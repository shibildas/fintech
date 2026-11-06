/**
 * Rule 1: Store every amount as an integer in the smallest unit (paise).
 * Never use floating-point numbers for money anywhere, including reports.
 */

export const INR_CURRENCY_NUMERIC = "356";

export class MoneyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MoneyError";
  }
}

/**
 * Asserts that `amount` is a safe integer in paise (no floats, NaN, or Infinity).
 */
export function assertPaiseInteger(
  amount: unknown,
  fieldName = "amount"
): asserts amount is number {
  if (typeof amount !== "number" || !Number.isSafeInteger(amount)) {
    throw new MoneyError(
      `Rule 1 Violation: ${fieldName} must be an integer in paise, received ${String(amount)}`
    );
  }
}

/**
 * Asserts that `amount` is a strictly positive integer in paise (> 0).
 */
export function assertPositivePaise(
  amount: unknown,
  fieldName = "amount"
): asserts amount is number {
  assertPaiseInteger(amount, fieldName);
  if (amount <= 0) {
    throw new MoneyError(
      `Rule 1 Violation: ${fieldName} must be > 0 paise, received ${amount}`
    );
  }
}

/**
 * Formats integer paise (e.g., 150000) into human-readable INR string ("₹1,500.00")
 * using pure integer arithmetic (zero floating-point operations).
 */
export function formatInrFromPaise(paise: number): string {
  assertPaiseInteger(paise, "paise");
  const isNegative = paise < 0;
  const absPaise = Math.abs(paise);
  const rupees = Math.trunc(absPaise / 100);
  const remainderPaise = absPaise % 100;
  const formattedRupees = rupees.toLocaleString("en-IN");
  const formattedPaise = String(remainderPaise).padStart(2, "0");
  return `${isNegative ? "-" : ""}₹${formattedRupees}.${formattedPaise}`;
}

/**
 * Parses an exact decimal string like "1500.00" or "1500" into integer paise (150000)
 * without using parseFloat or Number() multiplication.
 */
export function parseInrStringToPaise(input: string): number {
  const trimmed = input.trim().replace(/^₹/, "").replace(/,/g, "");
  if (!/^-?\d+(\.\d{1,2})?$/.test(trimmed)) {
    throw new MoneyError(`Invalid INR string format: "${input}"`);
  }
  const isNegative = trimmed.startsWith("-");
  const clean = isNegative ? trimmed.slice(1) : trimmed;
  const [rupeePart, paisePart = ""] = clean.split(".");
  const rupees = BigInt(rupeePart) * 100n;
  const paise = BigInt(paisePart.padEnd(2, "0"));
  const total = isNegative ? -(rupees + paise) : rupees + paise;
  const asNumber = Number(total);
  assertPaiseInteger(asNumber, "parsedPaise");
  return asNumber;
}

/**
 * Computes basis-point percentage in integer paise using deterministic half-up rounding.
 * 100 bps = 1.00%, 10000 bps = 100.00%.
 */
export function computeBasisPointsPaise(amountPaise: number, bps: number): number {
  assertPositivePaise(amountPaise, "amountPaise");
  assertPaiseInteger(bps, "bps");
  if (bps < 0 || bps > 10000) {
    throw new MoneyError(`bps must be between 0 and 10000, received ${bps}`);
  }
  const numerator = BigInt(amountPaise) * BigInt(bps) + 5000n;
  return Number(numerator / 10000n);
}

export interface MdrSplitResult {
  grossPaise: number;
  mdrFeePaise: number;
  gstOnFeePaise: number;
  merchantNetPaise: number;
}

/**
 * Project 2 Requirement 24: Splits a captured payment into Gross, MDR Fee, GST on Fee,
 * and Merchant Net Payable, guaranteeing `mdrFeePaise + gstOnFeePaise + merchantNetPaise === grossPaise`.
 */
export function splitMdrAndGst(
  grossPaise: number,
  mdrBps: number,
  gstBps = 1800 // Default 18.00% GST on MDR fee
): MdrSplitResult {
  assertPositivePaise(grossPaise, "grossPaise");
  const mdrFeePaise = computeBasisPointsPaise(grossPaise, mdrBps);
  const gstOnFeePaise =
    mdrFeePaise > 0 ? computeBasisPointsPaise(mdrFeePaise, gstBps) : 0;
  const merchantNetPaise = grossPaise - mdrFeePaise - gstOnFeePaise;

  if (mdrFeePaise + gstOnFeePaise + merchantNetPaise !== grossPaise) {
    throw new MoneyError("Zero-sum MDR split invariant violated");
  }

  return {
    grossPaise,
    mdrFeePaise,
    gstOnFeePaise,
    merchantNetPaise,
  };
}
