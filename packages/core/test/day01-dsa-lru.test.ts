import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  TtlLruCache,
  SingleFlightIdempotencyCache,
  IdempotencyConflictError,
} from "../src/index.ts";

describe("Day 1 Fintech DSA — O(1) TTL-LRU Cache & Single-Flight Coalescing", () => {
  it("O(1) Doubly Linked List + Hash Map LRU promotes on get() and evicts tail.prev on capacity overflow", () => {
    const lru = new TtlLruCache<string, number>(3, 60_000);
    const t0 = 1_000_000;

    lru.put("RRN-1", 100, 60_000, t0);
    lru.put("RRN-2", 200, 60_000, t0);
    lru.put("RRN-3", 300, 60_000, t0);
    assert.deepEqual(lru.keysMruToLru(), ["RRN-3", "RRN-2", "RRN-1"]);

    // Access RRN-1 -> promoted to MRU; RRN-2 is now the Least Recently Used
    assert.equal(lru.get("RRN-1", t0 + 100), 100);
    assert.deepEqual(lru.keysMruToLru(), ["RRN-1", "RRN-3", "RRN-2"]);

    // Insert RRN-4 -> capacity is 3, so RRN-2 (LRU) is evicted in O(1)
    lru.put("RRN-4", 400, 60_000, t0 + 200);
    assert.equal(lru.get("RRN-2", t0 + 200), undefined);
    assert.deepEqual(lru.keysMruToLru(), ["RRN-4", "RRN-1", "RRN-3"]);
  });

  it("Evicts expired keys lazily in O(1) when TTL has elapsed", () => {
    const lru = new TtlLruCache<string, string>(5, 5_000);
    const t0 = 1_000_000;

    lru.put("STAN-000101", "00", 5_000, t0);
    assert.equal(lru.get("STAN-000101", t0 + 4_999), "00");
    assert.equal(lru.get("STAN-000101", t0 + 5_000), undefined);
    assert.equal(lru.size, 0);
  });

  it("SingleFlightIdempotencyCache coalesces 5 concurrent in-flight requests into 1 execution and rejects conflicting payload with HTTP 409", async () => {
    const coordinator = new SingleFlightIdempotencyCache<{ rrn: string; code: string }>(
      100,
      60_000
    );

    let bankCoreCalls = 0;

    const simulateSlowBankDebit = async () => {
      bankCoreCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { rrn: "630912004512", code: "00" };
    };

    // Fire 5 identical requests concurrently at the exact same millisecond
    const burstPromises = Array.from({ length: 5 }, () =>
      coordinator.execute({
        idempotencyKey: "TXN-2026110500001",
        payloadHash: "HASH_150000_PAISE",
        work: simulateSlowBankDebit,
      })
    );

    // While the 5 are still IN_FLIGHT, fire a 6th request with the SAME key but a DIFFERENT payloadHash
    await assert.rejects(
      () =>
        coordinator.execute({
          idempotencyKey: "TXN-2026110500001",
          payloadHash: "HASH_999900_PAISE_TAMPERED",
          work: simulateSlowBankDebit,
        }),
      (err: unknown) => err instanceof IdempotencyConflictError && err.statusCode === 409
    );

    const results = await Promise.all(burstPromises);

    // Underlying bank debit was executed literally ONCE across all 5 concurrent callers
    assert.equal(bankCoreCalls, 1);

    const freshCount = results.filter((r) => !r.coalescedOrReplayed).length;
    const coalescedCount = results.filter((r) => r.coalescedOrReplayed).length;
    assert.equal(freshCount, 1);
    assert.equal(coalescedCount, 4);

    for (const res of results) {
      assert.deepEqual(res.value, { rrn: "630912004512", code: "00" });
    }
  });
});
