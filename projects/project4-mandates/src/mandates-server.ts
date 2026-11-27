import http from "node:http";
import {
  buildCorsHeaders,
  mapErrorToHttpStatus,
  readRawAndJsonBody,
  timingSafeTokenEqual,
  writeJsonResponse,
  writeHtmlResponse,
  validateAnchorDay,
  validatePinOrOtp,
  validatePositivePaise,
  validateVpa,
} from "@fintech/core";
import type { MandateRail } from "./mandate-service.ts";
import { renderMandatesUiHtml } from "./mandates-ui.ts";
import type { MandatesHttpServerContext } from "./mandates-context.ts";
import { handleMandatesBillingRoute } from "./mandates-billing-routes.ts";

export {
  createPersistentMandatesContext,
  type MandatesHttpServerContext,
} from "./mandates-context.ts";

/**
 * Slice 06 — Project 4 Live HTTP Server (:3004)
 */
export class MandatesHttpServer {
  public readonly ctx: MandatesHttpServerContext;

  constructor(ctx: MandatesHttpServerContext) {
    this.ctx = ctx;
  }

  private requireMerchantAuth(req: http.IncomingMessage): { uiRole: "user" | "admin" } {
    const session = this.ctx.uiAuth.getSessionFromHeaders(req.headers);
    if (session) {
      return { uiRole: session.role };
    }
    const token = String(req.headers["x-merchant-token"] ?? "").trim();
    if (!timingSafeTokenEqual(token, this.ctx.merchantToken)) {
      throw Object.assign(
        new Error("Unauthorized (HTTP 401): Missing session cookie or X-Merchant-Token"),
        { statusCode: 401 }
      );
    }
    return { uiRole: "admin" };
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
          writeHtmlResponse(res, 200, renderMandatesUiHtml(), origin);
          return;
        }
        if (method === "GET" && pathname === "/health") {
          writeJsonResponse(
            res,
            200,
            {
              service: "project4-mandates",
              status: "UP",
              fakeClockUtc: this.ctx.clock.now().toISOString(),
              rails: ["UPI_AUTOPAY", "E_NACH"],
            },
            origin
          );
          return;
        }

        const { json } = await readRawAndJsonBody(req);

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

        const auth = this.requireMerchantAuth(req);

