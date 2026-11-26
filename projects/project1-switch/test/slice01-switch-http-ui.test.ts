import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CentralSwitch, SwitchAdminApp, createSeededTopology } from "../src/index.ts";

describe("Slice 01 — Project 1 Switch Interactive HTTP UI, Strict Token Auth, CORS & .data/ Persistence", () => {
  it("Enforces X-Admin-Token (401), RBAC (403), CORS, 6-hop pay-demo, and preserves balances across restart", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "fintech-slice01-"));
    const adminToken = "test_p1_secret_token";

    try {
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

      // 1. HTML UI & CORS preflight
      const htmlRes = await app1.dispatch({ method: "GET", path: "/" });
      assert.equal(htmlRes.statusCode, 200);
      assert.ok(String(htmlRes.body).includes("Execute 6-Hop UPI Pay"));
      assert.equal(htmlRes.headers["access-control-allow-origin"], "*");

      const optRes = await app1.dispatch({ method: "OPTIONS", path: "/api/balances" });
      assert.equal(optRes.statusCode, 204);

      // 2. Missing X-Admin-Token -> 401
      const unauth = await app1.dispatch({ method: "GET", path: "/api/balances" });
      assert.equal(unauth.statusCode, 401);

      // 3. Operator role cannot change chaos -> 403; Admin role succeeds -> 200
      const opChaos = await app1.dispatch({
        method: "PUT",
        path: "/participants/BANKA/chaos",
        headers: { "x-admin-token": adminToken, "x-role": "operator" },
        body: { debitThenHang: true },
      });
      assert.equal(opChaos.statusCode, 403);

      const admChaos = await app1.dispatch({
        method: "PUT",
        path: "/participants/BANKA/chaos",
        headers: { "x-admin-token": adminToken, "x-role": "admin" },
        body: { debitThenHang: false },
      });
      assert.equal(admChaos.statusCode, 200);

      // 4. Execute 6-hop UPI Pay via /api/pay-demo
      const payRes = await app1.dispatch({
        method: "POST",
        path: "/api/pay-demo",
        headers: { "x-admin-token": adminToken, "x-role": "operator" },
        body: {
          payerVpa: "anita@psp1",
          payeeVpa: "shop@psp2",
          amountPaise: 50_000,
          rawPin: "1234",
        },
      });
      assert.equal(payRes.statusCode, 200);

      // 5. Simulate server restart against the SAME tmpDir -> balances persist!
      const app2 = bootApp();
      const balRes = await app2.dispatch({
        method: "GET",
        path: "/api/balances",
        headers: { "x-admin-token": adminToken, "x-role": "operator" },
      });
      assert.equal(balRes.statusCode, 200);
      const accounts = (balRes.body as { accounts: Array<{ vpa: string; ledger_balance_paise: number }> }).accounts;
      const anita = accounts.find((a) => a.vpa === "anita@psp1");
      assert.equal(anita?.ledger_balance_paise, 950_000); // 1,000,000 - 50,000 persisted!
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
