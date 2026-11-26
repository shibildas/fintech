import http from "node:http";
import path from "node:path";
import {
  CORS_HEADERS,
  ensureDataDir,
  readRawAndJsonBody,
  writeJsonResponse,
  writeHtmlResponse,
  renderFintechShellHtml,
  InjectableFakeClock,
} from "@fintech/core";
import { createSeededGatewayTopology } from "@fintech/project2-gateway";
import { MandateService, type MandateRail } from "./mandate-service.ts";
import { SubscriptionService } from "./subscription-service.ts";
import { RecurringCycleExecutor } from "./cycle-executor.ts";
import { EnachBankBatchSimulator, EnachPresentmentEngine } from "./enach-batch.ts";
import { DunningEngine } from "./dunning-engine.ts";
import { InvoiceAndMrrService } from "./invoices-and-analytics.ts";

/**
 * Slice 06 — Project 4 Live HTTP Server & Interactive Fake Clock UI (:3004)
 *
 * - Persistent `.data/p4-mandates.sqlite` including persisted `fake_clock_state`
 * - Strict manual `X-Merchant-Token` auth (`401` on missing/wrong) + customer PIN/OTP on mandate auth
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
  const dbPath = options?.dataDir
    ? path.join(options.dataDir, "p4-mandates.sqlite")
    : ":memory:";

  const gwTopo = createSeededGatewayTopology();
  const mandates = new MandateService(dbPath);

  // Persist Fake Clock state in SQLite so time progression survives restarts
  mandates.db.exec(`
    CREATE TABLE IF NOT EXISTS fake_clock_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_iso TEXT NOT NULL
    );
  `);
  const savedClock = mandates.db
    .prepare(`SELECT current_iso FROM fake_clock_state WHERE id = 1`)
    .get() as { current_iso: string } | undefined;

  const initialIso = savedClock?.current_iso ?? "2026-01-31T04:30:00.000Z"; // Jan 31, 10:00 AM IST
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
    p1Switch: gwTopo.p1.centralSwitch,
    p1Psp: gwTopo.p1.psps.PSP1,
    merchantVpa: "shop@psp2",
    clock,
    dbPath,
  });
  const enach = new EnachPresentmentEngine({ gateway: gwTopo.gateway, dbPath });
  const dunning = new DunningEngine({ subs, gateway: gwTopo.gateway, clock, dbPath });
  const invoices = new InvoiceAndMrrService({ webhooks: gwTopo.gateway.webhooks, dbPath });

  return {
    clock,
    mandates,
    subs,
    executor,
    enach,
    dunning,
    invoices,
    merchantId: gwTopo.merchant.id,
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
    if (!token || token !== this.ctx.merchantToken) {
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
            service: "project4-mandates",
            status: "UP",
            fakeClockUtc: this.ctx.clock.now().toISOString(),
            rails: ["UPI_AUTOPAY", "E_NACH"],
          });
          return;
        }

        const { json } = await readRawAndJsonBody(req);
        this.requireMerchantToken(req);

        if (method === "GET" && pathname === "/api/clock") {
          const now = this.ctx.clock.now();
          const ist = new Date(now.getTime() + 330 * 60 * 1000).toISOString().replace("Z", "+05:30");
          writeJsonResponse(res, 200, { utc: now.toISOString(), ist });
          return;
        }

        if (method === "POST" && pathname === "/api/clock/advance") {
          if (json.setIso) {
            this.ctx.clock.setTime(String(json.setIso));
          } else if (json.hours) {
            this.ctx.clock.advanceByHours(Number(json.hours));
          } else if (json.days) {
            this.ctx.clock.advanceByDays(Number(json.days));
          }
          this.ctx.persistClock();
          const now = this.ctx.clock.now();
          const ist = new Date(now.getTime() + 330 * 60 * 1000).toISOString().replace("Z", "+05:30");
          writeJsonResponse(res, 200, { utc: now.toISOString(), ist });
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
          writeJsonResponse(res, 201, m);
          return;
        }

        const mAuth = pathname.match(/^\/api\/mandates\/([^/]+)\/authorize$/);
        if (method === "POST" && mAuth) {
          const out = this.ctx.mandates.authorizeMandate({
            mandateId: decodeURIComponent(mAuth[1]),
            authCredential: String(json.authCredential ?? ""),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 200, out);
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
          writeJsonResponse(res, 200, out);
          return;
        }

        const mReauth = pathname.match(/^\/api\/mandates\/([^/]+)\/reauth$/);
        if (method === "POST" && mReauth) {
          const out = this.ctx.mandates.confirmCapIncreaseReauth({
            mandateId: decodeURIComponent(mReauth[1]),
            authCredential: String(json.authCredential ?? ""),
            now: this.ctx.clock.now(),
          });
          writeJsonResponse(res, 200, out);
          return;
        }

        const mRevoke = pathname.match(/^\/api\/mandates\/([^/]+)\/revoke$/);
        if (method === "POST" && mRevoke) {
          const out = this.ctx.mandates.revokeMandate(
            decodeURIComponent(mRevoke[1]),
            String(json.reason ?? "Customer revoked via UI"),
            this.ctx.clock.now()
          );
          writeJsonResponse(res, 200, out);
          return;
        }

        if (method === "POST" && pathname === "/api/plans") {
          const p = this.ctx.subs.createPlan({
            merchantId: this.ctx.merchantId,
            name: String(json.name ?? "SaaS Pro Monthly"),
            interval: (json.interval as "MONTHLY" | "YEARLY") ?? "MONTHLY",
            amountPaise: Number(json.amountPaise ?? 49_900),
          });
          writeJsonResponse(res, 201, p);
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
          const active = this.ctx.subs.activateSubscription(sub.id);
          writeJsonResponse(res, 201, active);
          return;
        }

        const sAdv = pathname.match(/^\/api\/subscriptions\/([^/]+)\/advance-anchor$/);
        if (method === "POST" && sAdv) {
          const out = this.ctx.subs.advanceToNextBillingCycle(decodeURIComponent(sAdv[1]));
          writeJsonResponse(res, 200, out);
          return;
        }

        if (method === "POST" && pathname === "/api/cycles/pre-debit") {
          const notice = this.ctx.executor.sendPreDebitNotice(
            String(json.subscriptionId ?? ""),
            Number(json.cycleNumber ?? 1)
          );
          writeJsonResponse(res, 201, notice);
          return;
        }

        if (method === "POST" && pathname === "/api/cycles/execute") {
          const out = await this.ctx.executor.executeCycle({
            subscriptionId: String(json.subscriptionId ?? ""),
            cycleNumber: Number(json.cycleNumber ?? 1),
          });
          writeJsonResponse(res, 200, out);
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
          writeJsonResponse(res, 200, ingested);
          return;
        }

        if (method === "POST" && pathname === "/api/dunning/fail") {
          const out = await this.ctx.dunning.handleDebitFailure({
            subscriptionId: String(json.subscriptionId ?? ""),
            executionKey: String(json.executionKey ?? `sub:cycle:${Date.now()}`),
            amountPaise: Number(json.amountPaise ?? 49_900),
            failureCode: String(json.failureCode ?? "51_INSUFFICIENT_FUNDS"),
          });
          writeJsonResponse(res, 200, out);
          return;
        }

        const dunPay = pathname.match(/^\/api\/dunning\/([^/]+)\/pay-now$/);
        if (method === "POST" && dunPay) {
          const out = await this.ctx.dunning.recoverViaPayNowCard({
            dunningCaseId: decodeURIComponent(dunPay[1]),
            cardNumber: String(json.cardNumber ?? "4111111111114242"),
            expiry: String(json.expiry ?? "12/29"),
          });
          writeJsonResponse(res, 200, out);
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
          });
          return;
        }

        if (method === "GET" && pathname === "/api/invoices/mrr-parity") {
          writeJsonResponse(
            res,
            200,
            this.ctx.invoices.verifyMrrMatchesPaidInvoices(this.ctx.merchantId)
          );
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
      title: "Project 4 — RBI Mandates (AutoPay & e-NACH), Subscriptions & Fake Clock",
      subtitle: "Persisted Injectable Fake Clock • UMRN & Cap Re-Auth • 24h Pre-Debit Gate • Dunning & Pay-Now",
      activePort: 3004,
      bodyHtml: `
        <div class="auth-bar">
          <label>X-Merchant-Token (see server stdout)<input id="p4Token" type="password" placeholder="Paste X-Merchant-Token" /></label>
          <button onclick="advanceClock({ hours: 10 })">+10h</button>
          <button onclick="advanceClock({ hours: 24 })">+24h (Pre-Debit)</button>
          <button class="secondary" onclick="advanceClock({ days: 7 })">+7d</button>
          <button class="secondary" onclick="advanceClock({ setIso: '2026-01-31T04:30:00.000Z' })">Reset Jan 31 10:00 IST</button>
          <span id="clockBadge" class="badge ok">Clock: click Refresh/Advance</span>
        </div>
        <div class="grid">
          <div class="card">
            <h2>1. RBI Mandate UMRN & Cap Re-Auth</h2>
            <div class="row">
              <label>Rail<select id="mRail"><option value="UPI_AUTOPAY">UPI_AUTOPAY (PIN 1234)</option><option value="E_NACH">E_NACH (OTP 654321)</option></select></label>
              <label>Auth PIN / OTP<input id="mCred" type="password" placeholder="1234 or 654321" /></label>
            </div>
            <div class="row">
              <button onclick="createAndAuthMandate()">Create & Authorize Mandate</button>
              <button class="secondary" onclick="increaseCap()">Request Cap Increase</button>
              <button class="danger" onclick="revokeMandate()">Revoke Mandate</button>
            </div>
            <pre id="mOut" class="out">Enter X-Merchant-Token above, then authorize a mandate to mint UMRN...</pre>
          </div>
          <div class="card">
            <h2>2. Subscription (Jan 31 -> Feb 28 -> Mar 31) & 24h Pre-Debit Gate</h2>
            <div class="row">
              <button onclick="createSub()">Create & Activate Sub</button>
              <button class="secondary" onclick="advanceAnchor()">Preview Next Anchor Month</button>
            </div>
            <div class="row">
              <button onclick="sendPreDebit()">1. Send 24h Pre-Debit Notice</button>
              <button class="secondary" onclick="execCycle()">2. Execute Cycle (Watch 403 -> +24h -> 200)</button>
            </div>
            <pre id="subOut" class="out">Try Execute Cycle before +24h to see the RBI 403 Pre-Debit Gate...</pre>
          </div>
          <div class="card">
            <h2>3. Dunning (Day 1/3/7) & Pay-Now Recovery</h2>
            <div class="row">
              <button class="danger" onclick="triggerSoftFail()">Simulate 51_INSUFFICIENT_FUNDS</button>
              <button onclick="payNowRecover()">Pay-Now Recovery (Card)</button>
            </div>
            <pre id="dunOut" class="out">Soft failure creates PAST_DUE + Day 1/3/7 retries + Pay-Now Order...</pre>
          </div>
          <div class="card">
            <h2>4. e-NACH Missing-Record Batch & Printable Invoice / MRR</h2>
            <div class="row">
              <button onclick="runEnachSample()">Run e-NACH Batch (1 Dropped Row)</button>
              <button class="secondary" onclick="createPaidInvoice()">Issue & Pay Tax Invoice</button>
            </div>
            <pre id="invOut" class="out">Printable Tax Invoice + MRR-to-Paid-Invoice invariant...</pre>
          </div>
        </div>`,
      scriptJs: `
        let p4State = { mandateId: "", umrn: "", subId: "", dunningCaseId: "" };
        function p4Headers() {
          return { "content-type": "application/json", "x-merchant-token": document.getElementById("p4Token").value.trim() };
        }
        async function advanceClock(body) {
          const r = await fetch("/api/clock/advance", { method: "POST", headers: p4Headers(), body: JSON.stringify(body) });
          const data = await r.json();
          if (r.ok) document.getElementById("clockBadge").textContent = "IST: " + data.ist;
          else show("mOut", { status: r.status, body: data });
        }
        async function createAndAuthMandate() {
          const rail = document.getElementById("mRail").value;
          const m1 = await fetch("/api/mandates", { method: "POST", headers: p4Headers(), body: JSON.stringify({ rail }) });
          const mData = await m1.json();
          if (!m1.ok) return show("mOut", { status: m1.status, body: mData });
          p4State.mandateId = mData.id;
          const m2 = await fetch("/api/mandates/" + mData.id + "/authorize", {
            method: "POST",
            headers: p4Headers(),
            body: JSON.stringify({ authCredential: document.getElementById("mCred").value })
          });
          const aData = await m2.json();
          if (aData.umrn) p4State.umrn = aData.umrn;
          show("mOut", { status: m2.status, body: aData });
        }
        async function increaseCap() {
          const r = await fetch("/api/mandates/" + p4State.mandateId + "/cap", {
            method: "POST",
            headers: p4Headers(),
            body: JSON.stringify({ newMaxAmountPaise: 200000, newMonthlyAggregateCapPaise: 400000 })
          });
          show("mOut", { status: r.status, body: await r.json() });
        }
        async function revokeMandate() {
          const r = await fetch("/api/mandates/" + p4State.mandateId + "/revoke", { method: "POST", headers: p4Headers(), body: "{}" });
          show("mOut", { status: r.status, body: await r.json() });
        }
        async function createSub() {
          const pr = await fetch("/api/plans", { method: "POST", headers: p4Headers(), body: JSON.stringify({ name: "Pro Monthly", amountPaise: 49900 }) });
          const plan = await pr.json();
          if (!pr.ok) return show("subOut", { status: pr.status, body: plan });
          const sr = await fetch("/api/subscriptions", {
            method: "POST",
            headers: p4Headers(),
            body: JSON.stringify({ planId: plan.id, mandateId: p4State.mandateId, anchorDay: 31, startYear: 2026, startMonth1Based: 1 })
          });
          const sub = await sr.json();
          if (sub.id) p4State.subId = sub.id;
          show("subOut", { status: sr.status, body: sub });
        }
        async function advanceAnchor() {
          const r = await fetch("/api/subscriptions/" + p4State.subId + "/advance-anchor", { method: "POST", headers: p4Headers(), body: "{}" });
          show("subOut", { status: r.status, body: await r.json() });
        }
        async function sendPreDebit() {
          const r = await fetch("/api/cycles/pre-debit", { method: "POST", headers: p4Headers(), body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
          show("subOut", { status: r.status, body: await r.json() });
        }
        async function execCycle() {
          const r = await fetch("/api/cycles/execute", { method: "POST", headers: p4Headers(), body: JSON.stringify({ subscriptionId: p4State.subId, cycleNumber: 1 }) });
          show("subOut", { status: r.status, body: await r.json() });
        }
        async function triggerSoftFail() {
          const r = await fetch("/api/dunning/fail", {
            method: "POST",
            headers: p4Headers(),
            body: JSON.stringify({ subscriptionId: p4State.subId, executionKey: p4State.subId + ":cycle:2", amountPaise: 49900, failureCode: "51_INSUFFICIENT_FUNDS" })
          });
          const data = await r.json();
          if (data.dunningCase?.id) p4State.dunningCaseId = data.dunningCase.id;
          show("dunOut", { status: r.status, body: data });
        }
        async function payNowRecover() {
          const r = await fetch("/api/dunning/" + p4State.dunningCaseId + "/pay-now", {
            method: "POST",
            headers: p4Headers(),
            body: JSON.stringify({ cardNumber: "4111111111114242", expiry: "12/29" })
          });
          show("dunOut", { status: r.status, body: await r.json() });
        }
        async function runEnachSample() {
          const r = await fetch("/api/enach/run-sample", { method: "POST", headers: p4Headers(), body: "{}" });
          show("invOut", { status: r.status, body: await r.json() });
        }
        async function createPaidInvoice() {
          const r = await fetch("/api/invoices/demo-paid", {
            method: "POST",
            headers: p4Headers(),
            body: JSON.stringify({ subscriptionId: p4State.subId || "sub_demo", umrn: p4State.umrn || "UMRNBANKA000001", amountPaise: 49900 })
          });
          const data = await r.json();
          show("invOut", r.ok ? data.printable + "\\n\\nMRR Parity: " + JSON.stringify(data.mrrParity) : { status: r.status, body: data });
        }
      `,
    });
  }
}
