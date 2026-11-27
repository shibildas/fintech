import { IdempotencyConflictError } from "./idempotency.ts";

/**
 * Day 1 Fintech DSA — O(1) Doubly-Linked-List + Hash Map LRU Cache with TTL
 * & Single-Flight (In-Flight Promise Coalescing) Idempotency Deduplicator.
 *
 * Time Complexity:
 * - get(key): O(1)
 * - put(key, value): O(1)
 * - evictLeastRecentlyUsed(): O(1)
 * - executeSingleFlight(key, payloadHash, fn): O(1) lookup + coalesces N concurrent requests into 1 execution.
 *
 * Space Complexity: O(capacity)
 */

class LruNode<K, V> {
  public key: K;
  public value: V;
  public expiresAtMs: number;
  public prev: LruNode<K, V> | null = null;
  public next: LruNode<K, V> | null = null;

  constructor(key: K, value: V, expiresAtMs: number) {
    this.key = key;
    this.value = value;
    this.expiresAtMs = expiresAtMs;
  }
}

export class TtlLruCache<K, V> {
  private readonly capacity: number;
  private readonly defaultTtlMs: number;
  private readonly map = new Map<K, LruNode<K, V>>();
  // Sentinel dummy head (MRU side) and tail (LRU side) eliminate null-check branches
  private readonly head: LruNode<K, V>;
  private readonly tail: LruNode<K, V>;

  constructor(capacity: number, defaultTtlMs = 5 * 60 * 1000) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new Error(`Capacity must be a positive integer, received ${capacity}`);
    }
    this.capacity = capacity;
    this.defaultTtlMs = defaultTtlMs;
    this.head = new LruNode<K, V>(undefined as unknown as K, undefined as unknown as V, 0);
    this.tail = new LruNode<K, V>(undefined as unknown as K, undefined as unknown as V, 0);
    this.head.next = this.tail;
    this.tail.prev = this.head;
  }

  public get size(): number {
    return this.map.size;
  }

  /**
   * O(1) lookup:
   * - If missing, returns undefined.
   * - If expired (nowMs >= expiresAtMs), unlinks and deletes the node in O(1) and returns undefined.
   * - Otherwise moves the node to Most-Recently-Used (right after head) in O(1) and returns value.
   */
  public get(key: K, nowMs = Date.now()): V | undefined {
    const node = this.map.get(key);
    if (!node) {
      return undefined;
    }
    if (nowMs >= node.expiresAtMs) {
      this.removeNode(node);
      this.map.delete(key);
      return undefined;
    }
    this.moveToMostRecentlyUsed(node);
    return node.value;
  }

  /**
   * O(1) insert or update:
   * - Updates existing key and moves to MRU, or inserts new node at MRU.
   * - If over capacity, evicts Least-Recently-Used node (tail.prev) in O(1).
   */
  public put(key: K, value: V, ttlMs = this.defaultTtlMs, nowMs = Date.now()): void {
    const expiresAtMs = nowMs + ttlMs;
    const existing = this.map.get(key);

    if (existing) {
      existing.value = value;
      existing.expiresAtMs = expiresAtMs;
      this.moveToMostRecentlyUsed(existing);
      return;
    }

    if (this.map.size >= this.capacity) {
      this.evictLeastRecentlyUsed();
    }

    const newNode = new LruNode(key, value, expiresAtMs);
    this.map.set(key, newNode);
    this.insertAfterHead(newNode);
  }

  public delete(key: K): boolean {
    const node = this.map.get(key);
    if (!node) {
      return false;
    }
    this.removeNode(node);
    this.map.delete(key);
    return true;
  }

  /**
   * Returns keys ordered from Most-Recently-Used (MRU) to Least-Recently-Used (LRU)
   * for testing and inspection.
   */
  public keysMruToLru(): K[] {
    const result: K[] = [];
    let curr = this.head.next;
    while (curr && curr !== this.tail) {
      result.push(curr.key);
      curr = curr.next;
    }
    return result;
  }

  private insertAfterHead(node: LruNode<K, V>): void {
    const firstReal = this.head.next!;
    node.prev = this.head;
    node.next = firstReal;
    this.head.next = node;
    firstReal.prev = node;
  }

  private removeNode(node: LruNode<K, V>): void {
    const prevNode = node.prev!;
    const nextNode = node.next!;
    prevNode.next = nextNode;
    nextNode.prev = prevNode;
    node.prev = null;
    node.next = null;
  }

  private moveToMostRecentlyUsed(node: LruNode<K, V>): void {
    this.removeNode(node);
    this.insertAfterHead(node);
  }

  private evictLeastRecentlyUsed(): void {
    const lruNode = this.tail.prev;
    if (!lruNode || lruNode === this.head) {
      return;
    }
    this.removeNode(lruNode);
    this.map.delete(lruNode.key);
  }
}

/**
 * Concurrency-Safe Single-Flight Idempotency Coordinator:
 * Solves the "5 simultaneous identical requests" burst race condition (Project 1 Req 5 & Project 2 NFR 2).
 *
 * State machine per key in memory:
 * - IN_FLIGHT: First request is still executing asynchronously; concurrent identical requests
 *              await the exact same Promise instead of hitting the DB/bank 5 times.
 * - RESOLVED:  Completed response is cached in the O(1) TTL-LRU cache.
 */
interface SingleFlightSlot<T> {
  payloadHash: string;
  state: "IN_FLIGHT" | "RESOLVED";
  promise?: Promise<T>;
  resolvedValue?: T;
}

export class SingleFlightIdempotencyCache<T> {
  private readonly cache: TtlLruCache<string, SingleFlightSlot<T>>;

  constructor(capacity = 10_000, ttlMs = 5 * 60 * 1000) {
    this.cache = new TtlLruCache(capacity, ttlMs);
  }

  public async execute(params: {
    idempotencyKey: string;
    payloadHash: string;
    nowMs?: number;
    work: () => Promise<T>;
  }): Promise<{ value: T; coalescedOrReplayed: boolean }> {
    const nowMs = params.nowMs ?? Date.now();
    const existing = this.cache.get(params.idempotencyKey, nowMs);

    if (existing) {
      // Rule 5: Same key with different payload hash -> immediate HTTP 409 Conflict!
      if (existing.payloadHash !== params.payloadHash) {
        throw new IdempotencyConflictError(params.idempotencyKey);
      }

      if (existing.state === "RESOLVED") {
        return { value: existing.resolvedValue as T, coalescedOrReplayed: true };
      }

      // State is IN_FLIGHT: coalesce onto the running Promise!
      const sharedResult = await existing.promise!;
      return { value: sharedResult, coalescedOrReplayed: true };
    }

    const workPromise = params.work();
    const inFlightSlot: SingleFlightSlot<T> = {
      payloadHash: params.payloadHash,
      state: "IN_FLIGHT",
      promise: workPromise,
    };
    this.cache.put(params.idempotencyKey, inFlightSlot, undefined, nowMs);

    try {
      const result = await workPromise;
      this.cache.put(
        params.idempotencyKey,
        {
          payloadHash: params.payloadHash,
          state: "RESOLVED",
          resolvedValue: result,
        },
        undefined,
        nowMs
      );
      return { value: result, coalescedOrReplayed: false };
    } catch (err) {
      // Evict failed in-flight slot so a subsequent retry can re-attempt cleanly
      this.cache.delete(params.idempotencyKey);
      throw err;
    }
  }
}
