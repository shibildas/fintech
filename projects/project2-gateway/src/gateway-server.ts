import http from "node:http";
import {
  buildCorsHeaders,
  mapErrorToHttpStatus,
  readRawAndJsonBody,
  writeJsonResponse,
  writeHtmlResponse,
} from "@fintech/core";
import type { AcquirerSimulator } from "./acquirer-simulator.ts";
import { runPciGrepTest } from "./token-vault.ts";
import { renderGatewayUiHtml } from "./gateway-ui.ts";
import type { GatewayHttpServerContext } from "./gateway-context.ts";

export {
  createPersistentGatewayContext,
  type GatewayHttpServerContext,
} from "./gateway-context.ts";

/**
 * Slices 02 & 03 — Project 2 Live HTTP Server (:3002)
 */
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

  private assertOwnership(table: "orders" | "payments", id: string, merchantId: string): void {
    const row = this.ctx.gateway.gatewayDb
      .prepare(`SELECT merchant_id FROM ${table} WHERE id = ?`)
      .get(id) as { merchant_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error(`${table.slice(0, -1)} "${id}" not found`), {
        statusCode: 404,
      });
    }
    if (row.merchant_id !== merchantId) {
      throw Object.assign(new Error("Forbidden (HTTP 403): Resource belongs to another merchant"), {
        statusCode: 403,
      });
    }
  }

  private assertDeliveryOwnership(deliveryId: string, merchantId: string): void {
    const row = this.ctx.gateway.gatewayDb
      .prepare(
        `SELECT e.merchant_id FROM webhook_deliveries d
         JOIN webhook_endpoints e ON d.endpoint_id = e.id WHERE d.id = ?`
      )
      .get(deliveryId) as { merchant_id: string } | undefined;
    if (!row) {
      throw Object.assign(new Error(`Webhook delivery "${deliveryId}" not found`), {
        statusCode: 404,
      });
    }
    if (row.merchant_id !== merchantId) {
      throw Object.assign(
        new Error("Forbidden (HTTP 403): Webhook delivery belongs to another merchant"),
        { statusCode: 403 }
      );
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
          writeJsonResponse(
            res,
            200,
            {
              service: "project2-gateway",
              status: "UP",
              acquirers: this.ctx.gateway.routing.listAllHealthSnapshots(),
            },
            origin
          );
          return;
        }

        const { rawBody, json } = await readRawAndJsonBody(req);

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
          this.assertOwnership("orders", orderId, auth.merchant.id);
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
          writeJsonResponse(
            res,
            200,
            { snapshots: this.ctx.gateway.routing.listAllHealthSnapshots() },
            origin
          );
          return;
        }

        const acqMatch = pathname.match(/^\/api\/acquirers\/([^/]+)\/chaos$/);
        if (method === "PUT" && acqMatch) {
          if (auth.mode !== "LIVE") {
            throw Object.assign(new Error("Forbidden (HTTP 403): LIVE key required"), {
              statusCode: 403,
            });
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
          if (json.forceRefundFail !== undefined)
            patch.forceRefundFail = Boolean(json.forceRefundFail);
          if (json.technicalFailureRatePercent !== undefined) {
            const pct = Number(json.technicalFailureRatePercent);
            if (!Number.isFinite(pct) || pct < 0 || pct > 100) {
              throw Object.assign(
                new Error("technicalFailureRatePercent must be between 0 and 100"),
                { statusCode: 400 }
              );
            }
            patch.technicalFailureRatePercent = pct;
          }
          if (json.latencyMs !== undefined) {
            const lat = Number(json.latencyMs);
            if (!Number.isFinite(lat) || lat < 0) {
              throw Object.assign(new Error("latencyMs must be a non-negative number"), {
                statusCode: 400,
              });
            }
            patch.latencyMs = lat;
          }
          writeJsonResponse(res, 200, { acquirerId: id, chaos: sim.setChaos(patch) }, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/pci-grep-audit") {
          const customPans = (url.searchParams.get("pans") ?? "")
            .split(",")
            .map((s) => s.replace(/[\s-]/g, ""))
            .filter((s) => s.length >= 13);
          const rawPansUsed =
            customPans.length > 0 ? customPans : ["4111111111114242", "5555555555554444"];
          const audit = runPciGrepTest({
            gatewayDb: this.ctx.gateway.gatewayDb,
            vaultDb: this.ctx.gateway.vault.vaultDb,
            structuredLogs: this.ctx.gateway.structuredLogs,
            rawPansUsed,
          });
          writeJsonResponse(
            res,
            200,
            { tracked_pans_checked: rawPansUsed.length, ...audit },
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/refunds") {
          const paymentId = String(json.paymentId ?? "");
          this.assertOwnership("payments", paymentId, auth.merchant.id);
          const refRes = await this.ctx.gateway.createRefund({
            paymentId,
            amountPaise: Number(json.amountPaise ?? 0),
            idempotencyKey: String(json.idempotencyKey ?? `ref_${Date.now()}`),
          });
          writeJsonResponse(res, 201, refRes, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/ledger/parity") {
          writeJsonResponse(
            res,
            200,
            {
              balances: this.ctx.gateway.getMerchantLedgerBalances(auth.merchant.id),
              parity: this.ctx.gateway.verifyDashboardMatchesLedger(auth.merchant.id),
            },
            origin
          );
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
          writeJsonResponse(
            res,
            200,
            {
              demoReceiverSimulating500: this.ctx.demoStore.simulateServer500,
              endpoints: eps.map((e) => ({ id: e.id, url: e.url, state: e.state })),
              deliveries,
            },
            origin
          );
          return;
        }

        if (method === "PUT" && pathname === "/api/webhooks/demo-receiver") {
          if (auth.mode !== "LIVE") {
            throw Object.assign(new Error("Forbidden (HTTP 403): LIVE key required"), {
              statusCode: 403,
            });
          }
          this.ctx.demoStore.simulateServer500 = Boolean(json.simulateServer500);
          writeJsonResponse(
            res,
            200,
            { simulateServer500: this.ctx.demoStore.simulateServer500 },
            origin
          );
          return;
        }

        const resendMatch = pathname.match(/^\/api\/webhooks\/deliveries\/([^/]+)\/resend$/);
        if (method === "POST" && resendMatch) {
          const delId = decodeURIComponent(resendMatch[1]);
          this.assertDeliveryOwnership(delId, auth.merchant.id);
          writeJsonResponse(
            res,
            200,
            await this.ctx.gateway.webhooks.resendDelivery(delId),
            origin
          );
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
        writeJsonResponse(
          res,
          mapErrorToHttpStatus(err),
          {
            error: err instanceof Error ? err.message : String(err),
          },
          origin
        );
      }
    });
  }
}
