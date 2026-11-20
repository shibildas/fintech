import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLogger,
  assertValidTransition,
  DISPUTE_TRANSITIONS,
  SlaDeadlineMinHeap,
  type DisputeState,
} from "@fintech/core";

/**
 * Project 3 (Day 20) — Consumer Dispute Desk Linked to Switch Reversals & Recon Exceptions
 *
 * State Machine (`DISPUTE_TRANSITIONS`):
 * `OPEN -> UNDER_REVIEW -> RESOLVED_CREDITED | RESOLVED_REJECTED | ESCALATED`
 * (Also allows direct `OPEN -> RESOLVED_CREDITED` when an automated Switch reversal lands!)
 */

export type DisputeCategory =
  | "DEBITED_NOT_CREDITED"
  | "UNAUTHORIZED_TRANSACTION"
  | "DUPLICATE_DEBIT"
  | "MERCHANT_NON_DELIVERY";

export const SLA_HOURS_BY_CATEGORY: Record<DisputeCategory, number> = {
  DEBITED_NOT_CREDITED: 24, // T+1 RBI TAT for failed UPI auto-reversals
  DUPLICATE_DEBIT: 24,
  UNAUTHORIZED_TRANSACTION: 72,
  MERCHANT_NON_DELIVERY: 120,
};

export interface DisputeRecord {
  id: string;
  customer_id: string;
  switch_rrn: string;
  recon_exception_id: string | null;
  category: DisputeCategory;
  amount_paise: number;
  customer_note: string;
  state: DisputeState;
  resolution_note: string | null;
  sla_deadline_at: string;
  created_at: string;
  updated_at: string;
}

export interface InboxNotificationRecord {
  id: string;
  customer_id: string;
  title: string;
  body: string;
  reference_id: string;
  created_at: string;
}

export interface EscalatedCaseFile {
  case_file_id: string;
  dispute_id: string;
  switch_rrn: string;
  recon_exception_id: string | null;
  category: DisputeCategory;
  amount_paise: number;
  sla_deadline_at: string;
  generated_at: string;
  summary_markdown: string;
}

