import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PaymentCorridorGraph,
  INR_CURRENCY_NUMERIC,
  signServiceMessage,
  type Iso8583MessageEnvelope,
} from "../../../packages/core/src/index.ts";
import {
  createSeededTopology,
  CentralSwitch,
} from "../src/index.ts";

function setupSwitchWithSeededTopology() {
  const topology = createSeededTopology();
  const sw = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-07",
  });

  sw.registerBank(topology.banks.BANKA);
  sw.registerBank(topology.banks.BANKB);
  sw.registerBank(topology.banks.BANKC);
  sw.registerPsp(topology.psps.PSP1);
  sw.registerPsp(topology.psps.PSP2);

  return { sw, ...topology };
}

describe("Day 3 & 4 Switch Flow — 6-Hop Pay, 5x Concurrency, Timeouts (CHK), 0420 Reversal, Deemed-Approved & Crash Recovery", () => {
  it("Acceptance Test 1: Happy path pay ₹1,500 from anita@psp1 to shop@psp2 changes both balances and logs exactly 6 hops", async () => {
    const { sw, banks, psps } = setupSwitchWithSeededTopology();
    const now = new Date("2026-11-07T10:15:30Z");

    const reqEnvelope = psps.PSP1.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: "TXN-2026110700001",
      payerVpa: "anita@psp1",
      payeeVpa: "shop@psp2",
      amountPaise: 150_000, // ₹1,500.00
      now,
    });

    const result = await sw.handlePay({
      envelope: reqEnvelope,
      rawPin: "1234",
      now,
    });

    assert.equal(result.replayed, false);
    assert.equal(result.envelope.mti, "0210");
    assert.equal(result.envelope.response_code, "00");
    assert.equal(result.transaction.state, "SUCCESS");
    assert.equal(result.transaction.settlement_cycle_id, "CYC-2026-11-07");

    // Verify both bank balances changed by exactly ₹1,500.00 (150,000 paise)
    assert.equal(
      banks.BANKA.ledger.getBalance("987654324521").available_balance_paise,
      850_000 // ₹10,000 - ₹1,500 = ₹8,500
    );
    assert.equal(
      banks.BANKC.ledger.getBalance("765432103344").available_balance_paise,
      350_000 // ₹2,000 + ₹1,500 = ₹3,500
    );

    // Verify the console message log shows exactly 6 hops
    assert.equal(result.hops.length, 6);
    assert.deepEqual(
      result.hops.map((h) => `${h.hop_number}:${h.from_participant}->${h.to_participant}:${h.mti}`),
      [
        "1:PSP1->SWITCH:0200",
        "2:SWITCH->BANKA:0200",
        "3:BANKA->SWITCH:0210",
        "4:SWITCH->BANKC:0200",
        "5:BANKC->SWITCH:0210",
        "6:SWITCH->PSP1:0210",
      ]
    );

    // Verify state history transitions
    const history = sw.listStateHistoryByRrn(result.transaction.rrn);
    assert.deepEqual(
      history.map((s) => s.to_state),
      ["RECEIVED", "DEBIT_REQUESTED", "DEBITED", "CREDIT_REQUESTED", "SUCCESS"]
    );
  });

  it("Acceptance Test 2: Duplicate submission sent 5 times concurrently produces 1 debit, 1 credit, and 1 RRN", async () => {
    const { sw, banks, psps } = setupSwitchWithSeededTopology();
    const now = new Date("2026-11-07T10:20:00Z");

    // Add 15ms latency on BANKA so all 5 requests overlap in flight
    banks.BANKA.setChaosConfig({ latencyMs: 15 });

    const reqEnvelope = psps.PSP1.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: "TXN-BURST-5X",
      payerVpa: "anita@psp1",
      payeeVpa: "shop@psp2",
      amountPaise: 150_000,
      now,
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () =>
        sw.handlePay({
          envelope: reqEnvelope,
          rawPin: "1234",
          now,
        })
      )
    );

    const uniqueRrns = new Set(responses.map((r) => r.transaction.rrn));
    assert.equal(uniqueRrns.size, 1);

    const rrn = responses[0].transaction.rrn;
    assert.equal(banks.BANKA.ledger.listPostingsByRrn(rrn).length, 2); // 1 debit journal
    assert.equal(banks.BANKC.ledger.listPostingsByRrn(rrn).length, 2); // 1 credit journal

    assert.equal(
      banks.BANKA.ledger.getBalance("987654324521").available_balance_paise,
      850_000
    );
    assert.equal(
      banks.BANKC.ledger.getBalance("765432103344").available_balance_paise,
      350_000
    );
  });

  it("Acceptance Tests 3, 4 & Req 3: Unknown VPA returns 14, Insufficient Funds returns 51, 3 Wrong PINs return 55 and freeze account", async () => {
    const { sw, banks, psps } = setupSwitchWithSeededTopology();
    const now = new Date("2026-11-07T10:25:00Z");

    // 1. Unknown VPA -> 14
    const unknownVpaEnv = psps.PSP1.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: "TXN-UNKNOWN-VPA",
      payerVpa: "anita@psp1",
      payeeVpa: "nobody@psp2",
      amountPaise: 10_000,
      now,
    });
    const res14 = await sw.handlePay({ envelope: unknownVpaEnv, rawPin: "1234", now });
    assert.equal(res14.envelope.response_code, "14");
    assert.equal(res14.transaction.state, "FAILED");

    // 2. Insufficient funds -> Place hold on Anita's account leaving ₹500 available, then try to pay ₹1,500 -> 51
    const holdId = banks.BANKA.ledger.placeHold({
      accountNumber: "987654324521",
      amountPaise: 950_000,
      reason: "Test Hold",
    });
    const insuffEnv = psps.PSP1.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: "TXN-INSUFF-51",
      payerVpa: "anita@psp1",
      payeeVpa: "shop@psp2",
      amountPaise: 150_000,
      now,
    });
    const res51 = await sw.handlePay({ envelope: insuffEnv, rawPin: "1234", now });
    assert.equal(res51.envelope.response_code, "51");
    assert.equal(res51.transaction.state, "FAILED");
    assert.equal(banks.BANKA.ledger.listPostingsByRrn(res51.transaction.rrn).length, 0);
    banks.BANKA.ledger.releaseHold(holdId);

    // 3. Wrong PIN 3 times -> 55, then freezes account even for right PIN
    for (let i = 1; i <= 3; i++) {
      const wrongEnv = psps.PSP1.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: `TXN-WRONG-PIN-${i}`,
        payerVpa: "anita@psp1",
        payeeVpa: "shop@psp2",
        amountPaise: 10_000,
        now,
      });
      const res55 = await sw.handlePay({ envelope: wrongEnv, rawPin: "0000", now });
      assert.equal(res55.envelope.response_code, "55");
    }
    assert.equal(banks.BANKA.ledger.getAccount("987654324521")?.status, "FROZEN");
  });

  it("Acceptance Test 5: Remitter bank hangs after debiting -> Switch status-checks (CHK), finds debit, and completes credit to SUCCESS", async () => {
    const { sw, banks, psps } = setupSwitchWithSeededTopology();
    const now = new Date("2026-11-07T10:30:00Z");

    // Enable "debit then never respond" mode on BANKA
    banks.BANKA.setChaosConfig({ debitThenHang: true });

    const reqEnvelope = psps.PSP1.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: "TXN-REMITTER-HANG",
      payerVpa: "anita@psp1",
      payeeVpa: "shop@psp2",
      amountPaise: 150_000,
      now,
    });

    const result = await sw.handlePay({
      envelope: reqEnvelope,
      rawPin: "1234",
      now,
    });

    assert.equal(result.transaction.state, "SUCCESS");
    assert.equal(result.envelope.response_code, "00");

    // State history must show DEBIT_REQUESTED -> DEBIT_UNKNOWN -> DEBITED -> CREDIT_REQUESTED -> SUCCESS
    const states = sw.listStateHistoryByRrn(result.transaction.rrn).map((s) => s.to_state);
    assert.deepEqual(states, [
      "RECEIVED",
      "DEBIT_REQUESTED",
      "DEBIT_UNKNOWN",
      "DEBITED",
      "CREDIT_REQUESTED",
      "SUCCESS",
    ]);

    // Exactly 1 debit at BANKA and 1 credit at BANKC
    assert.equal(
      banks.BANKA.ledger.getBalance("987654324521").available_balance_paise,
      850_000
    );
    assert.equal(
      banks.BANKC.ledger.getBalance("765432103344").available_balance_paise,
      350_000
    );
  });

  it("Acceptance Test 6 & Req 9: Beneficiary bank down -> credit retries fail -> 0420 Reversal re-credits payer -> REVERSED + Deemed-Approved detection", async () => {
    const { sw, banks, psps } = setupSwitchWithSeededTopology();
    const now = new Date("2026-11-07T10:35:00Z");

    // Force Beneficiary Bank (BANKC) DOWN
    banks.BANKC.setChaosConfig({ forceDown: true });

    const reqEnvelope = psps.PSP1.createSignedRequestEnvelope({
      mti: "0200",
      processingCode: "PAY",
      transactionId: "TXN-BENEFICIARY-DOWN",
      payerVpa: "anita@psp1",
      payeeVpa: "shop@psp2",
      amountPaise: 150_000,
      now,
    });

    const result = await sw.handlePay({
      envelope: reqEnvelope,
      rawPin: "1234",
      now,
    });

    assert.equal(result.transaction.state, "REVERSED");
    assert.equal(result.transaction.credit_retry_count, 2);

    // Payer's net balance is completely unchanged (₹10,000.00 = 1,000,000 paise)
    assert.equal(
      banks.BANKA.ledger.getBalance("987654324521").available_balance_paise,
      1_000_000
    );

    // State history shows CREDIT_REQUESTED -> CREDIT_PENDING -> REVERSAL_REQUESTED -> REVERSED
    const states = sw.listStateHistoryByRrn(result.transaction.rrn).map((s) => s.to_state);
    assert.deepEqual(states, [
      "RECEIVED",
      "DEBIT_REQUESTED",
      "DEBITED",
      "CREDIT_REQUESTED",
      "CREDIT_PENDING",
      "REVERSAL_REQUESTED",
      "REVERSED",
    ]);

    // Requirement 9: Late 0210 with code 00 arrives after reversal -> flagged as deemed_approved_conflict!
    const late0210: Iso8583MessageEnvelope = {
      mti: "0210",
      transaction_id: result.transaction.transaction_id,
      stan: result.transaction.stan,
      rrn: result.transaction.rrn,
      processing_code: "PAY",
      amount: 150_000,
      currency: INR_CURRENCY_NUMERIC,
      transmission_time: now.toISOString(),
      payer_vpa: "anita@psp1",
      payee_vpa: "shop@psp2",
      response_code: "00",
      signature: signServiceMessage("late", now.toISOString(), banks.BANKA.config.sharedSecret),
    };
    const conflict = sw.handleLateRemitterResponse(late0210, now);
    assert.equal(conflict.conflictDetected, true);
    assert.equal(conflict.transaction.state, "REVERSED"); // Keeps the reversal!
    assert.equal(conflict.transaction.deemed_approved_conflict, 1);
  });

  it("Acceptance Test 7 & 10: Switch survives restart mid-transaction and Balance Enquiry writes 0 postings", async () => {
    const { sw, banks, psps } = setupSwitchWithSeededTopology();
    const now = new Date("2026-11-07T10:40:00Z");

    // Simulate a transaction stuck in CREDIT_PENDING when the Switch crashed
    const rrnStuck = "631110009999";
    banks.BANKA.ledger.debitCustomerAccountByRrn({
      rrn: rrnStuck,
      transactionId: "TXN-CRASH-MID-FLIGHT",
      accountNumber: "987654324521",
      amountPaise: 100_000,
      rawPin: "1234",
      now,
    });

    sw.db
      .prepare(
        `INSERT INTO switch_transactions (
          transaction_id, rrn, stan, type, amount_paise, currency,
          payer_vpa, payee_vpa, payer_psp_id, payee_psp_id,
          remitter_bank_id, beneficiary_bank_id, state, created_at, updated_at
        ) VALUES ('TXN-CRASH-MID-FLIGHT', ?, '000099', 'PAY', 100000, '356',
          'anita@psp1', 'shop@psp2', 'PSP1', 'PSP2', 'BANKA', 'BANKC',
          'CREDIT_PENDING', ?, ?)`
      )
      .run(rrnStuck, now.toISOString(), now.toISOString());

    // On Switch startup, resumeInFlightTransactions completes the credit leg to BANKC!
    const resumed = await sw.resumeInFlightTransactions(now);
    assert.equal(resumed.length, 1);
    assert.equal(resumed[0].state, "SUCCESS");
    assert.equal(
      banks.BANKC.ledger.getBalance("765432103344").available_balance_paise,
      300_000 // ₹2,000 + ₹1,000
    );

    // Acceptance Test 10: Balance enquiry through Switch writes 0 postings and logs 4 hops
    const balEnv = psps.PSP1.createSignedRequestEnvelope({
      mti: "0100",
      processingCode: "BAL",
      transactionId: "TXN-BAL-CHECK",
      payerVpa: "anita@psp1",
      amountPaise: 0,
      now,
    });
    const balRes = await sw.handleBalanceEnquiry({
      envelope: balEnv,
      rawPin: "1234",
      now,
    });
    assert.equal(balRes.envelope.response_code, "00");
    assert.equal(balRes.available_balance_paise, 900_000); // ₹9,000.00
    assert.equal(balRes.hops.length, 4);
  });

  it("Day 3 Fintech DSA: PaymentCorridorGraph finds BFS min-hop and Dijkstra lowest-cost routes while bypassing DOWN banks", () => {
    const graph = new PaymentCorridorGraph();

    // Direct corridor BANKA -> BANKC has high latency (500ms), whereas BANKA -> SWITCH -> BANKC is 40ms
    graph.addCorridor({ from: "BANKA", to: "BANKC", latencyMs: 500, feeBps: 5, active: true });
    graph.addCorridor({ from: "BANKA", to: "SWITCH", latencyMs: 20, feeBps: 1, active: true });
    graph.addCorridor({ from: "SWITCH", to: "BANKC", latencyMs: 20, feeBps: 1, active: true });
    graph.addCorridor({ from: "BANKA", to: "BANKB", latencyMs: 30, feeBps: 1, active: true });
    graph.addCorridor({ from: "BANKB", to: "BANKC", latencyMs: 30, feeBps: 1, active: true });

    // 1. BFS finds minimum-hop route (BANKA -> BANKC, 1 hop)
    assert.deepEqual(graph.findMinHopRouteBfs("BANKA", "BANKC"), ["BANKA", "BANKC"]);

    // 2. Dijkstra finds lowest latency+fee route (BANKA -> SWITCH -> BANKC, 40ms total)
    const best = graph.findOptimalRouteDijkstra("BANKA", "BANKC");
    assert.ok(best);
    assert.deepEqual(best.path, ["BANKA", "SWITCH", "BANKC"]);
    assert.equal(best.totalLatencyMs, 40);

    // 3. Mark SWITCH as DOWN -> Dijkstra automatically reroutes via BANKB (60ms total)!
    graph.setNodeDown("SWITCH", true);
    const rerouted = graph.findOptimalRouteDijkstra("BANKA", "BANKC");
    assert.ok(rerouted);
    assert.deepEqual(rerouted.path, ["BANKA", "BANKB", "BANKC"]);
    assert.equal(rerouted.totalLatencyMs, 60);
  });
});
