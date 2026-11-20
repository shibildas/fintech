import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computePeakConcurrentWindowAmount } from "@fintech/core";
import { MandateService } from "../src/index.ts";

describe("Day 22 — Project 4: RBI Mandates (AutoPay & e-NACH), UMRN, Cap Re-Auth & Interval Capacity DSA", () => {
  it("1. UPI AutoPay & e-NACH authorization mints unique UMRN and enforces per-debit + monthly aggregate caps", () => {
    const svc = new MandateService();
    const now = new Date("2026-11-26T10:00:00.000Z");

    const autopay = svc.createMandate({
      merchantId: "merch_saas_01",
      customerId: "cust_anita",
      payerVpa: "anita@psp1",
      bankId: "BANKA",
      accountNumberMasked: "XXXX4521",
      rail: "UPI_AUTOPAY",
      maxAmountPaise: 100_000, // ₹1,000 per debit
      monthlyAggregateCapPaise: 150_000, // ₹1,500 monthly aggregate
      validUntilIso: "2027-11-26T00:00:00.000Z",
      now,
    });
    assert.equal(autopay.state, "CREATED");
    assert.equal(autopay.umrn, null);

    const activeAuto = svc.authorizeMandate({
      mandateId: autopay.id,
      authCredential: "1234",
      now,
    });
    assert.equal(activeAuto.state, "ACTIVE");
    assert.ok(activeAuto.umrn?.startsWith("UMRNBANK"));

    // e-NACH registration with Bank OTP
    const enach = svc.createMandate({
      merchantId: "merch_ins_01",
      customerId: "cust_rahul",
      bankId: "BANKB",
      accountNumberMasked: "XXXX8899",
      rail: "E_NACH",
      maxAmountPaise: 500_000,
      monthlyAggregateCapPaise: 500_000,
      validUntilIso: "2028-11-26T00:00:00.000Z",
      now,
    });
    const activeNach = svc.authorizeMandate({
      mandateId: enach.id,
      authCredential: "654321",
      now,
    });
    assert.equal(activeNach.state, "ACTIVE");
    assert.notEqual(activeNach.umrn, activeAuto.umrn);

    // Per-debit cap enforcement: ₹1,200 > ₹1,000 -> 403
    assert.throws(
      () =>
        svc.validateAndReserveDebitCap({
          mandateId: activeAuto.id,
          amountPaise: 120_000,
          now,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // Monthly aggregate cap: ₹900 allowed, second ₹700 in same month (900+700=1600 > 1500) -> 403
    svc.validateAndReserveDebitCap({ mandateId: activeAuto.id, amountPaise: 90_000, now });
    assert.throws(
      () =>
        svc.validateAndReserveDebitCap({
          mandateId: activeAuto.id,
          amountPaise: 70_000,
          now,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );
  });

  it("2. Cap increase requires explicit customer re-authorization (PENDING_REAUTH); revoke propagates to linked subscriptions", () => {
    const svc = new MandateService();
    const now = new Date("2026-11-26T11:00:00.000Z");

    const haltedSubs: string[] = [];
    svc.onMandateStateChange((ev) => {
      if (ev.newState === "REVOKED" || ev.newState === "PAUSED") {
        haltedSubs.push(`${ev.mandateId}:${ev.newState}`);
      }
    });

    const m = svc.createMandate({
      merchantId: "merch_stream",
      customerId: "cust_anita",
      payerVpa: "anita@psp1",
      bankId: "BANKA",
      accountNumberMasked: "XXXX4521",
      rail: "UPI_AUTOPAY",
      maxAmountPaise: 50_000,
      monthlyAggregateCapPaise: 100_000,
      validUntilIso: "2027-11-26T00:00:00.000Z",
      now,
    });
    svc.authorizeMandate({ mandateId: m.id, authCredential: "1234", now });

    // Increasing cap moves mandate to PENDING_REAUTH
    const mod = svc.requestCapModification({
      mandateId: m.id,
      newMaxAmountPaise: 150_000,
      newMonthlyAggregateCapPaise: 300_000,
      now,
    });
    assert.equal(mod.requiresCustomerReauth, true);
    assert.equal(mod.mandate.state, "PENDING_REAUTH");

    // Debits are blocked while PENDING_REAUTH
    assert.throws(
      () => svc.validateAndReserveDebitCap({ mandateId: m.id, amountPaise: 50_000, now }),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // Customer confirms with PIN -> ACTIVE with higher cap
    const confirmed = svc.confirmCapIncreaseReauth({
      mandateId: m.id,
      authCredential: "1234",
      now,
    });
    assert.equal(confirmed.state, "ACTIVE");
    assert.equal(confirmed.max_amount_paise, 150_000);

    // Pause -> Resume -> Revoke propagates immediately to linked subscription hooks
    svc.pauseMandate(m.id, "Vacation pause", now);
    svc.resumeMandate(m.id, now);
    svc.revokeMandate(m.id, "Cancelled membership", now);
    assert.deepEqual(haltedSubs, [`${m.id}:PAUSED`, `${m.id}:REVOKED`]);
  });

  it("3. Day 22 Fintech DSA: Sweep-line computePeakConcurrentWindowAmount computes exact peak capacity", () => {
    const peak = computePeakConcurrentWindowAmount([
      { id: "d1", startMs: 1000, endMs: 3000, amountPaise: 50_000 },
      { id: "d2", startMs: 2000, endMs: 4000, amountPaise: 75_000 },
      { id: "d3", startMs: 3000, endMs: 5000, amountPaise: 40_000 },
    ]);
    // [1000,2000): 50k | [2000,3000): 50k+75k = 125k | [3000,4000): 75k+40k = 115k
    assert.equal(peak, 125_000);
  });
});
