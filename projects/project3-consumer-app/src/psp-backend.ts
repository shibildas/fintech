import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  AuditLogger,
  DeviceRequestReplayGuard,
  verifyDeviceSignature,
  maskAccountNumber,
} from "@fintech/core";
import type { BankCoreSimulator } from "@fintech/project1-switch";

/**
 * Project 3 (Day 15) — TPAP/PSP Backend:
 * - Mobile Onboarding + Mock SMS OTP
 * - Asymmetric Ed25519 Device Binding (1 active device per customer; 2nd-device takeover
 *   retires old device & triggers 24-hour new-device cooling cap)
 * - Salted Per-Transaction Nonce PIN Hashing + 5-Wrong-PIN 30m Lock
 * - Bank Core Account Discovery & Linking
 */

export const NEW_DEVICE_COOLING_MS = 24 * 60 * 60 * 1000;
export const NEW_DEVICE_COOLING_CAP_PAISE = 500_000; // ₹5,000.00 during first 24h
export const PIN_LOCK_DURATION_MS = 30 * 60 * 1000;
export const MAX_WRONG_PIN_STRIKES = 5;

export interface CustomerRecord {
  id: string;
  mobile_number: string;
  full_name: string;
  otp_verified: number;
  pin_salt: string | null;
  pin_hash: string | null;
  failed_pin_attempts: number;
  pin_locked_until: string | null;
  active_device_id: string | null;
  new_device_cooling_until: string | null;
  created_at: string;
}

export interface BoundDeviceRecord {
  device_id: string;
  customer_id: string;
  public_key_pem: string;
  device_model: string;
  status: "ACTIVE" | "RETIRED";
  bound_at: string;
  retired_at: string | null;
}

export interface LinkedBankAccountRecord {
  id: string;
  customer_id: string;
  bank_id: string;
  bank_name: string;
  branch_code: string;
  account_number: string;
  account_number_masked: string;
  holder_name: string;
  is_primary: number;
  linked_at: string;
}

export class ConsumerPspBackend {
  public readonly db: DatabaseSync;
  public readonly audit: AuditLogger;
  public readonly replayGuard = new DeviceRequestReplayGuard();
  private readonly banks = new Map<string, BankCoreSimulator>();
  private readonly pendingOtps = new Map<string, string>(); // mobile -> otp

  constructor(dbPath = ":memory:") {
    this.db = new DatabaseSync(dbPath);
    this.audit = new AuditLogger(this.db);
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        mobile_number TEXT UNIQUE NOT NULL,
        full_name TEXT NOT NULL,
        otp_verified INTEGER NOT NULL DEFAULT 0,
        pin_salt TEXT,
        pin_hash TEXT,
        failed_pin_attempts INTEGER NOT NULL DEFAULT 0,
        pin_locked_until TEXT,
        active_device_id TEXT,
        new_device_cooling_until TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bound_devices (
        device_id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        public_key_pem TEXT NOT NULL,
        device_model TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('ACTIVE', 'RETIRED')),
        bound_at TEXT NOT NULL,
        retired_at TEXT
      );

