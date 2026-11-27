import { renderFintechShellHtml } from "@fintech/core";

/**
 * Project 3 — Consumer UPI App, Real-Time Risk Engine & Dispute Desk HTML/JS UI.
 */
export function renderConsumerUiHtml(): string {
  return renderFintechShellHtml({
    title: "Project 3 — Consumer UPI App & Risk Engine",
    subtitle: "Browser Ed25519 Device Signing • Salted Nonce PIN Proof • Shadow Diff & Disputes",
    activePort: 3003,
    bodyHtml: `
      <div class="auth-bar">
        <label>Ops Token (Risk / Disputes / Chaos — stdout)<input id="opsToken" type="password" placeholder="Paste X-Ops-Token" /></label>
        <button onclick="runShadow100(this)">Run 100-Payment Shadow Diff</button>
        <button class="secondary" onclick="promoteShadow(this)">Promote v2.0-strict</button>
        <button class="secondary" onclick="toggleAirplane(this, true)">Airplane ON</button>
        <button class="secondary" onclick="toggleAirplane(this, false)">Airplane OFF</button>
      </div>
      <div class="grid">
        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">1</span> Onboarding &amp; Ed25519 Device Binding</h2>
            <p class="hint">Generates an Ed25519 keypair in browser SubtleCrypto; private key stays local.</p>
          </div>
          <div class="row">
            <label>Mobile<input id="cMob" value="9876543210" /></label>
            <label>Full Name<input id="cName" value="Anita Sharma" /></label>
            <button onclick="doSignup(this)">1. Signup</button>
          </div>
          <div class="row">
            <label>SMS OTP<input id="cOtp" type="password" placeholder="Enter SMS OTP" /></label>
            <label>Set UPI PIN<input id="cPin" type="password" placeholder="4-6 digit PIN" /></label>
            <button onclick="doVerifyAndBind(this)">2. Verify &amp; Bind</button>
          </div>
          <div class="out-wrap">
            <div id="onboardOutMeta" class="out-meta"></div>
            <pre id="onboardOut" class="out">Click Signup, read SMS OTP in stdout, then Verify &amp; Bind.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">2</span> Ed25519 Signed Pay (4 Paths)</h2>
            <p class="hint">Signs payload with Ed25519 and computes client-side salted nonce PIN proof.</p>
          </div>
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
            <label>IFSC (BANK_IFSC)<input id="payIfsc" placeholder="SBIN0001234" /></label>
          </div>
          <div class="row">
            <label>Amount (paise)<input id="pAmt" type="number" value="25000" /></label>
            <label>UPI PIN<input id="pPin" type="password" placeholder="Enter UPI PIN" /></label>
            <button onclick="doSignedPay(this)">Sign &amp; Pay</button>
            <button class="secondary" onclick="syncPending(this)">Sync Pending</button>
          </div>
          <div class="out-wrap">
            <div id="payOutMeta" class="out-meta"></div>
            <pre id="payOut" class="out">Bind Ed25519 device first, then send a signed payment.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">3</span> Collect Requests &amp; Anti-Spam</h2>
            <p class="hint">Create, approve, decline, or block abusive collect requesters.</p>
          </div>
          <div class="row">
            <label>Payer VPA<input id="colPayer" value="anita@psp1" /></label>
            <label>Amount (paise)<input id="colAmt" type="number" value="15000" /></label>
            <button onclick="createCollect(this)">Request Collect</button>
          </div>
          <div class="row">
            <label>Collect ID<input id="colId" placeholder="col_..." /></label>
            <button onclick="approveCollect(this)">Approve</button>
            <button class="danger" onclick="declineCollect(this)">Decline</button>
            <button class="secondary" onclick="blockRequester(this)">Block</button>
          </div>
          <div class="out-wrap">
            <div id="colOutMeta" class="out-meta"></div>
            <pre id="colOut" class="out">Signed collect request lifecycle.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">4</span> Real-Time Risk Engine &amp; Shadow Diff</h2>
            <p class="hint">Sub-100ms scoring, timeout fallback split, and v1.0 vs v2.0-strict shadow diff.</p>
          </div>
          <div class="row">
            <label>Payee VPA<input id="rPayee" value="unknown@psp2" /></label>
            <label>Amount (paise)<input id="rAmt" type="number" value="600000" /></label>
            <button onclick="scoreRisk(this)">Score Payment</button>
          </div>
          <div class="row">
            <button class="danger" onclick="toggleRiskFallback(this, true)">Timeout Fallback ON</button>
            <button class="secondary" onclick="toggleRiskFallback(this, false)">Timeout Fallback OFF</button>
          </div>
          <div class="out-wrap">
            <div id="riskOutMeta" class="out-meta"></div>
            <pre id="riskOut" class="out">Requires X-Ops-Token above.</pre>
          </div>
        </div>

        <div class="card">
          <div class="card-head">
            <h2><span class="step-pill">5</span> Dispute Desk &amp; NPCI Case File</h2>
            <p class="hint">Auto-resolve via Switch reversal or escalate to download an NPCI case file.</p>
          </div>
          <div class="row">
            <label>Switch RRN<input id="dRrn" value="632810000999" /></label>
            <label>Amount (paise)<input id="dAmt" type="number" value="50000" /></label>
            <button onclick="openDispute(this)">Open Dispute</button>
            <button class="secondary" onclick="fireReversal(this)">Switch Reversal</button>
          </div>
          <div class="row">
            <label>Dispute ID<input id="dId" placeholder="dsp_..." /></label>
            <button class="danger" onclick="escalateDispute(this)">Escalate</button>
            <button class="secondary" onclick="downloadCaseFile(this)">NPCI Case File</button>
          </div>
          <div class="out-wrap">
            <div id="dispOutMeta" class="out-meta"></div>
            <pre id="dispOut" class="out">Dispute status &amp; SLA case file output.</pre>
          </div>
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
          return { status: 401, body: { error: "Bind an Ed25519 device in Step 1 first" } };
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
      async function doSignup(btn) {
        return runAction(btn, "onboardOut", "Sending SMS OTP", async () => {
          const r = await fetch("/api/signup", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ mobileNumber: document.getElementById("cMob").value, fullName: document.getElementById("cName").value })
          });
          const data = await r.json();
          if (data.customer?.id) deviceState.customerId = data.customer.id;
          return { status: r.status, body: data, toastLabel: "Signup" };
        });
      }
      async function doVerifyAndBind(btn) {
        const otp = document.getElementById("cOtp").value.trim();
        const rawPin = document.getElementById("cPin").value.trim();
        if (!otp || !rawPin) {
          toast("Enter SMS OTP and UPI PIN", "err");
          return show("onboardOut", { error: "Please enter SMS OTP and 4-6 digit UPI PIN" }, { status: 400 });
        }
        return runAction(btn, "onboardOut", "Binding Ed25519", async () => {
          const vr = await fetch("/api/otp/verify", {
            method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ mobileNumber: document.getElementById("cMob").value, otp })
          });
          const vData = await vr.json();
          if (!vr.ok) return { status: vr.status, body: vData, toastLabel: "OTP Verify" };
          deviceState.customerId = vData.customer.id;
          deviceState.onboardingToken = vData.onboardingToken;
          const obHeaders = { "content-type": "application/json", "x-onboarding-token": deviceState.onboardingToken };

          const kp = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
          const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
          deviceState.privateKey = kp.privateKey;
          deviceState.deviceId = "web_dev_" + Date.now();

          const br = await fetch("/api/devices/bind", { method: "POST", headers: obHeaders, body: JSON.stringify({ customerId: deviceState.customerId, deviceId: deviceState.deviceId, publicKeyPem: spkiToPem(spki) }) });
          const bData = await br.json();
          if (!br.ok) return { status: br.status, body: bData, toastLabel: "Device Bind" };

          const pinRes = await fetch("/api/pin/set", { method: "POST", headers: obHeaders, body: JSON.stringify({ customerId: deviceState.customerId, rawPin }) });
          const pinData = await pinRes.json();
          if (!pinRes.ok) return { status: pinRes.status, body: pinData, toastLabel: "Set PIN" };

          const lr = await fetch("/api/accounts/link", { method: "POST", headers: obHeaders, body: JSON.stringify({ customerId: deviceState.customerId, bankId: "BANKA", accountNumber: "987654324521" }) });
          const lData = await lr.json();
          if (!lr.ok) return { status: lr.status, body: lData, toastLabel: "Link Account" };

          const handle = "web." + Date.now().toString().slice(-5);
          const vpaRes = await fetch("/api/vpas", { method: "POST", headers: obHeaders, body: JSON.stringify({ customerId: deviceState.customerId, linkedAccountId: lData.id, handle }) });
          const vpaData = await vpaRes.json();
          if (!vpaRes.ok) return { status: vpaRes.status, body: vpaData, toastLabel: "Create VPA" };
          deviceState.vpa = vpaData.vpa;
          return { status: 200, display: { bound: bData, linked: lData, vpa: vpaData }, toastLabel: "Device Bound" };
        });
      }
      async function doSignedPay(btn) {
        const rawPin = document.getElementById("pPin").value.trim();
        if (!rawPin) {
          toast("Enter UPI PIN", "err");
          return show("payOut", { error: "Please enter UPI PIN" }, { status: 400 });
        }
        return runAction(btn, "payOut", "Signing & paying", async () => {
          const ch = await signedDeviceFetch("POST", "/api/pin/challenge", { customerId: deviceState.customerId });
          if (ch.status !== 200) return { ...ch, toastLabel: "PIN Challenge" };
          const pinHash = await sha256Hex(ch.body.pinSalt + ":" + rawPin);
          const clientPinProofHex = await sha256Hex(ch.body.txnNonce + ":" + pinHash);

          const clientTxnId = "WEB-" + Date.now();
          const pending = JSON.parse(localStorage.getItem("fintech_p3_pending_txns") || "[]");
          pending.unshift(clientTxnId);
          localStorage.setItem("fintech_p3_pending_txns", JSON.stringify(pending.slice(0, 10)));

          const payPath = document.getElementById("payPath").value;
          const target = document.getElementById("payTarget").value.trim();
          const payloadObj = {
            customerId: deviceState.customerId, clientTxnId, payPath, payerVpa: deviceState.vpa,
            amountPaise: Number(document.getElementById("pAmt").value), rawPin, txnNonce: ch.body.txnNonce, clientPinProofHex
          };
          if (payPath === "VPA") payloadObj.payeeVpa = target;
          else if (payPath === "QR") payloadObj.qrUri = target;
          else if (payPath === "MOBILE") payloadObj.payeeMobile = target;
          else if (payPath === "BANK_IFSC") { payloadObj.payeeAccountNumber = target; payloadObj.payeeIfsc = document.getElementById("payIfsc").value.trim(); }
          return { ...(await signedDeviceFetch("POST", "/api/pay", payloadObj)), toastLabel: "Signed Pay" };
        });
      }
      async function syncPending(btn) {
        return runAction(btn, "payOut", "Syncing pending", async () => {
          const pending = JSON.parse(localStorage.getItem("fintech_p3_pending_txns") || "[]");
          if (!pending.length) return { status: 200, display: "No pending transactions in localStorage.", toastLabel: "Sync" };
          const results = [];
          for (const id of pending.slice(0, 3)) results.push(await signedDeviceFetch("GET", "/api/transactions/" + encodeURIComponent(id)));
          return { status: 200, display: results, toastLabel: "Sync Pending" };
        });
      }
      async function createCollect(btn) {
        return runAction(btn, "colOut", "Requesting collect", async () => {
          const res = await signedDeviceFetch("POST", "/api/collects", {
            requesterVpa: deviceState.vpa || "shop@psp2",
            payerVpa: document.getElementById("colPayer").value.trim(),
            amountPaise: Number(document.getElementById("colAmt").value),
            note: "Web UI collect request"
          });
          if (res.body?.collect?.id) document.getElementById("colId").value = res.body.collect.id;
          return { ...res, toastLabel: "Collect Request" };
        });
      }
      async function approveCollect(btn) {
        const id = document.getElementById("colId").value.trim();
        if (!id) return show("colOut", { error: "Enter Collect ID first" }, { status: 400 });
        return runAction(btn, "colOut", "Approving collect", async () => ({
          ...(await signedDeviceFetch("POST", "/api/collects/" + encodeURIComponent(id) + "/approve", { rawPin: document.getElementById("pPin").value.trim() })),
          toastLabel: "Approve Collect"
        }));
      }
      async function declineCollect(btn) {
        const id = document.getElementById("colId").value.trim();
        if (!id) return show("colOut", { error: "Enter Collect ID first" }, { status: 400 });
        return runAction(btn, "colOut", "Declining collect", async () => ({
          ...(await signedDeviceFetch("POST", "/api/collects/" + encodeURIComponent(id) + "/decline", {})),
          toastLabel: "Decline Collect"
        }));
      }
      async function blockRequester(btn) {
        return runAction(btn, "colOut", "Blocking requester", async () => ({
          ...(await signedDeviceFetch("POST", "/api/collects/block", { payerVpa: deviceState.vpa || "anita@psp1", requesterVpa: document.getElementById("colPayer").value.trim() })),
          toastLabel: "Block Requester"
        }));
      }
      async function toggleAirplane(btn, enabled) {
        return runAction(btn, "payOut", enabled ? "Enabling airplane" : "Disabling airplane", async () => {
          const r = await fetch("/api/chaos/airplane-mode", { method: "PUT", headers: opsHeaders(), body: JSON.stringify({ enabled }) });
          return { status: r.status, body: await r.json(), toastLabel: "Airplane Mode" };
        });
      }
      async function scoreRisk(btn) {
        return runAction(btn, "riskOut", "Scoring risk", async () => {
          const r = await fetch("/api/risk/score", {
            method: "POST", headers: opsHeaders(),
            body: JSON.stringify({ payeeVpa: document.getElementById("rPayee").value, amountPaise: Number(document.getElementById("rAmt").value), isNewCounterparty: true })
          });
          return { status: r.status, body: await r.json(), toastLabel: "Risk Score" };
        });
      }
      async function toggleRiskFallback(btn, enabled) {
        return runAction(btn, "riskOut", "Updating fallback", async () => {
          const r = await fetch("/api/risk/timeout-fallback", { method: "PUT", headers: opsHeaders(), body: JSON.stringify({ enabled }) });
          return { status: r.status, body: await r.json(), toastLabel: "Risk Fallback" };
        });
      }
      async function runShadow100(btn) {
        return runAction(btn, "riskOut", "Running 100-txn diff", async () => {
          const r = await fetch("/api/risk/shadow/run-100", { method: "POST", headers: opsHeaders(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Shadow Diff" };
        });
      }
      async function promoteShadow(btn) {
        return runAction(btn, "riskOut", "Promoting ruleset", async () => {
          const r = await fetch("/api/risk/shadow/promote", { method: "POST", headers: opsHeaders(), body: "{}" });
          return { status: r.status, body: await r.json(), toastLabel: "Promote Ruleset" };
        });
      }
      async function openDispute(btn) {
        return runAction(btn, "dispOut", "Opening dispute", async () => {
          const r = await fetch("/api/disputes", {
            method: "POST", headers: opsHeaders(),
            body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value, amountPaise: Number(document.getElementById("dAmt").value) })
          });
          const data = await r.json();
          if (data?.id) document.getElementById("dId").value = data.id;
          return { status: r.status, body: data, toastLabel: "Open Dispute" };
        });
      }
      async function fireReversal(btn) {
        return runAction(btn, "dispOut", "Firing reversal", async () => {
          const r = await fetch("/api/disputes/switch-reversal", { method: "POST", headers: opsHeaders(), body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value }) });
          return { status: r.status, body: await r.json(), toastLabel: "Switch Reversal" };
        });
      }
      async function escalateDispute(btn) {
        const id = document.getElementById("dId").value.trim();
        if (!id) return show("dispOut", { error: "Enter Dispute ID first" }, { status: 400 });
        return runAction(btn, "dispOut", "Escalating", async () => {
          const r = await fetch("/api/disputes/" + encodeURIComponent(id) + "/escalate", { method: "POST", headers: opsHeaders(), body: JSON.stringify({ reason: "Escalated from Ops Console" }) });
          return { status: r.status, body: await r.json(), toastLabel: "Escalate Dispute" };
        });
      }
      async function downloadCaseFile(btn) {
        const id = document.getElementById("dId").value.trim();
        if (!id) return show("dispOut", { error: "Enter Dispute ID first" }, { status: 400 });
        return runAction(btn, "dispOut", "Fetching case file", async () => {
          const r = await fetch("/api/disputes/" + encodeURIComponent(id) + "/case-file", { headers: opsHeaders() });
          return { status: r.status, body: await r.json(), toastLabel: "NPCI Case File" };
        });
      }
    `,
  });
}
