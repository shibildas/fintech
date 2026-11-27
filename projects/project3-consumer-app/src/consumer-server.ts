import http from "node:http";
import path from "node:path";
import crypto from "node:crypto";
import {
  buildCorsHeaders,
  ensureDataDir,
  mapErrorToHttpStatus,
  readRawAndJsonBody,
  timingSafeTokenEqual,
  writeJsonResponse,
  writeHtmlResponse,
} from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { ConsumerPspBackend } from "./psp-backend.ts";
import { ConsumerPayEngine, type PayPathType } from "./pay-flows.ts";
import { CollectRequestEngine, PspLimitProfileEngine } from "./collect-and-limits.ts";
import { RealTimeRiskEngine } from "./risk-engine.ts";
import { VersionedShadowRiskEngine } from "./risk-shadow-mode.ts";
import { ConsumerDisputeDesk, type DisputeCategory } from "./dispute-desk.ts";
import { renderConsumerUiHtml } from "./consumer-ui.ts";

/**
 * Slices 04 & 05 — Project 3 Live HTTP Server (:3003)
 *
 * - Persistent `.data/p3-consumer.sqlite`, `.data/p3-risk.sqlite`, `.data/p3-disputes.sqlite`, `.data/p3-banks/`
 * - Strict OTP onboarding token + Ed25519 device signing (`X-Device-*`) + `X-Ops-Token`
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
  const p3BanksDir = options?.dataDir ? path.join(options.dataDir, "p3-banks") : undefined;

  const p1 = createSeededTopology(p3BanksDir ? { dataDir: p3BanksDir } : undefined);
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
  const shadow = new VersionedShadowRiskEngine(dbPath("p3-risk.sqlite"));
  if (!shadow.hasRulesets()) {
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
  }

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
  private readonly onboardingTokens = new Map<string, { customerId: string; expiresAtMs: number }>();

  constructor(ctx: ConsumerHttpServerContext) {
    this.ctx = ctx;
  }

  private requireOpsToken(req: http.IncomingMessage): void {
    const token = String(req.headers["x-ops-token"] ?? "").trim();
    if (!timingSafeTokenEqual(token, this.ctx.opsToken)) {
      throw Object.assign(new Error("Unauthorized (HTTP 401): Missing or invalid X-Ops-Token"), {
        statusCode: 401,
      });
    }
  }

  private extractDeviceHeaders(req: http.IncomingMessage) {
    const deviceId = String(req.headers["x-device-id"] ?? "").trim();
    const timestampMs = Number(req.headers["x-device-timestamp"] ?? 0);
    const nonce = String(req.headers["x-device-nonce"] ?? "").trim();
    const signatureBase64 = String(req.headers["x-device-signature"] ?? "").trim();
    if (!deviceId || !timestampMs || !nonce || !signatureBase64) {
      throw Object.assign(
        new Error("Unauthorized (HTTP 401): Missing Ed25519 X-Device-* headers"),
        { statusCode: 401 }
      );
    }
    return { deviceId, timestampMs, nonce, signatureBase64 };
  }

  private verifyDeviceAuth(req: http.IncomingMessage, rawBody: string) {
    const h = this.extractDeviceHeaders(req);
    return this.ctx.psp.verifyDeviceSignedRequest({
      ...h,
      payload: rawBody,
    });
  }

  private requireOnboardingOrDeviceAuth(
    req: http.IncomingMessage,
    rawBody: string,
    targetCustomerId?: string
  ): string {
    const obToken = String(req.headers["x-onboarding-token"] ?? "").trim();
    if (obToken) {
      const rec = this.onboardingTokens.get(obToken);
      if (!rec || Date.now() > rec.expiresAtMs) {
        this.onboardingTokens.delete(obToken);
        throw Object.assign(new Error("Unauthorized (HTTP 401): Invalid or expired X-Onboarding-Token"), {
          statusCode: 401,
        });
      }
      if (targetCustomerId && rec.customerId !== targetCustomerId) {
        throw Object.assign(new Error("Forbidden (HTTP 403): Onboarding token belongs to another customer"), {
          statusCode: 403,
        });
      }
      return rec.customerId;
    }
    const verified = this.verifyDeviceAuth(req, rawBody);
    if (targetCustomerId && verified.customer.id !== targetCustomerId) {
      throw Object.assign(new Error("Forbidden (HTTP 403): Device belongs to another customer"), {
        statusCode: 403,
      });
    }
    return verified.customer.id;
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
          writeHtmlResponse(res, 200, renderConsumerUiHtml(), origin);
          return;
        }

        if (method === "GET" && pathname === "/health") {
          writeJsonResponse(res, 200, {
            service: "project3-consumer-app",
            status: "UP",
            banks: this.ctx.psp.listBanks(),
            airplaneMode: this.ctx.payEngine.simulateAirplaneMode,
          }, origin);
          return;
        }

        const { rawBody, json } = await readRawAndJsonBody(req);

        // Slice 04: Onboarding & Ed25519 Device Auth
        if (method === "POST" && pathname === "/api/signup") {
          const out = this.ctx.psp.signup({
            mobileNumber: String(json.mobileNumber ?? ""),
            fullName: String(json.fullName ?? "Anita Sharma"),
          });
          console.log(`[p3:consumer] Mock SMS OTP for ${out.customer.mobile_number}: ${out.mockSmsOtp}`);
          writeJsonResponse(res, 201, { customer: out.customer, smsSent: true }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/otp/verify") {
          const c = this.ctx.psp.verifySmsOtp(
            String(json.mobileNumber ?? ""),
            String(json.otp ?? "")
          );
          const onboardingToken = `ob_${crypto.randomBytes(24).toString("hex")}`;
          this.onboardingTokens.set(onboardingToken, {
            customerId: c.id,
            expiresAtMs: Date.now() + 15 * 60 * 1000,
          });
          writeJsonResponse(res, 200, { customer: c, onboardingToken }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/devices/bind") {
          const customerId = this.requireOnboardingOrDeviceAuth(
            req,
            rawBody,
            json.customerId ? String(json.customerId) : undefined
          );
          const bound = this.ctx.psp.bindDevice({
            customerId,
            deviceId: String(json.deviceId ?? ""),
            publicKeyPem: String(json.publicKeyPem ?? ""),
            deviceModel: String(json.deviceModel ?? "Browser WebCrypto"),
          });
          writeJsonResponse(res, 200, bound, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/pin/set") {
          const customerId = this.requireOnboardingOrDeviceAuth(
            req,
            rawBody,
            json.customerId ? String(json.customerId) : undefined
          );
          this.ctx.psp.setPin(customerId, String(json.rawPin ?? ""));
          writeJsonResponse(res, 200, { status: "PIN_SET" }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/pin/challenge") {
          const verified = this.verifyDeviceAuth(req, rawBody);
          const txnNonce = this.ctx.psp.issuePinChallengeNonce();
          writeJsonResponse(res, 200, {
            txnNonce,
            pinSalt: verified.customer.pin_salt ?? null,
          }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/accounts/discover") {
          this.requireOnboardingOrDeviceAuth(req, rawBody);
          const accounts = this.ctx.psp.discoverAccountsAtBank({
            bankId: String(json.bankId ?? "BANKA"),
            holderNameQuery: String(json.holderNameQuery ?? ""),
          });
          writeJsonResponse(res, 200, { accounts }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/accounts/link") {
          const customerId = this.requireOnboardingOrDeviceAuth(
            req,
            rawBody,
            json.customerId ? String(json.customerId) : undefined
          );
          const linked = this.ctx.psp.linkBankAccount({
            customerId,
            bankId: String(json.bankId ?? "BANKA"),
            accountNumber: String(json.accountNumber ?? "987654324521"),
            isPrimary: true,
          });
          writeJsonResponse(res, 201, linked, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/vpas") {
          const customerId = this.requireOnboardingOrDeviceAuth(
            req,
            rawBody,
            json.customerId ? String(json.customerId) : undefined
          );
          const vpa = this.ctx.payEngine.createVpa({
            customerId,
            linkedAccountId: String(json.linkedAccountId ?? ""),
            handle: String(json.handle ?? ""),
            isDefault: true,
          });
          writeJsonResponse(res, 201, vpa, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/pay") {
          const h = this.extractDeviceHeaders(req);
          const txnNonce = String(json.txnNonce ?? "").trim();
          const clientPinProofHex = String(json.clientPinProofHex ?? "").trim();
          if (!txnNonce || !clientPinProofHex) {
            writeJsonResponse(res, 400, {
              error: "txnNonce and clientPinProofHex (from /api/pin/challenge) are required",
            }, origin);
            return;
          }
          const tx = await this.ctx.payEngine.initiatePay({
            customerId: String(json.customerId ?? ""),
            deviceId: h.deviceId,
            timestampMs: h.timestampMs,
            nonce: h.nonce,
            payloadJson: rawBody,
            signatureBase64: h.signatureBase64,
            clientTxnId: String(json.clientTxnId ?? `CLNT-${Date.now()}`),
            payPath: (json.payPath as PayPathType) ?? "VPA",
            payerVpa: String(json.payerVpa ?? ""),
            qrUri: json.qrUri ? String(json.qrUri) : undefined,
            payeeVpa: json.payeeVpa ? String(json.payeeVpa) : undefined,
            payeeMobile: json.payeeMobile ? String(json.payeeMobile) : undefined,
            payeeAccountNumber: json.payeeAccountNumber ? String(json.payeeAccountNumber) : undefined,
            payeeIfsc: json.payeeIfsc ? String(json.payeeIfsc) : undefined,
            amountPaise: json.amountPaise !== undefined ? Number(json.amountPaise) : undefined,
            rawPin: String(json.rawPin ?? ""),
            txnNonce,
            clientPinProofHex,
          });
          writeJsonResponse(res, 200, tx, origin);
          return;
        }

        const txMatch = pathname.match(/^\/api\/transactions\/([^/]+)$/);
        if (method === "GET" && txMatch) {
          this.verifyDeviceAuth(req, rawBody);
          const tx = this.ctx.payEngine.getStatusByClientTxnId(decodeURIComponent(txMatch[1]));
          writeJsonResponse(res, 200, tx, origin);
          return;
        }

        if (method === "PUT" && pathname === "/api/chaos/airplane-mode") {
          this.requireOpsToken(req);
          this.ctx.payEngine.simulateAirplaneMode = Boolean(json.enabled);
          writeJsonResponse(res, 200, { airplaneMode: this.ctx.payEngine.simulateAirplaneMode }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/collects") {
          this.verifyDeviceAuth(req, rawBody);
          const out = this.ctx.collects.createCollectRequest({
            requesterVpa: String(json.requesterVpa ?? ""),
            payerVpa: String(json.payerVpa ?? ""),
            amountPaise: Number(json.amountPaise ?? 10_000),
            note: json.note ? String(json.note) : undefined,
          });
          writeJsonResponse(res, 201, out, origin);
          return;
        }

        const colApproveMatch = pathname.match(/^\/api\/collects\/([^/]+)\/approve$/);
        if (method === "POST" && colApproveMatch) {
          const verified = this.verifyDeviceAuth(req, rawBody);
          const rawPin = String(json.rawPin ?? "");
          const txnNonce = String(json.txnNonce ?? this.ctx.psp.issuePinChallengeNonce());
          const clientPinProofHex = json.clientPinProofHex
            ? String(json.clientPinProofHex)
            : this.ctx.psp.computeClientNoncePinProof({
                customerId: verified.customer.id,
                rawPin,
                txnNonce,
              });
          const approved = await this.ctx.collects.approveCollectRequest({
            collectId: decodeURIComponent(colApproveMatch[1]),
            payerCustomerId: verified.customer.id,
            rawPin,
            txnNonce,
            clientPinProofHex,
          });
          writeJsonResponse(res, 200, approved, origin);
          return;
        }

        const colDeclineMatch = pathname.match(/^\/api\/collects\/([^/]+)\/decline$/);
        if (method === "POST" && colDeclineMatch) {
          this.verifyDeviceAuth(req, rawBody);
          const declined = this.ctx.collects.declineCollectRequest(
            decodeURIComponent(colDeclineMatch[1])
          );
          writeJsonResponse(res, 200, declined, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/collects/block") {
          this.verifyDeviceAuth(req, rawBody);
          this.ctx.collects.blockRequester(
            String(json.payerVpa ?? ""),
            String(json.requesterVpa ?? "")
          );
          writeJsonResponse(res, 200, { blocked: true }, origin);
          return;
        }

        // Slice 05: Ops Risk Engine, Shadow Mode & Dispute Desk
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
          writeJsonResponse(res, 200, decision, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/risk/blacklist") {
          this.ctx.risk.addToBlacklist(String(json.entityId ?? ""));
          writeJsonResponse(res, 200, { blacklisted: String(json.entityId ?? "") }, origin);
          return;
        }

        if (method === "PUT" && pathname === "/api/risk/timeout-fallback") {
          this.ctx.risk.simulateTimeoutFallback = Boolean(json.enabled);
          writeJsonResponse(res, 200, { fallbackEnabled: this.ctx.risk.simulateTimeoutFallback }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/risk/shadow/run-100") {
          // Scope batch diff strictly to this 100-payment run
          this.ctx.shadow.db
            .prepare(`DELETE FROM shadow_comparisons WHERE payment_id LIKE 'ui_shd_%'`)
            .run();
          for (let i = 0; i < 100; i++) {
            const isNewCp = i >= 70;
            const amountPaise = i < 70 ? 50_000 : i < 90 ? 300_000 : 600_000;
            this.ctx.shadow.evaluateLivePayment({
              paymentId: `ui_shd_${Date.now()}_${i}`,
              features: { amount_paise: amountPaise, is_new_counterparty: isNewCp },
            });
          }
          const report = this.ctx.shadow.generateShadowDiffReport("v1.0", "v2.0-strict");
          writeJsonResponse(res, 200, report, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/risk/shadow/promote") {
          const promoted = this.ctx.shadow.promoteShadowToActive("v2.0-strict");
          writeJsonResponse(res, 200, promoted, origin);
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
          writeJsonResponse(res, 201, d, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/disputes/switch-reversal") {
          const resolved = this.ctx.disputes.handleSwitchReversalEvent({
            switchRrn: String(json.switchRrn ?? ""),
            reversalReference: String(json.reversalReference ?? `REV-${Date.now()}`),
          });
          writeJsonResponse(res, 200, { resolved }, origin);
          return;
        }

        const escMatch = pathname.match(/^\/api\/disputes\/([^/]+)\/escalate$/);
        if (method === "POST" && escMatch) {
          const id = decodeURIComponent(escMatch[1]);
          const curr = this.ctx.disputes.getDispute(id);
          if (!curr) {
            writeJsonResponse(res, 404, { error: `Dispute "${id}" not found` }, origin);
            return;
          }
          if (curr.state === "OPEN") {
            this.ctx.disputes.transitionDispute({ disputeId: id, toState: "UNDER_REVIEW" });
          }
          const esc = this.ctx.disputes.transitionDispute({
            disputeId: id,
            toState: "ESCALATED",
            resolutionNote: String(json.reason ?? "Escalated via Ops Console"),
          });
          writeJsonResponse(res, 200, esc, origin);
          return;
        }

        const cfMatch = pathname.match(/^\/api\/disputes\/([^/]+)\/case-file$/);
        if (method === "GET" && cfMatch) {
          const cf = this.ctx.disputes.generateEscalatedCaseFile(decodeURIComponent(cfMatch[1]));
          writeJsonResponse(res, 200, cf, origin);
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
