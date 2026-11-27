import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLogger,
  IdempotencyStore,
  SingleFlightIdempotencyCache,
  canonicalJsonHash,
  assertPositivePaise,
  splitMdrAndGst,
  computeBasisPointsPaise,
  signServiceMessage,
  verifyServiceMessage,
  assertValidTransition,
  GATEWAY_PAYMENT_TRANSITIONS,
  INR_CURRENCY_NUMERIC,
  redactSensitiveData,
  type GatewayPaymentState,
} from "../../../packages/core/src/index.ts";
import type { CentralSwitch, PspSimulator } from "../../project1-switch/src/index.ts";
import { TokenVaultService } from "./token-vault.ts";
import { AcquirerSimulator, type PaymentMethod } from "./acquirer-simulator.ts";
import { AcquirerRoutingEngine } from "./routing-engine.ts";
import { WebhookDeliveryWorker } from "./webhook-worker.ts";

/**
 * Project 2 — Gateway Orchestration, Merchant Ledger, Refunds & Payouts Engine
 * (Requirements 1–29, Pages 13–17)
 */

export type MerchantOnboardingState = "CREATED" | "UNDER_REVIEW" | "ACTIVE" | "REJECTED";

export type CaptureMode = "AUTO" | "MANUAL";

export interface MdrPlanConfig {
  cardBps: number; // e.g., 200 = 2.00%
  upiBps: number; // e.g., 0 or 30 = 0.30%
  netbankingBps: number; // e.g., 150 = 1.50%
  walletBps: number; // e.g., 180 = 1.80%
  gstBps: number; // 1800 = 18.00% GST on MDR fee
  returnFeeOnRefund: boolean; // Req 24 per-plan setting
}

export interface MerchantRecord {
  id: string;
  business_name: string;
  contact_email: string;
  state: MerchantOnboardingState;
  settlement_account_number: string;
  settlement_branch_code: string;
  settlement_holder_name: string;
  mdr_plan: MdrPlanConfig;
  capture_mode: CaptureMode;
  return_url: string;
  rolling_reserve_bps: number; // Req 26: percentage held for N days
  rolling_reserve_days: number;
  hold_paise: number;
  created_at: string;
}

export interface ApiKeyRecord {
  key_id: string;
  merchant_id: string;
  mode: "TEST" | "LIVE";
  active_secret: string;
  previous_secret: string | null;
  previous_secret_expires_at: string | null;
  created_at: string;
  rotated_at: string | null;
}

export interface OrderRecord {
  id: string;
  merchant_id: string;
  mode: "TEST" | "LIVE";
  merchant_order_id: string;
  amount_paise: number;
  currency: string;
  customer_reference: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  notes: string | null;
  state: "CREATED" | "PAID" | "EXPIRED";
  checkout_url: string;
  expires_at: string;
  created_at: string;
}

export interface PaymentRecord {
  id: string;
  order_id: string;
  merchant_id: string;
  method: PaymentMethod;
  amount_paise: number;
  refunded_amount_paise: number;
  state: GatewayPaymentState;
  token_id: string | null;
  acquirer_id: string | null;
  acquirer_reference: string | null;
  upi_switch_rrn: string | null;
  created_at: string;
  updated_at: string;
}

export interface PaymentAttemptRecord {
  id: string;
  payment_id: string;
  order_id: string;
  attempt_number: number;
  method: PaymentMethod;
  acquirer_id: string;
  routing_reason: string;
  state: "SUCCEEDED" | "FAILED";
  acquirer_response_code: string;
  token_id: string | null;
  latency_ms: number;
  created_at: string;
}

export interface RefundRecord {
  id: string;
  payment_id: string;
  order_id: string;
  merchant_id: string;
  amount_paise: number;
  state: "CREATED" | "PROCESSED" | "FAILED";
  idempotency_key: string;
  acquirer_reference: string | null;
  created_at: string;
}

export type GatewayLedgerAccountType =
  | "MERCHANT_RECEIVABLE"
  | "MERCHANT_PAYABLE"
  | "MERCHANT_RESERVE"
  | "GATEWAY_REVENUE"
  | "GATEWAY_TAX_GST"
  | "SETTLEMENT_BANK";

export interface GatewayLedgerPosting {
  id: string;
  journal_id: string;
  merchant_id: string;
  account_type: GatewayLedgerAccountType;
  direction: "DEBIT" | "CREDIT";
  amount_paise: number;
  reference_type: "PAYMENT" | "REFUND" | "PAYOUT" | "RESERVE_RELEASE";
  reference_id: string;
  created_at: string;
}

export interface MerchantSettlementRecord {
  id: string;
  merchant_id: string;
  period_label: string;
  gross_paise: number;
  fees_paise: number;
  tax_paise: number;
  net_paise: number;
  state: "PROCESSED";
  report_csv: string;
  created_at: string;
}

export class PaymentGatewayEngine {
  public readonly gatewayDb: DatabaseSync;
  public readonly audit: AuditLogger;
  public readonly idempotencyStore: IdempotencyStore;
  public readonly vault: TokenVaultService;
  public readonly routing: AcquirerRoutingEngine;
  public readonly webhooks: WebhookDeliveryWorker;

  private readonly orderSingleFlight = new SingleFlightIdempotencyCache<OrderRecord>(
    10_000,
    10 * 60 * 1000
  );
  private readonly refundSingleFlight = new SingleFlightIdempotencyCache<RefundRecord>(
    10_000,
    10 * 60 * 1000
  );

  private readonly adapterCredential: string;
  private readonly upiSwitch?: CentralSwitch;
  private readonly upiPsp?: PspSimulator;
  private readonly merchantUpiVpa: string;

  public readonly structuredLogs: Array<Record<string, unknown>> = [];
  public readonly duplicatePaymentAlerts: Array<{
    order_id: string;
    duplicate_payment_id: string;
    auto_refund_id: string;
    created_at: string;
  }> = [];

  constructor(params?: {
    gatewayDbPath?: string;
    vault?: TokenVaultService;
    adapterCredential?: string;
    upiSwitch?: CentralSwitch;
    upiPsp?: PspSimulator;
    merchantUpiVpa?: string;
  }) {
    this.gatewayDb = new DatabaseSync(params?.gatewayDbPath ?? ":memory:");
    this.audit = new AuditLogger(this.gatewayDb);
    this.idempotencyStore = new IdempotencyStore(this.gatewayDb);
    this.adapterCredential = params?.adapterCredential ?? "INTERNAL_ACQUIRER_ADAPTER_SECRET_KEY";
    this.vault =
      params?.vault ?? new TokenVaultService({ adapterCredential: this.adapterCredential });
    this.routing = new AcquirerRoutingEngine(this.gatewayDb, this.audit);
    this.webhooks = new WebhookDeliveryWorker(this.gatewayDb);
    this.upiSwitch = params?.upiSwitch;
    this.upiPsp = params?.upiPsp;
    this.merchantUpiVpa = params?.merchantUpiVpa ?? "shop@psp2";

    this.initSchema();
  }

