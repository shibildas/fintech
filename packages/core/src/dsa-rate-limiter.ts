/**
 * Day 8 Fintech DSA — Sliding-Window Counter & Token-Bucket Rate Limiter
 *
 * Used in Payment Gateways & Switches (Project 1 Stretch Goal 3 & Project 2 API Gateway)
 * to protect bank cores and acquirers from merchant traffic spikes, returning ISO code `96`
 * or `HTTP 429 Too Many Requests` when a participant exceeds its quota.
 *
 * Time Complexity: O(1) amortized per request.
 * Space Complexity: O(U) where U is the number of active participants/merchants.
 */

export interface RateLimitCheckResult {
  allowed: boolean;
  remainingTokens: number;
  retryAfterMs: number;
  isoResponseCode: "00" | "96";
}

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

export class TokenBucketRateLimiter {
  private readonly capacity: number;
  private readonly refillTokensPerSecond: number;
  private readonly buckets = new Map<string, BucketState>();

  constructor(capacity: number, refillTokensPerSecond: number) {
    if (capacity <= 0 || refillTokensPerSecond <= 0) {
      throw new Error("Capacity and refill rate must be > 0");
    }
    this.capacity = capacity;
    this.refillTokensPerSecond = refillTokensPerSecond;
  }

  public tryConsume(
    participantId: string,
    cost = 1,
    nowMs = Date.now()
  ): RateLimitCheckResult {
    let bucket = this.buckets.get(participantId);
    if (!bucket) {
      bucket = { tokens: this.capacity, lastRefillMs: nowMs };
      this.buckets.set(participantId, bucket);
    } else {
      const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
      const refilled = elapsedSec * this.refillTokensPerSecond;
      bucket.tokens = Math.min(this.capacity, bucket.tokens + refilled);
      bucket.lastRefillMs = nowMs;
    }

    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      return {
        allowed: true,
        remainingTokens: Math.floor(bucket.tokens),
        retryAfterMs: 0,
        isoResponseCode: "00",
      };
    }

    const deficit = cost - bucket.tokens;
    const retryAfterMs = Math.ceil((deficit / this.refillTokensPerSecond) * 1000);
    return {
      allowed: false,
      remainingTokens: 0,
      retryAfterMs,
      isoResponseCode: "96", // System malfunction / overload (Project 1 Stretch Goal 3)
    };
  }
}
