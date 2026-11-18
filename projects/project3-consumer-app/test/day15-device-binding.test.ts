import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  generateDeviceEd25519KeyPair,
  signDevicePayload,
  DeviceRequestReplayGuard,
} from "@fintech/core";
import { createSeededConsumerPspTopology } from "../src/index.ts";

describe("Day 15 — Project 3: Device Binding, Asymmetric Ed25519 Signing, PIN Nonces & Account Discovery", () => {
  it("1. Fresh install onboarding -> SMS OTP -> Ed25519 device binding -> Bank account discovery & linking", () => {
    const { psp } = createSeededConsumerPspTopology();
    const now = new Date("2026-11-19T09:30:00.000Z");

    const { customer, mockSmsOtp } = psp.signup({
      mobileNumber: "9876543210",
      fullName: "Anita Sharma",
      now,
    });
    assert.equal(customer.otp_verified, 0);

    const verified = psp.verifySmsOtp("9876543210", mockSmsOtp);
    assert.equal(verified.otp_verified, 1);

    const keys = generateDeviceEd25519KeyPair();
    const bound = psp.bindDevice({
      customerId: customer.id,
      deviceId: "dev_pixel9_01",
      publicKeyPem: keys.publicKeyPem,
      deviceModel: "Pixel 9",
      now,
    });
    assert.equal(bound.device.status, "ACTIVE");
    assert.equal(bound.retiredPreviousDeviceId, null);

    // Discover & link Anita's account at BANKA
    const discovered = psp.discoverAccountsAtBank({
      bankId: "BANKA",
      holderNameQuery: "Anita",
    });
    assert.equal(discovered.length, 1);
    assert.equal(discovered[0].accountNumberMasked, "XXXX4521");

    const linked = psp.linkBankAccount({
      customerId: customer.id,
      bankId: "BANKA",
      accountNumber: discovered[0].accountNumber,
      isPrimary: true,
      now,
    });
    assert.equal(linked.account_number_masked, "XXXX4521");
    assert.equal(linked.is_primary, 1);
  });

  it("2. Second-device takeover retires old device (401) and enforces 24-hour new-device cooling cap", () => {
    const { psp } = createSeededConsumerPspTopology();
    const t0 = new Date("2026-11-19T10:00:00.000Z");

    const { customer, mockSmsOtp } = psp.signup({
      mobileNumber: "9876500001",
      fullName: "Rahul Verma",
      now: t0,
    });
    psp.verifySmsOtp("9876500001", mockSmsOtp);

    const oldKeys = generateDeviceEd25519KeyPair();
    psp.bindDevice({
      customerId: customer.id,
      deviceId: "dev_old_phone",
      publicKeyPem: oldKeys.publicKeyPem,
      deviceModel: "OnePlus 11",
      now: t0,
    });

    // 1 hour later: customer logs in on a new phone (takeover)
    const t1 = new Date("2026-11-19T11:00:00.000Z");
    const newKeys = generateDeviceEd25519KeyPair();
    const takeover = psp.bindDevice({
      customerId: customer.id,
      deviceId: "dev_new_phone",
      publicKeyPem: newKeys.publicKeyPem,
      deviceModel: "iPhone 16",
      now: t1,
    });
    assert.equal(takeover.retiredPreviousDeviceId, "dev_old_phone");
    assert.ok(takeover.newDeviceCoolingUntil !== null);

    // Old device signature is immediately rejected with 401
    const payload = JSON.stringify({ amount: 10000 });
    const oldSig = signDevicePayload({
      deviceId: "dev_old_phone",
      timestampMs: t1.getTime(),
      nonce: "nonce_old_0001",
      payload,
      privateKeyPem: oldKeys.privateKeyPem,
    });
    assert.throws(
      () =>
        psp.verifyDeviceSignedRequest({
          deviceId: "dev_old_phone",
          timestampMs: t1.getTime(),
          nonce: "nonce_old_0001",
          payload,
          signatureBase64: oldSig,
          now: t1,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 401
    );

    // New device authenticates, but > ₹5,000 (500,000 paise) is blocked during 24h cooling window
    const newSig = signDevicePayload({
      deviceId: "dev_new_phone",
      timestampMs: t1.getTime(),
      nonce: "nonce_new_0001",
      payload,
      privateKeyPem: newKeys.privateKeyPem,
    });
    const auth = psp.verifyDeviceSignedRequest({
      deviceId: "dev_new_phone",
      timestampMs: t1.getTime(),
      nonce: "nonce_new_0001",
      payload,
      signatureBase64: newSig,
      now: t1,
    });
    assert.equal(auth.device.device_id, "dev_new_phone");

    assert.throws(
      () => psp.checkNewDeviceCoolingLimit(customer.id, 600_000, t1),
      (err: Error & { statusCode?: number }) => err.statusCode === 403
    );

    // 25 hours later, cooling cap is lifted
    const t2 = new Date(t1.getTime() + 25 * 60 * 60 * 1000);
    const afterCooling = psp.checkNewDeviceCoolingLimit(customer.id, 600_000, t2);
    assert.equal(afterCooling.inCoolingWindow, false);
  });

  it("3. Salted per-transaction nonce PIN verification + 5-wrong-PIN 30m lock + Ops unlock", () => {
    const { psp } = createSeededConsumerPspTopology();
    const t0 = new Date("2026-11-19T12:00:00.000Z");

    const { customer, mockSmsOtp } = psp.signup({
      mobileNumber: "9876500002",
      fullName: "Anita Sharma",
      now: t0,
    });
    psp.verifySmsOtp("9876500002", mockSmsOtp);
    psp.setPin(customer.id, "4321");

    // 4 wrong attempts -> returns remaining attempts
    for (let i = 1; i <= 4; i++) {
      const nonce = psp.issuePinChallengeNonce();
      const badProof = psp.computeClientNoncePinProof({
        customerId: customer.id,
        rawPin: "9999",
        txnNonce: nonce,
      });
      const res = psp.verifyPinWithNonce({
        customerId: customer.id,
        txnNonce: nonce,
        clientProofHex: badProof,
        now: t0,
      });
      assert.equal(res.valid, false);
      assert.equal(res.remainingAttempts, 5 - i);
    }

    // 5th wrong attempt -> 423 Locked for 30 minutes
    const nonce5 = psp.issuePinChallengeNonce();
    const badProof5 = psp.computeClientNoncePinProof({
      customerId: customer.id,
      rawPin: "9999",
      txnNonce: nonce5,
    });
    assert.throws(
      () =>
        psp.verifyPinWithNonce({
          customerId: customer.id,
          txnNonce: nonce5,
          clientProofHex: badProof5,
          now: t0,
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 423
    );

    // Ops unlocks -> valid PIN succeeds immediately
    psp.opsUnlockPin(customer.id, "ops-lead", t0);
    const okNonce = psp.issuePinChallengeNonce();
    const okProof = psp.computeClientNoncePinProof({
      customerId: customer.id,
      rawPin: "4321",
      txnNonce: okNonce,
    });
    const okRes = psp.verifyPinWithNonce({
      customerId: customer.id,
      txnNonce: okNonce,
      clientProofHex: okProof,
      now: t0,
    });
    assert.equal(okRes.valid, true);
  });

  it("4. Day 15 Fintech DSA: DeviceRequestReplayGuard rejects replayed nonces & non-monotonic timestamps", () => {
    const guard = new DeviceRequestReplayGuard(60_000);
    const nowMs = 1_700_000_000_000;

    assert.equal(
      guard.validateAndRecord({ deviceId: "dev1", timestampMs: nowMs, nonce: "nonce_aaa_111", nowMs }).valid,
      true
    );

    // Same nonce replayed -> rejected
    const replay = guard.validateAndRecord({
      deviceId: "dev1",
      timestampMs: nowMs + 100,
      nonce: "nonce_aaa_111",
      nowMs: nowMs + 100,
    });
    assert.equal(replay.valid, false);
    assert.equal(replay.reason, "REPLAYED_NONCE");

    // Older monotonic timestamp -> rejected
    const backwards = guard.validateAndRecord({
      deviceId: "dev1",
      timestampMs: nowMs - 500,
      nonce: "nonce_bbb_222",
      nowMs: nowMs + 100,
    });
    assert.equal(backwards.valid, false);
    assert.equal(backwards.reason, "NON_MONOTONIC_TIMESTAMP");
  });
});
