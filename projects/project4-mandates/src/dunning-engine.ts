import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { buildDunningSchedule, DEFAULT_DUNNING_OFFSETS_DAYS, type Clock } from "@fintech/core";
import type { PaymentGatewayEngine } from "@fintech/project2-gateway";
import type { SubscriptionService } from "./subscription-service.ts";

/**
 * Project 4 (Day 26) — Dunning Engine, Soft vs Hard Failures, Grace Periods & Pay-Now Recovery
 */

export type FailureClass = "SOFT" | "HARD";

export interface DunningCaseRecord {
  id: string;
  subscription_id: string;
  execution_key: string;
  amount_paise: number;
  failure_code: string;
  failure_class: FailureClass;
  status: "ACTIVE_DUNNING" | "RECOVERED_RETRY" | "RECOVERED_PAY_NOW" | "EXHAUSTED_HALTED";
  pay_now_order_id: string | null;
  pay_now_url: string | null;
  customer_message: string;
  grace_period_ends_at: string;
  created_at: string;
  updated_at: string;
}

export interface DunningRetryRecord {
  retry_execution_key: string;
  dunning_case_id: string;
  attempt_number: number;
  scheduled_at: string;
  status: "SCHEDULED" | "SUCCEEDED" | "FAILED" | "CANCELLED";
  updated_at: string;
}

const HARD_FAILURE_CODES = new Set([
  "78_ACCOUNT_CLOSED",
  "14_MANDATE_NOT_FOUND",
  "MANDATE_REVOKED",
]);

export function classifyRecurringFailure(failureCode: string): FailureClass {
  return HARD_FAILURE_CODES.has(failureCode) ? "HARD" : "SOFT";
}

export class DunningEngine {
  public readonly db: DatabaseSync;
  private readonly subs: SubscriptionService;
  private readonly gateway?: PaymentGatewayEngine;
  private readonly clock: Clock;
  private readonly retryOffsetsDays: readonly number[];

