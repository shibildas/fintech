import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLogger,
  IdempotencyStore,
  SingleFlightIdempotencyCache,
  canonicalJsonHash,
  mintRrn,
  formatStan,
  resolvePspIdFromVpa,
  signServiceMessage,
  verifyServiceMessage,
  validateIso8583Envelope,
  assertValidTransition,
  SWITCH_TRANSACTION_TRANSITIONS,
  INR_CURRENCY_NUMERIC,
  type Iso8583MessageEnvelope,
  type IsoResponseCode,
  type SwitchTransactionState,
} from "../../../packages/core/src/index.ts";
import {
  BankCoreSimulator,
  BankTimeoutSimulatedError,
} from "./bank-core.ts";
import { PspSimulator } from "./psp-simulator.ts";

/**
 * Project 1 — Central UPI-Style Switch (Requirements 1–12, 17–24, Pages 6–10)
 *
 * Responsibilities:
 * - Participant Registry (PSPs and Banks with status UP / DOWN / DEGRADED)
 * - Address Resolution through Payer PSP and Payee PSP (`GET /vpa/{handle}`)
 * - 6-Hop Pay Flow (`POST /pay` MTI 0200 -> 0210) with hop-by-hop `message_logs`
 * - Strict Transaction State Machine (`RECEIVED -> DEBIT_REQUESTED -> ...`) + State History
 * - Exactly-Once deduplication by `transaction_id` (SingleFlight + SQLite IdempotencyStore)
 * - Remitter Timeout -> Status Check (`CHK` MTI 0100) recovery (Req 7)
 * - Beneficiary Credit Failure -> `CREDIT_PENDING` retry schedule -> `0420` Reversal (Req 8)
 * - Deemed-Approved late `0210 00` after reversal conflict flagging (Req 9)
 * - Mid-transaction crash recovery on Switch restart (`resumeInFlightTransactions`, NFR 2)
 */

export type ParticipantStatus = "UP" | "DOWN" | "DEGRADED";

export interface ParticipantRecord {
  id: string;
  type: "PSP" | "BANK";
  endpoint: string;
  secret: string;
  status: ParticipantStatus;
  updated_at: string;
}

export interface SwitchTransactionRecord {
  transaction_id: string;
  rrn: string;
  stan: string;
  type: "PAY" | "BAL";
  amount_paise: number;
  currency: string;
  payer_vpa: string;
  payee_vpa: string | null;
  payer_psp_id: string;
  payee_psp_id: string | null;
  remitter_bank_id: string;
  beneficiary_bank_id: string | null;
  state: SwitchTransactionState;
  response_code: IsoResponseCode | null;
  settlement_cycle_id: string | null;
  credit_retry_count: number;
  deemed_approved_conflict: number; // 1 if late 0210 00 arrived after timeout+reversal (Req 9)
  raw_pin_cached_for_resume: string | null;
  created_at: string;
  updated_at: string;
}

export interface MessageLogRecord {
  id: string;
  transaction_id: string;
  rrn: string;
  hop_number: number;
  direction: "IN" | "OUT";
  from_participant: string;
  to_participant: string;
  mti: string;
  processing_code: string;
  body_json: string;
  response_code: string | null;
  sent_at: string;
  received_at: string;
}

export interface StateHistoryRecord {
  id: string;
  transaction_id: string;
  rrn: string;
  from_state: string | null;
  to_state: SwitchTransactionState;
  reason: string;
  created_at: string;
}

export interface SwitchConfig {
  dbPath?: string;
  bankTimeoutMs?: number; // Default 5000ms (Req 7)
  maxCreditRetries?: number; // Default 3 retries before 0420 Reversal (Req 8)
  activeCycleId?: string; // Current T+1 settlement cycle ID (Req 17)
}

export class CentralSwitch {
  public readonly db: DatabaseSync;
  public readonly audit: AuditLogger;
  public readonly idempotencyStore: IdempotencyStore;
  private readonly singleFlight = new SingleFlightIdempotencyCache<{
    envelope: Iso8583MessageEnvelope;
    transaction: SwitchTransactionRecord;
    hops: MessageLogRecord[];
  }>(20_000, 10 * 60 * 1000);

  private readonly banks = new Map<string, BankCoreSimulator>();
  private readonly psps = new Map<string, PspSimulator>();
  private stanSequence = 0;

  public bankTimeoutMs: number;
  public maxCreditRetries: number;
  public activeCycleId: string;

