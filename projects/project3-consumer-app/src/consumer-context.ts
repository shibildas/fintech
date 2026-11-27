import path from "node:path";
import { ensureDataDir, UiAuthStore } from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { ConsumerPspBackend } from "./psp-backend.ts";
import { ConsumerPayEngine } from "./pay-flows.ts";
import { CollectRequestEngine, PspLimitProfileEngine } from "./collect-and-limits.ts";
import { RealTimeRiskEngine } from "./risk-engine.ts";
import { VersionedShadowRiskEngine } from "./risk-shadow-mode.ts";
import { ConsumerDisputeDesk } from "./dispute-desk.ts";

/**
 * Persistent context bootstrapper for Project 3 Consumer App, Risk Engine & Disputes (:3003).
 */
export interface ConsumerHttpServerContext {
  psp: ConsumerPspBackend;
  uiAuth: UiAuthStore;
  payEngine: ConsumerPayEngine;
  collects: CollectRequestEngine;
  risk: RealTimeRiskEngine;
  shadow: VersionedShadowRiskEngine;
  disputes: ConsumerDisputeDesk;
  opsToken: string;
}

export function createPersistentConsumerContext(options?: {
  dataDir?: string;
  opsToken?: string;
}): ConsumerHttpServerContext {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const dbPath = (file: string) =>
    options?.dataDir ? path.join(options.dataDir, file) : ":memory:";
  const p3BanksDir = options?.dataDir ? path.join(options.dataDir, "p3-banks") : undefined;

  const p1 = createSeededTopology(p3BanksDir ? { dataDir: p3BanksDir } : undefined);
  const sw = new CentralSwitch({
    dbPath: dbPath("p3-switch.sqlite"),
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const psp = new ConsumerPspBackend(dbPath("p3-consumer.sqlite"));
  psp.registerBank(p1.banks.BANKA);
  psp.registerBank(p1.banks.BANKB);
  psp.registerBank(p1.banks.BANKC);

  const payEngine = new ConsumerPayEngine({
    pspBackend: psp,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    allPsps: [p1.psps.PSP1, p1.psps.PSP2],
  });

  const limits = new PspLimitProfileEngine(psp);
  const collects = new CollectRequestEngine({
    pspBackend: psp,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    limits,
  });

  const risk = new RealTimeRiskEngine(dbPath("p3-risk.sqlite"));
  const shadow = new VersionedShadowRiskEngine(dbPath("p3-risk.sqlite"));
  if (!shadow.hasRulesets()) {
    shadow.registerRuleset({
      version: "v1.0",
      status: "ACTIVE",
      rules: [
        {
          ruleId: "NEW_CP_5K",
          weight: 50,
          description: "New counterparty >= ₹5,000",
          ast: {
            type: "AND",
            children: [
              { type: "CMP", field: "is_new_counterparty", op: "EQ", value: true },
              { type: "CMP", field: "amount_paise", op: "GTE", value: 500_000 },
            ],
          },
        },
      ],
    });
    shadow.registerRuleset({
      version: "v2.0-strict",
      status: "SHADOW",
      rules: [
        {
          ruleId: "NEW_CP_2K",
          weight: 50,
          description: "New counterparty >= ₹2,000",
          ast: {
            type: "AND",
            children: [
              { type: "CMP", field: "is_new_counterparty", op: "EQ", value: true },
              { type: "CMP", field: "amount_paise", op: "GTE", value: 200_000 },
            ],
          },
        },
      ],
    });
  }

  const disputes = new ConsumerDisputeDesk(dbPath("p3-disputes.sqlite"));

  if (options?.dataDir) {
    for (const db of [sw.db, psp.db, risk.db, disputes.db]) {
      db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    }
  }

  const uiAuth = new UiAuthStore({
    db: psp.db,
    cookieName: "fintech_sess_p3",
    seedUsers: [
      {
        username: "anita.user",
        password: process.env.P3_USER_PASSWORD ?? "ConsUser#2026",
        role: "user",
        displayName: "Anita Sharma (Consumer)",
      },
      {
        username: "risk.admin",
        password: process.env.P3_ADMIN_PASSWORD ?? "RiskAdmin#2026",
        role: "admin",
        displayName: "Risk & Ops Admin",
      },
    ],
  });

  return {
    psp,
    uiAuth,
    payEngine,
    collects,
    risk,
    shadow,
    disputes,
    opsToken: options?.opsToken ?? process.env.P3_OPS_TOKEN ?? "p3_dev_ops_token_2026",
  };
}
