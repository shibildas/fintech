import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  InjectableFakeClock,
  advanceAnchoredMonths,
  computeMidCycleProrationPaise,
} from "@fintech/core";
import { MandateService, SubscriptionService } from "../src/index.ts";

describe("Day 23 — Project 4: Subscriptions, Anchor Calendar (Feb 28/29 -> Mar 31), Mid-Cycle Proration & Fake Clock", () => {
  it("1. Day 23 Fintech DSA: Anchor day 31 snaps to Feb 28 (2026) / Feb 29 (2028 leap) and returns to Mar 31", () => {
    // Non-leap year 2026: Jan 31 -> Feb 28 -> Mar 31 -> Apr 30 -> May 31
    const feb2026 = advanceAnchoredMonths({
      anchorDay: 31,
      fromYear: 2026,
      fromMonth1Based: 1,
      monthsToAdd: 1,
    });
    assert.equal(feb2026.localDateIso, "2026-02-28");

    const mar2026 = advanceAnchoredMonths({
      anchorDay: 31,
      fromYear: 2026,
      fromMonth1Based: 2,
      monthsToAdd: 1,
    });
    assert.equal(mar2026.localDateIso, "2026-03-31");

    const apr2026 = advanceAnchoredMonths({
      anchorDay: 31,
      fromYear: 2026,
      fromMonth1Based: 3,
      monthsToAdd: 1,
    });
    assert.equal(apr2026.localDateIso, "2026-04-30");

    // Leap year 2028: Jan 31 -> Feb 29 -> Mar 31
    const feb2028 = advanceAnchoredMonths({
      anchorDay: 31,
      fromYear: 2028,
      fromMonth1Based: 1,
      monthsToAdd: 1,
    });
    assert.equal(feb2028.localDateIso, "2028-02-29");
  });

  it("2. Mid-cycle upgrade & downgrade compute exact integer paise proration without float drift", () => {
    // Upgrade ₹300 (30,000) -> ₹900 (90,000) with 15 of 30 days left -> credit 15,000, charge 45,000, net +30,000
    const up = computeMidCycleProrationPaise({
      oldPlanPaise: 30_000,
      newPlanPaise: 90_000,
      remainingDays: 15,
      totalCycleDays: 30,
    });
    assert.equal(up.unusedCreditPaise, 15_000);
    assert.equal(up.newPlanChargePaise, 45_000);
    assert.equal(up.netDeltaPaise, 30_000);

    // Odd 31-day month downgrade ₹999 (99,900) -> ₹499 (49,900) with 10 of 31 days left
    const down = computeMidCycleProrationPaise({
      oldPlanPaise: 99_900,
      newPlanPaise: 49_900,
      remainingDays: 10,
      totalCycleDays: 31,
    });
    assert.equal(Number.isInteger(down.netDeltaPaise), true);
    assert.ok(down.netDeltaPaise < 0);
  });

  it("3. Subscription lifecycle with Fake Clock, mid-cycle upgrade, and auto-HALT on mandate revoke", () => {
    const clock = new InjectableFakeClock("2026-01-31T04:30:00.000Z"); // 10:00 AM IST Jan 31
    const mandates = new MandateService();
    const subs = new SubscriptionService({ mandates, clock });

    const m = mandates.createMandate({
      merchantId: "merch_cloud",
      customerId: "cust_anita",
      payerVpa: "anita@psp1",
      bankId: "BANKA",
      accountNumberMasked: "XXXX4521",
      rail: "UPI_AUTOPAY",
      maxAmountPaise: 200_000,
      monthlyAggregateCapPaise: 500_000,
      validUntilIso: "2028-01-31T00:00:00.000Z",
      now: clock.now(),
    });
    mandates.authorizeMandate({ mandateId: m.id, authCredential: "1234", now: clock.now() });

    const starter = subs.createPlan({
      merchantId: "merch_cloud",
      name: "Starter Monthly",
      interval: "MONTHLY",
      amountPaise: 49_900,
    });
    const pro = subs.createPlan({
      merchantId: "merch_cloud",
      name: "Pro Monthly",
      interval: "MONTHLY",
      amountPaise: 99_900,
    });

    const sub = subs.createSubscription({
      merchantId: "merch_cloud",
      customerId: "cust_anita",
      planId: starter.id,
      mandateId: m.id,
      anchorDay: 31,
      startYear: 2026,
      startMonth1Based: 1,
    });
    const active = subs.activateSubscription(sub.id);
    assert.equal(active.state, "ACTIVE");

    // Advance 1 month -> snaps to 2026-02-28; advance another -> snaps back to 2026-03-31!
    clock.advanceByDays(28);
    const c1 = subs.advanceToNextBillingCycle(sub.id);
    assert.equal(c1.localDateIso, "2026-02-28");
    const c2 = subs.advanceToNextBillingCycle(sub.id);
    assert.equal(c2.localDateIso, "2026-03-31");

    // Mid-cycle upgrade Starter -> Pro
    const upgraded = subs.changeSubscriptionPlan({
      subscriptionId: sub.id,
      newPlanId: pro.id,
      remainingDays: 15,
      totalCycleDays: 30,
    });
    assert.equal(upgraded.subscription.plan_id, pro.id);
    assert.equal(upgraded.proration.net_delta_paise, 25_000);

    // Revoking mandate immediately HALTs the linked subscription
    mandates.revokeMandate(m.id, "Customer revoked AutoPay", clock.now());
    assert.equal(subs.getSubscription(sub.id)?.state, "HALTED");
  });
});
