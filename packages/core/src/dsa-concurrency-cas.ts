/**
 * Day 9 Fintech DSA — Concurrency Locks & Compare-And-Swap (CAS) Patterns
 *
 * Used in Payment Switches, Bank Cores & Gateways (Razorpay, Juspay, PhonePe):
 * 1. KeyedAsyncMutex + Ordered Multi-Key Locking: Prevents race conditions on concurrent
 *    debits/captures for the same account/order while avoiding deadlocks on transfers (A<->B).
 * 2. ReadWriteLock (Writer-Preference): High-throughput concurrent reads for routing tables
 *    and risk rulesets with exclusive, starvation-free writes.
 * 3. LockFreeAtomicLedgerCounter: True hardware-level CAS loop via SharedArrayBuffer +
 *    Atomics.compareExchange for zero-lock balance/quota updates.
 * 4. OptimisticVersionedStore: Monotonic-version CAS (ABA-safe) for distributed state machines
 *    and idempotent order/payment transitions.
 */

export class KeyedAsyncMutex {
  private readonly queues = new Map<string, Array<() => void>>();
  private readonly held = new Set<string>();

  /**
   * Acquires an exclusive lock for `key` in FIFO order.
   * Time Complexity: O(1) amortized.
   */
  public acquire(key: string): Promise<() => void> {
    if (!this.held.has(key)) {
      this.held.add(key);
      return Promise.resolve(() => this.release(key));
    }

    return new Promise<() => void>((resolve) => {
      let queue = this.queues.get(key);
      if (!queue) {
        queue = [];
        this.queues.set(key, queue);
      }
      queue.push(() => resolve(() => this.release(key)));
    });
  }

  private release(key: string): void {
    const queue = this.queues.get(key);
    if (queue && queue.length > 0) {
      const next = queue.shift()!;
      if (queue.length === 0) {
        this.queues.delete(key);
      }
      next();
      return;
    }
    this.held.delete(key);
  }

  public async withLock<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire(key);
    try {
      return await fn();
    } finally {
      release();
    }
  }

  /**
   * Deadlock-free multi-key lock acquisition using canonical lexicographical ordering.
   * Deduplicates keys so locking [A, A] does not self-deadlock.
   * Time Complexity: O(K log K) where K is the number of keys.
   */
  public async withOrderedLocks<T>(
    keys: string[],
    fn: () => Promise<T> | T
  ): Promise<T> {
    const orderedKeys = Array.from(new Set(keys)).sort();
    const releases: Array<() => void> = [];
    try {
      for (const key of orderedKeys) {
        releases.push(await this.acquire(key));
      }
      return await fn();
    } finally {
      for (let i = releases.length - 1; i >= 0; i--) {
        releases[i]?.();
      }
    }
  }

  public get activeLockCount(): number {
    return this.held.size;
  }
}

/**
 * Writer-preference Read-Write Lock.
 * Allows N concurrent readers when no writer holds or waits for the lock.
 * Prevents writer starvation when read traffic is heavy (e.g. Acquirer Routing Table).
 */
export class ReadWriteLock {
  private activeReaders = 0;
  private activeWriter = false;
  private readonly readerQueue: Array<() => void> = [];
  private readonly writerQueue: Array<() => void> = [];

  public acquireRead(): Promise<() => void> {
    if (!this.activeWriter && this.writerQueue.length === 0) {
      this.activeReaders++;
      return Promise.resolve(() => this.releaseRead());
    }
    return new Promise<() => void>((resolve) => {
      this.readerQueue.push(() => {
        this.activeReaders++;
        resolve(() => this.releaseRead());
      });
    });
  }

  private releaseRead(): void {
    this.activeReaders--;
    if (this.activeReaders === 0 && this.writerQueue.length > 0) {
      this.activeWriter = true;
      const nextWriter = this.writerQueue.shift()!;
      nextWriter();
    }
  }

  public acquireWrite(): Promise<() => void> {
    if (!this.activeWriter && this.activeReaders === 0) {
      this.activeWriter = true;
      return Promise.resolve(() => this.releaseWrite());
    }
    return new Promise<() => void>((resolve) => {
      this.writerQueue.push(() => {
        this.activeWriter = true;
        resolve(() => this.releaseWrite());
      });
    });
  }

  private releaseWrite(): void {
    this.activeWriter = false;
    if (this.writerQueue.length > 0) {
      this.activeWriter = true;
      const nextWriter = this.writerQueue.shift()!;
      nextWriter();
      return;
    }
    while (this.readerQueue.length > 0) {
      const nextReader = this.readerQueue.shift()!;
      nextReader();
    }
  }

