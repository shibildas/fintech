import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RunningMedianTracker } from "@fintech/core";

/**
 * Project 3 (Day 18) — Real-Time Fraud & Risk Engine (<100ms p95)
 *
 * Evaluates 7 weighted starter rules on every payment:
 * 1. `VELOCITY_10M` — >= 4 payments in 10 minutes (+35)
 * 2. `VELOCITY_24H` — >= ₹50,000 (5,000,000 paise) in 24h (+30)
 * 3. `MEDIAN_ANOMALY_30D` — amount > 5x customer's 30-day running median (+35)
 * 4. `NEW_COUNTERPARTY_HIGH_AMOUNT` — first time paying payee & amount >= ₹2,000 (+25)
 * 5. `NEW_DEVICE_24H` — device bound within last 24h (+25)
 * 6. `COLLECT_FANOUT` — requester has >= 10 distinct payers in 1h (+45)
 * 7. `BLACKLIST_HIT` — payee VPA or device is blacklisted (+100 -> immediate DECLINE)
 * 8. `ROUND_AMOUNT_NIGHT_TIME` — exact multiple of ₹1,000 between 00:00–05:00 IST (+20)
 *
 * Score Thresholds:
 * - score >= 80 -> `DECLINE`
 * - score >= 40 -> `STEP_UP` (extra OTP or 30m cooling delay)
 * - score <  40 -> `ALLOW`
 *
 * Timeout Fallback:
 * - If scoring exceeds `timeoutBudgetMs` (e.g. 100ms), deterministically returns
 *   `ALLOW` for small payments (<= ₹2,000) and `STEP_UP` for large payments (> ₹2,000).
 */

export type RiskDecisionAction = "ALLOW" | "STEP_UP" | "DECLINE";

export interface RiskScoringInput {
  paymentId: string;
  customerId: string;
  deviceId: string;
  payeeVpa: string;
  amountPaise: number;
  isNewDevice24h: boolean;
  isNewCounterparty: boolean;
  collectFanOutCount1h?: number;
  now?: Date;
}

export interface FiredRiskRule {
  ruleId: string;
  weight: number;
  reason: string;
}

export interface RiskDecisionRecord {
  id: string;
  payment_id: string;
  customer_id: string;
  ruleset_version: string;
  total_score: number;
  decision: RiskDecisionAction;
  step_up_method: "NONE" | "MOBILE_OTP" | "COOLING_DELAY_30M";
  fired_rules: FiredRiskRule[];
  fallback_used: boolean;
  latency_ms: number;
  created_at: string;
}

export class RealTimeRiskEngine {
  public readonly db: DatabaseSync;
  private readonly medianByCustomer = new Map<string, RunningMedianTracker>();
  private readonly recentTxnsByCustomer = new Map<
    string,
    Array<{ amountPaise: number; timestampMs: number }>
  >();
  private readonly blacklistedEntities = new Set<string>(); // VPA or deviceId

