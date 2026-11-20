/**
 * Day 20 Fintech DSA — Min-Heap SLA Deadline Tracker
 *
 * Tracks open customer disputes ordered by their regulatory SLA deadline (`deadlineMs`)
 * so Ops monitors can peek the soonest-to-breach dispute in O(1) and extract all
 * breached disputes in O(k log N) instead of scanning all disputes every minute.
 */

export interface SlaDeadlineEntry {
  entityId: string;
  deadlineMs: number;
  category: string;
}

export class SlaDeadlineMinHeap {
  private readonly heap: SlaDeadlineEntry[] = [];

  public get size(): number {
    return this.heap.length;
  }

  public peek(): SlaDeadlineEntry | undefined {
    return this.heap[0];
  }

  public push(entry: SlaDeadlineEntry): void {
    this.heap.push(entry);
    let idx = this.heap.length - 1;
    while (idx > 0) {
      const parent = (idx - 1) >> 1;
      if (this.heap[idx].deadlineMs >= this.heap[parent].deadlineMs) {
        break;
      }
      [this.heap[idx], this.heap[parent]] = [this.heap[parent], this.heap[idx]];
      idx = parent;
    }
  }

  public pop(): SlaDeadlineEntry | undefined {
    if (this.heap.length === 0) {
      return undefined;
    }
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      let idx = 0;
      const len = this.heap.length;
      while (true) {
        const left = (idx << 1) + 1;
        const right = left + 1;
        let smallest = idx;
        if (left < len && this.heap[left].deadlineMs < this.heap[smallest].deadlineMs) {
          smallest = left;
        }
        if (right < len && this.heap[right].deadlineMs < this.heap[smallest].deadlineMs) {
          smallest = right;
        }
        if (smallest === idx) {
          break;
        }
        [this.heap[idx], this.heap[smallest]] = [this.heap[smallest], this.heap[idx]];
        idx = smallest;
      }
    }
    return top;
  }

  /**
   * Pops and returns all entries whose `deadlineMs <= nowMs` in chronological deadline order.
   */
  public extractBreached(nowMs: number): SlaDeadlineEntry[] {
    const breached: SlaDeadlineEntry[] = [];
    while (this.heap.length > 0 && this.heap[0].deadlineMs <= nowMs) {
      breached.push(this.pop()!);
    }
    return breached;
  }
}
