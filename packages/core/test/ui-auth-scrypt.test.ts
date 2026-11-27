import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { UiAuthStore, hashPasswordScrypt, verifyPasswordScrypt } from "../src/index.ts";

describe("UI Session Auth — Salted scrypt Password Hashing & HttpOnly Session Store", () => {
  it("Stores passwords strictly as salted scrypt hashes (never plaintext) and enforces session lifecycle", () => {
    const db = new DatabaseSync(":memory:");
    const store = new UiAuthStore({
      db,
      cookieName: "fintech_sess_test",
      seedUsers: [
        {
          username: "demo.user",
          password: "UserPass#2026",
          role: "user",
          displayName: "Demo User",
        },
        {
          username: "demo.admin",
          password: "AdminPass#2026",
          role: "admin",
          displayName: "Demo Admin",
        },
      ],
    });

    // 1. Verify raw DB contains zero plaintext passwords and uses scrypt$<salt>$<hash>
    const rows = db.prepare(`SELECT username, password_hash, role FROM ui_users`).all() as Array<{
      username: string;
      password_hash: string;
      role: string;
    }>;
    assert.equal(rows.length, 2);
    for (const r of rows) {
      assert.ok(r.password_hash.startsWith("scrypt$"), "Must use salted scrypt format");
      assert.ok(
        !r.password_hash.includes("Pass#2026"),
        "Plaintext password must never appear in DB"
      );
    }

    // 2. Two hashes of the same password produce different salts
    const h1 = hashPasswordScrypt("SamePass#123");
    const h2 = hashPasswordScrypt("SamePass#123");
    assert.notEqual(h1, h2);
    assert.equal(verifyPasswordScrypt("SamePass#123", h1), true);
    assert.equal(verifyPasswordScrypt("WrongPass", h1), false);

    // 3. Invalid password rejected; valid login issues HttpOnly cookie & hashed DB session
    assert.equal(store.login("demo.user", "wrong"), null);
    const loginOut = store.login("demo.admin", "AdminPass#2026");
    assert.ok(loginOut);
    assert.equal(loginOut.user.role, "admin");
    assert.ok(loginOut.setCookieHeader.includes("HttpOnly"));
    assert.ok(loginOut.setCookieHeader.includes("SameSite=Lax"));

    const sessRow = db.prepare(`SELECT token_hash FROM ui_sessions`).get() as {
      token_hash: string;
    };
    assert.notEqual(sessRow.token_hash, loginOut.rawToken, "Session token must be hashed in DB");

    // 4. Cookie authenticates session; logout revokes it
    const cookieHeader = `fintech_sess_test=${encodeURIComponent(loginOut.rawToken)}`;
    const session = store.getSessionFromHeaders({ cookie: cookieHeader });
    assert.equal(session?.username, "demo.admin");
    assert.equal(session?.role, "admin");

    store.logoutFromHeaders({ cookie: cookieHeader });
    assert.equal(store.getSessionFromHeaders({ cookie: cookieHeader }), null);
  });
});
