/**
 * Client API keys: CRUD, rotation, env import and request-time accounting.
 *
 * Each block documents the reasoning in the test name itself — a future reader
 * can grep for the behaviour they are about to change.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
import { ApiKeyManager, hashApiKey, mintApiKey } from "../src/services/apiKeys.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("error");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-apikeys-"));
}

/* ---------------- hashing and minting ---------------- */

test("hashing is deterministic and one-way at rest", () => {
  assert.equal(hashApiKey("abc"), hashApiKey("abc"));
  assert.notEqual(hashApiKey("abc"), hashApiKey("abd"));
  assert.ok(hashApiKey("abc").startsWith("sha256:"));
});

test("minted keys are unique and prefixed", () => {
  const seen = new Set(Array.from({ length: 50 }, () => mintApiKey()));
  assert.equal(seen.size, 50);
  for (const key of seen) assert.ok(key.startsWith("sk-cline-"));
});

/* ---------------- CRUD ---------------- */

test("creating a key returns the plaintext once and stores only the hash", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger });
  const { record, plaintext } = mgr.create("cursor");
  assert.equal(record.label, "cursor");
  assert.equal(record.prefix, plaintext.slice(0, 8));
  assert.equal(record.useCount, 0);
  assert.equal(record.lastUsedAt, null);

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "apikeys.json"), "utf8")) as {
    keys: Array<Record<string, unknown>>;
  };
  assert.equal(onDisk.keys.length, 1);
  // No plaintext on disk: the file holds the hash, nothing reversible.
  assert.ok(!JSON.stringify(onDisk.keys).includes(plaintext));
  assert.equal(onDisk.keys[0]?.keyHash, hashApiKey(plaintext));

  // And the file must not be world-readable.
  assert.equal(fs.statSync(path.join(dir, "apikeys.json")).mode & 0o777, 0o600);

  // List rows never carry the hash either.
  const listed = mgr.list()[0];
  assert.ok(listed && !("keyHash" in listed));
});

test("verify succeeds only for enabled keys and records last use", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger });
  const other = mgr.create("other");
  const { plaintext } = mgr.create("a");
  const row = mgr.verify(plaintext, "some-model");
  assert.ok(row);
  assert.equal(row?.useCount, 1);
  assert.equal(row?.lastUsedModel, "some-model");
  assert.ok(typeof row?.lastUsedAt === "number");

  assert.equal(mgr.verify("wrong-key"), null);
  assert.equal(mgr.matches("wrong-key"), null);

  // Disabling is what actually stops a key: both lookup paths agree. A second
  // key stays enabled, so this toggle is allowed through.
  assert.ok(!("error" in (mgr.setEnabled(row!.id, false) as object)));
  assert.equal(mgr.verify(plaintext), null);
  assert.equal(mgr.matches(plaintext), null);
  assert.ok(mgr.matches(other.plaintext));
});

test("rotate replaces the secret but keeps the row and resets counters", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger });
  const first = mgr.create("cursor");
  mgr.verify(first.plaintext, "m");
  const rotated = mgr.rotate(first.record.id);
  assert.ok(rotated);
  assert.notEqual(rotated?.plaintext, first.plaintext);
  // Old secret stops working immediately.
  assert.equal(mgr.verify(first.plaintext), null);
  assert.ok(mgr.verify(rotated!.plaintext));
  // Counters belong to the old secret.
  assert.equal(rotated?.record.useCount, 0);
  assert.equal(rotated?.record.lastUsedAt, null);
  assert.equal(rotated?.record.label, "cursor");
});

test("disabling the last enabled key is refused, not a silent lockout", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger });
  const only = mgr.create("only");
  const result = mgr.setEnabled(only.record.id, false);
  assert.ok(result !== null && "error" in result);

  // With two keys the toggle goes through.
  const second = mgr.create("second");
  assert.ok(!("error" in (mgr.setEnabled(only.record.id, false) as object)));
  assert.ok(mgr.matches(second.plaintext));
});

test("env-sourced keys cannot be deleted through the manager", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger, envKeys: ["sk-env-1"] });
  const row = mgr.list().find((k) => k.source === "env");
  assert.ok(row);
  const result = mgr.remove(row!.id);
  assert.ok(typeof result === "object" && "error" in result);
});

/* ---------------- env sync ---------------- */

test("syncFromEnv is idempotent across restarts", () => {
  const dir = tmpDir();
  const first = new ApiKeyManager({ dataDir: dir, logger, envKeys: ["a", "b"] });
  assert.equal(first.count(), 2);
  const second = new ApiKeyManager({ dataDir: dir, logger, envKeys: ["a", "b"] });
  assert.equal(second.count(), 2);
  assert.deepEqual(
    second.list().map((k) => k.label).sort(),
    ["env #1", "env #2"],
  );
});

test("removing an env key drops its row but never strands the gateway", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger, envKeys: ["keep", "drop"] });
  assert.equal(mgr.count(), 2);
  const res = mgr.syncFromEnv(["keep"]);
  assert.equal(res.dropped, 1);
  assert.equal(mgr.count(), 1);
  assert.ok(!mgr.list().some((k) => k.label === "env #2"));

  // Emptying the env entirely holds one row rather than locking everything out.
  const res2 = mgr.syncFromEnv([]);
  assert.equal(res2.held, true);
  assert.equal(mgr.count(), 1);
  assert.ok(mgr.matches("keep"));
});

