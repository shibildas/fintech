import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { AuditLogger } from "../../../packages/core/src/index.ts";
import type { SwitchTransactionRecord } from "./switch-engine.ts";

/**
 * Project 1 — T+1 Settlement Engine (Requirements 17, 18, 19, 20 & Acceptance Test 8, Pages 8–11)
 *
 * Responsibilities:
 * - Req 17: Configurable settlement cycle window (default cut-off 23:00). Every SUCCESS transaction
 *   belongs to exactly one cycle, assigned by the Switch's clock when reaching SUCCESS.
 * - Req 18: Computes each bank's multilateral net position:
 *     `net_paise = total_credits_received_paise - total_debits_sent_paise`
 *   Produces:
 *     (a) Summary CSV per bank (payable / receivable / flat)
 *     (b) Detail CSV per bank listing every RRN in the cycle
 *     (c) Cycle Manifest CSV with record counts and totals (sum of net positions across banks === 0)
 *   Every CSV carries a HEADER line (`HDR,...`) and a TRAILER line (`TRL,record_count,sha256_hash`).
 * - Req 19: Settlement files are immutable once generated; re-running a cycle increments `version`
 *   and preserves all previous versions (enforced with SQLite triggers blocking UPDATE/DELETE).
 * - Req 20: Operator can mark a cycle `SETTLED`, recording net movements and an audit log entry.
 */

export type SettlementCycleStatus = "OPEN" | "GENERATED" | "SETTLED";

export interface BankNetPosition {
  bank_id: string;
  credits_count: number;
  credits_paise: number;
  debits_count: number;
  debits_paise: number;
  net_paise: number; // credits_paise - debits_paise (>0 RECEIVABLE, <0 PAYABLE, 0 FLAT)
  position_type: "RECEIVABLE" | "PAYABLE" | "FLAT";
}

export interface SettlementFileArtifact {
  id: string;
  cycle_id: string;
  version: number;
  file_kind: "BANK_SUMMARY" | "BANK_DETAIL" | "CYCLE_MANIFEST";
  bank_id: string | null;
  filename: string;
  record_count: number;
  body_sha256: string;
  csv_content: string;
  created_at: string;
}

export interface SettlementCycleRunResult {
  cycle_id: string;
  version: number;
  window_start: string;
  window_end: string;
  status: SettlementCycleStatus;
  total_transactions: number;
  gross_volume_paise: number;
  net_sum_across_banks_paise: number; // Must ALWAYS equal 0!
  bank_positions: BankNetPosition[];
  files: SettlementFileArtifact[];
  created_at: string;
}

export function computeCsvBodyHash(bodyLines: string[]): string {
  const canonicalBody = bodyLines.join("\n");
  return crypto.createHash("sha256").update(canonicalBody, "utf8").digest("hex");
}

/**
 * Formats an immutable settlement CSV with a header line (`HDR,...`), body lines,
 * and a trailer line (`TRL,<record_count>,<sha256_hash_of_body>`).
 */
export function buildCsvWithHeaderAndTrailer(params: {
  cycleId: string;
  version: number;
  fileKind: string;
  generatedAtIso: string;
  columnHeader: string;
  dataRows: string[];
}): { csvContent: string; recordCount: number; bodySha256: string } {
  const bodyLines = [params.columnHeader, ...params.dataRows];
  const bodySha256 = computeCsvBodyHash(bodyLines);
  const recordCount = params.dataRows.length;

  const headerLine = `HDR,${params.cycleId},v${params.version},${params.fileKind},${params.generatedAtIso}`;
  const trailerLine = `TRL,${recordCount},${bodySha256}`;

  const allLines = [headerLine, ...bodyLines, trailerLine];
  return {
    csvContent: allLines.join("\n") + "\n",
    recordCount,
    bodySha256,
  };
}

/**
 * Verifies a settlement CSV's integrity by checking that its `TRL` row count matches
 * the number of data rows and that its `TRL` SHA-256 matches the body.
 */
