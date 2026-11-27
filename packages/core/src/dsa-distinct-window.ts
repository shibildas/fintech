/**
 * Day 17 Fintech DSA — Sliding-Window Distinct-Element Counter
 *
 * Detects collect-request fan-out fraud (e.g. a scammer sending collect requests
 * to 20+ distinct payers within 1 hour) in O(1) amortized time per event.
 */

interface WindowEvent {
  targetId: string;
  timestampMs: number;
}

export class SlidingWindowDistinctCounter {
  private readonly windowMs: number;
  private readonly eventsByActor = new Map<string, WindowEvent[]>();
  private readonly targetCountsByActor = new Map<string, Map<string, number>>();

  constructor(windowMs = 60 * 60 * 1000) {
    this.windowMs = windowMs;
  }

  private evictExpired(actorId: string, nowMs: number): void {
    const queue = this.eventsByActor.get(actorId);
    const counts = this.targetCountsByActor.get(actorId);
    if (!queue || !counts) {
      return;
    }

    const cutoff = nowMs - this.windowMs;
    while (queue.length > 0 && queue[0].timestampMs < cutoff) {
      const old = queue.shift()!;
      const prev = counts.get(old.targetId) ?? 0;
      if (prev <= 1) {
        counts.delete(old.targetId);
      } else {
        counts.set(old.targetId, prev - 1);
      }
    }
  }

  public recordAndCountDistinct(actorId: string, targetId: string, nowMs = Date.now()): number {
    this.evictExpired(actorId, nowMs);

    let queue = this.eventsByActor.get(actorId);
    let counts = this.targetCountsByActor.get(actorId);
    if (!queue || !counts) {
      queue = [];
      counts = new Map<string, number>();
      this.eventsByActor.set(actorId, queue);
      this.targetCountsByActor.set(actorId, counts);
    }

    queue.push({ targetId, timestampMs: nowMs });
    counts.set(targetId, (counts.get(targetId) ?? 0) + 1);

    return counts.size;
  }

  public getDistinctCount(actorId: string, nowMs = Date.now()): number {
    this.evictExpired(actorId, nowMs);
    return this.targetCountsByActor.get(actorId)?.size ?? 0;
  }
}
