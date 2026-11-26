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
import { AcquirerSimulator } from "./acquirer-simulator.ts";
import { PaymentGatewayEngine } from "./gateway-engine.ts";
import { TokenVaultService, runPciGrepTest } from "./token-vault.ts";
import { DemoStoreWebhookReceiver } from "./webhook-worker.ts";

/**
 * Slices 02 & 03 — Project 2 Live HTTP Server & Interactive Web UI (:3002)
 *
 * - Persistent `.data/p2-gateway.sqlite` + strictly isolated `.data/p2-vault.sqlite`
 * - Strict manual HMAC-SHA256 auth (`X-Key-Id`, `X-Timestamp`, `X-Signature`)
 * - Endpoints: Orders, Vault Tokenize, Payments (Card 3DS + UPI), Acquirer Chaos/Health,
 *   Live PCI Grep Audit, Partial Refunds (422 guard), Webhooks (500 toggle + Resend),
 *   T+1 Payout CSVs & Dual-Secret Overlap Key Rotation.
 */

export interface GatewayHttpServerContext {
  gateway: PaymentGatewayEngine;
  acqAlpha: AcquirerSimulator;
  acqBeta: AcquirerSimulator;
  acqGamma: AcquirerSimulator;
  demoStore: DemoStoreWebhookReceiver;
  seededMerchantId: string;
  seededKeyId: string;
  seededApiSecret: string;
  seededWebhookSecret: string;
}

export function createPersistentGatewayContext(options?: {
  dataDir?: string;
}): GatewayHttpServerContext {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const gwDbPath = options?.dataDir
    ? path.join(options.dataDir, "p2-gateway.sqlite")
    : ":memory:";
  const vaultDbPath = options?.dataDir
    ? path.join(options.dataDir, "p2-vault.sqlite")
    : ":memory:";

  const p1 = createSeededTopology();
  const sw = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const vault = new TokenVaultService({ dbPath: vaultDbPath });
  const gateway = new PaymentGatewayEngine({
    gatewayDbPath: gwDbPath,
    vault,
    upiSwitch: sw,
    upiPsp: p1.psps.PSP1,
    merchantUpiVpa: "shop@psp2",
  });

  const acqAlpha = new AcquirerSimulator({
    acquirerId: "ACQ_ALPHA",
    name: "Acquirer Alpha (Primary)",
    supportedMethods: ["CARD", "NETBANKING", "WALLET"],
    baseLatencyMs: 2,
  });
  const acqBeta = new AcquirerSimulator({
    acquirerId: "ACQ_BETA",
    name: "Acquirer Beta (Failover)",
    supportedMethods: ["CARD", "NETBANKING", "WALLET"],
    baseLatencyMs: 4,
  });
  const acqGamma = new AcquirerSimulator({
    acquirerId: "ACQ_GAMMA",
    name: "Acquirer Gamma (Backup)",
    supportedMethods: ["CARD", "NETBANKING"],
    baseLatencyMs: 6,
  });

  gateway.routing.registerAcquirer(acqAlpha);
  gateway.routing.registerAcquirer(acqBeta);
  gateway.routing.registerAcquirer(acqGamma);
  gateway.routing.addRoutingRule({ id: "r1", method: "CARD", priorityOrder: 1, acquirerId: "ACQ_ALPHA" });
  gateway.routing.addRoutingRule({ id: "r2", method: "CARD", priorityOrder: 2, acquirerId: "ACQ_BETA" });
  gateway.routing.addRoutingRule({ id: "r3", method: "CARD", priorityOrder: 3, acquirerId: "ACQ_GAMMA" });

  // Idempotently load or seed the demo merchant
  const existingMerchant = gateway.gatewayDb
    .prepare(`SELECT id FROM merchants WHERE business_name = 'Acme Books Store' LIMIT 1`)
    .get() as { id: string } | undefined;

  let merchantId: string;
  let keyId: string;
  let apiSecret: string;

  if (existingMerchant) {
    merchantId = existingMerchant.id;
    const keyRow = gateway.gatewayDb
      .prepare(`SELECT key_id, active_secret FROM api_keys WHERE merchant_id = ? AND mode = 'LIVE'`)
      .get(merchantId) as { key_id: string; active_secret: string };
    keyId = keyRow.key_id;
    apiSecret = keyRow.active_secret;
  } else {
    const onboarded = gateway.onboardMerchant({
      businessName: "Acme Books Store",
      contactEmail: "finance@acmebooks.in",
      settlementAccountNumber: "HDFC000998877",
      settlementBranchCode: "HDFC0000123",
      settlementHolderName: "Acme Books Pvt Ltd",
      returnUrl: "https://demo.acmebooks.in/checkout/return",
    });
    gateway.transitionMerchantOnboarding({ merchantId: onboarded.merchant.id, toState: "UNDER_REVIEW" });
    gateway.transitionMerchantOnboarding({ merchantId: onboarded.merchant.id, toState: "ACTIVE" });
    merchantId = onboarded.merchant.id;
    keyId = onboarded.liveKey.keyId;
    apiSecret = onboarded.liveKey.secret;
  }

  const webhookUrl = "https://demo.acmebooks.in/webhooks/gateway";
  const existingEps = gateway.webhooks.listMerchantEndpoints(merchantId);
  let webhookSecret = "whsec_demo_store_live_2026";
  if (existingEps.length > 0) {
    webhookSecret = existingEps[0].secret;
  } else {
    gateway.webhooks.registerEndpoint({
      merchantId,
      url: webhookUrl,
      secret: webhookSecret,
      events: ["payment.authorized", "payment.captured", "payment.failed", "refund.processed", "settlement.processed"],
    });
  }

  const demoStore = new DemoStoreWebhookReceiver(webhookSecret);
  gateway.webhooks.registerMockHttpTarget(webhookUrl, demoStore.createHandler());

  return {
    gateway,
    acqAlpha,
    acqBeta,
    acqGamma,
    demoStore,
    seededMerchantId: merchantId,
    seededKeyId: keyId,
    seededApiSecret: apiSecret,
    seededWebhookSecret: webhookSecret,
  };
}

