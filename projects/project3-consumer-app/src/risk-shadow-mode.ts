import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  evaluateRiskRuleAst,
  validateRiskRuleAst,
  type RiskRuleAstNode,
} from "@fintech/core";
import type { RiskDecisionAction } from "./risk-engine.ts";

/**
 * Project 3 (Day 19) — Risk Rule Versioning (`ACTIVE` / `SHADOW` / `RETIRED`),
 * Shadow Mode Dual Evaluator + 100-Payment Diff Report, and Historical Replay.
 */

export const ALLOWED_RISK_FEATURES = new Set<string>([
  "amount_paise",
  "txn_count_10m",
  "sum_24h_paise",
  "median_ratio",
  "is_new_device_24h",
  "is_new_counterparty",
  "collect_fanout_1h",
  "is_blacklisted",
  "ist_hour",
]);

export interface VersionedAstRule {
  ruleId: string;
  weight: number;
  description: string;
  ast: RiskRuleAstNode;
}

export interface RiskRulesetVersion {
  version: string;
  status: "ACTIVE" | "SHADOW" | "RETIRED";
  stepUpThreshold: number;
  declineThreshold: number;
  rules: VersionedAstRule[];
  createdAt: string;
}

export interface ShadowEvaluationResult {
  paymentId: string;
  activeVersion: string;
  activeDecision: RiskDecisionAction;
  activeScore: number;
  shadowVersion: string | null;
  shadowDecision: RiskDecisionAction | null;
  shadowScore: number | null;
  diffLabel: string; // e.g., "AGREE" or "ALLOW->STEP_UP"
}

export interface ShadowDiffReport {
  activeVersion: string;
  shadowVersion: string;
  totalPaymentsEvaluated: number;
  agreementCount: number;
  agreementRatePercent: number;
  transitions: Record<string, number>;
}

