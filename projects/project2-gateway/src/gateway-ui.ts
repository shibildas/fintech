import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 2 — Merchant Payment Gateway Interactive Dashboard HTML/JS UI.
 */
export function renderGatewayUiHtml(): string {
  return renderFintechShellHtml({
    title: "Project 2 — Merchant Payment Gateway",
    subtitle:
      "Browser SubtleCrypto HMAC-SHA256 • Isolated PCI Token Vault • Smart Failover & Webhooks",
    activePort: 3002,
    bodyHtml: `
      <div class="auth-bar">
        <label>Merchant Key ID (stdout)<input id="gwKeyId" placeholder="rzp_live_..." /></label>
        <label>API Secret (signed locally via SubtleCrypto)<input id="gwSecret" type="password" placeholder="sec_live_..." /></label>
        <button onclick="checkParity(this)">Ledger Parity</button>
        <button class="secondary" onclick="runGrepAudit(this)">PCI Grep Audit</button>
        <button class="secondary" onclick="rotateKey(this)">Rotate Key</button>
      </div>

      <div class="card" style="margin-bottom:20px">
        <div class="row" style="margin-bottom:8px;justify-content:space-between;align-items:center">
          <span class="badge neutral" id="sigPreview">Last X-Signature: (none yet)</span>
          <div id="topOutMeta" class="out-meta" style="margin:0"></div>
        </div>
        <pre id="topOut" class="out">Ledger Parity, PCI Grep Audit &amp; Key Rotation results appear here.</pre>
      </div>

      <div class="grid">
        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">1</span> Hosted Checkout (Vault Card &amp; UPI)</h2>
            <p class="hint">Card PANs go directly to p2-vault.sqlite; Gateway only receives opaque tokens.</p>
          </div>
          <div class="row">
            <label>Amount (paise)<input id="ordAmt" type="number" value="150000" /></label>
            <label>Card PAN (Vault)<input id="cardPan" value="4111111111114242" /></label>
            <label>3DS OTP<input id="cardOtp" type="password" placeholder="Enter 3DS OTP" /></label>
          </div>
          <div class="row">
            <label>UPI Payer VPA<input id="upiVpa" value="anita@psp1" /></label>
            <label>UPI PIN<input id="upiPin" type="password" placeholder="Enter UPI PIN" /></label>
          </div>
          <div class="row">
            <button onclick="runCardCheckout(this)">Pay with Card</button>
            <button class="secondary" onclick="runUpiCheckout(this)">Pay with UPI</button>
          </div>
          <div class="out-wrap">
            <div id="payOutMeta" class="out-meta"></div>
            <pre id="payOut" class="out">Enter X-Key-Id &amp; API Secret above, then submit a payment.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">2</span> Smart Acquirer Chaos &amp; Failover</h2>
            <p class="hint">Force ACQ_ALPHA down to watch live failover to ACQ_BETA.</p>
          </div>
          <div class="row">
            <label>Acquirer<select id="acqId"><option>ACQ_ALPHA</option><option>ACQ_BETA</option><option>ACQ_GAMMA</option></select></label>
            <label>Failure %<input id="acqFailPct" type="number" value="0" min="0" max="100" /></label>
            <label>Latency (ms)<input id="acqLatency" type="number" value="0" min="0" /></label>
          </div>
          <div class="row">
            <button class="danger" onclick="setAcqChaos(this, true)">Force Down</button>
            <button class="secondary" onclick="setAcqChaos(this, false)">Restore Healthy</button>
            <button class="secondary" onclick="loadAcqHealth(this)">Health Snapshot</button>
          </div>
          <div class="out-wrap">
            <div id="acqOutMeta" class="out-meta"></div>
            <pre id="acqOut" class="out">Acquirer circuit breaker &amp; rolling health metrics.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">3</span> Partial Refunds &amp; T+1 Payouts</h2>
            <p class="hint">Tests cumulative refund cap (422) and T+1 CSV settlement generation.</p>
          </div>
          <div class="row">
            <label>Payment ID<input id="refPayId" placeholder="pay_..." /></label>
            <label>Refund (paise)<input id="refAmt" type="number" value="50000" /></label>
          </div>
          <div class="row">
            <button onclick="issueRefund(this)">Issue Refund</button>
            <button class="secondary" onclick="runPayout(this)">Run T+1 Payout</button>
          </div>
          <div class="out-wrap">
            <div id="refOutMeta" class="out-meta"></div>
            <pre id="refOut" class="out">Refund and payout ledger responses appear here.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">4</span> Signed Webhooks &amp; Outage Recovery</h2>
            <p class="hint">Simulate merchant 500 outages and trigger manual HMAC-signed resends.</p>
          </div>
          <div class="row">
            <button class="danger" onclick="setWebhook500(this, true)">Simulate 500</button>
            <button class="secondary" onclick="setWebhook500(this, false)">Restore 200 OK</button>
            <button class="secondary" onclick="loadWebhooks(this)">Deliveries</button>
          </div>
          <div class="row">
            <label>Delivery ID<input id="whDelId" placeholder="wh_del_..." /></label>
            <button onclick="resendWh(this)">Manual Resend</button>
          </div>
          <div class="out-wrap">
            <div id="whOutMeta" class="out-meta"></div>
            <pre id="whOut" class="out">Webhook delivery queue and retry attempts.</pre>
          </div>
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
        if (sigEl) {
          sigEl.className = sig ? "badge ok" : "badge warn";
          sigEl.textContent = sig ? ("Last X-Signature: " + sig.slice(0, 24) + "...") : "Last X-Signature: (unsigned)";
        }
        const headers = { "x-key-id": keyId, "x-timestamp": ts, "x-signature": sig };
        if (bodyObj !== undefined) headers["content-type"] = "application/json";
        const r = await fetch(path, { method, headers, body: bodyObj === undefined ? undefined : rawBody });
        return { status: r.status, body: await r.json() };
      }
      async function runCardCheckout(btn) {
        const cardOtp = document.getElementById("cardOtp").value.trim();
        if (!cardOtp) {
          toast("Enter 3DS OTP first", "err");
          return show("payOut", { error: "Please enter 3DS OTP (see server stdout)" }, { status: 400 });
        }
        return runAction(btn, "payOut", "Processing card", async () => {
          const amt = Number(document.getElementById("ordAmt").value);
          const ord = await signedFetch("POST", "/api/orders", { amountPaise: amt, idempotencyKey: "ui_ord_" + Date.now(), merchantOrderId: "rcpt_" + Date.now() });
          if (ord.status !== 201) return { ...ord, toastLabel: "Order" };
          const tokRes = await fetch("/api/vault/tokenize", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ cardNumber: document.getElementById("cardPan").value, expiry: "12/29", merchantId: ord.body.order.merchant_id })
          });
          const tok = await tokRes.json();
          if (!tokRes.ok) return { status: tokRes.status, body: tok, toastLabel: "Vault Tokenize" };
          const pay = await signedFetch("POST", "/api/payments", { orderId: ord.body.order.id, method: "CARD", tokenId: tok.token, cardOtp });
          if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
          return { status: pay.status, display: { token: tok, payment: pay }, toastLabel: "Card Payment" };
        });
      }
      async function runUpiCheckout(btn) {
        const upiRawPin = document.getElementById("upiPin").value.trim();
        if (!upiRawPin) {
          toast("Enter UPI PIN first", "err");
          return show("payOut", { error: "Please enter UPI PIN (see server stdout)" }, { status: 400 });
        }
        return runAction(btn, "payOut", "Processing UPI", async () => {
          const amt = Number(document.getElementById("ordAmt").value);
          const ord = await signedFetch("POST", "/api/orders", { amountPaise: amt, idempotencyKey: "ui_upi_" + Date.now(), merchantOrderId: "rcpt_upi_" + Date.now() });
          if (ord.status !== 201) return { ...ord, toastLabel: "Order" };
          const pay = await signedFetch("POST", "/api/payments", {
            orderId: ord.body.order.id, method: "UPI", upiPayerVpa: document.getElementById("upiVpa").value.trim(), upiRawPin
          });
          if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
          return { ...pay, toastLabel: "UPI Payment" };
        });
      }
      async function setAcqChaos(btn, forceDown) {
        return runAction(btn, "acqOut", forceDown ? "Forcing down" : "Updating acquirer", async () => {
          const id = encodeURIComponent(document.getElementById("acqId").value);
          const technicalFailureRatePercent = Number(document.getElementById("acqFailPct").value) || 0;
          const latencyMs = Number(document.getElementById("acqLatency").value) || 0;
          const res = await signedFetch("PUT", "/api/acquirers/" + id + "/chaos", { forceDown, technicalFailureRatePercent, latencyMs });
          return { ...res, toastLabel: "Acquirer Chaos" };
        });
      }
      async function loadAcqHealth(btn) {
        return runAction(btn, "acqOut", "Checking health", async () => ({ ...(await signedFetch("GET", "/api/acquirers/health")), toastLabel: "Acquirer Health" }));
      }
      async function runGrepAudit(btn) {
        return runAction(btn, "topOut", "Running PCI grep", async () => ({ ...(await signedFetch("GET", "/api/pci-grep-audit")), toastLabel: "PCI Grep Audit" }));
      }
      async function checkParity(btn) {
        return runAction(btn, "topOut", "Checking parity", async () => ({ ...(await signedFetch("GET", "/api/ledger/parity")), toastLabel: "Ledger Parity" }));
      }
      async function issueRefund(btn) {
        return runAction(btn, "refOut", "Issuing refund", async () => ({
          ...(await signedFetch("POST", "/api/refunds", {
            paymentId: document.getElementById("refPayId").value.trim(),
            amountPaise: Number(document.getElementById("refAmt").value),
            idempotencyKey: "ui_ref_" + Date.now()
          })),
          toastLabel: "Refund"
        }));
      }
      async function runPayout(btn) {
        return runAction(btn, "refOut", "Generating payout", async () => ({ ...(await signedFetch("POST", "/api/payouts/run", {})), toastLabel: "T+1 Payout" }));
      }
      async function setWebhook500(btn, flag) {
        return runAction(btn, "whOut", "Updating receiver", async () => ({ ...(await signedFetch("PUT", "/api/webhooks/demo-receiver", { simulateServer500: flag })), toastLabel: "Webhook Receiver" }));
      }
      async function loadWebhooks(btn) {
        return runAction(btn, "whOut", "Loading deliveries", async () => ({ ...(await signedFetch("GET", "/api/webhooks/deliveries")), toastLabel: "Webhooks" }));
      }
      async function resendWh(btn) {
        const id = document.getElementById("whDelId").value.trim();
        if (!id) {
          toast("Enter Delivery ID first", "err");
          return show("whOut", { error: "Please enter a Delivery ID to resend" }, { status: 400 });
        }
        return runAction(btn, "whOut", "Resending", async () => ({ ...(await signedFetch("POST", "/api/webhooks/deliveries/" + encodeURIComponent(id) + "/resend", {})), toastLabel: "Webhook Resend" }));
      }
      async function rotateKey(btn) {
        return runAction(btn, "topOut", "Rotating key", async () => ({ ...(await signedFetch("POST", "/api/keys/rotate", { overlapWindowMs: 900000 })), toastLabel: "Key Rotation" }));
      }
    `,
  });
}
