import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { signServiceMessage, verifyServiceMessage } from "../../../packages/core/src/index.ts";

/**
 * Project 2 — At-Least-Once Signed Webhooks Worker & Demo Store Receiver
 * (Requirements 19, 20, 21, 22, NFR 3 & Acceptance Tests 1, 8, Pages 14–17)
 *
 * Also reused by Project 4 for `subscription.*`, `mandate.*`, and `invoice.*` events!
 */

export type WebhookEventType =
  | "payment.authorized"
  | "payment.captured"
  | "payment.failed"
  | "refund.processed"
  | "refund.failed"
  | "settlement.processed"
  | "subscription.activated"
  | "subscription.past_due"
  | "subscription.halted"
  | "subscription.cancelled"
  | "mandate.authorized"
  | "mandate.revoked"
  | "invoice.issued"
  | "invoice.paid"
  | "invoice.payment_failed";

export const EXPONENTIAL_BACKOFF_MINUTES = [1, 5, 30, 120, 360, 1440] as const; // 1m, 5m, 30m, 2h, 6h, 24h

export interface WebhookEndpointRecord {
  id: string;
  merchant_id: string;
  url: string;
  secret: string;
  events: WebhookEventType[];
  state: "ACTIVE" | "FAILING" | "DISABLED";
  first_failing_at: string | null;
  created_at: string;
}

export interface WebhookDeliveryRecord {
  id: string;
  event_id: string;
  endpoint_id: string;
  merchant_id: string;
  event_type: WebhookEventType;
  payload_json: string;
  signature_header: string;
  attempt: number;
  status: "PENDING" | "DELIVERED" | "RETRY_SCHEDULED" | "GAVE_UP";
  http_status_code: number | null;
  duration_ms: number | null;
  response_snippet: string | null;
  next_retry_at: string | null;
  created_at: string;
  updated_at: string;
}

export type SimulatedWebhookHttpHandler = (req: {
  url: string;
  headers: {
    "x-gateway-event-id": string;
    "x-gateway-event-type": string;
    "x-gateway-timestamp": string;
    "x-gateway-signature": string;
  };
  rawBody: string;
}) => Promise<{ statusCode: number; bodyText: string }>;

export class WebhookDeliveryWorker {
  private readonly db: DatabaseSync;
  private readonly customHandlers = new Map<string, SimulatedWebhookHttpHandler>();

