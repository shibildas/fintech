import { createSeededTopology, CentralSwitch } from "@fintech/project1-switch";
import { AcquirerSimulator } from "./acquirer-simulator.ts";
import { PaymentGatewayEngine } from "./gateway-engine.ts";

export * from "./token-vault.ts";
export * from "./acquirer-simulator.ts";
export * from "./routing-engine.ts";
export * from "./webhook-worker.ts";
export * from "./gateway-engine.ts";

/**
 * Creates a ready-to-use Project 2 Gateway topology with:
 * - 3 Acquirer Simulators (`ACQ_ALPHA`, `ACQ_BETA`, `ACQ_GAMMA`)
 * - Seeded Routing Rules across CARD, NETBANKING, WALLET
 * - Integrated Project 1 CentralSwitch + PSP1/PSP2 for UPI Collect & Intent payments
 * - An onboarded and `ACTIVE` merchant (`Acme Books Store`)
 */
export function createSeededGatewayTopology() {
  const p1 = createSeededTopology();
  const centralSwitch = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-12",
  });
  centralSwitch.registerBank(p1.banks.BANKA);
  centralSwitch.registerBank(p1.banks.BANKB);
  centralSwitch.registerBank(p1.banks.BANKC);
  centralSwitch.registerPsp(p1.psps.PSP1);
  centralSwitch.registerPsp(p1.psps.PSP2);

  const gateway = new PaymentGatewayEngine({
    upiSwitch: centralSwitch,
    upiPsp: p1.psps.PSP1,
    merchantUpiVpa: "shop@psp2",
  });

  const acqAlpha = new AcquirerSimulator({
    acquirerId: "ACQ_ALPHA",
    name: "Acquirer Alpha (Primary Card & Netbanking)",
    supportedMethods: ["CARD", "NETBANKING", "WALLET"],
    baseLatencyMs: 2,
  });

  const acqBeta = new AcquirerSimulator({
    acquirerId: "ACQ_BETA",
    name: "Acquirer Beta (Secondary Failover)",
    supportedMethods: ["CARD", "NETBANKING", "WALLET"],
    baseLatencyMs: 4,
  });

  const acqGamma = new AcquirerSimulator({
    acquirerId: "ACQ_GAMMA",
    name: "Acquirer Gamma (RuPay & Backup)",
    supportedMethods: ["CARD", "NETBANKING"],
    baseLatencyMs: 6,
  });

  gateway.routing.registerAcquirer(acqAlpha);
  gateway.routing.registerAcquirer(acqBeta);
  gateway.routing.registerAcquirer(acqGamma);

  gateway.routing.addRoutingRule({
    id: "rule_card_alpha",
    method: "CARD",
    priorityOrder: 1,
    acquirerId: "ACQ_ALPHA",
  });
  gateway.routing.addRoutingRule({
    id: "rule_card_beta",
    method: "CARD",
    priorityOrder: 2,
    acquirerId: "ACQ_BETA",
  });
  gateway.routing.addRoutingRule({
    id: "rule_card_gamma",
    method: "CARD",
    priorityOrder: 3,
    acquirerId: "ACQ_GAMMA",
  });

  const onboarded = gateway.onboardMerchant({
    businessName: "Acme Books Store",
    contactEmail: "finance@acmebooks.in",
    settlementAccountNumber: "HDFC000998877",
    settlementBranchCode: "HDFC0000123",
    settlementHolderName: "Acme Books Pvt Ltd",
    returnUrl: "https://demo.acmebooks.in/checkout/return",
    mdrPlan: {
      cardBps: 200, // 2.00%
      upiBps: 0, // 0.00%
      netbankingBps: 150,
      walletBps: 180,
      gstBps: 1800, // 18% GST on MDR fee
      returnFeeOnRefund: false,
    },
  });

  gateway.transitionMerchantOnboarding({
    merchantId: onboarded.merchant.id,
    toState: "UNDER_REVIEW",
  });
  const activeMerchant = gateway.transitionMerchantOnboarding({
    merchantId: onboarded.merchant.id,
    toState: "ACTIVE",
  });

  return {
    gateway,
    p1: { ...p1, centralSwitch },
    acqAlpha,
    acqBeta,
    acqGamma,
    merchant: activeMerchant,
    testKey: onboarded.testKey,
    liveKey: onboarded.liveKey,
  };
}
