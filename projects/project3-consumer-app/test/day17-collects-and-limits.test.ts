import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { SlidingWindowDistinctCounter } from "@fintech/core";
import { createSeededTopology, CentralSwitch } from "@fintech/project1-switch";
import { ConsumerPspBackend } from "../src/psp-backend.ts";
import {
  CollectRequestEngine,
  PspLimitProfileEngine,
} from "../src/collect-and-limits.ts";

function setupCollectEnv() {
  const p1 = createSeededTopology();
  const sw = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-21",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const psp = new ConsumerPspBackend();
  psp.registerBank(p1.banks.BANKA);
  psp.registerBank(p1.banks.BANKB);

  const limits = new PspLimitProfileEngine(psp, {
    perTxnMaxPaise: 500_000, // ₹5,000
    dailyAmountMaxPaise: 800_000, // ₹8,000
    dailyCountMax: 5,
    newCounterpartyCapPaise: 200_000, // ₹2,000 first-time payee cap
  });

  const collects = new CollectRequestEngine({
    pspBackend: psp,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    limits,
    maxCollectsPerPayerPerHour: 2,
  });

  const now = new Date("2026-11-21T10:00:00.000Z");
  const signup = psp.signup({ mobileNumber: "9876543210", fullName: "Anita Sharma", now });
  psp.verifySmsOtp("9876543210", signup.mockSmsOtp);
  psp.setPin(signup.customer.id, "1234");

  return { p1, sw, psp, limits, collects, customer: signup.customer, now };
}

