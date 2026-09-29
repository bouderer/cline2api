/**
 * Console login.
 *
 * The password is grok-iq's, stored as a PBKDF2-SHA256 hash in its SQLite
 * database. These tests build that database the way grok-iq does and check
 * the three things the console depends on: the right password opens a session,
 * the wrong one does not, and a session cookie — not a URL token — is what
 * unlocks the admin API afterwards.
 */
import assert from "node:assert/strict";
import { pbkdf2Sync, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
import { AdminAuth, readCookie, readGrokIqAdmin } from "../src/services/adminAuth.js";

const PASSWORD = "correct-horse-battery";
const USERNAME = "christcul";

function grokIqDb(password: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-grokiq-"));
  const dbPath = path.join(dir, "grokiq.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE admin_users (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL,
    password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL,
    password_iterations INTEGER NOT NULL
  )`);
  const salt = randomBytes(16);
  const hash = pbkdf2Sync(password, salt, 1000, 32, "sha256").toString("hex");
  db.prepare(
    `INSERT INTO admin_users (id, username, password_salt, password_hash, password_iterations)
     VALUES (1, ?, ?, ?, 1000)`,
  ).run(USERNAME, salt.toString("base64url"), hash);
  db.close();
  return dbPath;
}

test("readGrokIqAdmin returns the single admin row and nothing for a bad file", () => {
  const dbPath = grokIqDb(PASSWORD);
  const credential = readGrokIqAdmin(dbPath);
  assert.ok(credential);
  assert.equal(credential.username, USERNAME);
  assert.equal(credential.passwordIterations, 1000);

  assert.equal(readGrokIqAdmin(path.join(os.tmpdir(), "does-not-exist.db")), null);
});

test("verify accepts only the matching username and password", () => {
  const auth = new AdminAuth({ loadCredential: () => readGrokIqAdmin(grokIqDb(PASSWORD)) });
  assert.equal(auth.available(), true);
  assert.equal(auth.verify(USERNAME, PASSWORD), true);
  assert.equal(auth.verify(USERNAME, "wrong-password"), false);
  assert.equal(auth.verify("someone-else", PASSWORD), false);
  assert.equal(auth.verify(`  ${USERNAME}  `, PASSWORD), true);
});

test("a session expires and can be revoked", () => {
  let now = 1_000_000;
  const auth = new AdminAuth({ now: () => now, sessionTtlMs: 1000 });
  const { token } = auth.createSession(USERNAME);
  assert.equal(auth.authenticate(token), USERNAME);
  now += 1001;
  assert.equal(auth.authenticate(token), null);
  const second = auth.createSession(USERNAME);
  auth.revoke(second.token);
  assert.equal(auth.authenticate(second.token), null);
});

test("readCookie picks the named cookie and ignores the rest", () => {
  assert.equal(readCookie("a=1; cline2api_session=abc; b=2", "cline2api_session"), "abc");
  assert.equal(readCookie("cline2api_session=", "cline2api_session"), null);
  assert.equal(readCookie(null, "cline2api_session"), null);
});

test("login sets a session cookie that authorizes the admin API", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-login-"));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    ADMIN_TOKEN: "admin-token",
    GROKIQ_DB_PATH: grokIqDb(PASSWORD),
    CLINE_API_BASE_URL: "http://127.0.0.1:1",
    WORKOS_API_BASE_URL: "http://127.0.0.1:1",
    LOG_LEVEL: "error",
  });
  const { app } = createApp(config);

  const wrong = await app.request("/admin/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: "nope" }),
  });
  assert.equal(wrong.status, 401);

  const login = await app.request("/admin/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  assert.equal(login.status, 200);
  const setCookie = login.headers.get("set-cookie") ?? "";
  assert.match(setCookie, /^cline2api_session=[^;]+; HttpOnly; Path=\/; SameSite=Lax; Max-Age=\d+$/);
  const cookie = setCookie.split(";")[0] ?? "";

  // No token in the URL, no Authorization header: the cookie alone is enough.
  const status = await app.request("/admin/api/auth/status", { headers: { Cookie: cookie } });
  assert.deepEqual(await status.json(), { authenticated: true, username: USERNAME, loginAvailable: true });

  const accounts = await app.request("/admin/api/accounts", { headers: { Cookie: cookie } });
  assert.equal(accounts.status, 200);

  // A URL token no longer counts, even when it is the real ADMIN_TOKEN.
  const viaQuery = await app.request("/admin/api/accounts?token=admin-token");
  assert.equal(viaQuery.status, 401);

  // The registrar's Bearer token still does.
  const viaBearer = await app.request("/admin/api/accounts", {
    headers: { Authorization: "Bearer admin-token" },
  });
  assert.equal(viaBearer.status, 200);

  const logout = await app.request("/admin/api/auth/logout", {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(logout.status, 200);
  const after = await app.request("/admin/api/accounts", { headers: { Cookie: cookie } });
  assert.equal(after.status, 401);
});

test("login reports 503 when grok-iq's database is not configured", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-login-"));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    ADMIN_TOKEN: "admin-token",
    CLINE_API_BASE_URL: "http://127.0.0.1:1",
    WORKOS_API_BASE_URL: "http://127.0.0.1:1",
    LOG_LEVEL: "error",
  });
  const { app } = createApp(config);
  const response = await app.request("/admin/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  assert.equal(response.status, 503);
});
