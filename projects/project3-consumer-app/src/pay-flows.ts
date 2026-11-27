import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  assertPositivePaise,
  parseUpiQrUri,
  signDevicePayload,
  type IsoResponseCode,
} from "@fintech/core";
import type { CentralSwitch, PspSimulator } from "@fintech/project1-switch";
import type { ConsumerPspBackend } from "./psp-backend.ts";

/**
 * Project 3 (Day 16) — VPA Management, 4 Pay Paths & Honest Pending UX
 *
 * 4 Pay Paths:
 * 1. QR Scan (`upi://pay?pa=...&am=...`)
 * 2. VPA (`shop@psp2`)
 * 3. Mobile Number Lookup (`9876543210` -> primary VPA)
 * 4. Bank Account + IFSC (`765432103344` + `BNKC0001` -> bank-rail VPA)
 *
 * Honest Pending UX:
 * - Client generates `client_txn_id` and persists `PENDING` locally BEFORE calling the network.
 * - If network drops / airplane mode occurs, UI shows `PENDING` honestly (never fakes success/failure).
 * - On reconnect / app restart, `syncPendingTransactions()` queries the server by `client_txn_id`
 *   to converge to the exact Switch status (`SUCCESS`, `FAILED`, or `REVERSED`).
 */

export type PayPathType = "QR" | "VPA" | "MOBILE" | "BANK_IFSC";

export interface CustomerVpaRecord {
  vpa: string;
  customer_id: string;
  linked_account_id: string;
  bank_id: string;
  account_number: string;
  holder_name: string;
  is_default: number;
  created_at: string;
}

export interface PspTransactionRecord {
  client_txn_id: string;
  customer_id: string;
  pay_path: PayPathType;
  payer_vpa: string;
  payee_vpa: string;
  payee_display_name: string;
  amount_paise: number;
  note: string | null;
  status: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
  switch_rrn: string | null;
  iso_response_code: IsoResponseCode | null;
  honest_status_message: string;
  created_at: string;
  updated_at: string;
}

export class NetworkDropSimulatedError extends Error {
  constructor(message = "Network unavailable (Airplane Mode / Socket Drop)") {
    super(message);
    this.name = "NetworkDropSimulatedError";
  }
}

export class ConsumerPayEngine {
  private readonly pspBackend: ConsumerPspBackend;
  private readonly p1Switch: CentralSwitch;
  private readonly p1Psp: PspSimulator;
  private readonly allPsps: PspSimulator[];
  public simulateAirplaneMode = false;

  constructor(params: {
    pspBackend: ConsumerPspBackend;
    p1Switch: CentralSwitch;
    p1Psp: PspSimulator;
    allPsps?: PspSimulator[];
  }) {
    this.pspBackend = params.pspBackend;
    this.p1Switch = params.p1Switch;
    this.p1Psp = params.p1Psp;
    this.allPsps = params.allPsps ?? [params.p1Psp];
    this.initSchema();
  }

