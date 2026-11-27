import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  computeBatchLinesSha256,
  verifySignedBatchCsv,
  diffPresentedVsRespondedKeys,
} from "@fintech/core";
import type { PaymentGatewayEngine } from "@fintech/project2-gateway";

/**
 * Project 4 (Day 25) — e-NACH Daily Presentment Batch Generator,
 * Bank Batch Simulator & Missing-Record Exception Detector
 */

export type EnachResponseCode =
  "00_SUCCESS" | "51_INSUFFICIENT_FUNDS" | "14_MANDATE_NOT_FOUND" | "78_ACCOUNT_CLOSED";

export interface EnachPresentmentItem {
  executionKey: string;
  merchantId: string;
  subscriptionId: string;
  umrn: string;
  bankId: string;
  amountPaise: number;
}

export interface EnachBatchSummary {
  batchId: string;
  bankId: string;
  itemCount: number;
  totalAmountPaise: number;
  presentmentCsv: string;
}

export interface EnachIngestionResult {
  batchId: string;
  bankId: string;
  succeededCount: number;
  softFailedCount: number;
  hardFailedCount: number;
  missingRecordExceptions: Array<{
    exceptionId: string;
    executionKey: string;
    reason: "MISSING_FROM_BANK_RESPONSE";
  }>;
  unexpectedKeys: string[];
}

export class EnachBankBatchSimulator {
  public readonly bankId: string;
  private readonly forcedFailures = new Map<string, EnachResponseCode>(); // executionKey -> code
  private readonly dropFromResponse = new Set<string>(); // executionKeys silently omitted in response CSV

  constructor(bankId: string) {
    this.bankId = bankId;
  }

  public setForcedFailure(executionKey: string, code: EnachResponseCode): void {
    this.forcedFailures.set(executionKey, code);
  }

  public setDroppedRecord(executionKey: string): void {
    this.dropFromResponse.add(executionKey);
  }

  /**
   * Simulates `POST /nach/present` -> T+1 `GET /nach/response/{batchId}` CSV generation.
   */
  public processPresentmentAndBuildResponseCsv(
    batchId: string,
    presentmentCsv: string,
    now = new Date()
  ): string {
    const check = verifySignedBatchCsv(presentmentCsv);
    if (!check.valid) {
      throw new Error(`Bank ${this.bankId} rejected corrupt presentment CSV: ${check.reason}`);
    }

    const responseDataLines: string[] = [];
    for (const line of check.dataLines) {
      const [executionKey, merchantId, subscriptionId, umrn, amountStr] = line.split(",");
      if (this.dropFromResponse.has(executionKey)) {
        // Chaos: simulate bank silently omitting a row from its response file!
        continue;
      }
      const code: EnachResponseCode = this.forcedFailures.get(executionKey) ?? "00_SUCCESS";
      const bankRef = `NACH-${this.bankId}-${crypto.randomUUID().slice(0, 8)}`;
      responseDataLines.push(
        `${executionKey},${merchantId},${subscriptionId},${umrn},${amountStr},${code},${bankRef}`
      );
    }

    const sha256 = computeBatchLinesSha256(responseDataLines);
    return (
      [
        `HDR,NACH_RESPONSE,${batchId},${this.bankId},${now.toISOString()}`,
        ...responseDataLines,
        `TRL,${responseDataLines.length},${sha256}`,
      ].join("\n") + "\n"
    );
  }
}

export class EnachPresentmentEngine {
  public readonly db: DatabaseSync;
  private readonly gateway?: PaymentGatewayEngine;

