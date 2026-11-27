/**
 * Day 22 Fintech DSA — Interval Scheduling & Aggregate Capacity Checker
 *
 * Used by Recurring Mandate Engines (AutoPay / e-NACH) to enforce:
 * 1. Monthly aggregate cap across all debits within a calendar month (`YYYY-MM`).
 * 2. Sweep-line peak concurrent capacity check across scheduled debit windows
 *    so a bank batch or merchant schedule never exceeds its concurrent TPS/amount cap.
 */

export interface ScheduledDebitInterval {
  id: string;
  startMs: number;
  endMs: number;
  amountPaise: number;
}

export class MandateAggregateCapChecker {
  private readonly monthlyTotals = new Map<string, number>(); // `${umrn}:${YYYY-MM}` -> sumPaise

  public canDebitWithinMonthlyCap(params: {
    umrn: string;
    monthKey: string; // YYYY-MM
    amountPaise: number;
    monthlyCapPaise: number;
  }): { allowed: boolean; currentUsedPaise: number; projectedPaise: number } {
    const key = `${params.umrn}:${params.monthKey}`;
    const used = this.monthlyTotals.get(key) ?? 0;
    const projected = used + params.amountPaise;
    return {
      allowed: projected <= params.monthlyCapPaise,
      currentUsedPaise: used,
      projectedPaise: projected,
    };
  }

  public recordMonthlyDebit(umrn: string, monthKey: string, amountPaise: number): number {
    const key = `${umrn}:${monthKey}`;
    const next = (this.monthlyTotals.get(key) ?? 0) + amountPaise;
    this.monthlyTotals.set(key, next);
    return next;
  }
}

/**
 * Sweep-line algorithm in O(N log N) computing the peak simultaneous scheduled amount
 * across overlapping `[startMs, endMs)` debit execution windows.
 */
export function computePeakConcurrentWindowAmount(intervals: ScheduledDebitInterval[]): number {
  const events: Array<{ timeMs: number; deltaPaise: number }> = [];
  for (const iv of intervals) {
    if (iv.endMs <= iv.startMs) {
      continue;
    }
    events.push({ timeMs: iv.startMs, deltaPaise: iv.amountPaise });
    events.push({ timeMs: iv.endMs, deltaPaise: -iv.amountPaise });
  }

  // Sort by timestamp ascending; process end (-delta) before start (+delta) on ties
  events.sort((a, b) => a.timeMs - b.timeMs || a.deltaPaise - b.deltaPaise);

  let current = 0;
  let peak = 0;
  for (const ev of events) {
    current += ev.deltaPaise;
    if (current > peak) {
      peak = current;
    }
  }
  return peak;
}
