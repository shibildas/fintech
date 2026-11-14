/**
 * Day 9 Fintech DSA — Tree Traversal Patterns (Binary, N-ary, Merkle & BST)
 *
 * Used in Payment Gateways, Switches & Ledgers:
 * 1. MerkleAuditTree: Tamper-evident binary hash tree over ordered ledger/settlement
 *    postings, providing O(log N) inclusion proofs for external auditors.
 * 2. HierarchicalPolicyTree (N-ary Tree): Models Platform -> MCC -> Merchant -> Method
 *    fee/limit hierarchies using:
 *    - Pre-order DFS for top-down effective policy inheritance
 *    - Post-order DFS for bottom-up GMV/volume rollup
 *    - BFS for level-by-level serialization
 *    - Lowest Common Ancestor (LCA) for finding shared policy scopes
 * 3. Iterative Binary Tree Traversals: Stack-based Inorder, Preorder, Postorder, BFS,
 *    BST validation & Kth-smallest (zero recursion stack overflow risk).
 */

import { createHash } from "node:crypto";

// ---------------------------------------------------------------------------
// 1. Merkle Audit Tree (Binary Hash Tree)
// ---------------------------------------------------------------------------

export interface MerkleProofStep {
  position: "left" | "right";
  hash: string;
}

function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export class MerkleAuditTree {
  private readonly levels: string[][] = [];

  constructor(records: string[]) {
    if (records.length === 0) {
      throw new Error("MerkleAuditTree requires at least one record");
    }

    let currentLevel = records.map((r) => sha256Hex(`LEAF:${r}`));
    this.levels.push(currentLevel);

    while (currentLevel.length > 1) {
      const nextLevel: string[] = [];
      for (let i = 0; i < currentLevel.length; i += 2) {
        const left = currentLevel[i];
        const right = i + 1 < currentLevel.length ? currentLevel[i + 1] : left;
        nextLevel.push(sha256Hex(`NODE:${left}:${right}`));
      }
      this.levels.push(nextLevel);
      currentLevel = nextLevel;
    }
  }

  public getRootHash(): string {
    return this.levels[this.levels.length - 1]![0]!;
  }

  /**
   * Generates an O(log N) Merkle inclusion proof for the record at `index`.
   */
  public getProof(index: number): MerkleProofStep[] {
    const leafLevel = this.levels[0]!;
    if (index < 0 || index >= leafLevel.length) {
      throw new RangeError(`Leaf index ${index} out of bounds`);
    }

    const proof: MerkleProofStep[] = [];
    let idx = index;

    for (let level = 0; level < this.levels.length - 1; level++) {
      const nodes = this.levels[level]!;
      const isRightNode = idx % 2 === 1;
      const siblingIdx = isRightNode ? idx - 1 : idx + 1;
      const siblingHash =
        siblingIdx < nodes.length ? nodes[siblingIdx]! : nodes[idx]!;

      proof.push({
        position: isRightNode ? "left" : "right",
        hash: siblingHash,
      });
      idx = Math.floor(idx / 2);
    }

    return proof;
  }

  public static verifyProof(
    record: string,
    proof: MerkleProofStep[],
    expectedRootHash: string
  ): boolean {
    let computed = sha256Hex(`LEAF:${record}`);
    for (const step of proof) {
      computed =
        step.position === "left"
          ? sha256Hex(`NODE:${step.hash}:${computed}`)
          : sha256Hex(`NODE:${computed}:${step.hash}`);
    }
    return computed === expectedRootHash;
  }
}

// ---------------------------------------------------------------------------
// 2. Hierarchical MDR / Policy N-ary Tree
// ---------------------------------------------------------------------------

export interface PolicyTreeNode {
  id: string;
  label: string;
  /** Optional MDR override in basis points (e.g., 200 = 2.00%). Null inherits parent. */
  mdrBps: number | null;
  /** Direct transaction volume in paise at this node. */
  directVolumePaise: number;
  children: PolicyTreeNode[];
}

export class HierarchicalPolicyTree {
  public readonly root: PolicyTreeNode;

  constructor(root: PolicyTreeNode) {
    this.root = root;
  }

  /**
   * Pre-order DFS: Resolves effective MDR (basis points) for every node
   * by inheriting from the nearest ancestor when `mdrBps` is null.
   * Time Complexity: O(N)
   */
  public resolveEffectiveMdr(): Map<string, number> {
    const resolved = new Map<string, number>();

    const dfs = (node: PolicyTreeNode, inheritedBps: number): void => {
      const effective = node.mdrBps !== null ? node.mdrBps : inheritedBps;
      resolved.set(node.id, effective);
      for (const child of node.children) {
        dfs(child, effective);
      }
    };

    if (this.root.mdrBps === null) {
      throw new Error("Root policy node must define a default mdrBps");
    }
    dfs(this.root, this.root.mdrBps);
    return resolved;
  }

  /**
   * Post-order DFS: Aggregates subtree GMV (paise) bottom-up from leaves to root.
   * Time Complexity: O(N)
   */
  public rollupVolumePaise(): Map<string, number> {
    const totals = new Map<string, number>();

    const dfs = (node: PolicyTreeNode): number => {
      let sum = node.directVolumePaise;
      for (const child of node.children) {
        sum += dfs(child);
      }
      totals.set(node.id, sum);
      return sum;
    };

    dfs(this.root);
    return totals;
  }

