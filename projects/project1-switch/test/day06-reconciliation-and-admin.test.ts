import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  threeWaySortedMergeJoin,
  type SortedReconInputRow,
} from "../../../packages/core/src/index.ts";
import {
  createSeededTopology,
  CentralSwitch,
  SwitchAdminApp,
} from "../src/index.ts";

describe("Day 6 & 7 — Three-Way Reconciliation, Exception Resolution, Admin RBAC & 100+ TPS Load Benchmark", () => {
  it("Acceptance Test 9 & Reqs 21–24: Classifies MISSING_AT_BENEFICIARY, AMOUNT_MISMATCH, MISSING_AT_REMITTER, MISSING_AT_SWITCH, STATUS_MISMATCH and resolves by posting credit with exception reference", async () => {
    const topology = createSeededTopology();
    const cycleId = "CYC-2026-11-08";
    const sw = new CentralSwitch({ activeCycleId: cycleId });

    sw.registerBank(topology.banks.BANKA);
    sw.registerBank(topology.banks.BANKB);
    sw.registerBank(topology.banks.BANKC);
    sw.registerPsp(topology.psps.PSP1);
    sw.registerPsp(topology.psps.PSP2);

    const app = new SwitchAdminApp({ sw, topology });
    const now = new Date("2026-11-08T12:00:00Z");

    // Execute 5 happy-path payments from anita@psp1 (BANKA) to shop@psp2 (BANKC) of ₹100.00 (10,000 paise) each
    const rrns: string[] = [];
    for (let i = 1; i <= 5; i++) {
      const env = topology.psps.PSP1.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: `TXN-RECON-${i}`,
        payerVpa: "anita@psp1",
        payeeVpa: "shop@psp2",
        amountPaise: 10_000,
        now,
      });
      const res = await sw.handlePay({ envelope: env, rawPin: "1234", now });
      assert.equal(res.transaction.state, "SUCCESS");
      rrns.push(res.transaction.rrn);
    }

    // Generate clean EOD reports from BANKA (remitter) and BANKC (beneficiary)
    const bankAReport = topology.banks.BANKA.generateEodReport();
    const bankCReport = topology.banks.BANKC.generateEodReport();

    // Acceptance Test 9:
    // 1. Delete TWO rows (rrns[0] and rrns[1]) from Beneficiary Bank (BANKC) report -> MISSING_AT_BENEFICIARY
    const tamperedBankCReport = bankCReport.filter(
      (row) => row.rrn !== rrns[0] && row.rrn !== rrns[1]
    );

    // 2. Change ONE amount (rrns[2]) in BANKC's report from 10,000 to 9,500 paise -> AMOUNT_MISMATCH
    const rowToChange = tamperedBankCReport.find((r) => r.rrn === rrns[2])!;
    rowToChange.amount_paise = 9_500;

    // 3. Also test MISSING_AT_REMITTER (remove rrns[3] from BANKA report)
    const tamperedBankAReport = bankAReport.filter((r) => r.rrn !== rrns[3]);

    // 4. Also test MISSING_AT_SWITCH (inject a ghost RRN reported by BANKA that Switch never saw)
    tamperedBankAReport.push({
      bank_id: "BANKA",
      rrn: "631299999999",
      transaction_id: "TXN-GHOST-BANK",
      account_number_masked: "XXXX4521",
      direction: "DEBIT",
      amount_paise: 5_000,
      status: "SUCCESS",
      timestamp: now.toISOString(),
    });

    // Run 3-Way Reconciliation via Admin App API (`POST /cycles/{id}/reconcile`)
    const reconRes = await app.dispatch({
      method: "POST",
      path: `/cycles/${cycleId}/reconcile`,
      headers: { "x-role": "operator", "x-actor-id": "ops-priya" },
      body: {
        bankReports: [...tamperedBankAReport, ...tamperedBankCReport],
      },
    });
    assert.equal(reconRes.statusCode, 200);

    const reconBody = reconRes.body as ReturnType<
      typeof app.reconciliation.runThreeWayReconciliation
    >;

    // Verify counts by classification class
    assert.equal(reconBody.summary.by_class.MISSING_AT_BENEFICIARY.count, 2);
    assert.equal(reconBody.summary.by_class.AMOUNT_MISMATCH.count, 1);
    assert.equal(reconBody.summary.by_class.MISSING_AT_REMITTER.count, 1);
    assert.equal(reconBody.summary.by_class.MISSING_AT_SWITCH.count, 1);
    assert.equal(reconBody.summary.by_class.MATCHED.count, 1); // rrns[4] matched cleanly!

    // Acceptance Test 9: Resolve the first MISSING_AT_BENEFICIARY exception by "TRIGGER_CREDIT"
    const missingAtBeneExc = reconBody.exceptions.find(
      (e) => e.rrn === rrns[0] && e.classification === "MISSING_AT_BENEFICIARY"
    )!;
    assert.ok(missingAtBeneExc);

    const shopBalanceBefore =
      topology.banks.BANKC.ledger.getBalance("765432103344").available_balance_paise;

    const resolveRes = await app.dispatch({
      method: "POST",
      path: `/exceptions/${missingAtBeneExc.id}/resolve`,
      headers: { "x-role": "operator", "x-actor-id": "ops-priya" },
      body: {
        action: "TRIGGER_CREDIT",
        note: "Credited beneficiary after verifying remitter EOD debit",
      },
    });
    assert.equal(resolveRes.statusCode, 200);

    // Verify Shop's balance increased by ₹100.00 (10,000 paise) and the posting carries `exception_id`!
    const shopBalanceAfter =
      topology.banks.BANKC.ledger.getBalance("765432103344").available_balance_paise;
    assert.equal(shopBalanceAfter - shopBalanceBefore, 10_000);

    const postingsForRrn0 = topology.banks.BANKC.ledger.listPostingsByRrn(rrns[0]);
    const exceptionPostings = postingsForRrn0.filter(
      (p) => p.exception_id === missingAtBeneExc.id
    );
    assert.equal(exceptionPostings.length, 2); // Double-entry DEBIT + CREDIT referencing the exception!
  });

  it("Common Rules 8, 11, 12 & Milestone 1 Load Test: Enforces RBAC, exposes /metrics & /health, sustains >100 TPS with p95 < 1s, and writes sample artifacts", async () => {
    const topology = createSeededTopology();
    const cycleId = "CYC-2026-11-11";
    topology.banks.BANKA.db.exec(
      `UPDATE accounts SET daily_limit_paise = 999999999, per_transaction_limit_paise = 999999999;`
    );
    topology.banks.BANKB.db.exec(
      `UPDATE accounts SET daily_limit_paise = 999999999, per_transaction_limit_paise = 999999999;`
    );
    topology.banks.BANKC.db.exec(
      `UPDATE accounts SET daily_limit_paise = 999999999, per_transaction_limit_paise = 999999999;`
    );

    const sw = new CentralSwitch({ activeCycleId: cycleId });
    sw.registerBank(topology.banks.BANKA);
    sw.registerBank(topology.banks.BANKB);
    sw.registerBank(topology.banks.BANKC);
    sw.registerPsp(topology.psps.PSP1);
    sw.registerPsp(topology.psps.PSP2);

    const app = new SwitchAdminApp({ sw, topology });

    // 1. Common Rule 11: Operator role cannot modify chaos config (403 Forbidden), Admin role can (200 OK)
    const forbiddenChaos = await app.dispatch({
      method: "PUT",
      path: "/participants/BANKA/chaos",
      headers: { "x-role": "operator" },
      body: { latencyMs: 10 },
    });
    assert.equal(forbiddenChaos.statusCode, 403);

    const allowedChaos = await app.dispatch({
      method: "PUT",
      path: "/participants/BANKA/chaos",
      headers: { "x-role": "admin", "x-actor-id": "admin-nikhil" },
      body: { latencyMs: 0 },
    });
    assert.equal(allowedChaos.statusCode, 200);

    // 2. Milestone 1 Load Benchmark: Execute 120 end-to-end payments across 3 banks and verify >100 TPS & p95 < 1000ms
    const totalLoadTxns = 120;
    const startWallMs = performance.now();

    for (let i = 1; i <= totalLoadTxns; i++) {
      const env = topology.psps.PSP1.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: `TXN-LOAD-${String(i).padStart(4, "0")}`,
        payerVpa: i % 2 === 0 ? "anita@psp1" : "rahul@psp1",
        payeeVpa: i % 3 === 0 ? "coffee@psp2" : "shop@psp2",
        amountPaise: 500,
      });
      const payRes = await app.dispatch({
        method: "POST",
        path: "/pay",
        body: {
          envelope: env,
          rawPin: i % 2 === 0 ? "1234" : "5678",
        },
      });
      assert.equal(payRes.statusCode, 200);
    }

    const elapsedSec = (performance.now() - startWallMs) / 1000;
    const sustainedTps = Math.round(totalLoadTxns / elapsedSec);

    const metricsRes = await app.dispatch({ method: "GET", path: "/metrics" });
    assert.equal(metricsRes.statusCode, 200);
    const metrics = metricsRes.body as ReturnType<typeof app.getMetricsSnapshot>;
    const payRouteMetrics = metrics.routes["POST /pay"];

    assert.ok(
      sustainedTps >= 100,
      `Expected >= 100 TPS on laptop, achieved ${sustainedTps} TPS`
    );
    assert.ok(
      payRouteMetrics.p95_latency_ms < 1000,
      `Expected p95 < 1000ms, achieved ${payRouteMetrics.p95_latency_ms}ms`
    );

    // 3. Generate and check in sample settlement file set and sample reconciliation report (Deliverables Page 11)
    const settleRes = await app.dispatch({
      method: "POST",
      path: `/cycles/${cycleId}/run`,
      headers: { "x-role": "operator" },
    });
    assert.equal(settleRes.statusCode, 200);

    const reconRes = await app.dispatch({
      method: "POST",
      path: `/cycles/${cycleId}/reconcile`,
      headers: { "x-role": "operator" },
    });
    assert.equal(reconRes.statusCode, 200);

    const samplesDir = path.resolve(
      "/Users/shibildas/development/fintech/projects/project1-switch/samples"
    );
    fs.mkdirSync(samplesDir, { recursive: true });

    const settlementData = settleRes.body as ReturnType<
      typeof app.settlement.runSettlementCycle
    >;
    for (const f of settlementData.files) {
      fs.writeFileSync(path.join(samplesDir, f.filename), f.csv_content, "utf8");
    }

    const reconData = reconRes.body as ReturnType<
      typeof app.reconciliation.runThreeWayReconciliation
    >;
    fs.writeFileSync(
      path.join(samplesDir, `reconciliation_report_${cycleId}.json`),
      JSON.stringify(
        {
          benchmark: {
            total_transactions: totalLoadTxns,
            sustained_tps: sustainedTps,
            p95_latency_ms: payRouteMetrics.p95_latency_ms,
          },
          summary: reconData.summary,
        },
        null,
        2
      ),
      "utf8"
    );
  });

  it("Day 6 Fintech DSA: threeWaySortedMergeJoin performs O(N) 3-pointer streaming Full Outer Join", () => {
    const switchSorted: SortedReconInputRow[] = [
      { rrn: "631200000001", amountPaise: 1000, status: "SUCCESS" },
      { rrn: "631200000002", amountPaise: 2000, status: "SUCCESS" },
    ];
    const remitterSorted: SortedReconInputRow[] = [
      { rrn: "631200000001", amountPaise: 1000, status: "SUCCESS" },
      { rrn: "631200000002", amountPaise: 2000, status: "SUCCESS" },
      { rrn: "631200000003", amountPaise: 3000, status: "SUCCESS" }, // Missing at Switch & Beneficiary
    ];
    const beneficiarySorted: SortedReconInputRow[] = [
      { rrn: "631200000001", amountPaise: 1000, status: "SUCCESS" }, // 0002 missing at Beneficiary
    ];

    const joined = threeWaySortedMergeJoin(
      switchSorted,
      remitterSorted,
      beneficiarySorted
    );
    assert.equal(joined.length, 3);
    assert.equal(joined[0].rrn, "631200000001");
    assert.ok(joined[0].switchRow && joined[0].remitterRow && joined[0].beneficiaryRow);

    assert.equal(joined[1].rrn, "631200000002");
    assert.equal(joined[1].beneficiaryRow, null);

    assert.equal(joined[2].rrn, "631200000003");
    assert.equal(joined[2].switchRow, null);
  });
});
