import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  evaluateRiskRuleAst,
  validateRiskRuleAst,
  type RiskRuleAstNode,
} from "@fintech/core";
import {
  VersionedShadowRiskEngine,
  ALLOWED_RISK_FEATURES,
} from "../src/risk-shadow-mode.ts";

describe("Day 19 — Project 3: Rule Versioning, Shadow Mode 100-Payment Diff Report, Replay & AST Evaluator", () => {
  it("1. Day 19 Fintech DSA: Safe AST Expression Tree validates schema and evaluates nested AND/OR/NOT/CMP rules", () => {
    const ast: RiskRuleAstNode = {
      type: "AND",
      children: [
        { type: "CMP", field: "amount_paise", op: "GTE", value: 200_000 },
        {
          type: "OR",
          children: [
            { type: "CMP", field: "is_new_device_24h", op: "EQ", value: true },
            { type: "CMP", field: "ist_hour", op: "IN", value: [0, 1, 2, 3, 4] },
          ],
        },
      ],
    };

    validateRiskRuleAst(ast, ALLOWED_RISK_FEATURES);

    assert.equal(
      evaluateRiskRuleAst(ast, {
        amount_paise: 300_000,
        is_new_device_24h: false,
        ist_hour: 2,
      }),
      true
    );
    assert.equal(
      evaluateRiskRuleAst(ast, {
        amount_paise: 300_000,
        is_new_device_24h: false,
        ist_hour: 14,
      }),
      false
    );

    // Disallowed feature field is rejected at validation time
    assert.throws(() =>
      validateRiskRuleAst(
        { type: "CMP", field: "eval_arbitrary_code", op: "EQ", value: 1 },
        ALLOWED_RISK_FEATURES
      )
    );
  });

  it("2. 100-Payment Shadow Mode Diff Report, Historical Replay & Shadow->Active Promotion", () => {
    const engine = new VersionedShadowRiskEngine();

    // v1 (ACTIVE): steps up only if amount >= ₹5,000 AND new counterparty
    engine.registerRuleset({
      version: "v1.0",
      status: "ACTIVE",
      rules: [
        {
          ruleId: "NEW_CP_5K",
          weight: 50,
          description: "New counterparty >= ₹5,000",
          ast: {
            type: "AND",
            children: [
              { type: "CMP", field: "is_new_counterparty", op: "EQ", value: true },
              { type: "CMP", field: "amount_paise", op: "GTE", value: 500_000 },
            ],
          },
        },
      ],
    });

    // v2 (SHADOW): stricter — steps up if amount >= ₹2,000 AND new counterparty
    engine.registerRuleset({
      version: "v2.0-strict",
      status: "SHADOW",
      rules: [
        {
          ruleId: "NEW_CP_2K",
          weight: 50,
          description: "New counterparty >= ₹2,000",
          ast: {
            type: "AND",
            children: [
              { type: "CMP", field: "is_new_counterparty", op: "EQ", value: true },
              { type: "CMP", field: "amount_paise", op: "GTE", value: 200_000 },
            ],
          },
        },
      ],
    });

    // Run 100 live payments: 70 small/known (ALLOW in both), 20 new counterparty ₹3,000 (ALLOW in v1, STEP_UP in v2), 10 new counterparty ₹6,000 (STEP_UP in both)
    for (let i = 0; i < 100; i++) {
      const isNewCp = i >= 70;
      const amountPaise = i < 70 ? 50_000 : i < 90 ? 300_000 : 600_000;
      const res = engine.evaluateLivePayment({
        paymentId: `pay_shd_${i}`,
        features: {
          amount_paise: amountPaise,
          is_new_counterparty: isNewCp,
        },
      });
      // Customer decision strictly follows ACTIVE v1.0 (never blocked by SHADOW)
      assert.equal(res.activeDecision, i >= 90 ? "STEP_UP" : "ALLOW");
    }

    const report = engine.generateShadowDiffReport("v1.0", "v2.0-strict");
    assert.equal(report.totalPaymentsEvaluated, 100);
    assert.equal(report.agreementCount, 80);
    assert.equal(report.agreementRatePercent, 80);
    assert.equal(report.transitions["ALLOW->STEP_UP"], 20);

    // Historical replay against v2.0-strict matches the exact 30 STEP_UP + 70 ALLOW distribution
    const replay = engine.replayHistoricalPayments("v2.0-strict");
    assert.equal(replay.totalReplayed, 100);
    assert.equal(replay.counts.ALLOW, 70);
    assert.equal(replay.counts.STEP_UP, 30);

    // Promote v2.0-strict from SHADOW -> ACTIVE
    const promoted = engine.promoteShadowToActive("v2.0-strict");
    assert.equal(promoted.status, "ACTIVE");
  });
});
