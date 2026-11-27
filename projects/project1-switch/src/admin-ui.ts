import { renderFintechShellHtml } from "../../../packages/core/src/index.ts";

/**
 * Project 1 — UPI Central Switch Interactive Admin Console HTML/JS UI.
 */
export function renderSwitchAdminHtml(activeCycleId: string): string {
  const safeCycleJson = JSON.stringify(activeCycleId);
  return renderFintechShellHtml({
    title: "Project 1 — UPI Central Switch, Settlement & 3-Way Recon",
    subtitle: "ISO 8583 6-Hop Pay • Chaos Injection • T+1 Multilateral Netting • Persistent .data/ SQLite",
    activePort: 3001,
    bodyHtml: `
      <div class="auth-bar">
        <label>X-Admin-Token (see server stdout)<input id="p1Token" type="password" placeholder="Paste X-Admin-Token" /></label>
        <label>RBAC Role (X-Role)<select id="p1Role"><option value="operator">operator</option><option value="admin">admin</option></select></label>
        <button onclick="loadBalances()">Refresh Balances</button>
        <button class="secondary" onclick="loadTxns()">Recent Transactions</button>
      </div>
      <div class="grid">
        <div class="card">
          <h2>1. Live Bank Core Balances</h2>
          <pre id="balOut" class="out">Enter X-Admin-Token and click Refresh Balances...</pre>
        </div>
        <div class="card">
          <h2>2. Execute 6-Hop UPI Pay</h2>
          <div class="row">
            <label>Payer VPA<input id="payerVpa" value="anita@psp1" /></label>
            <label>Payee VPA<input id="payeeVpa" value="shop@psp2" /></label>
          </div>
          <div class="row">
            <label>Amount (paise)<input id="amountPaise" type="number" value="50000" /></label>
            <label>UPI PIN<input id="rawPin" type="password" placeholder="Enter UPI PIN" /></label>
            <button onclick="sendPay()">Send 0200 PAY</button>
          </div>
          <pre id="payOut" class="out">6-hop ISO 8583 trace will appear here...</pre>
        </div>
        <div class="card">
          <h2>3. Bank Chaos Control (Admin RBAC)</h2>
          <div class="row">
            <label>Bank<select id="chaosBank"><option>BANKA</option><option>BANKB</option><option>BANKC</option></select></label>
            <label>Mode<select id="chaosMode"><option value="normal">Normal (Healthy)</option><option value="hang">debitThenHang (CHK Recovery)</option><option value="down">forceDown (0420 Reversal)</option></select></label>
            <label>Latency (ms)<input id="chaosLatency" type="number" value="0" min="0" /></label>
            <button class="danger" onclick="applyChaos()">Apply Chaos</button>
          </div>
          <pre id="chaosOut" class="out">Try with role=operator (403) vs role=admin (200)...</pre>
        </div>
        <div class="card">
          <h2>4. T+1 Settlement & 3-Way Reconciliation</h2>
          <div class="row">
            <button onclick="runSettlement()">Run Settlement Cycle</button>
            <button class="secondary" onclick="runRecon()">Run 3-Way Recon</button>
          </div>
          <pre id="reconOut" class="out">Settlement net positions & 3-way recon results...</pre>
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
      async function loadBalances() {
        const r = await fetch("/api/balances", { headers: p1Headers() });
        show("balOut", { status: r.status, body: await r.json() });
      }
      async function loadTxns() {
        const r = await fetch("/transactions", { headers: p1Headers() });
        show("balOut", { status: r.status, body: await r.json() });
      }
      async function sendPay() {
        const rawPin = document.getElementById("rawPin").value.trim();
        if (!rawPin) return show("payOut", { error: "Please enter UPI PIN (see server stdout)" });
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
        show("payOut", { status: r.status, body: await r.json() });
        if (r.ok) loadBalances();
      }
      async function applyChaos() {
        const bank = encodeURIComponent(document.getElementById("chaosBank").value);
        const mode = document.getElementById("chaosMode").value;
        const latencyMs = Number(document.getElementById("chaosLatency").value) || 0;
        const payload = mode === "hang" ? { debitThenHang: true, forceDown: false, latencyMs }
                      : mode === "down" ? { debitThenHang: false, forceDown: true, latencyMs }
                      : { debitThenHang: false, forceDown: false, latencyMs };
        const r = await fetch("/participants/" + bank + "/chaos", {
          method: "PUT",
          headers: p1Headers(),
          body: JSON.stringify(payload)
        });
        show("chaosOut", { status: r.status, body: await r.json() });
      }
      async function runSettlement() {
        const r = await fetch("/cycles/" + encodeURIComponent(ACTIVE_CYCLE_ID) + "/run", { method: "POST", headers: p1Headers(), body: "{}" });
        show("reconOut", { status: r.status, body: await r.json() });
      }
      async function runRecon() {
        const r = await fetch("/cycles/" + encodeURIComponent(ACTIVE_CYCLE_ID) + "/reconcile", { method: "POST", headers: p1Headers(), body: "{}" });
        show("reconOut", { status: r.status, body: await r.json() });
      }
    `,
  });
}
