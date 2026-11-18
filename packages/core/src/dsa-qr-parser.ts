import { parseInrStringToPaise, formatInrFromPaise } from "./money.ts";

/**
 * Day 16 Fintech DSA — NPCI UPI QR URI Parser & Builder (`upi://pay?...`)
 *
 * Parses standard NPCI UPI QR URIs into validated fields with integer `amountPaise`
 * (never floating-point rupees) in O(L) linear time over the URI length.
 */

export interface ParsedUpiQrUri {
  payeeVpa: string;
  payeeName: string;
  amountPaise: number | null; // null for static QRs where user enters amount
  currency: "INR";
  note: string | null;
  txnRef: string | null;
}

export function parseUpiQrUri(uri: string): ParsedUpiQrUri {
  const trimmed = uri.trim();
  if (!trimmed.toLowerCase().startsWith("upi://pay?")) {
    throw new Error(`Invalid UPI QR URI scheme: expected "upi://pay?...", got "${trimmed}"`);
  }

  const queryStr = trimmed.slice("upi://pay?".length);
  const params = new URLSearchParams(queryStr);

  const pa = params.get("pa")?.trim();
  if (!pa || !/^[a-zA-Z0-9._-]+@[a-zA-Z0-9.-]+$/.test(pa)) {
    throw new Error(`Invalid or missing payee VPA ("pa") in UPI QR URI`);
  }

  const pn = params.get("pn")?.trim() || pa;
  const cu = (params.get("cu")?.trim() || "INR").toUpperCase();
  if (cu !== "INR") {
    throw new Error(`Unsupported currency "${cu}" in UPI QR URI (only INR supported)`);
  }

  const amRaw = params.get("am")?.trim();
  let amountPaise: number | null = null;
  if (amRaw !== undefined && amRaw !== "") {
    amountPaise = parseInrStringToPaise(amRaw);
    if (amountPaise <= 0) {
      throw new Error(`UPI QR amount ("am") must be positive, got "${amRaw}"`);
    }
  }

  return {
    payeeVpa: pa.toLowerCase(),
    payeeName: pn,
    amountPaise,
    currency: "INR",
    note: params.get("tn")?.trim() || null,
    txnRef: params.get("tr")?.trim() || null,
  };
}

export function buildUpiQrUri(params: {
  payeeVpa: string;
  payeeName: string;
  amountPaise?: number;
  note?: string;
  txnRef?: string;
}): string {
  const search = new URLSearchParams();
  search.set("pa", params.payeeVpa.toLowerCase());
  search.set("pn", params.payeeName);
  search.set("cu", "INR");
  if (params.amountPaise !== undefined) {
    // Format exact integer paise to decimal string without float math (e.g. 150000 -> "1500.00")
    const formatted = formatInrFromPaise(params.amountPaise).replace(/^₹/, "").replace(/,/g, "");
    search.set("am", formatted);
  }
  if (params.note) {
    search.set("tn", params.note);
  }
  if (params.txnRef) {
    search.set("tr", params.txnRef);
  }
  return `upi://pay?${search.toString()}`;
}