      CREATE TABLE IF NOT EXISTS linked_accounts (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL,
        bank_id TEXT NOT NULL,
        bank_name TEXT NOT NULL,
        branch_code TEXT NOT NULL,
        account_number TEXT NOT NULL,
        account_number_masked TEXT NOT NULL,
        holder_name TEXT NOT NULL,
        is_primary INTEGER NOT NULL DEFAULT 0,
        linked_at TEXT NOT NULL,
        UNIQUE (customer_id, bank_id, account_number)
      );
    `);
  }

  public registerBank(bank: BankCoreSimulator): void {
    this.banks.set(bank.config.bankId, bank);
  }

  public listBanks(): Array<{ bankId: string; bankName: string; branchPrefix: string }> {
    return Array.from(this.banks.values()).map((b) => ({
      bankId: b.config.bankId,
      bankName: b.config.bankName,
      branchPrefix: b.config.branchPrefix,
    }));
  }

  /**
   * Step 1: Mobile signup + mock SMS OTP issuance.
   */
  public signup(params: { mobileNumber: string; fullName: string; now?: Date }): {
    customer: CustomerRecord;
    mockSmsOtp: string;
  } {
    const cleanMobile = params.mobileNumber.trim();
    if (!/^\d{10}$/.test(cleanMobile)) {
      throw new Error(`Invalid 10-digit mobile number "${params.mobileNumber}"`);
    }

    const existing = this.getCustomerByMobile(cleanMobile);
    if (existing) {
      const otp = "123456";
      this.pendingOtps.set(cleanMobile, otp);
      return { customer: existing, mockSmsOtp: otp };
    }

    const id = `cust_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = (params.now ?? new Date()).toISOString();

    this.db
      .prepare(
        `INSERT INTO customers (id, mobile_number, full_name, otp_verified, created_at)
         VALUES (?, ?, ?, 0, ?)`
      )
      .run(id, cleanMobile, params.fullName.trim(), nowIso);

    const otp = "123456";
    this.pendingOtps.set(cleanMobile, otp);