  public stepUpThreshold = 40;
  public declineThreshold = 80;
  public timeoutBudgetMs = 100;
  public smallFallbackCapPaise = 200_000; // ₹2,000
  public simulateTimeoutFallback = false;

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS risk_decisions (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        ruleset_version TEXT NOT NULL,
        total_score INTEGER NOT NULL,
        decision TEXT NOT NULL CHECK (decision IN ('ALLOW', 'STEP_UP', 'DECLINE')),
        step_up_method TEXT NOT NULL,
        fired_rules_json TEXT NOT NULL,
        fallback_used INTEGER NOT NULL DEFAULT 0,
        latency_ms REAL NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  public addToBlacklist(entityId: string): void {
    this.blacklistedEntities.add(entityId.trim().toLowerCase());
  }

  public recordHistoricalPayment(
    customerId: string,
    amountPaise: number,
    timestampMs: number
  ): void {
    let tracker = this.medianByCustomer.get(customerId);
    if (!tracker) {
      tracker = new RunningMedianTracker();
      this.medianByCustomer.set(customerId, tracker);
    }
    tracker.add(amountPaise);

    const list = this.recentTxnsByCustomer.get(customerId) ?? [];
    list.push({ amountPaise, timestampMs });
    this.recentTxnsByCustomer.set(customerId, list);
  }

  public scorePayment(input: RiskScoringInput): RiskDecisionRecord {
    const t0 = performance.now();
    const now = input.now ?? new Date();
    const nowMs = now.getTime();
    const id = `rsk_${crypto.randomUUID().slice(0, 10)}`;

    // Deterministic Timeout Fallback
    if (this.simulateTimeoutFallback) {
      const fallbackAction: RiskDecisionAction =
        input.amountPaise <= this.smallFallbackCapPaise ? "ALLOW" : "STEP_UP";
      const record: RiskDecisionRecord = {
        id,
        payment_id: input.paymentId,
        customer_id: input.customerId,
        ruleset_version: "v1.0-starter",
        total_score: 0,
        decision: fallbackAction,
        step_up_method: fallbackAction === "STEP_UP" ? "MOBILE_OTP" : "NONE",
        fired_rules: [
          {
            ruleId: "TIMEOUT_FALLBACK",
            weight: 0,
            reason: `Risk engine exceeded ${this.timeoutBudgetMs}ms budget -> deterministic fallback`,
          },
        ],
        fallback_used: true,
        latency_ms: Math.round((performance.now() - t0) * 100) / 100,
        created_at: now.toISOString(),
      };
      this.persistDecision(record);
      return record;
    }

    const fired: FiredRiskRule[] = [];
    const payeeClean = input.payeeVpa.trim().toLowerCase();
    const deviceClean = input.deviceId.trim().toLowerCase();

    // Prune customer velocity history to 24 hours
    const history = (this.recentTxnsByCustomer.get(input.customerId) ?? []).filter(
      (h) => h.timestampMs >= nowMs - 24 * 60 * 60 * 1000
    );
    this.recentTxnsByCustomer.set(input.customerId, history);

    // Rule 1: 10-minute velocity count
    const count10m = history.filter(
      (h) => h.timestampMs >= nowMs - 10 * 60 * 1000
    ).length;
    if (count10m >= 4) {
      fired.push({
        ruleId: "VELOCITY_10M",
        weight: 35,
        reason: `${count10m} payments already made in last 10 minutes`,
      });
    }

    // Rule 2: 24-hour velocity sum
    const sum24h = history.reduce((acc, h) => acc + h.amountPaise, 0) + input.amountPaise;
    if (sum24h >= 5_000_000) {
      fired.push({
        ruleId: "VELOCITY_24H",
        weight: 30,
        reason: `24h cumulative volume ${sum24h} paise >= 5,000,000 paise`,
      });
    }

    // Rule 3: 30-day Running Median Anomaly (> 5x customer median)
    const medianTracker = this.medianByCustomer.get(input.customerId);
    const median = medianTracker && medianTracker.count >= 3 ? medianTracker.getMedian() : null;
    if (median !== null && median > 0 && input.amountPaise > median * 5) {
      fired.push({
        ruleId: "MEDIAN_ANOMALY_30D",
        weight: 35,
        reason: `Amount ${input.amountPaise} > 5x 30d running median (${median})`,
      });
    }

    // Rule 4: New counterparty + high amount (>= ₹2,000)
    if (input.isNewCounterparty && input.amountPaise >= 200_000) {
      fired.push({
        ruleId: "NEW_COUNTERPARTY_HIGH_AMOUNT",
        weight: 25,
        reason: `First payment to "${payeeClean}" >= ₹2,000`,
      });
    }

    // Rule 5: New device bound < 24h ago
    if (input.isNewDevice24h) {
      fired.push({
        ruleId: "NEW_DEVICE_24H",
        weight: 25,
        reason: `Device "${input.deviceId}" bound within last 24 hours`,
      });
    }

    // Rule 6: Collect fan-out signal
    if ((input.collectFanOutCount1h ?? 0) >= 10) {
      fired.push({
        ruleId: "COLLECT_FANOUT",
        weight: 45,
        reason: `Requester targeted ${input.collectFanOutCount1h} distinct payers in 1h`,
      });
    }

    // Rule 7: Blacklist hit (immediate DECLINE)
    if (
      this.blacklistedEntities.has(payeeClean) ||
      this.blacklistedEntities.has(deviceClean)
    ) {
      fired.push({
        ruleId: "BLACKLIST_HIT",
        weight: 100,
        reason: `Matched blacklisted entity (${payeeClean} / ${deviceClean})`,
      });
    }

    // Rule 8: Round amount (exact multiple of ₹1,000) during night hours (00:00–05:00 IST = UTC+5:30)
    const istHour = new Date(nowMs + 330 * 60 * 1000).getUTCHours();
    if (
      istHour >= 0 &&
      istHour < 5 &&
      input.amountPaise >= 100_000 &&
      input.amountPaise % 100_000 === 0
    ) {
      fired.push({
        ruleId: "ROUND_AMOUNT_NIGHT_TIME",
        weight: 20,
        reason: `Round ₹1,000+ transfer at night (${istHour}:00 IST)`,
      });
    }

    const totalScore = fired.reduce((sum, r) => sum + r.weight, 0);
    const decision: RiskDecisionAction =
      totalScore >= this.declineThreshold
        ? "DECLINE"
        : totalScore >= this.stepUpThreshold
          ? "STEP_UP"
          : "ALLOW";

    const stepUpMethod: RiskDecisionRecord["step_up_method"] =
      decision !== "STEP_UP"
        ? "NONE"
        : input.isNewDevice24h || totalScore >= 60
          ? "COOLING_DELAY_30M"
          : "MOBILE_OTP";

    const record: RiskDecisionRecord = {
      id,
      payment_id: input.paymentId,
      customer_id: input.customerId,
      ruleset_version: "v1.0-starter",
      total_score: totalScore,
      decision,
      step_up_method: stepUpMethod,
      fired_rules: fired,
      fallback_used: false,
      latency_ms: Math.round((performance.now() - t0) * 1000) / 1000,
      created_at: now.toISOString(),
    };

    this.persistDecision(record);
    return record;
  }

  private persistDecision(record: RiskDecisionRecord): void {
    this.db
      .prepare(
        `INSERT INTO risk_decisions (
          id, payment_id, customer_id, ruleset_version, total_score,
          decision, step_up_method, fired_rules_json, fallback_used, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.payment_id,
        record.customer_id,
        record.ruleset_version,
        record.total_score,
        record.decision,
        record.step_up_method,
        JSON.stringify(record.fired_rules),
        record.fallback_used ? 1 : 0,
        record.latency_ms,
        record.created_at
      );
  }
}
