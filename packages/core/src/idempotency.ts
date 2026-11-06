import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Rule 5: Every write endpoint that creates money movement accepts an idempotency key.
 * The same key with the same body returns the first response;
 * the same key with a different body returns an error (HTTP 409).
 */

export class IdempotencyConflictError extends Error {
  public readonly statusCode = 409;
  public readonly idempotencyKey: string;

  constructor(idempotencyKey: string, message?: string) {
    super(
      message ??
        `Rule 5 Violation (HTTP 409): Idempotency key "${idempotencyKey}" was already used with a different request payload`
    );
    this.name = "IdempotencyConflictError";
    this.idempotencyKey = idempotencyKey;
  }
}

export interface StoredIdempotentResponse<T = unknown> {
  idempotency_key: string;
  scope: string;
  payload_hash: string;
  status_code: number;
  response_body: T;
  replayed: boolean;
  created_at: string;
}

/**
 * Computes a deterministic SHA-256 hash of a JSON payload (sorting object keys recursively).
 */
export function canonicalJsonHash(payload: unknown): string {
  const canonicalize = (val: unknown): unknown => {
    if (val === null || typeof val !== "object") {
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(canonicalize);
    }
    const sortedKeys = Object.keys(val as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const k of sortedKeys) {
      result[k] = canonicalize((val as Record<string, unknown>)[k]);
    }
    return result;
  };

  const canonicalString = JSON.stringify(canonicalize(payload));
  return crypto.createHash("sha256").update(canonicalString, "utf8").digest("hex");
}

export function initIdempotencySchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS idempotency_records (
      scope TEXT NOT NULL,
      idempotency_key TEXT NOT NULL,
      payload_hash TEXT NOT NULL,
      status_code INTEGER NOT NULL,
      response_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (scope, idempotency_key)
    );
  `);
}

export class IdempotencyStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    initIdempotencySchema(this.db);
  }

  /**
   * Executes `handler` once per `(scope, idempotencyKey)`.
   * - If the key already exists with the SAME payload hash, returns the stored response (`replayed: true`).
   * - If the key already exists with a DIFFERENT payload hash, throws `IdempotencyConflictError` (HTTP 409).
   */
  public execute<T>(params: {
    scope: string;
    idempotencyKey: string;
    requestPayload: unknown;
    handler: () => { statusCode: number; body: T };
  }): StoredIdempotentResponse<T> {
    if (!params.idempotencyKey || typeof params.idempotencyKey !== "string") {
      throw new Error("Rule 5 Violation: idempotencyKey is required");
    }

    const payloadHash = canonicalJsonHash(params.requestPayload);

    const selectStmt = this.db.prepare(`
      SELECT scope, idempotency_key, payload_hash, status_code, response_json, created_at
      FROM idempotency_records
      WHERE scope = ? AND idempotency_key = ?
    `);

    const existing = selectStmt.get(params.scope, params.idempotencyKey) as
      | {
          scope: string;
          idempotency_key: string;
          payload_hash: string;
          status_code: number;
          response_json: string;
          created_at: string;
        }
      | undefined;

    if (existing) {
      if (existing.payload_hash !== payloadHash) {
        throw new IdempotencyConflictError(params.idempotencyKey);
      }
      return {
        idempotency_key: existing.idempotency_key,
        scope: existing.scope,
        payload_hash: existing.payload_hash,
        status_code: existing.status_code,
        response_body: JSON.parse(existing.response_json) as T,
        replayed: true,
        created_at: existing.created_at,
      };
    }

    const { statusCode, body } = params.handler();
    const createdAt = new Date().toISOString();
    const responseJson = JSON.stringify(body);

    try {
      const insertStmt = this.db.prepare(`
        INSERT INTO idempotency_records (
          scope, idempotency_key, payload_hash, status_code, response_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      insertStmt.run(
        params.scope,
        params.idempotencyKey,
        payloadHash,
        statusCode,
        responseJson,
        createdAt
      );
    } catch (err: unknown) {
      // Handle race condition if another concurrent call inserted first
      const raced = selectStmt.get(params.scope, params.idempotencyKey) as
        | {
            scope: string;
            idempotency_key: string;
            payload_hash: string;
            status_code: number;
            response_json: string;
            created_at: string;
          }
        | undefined;
      if (raced) {
        if (raced.payload_hash !== payloadHash) {
          throw new IdempotencyConflictError(params.idempotencyKey);
        }
        return {
          idempotency_key: raced.idempotency_key,
          scope: raced.scope,
          payload_hash: raced.payload_hash,
          status_code: raced.status_code,
          response_body: JSON.parse(raced.response_json) as T,
          replayed: true,
          created_at: raced.created_at,
        };
      }
      throw err;
    }

    return {
      idempotency_key: params.idempotencyKey,
      scope: params.scope,
      payload_hash: payloadHash,
      status_code: statusCode,
      response_body: body,
      replayed: false,
      created_at: createdAt,
    };
  }
}
