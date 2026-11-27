import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  createPersistentMandatesContext,
  MandatesHttpServer,
} from "../src/index.ts";

describe("Slice 06 — Project 4 Mandates Live HTTP Server, Fake Clock Persistence, 24h Pre-Debit Gate & Dunning", () => {
  it("Enforces X-Merchant-Token (401), clock validation (400), 24h Pre-Debit Gate (403 -> +24h -> 200), Dunning/Pay-Now & MRR parity across restart", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice06-"));
    const token = "test_p4_merchant_token";

    const ctx1 = createPersistentMandatesContext({ dataDir: tmpDir, merchantToken: token });
    const httpServer = new MandatesHttpServer(ctx1).createHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const hdrs = { "content-type": "application/json", "x-merchant-token": token };

    let httpServer2: ReturnType<MandatesHttpServer["createHttpServer"]> | undefined;

    try {
      // 1. UI HTML, missing token (401), invalid clock inputs (400 without bricking server)
      const ui = await fetch(`${base}/`);
      assert.equal(ui.status, 200);
      assert.ok((await ui.text()).includes("Confirm Cap Re-Auth"));

      assert.equal((await fetch(`${base}/api/clock`)).status, 401);
      assert.equal(
        (await fetch(`${base}/api/clock/advance`, { method: "POST", headers: hdrs, body: JSON.stringify({ setIso: "not-a-date" }) })).status,
        400
      );
      assert.equal(
        (await fetch(`${base}/api/clock/advance`, { method: "POST", headers: hdrs, body: JSON.stringify({ hours: "abc" }) })).status,
        400
      );
      assert.equal((await fetch(`${base}/health`)).status, 200);

      // 2. Create mandate -> wrong PIN (401) -> valid PIN mints UMRN
      const mRes = await fetch(`${base}/api/mandates`, { method: "POST", headers: hdrs, body: JSON.stringify({ rail: "UPI_AUTOPAY" }) });
      const mandate = (await mRes.json()) as { id: string };

      const badAuth = await fetch(`${base}/api/mandates/${mandate.id}/authorize`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ authCredential: "9999" }),
      });
      assert.equal(badAuth.status, 401);

      const authRes = await fetch(`${base}/api/mandates/${mandate.id}/authorize`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ authCredential: "1234" }),
      });
      assert.equal(authRes.status, 200);
      const activeMandate = (await authRes.json()) as { umrn: string };
      assert.ok(activeMandate.umrn.startsWith("UMRN"));

      // 3. Plan, Subscription & 24h Pre-Debit Gate (403 -> +24h -> 200)
      const plan = (await (await fetch(`${base}/api/plans`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ name: "Monthly Pro", amountPaise: 49_900 }),
      })).json()) as { id: string };

      const sub = (await (await fetch(`${base}/api/subscriptions`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ planId: plan.id, mandateId: mandate.id, anchorDay: 31 }),
      })).json()) as { id: string };

      await fetch(`${base}/api/cycles/pre-debit`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ subscriptionId: sub.id, cycleNumber: 1 }),
      });
      assert.equal(
        (await fetch(`${base}/api/cycles/execute`, { method: "POST", headers: hdrs, body: JSON.stringify({ subscriptionId: sub.id, cycleNumber: 1 }) })).status,
        403
      );

      await fetch(`${base}/api/clock/advance`, { method: "POST", headers: hdrs, body: JSON.stringify({ hours: 24 }) });
      assert.equal(
        (await fetch(`${base}/api/cycles/execute`, { method: "POST", headers: hdrs, body: JSON.stringify({ subscriptionId: sub.id, cycleNumber: 1 }) })).status,
        200
      );

      // 4. Create paid invoice + soft-fail dunning case BEFORE restart
      const invRes = await fetch(`${base}/api/invoices/demo-paid`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ subscriptionId: sub.id, umrn: activeMandate.umrn, amountPaise: 49_900 }),
      });
      assert.equal(invRes.status, 201);
      const invData = (await invRes.json()) as { invoice: { id: string } };
      assert.equal((await fetch(`${base}/api/invoices/${invData.invoice.id}/printable`, { headers: hdrs })).status, 200);

      const dunRes = await fetch(`${base}/api/dunning/fail`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({
          subscriptionId: sub.id,
          executionKey: `${sub.id}:cycle:2`,
          amountPaise: 49_900,
          failureCode: "51_INSUFFICIENT_FUNDS",
        }),
      });
      const dun = (await dunRes.json()) as { dunningCase: { id: string } };

      // 5. Restart server against SAME tmpDir -> merchantId, Fake Clock, MRR Parity & Dunning Pay-Now ALL survive!
      const ctx2 = createPersistentMandatesContext({ dataDir: tmpDir, merchantToken: token });
      assert.equal(ctx2.merchantId, ctx1.merchantId);
      assert.equal(ctx2.clock.now().toISOString(), "2026-02-01T04:30:00.000Z");

      httpServer2 = new MandatesHttpServer(ctx2).createHttpServer();
      await new Promise<void>((resolve) => httpServer2!.listen(0, "127.0.0.1", resolve));
      const base2 = `http://127.0.0.1:${(httpServer2.address() as { port: number }).port}`;

      const parity2 = await fetch(`${base2}/api/invoices/mrr-parity`, { headers: hdrs });
      assert.equal(parity2.status, 200);
      assert.equal((await parity2.json() as { paidInvoicesTotalPaise: number }).paidInvoicesTotalPaise, 49_900);

      const payNowAfterRestart = await fetch(`${base2}/api/dunning/${dun.dunningCase.id}/pay-now`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ cardNumber: "4111111111114242", expiry: "12/29" }),
      });
      assert.equal(payNowAfterRestart.status, 200);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      if (httpServer2) {
        await new Promise<void>((resolve) => httpServer2!.close(() => resolve()));
      }
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
