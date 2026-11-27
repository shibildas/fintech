import http from "node:http";
import crypto from "node:crypto";
import {
  buildCorsHeaders,
  mapErrorToHttpStatus,
  readRawAndJsonBody,
  timingSafeTokenEqual,
  writeJsonResponse,
  writeHtmlResponse,
  validateIndianMobile,
  validateNonEmptyString,
  validatePinOrOtp,
  validatePositivePaise,
} from "@fintech/core";
import type { PayPathType } from "./pay-flows.ts";
import { renderConsumerUiHtml } from "./consumer-ui.ts";
import type { ConsumerHttpServerContext } from "./consumer-context.ts";
import { handleConsumerOpsRoute } from "./consumer-ops-routes.ts";

export {
  createPersistentConsumerContext,
  type ConsumerHttpServerContext,
} from "./consumer-context.ts";

/**
 * Slices 04 & 05 — Project 3 Live HTTP Server (:3003)
 */
export class ConsumerHttpServer {
  public readonly ctx: ConsumerHttpServerContext;
  private readonly onboardingTokens = new Map<
    string,
    { customerId: string; expiresAtMs: number }
  >();

  constructor(ctx: ConsumerHttpServerContext) {
    this.ctx = ctx;
  }

  private requireOpsToken(req: http.IncomingMessage): void {
    const session = this.ctx.uiAuth.getSessionFromHeaders(req.headers);
    if (session) {
      if (session.role !== "admin") {
        throw Object.assign(
          new Error("Forbidden (HTTP 403): Admin role required for Risk, Disputes & Chaos"),
          { statusCode: 403 }
        );
      }
      return;
    }
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
    return this.ctx.psp.verifyDeviceSignedRequest({
      ...this.extractDeviceHeaders(req),
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
        throw Object.assign(
          new Error("Unauthorized (HTTP 401): Invalid or expired X-Onboarding-Token"),
          { statusCode: 401 }
        );
      }
      if (targetCustomerId && rec.customerId !== targetCustomerId) {
        throw Object.assign(
          new Error("Forbidden (HTTP 403): Onboarding token belongs to another customer"),
          { statusCode: 403 }
        );
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
          writeJsonResponse(
            res,
            200,
            {
              service: "project3-consumer-app",
              status: "UP",
              banks: this.ctx.psp.listBanks(),
              airplaneMode: this.ctx.payEngine.simulateAirplaneMode,
            },
            origin
          );
          return;
        }

        const { rawBody, json } = await readRawAndJsonBody(req);

        // UI Session Auth (scrypt hashed passwords in SQLite + HttpOnly cookie)
        if (method === "GET" && pathname === "/api/auth/me") {
          const user = this.ctx.uiAuth.getSessionFromHeaders(req.headers);
          writeJsonResponse(res, 200, { authenticated: Boolean(user), user }, origin);
          return;
        }
        if (method === "POST" && pathname === "/api/auth/login") {
          const out = this.ctx.uiAuth.login(
            String(json.username ?? ""),
            String(json.password ?? "")
          );
          if (!out) {
            writeJsonResponse(res, 401, { error: "Invalid username or password" }, origin);
            return;
          }
          writeJsonResponse(res, 200, { user: out.user }, origin, {
            "set-cookie": out.setCookieHeader,
          });
          return;
        }
        if (method === "POST" && pathname === "/api/auth/logout") {
          const clearCookie = this.ctx.uiAuth.logoutFromHeaders(req.headers);
          writeJsonResponse(res, 200, { loggedOut: true }, origin, { "set-cookie": clearCookie });
          return;
        }

        if (method === "POST" && pathname === "/api/signup") {
          const mobileNumber = validateIndianMobile(json.mobileNumber, "mobileNumber");
          const fullName = validateNonEmptyString(
            json.fullName ?? "Anita Sharma",
            "fullName",
            2,
            80
          );
          const out = this.ctx.psp.signup({ mobileNumber, fullName });
          console.log(
            `[p3:consumer] Mock SMS OTP for ${out.customer.mobile_number}: ${out.mockSmsOtp}`
          );
          writeJsonResponse(res, 201, { customer: out.customer, smsSent: true }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/otp/verify") {
          const mobileNumber = validateIndianMobile(json.mobileNumber, "mobileNumber");
          const otp = validatePinOrOtp(json.otp, "otp");
          const c = this.ctx.psp.verifySmsOtp(mobileNumber, otp);
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
          writeJsonResponse(
            res,
            200,
            this.ctx.psp.bindDevice({
              customerId,
              deviceId: String(json.deviceId ?? ""),
              publicKeyPem: String(json.publicKeyPem ?? ""),
              deviceModel: String(json.deviceModel ?? "Browser WebCrypto"),
            }),
            origin
          );
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
          writeJsonResponse(
            res,
            200,
            {
              txnNonce: this.ctx.psp.issuePinChallengeNonce(),
              pinSalt: verified.customer.pin_salt ?? null,
            },
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/accounts/discover") {
          this.requireOnboardingOrDeviceAuth(req, rawBody);
          writeJsonResponse(
            res,
            200,
            {
              accounts: this.ctx.psp.discoverAccountsAtBank({
                bankId: String(json.bankId ?? "BANKA"),
                holderNameQuery: String(json.holderNameQuery ?? ""),
              }),
            },
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/accounts/link") {
          const customerId = this.requireOnboardingOrDeviceAuth(
            req,
            rawBody,
            json.customerId ? String(json.customerId) : undefined
          );
          writeJsonResponse(
            res,
            201,
            this.ctx.psp.linkBankAccount({
              customerId,
              bankId: String(json.bankId ?? "BANKA"),
              accountNumber: String(json.accountNumber ?? "987654324521"),
              isPrimary: true,
            }),
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/vpas") {
          const customerId = this.requireOnboardingOrDeviceAuth(
            req,
            rawBody,
            json.customerId ? String(json.customerId) : undefined
          );
          writeJsonResponse(
            res,
            201,
            this.ctx.payEngine.createVpa({
              customerId,
              linkedAccountId: String(json.linkedAccountId ?? ""),
              handle: String(json.handle ?? ""),
              isDefault: true,
            }),
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/pay") {
          const h = this.extractDeviceHeaders(req);
          const txnNonce = String(json.txnNonce ?? "").trim();
          const clientPinProofHex = String(json.clientPinProofHex ?? "").trim();
          if (!txnNonce || !clientPinProofHex) {
            writeJsonResponse(
              res,
              400,
              { error: "txnNonce and clientPinProofHex (from /api/pin/challenge) are required" },
              origin
            );
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
            payeeAccountNumber: json.payeeAccountNumber
              ? String(json.payeeAccountNumber)
              : undefined,
            payeeIfsc: json.payeeIfsc ? String(json.payeeIfsc) : undefined,
            amountPaise:
              json.amountPaise !== undefined
                ? validatePositivePaise(json.amountPaise, "amountPaise")
                : undefined,
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
          writeJsonResponse(
            res,
            200,
            this.ctx.payEngine.getStatusByClientTxnId(decodeURIComponent(txMatch[1])),
            origin
          );
          return;
        }

        if (method === "PUT" && pathname === "/api/chaos/airplane-mode") {
          this.requireOpsToken(req);
          this.ctx.payEngine.simulateAirplaneMode = Boolean(json.enabled);
          writeJsonResponse(
            res,
            200,
            { airplaneMode: this.ctx.payEngine.simulateAirplaneMode },
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/collects") {
          this.verifyDeviceAuth(req, rawBody);
          writeJsonResponse(
            res,
            201,
            this.ctx.collects.createCollectRequest({
              requesterVpa: String(json.requesterVpa ?? ""),
              payerVpa: String(json.payerVpa ?? ""),
              amountPaise: Number(json.amountPaise ?? 10_000),
              note: json.note ? String(json.note) : undefined,
            }),
            origin
          );
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
          writeJsonResponse(
            res,
            200,
            await this.ctx.collects.approveCollectRequest({
              collectId: decodeURIComponent(colApproveMatch[1]),
              payerCustomerId: verified.customer.id,
              rawPin,
              txnNonce,
              clientPinProofHex,
            }),
            origin
          );
          return;
        }

        const colDeclineMatch = pathname.match(/^\/api\/collects\/([^/]+)\/decline$/);
        if (method === "POST" && colDeclineMatch) {
          this.verifyDeviceAuth(req, rawBody);
          writeJsonResponse(
            res,
            200,
            this.ctx.collects.declineCollectRequest(decodeURIComponent(colDeclineMatch[1])),
            origin
          );
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

        if (pathname.startsWith("/api/risk/") || pathname.startsWith("/api/disputes")) {
          this.requireOpsToken(req);
          if (handleConsumerOpsRoute({ ctx: this.ctx, method, pathname, json, res, origin })) {
            return;
          }
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
