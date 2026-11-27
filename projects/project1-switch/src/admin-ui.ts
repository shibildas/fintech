import { renderFintechShellHtml } from "../../../packages/core/src/index.ts";

/**
 * Project 1 — UPI Central Switch Interactive Admin Console HTML/JS UI.
 */
export function renderSwitchAdminHtml(activeCycleId: string): string {
  const safeCycleJson = JSON.stringify(activeCycleId);
  return renderFintechShellHtml({
    title: "Project 1 — UPI Central Switch",
    subtitle: "ISO 8583 6-Hop Pay • Chaos Injection • T+1 Settlement & 3-Way Recon",
    activePort: 3001,
    bodyHtml: `
      <div class="auth-bar">
        <label>Admin Token (see server stdout)<input id="p1Token" type="password" placeholder="Paste X-Admin-Token" /></label>
        <label>RBAC Role<select id="p1Role"><option value="operator">operator</option><option value="admin">admin</option></select></label>
        <button onclick="loadBalances(this)">Refresh Balances</button>
        <button class="secondary" onclick="loadTxns(this)">Recent Transactions</button>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">1</span> Live Bank Core Balances</h2>
            <p class="hint">Persistent SQLite balances across BANKA, BANKB, and BANKC.</p>
          </div>
          <div class="out-wrap">
            <div id="balOutMeta" class="out-meta"></div>
            <pre id="balOut" class="out">Enter X-Admin-Token above and click Refresh Balances.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">2</span> Execute 6-Hop UPI Pay</h2>
            <p class="hint">Sends an ISO 8583 MTI 0200 payment through PSP → Switch → Remitter &amp; Beneficiary banks.</p>
          </div>
          <div class="row">
            <label>Payer VPA<input id="payerVpa" value="anita@psp1" /></label>
            <label>Payee VPA<input id="payeeVpa" value="shop@psp2" /></label>
          </div>
          <div class="row">
            <label>Amount (paise)<input id="amountPaise" type="number" value="50000" /></label>
            <label>UPI PIN<input id="rawPin" type="password" placeholder="Enter UPI PIN" /></label>
            <button onclick="sendPay(this)">Send 0200 PAY</button>
          </div>
          <div class="out-wrap">
            <div id="payOutMeta" class="out-meta"></div>
            <pre id="payOut" class="out">6-hop ISO 8583 trace will appear here.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">3</span> Bank Chaos Control (Admin RBAC)</h2>
            <p class="hint">Test operator (403) vs admin (200) permissions and timeout/reversal recovery.</p>
          </div>
          <div class="row">
            <label>Bank<select id="chaosBank"><option>BANKA</option><option>BANKB</option><option>BANKC</option></select></label>
            <label>Chaos Mode<select id="chaosMode"><option value="normal">Healthy</option><option value="hang">debitThenHang (CHK)</option><option value="down">forceDown (0420)</option></select></label>
            <label>Latency (ms)<input id="chaosLatency" type="number" value="0" min="0" /></label>
          </div>
          <div class="row">
            <button class="danger" onclick="applyChaos(this)">Apply Chaos Policy</button>
          </div>
          <div class="out-wrap">
            <div id="chaosOutMeta" class="out-meta"></div>
            <pre id="chaosOut" class="out">Switch role to admin to update bank chaos settings.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">4</span> T+1 Settlement &amp; 3-Way Recon</h2>
            <p class="hint">Runs zero-sum multilateral netting and 6-class three-way reconciliation.</p>
          </div>
          <div class="row">
            <button onclick="runSettlement(this)">Run Settlement Cycle</button>
            <button class="secondary" onclick="runRecon(this)">Run 3-Way Recon</button>
          </div>
          <div class="out-wrap">
            <div id="reconOutMeta" class="out-meta"></div>
            <pre id="reconOut" class="out">Settlement net positions and reconciliation summary.</pre>
          </div>
        </div>
      </div>`,
    scriptJs: `
      const ACTIVE_CYCLE_ID = ${safeCycleJson};
      function p1Headers() {
        return {
          "content-type": "application/json",
          "x-admin-token": document.getElementById("p1Token").value.trim(),
          "x-role": document.getElementById("p1Role").value
        };
      }
      async function loadBalances(btn) {
        return runAction(btn, "balOut", "Loading balances", async () => {
          const r = await fetch("/api/balances", { headers: p1Headers() });
          return { status: r.status, body: await r.json(), toastLabel: "Balances" };
        });
      }
      async function loadTxns(btn) {
        return runAction(btn, "balOut", "Fetching transactions", async () => {
          const r = await fetch("/transactions", { headers: p1Headers() });
          return { status: r.status, body: await r.json(), toastLabel: "Transactions" };
        });
      }
      async function sendPay(btn) {
        const rawPin = document.getElementById("rawPin").value.trim();
        if (!rawPin) {
          toast("Please enter UPI PIN (see server stdout)", "err");
          return show("payOut", { error: "Please enter UPI PIN (see server stdout)" }, { status: 400 });
        }
        const res = await runAction(btn, "payOut", "Executing 6-hop pay", async () => {
          const r = await fetch("/api/pay-demo", {
            method: "POST",
            headers: p1Headers(),
            body: JSON.stringify({
              payerVpa: document.getElementById("payerVpa").value,
              payeeVpa: document.getElementById("payeeVpa").value,
              amountPaise: Number(document.getElementById("amountPaise").value),
              rawPin
            })
          });
          return { status: r.status, body: await r.json(), toastLabel: "UPI 0200 Pay" };
        });
        if (res && res.status === 200) loadBalances(null);
      }
      async function applyChaos(btn) {
        return runAction(btn, "chaosOut", "Applying chaos", async () => {
          const bank = encodeURIComponent(document.getElementById("chaosBank").value);
          const mode = document.getElementById("chaosMode").value;
          const latencyMs = Number(document.getElementById("chaosLatency").value) || 0;
          const payload = mode === "hang" ? { debitThenHang: true, forceDown: false, latencyMs }
                        : mode === "down" ? { debitThenHang: false, forceDown: true, latencyMs }
                        : { debitThenHang: false, forceDown: false, latencyMs };
          const r = await fetch("/participants/" + bank + "/chaos", {
            method: "PUT", headers: p1Headers(), body: JSON.stringify(payload)
          });
          return { status: r.status, body: await r.json(), toastLabel: "Chaos Policy" };
        });
      }
      async function runSettlement(btn) {
        return runAction(btn, "reconOut", "Running settlement", async () => {
          const r = await fetch("/cycles/" + encodeURIComponent(ACTIVE_CYCLE_ID) + "/run", { method: "POST", headers: p1Headers(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Settlement" };
        });
      }
      async function runRecon(btn) {
        return runAction(btn, "reconOut", "Reconciling", async () => {
          const r = await fetch("/cycles/" + encodeURIComponent(ACTIVE_CYCLE_ID) + "/reconcile", { method: "POST", headers: p1Headers(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "3-Way Recon" };
        });
      }
    `,
  });
}
