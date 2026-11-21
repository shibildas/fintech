import crypto from "node:crypto";

/**
 * Day 25 Fintech DSA — Streaming Batch Checksum Verifier & O(N + M) Set Difference
 *
 * Used by e-NACH Presentment & Bank Response File Parsers to:
 * 1. Verify trailer row counts & SHA-256 checksums against SFTP truncation/tampering.
 * 2. Detect presented records missing from the bank's T+1 response file (and unexpected
 *    orphan records) in O(N + M) linear time without nested loops.
 */

export function computeBatchLinesSha256(dataLines: string[]): string {
  const hash = crypto.createHash("sha256");
  for (const line of dataLines) {
    hash.update(line);
    hash.update("\n");
  }
  return hash.digest("hex");
}

export function verifySignedBatchCsv(csvContent: string): {
  valid: boolean;
  reason?: string;
  headerLine?: string;
  dataLines: string[];
  declaredCount?: number;
  declaredSha256?: string;
} {
  const lines = csvContent
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  if (lines.length < 2) {
    return { valid: false, reason: "MISSING_HEADER_OR_TRAILER", dataLines: [] };
  }

  const headerLine = lines[0];
  const trailerLine = lines[lines.length - 1];
  if (!headerLine.startsWith("HDR,")) {
    return { valid: false, reason: "INVALID_HEADER_PREFIX", dataLines: [] };
  }
  if (!trailerLine.startsWith("TRL,")) {
    return { valid: false, reason: "INVALID_TRAILER_PREFIX", dataLines: [] };
  }

  const trailerParts = trailerLine.split(",");
  if (trailerParts.length !== 3) {
    return { valid: false, reason: "MALFORMED_TRAILER", dataLines: [] };
  }

  const declaredCount = Number(trailerParts[1]);
  const declaredSha256 = trailerParts[2];
  const dataLines = lines.slice(1, -1);

  if (declaredCount !== dataLines.length) {
    return {
      valid: false,
      reason: `ROW_COUNT_MISMATCH(declared=${declaredCount}, actual=${dataLines.length})`,
      headerLine,
      dataLines,
      declaredCount,
      declaredSha256,
    };
  }

  const actualSha256 = computeBatchLinesSha256(dataLines);
  if (actualSha256 !== declaredSha256) {
    return {
      valid: false,
      reason: "SHA256_CHECKSUM_MISMATCH",
      headerLine,
      dataLines,
      declaredCount,
      declaredSha256,
    };
  }

  return {
    valid: true,
    headerLine,
    dataLines,
    declaredCount,
    declaredSha256,
  };
}

/**
 * O(N + M) set-difference comparing presented `execution_key`s against bank response `execution_key`s.
 */
export function diffPresentedVsRespondedKeys(
  presentedKeys: string[],
  respondedKeys: string[]
): {
  matched: string[];
  missingFromResponse: string[];
  unexpectedInResponse: string[];
} {
  const presentedSet = new Set(presentedKeys);
  const respondedSet = new Set(respondedKeys);

  const matched: string[] = [];
  const missingFromResponse: string[] = [];
  const unexpectedInResponse: string[] = [];

  for (const key of presentedKeys) {
    if (respondedSet.has(key)) {
      matched.push(key);
    } else {
      missingFromResponse.push(key);
    }
  }

  for (const key of respondedKeys) {
    if (!presentedSet.has(key)) {
      unexpectedInResponse.push(key);
    }
  }

  return { matched, missingFromResponse, unexpectedInResponse };
}
