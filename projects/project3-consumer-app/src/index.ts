import { createSeededTopology } from "@fintech/project1-switch";
import { ConsumerPspBackend } from "./psp-backend.ts";

export * from "./psp-backend.ts";

export function createSeededConsumerPspTopology() {
  const p1 = createSeededTopology();
  const psp = new ConsumerPspBackend();
  psp.registerBank(p1.banks.BANKA);
  psp.registerBank(p1.banks.BANKB);
  psp.registerBank(p1.banks.BANKC);
  return { psp, p1 };
}
