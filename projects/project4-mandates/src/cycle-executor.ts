import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AuditLogger, DistributedLeaseManager, type Clock } from "@fintech/core";
import type { CentralSwitch, PspSimulator } from "@fintech/project1-switch";
import type { MandateService } from "./mandate-service.ts";
import type { SubscriptionService } from "./subscription-service.ts";

/**
 * Project 4 (Day 24) — 24h Pre-Debit Notice Gate & Kill-Safe Exactly-Once Cycle Executor
 *
 * Guarantees:
 * 1. Regulatory 24h Pre-Debit Notice Gate: Cannot execute a cycle unless a notice was
 *    sent & recorded >= 24 hours earlier (`nowMs - sent_at >= 24h`) with a 1-click pause/cancel link.
 * 2. Customer Local Execution Window: `06:00–22:00` customer local time.
 * 3. Exactly-Once Execution Key: `execution_key = ${subscriptionId}:cycle:${cycleNumber}`
 *    enforced by SQLite `PRIMARY KEY` + `DistributedLeaseManager`.
 * 4. Kill-Safe Crash Recovery: If the executor crashes between claiming `execution_key`
 *    and persisting the Switch response, `recoverCrashedExecutions()` queries the Switch
 *    using the deterministic `transaction_id = execution_key` and converges with strictly 1 bank debit!
 */

export const PRE_DEBIT_MIN_LEAD_MS = 24 * 60 * 60 * 1000;

export interface PreDebitNoticeRecord {
  execution_key: string;
  subscription_id: string;
  cycle_number: number;
  customer_id: string;
  amount_paise: number;
  pause_or_cancel_url: string;
  sent_at: string;
}

export interface CycleExecutionRecord {
  execution_key: string;
  subscription_id: string;
  cycle_number: number;
  mandate_id: string;
  amount_paise: number;
  worker_id: string;
  state: "CLAIMED" | "SUCCEEDED" | "FAILED_SOFT" | "FAILED_HARD";
  switch_rrn: string | null;
  error_reason: string | null;
  claimed_at: string;
  updated_at: string;
}

export class ExecutorSimulatedCrashError extends Error {
  public readonly executionKey: string;
  constructor(executionKey: string) {
    super(`Executor process killed mid-flight after Switch debit for ${executionKey}`);
    this.name = "ExecutorSimulatedCrashError";
    this.executionKey = executionKey;
  }
}

export class RecurringCycleExecutor {
  public readonly db: DatabaseSync;
  public readonly audit: AuditLogger;
  public readonly leaseManager = new DistributedLeaseManager();
  private readonly mandates: MandateService;
  private readonly subs: SubscriptionService;
  private readonly p1Switch: CentralSwitch;
  private readonly p1Psp: PspSimulator;
  private readonly merchantVpa: string;
  private readonly clock: Clock;

  public simulateCrashAfterSwitchDebit = false;

