import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  simplifyMultilateralSettlement,
  type BilateralLeg,
} from "../../../packages/core/src/index.ts";
import {
  createSeededTopology,
  CentralSwitch,
  SettlementEngine,
  verifySettlementCsvIntegrity,
} from "../src/index.ts";

describe("Day 5 Settlement Engine — 200 Mixed Txns across 3 Banks, Zero-Sum Netting & Immutable CSVs", () => {
  it("Acceptance Test 8 & Reqs 17–20: 200 mixed transactions across 3 banks sum to zero net position, trailer counts & hashes match, and re-runs version cleanly", async () => {
    const topology = createSeededTopology();
    const cycleId = "CYC-2026-11-07";

    // Top up accounts so 200 mixed transactions succeed without hitting daily limit
    topology.banks.BANKA.db.exec(`
      UPDATE accounts SET daily_limit_paise = 999999999, per_transaction_limit_paise = 999999999;
    `);
    topology.banks.BANKB.db.exec(`
      UPDATE accounts SET daily_limit_paise = 999999999, per_transaction_limit_paise = 999999999;
    `);
    topology.banks.BANKC.db.exec(`
      UPDATE accounts SET daily_limit_paise = 999999999, per_transaction_limit_paise = 999999999;
    `);

    const sw = new CentralSwitch({ activeCycleId: cycleId });
    sw.registerBank(topology.banks.BANKA);
    sw.registerBank(topology.banks.BANKB);
    sw.registerBank(topology.banks.BANKC);
    sw.registerPsp(topology.psps.PSP1);
    sw.registerPsp(topology.psps.PSP2);

    const settlement = new SettlementEngine(sw.db, sw.audit);
    const now = new Date("2026-11-07T15:00:00Z");

    const corridors = [
      {
        psp: topology.psps.PSP1,
        payer: "anita@psp1", // BANKA
        payee: "shop@psp2", // BANKC
        pin: "1234",
        amountPaise: 1_500,
      },
      {
        psp: topology.psps.PSP1,
        payer: "rahul@psp1", // BANKB
        payee: "shop@psp2", // BANKC
        pin: "5678",
        amountPaise: 2_000,
      },
      {
        psp: topology.psps.PSP1,
        payer: "anita@psp1", // BANKA
        payee: "coffee@psp2", // BANKB
        pin: "1234",
        amountPaise: 1_000,
      },
      {
        psp: topology.psps.PSP1,
        payer: "rahul@psp1", // BANKB
        payee: "coffee@psp2", // BANKB (intra-bank via switch)
        pin: "5678",
        amountPaise: 500,
      },
    ];

    // Execute 200 mixed transactions across BANKA, BANKB, and BANKC
    for (let i = 1; i <= 200; i++) {
      const c = corridors[(i - 1) % corridors.length];
      const env = c.psp.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: `TXN-SETTLE-200-${String(i).padStart(4, "0")}`,
        payerVpa: c.payer,
        payeeVpa: c.payee,
        amountPaise: c.amountPaise,
        now,
      });
      const res = await sw.handlePay({
        envelope: env,
        rawPin: c.pin,
        now,
      });
      assert.equal(res.transaction.state, "SUCCESS");
    }

    // Run Settlement Cycle v1
    const runV1 = settlement.runSettlementCycle({
      cycleId,
      registeredBankIds: ["BANKA", "BANKB", "BANKC"],
      now,
    });

    assert.equal(runV1.version, 1);
    assert.equal(runV1.total_transactions, 200);
    assert.equal(runV1.net_sum_across_banks_paise, 0);

    // Sum of net positions across all 3 banks must be 0
    const manualNetSum = runV1.bank_positions.reduce((acc, b) => acc + b.net_paise, 0);
    assert.equal(manualNetSum, 0);

    // 3 banks * 2 files (summary + detail) + 1 cycle manifest = 7 CSV files
    assert.equal(runV1.files.length, 7);

    // Verify every single CSV's HDR, TRL record_count, and SHA-256 body hash
    for (const file of runV1.files) {
      const check = verifySettlementCsvIntegrity(file.csv_content);
      assert.equal(check.valid, true, `CSV integrity check failed for ${file.filename}`);
      assert.equal(check.recordCount, file.record_count);
      assert.equal(check.bodySha256, file.body_sha256);
    }

    // Requirement 19: Attempting to mutate or delete a generated settlement file is blocked by DB triggers
    assert.throws(() => {
      sw.db
        .prepare(`UPDATE settlement_files SET csv_content = 'tampered' WHERE id = ?`)
        .run(runV1.files[0].id);
    }, /Req 19 Violation/);

    assert.throws(() => {
      sw.db.prepare(`DELETE FROM settlement_files WHERE id = ?`).run(runV1.files[0].id);
    }, /Req 19 Violation/);

    // Requirement 19: Re-running the cycle produces version 2 and keeps version 1
    const runV2 = settlement.runSettlementCycle({
      cycleId,
      registeredBankIds: ["BANKA", "BANKB", "BANKC"],
      now,
    });
    assert.equal(runV2.version, 2);
    assert.deepEqual(settlement.listCycleVersions(cycleId), [1, 2]);
    assert.equal(settlement.getCycleFiles(cycleId, 1)?.version, 1);

    // Requirement 20: Operator marks cycle SETTLED
    const settled = settlement.markCycleSettled({
      cycleId,
      version: 2,
      actorId: "operator-anand",
      now,
    });
    assert.equal(settled.status, "SETTLED");
  });

  it("Day 5 Fintech DSA: simplifyMultilateralSettlement compresses 200 bilateral legs into at most B-1 net transfers", () => {
    const legs: BilateralLeg[] = [];
    for (let i = 0; i < 100; i++) {
      legs.push({ fromBank: "BANKA", toBank: "BANKC", amountPaise: 1500 });
      legs.push({ fromBank: "BANKC", toBank: "BANKB", amountPaise: 1000 });
    }

    const result = simplifyMultilateralSettlement(legs);
    assert.equal(result.bilateralCount, 200);
    // 3 banks -> at most 3 - 1 = 2 transfers!
    assert.ok(result.simplifiedTransferCount <= 2);

    const netSum = Object.values(result.netPositions).reduce((a, b) => a + b, 0);
    assert.equal(netSum, 0);
  });
});