  constructor(db: DatabaseSync) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS webhook_endpoints (
        id TEXT PRIMARY KEY,
        merchant_id TEXT NOT NULL,
        url TEXT NOT NULL,
        secret TEXT NOT NULL,
        events_json TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (state IN ('ACTIVE', 'FAILING', 'DISABLED')),
        first_failing_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        event_id TEXT NOT NULL,
        endpoint_id TEXT NOT NULL,
        merchant_id TEXT NOT NULL,
        event_type TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        signature_header TEXT NOT NULL,
        attempt INTEGER NOT NULL DEFAULT 0,
        status TEXT NOT NULL CHECK (status IN ('PENDING', 'DELIVERED', 'RETRY_SCHEDULED', 'GAVE_UP')),
        http_status_code INTEGER,
        duration_ms INTEGER,
        response_snippet TEXT,
        next_retry_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_endpoint
        ON webhook_deliveries(endpoint_id, created_at);
    `);
  }

  public registerMockHttpTarget(url: string, handler: SimulatedWebhookHttpHandler): void {
    this.customHandlers.set(url, handler);
  }

  /**
   * Requirement 19 & Interface `POST /webhooks`:
   */
  public registerEndpoint(params: {
    merchantId: string;
    url: string;
    secret?: string;
    events: WebhookEventType[];
    now?: Date;
  }): WebhookEndpointRecord {
    const id = `wh_ep_${crypto.randomUUID().slice(0, 8)}`;
    const secret = params.secret ?? `whsec_${crypto.randomBytes(16).toString("hex")}`;
    const nowIso = (params.now ?? new Date()).toISOString();

    this.db
      .prepare(
        `INSERT INTO webhook_endpoints (
          id, merchant_id, url, secret, events_json, state, first_failing_at, created_at
        ) VALUES (?, ?, ?, ?, ?, 'ACTIVE', NULL, ?)`
      )
      .run(id, params.merchantId, params.url, secret, JSON.stringify(params.events), nowIso);

    return this.getEndpoint(id)!;
  }

  public getEndpoint(endpointId: string): WebhookEndpointRecord | undefined {
    const row = this.db.prepare(`SELECT * FROM webhook_endpoints WHERE id = ?`).get(endpointId) as
      | {
          id: string;
          merchant_id: string;
          url: string;
          secret: string;
          events_json: string;
          state: "ACTIVE" | "FAILING" | "DISABLED";
          first_failing_at: string | null;
          created_at: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }

    return {
      id: row.id,
      merchant_id: row.merchant_id,
      url: row.url,
      secret: row.secret,
      events: JSON.parse(row.events_json) as WebhookEventType[],
      state: row.state,
      first_failing_at: row.first_failing_at,
      created_at: row.created_at,
    };
  }

  public listMerchantEndpoints(merchantId: string): WebhookEndpointRecord[] {
    const rows = this.db
      .prepare(`SELECT id FROM webhook_endpoints WHERE merchant_id = ? ORDER BY created_at ASC`)
      .all(merchantId) as Array<{ id: string }>;
    return rows.map((r) => this.getEndpoint(r.id)!);
  }

  /**
   * Requirements 20 & 21:
   * Enqueues and immediately attempts the first delivery of an event to all matching
   * merchant webhook endpoints.
   */
  public async publishEvent(params: {
    merchantId: string;
    eventType: WebhookEventType;
    objectData: unknown;
    eventId?: string;
    now?: Date;
  }): Promise<WebhookDeliveryRecord[]> {
    const now = params.now ?? new Date();
    const nowIso = now.toISOString();
    const eventId = params.eventId ?? `evt_${crypto.randomUUID().slice(0, 12)}`;

    const endpoints = this.listMerchantEndpoints(params.merchantId).filter(
      (ep) => ep.state !== "DISABLED" && ep.events.includes(params.eventType)
    );

    const deliveries: WebhookDeliveryRecord[] = [];

    for (const ep of endpoints) {
      const eventEnvelope = {
        event_id: eventId,
        event_type: params.eventType,
        created_at: nowIso,
        data: params.objectData,
      };
      const rawBody = JSON.stringify(eventEnvelope);
      const signature = signServiceMessage(rawBody, nowIso, ep.secret);

      const deliveryId = `wh_del_${crypto.randomUUID().slice(0, 10)}`;
      this.db
        .prepare(
          `INSERT INTO webhook_deliveries (
            id, event_id, endpoint_id, merchant_id, event_type,
            payload_json, signature_header, attempt, status,
            created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, 'PENDING', ?, ?)`
        )
        .run(
          deliveryId,
          eventId,
          ep.id,
          params.merchantId,
          params.eventType,
          rawBody,
          signature,
          nowIso,
          nowIso
        );

      const attempted = await this.attemptDelivery(deliveryId, now);
      deliveries.push(attempted);
    }

    return deliveries;
  }

  /**
   * Requirement 21 & 22:
   * Executes a single webhook delivery attempt, records `attempt`, `http_status_code`,
   * `duration_ms`, `response_snippet`, schedules exponential backoff on failure,
   * and marks the endpoint `FAILING` if failing continuously for >= 24 hours (Req 22).
   */
  public async attemptDelivery(
    deliveryId: string,
    now = new Date()
  ): Promise<WebhookDeliveryRecord> {
    const nowIso = now.toISOString();
    const delivery = this.getDelivery(deliveryId);
    if (!delivery) {
      throw new Error(`Webhook delivery "${deliveryId}" not found`);
    }

    const endpoint = this.getEndpoint(delivery.endpoint_id)!;
    const attemptNumber = delivery.attempt + 1;

    // Re-sign with current timestamp so replay verification at receiver succeeds on retries
    const freshSig = signServiceMessage(delivery.payload_json, nowIso, endpoint.secret);

    const startMs = performance.now();
    let statusCode: number;
    let responseSnippet: string;

    const handler = this.customHandlers.get(endpoint.url);
    if (handler) {
      try {
        const res = await handler({
          url: endpoint.url,
          headers: {
            "x-gateway-event-id": delivery.event_id,
            "x-gateway-event-type": delivery.event_type,
            "x-gateway-timestamp": nowIso,
            "x-gateway-signature": freshSig,
          },
          rawBody: delivery.payload_json,
        });
        statusCode = res.statusCode;
        responseSnippet = res.bodyText.slice(0, 200);
      } catch (err) {
        statusCode = 503;
        responseSnippet = err instanceof Error ? err.message : String(err);
      }
    } else {
      statusCode = 200;
      responseSnippet = "OK (default mock endpoint)";
    }

    const durationMs = Math.max(1, Math.round(performance.now() - startMs));

    if (statusCode >= 200 && statusCode < 300) {
      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET attempt = ?,
               status = 'DELIVERED',
               signature_header = ?,
               http_status_code = ?,
               duration_ms = ?,
               response_snippet = ?,
               next_retry_at = NULL,
               updated_at = ?
           WHERE id = ?`
        )
        .run(attemptNumber, freshSig, statusCode, durationMs, responseSnippet, nowIso, deliveryId);