  constructor(config?: SwitchConfig) {
    this.db = new DatabaseSync(config?.dbPath ?? ":memory:");
    this.audit = new AuditLogger(this.db);
    this.idempotencyStore = new IdempotencyStore(this.db);
    this.bankTimeoutMs = config?.bankTimeoutMs ?? 5_000;
    this.maxCreditRetries = config?.maxCreditRetries ?? 3;
    this.activeCycleId = config?.activeCycleId ?? "CYC-2026-11-07";
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS participants (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK (type IN ('PSP', 'BANK')),
        endpoint TEXT NOT NULL,
        secret TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'UP' CHECK (status IN ('UP', 'DOWN', 'DEGRADED')),
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS switch_transactions (
        transaction_id TEXT PRIMARY KEY,
        rrn TEXT NOT NULL UNIQUE,
        stan TEXT NOT NULL,
        type TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        currency TEXT NOT NULL,
        payer_vpa TEXT NOT NULL,
        payee_vpa TEXT,
        payer_psp_id TEXT NOT NULL,
        payee_psp_id TEXT,
        remitter_bank_id TEXT NOT NULL,
        beneficiary_bank_id TEXT,
        state TEXT NOT NULL,
        response_code TEXT,
        settlement_cycle_id TEXT,
        credit_retry_count INTEGER NOT NULL DEFAULT 0,
        deemed_approved_conflict INTEGER NOT NULL DEFAULT 0,
        raw_pin_cached_for_resume TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_switch_tx_rrn ON switch_transactions(rrn);
      CREATE INDEX IF NOT EXISTS idx_switch_tx_state ON switch_transactions(state);
      CREATE INDEX IF NOT EXISTS idx_switch_tx_cycle ON switch_transactions(settlement_cycle_id);

      CREATE TABLE IF NOT EXISTS message_logs (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        rrn TEXT NOT NULL,
        hop_number INTEGER NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('IN', 'OUT')),
        from_participant TEXT NOT NULL,
        to_participant TEXT NOT NULL,
        mti TEXT NOT NULL,
        processing_code TEXT NOT NULL,
        body_json TEXT NOT NULL,
        response_code TEXT,
        sent_at TEXT NOT NULL,
        received_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_msg_logs_tx ON message_logs(transaction_id, hop_number);
      CREATE INDEX IF NOT EXISTS idx_msg_logs_rrn ON message_logs(rrn, hop_number);

      CREATE TABLE IF NOT EXISTS transaction_state_history (
        id TEXT PRIMARY KEY,
        transaction_id TEXT NOT NULL,
        rrn TEXT NOT NULL,
        from_state TEXT,
        to_state TEXT NOT NULL,
        reason TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Requirement 1: Participant registry (PSPs and Banks with ids, endpoints, shared secrets, and status).
   */
  public registerBank(bank: BankCoreSimulator, endpoint?: string): void {
    this.banks.set(bank.config.bankId, bank);
    this.upsertParticipant({
      id: bank.config.bankId,
      type: "BANK",
      endpoint: endpoint ?? `http://localhost/banks/${bank.config.bankId.toLowerCase()}`,
      secret: bank.config.sharedSecret,
      status: "UP",
    });
  }

  public registerPsp(psp: PspSimulator, endpoint?: string): void {
    this.psps.set(psp.config.pspId, psp);
    this.upsertParticipant({
      id: psp.config.pspId,
      type: "PSP",
      endpoint: endpoint ?? `http://localhost/psps/${psp.config.pspId.toLowerCase()}`,
      secret: psp.config.sharedSecret,
      status: "UP",
    });
  }

  private upsertParticipant(p: Omit<ParticipantRecord, "updated_at">): void {
    const nowIso = new Date().toISOString();
    this.db
      .prepare(
        `INSERT INTO participants (id, type, endpoint, secret, status, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           endpoint = excluded.endpoint,
           secret = excluded.secret,
           status = excluded.status,
           updated_at = excluded.updated_at`
      )
      .run(p.id, p.type, p.endpoint, p.secret, p.status, nowIso);
  }

  public setParticipantStatus(
    participantId: string,
    status: ParticipantStatus,
    actorId = "switch-operator",
    requestId = "REQ-PARTICIPANT-STATUS"
  ): ParticipantRecord {
    const existing = this.getParticipant(participantId);
    if (!existing) {
      throw new Error(`Participant "${participantId}" not found in registry`);
    }
    const nowIso = new Date().toISOString();
    this.db
      .prepare(`UPDATE participants SET status = ?, updated_at = ? WHERE id = ?`)
      .run(status, nowIso, participantId);

    this.audit.record({
      actorId,
      actorRole: "operator",
      action: "CHANGE_PARTICIPANT_STATUS",
      entityType: "Participant",
      entityId: participantId,
      oldValue: { status: existing.status },
      newValue: { status },
      requestId,
      nowIso,
    });

    return this.getParticipant(participantId)!;
  }

  public getParticipant(participantId: string): ParticipantRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM participants WHERE id = ?`)
      .get(participantId) as unknown as ParticipantRecord | undefined;
  }

  public listParticipants(): ParticipantRecord[] {
    return this.db
      .prepare(`SELECT * FROM participants ORDER BY type DESC, id ASC`)
      .all() as unknown as ParticipantRecord[];
  }

  private nextSwitchStan(): string {
    this.stanSequence += 1;
    return formatStan(this.stanSequence);
  }

  /**
   * Interface: `POST /pay` (PSP -> Switch, Financial Request MTI 0200 -> 0210)
   *
   * Implements Requirements 3, 4, 5, 7, 8, 9, 10:
   * - SingleFlight + IdempotencyStore deduplication by `envelope.transaction_id`
   * - Address resolution via Payer PSP & Payee PSP (`14` on unknown VPA)
   * - 6-Hop message logging (`message_logs`)
   * - Remitter bank timeout -> `DEBIT_UNKNOWN` -> `CHK` status check (Req 7)
   * - Beneficiary credit failure -> `CREDIT_PENDING` retries -> `0420` Reversal (Req 8)
   */
  public async handlePay(params: {
    envelope: Iso8583MessageEnvelope;
    rawPin: string;
    now?: Date;
  }): Promise<{
    envelope: Iso8583MessageEnvelope;
    transaction: SwitchTransactionRecord;
    hops: MessageLogRecord[];
    replayed: boolean;
  }> {
    const now = params.now ?? new Date();
    validateIso8583Envelope(params.envelope);

    // Verify Payer PSP HMAC signature (Rule 9)
    const payerPspId =
      params.envelope.payer_psp_id ?? resolvePspIdFromVpa(params.envelope.payer_vpa);
    const payerPspParticipant = this.getParticipant(payerPspId);
    if (!payerPspParticipant) {
      throw new Error(`Unknown Payer PSP "${payerPspId}"`);
    }

    const { signature, ...unsignedReq } = params.envelope;
    const verifyRes = verifyServiceMessage(
      JSON.stringify(unsignedReq),
      params.envelope.transmission_time,
      signature,
      payerPspParticipant.secret,
      { nowMs: now.getTime() }
    );
    if (!verifyRes.valid) {
      throw new Error(`Rule 9 Switch HMAC Verification Failed: ${verifyRes.reason}`);
    }

    // Canonical payload hash for Rule 5 idempotency check (excludes timestamp/STAN/signature)
    const businessPayload = {
      transaction_id: params.envelope.transaction_id,
      processing_code: params.envelope.processing_code,
      amount: params.envelope.amount,
      currency: params.envelope.currency,
      payer_vpa: params.envelope.payer_vpa.toLowerCase(),
      payee_vpa: params.envelope.payee_vpa?.toLowerCase() ?? "",
    };
    const payloadHash = canonicalJsonHash(businessPayload);

    const sfResult = await this.singleFlight.execute({
      idempotencyKey: params.envelope.transaction_id,
      payloadHash,
      nowMs: now.getTime(),
      work: async () => {
        // Also check persistent SQLite IdempotencyStore in case Switch restarted
        const existingTx = this.getTransactionById(params.envelope.transaction_id);
        if (existingTx) {
          this.idempotencyStore.execute({
            scope: "SWITCH:POST:/pay",
            idempotencyKey: params.envelope.transaction_id,
            requestPayload: businessPayload,
            handler: () => ({ statusCode: 200, body: existingTx }),
          });
          const hops = this.listMessageLogsByRrn(existingTx.rrn);
          const finalHop = hops[hops.length - 1];
          return {
            envelope: JSON.parse(finalHop.body_json) as Iso8583MessageEnvelope,
            transaction: existingTx,
            hops,
          };
        }

        const result = await this.executePayJourney(params.envelope, params.rawPin, now);

        this.idempotencyStore.execute({
          scope: "SWITCH:POST:/pay",
          idempotencyKey: params.envelope.transaction_id,
          requestPayload: businessPayload,
          handler: () => ({ statusCode: 200, body: result.transaction }),
        });

        return result;
      },
    });

    return {
      ...sfResult.value,
      replayed: sfResult.coalescedOrReplayed,
    };
  }

  private async executePayJourney(
    reqEnvelope: Iso8583MessageEnvelope,
    rawPin: string,
    now: Date
  ): Promise<{
    envelope: Iso8583MessageEnvelope;
    transaction: SwitchTransactionRecord;
    hops: MessageLogRecord[];
  }> {
    const rrn = reqEnvelope.rrn ?? mintRrn(this.nextSwitchStan(), now);
    const payerVpa = reqEnvelope.payer_vpa.toLowerCase();
    const payeeVpa = reqEnvelope.payee_vpa?.toLowerCase() ?? "";

    let payerPspId = "UNKNOWN";
    let payeePspId = "UNKNOWN";
    try {
      payerPspId = resolvePspIdFromVpa(payerVpa);
      payeePspId = resolvePspIdFromVpa(payeeVpa);
    } catch {
      // Invalid VPA syntax -> code 14
    }

    const payerPsp = this.psps.get(payerPspId);
    const payeePsp = this.psps.get(payeePspId);

    // Requirement 3: Address resolution through Payer PSP and Payee PSP
    const payerDirectory = payerPsp?.lookupVpaExternal(payerVpa) ?? null;
    const payeeDirectory = payeePsp?.lookupVpaExternal(payeeVpa) ?? null;

    const remitterBankId = payerDirectory?.bank_id ?? "UNKNOWN";
    const beneficiaryBankId = payeeDirectory?.bank_id ?? "UNKNOWN";

    // Create initial transaction record in state RECEIVED
    const nowIso = now.toISOString();
    this.db
      .prepare(
        `INSERT INTO switch_transactions (
          transaction_id, rrn, stan, type, amount_paise, currency,
          payer_vpa, payee_vpa, payer_psp_id, payee_psp_id,
          remitter_bank_id, beneficiary_bank_id, state, response_code,
          settlement_cycle_id, credit_retry_count, deemed_approved_conflict,
          raw_pin_cached_for_resume, created_at, updated_at
        ) VALUES (?, ?, ?, 'PAY', ?, ?, ?, ?, ?, ?, ?, ?, 'RECEIVED', NULL, NULL, 0, 0, ?, ?, ?)`
      )
      .run(
        reqEnvelope.transaction_id,
        rrn,
        reqEnvelope.stan,
        reqEnvelope.amount,
        reqEnvelope.currency,
        payerVpa,
        payeeVpa,
        payerPspId,
        payeePspId,
        remitterBankId,
        beneficiaryBankId,
        rawPin,
        nowIso,
        nowIso
      );

    this.recordStateChange(
      reqEnvelope.transaction_id,
      rrn,
      null,
      "RECEIVED",
      "Payment request received at Switch",
      nowIso
    );

    // HOP 1 (IN): Payer PSP -> Switch (MTI 0200)
    const hop1Envelope: Iso8583MessageEnvelope = {
      ...reqEnvelope,
      rrn,
      payer_psp_id: payerPspId,
      payee_psp_id: payeePspId,
      remitter_bank_id: remitterBankId,
      beneficiary_bank_id: beneficiaryBankId,
    };
    this.logMessageHop({
      transactionId: reqEnvelope.transaction_id,
      rrn,
      direction: "IN",
      fromParticipant: payerPspId,
      toParticipant: "SWITCH",
      envelope: hop1Envelope,
      nowIso,
    });

    // If VPA address resolution failed, transition RECEIVED -> DEBIT_REQUESTED -> FAILED with code 14
    if (!payerDirectory || !payeeDirectory || !payerPsp || !payeePsp) {
      this.transitionState(
        reqEnvelope.transaction_id,
        rrn,
        "DEBIT_REQUESTED",
        "Address resolution check",
        nowIso
      );
      this.transitionState(
        reqEnvelope.transaction_id,
        rrn,
        "FAILED",
        "Unknown VPA (Response Code 14)",
        nowIso,
        "14"
      );
      const failResp = this.buildPspResponse(hop1Envelope, "0210", "14", payerPspId, now);
      this.logMessageHop({
        transactionId: reqEnvelope.transaction_id,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: payerPspId,
        envelope: failResp,
        nowIso,
      });
      return {
        envelope: failResp,
        transaction: this.getTransactionByRrn(rrn)!,
        hops: this.listMessageLogsByRrn(rrn),
      };
    }

    return this.continueFromDebitRequest(
      hop1Envelope,
      payerPsp,
      payeePsp,
      rawPin,
      now
    );
  }

  /**
   * Executes the Remitter Bank Debit leg, Status-Check recovery on timeout,
   * Beneficiary Bank Credit leg, Credit retries, and Reversal (0420) if credit fails.
   */
  private async continueFromDebitRequest(
    baseEnvelope: Iso8583MessageEnvelope,
    payerPsp: PspSimulator,
    payeePsp: PspSimulator,
    rawPin: string,
    now: Date
  ): Promise<{
    envelope: Iso8583MessageEnvelope;
    transaction: SwitchTransactionRecord;
    hops: MessageLogRecord[];
  }> {
    const rrn = baseEnvelope.rrn!;
    const txId = baseEnvelope.transaction_id;
    const payerPspId = baseEnvelope.payer_psp_id!;
    const remitterBankId = baseEnvelope.remitter_bank_id!;
    const beneficiaryBankId = baseEnvelope.beneficiary_bank_id!;

    const remitterBank = this.banks.get(remitterBankId);
    const beneficiaryBank = this.banks.get(beneficiaryBankId);
    const remitterParticipant = this.getParticipant(remitterBankId);

    const currentTx = this.getTransactionByRrn(rrn)!;
    if (currentTx.state === "RECEIVED") {
      this.transitionState(
        txId,
        rrn,
        "DEBIT_REQUESTED",
        `Routing MTI 0200 debit to ${remitterBankId}`,
        now.toISOString()
      );
    }

    const payerInternal = payerPsp.resolveBankAccountInternal(baseEnvelope.payer_vpa)!;
    const payeeInternal = payeePsp.resolveBankAccountInternal(baseEnvelope.payee_vpa!)!;

    // Check if remitter bank is marked DOWN in participant registry
    if (!remitterBank || !remitterParticipant || remitterParticipant.status === "DOWN") {
      this.transitionState(txId, rrn, "FAILED", "Remitter bank DOWN (91)", now.toISOString(), "91");
      const downResp = this.buildPspResponse(baseEnvelope, "0210", "91", payerPspId, now);
      this.logMessageHop({
        transactionId: txId,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: payerPspId,
        envelope: downResp,
        nowIso: now.toISOString(),
      });
      return {
        envelope: downResp,
        transaction: this.getTransactionByRrn(rrn)!,
        hops: this.listMessageLogsByRrn(rrn),
      };
    }

    // HOP 2 (OUT): Switch -> Remitter Bank (POST /debit, MTI 0200)
    const debitReqEnvelope = this.signForBank(
      {
        mti: "0200",
        transaction_id: txId,
        stan: baseEnvelope.stan,
        rrn,
        processing_code: "PAY",
        amount: baseEnvelope.amount,
        currency: baseEnvelope.currency,
        transmission_time: now.toISOString(),
        payer_vpa: baseEnvelope.payer_vpa,
        payee_vpa: baseEnvelope.payee_vpa,
        payer_psp_id: baseEnvelope.payer_psp_id,
        payee_psp_id: baseEnvelope.payee_psp_id,
        remitter_bank_id: remitterBankId,
        beneficiary_bank_id: beneficiaryBankId,
        account_reference: baseEnvelope.account_reference,
      },
      remitterBank.config.sharedSecret
    );

    this.logMessageHop({
      transactionId: txId,
      rrn,
      direction: "OUT",
      fromParticipant: "SWITCH",
      toParticipant: remitterBankId,
      envelope: debitReqEnvelope,
      nowIso: now.toISOString(),
    });

    let debitApproved = false;
    let debitResponseCode: IsoResponseCode = "68";

    try {
      const debitRes = await this.withBankTimeout(
        remitterBank.handleDebit({
          envelope: debitReqEnvelope,
          accountNumber: payerInternal.account_number,
          rawPin,
          now,
        }),
        remitterBankId,
        rrn
      );

      // HOP 3 (IN): Remitter Bank -> Switch (MTI 0210)
      this.logMessageHop({
        transactionId: txId,
        rrn,
        direction: "IN",
        fromParticipant: remitterBankId,
        toParticipant: "SWITCH",
        envelope: debitRes,
        nowIso: now.toISOString(),
      });

      debitResponseCode = debitRes.response_code!;
      if (debitResponseCode === "00") {
        debitApproved = true;
        this.transitionState(
          txId,
          rrn,
          "DEBITED",
          `Remitter bank ${remitterBankId} approved debit (00)`,
          now.toISOString()
        );
      } else {
        this.transitionState(
          txId,
          rrn,
          "FAILED",
          `Remitter bank declined debit (${debitResponseCode})`,
          now.toISOString(),
          debitResponseCode
        );
      }
    } catch (err) {
      // Requirement 7: Remitter bank timed out! Transition DEBIT_REQUESTED -> DEBIT_UNKNOWN
      this.transitionState(
        txId,
        rrn,
        "DEBIT_UNKNOWN",
        `Remitter bank ${remitterBankId} timed out: ${(err as Error).message}`,
        now.toISOString()
      );

      // Send status check (MTI 0100 processing_code CHK on the same RRN)
      const chkReq = this.signForBank(
        {
          mti: "0100",
          transaction_id: txId,
          stan: this.nextSwitchStan(),
          rrn,
          processing_code: "CHK",
          amount: 0,
          currency: baseEnvelope.currency,
          transmission_time: now.toISOString(),
          payer_vpa: baseEnvelope.payer_vpa,
          payee_vpa: baseEnvelope.payee_vpa,
          remitter_bank_id: remitterBankId,
        },
        remitterBank.config.sharedSecret
      );

      this.logMessageHop({
        transactionId: txId,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: remitterBankId,
        envelope: chkReq,
        nowIso: now.toISOString(),
      });

      try {
        const chkRes = await this.withBankTimeout(
          remitterBank.handleStatusCheck({
            envelope: chkReq,
            operation: "DEBIT",
            now,
          }),
          remitterBankId,
          rrn
        );

        this.logMessageHop({
          transactionId: txId,
          rrn,
          direction: "IN",
          fromParticipant: remitterBankId,
          toParticipant: "SWITCH",
          envelope: chkRes.envelope,
          nowIso: now.toISOString(),
        });

        if (chkRes.found && chkRes.original_response_code === "00") {
          debitApproved = true;
          debitResponseCode = "00";
          this.transitionState(
            txId,
            rrn,
            "DEBITED",
            `Status check CHK confirmed debit succeeded at ${remitterBankId}`,
            now.toISOString()
          );
        } else {
          debitResponseCode = "68";
          this.transitionState(
            txId,
            rrn,
            "FAILED",
            `Status check CHK reported no debit at ${remitterBankId} (68 timeout)`,
            now.toISOString(),
            "68"
          );
        }
      } catch {
        debitResponseCode = "68";
        this.transitionState(
          txId,
          rrn,
          "FAILED",
          `Status check CHK also timed out at ${remitterBankId} (68)`,
          now.toISOString(),
          "68"
        );
      }
    }

    // If debit did not succeed, return final response to Payer PSP immediately
    if (!debitApproved) {
      const failEnvelope = this.buildPspResponse(
        baseEnvelope,
        "0210",
        debitResponseCode,
        payerPspId,
        now
      );
      this.logMessageHop({
        transactionId: txId,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: payerPspId,
        envelope: failEnvelope,
        nowIso: now.toISOString(),
      });
      return {
        envelope: failEnvelope,
        transaction: this.getTransactionByRrn(rrn)!,
        hops: this.listMessageLogsByRrn(rrn),
      };
    }

    // Proceed to Beneficiary Credit Leg
    return this.continueFromCreditLeg(
      baseEnvelope,
      remitterBank,
      beneficiaryBank,
      payeeInternal.account_number,
      now
    );
  }

  /**
   * Executes the Beneficiary Credit Leg (`DEBITED -> CREDIT_REQUESTED -> SUCCESS`),
   * or on failure retries through `CREDIT_PENDING` and issues `0420` Reversal (`REVERSAL_REQUESTED -> REVERSED`).
   */
  public async continueFromCreditLeg(
    baseEnvelope: Iso8583MessageEnvelope,
    remitterBank: BankCoreSimulator,
    beneficiaryBank: BankCoreSimulator | undefined,
    beneficiaryAccountNumber: string,
    now: Date
  ): Promise<{
    envelope: Iso8583MessageEnvelope;
    transaction: SwitchTransactionRecord;
    hops: MessageLogRecord[];
  }> {
    const rrn = baseEnvelope.rrn!;
    const txId = baseEnvelope.transaction_id;
    const payerPspId = baseEnvelope.payer_psp_id!;
    const remitterBankId = baseEnvelope.remitter_bank_id!;
    const beneficiaryBankId = baseEnvelope.beneficiary_bank_id!;
    const beneficiaryParticipant = this.getParticipant(beneficiaryBankId);

    const txBeforeCredit = this.getTransactionByRrn(rrn)!;
    if (txBeforeCredit.state === "DEBITED") {
      this.transitionState(
        txId,
        rrn,
        "CREDIT_REQUESTED",
        `Routing MTI 0200 credit to ${beneficiaryBankId}`,
        now.toISOString()
      );
    }

    const attemptCreditOnce = async (): Promise<boolean> => {
      if (
        !beneficiaryBank ||
        !beneficiaryParticipant ||
        beneficiaryParticipant.status === "DOWN"
      ) {
        return false;
      }

      // HOP 4 (OUT): Switch -> Beneficiary Bank (POST /credit, MTI 0200)
      const creditReq = this.signForBank(
        {
          mti: "0200",
          transaction_id: txId,
          stan: baseEnvelope.stan,
          rrn,
          processing_code: "PAY",
          amount: baseEnvelope.amount,
          currency: baseEnvelope.currency,
          transmission_time: now.toISOString(),
          payer_vpa: baseEnvelope.payer_vpa,
          payee_vpa: baseEnvelope.payee_vpa,
          payer_psp_id: baseEnvelope.payer_psp_id,
          payee_psp_id: baseEnvelope.payee_psp_id,
          remitter_bank_id: remitterBankId,
          beneficiary_bank_id: beneficiaryBankId,
        },
        beneficiaryBank.config.sharedSecret
      );

      this.logMessageHop({
        transactionId: txId,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: beneficiaryBankId,
        envelope: creditReq,
        nowIso: now.toISOString(),
      });

      try {
        const creditRes = await this.withBankTimeout(
          beneficiaryBank.handleCredit({
            envelope: creditReq,
            accountNumber: beneficiaryAccountNumber,
            now,
          }),
          beneficiaryBankId,
          rrn
        );

        // HOP 5 (IN): Beneficiary Bank -> Switch (MTI 0210)
        this.logMessageHop({
          transactionId: txId,
          rrn,
          direction: "IN",
          fromParticipant: beneficiaryBankId,
          toParticipant: "SWITCH",
          envelope: creditRes,
          nowIso: now.toISOString(),
        });

        return creditRes.response_code === "00";
      } catch {
        return false;
      }
    };

    let creditSucceeded = await attemptCreditOnce();

    if (!creditSucceeded) {
      // Requirement 8: Credit failure after successful debit -> mark CREDIT_PENDING & retry on schedule
      if (this.getTransactionByRrn(rrn)!.state === "CREDIT_REQUESTED") {
        this.transitionState(
          txId,
          rrn,
          "CREDIT_PENDING",
          `Beneficiary bank ${beneficiaryBankId} failed/down; entering credit retry schedule (DEBIT_SUCCESS_CREDIT_PENDING)`,
          now.toISOString()
        );
      }

      for (let retry = 1; retry <= this.maxCreditRetries; retry++) {
        this.db
          .prepare(
            `UPDATE switch_transactions SET credit_retry_count = ?, updated_at = ? WHERE rrn = ?`
          )
          .run(retry, now.toISOString(), rrn);

        creditSucceeded = await attemptCreditOnce();
        if (creditSucceeded) {
          break;
        }
      }
    }

    if (creditSucceeded) {
      // Requirement 17: Assign settlement_cycle_id using Switch's own clock when reaching SUCCESS
      this.transitionState(
        txId,
        rrn,
        "SUCCESS",
        `Beneficiary bank ${beneficiaryBankId} credited successfully`,
        now.toISOString(),
        "00",
        this.activeCycleId
      );

      // HOP 6 (OUT): Switch -> Payer PSP (MTI 0210, Response Code 00)
      const successResp = this.buildPspResponse(
        baseEnvelope,
        "0210",
        "00",
        payerPspId,
        now
      );
      this.logMessageHop({
        transactionId: txId,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: payerPspId,
        envelope: successResp,
        nowIso: now.toISOString(),
      });

      return {
        envelope: successResp,
        transaction: this.getTransactionByRrn(rrn)!,
        hops: this.listMessageLogsByRrn(rrn),
      };
    }

    // Requirement 8 & Acceptance Test 6: Credit failed through all retries -> issue MTI 0420 Reversal to Remitter Bank!
    this.transitionState(
      txId,
      rrn,
      "REVERSAL_REQUESTED",
      `Credit failed after ${this.maxCreditRetries} retries; issuing MTI 0420 reversal to ${remitterBankId}`,
      now.toISOString()
    );

    const revReq = this.signForBank(
      {
        mti: "0420",
        transaction_id: txId,
        stan: this.nextSwitchStan(),
        rrn,
        processing_code: "REV",
        amount: baseEnvelope.amount,
        currency: baseEnvelope.currency,
        transmission_time: now.toISOString(),
        payer_vpa: baseEnvelope.payer_vpa,
        payee_vpa: baseEnvelope.payee_vpa,
        remitter_bank_id: remitterBankId,
        beneficiary_bank_id: beneficiaryBankId,
      },
      remitterBank.config.sharedSecret
    );

    this.logMessageHop({
      transactionId: txId,
      rrn,
      direction: "OUT",
      fromParticipant: "SWITCH",
      toParticipant: remitterBankId,
      envelope: revReq,
      nowIso: now.toISOString(),
    });

    const revRes = await remitterBank.handleReversal({
      envelope: revReq,
      now,
    });

    this.logMessageHop({
      transactionId: txId,
      rrn,
      direction: "IN",
      fromParticipant: remitterBankId,
      toParticipant: "SWITCH",
      envelope: revRes,
      nowIso: now.toISOString(),
    });

    this.transitionState(
      txId,
      rrn,
      "REVERSED",
      `Remitter bank ${remitterBankId} re-credited payer via MTI 0430`,
      now.toISOString(),
      "91"
    );

    const revPspResp = this.buildPspResponse(
      baseEnvelope,
      "0210",
      "91",
      payerPspId,
      now
    );
    this.logMessageHop({
      transactionId: txId,
      rrn,
      direction: "OUT",
      fromParticipant: "SWITCH",
      toParticipant: payerPspId,
      envelope: revPspResp,
      nowIso: now.toISOString(),
    });

    return {
      envelope: revPspResp,
      transaction: this.getTransactionByRrn(rrn)!,
      hops: this.listMessageLogsByRrn(rrn),
    };
  }

  /**
   * Requirement 9: Deemed-approved handling:
   * When the switch receives a late MTI 0210 with code `00` from the remitter bank AFTER
   * the switch has already timed out (`FAILED` or `REVERSED`), it detects the conflict,
   * keeps the reversal/state, and flags `deemed_approved_conflict = 1` for reconciliation.
   */
  public handleLateRemitterResponse(
    lateEnvelope: Iso8583MessageEnvelope,
    now = new Date()
  ): { conflictDetected: boolean; transaction: SwitchTransactionRecord } {
    if (!lateEnvelope.rrn) {
      throw new Error("Late response must include RRN");
    }
    const tx = this.getTransactionByRrn(lateEnvelope.rrn);
    if (!tx) {
      throw new Error(`Unknown RRN "${lateEnvelope.rrn}"`);
    }

    this.logMessageHop({
      transactionId: tx.transaction_id,
      rrn: tx.rrn,
      direction: "IN",
      fromParticipant: tx.remitter_bank_id,
      toParticipant: "SWITCH",
      envelope: lateEnvelope,
      nowIso: now.toISOString(),
    });

    if (
      lateEnvelope.mti === "0210" &&
      lateEnvelope.response_code === "00" &&
      (tx.state === "FAILED" || tx.state === "REVERSED")
    ) {
      this.db
        .prepare(
          `UPDATE switch_transactions
           SET deemed_approved_conflict = 1, updated_at = ?
           WHERE rrn = ?`
        )
        .run(now.toISOString(), tx.rrn);

      this.audit.record({
        actorId: "SWITCH",
        actorRole: "system",
        action: "DEEMED_APPROVED_CONFLICT_DETECTED",
        entityType: "SwitchTransaction",
        entityId: tx.rrn,
        oldValue: { state: tx.state, deemed_approved_conflict: 0 },
        newValue: {
          state: tx.state,
          deemed_approved_conflict: 1,
          late_response_code: "00",
        },
        requestId: tx.transaction_id,
        nowIso: now.toISOString(),
      });

      return {
        conflictDetected: true,
        transaction: this.getTransactionByRrn(tx.rrn)!,
      };
    }

    return {
      conflictDetected: false,
      transaction: this.getTransactionByRrn(tx.rrn)!,
    };
  }

  /**
   * Non-Functional Requirement 2 & Acceptance Test 7:
   * The switch survives a restart mid-transaction: on start-up it finds transactions in
   * `DEBIT_REQUESTED`, `DEBIT_UNKNOWN`, or `CREDIT_PENDING` and resumes them (status check, retry, or reversal).
   */
  public async resumeInFlightTransactions(now = new Date()): Promise<SwitchTransactionRecord[]> {
    const stuckRows = this.db
      .prepare(
        `SELECT * FROM switch_transactions
         WHERE state IN ('DEBIT_REQUESTED', 'DEBIT_UNKNOWN', 'CREDIT_PENDING')
         ORDER BY created_at ASC`
      )
      .all() as unknown as SwitchTransactionRecord[];

    const resumed: SwitchTransactionRecord[] = [];

    for (const tx of stuckRows) {
      const payerPsp = this.psps.get(tx.payer_psp_id)!;
      const payeePsp = this.psps.get(tx.payee_psp_id!)!;
      const remitterBank = this.banks.get(tx.remitter_bank_id)!;
      const beneficiaryBank = this.banks.get(tx.beneficiary_bank_id!);
      const payeeInternal = payeePsp.resolveBankAccountInternal(tx.payee_vpa!)!;

      const syntheticBaseEnvelope: Iso8583MessageEnvelope = {
        mti: "0200",
        transaction_id: tx.transaction_id,
        stan: tx.stan,
        rrn: tx.rrn,
        processing_code: "PAY",
        amount: tx.amount_paise,
        currency: tx.currency,
        transmission_time: now.toISOString(),
        payer_vpa: tx.payer_vpa,
        payee_vpa: tx.payee_vpa ?? undefined,
        payer_psp_id: tx.payer_psp_id,
        payee_psp_id: tx.payee_psp_id ?? undefined,
        remitter_bank_id: tx.remitter_bank_id,
        beneficiary_bank_id: tx.beneficiary_bank_id ?? undefined,
        signature: "RESUMED",
      };

      if (tx.state === "DEBIT_REQUESTED" || tx.state === "DEBIT_UNKNOWN") {
        if (tx.state === "DEBIT_REQUESTED") {
          this.transitionState(
            tx.transaction_id,
            tx.rrn,
            "DEBIT_UNKNOWN",
            "Switch restarted mid-debit; probing bank status via CHK",
            now.toISOString()
          );
        }

        const chkReq = this.signForBank(
          {
            mti: "0100",
            transaction_id: tx.transaction_id,
            stan: this.nextSwitchStan(),
            rrn: tx.rrn,
            processing_code: "CHK",
            amount: 0,
            currency: tx.currency,
            transmission_time: now.toISOString(),
            payer_vpa: tx.payer_vpa,
            remitter_bank_id: tx.remitter_bank_id,
          },
          remitterBank.config.sharedSecret
        );

        const chkRes = await remitterBank.handleStatusCheck({
          envelope: chkReq,
          operation: "DEBIT",
          now,
        });

        if (chkRes.found && chkRes.original_response_code === "00") {
          this.transitionState(
            tx.transaction_id,
            tx.rrn,
            "DEBITED",
            "Startup CHK confirmed debit succeeded; continuing to credit leg",
            now.toISOString()
          );
          await this.continueFromCreditLeg(
            syntheticBaseEnvelope,
            remitterBank,
            beneficiaryBank,
            payeeInternal.account_number,
            now
          );
        } else {
          this.transitionState(
            tx.transaction_id,
            tx.rrn,
            "FAILED",
            "Startup CHK confirmed no debit at remitter bank (68)",
            now.toISOString(),
            "68"
          );
        }
      } else if (tx.state === "CREDIT_PENDING") {
        await this.continueFromCreditLeg(
          syntheticBaseEnvelope,
          remitterBank,
          beneficiaryBank,
          payeeInternal.account_number,
          now
        );
      }

      resumed.push(this.getTransactionByRrn(tx.rrn)!);
    }

    return resumed;
  }

  /**
   * Requirement 11 & Acceptance Test 10:
   * Balance enquiry (MTI 0100) goes to the payer's own bank, returns available balance,
   * writes NO posting, and shows in the message log.
   */
  public async handleBalanceEnquiry(params: {
    envelope: Iso8583MessageEnvelope;
    rawPin: string;
    now?: Date;
  }): Promise<{
    envelope: Iso8583MessageEnvelope;
    available_balance_paise: number | null;
    hops: MessageLogRecord[];
  }> {
    const now = params.now ?? new Date();
    const rrn = params.envelope.rrn ?? mintRrn(this.nextSwitchStan(), now);
    const payerVpa = params.envelope.payer_vpa.toLowerCase();
    const payerPspId = resolvePspIdFromVpa(payerVpa);
    const payerPsp = this.psps.get(payerPspId);
    const payerInternal = payerPsp?.resolveBankAccountInternal(payerVpa);

    const hop1Env: Iso8583MessageEnvelope = { ...params.envelope, rrn };
    this.logMessageHop({
      transactionId: params.envelope.transaction_id,
      rrn,
      direction: "IN",
      fromParticipant: payerPspId,
      toParticipant: "SWITCH",
      envelope: hop1Env,
      nowIso: now.toISOString(),
    });

    if (!payerPsp || !payerInternal) {
      const failResp = this.buildPspResponse(hop1Env, "0110", "14", payerPspId, now);
      this.logMessageHop({
        transactionId: params.envelope.transaction_id,
        rrn,
        direction: "OUT",
        fromParticipant: "SWITCH",
        toParticipant: payerPspId,
        envelope: failResp,
        nowIso: now.toISOString(),
      });
      return {
        envelope: failResp,
        available_balance_paise: null,
        hops: this.listMessageLogsByRrn(rrn),
      };
    }

    const remitterBank = this.banks.get(payerInternal.bank_id)!;
    const bankReq = this.signForBank(
      {
        mti: "0100",
        transaction_id: params.envelope.transaction_id,
        stan: params.envelope.stan,
        rrn,
        processing_code: "BAL",
        amount: 0,
        currency: INR_CURRENCY_NUMERIC,
        transmission_time: now.toISOString(),
        payer_vpa: payerVpa,
        remitter_bank_id: payerInternal.bank_id,
      },
      remitterBank.config.sharedSecret
    );

    this.logMessageHop({
      transactionId: params.envelope.transaction_id,
      rrn,
      direction: "OUT",
      fromParticipant: "SWITCH",
      toParticipant: payerInternal.bank_id,
      envelope: bankReq,
      nowIso: now.toISOString(),
    });

    const bankRes = await remitterBank.handleBalanceEnquiry({
      envelope: bankReq,
      accountNumber: payerInternal.account_number,
      rawPin: params.rawPin,
      now,
    });

    this.logMessageHop({
      transactionId: params.envelope.transaction_id,
      rrn,
      direction: "IN",
      fromParticipant: payerInternal.bank_id,
      toParticipant: "SWITCH",
      envelope: bankRes.envelope,
      nowIso: now.toISOString(),
    });

    const pspResp = this.buildPspResponse(
      hop1Env,
      "0110",
      bankRes.envelope.response_code!,
      payerPspId,
      now
    );
    this.logMessageHop({
      transactionId: params.envelope.transaction_id,
      rrn,
      direction: "OUT",
      fromParticipant: "SWITCH",
      toParticipant: payerPspId,
      envelope: pspResp,
      nowIso: now.toISOString(),
    });

    return {
      envelope: pspResp,
      available_balance_paise: bankRes.available_balance_paise,
      hops: this.listMessageLogsByRrn(rrn),
    };
  }

  /**
   * Requirement 12 & Interface `GET /transactions/{rrn}`:
   * Any participant can ask the switch for the current state of a transaction by RRN or transaction_id.
   */
  public getTransactionByRrn(rrn: string): SwitchTransactionRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM switch_transactions WHERE rrn = ?`)
      .get(rrn) as unknown as SwitchTransactionRecord | undefined;
  }

  public getTransactionById(transactionId: string): SwitchTransactionRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM switch_transactions WHERE transaction_id = ?`)
      .get(transactionId) as unknown as SwitchTransactionRecord | undefined;
  }

  public listMessageLogsByRrn(rrn: string): MessageLogRecord[] {
    return this.db
      .prepare(`SELECT * FROM message_logs WHERE rrn = ? ORDER BY hop_number ASC`)
      .all(rrn) as unknown as MessageLogRecord[];
  }

  public listStateHistoryByRrn(rrn: string): StateHistoryRecord[] {
    return this.db
      .prepare(
        `SELECT * FROM transaction_state_history WHERE rrn = ? ORDER BY created_at ASC, rowid ASC`
      )
      .all(rrn) as unknown as StateHistoryRecord[];
  }

  private transitionState(
    transactionId: string,
    rrn: string,
    toState: SwitchTransactionState,
    reason: string,
    nowIso: string,
    responseCode?: IsoResponseCode,
    settlementCycleId?: string
  ): void {
    const current = this.getTransactionByRrn(rrn);
    if (!current) {
      throw new Error(`Transaction RRN "${rrn}" not found`);
    }
    assertValidTransition(
      "SwitchTransaction",
      SWITCH_TRANSACTION_TRANSITIONS,
      current.state,
      toState
    );

    this.db
      .prepare(
        `UPDATE switch_transactions
         SET state = ?,
             response_code = COALESCE(?, response_code),
             settlement_cycle_id = COALESCE(?, settlement_cycle_id),
             updated_at = ?
         WHERE rrn = ?`
      )
      .run(
        toState,
        responseCode ?? null,
        settlementCycleId ?? null,
        nowIso,
        rrn
      );

    this.recordStateChange(
      transactionId,
      rrn,
      current.state,
      toState,
      reason,
      nowIso
    );
  }

  private recordStateChange(
    transactionId: string,
    rrn: string,
    fromState: string | null,
    toState: SwitchTransactionState,
    reason: string,
    nowIso: string
  ): void {
    this.db
      .prepare(
        `INSERT INTO transaction_state_history (
          id, transaction_id, rrn, from_state, to_state, reason, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `STH-${crypto.randomUUID()}`,
        transactionId,
        rrn,
        fromState,
        toState,
        reason,
        nowIso
      );
  }

  private logMessageHop(params: {
    transactionId: string;
    rrn: string;
    direction: "IN" | "OUT";
    fromParticipant: string;
    toParticipant: string;
    envelope: Iso8583MessageEnvelope;
    nowIso: string;
  }): MessageLogRecord {
    const countRow = this.db
      .prepare(`SELECT COUNT(*) AS cnt FROM message_logs WHERE rrn = ?`)
      .get(params.rrn) as { cnt: number };
    const hopNumber = countRow.cnt + 1;

    const record: MessageLogRecord = {
      id: `MSG-${crypto.randomUUID()}`,
      transaction_id: params.transactionId,
      rrn: params.rrn,
      hop_number: hopNumber,
      direction: params.direction,
      from_participant: params.fromParticipant,
      to_participant: params.toParticipant,
      mti: params.envelope.mti,
      processing_code: params.envelope.processing_code,
      body_json: JSON.stringify(params.envelope),
      response_code: params.envelope.response_code ?? null,
      sent_at: params.envelope.transmission_time,
      received_at: params.nowIso,
    };

    this.db
      .prepare(
        `INSERT INTO message_logs (
          id, transaction_id, rrn, hop_number, direction,
          from_participant, to_participant, mti, processing_code,
          body_json, response_code, sent_at, received_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        record.id,
        record.transaction_id,
        record.rrn,
        record.hop_number,
        record.direction,
        record.from_participant,
        record.to_participant,
        record.mti,
        record.processing_code,
        record.body_json,
        record.response_code,
        record.sent_at,
        record.received_at
      );

    return record;
  }

  private signForBank(
    unsigned: Omit<Iso8583MessageEnvelope, "signature">,
    bankSecret: string
  ): Iso8583MessageEnvelope {
    const rawBody = JSON.stringify(unsigned);
    const signature = signServiceMessage(
      rawBody,
      unsigned.transmission_time,
      bankSecret
    );
    return { ...unsigned, signature };
  }

  private buildPspResponse(
    req: Iso8583MessageEnvelope,
    responseMti: "0210" | "0110",
    responseCode: IsoResponseCode,
    payerPspId: string,
    now: Date
  ): Iso8583MessageEnvelope {
    const pspParticipant = this.getParticipant(payerPspId);
    const secret = pspParticipant?.secret ?? "fallback_switch_secret";
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
      account_reference: req.account_reference,
      response_code: responseCode,
    };
    const signature = signServiceMessage(
      JSON.stringify(unsigned),
      unsigned.transmission_time,
      secret
    );
    return { ...unsigned, signature };
  }

  private async withBankTimeout<T>(
    promise: Promise<T>,
    bankId: string,
    rrn: string
  ): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new BankTimeoutSimulatedError(
            bankId,
            rrn,
            `Exceeded switch bankTimeoutMs (${this.bankTimeoutMs}ms)`
          )
        );
      }, this.bankTimeoutMs);
    });

    try {
      return await Promise.race([promise, timeoutPromise]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }
}