  constructor(params: {
    mandates: MandateService;
    subs: SubscriptionService;
    p1Switch: CentralSwitch;
    p1Psp: PspSimulator;
    merchantVpa?: string;
    clock?: Clock;
    dbPath?: string;
  }) {
    this.db = new DatabaseSync(params.dbPath ?? ":memory:");
    this.audit = new AuditLogger(this.db);
    this.mandates = params.mandates;
    this.subs = params.subs;
    this.p1Switch = params.p1Switch;
    this.p1Psp = params.p1Psp;
    this.merchantVpa = params.merchantVpa ?? "shop@psp2";
    this.clock = params.clock ?? { now: () => new Date(), nowMs: () => Date.now() };
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS pre_debit_notices (
        execution_key TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        cycle_number INTEGER NOT NULL,
        customer_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        pause_or_cancel_url TEXT NOT NULL,
        sent_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS cycle_executions (
        execution_key TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        cycle_number INTEGER NOT NULL,
        mandate_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('CLAIMED', 'SUCCEEDED', 'FAILED_SOFT', 'FAILED_HARD')),
        switch_rrn TEXT,
        error_reason TEXT,
        claimed_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public static buildExecutionKey(subscriptionId: string, cycleNumber: number): string {
    return `${subscriptionId}:cycle:${cycleNumber}`;
  }

  /**
   * Sends & records the mandatory RBI 24-hour pre-debit notice with a 1-click pause/cancel link.
   */
  public sendPreDebitNotice(subscriptionId: string, cycleNumber: number): PreDebitNoticeRecord {
    const sub = this.subs.getSubscription(subscriptionId);
    if (!sub) {
      throw new Error(`Subscription "${subscriptionId}" not found`);
    }
    const plan = this.subs.getPlan(sub.plan_id)!;
    const executionKey = RecurringCycleExecutor.buildExecutionKey(subscriptionId, cycleNumber);
    const nowIso = this.clock.now().toISOString();
    const pauseUrl = `https://portal.mandates.local/manage/${sub.id}?action=pause_or_cancel&key=${encodeURIComponent(
      executionKey
    )}`;

    this.db
      .prepare(
        `INSERT OR IGNORE INTO pre_debit_notices (
          execution_key, subscription_id, cycle_number, customer_id,
          amount_paise, pause_or_cancel_url, sent_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(executionKey, sub.id, cycleNumber, sub.customer_id, plan.amount_paise, pauseUrl, nowIso);

    return this.getPreDebitNotice(executionKey)!;
  }

  /**
   * Executes a single recurring billing cycle with:
   * - Mandatory 24h Pre-Debit Notice gate
   * - Customer local 06:00–22:00 execution window
   * - Atomic `execution_key` claim + Distributed Lease
   * - Mandate cap validation + Project 1 CentralSwitch debit
   */
  public async executeCycle(params: {
    subscriptionId: string;
    cycleNumber: number;
    workerId?: string;
    mandatePin?: string;
  }): Promise<{ execution: CycleExecutionRecord; alreadyExecuted: boolean }> {
    const now = this.clock.now();
    const nowMs = now.getTime();
    const nowIso = now.toISOString();
    const workerId = params.workerId ?? `worker_${crypto.randomUUID().slice(0, 6)}`;
    const executionKey = RecurringCycleExecutor.buildExecutionKey(
      params.subscriptionId,
      params.cycleNumber
    );

    // 1. Idempotency check: if already finalized, return immediately without re-debiting!
    const existing = this.getExecution(executionKey);
    if (existing && existing.state === "SUCCEEDED") {
      return { execution: existing, alreadyExecuted: true };
    }

    const sub = this.subs.getSubscription(params.subscriptionId);
    if (!sub) {
      throw new Error(`Subscription "${params.subscriptionId}" not found`);
    }
    if (sub.state !== "ACTIVE" && sub.state !== "PAST_DUE") {
      throw Object.assign(new Error(`Subscription "${sub.id}" is "${sub.state}" — debit aborted`), {
        statusCode: 403,
      });
    }

    // 2. Customer local execution window check (06:00–22:00)
    const localHour = new Date(nowMs + sub.tz_offset_minutes * 60 * 1000).getUTCHours();
    if (localHour < 6 || localHour >= 22) {
      throw Object.assign(
        new Error(
          `Outside permitted execution window (06:00–22:00 local; currently ${localHour}:00)`
        ),
        { statusCode: 425 }
      );
    }

    // 3. Mandatory RBI 24-hour Pre-Debit Notice Gate
    const notice = this.getPreDebitNotice(executionKey);
    if (!notice) {
      throw Object.assign(
        new Error(`RBI Pre-Debit Gate: no pre-debit notice sent for ${executionKey}`),
        { statusCode: 403 }
      );
    }
    const elapsedSinceNoticeMs = nowMs - Date.parse(notice.sent_at);
    if (elapsedSinceNoticeMs < PRE_DEBIT_MIN_LEAD_MS) {
      throw Object.assign(
        new Error(
          `RBI Pre-Debit Gate: only ${(elapsedSinceNoticeMs / 3_600_000).toFixed(
            1
          )}h elapsed since notice (minimum 24h required)`
        ),
        { statusCode: 403 }
      );
    }

    // 4. Acquire Distributed Lease & Atomic SQLite CLAIM
    const lease = this.leaseManager.acquire({
      key: executionKey,
      ownerId: workerId,
      leaseDurationMs: 30_000,
      nowMs,
    });
    if (!lease.acquired) {
      throw Object.assign(
        new Error(`Execution ${executionKey} currently leased by ${lease.heldBy}`),
        { statusCode: 409 }
      );
    }

    const plan = this.subs.getPlan(sub.plan_id)!;
    if (!existing) {
      this.db
        .prepare(
          `INSERT INTO cycle_executions (
            execution_key, subscription_id, cycle_number, mandate_id, amount_paise,
            worker_id, state, claimed_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'CLAIMED', ?, ?)`
        )
        .run(
          executionKey,
          sub.id,
          params.cycleNumber,
          sub.mandate_id,
          plan.amount_paise,
          workerId,
          nowIso,
          nowIso
        );
    }

    try {
      // 5. Validate Mandate state & caps
      const mandate = this.mandates.validateAndReserveDebitCap({
        mandateId: sub.mandate_id,
        amountPaise: plan.amount_paise,
        now,
      });

      // 6. Execute synchronous AutoPay debit via Project 1 CentralSwitch
      //    Deterministic transactionId = executionKey guarantees Switch idempotency!
      const env = this.p1Psp.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: executionKey,
        payerVpa: mandate.payer_vpa ?? "anita@psp1",
        payeeVpa: this.merchantVpa,
        amountPaise: plan.amount_paise,
        now,
      });

      const switchRes = await this.p1Switch.handlePay({
        envelope: env,
        rawPin: params.mandatePin ?? "1234",
        now,
      });

      // Kill Test Hook: simulate SIGKILL right after Switch debited bank but BEFORE executor writes DB!
      if (this.simulateCrashAfterSwitchDebit) {
        throw new ExecutorSimulatedCrashError(executionKey);
      }

      const finalState: CycleExecutionRecord["state"] =
        switchRes.transaction.state === "SUCCESS" ? "SUCCEEDED" : "FAILED_SOFT";

      this.db
        .prepare(
          `UPDATE cycle_executions
           SET state = ?, switch_rrn = ?, error_reason = ?, updated_at = ?
           WHERE execution_key = ?`
        )
        .run(
          finalState,
          switchRes.transaction.rrn,
          finalState === "SUCCEEDED"
            ? null
            : `Switch code ${switchRes.envelope.response_code ?? "91"}`,
          this.clock.now().toISOString(),
          executionKey
        );

      return { execution: this.getExecution(executionKey)!, alreadyExecuted: false };
    } finally {
      this.leaseManager.release(executionKey, workerId);
    }
  }

  /**
   * Crash Recovery Worker: finds all `CLAIMED` rows left behind after an executor crash,
   * checks their deterministic `transaction_id = execution_key` on Project 1's CentralSwitch,
   * and finalizes them to `SUCCEEDED` without issuing a second bank debit!
   */
  public recoverCrashedExecutions(): CycleExecutionRecord[] {
    const claimedRows = this.db
      .prepare(`SELECT * FROM cycle_executions WHERE state = 'CLAIMED'`)
      .all() as unknown as CycleExecutionRecord[];

    const recovered: CycleExecutionRecord[] = [];
    for (const row of claimedRows) {
      const switchTxn = this.p1Switch.db
        .prepare(`SELECT rrn, state FROM switch_transactions WHERE transaction_id = ?`)
        .get(row.execution_key) as { rrn: string; state: string } | undefined;

      if (switchTxn && switchTxn.state === "SUCCESS") {
        this.db
          .prepare(
            `UPDATE cycle_executions
             SET state = 'SUCCEEDED', switch_rrn = ?, updated_at = ?
             WHERE execution_key = ?`
          )
          .run(switchTxn.rrn, this.clock.now().toISOString(), row.execution_key);
        recovered.push(this.getExecution(row.execution_key)!);
      }
    }
    return recovered;
  }

  public getPreDebitNotice(executionKey: string): PreDebitNoticeRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM pre_debit_notices WHERE execution_key = ?`)
      .get(executionKey) as unknown as PreDebitNoticeRecord | undefined;
  }

  public getExecution(executionKey: string): CycleExecutionRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM cycle_executions WHERE execution_key = ?`)
      .get(executionKey) as unknown as CycleExecutionRecord | undefined;
  }
}
