import type { DatabaseSync } from "node:sqlite";
import { AuditLogger } from "../../../packages/core/src/index.ts";
import type { AcquirerSimulator, PaymentMethod } from "./acquirer-simulator.ts";
import type { CardNetwork } from "./token-vault.ts";

/**
 * Project 2 — Orchestration & Dynamic Success-Rate Routing Engine (Requirements 10, 11, 12, 13, 14, Pages 13–14)
 *
 * Responsibilities:
 * - Req 10: Routing table per method with constraints (card network, issuing bank from 6-digit BIN, amount band).
 * - Req 11: Rolling health score per acquirer per method (`success_rate`, `p95_latency_ms`, `timeout_count`).
 *   Below configurable threshold (`demoteThresholdScore = 60`), acquirer is `DEMOTED`; above it, restored to `HEALTHY`.
 * - Req 12: Picks the healthiest eligible acquirer; on a `TECHNICAL_FAILURE` retries ONCE on the next healthiest
 *   acquirer within the customer's session; NEVER retries a `BUSINESS_DECLINE`.
 * - Req 13: Operator overrides (`forceAcquirerId` or `blockedAcquirerIds` per method) with an immutable audit entry.
 * - Req 14: Records `acquirer_id`, `routing_reason` (including score at the time), and `acquirer_response_code`
 *   on every payment attempt.
 */

export interface RoutingRuleConstraint {
  id: string;
  method: PaymentMethod;
  priorityOrder: number;
  acquirerId: string;
  cardNetworks?: CardNetwork[];
  issuerBanks?: string[];
  minAmountPaise?: number;
  maxAmountPaise?: number;
}

export interface AcquirerHealthSnapshot {
  acquirer_id: string;
  method: PaymentMethod;
  window_size: number;
  success_rate_percent: number;
  p95_latency_ms: number;
  timeout_count: number;
  score: number; // 0 to 100
  state: "HEALTHY" | "DEMOTED" | "BLOCKED";
}

export interface MethodRoutingOverride {
  method: PaymentMethod;
  forcedAcquirerId: string | null;
  blockedAcquirerIds: string[];
  updatedAt: string;
}

export interface SelectedCandidateAcquirer {
  acquirer: AcquirerSimulator;
  score: number;
  routingReason: string;
}

interface OutcomeSample {
  success: boolean;
  latencyMs: number;
  isTimeout: boolean;
  timestampMs: number;
}

export class AcquirerRoutingEngine {
  private readonly db: DatabaseSync;
  private readonly audit: AuditLogger;
  private readonly acquirers = new Map<string, AcquirerSimulator>();
  private readonly rules: RoutingRuleConstraint[] = [];
  private readonly rollingSamples = new Map<string, OutcomeSample[]>(); // key: `${acquirerId}:${method}`
  private readonly overrides = new Map<PaymentMethod, MethodRoutingOverride>();

  public demoteThresholdScore = 60;

