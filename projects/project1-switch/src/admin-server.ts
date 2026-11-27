import http from "node:http";
import crypto from "node:crypto";
import {
  redactSensitiveData,
  buildCorsHeaders,
  maskAccountNumber,
  timingSafeTokenEqual,
  readRawAndJsonBody,
  UiAuthStore,
} from "../../../packages/core/src/index.ts";
import { renderSwitchAdminHtml } from "./admin-ui.ts";
import { CentralSwitch } from "./switch-engine.ts";
import { SettlementEngine } from "./settlement-engine.ts";
import { ReconciliationEngine, type ExceptionResolutionAction } from "./reconciliation-engine.ts";
import type { SeededProject1Topology } from "./seed.ts";
import type { BankChaosConfig } from "./bank-core.ts";

/**
 * Project 1 — Switch HTTP API + Web Admin Console + RBAC + Observability
 * (Requirements 25, 26, 27, Interfaces Pages 9–10, Common Rules 8, 11, 12, 13)
 *
 * Roles (Common Rule 11):
 * - `operator`: Can read dashboards, run settlement/reconciliation, and resolve exceptions.
 * - `admin`: Can do everything `operator` does PLUS change participant status, chaos config, and system settings.
 */

export type ConsoleRole = "operator" | "admin";

export interface ApiRequest {
  method: string;
  path: string;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface ApiResponse<T = unknown> {
  statusCode: number;
  headers: Record<string, string>;
  body: T;
}

export class SwitchAdminApp {
  public readonly sw: CentralSwitch;
  public readonly settlement: SettlementEngine;
  public readonly reconciliation: ReconciliationEngine;
  public readonly topology: SeededProject1Topology;

  private readonly routeLatenciesMs = new Map<string, number[]>();
  private readonly routeCounts = new Map<
    string,
    { total: number; success: number; error: number }
  >();
  public readonly structuredLogs: Array<Record<string, unknown>> = [];
  public readonly uiAuth: UiAuthStore;
  private readonly adminToken?: string;

  constructor(params: {
    sw: CentralSwitch;
    topology: SeededProject1Topology;
    adminToken?: string;
  }) {
    this.sw = params.sw;
    this.topology = params.topology;
    this.adminToken = params.adminToken;
    this.settlement = new SettlementEngine(this.sw.db, this.sw.audit);
    this.reconciliation = new ReconciliationEngine(this.sw.db, this.sw.audit);
    this.uiAuth = new UiAuthStore({
      db: this.sw.db,
      cookieName: "fintech_sess_p1",
      seedUsers: [
        {
          username: "switch.ops",
          password: process.env.P1_USER_PASSWORD ?? "SwitchUser#2026",
          role: "user",
          displayName: "Switch Operator",
        },
        {
          username: "switch.admin",
          password: process.env.P1_ADMIN_PASSWORD ?? "SwitchAdmin#2026",
          role: "admin",
          displayName: "Switch Admin",
        },
      ],
    });
  }

  /**
   * Common Rule 11: Enforces RBAC via either HttpOnly UI session cookie or strict `X-Admin-Token`.
   */
  private requireRole(
    headers: Record<string, string | undefined>,
    minimumRole: ConsoleRole
  ): { actorId: string; role: ConsoleRole } {
    const session = this.uiAuth.getSessionFromHeaders(headers);
    if (session) {
      const mappedRole: ConsoleRole = session.role === "admin" ? "admin" : "operator";
      if (minimumRole === "admin" && mappedRole !== "admin") {
        throw Object.assign(
          new Error(
            "Rule 11 RBAC Violation (HTTP 403): Admin role required to modify configuration or chaos rules"
          ),
          { statusCode: 403 }
        );
      }
      return { actorId: session.username, role: mappedRole };
    }

    if (this.adminToken) {
      const providedToken = headers["x-admin-token"] ?? headers["X-Admin-Token"];
      if (!timingSafeTokenEqual(providedToken, this.adminToken)) {
        throw Object.assign(
          new Error("Unauthorized (HTTP 401): Missing or invalid X-Admin-Token"),
          { statusCode: 401 }
        );
      }
    }
    const rawRole = (headers["x-role"] ?? headers["X-Role"] ?? "operator").toLowerCase().trim();
    const actorId = headers["x-actor-id"] ?? headers["X-Actor-Id"] ?? `user-${rawRole}`;

    if (rawRole !== "operator" && rawRole !== "admin") {
      throw Object.assign(new Error("Forbidden: Invalid role"), { statusCode: 403 });
    }
    if (minimumRole === "admin" && rawRole !== "admin") {
      throw Object.assign(
        new Error(
          "Rule 11 RBAC Violation (HTTP 403): Admin role required to modify configuration or chaos rules"
        ),
        { statusCode: 403 }
      );
    }
    return { actorId, role: rawRole as ConsoleRole };
  }

