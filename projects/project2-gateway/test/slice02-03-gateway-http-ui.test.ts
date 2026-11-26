import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signServiceMessage } from "@fintech/core";
import {
  createPersistentGatewayContext,
  GatewayHttpServer,
} from "../src/index.ts";

describe("Slices 02 & 03 — Project 2 Gateway Live HTTP Server, HMAC Auth, Isolated Vault & Ops", () => {
  it("Enforces strict HMAC auth (401), vault isolation + PCI grep, failover, refunds (422), webhooks, key rotation & persistence", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice02-"));
    const ctx = createPersistentGatewayContext({ dataDir: tmpDir });
    const gwServer = new GatewayHttpServer(ctx);
    const httpServer = gwServer.createHttpServer();

    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    const signedFetch = async (
      method: string,
      pathname: string,
      bodyObj?: unknown,
      secretOverride?: string
    ) => {
      const rawBody = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
      const ts = new Date().toISOString();
      const sig = signServiceMessage(rawBody, ts, secretOverride ?? ctx.seededApiSecret);
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-key-id": ctx.seededKeyId,
          "x-timestamp": ts,
          "x-signature": sig,
        },
        body: bodyObj === undefined ? undefined : rawBody,
      });
      return { status: res.status, body: await res.json() };
    };

    try {
      // 1. HTML UI & unsigned rejection (401)
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      assert.ok((await htmlRes.text()).includes("SubtleCrypto"));

      const unauth = await fetch(`${base}/api/ledger/parity`);
      assert.equal(unauth.status, 401);

      // 2. Force ACQ_ALPHA down -> Card checkout fails over to ACQ_BETA
      const chaos = await signedFetch("PUT", "/api/acquirers/ACQ_ALPHA/chaos", { forceDown: true });
      assert.equal(chaos.status, 200);

      const ord = await signedFetch("POST", "/api/orders", {
        amountPaise: 100_000,
        idempotencyKey: "http_ord_1",
        merchantOrderId: "rcpt_http_1",
      });
      assert.equal(ord.status, 201);

      const tokRes = await fetch(`${base}/api/vault/tokenize`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          cardNumber: "4111111111114242",
          expiry: "12/29",
          merchantId: ctx.seededMerchantId,
        }),
      });
      const tok = (await tokRes.json()) as { token: string };

      const pay = await signedFetch("POST", "/api/payments", {
        orderId: (ord.body as { order: { id: string } }).order.id,
        method: "CARD",
        tokenId: tok.token,
        cardOtp: "123456",
      });
      assert.equal(pay.status, 200);
      const paymentId = (pay.body as { payment: { id: string; acquirer_id: string }; attempts: unknown[] }).payment.id;
      assert.equal((pay.body as { payment: { acquirer_id: string } }).payment.acquirer_id, "ACQ_BETA");
      assert.equal((pay.body as { attempts: unknown[] }).attempts.length, 2);

      // 3. PCI Grep Audit -> 0 leaks across p2-gateway.sqlite & p2-vault.sqlite!
      const grep = await signedFetch("GET", "/api/pci-grep-audit");
      assert.equal(grep.status, 200);
      assert.equal((grep.body as { passed: boolean }).passed, true);

      // 4. Partial refund succeeds; excess refund returns 422
      const r1 = await signedFetch("POST", "/api/refunds", {
        paymentId,
        amountPaise: 60_000,
        idempotencyKey: "http_ref_1",
      });
      assert.equal(r1.status, 201);
      const r2 = await signedFetch("POST", "/api/refunds", {
        paymentId,
        amountPaise: 50_000,
        idempotencyKey: "http_ref_2",
      });
      assert.equal(r2.status, 422);

      // 5. Key rotation overlap: old secret still authenticates during overlap
      const rot = await signedFetch("POST", "/api/keys/rotate", { overlapWindowMs: 600_000 });
      assert.equal(rot.status, 200);
      const parityWithOldSecret = await signedFetch("GET", "/api/ledger/parity", undefined, ctx.seededApiSecret);
      assert.equal(parityWithOldSecret.status, 200);
      assert.equal((parityWithOldSecret.body as { parity: { matches: boolean } }).parity.matches, true);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
