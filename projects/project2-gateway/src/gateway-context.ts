import path from "node:path";
import { ensureDataDir, UiAuthStore } from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { AcquirerSimulator } from "./acquirer-simulator.ts";
import { PaymentGatewayEngine } from "./gateway-engine.ts";
import { TokenVaultService } from "./token-vault.ts";
import { DemoStoreWebhookReceiver } from "./webhook-worker.ts";

/**
 * Persistent context bootstrapper for Project 2 Gateway (:3002).
 */
export interface GatewayHttpServerContext {
  gateway: PaymentGatewayEngine;
  uiAuth: UiAuthStore;
  acqAlpha: AcquirerSimulator;
  acqBeta: AcquirerSimulator;
  acqGamma: AcquirerSimulator;
  demoStore: DemoStoreWebhookReceiver;
  seededMerchantId: string;
  seededKeyId: string;
  seededApiSecret: string;
  seededWebhookSecret: string;
}

export function createPersistentGatewayContext(options?: {
  dataDir?: string;
}): GatewayHttpServerContext {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const gwDbPath = options?.dataDir ? path.join(options.dataDir, "p2-gateway.sqlite") : ":memory:";
  const vaultDbPath = options?.dataDir ? path.join(options.dataDir, "p2-vault.sqlite") : ":memory:";
  const p2BanksDir = options?.dataDir ? path.join(options.dataDir, "p2-banks") : undefined;
  const p2SwitchPath = options?.dataDir
    ? path.join(options.dataDir, "p2-switch.sqlite")
    : ":memory:";

  const p1 = createSeededTopology(p2BanksDir ? { dataDir: p2BanksDir } : undefined);
  const sw = new CentralSwitch({
    dbPath: p2SwitchPath,
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const vault = new TokenVaultService({ dbPath: vaultDbPath });
  const gateway = new PaymentGatewayEngine({
    gatewayDbPath: gwDbPath,
    vault,
    upiSwitch: sw,
    upiPsp: p1.psps.PSP1,
    merchantUpiVpa: "shop@psp2",
  });

  if (options?.dataDir) {
    gateway.gatewayDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    vault.vaultDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }

  const acqAlpha = new AcquirerSimulator({
    acquirerId: "ACQ_ALPHA",
    name: "Acquirer Alpha (Primary)",
    supportedMethods: ["CARD", "NETBANKING", "WALLET"],
    baseLatencyMs: 2,
  });
  const acqBeta = new AcquirerSimulator({
    acquirerId: "ACQ_BETA",
    name: "Acquirer Beta (Failover)",
    supportedMethods: ["CARD", "NETBANKING", "WALLET"],
    baseLatencyMs: 4,
  });
  const acqGamma = new AcquirerSimulator({
    acquirerId: "ACQ_GAMMA",
    name: "Acquirer Gamma (Backup)",
    supportedMethods: ["CARD", "NETBANKING"],
    baseLatencyMs: 6,
  });

  gateway.routing.registerAcquirer(acqAlpha);
  gateway.routing.registerAcquirer(acqBeta);
  gateway.routing.registerAcquirer(acqGamma);
  gateway.routing.addRoutingRule({
    id: "r1",
    method: "CARD",
    priorityOrder: 1,
    acquirerId: "ACQ_ALPHA",
  });
  gateway.routing.addRoutingRule({
    id: "r2",
    method: "CARD",
    priorityOrder: 2,
    acquirerId: "ACQ_BETA",
  });
  gateway.routing.addRoutingRule({
    id: "r3",
    method: "CARD",
    priorityOrder: 3,
    acquirerId: "ACQ_GAMMA",
  });

  const existingMerchant = gateway.gatewayDb
    .prepare(`SELECT id FROM merchants WHERE business_name = 'Acme Books Store' LIMIT 1`)
    .get() as { id: string } | undefined;

  let merchantId: string;
  let keyId: string;
  let apiSecret: string;

  if (existingMerchant) {
    merchantId = existingMerchant.id;
    const keyRow = gateway.gatewayDb
      .prepare(`SELECT key_id, active_secret FROM api_keys WHERE merchant_id = ? AND mode = 'LIVE'`)
      .get(merchantId) as { key_id: string; active_secret: string };
    keyId = keyRow.key_id;
    apiSecret = keyRow.active_secret;
  } else {
    const onboarded = gateway.onboardMerchant({
      businessName: "Acme Books Store",
      contactEmail: "finance@acmebooks.in",
      settlementAccountNumber: "HDFC000998877",
      settlementBranchCode: "HDFC0000123",
      settlementHolderName: "Acme Books Pvt Ltd",
      returnUrl: "https://demo.acmebooks.in/checkout/return",
    });
    gateway.transitionMerchantOnboarding({
      merchantId: onboarded.merchant.id,
      toState: "UNDER_REVIEW",
    });
    gateway.transitionMerchantOnboarding({ merchantId: onboarded.merchant.id, toState: "ACTIVE" });
    merchantId = onboarded.merchant.id;
    keyId = onboarded.liveKey.keyId;
    apiSecret = onboarded.liveKey.secret;
  }

  const webhookUrl = "https://demo.acmebooks.in/webhooks/gateway";
  const existingEps = gateway.webhooks.listMerchantEndpoints(merchantId);
  const webhookSecret =
    existingEps.length > 0 ? existingEps[0].secret : "whsec_demo_store_live_2026";
  if (existingEps.length === 0) {
    gateway.webhooks.registerEndpoint({
      merchantId,
      url: webhookUrl,
      secret: webhookSecret,
      events: [
        "payment.authorized",
        "payment.captured",
        "payment.failed",
        "refund.processed",
        "settlement.processed",
      ],
    });
  }

  const demoStore = new DemoStoreWebhookReceiver(webhookSecret);
  gateway.webhooks.registerMockHttpTarget(webhookUrl, demoStore.createHandler());

  const uiAuth = new UiAuthStore({
    db: gateway.gatewayDb,
    cookieName: "fintech_sess_p2",
    seedUsers: [
      {
        username: "acme.user",
        password: process.env.P2_USER_PASSWORD ?? "GateUser#2026",
        role: "user",
        displayName: "Acme Ops User",
      },
      {
        username: "acme.admin",
        password: process.env.P2_ADMIN_PASSWORD ?? "GateAdmin#2026",
        role: "admin",
        displayName: "Acme Finance Admin",
      },
    ],
  });

  return {
    gateway,
    uiAuth,
    acqAlpha,
    acqBeta,
    acqGamma,
    demoStore,
    seededMerchantId: merchantId,
    seededKeyId: keyId,
    seededApiSecret: apiSecret,
    seededWebhookSecret: webhookSecret,
  };
}
