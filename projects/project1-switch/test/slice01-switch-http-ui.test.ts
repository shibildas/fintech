import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CentralSwitch, SwitchAdminApp, createSeededTopology } from "../src/index.ts";

describe("Slice 01 — Project 1 Switch Interactive HTTP UI, Strict Token Auth, CORS & .data/ Persistence", () => {
  it("Enforces X-Admin-Token (401), RBAC (403), PIN redaction, 400 invalid JSON, origin CORS, /reconcile & restart persistence", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice01-"));
    const adminToken = "test_p1_secret_token";

    const bootApp = () => {
      const topology = createSeededTopology({ dataDir: tmpDir });
      const sw = new CentralSwitch({
        dbPath: path.join(tmpDir, "p1-switch.sqlite"),
        bankTimeoutMs: 500,
        maxCreditRetries: 2,
        activeCycleId: "CYC-2026-11-26",
      });
      sw.registerBank(topology.banks.BANKA);
      sw.registerBank(topology.banks.BANKB);
      sw.registerBank(topology.banks.BANKC);
      sw.registerPsp(topology.psps.PSP1);
      sw.registerPsp(topology.psps.PSP2);
      return new SwitchAdminApp({ sw, topology, adminToken });
    };

    const app1 = bootApp();
    const httpServer = app1.createHttpServer();
    await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
    const port = (httpServer.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      // 1. HTML UI, origin-allowlisted CORS & malformed JSON -> 400
      const htmlRes = await fetch(`${base}/`, { headers: { origin: "http://127.0.0.1:3002" } });
      assert.equal(htmlRes.status, 200);
      assert.equal(htmlRes.headers.get("access-control-allow-origin"), "http://127.0.0.1:3002");
      assert.ok((await htmlRes.text()).includes("Execute 6-Hop UPI Pay"));

      const badJsonRes = await fetch(`${base}/api/pay-demo`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-admin-token": adminToken },
        body: "{bad-json",
      });
      assert.equal(badJsonRes.status, 400);

      // 2. Missing X-Admin-Token -> 401 (including /transactions/:rrn)
      assert.equal((await fetch(`${base}/api/balances`)).status, 401);
      assert.equal((await fetch(`${base}/transactions/NONEXISTENT`)).status, 401);

      // 3. Operator role cannot change chaos -> 403; Admin role succeeds -> 200
      const opChaos = await fetch(`${base}/participants/BANKA/chaos`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-admin-token": adminToken,
          "x-role": "operator",
        },
        body: JSON.stringify({ debitThenHang: true }),
      });
      assert.equal(opChaos.status, 403);

      const admChaos = await fetch(`${base}/participants/BANKA/chaos`, {
        method: "PUT",
        headers: {
          "content-type": "application/json",
          "x-admin-token": adminToken,
          "x-role": "admin",
        },
        body: JSON.stringify({ debitThenHang: false, latencyMs: 5 }),
      });
      assert.equal(admChaos.status, 200);

      // 4. Missing rawPin rejected (400); valid pay succeeds & redacts rawPin from structuredLogs
      const noPinRes = await fetch(`${base}/api/pay-demo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": adminToken,
          "x-role": "operator",
        },
        body: JSON.stringify({
          payerVpa: "anita@psp1",
          payeeVpa: "shop@psp2",
          amountPaise: 50_000,
        }),
      });
      assert.equal(noPinRes.status, 400);

      const payRes = await fetch(`${base}/api/pay-demo`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": adminToken,
          "x-role": "operator",
        },
        body: JSON.stringify({
          payerVpa: "anita@psp1",
          payeeVpa: "shop@psp2",
          amountPaise: 50_000,
          rawPin: "1234",
        }),
      });
      assert.equal(payRes.status, 200);
      const serializedLogs = JSON.stringify(app1.structuredLogs);
      assert.ok(
        !serializedLogs.includes('"rawPin":"1234"'),
        "Plaintext rawPin must never appear in structuredLogs"
      );

      // 5. POST /reconcile alias works
      const reconRes = await fetch(`${base}/reconcile`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-admin-token": adminToken,
          "x-role": "operator",
        },
        body: "{}",
      });
      assert.equal(reconRes.status, 200);

      // 6. Simulate server restart against the SAME tmpDir -> balances persist!
      const app2 = bootApp();
      const balRes = await app2.dispatch({
        method: "GET",
        path: "/api/balances",
        headers: { "x-admin-token": adminToken, "x-role": "operator" },
      });
      assert.equal(balRes.statusCode, 200);
      const accounts = (
        balRes.body as { accounts: Array<{ vpa: string; ledger_balance_paise: number }> }
      ).accounts;
      const anita = accounts.find((a) => a.vpa === "anita@psp1");
      assert.equal(anita?.ledger_balance_paise, 950_000);
    } finally {
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
