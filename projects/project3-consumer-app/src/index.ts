import { createSeededTopology, CentralSwitch } from "@fintech/project1-switch";
import { ConsumerPspBackend } from "./psp-backend.ts";
import { ConsumerPayEngine } from "./pay-flows.ts";

export * from "./psp-backend.ts";
export * from "./pay-flows.ts";
export * from "./collect-and-limits.ts";
export * from "./risk-engine.ts";
export * from "./risk-shadow-mode.ts";
export * from "./dispute-desk.ts";
export * from "./consumer-server.ts";

export function createSeededConsumerPspTopology() {
  const p1 = createSeededTopology();
  const centralSwitch = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-20",
  });
  centralSwitch.registerBank(p1.banks.BANKA);
  centralSwitch.registerBank(p1.banks.BANKB);
  centralSwitch.registerBank(p1.banks.BANKC);
  centralSwitch.registerPsp(p1.psps.PSP1);
  centralSwitch.registerPsp(p1.psps.PSP2);

  const psp = new ConsumerPspBackend();
  psp.registerBank(p1.banks.BANKA);
  psp.registerBank(p1.banks.BANKB);
  psp.registerBank(p1.banks.BANKC);

  const payEngine = new ConsumerPayEngine({
    pspBackend: psp,
    p1Switch: centralSwitch,
    p1Psp: p1.psps.PSP1,
    allPsps: [p1.psps.PSP1, p1.psps.PSP2],
  });

  return { psp, payEngine, centralSwitch, p1 };
}
