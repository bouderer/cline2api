/**
 * The settings page writes two things that outlive the process: grok-iq's
 * admin password, and the gateway's ADMIN_TOKEN. These tests check both land
 * where the next boot reads them, and that a wrong current password changes
 * nothing.
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
import { AdminAuth, readGrokIqAdmin } from "../src/services/adminAuth.js";
import { AdminSettings, rewriteEnvLine } from "../src/services/adminSettings.js";

const USERNAME = "christcul";

function grokIqDb(password: string, iterations = 1000): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-settings-"));
  const dbPath = path.join(dir, "grokiq.db");
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE admin_users (
    id INTEGER PRIMARY KEY, username TEXT NOT NULL, password_salt TEXT NOT NULL,
    password_hash TEXT NOT NULL, password_iterations INTEGER NOT NULL,
    token_version INTEGER NOT NULL DEFAULT 1, created_at TEXT, updated_at TEXT
  )`);
  const salt = randomBytes(16);
  db.prepare(
    `INSERT INTO admin_users (id, username, password_salt, password_hash, password_iterations)
     VALUES (1, ?, ?, ?, ?)`,
  ).run(USERNAME, salt.toString("base64url"), pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex"), iterations);
  db.close();
  return dbPath;
}

function session(app: ReturnType<typeof createApp>["app"], dbPath: string, password: string): Promise<string> {
  return app
    .request("/admin/api/auth/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: USERNAME, password }),
    })
    .then((res) => (res.headers.get("set-cookie") ?? "").split(";")[0] ?? "");
}

test("rewriteEnvLine replaces one key and keeps the rest", () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-env-")), ".env");
  fs.writeFileSync(file, "# comment\nPROXY_API_KEY=keep-me\nADMIN_TOKEN=old-value\nPORT=8787\n");
  rewriteEnvLine(file, "ADMIN_TOKEN", "brand-new-token-value");
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^# comment$/m);
  assert.match(text, /^PROXY_API_KEY=keep-me$/m);
  assert.match(text, /^ADMIN_TOKEN=brand-new-token-value$/m);
  assert.match(text, /^PORT=8787$/m);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("changePassword rejects a wrong current password and writes grok-iq's hash", () => {
  const dbPath = grokIqDb("original-password");
  const auth = new AdminAuth({ loadCredential: () => readGrokIqAdmin(dbPath) });
  const settings = new AdminSettings({ grokIqDbPath: dbPath });

  assert.throws(() => settings.changePassword(USERNAME, "nope", "replacement-password", (u, p) => auth.verify(u, p)), /当前密码不正确/);
  assert.equal(auth.verify(USERNAME, "original-password"), true);

  settings.changePassword(USERNAME, "original-password", "replacement-password", (u, p) => auth.verify(u, p));
  const fresh = new AdminAuth({ loadCredential: () => readGrokIqAdmin(dbPath) });
  assert.equal(fresh.verify(USERNAME, "original-password"), false);
  assert.equal(fresh.verify(USERNAME, "replacement-password"), true);
  assert.equal(readGrokIqAdmin(dbPath)?.passwordIterations, 310_000);
});

test("the settings API rotates the token for the running process and the env file", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-settings-"));
  const envFile = path.join(dir, ".env");
  fs.writeFileSync(envFile, "ADMIN_TOKEN=admin-token\nPROXY_API_KEY=test-key\n");
  const dbPath = grokIqDb("correct-horse-battery");
  const config = loadConfig({
    DATA_DIR: dir,
    PROXY_API_KEY: "test-key",
    ADMIN_TOKEN: "admin-token",
    GROKIQ_DB_PATH: dbPath,
    ENV_FILE: envFile,
    CLINE_API_BASE_URL: "http://127.0.0.1:1",
    WORKOS_API_BASE_URL: "http://127.0.0.1:1",
    LOG_LEVEL: "error",
  });
  const { app } = createApp(config);
  const cookie = await session(app, dbPath, "correct-horse-battery");

  const before = await app.request("/admin/api/settings", { headers: { Cookie: cookie } });
  const status = (await before.json()) as { token: { configured: boolean; preview: string }; username: string };
  assert.equal(status.username, USERNAME);
  assert.equal(status.token.configured, true);
  assert.equal(status.token.preview, "admi…oken");

  const rotated = await app.request("/admin/api/settings/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ token: "a-brand-new-admin-token" }),
  });
  assert.equal(rotated.status, 200);
  assert.match(fs.readFileSync(envFile, "utf8"), /^ADMIN_TOKEN=a-brand-new-admin-token$/m);

  // The old token stops working immediately; the new one works immediately.
  const oldToken = await app.request("/admin/api/accounts", { headers: { Authorization: "Bearer admin-token" } });
  assert.equal(oldToken.status, 401);
  const newToken = await app.request("/admin/api/accounts", { headers: { Authorization: "Bearer a-brand-new-admin-token" } });
  assert.equal(newToken.status, 200);

  const tooShort = await app.request("/admin/api/settings/token", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ token: "short" }),
  });
  assert.equal(tooShort.status, 400);
});

test("the settings API changes the password and rejects a wrong one", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-settings-"));
  const dbPath = grokIqDb("correct-horse-battery");
  const config = loadConfig({
    DATA_DIR: dir,
    PROXY_API_KEY: "test-key",
    ADMIN_TOKEN: "admin-token",
    GROKIQ_DB_PATH: dbPath,
    CLINE_API_BASE_URL: "http://127.0.0.1:1",
    WORKOS_API_BASE_URL: "http://127.0.0.1:1",
    LOG_LEVEL: "error",
  });
  const { app } = createApp(config);
  const cookie = await session(app, dbPath, "correct-horse-battery");

  const wrong = await app.request("/admin/api/settings/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "nope", newPassword: "replacement-password" }),
  });
  assert.equal(wrong.status, 400);

  const ok = await app.request("/admin/api/settings/password", {
    method: "POST",
    headers: { "Content-Type": "application/json", Cookie: cookie },
    body: JSON.stringify({ currentPassword: "correct-horse-battery", newPassword: "replacement-password" }),
  });
  assert.equal(ok.status, 200);

  const oldLogin = await app.request("/admin/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: "correct-horse-battery" }),
  });
  assert.equal(oldLogin.status, 401);
  const newLogin = await app.request("/admin/api/auth/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: USERNAME, password: "replacement-password" }),
  });
  assert.equal(newLogin.status, 200);
});
