import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { generateDeviceEd25519KeyPair, signDevicePayload } from "@fintech/core";
import {
  createPersistentConsumerContext,
  ConsumerHttpServer,
} from "../src/index.ts";

describe("Slices 04 & 05 — Project 3 Consumer App, Ed25519 Auth, Risk Engine, Shadow Mode & Disputes HTTP", () => {
  it("Enforces Ed25519 device auth (401), X-Ops-Token (401), 100-payment Shadow Diff & Dispute Auto-Resolve", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice04-"));
    const opsToken = "test_p3_ops_token";
    const ctx = createPersistentConsumerContext({ dataDir: tmpDir, opsToken });
    const httpServer = new ConsumerHttpServer(ctx).createHttpServer();

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. UI HTML & unsigned /api/pay rejection (401)
      const ui = await fetch(`${base}/`);
      assert.equal(ui.status, 200);
      assert.ok((await ui.text()).includes("Ed25519"));

      const unauthPay = await fetch(`${base}/api/pay`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ amountPaise: 10_000 }),
      });
      assert.equal(unauthPay.status, 401);

      // 2. Onboard -> OTP -> Bind Ed25519 -> Set PIN -> Link -> Create VPA -> Signed Pay
      const sRes = await fetch(`${base}/api/signup`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobileNumber: "9876543210", fullName: "Anita Sharma" }),
      });
      const { customer } = (await sRes.json()) as { customer: { id: string } };
      await fetch(`${base}/api/otp/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mobileNumber: "9876543210", otp: "123456" }),
      });

      const kp = generateDeviceEd25519KeyPair();
      await fetch(`${base}/api/devices/bind`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          deviceId: "dev_http_1",
          publicKeyPem: kp.publicKeyPem,
        }),
      });
      await fetch(`${base}/api/pin/set`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ customerId: customer.id, rawPin: "1234" }),
      });
      const lRes = await fetch(`${base}/api/accounts/link`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          bankId: "BANKA",
          accountNumber: "987654324521",
        }),
      });
      const linked = (await lRes.json()) as { id: string };
      const vRes = await fetch(`${base}/api/vpas`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          customerId: customer.id,
          linkedAccountId: linked.id,
          handle: "anita.http",
        }),
      });
      const vpa = (await vRes.json()) as { vpa: string };

      const rawPay = JSON.stringify({
        customerId: customer.id,
        clientTxnId: "CLNT-HTTP-001",
        payPath: "VPA",
        payerVpa: vpa.vpa,
        payeeVpa: "shop@psp2",
        amountPaise: 25_000,
        rawPin: "1234",
      });
      const ts = Date.now();
      const nonce = "nonce_http_0001";
      const sig = signDevicePayload({
        deviceId: "dev_http_1",
        timestampMs: ts,
        nonce,
        payload: rawPay,
        privateKeyPem: kp.privateKeyPem,
      });

      const payRes = await fetch(`${base}/api/pay`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-device-id": "dev_http_1",
          "x-device-timestamp": String(ts),
          "x-device-nonce": nonce,
          "x-device-signature": sig,
        },
        body: rawPay,
      });
      assert.equal(payRes.status, 200);
      const payBody = (await payRes.json()) as { status: string; switch_rrn: string };
      assert.equal(payBody.status, "SUCCESS");

      // 3. Slice 05 Ops auth (401 without X-Ops-Token) + Shadow 100-payment diff + Dispute Auto-Resolve
      const noOps = await fetch(`${base}/api/risk/shadow/run-100`, { method: "POST" });
      assert.equal(noOps.status, 401);

      const shdRes = await fetch(`${base}/api/risk/shadow/run-100`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": opsToken },
        body: "{}",
      });
      assert.equal(shdRes.status, 200);
      const shdBody = (await shdRes.json()) as { totalPaymentsEvaluated: number; agreementRatePercent: number };
      assert.equal(shdBody.totalPaymentsEvaluated, 100);
      assert.equal(shdBody.agreementRatePercent, 80);

      const dRes = await fetch(`${base}/api/disputes`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": opsToken },
        body: JSON.stringify({ switchRrn: payBody.switch_rrn, amountPaise: 25_000 }),
      });
      assert.equal(dRes.status, 201);

      const revRes = await fetch(`${base}/api/disputes/switch-reversal`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-ops-token": opsToken },
        body: JSON.stringify({ switchRrn: payBody.switch_rrn }),
      });
      const revBody = (await revRes.json()) as { resolved: Array<{ state: string }> };
      assert.equal(revBody.resolved[0].state, "RESOLVED_CREDITED");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
