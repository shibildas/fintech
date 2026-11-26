import http from "node:http";
import path from "node:path";
import { ensureDataDir } from "@fintech/core";
import {
  CentralSwitch,
  SwitchAdminApp,
  createSeededTopology,
} from "@fintech/project1-switch";
import {
  createPersistentGatewayContext,
  GatewayHttpServer,
} from "@fintech/project2-gateway";
import {
  createPersistentConsumerContext,
  ConsumerHttpServer,
} from "@fintech/project3-consumer-app";
import {
  createPersistentMandatesContext,
  MandatesHttpServer,
} from "@fintech/project4-mandates";

type ServiceTarget = "p1" | "p2" | "p3" | "p4";

const DATA_DIR = path.resolve(process.cwd(), ".data");

function parseTargets(argv: string[]): Set<ServiceTarget> {
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  if (!onlyArg) {
    return new Set<ServiceTarget>(["p1", "p2", "p3", "p4"]);
  }

  const raw = onlyArg.slice("--only=".length).split(",").map((s) => s.trim());
  const targets = new Set<ServiceTarget>();
  for (const item of raw) {
    if (item === "p1" || item === "p2" || item === "p3" || item === "p4") {
      targets.add(item);
    } else {
      throw new Error(`Unknown service target "${item}". Expected p1, p2, p3, or p4.`);
    }
  }
  return targets;
}

function startSwitchServer(port: number): Promise<http.Server> {
  const topology = createSeededTopology({ dataDir: DATA_DIR });
  const sw = new CentralSwitch({
    dbPath: path.join(DATA_DIR, "p1-switch.sqlite"),
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(topology.banks.BANKA);
  sw.registerBank(topology.banks.BANKB);
  sw.registerBank(topology.banks.BANKC);
  sw.registerPsp(topology.psps.PSP1);
  sw.registerPsp(topology.psps.PSP2);

  const adminToken = process.env.P1_ADMIN_TOKEN ?? "p1_dev_admin_token_2026";
  const app = new SwitchAdminApp({ sw, topology, adminToken });
  const server = app.createHttpServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p1:switch]   http://127.0.0.1:${port}/  (X-Admin-Token: ${adminToken} | Seeded PINs: anita=1234, rahul=5678)`);
      resolve(server);
    });
  });
}

function startGatewayServer(port: number): Promise<http.Server> {
  const ctx = createPersistentGatewayContext({ dataDir: DATA_DIR });
  const server = new GatewayHttpServer(ctx).createHttpServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p2:gateway]  http://127.0.0.1:${port}/  (X-Key-Id: ${ctx.seededKeyId} | API Secret: ${ctx.seededApiSecret})`);
      resolve(server);
    });
  });
}

function startConsumerAppServer(port: number): Promise<http.Server> {
  const ctx = createPersistentConsumerContext({ dataDir: DATA_DIR });
  const server = new ConsumerHttpServer(ctx).createHttpServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p3:consumer] http://127.0.0.1:${port}/  (X-Ops-Token: ${ctx.opsToken} | Mock SMS OTP: 123456)`);
      resolve(server);
    });
  });
}

function startMandatesServer(port: number): Promise<http.Server> {
  const ctx = createPersistentMandatesContext({ dataDir: DATA_DIR });
  const server = new MandatesHttpServer(ctx).createHttpServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p4:mandates] http://127.0.0.1:${port}/  (X-Merchant-Token: ${ctx.merchantToken} | AutoPay PIN: 1234 | e-NACH OTP: 654321)`);
      resolve(server);
    });
  });
}

async function main(): Promise<void> {
  ensureDataDir(DATA_DIR);
  const targets = parseTargets(process.argv.slice(2));
  const switchPort = Number(process.env.SWITCH_PORT ?? 3001);
  const gatewayPort = Number(process.env.GATEWAY_PORT ?? 3002);
  const consumerPort = Number(process.env.CONSUMER_PORT ?? 3003);
  const mandatesPort = Number(process.env.MANDATES_PORT ?? 3004);

  const servers: http.Server[] = [];

  if (targets.has("p1")) servers.push(await startSwitchServer(switchPort));
  if (targets.has("p2")) servers.push(await startGatewayServer(gatewayPort));
  if (targets.has("p3")) servers.push(await startConsumerAppServer(consumerPort));
  if (targets.has("p4")) servers.push(await startMandatesServer(mandatesPort));

  console.log(`\nFintech stack orchestrator ready (SQLite persisted under ${DATA_DIR}). Press Ctrl+C to stop.`);

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down ${servers.length} server(s)...`);
    let pending = servers.length;
    if (pending === 0) process.exit(0);
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) process.exit(0);
      });
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start fintech stack:", err);
  process.exit(1);
});
