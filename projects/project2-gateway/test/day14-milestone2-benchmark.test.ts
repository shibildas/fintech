import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createSeededGatewayTopology } from "../src/index.ts";

describe("Day 14 — Milestone 2: Multi-Rail Gateway Throughput, p95 Latency & Ledger Invariant", () => {
  it("Sustains >100 orders+payments/sec with p95 < 100ms across Card & UPI and maintains exact dashboard-vs-ledger parity", async () => {
    const { gateway, merchant, acqAlpha, acqBeta, acqGamma } = createSeededGatewayTopology();

    // Remove simulated network sleep for pure engine + SQLite + crypto + ledger throughput benchmark
    acqAlpha.setChaos({ latencyMs: 0 });
    acqBeta.setChaos({ latencyMs: 0 });
    acqGamma.setChaos({ latencyMs: 0 });

    const totalTxns = 100;
    const latenciesMs: number[] = [];
    const benchStart = performance.now();

    for (let i = 0; i < totalTxns; i++) {
      const t0 = performance.now();
      const { order } = await gateway.createOrder({
        merchantId: merchant.id,
        idempotencyKey: `idem_m2_bench_${i}`,
        amountPaise: 5_000 + i * 10, // ~₹50-60 per txn (50 UPI txns stay well within ₹10,000 daily limit)
        merchantOrderId: `rcpt_m2_${i}`,
      });

      if (i % 2 === 0) {
        const tok = gateway.vault.tokenize({
          cardNumber: `411111111111${String(1000 + i).slice(-4)}`,
          expiry: "12/29",
          merchantId: merchant.id,
        });
        const res = await gateway.payOrder({
          orderId: order.id,
          method: "CARD",
          tokenId: tok.token,
          cardOtp: "123456",
        });
        assert.equal(res.payment.state, "CAPTURED");
      } else {
        const res = await gateway.payOrder({
          orderId: order.id,
          method: "UPI",
          upiPayerVpa: "anita@psp1",
          upiRawPin: "1234",
        });
        assert.equal(res.payment.state, "CAPTURED");
      }
      latenciesMs.push(performance.now() - t0);
    }

    const totalSec = (performance.now() - benchStart) / 1000;
    const tps = totalTxns / totalSec;
    latenciesMs.sort((a, b) => a - b);
    const p95Ms = latenciesMs[Math.floor(latenciesMs.length * 0.95)];

    assert.ok(tps > 100, `Expected >100 TPS, observed ${tps.toFixed(1)} TPS`);
    assert.ok(p95Ms < 100, `Expected p95 < 100ms, observed ${p95Ms.toFixed(2)}ms`);

    // Nightly dashboard-vs-ledger invariant must hold after mixed Card + UPI load
    const parity = gateway.verifyDashboardMatchesLedger(merchant.id);
    assert.equal(parity.matches, true);
    assert.ok(parity.ledger_payable_paise > 0);
  });
});
