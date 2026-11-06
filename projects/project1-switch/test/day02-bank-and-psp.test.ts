import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  signServiceMessage,
  INR_CURRENCY_NUMERIC,
  RoutingPrefixTrie,
  type Iso8583MessageEnvelope,
} from "../../../packages/core/src/index.ts";
import {
  createSeededTopology,
  BankTimeoutSimulatedError,
} from "../src/index.ts";

function buildSignedSwitchToBankEnvelope(
  unsigned: Omit<Iso8583MessageEnvelope, "signature">,
  bankSecret: string
): Iso8583MessageEnvelope {
  const rawBody = JSON.stringify(unsigned);
  const signature = signServiceMessage(
    rawBody,
    unsigned.transmission_time,
    bankSecret
  );
  return { ...unsigned, signature };
}

describe("Day 2 Build — 3 Bank Core Simulators, 2 PSP Directories, Chaos & EOD Reports", () => {
  it("Req 2 & Rule 10: PSP directory resolves VPAs with masked accounts (XXXX4521) and enforces namespace uniqueness", () => {
    const { psps } = createSeededTopology();

    const anita = psps.PSP1.lookupVpaExternal("anita@psp1");
    assert.ok(anita);
    assert.equal(anita.bank_id, "BANKA");
    assert.equal(anita.masked_account, "XXXX4521");
    assert.equal(anita.holder_name, "Anita Sharma");
    // Ensure raw account_number is not present on external lookup object
    assert.equal("account_number" in anita, false);

    // Unknown VPA returns null (Switch maps this to ISO code 14)
    assert.equal(psps.PSP1.lookupVpaExternal("ghost@psp1"), null);

    // Duplicate VPA registration fails
    assert.throws(() =>
      psps.PSP1.registerVpa({
        vpa: "anita@psp1",
        bankId: "BANKA",
        accountNumber: "111122223333",
        holderName: "Duplicate Anita",
      })
    );

    // Wrong PSP suffix registration fails
    assert.throws(() =>
      psps.PSP1.registerVpa({
        vpa: "merchant@psp2",
        bankId: "BANKC",
        accountNumber: "111122223333",
        holderName: "Wrong PSP",
      })
    );
  });

  it("Reqs 7, 11, 15, 16: Bank Core handles Balance Enquiry (0 postings), 'Debit Then Hang' chaos + CHK recovery, Reversal & EOD Report", async () => {
    const { banks, psps } = createSeededTopology();
    const now = new Date("2026-11-06T10:00:00Z");

    const anitaInternal = psps.PSP1.resolveBankAccountInternal("anita@psp1")!;
    const shopInternal = psps.PSP2.resolveBankAccountInternal("shop@psp2")!;

    // 1. Requirement 11 & Acceptance Test 10: Balance enquiry (MTI 0100 BAL) returns available balance and writes 0 postings
    const balEnv = buildSignedSwitchToBankEnvelope(
      {
        mti: "0100",
        transaction_id: "TXN-BAL-001",
        stan: "000001",
        rrn: "631010000001",
        processing_code: "BAL",
        amount: 0,
        currency: INR_CURRENCY_NUMERIC,
        transmission_time: now.toISOString(),
        payer_vpa: "anita@psp1",
      },
      banks.BANKA.config.sharedSecret
    );

    const balRes = await banks.BANKA.handleBalanceEnquiry({
      envelope: balEnv,
      accountNumber: anitaInternal.account_number,
      rawPin: "1234",
      now,
    });
    assert.equal(balRes.envelope.mti, "0110");
    assert.equal(balRes.envelope.response_code, "00");
    assert.equal(balRes.available_balance_paise, 1_000_000); // ₹10,000.00
    assert.equal(banks.BANKA.ledger.listPostingsByRrn("631010000001").length, 0);

    // 2. Requirement 15 & Acceptance Test 5: Enable "debit then never respond" chaos on BANKA
    banks.BANKA.setChaosConfig({ debitThenHang: true });

    const rrnHang = "631010000002";
    const debitEnv = buildSignedSwitchToBankEnvelope(
      {
        mti: "0200",
        transaction_id: "TXN-PAY-HANG",
        stan: "000002",
        rrn: rrnHang,
        processing_code: "PAY",
        amount: 150_000, // ₹1,500.00
        currency: INR_CURRENCY_NUMERIC,
        transmission_time: now.toISOString(),
        payer_vpa: "anita@psp1",
        payee_vpa: "shop@psp2",
      },
      banks.BANKA.config.sharedSecret
    );

    // Bank commits the debit in SQLite, then throws BankTimeoutSimulatedError!
    await assert.rejects(
      () =>
        banks.BANKA.handleDebit({
          envelope: debitEnv,
          accountNumber: anitaInternal.account_number,
          rawPin: "1234",
          now,
        }),
      BankTimeoutSimulatedError
    );

    // Verify money WAS debited inside BANKA's ledger despite the timeout!
    assert.equal(
      banks.BANKA.ledger.getBalance(anitaInternal.account_number)
        .available_balance_paise,
      850_000 // ₹8,500.00
    );

    // 3. Requirement 7: Switch sends status check (MTI 0100 processing_code CHK) on the same RRN
    const chkEnv = buildSignedSwitchToBankEnvelope(
      {
        mti: "0100",
        transaction_id: "TXN-PAY-HANG",
        stan: "000003",
        rrn: rrnHang,
        processing_code: "CHK",
        amount: 0,
        currency: INR_CURRENCY_NUMERIC,
        transmission_time: now.toISOString(),
        payer_vpa: "anita@psp1",
      },
      banks.BANKA.config.sharedSecret
    );

    const chkRes = await banks.BANKA.handleStatusCheck({
      envelope: chkEnv,
      operation: "DEBIT",
      now,
    });
    assert.equal(chkRes.found, true);
    assert.equal(chkRes.original_response_code, "00");
    assert.equal(chkRes.envelope.mti, "0110");
    assert.equal(chkRes.envelope.response_code, "00");

    // 4. Credit Beneficiary Bank (BANKC) with the same RRN
    const creditEnv = buildSignedSwitchToBankEnvelope(
      {
        mti: "0200",
        transaction_id: "TXN-PAY-HANG",
        stan: "000004",
        rrn: rrnHang,
        processing_code: "PAY",
        amount: 150_000,
        currency: INR_CURRENCY_NUMERIC,
        transmission_time: now.toISOString(),
        payer_vpa: "anita@psp1",
        payee_vpa: "shop@psp2",
      },
      banks.BANKC.config.sharedSecret
    );

    const creditRes = await banks.BANKC.handleCredit({
      envelope: creditEnv,
      accountNumber: shopInternal.account_number,
      now,
    });
    assert.equal(creditRes.response_code, "00");
    assert.equal(
      banks.BANKC.ledger.getBalance(shopInternal.account_number)
        .available_balance_paise,
      350_000 // ₹2,000 + ₹1,500 = ₹3,500.00
    );

    // 5. Requirement 16: Independent EOD transaction reports from BANKA and BANKC
    const bankAEod = banks.BANKA.generateEodReport();
    const bankCEod = banks.BANKC.generateEodReport();

    assert.equal(bankAEod.length, 1);
    assert.equal(bankAEod[0].rrn, rrnHang);
    assert.equal(bankAEod[0].direction, "DEBIT");
    assert.equal(bankAEod[0].amount_paise, 150_000);
    assert.equal(bankAEod[0].status, "SUCCESS");
    assert.equal(bankAEod[0].account_number_masked, "XXXX4521");

    assert.equal(bankCEod.length, 1);
    assert.equal(bankCEod[0].rrn, rrnHang);
    assert.equal(bankCEod[0].direction, "CREDIT");
    assert.equal(bankCEod[0].amount_paise, 150_000);
    assert.equal(bankCEod[0].status, "SUCCESS");
    assert.equal(bankCEod[0].account_number_masked, "XXXX3344");
  });

  it("Day 2 Fintech DSA: RoutingPrefixTrie resolves Longest-Prefix-Match in O(L) for Card BINs and IFSC prefixes", () => {
    const binTrie = new RoutingPrefixTrie<{ network: string; issuer: string }>();

    binTrie.insert("4", { network: "VISA", issuer: "GENERIC_VISA" });
    binTrie.insert("4111", { network: "VISA", issuer: "VISA_INDIA_DOMESTIC" });
    binTrie.insert("411122", { network: "VISA", issuer: "HDFC_CREDIT" });
    binTrie.insert("52", { network: "MASTERCARD", issuer: "GENERIC_MC" });
    binTrie.insert("60", { network: "RUPAY", issuer: "NPCI_RUPAY" });

    // Longest prefix "411122" wins over "4111" and "4"
    const hdfcMatch = binTrie.longestPrefixMatch("4111229988776655");
    assert.deepEqual(hdfcMatch, {
      prefix: "411122",
      value: { network: "VISA", issuer: "HDFC_CREDIT" },
    });

    // Falls back to "4111" when 6-digit BIN is not specifically registered
    const domesticMatch = binTrie.longestPrefixMatch("4111990000001111");
    assert.deepEqual(domesticMatch, {
      prefix: "4111",
      value: { network: "VISA", issuer: "VISA_INDIA_DOMESTIC" },
    });

    // Unknown card prefix returns null
    assert.equal(binTrie.longestPrefixMatch("9999000011112222"), null);
  });
});
