import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateDeviceEd25519KeyPair, signDevicePayload } from "@fintech/core";
import { createPersistentConsumerContext, ConsumerHttpServer } from "../src/index.ts";

describe("Slices 04 & 05 — Project 3 Consumer App, Ed25519 Auth, Risk Engine, Shadow Mode & Disputes HTTP", () => {
  it("Enforces onboarding token + Ed25519 device auth (401/403), nonce replay, X-Ops-Token, 100-payment Shadow Diff & restart persistence", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice04-"));
    const opsToken = "test_p3_ops_token";
    const ctx = createPersistentConsumerContext({ dataDir: tmpDir, opsToken });
    const httpServer = new ConsumerHttpServer(ctx).createHttpServer();

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const signHeaders = (
      deviceId: string,
      privateKeyPem: string,
      rawBody: string,
      nonce: string
    ) => {
      const ts = Date.now();
      const sig = signDevicePayload({
        deviceId,
        timestampMs: ts,
        nonce,
        payload: rawBody,
        privateKeyPem,
      });
      return {
        "content-type": "application/json",
        "x-device-id": deviceId,
        "x-device-timestamp": String(ts),
        "x-device-nonce": nonce,
        "x-device-signature": sig,
      };
    };

    try {
      // 1. UI HTML & unauthenticated rejections (401)
      const ui = await fetch(`${base}/`);
      assert.equal(ui.status, 200);
      assert.ok((await ui.text()).includes("Ed25519"));

      assert.equal((await fetch(`${base}/api/pay`, { method: "POST", body: "{}" })).status, 401);
      assert.equal(
        (await fetch(`${base}/api/devices/bind`, { method: "POST", body: "{}" })).status,
        401
      );
      assert.equal(
        (await fetch(`${base}/api/pin/set`, { method: "POST", body: "{}" })).status,
        401
      );
      assert.equal(
        (await fetch(`${base}/api/collects`, { method: "POST", body: "{}" })).status,
        401
      );
      assert.equal(
        (await fetch(`${base}/api/chaos/airplane-mode`, { method: "PUT", body: "{}" })).status,
        401
      );

      // 2. Onboard -> OTP (gets X-Onboarding-Token) -> Bind Ed25519 -> Set PIN -> Link BANKA (idempotent) -> VPA
      const sRes = await fetch(`${base}/api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobileNumber: "9876543210", fullName: "Anita Sharma" }),
      });
      const { customer } = (await sRes.json()) as { customer: { id: string } };
      const otpRes = await fetch(`${base}/api/otp/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobileNumber: "9876543210", otp: "123456" }),
      });
      const { onboardingToken } = (await otpRes.json()) as { onboardingToken: string };
      assert.ok(onboardingToken.startsWith("ob_"));
      const obHeaders = {
        "content-type": "application/json",
        "x-onboarding-token": onboardingToken,
      };

      const kp = generateDeviceEd25519KeyPair();
      const bindRes = await fetch(`${base}/api/devices/bind`, {
        method: "POST",
        headers: obHeaders,
        body: JSON.stringify({
          customerId: customer.id,
          deviceId: "dev_http_1",
          publicKeyPem: kp.publicKeyPem,
        }),
      });
      assert.equal(bindRes.status, 200);

      assert.equal(
        (
          await fetch(`${base}/api/pin/set`, {
            method: "POST",
            headers: obHeaders,
            body: JSON.stringify({ customerId: customer.id, rawPin: "1234" }),
          })
        ).status,
        200
      );

      // Idempotent bank linking (2nd call succeeds instead of UNIQUE 500)
      const lRes1 = await fetch(`${base}/api/accounts/link`, {
        method: "POST",
        headers: obHeaders,
        body: JSON.stringify({
          customerId: customer.id,
          bankId: "BANKA",
          accountNumber: "987654324521",
        }),
      });
      const lRes2 = await fetch(`${base}/api/accounts/link`, {
        method: "POST",
        headers: obHeaders,
        body: JSON.stringify({
          customerId: customer.id,
          bankId: "BANKA",
          accountNumber: "987654324521",
        }),
      });
      assert.equal(lRes1.status, 201);
      assert.equal(lRes2.status, 201);
      const linked = (await lRes1.json()) as { id: string };

      const vRes = await fetch(`${base}/api/vpas`, {
        method: "POST",
        headers: obHeaders,
        body: JSON.stringify({
          customerId: customer.id,
          linkedAccountId: linked.id,
          handle: "anita.http",
        }),
      });
      const vpa = (await vRes.json()) as { vpa: string };

      // 3. Challenge nonce -> Ed25519 signed pay + replay guard (401)
      const chBody = JSON.stringify({ customerId: customer.id });
      const chRes = await fetch(`${base}/api/pin/challenge`, {
        method: "POST",
        headers: signHeaders("dev_http_1", kp.privateKeyPem, chBody, "nonce_ch_1"),
        body: chBody,
      });
      assert.equal(chRes.status, 200);
      const { txnNonce } = (await chRes.json()) as { txnNonce: string };
      const clientPinProofHex = ctx.psp.computeClientNoncePinProof({
        customerId: customer.id,
        rawPin: "1234",
        txnNonce,
      });

      const rawPay = JSON.stringify({
        customerId: customer.id,
        clientTxnId: "CLNT-HTTP-001",
        payPath: "VPA",
        payerVpa: vpa.vpa,
        payeeVpa: "shop@psp2",
        amountPaise: 25_000,
        rawPin: "1234",
        txnNonce,
        clientPinProofHex,
      });
      const payHeaders = signHeaders("dev_http_1", kp.privateKeyPem, rawPay, "nonce_http_0001");
      const payRes = await fetch(`${base}/api/pay`, {
        method: "POST",
        headers: payHeaders,
        body: rawPay,
      });
      assert.equal(payRes.status, 200);
      const payBody = (await payRes.json()) as { status: string; switch_rrn: string };
      assert.equal(payBody.status, "SUCCESS");

      // Replaying the exact same Ed25519 nonce -> 401
      const replayRes = await fetch(`${base}/api/pay`, {
        method: "POST",
        headers: payHeaders,
        body: rawPay,
      });
      assert.equal(replayRes.status, 401);

      // 4. Slice 05 Ops auth + repeated Shadow 100-payment diff stays 100 + Blacklist & Promotion persist!
      assert.equal(
        (await fetch(`${base}/api/risk/shadow/run-100`, { method: "POST" })).status,
        401
      );
      const opsHdrs = { "content-type": "application/json", "x-ops-token": opsToken };

      await fetch(`${base}/api/risk/shadow/run-100`, {
        method: "POST",
        headers: opsHdrs,
        body: "{}",
      });
      const shdRes2 = await fetch(`${base}/api/risk/shadow/run-100`, {
        method: "POST",
        headers: opsHdrs,
        body: "{}",
      });
      const shdBody = (await shdRes2.json()) as {
        totalPaymentsEvaluated: number;
        agreementRatePercent: number;
      };
      assert.equal(shdBody.totalPaymentsEvaluated, 100);
      assert.equal(shdBody.agreementRatePercent, 80);

      await fetch(`${base}/api/risk/blacklist`, {
        method: "POST",
        headers: opsHdrs,
        body: JSON.stringify({ entityId: "fraud@psp2" }),
      });
      await fetch(`${base}/api/risk/shadow/promote`, {
        method: "POST",
        headers: opsHdrs,
        body: "{}",
      });

      const dRes = await fetch(`${base}/api/disputes`, {
        method: "POST",
        headers: opsHdrs,
        body: JSON.stringify({ switchRrn: payBody.switch_rrn, amountPaise: 25_000 }),
      });
      assert.equal(dRes.status, 201);
      const revRes = await fetch(`${base}/api/disputes/switch-reversal`, {
        method: "POST",
        headers: opsHdrs,
        body: JSON.stringify({ switchRrn: payBody.switch_rrn }),
      });
      assert.equal(
        ((await revRes.json()) as { resolved: Array<{ state: string }> }).resolved[0].state,
        "RESOLVED_CREDITED"
      );

      // 5. Restart persistence: VPA rehydrates into PSP1, risk blacklist & promoted v2.0-strict persist!
      const ctx2 = createPersistentConsumerContext({ dataDir: tmpDir, opsToken });
      assert.equal(ctx2.payEngine.lookupVpaDirectory(vpa.vpa).vpa, vpa.vpa);
      const blDecision = ctx2.risk.scorePayment({
        paymentId: "p_bl_1",
        customerId: customer.id,
        deviceId: "dev_http_1",
        payeeVpa: "fraud@psp2",
        amountPaise: 10_000,
        isNewDevice24h: false,
        isNewCounterparty: true,
      });
      assert.equal(blDecision.decision, "DECLINE");
      const activeEval = ctx2.shadow.evaluateLivePayment({
        paymentId: "p_after_promote",
        features: { amount_paise: 300_000, is_new_counterparty: true },
      });
      assert.equal(activeEval.activeVersion, "v2.0-strict");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