  constructor(params: {
    subs: SubscriptionService;
    gateway?: PaymentGatewayEngine;
    clock?: Clock;
    retryOffsetsDays?: readonly number[];
    dbPath?: string;
  }) {
    this.db = new DatabaseSync(params.dbPath ?? ":memory:");
    this.subs = params.subs;
    this.gateway = params.gateway;
    this.clock = params.clock ?? { now: () => new Date(), nowMs: () => Date.now() };
    this.retryOffsetsDays = params.retryOffsetsDays ?? DEFAULT_DUNNING_OFFSETS_DAYS;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dunning_cases (
        id TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        execution_key TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        failure_code TEXT NOT NULL,
        failure_class TEXT NOT NULL CHECK (failure_class IN ('SOFT', 'HARD')),
        status TEXT NOT NULL CHECK (status IN ('ACTIVE_DUNNING', 'RECOVERED_RETRY', 'RECOVERED_PAY_NOW', 'EXHAUSTED_HALTED')),
        pay_now_order_id TEXT,
        pay_now_url TEXT,
        customer_message TEXT NOT NULL,
        grace_period_ends_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS dunning_retries (
        retry_execution_key TEXT PRIMARY KEY,
        dunning_case_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        scheduled_at TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('SCHEDULED', 'SUCCEEDED', 'FAILED', 'CANCELLED')),
        updated_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Handles a failed recurring debit:
   * - `HARD` failure (`78_ACCOUNT_CLOSED`, `14_MANDATE_NOT_FOUND`, `MANDATE_REVOKED`):
   *   Immediately transitions subscription to `HALTED` with 0 retries.
   * - `SOFT` failure (`51_INSUFFICIENT_FUNDS`, `68_TIMEOUT`, `91_BANK_DOWN`):
   *   Transitions subscription `ACTIVE -> PAST_DUE`, schedules Day 1/3/7 fresh retries,
   *   and generates a Pay-Now Link backed by a Project 2 Gateway Order!
   */
  public async handleDebitFailure(params: {
    subscriptionId: string;
    executionKey: string;
    amountPaise: number;
    failureCode: string;
  }): Promise<{ dunningCase: DunningCaseRecord; scheduledRetries: DunningRetryRecord[] }> {
    const now = this.clock.now();
    const nowIso = now.toISOString();
    const sub = this.subs.getSubscription(params.subscriptionId);
    if (!sub) {
      throw new Error(`Subscription "${params.subscriptionId}" not found`);
    }

    const failureClass = classifyRecurringFailure(params.failureCode);
    const caseId = `dun_${crypto.randomUUID().slice(0, 10)}`;

    if (failureClass === "HARD") {
      if (sub.state === "ACTIVE") {
        this.subs.transitionState(sub.id, "PAST_DUE");
      }
      this.subs.transitionState(sub.id, "HALTED");

      const msg = `Your subscription ${sub.id} has been halted due to a permanent mandate/account error (${params.failureCode}). Please register a new mandate.`;
      this.db
        .prepare(
          `INSERT INTO dunning_cases (
            id, subscription_id, execution_key, amount_paise, failure_code, failure_class,
            status, pay_now_order_id, pay_now_url, customer_message, grace_period_ends_at,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, 'HARD', 'EXHAUSTED_HALTED', NULL, NULL, ?, ?, ?, ?)`
        )
        .run(
          caseId,
          sub.id,
          params.executionKey,
          params.amountPaise,
          params.failureCode,
          msg,
          nowIso,
          nowIso,
          nowIso
        );

      return { dunningCase: this.getCase(caseId)!, scheduledRetries: [] };
    }

    // SOFT failure -> PAST_DUE + Day 1, 3, 7 schedule + Project 2 Pay-Now Order
    if (sub.state === "ACTIVE") {
      this.subs.transitionState(sub.id, "PAST_DUE");
    }

    const plan = buildDunningSchedule({
      baseExecutionKey: params.executionKey,
      failedAtMs: now.getTime(),
      retryOffsetsDays: this.retryOffsetsDays,
    });

    let payNowOrderId: string | null = null;
    let payNowUrl = `https://checkout.gateway.local/pay-now/${caseId}`;

    if (this.gateway) {
      const { order } = await this.gateway.createOrder({
        merchantId: sub.merchant_id,
        idempotencyKey: `PAYNOW-${params.executionKey}`,
        amountPaise: params.amountPaise,
        merchantOrderId: `PAYNOW-${sub.id}-${params.executionKey}`,
        customerReference: sub.customer_id,
        expiryMinutes: 7 * 24 * 60, // Valid for entire 7-day grace window
        now,
      });
      payNowOrderId = order.id;
      payNowUrl = order.checkout_url;
    }

    const msg = `Payment of ₹${(params.amountPaise / 100).toFixed(2)} failed (${params.failureCode}). We will retry on Days ${this.retryOffsetsDays.join(", ")}. Or pay instantly now: ${payNowUrl}`;

    this.db
      .prepare(
        `INSERT INTO dunning_cases (
          id, subscription_id, execution_key, amount_paise, failure_code, failure_class,
          status, pay_now_order_id, pay_now_url, customer_message, grace_period_ends_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 'SOFT', 'ACTIVE_DUNNING', ?, ?, ?, ?, ?, ?)`
      )
      .run(
        caseId,
        sub.id,
        params.executionKey,
        params.amountPaise,
        params.failureCode,
        payNowOrderId,
        payNowUrl,
        msg,
        plan.gracePeriodEndsAtIso,
        nowIso,
        nowIso
      );

    const insertRetry = this.db.prepare(
      `INSERT INTO dunning_retries (
        retry_execution_key, dunning_case_id, attempt_number, scheduled_at, status, updated_at
      ) VALUES (?, ?, ?, ?, 'SCHEDULED', ?)`
    );
    for (const a of plan.attempts) {
      insertRetry.run(a.retryExecutionKey, caseId, a.attemptNumber, a.scheduledAtIso, nowIso);
    }

    return {
      dunningCase: this.getCase(caseId)!,
      scheduledRetries: this.listRetries(caseId),
    };
  }

  /**
   * Processes due scheduled retries (`scheduled_at <= clock.now()`) via an injected attempt runner.
   * If all retries fail and grace period elapses, transitions subscription `PAST_DUE -> HALTED`.
   */
  public async processDueRetries(
    attemptDebit: (retryKey: string, dunningCase: DunningCaseRecord) => Promise<boolean>
  ): Promise<{ succeeded: number; failed: number; halted: number }> {
    const now = this.clock.now();
    const nowIso = now.toISOString();

    const dueRetries = this.db
      .prepare(
        `SELECT * FROM dunning_retries
         WHERE status = 'SCHEDULED' AND scheduled_at <= ?
         ORDER BY scheduled_at ASC`
      )
      .all(nowIso) as unknown as DunningRetryRecord[];

    let succeeded = 0;
    let failed = 0;
    let halted = 0;

    for (const retry of dueRetries) {
      const dCase = this.getCase(retry.dunning_case_id)!;
      if (dCase.status !== "ACTIVE_DUNNING") {
        continue;
      }

      const ok = await attemptDebit(retry.retry_execution_key, dCase);
      if (ok) {
        succeeded++;
        this.db
          .prepare(
            `UPDATE dunning_retries SET status = 'SUCCEEDED', updated_at = ? WHERE retry_execution_key = ?`
          )
          .run(nowIso, retry.retry_execution_key);
        this.db
          .prepare(
            `UPDATE dunning_retries SET status = 'CANCELLED', updated_at = ?
             WHERE dunning_case_id = ? AND status = 'SCHEDULED'`
          )
          .run(nowIso, dCase.id);
        this.db
          .prepare(
            `UPDATE dunning_cases SET status = 'RECOVERED_RETRY', updated_at = ? WHERE id = ?`
          )
          .run(nowIso, dCase.id);
        this.subs.transitionState(dCase.subscription_id, "ACTIVE");
      } else {
        failed++;
        this.db
          .prepare(
            `UPDATE dunning_retries SET status = 'FAILED', updated_at = ? WHERE retry_execution_key = ?`
          )
          .run(nowIso, retry.retry_execution_key);
      }
    }

    // Check if any ACTIVE_DUNNING case has exhausted all retries -> HALT subscription
    const activeCases = this.db
      .prepare(`SELECT * FROM dunning_cases WHERE status = 'ACTIVE_DUNNING'`)
      .all() as unknown as DunningCaseRecord[];

    for (const c of activeCases) {
      const remaining = this.db
        .prepare(
          `SELECT COUNT(*) AS cnt FROM dunning_retries WHERE dunning_case_id = ? AND status = 'SCHEDULED'`
        )
        .get(c.id) as { cnt: number };

      if (remaining.cnt === 0) {
        halted++;
        this.db
          .prepare(
            `UPDATE dunning_cases SET status = 'EXHAUSTED_HALTED', updated_at = ? WHERE id = ?`
          )
          .run(nowIso, c.id);
        this.subs.transitionState(c.subscription_id, "HALTED");
      }
    }

    return { succeeded, failed, halted };
  }

  /**
   * Out-of-Band Pay-Now Recovery: customer clicks the Pay-Now link and pays via Project 2 Gateway.
   * Cancels all pending scheduled retries and restores subscription `PAST_DUE -> ACTIVE`!
   */
  public async recoverViaPayNowCard(params: {
    dunningCaseId: string;
    cardNumber: string;
    expiry: string;
    cardOtp?: string;
  }): Promise<{ dunningCase: DunningCaseRecord; paymentState: string }> {
    if (!this.gateway) {
      throw new Error("Project 2 PaymentGatewayEngine not wired for Pay-Now recovery");
    }
    const dCase = this.getCase(params.dunningCaseId);
    if (!dCase || !dCase.pay_now_order_id || dCase.status !== "ACTIVE_DUNNING") {
      throw Object.assign(new Error(`Active Pay-Now case "${params.dunningCaseId}" not found`), {
        statusCode: 409,
      });
    }

    const sub = this.subs.getSubscription(dCase.subscription_id)!;
    const now = this.clock.now();
    const nowIso = now.toISOString();

    const tok = this.gateway.vault.tokenize({
      cardNumber: params.cardNumber,
      expiry: params.expiry,
      merchantId: sub.merchant_id,
      customerReference: sub.customer_id,
      now,
    });

    const payRes = await this.gateway.payOrder({
      orderId: dCase.pay_now_order_id,
      method: "CARD",
      tokenId: tok.token,
      cardOtp: params.cardOtp ?? "123456",
      now,
    });

    if (payRes.payment.state !== "CAPTURED") {
      throw new Error(`Pay-Now checkout failed with state "${payRes.payment.state}"`);
    }

    this.db
      .prepare(
        `UPDATE dunning_retries SET status = 'CANCELLED', updated_at = ?
         WHERE dunning_case_id = ? AND status = 'SCHEDULED'`
      )
      .run(nowIso, dCase.id);

    this.db
      .prepare(`UPDATE dunning_cases SET status = 'RECOVERED_PAY_NOW', updated_at = ? WHERE id = ?`)
      .run(nowIso, dCase.id);

    this.subs.transitionState(sub.id, "ACTIVE");

    return {
      dunningCase: this.getCase(dCase.id)!,
      paymentState: payRes.payment.state,
    };
  }

  public getCase(caseId: string): DunningCaseRecord | undefined {
    return this.db.prepare(`SELECT * FROM dunning_cases WHERE id = ?`).get(caseId) as unknown as
      DunningCaseRecord | undefined;
  }

  public listRetries(caseId: string): DunningRetryRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM dunning_retries WHERE dunning_case_id = ? ORDER BY attempt_number ASC`
      )
      .all(caseId) as unknown as DunningRetryRecord[];
  }
}
