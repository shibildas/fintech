import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 3 — Consumer UPI App, Real-Time Risk Engine, Shadow Mode & Dispute Desk HTML/JS UI.
 */
export function renderConsumerUiHtml(): string {
  return renderFintechShellHtml({
    title: "Project 3 — Consumer UPI App, Real-Time Risk Engine & Dispute Desk",
    subtitle: "Browser Ed25519 Device Signing • Salted Nonce PIN Proof • 4 Pay Paths • Collects • Shadow Diff • Disputes",
    activePort: 3003,
    bodyHtml: `
      <div class="auth-bar">
        <label>Ops Token (X-Ops-Token for Risk/Disputes/Chaos — see server stdout)<input id="opsToken" type="password" placeholder="Paste X-Ops-Token" /></label>
        <button onclick="runShadow100()">Run 100-Payment Shadow Diff</button>
        <button class="secondary" onclick="promoteShadow()">Promote v2.0-strict</button>
        <button class="secondary" onclick="toggleAirplane(true)">Airplane Mode ON</button>
        <button class="secondary" onclick="toggleAirplane(false)">Airplane Mode OFF</button>
      </div>
      <div class="grid">
        <div class="card">
          <h2>1. Consumer Onboarding + Browser Ed25519 Binding</h2>
          <div class="row">
            <label>Mobile<input id="cMob" value="9876543210" /></label>
            <label>Full Name<input id="cName" value="Anita Sharma" /></label>
            <button onclick="doSignup()">1. Signup (OTP in stdout)</button>
          </div>
          <div class="row">
            <label>SMS OTP<input id="cOtp" type="password" placeholder="Enter SMS OTP" /></label>
            <label>Set UPI PIN<input id="cPin" type="password" placeholder="4-6 digit PIN" /></label>
            <button onclick="doVerifyAndBind()">2. Verify OTP + Bind Ed25519 + Link BANKA</button>
          </div>
          <pre id="onboardOut" class="out">Ed25519 keypair generated in browser SubtleCrypto; private key never leaves browser...</pre>
        </div>
        <div class="card">
          <h2>2. Ed25519 Signed Pay (4 Paths) & Honest Pending</h2>
          <div class="row">
            <label>Pay Path
              <select id="payPath">
                <option value="VPA">VPA</option>
                <option value="QR">QR (upi://pay?...)</option>
                <option value="MOBILE">MOBILE</option>
                <option value="BANK_IFSC">BANK_IFSC</option>
              </select>
            </label>
            <label>Target (VPA / QR URI / Mobile / Acct)<input id="payTarget" value="shop@psp2" /></label>
            <label>IFSC (BANK_IFSC only)<input id="payIfsc" placeholder="SBIN0001234" /></label>
          </div>
          <div class="row">
            <label>Amount (paise)<input id="pAmt" type="number" value="25000" /></label>
            <label>UPI PIN<input id="pPin" type="password" placeholder="Enter UPI PIN" /></label>
            <button onclick="doSignedPay()">Sign & Pay (Ed25519)</button>
            <button class="secondary" onclick="syncPending()">Sync Pending Txns</button>
          </div>
          <pre id="payOut" class="out">Bind Ed25519 device first, then send signed payment...</pre>
        </div>
        <div class="card">
          <h2>3. Collect Requests & Anti-Spam Block</h2>
          <div class="row">
            <label>Payer VPA<input id="colPayer" value="anita@psp1" /></label>
            <label>Amount (paise)<input id="colAmt" type="number" value="15000" /></label>
            <button onclick="createCollect()">Request Collect</button>
          </div>
          <div class="row">
            <label>Collect ID<input id="colId" placeholder="col_..." /></label>
            <button onclick="approveCollect()">Approve</button>
            <button class="danger" onclick="declineCollect()">Decline</button>
            <button class="secondary" onclick="blockRequester()">Block Requester</button>
          </div>
          <pre id="colOut" class="out">Signed collect request lifecycle...</pre>
        </div>
        <div class="card">
          <h2>4. Real-Time Risk Engine (&lt;100ms) & Shadow Mode</h2>
          <div class="row">
            <label>Payee VPA<input id="rPayee" value="unknown@psp2" /></label>
            <label>Amount (paise)<input id="rAmt" type="number" value="600000" /></label>
            <button onclick="scoreRisk()">Score Payment</button>
          </div>
          <div class="row">
            <button class="danger" onclick="toggleRiskFallback(true)">Timeout Fallback ON</button>
            <button class="secondary" onclick="toggleRiskFallback(false)">Timeout Fallback OFF</button>
          </div>
          <pre id="riskOut" class="out">Requires X-Ops-Token. Risk score, fallback split & shadow diff...</pre>
        </div>
        <div class="card">
          <h2>5. Dispute Desk & NPCI Case File</h2>
          <div class="row">
            <label>Switch RRN<input id="dRrn" value="632810000999" /></label>
            <label>Amount (paise)<input id="dAmt" type="number" value="50000" /></label>
            <button onclick="openDispute()">Open Dispute</button>
            <button class="secondary" onclick="fireReversal()">Simulate Switch Reversal</button>
          </div>
          <div class="row">
            <label>Dispute ID<input id="dId" placeholder="dsp_..." /></label>
            <button class="danger" onclick="escalateDispute()">Escalate</button>
            <button class="secondary" onclick="downloadCaseFile()">NPCI Case File</button>
          </div>
          <pre id="dispOut" class="out">Open dispute -> auto-resolve on reversal or escalate for NPCI case file...</pre>
        </div>
      </div>`,
    scriptJs: `
      const deviceState = { customerId: null, onboardingToken: null, deviceId: null, privateKey: null, vpa: null };
      function opsHeaders() {
        return { "content-type": "application/json", "x-ops-token": document.getElementById("opsToken").value.trim() };
      }
      function bufToB64(buf) {
        let s = "";
        new Uint8Array(buf).forEach(b => s += String.fromCharCode(b));
        return btoa(s);
      }
      async function sha256Hex(str) {
        const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
        return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, "0")).join("");
      }
      function spkiToPem(buf) {
        const b64 = bufToB64(buf).match(/.{1,64}/g).join("\\n");
        return "-----BEGIN PUBLIC KEY-----\\n" + b64 + "\\n-----END PUBLIC KEY-----";
      }
      async function signedDeviceFetch(method, path, bodyObj) {
        if (!deviceState.privateKey || !deviceState.deviceId) {
          return { status: 0, body: { error: "Bind an Ed25519 device in Card 1 first!" } };
        }
        const rawBody = bodyObj === undefined ? "" : JSON.stringify(bodyObj);
        const ts = Date.now();
        const nonce = "nonce_" + ts + "_" + Math.random().toString(36).slice(2, 8);
        const signingInput = deviceState.deviceId + "|" + ts + "|" + nonce + "|" + rawBody;
        const sigBuf = await crypto.subtle.sign("Ed25519", deviceState.privateKey, new TextEncoder().encode(signingInput));
        const headers = {
          "x-device-id": deviceState.deviceId,
          "x-device-timestamp": String(ts),
          "x-device-nonce": nonce,
          "x-device-signature": bufToB64(sigBuf)
        };
        if (bodyObj !== undefined) headers["content-type"] = "application/json";
        const r = await fetch(path, { method, headers, body: bodyObj === undefined ? undefined : rawBody });
        return { status: r.status, body: await r.json() };
      }
      async function doSignup() {
        const r = await fetch("/api/signup", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mobileNumber: document.getElementById("cMob").value, fullName: document.getElementById("cName").value })
        });
        const data = await r.json();
        if (data.customer?.id) deviceState.customerId = data.customer.id;
        show("onboardOut", { status: r.status, body: data });
      }
      async function doVerifyAndBind() {
        const otp = document.getElementById("cOtp").value.trim();
        const rawPin = document.getElementById("cPin").value.trim();
        if (!otp) return show("onboardOut", { error: "Please enter SMS OTP (see server stdout)" });
        if (!rawPin) return show("onboardOut", { error: "Please enter a 4-6 digit UPI PIN" });

        const vr = await fetch("/api/otp/verify", {
          method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ mobileNumber: document.getElementById("cMob").value, otp })
        });
        const vData = await vr.json();
        if (!vr.ok) return show("onboardOut", { step: "otp_verify", status: vr.status, body: vData });
        deviceState.customerId = vData.customer.id;
        deviceState.onboardingToken = vData.onboardingToken;
        const obHeaders = { "content-type": "application/json", "x-onboarding-token": deviceState.onboardingToken };

        const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
        const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
        deviceState.privateKey = kp.privateKey;
        deviceState.deviceId = "web_dev_" + Date.now();

        const br = await fetch("/api/devices/bind", {
          method: "POST", headers: obHeaders,
          body: JSON.stringify({ customerId: deviceState.customerId, deviceId: deviceState.deviceId, publicKeyPem: spkiToPem(spki) })
        });
        const bData = await br.json();
        if (!br.ok) return show("onboardOut", { step: "device_bind", status: br.status, body: bData });

        const pinRes = await fetch("/api/pin/set", {
          method: "POST", headers: obHeaders,
          body: JSON.stringify({ customerId: deviceState.customerId, rawPin })
        });
        const pinData = await pinRes.json();
        if (!pinRes.ok) return show("onboardOut", { step: "pin_set", status: pinRes.status, body: pinData });

        const lr = await fetch("/api/accounts/link", {
          method: "POST", headers: obHeaders,
          body: JSON.stringify({ customerId: deviceState.customerId, bankId: "BANKA", accountNumber: "987654324521" })
        });
        const lData = await lr.json();
        if (!lr.ok) return show("onboardOut", { step: "link_account", status: lr.status, body: lData });

        const handle = "web." + Date.now().toString().slice(-5);
        const vpaRes = await fetch("/api/vpas", {
          method: "POST", headers: obHeaders,
          body: JSON.stringify({ customerId: deviceState.customerId, linkedAccountId: lData.id, handle })
        });
        const vpaData = await vpaRes.json();
        if (!vpaRes.ok) return show("onboardOut", { step: "create_vpa", status: vpaRes.status, body: vpaData });
        deviceState.vpa = vpaData.vpa;
        show("onboardOut", { bound: bData, linked: lData, vpa: vpaData });
      }
      async function doSignedPay() {
        const rawPin = document.getElementById("pPin").value.trim();
        if (!rawPin) return show("payOut", { error: "Please enter UPI PIN" });
        const ch = await signedDeviceFetch("POST", "/api/pin/challenge", { customerId: deviceState.customerId });
        if (ch.status !== 200) return show("payOut", { step: "pin_challenge", ...ch });
        const pinHash = await sha256Hex(ch.body.pinSalt + ":" + rawPin);
        const clientPinProofHex = await sha256Hex(ch.body.txnNonce + ":" + pinHash);

        const clientTxnId = "WEB-" + Date.now();
        const pending = JSON.parse(localStorage.getItem("fintech_p3_pending_txns") || "[]");
        pending.unshift(clientTxnId);
        localStorage.setItem("fintech_p3_pending_txns", JSON.stringify(pending.slice(0, 10)));

        const payPath = document.getElementById("payPath").value;
        const target = document.getElementById("payTarget").value.trim();
        const payloadObj = {
          customerId: deviceState.customerId,
          clientTxnId,
          payPath,
          payerVpa: deviceState.vpa,
          amountPaise: Number(document.getElementById("pAmt").value),
          rawPin,
          txnNonce: ch.body.txnNonce,
          clientPinProofHex
        };
        if (payPath === "VPA") payloadObj.payeeVpa = target;
        else if (payPath === "QR") payloadObj.qrUri = target;
        else if (payPath === "MOBILE") payloadObj.payeeMobile = target;
        else if (payPath === "BANK_IFSC") {
          payloadObj.payeeAccountNumber = target;
          payloadObj.payeeIfsc = document.getElementById("payIfsc").value.trim();
        }
        show("payOut", await signedDeviceFetch("POST", "/api/pay", payloadObj));
      }
      async function syncPending() {
        const pending = JSON.parse(localStorage.getItem("fintech_p3_pending_txns") || "[]");
        if (!pending.length) return show("payOut", "No pending transaction in localStorage.");
        const results = [];
        for (const id of pending.slice(0, 3)) {
          results.push(await signedDeviceFetch("GET", "/api/transactions/" + encodeURIComponent(id)));
        }
        show("payOut", results);
      }
      async function createCollect() {
        const res = await signedDeviceFetch("POST", "/api/collects", {
          requesterVpa: deviceState.vpa || "shop@psp2",
          payerVpa: document.getElementById("colPayer").value.trim(),
          amountPaise: Number(document.getElementById("colAmt").value),
          note: "Web UI collect request"
        });
        if (res.body?.id) document.getElementById("colId").value = res.body.id;
        show("colOut", res);
      }
      async function approveCollect() {
        const id = document.getElementById("colId").value.trim();
        if (!id) return show("colOut", { error: "Enter Collect ID first" });
        const rawPin = document.getElementById("pPin").value.trim();
        show("colOut", await signedDeviceFetch("POST", "/api/collects/" + encodeURIComponent(id) + "/approve", { rawPin }));
      }
      async function declineCollect() {
        const id = document.getElementById("colId").value.trim();
        if (!id) return show("colOut", { error: "Enter Collect ID first" });
        show("colOut", await signedDeviceFetch("POST", "/api/collects/" + encodeURIComponent(id) + "/decline", {}));
      }
      async function blockRequester() {
        show("colOut", await signedDeviceFetch("POST", "/api/collects/block", {
          payerVpa: deviceState.vpa || "anita@psp1",
          requesterVpa: document.getElementById("colPayer").value.trim()
        }));
      }
      async function toggleAirplane(enabled) {
        const r = await fetch("/api/chaos/airplane-mode", { method: "PUT", headers: opsHeaders(), body: JSON.stringify({ enabled }) });
        show("payOut", { status: r.status, body: await r.json() });
      }
      async function scoreRisk() {
        const r = await fetch("/api/risk/score", {
          method: "POST", headers: opsHeaders(),
          body: JSON.stringify({ payeeVpa: document.getElementById("rPayee").value, amountPaise: Number(document.getElementById("rAmt").value), isNewCounterparty: true })
        });
        show("riskOut", { status: r.status, body: await r.json() });
      }
      async function toggleRiskFallback(enabled) {
        const r = await fetch("/api/risk/timeout-fallback", { method: "PUT", headers: opsHeaders(), body: JSON.stringify({ enabled }) });
        show("riskOut", { status: r.status, body: await r.json() });
      }
      async function runShadow100() {
        const r = await fetch("/api/risk/shadow/run-100", { method: "POST", headers: opsHeaders(), body: "{}" });
        show("riskOut", { status: r.status, body: await r.json() });
      }
      async function promoteShadow() {
        const r = await fetch("/api/risk/shadow/promote", { method: "POST", headers: opsHeaders(), body: "{}" });
        show("riskOut", { status: r.status, body: await r.json() });
      }
      async function openDispute() {
        const r = await fetch("/api/disputes", {
          method: "POST", headers: opsHeaders(),
          body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value, amountPaise: Number(document.getElementById("dAmt").value) })
        });
        const data = await r.json();
        if (data?.id) document.getElementById("dId").value = data.id;
        show("dispOut", { status: r.status, body: data });
      }
      async function fireReversal() {
        const r = await fetch("/api/disputes/switch-reversal", {
          method: "POST", headers: opsHeaders(),
          body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value })
        });
        show("dispOut", { status: r.status, body: await r.json() });
      }
      async function escalateDispute() {
        const id = document.getElementById("dId").value.trim();
        if (!id) return show("dispOut", { error: "Enter Dispute ID first" });
        const r = await fetch("/api/disputes/" + encodeURIComponent(id) + "/escalate", {
          method: "POST", headers: opsHeaders(), body: JSON.stringify({ reason: "Escalated from Ops Console" })
        });
        show("dispOut", { status: r.status, body: await r.json() });
      }
      async function downloadCaseFile() {
        const id = document.getElementById("dId").value.trim();
        if (!id) return show("dispOut", { error: "Enter Dispute ID first" });
        const r = await fetch("/api/disputes/" + encodeURIComponent(id) + "/case-file", { headers: opsHeaders() });
        show("dispOut", { status: r.status, body: await r.json() });
      }
    `,
  });
}
