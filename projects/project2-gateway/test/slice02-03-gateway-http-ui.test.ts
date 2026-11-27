import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { signServiceMessage } from "@fintech/core";
import { createPersistentGatewayContext, GatewayHttpServer } from "../src/index.ts";

describe("Slices 02 & 03 — Project 2 Gateway Live HTTP Server, HMAC Auth, Isolated Vault & Ops", () => {
  it("Enforces strict HMAC auth (401), cross-tenant IDOR (403), 400 validation, vault isolation + PCI grep, failover, refunds (422), key rotation & restart persistence", async () => {
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
      creds?: { keyId: string; secret: string }
    ) => {
      const rawBody = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
      const ts = new Date().toISOString();
      const keyId = creds?.keyId ?? ctx.seededKeyId;
      const secret = creds?.secret ?? ctx.seededApiSecret;
      const sig = signServiceMessage(rawBody, ts, secret);
      const res = await fetch(`${base}${pathname}`, {
        method,
        headers: {
          "content-type": "application/json",
          "x-key-id": keyId,
          "x-timestamp": ts,
          "x-signature": sig,
        },
        body: bodyObj === undefined ? undefined : rawBody,
      });
      return { status: res.status, body: await res.json() };
    };

    try {
      // 1. HTML UI (no hardcoded UPI PIN!) & unsigned rejection (401)
      const htmlRes = await fetch(`${base}/`);
      assert.equal(htmlRes.status, 200);
      const html = await htmlRes.text();
      assert.ok(html.includes("SubtleCrypto"));
      assert.ok(!html.includes('upiRawPin: "1234"'));

      const unauth = await fetch(`${base}/api/ledger/parity`);
      assert.equal(unauth.status, 401);

      // 2. Float amount returns HTTP 400 (not 500!)
      const badOrder = await signedFetch("POST", "/api/orders", {
        amountPaise: 100.5,
        idempotencyKey: "bad_float_ord",
        merchantOrderId: "rcpt_bad",
      });
      assert.equal(badOrder.status, 400);

      // 3. Chaos preserves omitted flags & accepts technicalFailureRatePercent + latencyMs
      const chaos1 = await signedFetch("PUT", "/api/acquirers/ACQ_ALPHA/chaos", {
        forceDown: true,
        technicalFailureRatePercent: 25,
        latencyMs: 5,
      });
      assert.equal(chaos1.status, 200);
      const chaos2 = await signedFetch("PUT", "/api/acquirers/ACQ_ALPHA/chaos", {
        forceRefundFail: false,
      });
      assert.equal(chaos2.status, 200);
      assert.equal((chaos2.body as { chaos: { forceDown: boolean } }).chaos.forceDown, true);

      // 4. Card checkout fails over to ACQ_BETA
      const ord = await signedFetch("POST", "/api/orders", {
        amountPaise: 100_000,
        idempotencyKey: "http_ord_1",
        merchantOrderId: "rcpt_http_1",
      });
      assert.equal(ord.status, 201);
      const orderId = (ord.body as { order: { id: string } }).order.id;

      // Cross-tenant IDOR check: 2nd merchant cannot pay 1st merchant's order (403)
      const m2 = ctx.gateway.onboardMerchant({
        businessName: "Other Store",
        contactEmail: "other@store.in",
        settlementAccountNumber: "ICIC000112233",
        settlementBranchCode: "ICIC0000111",
        settlementHolderName: "Other Store Pvt Ltd",
        returnUrl: "https://other.store.in/return",
      });
      ctx.gateway.transitionMerchantOnboarding({
        merchantId: m2.merchant.id,
        toState: "UNDER_REVIEW",
      });
      ctx.gateway.transitionMerchantOnboarding({ merchantId: m2.merchant.id, toState: "ACTIVE" });

      const idorPay = await signedFetch(
        "POST",
        "/api/payments",
        { orderId, method: "CARD", tokenId: "tok_fake", cardOtp: "123456" },
        { keyId: m2.liveKey.keyId, secret: m2.liveKey.secret }
      );
      assert.equal(idorPay.status, 403);

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
        orderId,
        method: "CARD",
        tokenId: tok.token,
        cardOtp: "123456",
      });
      assert.equal(pay.status, 200);
      const paymentId = (
        pay.body as { payment: { id: string; acquirer_id: string }; attempts: unknown[] }
      ).payment.id;
      assert.equal(
        (pay.body as { payment: { acquirer_id: string } }).payment.acquirer_id,
        "ACQ_BETA"
      );
      assert.equal((pay.body as { attempts: unknown[] }).attempts.length, 2);

      // 5. PCI Grep Audit -> 0 leaks across p2-gateway.sqlite & p2-vault.sqlite
      const grep = await signedFetch("GET", "/api/pci-grep-audit");
      assert.equal(grep.status, 200);
      assert.equal((grep.body as { passed: boolean; tracked_pans_checked: number }).passed, true);
      assert.ok((grep.body as { tracked_pans_checked: number }).tracked_pans_checked >= 2);

      // 6. Partial refund succeeds; excess refund returns 422
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

      // 7. Key rotation overlap: old secret still authenticates during overlap
      const rot = await signedFetch("POST", "/api/keys/rotate", { overlapWindowMs: 600_000 });
      assert.equal(rot.status, 200);
      const parityWithOldSecret = await signedFetch("GET", "/api/ledger/parity", undefined, {
        keyId: ctx.seededKeyId,
        secret: ctx.seededApiSecret,
      });
      assert.equal(parityWithOldSecret.status, 200);
      assert.equal(
        (parityWithOldSecret.body as { parity: { matches: boolean } }).parity.matches,
        true
      );

      // 8. True restart persistence: same merchantId & ledger parity survive restart
      const ctx2 = createPersistentGatewayContext({ dataDir: tmpDir });
      assert.equal(ctx2.seededMerchantId, ctx.seededMerchantId);
      const parityAfterRestart = ctx2.gateway.verifyDashboardMatchesLedger(ctx2.seededMerchantId);
      assert.equal(parityAfterRestart.matches, true);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
