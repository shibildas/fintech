import http from "node:http";
import path from "node:path";
import {
  buildCorsHeaders,
  ensureDataDir,
  mapErrorToHttpStatus,
  readRawAndJsonBody,
  timingSafeTokenEqual,
  writeJsonResponse,
  writeHtmlResponse,
  InjectableFakeClock,
} from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { createPersistentGatewayContext } from "@fintech/project2-gateway";
import { MandateService, type MandateRail } from "./mandate-service.ts";
import { SubscriptionService } from "./subscription-service.ts";
import { RecurringCycleExecutor } from "./cycle-executor.ts";
import { EnachBankBatchSimulator, EnachPresentmentEngine } from "./enach-batch.ts";
import { DunningEngine } from "./dunning-engine.ts";
import { InvoiceAndMrrService } from "./invoices-and-analytics.ts";
import { renderMandatesUiHtml } from "./mandates-ui.ts";

/**
 * Slice 06 — Project 4 Live HTTP Server & Interactive Fake Clock UI (:3004)
 *
 * - Persistent `.data/p4-mandates.sqlite`, `.data/p4-gateway/`, `.data/p4-banks/`, `.data/p4-switch.sqlite`
 * - Persisted `fake_clock_state` + deterministic persisted `merchantId` across restarts
 * - Constant-time `X-Merchant-Token` auth + customer PIN/OTP on mandate authorization
 */

export interface MandatesHttpServerContext {
  clock: InjectableFakeClock;
  mandates: MandateService;
  subs: SubscriptionService;
  executor: RecurringCycleExecutor;
  enach: EnachPresentmentEngine;
  dunning: DunningEngine;
  invoices: InvoiceAndMrrService;
  merchantId: string;
  merchantToken: string;
  persistClock: () => void;
}