  public async withReadLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireRead();
    try {
      return await fn();
    } finally {
      release();
    }
  }

  public async withWriteLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquireWrite();
    try {
      return await fn();
    } finally {
      release();
    }
  }
}

export interface CasDebitResult {
  success: boolean;
  newBalancePaise: number;
  retries: number;
}

/**
 * Lock-free atomic balance counter backed by SharedArrayBuffer + Atomics.compareExchange.
 * Demonstrates hardware-level Compare-And-Swap (CAS) retry loops without mutexes.
 * Note: Int32Array supports balances up to ~2.14B paise (~₹2.14 Crore) per slot.
 */
export class LockFreeAtomicLedgerCounter {
  private readonly view: Int32Array;
  public totalCasRetries = 0;

  constructor(initialBalancePaise = 0) {
    if (!Number.isInteger(initialBalancePaise) || initialBalancePaise < 0) {
      throw new Error("Initial balance must be a non-negative integer (paise)");
    }
    const sab = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
    this.view = new Int32Array(sab);
    Atomics.store(this.view, 0, initialBalancePaise);
  }

  public getBalance(): number {
    return Atomics.load(this.view, 0);
  }

  /**
   * Atomically debits `amountPaise` if sufficient balance exists, using a CAS loop.
   */
  public tryDebit(amountPaise: number): CasDebitResult {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new Error("Debit amount must be a positive integer (paise)");
    }

    let retries = 0;
    while (true) {
      const current = Atomics.load(this.view, 0);
      if (current < amountPaise) {
        return { success: false, newBalancePaise: current, retries };
      }
      const next = current - amountPaise;
      const witnessed = Atomics.compareExchange(this.view, 0, current, next);
      if (witnessed === current) {
        return { success: true, newBalancePaise: next, retries };
      }
      retries++;
      this.totalCasRetries++;
    }
  }

  /**
   * Atomically credits `amountPaise` using a CAS loop.
   */
  public credit(amountPaise: number): { newBalancePaise: number; retries: number } {
    if (!Number.isInteger(amountPaise) || amountPaise <= 0) {
      throw new Error("Credit amount must be a positive integer (paise)");
    }

    let retries = 0;
    while (true) {
      const current = Atomics.load(this.view, 0);
      const next = current + amountPaise;
      const witnessed = Atomics.compareExchange(this.view, 0, current, next);
      if (witnessed === current) {
        return { newBalancePaise: next, retries };
      }
      retries++;
      this.totalCasRetries++;
    }
  }
}

export interface VersionedEntry<T> {
  value: T;
  version: number;
}

export interface CasSwapResult<T> {
  swapped: boolean;
  entry: VersionedEntry<T>;
}

/**
 * Optimistic Concurrency Control (OCC) store using monotonic version numbers.
 * Prevents the ABA problem because even if a value transitions A -> B -> A,
 * its version strictly increases (1 -> 2 -> 3), so stale CAS(expectedVersion=1) fails.
 */
export class OptimisticVersionedStore<T> {
  private readonly store = new Map<string, VersionedEntry<T>>();

  public get(key: string): VersionedEntry<T> | undefined {
    const entry = this.store.get(key);
    return entry ? { value: entry.value, version: entry.version } : undefined;
  }

  public putIfAbsent(key: string, value: T): boolean {
    if (this.store.has(key)) {
      return false;
    }
    this.store.set(key, { value, version: 1 });
    return true;
  }

  public compareAndSwap(
    key: string,
    expectedVersion: number,
    nextValue: T
  ): CasSwapResult<T> {
    const current = this.store.get(key);
    if (!current) {
      throw new Error(`Key "${key}" does not exist`);
    }
    if (current.version !== expectedVersion) {
      return {
        swapped: false,
        entry: { value: current.value, version: current.version },
      };
    }
    const updated: VersionedEntry<T> = {
      value: nextValue,
      version: current.version + 1,
    };
    this.store.set(key, updated);
    return { swapped: true, entry: { ...updated } };
  }

  /**
   * Executes an optimistic CAS update loop with bounded retries.
   * Useful for concurrent state transitions or balance updates without locks.
   */
  public updateWithRetry(
    key: string,
    updater: (current: T) => T,
    maxRetries = 10
  ): { entry: VersionedEntry<T>; attempts: number } {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const snapshot = this.get(key);
      if (!snapshot) {
        throw new Error(`Key "${key}" does not exist`);
      }
      const nextValue = updater(snapshot.value);
      const res = this.compareAndSwap(key, snapshot.version, nextValue);
      if (res.swapped) {
        return { entry: res.entry, attempts: attempt };
      }
    }
    throw new Error(`CAS update failed for "${key}" after ${maxRetries} retries`);
  }
}
