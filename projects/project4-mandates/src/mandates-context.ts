import path from "node:path";
import { ensureDataDir, InjectableFakeClock } from "@fintech/core";
import { CentralSwitch, createSeededTopology } from "@fintech/project1-switch";
import { createPersistentGatewayContext } from "@fintech/project2-gateway";
import { MandateService } from "./mandate-service.ts";
import { SubscriptionService } from "./subscription-service.ts";
import { RecurringCycleExecutor } from "./cycle-executor.ts";
import { EnachPresentmentEngine } from "./enach-batch.ts";
import { DunningEngine } from "./dunning-engine.ts";
import { InvoiceAndMrrService } from "./invoices-and-analytics.ts";

/**
 * Persistent context bootstrapper for Project 4 Mandates & Subscriptions (:3004).
 */
export interface MandatesHttpServerContext {
  clock: InjectableFakeClock;
  mandates: MandateService;
  subs: SubscriptionService;
  executor: RecurringCycleExecutor;
  enach: EnachPresentmentEngine;
  dunning: DunningEngine;
  invoices: InvoiceAndMrrService;
  merchantId: string;
  merchantToken: string;
  persistClock: () => void;
}

export function createPersistentMandatesContext(options?: {
  dataDir?: string;
  merchantToken?: string;
}): MandatesHttpServerContext {
  if (options?.dataDir) {
    ensureDataDir(options.dataDir);
  }
  const dbPath = options?.dataDir ? path.join(options.dataDir, "p4-mandates.sqlite") : ":memory:";
  const p4GwDir = options?.dataDir ? path.join(options.dataDir, "p4-gateway") : undefined;
  const p4BanksDir = options?.dataDir ? path.join(options.dataDir, "p4-banks") : undefined;
  const p4SwitchPath = options?.dataDir
    ? path.join(options.dataDir, "p4-switch.sqlite")
    : ":memory:";

  const p1 = createSeededTopology(p4BanksDir ? { dataDir: p4BanksDir } : undefined);
  const sw = new CentralSwitch({
    dbPath: p4SwitchPath,
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1.banks.BANKA);
  sw.registerBank(p1.banks.BANKB);
  sw.registerBank(p1.banks.BANKC);
  sw.registerPsp(p1.psps.PSP1);
  sw.registerPsp(p1.psps.PSP2);

  const gwCtx = createPersistentGatewayContext(p4GwDir ? { dataDir: p4GwDir } : undefined);
  const mandates = new MandateService(dbPath);

  if (options?.dataDir) {
    mandates.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    sw.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }

  mandates.db.exec(`
    CREATE TABLE IF NOT EXISTS fake_clock_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      current_iso TEXT NOT NULL
    );
  `);
  const savedClock = mandates.db
    .prepare(`SELECT current_iso FROM fake_clock_state WHERE id = 1`)
    .get() as { current_iso: string } | undefined;

  const clock = new InjectableFakeClock(savedClock?.current_iso ?? "2026-01-31T04:30:00.000Z");
  const persistClock = () => {
    mandates.db
      .prepare(
        `INSERT INTO fake_clock_state (id, current_iso) VALUES (1, ?)
         ON CONFLICT(id) DO UPDATE SET current_iso = excluded.current_iso`
      )
      .run(clock.now().toISOString());
  };
  persistClock();

  const subs = new SubscriptionService({ mandates, clock, dbPath });
  const executor = new RecurringCycleExecutor({
    mandates,
    subs,
    p1Switch: sw,
    p1Psp: p1.psps.PSP1,
    merchantVpa: "shop@psp2",
    clock,
    dbPath,
  });
  const enach = new EnachPresentmentEngine({ gateway: gwCtx.gateway, dbPath });
  const dunning = new DunningEngine({ subs, gateway: gwCtx.gateway, clock, dbPath });
  const invoices = new InvoiceAndMrrService({ webhooks: gwCtx.gateway.webhooks, dbPath });

  return {
    clock,
    mandates,
    subs,
    executor,
    enach,
    dunning,
    invoices,
    merchantId: gwCtx.seededMerchantId,
    merchantToken:
      options?.merchantToken ?? process.env.P4_MERCHANT_TOKEN ?? "p4_dev_merchant_token_2026",
    persistClock,
  };
}
