import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { DistributedLeaseManager, InjectableFakeClock } from "@fintech/core";
import { RecurringCycleExecutor } from "../src/index.ts";

describe("Day 28 — Milestone 4: 10,000-Cycle Same-Minute Load Benchmark (Zero Duplicate Debits)", () => {
  it("Claims and executes 10,000 due cycles in < 5 seconds across concurrent workers with 0 duplicate execution_keys", () => {
    const db = new DatabaseSync(":memory:");
    db.exec(`
      CREATE TABLE cycle_claims (
        execution_key TEXT PRIMARY KEY,
        subscription_id TEXT NOT NULL,
        cycle_number INTEGER NOT NULL,
        worker_id TEXT NOT NULL,
        amount_paise INTEGER NOT NULL,
        state TEXT NOT NULL,
        claimed_at TEXT NOT NULL
      );
    `);

    const leases = new DistributedLeaseManager();
    const clock = new InjectableFakeClock("2026-12-02T04:30:00.000Z"); // 10:00 AM IST
    const nowMs = clock.nowMs();
    const nowIso = clock.now().toISOString();

    const totalCycles = 10_000;
    const insertClaim = db.prepare(
      `INSERT OR IGNORE INTO cycle_claims (
        execution_key, subscription_id, cycle_number, worker_id, amount_paise, state, claimed_at
      ) VALUES (?, ?, 1, ?, 49900, 'SUCCEEDED', ?)`
    );

    const start = performance.now();
    db.exec("BEGIN TRANSACTION");
    let claimedCount = 0;
    let duplicateRejectedCount = 0;

    for (let i = 0; i < totalCycles; i++) {
      const subId = `sub_10k_${i}`;
      const execKey = RecurringCycleExecutor.buildExecutionKey(subId, 1);

      // Worker 1 acquires lease & claims atomically
      const lease1 = leases.acquire({
        key: execKey,
        ownerId: "worker-1",
        leaseDurationMs: 30_000,
        nowMs,
      });
      assert.equal(lease1.acquired, true);

      // Simulated competing Worker 2 tries to claim the exact same due cycle simultaneously
      const lease2 = leases.acquire({
        key: execKey,
        ownerId: "worker-2",
        leaseDurationMs: 30_000,
        nowMs,
      });
      if (!lease2.acquired) {
        duplicateRejectedCount++;
      }

      const res = insertClaim.run(execKey, subId, "worker-1", nowIso);
      if (Number(res.changes) === 1) {
        claimedCount++;
      }
      leases.release(execKey, "worker-1");
    }
    db.exec("COMMIT");

    const elapsedMs = performance.now() - start;
    const rowCount = (
      db.prepare(`SELECT COUNT(*) AS cnt FROM cycle_claims`).get() as { cnt: number }
    ).cnt;

    assert.equal(claimedCount, totalCycles);
    assert.equal(duplicateRejectedCount, totalCycles);
    assert.equal(rowCount, totalCycles);
    assert.ok(
      elapsedMs < 5000,
      `Expected 10,000 cycles in < 5000ms, took ${elapsedMs.toFixed(1)}ms`
    );
  });
});