  constructor(db: DatabaseSync, audit: AuditLogger) {
    this.db = db;
    this.audit = audit;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS acquirer_health (
        acquirer_id TEXT NOT NULL,
        method TEXT NOT NULL,
        window_size INTEGER NOT NULL,
        success_rate_percent REAL NOT NULL,
        p95_latency_ms INTEGER NOT NULL,
        timeout_count INTEGER NOT NULL,
        score REAL NOT NULL,
        state TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (acquirer_id, method)
      );
    `);
  }

  public registerAcquirer(acquirer: AcquirerSimulator): void {
    this.acquirers.set(acquirer.config.acquirerId, acquirer);
    for (const method of acquirer.config.supportedMethods) {
      this.recomputeHealth(acquirer.config.acquirerId, method);
    }
  }

  public addRoutingRule(rule: RoutingRuleConstraint): void {
    this.rules.push(rule);
    this.rules.sort((a, b) => a.priorityOrder - b.priorityOrder);
  }

  /**
   * Requirement 13 & Interface `PUT /routing/{method}` (operator/admin):
   * Force all traffic for a method to one acquirer, or block specific acquirers, with an audit entry.
   */
  public setMethodOverride(params: {
    method: PaymentMethod;
    forcedAcquirerId?: string | null;
    blockedAcquirerIds?: string[];
    actorId?: string;
    requestId?: string;
  }): MethodRoutingOverride {
    const prev = this.overrides.get(params.method) ?? {
      method: params.method,
      forcedAcquirerId: null,
      blockedAcquirerIds: [],
      updatedAt: new Date().toISOString(),
    };

    const next: MethodRoutingOverride = {
      method: params.method,
      forcedAcquirerId:
        params.forcedAcquirerId !== undefined ? params.forcedAcquirerId : prev.forcedAcquirerId,
      blockedAcquirerIds:
        params.blockedAcquirerIds !== undefined
          ? [...params.blockedAcquirerIds]
          : prev.blockedAcquirerIds,
      updatedAt: new Date().toISOString(),
    };

    this.overrides.set(params.method, next);

    for (const acq of this.acquirers.values()) {
      if (acq.config.supportedMethods.includes(params.method)) {
        this.recomputeHealth(acq.config.acquirerId, params.method);
      }
    }

    this.audit.record({
      actorId: params.actorId ?? "gateway-operator",
      actorRole: "operator",
      action: "UPDATE_ROUTING_OVERRIDE",
      entityType: "RoutingMethod",
      entityId: params.method,
      oldValue: prev,
      newValue: next,
      requestId: params.requestId ?? `REQ-ROUTING-${params.method}`,
      nowIso: next.updatedAt,
    });

    return next;
  }

  public getMethodOverride(method: PaymentMethod): MethodRoutingOverride {
    return (
      this.overrides.get(method) ?? {
        method,
        forcedAcquirerId: null,
        blockedAcquirerIds: [],
        updatedAt: new Date().toISOString(),
      }
    );
  }

  /**
   * Records an outcome from an acquirer call and recomputes its rolling health score (Requirement 11).
   */
  public recordOutcome(params: {
    acquirerId: string;
    method: PaymentMethod;
    success: boolean;
    latencyMs: number;
    isTimeout: boolean;
    nowMs?: number;
  }): AcquirerHealthSnapshot {
    const key = `${params.acquirerId}:${params.method}`;
    const nowMs = params.nowMs ?? Date.now();
    const list = this.rollingSamples.get(key) ?? [];

    // Keep rolling window of last 60 seconds (or last 50 samples)
    const cutoffMs = nowMs - 60_000;
    const pruned = list.filter((s) => s.timestampMs >= cutoffMs);
    pruned.push({
      success: params.success,
      latencyMs: params.latencyMs,
      isTimeout: params.isTimeout,
      timestampMs: nowMs,
    });
    if (pruned.length > 50) {
      pruned.shift();
    }
    this.rollingSamples.set(key, pruned);

    return this.recomputeHealth(params.acquirerId, params.method);
  }

  public recomputeHealth(acquirerId: string, method: PaymentMethod): AcquirerHealthSnapshot {
    const key = `${acquirerId}:${method}`;
    const samples = this.rollingSamples.get(key) ?? [];
    const acq = this.acquirers.get(acquirerId)!;
    const override = this.getMethodOverride(method);
    const isBlocked = override.blockedAcquirerIds.includes(acquirerId);

    let successRatePercent = 100;
    let p95LatencyMs = acq?.config.baseLatencyMs ?? 50;
    let timeoutCount = 0;

    if (samples.length > 0) {
      const successes = samples.filter((s) => s.success).length;
      successRatePercent = Math.round((successes / samples.length) * 10000) / 100;
      const sortedLat = samples.map((s) => s.latencyMs).sort((a, b) => a - b);
      p95LatencyMs = sortedLat[Math.floor(sortedLat.length * 0.95)] ?? sortedLat[0];
      timeoutCount = samples.filter((s) => s.isTimeout).length;
    }

    // Health Score formula (0 to 100):
    // 80% weight on success rate + 20% weight on low latency (<500ms), minus 10 points per timeout
    const latencyScore = Math.max(0, 100 - Math.min(100, p95LatencyMs / 10));
    const rawScore = successRatePercent * 0.8 + latencyScore * 0.2 - timeoutCount * 10;
    const score = isBlocked ? 0 : Math.max(0, Math.min(100, Math.round(rawScore * 100) / 100));

    const state: AcquirerHealthSnapshot["state"] = isBlocked
      ? "BLOCKED"
      : score < this.demoteThresholdScore
        ? "DEMOTED"
        : "HEALTHY";

    const snapshot: AcquirerHealthSnapshot = {
      acquirer_id: acquirerId,
      method,
      window_size: samples.length,
      success_rate_percent: successRatePercent,
      p95_latency_ms: p95LatencyMs,
      timeout_count: timeoutCount,
      score,
      state,
    };

    this.db
      .prepare(
        `INSERT INTO acquirer_health (
          acquirer_id, method, window_size, success_rate_percent,
          p95_latency_ms, timeout_count, score, state, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(acquirer_id, method) DO UPDATE SET
          window_size = excluded.window_size,
          success_rate_percent = excluded.success_rate_percent,
          p95_latency_ms = excluded.p95_latency_ms,
          timeout_count = excluded.timeout_count,
          score = excluded.score,
          state = excluded.state,
          updated_at = excluded.updated_at`
      )
      .run(
        snapshot.acquirer_id,
        snapshot.method,
        snapshot.window_size,
        snapshot.success_rate_percent,
        snapshot.p95_latency_ms,
        snapshot.timeout_count,
        snapshot.score,
        snapshot.state,
        new Date().toISOString()
      );

    return snapshot;
  }

  /**
   * Requirements 10, 11, 12, 13, 14:
   * Returns an ordered list of candidate acquirers for the payment session:
   * 1. If operator `forcedAcquirerId` is set, returns that acquirer with reason `OPERATOR_FORCED_OVERRIDE`.
   * 2. Otherwise filters out `BLOCKED` acquirers, evaluates routing constraints (card network, issuer bank from BIN6, amount band),
   *    places `HEALTHY` acquirers ahead of `DEMOTED` ones, and sorts by highest `score` (breaking ties by rule priorityOrder).
   */
  public selectRankedAcquirers(params: {
    method: PaymentMethod;
    amountPaise: number;
    cardNetwork?: CardNetwork;
    issuerBank?: string;
  }): SelectedCandidateAcquirer[] {
    const override = this.getMethodOverride(params.method);

    if (override.forcedAcquirerId) {
      const forced = this.acquirers.get(override.forcedAcquirerId);
      if (forced) {
        const health = this.recomputeHealth(forced.config.acquirerId, params.method);
        return [
          {
            acquirer: forced,
            score: health.score,
            routingReason: `OPERATOR_FORCED_OVERRIDE(acquirer=${forced.config.acquirerId}, score=${health.score})`,
          },
        ];
      }
    }

    // Match rules for this method & constraints
    const matchedAcquirerPriority = new Map<string, { priority: number; ruleId: string }>();

    for (const rule of this.rules) {
      if (rule.method !== params.method) {
        continue;
      }
      if (
        rule.cardNetworks &&
        params.cardNetwork &&
        !rule.cardNetworks.includes(params.cardNetwork)
      ) {
        continue;
      }
      if (rule.issuerBanks && params.issuerBank && !rule.issuerBanks.includes(params.issuerBank)) {
        continue;
      }
      if (rule.minAmountPaise !== undefined && params.amountPaise < rule.minAmountPaise) {
        continue;
      }
      if (rule.maxAmountPaise !== undefined && params.amountPaise > rule.maxAmountPaise) {
        continue;
      }
      if (!matchedAcquirerPriority.has(rule.acquirerId)) {
        matchedAcquirerPriority.set(rule.acquirerId, {
          priority: rule.priorityOrder,
          ruleId: rule.id,
        });
      }
    }

    // Include any registered acquirer supporting this method if not already in rules
    let fallbackPriority = 1000;
    for (const acq of this.acquirers.values()) {
      if (
        acq.config.supportedMethods.includes(params.method) &&
        !matchedAcquirerPriority.has(acq.config.acquirerId)
      ) {
        matchedAcquirerPriority.set(acq.config.acquirerId, {
          priority: fallbackPriority++,
          ruleId: "DEFAULT_METHOD_SUPPORT",
        });
      }
    }

    const candidates: Array<{
      acquirer: AcquirerSimulator;
      health: AcquirerHealthSnapshot;
      priority: number;
      ruleId: string;
    }> = [];

    for (const [acqId, meta] of matchedAcquirerPriority.entries()) {
      if (override.blockedAcquirerIds.includes(acqId)) {
        continue; // Blocked by operator override
      }
      const acq = this.acquirers.get(acqId);
      if (!acq) {
        continue;
      }
      const health = this.recomputeHealth(acqId, params.method);
      candidates.push({
        acquirer: acq,
        health,
        priority: meta.priority,
        ruleId: meta.ruleId,
      });
    }

    // Sort: HEALTHY before DEMOTED, then higher score, then lower priorityOrder number
    candidates.sort((a, b) => {
      if (a.health.state !== b.health.state) {
        return a.health.state === "HEALTHY" ? -1 : 1;
      }
      if (b.health.score !== a.health.score) {
        return b.health.score - a.health.score;
      }
      return a.priority - b.priority;
    });

    return candidates.map((c, idx) => ({
      acquirer: c.acquirer,
      score: c.health.score,
      routingReason:
        idx === 0
          ? `PRIMARY_HEALTHIEST(rule=${c.ruleId}, state=${c.health.state}, score=${c.health.score})`
          : `FAILOVER_CANDIDATE_${idx}(rule=${c.ruleId}, state=${c.health.state}, score=${c.health.score})`,
    }));
  }

  public listAllHealthSnapshots(): AcquirerHealthSnapshot[] {
    return this.db
      .prepare(`SELECT * FROM acquirer_health ORDER BY method ASC, score DESC`)
      .all() as unknown as AcquirerHealthSnapshot[];
  }
}
