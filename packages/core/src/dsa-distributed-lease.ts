/**
 * Day 24 Fintech DSA — Distributed Lease Lock & Idempotent Job Claimer
 *
 * Prevents two recurring-billing executor workers from claiming the same
 * `execution_key` simultaneously, while allowing a healthy worker to safely
 * take over a crashed worker's job once its `leaseExpiresAtMs` elapses.
 *
 * Time Complexity: O(1) per acquire / renew / release.
 */

export interface LeaseRecord {
  key: string;
  ownerId: string;
  fencingToken: number;
  expiresAtMs: number;
}

export class DistributedLeaseManager {
  private readonly leases = new Map<string, LeaseRecord>();
  private nextFencingToken = 1;

  public acquire(params: {
    key: string;
    ownerId: string;
    leaseDurationMs: number;
    nowMs: number;
  }): { acquired: true; lease: LeaseRecord } | { acquired: false; heldBy: string } {
    const existing = this.leases.get(params.key);
    if (existing && existing.expiresAtMs > params.nowMs && existing.ownerId !== params.ownerId) {
      return { acquired: false, heldBy: existing.ownerId };
    }

    const lease: LeaseRecord = {
      key: params.key,
      ownerId: params.ownerId,
      fencingToken: this.nextFencingToken++,
      expiresAtMs: params.nowMs + params.leaseDurationMs,
    };
    this.leases.set(params.key, lease);
    return { acquired: true, lease };
  }

  public renew(key: string, ownerId: string, leaseDurationMs: number, nowMs: number): boolean {
    const existing = this.leases.get(key);
    if (!existing || existing.ownerId !== ownerId || existing.expiresAtMs <= nowMs) {
      return false;
    }
    existing.expiresAtMs = nowMs + leaseDurationMs;
    return true;
  }

  public release(key: string, ownerId: string): boolean {
    const existing = this.leases.get(key);
    if (!existing || existing.ownerId !== ownerId) {
      return false;
    }
    this.leases.delete(key);
    return true;
  }
}