  /**
   * Dispatches any REST or Admin Console request (works both in-process for fast tests
   * and over HTTP via `createHttpServer()`).
   */
  public async dispatch(req: ApiRequest): Promise<ApiResponse> {
    const startMs = performance.now();
    const headers = req.headers ?? {};
    const requestId = headers["x-request-id"] ?? `REQ-${crypto.randomUUID().slice(0, 8)}`;
    const url = new URL(req.path, "http://localhost");
    const pathname = url.pathname;
    const routeKey = `${req.method.toUpperCase()} ${pathname}`;

    const cors = buildCorsHeaders(headers["origin"] ?? headers["Origin"]);
    try {
      const response = await this.route(
        req.method.toUpperCase(),
        pathname,
        url.searchParams,
        headers,
        req.body,
        requestId
      );
      this.recordRouteMetric(routeKey, performance.now() - startMs, response.statusCode < 400);
      this.logStructured("INFO", requestId, routeKey, response.statusCode, req.body);
      return {
        ...response,
        headers: {
          ...cors,
          "x-request-id": requestId,
          ...response.headers,
        },
      };
    } catch (err: unknown) {
      const statusCode = (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      this.recordRouteMetric(routeKey, performance.now() - startMs, false);
      this.logStructured("ERROR", requestId, routeKey, statusCode, { error: message });
      return {
        statusCode,
        headers: {
          ...cors,
          "content-type": "application/json",
          "x-request-id": requestId,
        },
        body: { error: message, request_id: requestId },
      };
    }
  }

  private async route(
    method: string,
    pathname: string,
    query: URLSearchParams,
    headers: Record<string, string | undefined>,
    body: unknown,
    requestId: string
  ): Promise<ApiResponse> {
    if (method === "OPTIONS") {
      return {
        statusCode: 204,
        headers: buildCorsHeaders(headers["origin"] ?? headers["Origin"]),
        body: "",
      };
    }

    // UI Session Auth (scrypt hashed passwords in SQLite + HttpOnly cookie)
    if (method === "GET" && pathname === "/api/auth/me") {
      const user = this.uiAuth.getSessionFromHeaders(headers);
      return this.json(200, { authenticated: Boolean(user), user });
    }
    if (method === "POST" && pathname === "/api/auth/login") {
      const p = (body ?? {}) as { username?: string; password?: string };
      const out = this.uiAuth.login(String(p.username ?? ""), String(p.password ?? ""));
      if (!out) {
        return this.json(401, { error: "Invalid username or password" });
      }
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "set-cookie": out.setCookieHeader },
        body: { user: out.user },
      };
    }
    if (method === "POST" && pathname === "/api/auth/logout") {
      const clearCookie = this.uiAuth.logoutFromHeaders(headers);
      return {
        statusCode: 200,
        headers: { "content-type": "application/json", "set-cookie": clearCookie },
        body: { loggedOut: true },
      };
    }

    // Live Balances & Interactive Demo Pay endpoints (Slice 01)
    if (method === "GET" && pathname === "/api/balances") {
      this.requireRole(headers, "operator");
      const accounts = [
        { bank: "BANKA", vpa: "anita@psp1", acct: "987654324521", sim: this.topology.banks.BANKA },
        { bank: "BANKB", vpa: "rahul@psp1", acct: "876543218899", sim: this.topology.banks.BANKB },
        { bank: "BANKB", vpa: "coffee@psp2", acct: "876543217766", sim: this.topology.banks.BANKB },
        { bank: "BANKC", vpa: "shop@psp2", acct: "765432103344", sim: this.topology.banks.BANKC },
      ].map((item) => {
        const b = item.sim.ledger.getBalance(item.acct);
        return {
          bank: item.bank,
          vpa: item.vpa,
          account_masked: maskAccountNumber(item.acct),
          ledger_balance_paise: b.ledger_balance_paise,
          available_balance_paise: b.available_balance_paise,
        };
      });
      return this.json(200, { active_cycle_id: this.sw.activeCycleId, accounts });
    }

