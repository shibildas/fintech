import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { InjectableFakeClock, generateDeviceEd25519KeyPair } from "@fintech/core";
import { createSeededGatewayTopology } from "@fintech/project2-gateway";
import {
  ConsumerPspBackend,
  RealTimeRiskEngine,
  ConsumerDisputeDesk,
} from "@fintech/project3-consumer-app";
import {
  MandateService,
  SubscriptionService,
  RecurringCycleExecutor,
  DunningEngine,
  InvoiceAndMrrService,
} from "../src/index.ts";

describe("Day 29 — Unified 4-Project Full-Stack E2E Integration (Switch + Gateway + Consumer App/Risk + Mandates)", () => {
  it("Executes an end-to-end journey spanning all 4 projects with zero ledger drift", async () => {
    const clock = new InjectableFakeClock("2026-12-03T04:30:00.000Z"); // 10:00 AM IST

    // Project 1 + Project 2 unified topology
    const { gateway, p1, merchant } = createSeededGatewayTopology();

    // Project 3: Onboard customer Anita, bind Ed25519 device, score payment in Risk Engine
    const pspBackend = new ConsumerPspBackend();
    pspBackend.registerBank(p1.banks.BANKA);
    const signup = pspBackend.signup({
      mobileNumber: "9876543210",
      fullName: "Anita Sharma",
      now: clock.now(),
    });
    pspBackend.verifySmsOtp("9876543210", signup.mockSmsOtp);
    const keys = generateDeviceEd25519KeyPair();
    pspBackend.bindDevice({
      customerId: signup.customer.id,
      deviceId: "dev_e2e_anita",
      publicKeyPem: keys.publicKeyPem,
      deviceModel: "Pixel 9",
      now: clock.now(),
    });

    const risk = new RealTimeRiskEngine();
    const riskDecision = risk.scorePayment({
      paymentId: "pay_e2e_init",
      customerId: signup.customer.id,
      deviceId: "dev_e2e_anita",
      payeeVpa: "shop@psp2",
      amountPaise: 49_900,
      isNewDevice24h: false,
      isNewCounterparty: false,
      now: clock.now(),
    });
    assert.equal(riskDecision.decision, "ALLOW");

    // Project 4: Authorize AutoPay Mandate (UMRN) -> Activate Subscription -> 24h Pre-Debit Gate -> Switch Debit
    const mandates = new MandateService();
    const subs = new SubscriptionService({ mandates, clock });
    const executor = new RecurringCycleExecutor({
      mandates,
      subs,
      p1Switch: p1.centralSwitch,
      p1Psp: p1.psps.PSP1,
      merchantVpa: "shop@psp2",
      clock,
    });
    const dunning = new DunningEngine({ subs, gateway, clock });
    const invoices = new InvoiceAndMrrService({ webhooks: gateway.webhooks });

    const mandate = mandates.createMandate({
      merchantId: merchant.id,
      customerId: signup.customer.id,
      payerVpa: "anita@psp1",
      bankId: "BANKA",
      accountNumberMasked: "XXXX4521",
      rail: "UPI_AUTOPAY",
      maxAmountPaise: 100_000,
      monthlyAggregateCapPaise: 300_000,
      validUntilIso: "2028-12-03T00:00:00.000Z",
      now: clock.now(),
    });
    const activeMandate = mandates.authorizeMandate({
      mandateId: mandate.id,
      authCredential: "1234",
      now: clock.now(),
    });
    assert.ok(activeMandate.umrn?.startsWith("UMRN"));

    const plan = subs.createPlan({
      merchantId: merchant.id,
      name: "FullStack SaaS Monthly",
      interval: "MONTHLY",
      amountPaise: 49_900,
    });
    const sub = subs.createSubscription({
      merchantId: merchant.id,
      customerId: signup.customer.id,
      planId: plan.id,
      mandateId: mandate.id,
    });
    subs.activateSubscription(sub.id);

    // Cycle 1: 24h Pre-Debit Notice -> Execute via Project 1 Switch -> Post to Project 2 Ledger & Project 4 Invoice
    executor.sendPreDebitNotice(sub.id, 1);
    clock.advanceByHours(24);
    const exec1 = await executor.executeCycle({ subscriptionId: sub.id, cycleNumber: 1 });
    assert.equal(exec1.execution.state, "SUCCEEDED");
    assert.equal(exec1.execution.switch_rrn?.length, 12);

    gateway.postExternalSubscriptionCapture({
      merchantId: merchant.id,
      referenceId: exec1.execution.switch_rrn!,
      amountPaise: 49_900,
      method: "UPI",
      now: clock.now(),
    });

    invoices.recordMrrMovement({
      merchantId: merchant.id,
      subscriptionId: sub.id,
      eventType: "NEW",
      deltaPaise: 49_900,
      now: clock.now(),
    });
    const inv1 = invoices.createDraftInvoice({
      merchantId: merchant.id,
      customerId: signup.customer.id,
      subscriptionId: sub.id,
      cycleNumber: 1,
      umrn: activeMandate.umrn,
      recurringAmountPaise: 49_900,
      now: clock.now(),
    });
    await invoices.issueInvoice(inv1.id, clock.now());
    await invoices.markInvoicePaid({
      invoiceId: inv1.id,
      paymentReference: exec1.execution.switch_rrn!,
      now: clock.now(),
    });

    // Cycle 2: Soft failure -> Dunning -> Pay-Now recovery via Project 2 Gateway Vault & Card Acquirer
    const dun = await dunning.handleDebitFailure({
      subscriptionId: sub.id,
      executionKey: `${sub.id}:cycle:2`,
      amountPaise: 49_900,
      failureCode: "51_INSUFFICIENT_FUNDS",
    });
    assert.equal(subs.getSubscription(sub.id)?.state, "PAST_DUE");
    const payNow = await dunning.recoverViaPayNowCard({
      dunningCaseId: dun.dunningCase.id,
      cardNumber: "4111111111114242",
      expiry: "12/29",
    });
    assert.equal(payNow.paymentState, "CAPTURED");
    assert.equal(subs.getSubscription(sub.id)?.state, "ACTIVE");

    // Cross-check Project 3 Dispute Desk auto-resolution + Project 2 Dashboard/Ledger parity + Project 4 MRR parity
    const disputes = new ConsumerDisputeDesk();
    const dsp = disputes.openDispute({
      customerId: signup.customer.id,
      switchRrn: exec1.execution.switch_rrn!,
      category: "DEBITED_NOT_CREDITED",
      amountPaise: 49_900,
      customerNote: "E2E audit check",
      now: clock.now(),
    });
    const resolved = disputes.handleSwitchReversalEvent({
      switchRrn: exec1.execution.switch_rrn!,
      reversalReference: "REV-E2E-001",
      now: clock.now(),
    });
    assert.equal(resolved[0].id, dsp.id);
    assert.equal(resolved[0].state, "RESOLVED_CREDITED");

    assert.equal(gateway.verifyDashboardMatchesLedger(merchant.id).matches, true);
    assert.equal(invoices.verifyMrrMatchesPaidInvoices(merchant.id).matches, true);
  });
});
