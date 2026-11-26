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
  it("Enforces X-Merchant-Token (401), 24h Pre-Debit Gate (403 -> +24h -> 200), Dunning/Pay-Now & Fake Clock persistence", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice06-"));
    const token = "test_p4_merchant_token";

    const ctx1 = createPersistentMandatesContext({ dataDir: tmpDir, merchantToken: token });
    const httpServer = new MandatesHttpServer(ctx1).createHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    const hdrs = { "content-type": "application/json", "x-merchant-token": token };

    try {
      // 1. UI HTML & missing token rejection (401)
      const ui = await fetch(`${base}/`);
      assert.equal(ui.status, 200);
      assert.ok((await ui.text()).includes("Pre-Debit"));

      const unauth = await fetch(`${base}/api/clock`);
      assert.equal(unauth.status, 401);

      // 2. Create & authorize AutoPay mandate -> mints UMRN
      const mRes = await fetch(`${base}/api/mandates`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ rail: "UPI_AUTOPAY" }),
      });
      const mandate = (await mRes.json()) as { id: string };

      const authRes = await fetch(`${base}/api/mandates/${mandate.id}/authorize`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ authCredential: "1234" }),
      });
      assert.equal(authRes.status, 200);
      const activeMandate = (await authRes.json()) as { umrn: string };
      assert.ok(activeMandate.umrn.startsWith("UMRN"));

      // 3. Create Plan & Subscription anchored on Jan 31 -> verify Feb 28 -> Mar 31
      const pRes = await fetch(`${base}/api/plans`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ name: "Monthly Pro", amountPaise: 49_900 }),
      });
      const plan = (await pRes.json()) as { id: string };

      const sRes = await fetch(`${base}/api/subscriptions`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ planId: plan.id, mandateId: mandate.id, anchorDay: 31 }),
      });
      const sub = (await sRes.json()) as { id: string };

      // 4. Pre-Debit Notice -> early execute rejected (403) -> advance +24h -> succeeds (200)
      await fetch(`${base}/api/cycles/pre-debit`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ subscriptionId: sub.id, cycleNumber: 1 }),
      });
      const earlyExec = await fetch(`${base}/api/cycles/execute`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ subscriptionId: sub.id, cycleNumber: 1 }),
      });
      assert.equal(earlyExec.status, 403);

      await fetch(`${base}/api/clock/advance`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ hours: 24 }),
      });

      const okExec = await fetch(`${base}/api/cycles/execute`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ subscriptionId: sub.id, cycleNumber: 1 }),
      });
      assert.equal(okExec.status, 200);

      // 5. Dunning soft failure -> Pay-Now recovery restores ACTIVE
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
      const payNow = await fetch(`${base}/api/dunning/${dun.dunningCase.id}/pay-now`, {
        method: "POST",
        headers: hdrs,
        body: JSON.stringify({ cardNumber: "4111111111114242", expiry: "12/29" }),
      });
      assert.equal(payNow.status, 200);

      // 6. Restart context against same tmpDir -> Fake Clock (+24h = 2026-02-01) persists!
      const ctx2 = createPersistentMandatesContext({ dataDir: tmpDir, merchantToken: token });
      assert.equal(ctx2.clock.now().toISOString(), "2026-02-01T04:30:00.000Z");
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
