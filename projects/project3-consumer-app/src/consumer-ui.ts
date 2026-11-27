import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 3 — Consumer UPI App, Real-Time Risk Engine & Dispute Desk Product UI.
 */
export function renderConsumerUiHtml(): string {
  return renderFintechShellHtml({
    title: "Consumer UPI & Risk Desk",
    subtitle: "Ed25519 Device Signing • 4 Pay Paths • Shadow Diff & Disputes",
    activePort: 3003,
    tabs: [
      { id: "phone", label: "Consumer UPI App" },
      { id: "collects", label: "Collect Requests" },
      { id: "risk", label: "Risk & Shadow Mode", adminOnly: true },
      { id: "disputes", label: "Dispute Desk", adminOnly: true },
    ],
    loginAccounts: [
      { username: "anita.user", role: "user", label: "Consumer UPI App" },
      { username: "risk.admin", role: "admin", label: "Ops Admin (Risk, Disputes)" },
    ],
    bodyHtml: `
      <section id="view-phone" class="view-pane">
        <div class="grid">
          <div class="card">
            <h3>1. Consumer Onboarding &amp; Ed25519 Binding</h3>
            <p class="hint">Generates a browser-local Ed25519 keypair via Web Crypto; private key never leaves your browser.</p>
            <div class="row">
              <label>Mobile Number<input id="cMob" value="9876543210" /></label>
              <label>Full Name<input id="cName" value="Anita Sharma" /></label>
              <button onclick="doSignup(this)">Send OTP</button>
            </div>
            <div class="row">
              <label>SMS OTP (123456)<input id="cOtp" type="password" placeholder="Enter SMS OTP" /></label>
              <label>Set UPI PIN<input id="cPin" type="password" placeholder="4-6 digit PIN" /></label>
              <button onclick="doVerifyAndBind(this)">Verify &amp; Bind Device</button>
            </div>
            <div id="deviceBadge" style="margin-top:8px;"><span class="badge neutral">No Ed25519 device bound in this tab yet</span></div>
          </div>

          <div class="card">
            <h3>2. Ed25519 Signed Pay (4 Pay Paths)</h3>
            <p class="hint">Signs payload with Ed25519 and computes salted per-transaction nonce PIN proof client-side.</p>
            <div class="row">
              <label>Pay Path
                <select id="payPath">
                  <option value="VPA">VPA</option>
                  <option value="QR">QR (upi://pay?...)</option>
                  <option value="MOBILE">MOBILE</option>
                  <option value="BANK_IFSC">BANK_IFSC</option>
                </select>
              </label>
              <label>Target<input id="payTarget" value="shop@psp2" /></label>
              <label>IFSC<input id="payIfsc" placeholder="SBIN0001234" /></label>
            </div>
            <div class="row">
              <label>Amount (paise)<input id="pAmt" type="number" value="25000" /></label>
              <label>UPI PIN<input id="pPin" type="password" placeholder="Enter UPI PIN" /></label>
            </div>
            <div class="row">
              <button onclick="doSignedPay(this)">Sign &amp; Pay</button>
              <button class="secondary" onclick="syncPending(this)">Sync Pending Txns</button>
            </div>
          </div>
        </div>
      </section>

      <section id="view-collects" class="view-pane hidden">
        <div class="card">
          <h3>Collect Requests &amp; Anti-Spam Block</h3>
          <p class="hint">Create, approve, decline, or block abusive collect requesters using your bound Ed25519 device.</p>
          <div class="row">
            <label>Payer VPA<input id="colPayer" value="anita@psp1" /></label>
            <label>Amount (paise)<input id="colAmt" type="number" value="15000" /></label>
            <button onclick="createCollect(this)">Request Collect</button>
          </div>
          <div class="row">
            <label>Collect ID<input id="colId" placeholder="col_..." /></label>
            <button onclick="approveCollect(this)">Approve</button>
            <button class="danger" onclick="declineCollect(this)">Decline</button>
            <button class="secondary" onclick="blockRequester(this)">Block Requester</button>
          </div>
        </div>
      </section>

      <section id="view-risk" class="view-pane hidden">
        <div class="kpi-grid">
          <div class="kpi-card"><div class="kpi-label">Shadow Batch Evaluated</div><div class="kpi-value" id="kpiShdTotal">—</div><div class="kpi-sub">v1.0 vs v2.0-strict</div></div>
          <div class="kpi-card"><div class="kpi-label">Agreement Rate</div><div class="kpi-value" id="kpiShdAgree">—</div><div class="kpi-sub">Live vs Shadow Ruleset</div></div>
          <div class="kpi-card"><div class="kpi-label">Last Risk Decision</div><div class="kpi-value" id="kpiRiskDec">—</div><div class="kpi-sub">&lt;100ms SLA Engine</div></div>
        </div>
        <div class="card">
          <h3>Real-Time Risk Scoring, Shadow Mode &amp; Airplane Chaos <span class="badge warn">Admin</span></h3>
          <p class="hint">Sign in as <code>risk.admin</code> to score payments, run 100-payment Shadow Diffs, promote rulesets, or toggle chaos.</p>
          <div class="row">
            <label>Payee VPA<input id="rPayee" value="unknown@psp2" /></label>
            <label>Amount (paise)<input id="rAmt" type="number" value="600000" /></label>
            <button onclick="scoreRisk(this)">Score Payment</button>
            <button onclick="runShadow100(this)">Run 100-Txn Shadow Diff</button>
            <button class="secondary" onclick="promoteShadow(this)">Promote v2.0-strict</button>
          </div>
          <div class="row">
            <button class="danger" onclick="toggleRiskFallback(this, true)">Timeout Fallback ON</button>
            <button class="secondary" onclick="toggleRiskFallback(this, false)">Timeout Fallback OFF</button>
            <button class="secondary" onclick="toggleAirplane(this, true)">Airplane Mode ON</button>
            <button class="secondary" onclick="toggleAirplane(this, false)">Airplane Mode OFF</button>
          </div>
        </div>
      </section>

      <section id="view-disputes" class="view-pane hidden">
        <div class="card">
          <h3>Dispute Desk &amp; NPCI Case File <span class="badge warn">Admin</span></h3>
          <p class="hint">Open a customer dispute, auto-resolve on Switch 0420 reversal, or escalate to export an NPCI case file.</p>
          <div class="row">
            <label>Switch RRN<input id="dRrn" value="632810000999" /></label>
            <label>Amount (paise)<input id="dAmt" type="number" value="50000" /></label>
            <button onclick="openDispute(this)">Open Dispute</button>
            <button class="secondary" onclick="fireReversal(this)">Simulate Switch Reversal</button>
          </div>
          <div class="row">
            <label>Dispute ID<input id="dId" placeholder="dsp_..." /></label>
            <button class="danger" onclick="escalateDispute(this)">Escalate</button>
            <button class="secondary" onclick="downloadCaseFile(this)">Download NPCI Case File</button>
          </div>
        </div>
      </section>`,
    scriptJs: `
      const deviceState = { customerId: null, onboardingToken: null, deviceId: null, privateKey: null, vpa: null };
      function bufToB64(buf) { let s = ""; new Uint8Array(buf).forEach(b => s += String.fromCharCode(b)); return btoa(s); }
      async function sha256Hex(str) {
        const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
        return Array.from(new Uint8Array(d)).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      function spkiToPem(buf) { return "-----BEGIN PUBLIC KEY-----\\n" + bufToB64(buf).match(/.{1,64}/g).join("\\n") + "\\n-----END PUBLIC KEY-----"; }
      async function signedDeviceFetch(method, path, bodyObj) {
        if (!deviceState.privateKey || !deviceState.deviceId) return { status: 401, body: { error: "Bind an Ed25519 device first" } };
        const rawBody = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
        const ts = Date.now();
        const nonce = "nonce_" + ts + "_" + Math.random().toString(36).slice(2, 8);
        const sigBuf = await crypto.subtle.sign("Ed25519", deviceState.privateKey, new TextEncoder().encode(deviceState.deviceId + "|" + ts + "|" + nonce + "|" + rawBody));
        const headers = { "x-device-id": deviceState.deviceId, "x-device-timestamp": String(ts), "x-device-nonce": nonce, "x-device-signature": bufToB64(sigBuf) };
        if (bodyObj !== undefined) headers["content-type"] = "application/json";
        const r = await fetch(path, { method, headers, body: bodyObj === undefined ? undefined : rawBody });
        return { status: r.status, body: await r.json() };
      }
      async function doSignup(btn) {
        return runAction(btn, null, "Sending SMS OTP", async () => {
          const r = await fetch("/api/signup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mobileNumber: document.getElementById("cMob").value, fullName: document.getElementById("cName").value }) });
          const data = await r.json();
          if (data.customer?.id) deviceState.customerId = data.customer.id;
          return { status: r.status, body: data, toastLabel: "Signup" };
        });
      }
      async function doVerifyAndBind(btn) {
        const otp = document.getElementById("cOtp").value.trim();
        const rawPin = document.getElementById("cPin").value.trim();
        if (!otp || !rawPin) { toast("Enter SMS OTP and UPI PIN", "err"); return; }
        const res = await runAction(btn, null, "Binding Ed25519", async () => {
          const vr = await fetch("/api/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mobileNumber: document.getElementById("cMob").value, otp }) });
          const vData = await vr.json();
          if (!vr.ok) return { status: vr.status, body: vData, toastLabel: "OTP Verify" };
          deviceState.customerId = vData.customer.id;
          deviceState.onboardingToken = vData.onboardingToken;
          const obH = { "content-type": "application/json", "x-onboarding-token": deviceState.onboardingToken };
          const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
          const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
          deviceState.privateKey = kp.privateKey;
          deviceState.deviceId = "web_dev_" + Date.now();
          const br = await fetch("/api/devices/bind", { method: "POST", headers: obH, body: JSON.stringify({ customerId: deviceState.customerId, deviceId: deviceState.deviceId, publicKeyPem: spkiToPem(spki) }) });
          if (!br.ok) return { status: br.status, body: await br.json(), toastLabel: "Device Bind" };
          const pr = await fetch("/api/pin/set", { method: "POST", headers: obH, body: JSON.stringify({ customerId: deviceState.customerId, rawPin }) });
          if (!pr.ok) return { status: pr.status, body: await pr.json(), toastLabel: "Set PIN" };
          const lr = await fetch("/api/accounts/link", { method: "POST", headers: obH, body: JSON.stringify({ customerId: deviceState.customerId, bankId: "BANKA", accountNumber: "987654324521" }) });
          const lData = await lr.json();
          if (!lr.ok) return { status: lr.status, body: lData, toastLabel: "Link Account" };
          const vpaRes = await fetch("/api/vpas", { method: "POST", headers: obH, body: JSON.stringify({ customerId: deviceState.customerId, linkedAccountId: lData.id, handle: "web." + Date.now().toString().slice(-5) }) });
          const vpaData = await vpaRes.json();
          if (!vpaRes.ok) return { status: vpaRes.status, body: vpaData, toastLabel: "Create VPA" };
          deviceState.vpa = vpaData.vpa;
          return { status: 200, body: { deviceId: deviceState.deviceId, vpa: vpaData.vpa }, toastLabel: "Device Bound" };
        });
        if (res && res.status === 200) {
          document.getElementById("deviceBadge").innerHTML = '<span class="badge ok">Bound: ' + esc(deviceState.vpa) + ' (' + esc(deviceState.deviceId) + ')</span>';
        }
      }
      async function doSignedPay(btn) {
        const rawPin = document.getElementById("pPin").value.trim();
        if (!rawPin) { toast("Enter UPI PIN", "err"); return; }
        return runAction(btn, null, "Signing & paying", async () => {
          const ch = await signedDeviceFetch("POST", "/api/pin/challenge", { customerId: deviceState.customerId });
          if (ch.status !== 200) return { ...ch, toastLabel: "PIN Challenge" };
          const clientPinProofHex = await sha256Hex(ch.body.txnNonce + ":" + (await sha256Hex(ch.body.pinSalt + ":" + rawPin)));
          const clientTxnId = "WEB-" + Date.now();
          const pending = JSON.parse(localStorage.getItem("fintech_p3_pending_txns") || "[]");
          pending.unshift(clientTxnId);
          localStorage.setItem("fintech_p3_pending_txns", JSON.stringify(pending.slice(0, 10)));
          const payPath = document.getElementById("payPath").value;
          const target = document.getElementById("payTarget").value.trim();
          const p = { customerId: deviceState.customerId, clientTxnId, payPath, payerVpa: deviceState.vpa, amountPaise: Number(document.getElementById("pAmt").value), rawPin, txnNonce: ch.body.txnNonce, clientPinProofHex };
          if (payPath === "VPA") p.payeeVpa = target;
          else if (payPath === "QR") p.qrUri = target;
          else if (payPath === "MOBILE") p.payeeMobile = target;
          else if (payPath === "BANK_IFSC") { p.payeeAccountNumber = target; p.payeeIfsc = document.getElementById("payIfsc").value.trim(); }
          return { ...(await signedDeviceFetch("POST", "/api/pay", p)), toastLabel: "Signed Pay" };
        });
      }
      async function syncPending(btn) {
        return runAction(btn, null, "Syncing pending", async () => {
          const pending = JSON.parse(localStorage.getItem("fintech_p3_pending_txns") || "[]");
          if (!pending.length) return { status: 200, body: { message: "No pending transactions" }, toastLabel: "Sync" };
          const out = [];
          for (const id of pending.slice(0, 3)) out.push(await signedDeviceFetch("GET", "/api/transactions/" + encodeURIComponent(id)));
          return { status: 200, body: out, toastLabel: "Sync Pending" };
        });
      }
      async function createCollect(btn) {
        return runAction(btn, null, "Requesting collect", async () => {
          const res = await signedDeviceFetch("POST", "/api/collects", { requesterVpa: deviceState.vpa || "shop@psp2", payerVpa: document.getElementById("colPayer").value.trim(), amountPaise: Number(document.getElementById("colAmt").value) });
          if (res.body?.collect?.id) document.getElementById("colId").value = res.body.collect.id;
          return { ...res, toastLabel: "Collect Request" };
        });
      }
      async function approveCollect(btn) {
        const id = document.getElementById("colId").value.trim();
        if (!id) { toast("Enter Collect ID", "err"); return; }
        return runAction(btn, null, "Approving", async () => ({ ...(await signedDeviceFetch("POST", "/api/collects/" + encodeURIComponent(id) + "/approve", { rawPin: document.getElementById("pPin").value.trim() })), toastLabel: "Approve Collect" }));
      }
      async function declineCollect(btn) {
        const id = document.getElementById("colId").value.trim();
        if (!id) { toast("Enter Collect ID", "err"); return; }
        return runAction(btn, null, "Declining", async () => ({ ...(await signedDeviceFetch("POST", "/api/collects/" + encodeURIComponent(id) + "/decline", {})), toastLabel: "Decline Collect" }));
      }
      async function blockRequester(btn) {
        return runAction(btn, null, "Blocking", async () => ({ ...(await signedDeviceFetch("POST", "/api/collects/block", { payerVpa: deviceState.vpa || "anita@psp1", requesterVpa: document.getElementById("colPayer").value.trim() })), toastLabel: "Block Requester" }));
      }
      async function toggleAirplane(btn, enabled) {
        return runAction(btn, null, "Updating airplane", async () => {
          const r = await fetch("/api/chaos/airplane-mode", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
          return { status: r.status, body: await r.json(), toastLabel: "Airplane Mode" };
        });
      }
      async function scoreRisk(btn) {
        const res = await runAction(btn, null, "Scoring risk", async () => {
          const r = await fetch("/api/risk/score", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ payeeVpa: document.getElementById("rPayee").value, amountPaise: Number(document.getElementById("rAmt").value), isNewCounterparty: true }) });
          return { status: r.status, body: await r.json(), toastLabel: "Risk Score" };
        });
        if (res && res.status === 200 && res.body?.decision) {
          const cls = res.body.decision === "ALLOW" ? "ok" : res.body.decision === "STEP_UP" ? "warn" : "err";
          document.getElementById("kpiRiskDec").innerHTML = '<span class="badge ' + cls + '">' + esc(res.body.decision) + ' (' + esc(res.body.total_score) + ')</span>';
        }
      }
      async function toggleRiskFallback(btn, enabled) {
        return runAction(btn, null, "Updating fallback", async () => {
          const r = await fetch("/api/risk/timeout-fallback", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
          return { status: r.status, body: await r.json(), toastLabel: "Risk Fallback" };
        });
      }
      async function runShadow100(btn) {
        const res = await runAction(btn, null, "Running 100-txn diff", async () => {
          const r = await fetch("/api/risk/shadow/run-100", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Shadow Diff" };
        });
        if (res && res.status === 200) {
          document.getElementById("kpiShdTotal").textContent = String(res.body.totalPaymentsEvaluated ?? 0);
          document.getElementById("kpiShdAgree").textContent = (res.body.agreementRatePercent ?? 0) + "%";
        }
      }
      async function promoteShadow(btn) {
        return runAction(btn, null, "Promoting ruleset", async () => {
          const r = await fetch("/api/risk/shadow/promote", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Promote Ruleset" };
        });
      }
      async function openDispute(btn) {
        return runAction(btn, null, "Opening dispute", async () => {
          const r = await fetch("/api/disputes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value, amountPaise: Number(document.getElementById("dAmt").value) }) });
          const data = await r.json();
          if (data?.id) document.getElementById("dId").value = data.id;
          return { status: r.status, body: data, toastLabel: "Open Dispute" };
        });
      }
      async function fireReversal(btn) {
        return runAction(btn, null, "Firing reversal", async () => {
          const r = await fetch("/api/disputes/switch-reversal", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value }) });
          return { status: r.status, body: await r.json(), toastLabel: "Switch Reversal" };
        });
      }
      async function escalateDispute(btn) {
        const id = document.getElementById("dId").value.trim();
        if (!id) { toast("Enter Dispute ID", "err"); return; }
        return runAction(btn, null, "Escalating", async () => {
          const r = await fetch("/api/disputes/" + encodeURIComponent(id) + "/escalate", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ reason: "Escalated via Risk Console" }) });
          return { status: r.status, body: await r.json(), toastLabel: "Escalate Dispute" };
        });
      }
      async function downloadCaseFile(btn) {
        const id = document.getElementById("dId").value.trim();
        if (!id) { toast("Enter Dispute ID", "err"); return; }
        return runAction(btn, null, "Fetching case file", async () => {
          const r = await fetch("/api/disputes/" + encodeURIComponent(id) + "/case-file");
          return { status: r.status, body: await r.json(), toastLabel: "NPCI Case File" };
        });
      }
    `,
  });
}
