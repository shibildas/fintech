import http from "node:http";
import path from "node:path";
import { ensureDataDir } from "@fintech/core";
import { CentralSwitch, SwitchAdminApp, createSeededTopology } from "@fintech/project1-switch";
import { createPersistentGatewayContext, GatewayHttpServer } from "@fintech/project2-gateway";
import {
  createPersistentConsumerContext,
  ConsumerHttpServer,
} from "@fintech/project3-consumer-app";
import { createPersistentMandatesContext, MandatesHttpServer } from "@fintech/project4-mandates";

/**
 * Single-Port Cloud Entrypoint for Hugging Face Spaces (PORT=7860) / Render / Koyeb.
 *
 * Mounts all 4 isolated microservices behind one public HTTP server on 0.0.0.0:$PORT:
 *   /        -> 302 redirect to /p1/
 *   /health  -> aggregated health check
 *   /p1/*    -> Project 1 Switch (:13001)
 *   /p2/*    -> Project 2 Gateway (:13002)
 *   /p3/*    -> Project 3 Consumer & Risk (:13003)
 *   /p4/*    -> Project 4 Mandates & Subscriptions (:13004)
 */

process.env.CLOUD_SINGLE_PORT = "true";

const PUBLIC_PORT = Number(process.env.PORT ?? 7860);
const DATA_DIR = path.resolve(process.env.FINTECH_DATA_DIR ?? path.join(process.cwd(), ".data"));

function listenLocal(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve(addr.port);
    });
  });
}

function proxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPort: number,
  targetPath: string
): void {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: `127.0.0.1:${targetPort}` };
  const upstream = http.request(
    {
      hostname: "127.0.0.1",
      port: targetPort,
      method: req.method,
      path: targetPath,
      headers,
    },
    (upRes) => {
      res.writeHead(upRes.statusCode ?? 502, upRes.headers);
      upRes.pipe(res);
    }
  );
  upstream.on("error", (err) => {
    if (!res.headersSent) {
      res.writeHead(502, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: `Upstream unavailable: ${err.message}` }));
    }
  });
  req.pipe(upstream);
}

async function main(): Promise<void> {
  ensureDataDir(DATA_DIR);

  // 1. Boot Project 1 Switch
  const p1Topo = createSeededTopology({ dataDir: DATA_DIR });
  const sw = new CentralSwitch({
    dbPath: path.join(DATA_DIR, "p1-switch.sqlite"),
    bankTimeoutMs: 500,
    maxCreditRetries: 2,
    activeCycleId: "CYC-2026-11-26",
  });
  sw.registerBank(p1Topo.banks.BANKA);
  sw.registerBank(p1Topo.banks.BANKB);
  sw.registerBank(p1Topo.banks.BANKC);
  sw.registerPsp(p1Topo.psps.PSP1);
  sw.registerPsp(p1Topo.psps.PSP2);
  for (const db of [sw.db, p1Topo.banks.BANKA.db, p1Topo.banks.BANKB.db, p1Topo.banks.BANKC.db]) {
    db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
  }
  const p1Token = process.env.P1_ADMIN_TOKEN ?? "p1_dev_admin_token_2026";
  const s1 = new SwitchAdminApp({ sw, topology: p1Topo, adminToken: p1Token }).createHttpServer();

  // 2. Boot Project 2 Gateway
  const p2Ctx = createPersistentGatewayContext({ dataDir: DATA_DIR });
  const s2 = new GatewayHttpServer(p2Ctx).createHttpServer();

  // 3. Boot Project 3 Consumer & Risk
  const p3Ctx = createPersistentConsumerContext({ dataDir: DATA_DIR });
  const s3 = new ConsumerHttpServer(p3Ctx).createHttpServer();

  // 4. Boot Project 4 Mandates
  const p4Ctx = createPersistentMandatesContext({ dataDir: DATA_DIR });
  const s4 = new MandatesHttpServer(p4Ctx).createHttpServer();

  const ports = {
    p1: await listenLocal(s1, 0),
    p2: await listenLocal(s2, 0),
    p3: await listenLocal(s3, 0),
    p4: await listenLocal(s4, 0),
  };

  // 5. Public Single-Port Router on 0.0.0.0:$PORT
  const publicServer = http.createServer((req, res) => {
    const rawUrl = req.url ?? "/";
    if (rawUrl === "/" || rawUrl === "") {
      res.writeHead(302, { location: "/p1/" });
      res.end();
      return;
    }
    if (rawUrl === "/health") {
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      res.end(
        JSON.stringify({
          status: "UP",
          mode: "cloud-single-port",
          routes: ["/p1/", "/p2/", "/p3/", "/p4/"],
        })
      );
      return;
    }

    const match = rawUrl.match(/^\/(p[1-4])(\/.*|\?.*)?$/);
    if (!match) {
      res.writeHead(404, { "content-type": "application/json; charset=utf-8" });
      res.end(JSON.stringify({ error: "Not Found. Visit /p1/, /p2/, /p3/, or /p4/." }));
      return;
    }

    const service = match[1] as keyof typeof ports;
    const rest = match[2] ?? "";
    if (rest === "" || rest.startsWith("?")) {
      res.writeHead(302, { location: `/${service}/${rest}` });
      res.end();
      return;
    }
    proxyRequest(req, res, ports[service], rest);
  });

  await new Promise<void>((resolve, reject) => {
    publicServer.once("error", reject);
    publicServer.listen(PUBLIC_PORT, "0.0.0.0", resolve);
  });

  console.log(`\nFintech Stack Cloud Server listening on http://0.0.0.0:${PUBLIC_PORT}/`);
  console.log(
    `[p1:switch]   /p1/  (X-Admin-Token: ${p1Token} | Seeded PINs: anita=1234, rahul=5678)`
  );
  console.log(
    `[p2:gateway]  /p2/  (X-Key-Id: ${p2Ctx.seededKeyId} | API Secret: ${p2Ctx.seededApiSecret})`
  );
  console.log(`[p3:consumer] /p3/  (X-Ops-Token: ${p3Ctx.opsToken} | Mock SMS OTP: 123456)`);
  console.log(
    `[p4:mandates] /p4/  (X-Merchant-Token: ${p4Ctx.merchantToken} | AutoPay PIN: 1234 | e-NACH OTP: 654321)\n`
  );

  const allServers = [publicServer, s1, s2, s3, s4];
  let isShuttingDown = false;
  const shutdown = (signal: string) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`\nReceived ${signal}, gracefully shutting down cloud server...`);
    let pending = allServers.length;
    const forceTimer = setTimeout(() => {
      for (const srv of allServers) srv.closeAllConnections?.();
      process.exit(0);
    }, 5_000);
    forceTimer.unref();

    for (const srv of allServers) {
      srv.close(() => {
        pending -= 1;
        if (pending === 0) {
          clearTimeout(forceTimer);
          process.exit(0);
        }
      });
      srv.closeIdleConnections?.();
    }
  };

  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((err) => {
  console.error("Failed to start cloud server:", err);
  process.exit(1);
});
