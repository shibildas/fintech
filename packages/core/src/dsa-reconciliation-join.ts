/**
 * Day 6 Fintech DSA — Three-Way Streaming Sorted-Merge Join (`threeWaySortedMergeJoin`)
 *
 * Why Interviewers Ask This at Razorpay, PhonePe & NPCI:
 * When reconciling 50,000,000 daily UPI transactions across Switch, Remitter EOD, and Beneficiary EOD
 * CSV files, loading all 50M objects into an in-memory Hash Map can exceed worker RAM (OOM).
 *
 * If the 3 EOD files are sorted by `RRN` (which is naturally monotonic by timestamp `YDDDHHSSSSSS`!),
 * you can perform a 3-Pointer Streaming Full Outer Merge Join in:
 * - Time Complexity: O(N_switch + N_remitter + N_beneficiary) single linear pass
 * - Auxiliary Memory: O(1) beyond the current RRN tuple!
 */

export interface SortedReconInputRow {
  rrn: string;
  amountPaise: number;
  status: "SUCCESS" | "REVERSED" | "FAILED";
}

export interface ThreeWayJoinedTuple {
  rrn: string;
  switchRow: SortedReconInputRow | null;
  remitterRow: SortedReconInputRow | null;
  beneficiaryRow: SortedReconInputRow | null;
}

/**
 * Performs a 3-pointer streaming Full Outer Join over three RRN-sorted arrays in O(N) time and O(1) auxiliary state.
 */
export function threeWaySortedMergeJoin(
  switchSorted: readonly SortedReconInputRow[],
  remitterSorted: readonly SortedReconInputRow[],
  beneficiarySorted: readonly SortedReconInputRow[]
): ThreeWayJoinedTuple[] {
  const output: ThreeWayJoinedTuple[] = [];
  let i = 0;
  let j = 0;
  let k = 0;

  while (i < switchSorted.length || j < remitterSorted.length || k < beneficiarySorted.length) {
    const rrnS = i < switchSorted.length ? switchSorted[i].rrn : null;
    const rrnR = j < remitterSorted.length ? remitterSorted[j].rrn : null;
    const rrnB = k < beneficiarySorted.length ? beneficiarySorted[k].rrn : null;

    // Find the lexicographically smallest RRN among the active heads
    let minRrn: string | null = null;
    for (const candidate of [rrnS, rrnR, rrnB]) {
      if (candidate !== null && (minRrn === null || candidate < minRrn)) {
        minRrn = candidate;
      }
    }

    if (minRrn === null) {
      break;
    }

    const swMatch = rrnS === minRrn ? switchSorted[i++] : null;
    const remMatch = rrnR === minRrn ? remitterSorted[j++] : null;
    const benMatch = rrnB === minRrn ? beneficiarySorted[k++] : null;

    output.push({
      rrn: minRrn,
      switchRow: swMatch,
      remitterRow: remMatch,
      beneficiaryRow: benMatch,
    });
  }

  return output;
}