export function createPersistentMandatesContext(options?: {
  dataDir?: string;
  merchantToken?: string;
}): MandatesHttpServerContext {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const dbPath = options?.dataDir ? path.join(options.dataDir, "p4-mandates.sqlite") : ":memory:";
  const p4GwDir = options?.dataDir ? path.join(options.dataDir, "p4-gateway") : undefined;
  const p4BanksDir = options?.dataDir ? path.join(options.dataDir, "p4-banks") : undefined;
  const p4SwitchPath = options?.dataDir ? path.join(options.dataDir, "p4-switch.sqlite") : ":memory:";

  const p1 = createSeededTopology(p4BanksDir ? { dataDir: p4BanksDir } : undefined);
  const sw = new CentralSwitch({
    dbPath: p4SwitchPath,
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const gwCtx = createPersistentGatewayContext(p4GwDir ? { dataDir: p4GwDir } : undefined);
  const mandates = new MandateService(dbPath);

  mandates.db.exec(`
    CREATE TABLE IF NOT EXISTS fake_clock_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_iso TEXT NOT NULL
    );
  `);
  const savedClock = mandates.db
    .prepare(`SELECT current_iso FROM fake_clock_state WHERE id = 1`)
    .get() as { current_iso: string } | undefined;

  const initialIso = savedClock?.current_iso ?? "2026-01-31T04:30:00.000Z";
  const clock = new InjectableFakeClock(initialIso);
  const persistClock = () => {
    mandates.db
      .prepare(
        `INSERT INTO fake_clock_state (id, current_iso) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET current_iso = excluded.current_iso`
      )
      .run(clock.now().toISOString());
  };
  persistClock();

  const subs = new SubscriptionService({ mandates, clock, dbPath });
  const executor = new RecurringCycleExecutor({
    mandates,
    subs,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    merchantVpa: "shop@psp2",
    clock,
    dbPath,
  });
  const enach = new EnachPresentmentEngine({ gateway: gwCtx.gateway, dbPath });
  const dunning = new DunningEngine({ subs, gateway: gwCtx.gateway, clock, dbPath });
  const invoices = new InvoiceAndMrrService({ webhooks: gwCtx.gateway.webhooks, dbPath });

  return {
    clock,
    mandates,
    subs,
    executor,
    enach,
    dunning,
    invoices,
    merchantId: gwCtx.seededMerchantId,
    merchantToken:
      options?.merchantToken ?? process.env.P4_MERCHANT_TOKEN ?? "p4_dev_merchant_token_2026",
    persistClock,
  };
}

export class MandatesHttpServer {
  public readonly ctx: MandatesHttpServerContext;

  constructor(ctx: MandatesHttpServerContext) {
    this.ctx = ctx;
  }

  private requireMerchantToken(req: http.IncomingMessage): void {
    const token = String(req.headers["x-merchant-token"] ?? "").trim();
    if (!timingSafeTokenEqual(token, this.ctx.merchantToken)) {
      throw Object.assign(
        new Error("Unauthorized (HTTP 401): Missing or invalid X-Merchant-Token"),
        { statusCode: 401 }
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
          writeHtmlResponse(res, 200, renderMandatesUiHtml(), origin);
          return;
        }

        if (method === "GET" && pathname === "/health") {
          writeJsonResponse(res, 200, {
            service: "project4-mandates",
            status: "UP",
            fakeClockUtc: this.ctx.clock.now().toISOString(),
            rails: ["UPI_AUTOPAY", "E_NACH"],
          }, origin);
          return;
        }

        const { json } = await readRawAndJsonBody(req);
        this.requireMerchantToken(req);

        if (method === "GET" && pathname === "/api/clock") {
          const now = this.ctx.clock.now();
          const ist = new Date(now.getTime() + 330 * 60 * 1000).toISOString().replace("Z", "+05:30");
          writeJsonResponse(res, 200, { utc: now.toISOString(), ist }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/clock/advance") {
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
          const ist = new Date(now.getTime() + 330 * 60 * 1000).toISOString().replace("Z", "+05:30");
          writeJsonResponse(res, 200, { utc: now.toISOString(), ist }, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/mandates") {
          const rows = this.ctx.mandates.db
            .prepare(`SELECT * FROM mandates WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50`)
            .all(this.ctx.merchantId);
          writeJsonResponse(res, 200, { mandates: rows }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/mandates") {
          const m = this.ctx.mandates.createMandate({
            merchantId: this.ctx.merchantId,
            customerId: String(json.customerId ?? "cust_anita"),
            payerVpa: json.payerVpa ? String(json.payerVpa) : "anita@psp1",
            bankId: String(json.bankId ?? "BANKA"),
            accountNumberMasked: String(json.accountNumberMasked ?? "XXXX4521"),
            rail: (json.rail as MandateRail) ?? "UPI_AUTOPAY",
            maxAmountPaise: Number(json.maxAmountPaise ?? 100_000),
            monthlyAggregateCapPaise: Number(json.monthlyAggregateCapPaise ?? 300_000),
            validUntilIso: String(json.validUntilIso ?? "2029-12-31T00:00:00.000Z"),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 201, m, origin);
          return;
        }

        const mAuth = pathname.match(/^\/api\/mandates\/([^/]+)\/authorize$/);
        if (method === "POST" && mAuth) {
          const out = this.ctx.mandates.authorizeMandate({
            mandateId: decodeURIComponent(mAuth[1]),
            authCredential: String(json.authCredential ?? ""),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        const mCap = pathname.match(/^\/api\/mandates\/([^/]+)\/cap$/);
        if (method === "POST" && mCap) {
          const out = this.ctx.mandates.requestCapModification({
            mandateId: decodeURIComponent(mCap[1]),
            newMaxAmountPaise: Number(json.newMaxAmountPaise ?? 150_000),
            newMonthlyAggregateCapPaise: Number(json.newMonthlyAggregateCapPaise ?? 300_000),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        const mReauth = pathname.match(/^\/api\/mandates\/([^/]+)\/reauth$/);
        if (method === "POST" && mReauth) {
          const out = this.ctx.mandates.confirmCapIncreaseReauth({
            mandateId: decodeURIComponent(mReauth[1]),
            authCredential: String(json.authCredential ?? ""),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        const mRevoke = pathname.match(/^\/api\/mandates\/([^/]+)\/revoke$/);
        if (method === "POST" && mRevoke) {
          const out = this.ctx.mandates.revokeMandate(
            decodeURIComponent(mRevoke[1]),
            String(json.reason ?? "Customer revoked via UI"),
            this.ctx.clock.now()
          );
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/plans") {
          const p = this.ctx.subs.createPlan({
            merchantId: this.ctx.merchantId,
            name: String(json.name ?? "SaaS Pro Monthly"),
            interval: (json.interval as "MONTHLY" | "YEARLY") ?? "MONTHLY",
            amountPaise: Number(json.amountPaise ?? 49_900),
          });
          writeJsonResponse(res, 201, p, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/subscriptions") {
          const rows = this.ctx.subs.db
            .prepare(`SELECT * FROM subscriptions WHERE merchant_id = ? ORDER BY created_at DESC LIMIT 50`)
            .all(this.ctx.merchantId);
          writeJsonResponse(res, 200, { subscriptions: rows }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/subscriptions") {
          const sub = this.ctx.subs.createSubscription({
            merchantId: this.ctx.merchantId,
            customerId: String(json.customerId ?? "cust_anita"),
            planId: String(json.planId ?? ""),
            mandateId: String(json.mandateId ?? ""),
            anchorDay: json.anchorDay ? Number(json.anchorDay) : 31,
            startYear: json.startYear ? Number(json.startYear) : 2026,
            startMonth1Based: json.startMonth1Based ? Number(json.startMonth1Based) : 1,
          });
          const out = json.autoActivate === false ? sub : this.ctx.subs.activateSubscription(sub.id);
          writeJsonResponse(res, 201, out, origin);
          return;
        }

        const sAct = pathname.match(/^\/api\/subscriptions\/([^/]+)\/activate$/);
        if (method === "POST" && sAct) {
          const out = this.ctx.subs.activateSubscription(decodeURIComponent(sAct[1]));
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        const sChange = pathname.match(/^\/api\/subscriptions\/([^/]+)\/change-plan$/);
        if (method === "POST" && sChange) {
          const out = this.ctx.subs.changeSubscriptionPlan({
            subscriptionId: decodeURIComponent(sChange[1]),
            newPlanId: String(json.newPlanId ?? ""),
            remainingDays: Number(json.remainingDays ?? 15),
            totalCycleDays: Number(json.totalCycleDays ?? 30),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        const sAdv = pathname.match(/^\/api\/subscriptions\/([^/]+)\/advance-anchor$/);
        if (method === "POST" && sAdv) {
          const out = this.ctx.subs.advanceToNextBillingCycle(decodeURIComponent(sAdv[1]));
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/cycles/pre-debit") {
          const notice = this.ctx.executor.sendPreDebitNotice(
            String(json.subscriptionId ?? ""),
            Number(json.cycleNumber ?? 1)
          );
          writeJsonResponse(res, 201, notice, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/cycles/execute") {
          const out = await this.ctx.executor.executeCycle({
            subscriptionId: String(json.subscriptionId ?? ""),
            cycleNumber: Number(json.cycleNumber ?? 1),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/enach/run-sample") {
          const simA = new EnachBankBatchSimulator("BANKA");
          const suffix = Date.now();
          const kDrop = `sub_demo_${suffix}_2:cycle:1`;
          simA.setDroppedRecord(kDrop);
          const batches = this.ctx.enach.generatePresentmentBatches(
            [
              { executionKey: `sub_demo_${suffix}_0:cycle:1`, merchantId: this.ctx.merchantId, subscriptionId: `sub_demo_${suffix}_0`, umrn: "UMRNDEMO00000001", bankId: "BANKA", amountPaise: 100_000 },
              { executionKey: `sub_demo_${suffix}_1:cycle:1`, merchantId: this.ctx.merchantId, subscriptionId: `sub_demo_${suffix}_1`, umrn: "UMRNDEMO00000002", bankId: "BANKA", amountPaise: 100_000 },
              { executionKey: kDrop, merchantId: this.ctx.merchantId, subscriptionId: `sub_demo_${suffix}_2`, umrn: "UMRNDEMO00000003", bankId: "BANKA", amountPaise: 100_000 },
            ],
            this.ctx.clock.now()
          );
          const respCsv = simA.processPresentmentAndBuildResponseCsv(batches[0].batchId, batches[0].presentmentCsv, this.ctx.clock.now());
          const ingested = this.ctx.enach.ingestResponseCsv(batches[0].batchId, respCsv, this.ctx.clock.now());
          writeJsonResponse(res, 200, ingested, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/dunning/fail") {
          const out = await this.ctx.dunning.handleDebitFailure({
            subscriptionId: String(json.subscriptionId ?? ""),
            executionKey: String(json.executionKey ?? `sub:cycle:${Date.now()}`),
            amountPaise: Number(json.amountPaise ?? 49_900),
            failureCode: String(json.failureCode ?? "51_INSUFFICIENT_FUNDS"),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/dunning/process-due") {
          const simulateSuccess = Boolean(json.simulateSuccess);
          const summary = await this.ctx.dunning.processDueRetries(async () => simulateSuccess);
          writeJsonResponse(res, 200, summary, origin);
          return;
        }

        const dunPay = pathname.match(/^\/api\/dunning\/([^/]+)\/pay-now$/);
        if (method === "POST" && dunPay) {
          const out = await this.ctx.dunning.recoverViaPayNowCard({
            dunningCaseId: decodeURIComponent(dunPay[1]),
            cardNumber: String(json.cardNumber ?? "4111111111114242"),
            expiry: String(json.expiry ?? "12/29"),
          });
          writeJsonResponse(res, 200, out, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/invoices") {
          const inv = this.ctx.invoices.createDraftInvoice({
            merchantId: this.ctx.merchantId,
            customerId: String(json.customerId ?? "cust_anita"),
            subscriptionId: String(json.subscriptionId ?? `sub_inv_${Date.now()}`),
            cycleNumber: Number(json.cycleNumber ?? 1),
            umrn: json.umrn ? String(json.umrn) : "UMRNBANKA000001",
            recurringAmountPaise: Number(json.amountPaise ?? 49_900),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 201, inv, origin);
          return;
        }

        const invPrint = pathname.match(/^\/api\/invoices\/([^/]+)\/printable$/);
        if (method === "GET" && invPrint) {
          const id = decodeURIComponent(invPrint[1]);
          const text = this.ctx.invoices.renderPrintableInvoice(id);
          writeJsonResponse(res, 200, { invoiceId: id, printable: text }, origin);
          return;
        }

        if (method === "POST" && pathname === "/api/invoices/demo-paid") {
          const amountPaise = Number(json.amountPaise ?? 49_900);
          const subId = String(json.subscriptionId ?? `sub_inv_${Date.now()}`);
          this.ctx.invoices.recordMrrMovement({
            merchantId: this.ctx.merchantId,
            subscriptionId: subId,
            eventType: "NEW",
            deltaPaise: amountPaise,
            now: this.ctx.clock.now(),
          });
          const inv = this.ctx.invoices.createDraftInvoice({
            merchantId: this.ctx.merchantId,
            customerId: "cust_anita",
            subscriptionId: subId,
            cycleNumber: 1,
            umrn: json.umrn ? String(json.umrn) : "UMRNBANKA000001",
            recurringAmountPaise: amountPaise,
            now: this.ctx.clock.now(),
          });
          await this.ctx.invoices.issueInvoice(inv.id, this.ctx.clock.now());
          await this.ctx.invoices.markInvoicePaid({
            invoiceId: inv.id,
            paymentReference: `RRN-${Date.now().toString().slice(-12)}`,
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 201, {
            invoice: this.ctx.invoices.getInvoice(inv.id),
            printable: this.ctx.invoices.renderPrintableInvoice(inv.id),
            mrrParity: this.ctx.invoices.verifyMrrMatchesPaidInvoices(this.ctx.merchantId),
          }, origin);
          return;
        }

        if (method === "GET" && pathname === "/api/invoices/mrr-parity") {
          writeJsonResponse(
            res,
            200,
            this.ctx.invoices.verifyMrrMatchesPaidInvoices(this.ctx.merchantId),
            origin
          );
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