    if (method === "POST" && pathname === "/api/pay-demo") {
      this.requireRole(headers, "operator");
      const p = (body ?? {}) as {
        payerVpa?: string;
        payeeVpa?: string;
        amountPaise?: number;
        rawPin?: string;
        transactionId?: string;
      };
      const payerVpa = (p.payerVpa ?? "anita@psp1").toLowerCase();
      const psp = payerVpa.endsWith("@psp2") ? this.topology.psps.PSP2 : this.topology.psps.PSP1;
      const env = psp.createSignedRequestEnvelope({
        mti: "0200",
        processingCode: "PAY",
        transactionId: p.transactionId ?? `UI-TXN-${crypto.randomUUID().slice(0, 8)}`,
        payerVpa,
        payeeVpa: (p.payeeVpa ?? "shop@psp2").toLowerCase(),
        amountPaise: Number(p.amountPaise ?? 10_000),
      });
      const rawPin = typeof p.rawPin === "string" ? p.rawPin.trim() : "";
      if (!rawPin) {
        return this.json(400, { error: "rawPin is required for /api/pay-demo" });
      }
      const result = await this.sw.handlePay({
        envelope: env,
        rawPin,
      });
      return this.json(200, {
        transaction: result.transaction,
        hops: result.hops,
        state_history: this.sw.listStateHistoryByRrn(result.transaction.rrn),
      });
    }
    // 1. Common Rule 12: Health & Prometheus Metrics Endpoints
    if (method === "GET" && pathname === "/health") {
      return this.json(200, {
        service: "project1-upi-switch",
        status: "UP",
        active_cycle_id: this.sw.activeCycleId,
        participants: this.sw.listParticipants().map((p) => ({
          id: p.id,
          type: p.type,
          status: p.status,
        })),
      });
    }

    if (method === "GET" && pathname === "/metrics") {
      return this.json(200, this.getMetricsSnapshot());
    }

    // 2. Web Admin Console HTML UI (Requirements 25, 26, 27)
    if (method === "GET" && (pathname === "/" || pathname === "/admin")) {
      return {
        statusCode: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: this.renderAdminConsoleHtml(),
      };
    }

    // 3. Interface: `GET /vpa/:handle` (Address Resolution)
    const vpaMatch = pathname.match(/^\/vpa\/([^/]+)$/);
    if (method === "GET" && vpaMatch) {
      const handle = decodeURIComponent(vpaMatch[1]).toLowerCase();
      const psp1Res = this.topology.psps.PSP1.lookupVpaExternal(handle);
      const psp2Res = this.topology.psps.PSP2.lookupVpaExternal(handle);
      const found = psp1Res ?? psp2Res;
      if (!found) {
        return this.json(404, { response_code: "14", message: "Invalid VPA" });
      }
      return this.json(200, found);
    }

    // 4. Interface: `POST /pay` (PSP -> Switch, Financial Request MTI 0200)
    if (method === "POST" && pathname === "/pay") {
      const payload = body as {
        envelope: Parameters<CentralSwitch["handlePay"]>[0]["envelope"];
        rawPin: string;
      };
      const result = await this.sw.handlePay({
        envelope: payload.envelope,
        rawPin: payload.rawPin,
      });
      return this.json(200, result);
    }

    // 5. Interface: `GET /transactions/:rrn` & `GET /transactions` (Req 12 & Req 25 Search)
    const txMatch = pathname.match(/^\/transactions\/([^/]+)$/);
    if (method === "GET" && txMatch) {
      this.requireRole(headers, "operator");
      const key = decodeURIComponent(txMatch[1]);
      const tx = this.sw.getTransactionByRrn(key) ?? this.sw.getTransactionById(key);
      if (!tx) {
        return this.json(404, { error: `Transaction "${key}" not found` });
      }
      return this.json(200, {
        transaction: tx,
        hops: this.sw.listMessageLogsByRrn(tx.rrn),
        state_history: this.sw.listStateHistoryByRrn(tx.rrn),
      });
    }

    if (method === "GET" && pathname === "/transactions") {
      this.requireRole(headers, "operator");
      const q = (query.get("q") ?? "").trim();
      const rows = q
        ? this.sw.db
            .prepare(
              `SELECT * FROM switch_transactions
               WHERE rrn = ? OR transaction_id = ? OR payer_vpa LIKE ? OR payee_vpa LIKE ? OR CAST(amount_paise AS TEXT) = ?
               ORDER BY created_at DESC LIMIT 100`
            )
            .all(q, q, `%${q}%`, `%${q}%`, q)
        : this.sw.db
            .prepare(`SELECT * FROM switch_transactions ORDER BY created_at DESC LIMIT 100`)
            .all();
      return this.json(200, { transactions: rows });
    }

