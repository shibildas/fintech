import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findPayoutSubsetSum, verifyBatchFeeRoundingInvariant } from "@fintech/core";
import { createSeededGatewayTopology } from "../src/index.ts";

describe("Day 13 — T+1 Payouts, Rolling Reserves, Nightly Ledger Check & DP Subset-Sum Reconciliation", () => {
  it("Enforces rolling reserve withholding and operator holds in available_payout_paise", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    // Configure 10% (1000 bps) rolling reserve + ₹100.00 (10,000 paise) operator hold
    gateway.gatewayDb
      .prepare(`UPDATE merchants SET rolling_reserve_bps = 1000, hold_paise = 10000 WHERE id = ?`)
      .run(merchant.id);

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_day13_reserve",
      amountPaise: 100_000, // ₹1,000.00
      merchantOrderId: "rcpt_day13_reserve",
    });

    const tok = gateway.vault.tokenize({
      cardNumber: "4111111111114242",
      expiry: "12/29",
      merchantId: merchant.id,
    });

    await gateway.payOrder({
      orderId: order.id,
      method: "CARD",
      tokenId: tok.token,
      cardOtp: "123456",
    });

    // Gross 100,000 - MDR 2,000 - GST 360 = 97,640 merchantNetPaise
    // 10% Rolling Reserve on 97,640 = 9,764 paise -> Payable = 87,876 paise
    // Minus 10,000 hold_paise -> Available for payout = 77,876 paise
    const bal = gateway.getMerchantLedgerBalances(merchant.id);
    assert.equal(bal.reserve_paise, 9_764);
    assert.equal(bal.payable_paise, 87_876);
    assert.equal(bal.available_payout_paise, 77_876);

    const check = gateway.verifyDashboardMatchesLedger(merchant.id);
    assert.equal(check.matches, true);
    assert.equal(check.dashboard_balance_paise, 87_876);
  });

  it("Day 13 Fintech DSA: findPayoutSubsetSum matches lump-sum bank credit and preserves fee-rounding invariant", () => {
    const candidates = [
      { id: "pay_01", amountPaise: 45_000 },
      { id: "pay_02", amountPaise: 120_000 },
      { id: "pay_03", amountPaise: 75_000 },
      { id: "pay_04", amountPaise: 30_000 },
    ];

    // Suppose bank credited ₹1950.00 (195,000 paise) -> pay_02 (120,000) + pay_03 (75,000)
    const matched = findPayoutSubsetSum(candidates, 195_000);
    assert.ok(matched !== null);
    assert.deepEqual(
      matched.map((m) => m.id),
      ["pay_02", "pay_03"]
    );

    // Non-matching target returns null
    assert.equal(findPayoutSubsetSum(candidates, 50_000), null);

    // Odd paise amounts preserve zero-sum rounding invariant across batch
    const invariant = verifyBatchFeeRoundingInvariant([10_003, 25_017, 99_999], 199, 1800);
    assert.equal(invariant.valid, true);
    assert.equal(
      invariant.totalNetPaise + invariant.totalMdrPaise + invariant.totalGstPaise,
      invariant.totalGrossPaise
    );
  });
});
