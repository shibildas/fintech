import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { AuditLogger, assertPositivePaise, MandateAggregateCapChecker } from "@fintech/core";

/**
 * Project 4 (Day 22) — RBI Mandate Service (UPI AutoPay & e-NACH)
 *
 * - Supports `UPI_AUTOPAY` (synchronous PIN authorization) and `E_NACH` (bank OTP registration).
 * - Mints a globally unique 20-char `UMRN` (Unique Mandate Reference Number) on authorization.
 * - Enforces per-debit `max_amount_paise` AND `monthly_aggregate_cap_paise`.
 * - Cap decreases apply immediately; cap INCREASES move mandate to `PENDING_REAUTH` until
 *   explicit customer PIN/OTP re-authorization!
 * - Immediate `PAUSE` / `RESUME` / `REVOKE` propagation with halt hooks for linked subscriptions.
 */

export type MandateRail = "UPI_AUTOPAY" | "E_NACH";

export type MandateState =
  "CREATED" | "ACTIVE" | "PENDING_REAUTH" | "PAUSED" | "REVOKED" | "EXPIRED";

export interface MandateRecord {
  id: string;
  umrn: string | null;
  merchant_id: string;
  customer_id: string;
  payer_vpa: string | null;
  bank_id: string;
  account_number_masked: string;
  rail: MandateRail;
  max_amount_paise: number;
  monthly_aggregate_cap_paise: number;
  pending_max_amount_paise: number | null;
  pending_monthly_cap_paise: number | null;
  state: MandateState;
  valid_until: string;
  created_at: string;
  updated_at: string;
}

export type MandateStateChangeHook = (event: {
  mandateId: string;
  umrn: string | null;
  newState: MandateState;
  reason: string;
  timestampIso: string;
}) => void;

