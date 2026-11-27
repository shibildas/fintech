import type http from "node:http";
import fs from "node:fs";
export { escapeHtml, renderFintechShellHtml } from "./ui-shell.ts";

/**
 * Shared HTTP Utilities (CORS allowlist, JSON body parser, status mapping & response writers).
 */

function getConfiguredPorts() {
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
  if (
    requestOrigin &&
    (allowed.has(requestOrigin) || /^https:\/\/[a-z0-9-]+\.hf\.space$/i.test(requestOrigin))
  ) {
    return requestOrigin;
  }
  return `http://127.0.0.1:${p1}`;
}

export function buildCorsHeaders(requestOrigin?: string): Record<string, string> {
  return {
    "access-control-allow-origin": getAllowedCorsOrigin(requestOrigin),
    vary: "Origin",
    "access-control-allow-methods": "GET, POST, PUT, DELETE, OPTIONS",
    "access-control-allow-headers":
      "Content-Type, X-Role, X-Actor-Id, X-Admin-Token, X-Request-Id, X-Key-Id, X-Timestamp, X-Signature, X-Device-Id, X-Device-Timestamp, X-Device-Nonce, X-Device-Signature, X-Ops-Token, X-Merchant-Token, X-Onboarding-Token",
  };
}

export const CORS_HEADERS: Record<string, string> = buildCorsHeaders();

export function mapErrorToHttpStatus(err: unknown): number {
  const explicit = (err as { statusCode?: number })?.statusCode;
  if (typeof explicit === "number" && explicit >= 400 && explicit <= 599) {
    return explicit;
  }
  const name = err instanceof Error ? err.name : "";
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
  if (
    name === "NetworkDropSimulatedError" ||
    msg.includes("airplane mode") ||
    msg.includes("network drop")
  ) {
    return 503;
  }
  if (msg.includes("not found")) return 404;
  if (msg.includes("unauthorized") || msg.includes("invalid pin") || msg.includes("invalid otp"))
    return 401;
  if (
    msg.includes("forbidden") ||
    msg.includes("cooling") ||
    msg.includes("frozen") ||
    msg.includes("halted")
  )
    return 403;
  if (
    msg.includes("unique constraint") ||
    msg.includes("already exists") ||
    msg.includes("conflict")
  )
    return 409;
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

export function applyCorsHeaders(res: http.ServerResponse, requestOrigin?: string): void {
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
