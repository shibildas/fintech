import crypto from "node:crypto";
import type { DatabaseSync } from "node:sqlite";

/**
 * Rule 8: Keep an immutable audit log: who or what changed which record, from what to what,
 * when, and under which request id. Expose it in the admin console.
 */

export interface AuditLogEntry {
  id: string;
  actor_id: string;
  actor_role: "system" | "operator" | "admin" | "merchant" | "customer";
  action: string;
  entity_type: string;
  entity_id: string;
  old_value: string | null;
  new_value: string | null;
  request_id: string;
  created_at: string;
}

export function initAuditSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_logs (
      id TEXT PRIMARY KEY,
      actor_id TEXT NOT NULL,
      actor_role TEXT NOT NULL,
      action TEXT NOT NULL,
      entity_type TEXT NOT NULL,
      entity_id TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      request_id TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_audit_entity
      ON audit_logs(entity_type, entity_id, created_at);

    CREATE INDEX IF NOT EXISTS idx_audit_request
      ON audit_logs(request_id);

    CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
    BEFORE UPDATE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'Rule 8 Violation: audit_logs are immutable and cannot be updated');
    END;

    CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
    BEFORE DELETE ON audit_logs
    BEGIN
      SELECT RAISE(ABORT, 'Rule 8 Violation: audit_logs are immutable and cannot be deleted');
    END;
  `);
}

export class AuditLogger {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    initAuditSchema(this.db);
  }

  public record(params: {
    actorId: string;
    actorRole: AuditLogEntry["actor_role"];
    action: string;
    entityType: string;
    entityId: string;
    oldValue?: unknown;
    newValue?: unknown;
    requestId: string;
    nowIso?: string;
  }): AuditLogEntry {
    const entry: AuditLogEntry = {
      id: `AUD-${crypto.randomUUID()}`,
      actor_id: params.actorId,
      actor_role: params.actorRole,
      action: params.action,
      entity_type: params.entityType,
      entity_id: params.entityId,
      old_value:
        params.oldValue === undefined ? null : JSON.stringify(params.oldValue),
      new_value:
        params.newValue === undefined ? null : JSON.stringify(params.newValue),
      request_id: params.requestId,
      created_at: params.nowIso ?? new Date().toISOString(),
    };

    const stmt = this.db.prepare(`
      INSERT INTO audit_logs (
        id, actor_id, actor_role, action, entity_type, entity_id,
        old_value, new_value, request_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    stmt.run(
      entry.id,
      entry.actor_id,
      entry.actor_role,
      entry.action,
      entry.entity_type,
      entry.entity_id,
      entry.old_value,
      entry.new_value,
      entry.request_id,
      entry.created_at
    );

    return entry;
  }

  public listByEntity(entityType: string, entityId: string): AuditLogEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      WHERE entity_type = ? AND entity_id = ?
      ORDER BY created_at ASC
    `);
    return stmt.all(entityType, entityId) as unknown as AuditLogEntry[];
  }

  public listRecent(limit = 100): AuditLogEntry[] {
    const stmt = this.db.prepare(`
      SELECT * FROM audit_logs
      ORDER BY created_at DESC
      LIMIT ?
    `);
    return stmt.all(limit) as unknown as AuditLogEntry[];
  }
}