  private initSchema(): void {
    this.pspBackend.db.exec(`
      CREATE TABLE IF NOT EXISTS customer_vpas (
        vpa TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        linked_account_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        account_number TEXT NOT NULL,
        holder_name TEXT NOT NULL,
        is_default INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS psp_transactions (
        client_txn_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        pay_path TEXT NOT NULL,
        payer_vpa TEXT NOT NULL,
        payee_vpa TEXT NOT NULL,
        payee_display_name TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        note TEXT,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'REVERSED')),
        switch_rrn TEXT,
        iso_response_code TEXT,
        honest_status_message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);

    const persistedVpas = this.pspBackend.db
      .prepare(`SELECT vpa, bank_id, account_number, holder_name FROM customer_vpas`)
      .all() as Array<{
      vpa: string;
      bank_id: string;
      account_number: string;
      holder_name: string;
    }>;
    for (const row of persistedVpas) {
      if (!this.p1Psp.lookupVpaExternal(row.vpa)) {
        try {
          this.p1Psp.registerVpa({
            vpa: row.vpa,
            bankId: row.bank_id,
            accountNumber: row.account_number,
            holderName: row.holder_name,
          });
        } catch {
          // Ignore if registered on another PSP
        }
      }
    }
  }

  /**
   * Creates a VPA (`mobile@psp1` or custom handle) and registers it in Project 1's PSP directory.
   */
  public createVpa(params: {
    customerId: string;
    linkedAccountId: string;
    handle: string;
    isDefault?: boolean;
    now?: Date;
  }): CustomerVpaRecord {
    const linked = this.pspBackend.db
      .prepare(`SELECT * FROM linked_accounts WHERE id = ? AND customer_id = ?`)
      .get(params.linkedAccountId, params.customerId) as
      | {
          id: string;
          customer_id: string;
          bank_id: string;
          account_number: string;
          holder_name: string;
        }
      | undefined;

    if (!linked) {
      throw new Error(`Linked account "${params.linkedAccountId}" not found for customer`);
    }

    const cleanHandle = params.handle.trim().toLowerCase();
    const vpa = cleanHandle.includes("@")
      ? cleanHandle
      : `${cleanHandle}@${this.p1Psp.config.handleSuffix}`;
    const nowIso = (params.now ?? new Date()).toISOString();
    const isDefault = params.isDefault ? 1 : 0;

    if (isDefault === 1) {
      this.pspBackend.db
        .prepare(`UPDATE customer_vpas SET is_default = 0 WHERE customer_id = ?`)
        .run(params.customerId);
    }

    this.p1Psp.registerVpa({
      vpa,
      bankId: linked.bank_id,
      accountNumber: linked.account_number,
      holderName: linked.holder_name,
    });

    this.pspBackend.db
      .prepare(
        `INSERT INTO customer_vpas (
          vpa, customer_id, linked_account_id, bank_id, account_number, holder_name, is_default, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        vpa,
        params.customerId,
        linked.id,
        linked.bank_id,
        linked.account_number,
        linked.holder_name,
        isDefault,
        nowIso
      );

    return this.pspBackend.db
      .prepare(`SELECT * FROM customer_vpas WHERE vpa = ?`)
      .get(vpa) as unknown as CustomerVpaRecord;
  }

  /**
   * Directory lookup returning verified payee display name & masked account (Rule 10).
   */
  public lookupVpaDirectory(vpa: string): {
    vpa: string;
    holderName: string;
    accountMasked: string;
  } {
    const clean = vpa.trim().toLowerCase();
    for (const psp of this.allPsps) {
      const res = psp.lookupVpaExternal(clean);
      if (res) {
        return {
          vpa: res.vpa,
          holderName: res.holder_name,
          accountMasked: res.account_number_masked,
        };
      }
    }
    throw Object.assign(new Error(`VPA "${clean}" not found in directory`), {
      statusCode: 404,
    });
  }

  public lookupByMobile(mobileNumber: string): {
    vpa: string;
    holderName: string;
    accountMasked: string;
  } {
    const customer = this.pspBackend.getCustomerByMobile(mobileNumber.trim());
    if (!customer) {
      throw Object.assign(new Error(`No UPI user found for mobile "${mobileNumber}"`), {
        statusCode: 404,
      });
    }
    const row = this.pspBackend.db
      .prepare(
        `SELECT vpa FROM customer_vpas WHERE customer_id = ? ORDER BY is_default DESC, created_at ASC LIMIT 1`
      )
      .get(customer.id) as { vpa: string } | undefined;

    if (!row) {
      throw Object.assign(new Error(`Customer "${customer.id}" has no VPA`), {
        statusCode: 404,
      });
    }
    return this.lookupVpaDirectory(row.vpa);
  }

  /**
   * Resolves Bank Account + IFSC (`branchPrefix`) to a bank-rail VPA in the PSP directory.
   */
  public resolveBankAccountIfscTarget(params: {
    accountNumber: string;
    ifscCode: string;
  }): { vpa: string; holderName: string } {
    const ifscUpper = params.ifscCode.trim().toUpperCase();
    for (const bankId of ["BANKA", "BANKB", "BANKC"]) {
      const bankList = this.pspBackend.listBanks();
      const match = bankList.find((b) => ifscUpper.startsWith(b.branchPrefix));
      if (match) {
        const discovered = this.pspBackend.discoverAccountsAtBank({
          bankId: match.bankId,
          holderNameQuery: "",
        });
        const acct = discovered.find((a) => a.accountNumber === params.accountNumber.trim());
        if (acct) {
          const syntheticVpa = `${acct.accountNumber}.${ifscUpper.toLowerCase()}@${this.p1Psp.config.handleSuffix}`;
          if (!this.p1Psp.lookupVpaExternal(syntheticVpa)) {
            this.p1Psp.registerVpa({
              vpa: syntheticVpa,
              bankId: match.bankId,
              accountNumber: acct.accountNumber,
              holderName: acct.holderName,
            });
          }
          return { vpa: syntheticVpa, holderName: acct.holderName };
        }
      }
      void bankId;
    }
    throw Object.assign(
      new Error(`Account "${params.accountNumber}" with IFSC "${params.ifscCode}" not found`),
      { statusCode: 404 }
    );
  }

  /**
   * Executes any of the 4 Pay Paths (`QR`, `VPA`, `MOBILE`, `BANK_IFSC`) with:
   * - Ed25519 device signature verification
   * - 24h new-device cooling cap check
   * - Client-generated `clientTxnId` idempotency
   * - Salted nonce PIN verification
   */
  public async initiatePay(params: {
    customerId: string;
    deviceId: string;
    timestampMs: number;
    nonce: string;
    payloadJson: string;
    signatureBase64: string;
    clientTxnId: string;
    payPath: PayPathType;
    payerVpa: string;
    qrUri?: string;
    payeeVpa?: string;
    payeeMobile?: string;
    payeeAccountNumber?: string;
    payeeIfsc?: string;
    amountPaise?: number;
    note?: string;
    rawPin: string;
    txnNonce: string;
    clientPinProofHex: string;
    now?: Date;
  }): Promise<PspTransactionRecord> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();

    // 1. Verify Ed25519 device signature, replay guard & customer ownership
    const verified = this.pspBackend.verifyDeviceSignedRequest({
      deviceId: params.deviceId,
      timestampMs: params.timestampMs,
      nonce: params.nonce,
      payload: params.payloadJson,
      signatureBase64: params.signatureBase64,
      now,
    });
    if (verified.customer.id !== params.customerId) {
      throw Object.assign(
        new Error("Forbidden (HTTP 403): Signed device does not belong to customerId"),
        { statusCode: 403 }
      );
    }
    const ownedVpa = this.pspBackend.db
      .prepare(`SELECT 1 FROM customer_vpas WHERE customer_id = ? AND vpa = ?`)
      .get(verified.customer.id, params.payerVpa.trim().toLowerCase());
    if (!ownedVpa) {
      throw Object.assign(
        new Error(`Forbidden (HTTP 403): Payer VPA "${params.payerVpa}" is not owned by authenticated customer`),
        { statusCode: 403 }
      );
    }

    // 2. Idempotency by client_txn_id (safe retries after airplane mode / app restart!)
    const existing = this.getTransactionByClientId(params.clientTxnId);
    if (existing && existing.status !== "PENDING") {
      return existing;
    }

    // 3. Resolve target payee across the 4 Pay Paths
    let resolvedPayeeVpa = "";
    let resolvedPayeeName = "";
    let resolvedAmountPaise = params.amountPaise ?? 0;
    let resolvedNote = params.note ?? null;

    if (params.payPath === "QR") {
      const parsed = parseUpiQrUri(params.qrUri ?? "");
      const dir = this.lookupVpaDirectory(parsed.payeeVpa);
      resolvedPayeeVpa = dir.vpa;
      resolvedPayeeName = dir.holderName;
      if (parsed.amountPaise !== null) {
        resolvedAmountPaise = parsed.amountPaise;
      }
      resolvedNote = parsed.note ?? resolvedNote;
    } else if (params.payPath === "VPA") {
      const dir = this.lookupVpaDirectory(params.payeeVpa ?? "");
      resolvedPayeeVpa = dir.vpa;
      resolvedPayeeName = dir.holderName;
    } else if (params.payPath === "MOBILE") {
      const dir = this.lookupByMobile(params.payeeMobile ?? "");
      resolvedPayeeVpa = dir.vpa;
      resolvedPayeeName = dir.holderName;
    } else if (params.payPath === "BANK_IFSC") {
      const target = this.resolveBankAccountIfscTarget({
        accountNumber: params.payeeAccountNumber ?? "",
        ifscCode: params.payeeIfsc ?? "",
      });
      resolvedPayeeVpa = target.vpa;
      resolvedPayeeName = target.holderName;
    }

    assertPositivePaise(resolvedAmountPaise, "amountPaise");

    // 4. Enforce 24h new-device cooling cap
    this.pspBackend.checkNewDeviceCoolingLimit(
      params.customerId,
      resolvedAmountPaise,
      now
    );

    // 5. Verify per-transaction salted nonce PIN proof
    const pinRes = this.pspBackend.verifyPinWithNonce({
      customerId: params.customerId,
      txnNonce: params.txnNonce,
      clientProofHex: params.clientPinProofHex,
      now,
    });
    if (!pinRes.valid) {
      throw Object.assign(
        new Error(`Wrong UPI PIN (${pinRes.remainingAttempts} attempts remaining)`),
        { statusCode: 401 }
      );
    }

    // 6. Persist PENDING on PSP server before calling Switch
    if (!existing) {
      this.pspBackend.db
        .prepare(
          `INSERT INTO psp_transactions (
            client_txn_id, customer_id, pay_path, payer_vpa, payee_vpa, payee_display_name,
            amount_paise, note, status, honest_status_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'PENDING', ?, ?, ?)`
        )
        .run(
          params.clientTxnId,
          params.customerId,
          params.payPath,
          params.payerVpa.toLowerCase(),
          resolvedPayeeVpa,
          resolvedPayeeName,
          resolvedAmountPaise,
          resolvedNote,
          "Payment submitted. Awaiting bank confirmation.",
          nowIso,
          nowIso
        );
    }

    // Simulate airplane mode / network drop after client initiated request
    if (this.simulateAirplaneMode) {
      throw new NetworkDropSimulatedError();
    }

    // 7. Route through Project 1 CentralSwitch using deterministic transactionId = clientTxnId
    const env = this.p1Psp.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: params.clientTxnId,
      payerVpa: params.payerVpa.toLowerCase(),
      payeeVpa: resolvedPayeeVpa,
      amountPaise: resolvedAmountPaise,
      now,
    });

    const switchRes = await this.p1Switch.handlePay({
      envelope: env,
      rawPin: params.rawPin,
      now,
    });

    const finalStatus: PspTransactionRecord["status"] =
      switchRes.transaction.state === "SUCCESS"
        ? "SUCCESS"
        : switchRes.transaction.state === "REVERSED"
          ? "REVERSED"
          : switchRes.transaction.state === "FAILED"
            ? "FAILED"
            : "PENDING";

    const honestMsg =
      finalStatus === "SUCCESS"
        ? `Paid ₹${(resolvedAmountPaise / 100).toFixed(2)} to ${resolvedPayeeName}`
        : finalStatus === "REVERSED"
          ? "Payment reversed to your bank account."
          : finalStatus === "FAILED"
            ? `Payment failed (ISO ${switchRes.envelope.response_code ?? "96"}).`
            : "Payment is still pending confirmation from your bank. Do NOT retry yet.";

    this.pspBackend.db
      .prepare(
        `UPDATE psp_transactions
         SET status = ?, switch_rrn = ?, iso_response_code = ?, honest_status_message = ?, updated_at = ?
         WHERE client_txn_id = ?`
      )
      .run(
        finalStatus,
        switchRes.transaction.rrn,
        switchRes.envelope.response_code ?? null,
        honestMsg,
        now.toISOString(),
        params.clientTxnId
      );

    return this.getTransactionByClientId(params.clientTxnId)!;
  }

  /**
   * Queries status by `client_txn_id` when the mobile app recovers from airplane mode or restart.
   */
  public getStatusByClientTxnId(clientTxnId: string): PspTransactionRecord {
    if (this.simulateAirplaneMode) {
      throw new NetworkDropSimulatedError();
    }
    const row = this.getTransactionByClientId(clientTxnId);
    if (!row) {
      throw Object.assign(new Error(`Transaction "${clientTxnId}" not found`), {
        statusCode: 404,
      });
    }
    return row;
  }

  public getTransactionByClientId(clientTxnId: string): PspTransactionRecord | undefined {
    return this.pspBackend.db
      .prepare(`SELECT * FROM psp_transactions WHERE client_txn_id = ?`)
      .get(clientTxnId) as unknown as PspTransactionRecord | undefined;
  }
}

