import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  assertPaiseInteger,
  formatInrFromPaise,
  aggregateMrrMovements,
  type MrrMovementEvent,
  type MrrMovementSummary,
} from "@fintech/core";
import type { WebhookDeliveryWorker } from "@fintech/project2-gateway";

/**
 * Project 4 (Day 27) — Printable Invoices, MRR/Churn Analytics & Revenue-to-Invoice Invariant
 *
 * Invoice Lifecycle: `DRAFT -> ISSUED -> PAID | VOID | UNCOLLECTIBLE`
 * Accounting Invariant: `MRR (recurring_paise) + one_time_charges_paise === sum(PAID invoices)`
 */

export type InvoiceState = "DRAFT" | "ISSUED" | "PAID" | "VOID" | "UNCOLLECTIBLE";

export interface InvoiceRecord {
  id: string;
  merchant_id: string;
  customer_id: string;
  subscription_id: string;
  cycle_number: number;
  umrn: string | null;
  recurring_amount_paise: number;
  one_time_adjustment_paise: number;
  total_amount_paise: number;
  state: InvoiceState;
  payment_reference: string | null;
  issued_at: string | null;
  paid_at: string | null;
  created_at: string;
}

const ALLOWED_INVOICE_TRANSITIONS: Record<InvoiceState, InvoiceState[]> = {
  DRAFT: ["ISSUED", "VOID"],
  ISSUED: ["PAID", "VOID", "UNCOLLECTIBLE"],
  PAID: [],
  VOID: [],
  UNCOLLECTIBLE: [],
};

export class InvoiceAndMrrService {
  public readonly db: DatabaseSync;
  private readonly webhooks?: WebhookDeliveryWorker;

  constructor(params?: { webhooks?: WebhookDeliveryWorker; dbPath?: string }) {
    this.db = new DatabaseSync(params?.dbPath ?? ":memory:");
    this.webhooks = params?.webhooks;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS invoices (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        customer_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        cycle_number INTEGER NOT NULL,
        umrn TEXT,
        recurring_amount_paise INTEGER NOT NULL,
        one_time_adjustment_paise INTEGER NOT NULL DEFAULT 0,
        total_amount_paise INTEGER NOT NULL,
        state TEXT NOT NULL CHECK (state IN ('DRAFT', 'ISSUED', 'PAID', 'VOID', 'UNCOLLECTIBLE')),
        payment_reference TEXT,
        issued_at TEXT,
        paid_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mrr_events (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        subscription_id TEXT NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type IN ('NEW', 'EXPANSION', 'CONTRACTION', 'CHURN')),
        delta_paise INTEGER NOT NULL CHECK (delta_paise >= 0),
        created_at TEXT NOT NULL
      );
    `);
  }

  public createDraftInvoice(params: {
    merchantId: string;
    customerId: string;
    subscriptionId: string;
    cycleNumber: number;
    umrn?: string | null;
    recurringAmountPaise: number;
    oneTimeAdjustmentPaise?: number;
    now?: Date;
  }): InvoiceRecord {
    assertPaiseInteger(params.recurringAmountPaise, "recurringAmountPaise");
    const oneTime = params.oneTimeAdjustmentPaise ?? 0;
    assertPaiseInteger(oneTime, "oneTimeAdjustmentPaise");
    const total = params.recurringAmountPaise + oneTime;
    if (total < 0) {
      throw new Error("Invoice total_amount_paise cannot be negative");
    }

    const id = `inv_${crypto.randomUUID().slice(0, 10)}`;
    const nowIso = (params.now ?? new Date()).toISOString();

    this.db
      .prepare(
        `INSERT INTO invoices (
          id, merchant_id, customer_id, subscription_id, cycle_number, umrn,
          recurring_amount_paise, one_time_adjustment_paise, total_amount_paise,
          state, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'DRAFT', ?)`
      )
      .run(
        id,
        params.merchantId,
        params.customerId,
        params.subscriptionId,
        params.cycleNumber,
        params.umrn ?? null,
        params.recurringAmountPaise,
        oneTime,
        total,
        nowIso
      );

    return this.getInvoice(id)!;
  }

  public async issueInvoice(invoiceId: string, now = new Date()): Promise<InvoiceRecord> {
    const inv = this.getInvoice(invoiceId);
    if (!inv) {
      throw new Error(`Invoice "${invoiceId}" not found`);
    }
    this.assertTransition(inv.state, "ISSUED");
    const nowIso = now.toISOString();

    this.db
      .prepare(`UPDATE invoices SET state = 'ISSUED', issued_at = ? WHERE id = ?`)
      .run(nowIso, invoiceId);

    const updated = this.getInvoice(invoiceId)!;
    if (this.webhooks) {
      await this.webhooks.publishEvent({
        merchantId: inv.merchant_id,
        eventType: "invoice.issued",
        objectData: updated,
        now,
      });
    }
    return updated;
  }

  public async markInvoicePaid(params: {
    invoiceId: string;
    paymentReference: string;
    now?: Date;
  }): Promise<InvoiceRecord> {
    const now = params.now ?? new Date();
    const inv = this.getInvoice(params.invoiceId);
    if (!inv) {
      throw new Error(`Invoice "${params.invoiceId}" not found`);
    }
    this.assertTransition(inv.state, "PAID");
    const nowIso = now.toISOString();

    this.db
      .prepare(
        `UPDATE invoices SET state = 'PAID', payment_reference = ?, paid_at = ? WHERE id = ?`
      )
      .run(params.paymentReference, nowIso, inv.id);

    const updated = this.getInvoice(inv.id)!;
    if (this.webhooks) {
      await this.webhooks.publishEvent({
        merchantId: inv.merchant_id,
        eventType: "invoice.paid",
        objectData: updated,
        now,
      });
    }
    return updated;
  }

  public markInvoiceTerminal(
    invoiceId: string,
    toState: "VOID" | "UNCOLLECTIBLE"
  ): InvoiceRecord {
    const inv = this.getInvoice(invoiceId);
    if (!inv) {
      throw new Error(`Invoice "${invoiceId}" not found`);
    }
    this.assertTransition(inv.state, toState);
    this.db.prepare(`UPDATE invoices SET state = ? WHERE id = ?`).run(toState, invoiceId);
    return this.getInvoice(invoiceId)!;
  }

  public recordMrrMovement(params: {
    merchantId: string;
    subscriptionId: string;
    eventType: MrrMovementEvent["type"];
    deltaPaise: number;
    now?: Date;
  }): void {
    assertPaiseInteger(params.deltaPaise, "deltaPaise");
    this.db
      .prepare(
        `INSERT INTO mrr_events (id, merchant_id, subscription_id, event_type, delta_paise, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        `mrr_${crypto.randomUUID().slice(0, 10)}`,
        params.merchantId,
        params.subscriptionId,
        params.eventType,
        params.deltaPaise,
        (params.now ?? new Date()).toISOString()
      );
  }

