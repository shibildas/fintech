import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 2 — Merchant Payment Gateway Interactive Dashboard HTML/JS UI.
 */
export function renderGatewayUiHtml(): string {
  return renderFintechShellHtml({
    title: "Project 2 — Merchant Payment Gateway, PCI Vault & Webhooks",
    subtitle: "Browser SubtleCrypto HMAC-SHA256 Auth • Isolated p2-vault.sqlite • Smart Failover • Webhooks & Payouts",
    activePort: 3002,
    bodyHtml: `
      <div class="auth-bar">
        <label>X-Key-Id (see server stdout)<input id="gwKeyId" placeholder="rzp_live_..." /></label>
        <label>API Secret (signed locally via SubtleCrypto)<input id="gwSecret" type="password" placeholder="sec_live_..." /></label>
        <button onclick="checkParity()">Ledger Parity</button>
        <button class="secondary" onclick="runGrepAudit()">PCI Grep Audit</button>
        <button class="secondary" onclick="rotateKey()">Rotate Key (15m Overlap)</button>
      </div>
      <div class="card" style="margin-bottom:16px">
        <div class="row" style="margin-bottom:0;justify-content:space-between">
          <span class="badge ok" id="sigPreview">Last X-Signature: (none yet)</span>
        </div>
        <pre id="topOut" class="out">Top-bar Ledger Parity, PCI Grep Audit & Key Rotation responses appear here...</pre>
      </div>
      <div class="grid">
        <div class="card">
          <h2>1. Order -> PCI Token Vault -> 3DS Card / UPI Pay</h2>
          <div class="row">
            <label>Amount (paise)<input id="ordAmt" type="number" value="150000" /></label>
            <label>Card PAN (Vault Only)<input id="cardPan" value="4111111111114242" /></label>
            <label>3DS OTP<input id="cardOtp" type="password" placeholder="Enter 3DS OTP" /></label>
          </div>
          <div class="row">
            <label>UPI Payer VPA<input id="upiVpa" value="anita@psp1" /></label>
            <label>UPI PIN<input id="upiPin" type="password" placeholder="Enter UPI PIN" /></label>
          </div>
          <div class="row">
            <button onclick="runCardCheckout()">Run Card Checkout</button>
            <button class="secondary" onclick="runUpiCheckout()">Run UPI Checkout</button>
          </div>
          <pre id="payOut" class="out">Enter X-Key-Id + API Secret above, then run checkout...</pre>
        </div>
        <div class="card">
          <h2>2. Smart Acquirer Chaos & Health</h2>
          <div class="row">
            <label>Acquirer<select id="acqId"><option>ACQ_ALPHA</option><option>ACQ_BETA</option><option>ACQ_GAMMA</option></select></label>
            <label>Failure %<input id="acqFailPct" type="number" value="0" min="0" max="100" /></label>
            <label>Latency (ms)<input id="acqLatency" type="number" value="0" min="0" /></label>
          </div>
          <div class="row">
            <button class="danger" onclick="setAcqChaos(true)">Force Down</button>
            <button class="secondary" onclick="setAcqChaos(false)">Apply / Restore Healthy</button>
            <button class="secondary" onclick="loadAcqHealth()">Refresh Health</button>
          </div>
          <pre id="acqOut" class="out">Toggle ACQ_ALPHA down to watch live failover to ACQ_BETA...</pre>
        </div>
        <div class="card">
          <h2>3. Partial Refunds & T+1 Payout CSV</h2>
          <div class="row">
            <label>Payment ID<input id="refPayId" placeholder="pay_..." /></label>
            <label>Refund (paise)<input id="refAmt" type="number" value="50000" /></label>
            <button onclick="issueRefund()">Refund</button>
            <button class="secondary" onclick="runPayout()">Run T+1 Payout</button>
          </div>
          <pre id="refOut" class="out">Partial refunds, 422 guard & T+1 CSV...</pre>
        </div>
        <div class="card">
          <h2>4. Signed Webhooks & 500 Outage Simulator</h2>
          <div class="row">
            <button class="danger" onclick="setWebhook500(true)">Simulate Demo Store 500</button>
            <button class="secondary" onclick="setWebhook500(false)">Restore 200 OK</button>
            <button onclick="loadWebhooks()">Refresh Deliveries</button>
          </div>
          <div class="row">
            <label>Delivery ID to Resend<input id="whDelId" placeholder="wh_del_..." /></label>
            <button onclick="resendWh()">Manual Resend</button>
          </div>
          <pre id="whOut" class="out">Webhook delivery attempts & HMAC signatures...</pre>
        </div>
      </div>`,
    scriptJs: `
      async function hmacHex(secret, msg) {
        const enc = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, enc.encode(msg));
        return Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      async function signedFetch(method, path, bodyObj) {
        const keyId = document.getElementById("gwKeyId").value.trim();
        const secret = document.getElementById("gwSecret").value.trim();
        const rawBody = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
        const ts = new Date().toISOString();
        const sig = secret ? await hmacHex(secret, ts + "." + rawBody) : "";
        const sigEl = document.getElementById("sigPreview");
        if (sigEl) sigEl.textContent = sig ? ("Last X-Signature: " + sig.slice(0, 24) + "...") : "Last X-Signature: (unsigned)";
        const headers = { "x-key-id": keyId, "x-timestamp": ts, "x-signature": sig };
        if (bodyObj !== undefined) headers["content-type"] = "application/json";
        const r = await fetch(path, { method, headers, body: bodyObj === undefined ? undefined : rawBody });
        return { status: r.status, body: await r.json() };
      }
      async function runCardCheckout() {
        const amt = Number(document.getElementById("ordAmt").value);
        const cardOtp = document.getElementById("cardOtp").value.trim();
        if (!cardOtp) return show("payOut", { error: "Please enter 3DS OTP (see server stdout)" });
        const ord = await signedFetch("POST", "/api/orders", { amountPaise: amt, idempotencyKey: "ui_ord_" + Date.now(), merchantOrderId: "rcpt_" + Date.now() });
        if (ord.status !== 201) return show("payOut", ord);
        const tokRes = await fetch("/api/vault/tokenize", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ cardNumber: document.getElementById("cardPan").value, expiry: "12/29", merchantId: ord.body.order.merchant_id })
        });
        const tok = await tokRes.json();
        if (!tokRes.ok) return show("payOut", { status: tokRes.status, body: tok });
        const pay = await signedFetch("POST", "/api/payments", { orderId: ord.body.order.id, method: "CARD", tokenId: tok.token, cardOtp });
        if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
        show("payOut", { token: tok, payment: pay });
      }
      async function runUpiCheckout() {
        const amt = Number(document.getElementById("ordAmt").value);
        const upiPayerVpa = document.getElementById("upiVpa").value.trim();
        const upiRawPin = document.getElementById("upiPin").value.trim();
        if (!upiRawPin) return show("payOut", { error: "Please enter UPI PIN (see server stdout)" });
        const ord = await signedFetch("POST", "/api/orders", { amountPaise: amt, idempotencyKey: "ui_upi_" + Date.now(), merchantOrderId: "rcpt_upi_" + Date.now() });
        if (ord.status !== 201) return show("payOut", ord);
        const pay = await signedFetch("POST", "/api/payments", { orderId: ord.body.order.id, method: "UPI", upiPayerVpa, upiRawPin });
        if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
        show("payOut", pay);
      }
      async function setAcqChaos(forceDown) {
        const id = encodeURIComponent(document.getElementById("acqId").value);
        const technicalFailureRatePercent = Number(document.getElementById("acqFailPct").value) || 0;
        const latencyMs = Number(document.getElementById("acqLatency").value) || 0;
        show("acqOut", await signedFetch("PUT", "/api/acquirers/" + id + "/chaos", { forceDown, technicalFailureRatePercent, latencyMs }));
      }
      async function loadAcqHealth() { show("acqOut", await signedFetch("GET", "/api/acquirers/health")); }
      async function runGrepAudit() { show("topOut", await signedFetch("GET", "/api/pci-grep-audit")); }
      async function checkParity() { show("topOut", await signedFetch("GET", "/api/ledger/parity")); }
      async function issueRefund() {
        show("refOut", await signedFetch("POST", "/api/refunds", {
          paymentId: document.getElementById("refPayId").value.trim(),
          amountPaise: Number(document.getElementById("refAmt").value),
          idempotencyKey: "ui_ref_" + Date.now()
        }));
      }
      async function runPayout() { show("refOut", await signedFetch("POST", "/api/payouts/run", {})); }
      async function setWebhook500(flag) { show("whOut", await signedFetch("PUT", "/api/webhooks/demo-receiver", { simulateServer500: flag })); }
      async function loadWebhooks() { show("whOut", await signedFetch("GET", "/api/webhooks/deliveries")); }
      async function resendWh() {
        const id = document.getElementById("whDelId").value.trim();
        if (!id) return show("whOut", { error: "Please enter a Delivery ID to resend" });
        show("whOut", await signedFetch("POST", "/api/webhooks/deliveries/" + encodeURIComponent(id) + "/resend", {}));
      }
      async function rotateKey() { show("topOut", await signedFetch("POST", "/api/keys/rotate", { overlapWindowMs: 900000 })); }
    `,
  });
}