  private initSchema(): void {
    this.gatewayDb.exec(`
      CREATE TABLE IF NOT EXISTS merchants (
        id TEXT PRIMARY KEY,
        business_name TEXT NOT NULL,
        contact_email TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('CREATED', 'UNDER_REVIEW', 'ACTIVE', 'REJECTED')),
        settlement_account_number TEXT NOT NULL,
        settlement_branch_code TEXT NOT NULL,
        settlement_holder_name TEXT NOT NULL,
        mdr_plan_json TEXT NOT NULL,
        capture_mode TEXT NOT NULL DEFAULT 'AUTO' CHECK (capture_mode IN ('AUTO', 'MANUAL')),
        return_url TEXT NOT NULL,
        rolling_reserve_bps INTEGER NOT NULL DEFAULT 0,
        rolling_reserve_days INTEGER NOT NULL DEFAULT 0,
        hold_paise INTEGER NOT NULL DEFAULT 0,
        dashboard_cached_payable_paise INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS api_keys (
        key_id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('TEST', 'LIVE')),
        active_secret TEXT NOT NULL,
        previous_secret TEXT,
        previous_secret_expires_at TEXT,
        created_at TEXT NOT NULL,
        rotated_at TEXT,
        UNIQUE (merchant_id, mode)
      );

      CREATE TABLE IF NOT EXISTS orders (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('TEST', 'LIVE')),
        merchant_order_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        currency TEXT NOT NULL,
        customer_reference TEXT,
        customer_email TEXT,
        customer_phone TEXT,
        notes TEXT,
        state TEXT NOT NULL CHECK (state IN ('CREATED', 'PAID', 'EXPIRED')),
        checkout_url TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payments (
        id TEXT PRIMARY KEY,
        order_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        method TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        refunded_amount_paise INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL,
        token_id TEXT,
        acquirer_id TEXT,
        acquirer_reference TEXT,
        upi_switch_rrn TEXT,
        settled_in_payout_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS payment_attempts (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL,
        method TEXT NOT NULL,
        acquirer_id TEXT NOT NULL,
        routing_reason TEXT NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('SUCCEEDED', 'FAILED')),
        acquirer_response_code TEXT NOT NULL,
        token_id TEXT,
        latency_ms INTEGER NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS refunds (
        id TEXT PRIMARY KEY,
        payment_id TEXT NOT NULL,
        order_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        state TEXT NOT NULL CHECK (state IN ('CREATED', 'PROCESSED', 'FAILED')),
        idempotency_key TEXT NOT NULL,
        acquirer_reference TEXT,
        settled_in_payout_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS gateway_ledger_postings (
        id TEXT PRIMARY KEY,
        journal_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        account_type TEXT NOT NULL,
        direction TEXT NOT NULL CHECK (direction IN ('DEBIT', 'CREDIT')),
        amount_paise INTEGER NOT NULL CHECK (amount_paise > 0),
        reference_type TEXT NOT NULL,
        reference_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      -- Rule 3: Append-only ledger postings!
      CREATE TRIGGER IF NOT EXISTS trg_gw_ledger_no_update
      BEFORE UPDATE ON gateway_ledger_postings
      BEGIN
        SELECT RAISE(ABORT, 'Rule 3 Violation: gateway_ledger_postings are append-only');
      END;

      CREATE TRIGGER IF NOT EXISTS trg_gw_ledger_no_delete
      BEFORE DELETE ON gateway_ledger_postings
      BEGIN
        SELECT RAISE(ABORT, 'Rule 3 Violation: gateway_ledger_postings cannot be deleted');
      END;

      CREATE TABLE IF NOT EXISTS merchant_settlements (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        period_label TEXT NOT NULL,
        gross_paise INTEGER NOT NULL,
        fees_paise INTEGER NOT NULL,
        tax_paise INTEGER NOT NULL,
        net_paise INTEGER NOT NULL,
        state TEXT NOT NULL,
        report_csv TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  /**
   * Requirements 1 & 2: Merchant Onboarding & Initial API Keys (TEST & LIVE).
   * Onboarding states: `CREATED -> UNDER_REVIEW -> ACTIVE | REJECTED`.
   */
  public onboardMerchant(params: {
    businessName: string;
    contactEmail: string;
    settlementAccountNumber: string;
    settlementBranchCode: string;
    settlementHolderName: string;
    mdrPlan?: Partial<MdrPlanConfig>;
    captureMode?: CaptureMode;
    returnUrl: string;
    now?: Date;
  }): {
    merchant: MerchantRecord;
    testKey: { keyId: string; secret: string };
    liveKey: { keyId: string; secret: string };
  } {
    const nowIso = (params.now ?? new Date()).toISOString();
    const merchantId = `merch_${crypto.randomUUID().slice(0, 8)}`;

    const mdrPlan: MdrPlanConfig = {
      cardBps: params.mdrPlan?.cardBps ?? 200, // 2.00%
      upiBps: params.mdrPlan?.upiBps ?? 0, // 0.00%
      netbankingBps: params.mdrPlan?.netbankingBps ?? 150, // 1.50%
      walletBps: params.mdrPlan?.walletBps ?? 180, // 1.80%
      gstBps: params.mdrPlan?.gstBps ?? 1800, // 18.00% GST on MDR fee
      returnFeeOnRefund: params.mdrPlan?.returnFeeOnRefund ?? false,
    };

    this.gatewayDb
      .prepare(
        `INSERT INTO merchants (
          id, business_name, contact_email, state,
          settlement_account_number, settlement_branch_code, settlement_holder_name,
          mdr_plan_json, capture_mode, return_url, created_at
        ) VALUES (?, ?, ?, 'CREATED', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        merchantId,
        params.businessName,
        params.contactEmail,
        params.settlementAccountNumber,
        params.settlementBranchCode,
        params.settlementHolderName,
        JSON.stringify(mdrPlan),
        params.captureMode ?? "AUTO",
        params.returnUrl,
        nowIso
      );

    const testKeyId = `rzp_test_${merchantId}`;
    const testSecret = `sec_test_${crypto.randomBytes(16).toString("hex")}`;
    const liveKeyId = `rzp_live_${merchantId}`;
    const liveSecret = `sec_live_${crypto.randomBytes(16).toString("hex")}`;

    const insertKeyStmt = this.gatewayDb.prepare(`
      INSERT INTO api_keys (
        key_id, merchant_id, mode, active_secret,
        previous_secret, previous_secret_expires_at, created_at
      ) VALUES (?, ?, ?, ?, NULL, NULL, ?)
    `);

    insertKeyStmt.run(testKeyId, merchantId, "TEST", testSecret, nowIso);
    insertKeyStmt.run(liveKeyId, merchantId, "LIVE", liveSecret, nowIso);

    return {
      merchant: this.getMerchant(merchantId)!,
      testKey: { keyId: testKeyId, secret: testSecret },
      liveKey: { keyId: liveKeyId, secret: liveSecret },
    };
  }

  public transitionMerchantOnboarding(params: {
    merchantId: string;
    toState: MerchantOnboardingState;
    actorId?: string;
    now?: Date;
  }): MerchantRecord {
    const m = this.getMerchant(params.merchantId);
    if (!m) {
      throw new Error(`Merchant "${params.merchantId}" not found`);
    }

    const allowed: Record<MerchantOnboardingState, MerchantOnboardingState[]> = {
      CREATED: ["UNDER_REVIEW"],
      UNDER_REVIEW: ["ACTIVE", "REJECTED"],
      ACTIVE: [],
      REJECTED: [],
    };
    if (!allowed[m.state].includes(params.toState)) {
      throw new Error(
        `Invalid merchant onboarding transition from "${m.state}" to "${params.toState}"`
      );
    }

    this.gatewayDb
      .prepare(`UPDATE merchants SET state = ? WHERE id = ?`)
      .run(params.toState, params.merchantId);

    this.audit.record({
      actorId: params.actorId ?? "gateway-operator",
      actorRole: "operator",
      action: "MERCHANT_ONBOARDING_TRANSITION",
      entityType: "Merchant",
      entityId: params.merchantId,
      oldValue: { state: m.state },
      newValue: { state: params.toState },
      requestId: `REQ-ONBOARD-${params.merchantId}`,
      nowIso: (params.now ?? new Date()).toISOString(),
    });

    return this.getMerchant(params.merchantId)!;
  }

  /**
   * Requirement 2 & Acceptance Test 10:
   * Rotates a merchant's API key secret with an overlap window (`overlapWindowMs`)
   * during which BOTH the new secret and the old secret authenticate successfully!
   */
  public rotateApiKey(params: {
    merchantId: string;
    mode: "TEST" | "LIVE";
    overlapWindowMs?: number; // Default 15 minutes
    now?: Date;
  }): { keyId: string; newSecret: string; previousSecretExpiresAt: string } {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const overlapMs = params.overlapWindowMs ?? 15 * 60 * 1000;
    const expiresAtIso = new Date(now.getTime() + overlapMs).toISOString();

    const row = this.gatewayDb
      .prepare(`SELECT * FROM api_keys WHERE merchant_id = ? AND mode = ?`)
      .get(params.merchantId, params.mode) as unknown as ApiKeyRecord | undefined;

    if (!row) {
      throw new Error(`API key not found for merchant "${params.merchantId}"`);
    }

    const newSecret = `sec_${params.mode.toLowerCase()}_${crypto.randomBytes(16).toString("hex")}`;

    this.gatewayDb
      .prepare(
        `UPDATE api_keys
         SET previous_secret = active_secret,
             previous_secret_expires_at = ?,
             active_secret = ?,
             rotated_at = ?
         WHERE key_id = ?`
      )
      .run(expiresAtIso, newSecret, nowIso, row.key_id);

    this.audit.record({
      actorId: params.merchantId,
      actorRole: "merchant",
      action: "ROTATE_API_KEY",
      entityType: "ApiKey",
      entityId: row.key_id,
      newValue: { rotated_at: nowIso, overlap_expires_at: expiresAtIso },
      requestId: `REQ-ROTATE-${row.key_id}`,
      nowIso,
    });

    return {
      keyId: row.key_id,
      newSecret,
      previousSecretExpiresAt: expiresAtIso,
    };
  }

  /**
   * Requirement 3 & Acceptance Test 10:
   * Authenticates a merchant API call using `keyId`, `timestampIso`, `signature`, and `rawBody`.
   * Rejects replays >5 minutes old and checks both `active_secret` and `previous_secret` (if within overlap window).
   */
  public authenticateMerchantRequest(params: {
    keyId: string;
    rawBody: string;
    timestampIso: string;
    signature: string;
    now?: Date;
  }): { merchant: MerchantRecord; mode: "TEST" | "LIVE" } {
    const nowMs = (params.now ?? new Date()).getTime();
    const keyRow = this.gatewayDb
      .prepare(`SELECT * FROM api_keys WHERE key_id = ?`)
      .get(params.keyId) as unknown as ApiKeyRecord | undefined;

    if (!keyRow) {
      throw Object.assign(new Error(`Unknown API key "${params.keyId}"`), {
        statusCode: 401,
      });
    }

    const overlapStillValid =
      keyRow.previous_secret !== null &&
      keyRow.previous_secret_expires_at !== null &&
      nowMs <= Date.parse(keyRow.previous_secret_expires_at);

    const verify = verifyServiceMessage(
      params.rawBody,
      params.timestampIso,
      params.signature,
      keyRow.active_secret,
      {
        nowMs,
        previousSecret: overlapStillValid ? (keyRow.previous_secret ?? undefined) : undefined,
      }
    );

    if (!verify.valid) {
      throw Object.assign(new Error(`Merchant API authentication failed: ${verify.reason}`), {
        statusCode: 401,
      });
    }

    const merchant = this.getMerchant(keyRow.merchant_id)!;
    // Requirement 1: Only ACTIVE merchants can take LIVE payments; TEST mode works from CREATED!
    if (keyRow.mode === "LIVE" && merchant.state !== "ACTIVE") {
      throw Object.assign(
        new Error(
          `Req 1 Violation (HTTP 403): Merchant "${merchant.id}" is in state "${merchant.state}" and cannot use LIVE mode until ACTIVE`
        ),
        { statusCode: 403 }
      );
    }

    return { merchant, mode: keyRow.mode };
  }

  /**
   * Requirement 4, NFR 2 & Acceptance Test 5:
   * Creates an order with an idempotency key (tested under 10 concurrent identical calls!).
   */
  public async createOrder(params: {
    merchantId: string;
    mode?: "TEST" | "LIVE";
    idempotencyKey: string;
    amountPaise: number;
    currency?: string;
    merchantOrderId: string;
    customerReference?: string;
    customerEmail?: string;
    customerPhone?: string;
    notes?: string;
    expiryMinutes?: number; // Default 30 minutes (Req 8)
    now?: Date;
  }): Promise<{ order: OrderRecord; replayed: boolean }> {
    assertPositivePaise(params.amountPaise, "amountPaise");
    const now = params.now ?? new Date();
    const mode = params.mode ?? "LIVE";
    const merchant = this.getMerchant(params.merchantId);
    if (!merchant) {
      throw new Error(`Merchant "${params.merchantId}" not found`);
    }
    if (mode === "LIVE" && merchant.state !== "ACTIVE") {
      throw Object.assign(new Error(`Merchant "${merchant.id}" must be ACTIVE for LIVE orders`), {
        statusCode: 403,
      });
    }

    const canonicalPayload = {
      merchant_id: params.merchantId,
      mode,
      amount_paise: params.amountPaise,
      currency: params.currency ?? INR_CURRENCY_NUMERIC,
      merchant_order_id: params.merchantOrderId,
    };
    const payloadHash = canonicalJsonHash(canonicalPayload);

    const sf = await this.orderSingleFlight.execute({
      idempotencyKey: `${params.merchantId}:${params.idempotencyKey}`,
      payloadHash,
      nowMs: now.getTime(),
      work: async () => {
        const stored = this.idempotencyStore.execute({
          scope: `GW_ORDER:${params.merchantId}`,
          idempotencyKey: params.idempotencyKey,
          requestPayload: canonicalPayload,
          handler: () => {
            const orderId = `order_${crypto.randomUUID().slice(0, 10)}`;
            const expiryMs = (params.expiryMinutes ?? 30) * 60 * 1000;
            const expiresAtIso = new Date(now.getTime() + expiryMs).toISOString();
            const nowIso = now.toISOString();

            const order: OrderRecord = {
              id: orderId,
              merchant_id: params.merchantId,
              mode,
              merchant_order_id: params.merchantOrderId,
              amount_paise: params.amountPaise,
              currency: params.currency ?? INR_CURRENCY_NUMERIC,
              customer_reference: params.customerReference ?? null,
              customer_email: params.customerEmail ?? null,
              customer_phone: params.customerPhone ?? null,
              notes: params.notes ?? null,
              state: "CREATED",
              checkout_url: `https://checkout.gateway.local/checkout/${orderId}`,
              expires_at: expiresAtIso,
              created_at: nowIso,
            };

            this.gatewayDb
              .prepare(
                `INSERT INTO orders (
                  id, merchant_id, mode, merchant_order_id, amount_paise, currency,
                  customer_reference, customer_email, customer_phone, notes,
                  state, checkout_url, expires_at, created_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'CREATED', ?, ?, ?)`
              )
              .run(
                order.id,
                order.merchant_id,
                order.mode,
                order.merchant_order_id,
                order.amount_paise,
                order.currency,
                order.customer_reference,
                order.customer_email,
                order.customer_phone,
                order.notes,
                order.checkout_url,
                order.expires_at,
                order.created_at
              );

            return { statusCode: 201, body: order };
          },
        });

        return stored.response_body;
      },
    });

    this.logGatewayEvent("ORDER_CREATED", {
      order_id: sf.value.id,
      merchant_id: params.merchantId,
      amount_paise: params.amountPaise,
      replayed: sf.coalescedOrReplayed,
    });

    return { order: sf.value, replayed: sf.coalescedOrReplayed };
  }

  /**
   * Requirements 5, 6, 7, 8, 9, 12, 14, 15, 17, 24 & Acceptance Tests 1, 2, 3, 4, 6:
   * Executes a customer payment on an order:
   * - Checks order expiry (Req 8).
   * - If the order is ALREADY `PAID`, handles Requirement 7 ("A second success for the same order
   *   is treated as a duplicate and auto-refunded with an alert").
   * - For `CARD`, requires a `tokenId` from the Token Vault (never accepts a raw PAN outside the vault!).
   *   Calls `vault.detokenize` internally inside the Acquirer Adapter, selects ranked acquirers via
   *   `AcquirerRoutingEngine`, retries ONCE on the next acquirer on `TECHNICAL_FAILURE`, and NEVER
   *   retries on `BUSINESS_DECLINE`.
   * - For `UPI`, routes the payment through Project 1's `CentralSwitch`!
   * - Returns signed merchant return URL parameters (Req 9) and triggers signed webhooks (`payment.authorized`, `payment.captured`, or `payment.failed`).
   */
  public async payOrder(params: {
    orderId: string;
    method: PaymentMethod;
    tokenId?: string; // Required for CARD (created via TokenVaultService.tokenize)
    cardOtp?: string;
    upiPayerVpa?: string;
    upiRawPin?: string;
    simulateBusinessDecline?: "INSUFFICIENT_FUNDS" | "DO_NOT_HONOUR";
    allowDuplicateOrderTest?: boolean;
    now?: Date;
  }): Promise<{
    payment: PaymentRecord;
    attempts: PaymentAttemptRecord[];
    signedReturnUrl: string;
    autoRefundedDuplicate?: RefundRecord;
  }> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const order = this.getOrder(params.orderId);
    if (!order) {
      throw new Error(`Order "${params.orderId}" not found`);
    }

    // Requirement 8: Check if unpaid order has expired
    if (order.state === "CREATED" && now.getTime() > Date.parse(order.expires_at)) {
      this.gatewayDb.prepare(`UPDATE orders SET state = 'EXPIRED' WHERE id = ?`).run(order.id);
      throw Object.assign(new Error(`Order "${order.id}" has expired`), {
        statusCode: 410,
      });
    }

    const wasAlreadyPaid = order.state === "PAID";
    if (wasAlreadyPaid && !params.allowDuplicateOrderTest) {
      throw Object.assign(new Error(`Order "${order.id}" is already PAID`), { statusCode: 409 });
    }

    const merchant = this.getMerchant(order.merchant_id)!;
    const paymentId = `pay_${crypto.randomUUID().slice(0, 10)}`;

    this.gatewayDb
      .prepare(
        `INSERT INTO payments (
          id, order_id, merchant_id, method, amount_paise, refunded_amount_paise,
          state, token_id, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 'CREATED', ?, ?, ?)`
      )
      .run(
        paymentId,
        order.id,
        order.merchant_id,
        params.method,
        order.amount_paise,
        params.tokenId ?? null,
        nowIso,
        nowIso
      );

    this.transitionPaymentState(paymentId, "ATTEMPTED", nowIso);

    const recordedAttempts: PaymentAttemptRecord[] = [];
    let succeededAcquirerId: string | null = null;
    let succeededAcquirerRef: string | null = null;
    let upiSwitchRrn: string | null = null;

    if (params.method === "UPI" && this.upiSwitch && this.upiPsp) {
      // Acceptance Test 2: UPI payment routed through the Project 1 Switch!
      const payerVpa = params.upiPayerVpa ?? "anita@psp1";
      const rawPin = params.upiRawPin ?? "1234";

      const reqEnv = this.upiPsp.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: `GW-UPI-${paymentId}`,
        payerVpa,
        payeeVpa: this.merchantUpiVpa,
        amountPaise: order.amount_paise,
        now,
      });