export function verifySettlementCsvIntegrity(csvContent: string): {
  valid: boolean;
  recordCount: number;
  bodySha256: string;
} {
  const lines = csvContent.trim().split(/\r?\n/);
  if (lines.length < 3) {
    return { valid: false, recordCount: 0, bodySha256: "" };
  }
  const headerLine = lines[0];
  const trailerLine = lines[lines.length - 1];
  if (!headerLine.startsWith("HDR,") || !trailerLine.startsWith("TRL,")) {
    return { valid: false, recordCount: 0, bodySha256: "" };
  }

  const [, countStr, expectedHash] = trailerLine.split(",");
  const expectedCount = Number(countStr);
  const bodyLines = lines.slice(1, -1); // includes columnHeader + dataRows
  const dataRowCount = bodyLines.length - 1;
  const actualHash = computeCsvBodyHash(bodyLines);

  return {
    valid: expectedCount === dataRowCount && expectedHash === actualHash,
    recordCount: dataRowCount,
    bodySha256: actualHash,
  };
}

export class SettlementEngine {
  private readonly db: DatabaseSync;
  private readonly audit: AuditLogger;

  constructor(db: DatabaseSync, audit: AuditLogger) {
    this.db = db;
    this.audit = audit;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS settlement_cycles (
        cycle_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        window_start TEXT NOT NULL,
        window_end TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('OPEN', 'GENERATED', 'SETTLED')),
        total_transactions INTEGER NOT NULL,
        gross_volume_paise INTEGER NOT NULL,
        net_sum_across_banks_paise INTEGER NOT NULL CHECK (net_sum_across_banks_paise = 0),
        positions_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        settled_at TEXT,
        settled_by TEXT,
        PRIMARY KEY (cycle_id, version)
      );

