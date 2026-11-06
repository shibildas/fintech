import { assertPaiseInteger, assertPositivePaise, INR_CURRENCY_NUMERIC } from "./money.ts";

/**
 * Project 1 — Message format (modelled on ISO 8583), Pages 5–6.
 * Used for every request and response between PSP, Switch, and Bank.
 */

export type MTI =
  | "0200" // Financial request (pay, debit, credit)
  | "0210" // Financial response
  | "0420" // Reversal request
  | "0430" // Reversal response
  | "0100" // Enquiry request (balance enquiry, status check)
  | "0110"; // Enquiry response

export type ProcessingCode =
  | "PAY" // Push payment / financial debit-credit
  | "BAL" // Balance enquiry
  | "CHK" // Transaction status check (Requirement 7)
  | "REV" // Reversal (MTI 0420/0430)
  | "COL" // Collect (pull) request (Project 2/3)
  | "MND"; // Mandate execution (Project 4)

export type IsoResponseCode =
  | "00" // Approved
  | "51" // Insufficient funds
  | "91" // Bank unavailable
  | "68" // Timeout
  | "12" // Invalid transaction
  | "14" // Invalid VPA / unknown address
  | "55" // Wrong PIN
  | "61" // Limit exceeded
  | "96"; // System malfunction / rate limit overload

export const ISO_RESPONSE_CODE_MEANINGS: Record<IsoResponseCode, string> = {
  "00": "Approved",
  "51": "Insufficient funds",
  "91": "Bank unavailable",
  "68": "Timeout",
  "12": "Invalid transaction",
  "14": "Invalid VPA",
  "55": "Wrong PIN",
  "61": "Limit exceeded",
  "96": "System malfunction",
};

export interface Iso8583MessageEnvelope {
  mti: MTI;
  transaction_id: string;
  stan: string; // 6 digits, unique per originator per day
  rrn?: string; // 12 digits, minted by Switch on first receipt
  processing_code: ProcessingCode;
  amount: number; // Integer paise (0 allowed for BAL/CHK enquiries)
  currency: string; // ISO 4217 numeric, e.g., "356"
  transmission_time: string; // ISO 8601 timestamp with timezone
  payer_vpa: string;
  payee_vpa?: string;
  payer_psp_id?: string;
  payee_psp_id?: string;
  remitter_bank_id?: string;
  beneficiary_bank_id?: string;
  account_reference?: string; // Masked "XXXX4521" outside bank core
  response_code?: IsoResponseCode; // Present in response MTIs (0210, 0430, 0110)
  signature: string; // HMAC over body + timestamp
}

export class Iso8583ValidationError extends Error {
  public readonly responseCode: IsoResponseCode = "12";
  constructor(message: string) {
    super(message);
    this.name = "Iso8583ValidationError";
  }
}

const VALID_MTIS = new Set<MTI>(["0200", "0210", "0420", "0430", "0100", "0110"]);
const RESPONSE_MTIS = new Set<MTI>(["0210", "0430", "0110"]);
const VALID_PROCESSING_CODES = new Set<ProcessingCode>([
  "PAY",
  "BAL",
  "CHK",
  "REV",
  "COL",
  "MND",
]);

/**
 * Mints a standard 12-digit Retrieval Reference Number (RRN) in `YDDDHHSSSSSS` format:
 * - Y: last digit of year (e.g., '6' for 2026)
 * - DDD: 3-digit day of year (001-366)
 * - HH: 2-digit hour (00-23)
 * - SSSSSS: 6-digit STAN / sequence number
 */