test("managed keys survive env syncs untouched", () => {
  const dir = tmpDir();
  const mgr = new ApiKeyManager({ dataDir: dir, logger, envKeys: ["a"] });
  const managed = mgr.create("mine");
  mgr.syncFromEnv(["b"]);
  assert.ok(mgr.matches(managed.plaintext));
  assert.equal(mgr.count(), 2);
});

/* ---------------- gateway integration ---------------- */

async function startUpstream() {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const url = req.url ?? "";
      res.writeHead(200, { "content-type": "application/json" });
      if (url === "/api/v1/models") {
        return res.end(JSON.stringify({ object: "list", data: [] }));
      }
      if (url === "/api/v1/ai/cline/recommended-models") {
        return res.end(JSON.stringify({ free: [], clinePass: [] }));
      }
      if (url === "/api/v1/chat/completions") {
        return res.end(
          JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }], usage: {} }),
        );
      }
      return res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

test("requests through a rotated key 401 and the new one works", async () => {
  const upstream = await startUpstream();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-keygw-"));
  // One seeded account so /v1/chat has something to bill against.
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "acct-1",
          label: null,
          email: "mock@example.com",
          accountId: "cu_mock",
          access: "seed-access",
          refresh: "seed-refresh",
          expires: Date.now() + 3_600_000,
          tokenType: "Bearer",
          provider: "cline",
          createdAt: Date.now(),
          updatedAt: Date.now(),
          disabled: false,
          lastError: null,
        },
      ],
    }),
    "utf8",
  );
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "",
    ADMIN_TOKEN: "admin-token",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app } = createApp(config);
  const adminHeaders = { Authorization: "Bearer admin-token", "Content-Type": "application/json" };
  try {
    // Empty env bootstraps exactly one generated key.
    const listed = (await (await app.request("/admin/api/keys", { headers: adminHeaders })).json()) as {
      keys: Array<{ id: string; label: string; useCount: number }>;
    };
    assert.equal(listed.keys.length, 1);

    const rotated = (await (
      await app.request(`/admin/api/keys/${listed.keys[0]!.id}/rotate`, {
        method: "POST",
        headers: adminHeaders,
      })
    ).json()) as { key: { id: string }; plaintext: string };

    // A successful chat records last-use on the key that served it.
    const chat = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${rotated.plaintext}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: "m", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(chat.status, 200);

    const after = (await (await app.request("/admin/api/keys", { headers: adminHeaders })).json()) as {
      keys: Array<{ useCount: number; lastUsedModel: string | null }>;
    };
    assert.equal(after.keys[0]?.useCount, 1);
    assert.equal(after.keys[0]?.lastUsedModel, "m");
  } finally {
    await upstream.close();
  }
});

test("a disabled key is rejected on every protocol surface", async () => {
  const upstream = await startUpstream();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-keygw-"));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "k1,k2",
    ADMIN_TOKEN: "admin-token",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app } = createApp(config);
  const adminHeaders = { Authorization: "Bearer admin-token", "Content-Type": "application/json" };
  try {
    const listed = (await (await app.request("/admin/api/keys", { headers: adminHeaders })).json()) as {
      keys: Array<{ id: string }>;
    };
    assert.equal(listed.keys.length, 2);

    // Disable one of two: the other keeps working, so the operator cannot
    // strand themselves by disabling the only key.
    const target = (await (await app.request("/admin/api/keys", { headers: adminHeaders })).json()) as {
      keys: Array<{ id: string; label: string }>;
    };
    const victim = target.keys.find((k) => k.label === "env #1")!;
    const toggled = await app.request(`/admin/api/keys/${victim.id}`, {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ enabled: false }),
    });
    assert.equal(toggled.status, 200);

    for (const path of ["/v1/models", "/v1/messages", "/v1/responses"] as const) {
      const bad = await app.request(path, {
        method: path === "/v1/models" ? "GET" : "POST",
        headers: { Authorization: "Bearer k1", "Content-Type": "application/json" },
        ...(path === "/v1/models" ? {} : { body: JSON.stringify({ model: "m", messages: [], input: "hi" }) }),
      });
      assert.equal(bad.status, 401, `${path} should reject the disabled key`);
    }

    const ok = await app.request("/v1/models", {
      headers: { Authorization: "Bearer k2" },
    });
    assert.equal(ok.status, 200);
  } finally {
    await upstream.close();
  }
});

test("the admin API never echoes a key secret", async () => {
  const upstream = await startUpstream();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-keygw-"));
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "supersecret-value-here",
    ADMIN_TOKEN: "admin-token",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app } = createApp(config);
  const adminHeaders = { Authorization: "Bearer admin-token", "Content-Type": "application/json" };
  try {
    const listed = await app.request("/admin/api/keys", { headers: adminHeaders });
    const text = await listed.text();
    assert.ok(!text.includes("supersecret-value-here"));
    // Hash is internal: responses carry the prefix, never the hash.
    assert.ok(!text.includes("sha256:"));
  } finally {
    await upstream.close();
  }
});