    return { customer: this.getCustomer(id)!, mockSmsOtp: otp };
  }

  public verifySmsOtp(mobileNumber: string, otp: string): CustomerRecord {
    const expected = this.pendingOtps.get(mobileNumber.trim());
    if (!expected || expected !== otp) {
      throw Object.assign(new Error("Invalid SMS OTP"), { statusCode: 401 });
    }
    this.pendingOtps.delete(mobileNumber.trim());
    this.db
      .prepare(`UPDATE customers SET otp_verified = 1 WHERE mobile_number = ?`)
      .run(mobileNumber.trim());
    return this.getCustomerByMobile(mobileNumber.trim())!;
  }

  /**
   * Step 2: Asymmetric Device Binding (1 active device per customer).
   * - If the customer already has an active device (2nd-device takeover), retires the old device
   *   and activates the 24-hour new-device cooling cap (`NEW_DEVICE_COOLING_CAP_PAISE`).
   */
  public bindDevice(params: {
    customerId: string;
    deviceId: string;
    publicKeyPem: string;
    deviceModel: string;
    now?: Date;
  }): {
    device: BoundDeviceRecord;
    retiredPreviousDeviceId: string | null;
    newDeviceCoolingUntil: string | null;
  } {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const customer = this.getCustomer(params.customerId);
    if (!customer) {
      throw new Error(`Customer "${params.customerId}" not found`);
    }
    if (customer.otp_verified !== 1) {
      throw Object.assign(new Error("Customer mobile OTP must be verified before device binding"), {
        statusCode: 403,
      });
    }

    let retiredPreviousDeviceId: string | null = null;
    let coolingUntilIso: string | null = customer.new_device_cooling_until;

    if (customer.active_device_id && customer.active_device_id !== params.deviceId) {
      retiredPreviousDeviceId = customer.active_device_id;
      this.db
        .prepare(`UPDATE bound_devices SET status = 'RETIRED', retired_at = ? WHERE device_id = ?`)
        .run(nowIso, retiredPreviousDeviceId);

      // 2nd-device takeover triggers 24-hour cooling cap
      coolingUntilIso = new Date(now.getTime() + NEW_DEVICE_COOLING_MS).toISOString();
    }

    this.db
      .prepare(
        `INSERT INTO bound_devices (
          device_id, customer_id, public_key_pem, device_model, status, bound_at, retired_at
        ) VALUES (?, ?, ?, ?, 'ACTIVE', ?, NULL)
        ON CONFLICT(device_id) DO UPDATE SET
          public_key_pem = excluded.public_key_pem,
          device_model = excluded.device_model,
          status = 'ACTIVE',
          bound_at = excluded.bound_at,
          retired_at = NULL`
      )
      .run(params.deviceId, params.customerId, params.publicKeyPem, params.deviceModel, nowIso);

    this.db
      .prepare(
        `UPDATE customers SET active_device_id = ?, new_device_cooling_until = ? WHERE id = ?`
      )
      .run(params.deviceId, coolingUntilIso, params.customerId);

    this.audit.record({
      actorId: params.customerId,
      actorRole: "customer",
      action: retiredPreviousDeviceId ? "DEVICE_TAKEOVER_BOUND" : "DEVICE_BOUND",
      entityType: "BoundDevice",
      entityId: params.deviceId,
      oldValue: retiredPreviousDeviceId ? { active_device_id: retiredPreviousDeviceId } : undefined,
      newValue: {
        active_device_id: params.deviceId,
        new_device_cooling_until: coolingUntilIso,
      },
      requestId: `REQ-DEV-${params.deviceId}`,
      nowIso,
    });

    return {
      device: this.getDevice(params.deviceId)!,
      retiredPreviousDeviceId,
      newDeviceCoolingUntil: coolingUntilIso,
    };
  }

  /**
   * Verifies every device-signed API request using Ed25519 + monotonic timestamp/nonce replay guard.
   */
  public verifyDeviceSignedRequest(params: {
    deviceId: string;
    timestampMs: number;
    nonce: string;
    payload: string;
    signatureBase64: string;
    now?: Date;
  }): { customer: CustomerRecord; device: BoundDeviceRecord } {
    const nowMs = (params.now ?? new Date()).getTime();
    const device = this.getDevice(params.deviceId);
    if (!device) {
      throw Object.assign(new Error(`Unknown device "${params.deviceId}"`), { statusCode: 401 });
    }
    if (device.status !== "ACTIVE") {
      throw Object.assign(
        new Error(`Device "${params.deviceId}" is ${device.status} (retired by takeover)`),
        { statusCode: 401 }
      );
    }

    const replayCheck = this.replayGuard.validateAndRecord({
      deviceId: params.deviceId,
      timestampMs: params.timestampMs,
      nonce: params.nonce,
      nowMs,
    });
    if (!replayCheck.valid) {
      throw Object.assign(
        new Error(`Device replay/timestamp check failed: ${replayCheck.reason}`),
        { statusCode: 401 }
      );
    }

    const sigValid = verifyDeviceSignature({
      deviceId: params.deviceId,
      timestampMs: params.timestampMs,
      nonce: params.nonce,
      payload: params.payload,
      signatureBase64: params.signatureBase64,
      publicKeyPem: device.public_key_pem,
    });
    if (!sigValid) {
      throw Object.assign(new Error("Invalid Ed25519 device signature"), { statusCode: 401 });
    }

    return { customer: this.getCustomer(device.customer_id)!, device };
  }

  /**
   * Checks whether the customer is currently inside the 24h new-device cooling window.
   */
  public checkNewDeviceCoolingLimit(
    customerId: string,
    amountPaise: number,
    now = new Date()
  ): { inCoolingWindow: boolean; maxAllowedPaise: number | null } {
    const customer = this.getCustomer(customerId);
    if (!customer || !customer.new_device_cooling_until) {
      return { inCoolingWindow: false, maxAllowedPaise: null };
    }
    const inCooling = now.getTime() < Date.parse(customer.new_device_cooling_until);
    if (inCooling && amountPaise > NEW_DEVICE_COOLING_CAP_PAISE) {
      throw Object.assign(
        new Error(`24h new-device cooling cap: max ₹${NEW_DEVICE_COOLING_CAP_PAISE / 100} allowed`),
        { statusCode: 403 }
      );
    }
    return {
      inCoolingWindow: inCooling,
      maxAllowedPaise: inCooling ? NEW_DEVICE_COOLING_CAP_PAISE : null,
    };
  }

  /**
   * Step 3: Salted UPI PIN setup & per-transaction nonce verification with 5-strike 30m lock.
   */
  public setPin(customerId: string, rawPin: string): void {
    if (!/^\d{4,6}$/.test(rawPin)) {
      throw new Error("UPI PIN must be 4 to 6 digits");
    }
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.createHash("sha256").update(`${salt}:${rawPin}`).digest("hex");

    this.db
      .prepare(
        `UPDATE customers
         SET pin_salt = ?, pin_hash = ?, failed_pin_attempts = 0, pin_locked_until = NULL
         WHERE id = ?`
      )
      .run(salt, hash, customerId);
  }

  /**
   * Generates a per-transaction PIN nonce challenge and verifies `HMAC(pin_hash, nonce)`.
   */
  public issuePinChallengeNonce(): string {
    return crypto.randomBytes(16).toString("hex");
  }

  public computeClientNoncePinProof(params: {
    customerId: string;
    rawPin: string;
    txnNonce: string;
  }): string {
    const customer = this.getCustomer(params.customerId);
    if (!customer?.pin_salt) {
      throw new Error("Customer PIN is not configured");
    }
    const pinHash = crypto
      .createHash("sha256")
      .update(`${customer.pin_salt}:${params.rawPin}`)
      .digest("hex");
    return crypto.createHmac("sha256", params.txnNonce).update(pinHash).digest("hex");
  }

  public verifyPinWithNonce(params: {
    customerId: string;
    txnNonce: string;
    clientProofHex: string;
    now?: Date;
  }): { valid: boolean; lockedUntil: string | null; remainingAttempts: number } {
    const now = params.now ?? new Date();
    const customer = this.getCustomer(params.customerId);
    if (!customer || !customer.pin_hash) {
      throw new Error("Customer PIN is not set");
    }

    if (customer.pin_locked_until && now.getTime() < Date.parse(customer.pin_locked_until)) {
      throw Object.assign(new Error(`PIN is locked until ${customer.pin_locked_until}`), {
        statusCode: 423,
      });
    }

    const expectedProof = crypto
      .createHmac("sha256", params.txnNonce)
      .update(customer.pin_hash)
      .digest("hex");

    const providedBuf = Buffer.from(params.clientProofHex, "hex");
    const expectedBuf = Buffer.from(expectedProof, "hex");
    const matches =
      providedBuf.length === expectedBuf.length && crypto.timingSafeEqual(providedBuf, expectedBuf);

    if (matches) {
      this.db
        .prepare(
          `UPDATE customers SET failed_pin_attempts = 0, pin_locked_until = NULL WHERE id = ?`
        )
        .run(customer.id);
      return { valid: true, lockedUntil: null, remainingAttempts: MAX_WRONG_PIN_STRIKES };
    }

    const nextStrikes = customer.failed_pin_attempts + 1;
    let lockedUntilIso: string | null = null;
    if (nextStrikes >= MAX_WRONG_PIN_STRIKES) {
      lockedUntilIso = new Date(now.getTime() + PIN_LOCK_DURATION_MS).toISOString();
    }

    this.db
      .prepare(`UPDATE customers SET failed_pin_attempts = ?, pin_locked_until = ? WHERE id = ?`)
      .run(nextStrikes, lockedUntilIso, customer.id);

    if (lockedUntilIso) {
      throw Object.assign(
        new Error(`5 wrong PIN attempts: locked for 30 minutes until ${lockedUntilIso}`),
        { statusCode: 423 }
      );
    }

    return {
      valid: false,
      lockedUntil: null,
      remainingAttempts: MAX_WRONG_PIN_STRIKES - nextStrikes,
    };
  }

  public opsUnlockPin(customerId: string, actorId = "ops-admin", now = new Date()): void {
    this.db
      .prepare(`UPDATE customers SET failed_pin_attempts = 0, pin_locked_until = NULL WHERE id = ?`)
      .run(customerId);
    this.audit.record({
      actorId,
      actorRole: "admin",
      action: "OPS_PIN_UNLOCK",
      entityType: "Customer",
      entityId: customerId,
      newValue: { failed_pin_attempts: 0, pin_locked_until: null },
      requestId: `REQ-UNLOCK-${customerId}`,
      nowIso: now.toISOString(),
    });
  }

  /**
   * Step 4: Discover & link bank accounts from registered BankCoreSimulators.
   */
  public discoverAccountsAtBank(params: { bankId: string; holderNameQuery: string }): Array<{
    bankId: string;
    bankName: string;
    branchCode: string;
    accountNumber: string;
    accountNumberMasked: string;
    holderName: string;
  }> {
    const bank = this.banks.get(params.bankId);
    if (!bank) {
      throw new Error(`Bank "${params.bankId}" not registered`);
    }
    const rows = bank.db
      .prepare(
        `SELECT account_number, holder_name FROM accounts WHERE LOWER(holder_name) LIKE LOWER(?)`
      )
      .all(`%${params.holderNameQuery.trim()}%`) as Array<{
      account_number: string;
      holder_name: string;
    }>;

    return rows.map((r) => ({
      bankId: bank.config.bankId,
      bankName: bank.config.bankName,
      branchCode: bank.config.branchPrefix,
      accountNumber: r.account_number,
      accountNumberMasked: maskAccountNumber(r.account_number),
      holderName: r.holder_name,
    }));
  }

  public linkBankAccount(params: {
    customerId: string;
    bankId: string;
    accountNumber: string;
    isPrimary?: boolean;
    now?: Date;
  }): LinkedBankAccountRecord {
    const bank = this.banks.get(params.bankId);
    if (!bank) {
      throw new Error(`Bank "${params.bankId}" not registered`);
    }
    const acct = bank.db
      .prepare(`SELECT account_number, holder_name FROM accounts WHERE account_number = ?`)
      .get(params.accountNumber) as { account_number: string; holder_name: string } | undefined;

    if (!acct) {
      throw new Error(`Account "${params.accountNumber}" not found at bank "${params.bankId}"`);
    }

    const existing = this.db
      .prepare(
        `SELECT * FROM linked_accounts
         WHERE customer_id = ? AND bank_id = ? AND account_number = ?`
      )
      .get(params.customerId, bank.config.bankId, acct.account_number) as unknown as
      LinkedBankAccountRecord | undefined;
    if (existing) {
      return existing;
    }

    const id = `lnk_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = (params.now ?? new Date()).toISOString();
    const isPrimary = params.isPrimary ? 1 : 0;

    if (isPrimary === 1) {
      this.db
        .prepare(`UPDATE linked_accounts SET is_primary = 0 WHERE customer_id = ?`)
        .run(params.customerId);
    }

    this.db
      .prepare(
        `INSERT INTO linked_accounts (
          id, customer_id, bank_id, bank_name, branch_code,
          account_number, account_number_masked, holder_name, is_primary, linked_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        params.customerId,
        bank.config.bankId,
        bank.config.bankName,
        bank.config.branchPrefix,
        acct.account_number,
        maskAccountNumber(acct.account_number),
        acct.holder_name,
        isPrimary,
        nowIso
      );

    return this.db
      .prepare(`SELECT * FROM linked_accounts WHERE id = ?`)
      .get(id) as unknown as LinkedBankAccountRecord;
  }

  public getCustomer(customerId: string): CustomerRecord | undefined {
    return this.db.prepare(`SELECT * FROM customers WHERE id = ?`).get(customerId) as unknown as
      CustomerRecord | undefined;
  }

  public getCustomerByMobile(mobileNumber: string): CustomerRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM customers WHERE mobile_number = ?`)
      .get(mobileNumber) as unknown as CustomerRecord | undefined;
  }

  public getDevice(deviceId: string): BoundDeviceRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM bound_devices WHERE device_id = ?`)
      .get(deviceId) as unknown as BoundDeviceRecord | undefined;
  }
}
