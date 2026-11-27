import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuditLogger } from "../../../packages/core/src/index.ts";
import type { BankCoreSimulator, BankEodReportRow } from "./bank-core.ts";
import type { SwitchTransactionRecord } from "./switch-engine.ts";

/**
 * Project 1 — Three-Way Reconciliation Engine (Requirements 21, 22, 23, 24 & Acceptance Test 9, Pages 8–11)
 *
 * Loads three independent sources for a settlement cycle:
 *   1. Switch transaction log (`switch_transactions`)
 *   2. Remitter bank EOD reports (`BankEodReportRow` with direction === 'DEBIT')
 *   3. Beneficiary bank EOD reports (`BankEodReportRow` with direction === 'CREDIT')
 *
 * Matches on `RRN`, `amount_paise`, and `final status`, classifying every record into:
 *   - `MATCHED`
 *   - `MISSING_AT_REMITTER`
 *   - `MISSING_AT_BENEFICIARY`
 *   - `MISSING_AT_SWITCH`
 *   - `AMOUNT_MISMATCH`
 *   - `STATUS_MISMATCH`
 *
 * Exceptions queue supports operator resolution actions (`TRIGGER_CREDIT`, `TRIGGER_REVERSAL`,
 * `MARK_INVESTIGATED`, `ATTACH_NOTE`), writing an immutable audit log entry and, where money moves,
 * a double-entry posting carrying `exception_id` (Requirement 23 & Acceptance Test 9).
 */

export type ReconciliationClass =
  | "MATCHED"
  | "MISSING_AT_REMITTER"
  | "MISSING_AT_BENEFICIARY"
  | "MISSING_AT_SWITCH"
  | "AMOUNT_MISMATCH"
  | "STATUS_MISMATCH";

export type ExceptionResolutionAction =
  "TRIGGER_CREDIT" | "TRIGGER_REVERSAL" | "MARK_INVESTIGATED" | "ATTACH_NOTE";

export interface ReconciliationRecord {
  id: string;
  cycle_id: string;
  rrn: string;
  transaction_id: string | null;
  classification: ReconciliationClass;
  switch_state: string | null;
  switch_amount_paise: number | null;
  remitter_bank_id: string | null;
  remitter_state: string | null;
  remitter_amount_paise: number | null;
  beneficiary_bank_id: string | null;
  beneficiary_state: string | null;
  beneficiary_amount_paise: number | null;
  discrepancy_amount_paise: number;
  status: "MATCHED" | "OPEN_EXCEPTION" | "RESOLVED";
  resolution_action: ExceptionResolutionAction | null;
  resolution_note: string | null;
  resolution_posting_journal_id: string | null;
  resolved_by: string | null;
  created_at: string;
  resolved_at: string | null;
}

export interface ReconciliationClassBreakdown {
  classification: ReconciliationClass;
  count: number;
  total_amount_paise: number;
}

export interface ReconciliationCycleSummary {
  cycle_id: string;
  total_records: number;
  matched_count: number;
  exception_count: number;
  open_exception_count: number;
  match_rate_percent: number;
  by_class: Record<ReconciliationClass, { count: number; amount_paise: number }>;
  oldest_open_exception_at: string | null;
  created_at: string;
}

export class ReconciliationEngine {
  private readonly db: DatabaseSync;
  private readonly audit: AuditLogger;

  constructor(db: DatabaseSync, audit: AuditLogger) {
    this.db = db;
    this.audit = audit;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS reconciliation_records (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        rrn TEXT NOT NULL,
        transaction_id TEXT,
        classification TEXT NOT NULL,
        switch_state TEXT,
        switch_amount_paise INTEGER,
        remitter_bank_id TEXT,
        remitter_state TEXT,
        remitter_amount_paise INTEGER,
        beneficiary_bank_id TEXT,
        beneficiary_state TEXT,
        beneficiary_amount_paise INTEGER,
        discrepancy_amount_paise INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('MATCHED', 'OPEN_EXCEPTION', 'RESOLVED')),
        resolution_action TEXT,
        resolution_note TEXT,
        resolution_posting_journal_id TEXT,
        resolved_by TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT,
        UNIQUE (cycle_id, rrn)
      );

      CREATE INDEX IF NOT EXISTS idx_recon_cycle_status
        ON reconciliation_records(cycle_id, status);