        if (method === "GET" && pathname === "/api/clock") {
          const now = this.ctx.clock.now();
          const ist = new Date(now.getTime() + 330 * 60 * 1000)
            .toISOString()
            .replace("Z", "+05:30");
          writeJsonResponse(res, 200, { utc: now.toISOString(), ist }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/clock/advance") {
          if (auth.uiRole !== "admin") {
            throw Object.assign(
              new Error("Forbidden (HTTP 403): Admin role required to advance Fake Clock"),
              { statusCode: 403 }
            );
          }
          if (json.setIso !== undefined) {
            const isoStr = String(json.setIso);
            if (Number.isNaN(Date.parse(isoStr))) {
              throw Object.assign(new Error("Invalid setIso timestamp"), { statusCode: 400 });
            }
            this.ctx.clock.setTime(isoStr);
          } else if (json.hours !== undefined) {
            const h = Number(json.hours);
            if (!Number.isFinite(h)) {
              throw Object.assign(new Error("hours must be a finite number"), { statusCode: 400 });
            }
            this.ctx.clock.advanceByHours(h);
          } else if (json.days !== undefined) {
            const d = Number(json.days);
            if (!Number.isFinite(d)) {
              throw Object.assign(new Error("days must be a finite number"), { statusCode: 400 });
            }
            this.ctx.clock.advanceByDays(d);
          }
          this.ctx.persistClock();
          const now = this.ctx.clock.now();
          const ist = new Date(now.getTime() + 330 * 60 * 1000)
            .toISOString()
            .replace("Z", "+05:30");
          writeJsonResponse(res, 200, { utc: now.toISOString(), ist }, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/mandates") {
          const rows = this.ctx.mandates.db
            .prepare(
              `SELECT * FROM mandates WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50`
            )
            .all(this.ctx.merchantId);
          writeJsonResponse(res, 200, { mandates: rows }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/mandates") {
          const payerVpa = validateVpa(json.payerVpa ?? "anita@psp1", "payerVpa");
          const maxAmountPaise = validatePositivePaise(
            json.maxAmountPaise ?? 100_000,
            "maxAmountPaise"
          );
          const monthlyAggregateCapPaise = validatePositivePaise(
            json.monthlyAggregateCapPaise ?? 300_000,
            "monthlyAggregateCapPaise"
          );
          writeJsonResponse(
            res,
            201,
            this.ctx.mandates.createMandate({
              merchantId: this.ctx.merchantId,
              customerId: String(json.customerId ?? "cust_anita"),
              payerVpa,
              bankId: String(json.bankId ?? "BANKA"),
              accountNumberMasked: String(json.accountNumberMasked ?? "XXXX4521"),
              rail: (json.rail as MandateRail) ?? "UPI_AUTOPAY",
              maxAmountPaise,
              monthlyAggregateCapPaise,
              validUntilIso: String(json.validUntilIso ?? "2029-12-31T00:00:00.000Z"),
              now: this.ctx.clock.now(),
            }),
            origin
          );
          return;
        }

        const mAuth = pathname.match(/^\/api\/mandates\/([^/]+)\/authorize$/);
        if (method === "POST" && mAuth) {
          const authCredential = validatePinOrOtp(json.authCredential, "authCredential");
          writeJsonResponse(
            res,
            200,
            this.ctx.mandates.authorizeMandate({
              mandateId: decodeURIComponent(mAuth[1]),
              authCredential,
              now: this.ctx.clock.now(),
            }),
            origin
          );
          return;
        }

        const mCap = pathname.match(/^\/api\/mandates\/([^/]+)\/cap$/);
        if (method === "POST" && mCap) {
          writeJsonResponse(
            res,
            200,
            this.ctx.mandates.requestCapModification({
              mandateId: decodeURIComponent(mCap[1]),
              newMaxAmountPaise: Number(json.newMaxAmountPaise ?? 150_000),
              newMonthlyAggregateCapPaise: Number(json.newMonthlyAggregateCapPaise ?? 300_000),
              now: this.ctx.clock.now(),
            }),
            origin
          );
          return;
        }

        const mReauth = pathname.match(/^\/api\/mandates\/([^/]+)\/reauth$/);
        if (method === "POST" && mReauth) {
          writeJsonResponse(
            res,
            200,
            this.ctx.mandates.confirmCapIncreaseReauth({
              mandateId: decodeURIComponent(mReauth[1]),
              authCredential: String(json.authCredential ?? ""),
              now: this.ctx.clock.now(),
            }),
            origin
          );
          return;
        }

        const mRevoke = pathname.match(/^\/api\/mandates\/([^/]+)\/revoke$/);
        if (method === "POST" && mRevoke) {
          writeJsonResponse(
            res,
            200,
            this.ctx.mandates.revokeMandate(
              decodeURIComponent(mRevoke[1]),
              String(json.reason ?? "Customer revoked via UI"),
              this.ctx.clock.now()
            ),
            origin
          );
          return;
        }

        if (method === "POST" && pathname === "/api/plans") {
          const amountPaise = validatePositivePaise(json.amountPaise ?? 49_900, "amountPaise");
          writeJsonResponse(
            res,
            201,
            this.ctx.subs.createPlan({
              merchantId: this.ctx.merchantId,
              name: String(json.name ?? "SaaS Pro Monthly"),
              interval: (json.interval as "MONTHLY" | "YEARLY") ?? "MONTHLY",
              amountPaise,
            }),
            origin
          );
          return;
        }

        if (method === "GET" && pathname === "/api/subscriptions") {
          const rows = this.ctx.subs.db
            .prepare(
              `SELECT * FROM subscriptions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50`
            )
            .all(this.ctx.merchantId);
          writeJsonResponse(res, 200, { subscriptions: rows }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/subscriptions") {
          const anchorDay = validateAnchorDay(json.anchorDay ?? 31);
          const sub = this.ctx.subs.createSubscription({
            merchantId: this.ctx.merchantId,
            customerId: String(json.customerId ?? "cust_anita"),
            planId: String(json.planId ?? ""),
            mandateId: String(json.mandateId ?? ""),
            anchorDay,
            startYear: json.startYear ? Number(json.startYear) : 2026,
            startMonth1Based: json.startMonth1Based ? Number(json.startMonth1Based) : 1,
          });
          writeJsonResponse(
            res,
            201,
            json.autoActivate === false ? sub : this.ctx.subs.activateSubscription(sub.id),
            origin
          );
          return;
        }

        const sAct = pathname.match(/^\/api\/subscriptions\/([^/]+)\/activate$/);
        if (method === "POST" && sAct) {
          writeJsonResponse(
            res,
            200,
            this.ctx.subs.activateSubscription(decodeURIComponent(sAct[1])),
            origin
          );
          return;
        }

        const sChange = pathname.match(/^\/api\/subscriptions\/([^/]+)\/change-plan$/);
        if (method === "POST" && sChange) {
          writeJsonResponse(
            res,
            200,
            this.ctx.subs.changeSubscriptionPlan({
              subscriptionId: decodeURIComponent(sChange[1]),
              newPlanId: String(json.newPlanId ?? ""),
              remainingDays: Number(json.remainingDays ?? 15),
              totalCycleDays: Number(json.totalCycleDays ?? 30),
            }),
            origin
          );
          return;
        }

        const sAdv = pathname.match(/^\/api\/subscriptions\/([^/]+)\/advance-anchor$/);
        if (method === "POST" && sAdv) {
          writeJsonResponse(
            res,
            200,
            this.ctx.subs.advanceToNextBillingCycle(decodeURIComponent(sAdv[1])),
            origin
          );
          return;
        }

        if (
          await handleMandatesBillingRoute({ ctx: this.ctx, method, pathname, json, res, origin })
        ) {
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
