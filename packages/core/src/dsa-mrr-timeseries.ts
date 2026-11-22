/**
 * Day 27 Fintech DSA — Time-Series Prefix-Sum Revenue Index & Cohort Churn Aggregator
 *
 * Precomputes prefix sums over daily/monthly integer paise revenue buckets so
 * dashboard date-range queries `[startIdx, endIdx]` execute in O(1) time.
 */

export class RevenuePrefixSumIndex {
  private readonly prefix: number[];

  constructor(dailyRevenuesPaise: number[]) {
    this.prefix = new Array<number>(dailyRevenuesPaise.length + 1);
    this.prefix[0] = 0;
    for (let i = 0; i < dailyRevenuesPaise.length; i++) {
      this.prefix[i + 1] = this.prefix[i] + dailyRevenuesPaise[i];
    }
  }

  /**
   * Returns exact sum of `dailyRevenuesPaise[left .. right]` (inclusive) in O(1).
   */
  public rangeSum(leftInclusive: number, rightInclusive: number): number {
    if (
      leftInclusive < 0 ||
      rightInclusive >= this.prefix.length - 1 ||
      leftInclusive > rightInclusive
    ) {
      throw new Error(`Invalid prefix-sum range [${leftInclusive}, ${rightInclusive}]`);
    }
    return this.prefix[rightInclusive + 1] - this.prefix[leftInclusive];
  }
}

export interface MrrMovementEvent {
  type: "NEW" | "EXPANSION" | "CONTRACTION" | "CHURN";
  deltaPaise: number; // Always positive magnitude
}

export interface MrrMovementSummary {
  newMrrPaise: number;
  expansionMrrPaise: number;
  contractionMrrPaise: number;
  churnedMrrPaise: number;
  netMrrPaise: number;
}

export function aggregateMrrMovements(events: MrrMovementEvent[]): MrrMovementSummary {
  let newMrrPaise = 0;
  let expansionMrrPaise = 0;
  let contractionMrrPaise = 0;
  let churnedMrrPaise = 0;

  for (const ev of events) {
    switch (ev.type) {
      case "NEW":
        newMrrPaise += ev.deltaPaise;
        break;
      case "EXPANSION":
        expansionMrrPaise += ev.deltaPaise;
        break;
      case "CONTRACTION":
        contractionMrrPaise += ev.deltaPaise;
        break;
      case "CHURN":
        churnedMrrPaise += ev.deltaPaise;
        break;
    }
  }

  const netMrrPaise =
    newMrrPaise + expansionMrrPaise - contractionMrrPaise - churnedMrrPaise;

  return {
    newMrrPaise,
    expansionMrrPaise,
    contractionMrrPaise,
    churnedMrrPaise,
    netMrrPaise,
  };
}