  /**
   * BFS Level-order traversal: Returns node IDs grouped by hierarchy depth.
   * Time Complexity: O(N)
   */
  public levelOrderIds(): string[][] {
    const levels: string[][] = [];
    const queue: PolicyTreeNode[] = [this.root];

    while (queue.length > 0) {
      const levelSize = queue.length;
      const currentLevel: string[] = [];
      for (let i = 0; i < levelSize; i++) {
        const node = queue.shift()!;
        currentLevel.push(node.id);
        for (const child of node.children) {
          queue.push(child);
        }
      }
      levels.push(currentLevel);
    }

    return levels;
  }

  /**
   * Finds the Lowest Common Ancestor (LCA) of two node IDs in the N-ary tree.
   * Useful for determining the narrowest shared risk/fee policy scope.
   * Time Complexity: O(N)
   */
  public findLowestCommonAncestor(idA: string, idB: string): PolicyTreeNode | null {
    const pathA = this.findPath(this.root, idA);
    const pathB = this.findPath(this.root, idB);
    if (!pathA || !pathB) {
      return null;
    }

    let lca: PolicyTreeNode | null = null;
    const minLen = Math.min(pathA.length, pathB.length);
    for (let i = 0; i < minLen; i++) {
      const nodeA = pathA[i]!;
      const nodeB = pathB[i]!;
      if (nodeA.id === nodeB.id) {
        lca = nodeA;
      } else {
        break;
      }
    }
    return lca;
  }

  private findPath(node: PolicyTreeNode, targetId: string): PolicyTreeNode[] | null {
    if (node.id === targetId) {
      return [node];
    }
    for (const child of node.children) {
      const childPath = this.findPath(child, targetId);
      if (childPath) {
        return [node, ...childPath];
      }
    }
    return null;
  }
}

// ---------------------------------------------------------------------------
// 3. Iterative Binary Tree & BST Traversals (Interview Classics)
// ---------------------------------------------------------------------------

export interface BinaryTreeNode<T> {
  val: T;
  left: BinaryTreeNode<T> | null;
  right: BinaryTreeNode<T> | null;
}

export function inorderIterative<T>(root: BinaryTreeNode<T> | null): T[] {
  const result: T[] = [];
  const stack: Array<BinaryTreeNode<T>> = [];
  let curr = root;

  while (curr !== null || stack.length > 0) {
    while (curr !== null) {
      stack.push(curr);
      curr = curr.left;
    }
    curr = stack.pop()!;
    result.push(curr.val);
    curr = curr.right;
  }

  return result;
}

export function preorderIterative<T>(root: BinaryTreeNode<T> | null): T[] {
  if (!root) return [];
  const result: T[] = [];
  const stack: Array<BinaryTreeNode<T>> = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node.val);
    if (node.right) stack.push(node.right);
    if (node.left) stack.push(node.left);
  }

  return result;
}

export function postorderIterative<T>(root: BinaryTreeNode<T> | null): T[] {
  if (!root) return [];
  const result: T[] = [];
  const stack: Array<BinaryTreeNode<T>> = [root];

  while (stack.length > 0) {
    const node = stack.pop()!;
    result.push(node.val);
    if (node.left) stack.push(node.left);
    if (node.right) stack.push(node.right);
  }

  return result.reverse();
}

export function levelOrderBfs<T>(root: BinaryTreeNode<T> | null): T[][] {
  if (!root) return [];
  const result: T[][] = [];
  const queue: Array<BinaryTreeNode<T>> = [root];

  while (queue.length > 0) {
    const size = queue.length;
    const level: T[] = [];
    for (let i = 0; i < size; i++) {
      const node = queue.shift()!;
      level.push(node.val);
      if (node.left) queue.push(node.left);
      if (node.right) queue.push(node.right);
    }
    result.push(level);
  }

  return result;
}

/**
 * Validates whether a binary tree satisfies strict BST ordering (iterative inorder).
 */
export function validateBst(root: BinaryTreeNode<number> | null): boolean {
  const stack: Array<BinaryTreeNode<number>> = [];
  let curr = root;
  let prev = -Infinity;

  while (curr !== null || stack.length > 0) {
    while (curr !== null) {
      stack.push(curr);
      curr = curr.left;
    }
    curr = stack.pop()!;
    if (curr.val <= prev) {
      return false;
    }
    prev = curr.val;
    curr = curr.right;
  }

  return true;
}

/**
 * Returns the 1-indexed kth smallest value in a BST in O(H + k) time.
 */
export function kthSmallestInBst(
  root: BinaryTreeNode<number> | null,
  k: number
): number {
  if (k <= 0) {
    throw new RangeError("k must be >= 1");
  }
  const stack: Array<BinaryTreeNode<number>> = [];
  let curr = root;
  let count = 0;

  while (curr !== null || stack.length > 0) {
    while (curr !== null) {
      stack.push(curr);
      curr = curr.left;
    }
    curr = stack.pop()!;
    count++;
    if (count === k) {
      return curr.val;
    }
    curr = curr.right;
  }

  throw new RangeError(`k=${k} exceeds number of nodes in BST`);
}
