import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RunningMedianTracker } from "@fintech/core";
import { RealTimeRiskEngine } from "../src/risk-engine.ts";

describe("Day 18 — Project 3: Real-Time Risk Engine (<100ms p95), 7 Rules, Step-Up & Two-Heaps Median", () => {
  it("1. Normal daytime payment to known payee is ALLOW; velocity + median anomaly triggers STEP_UP", () => {
    const engine = new RealTimeRiskEngine();
    const t0 = new Date("2026-11-22T09:00:00.000Z"); // 14:30 IST (daytime)

    // Seed 5 normal ₹200 (20,000 paise) transactions over the last few days
    for (let i = 1; i <= 5; i++) {
      engine.recordHistoricalPayment("cust_1", 20_000, t0.getTime() - i * 86_400_000);
    }

    // Normal ₹250 payment -> ALLOW
    const lowRisk = engine.scorePayment({
      paymentId: "pay_ok_1",
      customerId: "cust_1",
      deviceId: "dev_1",
      payeeVpa: "coffee@psp2",
      amountPaise: 25_000,
      isNewDevice24h: false,
      isNewCounterparty: false,
      now: t0,
    });
    assert.equal(lowRisk.decision, "ALLOW");
    assert.equal(lowRisk.total_score, 0);

    // Sudden ₹2,500 (> 5x ₹200 median = +35) to brand-new payee (>= ₹2,000 = +25) -> score 60 -> STEP_UP
    const stepUp = engine.scorePayment({
      paymentId: "pay_stepup_1",
      customerId: "cust_1",
      deviceId: "dev_1",
      payeeVpa: "unknown@psp2",
      amountPaise: 250_000,
      isNewDevice24h: false,
      isNewCounterparty: true,
      now: t0,
    });
    assert.equal(stepUp.decision, "STEP_UP");
    assert.equal(stepUp.total_score, 60);
    assert.equal(stepUp.step_up_method, "COOLING_DELAY_30M");
    assert.deepEqual(
      stepUp.fired_rules.map((r) => r.ruleId),
      ["MEDIAN_ANOMALY_30D", "NEW_COUNTERPARTY_HIGH_AMOUNT"]
    );
  });

  it("2. Blacklist hit triggers immediate DECLINE; night-time round amount + new device triggers STEP_UP", () => {
    const engine = new RealTimeRiskEngine();
    engine.addToBlacklist("fraudster@psp2");

    const nightUtc = new Date("2026-11-21T20:30:00.000Z"); // 02:00 IST

    const declined = engine.scorePayment({
      paymentId: "pay_bl_1",
      customerId: "cust_2",
      deviceId: "dev_2",
      payeeVpa: "fraudster@psp2",
      amountPaise: 10_000,
      isNewDevice24h: false,
      isNewCounterparty: true,
      now: nightUtc,
    });
    assert.equal(declined.decision, "DECLINE");
    assert.ok(declined.total_score >= 100);

    // Night-time round ₹10,000 (+20) + new device (+25) -> score 45 -> STEP_UP
    const nightStepUp = engine.scorePayment({
      paymentId: "pay_night_1",
      customerId: "cust_2",
      deviceId: "dev_2",
      payeeVpa: "friend@psp2",
      amountPaise: 1_000_000,
      isNewDevice24h: true,
      isNewCounterparty: false,
      now: nightUtc,
    });
    assert.equal(nightStepUp.decision, "STEP_UP");
    assert.equal(nightStepUp.total_score, 45);
  });

  it("3. Deterministic Timeout Fallback allows small (<= ₹2,000) and steps up large (> ₹2,000) payments", () => {
    const engine = new RealTimeRiskEngine();
    engine.simulateTimeoutFallback = true;

    const small = engine.scorePayment({
      paymentId: "pay_fb_small",
      customerId: "cust_3",
      deviceId: "dev_3",
      payeeVpa: "chai@psp2",
      amountPaise: 50_000, // ₹500
      isNewDevice24h: false,
      isNewCounterparty: true,
    });
    assert.equal(small.fallback_used, true);
    assert.equal(small.decision, "ALLOW");

    const large = engine.scorePayment({
      paymentId: "pay_fb_large",
      customerId: "cust_3",
      deviceId: "dev_3",
      payeeVpa: "jeweler@psp2",
      amountPaise: 500_000, // ₹5,000
      isNewDevice24h: false,
      isNewCounterparty: true,
    });
    assert.equal(large.fallback_used, true);
    assert.equal(large.decision, "STEP_UP");
  });

  it("4. Latency budget (<100ms p95 across 100 scorings) & Day 18 DSA Two-Heaps RunningMedianTracker", () => {
    const engine = new RealTimeRiskEngine();
    const latencies: number[] = [];
    for (let i = 0; i < 100; i++) {
      const res = engine.scorePayment({
        paymentId: `pay_lat_${i}`,
        customerId: "cust_bench",
        deviceId: "dev_bench",
        payeeVpa: "shop@psp2",
        amountPaise: 10_000 + i * 50,
        isNewDevice24h: false,
        isNewCounterparty: false,
      });
      latencies.push(res.latency_ms);
    }
    latencies.sort((a, b) => a - b);
    const p95 = latencies[Math.floor(latencies.length * 0.95)];
    assert.ok(p95 < 100, `Expected p95 < 100ms, got ${p95}ms`);

    // Two-Heaps Running Median verification
    const tracker = new RunningMedianTracker();
    for (const val of [50_000, 10_000, 30_000, 90_000, 20_000]) {
      tracker.add(val);
    }
    // Sorted: [10k, 20k, 30k, 50k, 90k] -> median = 30,000
    assert.equal(tracker.getMedian(), 30_000);
    tracker.add(40_000);
    // Sorted: [10k, 20k, 30k, 40k, 50k, 90k] -> median = (30k + 40k)/2 = 35,000
    assert.equal(tracker.getMedian(), 35_000);
  });
});
