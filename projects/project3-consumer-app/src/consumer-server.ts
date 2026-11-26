import http from "node:http";
import path from "node:path";
import {
  CORS_HEADERS,
  ensureDataDir,
  readRawAndJsonBody,
  writeJsonResponse,
  writeHtmlResponse,
  renderFintechShellHtml,
} from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { ConsumerPspBackend } from "./psp-backend.ts";
import { ConsumerPayEngine, type PayPathType } from "./pay-flows.ts";
import { CollectRequestEngine, PspLimitProfileEngine } from "./collect-and-limits.ts";
import { RealTimeRiskEngine } from "./risk-engine.ts";
import { VersionedShadowRiskEngine } from "./risk-shadow-mode.ts";
import { ConsumerDisputeDesk, type DisputeCategory } from "./dispute-desk.ts";

/**
 * Slices 04 & 05 — Project 3 Live HTTP Server & Interactive Web UI (:3003)
 *
 * - Persistent `.data/p3-consumer.sqlite`, `.data/p3-risk.sqlite`, `.data/p3-disputes.sqlite`
 * - Strict manual Ed25519 device signing (`X-Device-Id`, `X-Device-Timestamp`, `X-Device-Nonce`, `X-Device-Signature`)
 * - Strict manual Ops token (`X-Ops-Token`) on Risk Engine, Shadow Mode & Dispute Desk
 */

export interface ConsumerHttpServerContext {
  psp: ConsumerPspBackend;
  payEngine: ConsumerPayEngine;
  collects: CollectRequestEngine;
  risk: RealTimeRiskEngine;
  shadow: VersionedShadowRiskEngine;
  disputes: ConsumerDisputeDesk;
  opsToken: string;
}