      CREATE TABLE IF NOT EXISTS reconciliation_summaries (
        cycle_id TEXT PRIMARY KEY,
        total_records INTEGER NOT NULL,
        matched_count INTEGER NOT NULL,
        exception_count INTEGER NOT NULL,
        open_exception_count INTEGER NOT NULL,
        match_rate_percent REAL NOT NULL,
        by_class_json TEXT NOT NULL,
        oldest_open_exception_at TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Requirements 21, 22, 24 & Interface `POST /cycles/{id}/reconcile`:
   * Performs a 3-way outer join on `RRN` across:
   * - Switch transactions in `cycleId` (or all switch transactions if `includeFailedAndReversed` is true)
   * - Remitter bank EOD reports (`direction === 'DEBIT'`)
   * - Beneficiary bank EOD reports (`direction === 'CREDIT'`)
   */
  public runThreeWayReconciliation(params: {
    cycleId: string;
    bankReports: BankEodReportRow[];
    now?: Date;
    actorId?: string;
    requestId?: string;
  }): {
    summary: ReconciliationCycleSummary;
    records: ReconciliationRecord[];
    exceptions: ReconciliationRecord[];
  } {
    const nowIso = (params.now ?? new Date()).toISOString();

    // 1. Load Switch records for this cycle (plus any FAILED/REVERSED or deemed-approved conflict txns)
    const switchRows = this.db
      .prepare(
        `SELECT * FROM switch_transactions
         WHERE settlement_cycle_id = ? OR settlement_cycle_id IS NULL
         ORDER BY created_at ASC`
      )
      .all(params.cycleId) as unknown as SwitchTransactionRecord[];

    const switchByRrn = new Map<string, SwitchTransactionRecord>();
    for (const tx of switchRows) {
      switchByRrn.set(tx.rrn, tx);
    }

    // 2. Index Remitter (DEBIT) and Beneficiary (CREDIT) bank EOD report rows by RRN
    const remitterByRrn = new Map<string, BankEodReportRow>();
    const beneficiaryByRrn = new Map<string, BankEodReportRow>();

    for (const row of params.bankReports) {
      if (row.direction === "DEBIT") {
        remitterByRrn.set(row.rrn, row);
      } else if (row.direction === "CREDIT") {
        beneficiaryByRrn.set(row.rrn, row);
      }
    }

    // 3. Collect the union of all RRNs across all three sources (3-way Full Outer Join)
    const allRrns = new Set<string>([
      ...switchByRrn.keys(),
      ...remitterByRrn.keys(),
      ...beneficiaryByRrn.keys(),
    ]);

    // Clear previous unsettled reconciliation run for this cycle if re-running
    this.db.prepare(`DELETE FROM reconciliation_records WHERE cycle_id = ?`).run(params.cycleId);

    const records: ReconciliationRecord[] = [];

    for (const rrn of Array.from(allRrns).sort()) {
      const swTx = switchByRrn.get(rrn);
      const remRow = remitterByRrn.get(rrn);
      const benRow = beneficiaryByRrn.get(rrn);

      const classified = this.classifyRrn(swTx, remRow, benRow);

      // Ignore clean FAILED switch transactions that properly wrote nothing at either bank
      if (
        swTx &&
        swTx.state === "FAILED" &&
        swTx.deemed_approved_conflict === 0 &&
        !remRow &&
        !benRow
      ) {
        continue;
      }

      const record: ReconciliationRecord = {
        id: `REC-${crypto.randomUUID()}`,
        cycle_id: params.cycleId,
        rrn,
        transaction_id:
          swTx?.transaction_id ?? remRow?.transaction_id ?? benRow?.transaction_id ?? null,
        classification: classified.classification,
        switch_state: swTx?.state ?? null,
        switch_amount_paise: swTx?.amount_paise ?? null,
        remitter_bank_id: swTx?.remitter_bank_id ?? remRow?.bank_id ?? null,
        remitter_state: remRow?.status ?? null,
        remitter_amount_paise: remRow?.amount_paise ?? null,
        beneficiary_bank_id: swTx?.beneficiary_bank_id ?? benRow?.bank_id ?? null,
        beneficiary_state: benRow?.status ?? null,
        beneficiary_amount_paise: benRow?.amount_paise ?? null,
        discrepancy_amount_paise: classified.discrepancyPaise,
        status: classified.classification === "MATCHED" ? "MATCHED" : "OPEN_EXCEPTION",
        resolution_action: null,
        resolution_note: null,
        resolution_posting_journal_id: null,
        resolved_by: null,
        created_at: nowIso,
        resolved_at: null,
      };

      this.db
        .prepare(
          `INSERT INTO reconciliation_records (
            id, cycle_id, rrn, transaction_id, classification,
            switch_state, switch_amount_paise,
            remitter_bank_id, remitter_state, remitter_amount_paise,
            beneficiary_bank_id, beneficiary_state, beneficiary_amount_paise,
            discrepancy_amount_paise, status, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          record.id,
          record.cycle_id,
          record.rrn,
          record.transaction_id,
          record.classification,
          record.switch_state,
          record.switch_amount_paise,
          record.remitter_bank_id,
          record.remitter_state,
          record.remitter_amount_paise,
          record.beneficiary_bank_id,
          record.beneficiary_state,
          record.beneficiary_amount_paise,
          record.discrepancy_amount_paise,
          record.status,
          record.created_at
        );

      records.push(record);
    }

    const summary = this.recomputeSummary(params.cycleId, nowIso);

    this.audit.record({
      actorId: params.actorId ?? "switch-operator",
      actorRole: "operator",
      action: "RUN_THREE_WAY_RECONCILIATION",
      entityType: "ReconciliationCycle",
      entityId: params.cycleId,
      newValue: summary,
      requestId: params.requestId ?? `REQ-RECON-${params.cycleId}`,
      nowIso,
    });

    return {
      summary,
      records,
      exceptions: records.filter((r) => r.status === "OPEN_EXCEPTION"),
    };
  }

  /**
   * Requirement 22: Classifies an RRN across Switch, Remitter Report, and Beneficiary Report.
   */
  private classifyRrn(
    swTx: SwitchTransactionRecord | undefined,
    remRow: BankEodReportRow | undefined,
    benRow: BankEodReportRow | undefined
  ): { classification: ReconciliationClass; discrepancyPaise: number } {
    // 1. MISSING_AT_SWITCH: A bank reports an RRN the switch never logged
    if (!swTx) {
      const amt = remRow?.amount_paise ?? benRow?.amount_paise ?? 0;
      return { classification: "MISSING_AT_SWITCH", discrepancyPaise: amt };
    }

    // 2. Check if Switch recorded SUCCESS
    if (swTx.state === "SUCCESS") {
      if (!remRow) {
        return {
          classification: "MISSING_AT_REMITTER",
          discrepancyPaise: swTx.amount_paise,
        };
      }
      if (!benRow) {
        return {
          classification: "MISSING_AT_BENEFICIARY",
          discrepancyPaise: swTx.amount_paise,
        };
      }
      if (remRow.status !== "SUCCESS" || benRow.status !== "SUCCESS") {
        return {
          classification: "STATUS_MISMATCH",
          discrepancyPaise: swTx.amount_paise,
        };
      }
      if (remRow.amount_paise !== swTx.amount_paise || benRow.amount_paise !== swTx.amount_paise) {
        const diff =
          Math.abs(swTx.amount_paise - remRow.amount_paise) +
          Math.abs(swTx.amount_paise - benRow.amount_paise);
        return {
          classification: "AMOUNT_MISMATCH",
          discrepancyPaise: diff,
        };
      }
      return { classification: "MATCHED", discrepancyPaise: 0 };
    }

    // 3. Check if Switch recorded REVERSED
    if (swTx.state === "REVERSED") {
      // If deemed_approved_conflict or remitter still says SUCCESS (unreversed) or beneficiary credited
      if (
        swTx.deemed_approved_conflict === 1 ||
        (remRow && remRow.status !== "REVERSED") ||
        benRow !== undefined
      ) {
        return {
          classification: "STATUS_MISMATCH",
          discrepancyPaise: swTx.amount_paise,
        };
      }
      return { classification: "MATCHED", discrepancyPaise: 0 };
    }

    // 4. Switch says FAILED (or stuck), yet remitter or beneficiary bank moved money!
    if (remRow || benRow) {
      return {
        classification: "STATUS_MISMATCH",
        discrepancyPaise: swTx.amount_paise,
      };
    }

    return { classification: "MATCHED", discrepancyPaise: 0 };
  }

  /**
   * Requirement 23 & Acceptance Test 9:
   * Resolves an open reconciliation exception by class:
   * - `TRIGGER_CREDIT`: Posts a credit at the beneficiary bank with `exceptionId` reference!
   * - `TRIGGER_REVERSAL`: Posts a reversal / compensating credit at the remitter bank with `exceptionId` reference!
   * - `MARK_INVESTIGATED` / `ATTACH_NOTE`: Updates the exception record and logs an audit entry.
   */
  public resolveException(params: {
    exceptionId: string;
    action: ExceptionResolutionAction;
    note?: string;
    beneficiaryBank?: BankCoreSimulator;
    beneficiaryAccountNumber?: string;
    remitterBank?: BankCoreSimulator;
    remitterAccountNumber?: string;
    actorId?: string;
    requestId?: string;
    now?: Date;
  }): ReconciliationRecord {
    const nowIso = (params.now ?? new Date()).toISOString();
    const actorId = params.actorId ?? "switch-operator";
    const exc = this.getExceptionById(params.exceptionId);

    if (!exc) {
      throw new Error(`Reconciliation exception "${params.exceptionId}" not found`);
    }
    if (exc.status === "RESOLVED") {
      throw new Error(`Exception "${params.exceptionId}" is already RESOLVED`);
    }

    let journalId: string | null = null;
    const amountToMove =
      exc.switch_amount_paise ?? exc.remitter_amount_paise ?? exc.discrepancy_amount_paise;

    if (params.action === "TRIGGER_CREDIT") {
      if (!params.beneficiaryBank || !params.beneficiaryAccountNumber) {
        throw new Error("TRIGGER_CREDIT requires beneficiaryBank and beneficiaryAccountNumber");
      }
      // Post credit at the beneficiary bank with `exceptionId` reference (Requirement 23 & Acceptance Test 9)
      const posted = params.beneficiaryBank.ledger.postJournalEntry({
        rrn: exc.rrn,
        transactionId: exc.transaction_id ?? `RECON-${exc.rrn}`,
        exceptionId: exc.id,
        nowIso,
        lines: [
          {
            accountNumber: params.beneficiaryBank.ledger.settlementAccountNumber,
            direction: "DEBIT",
            amountPaise: amountToMove,
          },
          {
            accountNumber: params.beneficiaryAccountNumber,
            direction: "CREDIT",
            amountPaise: amountToMove,
          },
        ],
      });
      journalId = posted.journalId;
    } else if (params.action === "TRIGGER_REVERSAL") {
      if (!params.remitterBank || !params.remitterAccountNumber) {
        throw new Error("TRIGGER_REVERSAL requires remitterBank and remitterAccountNumber");
      }
      // Post compensating reversal credit to the remitter customer with `exceptionId` reference
      const posted = params.remitterBank.ledger.postJournalEntry({
        rrn: exc.rrn,
        transactionId: exc.transaction_id ?? `RECON-REV-${exc.rrn}`,
        exceptionId: exc.id,
        nowIso,
        lines: [
          {
            accountNumber: params.remitterBank.ledger.settlementAccountNumber,
            direction: "DEBIT",
            amountPaise: amountToMove,
          },
          {
            accountNumber: params.remitterAccountNumber,
            direction: "CREDIT",
            amountPaise: amountToMove,
          },
        ],
      });
      journalId = posted.journalId;
    }

    this.db
      .prepare(
        `UPDATE reconciliation_records
         SET status = 'RESOLVED',
             resolution_action = ?,
             resolution_note = ?,
             resolution_posting_journal_id = ?,
             resolved_by = ?,
             resolved_at = ?
         WHERE id = ?`
      )
      .run(params.action, params.note ?? null, journalId, actorId, nowIso, exc.id);

    this.recomputeSummary(exc.cycle_id, nowIso);

    const updated = this.getExceptionById(exc.id)!;

    this.audit.record({
      actorId,
      actorRole: "operator",
      action: `RESOLVE_RECON_EXCEPTION_${params.action}`,
      entityType: "ReconciliationRecord",
      entityId: exc.id,
      oldValue: { status: exc.status },
      newValue: {
        status: updated.status,
        rrn: exc.rrn,
        classification: exc.classification,
        resolution_action: params.action,
        resolution_posting_journal_id: journalId,
        note: params.note ?? null,
      },
      requestId: params.requestId ?? `REQ-RESOLVE-${exc.id}`,
      nowIso,
    });

    return updated;
  }

  public getExceptionById(id: string): ReconciliationRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM reconciliation_records WHERE id = ?`)
      .get(id) as unknown as ReconciliationRecord | undefined;
  }

  public listExceptions(cycleId?: string, onlyOpen = false): ReconciliationRecord[] {
    if (cycleId) {
      return this.db
        .prepare(
          `SELECT * FROM reconciliation_records
           WHERE cycle_id = ? AND status IN (${onlyOpen ? "'OPEN_EXCEPTION'" : "'OPEN_EXCEPTION', 'RESOLVED'"})
           ORDER BY created_at ASC, rrn ASC`
        )
        .all(cycleId) as unknown as ReconciliationRecord[];
    }
    return this.db
      .prepare(
        `SELECT * FROM reconciliation_records
         WHERE status IN (${onlyOpen ? "'OPEN_EXCEPTION'" : "'OPEN_EXCEPTION', 'RESOLVED'"})
         ORDER BY created_at ASC, rrn ASC`
      )
      .all() as unknown as ReconciliationRecord[];
  }

  public getCycleSummary(cycleId: string): ReconciliationCycleSummary | undefined {
    const row = this.db
      .prepare(`SELECT * FROM reconciliation_summaries WHERE cycle_id = ?`)
      .get(cycleId) as
      | {
          cycle_id: string;
          total_records: number;
          matched_count: number;
          exception_count: number;
          open_exception_count: number;
          match_rate_percent: number;
          by_class_json: string;
          oldest_open_exception_at: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      cycle_id: row.cycle_id,
      total_records: row.total_records,
      matched_count: row.matched_count,
      exception_count: row.exception_count,
      open_exception_count: row.open_exception_count,
      match_rate_percent: row.match_rate_percent,
      by_class: JSON.parse(row.by_class_json),
      oldest_open_exception_at: row.oldest_open_exception_at,
      created_at: row.created_at,
    };
  }

  private recomputeSummary(cycleId: string, nowIso: string): ReconciliationCycleSummary {
    const allRecords = this.db
      .prepare(`SELECT * FROM reconciliation_records WHERE cycle_id = ?`)
      .all(cycleId) as unknown as ReconciliationRecord[];

    const byClass: Record<ReconciliationClass, { count: number; amount_paise: number }> = {
      MATCHED: { count: 0, amount_paise: 0 },
      MISSING_AT_REMITTER: { count: 0, amount_paise: 0 },
      MISSING_AT_BENEFICIARY: { count: 0, amount_paise: 0 },
      MISSING_AT_SWITCH: { count: 0, amount_paise: 0 },
      AMOUNT_MISMATCH: { count: 0, amount_paise: 0 },
      STATUS_MISMATCH: { count: 0, amount_paise: 0 },
    };

    let matchedCount = 0;
    let exceptionCount = 0;
    let openExceptionCount = 0;
    let oldestOpenAt: string | null = null;

    for (const r of allRecords) {
      const amt =
        r.switch_amount_paise ?? r.remitter_amount_paise ?? r.beneficiary_amount_paise ?? 0;
      byClass[r.classification].count += 1;
      byClass[r.classification].amount_paise += amt;

      if (r.classification === "MATCHED") {
        matchedCount += 1;
      } else {
        exceptionCount += 1;
        if (r.status === "OPEN_EXCEPTION") {
          openExceptionCount += 1;
          if (!oldestOpenAt || r.created_at < oldestOpenAt) {
            oldestOpenAt = r.created_at;
          }
        }
      }
    }

    const total = allRecords.length;
    const matchRatePercent = total === 0 ? 100 : Math.round((matchedCount / total) * 10000) / 100;

    this.db
      .prepare(
        `INSERT INTO reconciliation_summaries (
          cycle_id, total_records, matched_count, exception_count,
          open_exception_count, match_rate_percent, by_class_json,
          oldest_open_exception_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(cycle_id) DO UPDATE SET
          total_records = excluded.total_records,
          matched_count = excluded.matched_count,
          exception_count = excluded.exception_count,
          open_exception_count = excluded.open_exception_count,
          match_rate_percent = excluded.match_rate_percent,
          by_class_json = excluded.by_class_json,
          oldest_open_exception_at = excluded.oldest_open_exception_at`
      )
      .run(
        cycleId,
        total,
        matchedCount,
        exceptionCount,
        openExceptionCount,
        matchRatePercent,
        JSON.stringify(byClass),
        oldestOpenAt,
        nowIso
      );

    return {
      cycle_id: cycleId,
      total_records: total,
      matched_count: matchedCount,
      exception_count: exceptionCount,
      open_exception_count: openExceptionCount,
      match_rate_percent: matchRatePercent,
      by_class: byClass,
      oldest_open_exception_at: oldestOpenAt,
      created_at: nowIso,
    };
  }
}
