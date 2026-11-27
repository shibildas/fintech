import { renderFintechShellHtml } from "../../../packages/core/src/index.ts";

/**
 * Project 1 — UPI Central Switch Product Dashboard UI (Login Gate, Sidebar, KPIs, Tables).
 */
export function renderSwitchAdminHtml(activeCycleId: string): string {
  const safeCycleJson = JSON.stringify(activeCycleId);
  return renderFintechShellHtml({
    title: "UPI Central Switch",
    subtitle: "ISO 8583 6-Hop Pay • Chaos • Settlement & Recon",
    activePort: 3001,
    tabs: [
      { id: "overview", label: "Overview & Balances" },
      { id: "pay", label: "Send 6-Hop Pay" },
      { id: "txns", label: "Transactions" },
      { id: "chaos", label: "Chaos & Faults", adminOnly: true },
      { id: "recon", label: "Settlement & Recon" },
    ],
    loginAccounts: [
      { username: "switch.ops", role: "user", label: "Operator (Pay, Recon)" },
      { username: "switch.admin", role: "admin", label: "Admin (Full + Chaos)" },
    ],
    bodyHtml: `
      <section id="view-overview" class="view-pane">
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Active Settlement Cycle</div><div class="kpi-value mono" id="kpiCycle">${activeCycleId}</div><div class="kpi-sub">T+1 Multilateral Netting</div></div>
          <div class="kpi-card"><div class="kpi-label">Total Bank Liquidity</div><div class="kpi-value" id="kpiLiquidity">—</div><div class="kpi-sub">Across BANKA, BANKB, BANKC</div></div>
          <div class="kpi-card"><div class="kpi-label">Connected Accounts</div><div class="kpi-value" id="kpiAcctCount">4</div><div class="kpi-sub">Double-Entry Bank Ledgers</div></div>
        </div>
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div><h3>Live Bank Core Balances</h3><p class="hint" style="margin:0;">Real-time ledger &amp; available balances across connected member banks.</p></div>
            <button onclick="loadBalances(this)">Refresh Balances</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Bank</th><th>VPA Handle</th><th>Masked Account</th><th>Ledger Balance</th><th>Available Balance</th></tr></thead>
              <tbody id="balTableBody"><tr><td colspan="5" style="color:var(--muted);">Loading balances...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="view-pay" class="view-pane hidden">
        <div class="card">
          <h3>Execute 6-Hop UPI Pay</h3>
          <p class="hint">Routes an ISO 8583 MTI 0200 payment through PSP → Switch → Remitter &amp; Beneficiary banks.</p>
          <div class="row">
            <label>Payer VPA<input id="payerVpa" value="anita@psp1" /></label>
            <label>Payee VPA<input id="payeeVpa" value="shop@psp2" /></label>
          </div>
          <div class="row">
            <label>Amount (paise)<input id="amountPaise" type="number" value="50000" /></label>
            <label>UPI PIN<input id="rawPin" type="password" placeholder="Enter customer UPI PIN" /></label>
            <button onclick="sendPay(this)">Send 0200 PAY</button>
          </div>
          <div id="hopSummary" style="margin-top:12px;"></div>
        </div>
      </section>

      <section id="view-txns" class="view-pane hidden">
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div><h3>Recent Switch Transactions</h3><p class="hint" style="margin:0;">Latest ISO 8583 transactions processed by the Central Switch.</p></div>
            <button class="secondary" onclick="loadTxns(this)">Refresh Transactions</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>RRN</th><th>Payer → Payee</th><th>Amount</th><th>Response</th><th>State</th></tr></thead>
              <tbody id="txnTableBody"><tr><td colspan="5" style="color:var(--muted);">Click Refresh Transactions to load history.</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="view-chaos" class="view-pane hidden">
        <div class="card">
          <h3>Bank Chaos Control <span class="badge warn">Admin RBAC</span></h3>
          <p class="hint">Sign in as <code>switch.ops</code> to test HTTP 403 RBAC rejection, or <code>switch.admin</code> to apply live chaos.</p>
          <div class="row">
            <label>Target Bank<select id="chaosBank"><option>BANKA</option><option>BANKB</option><option>BANKC</option></select></label>
            <label>Chaos Mode<select id="chaosMode"><option value="normal">Healthy (Normal)</option><option value="hang">debitThenHang (CHK Recovery)</option><option value="down">forceDown (0420 Reversal)</option></select></label>
            <label>Latency (ms)<input id="chaosLatency" type="number" value="0" min="0" /></label>
            <button class="danger" onclick="applyChaos(this)">Apply Chaos Policy</button>
          </div>
        </div>
      </section>

      <section id="view-recon" class="view-pane hidden">
        <div class="card">
          <h3>T+1 Settlement &amp; 3-Way Reconciliation</h3>
          <p class="hint">Runs zero-sum multilateral netting across BANKA/B/C and classifies 3-way reconciliation exceptions.</p>
          <div class="row">
            <button onclick="runSettlement(this)">Run Settlement Cycle</button>
            <button class="secondary" onclick="runRecon(this)">Run 3-Way Reconciliation</button>
          </div>
          <div id="reconCards" class="kpi-grid" style="margin-top:14px;"></div>
        </div>
      </section>`,
    scriptJs: `
      const ACTIVE_CYCLE_ID = ${safeCycleJson};
      window.onAppAuthenticated = () => { loadBalances(null); loadTxns(null); };
      async function loadBalances(btn) {
        const res = await runAction(btn, null, "Loading balances", async () => {
          const r = await fetch("/api/balances");
          return { status: r.status, body: await r.json(), toastLabel: "Balances" };
        });
        if (res && res.status === 200 && res.body?.accounts) {
          const accts = res.body.accounts;
          const total = accts.reduce((s, a) => s + Number(a.ledger_balance_paise || 0), 0);
          document.getElementById("kpiLiquidity").textContent = formatInr(total);
          document.getElementById("kpiAcctCount").textContent = String(accts.length);
          document.getElementById("balTableBody").innerHTML = accts.map(a =>
            '<tr><td><span class="badge neutral">' + esc(a.bank) + '</span></td><td class="mono">' + esc(a.vpa) + '</td><td class="mono">' + esc(a.account_masked) + '</td><td><strong>' + formatInr(a.ledger_balance_paise) + '</strong></td><td>' + formatInr(a.available_balance_paise) + '</td></tr>'
          ).join("");
        }
      }
      async function loadTxns(btn) {
        const res = await runAction(btn, null, "Loading transactions", async () => {
          const r = await fetch("/transactions");
          return { status: r.status, body: await r.json(), toastLabel: "Transactions" };
        });
        if (res && res.status === 200) {
          const rows = res.body?.transactions || [];
          document.getElementById("txnTableBody").innerHTML = rows.length
            ? rows.slice(0, 20).map(t => {
                const cls = t.state === "SUCCESS" ? "ok" : t.state === "REVERSED" ? "warn" : "err";
                return '<tr><td class="mono">' + esc(t.rrn) + '</td><td class="mono">' + esc(t.payer_vpa) + ' → ' + esc(t.payee_vpa) + '</td><td><strong>' + formatInr(t.amount_paise) + '</strong></td><td class="mono">' + esc(t.response_code || "-") + '</td><td><span class="badge ' + cls + '">' + esc(t.state) + '</span></td></tr>';
              }).join("")
            : '<tr><td colspan="5" style="color:var(--muted);">No transactions yet. Execute a 6-Hop Pay first.</td></tr>';
        }
      }
      async function sendPay(btn) {
        if (!validateFields([
          { id: "payerVpa", check: V.vpa },
          { id: "payeeVpa", check: V.vpa },
          { id: "amountPaise", check: V.posInt },
          { id: "rawPin", check: V.pin }
        ])) return;
        const rawPin = document.getElementById("rawPin").value.trim();
        const res = await runAction(btn, null, "Executing 6-hop pay", async () => {
          const r = await fetch("/api/pay-demo", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({
              payerVpa: document.getElementById("payerVpa").value,
              payeeVpa: document.getElementById("payeeVpa").value,
              amountPaise: Number(document.getElementById("amountPaise").value),
              rawPin
            })
          });
          return { status: r.status, body: await r.json(), toastLabel: "6-Hop UPI Pay" };
        });
        if (res && res.status === 200 && res.body?.transaction) {
          const tx = res.body.transaction;
          const hops = res.body.hops || [];
          document.getElementById("hopSummary").innerHTML =
            '<div class="kpi-grid"><div class="kpi-card"><div class="kpi-label">Status</div><div class="kpi-value"><span class="badge ' + (tx.state === "SUCCESS" ? "ok" : "err") + '">' + esc(tx.state) + ' (' + esc(tx.response_code) + ')</span></div></div><div class="kpi-card"><div class="kpi-label">RRN</div><div class="kpi-value mono" style="font-size:15px;">' + esc(tx.rrn) + '</div></div><div class="kpi-card"><div class="kpi-label">ISO 8583 Hops</div><div class="kpi-value">' + hops.length + ' hops</div></div></div>';
          loadBalances(null);
          loadTxns(null);
        }
      }
      async function applyChaos(btn) {
        return runAction(btn, null, "Applying chaos", async () => {
          const bank = encodeURIComponent(document.getElementById("chaosBank").value);
          const mode = document.getElementById("chaosMode").value;
          const latencyMs = Number(document.getElementById("chaosLatency").value) || 0;
          const payload = mode === "hang" ? { debitThenHang: true, forceDown: false, latencyMs }
                        : mode === "down" ? { debitThenHang: false, forceDown: true, latencyMs }
                        : { debitThenHang: false, forceDown: false, latencyMs };
          const r = await fetch("/participants/" + bank + "/chaos", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
          return { status: r.status, body: await r.json(), toastLabel: "Chaos Policy" };
        });
      }
      async function runSettlement(btn) {
        const res = await runAction(btn, null, "Running settlement", async () => {
          const r = await fetch("/cycles/" + encodeURIComponent(ACTIVE_CYCLE_ID) + "/run", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Settlement" };
        });
        if (res && res.status === 200) {
          document.getElementById("reconCards").innerHTML =
            '<div class="kpi-card"><div class="kpi-label">Settlement Version</div><div class="kpi-value">v' + esc(res.body.version ?? 1) + '</div></div><div class="kpi-card"><div class="kpi-label">Zero-Sum Netting</div><div class="kpi-value"><span class="badge ok">BALANCED (₹0.00)</span></div></div>';
        }
      }
      async function runRecon(btn) {
        const res = await runAction(btn, null, "Reconciling", async () => {
          const r = await fetch("/cycles/" + encodeURIComponent(ACTIVE_CYCLE_ID) + "/reconcile", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "3-Way Recon" };
        });
        if (res && res.status === 200 && res.body?.summary) {
          document.getElementById("reconCards").innerHTML =
            '<div class="kpi-card"><div class="kpi-label">Total Matched</div><div class="kpi-value">' + esc(res.body.summary.by_class?.MATCHED?.count ?? 0) + '</div></div><div class="kpi-card"><div class="kpi-label">Exceptions Opened</div><div class="kpi-value">' + esc(res.body.exceptionsOpened ?? 0) + '</div></div>';
        }
      }
    `,
  });
}
