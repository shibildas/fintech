import type http from "node:http";
import { writeJsonResponse } from "@fintech/core";
import type { DisputeCategory } from "./dispute-desk.ts";
import type { ConsumerHttpServerContext } from "./consumer-context.ts";

/**
 * Slice 05 — Ops Risk Engine, Shadow Mode & Dispute Desk route handler.
 * Returns true if the route was handled.
 */
export function handleConsumerOpsRoute(params: {
  ctx: ConsumerHttpServerContext;
  method: string;
  pathname: string;
  json: Record<string, unknown>;
  res: http.ServerResponse;
  origin?: string;
}): boolean {
  const { ctx, method, pathname, json, res, origin } = params;

  if (method === "POST" && pathname === "/api/risk/score") {
    const decision = ctx.risk.scorePayment({
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
    return true;
  }

  if (method === "POST" && pathname === "/api/risk/blacklist") {
    ctx.risk.addToBlacklist(String(json.entityId ?? ""));
    writeJsonResponse(res, 200, { blacklisted: String(json.entityId ?? "") }, origin);
    return true;
  }

  if (method === "PUT" && pathname === "/api/risk/timeout-fallback") {
    ctx.risk.simulateTimeoutFallback = Boolean(json.enabled);
    writeJsonResponse(res, 200, { fallbackEnabled: ctx.risk.simulateTimeoutFallback }, origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/risk/shadow/run-100") {
    ctx.shadow.db.prepare(`DELETE FROM shadow_comparisons WHERE payment_id LIKE 'ui_shd_%'`).run();
    for (let i = 0; i < 100; i++) {
      const isNewCp = i >= 70;
      const amountPaise = i < 70 ? 50_000 : i < 90 ? 300_000 : 600_000;
      ctx.shadow.evaluateLivePayment({
        paymentId: `ui_shd_${Date.now()}_${i}`,
        features: { amount_paise: amountPaise, is_new_counterparty: isNewCp },
      });
    }
    writeJsonResponse(res, 200, ctx.shadow.generateShadowDiffReport("v1.0", "v2.0-strict"), origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/risk/shadow/promote") {
    writeJsonResponse(res, 200, ctx.shadow.promoteShadowToActive("v2.0-strict"), origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/disputes") {
    const d = ctx.disputes.openDispute({
      customerId: String(json.customerId ?? "cust_anita"),
      switchRrn: String(json.switchRrn ?? "632810000123"),
      category: (json.category as DisputeCategory) ?? "DEBITED_NOT_CREDITED",
      amountPaise: Number(json.amountPaise ?? 50_000),
      customerNote: String(json.customerNote ?? "Debited but not credited"),
    });
    writeJsonResponse(res, 201, d, origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/disputes/switch-reversal") {
    const resolved = ctx.disputes.handleSwitchReversalEvent({
      switchRrn: String(json.switchRrn ?? ""),
      reversalReference: String(json.reversalReference ?? `REV-${Date.now()}`),
    });
    writeJsonResponse(res, 200, { resolved }, origin);
    return true;
  }

  const escMatch = pathname.match(/^\/api\/disputes\/([^/]+)\/escalate$/);
  if (method === "POST" && escMatch) {
    const id = decodeURIComponent(escMatch[1]);
    const curr = ctx.disputes.getDispute(id);
    if (!curr) {
      writeJsonResponse(res, 404, { error: `Dispute "${id}" not found` }, origin);
      return true;
    }
    if (curr.state === "OPEN") {
      ctx.disputes.transitionDispute({ disputeId: id, toState: "UNDER_REVIEW" });
    }
    const esc = ctx.disputes.transitionDispute({
      disputeId: id,
      toState: "ESCALATED",
      resolutionNote: String(json.reason ?? "Escalated via Ops Console"),
    });
    writeJsonResponse(res, 200, esc, origin);
    return true;
  }

  const cfMatch = pathname.match(/^\/api\/disputes\/([^/]+)\/case-file$/);
  if (method === "GET" && cfMatch) {
    writeJsonResponse(
      res,
      200,
      ctx.disputes.generateEscalatedCaseFile(decodeURIComponent(cfMatch[1])),
      origin
    );
    return true;
  }

  return false;
}