    // 6. Interface: `PUT /participants/:id/chaos` (Req 15 & Rule 11 Admin RBAC)
    const chaosMatch = pathname.match(/^\/participants\/([^/]+)\/chaos$/);
    if (method === "PUT" && chaosMatch) {
      const { actorId } = this.requireRole(headers, "admin");
      const bankId = decodeURIComponent(chaosMatch[1]).toUpperCase() as "BANKA" | "BANKB" | "BANKC";
      const bank = this.topology.banks[bankId];
      if (!bank) {
        return this.json(404, { error: `Bank "${bankId}" not found` });
      }
      const updated = bank.setChaosConfig(body as Partial<BankChaosConfig>, actorId, requestId);
      return this.json(200, { bank_id: bankId, chaos: updated });
    }

    // 7. Interface: `POST /cycles/:id/run` & `GET /cycles/:id/files` (Settlement Reqs 17–20)
    const cycleRunMatch = pathname.match(/^\/cycles\/([^/]+)\/run$/);
    if (method === "POST" && cycleRunMatch) {
      const { actorId } = this.requireRole(headers, "operator");
      const cycleId = decodeURIComponent(cycleRunMatch[1]);
      const result = this.settlement.runSettlementCycle({
        cycleId,
        registeredBankIds: ["BANKA", "BANKB", "BANKC"],
        actorId,
        requestId,
      });
      return this.json(200, result);
    }

    const cycleFilesMatch = pathname.match(/^\/cycles\/([^/]+)\/files$/);
    if (method === "GET" && cycleFilesMatch) {
      this.requireRole(headers, "operator");
      const cycleId = decodeURIComponent(cycleFilesMatch[1]);
      const verParam = query.get("version");
      const result = this.settlement.getCycleFiles(
        cycleId,
        verParam ? Number(verParam) : undefined
      );
      if (!result) {
        return this.json(404, { error: `Cycle "${cycleId}" not found` });
      }
      return this.json(200, result);
    }

    // 8. Interface: `POST /cycles/:id/reconcile`, `POST /reconcile` & `GET /cycles/:id/exceptions` (Reconciliation Reqs 21–24)
    const reconMatch = pathname.match(/^\/cycles\/([^/]+)\/reconcile$/);
    if (method === "POST" && (reconMatch || pathname === "/reconcile")) {
      const { actorId } = this.requireRole(headers, "operator");
      const cycleId = reconMatch ? decodeURIComponent(reconMatch[1]) : this.sw.activeCycleId;
      const customReports = (body as { bankReports?: unknown[] } | undefined)?.bankReports;
      const bankReports = (customReports as ReturnType<
        typeof this.topology.banks.BANKA.generateEodReport
      >) ?? [
        ...this.topology.banks.BANKA.generateEodReport(),
        ...this.topology.banks.BANKB.generateEodReport(),
        ...this.topology.banks.BANKC.generateEodReport(),
      ];

      const result = this.reconciliation.runThreeWayReconciliation({
        cycleId,
        bankReports,
        actorId,
        requestId,
      });
      return this.json(200, result);
    }

    const excListMatch = pathname.match(/^\/cycles\/([^/]+)\/exceptions$/);
    if (method === "GET" && excListMatch) {
      this.requireRole(headers, "operator");
      const cycleId = decodeURIComponent(excListMatch[1]);
      return this.json(200, {
        summary: this.reconciliation.getCycleSummary(cycleId),
        exceptions: this.reconciliation.listExceptions(cycleId),
      });
    }

    const excResolveMatch = pathname.match(/^\/exceptions\/([^/]+)\/resolve$/);
    if (method === "POST" && excResolveMatch) {
      const { actorId } = this.requireRole(headers, "operator");
      const exceptionId = decodeURIComponent(excResolveMatch[1]);
      const payload = body as {
        action: ExceptionResolutionAction;
        note?: string;
      };
      const exc = this.reconciliation.getExceptionById(exceptionId);
      if (!exc) {
        return this.json(404, { error: `Exception "${exceptionId}" not found` });
      }

      const tx = this.sw.getTransactionByRrn(exc.rrn);
      const beneBankId = (exc.beneficiary_bank_id ?? tx?.beneficiary_bank_id) as
        "BANKA" | "BANKB" | "BANKC" | undefined;
      const remBankId = (exc.remitter_bank_id ?? tx?.remitter_bank_id) as
        "BANKA" | "BANKB" | "BANKC" | undefined;

      const beneAcct = tx?.payee_vpa
        ? (
            this.topology.psps.PSP1.resolveBankAccountInternal(tx.payee_vpa) ??
            this.topology.psps.PSP2.resolveBankAccountInternal(tx.payee_vpa)
          )?.account_number
        : undefined;

      const remAcct = tx?.payer_vpa
        ? (
            this.topology.psps.PSP1.resolveBankAccountInternal(tx.payer_vpa) ??
            this.topology.psps.PSP2.resolveBankAccountInternal(tx.payer_vpa)
          )?.account_number
        : undefined;

      const resolved = this.reconciliation.resolveException({
        exceptionId,
        action: payload.action,
        note: payload.note,
        beneficiaryBank: beneBankId ? this.topology.banks[beneBankId] : undefined,
        beneficiaryAccountNumber: beneAcct,
        remitterBank: remBankId ? this.topology.banks[remBankId] : undefined,
        remitterAccountNumber: remAcct,
        actorId,
        requestId,
      });

      return this.json(200, resolved);
    }

