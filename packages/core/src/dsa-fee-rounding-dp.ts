import { assertPaiseInteger, splitMdrAndGst } from "./money.ts";

/**
 * Day 13 Fintech DSA — Dynamic Programming (Subset Sum for Payout Batch Matching)
 * & Integer Paise Fee-Rounding Invariants
 *
 * Used in Settlement & Payout Reconciliation when a bank credits a lump-sum NEFT/IMPS
 * amount (e.g. `targetPaise`) without per-item references, and Ops needs to identify
 * which subset of unsettled transactions sums to that exact payout amount.
 */

export interface PayoutCandidateItem {
  id: string;
  amountPaise: number;
}

/**
 * 0/1 Subset-Sum DP returning the exact item IDs whose integer paise amounts sum
 * to `targetPaise`, or `null` if no subset matches.
 *
 * Time Complexity: O(N * targetPaise) where N is candidate count (scaled by GCD when large).
 * Space Complexity: O(targetPaise) using parent pointers for exact reconstruction.
 */
export function findPayoutSubsetSum(
  items: PayoutCandidateItem[],
  targetPaise: number
): PayoutCandidateItem[] | null {
  assertPaiseInteger(targetPaise, "targetPaise");
  if (targetPaise === 0) {
    return [];
  }
  if (targetPaise < 0 || items.length === 0) {
    return null;
  }

  for (const item of items) {
    assertPaiseInteger(item.amountPaise, `item(${item.id}).amountPaise`);
  }

  // Scale amounts by their GCD to keep DP table compact for large rupee/paise figures
  const gcd = (a: number, b: number): number => (b === 0 ? a : gcd(b, a % b));
  let scale = targetPaise;
  for (const item of items) {
    if (item.amountPaise > 0) {
      scale = gcd(scale, item.amountPaise);
    }
  }

  const scaledTarget = targetPaise / scale;
  const dp = new Int32Array(scaledTarget + 1).fill(-2); // -2 = unreachable, -1 = base (0)
  dp[0] = -1;

  for (let i = 0; i < items.length; i++) {
    const w = items[i].amountPaise / scale;
    if (w <= 0 || w > scaledTarget) {
      continue;
    }
    for (let sum = scaledTarget; sum >= w; sum--) {
      if (dp[sum] === -2 && dp[sum - w] !== -2) {
        dp[sum] = i;
      }
    }
  }

  if (dp[scaledTarget] === -2) {
    return null;
  }

  const chosen: PayoutCandidateItem[] = [];
  let cursor = scaledTarget;
  while (cursor > 0) {
    const itemIdx = dp[cursor];
    const item = items[itemIdx];
    chosen.push(item);
    cursor -= item.amountPaise / scale;
  }

  return chosen.reverse();
}

/**
 * Verifies the zero-sum batch rounding invariant across N transactions:
 * For every item, `net_i + mdr_i + gst_i === gross_i`, and across the batch
 * `sum(net_i) + sum(mdr_i) + sum(gst_i) === sum(gross_i)`.
 */
export function verifyBatchFeeRoundingInvariant(
  grossAmountsPaise: number[],
  mdrBps: number,
  gstBps = 1800
): {
  valid: boolean;
  totalGrossPaise: number;
  totalMdrPaise: number;
  totalGstPaise: number;
  totalNetPaise: number;
} {
  let totalGrossPaise = 0;
  let totalMdrPaise = 0;
  let totalGstPaise = 0;
  let totalNetPaise = 0;

  for (const gross of grossAmountsPaise) {
    const split = splitMdrAndGst(gross, mdrBps, gstBps);
    if (split.merchantNetPaise + split.mdrFeePaise + split.gstOnFeePaise !== split.grossPaise) {
      return {
        valid: false,
        totalGrossPaise,
        totalMdrPaise,
        totalGstPaise,
        totalNetPaise,
      };
    }
    totalGrossPaise += split.grossPaise;
    totalMdrPaise += split.mdrFeePaise;
    totalGstPaise += split.gstOnFeePaise;
    totalNetPaise += split.merchantNetPaise;
  }

  return {
    valid: totalNetPaise + totalMdrPaise + totalGstPaise === totalGrossPaise,
    totalGrossPaise,
    totalMdrPaise,
    totalGstPaise,
    totalNetPaise,
  };
}
