import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 2 — Merchant Payment Gateway Product Dashboard UI (Stripe/RazorpayX Style).
 */
export function renderGatewayUiHtml(): string {
  return renderFintechShellHtml({
    title: "Merchant Payment Gateway",
    subtitle: "PCI Token Vault • Smart Acquirer Failover • SubtleCrypto HMAC & Webhooks",
    activePort: 3002,
    tabs: [
      { id: "overview", label: "Overview & Ledger" },
      { id: "checkout", label: "Hosted Checkout" },
      { id: "acquirers", label: "Acquirers & Chaos", adminOnly: true },
      { id: "refunds", label: "Refunds & Payouts" },
      { id: "webhooks", label: "Webhooks & Keys" },
    ],
    loginAccounts: [
      { username: "acme.user", role: "user", label: "Ops User (Checkout, Refunds)" },
      { username: "acme.admin", role: "admin", label: "Finance Admin (Chaos, Keys)" },
    ],
    bodyHtml: `
      <section id="view-overview" class="view-pane">
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Merchant Payable</div><div class="kpi-value" id="kpiPayable">—</div><div class="kpi-sub">Double-Entry Ledger</div></div>
          <div class="kpi-card"><div class="kpi-label">Rolling Reserve</div><div class="kpi-value" id="kpiReserve">—</div><div class="kpi-sub">10% Holdback</div></div>
          <div class="kpi-card"><div class="kpi-label">Dashboard Parity</div><div class="kpi-value" id="kpiParity">—</div><div class="kpi-sub">Zero Ledger Drift</div></div>
          <div class="kpi-card"><div class="kpi-label">PCI Vault Audit</div><div class="kpi-value" id="kpiPci">—</div><div class="kpi-sub">Isolated p2-vault.sqlite</div></div>
        </div>
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:0;">
            <div><h3>Merchant Health &amp; Compliance Checks</h3><p class="hint" style="margin:0;">Verify ledger-to-dashboard parity and zero raw PAN leaks across SQLite &amp; logs.</p></div>
            <div class="row" style="margin:0;">
              <button onclick="checkParity(this)">Refresh Ledger Parity</button>
              <button class="secondary" onclick="runGrepAudit(this)">Run PCI Grep Audit</button>
            </div>
          </div>
        </div>
      </section>

      <section id="view-checkout" class="view-pane hidden">
        <div class="card">
          <h3>Hosted Checkout (PCI Token Vault Card &amp; UPI)</h3>
          <p class="hint">Card PANs are tokenized directly in <code>p2-vault.sqlite</code>; the Gateway only handles opaque tokens.</p>
          <div class="row">
            <label>Order Amount (paise)<input id="ordAmt" type="number" value="150000" /></label>
            <label>Card PAN (Vault)<input id="cardPan" value="4111111111114242" /></label>
            <label>3DS OTP<input id="cardOtp" type="password" placeholder="Enter 3DS OTP (123456)" /></label>
          </div>
          <div class="row">
            <label>UPI Payer VPA<input id="upiVpa" value="anita@psp1" /></label>
            <label>UPI PIN<input id="upiPin" type="password" placeholder="Enter customer UPI PIN" /></label>
          </div>
          <div class="row">
            <button onclick="runCardCheckout(this)">Pay with Vaulted Card</button>
            <button class="secondary" onclick="runUpiCheckout(this)">Pay with UPI</button>
          </div>
          <div id="checkoutSummary" style="margin-top:14px;"></div>
        </div>
      </section>

      <section id="view-acquirers" class="view-pane hidden">
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div><h3>Smart Acquirer Routing &amp; Chaos <span class="badge warn">Admin</span></h3><p class="hint" style="margin:0;">Force ACQ_ALPHA down to watch live failover to ACQ_BETA.</p></div>
            <button class="secondary" onclick="loadAcqHealth(this)">Refresh Health</button>
          </div>
          <div class="row">
            <label>Acquirer<select id="acqId"><option>ACQ_ALPHA</option><option>ACQ_BETA</option><option>ACQ_GAMMA</option></select></label>
            <label>Failure %<input id="acqFailPct" type="number" value="0" min="0" max="100" /></label>
            <label>Latency (ms)<input id="acqLatency" type="number" value="0" min="0" /></label>
            <button class="danger" onclick="setAcqChaos(this, true)">Force Down</button>
            <button class="secondary" onclick="setAcqChaos(this, false)">Restore Healthy</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Acquirer</th><th>Circuit State</th><th>Success Rate</th><th>Attempts</th></tr></thead>
              <tbody id="acqTableBody"><tr><td colspan="4" style="color:var(--muted);">Loading acquirer health...</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>

      <section id="view-refunds" class="view-pane hidden">
        <div class="card">
          <h3>Partial Refunds &amp; T+1 Settlement Payouts</h3>
          <p class="hint">Enforces cumulative refund cap (HTTP 422) and generates T+1 payout CSV settlements.</p>
          <div class="row">
            <label>Payment ID<input id="refPayId" placeholder="pay_... (auto-filled after checkout)" /></label>
            <label>Refund Amount (paise)<input id="refAmt" type="number" value="50000" /></label>
            <button onclick="issueRefund(this)">Issue Refund</button>
            <button class="secondary" onclick="runPayout(this)">Run T+1 Payout</button>
          </div>
        </div>
      </section>

      <section id="view-webhooks" class="view-pane hidden">
        <div class="card">
          <div class="row" style="justify-content:space-between;align-items:center;margin-bottom:12px;">
            <div><h3>Signed Webhooks &amp; API Key Rotation</h3><p class="hint" style="margin:0;">Simulate merchant 500 outages, resend signed webhooks, or rotate keys with overlap.</p></div>
            <div class="row" style="margin:0;">
              <button class="danger" onclick="setWebhook500(this, true)">Simulate 500</button>
              <button class="secondary" onclick="setWebhook500(this, false)">Restore 200</button>
              <button class="secondary" onclick="loadWebhooks(this)">Refresh</button>
              <button onclick="rotateKey(this)">Rotate API Key</button>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Delivery ID</th><th>Event</th><th>Status</th><th>Attempts</th><th>Action</th></tr></thead>
              <tbody id="whTableBody"><tr><td colspan="5" style="color:var(--muted);">Click Refresh to load webhook deliveries.</td></tr></tbody>
            </table>
          </div>
        </div>
      </section>`,
    scriptJs: `
      window.onAppAuthenticated = () => { checkParity(null); loadAcqHealth(null); loadWebhooks(null); };
      async function api(method, path, bodyObj) {
        const headers = bodyObj !== undefined ? { "content-type": "application/json" } : {};
        const r = await fetch(path, { method, headers, body: bodyObj === undefined ? undefined : JSON.stringify(bodyObj) });
        return { status: r.status, body: await r.json() };
      }
      async function checkParity(btn) {
        const res = await runAction(btn, null, "Checking parity", async () => ({ ...(await api("GET", "/api/ledger/parity")), toastLabel: "Ledger Parity" }));
        if (res && res.status === 200) {
          document.getElementById("kpiPayable").textContent = formatInr(res.body.balances?.merchant_payable_paise ?? 0);
          document.getElementById("kpiReserve").textContent = formatInr(res.body.balances?.merchant_reserve_paise ?? 0);
          const ok = Boolean(res.body.parity?.matches);
          document.getElementById("kpiParity").innerHTML = '<span class="badge ' + (ok ? "ok" : "err") + '">' + (ok ? "MATCHED" : "DRIFT") + '</span>';
        }
      }
      async function runGrepAudit(btn) {
        const res = await runAction(btn, null, "Running PCI audit", async () => ({ ...(await api("GET", "/api/pci-grep-audit")), toastLabel: "PCI Grep Audit" }));
        if (res && res.status === 200) {
          const ok = Boolean(res.body.passed);
          document.getElementById("kpiPci").innerHTML = '<span class="badge ' + (ok ? "ok" : "err") + '">' + (ok ? "0 LEAKS" : "LEAK") + '</span>';
        }
      }
      async function runCardCheckout(btn) {
        const cardOtp = document.getElementById("cardOtp").value.trim();
        if (!cardOtp) { toast("Enter 3DS OTP first", "err"); return; }
        const res = await runAction(btn, null, "Processing card", async () => {
          const ord = await api("POST", "/api/orders", { amountPaise: Number(document.getElementById("ordAmt").value), idempotencyKey: "ui_ord_" + Date.now(), merchantOrderId: "rcpt_" + Date.now() });
          if (ord.status !== 201) return { ...ord, toastLabel: "Order" };
          const tokRes = await fetch("/api/vault/tokenize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ cardNumber: document.getElementById("cardPan").value, expiry: "12/29", merchantId: ord.body.order.merchant_id }) });
          const tok = await tokRes.json();
          if (!tokRes.ok) return { status: tokRes.status, body: tok, toastLabel: "Vault Tokenize" };
          const pay = await api("POST", "/api/payments", { orderId: ord.body.order.id, method: "CARD", tokenId: tok.token, cardOtp });
          if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
          return { status: pay.status, body: { token: tok, payment: pay.body }, toastLabel: "Card Checkout" };
        });
        if (res && res.status === 200 && res.body?.payment?.payment) {
          const p = res.body.payment.payment;
          document.getElementById("checkoutSummary").innerHTML =
            '<div class="kpi-grid"><div class="kpi-card"><div class="kpi-label">Payment ID</div><div class="kpi-value mono" style="font-size:14px;">' + esc(p.id) + '</div></div><div class="kpi-card"><div class="kpi-label">Acquirer Used</div><div class="kpi-value">' + esc(p.acquirer_id) + '</div></div><div class="kpi-card"><div class="kpi-label">State</div><div class="kpi-value"><span class="badge ' + (p.state === "CAPTURED" ? "ok" : "err") + '">' + esc(p.state) + '</span></div></div></div>';
          checkParity(null); loadWebhooks(null);
        }
      }
      async function runUpiCheckout(btn) {
        const upiRawPin = document.getElementById("upiPin").value.trim();
        if (!upiRawPin) { toast("Enter UPI PIN first", "err"); return; }
        const res = await runAction(btn, null, "Processing UPI", async () => {
          const ord = await api("POST", "/api/orders", { amountPaise: Number(document.getElementById("ordAmt").value), idempotencyKey: "ui_upi_" + Date.now(), merchantOrderId: "rcpt_upi_" + Date.now() });
          if (ord.status !== 201) return { ...ord, toastLabel: "Order" };
          const pay = await api("POST", "/api/payments", { orderId: ord.body.order.id, method: "UPI", upiPayerVpa: document.getElementById("upiVpa").value.trim(), upiRawPin });
          if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
          return { ...pay, toastLabel: "UPI Checkout" };
        });
        if (res && res.status === 200) { checkParity(null); loadWebhooks(null); }
      }
      async function loadAcqHealth(btn) {
        const res = await runAction(btn, null, "Refreshing acquirers", async () => ({ ...(await api("GET", "/api/acquirers/health")), toastLabel: "Acquirer Health" }));
        if (res && res.status === 200) {
          const list = res.body?.snapshots || [];
          document.getElementById("acqTableBody").innerHTML = list.map(a => {
            const cls = a.circuitState === "CLOSED" ? "ok" : a.circuitState === "HALF_OPEN" ? "warn" : "err";
            return '<tr><td><strong>' + esc(a.acquirerId) + '</strong></td><td><span class="badge ' + cls + '">' + esc(a.circuitState) + '</span></td><td>' + esc(a.successRatePercent ?? 100) + '%</td><td>' + esc(a.totalAttempts ?? 0) + '</td></tr>';
          }).join("");
        }
      }
      async function setAcqChaos(btn, forceDown) {
        const res = await runAction(btn, null, forceDown ? "Forcing down" : "Restoring", async () => {
          const id = encodeURIComponent(document.getElementById("acqId").value);
          return { ...(await api("PUT", "/api/acquirers/" + id + "/chaos", { forceDown, technicalFailureRatePercent: Number(document.getElementById("acqFailPct").value) || 0, latencyMs: Number(document.getElementById("acqLatency").value) || 0 })), toastLabel: "Acquirer Chaos" };
        });
        if (res && res.status === 200) loadAcqHealth(null);
      }
      async function issueRefund(btn) {
        const res = await runAction(btn, null, "Issuing refund", async () => ({
          ...(await api("POST", "/api/refunds", { paymentId: document.getElementById("refPayId").value.trim(), amountPaise: Number(document.getElementById("refAmt").value), idempotencyKey: "ui_ref_" + Date.now() })),
          toastLabel: "Refund"
        }));
        if (res && res.status === 201) checkParity(null);
      }
      async function runPayout(btn) {
        const res = await runAction(btn, null, "Generating payout", async () => ({ ...(await api("POST", "/api/payouts/run", {})), toastLabel: "T+1 Payout" }));
        if (res && res.status === 200) checkParity(null);
      }
      async function setWebhook500(btn, flag) {
        return runAction(btn, null, "Updating receiver", async () => ({ ...(await api("PUT", "/api/webhooks/demo-receiver", { simulateServer500: flag })), toastLabel: "Webhook Receiver" }));
      }
      async function loadWebhooks(btn) {
        const res = await runAction(btn, null, "Loading webhooks", async () => ({ ...(await api("GET", "/api/webhooks/deliveries")), toastLabel: "Webhooks" }));
        if (res && res.status === 200) {
          const rows = res.body?.deliveries || [];
          document.getElementById("whTableBody").innerHTML = rows.length
            ? rows.slice(0, 15).map(d => {
                const cls = d.status === "DELIVERED" ? "ok" : d.status === "RETRY_SCHEDULED" ? "warn" : "err";
                return '<tr><td class="mono">' + esc(d.id) + '</td><td class="mono">' + esc(d.event_type) + '</td><td><span class="badge ' + cls + '">' + esc(d.status) + '</span></td><td>' + esc(d.attempt_count) + '</td><td><button class="secondary" style="padding:5px 10px;font-size:12px;" onclick="resendWhById(this, \\'' + esc(d.id) + '\\')">Resend</button></td></tr>';
              }).join("")
            : '<tr><td colspan="5" style="color:var(--muted);">No webhook deliveries yet. Run a checkout first.</td></tr>';
        }
      }
      async function resendWhById(btn, id) {
        const res = await runAction(btn, null, "Resending", async () => ({ ...(await api("POST", "/api/webhooks/deliveries/" + encodeURIComponent(id) + "/resend", {})), toastLabel: "Webhook Resend" }));
        if (res && res.status === 200) loadWebhooks(null);
      }
      async function rotateKey(btn) {
        return runAction(btn, null, "Rotating key", async () => ({ ...(await api("POST", "/api/keys/rotate", { overlapWindowMs: 900000 })), toastLabel: "Key Rotation" }));
      }
    `,
  });
}
