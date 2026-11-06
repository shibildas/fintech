import { DatabaseSync } from "node:sqlite";
import {
  DoubleEntryLedger,
  AuditLogger,
  maskAccountNumber,
  verifyServiceMessage,
  signServiceMessage,
  type IsoResponseCode,
  type Iso8583MessageEnvelope,
  validateIso8583Envelope,
} from "../../../packages/core/src/index.ts";

/**
 * Project 1 — Bank Core Simulator (Requirements 4, 5, 6, 7, 8, 11, 13, 14, 15, 16, Pages 7–10)
 *
 * Same code, 3+ configurations (e.g., BANKA, BANKB, BANKC):
 * - Holds accounts & derived balances (`available_balance_paise` excludes holds)
 * - Verifies UPI PIN (with 3-strike account freeze)
 * - Keyed by RRN for `/debit`, `/credit`, `/reversal`, `/check`, and `/balance`
 * - Supports Chaos / Failure Injection (`latencyMs`, `errorRatePercent`, `debitThenHang`)
 * - Produces independent End-of-Day (EOD) transaction report for 3-way reconciliation
 */

export interface BankChaosConfig {
  latencyMs: number;
  errorRatePercent: number; // 0 to 100 -> returns '91' (bank unavailable)
  debitThenHang: boolean; // Requirement 15: commits debit in DB, then hangs/times out without responding!
  forceDown: boolean; // Simulates bank completely down ('91')
}

export interface BankEodReportRow {
  bank_id: string;
  rrn: string;
  transaction_id: string;
  account_number_masked: string;
  direction: "DEBIT" | "CREDIT" | "REVERSAL";
  amount_paise: number;
  status: "SUCCESS" | "REVERSED";
  timestamp: string;
}

export interface BankCoreConfig {
  bankId: string; // e.g., "BANKA", "BANKB", "BANKC"
  bankName: string;
  branchPrefix: string; // e.g., "BNKA0001"
  sharedSecret: string; // HMAC secret shared with Switch
  dbPath?: string; // defaults to ":memory:"
}

export class BankTimeoutSimulatedError extends Error {
  public readonly rrn: string;
  constructor(bankId: string, rrn: string, reason: string) {
    super(`Bank ${bankId} timed out on RRN ${rrn} (${reason})`);
    this.name = "BankTimeoutSimulatedError";
    this.rrn = rrn;
  }
}

export class BankCoreSimulator {
  public readonly config: BankCoreConfig;
  public readonly db: DatabaseSync;
  public readonly ledger: DoubleEntryLedger;
  public readonly audit: AuditLogger;
  private chaos: BankChaosConfig = {
    latencyMs: 0,
    errorRatePercent: 0,
    debitThenHang: false,
    forceDown: false,
  };

  private metrics = {
    requestsTotal: 0,
    debitSuccess: 0,
    debitFailed: 0,
    creditSuccess: 0,
    reversalSuccess: 0,
    statusChecks: 0,
    balanceEnquiries: 0,
    chaosTimeoutsTriggered: 0,
    chaosErrorsTriggered: 0,
  };

  constructor(config: BankCoreConfig) {
    this.config = config;
    this.db = new DatabaseSync(config.dbPath ?? ":memory:");
    this.ledger = new DoubleEntryLedger(this.db, `ACCT_${config.bankId}_NPCI_NOSTRO`);
    this.audit = new AuditLogger(this.db);
  }

  /**
   * Requirement 15 & Interface `PUT /participants/{id}/chaos`:
   * Updates failure-injection behavior at runtime without a code change (Rule 13 & 14).
   */
  public setChaosConfig(
    update: Partial<BankChaosConfig>,
    actorId = "operator-console",
    requestId = "REQ-CHAOS"
  ): BankChaosConfig {
    const oldChaos = { ...this.chaos };
    this.chaos = {
      ...this.chaos,
      ...update,
    };
    this.audit.record({
      actorId,
      actorRole: "operator",
      action: "UPDATE_BANK_CHAOS_CONFIG",
      entityType: "BankParticipant",
      entityId: this.config.bankId,
      oldValue: oldChaos,
      newValue: this.chaos,
      requestId,
    });
    return { ...this.chaos };
  }

  public getChaosConfig(): BankChaosConfig {
    return { ...this.chaos };
  }

  public getHealth() {
    return {
      bank_id: this.config.bankId,
      status: this.chaos.forceDown
        ? "DOWN"
        : this.chaos.errorRatePercent > 0 ||
            this.chaos.latencyMs > 1000 ||
            this.chaos.debitThenHang
          ? "DEGRADED"
          : "UP",
      chaos: this.getChaosConfig(),
      metrics: { ...this.metrics },
    };
  }

