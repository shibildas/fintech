import test from "node:test";
import assert from "node:assert/strict";
import {
  KeyedAsyncMutex,
  ReadWriteLock,
  LockFreeAtomicLedgerCounter,
  OptimisticVersionedStore,
  MerkleAuditTree,
  HierarchicalPolicyTree,
  inorderIterative,
  preorderIterative,
  postorderIterative,
  levelOrderBfs,
  validateBst,
  kthSmallestInBst,
  type BinaryTreeNode,
  type PolicyTreeNode,
} from "../src/index.ts";

test("KeyedAsyncMutex serializes per-key critical sections and prevents A<->B transfer deadlocks", async () => {
  const mutex = new KeyedAsyncMutex();
  const balances = new Map<string, number>([
    ["ACCT_A", 100_000],
    ["ACCT_B", 100_000],
  ]);

  // Simulate 10 concurrent bidirectional transfers (A->B and B->A)
  // Without ordered lock acquisition, opposing lock orders could deadlock.
  const transfers = Array.from({ length: 10 }, (_, idx) => {
    const from = idx % 2 === 0 ? "ACCT_A" : "ACCT_B";
    const to = idx % 2 === 0 ? "ACCT_B" : "ACCT_A";
    const amount = 500;

    return mutex.withOrderedLocks([from, to], async () => {
      const fromBal = balances.get(from)!;
      await new Promise((r) => setTimeout(r, 2));
      balances.set(from, fromBal - amount);
      balances.set(to, balances.get(to)! + amount);
    });
  });

  await Promise.all(transfers);
  assert.equal(balances.get("ACCT_A"), 100_000);
  assert.equal(balances.get("ACCT_B"), 100_000);
  assert.equal(mutex.activeLockCount, 0);
});

test("ReadWriteLock allows concurrent readers and prioritizes waiting writers", async () => {
  const rw = new ReadWriteLock();
  const events: string[] = [];

  const r1Release = await rw.acquireRead();
  events.push("r1_start");
  const r2Release = await rw.acquireRead();
  events.push("r2_start");

  // Writer queues while r1 and r2 are active
  const writerPromise = rw.withWriteLock(async () => {
    events.push("writer_exec");
  });

  // Subsequent reader should queue behind the waiting writer (writer-preference)
  const r3Promise = rw.withReadLock(async () => {
    events.push("r3_exec");
  });

  r1Release();
  r2Release();

  await Promise.all([writerPromise, r3Promise]);
  assert.deepEqual(events, ["r1_start", "r2_start", "writer_exec", "r3_exec"]);
});

test("LockFreeAtomicLedgerCounter performs exact CAS debits & credits via Atomics.compareExchange", () => {
  const counter = new LockFreeAtomicLedgerCounter(10_000);

  const d1 = counter.tryDebit(4_000);
  assert.equal(d1.success, true);
  assert.equal(d1.newBalancePaise, 6_000);

  const d2 = counter.tryDebit(7_000);
  assert.equal(d2.success, false);
  assert.equal(d2.newBalancePaise, 6_000);

  const c1 = counter.credit(2_500);
  assert.equal(c1.newBalancePaise, 8_500);
  assert.equal(counter.getBalance(), 8_500);
});

test("OptimisticVersionedStore prevents ABA problem and converges via CAS retry", async () => {
  const store = new OptimisticVersionedStore<string>();
  store.putIfAbsent("ORD_101", "CREATED");

  const staleSnapshot = store.get("ORD_101")!;
  assert.equal(staleSnapshot.version, 1);

  // Transition CREATED -> ATTEMPTED -> CREATED (ABA pattern on value)
  const t1 = store.compareAndSwap("ORD_101", 1, "ATTEMPTED");
  assert.equal(t1.swapped, true);
  assert.equal(t1.entry.version, 2);

  const t2 = store.compareAndSwap("ORD_101", 2, "CREATED");
  assert.equal(t2.swapped, true);
  assert.equal(t2.entry.version, 3);

  // Stale CAS with version=1 must fail even though value is "CREATED" again!
  const staleAttempt = store.compareAndSwap("ORD_101", staleSnapshot.version, "CAPTURED");
  assert.equal(staleAttempt.swapped, false);
  assert.equal(staleAttempt.entry.version, 3);

  // Numeric balance store with updateWithRetry
  const balStore = new OptimisticVersionedStore<number>();
  balStore.putIfAbsent("MERCH_1", 0);
  const res = balStore.updateWithRetry("MERCH_1", (bal) => bal + 1500);
  assert.equal(res.entry.value, 1500);
  assert.equal(res.entry.version, 2);
});