  constructor(params?: { gateway?: PaymentGatewayEngine; dbPath?: string }) {
    this.db = new DatabaseSync(params?.dbPath ?? ":memory:");
    this.gateway = params?.gateway;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS enach_batches (
        batch_id TEXT PRIMARY KEY,
        bank_id TEXT NOT NULL,
        item_count INTEGER NOT NULL,
        total_amount_paise INTEGER NOT NULL,
        presentment_csv TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PRESENTED', 'RECONCILED')),
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS enach_batch_items (
        execution_key TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        umrn TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PRESENTED', 'SUCCEEDED', 'FAILED_SOFT', 'FAILED_HARD', 'MISSING_EXCEPTION')),
        response_code TEXT,
        bank_ref TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS enach_missing_exceptions (
        id TEXT PRIMARY KEY,
        batch_id TEXT NOT NULL,
        execution_key TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Groups due e-NACH items per destination bank and builds signed CSV presentment batches.
   */
  public generatePresentmentBatches(
    items: EnachPresentmentItem[],
    now = new Date()
  ): EnachBatchSummary[] {
    const byBank = new Map<string, EnachPresentmentItem[]>();
    for (const item of items) {
      const list = byBank.get(item.bankId) ?? [];
      list.push(item);
      byBank.set(item.bankId, list);
    }

    const nowIso = now.toISOString();
    const summaries: EnachBatchSummary[] = [];

    for (const [bankId, bankItems] of byBank.entries()) {
      const batchId = `NACH_${bankId}_${crypto.randomUUID().slice(0, 8)}`;
      const dataLines: string[] = [];
      let totalAmountPaise = 0;

      for (const it of bankItems) {
        totalAmountPaise += it.amountPaise;
        dataLines.push(
          `${it.executionKey},${it.merchantId},${it.subscriptionId},${it.umrn},${it.amountPaise}`
        );
      }

      const sha256 = computeBatchLinesSha256(dataLines);
      const presentmentCsv =
        [
          `HDR,NACH_PRESENTMENT,${batchId},${bankId},${nowIso}`,
          ...dataLines,
          `TRL,${dataLines.length},${sha256}`,
        ].join("\n") + "\n";

      this.db
        .prepare(
          `INSERT INTO enach_batches (
            batch_id, bank_id, item_count, total_amount_paise, presentment_csv, status, created_at
          ) VALUES (?, ?, ?, ?, ?, 'PRESENTED', ?)`
        )
        .run(batchId, bankId, bankItems.length, totalAmountPaise, presentmentCsv, nowIso);

      const insertItem = this.db.prepare(
        `INSERT INTO enach_batch_items (
          execution_key, batch_id, merchant_id, subscription_id, umrn, bank_id,
          amount_paise, status, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PRESENTED', ?)`
      );
      for (const it of bankItems) {
        insertItem.run(
          it.executionKey,
          batchId,
          it.merchantId,
          it.subscriptionId,
          it.umrn,
          it.bankId,
          it.amountPaise,
          nowIso
        );
      }

      summaries.push({
        batchId,
        bankId,
        itemCount: bankItems.length,
        totalAmountPaise,
        presentmentCsv,
      });
    }

    return summaries;
  }

  /**
   * Ingests a bank's T+1 response CSV:
   * - Verifies row count & SHA-256 trailer.
   * - Posts captured `00_SUCCESS` items into Project 2's Merchant Ledger (if wired).
   * - Raises `MISSING_FROM_BANK_RESPONSE` exceptions for any presented key omitted by the bank!
   */
  public ingestResponseCsv(
    batchId: string,
    responseCsv: string,
    now = new Date()
  ): EnachIngestionResult {
    const check = verifySignedBatchCsv(responseCsv);
    if (!check.valid) {
      throw new Error(`Corrupt e-NACH response CSV for batch ${batchId}: ${check.reason}`);
    }

    const batch = this.db.prepare(`SELECT * FROM enach_batches WHERE batch_id = ?`).get(batchId) as
      { batch_id: string; bank_id: string } | undefined;
    if (!batch) {
      throw new Error(`Batch "${batchId}" not found`);
    }

    const presentedRows = this.db
      .prepare(
        `SELECT execution_key, merchant_id, amount_paise FROM enach_batch_items WHERE batch_id = ?`
      )
      .all(batchId) as Array<{ execution_key: string; merchant_id: string; amount_paise: number }>;

    const presentedKeys = presentedRows.map((r) => r.execution_key);
    const parsedResp = new Map<
      string,
      { merchantId: string; amountPaise: number; code: EnachResponseCode; bankRef: string }
    >();

    for (const line of check.dataLines) {
      const [executionKey, merchantId, , , amountStr, code, bankRef] = line.split(",");
      parsedResp.set(executionKey, {
        merchantId,
        amountPaise: Number(amountStr),
        code: code as EnachResponseCode,
        bankRef,
      });
    }

    const diff = diffPresentedVsRespondedKeys(presentedKeys, Array.from(parsedResp.keys()));
    const nowIso = now.toISOString();

    let succeededCount = 0;
    let softFailedCount = 0;
    let hardFailedCount = 0;

    const updateStmt = this.db.prepare(
      `UPDATE enach_batch_items
       SET status = ?, response_code = ?, bank_ref = ?, updated_at = ?
       WHERE execution_key = ?`
    );

    for (const key of diff.matched) {
      const resp = parsedResp.get(key)!;
      if (resp.code === "00_SUCCESS") {
        succeededCount++;
        updateStmt.run("SUCCEEDED", resp.code, resp.bankRef, nowIso, key);
        if (this.gateway) {
          this.gateway.postExternalSubscriptionCapture({
            merchantId: resp.merchantId,
            referenceId: resp.bankRef,
            amountPaise: resp.amountPaise,
            method: "NETBANKING",
            now,
          });
        }
      } else if (resp.code === "51_INSUFFICIENT_FUNDS") {
        softFailedCount++;
        updateStmt.run("FAILED_SOFT", resp.code, resp.bankRef, nowIso, key);
      } else {
        hardFailedCount++;
        updateStmt.run("FAILED_HARD", resp.code, resp.bankRef, nowIso, key);
      }
    }

    const missingRecordExceptions: EnachIngestionResult["missingRecordExceptions"] = [];
    const insertExc = this.db.prepare(
      `INSERT INTO enach_missing_exceptions (id, batch_id, execution_key, bank_id, reason, created_at)
       VALUES (?, ?, ?, ?, 'MISSING_FROM_BANK_RESPONSE', ?)`
    );

    for (const missingKey of diff.missingFromResponse) {
      const exceptionId = `EXC-NACH-${crypto.randomUUID().slice(0, 8)}`;
      updateStmt.run("MISSING_EXCEPTION", null, null, nowIso, missingKey);
      insertExc.run(exceptionId, batchId, missingKey, batch.bank_id, nowIso);
      missingRecordExceptions.push({
        exceptionId,
        executionKey: missingKey,
        reason: "MISSING_FROM_BANK_RESPONSE",
      });
    }

    this.db
      .prepare(`UPDATE enach_batches SET status = 'RECONCILED' WHERE batch_id = ?`)
      .run(batchId);

    return {
      batchId,
      bankId: batch.bank_id,
      succeededCount,
      softFailedCount,
      hardFailedCount,
      missingRecordExceptions,
      unexpectedKeys: diff.unexpectedInResponse,
    };
  }
}
