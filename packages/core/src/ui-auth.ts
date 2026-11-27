import crypto from "node:crypto";
import type http from "node:http";
import type { DatabaseSync } from "node:sqlite";

/**
 * Per-Service UI Authentication & Session Store
 *
 * - Passwords are NEVER stored in plaintext: uses Node 24 `crypto.scryptSync`
 *   with a 16-byte random salt (`scrypt$<saltHex>$<derivedHex>`) + `timingSafeEqual`.
 * - Session tokens are stored hashed (`SHA-256`) in SQLite `ui_sessions`.
 * - Distinct `HttpOnly; SameSite=Lax` cookie per service (`fintech_sess_p1..p4`)
 *   so all 4 dashboards stay cleanly isolated even on a single Render domain.
 */

export type UiUserRole = "user" | "admin";

export interface UiSessionUser {
  username: string;
  role: UiUserRole;
  displayName: string;
}

export interface SeedUiUser {
  username: string;
  password: string;
  role: UiUserRole;
  displayName: string;
}

export function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${derived}`;
}

export function verifyPasswordScrypt(password: string, storedHash: string): boolean {
  const parts = storedHash.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const [, salt, expectedHex] = parts;
  const actual = crypto.scryptSync(password, salt, 64);
  const expected = Buffer.from(expectedHex, "hex");
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

function hashSessionToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

export function parseCookieHeader(cookieHeader: string | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const idx = part.indexOf("=");
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    if (k === name) {
      return decodeURIComponent(part.slice(idx + 1).trim());
    }
  }
  return null;
}

export class UiAuthStore {
  public readonly db: DatabaseSync;
  public readonly cookieName: string;
  private readonly sessionTtlMs: number;

  constructor(params: {
    db: DatabaseSync;
    cookieName: string;
    seedUsers: SeedUiUser[];
    sessionTtlMs?: number;
  }) {
    this.db = params.db;
    this.cookieName = params.cookieName;
    this.sessionTtlMs = params.sessionTtlMs ?? 12 * 60 * 60 * 1000;
    this.initSchema();
    this.seedUsersIdempotently(params.seedUsers);
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS ui_users (
        username TEXT PRIMARY KEY,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ui_sessions (
        token_hash TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('user', 'admin')),
        display_name TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
  }

  private seedUsersIdempotently(users: SeedUiUser[]): void {
    const exists = this.db.prepare(`SELECT 1 FROM ui_users WHERE username = ?`);
    const insert = this.db.prepare(
      `INSERT INTO ui_users (username, password_hash, role, display_name, created_at)
       VALUES (?, ?, ?, ?, ?)`
    );
    const nowIso = new Date().toISOString();
    for (const u of users) {
      const normalized = u.username.trim().toLowerCase();
      if (!exists.get(normalized)) {
        insert.run(normalized, hashPasswordScrypt(u.password), u.role, u.displayName, nowIso);
      }
    }
  }

  public login(
    username: string,
    password: string
  ): { user: UiSessionUser; rawToken: string; setCookieHeader: string } | null {
    const normalized = username.trim().toLowerCase();
    const row = this.db
      .prepare(
        `SELECT username, password_hash, role, display_name FROM ui_users WHERE username = ?`
      )
      .get(normalized) as
      | { username: string; password_hash: string; role: UiUserRole; display_name: string }
      | undefined;

    if (!row || !verifyPasswordScrypt(password, row.password_hash)) {
      return null;
    }

    const rawToken = crypto.randomBytes(32).toString("hex");
    const tokenHash = hashSessionToken(rawToken);
    const now = Date.now();
    const expiresAt = new Date(now + this.sessionTtlMs).toISOString();

    this.db
      .prepare(
        `INSERT INTO ui_sessions (token_hash, username, role, display_name, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        tokenHash,
        row.username,
        row.role,
        row.display_name,
        expiresAt,
        new Date(now).toISOString()
      );

    const maxAgeSec = Math.floor(this.sessionTtlMs / 1000);
    const setCookieHeader = `${this.cookieName}=${encodeURIComponent(rawToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAgeSec}`;

    return {
      user: { username: row.username, role: row.role, displayName: row.display_name },
      rawToken,
      setCookieHeader,
    };
  }

  public getSessionFromHeaders(
    headers: http.IncomingHttpHeaders | Record<string, string | undefined>
  ): UiSessionUser | null {
    const rawCookie = headers.cookie ?? (headers as Record<string, string | undefined>)["Cookie"];
    const cookieStr = Array.isArray(rawCookie) ? rawCookie.join("; ") : rawCookie;
    const rawToken = parseCookieHeader(cookieStr, this.cookieName);
    if (!rawToken) return null;

    const tokenHash = hashSessionToken(rawToken);
    const row = this.db
      .prepare(
        `SELECT username, role, display_name, expires_at FROM ui_sessions WHERE token_hash = ?`
      )
      .get(tokenHash) as
      { username: string; role: UiUserRole; display_name: string; expires_at: string } | undefined;

    if (!row) return null;
    if (Date.now() > Date.parse(row.expires_at)) {
      this.db.prepare(`DELETE FROM ui_sessions WHERE token_hash = ?`).run(tokenHash);
      return null;
    }
    return { username: row.username, role: row.role, displayName: row.display_name };
  }

  public logoutFromHeaders(
    headers: http.IncomingHttpHeaders | Record<string, string | undefined>
  ): string {
    const rawCookie = headers.cookie ?? (headers as Record<string, string | undefined>)["Cookie"];
    const cookieStr = Array.isArray(rawCookie) ? rawCookie.join("; ") : rawCookie;
    const rawToken = parseCookieHeader(cookieStr, this.cookieName);
    if (rawToken) {
      this.db
        .prepare(`DELETE FROM ui_sessions WHERE token_hash = ?`)
        .run(hashSessionToken(rawToken));
    }
    return `${this.cookieName}=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0`;
  }
}