export class VersionedShadowRiskEngine {
  public readonly db: DatabaseSync;
  private readonly rulesets = new Map<string, RiskRulesetVersion>();

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_feature_snapshots (
        payment_id TEXT PRIMARY KEY,
        features_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS shadow_comparisons (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        active_version TEXT NOT NULL,
        active_decision TEXT NOT NULL,
        active_score INTEGER NOT NULL,
        shadow_version TEXT NOT NULL,
        shadow_decision TEXT NOT NULL,
        shadow_score INTEGER NOT NULL,
        diff_label TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Registers a ruleset version after validating every rule's AST against `ALLOWED_RISK_FEATURES`.
   * New candidate rulesets always stage safely in `SHADOW` before promotion to `ACTIVE`.
   */
  public registerRuleset(params: {
    version: string;
    status: "ACTIVE" | "SHADOW" | "RETIRED";
    stepUpThreshold?: number;
    declineThreshold?: number;
    rules: VersionedAstRule[];
    now?: Date;
  }): RiskRulesetVersion {
    for (const r of params.rules) {
      validateRiskRuleAst(r.ast, ALLOWED_RISK_FEATURES);
    }

    if (params.status === "ACTIVE") {
      for (const existing of this.rulesets.values()) {
        if (existing.status === "ACTIVE") {
          existing.status = "RETIRED";
        }
      }
    }

    const record: RiskRulesetVersion = {
      version: params.version,
      status: params.status,
      stepUpThreshold: params.stepUpThreshold ?? 40,
      declineThreshold: params.declineThreshold ?? 80,
      rules: params.rules,
      createdAt: (params.now ?? new Date()).toISOString(),
    };
    this.rulesets.set(params.version, record);
    return record;
  }

  public promoteShadowToActive(shadowVersion: string): RiskRulesetVersion {
    const candidate = this.rulesets.get(shadowVersion);
    if (!candidate || candidate.status !== "SHADOW") {
      throw new Error(`Ruleset "${shadowVersion}" is not in SHADOW state`);
    }
    for (const existing of this.rulesets.values()) {
      if (existing.status === "ACTIVE") {
        existing.status = "RETIRED";
      }
    }
    candidate.status = "ACTIVE";
    return candidate;
  }

  public evaluateWithRuleset(
    ruleset: RiskRulesetVersion,
    features: Record<string, number | string | boolean>
  ): { score: number; decision: RiskDecisionAction; firedRuleIds: string[] } {
    let score = 0;
    const firedRuleIds: string[] = [];

    for (const rule of ruleset.rules) {
      if (evaluateRiskRuleAst(rule.ast, features)) {
        score += rule.weight;
        firedRuleIds.push(rule.ruleId);
      }
    }

    const decision: RiskDecisionAction =
      score >= ruleset.declineThreshold
        ? "DECLINE"
        : score >= ruleset.stepUpThreshold
          ? "STEP_UP"
          : "ALLOW";

    return { score, decision, firedRuleIds };
  }

  /**
   * Scores a live payment with the `ACTIVE` ruleset (returned to customer) AND dual-evaluates
   * the `SHADOW` ruleset (logged for diff analysis without impacting the customer).
   */
  public evaluateLivePayment(params: {
    paymentId: string;
    features: Record<string, number | string | boolean>;
    now?: Date;
  }): ShadowEvaluationResult {
    const nowIso = (params.now ?? new Date()).toISOString();
    const active = Array.from(this.rulesets.values()).find((r) => r.status === "ACTIVE");
    if (!active) {
      throw new Error("No ACTIVE risk ruleset configured");
    }
    const shadow = Array.from(this.rulesets.values()).find((r) => r.status === "SHADOW") ?? null;

    // Persist feature snapshot for future historical replay (`/risk/replay`)
    this.db
      .prepare(
        `INSERT OR REPLACE INTO risk_feature_snapshots (payment_id, features_json, created_at)
         VALUES (?, ?, ?)`
      )
      .run(params.paymentId, JSON.stringify(params.features), nowIso);

    const activeRes = this.evaluateWithRuleset(active, params.features);

    if (!shadow) {
      return {
        paymentId: params.paymentId,
        activeVersion: active.version,
        activeDecision: activeRes.decision,
        activeScore: activeRes.score,
        shadowVersion: null,
        shadowDecision: null,
        shadowScore: null,
        diffLabel: "NO_SHADOW",
      };
    }

    const shadowRes = this.evaluateWithRuleset(shadow, params.features);
    const diffLabel =
      activeRes.decision === shadowRes.decision
        ? "AGREE"
        : `${activeRes.decision}->${shadowRes.decision}`;

    this.db
      .prepare(
        `INSERT INTO shadow_comparisons (
          id, payment_id, active_version, active_decision, active_score,
          shadow_version, shadow_decision, shadow_score, diff_label, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `shd_${crypto.randomUUID().slice(0, 10)}`,
        params.paymentId,
        active.version,
        activeRes.decision,
        activeRes.score,
        shadow.version,
        shadowRes.decision,
        shadowRes.score,
        diffLabel,
        nowIso
      );

    return {
      paymentId: params.paymentId,
      activeVersion: active.version,
      activeDecision: activeRes.decision,
      activeScore: activeRes.score,
      shadowVersion: shadow.version,
      shadowDecision: shadowRes.decision,
      shadowScore: shadowRes.score,
      diffLabel,
    };
  }

  public generateShadowDiffReport(
    activeVersion: string,
    shadowVersion: string
  ): ShadowDiffReport {
    const rows = this.db
      .prepare(
        `SELECT diff_label, COUNT(*) AS cnt
         FROM shadow_comparisons
         WHERE active_version = ? AND shadow_version = ?
         GROUP BY diff_label`
      )
      .all(activeVersion, shadowVersion) as Array<{ diff_label: string; cnt: number }>;

    let total = 0;
    let agree = 0;
    const transitions: Record<string, number> = {};

    for (const r of rows) {
      total += r.cnt;
      if (r.diff_label === "AGREE") {
        agree += r.cnt;
      } else {
        transitions[r.diff_label] = r.cnt;
      }
    }

    return {
      activeVersion,
      shadowVersion,
      totalPaymentsEvaluated: total,
      agreementCount: agree,
      agreementRatePercent: total === 0 ? 100 : Math.round((agree / total) * 10000) / 100,
      transitions,
    };
  }

  /**
   * Replays all stored historical payment snapshots against any registered ruleset version.
   */
  public replayHistoricalPayments(version: string): {
    version: string;
    totalReplayed: number;
    counts: Record<RiskDecisionAction, number>;
  } {
    const ruleset = this.rulesets.get(version);
    if (!ruleset) {
      throw new Error(`Ruleset "${version}" not found`);
    }

    const snapshots = this.db
      .prepare(`SELECT payment_id, features_json FROM risk_feature_snapshots`)
      .all() as Array<{ payment_id: string; features_json: string }>;

    const counts: Record<RiskDecisionAction, number> = {
      ALLOW: 0,
      STEP_UP: 0,
      DECLINE: 0,
    };

    for (const snap of snapshots) {
      const features = JSON.parse(snap.features_json) as Record<
        string,
        number | string | boolean
      >;
      const res = this.evaluateWithRuleset(ruleset, features);
      counts[res.decision]++;
    }

    return {
      version,
      totalReplayed: snapshots.length,
      counts,
    };
  }
}
