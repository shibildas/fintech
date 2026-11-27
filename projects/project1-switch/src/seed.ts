import path from "node:path";
import { ensureDataDir } from "../../../packages/core/src/index.ts";
import { BankCoreSimulator } from "./bank-core.ts";
import { PspSimulator } from "./psp-simulator.ts";

/**
 * Common Rule 16 & Project 1 Systems Table (Page 4):
 * - 3 Bank Core Simulators (same code, different configuration: BANKA, BANKB, BANKC)
 * - 2 PSP Simulators (PSP1, PSP2)
 * - Pre-seeded accounts and VPA mappings (`anita@psp1`, `rahul@psp1`, `shop@psp2`, `coffee@psp2`)
 */

export interface SeededProject1Topology {
  banks: {
    BANKA: BankCoreSimulator;
    BANKB: BankCoreSimulator;
    BANKC: BankCoreSimulator;
  };
  psps: {
    PSP1: PspSimulator;
    PSP2: PspSimulator;
  };
}

export function createSeededTopology(options?: { dataDir?: string }): SeededProject1Topology {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const bankDb = (name: string) =>
    options?.dataDir ? path.join(options.dataDir, name) : ":memory:";

  const BANKA = new BankCoreSimulator({
    bankId: "BANKA",
    bankName: "Apex National Bank",
    branchPrefix: "BNKA0001",
    sharedSecret: "secret_bank_a_shared_with_switch",
    dbPath: bankDb("p1-bankA.sqlite"),
  });

  const BANKB = new BankCoreSimulator({
    bankId: "BANKB",
    bankName: "Bharat State Bank",
    branchPrefix: "BNKB0001",
    sharedSecret: "secret_bank_b_shared_with_switch",
    dbPath: bankDb("p1-bankB.sqlite"),
  });

  const BANKC = new BankCoreSimulator({
    bankId: "BANKC",
    bankName: "Commerce Citi Bank",
    branchPrefix: "BNKC0001",
    sharedSecret: "secret_bank_c_shared_with_switch",
    dbPath: bankDb("p1-bankC.sqlite"),
  });

  const PSP1 = new PspSimulator({
    pspId: "PSP1",
    handleSuffix: "psp1",
    sharedSecret: "secret_psp_1_shared_with_switch",
  });

  const PSP2 = new PspSimulator({
    pspId: "PSP2",
    handleSuffix: "psp2",
    sharedSecret: "secret_psp_2_shared_with_switch",
  });

  const seedAccountIfMissing = (
    bank: BankCoreSimulator,
    acct: Parameters<BankCoreSimulator["seedCustomerAccount"]>[0]
  ) => {
    const exists = bank.db
      .prepare(`SELECT 1 FROM accounts WHERE account_number = ?`)
      .get(acct.accountNumber);
    if (!exists) {
      bank.seedCustomerAccount(acct);
    }
  };

  // Seed Bank Accounts idempotently (preserves balances across persistent .data/ restarts)
  seedAccountIfMissing(BANKA, {
    accountNumber: "987654324521",
    holderName: "Anita Sharma",
    rawPin: "1234",
    openingBalancePaise: 1_000_000,
    perTransactionLimitPaise: 500_000,
    dailyLimitPaise: 1_000_000,
  });

  seedAccountIfMissing(BANKB, {
    accountNumber: "876543218899",
    holderName: "Rahul Verma",
    rawPin: "5678",
    openingBalancePaise: 500_000,
  });

  seedAccountIfMissing(BANKB, {
    accountNumber: "876543217766",
    holderName: "Indiranagar Filter Coffee",
    rawPin: "1111",
    openingBalancePaise: 100_000,
  });

  seedAccountIfMissing(BANKC, {
    accountNumber: "765432103344",
    holderName: "Koramangala Book Shop",
    rawPin: "4321",
    openingBalancePaise: 200_000,
  });

  // Seed VPA Directory Mappings at PSP1 and PSP2
  PSP1.registerVpa({
    vpa: "anita@psp1",
    bankId: "BANKA",
    accountNumber: "987654324521",
    holderName: "Anita Sharma",
  });

  PSP1.registerVpa({
    vpa: "rahul@psp1",
    bankId: "BANKB",
    accountNumber: "876543218899",
    holderName: "Rahul Verma",
  });

  PSP2.registerVpa({
    vpa: "shop@psp2",
    bankId: "BANKC",
    accountNumber: "765432103344",
    holderName: "Koramangala Book Shop",
  });

  PSP2.registerVpa({
    vpa: "coffee@psp2",
    bankId: "BANKB",
    accountNumber: "876543217766",
    holderName: "Indiranagar Filter Coffee",
  });

  return {
    banks: { BANKA, BANKB, BANKC },
    psps: { PSP1, PSP2 },
  };
}
