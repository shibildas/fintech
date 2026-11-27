import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InjectableFakeClock } from "@fintech/core";
import { createSeededGatewayTopology } from "@fintech/project2-gateway";
import { MandateService, SubscriptionService, DunningEngine } from "../src/index.ts";

function setupDunningEnv() {
  const clock = new InjectableFakeClock("2026-11-30T04:30:00.000Z");
  const { gateway, merchant } = createSeededGatewayTopology();
  const mandates = new MandateService();
  const subs = new SubscriptionService({ mandates, clock });
  const dunning = new DunningEngine({ subs, gateway, clock });

  const createActiveSub = (tag: string) => {
    const m = mandates.createMandate({
      merchantId: merchant.id,
      customerId: `cust_${tag}`,
      payerVpa: `${tag}@psp1`,
      bankId: "BANKA",
      accountNumberMasked: "XXXX4521",
      rail: "UPI_AUTOPAY",
      maxAmountPaise: 200_000,
      monthlyAggregateCapPaise: 500_000,
      validUntilIso: "2028-11-30T00:00:00.000Z",
      now: clock.now(),
    });
    mandates.authorizeMandate({ mandateId: m.id, authCredential: "1234", now: clock.now() });
    const plan = subs.createPlan({
      merchantId: merchant.id,
      name: `Plan ${tag}`,
      interval: "MONTHLY",
      amountPaise: 99_900,
    });
    const sub = subs.createSubscription({
      merchantId: merchant.id,
      customerId: `cust_${tag}`,
      planId: plan.id,
      mandateId: m.id,
    });
    subs.activateSubscription(sub.id);
    return sub;
  };

  return { clock, gateway, merchant, subs, dunning, createActiveSub };
}

describe("Day 26 — Project 4: Dunning Engine (Day 1/3/7 Retries), Hard Failure Halt & Pay-Now Recovery", () => {
  it("1. Soft failure schedules Day 1/3/7 fresh retries -> Pay-Now via Project 2 Gateway cancels retries & restores ACTIVE", async () => {
    const { subs, dunning, createActiveSub } = setupDunningEnv();
    const sub = createActiveSub("paynow");

    const { dunningCase, scheduledRetries } = await dunning.handleDebitFailure({
      subscriptionId: sub.id,
      executionKey: `${sub.id}:cycle:1`,
      amountPaise: 99_900,
      failureCode: "51_INSUFFICIENT_FUNDS",
    });

    assert.equal(subs.getSubscription(sub.id)?.state, "PAST_DUE");
    assert.equal(dunningCase.failure_class, "SOFT");
    assert.equal(scheduledRetries.length, 3);
    assert.deepEqual(
      scheduledRetries.map((r) => r.retry_execution_key),
      [`${sub.id}:cycle:1:retry:1`, `${sub.id}:cycle:1:retry:2`, `${sub.id}:cycle:1:retry:3`]
    );
    assert.ok(dunningCase.pay_now_order_id?.startsWith("order_"));

    // Customer clicks Pay-Now link and pays by Card through Project 2 Gateway
    const rec = await dunning.recoverViaPayNowCard({
      dunningCaseId: dunningCase.id,
      cardNumber: "4111111111114242",
      expiry: "12/29",
    });
    assert.equal(rec.paymentState, "CAPTURED");
    assert.equal(rec.dunningCase.status, "RECOVERED_PAY_NOW");
    assert.equal(subs.getSubscription(sub.id)?.state, "ACTIVE");

    // All 3 pending retries are cancelled so customer is never double-charged!
    const retriesAfter = dunning.listRetries(dunningCase.id);
    assert.ok(retriesAfter.every((r) => r.status === "CANCELLED"));
  });

  it("2. Hard failure (78_ACCOUNT_CLOSED) halts immediately with 0 retries; exhausted soft retries halt at Day 7", async () => {
    const { clock, subs, dunning, createActiveSub } = setupDunningEnv();

    // Case A: Hard failure -> immediate HALTED, 0 retries
    const hardSub = createActiveSub("hard");
    const hardRes = await dunning.handleDebitFailure({
      subscriptionId: hardSub.id,
      executionKey: `${hardSub.id}:cycle:1`,
      amountPaise: 99_900,
      failureCode: "78_ACCOUNT_CLOSED",
    });
    assert.equal(hardRes.scheduledRetries.length, 0);
    assert.equal(subs.getSubscription(hardSub.id)?.state, "HALTED");

    // Case B: Soft failure where Day 1, Day 3, and Day 7 retries all fail -> HALTED
    const exhaustSub = createActiveSub("exhaust");
    const softRes = await dunning.handleDebitFailure({
      subscriptionId: exhaustSub.id,
      executionKey: `${exhaustSub.id}:cycle:1`,
      amountPaise: 99_900,
      failureCode: "51_INSUFFICIENT_FUNDS",
    });

    // Advance through Day 1, Day 3, Day 7 with failing bank debits
    clock.advanceByDays(1);
    await dunning.processDueRetries(async () => false);
    assert.equal(subs.getSubscription(exhaustSub.id)?.state, "PAST_DUE");

    clock.advanceByDays(2); // Day 3
    await dunning.processDueRetries(async () => false);
    assert.equal(subs.getSubscription(exhaustSub.id)?.state, "PAST_DUE");

    clock.advanceByDays(4); // Day 7
    const finalPass = await dunning.processDueRetries(async () => false);
    assert.equal(finalPass.halted, 1);
    assert.equal(subs.getSubscription(exhaustSub.id)?.state, "HALTED");
    assert.equal(dunning.getCase(softRes.dunningCase.id)?.status, "EXHAUSTED_HALTED");
  });
});