test("MerkleAuditTree generates O(log N) inclusion proofs and detects any tampering", () => {
  const postings = [
    "POSTING|TXN1|DEBIT|10000",
    "POSTING|TXN1|CREDIT|10000",
    "POSTING|TXN2|DEBIT|25000",
    "POSTING|TXN2|CREDIT|25000",
    "POSTING|TXN3|DEBIT|5000",
  ];

  const tree = new MerkleAuditTree(postings);
  const root = tree.getRootHash();

  for (let i = 0; i < postings.length; i++) {
    const proof = tree.getProof(i);
    assert.equal(MerkleAuditTree.verifyProof(postings[i]!, proof, root), true);
  }

  // Tampering with 1 paise in TXN2 must fail verification
  const proof2 = tree.getProof(2);
  assert.equal(MerkleAuditTree.verifyProof("POSTING|TXN2|DEBIT|25001", proof2, root), false);
});

test("HierarchicalPolicyTree computes pre-order MDR inheritance, post-order GMV rollup, BFS & LCA", () => {
  const rootNode: PolicyTreeNode = {
    id: "PLATFORM",
    label: "Platform Default",
    mdrBps: 200,
    directVolumePaise: 0,
    children: [
      {
        id: "MCC_RETAIL",
        label: "Retail MCC",
        mdrBps: 180,
        directVolumePaise: 0,
        children: [
          {
            id: "MERCH_A",
            label: "Merchant A",
            mdrBps: null, // Inherits 180 from MCC_RETAIL
            directVolumePaise: 500_000,
            children: [
              {
                id: "MERCH_A_UPI",
                label: "Merchant A UPI",
                mdrBps: 0, // Zero MDR override for UPI
                directVolumePaise: 300_000,
                children: [],
              },
              {
                id: "MERCH_A_CARD",
                label: "Merchant A Card",
                mdrBps: null, // Inherits 180
                directVolumePaise: 200_000,
                children: [],
              },
            ],
          },
        ],
      },
      {
        id: "MCC_TRAVEL",
        label: "Travel MCC",
        mdrBps: null, // Inherits 200 from PLATFORM
        directVolumePaise: 1_000_000,
        children: [],
      },
    ],
  };

  const tree = new HierarchicalPolicyTree(rootNode);

  // Pre-order DFS effective MDR
  const mdr = tree.resolveEffectiveMdr();
  assert.equal(mdr.get("PLATFORM"), 200);
  assert.equal(mdr.get("MCC_RETAIL"), 180);
  assert.equal(mdr.get("MERCH_A"), 180);
  assert.equal(mdr.get("MERCH_A_UPI"), 0);
  assert.equal(mdr.get("MERCH_A_CARD"), 180);
  assert.equal(mdr.get("MCC_TRAVEL"), 200);

  // Post-order DFS GMV rollup
  const gmv = tree.rollupVolumePaise();
  assert.equal(gmv.get("MERCH_A"), 1_000_000);
  assert.equal(gmv.get("MCC_RETAIL"), 1_000_000);
  assert.equal(gmv.get("PLATFORM"), 2_000_000);

  // BFS level-order
  assert.deepEqual(tree.levelOrderIds(), [
    ["PLATFORM"],
    ["MCC_RETAIL", "MCC_TRAVEL"],
    ["MERCH_A"],
    ["MERCH_A_UPI", "MERCH_A_CARD"],
  ]);

  // LCA
  assert.equal(tree.findLowestCommonAncestor("MERCH_A_UPI", "MERCH_A_CARD")?.id, "MERCH_A");
  assert.equal(tree.findLowestCommonAncestor("MERCH_A_UPI", "MCC_TRAVEL")?.id, "PLATFORM");
});

test("Iterative Binary Tree & BST traversals (Inorder, Preorder, Postorder, BFS, Validate, KthSmallest)", () => {
  //       40
  //      /  \
  //    20    60
  //   /  \  /  \
  //  10  30 50  70
  const bst: BinaryTreeNode<number> = {
    val: 40,
    left: {
      val: 20,
      left: { val: 10, left: null, right: null },
      right: { val: 30, left: null, right: null },
    },
    right: {
      val: 60,
      left: { val: 50, left: null, right: null },
      right: { val: 70, left: null, right: null },
    },
  };

  assert.deepEqual(inorderIterative(bst), [10, 20, 30, 40, 50, 60, 70]);
  assert.deepEqual(preorderIterative(bst), [40, 20, 10, 30, 60, 50, 70]);
  assert.deepEqual(postorderIterative(bst), [10, 30, 20, 50, 70, 60, 40]);
  assert.deepEqual(levelOrderBfs(bst), [[40], [20, 60], [10, 30, 50, 70]]);
  assert.equal(validateBst(bst), true);
  assert.equal(kthSmallestInBst(bst, 3), 30);
  assert.equal(kthSmallestInBst(bst, 6), 60);

  // Invalid BST (right child smaller than root)
  const invalidBst: BinaryTreeNode<number> = {
    val: 40,
    left: { val: 20, left: null, right: null },
    right: { val: 35, left: null, right: null },
  };
  assert.equal(validateBst(invalidBst), false);
});
