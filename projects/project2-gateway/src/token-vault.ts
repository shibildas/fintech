import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { RoutingPrefixTrie } from "../../../packages/core/src/index.ts";

/**
 * Project 2 — Isolated PCI Token Vault Service (Requirements 15, 16, 17, 18 & NFR 4, Pages 14 & 17)
 *
 * Strict PCI-DSS Isolation Boundary:
 * - Runs on its own dedicated database (`vaultDb`), completely separate from the Gateway database.
 * - Encrypts card numbers (PANs) at rest using AES-256-GCM with a key kept in runtime configuration,
 *   never stored in any database table.
 * - Exposes ONLY `tokenize`, `detokenize` (callable ONLY with the internal Acquirer Adapter credential
 *   AND matching `merchantId`), and `deleteToken`.
 * - Includes the automated "Grep Test" verifier (Req 18 & Acceptance Test 6) that scans all Gateway DB tables
 *   and structured logs after 100 card payments to prove zero raw PANs exist outside the vault.
 */

export type CardNetwork = "VISA" | "MASTERCARD" | "RUPAY" | "AMEX" | "UNKNOWN";

export interface PublicTokenMetadata {
  token: string;
  network: CardNetwork;
  issuer_bank: string;
  bin6: string; // First 6 digits for routing (Req 10); never the full PAN
  last_four: string;
  expiry: string; // MM/YY
  merchant_id: string;
  customer_reference: string | null;
  created_at: string;
}

export interface VaultConfig {
  encryptionKeyHex?: string; // 32-byte hex key (64 hex chars) kept in config, not DB
  adapterCredential?: string; // Internal credential required to call detokenize()
  dbPath?: string;
}

export class TokenVaultService {
  public readonly vaultDb: DatabaseSync;
  private readonly encryptionKey: Buffer;
  private readonly adapterCredential: string;
  private readonly binTrie = new RoutingPrefixTrie<{
    network: CardNetwork;
    issuerBank: string;
  }>();

  constructor(config?: VaultConfig) {
    this.vaultDb = new DatabaseSync(config?.dbPath ?? ":memory:");
    const hexKey =
      config?.encryptionKeyHex ??
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    this.encryptionKey = Buffer.from(hexKey, "hex");
    if (this.encryptionKey.length !== 32) {
      throw new Error("Vault AES-256-GCM encryption key must be 32 bytes (64 hex chars)");
    }
    this.adapterCredential =
      config?.adapterCredential ?? "INTERNAL_ACQUIRER_ADAPTER_SECRET_KEY";
    this.initSchema();
    this.seedBinTable();
  }

  private initSchema(): void {
    this.vaultDb.exec(`
      CREATE TABLE IF NOT EXISTS vault_tokens (
        token TEXT PRIMARY KEY,
        encrypted_card_hex TEXT NOT NULL,
        iv_hex TEXT NOT NULL,
        auth_tag_hex TEXT NOT NULL,
        network TEXT NOT NULL,
        issuer_bank TEXT NOT NULL,
        bin6 TEXT NOT NULL,
        last_four TEXT NOT NULL,
        expiry TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        customer_reference TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_vault_merchant_customer
        ON vault_tokens(merchant_id, customer_reference);
    `);
  }

  private seedBinTable(): void {
    this.binTrie.insert("4", { network: "VISA", issuerBank: "GENERIC_VISA" });
    this.binTrie.insert("411111", { network: "VISA", issuerBank: "HDFC" });
    this.binTrie.insert("424242", { network: "VISA", issuerBank: "ICICI" });
    this.binTrie.insert("5", { network: "MASTERCARD", issuerBank: "GENERIC_MC" });
    this.binTrie.insert("555555", { network: "MASTERCARD", issuerBank: "SBI" });
    this.binTrie.insert("510510", { network: "MASTERCARD", issuerBank: "AXIS" });
    this.binTrie.insert("60", { network: "RUPAY", issuerBank: "NPCI_RUPAY" });
    this.binTrie.insert("6521", { network: "RUPAY", issuerBank: "SBI_RUPAY" });
    this.binTrie.insert("37", { network: "AMEX", issuerBank: "AMEX_INDIA" });
  }

