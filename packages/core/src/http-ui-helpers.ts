import type http from "node:http";
import fs from "node:fs";

/**
 * Shared HTTP & UI Helpers for Interactive Microservice Dashboards (:3001–:3004).
 * Zero external runtime dependencies — Node 24 built-ins + Browser SubtleCrypto.
 */

function getConfiguredPorts(): {
  p1: number;
  p2: number;
  p3: number;
  p4: number;
} {
  return {
    p1: Number(process.env.SWITCH_PORT ?? 3001),
    p2: Number(process.env.GATEWAY_PORT ?? 3002),
    p3: Number(process.env.CONSUMER_PORT ?? 3003),
    p4: Number(process.env.MANDATES_PORT ?? 3004),
  };
}

export function getAllowedCorsOrigin(requestOrigin?: string): string {
  const { p1, p2, p3, p4 } = getConfiguredPorts();
  const allowed = new Set<string>([
    `http://127.0.0.1:${p1}`,
    `http://127.0.0.1:${p2}`,
    `http://127.0.0.1:${p3}`,
    `http://127.0.0.1:${p4}`,
    `http://localhost:${p1}`,
    `http://localhost:${p2}`,
    `http://localhost:${p3}`,
    `http://localhost:${p4}`,
  ]);
  if (requestOrigin && allowed.has(requestOrigin)) {
    return requestOrigin;
  }
  return `http://127.0.0.1:${p1}`;
}

export function buildCorsHeaders(requestOrigin?: string): Record<string, string> {
  return {
    "access-control-allow-origin": getAllowedCorsOrigin(requestOrigin),
    "vary": "Origin",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Content-Type, X-Role, X-Actor-Id, X-Admin-Token, X-Request-Id, X-Key-Id, X-Timestamp, X-Signature, X-Device-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature, X-Ops-Token, X-Merchant-Token, X-Onboarding-Token",
  };
}

export const CORS_HEADERS: Record<string, string> = buildCorsHeaders();

export function escapeHtml(raw: string): string {
  return raw
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function mapErrorToHttpStatus(err: unknown): number {
  const explicit = (err as { statusCode?: number })?.statusCode;
  if (typeof explicit === "number" && explicit >= 400 && explicit <= 599) {
    return explicit;
  }
  const name = err instanceof Error ? err.name : "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (name === "NetworkDropSimulatedError" || msg.includes("airplane mode") || msg.includes("network drop")) {
    return 503;
  }
  if (msg.includes("not found")) return 404;
  if (msg.includes("unauthorized") || msg.includes("invalid pin") || msg.includes("invalid otp")) return 401;
  if (msg.includes("forbidden") || msg.includes("cooling") || msg.includes("frozen") || msg.includes("halted")) return 403;
  if (msg.includes("unique constraint") || msg.includes("already exists") || msg.includes("conflict")) return 409;
  if (
    msg.includes("must be") ||
    msg.includes("invalid") ||
    msg.includes("required") ||
    msg.includes("positive integer") ||
    msg.includes("cannot exceed") ||
    msg.includes("luhn") ||
    msg.includes("expired")
  ) {
    return 400;
  }
  return 500;
}

export function ensureDataDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true });
}

export function applyCorsHeaders(
  res: http.ServerResponse,
  requestOrigin?: string
): void {
  for (const [k, v] of Object.entries(buildCorsHeaders(requestOrigin))) {
    res.setHeader(k, v);
  }
}

export function writeJsonResponse(
  res: http.ServerResponse,
  statusCode: number,
  body: unknown,
  requestOrigin?: string
): void {
  applyCorsHeaders(res, requestOrigin);
  res.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(body, null, 2));
}

export function writeHtmlResponse(
  res: http.ServerResponse,
  statusCode: number,
  html: string,
  requestOrigin?: string
): void {
  applyCorsHeaders(res, requestOrigin);
  res.writeHead(statusCode, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

export async function readRawAndJsonBody(
  req: http.IncomingMessage,
  maxBytes = 1_048_576
): Promise<{ rawBody: string; json: Record<string, unknown> }> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > maxBytes) {
      throw Object.assign(new Error("Request payload too large"), { statusCode: 413 });
    }
    chunks.push(buf);
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");
  if (!rawBody.trim()) {
    return { rawBody: "", json: {} };
  }
  try {
    const parsed = JSON.parse(rawBody);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("Expected JSON object");
    }
    return { rawBody, json: parsed as Record<string, unknown> };
  } catch {
    throw Object.assign(new Error("Invalid JSON request body"), { statusCode: 400 });
  }
}

