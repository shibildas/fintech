import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InjectableFakeClock, DistributedLeaseManager } from "@fintech/core";
import { createSeededTopology, CentralSwitch } from "@fintech/project1-switch";
import {
  MandateService,
  SubscriptionService,
  RecurringCycleExecutor,
  ExecutorSimulatedCrashError,
} from "../src/index.ts";

function setupExecutorEnv(initialIso = "2026-11-27T04:30:00.000Z") {
  const clock = new InjectableFakeClock(initialIso); // 10:00 AM IST
  const p1 = createSeededTopology();
  const sw = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-28",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const mandates = new MandateService();
  const subs = new SubscriptionService({ mandates, clock });
  const executor = new RecurringCycleExecutor({
    mandates,
    subs,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    merchantVpa: "shop@psp2",
    clock,
  });

  const m = mandates.createMandate({
    merchantId: "merch_ott",
    customerId: "cust_anita",
    payerVpa: "anita@psp1",
    bankId: "BANKA",
    accountNumberMasked: "XXXX4521",
    rail: "UPI_AUTOPAY",
    maxAmountPaise: 100_000,
    monthlyAggregateCapPaise: 300_000,
    validUntilIso: "2028-11-28T00:00:00.000Z",
    now: clock.now(),
  });
  mandates.authorizeMandate({ mandateId: m.id, authCredential: "1234", now: clock.now() });

  const plan = subs.createPlan({
    merchantId: "merch_ott",
    name: "OTT Gold Monthly",
    interval: "MONTHLY",
    amountPaise: 49_900, // ₹499.00
  });
  const sub = subs.createSubscription({
    merchantId: "merch_ott",
    customerId: "cust_anita",
    planId: plan.id,
    mandateId: m.id,
    anchorDay: 28,
    startYear: 2026,
    startMonth1Based: 11,
  });
  subs.activateSubscription(sub.id);

  return { clock, p1, sw, mandates, subs, executor, mandate: m, sub };
}

describe("Day 24 — Project 4: 24h Pre-Debit Notice Gate, Kill-Safe Exactly-Once Executor & Lease DSA", () => {
  it("1. RBI 24h Pre-Debit Gate blocks early debits and respects customer 1-click cancel after notice", async () => {
    const { clock, subs, executor, sub } = setupExecutorEnv();

    // No notice sent yet -> blocked with 403
    await assert.rejects(
      () => executor.executeCycle({ subscriptionId: sub.id, cycleNumber: 1 }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // Send pre-debit notice (carries 1-click pause/cancel URL)
    const notice = executor.sendPreDebitNotice(sub.id, 1);
    assert.ok(notice.pause_or_cancel_url.includes("pause_or_cancel"));

    // Only 10 hours later (20:00 IST, inside window) -> still blocked by 24h pre-debit gate (403)
    clock.advanceByHours(10);
    await assert.rejects(
      () => executor.executeCycle({ subscriptionId: sub.id, cycleNumber: 1 }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // Customer clicks 1-click cancel link during 24h notice window -> debit is aborted at +24h!
    subs.transitionState(sub.id, "CANCELLED");
    clock.advanceByHours(14);
    await assert.rejects(
      () => executor.executeCycle({ subscriptionId: sub.id, cycleNumber: 1 }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );
  });

  it("2. Executor Kill Test: crash between CLAIMED and Switch response recovers with strictly ONE bank debit", async () => {
    const { clock, p1, executor, sub } = setupExecutorEnv();

    const anitaBefore = p1.banks.BANKA.ledger.getBalance("987654324521").ledger_balance_paise;

    // Send pre-debit notice & advance Fake Clock by 24 hours (10:00 AM IST next day)
    executor.sendPreDebitNotice(sub.id, 1);
    clock.advanceByHours(24);

    // Simulate SIGKILL right after Switch debited BANKA but before executor persisted SUCCEEDED
    executor.simulateCrashAfterSwitchDebit = true;
    await assert.rejects(
      () => executor.executeCycle({ subscriptionId: sub.id, cycleNumber: 1 }),
      (err: unknown) => err instanceof ExecutorSimulatedCrashError
    );

    const key = RecurringCycleExecutor.buildExecutionKey(sub.id, 1);
    assert.equal(executor.getExecution(key)?.state, "CLAIMED");

    // Process restarts: recovery worker reconciles CLAIMED row via Switch status check
    executor.simulateCrashAfterSwitchDebit = false;
    const recovered = executor.recoverCrashedExecutions();
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].state, "SUCCEEDED");
    assert.equal(recovered[0].switch_rrn?.length, 12);

    // Re-running executeCycle for the same cycle is a no-op (alreadyExecuted = true)
    const replay = await executor.executeCycle({ subscriptionId: sub.id, cycleNumber: 1 });
    assert.equal(replay.alreadyExecuted, true);

    // Strictly ONE debit of ₹499.00 (49,900 paise) occurred at BANKA!
    const anitaAfter = p1.banks.BANKA.ledger.getBalance("987654324521").ledger_balance_paise;
    assert.equal(anitaBefore - anitaAfter, 49_900);
  });

  it("3. Day 24 Fintech DSA: DistributedLeaseManager blocks concurrent workers and allows takeover after lease expiry", () => {
    const leases = new DistributedLeaseManager();
    const t0 = 1_000_000;

    const a1 = leases.acquire({
      key: "sub_1:cycle:1",
      ownerId: "worker-A",
      leaseDurationMs: 5000,
      nowMs: t0,
    });
    assert.equal(a1.acquired, true);

    // Worker B blocked while Worker A's lease is active
    const b1 = leases.acquire({
      key: "sub_1:cycle:1",
      ownerId: "worker-B",
      leaseDurationMs: 5000,
      nowMs: t0 + 2000,
    });
    assert.equal(b1.acquired, false);

    // After lease expires at t0 + 5001, Worker B safely takes over with a higher fencing token
    const b2 = leases.acquire({
      key: "sub_1:cycle:1",
      ownerId: "worker-B",
      leaseDurationMs: 5000,
      nowMs: t0 + 5001,
    });
    assert.equal(b2.acquired, true);
    if (a1.acquired && b2.acquired) {
      assert.ok(b2.lease.fencingToken > a1.lease.fencingToken);
    }
  });
});
