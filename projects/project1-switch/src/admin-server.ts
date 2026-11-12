import http from "node:http";
import crypto from "node:crypto";
import { redactSensitiveData } from "../../../packages/core/src/index.ts";
import { CentralSwitch } from "./switch-engine.ts";
import { SettlementEngine } from "./settlement-engine.ts";
import {
  ReconciliationEngine,
  type ExceptionResolutionAction,
} from "./reconciliation-engine.ts";
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

  constructor(params: {
    sw: CentralSwitch;
    topology: SeededProject1Topology;
  }) {
    this.sw = params.sw;
    this.topology = params.topology;
    this.settlement = new SettlementEngine(this.sw.db, this.sw.audit);
    this.reconciliation = new ReconciliationEngine(this.sw.db, this.sw.audit);
  }

  /**
   * Common Rule 11: Enforces Role-Based Access Control (RBAC).
   * - `operator`: read, run settlement/reconciliation, resolve exceptions
   * - `admin`: change configuration, chaos rules, participant status
   */
  private requireRole(
    headers: Record<string, string | undefined>,
    minimumRole: ConsoleRole
  ): { actorId: string; role: ConsoleRole } {
    const rawRole = (headers["x-role"] ?? headers["X-Role"] ?? "operator")
      .toLowerCase()
      .trim();
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
    const requestId =
      headers["x-request-id"] ?? `REQ-${crypto.randomUUID().slice(0, 8)}`;
    const url = new URL(req.path, "http://localhost");
    const pathname = url.pathname;
    const routeKey = `${req.method.toUpperCase()} ${pathname}`;

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
          "x-request-id": requestId,
          ...response.headers,
        },
      };
    } catch (err: unknown) {
      const statusCode =
        (err as { statusCode?: number })?.statusCode ?? 500;
      const message = err instanceof Error ? err.message : String(err);
      this.recordRouteMetric(routeKey, performance.now() - startMs, false);
      this.logStructured("ERROR", requestId, routeKey, statusCode, { error: message });
      return {
        statusCode,
        headers: {
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
      const key = decodeURIComponent(txMatch[1]);
      const tx =
        this.sw.getTransactionByRrn(key) ?? this.sw.getTransactionById(key);
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
            .prepare(
              `SELECT * FROM switch_transactions ORDER BY created_at DESC LIMIT 100`
            )
            .all();
      return this.json(200, { transactions: rows });
    }

    // 6. Interface: `PUT /participants/:id/chaos` (Req 15 & Rule 11 Admin RBAC)
    const chaosMatch = pathname.match(/^\/participants\/([^/]+)\/chaos$/);
    if (method === "PUT" && chaosMatch) {
      const { actorId } = this.requireRole(headers, "admin");
      const bankId = decodeURIComponent(chaosMatch[1]).toUpperCase() as
        | "BANKA"
        | "BANKB"
        | "BANKC";
      const bank = this.topology.banks[bankId];
      if (!bank) {
        return this.json(404, { error: `Bank "${bankId}" not found` });
      }
      const updated = bank.setChaosConfig(
        body as Partial<BankChaosConfig>,
        actorId,
        requestId
      );
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

    // 8. Interface: `POST /cycles/:id/reconcile` & `GET /cycles/:id/exceptions` (Reconciliation Reqs 21–24)
    const reconMatch = pathname.match(/^\/cycles\/([^/]+)\/reconcile$/);
    if (method === "POST" && reconMatch) {
      const { actorId } = this.requireRole(headers, "operator");
      const cycleId = decodeURIComponent(reconMatch[1]);
      const customReports = (body as { bankReports?: unknown[] } | undefined)
        ?.bankReports;
      const bankReports =
        (customReports as ReturnType<
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
      const beneBankId = (exc.beneficiary_bank_id ??
        tx?.beneficiary_bank_id) as "BANKA" | "BANKB" | "BANKC" | undefined;
      const remBankId = (exc.remitter_bank_id ?? tx?.remitter_bank_id) as
        | "BANKA"
        | "BANKB"
        | "BANKC"
        | undefined;

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
      const latencies = [...(this.routeLatenciesMs.get(routeKey) ?? [])].sort(
        (a, b) => a - b
      );
      const p95Idx =
        latencies.length > 0 ? Math.floor(latencies.length * 0.95) : 0;
      const p95 = latencies.length > 0 ? latencies[p95Idx] : 0;

      routes[routeKey] = {
        ...counts,
        success_rate_percent:
          counts.total === 0
            ? 100
            : Math.round((counts.success / counts.total) * 10000) / 100,
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

  private recordRouteMetric(
    routeKey: string,
    durationMs: number,
    ok: boolean
  ): void {
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
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>Project 1 — UPI Switch Admin Console</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 24px; background: #0f172a; color: #f8fafc; }
    h1, h2 { color: #38bdf8; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px; }
    .card { background: #1e293b; padding: 16px; border-radius: 8px; border: 1px solid #334155; }
    code { background: #0f172a; padding: 2px 6px; border-radius: 4px; color: #7dd3fc; }
  </style>
</head>
<body>
  <h1>Project 1 — UPI Switch, Settlement & Three-Way Reconciliation Console</h1>
  <div class="grid">
    <div class="card">
      <h2>Live Transactions & 6-Hop Trace</h2>
      <p>Search by RRN, Transaction ID, VPA or Amount via <code>GET /transactions?q=</code> and <code>GET /transactions/{rrn}</code>.</p>
    </div>
    <div class="card">
      <h2>Participant Health & Chaos Injection</h2>
      <p>Monitor BANKA, BANKB, BANKC, PSP1, PSP2 via <code>GET /metrics</code> and inject latency/errors/hangs via <code>PUT /participants/{id}/chaos</code>.</p>
    </div>
    <div class="card">
      <h2>T+1 Settlement & 3-Way Reconciliation</h2>
      <p>Generate immutable CSV manifests via <code>POST /cycles/{id}/run</code> and run 3-way reconciliation via <code>POST /cycles/{id}/reconcile</code>.</p>
    </div>
  </div>
</body>
</html>`;
  }

  public createHttpServer(): http.Server {
    return http.createServer(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) {
        chunks.push(Buffer.from(chunk));
      }
      const rawBody = Buffer.concat(chunks).toString("utf8");
      let parsedBody: unknown = undefined;
      if (rawBody) {
        try {
          parsedBody = JSON.parse(rawBody);
        } catch {
          parsedBody = rawBody;
        }
      }

      const headers: Record<string, string | undefined> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        headers[k] = Array.isArray(v) ? v[0] : v;
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