      CREATE TABLE IF NOT EXISTS settlement_files (
        id TEXT PRIMARY KEY,
        cycle_id TEXT NOT NULL,
        version INTEGER NOT NULL,
        file_kind TEXT NOT NULL CHECK (file_kind IN ('BANK_SUMMARY', 'BANK_DETAIL', 'CYCLE_MANIFEST')),
        bank_id TEXT,
        filename TEXT NOT NULL,
        record_count INTEGER NOT NULL,
        body_sha256 TEXT NOT NULL,
        csv_content TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_settlement_files_cycle
        ON settlement_files(cycle_id, version);

      -- Requirement 19: Settlement files are immutable once generated!
      CREATE TRIGGER IF NOT EXISTS trg_settlement_files_no_update
      BEFORE UPDATE ON settlement_files
      BEGIN
        SELECT RAISE(ABORT, 'Req 19 Violation: settlement_files are immutable once generated');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_settlement_files_no_delete
      BEFORE DELETE ON settlement_files
      BEGIN
        SELECT RAISE(ABORT, 'Req 19 Violation: settlement_files are immutable and cannot be deleted');
      END;
    `);
  }

  /**
   * Requirements 17, 18, 19 & Interface `POST /cycles/{id}/run`:
   * Computes multilateral net positions across all registered banks for `cycleId`,
   * verifies that net positions sum to zero, increments `version` if re-run,
   * and persists immutable CSV files with header and trailer hash.
   */
  public runSettlementCycle(params: {
    cycleId: string;
    registeredBankIds: string[];
    windowStartIso?: string;
    windowEndIso?: string;
    now?: Date;
    actorId?: string;
    requestId?: string;
  }): SettlementCycleRunResult {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const windowStart = params.windowStartIso ?? `${params.cycleId.replace("CYC-", "")}T00:00:00Z`;
    const windowEnd = params.windowEndIso ?? `${params.cycleId.replace("CYC-", "")}T23:00:00Z`;

    // Determine next version number (Requirement 19: re-running creates a new version, keeps old ones)
    const maxVersionRow = this.db
      .prepare(
        `SELECT COALESCE(MAX(version), 0) AS max_ver FROM settlement_cycles WHERE cycle_id = ?`
      )
      .get(params.cycleId) as { max_ver: number };
    const version = maxVersionRow.max_ver + 1;

    // Load all SUCCESS transactions belonging to this settlement cycle
    const txRows = this.db
      .prepare(
        `SELECT * FROM switch_transactions
         WHERE settlement_cycle_id = ? AND state = 'SUCCESS'
         ORDER BY created_at ASC, rrn ASC`
      )
      .all(params.cycleId) as unknown as SwitchTransactionRecord[];

    // Discover all banks participating in either registry or cycle transactions
    const bankSet = new Set<string>(params.registeredBankIds);
    for (const tx of txRows) {
      bankSet.add(tx.remitter_bank_id);
      if (tx.beneficiary_bank_id) {
        bankSet.add(tx.beneficiary_bank_id);
      }
    }
    const sortedBankIds = Array.from(bankSet).sort();

    const bankPositionsMap = new Map<string, BankNetPosition>();
    const bankDetailRowsMap = new Map<string, string[]>();

    for (const bankId of sortedBankIds) {
      bankPositionsMap.set(bankId, {
        bank_id: bankId,
        credits_count: 0,
        credits_paise: 0,
        debits_count: 0,
        debits_paise: 0,
        net_paise: 0,
        position_type: "FLAT",
      });
      bankDetailRowsMap.set(bankId, []);
    }

    let grossVolumePaise = 0;

    for (const tx of txRows) {
      grossVolumePaise += tx.amount_paise;

      // Remitter Bank (Debit sent)
      const remitterPos = bankPositionsMap.get(tx.remitter_bank_id)!;
      remitterPos.debits_count += 1;
      remitterPos.debits_paise += tx.amount_paise;
      bankDetailRowsMap
        .get(tx.remitter_bank_id)!
        .push(
          `${tx.rrn},${tx.transaction_id},DEBIT_SENT,${tx.beneficiary_bank_id},${tx.amount_paise},${tx.payer_vpa},${tx.payee_vpa},${tx.updated_at}`
        );

      // Beneficiary Bank (Credit received)
      const beneBankId = tx.beneficiary_bank_id!;
      const benePos = bankPositionsMap.get(beneBankId)!;
      benePos.credits_count += 1;
      benePos.credits_paise += tx.amount_paise;
      bankDetailRowsMap
        .get(beneBankId)!
        .push(
          `${tx.rrn},${tx.transaction_id},CREDIT_RECEIVED,${tx.remitter_bank_id},${tx.amount_paise},${tx.payer_vpa},${tx.payee_vpa},${tx.updated_at}`
        );
    }

    const bankPositions: BankNetPosition[] = [];
    let netSumAcrossBanksPaise = 0;

    for (const bankId of sortedBankIds) {
      const pos = bankPositionsMap.get(bankId)!;
      pos.net_paise = pos.credits_paise - pos.debits_paise;
      pos.position_type = pos.net_paise > 0 ? "RECEIVABLE" : pos.net_paise < 0 ? "PAYABLE" : "FLAT";
      netSumAcrossBanksPaise += pos.net_paise;
      bankPositions.push(pos);
    }

    if (netSumAcrossBanksPaise !== 0) {
      throw new Error(
        `Settlement Zero-Sum Invariant Violated: net positions sum to ${netSumAcrossBanksPaise} paise instead of 0`
      );
    }

    const generatedFiles: SettlementFileArtifact[] = [];

    // Generate (a) Summary CSV per bank & (b) Detail CSV per bank
    for (const pos of bankPositions) {
      const summaryBuilt = buildCsvWithHeaderAndTrailer({
        cycleId: params.cycleId,
        version,
        fileKind: `BANK_SUMMARY_${pos.bank_id}`,
        generatedAtIso: nowIso,
        columnHeader:
          "bank_id,credits_count,credits_paise,debits_count,debits_paise,net_paise,position_type",
        dataRows: [
          `${pos.bank_id},${pos.credits_count},${pos.credits_paise},${pos.debits_count},${pos.debits_paise},${pos.net_paise},${pos.position_type}`,
        ],
      });

      generatedFiles.push({
        id: `SFL-${crypto.randomUUID()}`,
        cycle_id: params.cycleId,
        version,
        file_kind: "BANK_SUMMARY",
        bank_id: pos.bank_id,
        filename: `summary_${params.cycleId}_v${version}_${pos.bank_id}.csv`,
        record_count: summaryBuilt.recordCount,
        body_sha256: summaryBuilt.bodySha256,
        csv_content: summaryBuilt.csvContent,
        created_at: nowIso,
      });

      const detailRows = bankDetailRowsMap.get(pos.bank_id)!;
      const detailBuilt = buildCsvWithHeaderAndTrailer({
        cycleId: params.cycleId,
        version,
        fileKind: `BANK_DETAIL_${pos.bank_id}`,
        generatedAtIso: nowIso,
        columnHeader:
          "rrn,transaction_id,direction,counterparty_bank_id,amount_paise,payer_vpa,payee_vpa,completed_at",
        dataRows: detailRows,
      });

      generatedFiles.push({
        id: `SFL-${crypto.randomUUID()}`,
        cycle_id: params.cycleId,
        version,
        file_kind: "BANK_DETAIL",
        bank_id: pos.bank_id,
        filename: `detail_${params.cycleId}_v${version}_${pos.bank_id}.csv`,
        record_count: detailBuilt.recordCount,
        body_sha256: detailBuilt.bodySha256,
        csv_content: detailBuilt.csvContent,
        created_at: nowIso,
      });
    }

    // Generate (c) Cycle Manifest CSV with record counts and totals
    const manifestRows = bankPositions.map(
      (p) =>
        `${p.bank_id},${p.credits_count + p.debits_count},${p.credits_count},${p.credits_paise},${p.debits_count},${p.debits_paise},${p.net_paise},${p.position_type}`
    );
    const manifestBuilt = buildCsvWithHeaderAndTrailer({
      cycleId: params.cycleId,
      version,
      fileKind: "CYCLE_MANIFEST",
      generatedAtIso: nowIso,
      columnHeader:
        "bank_id,total_records,credits_count,credits_paise,debits_count,debits_paise,net_paise,position_type",
      dataRows: manifestRows,
    });

    generatedFiles.push({
      id: `SFL-${crypto.randomUUID()}`,
      cycle_id: params.cycleId,
      version,
      file_kind: "CYCLE_MANIFEST",
      bank_id: null,
      filename: `manifest_${params.cycleId}_v${version}.csv`,
      record_count: manifestBuilt.recordCount,
      body_sha256: manifestBuilt.bodySha256,
      csv_content: manifestBuilt.csvContent,
      created_at: nowIso,
    });

    // Persist cycle and immutable files inside an atomic DB transaction
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.db
        .prepare(
          `INSERT INTO settlement_cycles (
            cycle_id, version, window_start, window_end, status,
            total_transactions, gross_volume_paise, net_sum_across_banks_paise,
            positions_json, created_at
          ) VALUES (?, ?, ?, ?, 'GENERATED', ?, ?, ?, ?, ?)`
        )
        .run(
          params.cycleId,
          version,
          windowStart,
          windowEnd,
          txRows.length,
          grossVolumePaise,
          netSumAcrossBanksPaise,
          JSON.stringify(bankPositions),
          nowIso
        );

      const fileStmt = this.db.prepare(`
        INSERT INTO settlement_files (
          id, cycle_id, version, file_kind, bank_id, filename,
          record_count, body_sha256, csv_content, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      for (const f of generatedFiles) {
        fileStmt.run(
          f.id,
          f.cycle_id,
          f.version,
          f.file_kind,
          f.bank_id,
          f.filename,
          f.record_count,
          f.body_sha256,
          f.csv_content,
          f.created_at
        );
      }

      this.audit.record({
        actorId: params.actorId ?? "switch-operator",
        actorRole: "operator",
        action: "RUN_SETTLEMENT_CYCLE",
        entityType: "SettlementCycle",
        entityId: `${params.cycleId}:v${version}`,
        newValue: {
          version,
          total_transactions: txRows.length,
          gross_volume_paise: grossVolumePaise,
          net_sum_across_banks_paise: netSumAcrossBanksPaise,
          file_count: generatedFiles.length,
        },
        requestId: params.requestId ?? `REQ-SETTLE-${params.cycleId}-v${version}`,
        nowIso,
      });

      this.db.exec("COMMIT");
    } catch (err) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // ignore
      }
      throw err;
    }

    return {
      cycle_id: params.cycleId,
      version,
      window_start: windowStart,
      window_end: windowEnd,
      status: "GENERATED",
      total_transactions: txRows.length,
      gross_volume_paise: grossVolumePaise,
      net_sum_across_banks_paise: netSumAcrossBanksPaise,
      bank_positions: bankPositions,
      files: generatedFiles,
      created_at: nowIso,
    };
  }

  /**
   * Requirement 20: Marks the latest version (or specified version) of a settlement cycle as `SETTLED`.
   */
  public markCycleSettled(params: {
    cycleId: string;
    version?: number;
    actorId?: string;
    requestId?: string;
    now?: Date;
  }): SettlementCycleRunResult {
    const nowIso = (params.now ?? new Date()).toISOString();
    const targetVersion =
      params.version ??
      (
        this.db
          .prepare(`SELECT MAX(version) AS v FROM settlement_cycles WHERE cycle_id = ?`)
          .get(params.cycleId) as { v: number | null }
      ).v;

    if (!targetVersion) {
      throw new Error(`Settlement cycle "${params.cycleId}" has not been generated yet`);
    }

    const actorId = params.actorId ?? "settlement-bank-operator";
    this.db
      .prepare(
        `UPDATE settlement_cycles
         SET status = 'SETTLED', settled_at = ?, settled_by = ?
         WHERE cycle_id = ? AND version = ?`
      )
      .run(nowIso, actorId, params.cycleId, targetVersion);

    this.audit.record({
      actorId,
      actorRole: "operator",
      action: "MARK_CYCLE_SETTLED",
      entityType: "SettlementCycle",
      entityId: `${params.cycleId}:v${targetVersion}`,
      oldValue: { status: "GENERATED" },
      newValue: { status: "SETTLED", settled_at: nowIso },
      requestId: params.requestId ?? `REQ-MARK-SETTLED-${params.cycleId}`,
      nowIso,
    });

    return this.getCycleFiles(params.cycleId, targetVersion)!;
  }

  /**
   * Interface: `GET /cycles/{id}/files`
   */
  public getCycleFiles(cycleId: string, version?: number): SettlementCycleRunResult | undefined {
    const cycleRow = (
      version !== undefined
        ? this.db
            .prepare(`SELECT * FROM settlement_cycles WHERE cycle_id = ? AND version = ?`)
            .get(cycleId, version)
        : this.db
            .prepare(
              `SELECT * FROM settlement_cycles WHERE cycle_id = ? ORDER BY version DESC LIMIT 1`
            )
            .get(cycleId)
    ) as
      | {
          cycle_id: string;
          version: number;
          window_start: string;
          window_end: string;
          status: SettlementCycleStatus;
          total_transactions: number;
          gross_volume_paise: number;
          net_sum_across_banks_paise: number;
          positions_json: string;
          created_at: string;
        }
      | undefined;

    if (!cycleRow) {
      return undefined;
    }

    const files = this.db
      .prepare(
        `SELECT * FROM settlement_files WHERE cycle_id = ? AND version = ? ORDER BY filename ASC`
      )
      .all(cycleRow.cycle_id, cycleRow.version) as unknown as SettlementFileArtifact[];

    return {
      cycle_id: cycleRow.cycle_id,
      version: cycleRow.version,
      window_start: cycleRow.window_start,
      window_end: cycleRow.window_end,
      status: cycleRow.status,
      total_transactions: cycleRow.total_transactions,
      gross_volume_paise: cycleRow.gross_volume_paise,
      net_sum_across_banks_paise: cycleRow.net_sum_across_banks_paise,
      bank_positions: JSON.parse(cycleRow.positions_json) as BankNetPosition[],
      files,
      created_at: cycleRow.created_at,
    };
  }

  public listCycleVersions(cycleId: string): number[] {
    const rows = this.db
      .prepare(`SELECT version FROM settlement_cycles WHERE cycle_id = ? ORDER BY version ASC`)
      .all(cycleId) as Array<{ version: number }>;
    return rows.map((r) => r.version);
  }
}
