import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { AccountStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-test-"));
}

const silent = createLogger("error", []);

test("credentials are persisted atomically with owner-only permissions", () => {
  const dir = tempDir();
  const store = new AccountStore(dir, silent);
  const saved = store.saveCredentials(
    {
      access: "workos-token",
      refresh: "refresh-token",
      expires: Date.now() + 3_600_000,
      accountId: "cu_1",
      email: "user@example.com",
      metadata: { provider: "cline", tokenType: "Bearer" },
    },
    { provider: "cline" },
  );
  assert.equal(store.count(), 1);

  const file = path.join(dir, "accounts.json");
  assert.ok(fs.existsSync(file));
  if (process.platform !== "win32") {
    // Windows synthesises `mode` from the read-only attribute and has no POSIX
    // permission bits; there the file relies on the profile ACL instead.
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  }

  const raw = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(raw.version, 1);
  assert.equal(raw.accounts[0].id, saved.id);
  assert.equal(raw.accounts[0].refresh, "refresh-token");

  // No temp files left behind.
  assert.deepEqual(
    fs.readdirSync(dir).filter((name) => name.includes(".tmp")),
    [],
  );
});

test("re-saving the same account updates in place instead of duplicating", () => {
  const dir = tempDir();
  const store = new AccountStore(dir, silent);
  const first = store.saveCredentials({
    access: "a1",
    refresh: "r1",
    expires: Date.now() + 1000,
    accountId: "cu_9",
    email: "x@y.z",
  });
  const second = store.saveCredentials({
    access: "a2",
    refresh: "r2",
    expires: Date.now() + 2000,
    accountId: "cu_9",
    email: "x@y.z",
  });
  assert.equal(store.count(), 1);
  assert.equal(first.id, second.id);
  assert.equal(store.get(first.id)?.refresh, "r2");
});

test("reloading from disk yields the same records", () => {
  const dir = tempDir();
  const store = new AccountStore(dir, silent);
  const saved = store.saveCredentials({ access: "a", refresh: "r", expires: 1, email: "e@f.g" });
  const reloaded = new AccountStore(dir, silent);
  assert.equal(reloaded.count(), 1);
  assert.equal(reloaded.get(saved.id)?.refresh, "r");
});

test("disabling and removing accounts works", () => {
  const dir = tempDir();
  const store = new AccountStore(dir, silent);
  const saved = store.saveCredentials({ access: "a", refresh: "r", expires: 1 });
  store.update(saved.id, { disabled: true, lastError: "invalid_grant" });
  assert.equal(store.listActive().length, 0);
  assert.equal(store.get(saved.id)?.disabled, true);
  assert.equal(store.remove(saved.id), true);
  assert.equal(store.remove(saved.id), false);
  assert.equal(store.count(), 0);
});

test("logger redacts tokens, bearer headers and email local parts", () => {
  const dir = tempDir();
  const store = new AccountStore(dir, silent);
  const saved = store.saveCredentials({ access: "a", refresh: "r", expires: 1, email: "user@example.com" });
  assert.ok(saved.id);

  const lines: string[] = [];
  const originalLog = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map(String).join(" "));
  };
  try {
    const logger = createLogger("debug", ["super-secret-key"]);
    logger.info("auth failed", {
      authorization: "Bearer abcdefghijklmnop",
      apiKey: "sk-abcdefghijklmnopqrstuvwxyz",
      token: "workos:eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcd",
      email: "user@example.com",
      nested: { refreshToken: "some-refresh-value" },
      note: "used super-secret-key here",
    });
    logger.info("plain token workos:abcdefghijklmnopqrstuvwxyz");
  } finally {
    console.log = originalLog;
  }

  const joined = lines.join("\n");
  assert.equal(joined.includes("abcdefghijklmnop"), false);
  assert.equal(joined.includes("super-secret-key"), false);
  assert.equal(joined.includes("some-refresh-value"), false);
  assert.equal(joined.includes("user@example.com"), false);
  assert.match(joined, /us\*+@example\.com/);
  assert.match(joined, /<REDACTED>/);
});

test("picks up accounts written by an external registrar without restart", () => {
  const dir = tempDir();
  const store = new AccountStore(dir, silent);
  assert.equal(store.count(), 0);
  const file = path.join(dir, "accounts.json");
  fs.writeFileSync(
    file,
    `${JSON.stringify(
      {
        version: 1,
        accounts: [
          {
            id: "ext",
            label: null,
            email: "a@b.c",
            accountId: "cu_x",
            access: "workos:tok",
            refresh: "ref",
            expires: Date.now() + 1000,
            tokenType: "Bearer",
            provider: "cline",
            createdAt: Date.now(),
            updatedAt: Date.now(),
            disabled: false,
            lastError: null,
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  assert.equal(store.count(), 1);
  assert.equal(store.get("ext")?.email, "a@b.c");
  assert.equal(store.listActive()[0]?.refresh, "ref");
});