import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { RevenuePrefixSumIndex } from "@fintech/core";
import { InvoiceAndMrrService } from "../src/index.ts";

describe("Day 27 — Project 4: Printable Invoices, MRR/Churn Analytics & Revenue-to-Invoice Invariant", () => {
  it("1. Invoice lifecycle (DRAFT -> ISSUED -> PAID), printable receipt & MRR-to-Paid-Invoice invariant", async () => {
    const svc = new InvoiceAndMrrService();
    const merchantId = "merch_saas_pro";

    // Sub 1: New ₹499/mo + mid-cycle expansion +₹500/mo + ₹250 one-time proration
    svc.recordMrrMovement({ merchantId, subscriptionId: "sub_1", eventType: "NEW", deltaPaise: 49_900 });
    svc.recordMrrMovement({ merchantId, subscriptionId: "sub_1", eventType: "EXPANSION", deltaPaise: 50_000 });

    const inv1 = svc.createDraftInvoice({
      merchantId,
      customerId: "cust_anita",
      subscriptionId: "sub_1",
      cycleNumber: 1,
      umrn: "UMRNBANKA000001",
      recurringAmountPaise: 99_900,
      oneTimeAdjustmentPaise: 25_000,
    });
    await svc.issueInvoice(inv1.id);
    await svc.markInvoicePaid({ invoiceId: inv1.id, paymentReference: "RRN-633510000001" });

    // Sub 2: New ₹1,000/mo then churned -₹1,000/mo -> invoice marked UNCOLLECTIBLE
    svc.recordMrrMovement({ merchantId, subscriptionId: "sub_2", eventType: "NEW", deltaPaise: 100_000 });
    svc.recordMrrMovement({ merchantId, subscriptionId: "sub_2", eventType: "CHURN", deltaPaise: 100_000 });

    const inv2 = svc.createDraftInvoice({
      merchantId,
      customerId: "cust_rahul",
      subscriptionId: "sub_2",
      cycleNumber: 1,
      recurringAmountPaise: 100_000,
    });
    await svc.issueInvoice(inv2.id);
    svc.markInvoiceTerminal(inv2.id, "UNCOLLECTIBLE");

    // Invariant: netMrrPaise (99,900) + oneTime (25,000) === sum(PAID invoices = 124,900)
    const recon = svc.verifyMrrMatchesPaidInvoices(merchantId);
    assert.equal(recon.matches, true);
    assert.equal(recon.mrrSummary.netMrrPaise, 99_900);
    assert.equal(recon.paidInvoicesTotalPaise, 124_900);

    const printable = svc.renderPrintableInvoice(inv1.id);
    assert.ok(printable.includes("UMRNBANKA000001"));
    assert.ok(printable.includes("RRN-633510000001"));
  });

  it("2. Day 27 Fintech DSA: RevenuePrefixSumIndex answers arbitrary date-range revenue queries in O(1)", () => {
    const dailyPaise = [10_000, 20_000, 35_000, 15_000, 50_000];
    const index = new RevenuePrefixSumIndex(dailyPaise);

    assert.equal(index.rangeSum(0, 4), 130_000);
    assert.equal(index.rangeSum(1, 3), 70_000);
    assert.equal(index.rangeSum(2, 2), 35_000);
  });
});