describe("Day 17 — Project 3: Collect Requests, Fan-Out Abuse Controls & Pre-Switch Limits", () => {
  it("1. Collect request lifecycle: create -> approve with PIN -> moves Switch balances; decline & expiry work", async () => {
    const { p1, psp, collects, customer, now } = setupCollectEnv();

    const anitaBefore = p1.banks.BANKA.ledger.getBalance("987654324521").ledger_balance_paise;
    const shopBefore = p1.banks.BANKC.ledger.getBalance("765432103344").ledger_balance_paise;

    const { collect } = collects.createCollectRequest({
      requesterVpa: "shop@psp2",
      payerVpa: "anita@psp1",
      amountPaise: 100_000, // ₹1,000.00 (within ₹2,000 new-counterparty cap)
      note: "Book order #42",
      now,
    });
    assert.equal(collect.status, "PENDING");

    const txnNonce = psp.issuePinChallengeNonce();
    const proof = psp.computeClientNoncePinProof({
      customerId: customer.id,
      rawPin: "1234",
      txnNonce,
    });

    const approved = await collects.approveCollectRequest({
      collectId: collect.id,
      payerCustomerId: customer.id,
      rawPin: "1234",
      txnNonce,
      clientPinProofHex: proof,
      now,
    });
    assert.equal(approved.status, "APPROVED");
    assert.equal(approved.switch_rrn?.length, 12);

    const anitaAfter = p1.banks.BANKA.ledger.getBalance("987654324521").ledger_balance_paise;
    const shopAfter = p1.banks.BANKC.ledger.getBalance("765432103344").ledger_balance_paise;
    assert.equal(anitaBefore - anitaAfter, 100_000);
    assert.equal(shopAfter - shopBefore, 100_000);

    // Decline & Expiry checks
    const { collect: col2 } = collects.createCollectRequest({
      requesterVpa: "shop@psp2",
      payerVpa: "anita@psp1",
      amountPaise: 5_000,
      now: new Date(now.getTime() + 1000),
    });
    const declined = collects.declineCollectRequest(col2.id, now);
    assert.equal(declined.status, "DECLINED");

    // 31 minutes later -> auto-expires
    const { collect: col3 } = collects.createCollectRequest({
      requesterVpa: "coffee@psp2",
      payerVpa: "anita@psp1",
      amountPaise: 5_000,
      now,
    });
    const expiredCount = collects.expireDueCollectRequests(
      new Date(now.getTime() + 31 * 60 * 1000)
    );
    assert.equal(expiredCount, 1);
    assert.equal(collects.getCollect(col3.id)?.status, "EXPIRED");
  });

  it("2. Collect abuse controls: payer blocklist (403), per-payer rate limit (429), and 15+ distinct-payer fan-out flag (429)", () => {
    const { collects, now } = setupCollectEnv();

    // Blocklist test
    collects.blockRequester("anita@psp1", "spammer@psp2", now);
    assert.throws(
      () =>
        collects.createCollectRequest({
          requesterVpa: "spammer@psp2",
          payerVpa: "anita@psp1",
          amountPaise: 10_000,
          now,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // Per-payer rate limit (max 2/hour)
    collects.createCollectRequest({ requesterVpa: "shop@psp2", payerVpa: "anita@psp1", amountPaise: 1000, now });
    collects.createCollectRequest({ requesterVpa: "shop@psp2", payerVpa: "anita@psp1", amountPaise: 1000, now });
    assert.throws(
      () =>
        collects.createCollectRequest({
          requesterVpa: "shop@psp2",
          payerVpa: "anita@psp1",
          amountPaise: 1000,
          now,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 429
    );

    // Fan-out abuse: 15th distinct payer in 1 hour triggers 429 + audit entry
    for (let i = 1; i <= 14; i++) {
      collects.createCollectRequest({
        requesterVpa: "scammer@psp2",
        payerVpa: `victim${i}@psp1`,
        amountPaise: 50_000,
        now: new Date(now.getTime() + i * 1000),
      });
    }
    assert.throws(
      () =>
        collects.createCollectRequest({
          requesterVpa: "scammer@psp2",
          payerVpa: "victim15@psp1",
          amountPaise: 50_000,
          now: new Date(now.getTime() + 15_000),
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 429
    );
  });

  it("3. Pre-Switch PSP Limit Profiles enforce new-counterparty cap & daily limits", () => {
    const { limits, customer, now } = setupCollectEnv();

    // First payment to coffee@psp2 > ₹2,000 (200,000 paise) -> rejected with 403
    assert.throws(
      () =>
        limits.checkAndRecordPreSwitchLimits({
          customerId: customer.id,
          counterpartyVpa: "coffee@psp2",
          amountPaise: 250_000,
          now,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // Within new-counterparty cap (₹1,500) -> allowed; subsequent payment to same VPA can be ₹3,000
    limits.checkAndRecordPreSwitchLimits({
      customerId: customer.id,
      counterpartyVpa: "coffee@psp2",
      amountPaise: 150_000,
      now,
    });
    limits.checkAndRecordPreSwitchLimits({
      customerId: customer.id,
      counterpartyVpa: "coffee@psp2",
      amountPaise: 300_000,
      now,
    });

    // Next ₹4,000 exceeds ₹8,000 daily amount max (150k + 300k + 400k = 850k > 800k)
    assert.throws(
      () =>
        limits.checkAndRecordPreSwitchLimits({
          customerId: customer.id,
          counterpartyVpa: "coffee@psp2",
          amountPaise: 400_000,
          now,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );
  });

  it("4. Day 17 Fintech DSA: SlidingWindowDistinctCounter evicts expired targets in O(1) amortized", () => {
    const counter = new SlidingWindowDistinctCounter(60_000); // 1-minute window
    const t0 = 1_000_000;

    assert.equal(counter.recordAndCountDistinct("scam@psp", "u1@psp", t0), 1);
    assert.equal(counter.recordAndCountDistinct("scam@psp", "u1@psp", t0 + 1000), 1);
    assert.equal(counter.recordAndCountDistinct("scam@psp", "u2@psp", t0 + 2000), 2);

    // Advance 61s -> u1 and u2 expire, only u3 remains
    assert.equal(counter.recordAndCountDistinct("scam@psp", "u3@psp", t0 + 62_500), 1);
  });
});
