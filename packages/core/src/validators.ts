/**
 * Shared Strict Input Validators (Zero external dependencies).
 * Every validator throws a 400 Error with structured `fields` metadata on failure.
 */

export interface ValidationError extends Error {
  statusCode: number;
  fields?: Record<string, string>;
}

export function createValidationError(
  message: string,
  fields?: Record<string, string>
): ValidationError {
  return Object.assign(new Error(message), { statusCode: 400, fields });
}

export function validateUsername(raw: unknown): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (s.length < 3 || s.length > 64 || !/^[a-z0-9._-]+$/.test(s)) {
    throw createValidationError("Username must be 3–64 characters (letters, digits, ., _, -)", {
      username: "Must be 3–64 characters (letters, digits, ., _, -)",
    });
  }
  return s;
}

export function validatePassword(raw: unknown): string {
  const s = typeof raw === "string" ? raw : "";
  if (s.length < 8 || s.length > 128) {
    throw createValidationError("Password must be 8–128 characters", {
      password: "Must be 8–128 characters",
    });
  }
  return s;
}

export function validateVpa(raw: unknown, field = "vpa"): string {
  const s = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  if (!/^[a-z0-9._-]{2,64}@[a-z0-9]{2,32}$/.test(s)) {
    throw createValidationError(`${field} must be a valid VPA (e.g. anita@psp1)`, {
      [field]: "Must be a valid VPA handle (e.g. anita@psp1)",
    });
  }
  return s;
}

export function validatePositivePaise(
  raw: unknown,
  field = "amountPaise",
  maxPaise = 10_000_000_000
): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0 || n > maxPaise) {
    throw createValidationError(`${field} must be a positive integer in paise (1 to ${maxPaise})`, {
      [field]: `Must be a positive integer in paise`,
    });
  }
  return n;
}

export function validatePinOrOtp(raw: unknown, field = "rawPin"): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (!/^\d{4,6}$/.test(s)) {
    throw createValidationError(`${field} must be 4 to 6 numeric digits`, {
      [field]: "Must be 4 to 6 numeric digits",
    });
  }
  return s;
}

export function validateIndianMobile(raw: unknown, field = "mobileNumber"): string {
  const s = typeof raw === "string" ? raw.trim().replace(/[\s-]/g, "") : "";
  if (!/^[6-9]\d{9}$/.test(s)) {
    throw createValidationError(`${field} must be a valid 10-digit Indian mobile number`, {
      [field]: "Must be a 10-digit mobile number starting with 6–9",
    });
  }
  return s;
}

export function validateIfsc(raw: unknown, field = "payeeIfsc"): string {
  const s = typeof raw === "string" ? raw.trim().toUpperCase() : "";
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(s)) {
    throw createValidationError(`${field} must be a valid 11-character IFSC (e.g. SBIN0001234)`, {
      [field]: "Must be a valid 11-character IFSC code",
    });
  }
  return s;
}

export function validateCardPanLuhn(raw: unknown, field = "cardNumber"): string {
  const digits = typeof raw === "string" ? raw.replace(/[\s-]/g, "") : "";
  if (!/^\d{13,19}$/.test(digits)) {
    throw createValidationError(`${field} must be 13–19 digits`, {
      [field]: "Must be 13–19 numeric digits",
    });
  }
  let sum = 0;
  let shouldDouble = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let d = Number(digits[i]);
    if (shouldDouble) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
    shouldDouble = !shouldDouble;
  }
  if (sum % 10 !== 0) {
    throw createValidationError(`${field} failed Luhn checksum validation`, {
      [field]: "Invalid card number (failed Luhn check)",
    });
  }
  return digits;
}

export function validateAnchorDay(raw: unknown): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 31) {
    throw createValidationError("anchorDay must be an integer between 1 and 31", {
      anchorDay: "Must be between 1 and 31",
    });
  }
  return n;
}

export function validateNonEmptyString(
  raw: unknown,
  field: string,
  minLen = 1,
  maxLen = 200
): string {
  const s = typeof raw === "string" ? raw.trim() : "";
  if (s.length < minLen || s.length > maxLen) {
    throw createValidationError(`${field} must be ${minLen}–${maxLen} characters`, {
      [field]: `Must be ${minLen}–${maxLen} characters`,
    });
  }
  return s;
}