  /**
   * Requirement 15 & Interface `POST /tokens`:
   * Browser checkout page sends card number directly to the Vault;
   * Vault encrypts PAN at rest and returns ONLY the token, network, BIN6, last4, and expiry.
   */
  public tokenize(params: {
    cardNumber: string;
    expiry: string;
    merchantId: string;
    customerReference?: string | null;
    now?: Date;
  }): PublicTokenMetadata {
    const cleanPan = params.cardNumber.replace(/[\s-]/g, "");
    if (!/^\d{13,19}$/.test(cleanPan)) {
      throw new Error("Invalid card number format (must be 13-19 digits)");
    }
    if (!/^(0[1-9]|1[0-2])\/\d{2}$/.test(params.expiry.trim())) {
      throw new Error(`Invalid expiry format "${params.expiry}" (expected MM/YY)`);
    }

    const binMatch = this.binTrie.longestPrefixMatch(cleanPan);
    const network: CardNetwork = binMatch?.value.network ?? "UNKNOWN";
    const issuerBank = binMatch?.value.issuerBank ?? "OTHER_BANK";
    const bin6 = cleanPan.slice(0, 6);
    const lastFour = cleanPan.slice(-4);

    // Encrypt PAN at rest using AES-256-GCM
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const encrypted = Buffer.concat([
      cipher.update(cleanPan, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const token = `tok_${crypto.randomBytes(12).toString("hex")}`;
    const nowIso = (params.now ?? new Date()).toISOString();

    this.vaultDb
      .prepare(
        `INSERT INTO vault_tokens (
          token, encrypted_card_hex, iv_hex, auth_tag_hex,
          network, issuer_bank, bin6, last_four, expiry,
          merchant_id, customer_reference, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        token,
        encrypted.toString("hex"),
        iv.toString("hex"),
        authTag.toString("hex"),
        network,
        issuerBank,
        bin6,
        lastFour,
        params.expiry.trim(),
        params.merchantId,
        params.customerReference ?? null,
        nowIso
      );

    return {
      token,
      network,
      issuer_bank: issuerBank,
      bin6,
      last_four: lastFour,
      expiry: params.expiry.trim(),
      merchant_id: params.merchantId,
      customer_reference: params.customerReference ?? null,
      created_at: nowIso,
    };
  }

  /**
   * Requirements 16 & 17 & Interface `POST /tokens/{token}/detokenize` (Internal only):
   * - Verifies that the caller holds the internal `adapterCredential`.
   * - Enforces that `merchantId` matches the merchant that created the token (Req 17:
   *   "a merchant can only use tokens it created").
   */
  public detokenize(params: {
    token: string;
    merchantId: string;
    adapterCredential: string;
  }): {
    cardNumber: string;
    expiry: string;
    network: CardNetwork;
    issuer_bank: string;
    bin6: string;
    last_four: string;
  } {
    if (params.adapterCredential !== this.adapterCredential) {
      throw Object.assign(
        new Error(
          "Req 16 Violation (HTTP 403): Unauthorized detokenize call — only the Gateway Acquirer Adapter may detokenize"
        ),
        { statusCode: 403 }
      );
    }

    const row = this.vaultDb
      .prepare(`SELECT * FROM vault_tokens WHERE token = ?`)
      .get(params.token) as
      | {
          token: string;
          encrypted_card_hex: string;
          iv_hex: string;
          auth_tag_hex: string;
          network: CardNetwork;
          issuer_bank: string;
          bin6: string;
          last_four: string;
          expiry: string;
          merchant_id: string;
        }
      | undefined;

    if (!row) {
      throw Object.assign(new Error(`Token "${params.token}" not found`), {
        statusCode: 404,
      });
    }

    // Requirement 17: A merchant can only use tokens it created!
    if (row.merchant_id !== params.merchantId) {
      throw Object.assign(
        new Error(
          `Req 17 Violation (HTTP 403): Merchant "${params.merchantId}" cannot use token created by "${row.merchant_id}"`
        ),
        { statusCode: 403 }
      );
    }

    const decipher = crypto.createDecipheriv(
      "aes-256-gcm",
      this.encryptionKey,
      Buffer.from(row.iv_hex, "hex")
    );
    decipher.setAuthTag(Buffer.from(row.auth_tag_hex, "hex"));
    const decryptedPan = Buffer.concat([
      decipher.update(Buffer.from(row.encrypted_card_hex, "hex")),
      decipher.final(),
    ]).toString("utf8");

    return {
      cardNumber: decryptedPan,
      expiry: row.expiry,
      network: row.network,
      issuer_bank: row.issuer_bank,
      bin6: row.bin6,
      last_four: row.last_four,
    };
  }

  public getPublicTokenMetadata(
    token: string,
    merchantId: string
  ): PublicTokenMetadata {
    const row = this.vaultDb
      .prepare(
        `SELECT token, network, issuer_bank, bin6, last_four, expiry, merchant_id, customer_reference, created_at
         FROM vault_tokens WHERE token = ?`
      )
      .get(token) as unknown as PublicTokenMetadata | undefined;

    if (!row) {
      throw Object.assign(new Error(`Token "${token}" not found`), {
        statusCode: 404,
      });
    }
    if (row.merchant_id !== merchantId) {
      throw Object.assign(
        new Error(
          `Req 17 Violation (HTTP 403): Merchant "${merchantId}" does not own token "${token}"`
        ),
        { statusCode: 403 }
      );
    }
    return row;
  }

  /**
   * Requirement 17: Lists saved card tokens for `(merchantId, customerReference)`.
   */
  public listCustomerSavedTokens(
    merchantId: string,
    customerReference: string
  ): PublicTokenMetadata[] {
    return this.vaultDb
      .prepare(
        `SELECT token, network, issuer_bank, bin6, last_four, expiry, merchant_id, customer_reference, created_at
         FROM vault_tokens
         WHERE merchant_id = ? AND customer_reference = ?
         ORDER BY created_at DESC`
      )
      .all(merchantId, customerReference) as unknown as PublicTokenMetadata[];
  }

  public deleteToken(token: string, merchantId: string): boolean {
    const res = this.vaultDb
      .prepare(`DELETE FROM vault_tokens WHERE token = ? AND merchant_id = ?`)
      .run(token, merchantId);
    return res.changes > 0;
  }
}

/**
 * Requirement 18 & Acceptance Test 6 ("The Grep Test"):
 * Scans every table and row in the Gateway SQLite database AND all structured logs
 * to verify that NONE of the full card numbers (`rawPans`) appear anywhere outside the vault,
 * and even inside the vault DB, no raw unencrypted PAN appears in plaintext!
 */
export function runPciGrepTest(params: {
  gatewayDb: DatabaseSync;
  vaultDb: DatabaseSync;
  structuredLogs: unknown[];
  rawPansUsed: string[];
}): { passed: boolean; leaksFound: string[] } {
  const leaksFound: string[] = [];
  const cleanPans = params.rawPansUsed.map((p) => p.replace(/[\s-]/g, ""));

  // 1. Grep all non-vault tables in gatewayDb
  const gatewayTables = params.gatewayDb
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`
    )
    .all() as Array<{ name: string }>;

  for (const { name } of gatewayTables) {
    const rows = params.gatewayDb.prepare(`SELECT * FROM ${name}`).all();
    const dumped = JSON.stringify(rows);
    for (const pan of cleanPans) {
      if (dumped.includes(pan)) {
        leaksFound.push(`Gateway DB table "${name}" leaked raw PAN ${pan}`);
      }
    }
  }

  // 2. Grep vaultDb to prove PANs are encrypted at rest (never stored in plaintext)
  const vaultRows = params.vaultDb.prepare(`SELECT * FROM vault_tokens`).all();
  const vaultDumped = JSON.stringify(vaultRows);
  for (const pan of cleanPans) {
    if (vaultDumped.includes(pan)) {
      leaksFound.push(`Vault DB stored unencrypted plaintext PAN ${pan}`);
    }
  }

  // 3. Grep all structured logs
  const logsDumped = JSON.stringify(params.structuredLogs);
  for (const pan of cleanPans) {
    if (logsDumped.includes(pan)) {
      leaksFound.push(`Structured logs leaked raw PAN ${pan}`);
    }
  }

  return {
    passed: leaksFound.length === 0,
    leaksFound,
  };
}
