import http from "node:http";
import {
  CentralSwitch,
  SwitchAdminApp,
  createSeededTopology,
} from "@fintech/project1-switch";
import { createSeededGatewayTopology } from "@fintech/project2-gateway";
import { createSeededConsumerPspTopology } from "@fintech/project3-consumer-app";

type ServiceTarget = "p1" | "p2" | "p3";

function parseTargets(argv: string[]): Set<ServiceTarget> {
  const onlyArg = argv.find((arg) => arg.startsWith("--only="));
  if (!onlyArg) {
    return new Set<ServiceTarget>(["p1", "p2", "p3"]);
  }

  const raw = onlyArg.slice("--only=".length).split(",").map((s) => s.trim());
  const targets = new Set<ServiceTarget>();
  for (const item of raw) {
    if (item === "p1" || item === "p2" || item === "p3") {
      targets.add(item);
    } else {
      throw new Error(`Unknown service target "${item}". Expected p1, p2, or p3.`);
    }
  }
  return targets;
}

function writeJson(res: http.ServerResponse, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

function startSwitchServer(port: number): Promise<http.Server> {
  const topology = createSeededTopology();
  const sw = new CentralSwitch({
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-20",
  });
  sw.registerBank(topology.banks.BANKA);
  sw.registerBank(topology.banks.BANKB);
  sw.registerBank(topology.banks.BANKC);
  sw.registerPsp(topology.psps.PSP1);
  sw.registerPsp(topology.psps.PSP2);

  const app = new SwitchAdminApp({ sw, topology });
  const server = app.createHttpServer();

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p1:switch]   http://127.0.0.1:${port}  (/, /health, /metrics, /transactions)`);
      resolve(server);
    });
  });
}

function startGatewayServer(port: number): Promise<http.Server> {
  const ctx = createSeededGatewayTopology();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") {
      writeJson(res, 200, {
        service: "project2-gateway",
        status: "UP",
        merchantId: ctx.merchant.id,
        merchantName: ctx.merchant.business_name,
        acquirers: ["ACQ_ALPHA", "ACQ_BETA", "ACQ_GAMMA"],
      });
      return;
    }

    if (req.method === "GET" && url === "/") {
      writeJson(res, 200, {
        service: "project2-gateway",
        endpoints: ["/health"],
        seededMerchant: {
          id: ctx.merchant.id,
          name: ctx.merchant.business_name,
          status: ctx.merchant.state,
        },
      });
      return;
    }

    writeJson(res, 404, { error: "Not Found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p2:gateway]  http://127.0.0.1:${port}  (/, /health)`);
      resolve(server);
    });
  });
}

function startConsumerAppServer(port: number): Promise<http.Server> {
  const ctx = createSeededConsumerPspTopology();

  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (req.method === "GET" && url === "/health") {
      writeJson(res, 200, {
        service: "project3-consumer-app",
        status: "UP",
        registeredBanks: ["BANKA", "BANKB", "BANKC"],
        pspReady: Boolean(ctx.psp),
        payEngineReady: Boolean(ctx.payEngine),
      });
      return;
    }

    if (req.method === "GET" && url === "/") {
      writeJson(res, 200, {
        service: "project3-consumer-app",
        endpoints: ["/health"],
      });
      return;
    }

    writeJson(res, 404, { error: "Not Found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      console.log(`[p3:consumer] http://127.0.0.1:${port}  (/, /health)`);
      resolve(server);
    });
  });
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  const switchPort = Number(process.env.SWITCH_PORT ?? 3001);
  const gatewayPort = Number(process.env.GATEWAY_PORT ?? 3002);
  const consumerPort = Number(process.env.CONSUMER_PORT ?? 3003);

  const servers: http.Server[] = [];

  if (targets.has("p1")) {
    servers.push(await startSwitchServer(switchPort));
  }
  if (targets.has("p2")) {
    servers.push(await startGatewayServer(gatewayPort));
  }
  if (targets.has("p3")) {
    servers.push(await startConsumerAppServer(consumerPort));
  }

  console.log("Fintech stack orchestrator ready. Press Ctrl+C to stop.");

  const shutdown = (signal: string) => {
    console.log(`\nReceived ${signal}, shutting down ${servers.length} server(s)...`);
    let pending = servers.length;
    if (pending === 0) {
      process.exit(0);
    }
    for (const server of servers) {
      server.close(() => {
        pending -= 1;
        if (pending === 0) {
          process.exit(0);
        }
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