export class GatewayHttpServer {
  public readonly ctx: GatewayHttpServerContext;
  private readonly trackedRawPansForAudit = new Set<string>();

  constructor(ctx: GatewayHttpServerContext) {
    this.ctx = ctx;
  }

  private authenticate(req: http.IncomingMessage, rawBody: string) {
    const keyId = String(req.headers["x-key-id"] ?? "").trim();
    const timestampIso = String(req.headers["x-timestamp"] ?? "").trim();
    const signature = String(req.headers["x-signature"] ?? "").trim();
    if (!keyId || !timestampIso || !signature) {
      throw Object.assign(
        new Error("Unauthorized (HTTP 401): Missing X-Key-Id, X-Timestamp, or X-Signature"),
        { statusCode: 401 }
      );
    }
    return this.ctx.gateway.authenticateMerchantRequest({
      keyId,
      rawBody,
      timestampIso,
      signature,
    });
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
            service: "project2-gateway",
            status: "UP",
            acquirers: this.ctx.gateway.routing.listAllHealthSnapshots(),
          });
          return;
        }

        const { rawBody, json } = await readRawAndJsonBody(req);

        // Direct Browser -> Isolated PCI Token Vault (no merchant secret required for card tokenization, scoped to merchantId)
        if (method === "POST" && pathname === "/api/vault/tokenize") {
          const cardNumber = String(json.cardNumber ?? "");
          if (cardNumber) {
            this.trackedRawPansForAudit.add(cardNumber.replace(/[\s-]/g, ""));
          }
          const meta = this.ctx.gateway.vault.tokenize({
            cardNumber,
            expiry: String(json.expiry ?? "12/29"),
            merchantId: String(json.merchantId ?? this.ctx.seededMerchantId),
            customerReference: json.customerReference ? String(json.customerReference) : null,
          });
          writeJsonResponse(res, 201, meta);
          return;
        }

        // All merchant API routes below enforce strict manual HMAC-SHA256 authentication
        const auth = this.authenticate(req, rawBody);

        if (method === "POST" && pathname === "/api/orders") {
          const result = await this.ctx.gateway.createOrder({
            merchantId: auth.merchant.id,
            mode: auth.mode,
            idempotencyKey: String(json.idempotencyKey ?? `ord_${Date.now()}`),
            amountPaise: Number(json.amountPaise ?? 100_000),
            merchantOrderId: String(json.merchantOrderId ?? `rcpt_${Date.now()}`),
            customerReference: json.customerReference ? String(json.customerReference) : undefined,
          });
          writeJsonResponse(res, 201, result);
          return;
        }

        if (method === "POST" && pathname === "/api/payments") {
          const resPay = await this.ctx.gateway.payOrder({
            orderId: String(json.orderId ?? ""),
            method: (json.method as "CARD" | "UPI" | "NETBANKING" | "WALLET") ?? "CARD",
            tokenId: json.tokenId ? String(json.tokenId) : undefined,
            cardOtp: json.cardOtp !== undefined ? String(json.cardOtp) : undefined,
            upiPayerVpa: json.upiPayerVpa ? String(json.upiPayerVpa) : undefined,
            upiRawPin: json.upiRawPin ? String(json.upiRawPin) : undefined,
          });
          writeJsonResponse(res, 200, resPay);
          return;
        }

        if (method === "GET" && pathname === "/api/acquirers/health") {
          writeJsonResponse(res, 200, {
            snapshots: this.ctx.gateway.routing.listAllHealthSnapshots(),
          });
          return;
        }

        const acqMatch = pathname.match(/^\/api\/acquirers\/([^/]+)\/chaos$/);
        if (method === "PUT" && acqMatch) {
          const id = decodeURIComponent(acqMatch[1]).toUpperCase();
          const map: Record<string, AcquirerSimulator> = {
            ACQ_ALPHA: this.ctx.acqAlpha,
            ACQ_BETA: this.ctx.acqBeta,
            ACQ_GAMMA: this.ctx.acqGamma,
          };
          const sim = map[id];
          if (!sim) {
            writeJsonResponse(res, 404, { error: `Unknown acquirer "${id}"` });
            return;
          }
          const updated = sim.setChaos({
            forceDown: Boolean(json.forceDown),
            forceRefundFail: Boolean(json.forceRefundFail),
          });
          writeJsonResponse(res, 200, { acquirerId: id, chaos: updated });
          return;
        }

        if (method === "GET" && pathname === "/api/pci-grep-audit") {
          const audit = runPciGrepTest({
            gatewayDb: this.ctx.gateway.gatewayDb,
            vaultDb: this.ctx.gateway.vault.vaultDb,
            structuredLogs: this.ctx.gateway.structuredLogs,
            rawPansUsed: Array.from(this.trackedRawPansForAudit),
          });
          writeJsonResponse(res, 200, {
            tracked_pans_checked: this.trackedRawPansForAudit.size,
            ...audit,
          });
          return;
        }

        // Slice 03: Refunds, Ledger Parity, Payouts, Webhooks & Key Rotation
        if (method === "POST" && pathname === "/api/refunds") {
          const refRes = await this.ctx.gateway.createRefund({
            paymentId: String(json.paymentId ?? ""),
            amountPaise: Number(json.amountPaise ?? 0),
            idempotencyKey: String(json.idempotencyKey ?? `ref_${Date.now()}`),
          });
          writeJsonResponse(res, 201, refRes);
          return;
        }

        if (method === "GET" && pathname === "/api/ledger/parity") {
          writeJsonResponse(res, 200, {
            balances: this.ctx.gateway.getMerchantLedgerBalances(auth.merchant.id),
            parity: this.ctx.gateway.verifyDashboardMatchesLedger(auth.merchant.id),
          });
          return;
        }

        if (method === "POST" && pathname === "/api/payouts/run") {
          const payout = await this.ctx.gateway.runMerchantPayout({
            merchantId: auth.merchant.id,
            periodLabel: json.periodLabel ? String(json.periodLabel) : undefined,
          });
          writeJsonResponse(res, 200, payout);
          return;
        }

        if (method === "GET" && pathname === "/api/webhooks/deliveries") {
          const eps = this.ctx.gateway.webhooks.listMerchantEndpoints(auth.merchant.id);
          const deliveries = eps.flatMap((e) =>
            this.ctx.gateway.webhooks.listDeliveriesForEndpoint(e.id)
          );
          writeJsonResponse(res, 200, {
            demoReceiverSimulating500: this.ctx.demoStore.simulateServer500,
            endpoints: eps.map((e) => ({ id: e.id, url: e.url, state: e.state })),
            deliveries,
          });
          return;
        }

        if (method === "PUT" && pathname === "/api/webhooks/demo-receiver") {
          this.ctx.demoStore.simulateServer500 = Boolean(json.simulateServer500);
          writeJsonResponse(res, 200, {
            simulateServer500: this.ctx.demoStore.simulateServer500,
          });
          return;
        }

        const resendMatch = pathname.match(/^\/api\/webhooks\/deliveries\/([^/]+)\/resend$/);
        if (method === "POST" && resendMatch) {
          const delId = decodeURIComponent(resendMatch[1]);
          const resent = await this.ctx.gateway.webhooks.resendDelivery(delId);
          writeJsonResponse(res, 200, resent);
          return;
        }

        if (method === "POST" && pathname === "/api/keys/rotate") {
          const rotated = this.ctx.gateway.rotateApiKey({
            merchantId: auth.merchant.id,
            mode: auth.mode,
            overlapWindowMs: Number(json.overlapWindowMs ?? 15 * 60 * 1000),
          });
          writeJsonResponse(res, 200, rotated);
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
        <div class="grid">
          <div class="card">
            <h2>1. Order -> PCI Token Vault -> 3DS Card / UPI Pay</h2>
            <div class="row">
              <label>Amount (paise)<input id="ordAmt" type="number" value="150000" /></label>
              <label>Card PAN (Vault Only)<input id="cardPan" value="4111111111114242" /></label>
              <label>3DS OTP (123456=OK, 000000=Decline)<input id="cardOtp" value="123456" /></label>
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
              <button class="danger" onclick="setAcqDown(true)">Force Down</button>
              <button class="secondary" onclick="setAcqDown(false)">Restore Healthy</button>
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
            <pre id="refOut" class="out">Partial refunds, 422 guard, ledger parity & T+1 CSV...</pre>
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
          const headers = { "x-key-id": keyId, "x-timestamp": ts, "x-signature": sig };
          if (bodyObj !== undefined) headers["content-type"] = "application/json";
          const r = await fetch(path, { method, headers, body: bodyObj === undefined ? undefined : rawBody });
          return { status: r.status, body: await r.json() };
        }
        async function runCardCheckout() {
          const amt = Number(document.getElementById("ordAmt").value);
          const ord = await signedFetch("POST", "/api/orders", { amountPaise: amt, idempotencyKey: "ui_ord_" + Date.now(), merchantOrderId: "rcpt_" + Date.now() });
          if (ord.status !== 201) return show("payOut", ord);
          const tokRes = await fetch("/api/vault/tokenize", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ cardNumber: document.getElementById("cardPan").value, expiry: "12/29", merchantId: ord.body.order.merchant_id })
          });
          const tok = await tokRes.json();
          const pay = await signedFetch("POST", "/api/payments", { orderId: ord.body.order.id, method: "CARD", tokenId: tok.token, cardOtp: document.getElementById("cardOtp").value });
          if (pay.body?.payment?.id) document.getElementById("refPayId").value = pay.body.payment.id;
          show("payOut", { token: tok, payment: pay });
        }
        async function runUpiCheckout() {
          const amt = Number(document.getElementById("ordAmt").value);
          const ord = await signedFetch("POST", "/api/orders", { amountPaise: amt, idempotencyKey: "ui_upi_" + Date.now(), merchantOrderId: "rcpt_upi_" + Date.now() });
          if (ord.status !== 201) return show("payOut", ord);
          const pay = await signedFetch("POST", "/api/payments", { orderId: ord.body.order.id, method: "UPI", upiPayerVpa: "anita@psp1", upiRawPin: "1234" });
          show("payOut", pay);
        }
        async function setAcqDown(forceDown) {
          const id = document.getElementById("acqId").value;
          show("acqOut", await signedFetch("PUT", "/api/acquirers/" + id + "/chaos", { forceDown }));
        }
        async function loadAcqHealth() { show("acqOut", await signedFetch("GET", "/api/acquirers/health")); }
        async function runGrepAudit() { show("acqOut", await signedFetch("GET", "/api/pci-grep-audit")); }
        async function checkParity() { show("refOut", await signedFetch("GET", "/api/ledger/parity")); }
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
          show("whOut", await signedFetch("POST", "/api/webhooks/deliveries/" + id + "/resend", {}));
        }
        async function rotateKey() { show("refOut", await signedFetch("POST", "/api/keys/rotate", { overlapWindowMs: 900000 })); }
      `,
    });
  }
}