export function createPersistentConsumerContext(options?: {
  dataDir?: string;
  opsToken?: string;
}): ConsumerHttpServerContext {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const dbPath = (file: string) =>
    options?.dataDir ? path.join(options.dataDir, file) : ":memory:";

  const p1 = createSeededTopology();
  const sw = new CentralSwitch({
    dbPath: dbPath("p3-switch.sqlite"),
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const psp = new ConsumerPspBackend(dbPath("p3-consumer.sqlite"));
  psp.registerBank(p1.banks.BANKA);
  psp.registerBank(p1.banks.BANKB);
  psp.registerBank(p1.banks.BANKC);

  const payEngine = new ConsumerPayEngine({
    pspBackend: psp,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    allPsps: [p1.psps.PSP1, p1.psps.PSP2],
  });

  const limits = new PspLimitProfileEngine(psp);
  const collects = new CollectRequestEngine({
    pspBackend: psp,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    limits,
  });

  const risk = new RealTimeRiskEngine(dbPath("p3-risk.sqlite"));
  const shadow = new VersionedShadowRiskEngine(dbPath("p3-shadow.sqlite"));
  shadow.registerRuleset({
    version: "v1.0",
    status: "ACTIVE",
    rules: [
      {
        ruleId: "NEW_CP_5K",
        weight: 50,
        description: "New counterparty >= ₹5,000",
        ast: {
          type: "AND",
          children: [
            { type: "CMP", field: "is_new_counterparty", op: "EQ", value: true },
            { type: "CMP", field: "amount_paise", op: "GTE", value: 500_000 },
          ],
        },
      },
    ],
  });
  shadow.registerRuleset({
    version: "v2.0-strict",
    status: "SHADOW",
    rules: [
      {
        ruleId: "NEW_CP_2K",
        weight: 50,
        description: "New counterparty >= ₹2,000",
        ast: {
          type: "AND",
          children: [
            { type: "CMP", field: "is_new_counterparty", op: "EQ", value: true },
            { type: "CMP", field: "amount_paise", op: "GTE", value: 200_000 },
          ],
        },
      },
    ],
  });

  const disputes = new ConsumerDisputeDesk(dbPath("p3-disputes.sqlite"));

  return {
    psp,
    payEngine,
    collects,
    risk,
    shadow,
    disputes,
    opsToken: options?.opsToken ?? process.env.P3_OPS_TOKEN ?? "p3_dev_ops_token_2026",
  };
}

export class ConsumerHttpServer {
  public readonly ctx: ConsumerHttpServerContext;

  constructor(ctx: ConsumerHttpServerContext) {
    this.ctx = ctx;
  }

  private requireOpsToken(req: http.IncomingMessage): void {
    const token = String(req.headers["x-ops-token"] ?? "").trim();
    if (!token || token !== this.ctx.opsToken) {
      throw Object.assign(new Error("Unauthorized (HTTP 401): Missing or invalid X-Ops-Token"), {
        statusCode: 401,
      });
    }
  }

  public createHttpServer(): http.Server {
    return http.createServer(async (req, res) => {
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;

      if (method === "OPTIONS") {
        res.writeHead(204, CORS_HEADERS);
        res.end();
        return;
      }

      try {
        if (method === "GET" && pathname === "/") {
          writeHtmlResponse(res, 200, this.renderUiHtml());
          return;
        }

        if (method === "GET" && pathname === "/health") {
          writeJsonResponse(res, 200, {
            service: "project3-consumer-app",
            status: "UP",
            banks: this.ctx.psp.listBanks(),
            airplaneMode: this.ctx.payEngine.simulateAirplaneMode,
          });
          return;
        }

        const { rawBody, json } = await readRawAndJsonBody(req);

        // Slice 04: Consumer Onboarding, Ed25519 Device Binding, 4 Pay Paths & Collects
        if (method === "POST" && pathname === "/api/signup") {
          const out = this.ctx.psp.signup({
            mobileNumber: String(json.mobileNumber ?? ""),
            fullName: String(json.fullName ?? "Anita Sharma"),
          });
          console.log(`[p3:consumer] Mock SMS OTP for ${out.customer.mobile_number}: ${out.mockSmsOtp}`);
          writeJsonResponse(res, 201, { customer: out.customer, smsSent: true });
          return;
        }

        if (method === "POST" && pathname === "/api/otp/verify") {
          const c = this.ctx.psp.verifySmsOtp(
            String(json.mobileNumber ?? ""),
            String(json.otp ?? "")
          );
          writeJsonResponse(res, 200, { customer: c });
          return;
        }

        if (method === "POST" && pathname === "/api/devices/bind") {
          const bound = this.ctx.psp.bindDevice({
            customerId: String(json.customerId ?? ""),
            deviceId: String(json.deviceId ?? ""),
            publicKeyPem: String(json.publicKeyPem ?? ""),
            deviceModel: String(json.deviceModel ?? "Browser WebCrypto"),
          });
          writeJsonResponse(res, 200, bound);
          return;
        }

        if (method === "POST" && pathname === "/api/pin/set") {
          this.ctx.psp.setPin(String(json.customerId ?? ""), String(json.rawPin ?? ""));
          writeJsonResponse(res, 200, { status: "PIN_SET" });
          return;
        }

        if (method === "POST" && pathname === "/api/pin/challenge") {
          const customerId = String(json.customerId ?? "");
          const txnNonce = this.ctx.psp.issuePinChallengeNonce();
          const customer = this.ctx.psp.getCustomer(customerId);
          writeJsonResponse(res, 200, {
            txnNonce,
            pinSalt: customer?.pin_salt ?? null,
          });
          return;
        }

        if (method === "POST" && pathname === "/api/accounts/link") {
          const linked = this.ctx.psp.linkBankAccount({
            customerId: String(json.customerId ?? ""),
            bankId: String(json.bankId ?? "BANKA"),
            accountNumber: String(json.accountNumber ?? "987654324521"),
            isPrimary: true,
          });
          writeJsonResponse(res, 201, linked);
          return;
        }

        if (method === "POST" && pathname === "/api/vpas") {
          const vpa = this.ctx.payEngine.createVpa({
            customerId: String(json.customerId ?? ""),
            linkedAccountId: String(json.linkedAccountId ?? ""),
            handle: String(json.handle ?? ""),
            isDefault: true,
          });
          writeJsonResponse(res, 201, vpa);
          return;
        }

        if (method === "POST" && pathname === "/api/pay") {
          const deviceId = String(req.headers["x-device-id"] ?? "").trim();
          const timestampMs = Number(req.headers["x-device-timestamp"] ?? 0);
          const nonce = String(req.headers["x-device-nonce"] ?? "").trim();
          const signatureBase64 = String(req.headers["x-device-signature"] ?? "").trim();

          if (!deviceId || !timestampMs || !nonce || !signatureBase64) {
            writeJsonResponse(res, 401, {
              error: "Unauthorized (HTTP 401): Missing Ed25519 X-Device-* headers",
            });
            return;
          }

          const customerId = String(json.customerId ?? "");
          const rawPin = String(json.rawPin ?? "");
          const txnNonce = String(json.txnNonce ?? this.ctx.psp.issuePinChallengeNonce());
          const clientPinProofHex = json.clientPinProofHex
            ? String(json.clientPinProofHex)
            : this.ctx.psp.computeClientNoncePinProof({ customerId, rawPin, txnNonce });

          const tx = await this.ctx.payEngine.initiatePay({
            customerId,
            deviceId,
            timestampMs,
            nonce,
            payloadJson: rawBody,
            signatureBase64,
            clientTxnId: String(json.clientTxnId ?? `CLNT-${Date.now()}`),
            payPath: (json.payPath as PayPathType) ?? "VPA",
            payerVpa: String(json.payerVpa ?? ""),
            qrUri: json.qrUri ? String(json.qrUri) : undefined,
            payeeVpa: json.payeeVpa ? String(json.payeeVpa) : undefined,
            payeeMobile: json.payeeMobile ? String(json.payeeMobile) : undefined,
            payeeAccountNumber: json.payeeAccountNumber ? String(json.payeeAccountNumber) : undefined,
            payeeIfsc: json.payeeIfsc ? String(json.payeeIfsc) : undefined,
            amountPaise: json.amountPaise !== undefined ? Number(json.amountPaise) : undefined,
            rawPin,
            txnNonce,
            clientPinProofHex,
          });
          writeJsonResponse(res, 200, tx);
          return;
        }

        const txMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
        if (method === "GET" && txMatch) {
          const tx = this.ctx.payEngine.getStatusByClientTxnId(decodeURIComponent(txMatch[1]));
          writeJsonResponse(res, 200, tx);
          return;
        }

        if (method === "PUT" && pathname === "/api/chaos/airplane-mode") {
          this.ctx.payEngine.simulateAirplaneMode = Boolean(json.enabled);
          writeJsonResponse(res, 200, { airplaneMode: this.ctx.payEngine.simulateAirplaneMode });
          return;
        }

        if (method === "POST" && pathname === "/api/collects") {
          const out = this.ctx.collects.createCollectRequest({
            requesterVpa: String(json.requesterVpa ?? ""),
            payerVpa: String(json.payerVpa ?? ""),
            amountPaise: Number(json.amountPaise ?? 10_000),
            note: json.note ? String(json.note) : undefined,
          });
          writeJsonResponse(res, 201, out);
          return;
        }

        if (method === "POST" && pathname === "/api/collects/block") {
          this.ctx.collects.blockRequester(
            String(json.payerVpa ?? ""),
            String(json.requesterVpa ?? "")
          );
          writeJsonResponse(res, 200, { blocked: true });
          return;
        }

        // Slice 05: Ops Risk Engine, Shadow Mode & Dispute Desk (require X-Ops-Token)
        if (pathname.startsWith("/api/risk/") || pathname.startsWith("/api/disputes")) {
          this.requireOpsToken(req);
        }

        if (method === "POST" && pathname === "/api/risk/score") {
          const decision = this.ctx.risk.scorePayment({
            paymentId: String(json.paymentId ?? `rpay_${Date.now()}`),
            customerId: String(json.customerId ?? "cust_demo"),
            deviceId: String(json.deviceId ?? "dev_demo"),
            payeeVpa: String(json.payeeVpa ?? "shop@psp2"),
            amountPaise: Number(json.amountPaise ?? 50_000),
            isNewDevice24h: Boolean(json.isNewDevice24h),
            isNewCounterparty: Boolean(json.isNewCounterparty),
            collectFanOutCount1h: json.collectFanOutCount1h ? Number(json.collectFanOutCount1h) : 0,
          });
          writeJsonResponse(res, 200, decision);
          return;
        }

        if (method === "POST" && pathname === "/api/risk/blacklist") {
          this.ctx.risk.addToBlacklist(String(json.entityId ?? ""));
          writeJsonResponse(res, 200, { blacklisted: String(json.entityId ?? "") });
          return;
        }

        if (method === "PUT" && pathname === "/api/risk/timeout-fallback") {
          this.ctx.risk.simulateTimeoutFallback = Boolean(json.enabled);
          writeJsonResponse(res, 200, { fallbackEnabled: this.ctx.risk.simulateTimeoutFallback });
          return;
        }

        if (method === "POST" && pathname === "/api/risk/shadow/run-100") {
          for (let i = 0; i < 100; i++) {
            const isNewCp = i >= 70;
            const amountPaise = i < 70 ? 50_000 : i < 90 ? 300_000 : 600_000;
            this.ctx.shadow.evaluateLivePayment({
              paymentId: `ui_shd_${Date.now()}_${i}`,
              features: { amount_paise: amountPaise, is_new_counterparty: isNewCp },
            });
          }
          const report = this.ctx.shadow.generateShadowDiffReport("v1.0", "v2.0-strict");
          writeJsonResponse(res, 200, report);
          return;
        }

        if (method === "POST" && pathname === "/api/risk/shadow/promote") {
          const promoted = this.ctx.shadow.promoteShadowToActive("v2.0-strict");
          writeJsonResponse(res, 200, promoted);
          return;
        }

        if (method === "POST" && pathname === "/api/disputes") {
          const d = this.ctx.disputes.openDispute({
            customerId: String(json.customerId ?? "cust_anita"),
            switchRrn: String(json.switchRrn ?? "632810000123"),
            category: (json.category as DisputeCategory) ?? "DEBITED_NOT_CREDITED",
            amountPaise: Number(json.amountPaise ?? 50_000),
            customerNote: String(json.customerNote ?? "Debited but not credited"),
          });
          writeJsonResponse(res, 201, d);
          return;
        }

        if (method === "POST" && pathname === "/api/disputes/switch-reversal") {
          const resolved = this.ctx.disputes.handleSwitchReversalEvent({
            switchRrn: String(json.switchRrn ?? ""),
            reversalReference: String(json.reversalReference ?? `REV-${Date.now()}`),
          });
          writeJsonResponse(res, 200, { resolved });
          return;
        }

        const escMatch = pathname.match(/^\/api\/disputes\/([^/]+)\/escalate$/);
        if (method === "POST" && escMatch) {
          const id = decodeURIComponent(escMatch[1]);
          const curr = this.ctx.disputes.getDispute(id);
          if (curr?.state === "OPEN") {
            this.ctx.disputes.transitionDispute({ disputeId: id, toState: "UNDER_REVIEW" });
          }
          const esc = this.ctx.disputes.transitionDispute({
            disputeId: id,
            toState: "ESCALATED",
            resolutionNote: String(json.reason ?? "Escalated via Ops Console"),
          });
          writeJsonResponse(res, 200, esc);
          return;
        }

        const cfMatch = pathname.match(/^\/api\/disputes\/([^/]+)\/case-file$/);
        if (method === "GET" && cfMatch) {
          const cf = this.ctx.disputes.generateEscalatedCaseFile(decodeURIComponent(cfMatch[1]));
          writeJsonResponse(res, 200, cf);
          return;
        }

        writeJsonResponse(res, 404, { error: "Not Found" });
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
        const message = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, statusCode, { error: message });
      }
    });
  }

  private renderUiHtml(): string {
    return renderFintechShellHtml({
      title: "Project 3 — Consumer UPI App, Real-Time Risk Engine & Dispute Desk",
      subtitle: "Browser Ed25519 Device Binding • 4 Pay Paths & Honest Pending UX • <100ms Risk & Shadow Mode • Disputes",
      activePort: 3003,
      bodyHtml: `
        <div class="auth-bar">
          <label>X-Ops-Token (for Risk & Disputes — see stdout)<input id="p3OpsToken" type="password" placeholder="Paste X-Ops-Token" /></label>
          <button class="secondary" onclick="toggleAirplane(true)">Airplane Mode ON</button>
          <button class="secondary" onclick="toggleAirplane(false)">Airplane Mode OFF</button>
        </div>
        <div class="grid">
          <div class="card">
            <h2>1. Consumer Onboarding & Browser Ed25519 Binding</h2>
            <div class="row">
              <label>Mobile (10 digits)<input id="cMobile" value="9876543210" /></label>
              <label>SMS OTP (see stdout)<input id="cOtp" placeholder="123456" /></label>
              <label>UPI PIN<input id="cPin" type="password" placeholder="1234" /></label>
            </div>
            <div class="row">
              <button onclick="doSignup()">1. Signup</button>
              <button class="secondary" onclick="doVerifyAndBind()">2. Verify OTP + Bind Ed25519 + Link BANKA</button>
            </div>
            <pre id="onboardOut" class="out">Private Ed25519 key stays strictly inside browser SubtleCrypto...</pre>
          </div>
          <div class="card">
            <h2>2. Signed Pay (QR / VPA) & Honest Pending UX</h2>
            <div class="row">
              <label>Payee VPA<input id="cPayeeVpa" value="shop@psp2" /></label>
              <label>Amount (paise)<input id="cPayAmt" type="number" value="25000" /></label>
              <button onclick="doSignedPay()">Send Ed25519 Signed Pay</button>
              <button class="secondary" onclick="syncPending()">Sync Pending</button>
            </div>
            <pre id="cPayOut" class="out">Client-generated clientTxnId persisted to localStorage before send...</pre>
          </div>
          <div class="card">
            <h2>3. Real-Time Risk Engine (<100ms) & Shadow Mode</h2>
            <div class="row">
              <label>Payee VPA<input id="rPayee" value="unknown@psp2" /></label>
              <label>Amount (paise)<input id="rAmt" type="number" value="350000" /></label>
              <label>New Device 24h<select id="rNewDev"><option value="false">false</option><option value="true">true</option></select></label>
            </div>
            <div class="row">
              <button onclick="scoreRisk()">Score Payment</button>
              <button class="secondary" onclick="runShadow100()">Run 100-Payment Shadow Diff</button>
              <button class="danger" onclick="blacklistPayee()">Blacklist Payee</button>
            </div>
            <pre id="riskOut" class="out">Enter X-Ops-Token above to run Risk & Shadow Mode...</pre>
          </div>
          <div class="card">
            <h2>4. Dispute Desk & Switch 0420 Auto-Resolution</h2>
            <div class="row">
              <label>Switch RRN<input id="dRrn" value="632810000123" /></label>
              <label>Amount (paise)<input id="dAmt" type="number" value="50000" /></label>
            </div>
            <div class="row">
              <button onclick="openDispute()">Open Dispute</button>
              <button class="secondary" onclick="triggerReversal()">Simulate Switch 0420 Reversal</button>
            </div>
            <pre id="dspOut" class="out">Switch 0420 reversals auto-resolve OPEN disputes to RESOLVED_CREDITED...</pre>
          </div>
        </div>`,
      scriptJs: `
        let deviceState = { customerId: "", deviceId: "", vpa: "", privateKey: null };
        function opsHeaders() {
          return { "content-type": "application/json", "x-ops-token": document.getElementById("p3OpsToken").value.trim() };
        }
        async function doSignup() {
          const r = await fetch("/api/signup", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ mobileNumber: document.getElementById("cMobile").value, fullName: "Anita Sharma" })
          });
          const data = await r.json();
          if (data.customer?.id) deviceState.customerId = data.customer.id;
          show("onboardOut", { status: r.status, body: data });
        }
        async function doVerifyAndBind() {
          const mobile = document.getElementById("cMobile").value;
          const otp = document.getElementById("cOtp").value;
          const pin = document.getElementById("cPin").value;
          const vr = await fetch("/api/otp/verify", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mobileNumber: mobile, otp }) });
          const vData = await vr.json();
          if (!vr.ok) return show("onboardOut", { status: vr.status, body: vData });
          deviceState.customerId = vData.customer.id;
          const kp = await crypto.subtle.generateKey("Ed25519", true, ["sign", "verify"]);
          const spki = await crypto.subtle.exportKey("spki", kp.publicKey);
          const b64 = btoa(String.fromCharCode(...new Uint8Array(spki)));
          const pem = "-----BEGIN PUBLIC KEY-----\\n" + b64.match(/.{1,64}/g).join("\\n") + "\\n-----END PUBLIC KEY-----";
          deviceState.deviceId = "dev_web_" + Date.now();
          deviceState.privateKey = kp.privateKey;
          const br = await fetch("/api/devices/bind", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: deviceState.customerId, deviceId: deviceState.deviceId, publicKeyPem: pem }) });
          await fetch("/api/pin/set", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: deviceState.customerId, rawPin: pin }) });
          const lr = await fetch("/api/accounts/link", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: deviceState.customerId, bankId: "BANKA", accountNumber: "987654324521" }) });
          const lData = await lr.json();
          const vpaRes = await fetch("/api/vpas", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ customerId: deviceState.customerId, linkedAccountId: lData.id, handle: "web." + Date.now() }) });
          const vpaData = await vpaRes.json();
          deviceState.vpa = vpaData.vpa;
          show("onboardOut", { bound: await br.json(), linked: lData, vpa: vpaData });
        }
        async function doSignedPay() {
          if (!deviceState.privateKey) return show("cPayOut", "Bind Ed25519 device first!");
          const clientTxnId = "CLNT-WEB-" + Date.now();
          localStorage.setItem("last_client_txn_id", clientTxnId);
          const payloadObj = {
            customerId: deviceState.customerId,
            clientTxnId,
            payPath: "VPA",
            payerVpa: deviceState.vpa,
            payeeVpa: document.getElementById("cPayeeVpa").value,
            amountPaise: Number(document.getElementById("cPayAmt").value),
            rawPin: document.getElementById("cPin").value
          };
          const rawBody = JSON.stringify(payloadObj);
          const ts = Date.now();
          const nonce = "n_" + Math.random().toString(16).slice(2) + ts;
          const msg = new TextEncoder().encode(deviceState.deviceId + ":" + ts + ":" + nonce + ":" + rawBody);
          const sigBuf = await crypto.subtle.sign("Ed25519", deviceState.privateKey, msg);
          const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sigBuf)));
          const r = await fetch("/api/pay", {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-device-id": deviceState.deviceId,
              "x-device-timestamp": String(ts),
              "x-device-nonce": nonce,
              "x-device-signature": sigB64
            },
            body: rawBody
          });
          show("cPayOut", { clientTxnId, status: r.status, body: await r.json() });
        }
        async function syncPending() {
          const id = localStorage.getItem("last_client_txn_id");
          if (!id) return show("cPayOut", "No pending clientTxnId stored.");
          const r = await fetch("/api/transactions/" + encodeURIComponent(id));
          show("cPayOut", { status: r.status, body: await r.json() });
        }
        async function toggleAirplane(enabled) {
          const r = await fetch("/api/chaos/airplane-mode", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled }) });
          show("cPayOut", await r.json());
        }
        async function scoreRisk() {
          const r = await fetch("/api/risk/score", {
            method: "POST",
            headers: opsHeaders(),
            body: JSON.stringify({
              payeeVpa: document.getElementById("rPayee").value,
              amountPaise: Number(document.getElementById("rAmt").value),
              isNewDevice24h: document.getElementById("rNewDev").value === "true",
              isNewCounterparty: true
            })
          });
          show("riskOut", { status: r.status, body: await r.json() });
        }
        async function runShadow100() {
          const r = await fetch("/api/risk/shadow/run-100", { method: "POST", headers: opsHeaders(), body: "{}" });
          show("riskOut", { status: r.status, body: await r.json() });
        }
        async function blacklistPayee() {
          const r = await fetch("/api/risk/blacklist", { method: "POST", headers: opsHeaders(), body: JSON.stringify({ entityId: document.getElementById("rPayee").value }) });
          show("riskOut", { status: r.status, body: await r.json() });
        }
        async function openDispute() {
          const r = await fetch("/api/disputes", {
            method: "POST",
            headers: opsHeaders(),
            body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value, amountPaise: Number(document.getElementById("dAmt").value) })
          });
          show("dspOut", { status: r.status, body: await r.json() });
        }
        async function triggerReversal() {
          const r = await fetch("/api/disputes/switch-reversal", {
            method: "POST",
            headers: opsHeaders(),
            body: JSON.stringify({ switchRrn: document.getElementById("dRrn").value })
          });
          show("dspOut", { status: r.status, body: await r.json() });
        }
      `,
    });
  }
}
