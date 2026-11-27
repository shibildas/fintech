import type http from "node:http";
import { writeJsonResponse } from "@fintech/core";
import { EnachBankBatchSimulator } from "./enach-batch.ts";
import type { MandatesHttpServerContext } from "./mandates-context.ts";

/**
 * Slice 06 — Cycles, e-NACH Batch, Dunning & Tax Invoice/MRR route handler.
 */
export async function handleMandatesBillingRoute(params: {
  ctx: MandatesHttpServerContext;
  method: string;
  pathname: string;
  json: Record<string, unknown>;
  res: http.ServerResponse;
  origin?: string;
}): Promise<boolean> {
  const { ctx, method, pathname, json, res, origin } = params;

  if (method === "POST" && pathname === "/api/cycles/pre-debit") {
    const notice = ctx.executor.sendPreDebitNotice(
      String(json.subscriptionId ?? ""),
      Number(json.cycleNumber ?? 1)
    );
    writeJsonResponse(res, 201, notice, origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/cycles/execute") {
    const out = await ctx.executor.executeCycle({
      subscriptionId: String(json.subscriptionId ?? ""),
      cycleNumber: Number(json.cycleNumber ?? 1),
    });
    writeJsonResponse(res, 200, out, origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/enach/run-sample") {
    const simA = new EnachBankBatchSimulator("BANKA");
    const suffix = Date.now();
    const kDrop = `sub_demo_${suffix}_2:cycle:1`;
    simA.setDroppedRecord(kDrop);
    const batches = ctx.enach.generatePresentmentBatches(
      [
        {
          executionKey: `sub_demo_${suffix}_0:cycle:1`,
          merchantId: ctx.merchantId,
          subscriptionId: `sub_demo_${suffix}_0`,
          umrn: "UMRNDEMO00000001",
          bankId: "BANKA",
          amountPaise: 100_000,
        },
        {
          executionKey: `sub_demo_${suffix}_1:cycle:1`,
          merchantId: ctx.merchantId,
          subscriptionId: `sub_demo_${suffix}_1`,
          umrn: "UMRNDEMO00000002",
          bankId: "BANKA",
          amountPaise: 100_000,
        },
        {
          executionKey: kDrop,
          merchantId: ctx.merchantId,
          subscriptionId: `sub_demo_${suffix}_2`,
          umrn: "UMRNDEMO00000003",
          bankId: "BANKA",
          amountPaise: 100_000,
        },
      ],
      ctx.clock.now()
    );
    const respCsv = simA.processPresentmentAndBuildResponseCsv(
      batches[0].batchId,
      batches[0].presentmentCsv,
      ctx.clock.now()
    );
    writeJsonResponse(
      res,
      200,
      ctx.enach.ingestResponseCsv(batches[0].batchId, respCsv, ctx.clock.now()),
      origin
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/dunning/fail") {
    const out = await ctx.dunning.handleDebitFailure({
      subscriptionId: String(json.subscriptionId ?? ""),
      executionKey: String(json.executionKey ?? `sub:cycle:${Date.now()}`),
      amountPaise: Number(json.amountPaise ?? 49_900),
      failureCode: String(json.failureCode ?? "51_INSUFFICIENT_FUNDS"),
    });
    writeJsonResponse(res, 200, out, origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/dunning/process-due") {
    const simulateSuccess = Boolean(json.simulateSuccess);
    writeJsonResponse(
      res,
      200,
      await ctx.dunning.processDueRetries(async () => simulateSuccess),
      origin
    );
    return true;
  }

  const dunPay = pathname.match(/^\/api\/dunning\/([^/]+)\/pay-now$/);
  if (method === "POST" && dunPay) {
    const out = await ctx.dunning.recoverViaPayNowCard({
      dunningCaseId: decodeURIComponent(dunPay[1]),
      cardNumber: String(json.cardNumber ?? "4111111111114242"),
      expiry: String(json.expiry ?? "12/29"),
    });
    writeJsonResponse(res, 200, out, origin);
    return true;
  }

  if (method === "POST" && pathname === "/api/invoices") {
    const inv = ctx.invoices.createDraftInvoice({
      merchantId: ctx.merchantId,
      customerId: String(json.customerId ?? "cust_anita"),
      subscriptionId: String(json.subscriptionId ?? `sub_inv_${Date.now()}`),
      cycleNumber: Number(json.cycleNumber ?? 1),
      umrn: json.umrn ? String(json.umrn) : "UMRNBANKA000001",
      recurringAmountPaise: Number(json.amountPaise ?? 49_900),
      now: ctx.clock.now(),
    });
    writeJsonResponse(res, 201, inv, origin);
    return true;
  }

  const invPrint = pathname.match(/^\/api\/invoices\/([^/]+)\/printable$/);
  if (method === "GET" && invPrint) {
    const id = decodeURIComponent(invPrint[1]);
    writeJsonResponse(
      res,
      200,
      { invoiceId: id, printable: ctx.invoices.renderPrintableInvoice(id) },
      origin
    );
    return true;
  }

  if (method === "POST" && pathname === "/api/invoices/demo-paid") {
    const amountPaise = Number(json.amountPaise ?? 49_900);
    const subId = String(json.subscriptionId ?? `sub_inv_${Date.now()}`);
    ctx.invoices.recordMrrMovement({
      merchantId: ctx.merchantId,
      subscriptionId: subId,
      eventType: "NEW",
      deltaPaise: amountPaise,
      now: ctx.clock.now(),
    });
    const inv = ctx.invoices.createDraftInvoice({
      merchantId: ctx.merchantId,
      customerId: "cust_anita",
      subscriptionId: subId,
      cycleNumber: 1,
      umrn: json.umrn ? String(json.umrn) : "UMRNBANKA000001",
      recurringAmountPaise: amountPaise,
      now: ctx.clock.now(),
    });
    await ctx.invoices.issueInvoice(inv.id, ctx.clock.now());
    await ctx.invoices.markInvoicePaid({
      invoiceId: inv.id,
      paymentReference: `RRN-${Date.now().toString().slice(-12)}`,
      now: ctx.clock.now(),
    });
    writeJsonResponse(
      res,
      201,
      {
        invoice: ctx.invoices.getInvoice(inv.id),
        printable: ctx.invoices.renderPrintableInvoice(inv.id),
        mrrParity: ctx.invoices.verifyMrrMatchesPaidInvoices(ctx.merchantId),
      },
      origin
    );
    return true;
  }

  if (method === "GET" && pathname === "/api/invoices/mrr-parity") {
    writeJsonResponse(res, 200, ctx.invoices.verifyMrrMatchesPaidInvoices(ctx.merchantId), origin);
    return true;
  }

  return false;
}