export class ConsumerDisputeDesk {
  public readonly db: DatabaseSync;
  public readonly audit: AuditLogger;
  public readonly slaHeap = new SlaDeadlineMinHeap();

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.audit = new AuditLogger(this.db);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS disputes (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        switch_rrn TEXT NOT NULL,
        recon_exception_id TEXT,
        category TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        customer_note TEXT NOT NULL,
        state TEXT NOT NULL,
        resolution_note TEXT,
        sla_deadline_at TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_disputes_rrn ON disputes(switch_rrn);

      CREATE TABLE IF NOT EXISTS inbox_notifications (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  public openDispute(params: {
    customerId: string;
    switchRrn: string;
    reconExceptionId?: string | null;
    category: DisputeCategory;
    amountPaise: number;
    customerNote: string;
    now?: Date;
  }): DisputeRecord {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const slaMs = SLA_HOURS_BY_CATEGORY[params.category] * 60 * 60 * 1000;
    const deadlineMs = now.getTime() + slaMs;
    const deadlineIso = new Date(deadlineMs).toISOString();
    const id = `dsp_${crypto.randomUUID().slice(0, 10)}`;

    this.db
      .prepare(
        `INSERT INTO disputes (
          id, customer_id, switch_rrn, recon_exception_id, category,
          amount_paise, customer_note, state, resolution_note,
          sla_deadline_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'OPEN', NULL, ?, ?, ?)`
      )
      .run(
        id,
        params.customerId,
        params.switchRrn,
        params.reconExceptionId ?? null,
        params.category,
        params.amountPaise,
        params.customerNote,
        deadlineIso,
        nowIso,
        nowIso
      );

    this.slaHeap.push({
      entityId: id,
      deadlineMs,
      category: params.category,
    });

    this.pushInboxNotification({
      customerId: params.customerId,
      title: `Dispute ${id} Opened`,
      body: `We received your dispute for RRN ${params.switchRrn}. SLA deadline: ${deadlineIso}.`,
      referenceId: id,
      nowIso,
    });

    return this.getDispute(id)!;
  }

  public transitionDispute(params: {
    disputeId: string;
    toState: DisputeState;
    resolutionNote?: string;
    actorId?: string;
    now?: Date;
  }): DisputeRecord {
    const nowIso = (params.now ?? new Date()).toISOString();
    const current = this.getDispute(params.disputeId);
    if (!current) {
      throw new Error(`Dispute "${params.disputeId}" not found`);
    }

    assertValidTransition("Dispute", DISPUTE_TRANSITIONS, current.state, params.toState);

    this.db
      .prepare(
        `UPDATE disputes SET state = ?, resolution_note = COALESCE(?, resolution_note), updated_at = ?
         WHERE id = ?`
      )
      .run(params.toState, params.resolutionNote ?? null, nowIso, params.disputeId);

    this.audit.record({
      actorId: params.actorId ?? "ops-dispute-agent",
      actorRole: "operator",
      action: "DISPUTE_STATE_TRANSITION",
      entityType: "Dispute",
      entityId: params.disputeId,
      oldValue: { state: current.state },
      newValue: { state: params.toState, resolution_note: params.resolutionNote ?? null },
      requestId: `REQ-DSP-${params.disputeId}`,
      nowIso,
    });

    return this.getDispute(params.disputeId)!;
  }

  /**
   * Auto-resolution listener triggered when Project 1 CentralSwitch completes an `0420` reversal
   * for a disputed `switch_rrn`. Automatically moves `OPEN`/`UNDER_REVIEW` disputes to `RESOLVED_CREDITED`
   * and notifies the customer in their in-app inbox.
   */
  public handleSwitchReversalEvent(params: {
    switchRrn: string;
    reversalReference: string;
    now?: Date;
  }): DisputeRecord[] {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const openRows = this.db
      .prepare(
        `SELECT * FROM disputes WHERE switch_rrn = ? AND state IN ('OPEN', 'UNDER_REVIEW')`
      )
      .all(params.switchRrn) as unknown as DisputeRecord[];

    const resolved: DisputeRecord[] = [];
    for (const d of openRows) {
      if (d.state === "OPEN") {
        this.transitionDispute({
          disputeId: d.id,
          toState: "UNDER_REVIEW",
          actorId: "switch-reversal-listener",
          now,
        });
      }
      const done = this.transitionDispute({
        disputeId: d.id,
        toState: "RESOLVED_CREDITED",
        resolutionNote: `Auto-resolved: Switch 0420 reversal ${params.reversalReference} credited back to bank account.`,
        actorId: "switch-reversal-listener",
        now,
      });
      this.pushInboxNotification({
        customerId: d.customer_id,
        title: `Refund Credited — Dispute ${d.id} Resolved`,
        body: `₹${(d.amount_paise / 100).toFixed(2)} for RRN ${d.switch_rrn} was auto-reversed (${params.reversalReference}).`,
        referenceId: d.id,
        nowIso,
      });
      resolved.push(done);
    }
    return resolved;
  }

  /**
   * Generates a downloadable NPCI/Bank Escalated Case File for an `ESCALATED` dispute.
   */
  public generateEscalatedCaseFile(disputeId: string, now = new Date()): EscalatedCaseFile {
    const d = this.getDispute(disputeId);
    if (!d) {
      throw new Error(`Dispute "${disputeId}" not found`);
    }
    if (d.state !== "ESCALATED") {
      throw new Error(`Case file requires ESCALATED state (currently "${d.state}")`);
    }

    const nowIso = now.toISOString();
    const summaryMarkdown = [
      `# Escalated Dispute Case File — ${d.id}`,
      `- **Switch RRN**: \`${d.switch_rrn}\``,
      `- **Recon Exception ID**: \`${d.recon_exception_id ?? "NONE"}\``,
      `- **Category**: \`${d.category}\``,
      `- **Amount**: ₹${(d.amount_paise / 100).toFixed(2)} (\`${d.amount_paise}\` paise)`,
      `- **SLA Deadline**: \`${d.sla_deadline_at}\``,
      `- **Customer Statement**: ${d.customer_note}`,
      `- **Escalation Note**: ${d.resolution_note ?? "Escalated to NPCI/Beneficiary Bank"}`,
    ].join("\n");

    return {
      case_file_id: `CASE-${d.id}`,
      dispute_id: d.id,
      switch_rrn: d.switch_rrn,
      recon_exception_id: d.recon_exception_id,
      category: d.category,
      amount_paise: d.amount_paise,
      sla_deadline_at: d.sla_deadline_at,
      generated_at: nowIso,
      summary_markdown: summaryMarkdown,
    };
  }

  /**
   * Uses the Min-Heap SLA tracker to extract all still-open disputes past their SLA deadline.
   */
  public findSlaBreachedDisputes(now = new Date()): DisputeRecord[] {
    const candidates = this.slaHeap.extractBreached(now.getTime());
    const stillOpenBreached: DisputeRecord[] = [];
    for (const c of candidates) {
      const d = this.getDispute(c.entityId);
      if (d && (d.state === "OPEN" || d.state === "UNDER_REVIEW")) {
        stillOpenBreached.push(d);
      }
    }
    return stillOpenBreached;
  }

  public listInboxNotifications(customerId: string): InboxNotificationRecord[] {
    return this.db
      .prepare(`SELECT * FROM inbox_notifications WHERE customer_id = ? ORDER BY created_at ASC`)
      .all(customerId) as unknown as InboxNotificationRecord[];
  }

  public getDispute(disputeId: string): DisputeRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM disputes WHERE id = ?`)
      .get(disputeId) as unknown as DisputeRecord | undefined;
  }

  private pushInboxNotification(params: {
    customerId: string;
    title: string;
    body: string;
    referenceId: string;
    nowIso: string;
  }): void {
    this.db
      .prepare(
        `INSERT INTO inbox_notifications (id, customer_id, title, body, reference_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `ntf_${crypto.randomUUID().slice(0, 10)}`,
        params.customerId,
        params.title,
        params.body,
        params.referenceId,
        params.nowIso
      );
  }
}