export function mintRrn(stan: string, now: Date = new Date()): string {
  if (!/^\d{6}$/.test(stan)) {
    throw new Iso8583ValidationError(
      `STAN must be exactly 6 digits to mint RRN, received "${stan}"`
    );
  }
  const yearDigit = String(now.getUTCFullYear()).slice(-1);
  const startOfYear = Date.UTC(now.getUTCFullYear(), 0, 0);
  const diffMs = now.getTime() - startOfYear;
  const dayOfYear = Math.floor(diffMs / (1000 * 60 * 60 * 24));
  const ddd = String(dayOfYear).padStart(3, "0");
  const hh = String(now.getUTCHours()).padStart(2, "0");
  return `${yearDigit}${ddd}${hh}${stan}`;
}

/**
 * Formats a sequential number into a 6-digit STAN ("004512").
 */
export function formatStan(sequenceNumber: number): string {
  const normalized = ((sequenceNumber % 1000000) + 1000000) % 1000000;
  return String(normalized === 0 ? 1 : normalized).padStart(6, "0");
}

/**
 * Resolves the PSP ID from a VPA handle suffix (e.g., "anita@psp1" -> "PSP1").
 */
export function resolvePspIdFromVpa(vpa: string): string {
  const parts = vpa.trim().split("@");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Iso8583ValidationError(`Invalid VPA format: "${vpa}"`);
  }
  return parts[1].toUpperCase();
}

/**
 * Validates an ISO 8583 message envelope according to Project 1 specifications (Pages 5–6).
 */
export function validateIso8583Envelope(msg: Iso8583MessageEnvelope): void {
  if (!VALID_MTIS.has(msg.mti)) {
    throw new Iso8583ValidationError(`Unsupported MTI: "${String(msg.mti)}"`);
  }
  if (!msg.transaction_id || typeof msg.transaction_id !== "string") {
    throw new Iso8583ValidationError("transaction_id is required");
  }
  if (!/^\d{6}$/.test(msg.stan)) {
    throw new Iso8583ValidationError(`STAN must be 6 digits, received "${msg.stan}"`);
  }
  if (msg.rrn !== undefined && !/^\d{12}$/.test(msg.rrn)) {
    throw new Iso8583ValidationError(`RRN must be 12 digits, received "${msg.rrn}"`);
  }
  if (!VALID_PROCESSING_CODES.has(msg.processing_code)) {
    throw new Iso8583ValidationError(
      `Unsupported processing_code: "${String(msg.processing_code)}"`
    );
  }

  if (msg.processing_code === "BAL" || msg.processing_code === "CHK") {
    assertPaiseInteger(msg.amount, "amount");
    if (msg.amount < 0) {
      throw new Iso8583ValidationError("Enquiry amount cannot be negative");
    }
  } else {
    assertPositivePaise(msg.amount, "amount");
  }

  if (msg.currency !== INR_CURRENCY_NUMERIC) {
    throw new Iso8583ValidationError(
      `Currency mismatch: expected "${INR_CURRENCY_NUMERIC}", received "${msg.currency}"`
    );
  }

  if (!msg.transmission_time || Number.isNaN(Date.parse(msg.transmission_time))) {
    throw new Iso8583ValidationError(
      `Invalid transmission_time: "${msg.transmission_time}"`
    );
  }

  if (
    msg.account_reference !== undefined &&
    !/^XXXX\d{4}$/.test(msg.account_reference)
  ) {
    throw new Iso8583ValidationError(
      `Rule 10 Violation: account_reference outside bank core must be masked as XXXX1234, received "${msg.account_reference}"`
    );
  }

  if (RESPONSE_MTIS.has(msg.mti)) {
    if (!msg.response_code || !(msg.response_code in ISO_RESPONSE_CODE_MEANINGS)) {
      throw new Iso8583ValidationError(
        `Response MTI ${msg.mti} requires a valid 2-character response_code`
      );
    }
  } else if (msg.response_code !== undefined) {
    throw new Iso8583ValidationError(
      `Request MTI ${msg.mti} must not carry a response_code`
    );
  }

  if (!msg.signature || typeof msg.signature !== "string") {
    throw new Iso8583ValidationError("HMAC signature is required on every message");
  }
}
