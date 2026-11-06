import { DatabaseSync } from "node:sqlite";
import {
  maskAccountNumber,
  formatStan,
  resolvePspIdFromVpa,
  signServiceMessage,
  INR_CURRENCY_NUMERIC,
  type Iso8583MessageEnvelope,
  type ProcessingCode,
} from "../../../packages/core/src/index.ts";

/**
 * Project 1 — PSP Simulator (Requirements 2, 3, 4, 11, 12, Pages 4–9)
 *
 * Role:
 * - Owns VPAs (handles like `anita@psp1`) for its users
 * - Maps a VPA to `(bank_id, account_number, holder_name, created_at)`
 * - External `GET /vpa/{handle}` returns ONLY `bank_id`, `masked_account` (`XXXX4521`), and `holder_name` (Rule 10)
 * - Mints globally unique `transaction_id` and sequential 6-digit `STAN`, signs requests with HMAC (Rule 9),
 *   and forwards payment / balance enquiry requests to the Switch.
 */

export interface VpaDirectoryRecord {
  vpa: string;
  psp_id: string;
  bank_id: string;
  account_number: string;
  holder_name: string;
  created_at: string;
}

export interface MaskedVpaLookupResponse {
  vpa: string;
  psp_id: string;
  bank_id: string;
  masked_account: string; // Strictly "XXXX4521" (Rule 10 & Req 2)
  holder_name: string;
}

export interface PspConfig {
  pspId: string; // e.g., "PSP1", "PSP2"
  handleSuffix: string; // e.g., "psp1", "psp2"
  sharedSecret: string; // HMAC secret shared with Switch
  dbPath?: string;
}

export class PspSimulator {
  public readonly config: PspConfig;
  public readonly db: DatabaseSync;
  private stanCounter = 0;

  constructor(config: PspConfig) {
    this.config = config;
    this.db = new DatabaseSync(config.dbPath ?? ":memory:");
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS vpa_mappings (
        vpa TEXT PRIMARY KEY,
        psp_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        holder_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Registers a VPA in this PSP's directory.
   * Enforces that the handle suffix belongs to this PSP and that the VPA is unique.
   */
  public registerVpa(params: {
    vpa: string;
    bankId: string;
    accountNumber: string;
    holderName: string;
  }): MaskedVpaLookupResponse {
    const normalizedVpa = params.vpa.trim().toLowerCase();
    const resolvedPspId = resolvePspIdFromVpa(normalizedVpa);
    if (resolvedPspId !== this.config.pspId.toUpperCase()) {
      throw new Error(
        `PSP ${this.config.pspId} cannot register VPA "${normalizedVpa}" (belongs to ${resolvedPspId})`
      );
    }

    const existing = this.db
      .prepare(`SELECT vpa FROM vpa_mappings WHERE vpa = ?`)
      .get(normalizedVpa);
    if (existing) {
      throw new Error(`VPA "${normalizedVpa}" is already taken`);
    }

    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO vpa_mappings (vpa, psp_id, bank_id, account_number, holder_name, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        normalizedVpa,
        this.config.pspId,
        params.bankId,
        params.accountNumber,
        params.holderName,
        nowIso
      );

    return {
      vpa: normalizedVpa,
      psp_id: this.config.pspId,
      bank_id: params.bankId,
      masked_account: maskAccountNumber(params.accountNumber),
      holder_name: params.holderName,
    };
  }

  /**
   * Project 1 Requirement 2 & Interface `GET /vpa/{handle}`:
   * A VPA lookup from another participant returns ONLY the bank id, the masked account (`XXXX4521`),
   * and the holder display name. Never exposes the raw account number!
   */
  public lookupVpaExternal(vpa: string): MaskedVpaLookupResponse | null {
    const normalized = vpa.trim().toLowerCase();
    const row = this.db
      .prepare(`SELECT * FROM vpa_mappings WHERE vpa = ?`)
      .get(normalized) as unknown as VpaDirectoryRecord | undefined;

    if (!row) {
      return null;
    }

    return {
      vpa: row.vpa,
      psp_id: row.psp_id,
      bank_id: row.bank_id,
      masked_account: maskAccountNumber(row.account_number),
      holder_name: row.holder_name,
    };
  }

  /**
   * Resolves the underlying bank account number for bank-core execution.
   * Only used for routing the bank instruction; never logged or returned to merchants/other PSPs.
   */
  public resolveBankAccountInternal(vpa: string): VpaDirectoryRecord | null {
    const normalized = vpa.trim().toLowerCase();
    const row = this.db
      .prepare(`SELECT * FROM vpa_mappings WHERE vpa = ?`)
      .get(normalized) as unknown as VpaDirectoryRecord | undefined;
    return row ?? null;
  }

  public nextStan(): string {
    this.stanCounter += 1;
    return formatStan(this.stanCounter);
  }

  /**
   * Builds and HMAC-signs an outgoing ISO 8583 request envelope (`0200` PAY or `0100` BAL)
   * from this PSP to the Central Switch.
   */
  public createSignedRequestEnvelope(params: {
    mti: "0200" | "0100";
    processingCode: ProcessingCode;
    transactionId: string;
    payerVpa: string;
    payeeVpa?: string;
    amountPaise: number;
    stan?: string;
    now?: Date;
  }): Iso8583MessageEnvelope {
    const now = params.now ?? new Date();
    const stan = params.stan ?? this.nextStan();
    const payerRecord = this.lookupVpaExternal(params.payerVpa);

    const unsigned: Omit<Iso8583MessageEnvelope, "signature"> = {
      mti: params.mti,
      transaction_id: params.transactionId,
      stan,
      processing_code: params.processingCode,
      amount: params.amountPaise,
      currency: INR_CURRENCY_NUMERIC,
      transmission_time: now.toISOString(),
      payer_vpa: params.payerVpa.toLowerCase(),
      payee_vpa: params.payeeVpa?.toLowerCase(),
      payer_psp_id: this.config.pspId,
      remitter_bank_id: payerRecord?.bank_id,
      account_reference: payerRecord?.masked_account,
    };

    const rawBody = JSON.stringify(unsigned);
    const signature = signServiceMessage(
      rawBody,
      unsigned.transmission_time,
      this.config.sharedSecret
    );

    return {
      ...unsigned,
      signature,
    };
  }
}
