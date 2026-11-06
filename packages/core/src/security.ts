import crypto from "node:crypto";

/**
 * Rule 9: Service-to-service messages are signed (HMAC over the body with a shared secret
 * and a timestamp). Reject messages older than five minutes or with a bad signature,
 * and log the rejection.
 *
 * Rule 10: Card numbers, PINs and secrets never appear in logs, URLs, error messages or the
 * merchant-facing database. Mask account numbers to the last four digits everywhere
 * outside the vault or the bank core.
 */

export const FIVE_MINUTES_MS = 5 * 60 * 1000;

export interface SignedMessageHeaders {
  timestamp: string;
  signature: string;
}

export interface SignatureVerificationResult {
  valid: boolean;
  reason?: "EXPIRED_TIMESTAMP" | "INVALID_TIMESTAMP" | "BAD_SIGNATURE";
}

/**
 * Produces deterministic canonical payload string for HMAC signing: `${timestamp}.${rawBody}`
 */
export function signServiceMessage(
  rawBody: string,
  timestampIso: string,
  sharedSecret: string
): string {
  const payloadToSign = `${timestampIso}.${rawBody}`;
  return crypto
    .createHmac("sha256", sharedSecret)
    .update(payloadToSign, "utf8")
    .digest("hex");
}

/**
 * Verifies HMAC-SHA256 signature and enforces the 5-minute replay window (Rule 9).
 * Supports an optional `previousSecret` for Project 2 Requirement 2 (API key rotation overlap window).
 */
export function verifyServiceMessage(
  rawBody: string,
  timestampIso: string,
  providedSignature: string,
  activeSecret: string,
  options?: {
    nowMs?: number;
    maxSkewMs?: number;
    previousSecret?: string;
    onReject?: (reason: string, details: Record<string, unknown>) => void;
  }
): SignatureVerificationResult {
  const nowMs = options?.nowMs ?? Date.now();
  const maxSkewMs = options?.maxSkewMs ?? FIVE_MINUTES_MS;

  const parsedTime = Date.parse(timestampIso);
  if (Number.isNaN(parsedTime)) {
    options?.onReject?.("INVALID_TIMESTAMP", { timestampIso });
    return { valid: false, reason: "INVALID_TIMESTAMP" };
  }

  const ageMs = Math.abs(nowMs - parsedTime);
  if (ageMs > maxSkewMs) {
    options?.onReject?.("EXPIRED_TIMESTAMP", { timestampIso, ageMs, maxSkewMs });
    return { valid: false, reason: "EXPIRED_TIMESTAMP" };
  }

  const candidateSecrets = [activeSecret];
  if (options?.previousSecret) {
    candidateSecrets.push(options.previousSecret);
  }

  const providedBuf = Buffer.from(providedSignature, "utf8");

  for (const secret of candidateSecrets) {
    const expectedSig = signServiceMessage(rawBody, timestampIso, secret);
    const expectedBuf = Buffer.from(expectedSig, "utf8");
    if (
      providedBuf.length === expectedBuf.length &&
      crypto.timingSafeEqual(providedBuf, expectedBuf)
    ) {
      return { valid: true };
    }
  }

  options?.onReject?.("BAD_SIGNATURE", { timestampIso });
  return { valid: false, reason: "BAD_SIGNATURE" };
}

/**
 * Rule 10: Masks an account number to the last 4 digits ("XXXX4521") everywhere outside
 * the vault or the bank core.
 */
export function maskAccountNumber(accountNumber: string): string {
  const trimmed = accountNumber.trim();
  if (trimmed.length <= 4) {
    return `XXXX${trimmed}`;
  }
  return `XXXX${trimmed.slice(-4)}`;
}

const SENSITIVE_KEYS = new Set([
  "pin",
  "upi_pin",
  "upipin",
  "cvv",
  "card_number",
  "cardnumber",
  "pan",
  "secret",
  "shared_secret",
  "private_key",
  "otp",
]);

const PAN_REGEX = /\b(?:\d[ -]*?){13,19}\b/g;

/**
 * Rule 10: Recursively scrubs card numbers (PANs), PINs, CVVs, OTPs, and secrets from
 * any object before writing to structured logs or error responses.
 */
export function redactSensitiveData<T>(input: T): T {
  if (input === null || input === undefined) {
    return input;
  }
  if (typeof input === "string") {
    return input.replace(PAN_REGEX, "[REDACTED_PAN]") as unknown as T;
  }
  if (Array.isArray(input)) {
    return input.map((item) => redactSensitiveData(item)) as unknown as T;
  }
  if (typeof input === "object") {
    const redacted: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        redacted[key] = "[REDACTED]";
      } else if (
        key.toLowerCase() === "account_number" ||
        key.toLowerCase() === "accountnumber"
      ) {
        redacted[key] =
          typeof value === "string" ? maskAccountNumber(value) : "[REDACTED]";
      } else {
        redacted[key] = redactSensitiveData(value);
      }
    }
    return redacted as T;
  }
  return input;
}
