import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";

import {
  assertPaiseInteger,
  assertPositivePaise,
  formatInrFromPaise,
  parseInrStringToPaise,
  splitMdrAndGst,
  MoneyError,
  signServiceMessage,
  verifyServiceMessage,
  maskAccountNumber,
  redactSensitiveData,
  mintRrn,
  formatStan,
  resolvePspIdFromVpa,
  validateIso8583Envelope,
  Iso8583ValidationError,
  AuditLogger,
  IdempotencyStore,
  IdempotencyConflictError,
  assertValidTransition,
  SWITCH_TRANSACTION_TRANSITIONS,
  InvalidStateTransitionError,
  DoubleEntryLedger,
} from "../src/index.ts";

describe("Day 1 Core Build — 19 Common Rules & ISO 8583 Foundation", () => {
  it("Rule 1: Enforces integer paise, rejects floats, and guarantees zero-sum MDR/GST splits", () => {
    assert.throws(() => assertPaiseInteger(1500.5), MoneyError);
    assert.throws(() => assertPaiseInteger(Number.NaN), MoneyError);
    assert.throws(() => assertPositivePaise(0), MoneyError);
    assert.throws(() => assertPositivePaise(-100), MoneyError);

    assert.equal(formatInrFromPaise(150000), "₹1,500.00");
    assert.equal(parseInrStringToPaise("₹1,500.00"), 150000);
    assert.equal(parseInrStringToPaise("99.05"), 9905);

    // 2.00% MDR (200 bps) + 18.00% GST (1800 bps) on ₹1,500.00 (150000 paise)
    const split = splitMdrAndGst(150000, 200, 1800);
    assert.equal(split.mdrFeePaise, 3000); // ₹30.00
    assert.equal(split.gstOnFeePaise, 540); // ₹5.40
    assert.equal(split.merchantNetPaise, 146460); // ₹1,464.60
    assert.equal(
      split.mdrFeePaise + split.gstOnFeePaise + split.merchantNetPaise,
      split.grossPaise
    );
  });

  it("Rules 2, 3, 4 & Project 1 Reqs 5, 6, 8, 14: Double-entry ledger, holds, 5x duplicate RRN, 3-strike PIN freeze & 0420 reversal", () => {
    const db = new DatabaseSync(":memory:");
    const ledger = new DoubleEntryLedger(db);

    // Create Anita's account with ₹5,000.00 (500000 paise) and PIN "1234"
    ledger.createAccount({
      accountNumber: "987654324521",
      branchCode: "BANKA0001",
      holderName: "Anita Sharma",
      rawPin: "1234",
      perTransactionLimitPaise: 200000, // ₹2,000.00 max per txn
      dailyLimitPaise: 400000, // ₹4,000.00 daily limit
      initialOpeningBalancePaise: 500000,
    });

    // Check derived balance view
    const initialBal = ledger.getBalance("987654324521");
    assert.equal(initialBal.ledger_balance_paise, 500000);
    assert.equal(initialBal.active_holds_paise, 0);
    assert.equal(initialBal.available_balance_paise, 500000);

    // Place a ₹1,000.00 (100000 paise) hold -> available drops to ₹4,000.00
    const holdId = ledger.placeHold({
      accountNumber: "987654324521",
      amountPaise: 100000,
      reason: "UPI Mandate Block",
    });
    assert.equal(ledger.getBalance("987654324521").available_balance_paise, 400000);
    ledger.releaseHold(holdId);
    assert.equal(ledger.getBalance("987654324521").available_balance_paise, 500000);

    // Rule 2: Unbalanced journal entry must be rejected
    assert.throws(
      () =>
        ledger.postJournalEntry({
          rrn: "630912000001",
          transactionId: "TXN-BAD",
          lines: [
            { accountNumber: "987654324521", direction: "DEBIT", amountPaise: 1000 },
            {
              accountNumber: ledger.settlementAccountNumber,
              direction: "CREDIT",
              amountPaise: 999,
            },
          ],
        }),
      MoneyError
    );

    // Project 1 Req 5 & Acceptance Test 2: Send same debit request 5 times -> 1 debit, 4 replays
    const rrn1 = "630912004512";
    const results = Array.from({ length: 5 }, () =>
      ledger.debitCustomerAccountByRrn({
        rrn: rrn1,
        transactionId: "TXN-2026110500001",
        accountNumber: "987654324521",
        amountPaise: 150000, // ₹1,500.00
        rawPin: "1234",
        messageId: "MSG-0200-1",
      })
    );

    assert.equal(results[0].response_code, "00");
    assert.equal(results[0].replayed, false);
    for (let i = 1; i < 5; i++) {
      assert.equal(results[i].response_code, "00");
      assert.equal(results[i].replayed, true);
      assert.equal(results[i].journal_id, results[0].journal_id);
    }

    // Balance changed by exactly ₹1,500.00 once (500000 - 150000 = 350000)
    assert.equal(ledger.getBalance("987654324521").available_balance_paise, 350000);
    const rrnPostings = ledger.listPostingsByRrn(rrn1);
    assert.equal(rrnPostings.length, 2); // 1 DEBIT + 1 CREDIT

    // Rule 3: Attempting to UPDATE or DELETE a posting row is blocked by DB triggers
    assert.throws(() => {
      db.prepare(`UPDATE postings SET amount_paise = 1 WHERE rrn = ?`).run(rrn1);
    }, /Rule 3 Violation/);
    assert.throws(() => {
      db.prepare(`DELETE FROM postings WHERE rrn = ?`).run(rrn1);
    }, /Rule 3 Violation/);

    // Project 1 Req 8 & Rule 3: Reverse the debit (MTI 0420)
    const revResult = ledger.reverseDebitByRrn({
      rrn: rrn1,
      transactionId: "TXN-2026110500001",
      messageId: "MSG-0420-1",
    });
    assert.equal(revResult.response_code, "00");
    assert.equal(ledger.getBalance("987654324521").available_balance_paise, 500000);

    const allPostingsAfterRev = ledger.listPostingsByRrn(rrn1);
    assert.equal(allPostingsAfterRev.length, 4); // Original 2 + Reversing 2
    assert.ok(allPostingsAfterRev[2].reversal_of !== null);
    assert.ok(allPostingsAfterRev[3].reversal_of !== null);

    // Acceptance Test 3: Per-txn limit (61) and Insufficient funds (51) write nothing
    const overLimit = ledger.debitCustomerAccountByRrn({
      rrn: "630912004513",
      transactionId: "TXN-LIMIT",
      accountNumber: "987654324521",
      amountPaise: 250000, // > 200000 per-txn limit
      rawPin: "1234",
    });
    assert.equal(overLimit.response_code, "61");

    // Place hold of ₹4,000.00 so only ₹1,000.00 is available, then try to debit ₹1,500.00 -> 51
    const bigHold = ledger.placeHold({
      accountNumber: "987654324521",
      amountPaise: 400000,
      reason: "Test Hold",
    });
    const insuff = ledger.debitCustomerAccountByRrn({
      rrn: "630912004514",
      transactionId: "TXN-INSUFF",
      accountNumber: "987654324521",
      amountPaise: 150000,
      rawPin: "1234",
    });
    assert.equal(insuff.response_code, "51");
    assert.equal(ledger.listPostingsByRrn("630912004514").length, 0);
    ledger.releaseHold(bigHold);

    // Acceptance Test 4: Wrong PIN 3 times returns 55 and freezes the account
    for (let attempt = 1; attempt <= 3; attempt++) {
      const wrongPin = ledger.debitCustomerAccountByRrn({
        rrn: `63091200990${attempt}`,
        transactionId: `TXN-WRONGPIN-${attempt}`,
        accountNumber: "987654324521",
        amountPaise: 10000,
        rawPin: "9999",
      });
      assert.equal(wrongPin.response_code, "55");
    }
    assert.equal(ledger.getAccount("987654324521")?.status, "FROZEN");

    // Even with the CORRECT PIN "1234", the frozen account rejects the debit with 55
    const whileFrozen = ledger.debitCustomerAccountByRrn({
      rrn: "630912009904",
      transactionId: "TXN-FROZEN",
      accountNumber: "987654324521",
      amountPaise: 10000,
      rawPin: "1234",
    });
    assert.equal(whileFrozen.response_code, "55");
  });

  it("Rule 5: IdempotencyStore returns first response on same payload and HTTP 409 on modified payload", () => {
    const db = new DatabaseSync(":memory:");
    const store = new IdempotencyStore(db);
    let executions = 0;

    const first = store.execute({
      scope: "POST:/pay",
      idempotencyKey: "TXN-2026110500001",
      requestPayload: { amount: 150000, payer: "anita@psp1", payee: "shop@psp2" },
      handler: () => {
        executions += 1;
        return { statusCode: 200, body: { rrn: "630912004512", status: "SUCCESS" } };
      },
    });
    assert.equal(first.replayed, false);
    assert.equal(executions, 1);

    // Same key, same payload (keys in different order) -> replays without calling handler
    const second = store.execute({
      scope: "POST:/pay",
      idempotencyKey: "TXN-2026110500001",
      requestPayload: { payee: "shop@psp2", amount: 150000, payer: "anita@psp1" },
      handler: () => {
        executions += 1;
        return { statusCode: 200, body: { rrn: "DIFFERENT", status: "SUCCESS" } };
      },
    });
    assert.equal(second.replayed, true);
    assert.equal(executions, 1);
    assert.deepEqual(second.response_body, first.response_body);

    // Same key, different amount -> HTTP 409 Conflict
    assert.throws(
      () =>
        store.execute({
          scope: "POST:/pay",
          idempotencyKey: "TXN-2026110500001",
          requestPayload: { amount: 999900, payer: "anita@psp1", payee: "shop@psp2" },
          handler: () => ({ statusCode: 200, body: {} }),
        }),
      (err: unknown) => err instanceof IdempotencyConflictError && err.statusCode === 409
    );
  });

  it("Rule 6 & Rule 8: Enforces state machine transitions and immutable audit logs", () => {
    assertValidTransition(
      "SwitchTransaction",
      SWITCH_TRANSACTION_TRANSITIONS,
      "RECEIVED",
      "DEBIT_REQUESTED"
    );
    assertValidTransition(
      "SwitchTransaction",
      SWITCH_TRANSACTION_TRANSITIONS,
      "DEBIT_REQUESTED",
      "DEBIT_UNKNOWN"
    );
    assert.throws(
      () =>
        assertValidTransition(
          "SwitchTransaction",
          SWITCH_TRANSACTION_TRANSITIONS,
          "RECEIVED",
          "SUCCESS"
        ),
      InvalidStateTransitionError
    );

    const db = new DatabaseSync(":memory:");
    const audit = new AuditLogger(db);
    const entry = audit.record({
      actorId: "operator-1",
      actorRole: "operator",
      action: "PARTICIPANT_STATUS_CHANGE",
      entityType: "Participant",
      entityId: "BANKA",
      oldValue: { status: "UP" },
      newValue: { status: "DEGRADED" },
      requestId: "REQ-1001",
    });

    assert.equal(audit.listByEntity("Participant", "BANKA").length, 1);
    assert.throws(() => {
      db.prepare(`DELETE FROM audit_logs WHERE id = ?`).run(entry.id);
    }, /Rule 8 Violation/);
  });

  it("Rules 9 & 10 + ISO 8583: Verifies HMAC signatures, 5-min replay window, key overlap & envelope validation", () => {
    const nowMs = Date.parse("2026-11-05T10:15:30+05:30");
    const tsIso = "2026-11-05T10:15:30+05:30";
    const body = JSON.stringify({ rrn: "630912004512", amount: 150000 });
    const sig = signServiceMessage(body, tsIso, "psp1_secret_v1");

    // Valid signature within 5 minutes
    const ok = verifyServiceMessage(body, tsIso, sig, "psp1_secret_v1", {
      nowMs: nowMs + 60_000,
    });
    assert.equal(ok.valid, true);

    // Key rotation overlap: signed with old secret while new secret is active
    const overlapOk = verifyServiceMessage(body, tsIso, sig, "psp1_secret_v2", {
      nowMs: nowMs + 60_000,
      previousSecret: "psp1_secret_v1",
    });
    assert.equal(overlapOk.valid, true);

    // Replay older than 5 minutes -> rejected
    const expired = verifyServiceMessage(body, tsIso, sig, "psp1_secret_v1", {
      nowMs: nowMs + 6 * 60_000,
    });
    assert.equal(expired.valid, false);
    assert.equal(expired.reason, "EXPIRED_TIMESTAMP");

    // Rule 10 masking & redaction
    assert.equal(maskAccountNumber("987654324521"), "XXXX4521");
    const scrubbed = redactSensitiveData({
      payer: "anita@psp1",
      account_number: "987654324521",
      pin: "1234",
      note: "Card 4111 2222 3333 4444 used",
    });
    assert.equal(scrubbed.account_number, "XXXX4521");
    assert.equal(scrubbed.pin, "[REDACTED]");
    assert.equal(scrubbed.note, "Card [REDACTED_PAN] used");

    // ISO 8583 Envelope validation
    const stan = formatStan(4512);
    const rrn = mintRrn(stan, new Date("2026-11-05T10:15:30Z"));
    assert.equal(stan, "004512");
    assert.equal(rrn.length, 12);
    assert.equal(resolvePspIdFromVpa("anita@psp1"), "PSP1");

    validateIso8583Envelope({
      mti: "0200",
      transaction_id: "TXN-2026110500001",
      stan,
      rrn,
      processing_code: "PAY",
      amount: 150000,
      currency: "356",
      transmission_time: tsIso,
      payer_vpa: "anita@psp1",
      payee_vpa: "shop@psp2",
      payer_psp_id: "PSP1",
      payee_psp_id: "PSP2",
      remitter_bank_id: "BANKA",
      beneficiary_bank_id: "BANKC",
      account_reference: "XXXX4521",
      signature: sig,
    });

    // Unmasked account reference outside bank core must fail validation
    assert.throws(
      () =>
        validateIso8583Envelope({
          mti: "0200",
          transaction_id: "TXN-2026110500001",
          stan,
          rrn,
          processing_code: "PAY",
          amount: 150000,
          currency: "356",
          transmission_time: tsIso,
          payer_vpa: "anita@psp1",
          account_reference: "987654324521", // Raw unmasked!
          signature: sig,
        }),
      Iso8583ValidationError
    );
  });
});