      // Reset endpoint failing state on successful delivery
      if (endpoint.state === "FAILING" || endpoint.first_failing_at !== null) {
        this.db
          .prepare(
            `UPDATE webhook_endpoints SET state = 'ACTIVE', first_failing_at = NULL WHERE id = ?`
          )
          .run(endpoint.id);
      }
    } else {
      // Exponential backoff schedule: 1m, 5m, 30m, 2h, 6h, 24h, then GAVE_UP
      const backoffIdx = attemptNumber - 1;
      const hasMoreRetries = backoffIdx < EXPONENTIAL_BACKOFF_MINUTES.length;
      const nextRetryAt = hasMoreRetries
        ? new Date(
            now.getTime() + EXPONENTIAL_BACKOFF_MINUTES[backoffIdx] * 60 * 1000
          ).toISOString()
        : null;
      const newStatus = hasMoreRetries ? "RETRY_SCHEDULED" : "GAVE_UP";

      this.db
        .prepare(
          `UPDATE webhook_deliveries
           SET attempt = ?,
               status = ?,
               signature_header = ?,
               http_status_code = ?,
               duration_ms = ?,
               response_snippet = ?,
               next_retry_at = ?,
               updated_at = ?
           WHERE id = ?`
        )
        .run(
          attemptNumber,
          newStatus,
          freshSig,
          statusCode,
          durationMs,
          responseSnippet,
          nextRetryAt,
          nowIso,
          deliveryId
        );

      // Requirement 22: Track first_failing_at and mark endpoint FAILING after 24 hours of continuous failures
      const firstFailIso = endpoint.first_failing_at ?? nowIso;
      const failingDurationMs = now.getTime() - Date.parse(firstFailIso);
      const twentyFourHoursMs = 24 * 60 * 60 * 1000;
      const nextEndpointState =
        failingDurationMs >= twentyFourHoursMs || newStatus === "GAVE_UP"
          ? "FAILING"
          : endpoint.state;

      this.db
        .prepare(
          `UPDATE webhook_endpoints
           SET first_failing_at = ?, state = ?
           WHERE id = ?`
        )
        .run(firstFailIso, nextEndpointState, endpoint.id);
    }

    return this.getDelivery(deliveryId)!;
  }

  /**
   * Processes all due retries whose `next_retry_at <= now`.
   */
  public async processDueRetries(now = new Date()): Promise<WebhookDeliveryRecord[]> {
    const nowIso = now.toISOString();
    const dueRows = this.db
      .prepare(
        `SELECT id FROM webhook_deliveries
         WHERE status = 'RETRY_SCHEDULED' AND next_retry_at <= ?
         ORDER BY next_retry_at ASC`
      )
      .all(nowIso) as Array<{ id: string }>;

    const processed: WebhookDeliveryRecord[] = [];
    for (const r of dueRows) {
      processed.push(await this.attemptDelivery(r.id, now));
    }
    return processed;
  }

  /**
   * Requirement 21 & Interface `POST /deliveries/{id}/resend`:
   * Dashboard button to manually resend any webhook event.
   */
  public async resendDelivery(
    deliveryId: string,
    now = new Date()
  ): Promise<WebhookDeliveryRecord> {
    return this.attemptDelivery(deliveryId, now);
  }

  public getDelivery(deliveryId: string): WebhookDeliveryRecord | undefined {
    return this.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE id = ?`)
      .get(deliveryId) as unknown as WebhookDeliveryRecord | undefined;
  }

  public listDeliveriesForEndpoint(endpointId: string): WebhookDeliveryRecord[] {
    return this.db
      .prepare(`SELECT * FROM webhook_deliveries WHERE endpoint_id = ? ORDER BY created_at DESC`)
      .all(endpointId) as unknown as WebhookDeliveryRecord[];
  }
}

/**
 * Demo Merchant Store Webhook Receiver (Pages 12, 14, 17 — Acceptance Tests 1 & 8):
 * - Verifies the `X-Gateway-Signature` HMAC header using the merchant's webhook secret.
 * - Deduplicates incoming deliveries by `event_id` (Requirement 21: "Consumers must handle duplicates by event id; the demo store does").
 * - Can simulate returning HTTP 500 for an hour to test exponential backoff retries and manual resend!
 */
export class DemoStoreWebhookReceiver {
  private readonly webhookSecret: string;
  private readonly processedEventIds = new Set<string>();
  public readonly receivedEvents: Array<{
    event_id: string;
    event_type: string;
    data: unknown;
    replayed_duplicate: boolean;
  }> = [];
  public readonly paidMerchantOrderIds = new Set<string>();
  public simulateServer500 = false;

  constructor(webhookSecret: string) {
    this.webhookSecret = webhookSecret;
  }

  public createHandler(): SimulatedWebhookHttpHandler {
    return async (req) => {
      if (this.simulateServer500) {
        return {
          statusCode: 500,
          bodyText: "Internal Server Error (Simulated Merchant Outage)",
        };
      }

      const verify = verifyServiceMessage(
        req.rawBody,
        req.headers["x-gateway-timestamp"],
        req.headers["x-gateway-signature"],
        this.webhookSecret,
        { nowMs: Date.parse(req.headers["x-gateway-timestamp"]) }
      );

      if (!verify.valid) {
        return {
          statusCode: 401,
          bodyText: `Invalid webhook signature: ${verify.reason}`,
        };
      }

      const parsed = JSON.parse(req.rawBody) as {
        event_id: string;
        event_type: string;
        data: Record<string, unknown>;
      };

      // Requirement 21: Deduplicate by event_id
      if (this.processedEventIds.has(parsed.event_id)) {
        this.receivedEvents.push({
          event_id: parsed.event_id,
          event_type: parsed.event_type,
          data: parsed.data,
          replayed_duplicate: true,
        });
        return { statusCode: 200, bodyText: "OK (Duplicate event_id ignored)" };
      }

      this.processedEventIds.add(parsed.event_id);
      this.receivedEvents.push({
        event_id: parsed.event_id,
        event_type: parsed.event_type,
        data: parsed.data,
        replayed_duplicate: false,
      });

      if (parsed.event_type === "payment.captured" && typeof parsed.data?.order_id === "string") {
        this.paidMerchantOrderIds.add(parsed.data.order_id);
      }

      return { statusCode: 200, bodyText: "OK (Verified and Processed)" };
    };
  }
}
