/**
 * Day 5 Fintech DSA — Multilateral Clearing House Netting & Min-Cash-Flow Simplification
 *
 * Classic Fintech Interview Problem (asked at Razorpay, Juspay, PhonePe, Stripe):
 * Given `T` inter-bank payment legs `(fromBank, toBank, amountPaise)`:
 * 1. Compute each bank's multilateral net position (`O(T + B)`).
 * 2. Prove the Zero-Sum Clearing Invariant (`SUM(netPosition) === 0`).
 * 3. Simplify all debts into the minimum number of settlement transfers using a
 *    Two-Pointer / Greedy Creditor-Debtor matching algorithm (`O(B log B)`), producing at most `B - 1` transfers!
 */

export interface BilateralLeg {
  fromBank: string;
  toBank: string;
  amountPaise: number;
}

export interface SettlementTransferInstruction {
  fromDebtorBank: string;
  toCreditorBank: string;
  amountPaise: number;
}

export interface MultilateralNettingResult {
  netPositions: Record<string, number>;
  transfers: SettlementTransferInstruction[];
  bilateralCount: number;
  simplifiedTransferCount: number;
}

export function simplifyMultilateralSettlement(
  legs: BilateralLeg[]
): MultilateralNettingResult {
  const netMap = new Map<string, number>();

  for (const leg of legs) {
    if (leg.fromBank === leg.toBank || leg.amountPaise <= 0) {
      continue;
    }
    netMap.set(leg.fromBank, (netMap.get(leg.fromBank) ?? 0) - leg.amountPaise);
    netMap.set(leg.toBank, (netMap.get(leg.toBank) ?? 0) + leg.amountPaise);
  }

  const netPositions: Record<string, number> = {};
  let totalSum = 0;

  const debtors: Array<{ bank: string; owePaise: number }> = [];
  const creditors: Array<{ bank: string; receivablePaise: number }> = [];

  for (const [bank, net] of Array.from(netMap.entries()).sort((a, b) =>
    a[0].localeCompare(b[0])
  )) {
    netPositions[bank] = net;
    totalSum += net;
    if (net < 0) {
      debtors.push({ bank, owePaise: -net });
    } else if (net > 0) {
      creditors.push({ bank, receivablePaise: net });
    }
  }

  if (totalSum !== 0) {
    throw new Error(`Zero-sum invariant failed: sum=${totalSum}`);
  }

  // Sort largest debtor and largest creditor first for greedy matching
  debtors.sort((a, b) => b.owePaise - a.owePaise);
  creditors.sort((a, b) => b.receivablePaise - a.receivablePaise);

  const transfers: SettlementTransferInstruction[] = [];
  let dIdx = 0;
  let cIdx = 0;

  while (dIdx < debtors.length && cIdx < creditors.length) {
    const debtor = debtors[dIdx];
    const creditor = creditors[cIdx];
    if (!debtor || !creditor) {
      break;
    }
    const settledAmount = Math.min(debtor.owePaise, creditor.receivablePaise);

    if (settledAmount > 0) {
      transfers.push({
        fromDebtorBank: debtor.bank,
        toCreditorBank: creditor.bank,
        amountPaise: settledAmount,
      });
    }

    debtor.owePaise -= settledAmount;
    creditor.receivablePaise -= settledAmount;

    if (debtor.owePaise === 0) {
      dIdx += 1;
    }
    if (creditor.receivablePaise === 0) {
      cIdx += 1;
    }
  }

  return {
    netPositions,
    transfers,
    bilateralCount: legs.length,
    simplifiedTransferCount: transfers.length,
  };
}