  public computeMerchantMrrSummary(merchantId: string): MrrMovementSummary {
    const rows = this.db
      .prepare(`SELECT event_type, delta_paise FROM mrr_events WHERE merchant_id = ?`)
      .all(merchantId) as Array<{ event_type: MrrMovementEvent["type"]; delta_paise: number }>;

    return aggregateMrrMovements(
      rows.map((r) => ({ type: r.event_type, deltaPaise: r.delta_paise }))
    );
  }

  /**
   * Accounting Invariant:
   * `sum(recurring_amount_paise) + sum(one_time_adjustment_paise) === sum(total_amount_paise)`
   * across all `PAID` invoices, and equals `netMrrPaise + oneTimePaise` when MRR is synced!
   */
  public verifyMrrMatchesPaidInvoices(merchantId: string): {
    matches: boolean;
    mrrSummary: MrrMovementSummary;
    paidInvoicesRecurringPaise: number;
    paidInvoicesOneTimePaise: number;
    paidInvoicesTotalPaise: number;
  } {
    const mrrSummary = this.computeMerchantMrrSummary(merchantId);
    const agg = this.db
      .prepare(
        `SELECT
           COALESCE(SUM(recurring_amount_paise), 0) AS rec_sum,
           COALESCE(SUM(one_time_adjustment_paise), 0) AS ot_sum,
           COALESCE(SUM(total_amount_paise), 0) AS tot_sum
         FROM invoices
         WHERE merchant_id = ? AND state = 'PAID'`
      )
      .get(merchantId) as { rec_sum: number; ot_sum: number; tot_sum: number };

    const matches =
      mrrSummary.netMrrPaise + agg.ot_sum === agg.tot_sum &&
      agg.rec_sum + agg.ot_sum === agg.tot_sum;

    return {
      matches,
      mrrSummary,
      paidInvoicesRecurringPaise: agg.rec_sum,
      paidInvoicesOneTimePaise: agg.ot_sum,
      paidInvoicesTotalPaise: agg.tot_sum,
    };
  }

  public renderPrintableInvoice(invoiceId: string): string {
    const inv = this.getInvoice(invoiceId);
    if (!inv) {
      throw new Error(`Invoice "${invoiceId}" not found`);
    }
    return [
      `========================================`,
      `TAX INVOICE & MANDATE RECEIPT — ${inv.id}`,
      `========================================`,
      `Merchant:     ${inv.merchant_id}`,
      `Customer:     ${inv.customer_id}`,
      `Subscription: ${inv.subscription_id} (Cycle #${inv.cycle_number})`,
      `UMRN:         ${inv.umrn ?? "N/A"}`,
      `Status:       ${inv.state}`,
      `----------------------------------------`,
      `Recurring Plan Charge: ${formatInrFromPaise(inv.recurring_amount_paise)}`,
      `Proration / One-Time:  ${formatInrFromPaise(inv.one_time_adjustment_paise)}`,
      `TOTAL AMOUNT:          ${formatInrFromPaise(inv.total_amount_paise)}`,
      `Payment Reference:     ${inv.payment_reference ?? "UNPAID"}`,
      `========================================`,
    ].join("\n");
  }

  public getInvoice(invoiceId: string): InvoiceRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM invoices WHERE id = ?`)
      .get(invoiceId) as unknown as InvoiceRecord | undefined;
  }

  private assertTransition(from: InvoiceState, to: InvoiceState): void {
    if (!ALLOWED_INVOICE_TRANSITIONS[from].includes(to)) {
      throw new Error(`Invalid invoice transition from "${from}" to "${to}"`);
    }
  }
}