  /**
   * Project 3 Requirement 4 support: Discover customer accounts linked to a mobile number
   * or look up account holder name before PIN step (Project 3 Req 9).
   */
  public seedCustomerAccount(params: {
    accountNumber: string;
    holderName: string;
    rawPin: string;
    openingBalancePaise: number;
    perTransactionLimitPaise?: number;
    dailyLimitPaise?: number;
  }) {
    return this.ledger.createAccount({
      accountNumber: params.accountNumber,
      branchCode: this.config.branchPrefix,
      holderName: params.holderName,
      accountType: "CUSTOMER",
      rawPin: params.rawPin,
      perTransactionLimitPaise: params.perTransactionLimitPaise,
      dailyLimitPaise: params.dailyLimitPaise,
      initialOpeningBalancePaise: params.openingBalancePaise,
    });
  }

  private async applyPreOperationChaos(rrn: string): Promise<IsoResponseCode | null> {
    if (this.chaos.latencyMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.chaos.latencyMs));
    }
    if (this.chaos.forceDown) {
      this.metrics.chaosErrorsTriggered += 1;
      return "91";
    }
    if (this.chaos.errorRatePercent > 0) {
      const roll = Math.random() * 100;
      if (roll < this.chaos.errorRatePercent) {
        this.metrics.chaosErrorsTriggered += 1;
        return "91";
      }
    }
    return null;
  }

  /**
   * Verifies incoming Switch -> Bank HMAC signature (Rule 9).
   */
  public verifySwitchEnvelope(envelope: Iso8583MessageEnvelope, nowMs?: number): void {
    validateIso8583Envelope(envelope);
    const { signature, ...unsignedBody } = envelope;
    const rawBody = JSON.stringify(unsignedBody);
    const verification = verifyServiceMessage(
      rawBody,
      envelope.transmission_time,
      signature,
      this.config.sharedSecret,
      {
        nowMs,
        onReject: (reason, details) => {
          this.audit.record({
            actorId: "SWITCH",
            actorRole: "system",
            action: `HMAC_REJECTED_${reason}`,
            entityType: "IsoMessage",
            entityId: envelope.transaction_id,
            newValue: details,
            requestId: envelope.transaction_id,
          });
        },
      }
    );
    if (!verification.valid) {
      throw new Error(`Rule 9 HMAC Verification Failed: ${verification.reason}`);
    }
  }

  public signBankResponse(
    unsignedEnvelope: Omit<Iso8583MessageEnvelope, "signature">
  ): Iso8583MessageEnvelope {
    const rawBody = JSON.stringify(unsignedEnvelope);
    const signature = signServiceMessage(
      rawBody,
      unsignedEnvelope.transmission_time,
      this.config.sharedSecret
    );
    return {
      ...unsignedEnvelope,
      signature,
    };
  }

  /**
   * Interface: `POST /debit` (Switch -> Remitter Bank, MTI 0200 -> 0210)
   * Keyed by RRN (Requirement 5 & 6).
   * If `chaos.debitThenHang` is enabled (Requirement 15), commits the debit to SQLite
   * and then throws `BankTimeoutSimulatedError` so the Switch experiences a timeout AFTER debit!
   */
  public async handleDebit(params: {
    envelope: Iso8583MessageEnvelope;
    accountNumber: string;
    rawPin: string;
    now?: Date;
  }): Promise<Iso8583MessageEnvelope> {
    this.metrics.requestsTotal += 1;
    const now = params.now ?? new Date();
    this.verifySwitchEnvelope(params.envelope, now.getTime());

    if (!params.envelope.rrn) {
      throw new Error("RRN is required on POST /debit");
    }

    const preChaosCode = await this.applyPreOperationChaos(params.envelope.rrn);
    if (preChaosCode) {
      this.metrics.debitFailed += 1;
      return this.buildResponseEnvelope(params.envelope, "0210", preChaosCode, now);
    }

    const result = this.ledger.debitCustomerAccountByRrn({
      rrn: params.envelope.rrn,
      transactionId: params.envelope.transaction_id,
      accountNumber: params.accountNumber,
      amountPaise: params.envelope.amount,
      rawPin: params.rawPin,
      messageId: `MSG-DEBIT-${params.envelope.rrn}`,
      now,
    });

    if (result.response_code === "00") {
      this.metrics.debitSuccess += 1;
    } else {
      this.metrics.debitFailed += 1;
    }

    // Requirement 15 & Acceptance Test 5: "debit then never respond" mode!
    if (this.chaos.debitThenHang && result.response_code === "00" && !result.replayed) {
      this.metrics.chaosTimeoutsTriggered += 1;
      throw new BankTimeoutSimulatedError(
        this.config.bankId,
        params.envelope.rrn,
        "debitThenHang chaos mode active: debit committed in DB, response dropped"
      );
    }

    return this.buildResponseEnvelope(
      params.envelope,
      "0210",
      result.response_code,
      now,
      maskAccountNumber(params.accountNumber)
    );
  }

  /**
   * Interface: `POST /credit` (Switch -> Beneficiary Bank, MTI 0200 -> 0210)
   * Keyed by RRN.
   */
  public async handleCredit(params: {
    envelope: Iso8583MessageEnvelope;
    accountNumber: string;
    now?: Date;
  }): Promise<Iso8583MessageEnvelope> {
    this.metrics.requestsTotal += 1;
    const now = params.now ?? new Date();
    this.verifySwitchEnvelope(params.envelope, now.getTime());

    if (!params.envelope.rrn) {
      throw new Error("RRN is required on POST /credit");
    }

    const preChaosCode = await this.applyPreOperationChaos(params.envelope.rrn);
    if (preChaosCode) {
      return this.buildResponseEnvelope(params.envelope, "0210", preChaosCode, now);
    }

    const result = this.ledger.creditCustomerAccountByRrn({
      rrn: params.envelope.rrn,
      transactionId: params.envelope.transaction_id,
      accountNumber: params.accountNumber,
      amountPaise: params.envelope.amount,
      messageId: `MSG-CREDIT-${params.envelope.rrn}`,
      nowIso: now.toISOString(),
    });

    if (result.response_code === "00") {
      this.metrics.creditSuccess += 1;
    }

    return this.buildResponseEnvelope(
      params.envelope,
      "0210",
      result.response_code,
      now,
      maskAccountNumber(params.accountNumber)
    );
  }

  /**
   * Interface: `POST /reversal` (Switch -> Remitter Bank, MTI 0420 -> 0430)
   * Re-credits the payer when credit leg fails past retry deadline (Requirement 8).
   */
  public async handleReversal(params: {
    envelope: Iso8583MessageEnvelope;
    now?: Date;
  }): Promise<Iso8583MessageEnvelope> {
    this.metrics.requestsTotal += 1;
    const now = params.now ?? new Date();
    this.verifySwitchEnvelope(params.envelope, now.getTime());

    if (!params.envelope.rrn) {
      throw new Error("RRN is required on POST /reversal");
    }

    const preChaosCode = await this.applyPreOperationChaos(params.envelope.rrn);
    if (preChaosCode) {
      return this.buildResponseEnvelope(params.envelope, "0430", preChaosCode, now);
    }

    const result = this.ledger.reverseDebitByRrn({
      rrn: params.envelope.rrn,
      transactionId: params.envelope.transaction_id,
      messageId: `MSG-REV-${params.envelope.rrn}`,
      nowIso: now.toISOString(),
    });

    if (result.response_code === "00") {
      this.metrics.reversalSuccess += 1;
    }

    return this.buildResponseEnvelope(
      params.envelope,
      "0430",
      result.response_code,
      now
    );
  }

  /**
   * Interface: `POST /check` (Switch -> Bank, MTI 0100 processing_code CHK -> 0110)
   * Requirement 7: Queries whether a timed-out debit or credit on `RRN` actually happened.
   * Writes NO ledger postings.
   */
  public async handleStatusCheck(params: {
    envelope: Iso8583MessageEnvelope;
    operation?: "DEBIT" | "CREDIT";
    now?: Date;
  }): Promise<{
    envelope: Iso8583MessageEnvelope;
    found: boolean;
    original_response_code: IsoResponseCode | null;
  }> {
    this.metrics.requestsTotal += 1;
    this.metrics.statusChecks += 1;
    const now = params.now ?? new Date();
    this.verifySwitchEnvelope(params.envelope, now.getTime());

    if (!params.envelope.rrn) {
      throw new Error("RRN is required on POST /check");
    }

    const opType = params.operation ?? "DEBIT";
    const row = this.db
      .prepare(
        `SELECT response_code FROM rrn_operations WHERE rrn = ? AND operation = ?`
      )
      .get(params.envelope.rrn, opType) as
      | { response_code: IsoResponseCode }
      | undefined;

    if (!row) {
      return {
        envelope: this.buildResponseEnvelope(params.envelope, "0110", "12", now),
        found: false,
        original_response_code: null,
      };
    }

    return {
      envelope: this.buildResponseEnvelope(
        params.envelope,
        "0110",
        row.response_code,
        now
      ),
      found: true,
      original_response_code: row.response_code,
    };
  }

  /**
   * Interface: `POST /balance` (Switch -> Payer Bank, MTI 0100 processing_code BAL -> 0110)
   * Requirement 11 & Acceptance Test 10: Verifies PIN, returns available balance (excluding holds),
   * and writes NO ledger posting.
   */
  public async handleBalanceEnquiry(params: {
    envelope: Iso8583MessageEnvelope;
    accountNumber: string;
    rawPin: string;
    now?: Date;
  }): Promise<{
    envelope: Iso8583MessageEnvelope;
    available_balance_paise: number | null;
  }> {
    this.metrics.requestsTotal += 1;
    this.metrics.balanceEnquiries += 1;
    const now = params.now ?? new Date();
    this.verifySwitchEnvelope(params.envelope, now.getTime());

    const account = this.ledger.getAccount(params.accountNumber);
    if (!account) {
      return {
        envelope: this.buildResponseEnvelope(params.envelope, "0110", "14", now),
        available_balance_paise: null,
      };
    }

    const bal = this.ledger.getBalance(params.accountNumber);
    return {
      envelope: this.buildResponseEnvelope(
        params.envelope,
        "0110",
        "00",
        now,
        maskAccountNumber(params.accountNumber)
      ),
      available_balance_paise: bal.available_balance_paise,
    };
  }

  /**
   * Requirement 16: End-of-day (EOD) transaction report generated independently by the bank core
   * for three-way reconciliation (`RRN`, `direction`, `amount_paise`, `status`, `timestamp`).
   */
  public generateEodReport(): BankEodReportRow[] {
    const ops = this.db
      .prepare(
        `SELECT rrn, operation, response_code, journal_id, created_at
         FROM rrn_operations
         WHERE response_code = '00'
         ORDER BY created_at ASC`
      )
      .all() as Array<{
      rrn: string;
      operation: "DEBIT" | "CREDIT" | "REVERSAL";
      response_code: string;
      journal_id: string;
      created_at: string;
    }>;

    const reversedRrns = new Set(
      ops.filter((o) => o.operation === "REVERSAL").map((o) => o.rrn)
    );

    const report: BankEodReportRow[] = [];

    for (const op of ops) {
      if (op.operation === "REVERSAL") {
        continue; // Reversals mark the original DEBIT row as REVERSED
      }
      const customerPosting = this.db
        .prepare(
          `SELECT transaction_id, account_number, amount_paise, created_at
           FROM postings
           WHERE journal_id = ? AND account_number != ?
           LIMIT 1`
        )
        .get(op.journal_id, this.ledger.settlementAccountNumber) as
        | {
            transaction_id: string;
            account_number: string;
            amount_paise: number;
            created_at: string;
          }
        | undefined;

      if (customerPosting) {
        report.push({
          bank_id: this.config.bankId,
          rrn: op.rrn,
          transaction_id: customerPosting.transaction_id,
          account_number_masked: maskAccountNumber(customerPosting.account_number),
          direction: op.operation,
          amount_paise: customerPosting.amount_paise,
          status:
            op.operation === "DEBIT" && reversedRrns.has(op.rrn)
              ? "REVERSED"
              : "SUCCESS",
          timestamp: customerPosting.created_at,
        });
      }
    }

    return report;
  }

  private buildResponseEnvelope(
    req: Iso8583MessageEnvelope,
    responseMti: "0210" | "0430" | "0110",
    responseCode: IsoResponseCode,
    now: Date,
    maskedAccount?: string
  ): Iso8583MessageEnvelope {
    const unsigned: Omit<Iso8583MessageEnvelope, "signature"> = {
      mti: responseMti,
      transaction_id: req.transaction_id,
      stan: req.stan,
      rrn: req.rrn,
      processing_code: req.processing_code,
      amount: req.amount,
      currency: req.currency,
      transmission_time: now.toISOString(),
      payer_vpa: req.payer_vpa,
      payee_vpa: req.payee_vpa,
      payer_psp_id: req.payer_psp_id,
      payee_psp_id: req.payee_psp_id,
      remitter_bank_id: req.remitter_bank_id,
      beneficiary_bank_id: req.beneficiary_bank_id,
      account_reference: maskedAccount ?? req.account_reference,
      response_code: responseCode,
    };
    return this.signBankResponse(unsigned);
  }
}
