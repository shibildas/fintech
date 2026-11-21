import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { verifySignedBatchCsv } from "@fintech/core";
import { createSeededGatewayTopology } from "@fintech/project2-gateway";
import {
  EnachBankBatchSimulator,
  EnachPresentmentEngine,
  type EnachPresentmentItem,
} from "../src/index.ts";

describe("Day 25 — Project 4: e-NACH 500-Subscription Batch Presentment, Missing-Record Exceptions & P2 Ledger Posting", () => {
  it("Processes 500 e-NACH subscriptions across 3 banks, detects dropped records & posts captured revenue to Project 2 Ledger", () => {
    const { gateway, merchant } = createSeededGatewayTopology();
    const engine = new EnachPresentmentEngine({ gateway });

    const bankA = new EnachBankBatchSimulator("BANKA");
    const bankB = new EnachBankBatchSimulator("BANKB");
    const bankC = new EnachBankBatchSimulator("BANKC");
    const simByBank = new Map([
      ["BANKA", bankA],
      ["BANKB", bankB],
      ["BANKC", bankC],
    ]);

    // 500 e-NACH subscriptions distributed across BANKA, BANKB, BANKC
    const items: EnachPresentmentItem[] = [];
    const bankIds = ["BANKA", "BANKB", "BANKC"];
    for (let i = 0; i < 500; i++) {
      items.push({
        executionKey: `sub_nach_${i}:cycle:1`,
        merchantId: merchant.id,
        subscriptionId: `sub_nach_${i}`,
        umrn: `UMRN${String(i).padStart(16, "0")}`,
        bankId: bankIds[i % 3],
        amountPaise: 100_000, // ₹1,000.00 each
      });
    }

    // Inject realistic bank outcomes: 2 soft failures, 1 hard failure, and 2 silently dropped records!
    bankA.setForcedFailure("sub_nach_0:cycle:1", "51_INSUFFICIENT_FUNDS");
    bankB.setForcedFailure("sub_nach_1:cycle:1", "51_INSUFFICIENT_FUNDS");
    bankC.setForcedFailure("sub_nach_2:cycle:1", "78_ACCOUNT_CLOSED");
    bankA.setDroppedRecord("sub_nach_3:cycle:1");
    bankB.setDroppedRecord("sub_nach_4:cycle:1");

    const batches = engine.generatePresentmentBatches(items);
    assert.equal(batches.length, 3);

    let totalSuccess = 0;
    let totalSoftFail = 0;
    let totalHardFail = 0;
    let totalMissing = 0;

    for (const batch of batches) {
      const bankSim = simByBank.get(batch.bankId)!;
      const responseCsv = bankSim.processPresentmentAndBuildResponseCsv(
        batch.batchId,
        batch.presentmentCsv
      );

      // Tampering check: altering 1 character in CSV fails SHA-256 checksum
      assert.equal(
        verifySignedBatchCsv(responseCsv.replace("00_SUCCESS", "99_TAMPERED")).valid,
        false
      );

      const res = engine.ingestResponseCsv(batch.batchId, responseCsv);
      totalSuccess += res.succeededCount;
      totalSoftFail += res.softFailedCount;
      totalHardFail += res.hardFailedCount;
      totalMissing += res.missingRecordExceptions.length;
    }

    assert.equal(totalSuccess, 495);
    assert.equal(totalSoftFail, 2);
    assert.equal(totalHardFail, 1);
    assert.equal(totalMissing, 2); // Dropped rows NEVER assumed success/failure — raised as exceptions!

    // Verify Project 2 Merchant Ledger received all 495 captured e-NACH payments & matches dashboard!
    const parity = gateway.verifyDashboardMatchesLedger(merchant.id);
    assert.equal(parity.matches, true);
    assert.ok(parity.ledger_payable_paise > 0);
  });
});
