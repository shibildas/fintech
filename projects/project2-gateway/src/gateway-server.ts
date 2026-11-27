import http from "node:http";
import path from "node:path";
import {
  buildCorsHeaders,
  ensureDataDir,
  mapErrorToHttpStatus,
  readRawAndJsonBody,
  writeJsonResponse,
  writeHtmlResponse,
} from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { AcquirerSimulator } from "./acquirer-simulator.ts";
import { PaymentGatewayEngine } from "./gateway-engine.ts";
import { TokenVaultService, runPciGrepTest } from "./token-vault.ts";
import { DemoStoreWebhookReceiver } from "./webhook-worker.ts";
import { renderGatewayUiHtml } from "./gateway-ui.ts";

/**
 * Slices 02 & 03 — Project 2 Live HTTP Server & Interactive Web UI (:3002)
 *
 * - Persistent `.data/p2-gateway.sqlite` + strictly isolated `.data/p2-vault.sqlite`
 * - Strict manual HMAC-SHA256 auth (`X-Key-Id`, `X-Timestamp`, `X-Signature`) + merchant tenant isolation
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
  const gwDbPath = options?.dataDir ? path.join(options.dataDir, "p2-gateway.sqlite") : ":memory:";
  const vaultDbPath = options?.dataDir ? path.join(options.dataDir, "p2-vault.sqlite") : ":memory:";
  const p2BanksDir = options?.dataDir ? path.join(options.dataDir, "p2-banks") : undefined;
  const p2SwitchPath = options?.dataDir ? path.join(options.dataDir, "p2-switch.sqlite") : ":memory:";

  const p1 = createSeededTopology(p2BanksDir ? { dataDir: p2BanksDir } : undefined);
  const sw = new CentralSwitch({
    dbPath: p2SwitchPath,
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

  private assertMerchantOwnsOrder(orderId: string, merchantId: string): void {
    const row = this.ctx.gateway.gatewayDb
      .prepare(`SELECT merchant_id FROM orders WHERE id = ?`)
      .get(orderId) as { merchant_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error(`Order "${orderId}" not found`), { statusCode: 404 });
    }
    if (row.merchant_id !== merchantId) {
      throw Object.assign(new Error("Forbidden (HTTP 403): Order belongs to another merchant"), { statusCode: 403 });
    }
  }

  private assertMerchantOwnsPayment(paymentId: string, merchantId: string): void {
    const row = this.ctx.gateway.gatewayDb
      .prepare(`SELECT merchant_id FROM payments WHERE id = ?`)
      .get(paymentId) as { merchant_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error(`Payment "${paymentId}" not found`), { statusCode: 404 });
    }
    if (row.merchant_id !== merchantId) {
      throw Object.assign(new Error("Forbidden (HTTP 403): Payment belongs to another merchant"), { statusCode: 403 });
    }
  }

  private assertMerchantOwnsDelivery(deliveryId: string, merchantId: string): void {
    const row = this.ctx.gateway.gatewayDb
      .prepare(
        `SELECT e.merchant_id FROM webhook_deliveries d
         JOIN webhook_endpoints e ON d.endpoint_id = e.id
         WHERE d.id = ?`
      )
      .get(deliveryId) as { merchant_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error(`Webhook delivery "${deliveryId}" not found`), { statusCode: 404 });
    }
    if (row.merchant_id !== merchantId) {
      throw Object.assign(new Error("Forbidden (HTTP 403): Webhook delivery belongs to another merchant"), { statusCode: 403 });
    }
  }

  public createHttpServer(): http.Server {
    return http.createServer(async (req, res) => {
      const method = (req.method ?? "GET").toUpperCase();
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const pathname = url.pathname;
      const origin = req.headers.origin;

      if (method === "OPTIONS") {
        res.writeHead(204, buildCorsHeaders(origin));
        res.end();
        return;
      }

      try {
        if (method === "GET" && pathname === "/") {
          writeHtmlResponse(res, 200, renderGatewayUiHtml(), origin);
          return;
        }

        if (method === "GET" && pathname === "/health") {
          writeJsonResponse(res, 200, {
            service: "project2-gateway",
            status: "UP",
            acquirers: this.ctx.gateway.routing.listAllHealthSnapshots(),
          }, origin);
          return;
        }

        const { rawBody, json } = await readRawAndJsonBody(req);

        // Direct Browser -> Isolated PCI Token Vault (never retains raw PAN in Gateway RAM)
        if (method === "POST" && pathname === "/api/vault/tokenize") {
          const meta = this.ctx.gateway.vault.tokenize({
            cardNumber: String(json.cardNumber ?? ""),
            expiry: String(json.expiry ?? "12/29"),
            merchantId: String(json.merchantId ?? this.ctx.seededMerchantId),
            customerReference: json.customerReference ? String(json.customerReference) : null,
          });
          writeJsonResponse(res, 201, meta, origin);
          return;
        }

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
          writeJsonResponse(res, 201, result, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/payments") {
          const orderId = String(json.orderId ?? "");
          this.assertMerchantOwnsOrder(orderId, auth.merchant.id);
          const resPay = await this.ctx.gateway.payOrder({
            orderId,
            method: (json.method as "CARD" | "UPI" | "NETBANKING" | "WALLET") ?? "CARD",
            tokenId: json.tokenId ? String(json.tokenId) : undefined,
            cardOtp: json.cardOtp !== undefined ? String(json.cardOtp) : undefined,
            upiPayerVpa: json.upiPayerVpa ? String(json.upiPayerVpa) : undefined,
            upiRawPin: json.upiRawPin ? String(json.upiRawPin) : undefined,
          });
          writeJsonResponse(res, 200, resPay, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/acquirers/health") {
          writeJsonResponse(res, 200, {
            snapshots: this.ctx.gateway.routing.listAllHealthSnapshots(),
          }, origin);
          return;
        }

        const acqMatch = pathname.match(/^\/api\/acquirers\/([^/]+)\/chaos$/);
        if (method === "PUT" && acqMatch) {
          if (auth.mode !== "LIVE") {
            throw Object.assign(new Error("Forbidden (HTTP 403): LIVE key required for acquirer chaos controls"), { statusCode: 403 });
          }
          const id = decodeURIComponent(acqMatch[1]).toUpperCase();
          const map: Record<string, AcquirerSimulator> = {
            ACQ_ALPHA: this.ctx.acqAlpha,
            ACQ_BETA: this.ctx.acqBeta,
            ACQ_GAMMA: this.ctx.acqGamma,
          };
          const sim = map[id];
          if (!sim) {
            writeJsonResponse(res, 404, { error: `Unknown acquirer "${id}"` }, origin);
            return;
          }
          const patch: Parameters<AcquirerSimulator["setChaos"]>[0] = {};
          if (json.forceDown !== undefined) patch.forceDown = Boolean(json.forceDown);
          if (json.forceRefundFail !== undefined) patch.forceRefundFail = Boolean(json.forceRefundFail);
          if (json.technicalFailureRatePercent !== undefined) {
            const pct = Number(json.technicalFailureRatePercent);
            if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
              throw Object.assign(new Error("technicalFailureRatePercent must be between 0 and 100"), { statusCode: 400 });
            }
            patch.technicalFailureRatePercent = pct;
          }
          if (json.latencyMs !== undefined) {
            const lat = Number(json.latencyMs);
            if (!Number.isFinite(lat) || lat < 0) {
              throw Object.assign(new Error("latencyMs must be a non-negative number"), { statusCode: 400 });
            }
            patch.latencyMs = lat;
          }
          const updated = sim.setChaos(patch);
          writeJsonResponse(res, 200, { acquirerId: id, chaos: updated }, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/pci-grep-audit") {
          const customPans = (url.searchParams.get("pans") ?? "")
            .split(",")
            .map((s) => s.replace(/[\s-]/g, ""))
            .filter((s) => s.length >= 13);
          const rawPansUsed = customPans.length > 0 ? customPans : ["4111111111114242", "5555555555554444"];
          const audit = runPciGrepTest({
            gatewayDb: this.ctx.gateway.gatewayDb,
            vaultDb: this.ctx.gateway.vault.vaultDb,
            structuredLogs: this.ctx.gateway.structuredLogs,
            rawPansUsed,
          });
          writeJsonResponse(res, 200, {
            tracked_pans_checked: rawPansUsed.length,
            ...audit,
          }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/refunds") {
          const paymentId = String(json.paymentId ?? "");
          this.assertMerchantOwnsPayment(paymentId, auth.merchant.id);
          const refRes = await this.ctx.gateway.createRefund({
            paymentId,
            amountPaise: Number(json.amountPaise ?? 0),
            idempotencyKey: String(json.idempotencyKey ?? `ref_${Date.now()}`),
          });
          writeJsonResponse(res, 201, refRes, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/ledger/parity") {
          writeJsonResponse(res, 200, {
            balances: this.ctx.gateway.getMerchantLedgerBalances(auth.merchant.id),
            parity: this.ctx.gateway.verifyDashboardMatchesLedger(auth.merchant.id),
          }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/payouts/run") {
          const payout = await this.ctx.gateway.runMerchantPayout({
            merchantId: auth.merchant.id,
            periodLabel: json.periodLabel ? String(json.periodLabel) : undefined,
          });
          writeJsonResponse(res, 200, payout, origin);
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
          }, origin);
          return;
        }

        if (method === "PUT" && pathname === "/api/webhooks/demo-receiver") {
          if (auth.mode !== "LIVE") {
            throw Object.assign(new Error("Forbidden (HTTP 403): LIVE key required"), { statusCode: 403 });
          }
          this.ctx.demoStore.simulateServer500 = Boolean(json.simulateServer500);
          writeJsonResponse(res, 200, {
            simulateServer500: this.ctx.demoStore.simulateServer500,
          }, origin);
          return;
        }

        const resendMatch = pathname.match(/^\/api\/webhooks\/deliveries\/([^/]+)\/resend$/);
        if (method === "POST" && resendMatch) {
          const delId = decodeURIComponent(resendMatch[1]);
          this.assertMerchantOwnsDelivery(delId, auth.merchant.id);
          const resent = await this.ctx.gateway.webhooks.resendDelivery(delId);
          writeJsonResponse(res, 200, resent, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/keys/rotate") {
          const rotated = this.ctx.gateway.rotateApiKey({
            merchantId: auth.merchant.id,
            mode: auth.mode,
            overlapWindowMs: Number(json.overlapWindowMs ?? 15 * 60 * 1000),
          });
          writeJsonResponse(res, 200, rotated, origin);
          return;
        }

        writeJsonResponse(res, 404, { error: "Not Found" }, origin);
      } catch (err: unknown) {
        const statusCode = mapErrorToHttpStatus(err);
        const message = err instanceof Error ? err.message : String(err);
        writeJsonResponse(res, statusCode, { error: message }, origin);
      }
    });
  }
}