export function renderFintechShellHtml(params: {
  title: string;
  subtitle: string;
  activePort: 3001 | 3002 | 3003 | 3004;
  bodyHtml: string;
  scriptJs: string;
}): string {
  const { p1, p2, p3, p4 } = getConfiguredPorts();
  const navItems: Array<{ slot: 3001 | 3002 | 3003 | 3004; port: number; label: string }> = [
    { slot: 3001, port: p1, label: `P1 Switch (:${p1})` },
    { slot: 3002, port: p2, label: `P2 Gateway (:${p2})` },
    { slot: 3003, port: p3, label: `P3 Consumer & Risk (:${p3})` },
    { slot: 3004, port: p4, label: `P4 Mandates (:${p4})` },
  ];

  const navHtml = navItems
    .map((item) => {
      const activeClass = item.slot === params.activePort ? "nav-link active" : "nav-link";
      return `<a class="${activeClass}" href="http://127.0.0.1:${item.port}/">${escapeHtml(item.label)}</a>`;
    })
    .join("");

  const safeTitle = escapeHtml(params.title);
  const safeSubtitle = escapeHtml(params.subtitle);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${safeTitle}</title>
  <style>
    :root {
      --bg: #0b1020;
      --panel: #131a2e;
      --border: #243052;
      --text: #e6ecff;
      --muted: #93a3c7;
      --accent: #38bdf8;
      --ok: #22c55e;
      --warn: #f59e0b;
      --err: #ef4444;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      background: var(--bg);
      color: var(--text);
      line-height: 1.45;
    }
    header {
      background: #0f1629;
      border-bottom: 1px solid var(--border);
      padding: 14px 24px;
      display: flex;
      flex-wrap: wrap;
      align-items: center;
      justify-content: space-between;
      gap: 12px;
    }
    header h1 { margin: 0; font-size: 18px; letter-spacing: 0.2px; }
    header .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
    nav { display: flex; flex-wrap: wrap; gap: 8px; }
    .nav-link {
      color: var(--muted);
      text-decoration: none;
      font-size: 13px;
      padding: 6px 11px;
      border-radius: 6px;
      border: 1px solid var(--border);
    }
    .nav-link.active {
      color: #06101f;
      background: var(--accent);
      border-color: var(--accent);
      font-weight: 600;
    }
    main { max-width: 1280px; margin: 20px auto; padding: 0 20px 40px; }
    .auth-bar {
      background: #101933;
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 12px 16px;
      margin-bottom: 18px;
      display: flex;
      flex-wrap: wrap;
      gap: 10px;
      align-items: flex-end;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(360px, 1fr));
      gap: 16px;
    }
    .card {
      background: var(--panel);
      border: 1px solid var(--border);
      border-radius: 10px;
      padding: 16px;
    }
    .card h2 { margin: 0 0 10px; font-size: 15px; color: var(--accent); }
    .row { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 10px; align-items: flex-end; }
    label { display: flex; flex-direction: column; font-size: 11px; color: var(--muted); gap: 4px; flex: 1; min-width: 120px; }
    input, select {
      background: #0b1122;
      color: var(--text);
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 7px 9px;
      font-size: 13px;
    }
    button {
      background: var(--accent);
      color: #06101f;
      border: none;
      border-radius: 6px;
      padding: 8px 13px;
      font-size: 13px;
      font-weight: 600;
      cursor: pointer;
    }
    button.secondary { background: #243052; color: var(--text); }
    button.danger { background: var(--err); color: #fff; }
    pre.out {
      background: #080d1a;
      border: 1px solid var(--border);
      border-radius: 6px;
      padding: 10px;
      font-size: 12px;
      overflow-x: auto;
      max-height: 280px;
      margin: 10px 0 0;
      color: #cbd5f5;
    }
    .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
    .badge.ok { background: rgba(34,197,94,0.18); color: var(--ok); }
    .badge.warn { background: rgba(245,158,11,0.18); color: var(--warn); }
    .badge.err { background: rgba(239,68,68,0.18); color: var(--err); }
  </style>
</head>
<body>
  <header>
    <div>
      <h1>${safeTitle}</h1>
      <div class="sub">${safeSubtitle}</div>
    </div>
    <nav>${navHtml}</nav>
  </header>
  <main>
    ${params.bodyHtml}
  </main>
  <script>
    function show(id, data) {
      const el = document.getElementById(id);
      if (el) el.textContent = typeof data === "string" ? data : JSON.stringify(data, null, 2);
    }
    ${params.scriptJs}
  </script>
</body>
</html>`;
}