      const switchRes = await this.upiSwitch.handlePay({
        envelope: reqEnv,
        rawPin,
        now,
      });

      const attemptId = `att_${crypto.randomUUID().slice(0, 10)}`;
      const isOk =
        switchRes.transaction.state === "SUCCESS" && switchRes.envelope.response_code === "00";

      const attempt: PaymentAttemptRecord = {
        id: attemptId,
        payment_id: paymentId,
        order_id: order.id,
        attempt_number: 1,
        method: "UPI",
        acquirer_id: "PROJECT1_UPI_SWITCH",
        routing_reason: "UPI_SWITCH_COLLECT_FLOW",
        state: isOk ? "SUCCEEDED" : "FAILED",
        acquirer_response_code: switchRes.envelope.response_code ?? "91",
        token_id: null,
        latency_ms: 5,
        created_at: nowIso,
      };
      this.insertAttemptRecord(attempt);
      recordedAttempts.push(attempt);

      if (isOk) {
        succeededAcquirerId = "PROJECT1_UPI_SWITCH";
        succeededAcquirerRef = switchRes.transaction.rrn;
        upiSwitchRrn = switchRes.transaction.rrn;
      }
    } else {
      // CARD, NETBANKING, or WALLET routed across the 3 Acquirer Simulators
      let cardNetwork:
        undefined | ReturnType<TokenVaultService["getPublicTokenMetadata"]>["network"];
      let issuerBank: undefined | string;

      if (params.method === "CARD") {
        if (!params.tokenId) {
          throw new Error(
            "Req 15 Violation: Card payments must tokenize with the Vault first and pass tokenId"
          );
        }
        // Verify merchant ownership and retrieve non-sensitive metadata (network, BIN6, issuerBank)
        const tokenMeta = this.vault.getPublicTokenMetadata(params.tokenId, order.merchant_id);
        cardNetwork = tokenMeta.network;
        issuerBank = tokenMeta.issuer_bank;

        // Internal Acquirer Adapter detokenizes strictly in local scope (never logged or saved in gatewayDb!)
        this.vault.detokenize({
          token: params.tokenId,
          merchantId: order.merchant_id,
          adapterCredential: this.adapterCredential,
        });
      }

      const candidates = this.routing.selectRankedAcquirers({
        method: params.method,
        amountPaise: order.amount_paise,
        cardNetwork,
        issuerBank,
      });

      if (candidates.length === 0) {
        throw new Error(`No eligible acquirers found for method ${params.method}`);
      }

      // Requirement 12: Try primary healthiest acquirer; on TECHNICAL_FAILURE retry ONCE on next acquirer!
      const maxAttemptsInSession = Math.min(2, candidates.length);

      for (let idx = 0; idx < maxAttemptsInSession; idx++) {
        const candidate = candidates[idx];
        const authRes = await candidate.acquirer.authorize({
          method: params.method,
          amountPaise: order.amount_paise,
          otp: params.cardOtp,
          simulateBusinessDecline: params.simulateBusinessDecline,
        });

        this.routing.recordOutcome({
          acquirerId: candidate.acquirer.config.acquirerId,
          method: params.method,
          success: authRes.category === "SUCCESS",
          latencyMs: authRes.latency_ms,
          isTimeout: authRes.response_code === "68_TIMEOUT",
          nowMs: now.getTime(),
        });

        const attempt: PaymentAttemptRecord = {
          id: `att_${crypto.randomUUID().slice(0, 10)}`,
          payment_id: paymentId,
          order_id: order.id,
          attempt_number: idx + 1,
          method: params.method,
          acquirer_id: candidate.acquirer.config.acquirerId,
          routing_reason: candidate.routingReason,
          state: authRes.category === "SUCCESS" ? "SUCCEEDED" : "FAILED",
          acquirer_response_code: authRes.response_code,
          token_id: params.tokenId ?? null,
          latency_ms: authRes.latency_ms,
          created_at: nowIso,
        };
        this.insertAttemptRecord(attempt);
        recordedAttempts.push(attempt);

        if (authRes.category === "SUCCESS") {
          succeededAcquirerId = candidate.acquirer.config.acquirerId;
          succeededAcquirerRef = authRes.acquirer_reference;
          break;
        }

        // Requirement 12 & Acceptance Test 4: NEVER retry a business decline (insufficient funds, wrong OTP, do-not-honour)!
        if (authRes.category === "BUSINESS_DECLINE") {
          break;
        }
        // Otherwise category === 'TECHNICAL_FAILURE' -> loop continues once to failover acquirer!
      }
    }

    this.logGatewayEvent("PAYMENT_ATTEMPT_COMPLETED", {
      payment_id: paymentId,
      order_id: order.id,
      method: params.method,
      token_id: params.tokenId ?? null,
      attempts_count: recordedAttempts.length,
    });

    if (!succeededAcquirerId || !succeededAcquirerRef) {
      this.transitionPaymentState(paymentId, "FAILED", nowIso);
      const failedPayment = this.getPayment(paymentId)!;
      await this.webhooks.publishEvent({
        merchantId: order.merchant_id,
        eventType: "payment.failed",
        objectData: failedPayment,
        now,
      });

      return {
        payment: failedPayment,
        attempts: recordedAttempts,
        signedReturnUrl: this.buildSignedReturnUrl(merchant, order.id, paymentId, "FAILED", nowIso),
      };
    }

    // Update payment with winning acquirer & transition ATTEMPTED -> AUTHORIZED
    this.gatewayDb
      .prepare(
        `UPDATE payments
         SET acquirer_id = ?, acquirer_reference = ?, upi_switch_rrn = ?, updated_at = ?
         WHERE id = ?`
      )
      .run(succeededAcquirerId, succeededAcquirerRef, upiSwitchRrn, nowIso, paymentId);

    this.transitionPaymentState(paymentId, "AUTHORIZED", nowIso);

    await this.webhooks.publishEvent({
      merchantId: order.merchant_id,
      eventType: "payment.authorized",
      objectData: this.getPayment(paymentId)!,
      now,
    });

    // Requirement 6: Auto-capture is default; manual capture stops at AUTHORIZED
    if (merchant.capture_mode === "AUTO") {
      await this.capturePayment({ paymentId, now });
    }

    const finalPayment = this.getPayment(paymentId)!;

    // Requirement 7: If the order was ALREADY PAID by an earlier payment, auto-refund this duplicate with an alert!
    let autoRefundedDuplicate: RefundRecord | undefined;
    if (wasAlreadyPaid && finalPayment.state === "CAPTURED") {
      const autoRefund = await this.createRefund({
        paymentId: finalPayment.id,
        amountPaise: finalPayment.amount_paise,
        idempotencyKey: `AUTO-REFUND-DUP-${finalPayment.id}`,
        now,
      });
      autoRefundedDuplicate = autoRefund.refund;
      this.duplicatePaymentAlerts.push({
        order_id: order.id,
        duplicate_payment_id: finalPayment.id,
        auto_refund_id: autoRefund.refund.id,
        created_at: nowIso,
      });
    }

    return {
      payment: this.getPayment(paymentId)!,
      attempts: recordedAttempts,
      signedReturnUrl: this.buildSignedReturnUrl(
        merchant,
        order.id,
        paymentId,
        finalPayment.state,
        nowIso
      ),
      autoRefundedDuplicate,
    };
  }

  /**
   * Requirement 6 & 24 & Interface `POST /payments/{id}/capture`:
   * Transitions `AUTHORIZED -> CAPTURED`, marks the order `PAID`, posts the MDR/GST/Reserve/Payable
   * double-entry lines to the Merchant Ledger, and emits `payment.captured` webhook.
   */
  public async capturePayment(params: { paymentId: string; now?: Date }): Promise<PaymentRecord> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const payment = this.getPayment(params.paymentId);
    if (!payment) {
      throw new Error(`Payment "${params.paymentId}" not found`);
    }

    this.transitionPaymentState(payment.id, "CAPTURED", nowIso);
    this.gatewayDb.prepare(`UPDATE orders SET state = 'PAID' WHERE id = ?`).run(payment.order_id);

    const merchant = this.getMerchant(payment.merchant_id)!;
    this.postCaptureToMerchantLedger(merchant, payment, nowIso);

    const captured = this.getPayment(payment.id)!;
    await this.webhooks.publishEvent({
      merchantId: payment.merchant_id,
      eventType: "payment.captured",
      objectData: captured,
      now,
    });

    return captured;
  }

  /**
   * Requirement 6 & Interface `POST /payments/{id}/void`:
   * Voids an `AUTHORIZED` payment in manual capture mode.
   */
  public voidPayment(paymentId: string, now = new Date()): PaymentRecord {
    this.transitionPaymentState(paymentId, "VOIDED", now.toISOString());
    return this.getPayment(paymentId)!;
  }

  /**
   * Requirements 23 & 24 & Acceptance Test 7:
   * Creates a full or partial refund (`CREATED -> PROCESSED | FAILED`), idempotent by key under
   * concurrent retries, enforces `refunded_amount_paise + amountPaise <= payment.amount_paise`,
   * and posts reversing double-entry lines in the Merchant Ledger.
   */
  public async createRefund(params: {
    paymentId: string;
    amountPaise: number;
    idempotencyKey: string;
    acquirerSim?: AcquirerSimulator;
    now?: Date;
  }): Promise<{ refund: RefundRecord; replayed: boolean }> {
    assertPositivePaise(params.amountPaise, "refund.amountPaise");
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();

    const payment = this.getPayment(params.paymentId);
    if (!payment) {
      throw new Error(`Payment "${params.paymentId}" not found`);
    }
    if (
      payment.state !== "CAPTURED" &&
      payment.state !== "SETTLED" &&
      payment.state !== "PARTIALLY_REFUNDED"
    ) {
      throw Object.assign(new Error(`Cannot refund payment in state "${payment.state}"`), {
        statusCode: 400,
      });
    }

    const canonicalPayload = {
      payment_id: params.paymentId,
      amount_paise: params.amountPaise,
    };
    const payloadHash = canonicalJsonHash(canonicalPayload);

    const sf = await this.refundSingleFlight.execute({
      idempotencyKey: `${payment.merchant_id}:${params.idempotencyKey}`,
      payloadHash,
      nowMs: now.getTime(),
      work: async () => {
        const stored = this.idempotencyStore.execute({
          scope: `GW_REFUND:${payment.merchant_id}`,
          idempotencyKey: params.idempotencyKey,
          requestPayload: canonicalPayload,
          handler: () => {
            const freshPay = this.getPayment(params.paymentId)!;
            if (freshPay.refunded_amount_paise + params.amountPaise > freshPay.amount_paise) {
              throw Object.assign(
                new Error(
                  `Acceptance Test 7 Violation (HTTP 422): Refund of ${params.amountPaise} paise exceeds remaining refundable balance (${
                    freshPay.amount_paise - freshPay.refunded_amount_paise
                  } paise)`
                ),
                { statusCode: 422 }
              );
            }

            const refundId = `rfnd_${crypto.randomUUID().slice(0, 10)}`;
            this.gatewayDb
              .prepare(
                `INSERT INTO refunds (
                  id, payment_id, order_id, merchant_id, amount_paise,
                  state, idempotency_key, acquirer_reference, created_at
                ) VALUES (?, ?, ?, ?, ?, 'CREATED', ?, NULL, ?)`
              )
              .run(
                refundId,
                freshPay.id,
                freshPay.order_id,
                freshPay.merchant_id,
                params.amountPaise,
                params.idempotencyKey,
                nowIso
              );

            let acqStatus: "PROCESSED" | "FAILED" = "PROCESSED";
            const acqRef = `RFD-${crypto.randomUUID().slice(0, 8)}`;

            if (params.acquirerSim && params.acquirerSim.getChaos().forceRefundFail) {
              acqStatus = "FAILED";
            }

            this.gatewayDb
              .prepare(`UPDATE refunds SET state = ?, acquirer_reference = ? WHERE id = ?`)
              .run(acqStatus, acqRef, refundId);

            if (acqStatus === "PROCESSED") {
              const newRefundedTotal = freshPay.refunded_amount_paise + params.amountPaise;
              const nextPayState: GatewayPaymentState =
                newRefundedTotal === freshPay.amount_paise ? "REFUNDED" : "PARTIALLY_REFUNDED";

              this.gatewayDb
                .prepare(
                  `UPDATE payments SET refunded_amount_paise = ?, updated_at = ? WHERE id = ?`
                )
                .run(newRefundedTotal, nowIso, freshPay.id);

              this.transitionPaymentState(freshPay.id, nextPayState, nowIso);

              const merchant = this.getMerchant(freshPay.merchant_id)!;
              this.postRefundToMerchantLedger(
                merchant,
                freshPay,
                refundId,
                params.amountPaise,
                nowIso
              );
            }

            return { statusCode: 201, body: this.getRefund(refundId)! };
          },
        });

        return stored.response_body;
      },
    });

    if (!sf.coalescedOrReplayed) {
      await this.webhooks.publishEvent({
        merchantId: payment.merchant_id,
        eventType: sf.value.state === "PROCESSED" ? "refund.processed" : "refund.failed",
        objectData: sf.value,
        now,
      });
    }

    return { refund: sf.value, replayed: sf.coalescedOrReplayed };
  }

  /**
   * Requirement 16 from Project 4 (Page 27):
   * Allows Project 4's Subscription Executor to post captured recurring payments directly
   * into the Project 2 Merchant Ledger so payouts and settlement reports include subscription revenue!
   */
  public postExternalSubscriptionCapture(params: {
    merchantId: string;
    referenceId: string;
    amountPaise: number;
    method?: PaymentMethod;
    now?: Date;
  }): void {
    const nowIso = (params.now ?? new Date()).toISOString();
    const merchant = this.getMerchant(params.merchantId);
    if (!merchant) {
      throw new Error(`Merchant "${params.merchantId}" not found`);
    }

    const fakePayment: PaymentRecord = {
      id: params.referenceId,
      order_id: `SUB-${params.referenceId}`,
      merchant_id: params.merchantId,
      method: params.method ?? "UPI",
      amount_paise: params.amountPaise,
      refunded_amount_paise: 0,
      state: "CAPTURED",
      token_id: null,
      acquirer_id: "PROJECT1_UPI_SWITCH",
      acquirer_reference: params.referenceId,
      upi_switch_rrn: params.referenceId,
      created_at: nowIso,
      updated_at: nowIso,
    };

    this.gatewayDb
      .prepare(
        `INSERT OR IGNORE INTO payments (
          id, order_id, merchant_id, method, amount_paise, refunded_amount_paise,
          state, acquirer_id, acquirer_reference, upi_switch_rrn, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, 0, 'CAPTURED', ?, ?, ?, ?, ?)`
      )
      .run(
        fakePayment.id,
        fakePayment.order_id,
        fakePayment.merchant_id,
        fakePayment.method,
        fakePayment.amount_paise,
        fakePayment.acquirer_id,
        fakePayment.acquirer_reference,
        fakePayment.upi_switch_rrn,
        nowIso,
        nowIso
      );

    this.postCaptureToMerchantLedger(merchant, fakePayment, nowIso);
  }

  private getMdrBpsForMethod(plan: MdrPlanConfig, method: PaymentMethod): number {
    switch (method) {
      case "CARD":
        return plan.cardBps;
      case "UPI":
        return plan.upiBps;
      case "NETBANKING":
        return plan.netbankingBps;
      case "WALLET":
        return plan.walletBps;
    }
  }

  /**
   * Requirement 24 & 26:
   * Every captured payment posts:
   * - DEBIT `MERCHANT_RECEIVABLE` (gross)
   * - CREDIT `GATEWAY_REVENUE` (MDR fee)
   * - CREDIT `GATEWAY_TAX_GST` (18% GST on MDR fee)
   * - CREDIT `MERCHANT_RESERVE` (if rolling reserve > 0)
   * - CREDIT `MERCHANT_PAYABLE` (net minus reserve)
   * All lines in the journal sum to 0!
   */
  private postCaptureToMerchantLedger(
    merchant: MerchantRecord,
    payment: PaymentRecord,
    nowIso: string
  ): void {
    const mdrBps = this.getMdrBpsForMethod(merchant.mdr_plan, payment.method);
    const split = splitMdrAndGst(payment.amount_paise, mdrBps, merchant.mdr_plan.gstBps);

    const reservePaise =
      merchant.rolling_reserve_bps > 0
        ? computeBasisPointsPaise(split.merchantNetPaise, merchant.rolling_reserve_bps)
        : 0;
    const payablePaise = split.merchantNetPaise - reservePaise;

    const lines: Array<{
      accountType: GatewayLedgerAccountType;
      direction: "DEBIT" | "CREDIT";
      amountPaise: number;
    }> = [
      {
        accountType: "MERCHANT_RECEIVABLE",
        direction: "DEBIT",
        amountPaise: split.grossPaise,
      },
      {
        accountType: "MERCHANT_PAYABLE",
        direction: "CREDIT",
        amountPaise: payablePaise,
      },
    ];

    if (split.mdrFeePaise > 0) {
      lines.push({
        accountType: "GATEWAY_REVENUE",
        direction: "CREDIT",
        amountPaise: split.mdrFeePaise,
      });
    }
    if (split.gstOnFeePaise > 0) {
      lines.push({
        accountType: "GATEWAY_TAX_GST",
        direction: "CREDIT",
        amountPaise: split.gstOnFeePaise,
      });
    }
    if (reservePaise > 0) {
      lines.push({
        accountType: "MERCHANT_RESERVE",
        direction: "CREDIT",
        amountPaise: reservePaise,
      });
    }

    this.insertGatewayJournal({
      merchantId: merchant.id,
      referenceType: "PAYMENT",
      referenceId: payment.id,
      lines,
      nowIso,
    });

    this.syncDashboardPayableCache(merchant.id);
  }

  /**
   * Requirement 24:
   * A refund posts the reversal to the Merchant Ledger, including whether the MDR/GST fee
   * is returned to the merchant (`merchant.mdr_plan.returnFeeOnRefund`).
   */
  private postRefundToMerchantLedger(
    merchant: MerchantRecord,
    payment: PaymentRecord,
    refundId: string,
    refundAmountPaise: number,
    nowIso: string
  ): void {
    if (merchant.mdr_plan.returnFeeOnRefund) {
      const mdrBps = this.getMdrBpsForMethod(merchant.mdr_plan, payment.method);
      const split = splitMdrAndGst(refundAmountPaise, mdrBps, merchant.mdr_plan.gstBps);

      const lines: Array<{
        accountType: GatewayLedgerAccountType;
        direction: "DEBIT" | "CREDIT";
        amountPaise: number;
      }> = [
        {
          accountType: "MERCHANT_PAYABLE",
          direction: "DEBIT",
          amountPaise: split.merchantNetPaise,
        },
        {
          accountType: "MERCHANT_RECEIVABLE",
          direction: "CREDIT",
          amountPaise: split.grossPaise,
        },
      ];
      if (split.mdrFeePaise > 0) {
        lines.push({
          accountType: "GATEWAY_REVENUE",
          direction: "DEBIT",
          amountPaise: split.mdrFeePaise,
        });
      }
      if (split.gstOnFeePaise > 0) {
        lines.push({
          accountType: "GATEWAY_TAX_GST",
          direction: "DEBIT",
          amountPaise: split.gstOnFeePaise,
        });
      }

      this.insertGatewayJournal({
        merchantId: merchant.id,
        referenceType: "REFUND",
        referenceId: refundId,
        lines,
        nowIso,
      });
    } else {
      // Fee is NOT returned: full refund amount is debited from MERCHANT_PAYABLE
      this.insertGatewayJournal({
        merchantId: merchant.id,
        referenceType: "REFUND",
        referenceId: refundId,
        lines: [
          {
            accountType: "MERCHANT_PAYABLE",
            direction: "DEBIT",
            amountPaise: refundAmountPaise,
          },
          {
            accountType: "MERCHANT_RECEIVABLE",
            direction: "CREDIT",
            amountPaise: refundAmountPaise,
          },
        ],
        nowIso,
      });
    }

    this.syncDashboardPayableCache(merchant.id);
  }

  private insertGatewayJournal(params: {
    merchantId: string;
    referenceType: GatewayLedgerPosting["reference_type"];
    referenceId: string;
    lines: Array<{
      accountType: GatewayLedgerAccountType;
      direction: "DEBIT" | "CREDIT";
      amountPaise: number;
    }>;
    nowIso: string;
  }): string {
    let debitSum = 0;
    let creditSum = 0;
    for (const l of params.lines) {
      if (l.direction === "DEBIT") {
        debitSum += l.amountPaise;
      } else {
        creditSum += l.amountPaise;
      }
    }
    if (debitSum !== creditSum) {
      throw new Error(
        `Rule 2 Violation in Gateway Ledger: debitSum (${debitSum}) !== creditSum (${creditSum})`
      );
    }

    const journalId = `gw_jrn_${crypto.randomUUID().slice(0, 10)}`;
    const stmt = this.gatewayDb.prepare(`
      INSERT INTO gateway_ledger_postings (
        id, journal_id, merchant_id, account_type, direction,
        amount_paise, reference_type, reference_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const l of params.lines) {
      stmt.run(
        `gw_pst_${crypto.randomUUID().slice(0, 10)}`,
        journalId,
        params.merchantId,
        l.accountType,
        l.direction,
        l.amountPaise,
        params.referenceType,
        params.referenceId,
        params.nowIso
      );
    }

    return journalId;
  }

  /**
   * Computes a merchant's derived ledger balances directly from `gateway_ledger_postings`.
   */
  public getMerchantLedgerBalances(merchantId: string): {
    payable_paise: number;
    reserve_paise: number;
    gateway_revenue_paise: number;
    gateway_tax_gst_paise: number;
    available_payout_paise: number;
  } {
    const rows = this.gatewayDb
      .prepare(
        `SELECT account_type,
                SUM(CASE WHEN direction = 'CREDIT' THEN amount_paise ELSE -amount_paise END) AS net_credit_paise
         FROM gateway_ledger_postings
         WHERE merchant_id = ?
         GROUP BY account_type`
      )
      .all(merchantId) as Array<{
      account_type: GatewayLedgerAccountType;
      net_credit_paise: number;
    }>;

    const map = new Map<GatewayLedgerAccountType, number>();
    for (const r of rows) {
      map.set(r.account_type, r.net_credit_paise);
    }

    const merchant = this.getMerchant(merchantId)!;
    const payable = map.get("MERCHANT_PAYABLE") ?? 0;
    const reserve = map.get("MERCHANT_RESERVE") ?? 0;
    const revenue = map.get("GATEWAY_REVENUE") ?? 0;
    const tax = map.get("GATEWAY_TAX_GST") ?? 0;

    return {
      payable_paise: payable,
      reserve_paise: reserve,
      gateway_revenue_paise: revenue,
      gateway_tax_gst_paise: tax,
      available_payout_paise: Math.max(0, payable - merchant.hold_paise),
    };
  }

  private syncDashboardPayableCache(merchantId: string): void {
    const bal = this.getMerchantLedgerBalances(merchantId);
    this.gatewayDb
      .prepare(`UPDATE merchants SET dashboard_cached_payable_paise = ? WHERE id = ?`)
      .run(bal.payable_paise, merchantId);
  }

  /**
   * Requirement 27:
   * "The merchant's dashboard balance must equal the ledger at all times; a nightly check
   * compares the two and raises an exception on any difference."
   */
  public verifyDashboardMatchesLedger(merchantId: string): {
    matches: boolean;
    dashboard_balance_paise: number;
    ledger_payable_paise: number;
  } {
    const row = this.gatewayDb
      .prepare(`SELECT dashboard_cached_payable_paise FROM merchants WHERE id = ?`)
      .get(merchantId) as { dashboard_cached_payable_paise: number } | undefined;

    if (!row) {
      throw new Error(`Merchant "${merchantId}" not found`);
    }
    const ledgerBal = this.getMerchantLedgerBalances(merchantId);
    return {
      matches: row.dashboard_cached_payable_paise === ledgerBal.payable_paise,
      dashboard_balance_paise: row.dashboard_cached_payable_paise,
      ledger_payable_paise: ledgerBal.payable_paise,
    };
  }

  /**
   * Requirement 25 & Acceptance Test 9:
   * Executes a T+1 / T+2 payout run for a merchant:
   * - Pays the merchant's payable balance since the last payout to their settlement bank account.
   * - Transitions settled payments to `SETTLED`.
   * - Generates a downloadable CSV settlement report (every payment and refund in the batch, fee, tax, net)
   *   whose net equals the ledger's payable balance for the period!
   */
  public async runMerchantPayout(params: {
    merchantId: string;
    periodLabel?: string;
    now?: Date;
  }): Promise<MerchantSettlementRecord> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const merchant = this.getMerchant(params.merchantId);
    if (!merchant) {
      throw new Error(`Merchant "${params.merchantId}" not found`);
    }

    const ledgerBalBefore = this.getMerchantLedgerBalances(params.merchantId);
    const payableToSettle = ledgerBalBefore.available_payout_paise;
    if (payableToSettle <= 0) {
      throw new Error(
        `Merchant "${params.merchantId}" has no positive payable balance to settle (available=${payableToSettle})`
      );
    }

    // Gather all unsettled captured/refunded payments and processed refunds for the batch report
    const unsettledPayments = this.gatewayDb
      .prepare(
        `SELECT * FROM payments
         WHERE merchant_id = ?
           AND state IN ('CAPTURED', 'PARTIALLY_REFUNDED', 'REFUNDED')
           AND settled_in_payout_id IS NULL
         ORDER BY created_at ASC`
      )
      .all(params.merchantId) as unknown as PaymentRecord[];

    const unsettledRefunds = this.gatewayDb
      .prepare(
        `SELECT * FROM refunds
         WHERE merchant_id = ?
           AND state = 'PROCESSED'
           AND settled_in_payout_id IS NULL
         ORDER BY created_at ASC`
      )
      .all(params.merchantId) as unknown as RefundRecord[];

    const reportLines: string[] = [
      "item_type,id,order_id,gross_paise,mdr_fee_paise,gst_tax_paise,net_paise,created_at",
    ];

    let grossTotal = 0;
    let feesTotal = 0;
    let taxTotal = 0;
    let netTotal = 0;

    for (const p of unsettledPayments) {
      const mdrBps = this.getMdrBpsForMethod(merchant.mdr_plan, p.method);
      const split = splitMdrAndGst(p.amount_paise, mdrBps, merchant.mdr_plan.gstBps);
      grossTotal += split.grossPaise;
      feesTotal += split.mdrFeePaise;
      taxTotal += split.gstOnFeePaise;
      netTotal += split.merchantNetPaise;

      reportLines.push(
        `PAYMENT,${p.id},${p.order_id},${split.grossPaise},${split.mdrFeePaise},${split.gstOnFeePaise},${split.merchantNetPaise},${p.created_at}`
      );
    }

    for (const r of unsettledRefunds) {
      const parentPay = this.getPayment(r.payment_id)!;
      if (merchant.mdr_plan.returnFeeOnRefund) {
        const mdrBps = this.getMdrBpsForMethod(merchant.mdr_plan, parentPay.method);
        const split = splitMdrAndGst(r.amount_paise, mdrBps, merchant.mdr_plan.gstBps);
        grossTotal -= split.grossPaise;
        feesTotal -= split.mdrFeePaise;
        taxTotal -= split.gstOnFeePaise;
        netTotal -= split.merchantNetPaise;
        reportLines.push(
          `REFUND,${r.id},${r.order_id},-${split.grossPaise},-${split.mdrFeePaise},-${split.gstOnFeePaise},-${split.merchantNetPaise},${r.created_at}`
        );
      } else {
        grossTotal -= r.amount_paise;
        netTotal -= r.amount_paise;
        reportLines.push(
          `REFUND,${r.id},${r.order_id},-${r.amount_paise},0,0,-${r.amount_paise},${r.created_at}`
        );
      }
    }

    reportLines.push(
      `BATCH_TOTAL,SUMMARY,ALL,${grossTotal},${feesTotal},${taxTotal},${netTotal},${nowIso}`
    );

    const settlementId = `setl_${crypto.randomUUID().slice(0, 10)}`;

    // Post payout journal to Merchant Ledger: DEBIT MERCHANT_PAYABLE, CREDIT SETTLEMENT_BANK
    this.insertGatewayJournal({
      merchantId: merchant.id,
      referenceType: "PAYOUT",
      referenceId: settlementId,
      lines: [
        {
          accountType: "MERCHANT_PAYABLE",
          direction: "DEBIT",
          amountPaise: payableToSettle,
        },
        {
          accountType: "SETTLEMENT_BANK",
          direction: "CREDIT",
          amountPaise: payableToSettle,
        },
      ],
      nowIso,
    });

    this.syncDashboardPayableCache(merchant.id);

    for (const p of unsettledPayments) {
      if (p.state === "CAPTURED") {
        this.transitionPaymentState(p.id, "SETTLED", nowIso);
      }
      this.gatewayDb
        .prepare(`UPDATE payments SET settled_in_payout_id = ? WHERE id = ?`)
        .run(settlementId, p.id);
    }

    for (const r of unsettledRefunds) {
      this.gatewayDb
        .prepare(`UPDATE refunds SET settled_in_payout_id = ? WHERE id = ?`)
        .run(settlementId, r.id);
    }

    const record: MerchantSettlementRecord = {
      id: settlementId,
      merchant_id: merchant.id,
      period_label: params.periodLabel ?? `T+1-${nowIso.slice(0, 10)}`,
      gross_paise: grossTotal,
      fees_paise: feesTotal,
      tax_paise: taxTotal,
      net_paise: netTotal,
      state: "PROCESSED",
      report_csv: reportLines.join("\n") + "\n",
      created_at: nowIso,
    };

    this.gatewayDb
      .prepare(
        `INSERT INTO merchant_settlements (
          id, merchant_id, period_label, gross_paise, fees_paise, tax_paise,
          net_paise, state, report_csv, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'PROCESSED', ?, ?)`
      )
      .run(
        record.id,
        record.merchant_id,
        record.period_label,
        record.gross_paise,
        record.fees_paise,
        record.tax_paise,
        record.net_paise,
        record.report_csv,
        record.created_at
      );

    await this.webhooks.publishEvent({
      merchantId: merchant.id,
      eventType: "settlement.processed",
      objectData: record,
      now,
    });

    return record;
  }

  public getMerchant(merchantId: string): MerchantRecord | undefined {
    const row = this.gatewayDb.prepare(`SELECT * FROM merchants WHERE id = ?`).get(merchantId) as
      (Omit<MerchantRecord, "mdr_plan"> & { mdr_plan_json: string }) | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      business_name: row.business_name,
      contact_email: row.contact_email,
      state: row.state,
      settlement_account_number: row.settlement_account_number,
      settlement_branch_code: row.settlement_branch_code,
      settlement_holder_name: row.settlement_holder_name,
      mdr_plan: JSON.parse(row.mdr_plan_json) as MdrPlanConfig,
      capture_mode: row.capture_mode,
      return_url: row.return_url,
      rolling_reserve_bps: row.rolling_reserve_bps,
      rolling_reserve_days: row.rolling_reserve_days,
      hold_paise: row.hold_paise,
      created_at: row.created_at,
    };
  }

  public getOrder(orderId: string): OrderRecord | undefined {
    return this.gatewayDb.prepare(`SELECT * FROM orders WHERE id = ?`).get(orderId) as unknown as
      OrderRecord | undefined;
  }

  public getPayment(paymentId: string): PaymentRecord | undefined {
    return this.gatewayDb
      .prepare(`SELECT * FROM payments WHERE id = ?`)
      .get(paymentId) as unknown as PaymentRecord | undefined;
  }

  public listPaymentAttempts(paymentId: string): PaymentAttemptRecord[] {
    return this.gatewayDb
      .prepare(`SELECT * FROM payment_attempts WHERE payment_id = ? ORDER BY attempt_number ASC`)
      .all(paymentId) as unknown as PaymentAttemptRecord[];
  }

  public getRefund(refundId: string): RefundRecord | undefined {
    return this.gatewayDb.prepare(`SELECT * FROM refunds WHERE id = ?`).get(refundId) as unknown as
      RefundRecord | undefined;
  }

  private transitionPaymentState(
    paymentId: string,
    toState: GatewayPaymentState,
    nowIso: string
  ): void {
    const current = this.getPayment(paymentId);
    if (!current) {
      throw new Error(`Payment "${paymentId}" not found`);
    }
    assertValidTransition("GatewayPayment", GATEWAY_PAYMENT_TRANSITIONS, current.state, toState);
    this.gatewayDb
      .prepare(`UPDATE payments SET state = ?, updated_at = ? WHERE id = ?`)
      .run(toState, nowIso, paymentId);
  }

  private insertAttemptRecord(attempt: PaymentAttemptRecord): void {
    this.gatewayDb
      .prepare(
        `INSERT INTO payment_attempts (
          id, payment_id, order_id, attempt_number, method,
          acquirer_id, routing_reason, state, acquirer_response_code,
          token_id, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        attempt.id,
        attempt.payment_id,
        attempt.order_id,
        attempt.attempt_number,
        attempt.method,
        attempt.acquirer_id,
        attempt.routing_reason,
        attempt.state,
        attempt.acquirer_response_code,
        attempt.token_id,
        attempt.latency_ms,
        attempt.created_at
      );
  }

  private buildSignedReturnUrl(
    merchant: MerchantRecord,
    orderId: string,
    paymentId: string,
    status: string,
    nowIso: string
  ): string {
    const keyRow = this.gatewayDb
      .prepare(`SELECT active_secret FROM api_keys WHERE merchant_id = ? AND mode = 'LIVE'`)
      .get(merchant.id) as { active_secret: string } | undefined;
    const secret = keyRow?.active_secret ?? "default_return_secret";
    const payload = `order_id=${orderId}&payment_id=${paymentId}&status=${status}`;
    const sig = signServiceMessage(payload, nowIso, secret);
    return `${merchant.return_url}?${payload}&timestamp=${encodeURIComponent(
      nowIso
    )}&signature=${sig}`;
  }

  private logGatewayEvent(event: string, data: Record<string, unknown>): void {
    this.structuredLogs.push({
      timestamp: new Date().toISOString(),
      event,
      data: redactSensitiveData(data),
    });
  }
}
