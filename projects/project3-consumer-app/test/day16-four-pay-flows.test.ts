import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateDeviceEd25519KeyPair, parseUpiQrUri, buildUpiQrUri } from "@fintech/core";
import {
  createSeededConsumerPspTopology,
  ConsumerAppLocalStore,
  buildSignedPayArgs,
} from "../src/index.ts";

describe("Day 16 — Project 3: 4 Pay Flows, NPCI QR Parser & Honest Pending UX", () => {
  it("1. Day 16 Fintech DSA: parseUpiQrUri & buildUpiQrUri parse exact integer paise and reject invalid URIs", () => {
    const qr = buildUpiQrUri({
      payeeVpa: "shop@psp2",
      payeeName: "Koramangala Book Shop",
      amountPaise: 25_050, // ₹250.50
      note: "Hardcover book",
      txnRef: "ORD-123",
    });
    assert.ok(qr.startsWith("upi://pay?"));

    const parsed = parseUpiQrUri(qr);
    assert.equal(parsed.payeeVpa, "shop@psp2");
    assert.equal(parsed.payeeName, "Koramangala Book Shop");
    assert.equal(parsed.amountPaise, 25_050);
    assert.equal(parsed.currency, "INR");
    assert.equal(parsed.note, "Hardcover book");

    assert.throws(() => parseUpiQrUri("https://evil.com/pay?pa=shop@psp2"));
    assert.throws(() => parseUpiQrUri("upi://pay?pa=shop@psp2&cu=USD&am=10.00"));
  });

  it("2. Executes all 4 Pay Paths (QR, VPA, Mobile Lookup, Bank Account + IFSC) through Project 1 CentralSwitch", async () => {
    const { psp, payEngine, p1 } = createSeededConsumerPspTopology();
    const now = new Date("2026-11-20T10:00:00.000Z");

    // Setup Anita (payer)
    const anitaSignup = psp.signup({ mobileNumber: "9876543210", fullName: "Anita Sharma", now });
    psp.verifySmsOtp("9876543210", anitaSignup.mockSmsOtp);
    const anitaKeys = generateDeviceEd25519KeyPair();
    psp.bindDevice({
      customerId: anitaSignup.customer.id,
      deviceId: "dev_anita",
      publicKeyPem: anitaKeys.publicKeyPem,
      deviceModel: "Pixel 9",
      now,
    });
    psp.setPin(anitaSignup.customer.id, "1234");
    const anitaLinked = psp.linkBankAccount({
      customerId: anitaSignup.customer.id,
      bankId: "BANKA",
      accountNumber: "987654324521",
      isPrimary: true,
      now,
    });
    const anitaVpa = payEngine.createVpa({
      customerId: anitaSignup.customer.id,
      linkedAccountId: anitaLinked.id,
      handle: "9876543210",
      isDefault: true,
      now,
    });
    assert.equal(anitaVpa.vpa, "9876543210@psp1");

    // Setup Rahul (mobile payee)
    const rahulSignup = psp.signup({ mobileNumber: "9876543211", fullName: "Rahul Verma", now });
    psp.verifySmsOtp("9876543211", rahulSignup.mockSmsOtp);
    const rahulLinked = psp.linkBankAccount({
      customerId: rahulSignup.customer.id,
      bankId: "BANKB",
      accountNumber: "876543218899",
      isPrimary: true,
      now,
    });
    payEngine.createVpa({
      customerId: rahulSignup.customer.id,
      linkedAccountId: rahulLinked.id,
      handle: "9876543211",
      isDefault: true,
      now,
    });

    const anitaBefore = p1.banks.BANKA.ledger.getBalance("987654324521").ledger_balance_paise;
    const shopBefore = p1.banks.BANKC.ledger.getBalance("765432103344").ledger_balance_paise;
    const rahulBefore = p1.banks.BANKB.ledger.getBalance("876543218899").ledger_balance_paise;

    const helperPay = async (
      pathType: "QR" | "VPA" | "MOBILE" | "BANK_IFSC",
      extra: Record<string, unknown>,
      stepMs: number
    ) => {
      const t = new Date(now.getTime() + stepMs);
      const txnNonce = psp.issuePinChallengeNonce();
      const pinProof = psp.computeClientNoncePinProof({
        customerId: anitaSignup.customer.id,
        rawPin: "1234",
        txnNonce,
      });
      const signed = buildSignedPayArgs({
        deviceId: "dev_anita",
        privateKeyPem: anitaKeys.privateKeyPem,
        payload: { pathType, ...extra },
        nowMs: t.getTime(),
      });
      return payEngine.initiatePay({
        customerId: anitaSignup.customer.id,
        deviceId: "dev_anita",
        ...signed,
        clientTxnId: `CLNT-${pathType}-${stepMs}`,
        payPath: pathType,
        payerVpa: anitaVpa.vpa,
        rawPin: "1234",
        txnNonce,
        clientPinProofHex: pinProof,
        now: t,
        ...extra,
      });
    };

    // Path 1: QR Scan (₹100.00 to shop@psp2)
    const qrUri = buildUpiQrUri({
      payeeVpa: "shop@psp2",
      payeeName: "Koramangala Book Shop",
      amountPaise: 10_000,
    });
    const r1 = await helperPay("QR", { qrUri }, 1000);
    assert.equal(r1.status, "SUCCESS");

    // Path 2: Direct VPA (₹200.00 to shop@psp2)
    const r2 = await helperPay("VPA", { payeeVpa: "shop@psp2", amountPaise: 20_000 }, 2000);
    assert.equal(r2.status, "SUCCESS");

    // Path 3: Mobile Number Lookup (₹150.00 to Rahul 9876543211)
    const r3 = await helperPay("MOBILE", { payeeMobile: "9876543211", amountPaise: 15_000 }, 3000);
    assert.equal(r3.status, "SUCCESS");

    // Path 4: Bank Account + IFSC (₹50.00 to Shop's BANKC account 765432103344 / BNKC0001)
    const r4 = await helperPay(
      "BANK_IFSC",
      { payeeAccountNumber: "765432103344", payeeIfsc: "BNKC0001001", amountPaise: 5_000 },
      4000
    );
    assert.equal(r4.status, "SUCCESS");

    // Verify exact net movements: Anita -50,000, Shop +35,000 (10k+20k+5k), Rahul +15,000
    const anitaAfter = p1.banks.BANKA.ledger.getBalance("987654324521").ledger_balance_paise;
    const shopAfter = p1.banks.BANKC.ledger.getBalance("765432103344").ledger_balance_paise;
    const rahulAfter = p1.banks.BANKB.ledger.getBalance("876543218899").ledger_balance_paise;

    assert.equal(anitaBefore - anitaAfter, 50_000);
    assert.equal(shopAfter - shopBefore, 35_000);
    assert.equal(rahulAfter - rahulBefore, 15_000);
  });

  it("3. Honest Pending UX: Airplane mode leaves txn PENDING across app restart, then syncPendingTransactions converges cleanly", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-p3-day16-"));
    const localDbPath = path.join(tmpDir, "mobile-local.sqlite");

    try {
      const { psp, payEngine } = createSeededConsumerPspTopology();
      const now = new Date("2026-11-20T11:00:00.000Z");

      const signup = psp.signup({ mobileNumber: "9876543210", fullName: "Anita Sharma", now });
      psp.verifySmsOtp("9876543210", signup.mockSmsOtp);
      const keys = generateDeviceEd25519KeyPair();
      psp.bindDevice({
        customerId: signup.customer.id,
        deviceId: "dev_anita",
        publicKeyPem: keys.publicKeyPem,
        deviceModel: "Pixel 9",
        now,
      });
      psp.setPin(signup.customer.id, "1234");
      const linked = psp.linkBankAccount({
        customerId: signup.customer.id,
        bankId: "BANKA",
        accountNumber: "987654324521",
        isPrimary: true,
        now,
      });
      const vpa = payEngine.createVpa({
        customerId: signup.customer.id,
        linkedAccountId: linked.id,
        handle: "anita.mobile",
        isDefault: true,
        now,
      });

      const appSession1 = new ConsumerAppLocalStore(localDbPath);
      const clientTxnId = "CLNT-AIRPLANE-001";

      // Enable airplane mode mid-flight: server persisted PENDING, client loses socket
      payEngine.simulateAirplaneMode = true;
      const txnNonce = psp.issuePinChallengeNonce();
      const pinProof = psp.computeClientNoncePinProof({
        customerId: signup.customer.id,
        rawPin: "1234",
        txnNonce,
      });
      const signed = buildSignedPayArgs({
        deviceId: "dev_anita",
        privateKeyPem: keys.privateKeyPem,
        payload: { payeeVpa: "shop@psp2", amountPaise: 25_000 },
        nowMs: now.getTime(),
      });

      const uiState1 = await appSession1.sendWithHonestPending({
        clientTxnId,
        payeeLabel: "shop@psp2",
        amountPaise: 25_000,
        executeRemote: () =>
          payEngine.initiatePay({
            customerId: signup.customer.id,
            deviceId: "dev_anita",
            ...signed,
            clientTxnId,
            payPath: "VPA",
            payerVpa: vpa.vpa,
            payeeVpa: "shop@psp2",
            amountPaise: 25_000,
            rawPin: "1234",
            txnNonce,
            clientPinProofHex: pinProof,
            now,
          }),
      });

      // Must show honest PENDING — never fake SUCCESS or FAILED
      assert.equal(uiState1.status, "PENDING");
      assert.ok(uiState1.honestBanner.includes("do NOT pay again"));

      // Simulate user force-closing & reopening the app after turning off airplane mode
      payEngine.simulateAirplaneMode = false;
      const appSession2AfterRestart = new ConsumerAppLocalStore(localDbPath);
      const persistedBeforeSync = appSession2AfterRestart.getLocalTxn(clientTxnId);
      assert.equal(persistedBeforeSync?.status, "PENDING");

      const synced = appSession2AfterRestart.syncPendingTransactions(payEngine);
      assert.equal(synced.length, 1);
      assert.equal(synced[0].clientTxnId, clientTxnId);
      assert.equal(synced[0].status, "PENDING");
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
