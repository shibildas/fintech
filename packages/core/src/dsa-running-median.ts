/**
 * Day 18 Fintech DSA — Running Median (Two-Heaps: Max-Heap + Min-Heap)
 *
 * Used by Real-Time Risk Engines to track a customer's 30-day median transaction
 * amount in O(log N) per transaction and O(1) per median lookup — avoiding O(N log N)
 * re-sorting on every payment in the <100ms p95 scoring hot path!
 */

class BinaryHeap {
  private readonly data: number[] = [];
  private readonly compare: (a: number, b: number) => number;

  constructor(compare: (a: number, b: number) => number) {
    this.compare = compare;
  }

  public get size(): number {
    return this.data.length;
  }

  public peek(): number | undefined {
    return this.data[0];
  }

  public push(value: number): void {
    this.data.push(value);
    let idx = this.data.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.compare(this.data[idx], this.data[parent]) >= 0) {
        break;
      }
      [this.data[idx], this.data[parent]] = [this.data[parent], this.data[idx]];
      idx = parent;
    }
  }

  public pop(): number | undefined {
    if (this.data.length === 0) {
      return undefined;
    }
    const top = this.data[0];
    const last = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = last;
      let idx = 0;
      const len = this.data.length;
      while (true) {
        const left = (idx << 1) + 1;
        const right = left + 1;
        let best = idx;
        if (left < len && this.compare(this.data[left], this.data[best]) < 0) {
          best = left;
        }
        if (right < len && this.compare(this.data[right], this.data[best]) < 0) {
          best = right;
        }
        if (best === idx) {
          break;
        }
        [this.data[idx], this.data[best]] = [this.data[best], this.data[idx]];
        idx = best;
      }
    }
    return top;
  }
}

export class RunningMedianTracker {
  // Lower half: Max-Heap (largest element at root)
  private readonly lower = new BinaryHeap((a, b) => b - a);
  // Upper half: Min-Heap (smallest element at root)
  private readonly upper = new BinaryHeap((a, b) => a - b);

  public add(amountPaise: number): void {
    if (this.lower.size === 0 || amountPaise <= this.lower.peek()!) {
      this.lower.push(amountPaise);
    } else {
      this.upper.push(amountPaise);
    }

    // Rebalance so `lower.size === upper.size` or `lower.size === upper.size + 1`
    if (this.lower.size > this.upper.size + 1) {
      this.upper.push(this.lower.pop()!);
    } else if (this.upper.size > this.lower.size) {
      this.lower.push(this.upper.pop()!);
    }
  }

  public getMedian(): number | null {
    if (this.lower.size === 0) {
      return null;
    }
    if (this.lower.size > this.upper.size) {
      return this.lower.peek()!;
    }
    return Math.round((this.lower.peek()! + this.upper.peek()!) / 2);
  }

  public get count(): number {
    return this.lower.size + this.upper.size;
  }
}