export class MandateService {
  public readonly db: DatabaseSync;
  public readonly audit: AuditLogger;
  public readonly aggregateCapChecker = new MandateAggregateCapChecker();
  private readonly stateChangeHooks: MandateStateChangeHook[] = [];

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.audit = new AuditLogger(this.db);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS mandates (
        id TEXT PRIMARY KEY,
        umrn TEXT UNIQUE,
        merchant_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        payer_vpa TEXT,
        bank_id TEXT NOT NULL,
        account_number_masked TEXT NOT NULL,
        rail TEXT NOT NULL CHECK (rail IN ('UPI_AUTOPAY', 'E_NACH')),
        max_amount_paise INTEGER NOT NULL CHECK (max_amount_paise > 0),
        monthly_aggregate_cap_paise INTEGER NOT NULL CHECK (monthly_aggregate_cap_paise > 0),
        pending_max_amount_paise INTEGER,
        pending_monthly_cap_paise INTEGER,
        state TEXT NOT NULL CHECK (state IN ('CREATED', 'ACTIVE', 'PENDING_REAUTH', 'PAUSED', 'REVOKED', 'EXPIRED')),
        valid_until TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public onMandateStateChange(hook: MandateStateChangeHook): void {
    this.stateChangeHooks.push(hook);
  }

  public createMandate(params: {
    merchantId: string;
    customerId: string;
    payerVpa?: string | null;
    bankId: string;
    accountNumberMasked: string;
    rail: MandateRail;
    maxAmountPaise: number;
    monthlyAggregateCapPaise: number;
    validUntilIso: string;
    now?: Date;
  }): MandateRecord {
    assertPositivePaise(params.maxAmountPaise, "maxAmountPaise");
    assertPositivePaise(params.monthlyAggregateCapPaise, "monthlyAggregateCapPaise");
    if (params.monthlyAggregateCapPaise < params.maxAmountPaise) {
      throw new Error("monthlyAggregateCapPaise must be >= maxAmountPaise");
    }

    const id = `mnd_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = (params.now ?? new Date()).toISOString();

    this.db
      .prepare(
        `INSERT INTO mandates (
          id, umrn, merchant_id, customer_id, payer_vpa, bank_id, account_number_masked,
          rail, max_amount_paise, monthly_aggregate_cap_paise,
          pending_max_amount_paise, pending_monthly_cap_paise,
          state, valid_until, created_at, updated_at
        ) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 'CREATED', ?, ?, ?)`
      )
      .run(
        id,
        params.merchantId,
        params.customerId,
        params.payerVpa ?? null,
        params.bankId,
        params.accountNumberMasked,
        params.rail,
        params.maxAmountPaise,
        params.monthlyAggregateCapPaise,
        params.validUntilIso,
        nowIso,
        nowIso
      );

    return this.getMandate(id)!;
  }

  /**
   * Authorizes a `CREATED` mandate via UPI PIN (AutoPay) or Bank OTP (e-NACH)
   * and mints a 20-character globally unique UMRN (`UMRN...`).
   */
  public authorizeMandate(params: {
    mandateId: string;
    authCredential: string; // PIN for UPI_AUTOPAY, OTP for E_NACH
    expectedCredential?: string;
    now?: Date;
  }): MandateRecord {
    const m = this.getMandate(params.mandateId);
    if (!m) {
      throw new Error(`Mandate "${params.mandateId}" not found`);
    }
    if (m.state !== "CREATED") {
      throw Object.assign(new Error(`Mandate "${m.id}" is in state "${m.state}"`), {
        statusCode: 409,
      });
    }

    const expected = params.expectedCredential ?? (m.rail === "UPI_AUTOPAY" ? "1234" : "654321");
    if (params.authCredential !== expected) {
      throw Object.assign(new Error("Mandate authorization credential rejected"), {
        statusCode: 401,
      });
    }

    const nowIso = (params.now ?? new Date()).toISOString();
    const umrn = `UMRN${m.bank_id.slice(0, 4).toUpperCase()}${crypto
      .randomBytes(6)
      .toString("hex")
      .toUpperCase()}`;

    this.db
      .prepare(`UPDATE mandates SET umrn = ?, state = 'ACTIVE', updated_at = ? WHERE id = ?`)
      .run(umrn, nowIso, m.id);

    this.audit.record({
      actorId: m.customer_id,
      actorRole: "customer",
      action: "MANDATE_AUTHORIZED",
      entityType: "Mandate",
      entityId: m.id,
      newValue: { umrn, rail: m.rail, max_amount_paise: m.max_amount_paise },
      requestId: `REQ-AUTH-${m.id}`,
      nowIso,
    });

    return this.getMandate(m.id)!;
  }

  /**
   * Modifies mandate caps:
   * - Decreasing caps takes effect immediately.
   * - Increasing EITHER `maxAmountPaise` or `monthlyAggregateCapPaise` moves the mandate to
   *   `PENDING_REAUTH` and requires explicit `confirmCapIncreaseReauth()` from the customer!
   */
  public requestCapModification(params: {
    mandateId: string;
    newMaxAmountPaise: number;
    newMonthlyAggregateCapPaise: number;
    now?: Date;
  }): { mandate: MandateRecord; requiresCustomerReauth: boolean } {
    assertPositivePaise(params.newMaxAmountPaise, "newMaxAmountPaise");
    assertPositivePaise(params.newMonthlyAggregateCapPaise, "newMonthlyAggregateCapPaise");

    const m = this.getMandate(params.mandateId);
    if (!m || m.state !== "ACTIVE") {
      throw Object.assign(new Error(`Active mandate "${params.mandateId}" not found`), {
        statusCode: 409,
      });
    }

    const nowIso = (params.now ?? new Date()).toISOString();
    const isIncrease =
      params.newMaxAmountPaise > m.max_amount_paise ||
      params.newMonthlyAggregateCapPaise > m.monthly_aggregate_cap_paise;

    if (!isIncrease) {
      this.db
        .prepare(
          `UPDATE mandates
           SET max_amount_paise = ?, monthly_aggregate_cap_paise = ?, updated_at = ?
           WHERE id = ?`
        )
        .run(params.newMaxAmountPaise, params.newMonthlyAggregateCapPaise, nowIso, m.id);
      return { mandate: this.getMandate(m.id)!, requiresCustomerReauth: false };
    }

    this.db
      .prepare(
        `UPDATE mandates
         SET pending_max_amount_paise = ?, pending_monthly_cap_paise = ?,
             state = 'PENDING_REAUTH', updated_at = ?
         WHERE id = ?`
      )
      .run(params.newMaxAmountPaise, params.newMonthlyAggregateCapPaise, nowIso, m.id);

    return { mandate: this.getMandate(m.id)!, requiresCustomerReauth: true };
  }

  public confirmCapIncreaseReauth(params: {
    mandateId: string;
    authCredential: string;
    expectedCredential?: string;
    now?: Date;
  }): MandateRecord {
    const m = this.getMandate(params.mandateId);
    if (!m || m.state !== "PENDING_REAUTH") {
      throw Object.assign(new Error(`Mandate "${params.mandateId}" is not PENDING_REAUTH`), {
        statusCode: 409,
      });
    }
    const expected = params.expectedCredential ?? (m.rail === "UPI_AUTOPAY" ? "1234" : "654321");
    if (params.authCredential !== expected) {
      throw Object.assign(new Error("Invalid re-authorization credential"), { statusCode: 401 });
    }

    const nowIso = (params.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `UPDATE mandates
         SET max_amount_paise = pending_max_amount_paise,
             monthly_aggregate_cap_paise = pending_monthly_cap_paise,
             pending_max_amount_paise = NULL,
             pending_monthly_cap_paise = NULL,
             state = 'ACTIVE',
             updated_at = ?
         WHERE id = ?`
      )
      .run(nowIso, m.id);

    this.audit.record({
      actorId: m.customer_id,
      actorRole: "customer",
      action: "MANDATE_CAP_REAUTHORIZED",
      entityType: "Mandate",
      entityId: m.id,
      oldValue: {
        max_amount_paise: m.max_amount_paise,
        monthly_aggregate_cap_paise: m.monthly_aggregate_cap_paise,
      },
      newValue: {
        max_amount_paise: m.pending_max_amount_paise,
        monthly_aggregate_cap_paise: m.pending_monthly_cap_paise,
      },
      requestId: `REQ-REAUTH-${m.id}`,
      nowIso,
    });

    return this.getMandate(m.id)!;
  }

  /**
   * Validates whether a recurring debit of `amountPaise` is permitted under the mandate's
   * state, validity date, per-debit cap, and monthly aggregate cap.
   */
  public validateAndReserveDebitCap(params: {
    mandateId: string;
    amountPaise: number;
    now?: Date;
  }): MandateRecord {
    const now = params.now ?? new Date();
    const m = this.getMandate(params.mandateId);
    if (!m) {
      throw new Error(`Mandate "${params.mandateId}" not found`);
    }
    if (m.state !== "ACTIVE" || !m.umrn) {
      throw Object.assign(new Error(`Mandate "${m.id}" is "${m.state}" — debit rejected`), {
        statusCode: 403,
      });
    }
    if (now.getTime() > Date.parse(m.valid_until)) {
      this.db
        .prepare(`UPDATE mandates SET state = 'EXPIRED', updated_at = ? WHERE id = ?`)
        .run(now.toISOString(), m.id);
      throw Object.assign(new Error(`Mandate "${m.id}" has expired`), { statusCode: 410 });
    }
    if (params.amountPaise > m.max_amount_paise) {
      throw Object.assign(
        new Error(
          `Debit ${params.amountPaise} exceeds mandate per-debit cap ${m.max_amount_paise}`
        ),
        { statusCode: 403 }
      );
    }

    const monthKey = now.toISOString().slice(0, 7);
    const aggCheck = this.aggregateCapChecker.canDebitWithinMonthlyCap({
      umrn: m.umrn,
      monthKey,
      amountPaise: params.amountPaise,
      monthlyCapPaise: m.monthly_aggregate_cap_paise,
    });
    if (!aggCheck.allowed) {
      throw Object.assign(
        new Error(
          `Monthly aggregate cap exceeded for ${m.umrn}: projected ${aggCheck.projectedPaise} > ${m.monthly_aggregate_cap_paise}`
        ),
        { statusCode: 403 }
      );
    }

    this.aggregateCapChecker.recordMonthlyDebit(m.umrn, monthKey, params.amountPaise);
    return m;
  }

  public pauseMandate(
    mandateId: string,
    reason = "Customer paused",
    now = new Date()
  ): MandateRecord {
    return this.updateLifecycleState(mandateId, "PAUSED", reason, now);
  }

  public resumeMandate(mandateId: string, now = new Date()): MandateRecord {
    const m = this.getMandate(mandateId);
    if (!m || m.state !== "PAUSED") {
      throw Object.assign(new Error(`Mandate "${mandateId}" is not PAUSED`), { statusCode: 409 });
    }
    return this.updateLifecycleState(mandateId, "ACTIVE", "Customer resumed", now);
  }

  public revokeMandate(
    mandateId: string,
    reason = "Customer revoked",
    now = new Date()
  ): MandateRecord {
    return this.updateLifecycleState(mandateId, "REVOKED", reason, now);
  }

  private updateLifecycleState(
    mandateId: string,
    newState: MandateState,
    reason: string,
    now: Date
  ): MandateRecord {
    const m = this.getMandate(mandateId);
    if (!m) {
      throw new Error(`Mandate "${mandateId}" not found`);
    }
    if (m.state === "REVOKED") {
      throw Object.assign(new Error("Revoked mandate cannot be reactivated"), { statusCode: 409 });
    }
    const nowIso = now.toISOString();
    this.db
      .prepare(`UPDATE mandates SET state = ?, updated_at = ? WHERE id = ?`)
      .run(newState, nowIso, mandateId);

    this.audit.record({
      actorId: m.customer_id,
      actorRole: "customer",
      action: `MANDATE_${newState}`,
      entityType: "Mandate",
      entityId: m.id,
      oldValue: { state: m.state },
      newValue: { state: newState, reason },
      requestId: `REQ-${newState}-${m.id}`,
      nowIso,
    });

    for (const hook of this.stateChangeHooks) {
      hook({ mandateId: m.id, umrn: m.umrn, newState, reason, timestampIso: nowIso });
    }

    return this.getMandate(mandateId)!;
  }

  public getMandate(mandateId: string): MandateRecord | undefined {
    return this.db.prepare(`SELECT * FROM mandates WHERE id = ?`).get(mandateId) as unknown as
      MandateRecord | undefined;
  }
}
