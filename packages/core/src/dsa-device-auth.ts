import crypto from "node:crypto";

/**
 * Day 15 Fintech DSA — Asymmetric Ed25519 Signature Verification &
 * Monotonic Timestamp / Nonce Replay Validator
 *
 * Used by TPAP/PSP backends (PhonePe/GPay model) to authenticate every
 * sensitive mobile request (`pay`, `collect/approve`, `pin/verify`) without
 * storing symmetric secrets on the user's phone.
 *
 * Time Complexity: O(1) amortized per request.
 * Space Complexity: O(N) where N is active nonces within the replay window.
 */

export interface DeviceKeyPairPem {
  publicKeyPem: string;
  privateKeyPem: string;
}

export function generateDeviceEd25519KeyPair(): DeviceKeyPairPem {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return {
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

export function signDevicePayload(params: {
  deviceId: string;
  timestampMs: number;
  nonce: string;
  payload: string;
  privateKeyPem: string;
}): string {
  const message = `${params.deviceId}:${params.timestampMs}:${params.nonce}:${params.payload}`;
  const sig = crypto.sign(null, Buffer.from(message, "utf8"), params.privateKeyPem);
  return sig.toString("base64");
}

export function verifyDeviceSignature(params: {
  deviceId: string;
  timestampMs: number;
  nonce: string;
  payload: string;
  signatureBase64: string;
  publicKeyPem: string;
}): boolean {
  try {
    const message = `${params.deviceId}:${params.timestampMs}:${params.nonce}:${params.payload}`;
    return crypto.verify(
      null,
      Buffer.from(message, "utf8"),
      params.publicKeyPem,
      Buffer.from(params.signatureBase64, "base64")
    );
  } catch {
    return false;
  }
}

export class DeviceRequestReplayGuard {
  private readonly maxSkewMs: number;
  private readonly lastTimestampByDevice = new Map<string, number>();
  private readonly seenNonces = new Map<string, number>(); // `${deviceId}:${nonce}` -> expiresAtMs

  constructor(maxSkewMs = 5 * 60 * 1000) {
    this.maxSkewMs = maxSkewMs;
  }

  /**
   * Validates:
   * 1. Timestamp is within `+-maxSkewMs` of `nowMs`.
   * 2. Timestamp is monotonically non-decreasing per device (`timestampMs >= lastSeen`).
   * 3. `(deviceId, nonce)` has never been seen before within the replay window.
   */
  public validateAndRecord(params: {
    deviceId: string;
    timestampMs: number;
    nonce: string;
    nowMs: number;
  }): { valid: boolean; reason?: string } {
    if (!params.nonce || params.nonce.length < 8) {
      return { valid: false, reason: "INVALID_NONCE" };
    }
    if (Math.abs(params.nowMs - params.timestampMs) > this.maxSkewMs) {
      return { valid: false, reason: "TIMESTAMP_OUT_OF_WINDOW" };
    }

    const prevTs = this.lastTimestampByDevice.get(params.deviceId);
    if (prevTs !== undefined && params.timestampMs < prevTs) {
      return { valid: false, reason: "NON_MONOTONIC_TIMESTAMP" };
    }

    const nonceKey = `${params.deviceId}:${params.nonce}`;
    const existingExpiry = this.seenNonces.get(nonceKey);
    if (existingExpiry !== undefined && existingExpiry >= params.nowMs) {
      return { valid: false, reason: "REPLAYED_NONCE" };
    }

    // Prune expired nonces opportunistically
    if (this.seenNonces.size > 10_000) {
      for (const [k, exp] of this.seenNonces.entries()) {
        if (exp < params.nowMs) {
          this.seenNonces.delete(k);
        }
      }
    }

    this.lastTimestampByDevice.set(params.deviceId, params.timestampMs);
    this.seenNonces.set(nonceKey, params.nowMs + this.maxSkewMs);
    return { valid: true };
  }
}