    // 9. Common Rule 8: Immutable Audit Logs endpoint
    if (method === "GET" && pathname === "/audit-logs") {
      this.requireRole(headers, "operator");
      return this.json(200, {
        switch_audit_logs: this.sw.audit.listRecent(100),
      });
    }

    return this.json(404, { error: `Route ${method} ${pathname} not found` });
  }

  public getMetricsSnapshot() {
    const routes: Record<
      string,
      {
        total: number;
        success: number;
        error: number;
        success_rate_percent: number;
        p95_latency_ms: number;
      }
    > = {};

    for (const [routeKey, counts] of this.routeCounts.entries()) {
      const latencies = [...(this.routeLatenciesMs.get(routeKey) ?? [])].sort((a, b) => a - b);
      const p95Idx = latencies.length > 0 ? Math.floor(latencies.length * 0.95) : 0;
      const p95 = latencies.length > 0 ? latencies[p95Idx] : 0;

      routes[routeKey] = {
        ...counts,
        success_rate_percent:
          counts.total === 0 ? 100 : Math.round((counts.success / counts.total) * 10000) / 100,
        p95_latency_ms: Math.round(p95 * 100) / 100,
      };
    }

    return {
      routes,
      banks: {
        BANKA: this.topology.banks.BANKA.getHealth(),
        BANKB: this.topology.banks.BANKB.getHealth(),
        BANKC: this.topology.banks.BANKC.getHealth(),
      },
    };
  }

  private recordRouteMetric(routeKey: string, durationMs: number, ok: boolean): void {
    const counts = this.routeCounts.get(routeKey) ?? {
      total: 0,
      success: 0,
      error: 0,
    };
    counts.total += 1;
    if (ok) {
      counts.success += 1;
    } else {
      counts.error += 1;
    }
    this.routeCounts.set(routeKey, counts);

    const arr = this.routeLatenciesMs.get(routeKey) ?? [];
    arr.push(durationMs);
    if (arr.length > 5000) {
      arr.shift();
    }
    this.routeLatenciesMs.set(routeKey, arr);
  }

  private logStructured(
    level: "INFO" | "ERROR",
    requestId: string,
    route: string,
    statusCode: number,
    payload: unknown
  ): void {
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      request_id: requestId,
      route,
      status_code: statusCode,
      payload: redactSensitiveData(payload),
    };
    this.structuredLogs.push(entry);
    if (this.structuredLogs.length > 1000) {
      this.structuredLogs.shift();
    }
  }

  private json<T>(statusCode: number, body: T): ApiResponse<T> {
    return {
      statusCode,
      headers: { "content-type": "application/json" },
      body,
    };
  }

  private renderAdminConsoleHtml(): string {
    return renderSwitchAdminHtml(this.sw.activeCycleId);
  }

  public createHttpServer(): http.Server {
    return http.createServer(async (req, res) => {
      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v[0] : v;
      }

      let parsedBody: unknown;
      try {
        const { json } = await readRawAndJsonBody(req);
        parsedBody = json;
      } catch (err: unknown) {
        const statusCode = (err as { statusCode?: number })?.statusCode ?? 400;
        const message = err instanceof Error ? err.message : String(err);
        res.writeHead(statusCode, {
          ...buildCorsHeaders(headers["origin"] ?? headers["Origin"]),
          "content-type": "application/json",
        });
        res.end(JSON.stringify({ error: message }, null, 2));
        return;
      }

      const apiRes = await this.dispatch({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers,
        body: parsedBody,
      });

      res.writeHead(apiRes.statusCode, apiRes.headers);
      if (typeof apiRes.body === "string") {
        res.end(apiRes.body);
      } else {
        res.end(JSON.stringify(apiRes.body, null, 2));
      }
    });
  }
}
