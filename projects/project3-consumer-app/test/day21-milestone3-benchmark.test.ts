import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  RealTimeRiskEngine,
  VersionedShadowRiskEngine,
  ConsumerDisputeDesk,
} from "../src/index.ts";

describe("Day 21 — Milestone 3: Project 3 50+ TPS (<100ms p95) Risk Benchmark & E2E Flow", () => {
  it("Sustains >= 50 payments/sec through RealTimeRiskEngine + Shadow Mode with p95 < 100ms", () => {
    const risk = new RealTimeRiskEngine();
    const shadow = new VersionedShadowRiskEngine();

    shadow.registerRuleset({
      version: "v1.0",
      status: "ACTIVE",
      rules: [
        {
          ruleId: "HIGH_AMT",
          weight: 50,
          description: "Amount >= ₹5,000",
          ast: { type: "CMP", field: "amount_paise", op: "GTE", value: 500_000 },
        },
      ],
    });
    shadow.registerRuleset({
      version: "v2.0-shadow",
      status: "SHADOW",
      rules: [
        {
          ruleId: "HIGH_AMT_STRICT",
          weight: 50,
          description: "Amount >= ₹3,000",
          ast: { type: "CMP", field: "amount_paise", op: "GTE", value: 300_000 },
        },
      ],
    });

    const total = 150;
    const latenciesMs: number[] = [];
    const start = performance.now();

    for (let i = 0; i < total; i++) {
      const t0 = performance.now();
      const amountPaise = 50_000 + (i % 6) * 100_000;
      const r1 = risk.scorePayment({
        paymentId: `m3_pay_${i}`,
        customerId: `cust_${i % 10}`,
        deviceId: `dev_${i % 10}`,
        payeeVpa: "shop@psp2",
        amountPaise,
        isNewDevice24h: false,
        isNewCounterparty: i % 3 === 0,
      });
      const r2 = shadow.evaluateLivePayment({
        paymentId: `m3_pay_${i}`,
        features: { amount_paise: amountPaise, is_new_counterparty: i % 3 === 0 },
      });
      assert.ok(["ALLOW", "STEP_UP", "DECLINE"].includes(r1.decision));
      assert.ok(["ALLOW", "STEP_UP", "DECLINE"].includes(r2.activeDecision));
      latenciesMs.push(performance.now() - t0);
    }

    const elapsedSec = (performance.now() - start) / 1000;
    const tps = total / elapsedSec;
    latenciesMs.sort((a, b) => a - b);
    const p95Ms = latenciesMs[Math.floor(latenciesMs.length * 0.95)];

    assert.ok(tps >= 50, `Expected >= 50 TPS, got ${tps.toFixed(1)} TPS`);
    assert.ok(p95Ms < 100, `Expected p95 < 100ms, got ${p95Ms.toFixed(2)}ms`);

    const diff = shadow.generateShadowDiffReport("v1.0", "v2.0-shadow");
    assert.equal(diff.totalPaymentsEvaluated, total);

    // Quick sanity check on Dispute Desk export from unified index
    const desk = new ConsumerDisputeDesk();
    const dsp = desk.openDispute({
      customerId: "cust_1",
      switchRrn: "632915000001",
      category: "DEBITED_NOT_CREDITED",
      amountPaise: 50_000,
      customerNote: "Milestone 3 E2E dispute check",
    });
    assert.equal(dsp.state, "OPEN");
  });
});
