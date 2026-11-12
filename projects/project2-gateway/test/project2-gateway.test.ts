import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  signServiceMessage,
  TokenBucketRateLimiter,
  IdempotencyConflictError,
} from "@fintech/core";
import {
  createSeededGatewayTopology,
  DemoStoreWebhookReceiver,
  runPciGrepTest,
} from "../src/index.ts";

describe("Project 2 — Merchant Payment Gateway, Smart Routing & Webhook Engine (Days 8-14)", () => {
  it("1. Card payment end-to-end with OTP -> payment.captured webhook verified by Demo Store -> order marked paid", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const webhookSecret = "whsec_demo_store_secret_001";
    const demoStore = new DemoStoreWebhookReceiver(webhookSecret);
    const webhookUrl = "https://demo.acmebooks.in/webhooks/gateway";

    gateway.webhooks.registerMockHttpTarget(webhookUrl, demoStore.createHandler());
    gateway.webhooks.registerEndpoint({
      merchantId: merchant.id,
      url: webhookUrl,
      secret: webhookSecret,
      events: ["payment.authorized", "payment.captured", "payment.failed"],
    });

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_order_001",
      amountPaise: 150000, // ₹1,500.00
      merchantOrderId: "rcpt_book_001",
      customerReference: "cust_rohan_01",
    });
    assert.equal(order.state, "CREATED");

    // Browser tokenizes directly with Vault (never passes raw PAN to Gateway DB)
    const tokenMeta = gateway.vault.tokenize({
      cardNumber: "4111111111114242",
      expiry: "12/29",
      merchantId: merchant.id,
      customerReference: "cust_rohan_01",
    });
    assert.equal(tokenMeta.network, "VISA");
    assert.equal(tokenMeta.bin6, "411111");
    assert.equal(tokenMeta.last_four, "4242");

    // Pay order with token + 3D-Secure OTP
    const payRes = await gateway.payOrder({
      orderId: order.id,
      method: "CARD",
      tokenId: tokenMeta.token,
      cardOtp: "123456",
    });

    assert.equal(payRes.payment.state, "CAPTURED");
    assert.equal(payRes.payment.acquirer_id, "ACQ_ALPHA");
    assert.equal(payRes.attempts.length, 1);

    // Demo Store verified X-Gateway-Signature and marked the order paid
    assert.equal(demoStore.paidMerchantOrderIds.has(order.id), true);
    assert.equal(demoStore.receivedEvents.length, 2); // payment.authorized + payment.captured
  });

  it("2. UPI Collect payment routed through Project 1 CentralSwitch", async () => {
    const { gateway, merchant, p1 } = createSeededGatewayTopology();

    const webhookSecret = "whsec_upi_store_secret";
    const demoStore = new DemoStoreWebhookReceiver(webhookSecret);
    const webhookUrl = "https://freshmart.in/webhook";

    gateway.webhooks.registerMockHttpTarget(webhookUrl, demoStore.createHandler());
    gateway.webhooks.registerEndpoint({
      merchantId: merchant.id,
      url: webhookUrl,
      secret: webhookSecret,
      events: ["payment.captured"],
    });

    const anitaBefore = p1.banks.BANKA.ledger.getBalance("987654324521");
    const shopBefore = p1.banks.BANKC.ledger.getBalance("765432103344");

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_order_upi_001",
      amountPaise: 50000, // ₹500.00
      merchantOrderId: "rcpt_upi_001",
    });

    const upiRes = await gateway.payOrder({
      orderId: order.id,
      method: "UPI",
      upiPayerVpa: "anita@psp1",
      upiRawPin: "1234",
    });

    assert.equal(upiRes.payment.state, "CAPTURED");
    assert.equal(upiRes.payment.acquirer_id, "PROJECT1_UPI_SWITCH");
    assert.equal(upiRes.payment.upi_switch_rrn?.length, 12);

    // Verify Project 1 Bank A (anita@psp1) and Bank C (shop@psp2) balances moved by ₹500.00 (50,000 paise)
    const anitaAfter = p1.banks.BANKA.ledger.getBalance("987654324521");
    const shopAfter = p1.banks.BANKC.ledger.getBalance("765432103344");
    assert.equal(anitaBefore.ledger_balance_paise - anitaAfter.ledger_balance_paise, 50000);
    assert.equal(shopAfter.ledger_balance_paise - shopBefore.ledger_balance_paise, 50000);
    assert.equal(demoStore.paidMerchantOrderIds.has(order.id), true);
  });

  it("3. ACQ_ALPHA down -> card payment fails over to ACQ_BETA within the same session and succeeds; both attempts logged", async () => {
    const { gateway, merchant, acqAlpha } = createSeededGatewayTopology();

    // Put ACQ_ALPHA down
    acqAlpha.setChaos({ forceDown: true });

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_order_failover_01",
      amountPaise: 250000,
      merchantOrderId: "rcpt_failover_01",
    });

    const tokenMeta = gateway.vault.tokenize({
      cardNumber: "4111111111119999",
      expiry: "10/28",
      merchantId: merchant.id,
    });

    const res = await gateway.payOrder({
      orderId: order.id,
      method: "CARD",
      tokenId: tokenMeta.token,
      cardOtp: "123456",
    });

    assert.equal(res.payment.state, "CAPTURED");
    assert.equal(res.payment.acquirer_id, "ACQ_BETA");
    assert.equal(res.attempts.length, 2);

    const attempts = gateway.listPaymentAttempts(res.payment.id);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].acquirer_id, "ACQ_ALPHA");
    assert.equal(attempts[0].state, "FAILED");
    assert.equal(attempts[0].acquirer_response_code, "91_ACQUIRER_DOWN");

    assert.equal(attempts[1].acquirer_id, "ACQ_BETA");
    assert.equal(attempts[1].state, "SUCCEEDED");
    assert.equal(attempts[1].acquirer_response_code, "00_APPROVED");
  });

  it("4. Business decline (wrong OTP / insufficient funds) is NOT retried on another acquirer", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_order_decline_01",
      amountPaise: 80000,
      merchantOrderId: "rcpt_decline_01",
    });

    const tokenMeta = gateway.vault.tokenize({
      cardNumber: "4111111111110051",
      expiry: "08/28",
      merchantId: merchant.id,
    });

    const res = await gateway.payOrder({
      orderId: order.id,
      method: "CARD",
      tokenId: tokenMeta.token,
      cardOtp: "000000", // Wrong OTP -> 55_WRONG_OTP Business Decline
    });

    assert.equal(res.payment.state, "FAILED");
    assert.equal(res.attempts.length, 1); // Strictly 1 attempt — never retried on ACQ_BETA!
    assert.equal(res.attempts[0].acquirer_response_code, "55_WRONG_OTP");
  });

  it("5. 10 concurrent identical order-creation calls create exactly 1 order; mismatched payload returns 409", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        gateway.createOrder({
          merchantId: merchant.id,
          idempotencyKey: "idem_concurrent_10",
          amountPaise: 99900,
          merchantOrderId: "rcpt_concurrent_10",
        })
      )
    );

    const uniqueOrderIds = new Set(results.map((r) => r.order.id));
    assert.equal(uniqueOrderIds.size, 1);

    // Same idempotency key with different amount must throw 409 IdempotencyConflictError
    await assert.rejects(
      async () =>
        gateway.createOrder({
          merchantId: merchant.id,
          idempotencyKey: "idem_concurrent_10",
          amountPaise: 100000,
          merchantOrderId: "rcpt_concurrent_10",
        }),
      (err: unknown) =>
        err instanceof IdempotencyConflictError && err.statusCode === 409
    );
  });

  it("6. Saved card token reuse & 100-Card-Payment Grep Test finds ZERO raw PANs across all DBs and logs", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const rawPansUsed: string[] = [];
    let savedToken = "";

    for (let i = 0; i < 100; i++) {
      const { order } = await gateway.createOrder({
        merchantId: merchant.id,
        idempotencyKey: `idem_order_pci_${i}`,
        amountPaise: 10000 + i * 100,
        merchantOrderId: `rcpt_pci_${i}`,
        customerReference: i <= 1 ? "cust_repeat" : `cust_${i}`,
      });

      if (i === 1 && savedToken) {
        // Second purchase uses saved card token — no raw PAN passed
        const savedList = gateway.vault.listCustomerSavedTokens(
          merchant.id,
          "cust_repeat"
        );
        assert.equal(savedList.length, 1);
        assert.equal(savedList[0].token, savedToken);

        const done = await gateway.payOrder({
          orderId: order.id,
          method: "CARD",
          tokenId: savedToken,
          cardOtp: "123456",
        });
        assert.equal(done.payment.state, "CAPTURED");
      } else {
        const suffix = String(1000 + i).slice(-4);
        const pan = `555555555555${suffix}`;
        rawPansUsed.push(pan);

        const tok = gateway.vault.tokenize({
          cardNumber: pan,
          expiry: "11/29",
          merchantId: merchant.id,
          customerReference: i === 0 ? "cust_repeat" : `cust_${i}`,
        });
        if (i === 0) {
          savedToken = tok.token;
        }

        const done = await gateway.payOrder({
          orderId: order.id,
          method: "CARD",
          tokenId: tok.token,
          cardOtp: "123456",
        });
        assert.equal(done.payment.state, "CAPTURED");
      }
    }

    const grepAudit = runPciGrepTest({
      gatewayDb: gateway.gatewayDb,
      vaultDb: gateway.vault.vaultDb,
      structuredLogs: gateway.structuredLogs,
      rawPansUsed,
    });
    assert.equal(grepAudit.passed, true);
    assert.equal(grepAudit.leaksFound.length, 0);
  });

  it("7. Partial refund twice, then third refund exceeding captured amount is rejected (422); ledger & dashboard agree", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_order_refund_1",
      amountPaise: 100000, // ₹1,000.00
      merchantOrderId: "rcpt_refund_test",
    });

    const tok = gateway.vault.tokenize({
      cardNumber: "4111111111118888",
      expiry: "05/29",
      merchantId: merchant.id,
    });

    const payRes = await gateway.payOrder({
      orderId: order.id,
      method: "CARD",
      tokenId: tok.token,
      cardOtp: "123456",
    });

    // Partial refund 1: ₹400.00 (40,000 paise)
    const r1 = await gateway.createRefund({
      paymentId: payRes.payment.id,
      amountPaise: 40000,
      idempotencyKey: "idem_ref_1",
    });
    assert.equal(r1.refund.state, "PROCESSED");
    assert.equal(gateway.getPayment(payRes.payment.id)?.state, "PARTIALLY_REFUNDED");

    // Partial refund 2: ₹350.00 (35,000 paise)
    const r2 = await gateway.createRefund({
      paymentId: payRes.payment.id,
      amountPaise: 35000,
      idempotencyKey: "idem_ref_2",
    });
    assert.equal(r2.refund.state, "PROCESSED");
    assert.equal(gateway.getPayment(payRes.payment.id)?.refunded_amount_paise, 75000);

    // Third refund: ₹300.00 (30,000 paise) -> Total 105,000 > 100,000 -> Must reject with 422
    await assert.rejects(
      async () =>
        gateway.createRefund({
          paymentId: payRes.payment.id,
          amountPaise: 30000,
          idempotencyKey: "idem_ref_3",
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 422
    );

    // Dashboard and double-entry ledger balance must match to the paisa
    const reconciliation = gateway.verifyDashboardMatchesLedger(merchant.id);
    assert.equal(reconciliation.matches, true);
    // Gross captured 100,000 - MDR 2,000 - GST 360 - Refunds 75,000 = 22,640 paise
    assert.equal(reconciliation.ledger_payable_paise, 22640);
    assert.equal(reconciliation.dashboard_balance_paise, 22640);
  });

  it("8. Webhook endpoint returns 500 -> exponential backoff retries -> FAILING after 24h -> manual resend succeeds", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const webhookSecret = "whsec_flaky_secret";
    const demoStore = new DemoStoreWebhookReceiver(webhookSecret);
    demoStore.simulateServer500 = true;

    const webhookUrl = "https://flaky.in/webhook";
    gateway.webhooks.registerMockHttpTarget(webhookUrl, demoStore.createHandler());
    const ep = gateway.webhooks.registerEndpoint({
      merchantId: merchant.id,
      url: webhookUrl,
      secret: webhookSecret,
      events: ["payment.captured"],
    });

    let clockMs = Date.parse("2026-11-15T10:00:00.000Z");

    // Initial publish fails with 500 and schedules 1m retry
    const [initialDelivery] = await gateway.webhooks.publishEvent({
      merchantId: merchant.id,
      eventType: "payment.captured",
      objectData: { order_id: "ord_flaky_1", amount_paise: 50000 },
      now: new Date(clockMs),
    });
    assert.equal(initialDelivery.status, "RETRY_SCHEDULED");
    assert.equal(initialDelivery.attempt, 1);

    // Walk through the 6 exponential backoff intervals: 1m, 5m, 30m, 2h, 6h, 24h
    const backoffMinutes = [1, 5, 30, 120, 360, 1440];
    for (const mins of backoffMinutes) {
      clockMs += mins * 60 * 1000;
      await gateway.webhooks.processDueRetries(new Date(clockMs));
    }

    const afterExhausted = gateway.webhooks.getDelivery(initialDelivery.id)!;
    assert.equal(afterExhausted.status, "GAVE_UP");
    assert.equal(afterExhausted.attempt, 7);
    assert.equal(gateway.webhooks.getEndpoint(ep.id)?.state, "FAILING");

    // Merchant fixes server and triggers manual resend from dashboard
    demoStore.simulateServer500 = false;
    const resent = await gateway.webhooks.resendDelivery(
      initialDelivery.id,
      new Date(clockMs + 60_000)
    );
    assert.equal(resent.status, "DELIVERED");
    assert.equal(gateway.webhooks.getEndpoint(ep.id)?.state, "ACTIVE");
    assert.equal(demoStore.paidMerchantOrderIds.has("ord_flaky_1"), true);
  });

  it("9. T+1 Merchant Payout produces settlement CSV whose net equals ledger payable balance (with MDR & 18% GST)", async () => {
    const { gateway, merchant } = createSeededGatewayTopology();

    const { order } = await gateway.createOrder({
      merchantId: merchant.id,
      idempotencyKey: "idem_order_payout_01",
      amountPaise: 200000, // ₹2,000.00
      merchantOrderId: "rcpt_payout_01",
    });

    const tok = gateway.vault.tokenize({
      cardNumber: "4111111111113333",
      expiry: "09/29",
      merchantId: merchant.id,
    });

    await gateway.payOrder({
      orderId: order.id,
      method: "CARD",
      tokenId: tok.token,
      cardOtp: "123456",
    });

    // Before payout: Gross 200,000 - MDR 4,000 - GST 720 = 195,280 paise
    const beforeCheck = gateway.verifyDashboardMatchesLedger(merchant.id);
    assert.equal(beforeCheck.ledger_payable_paise, 195280);

    const payout = await gateway.runMerchantPayout({
      merchantId: merchant.id,
      periodLabel: "2026-11-16",
    });
    assert.equal(payout.gross_paise, 200000);
    assert.equal(payout.fees_paise, 4000);
    assert.equal(payout.tax_paise, 720);
    assert.equal(payout.net_paise, 195280);
    assert.ok(payout.report_csv.includes("PAYMENT,"));
    assert.ok(payout.report_csv.includes("BATCH_TOTAL,SUMMARY,ALL,200000,4000,720,195280"));

    // After payout: Merchant payable balance is swept to 0
    const afterCheck = gateway.verifyDashboardMatchesLedger(merchant.id);
    assert.equal(afterCheck.ledger_payable_paise, 0);
  });

  it("10. Rotate API key: calls signed with old secret work during overlap window and fail after expiry", () => {
    const { gateway, merchant, liveKey } = createSeededGatewayTopology();

    let clockMs = Date.parse("2026-11-18T12:00:00.000Z");
    const oldSecret = liveKey.secret;

    const rotated = gateway.rotateApiKey({
      merchantId: merchant.id,
      mode: "LIVE",
      overlapWindowMs: 60 * 60 * 1000, // 1 hour overlap
      now: new Date(clockMs),
    });
    assert.notEqual(rotated.newSecret, oldSecret);

    // 30 minutes later: old secret still authenticates within overlap window
    clockMs += 30 * 60 * 1000;
    const nowIso1 = new Date(clockMs).toISOString();
    const rawBody1 = JSON.stringify({ amount_paise: 50000 });
    const sigOldValid = signServiceMessage(rawBody1, nowIso1, oldSecret);

    const auth1 = gateway.authenticateMerchantRequest({
      keyId: liveKey.keyId,
      rawBody: rawBody1,
      timestampIso: nowIso1,
      signature: sigOldValid,
      now: new Date(clockMs),
    });
    assert.equal(auth1.merchant.id, merchant.id);

    // 45 minutes later (total 75m > 60m overlap): old secret is rejected with 401, new secret works
    clockMs += 45 * 60 * 1000;
    const nowIso2 = new Date(clockMs).toISOString();
    const rawBody2 = JSON.stringify({ amount_paise: 60000 });
    const sigOldExpired = signServiceMessage(rawBody2, nowIso2, oldSecret);

    assert.throws(
      () =>
        gateway.authenticateMerchantRequest({
          keyId: liveKey.keyId,
          rawBody: rawBody2,
          timestampIso: nowIso2,
          signature: sigOldExpired,
          now: new Date(clockMs),
        }),
      (err: Error & { statusCode?: number }) => err.statusCode === 401
    );

    const sigNewValid = signServiceMessage(rawBody2, nowIso2, rotated.newSecret);
    const auth2 = gateway.authenticateMerchantRequest({
      keyId: liveKey.keyId,
      rawBody: rawBody2,
      timestampIso: nowIso2,
      signature: sigNewValid,
      now: new Date(clockMs),
    });
    assert.equal(auth2.merchant.id, merchant.id);
  });

  it("11. Fintech DSA (Day 8): O(1) Token-Bucket Rate Limiter enforces burst & refill rates and returns ISO 96", () => {
    let clockMs = 1_000_000;
    const limiter = new TokenBucketRateLimiter(3, 1);

    // Burst of 3 requests succeeds immediately
    assert.equal(limiter.tryConsume("MERCHANT_A", 1, clockMs).allowed, true);
    assert.equal(limiter.tryConsume("MERCHANT_A", 1, clockMs).allowed, true);
    assert.equal(limiter.tryConsume("MERCHANT_A", 1, clockMs).allowed, true);

    // 4th immediate request is throttled with ISO code 96
    const blocked = limiter.tryConsume("MERCHANT_A", 1, clockMs);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.isoResponseCode, "96");
    assert.equal(blocked.retryAfterMs, 1000);

    // Advance clock by 1.5 seconds -> 1.5 tokens refilled -> 1 request allowed
    clockMs += 1500;
    assert.equal(limiter.tryConsume("MERCHANT_A", 1, clockMs).allowed, true);
    assert.equal(limiter.tryConsume("MERCHANT_A", 1, clockMs).allowed, false);
  });
});