/**
 * Persistent Mobile App Local Store (SQLite-backed so it survives app kill / restart)
 * implementing the Honest Pending UX pattern.
 */
export class ConsumerAppLocalStore {
  private readonly db: DatabaseSync;

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS local_pending_txns (
        client_txn_id TEXT PRIMARY KEY,
        payee_label TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'SUCCESS', 'FAILED', 'REVERSED')),
        honest_banner TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  public recordLocalPending(params: {
    clientTxnId: string;
    payeeLabel: string;
    amountPaise: number;
    now?: Date;
  }): void {
    const nowIso = (params.now ?? new Date()).toISOString();
    this.db
      .prepare(
        `INSERT OR IGNORE INTO local_pending_txns (
          client_txn_id, payee_label, amount_paise, status, honest_banner, updated_at
        ) VALUES (?, ?, ?, 'PENDING', ?, ?)`
      )
      .run(
        params.clientTxnId,
        params.payeeLabel,
        params.amountPaise,
        "Payment pending bank confirmation — do NOT pay again until resolved.",
        nowIso
      );
  }

  public async sendWithHonestPending(params: {
    clientTxnId: string;
    payeeLabel: string;
    amountPaise: number;
    executeRemote: () => Promise<PspTransactionRecord>;
  }): Promise<{
    clientTxnId: string;
    status: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
    honestBanner: string;
  }> {
    this.recordLocalPending({
      clientTxnId: params.clientTxnId,
      payeeLabel: params.payeeLabel,
      amountPaise: params.amountPaise,
    });

    try {
      const res = await params.executeRemote();
      this.db
        .prepare(
          `UPDATE local_pending_txns
           SET status = ?, honest_banner = ?, updated_at = ?
           WHERE client_txn_id = ?`
        )
        .run(res.status, res.honest_status_message, res.updated_at, params.clientTxnId);
      return {
        clientTxnId: params.clientTxnId,
        status: res.status,
        honestBanner: res.honest_status_message,
      };
    } catch (err) {
      if (err instanceof NetworkDropSimulatedError) {
        // Honest Pending UX: NEVER fake success or failure on network drop!
        const row = this.getLocalTxn(params.clientTxnId)!;
        return {
          clientTxnId: row.client_txn_id,
          status: "PENDING",
          honestBanner: row.honest_banner,
        };
      }
      throw err;
    }
  }

  /**
   * Called after app restart / network reconnect to synchronize all locally PENDING transactions.
   */
  public syncPendingTransactions(payEngine: ConsumerPayEngine): Array<{
    clientTxnId: string;
    status: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
    honestBanner: string;
  }> {
    const pending = this.db
      .prepare(`SELECT client_txn_id FROM local_pending_txns WHERE status = 'PENDING'`)
      .all() as Array<{ client_txn_id: string }>;

    const updated: Array<{
      clientTxnId: string;
      status: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
      honestBanner: string;
    }> = [];

    for (const row of pending) {
      const remote = payEngine.getStatusByClientTxnId(row.client_txn_id);
      this.db
        .prepare(
          `UPDATE local_pending_txns
           SET status = ?, honest_banner = ?, updated_at = ?
           WHERE client_txn_id = ?`
        )
        .run(remote.status, remote.honest_status_message, remote.updated_at, row.client_txn_id);
      updated.push({
        clientTxnId: row.client_txn_id,
        status: remote.status,
        honestBanner: remote.honest_status_message,
      });
    }
    return updated;
  }

  public getLocalTxn(clientTxnId: string): {
    client_txn_id: string;
    payee_label: string;
    amount_paise: number;
    status: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
    honest_banner: string;
  } | undefined {
    return this.db
      .prepare(`SELECT * FROM local_pending_txns WHERE client_txn_id = ?`)
      .get(clientTxnId) as
      | {
          client_txn_id: string;
          payee_label: string;
          amount_paise: number;
          status: "PENDING" | "SUCCESS" | "FAILED" | "REVERSED";
          honest_banner: string;
        }
      | undefined;
  }
}

export function buildSignedPayArgs(params: {
  deviceId: string;
  privateKeyPem: string;
  payload: Record<string, unknown>;
  nowMs?: number;
}) {
  const timestampMs = params.nowMs ?? Date.now();
  const nonce = crypto.randomBytes(8).toString("hex");
  const payloadJson = JSON.stringify(params.payload);
  const signatureBase64 = signDevicePayload({
    deviceId: params.deviceId,
    timestampMs,
    nonce,
    payload: payloadJson,
    privateKeyPem: params.privateKeyPem,
  });
  return { timestampMs, nonce, payloadJson, signatureBase64 };
}
