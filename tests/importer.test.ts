/**
 * Account import: file-shape parsing and the merge/verify behaviour.
 *
 * The verify step is stubbed by pointing the config at a local HTTP server that
 * plays WorkOS, so these tests exercise the real refresh path rather than a
 * mocked importer.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { AccountStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { loadConfig } from "../src/config.js";
import { createImporter, parseImportFile, parseImportedAccount } from "../src/services/importer.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-import-"));
}

const silent = createLogger("error", []);

/** A WorkOS stand-in that accepts one refresh token and rejects the others. */
function fakeWorkOS(validRefreshTokens: Set<string>): Promise<{ server: http.Server; base: string }> {
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => { body += chunk; });
    req.on("end", () => {
      // Upstream speaks camelCase here: `{refreshToken, grantType}`.
      const grant = (() => {
        try { return (JSON.parse(body) as { refreshToken?: string }).refreshToken; }
        catch { return undefined; }
      })();
      if (!grant || !validRefreshTokens.has(grant)) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "invalid_grant" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        success: true,
        data: {
          accessToken: "rotated-access-" + grant,
          refreshToken: "rotated-" + grant,
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          userInfo: { email: grant + "@example.com", clineUserId: "cu_" + grant },
        },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, base: `http://127.0.0.1:${port}` });
    });
  });
}

/* ---------------------------------------------------------------- parsing */

test("an entry is read from the store shape and from a bare credentials object", () => {
  const stored = parseImportedAccount({
    id: "abc", access: "a1", refresh: "r1", expires: 1_700_000_000_000,
    accountId: "cu_1", email: "u@example.com", tokenType: "Bearer", provider: "cline",
  });
  assert.equal("error" in stored, false);
  assert.deepEqual(
    { access: (stored as { access: string }).access, refresh: (stored as { refresh: string }).refresh },
    { access: "a1", refresh: "r1" },
  );

  const bare = parseImportedAccount({
    access_token: "a2", refresh_token: "r2", expires_at: "2026-09-21T00:00:00Z",
  });
  assert.equal("error" in bare, false);
  assert.equal((bare as { access: string }).access, "a2");
});

test("an entry without both tokens is rejected, not half-imported", () => {
  assert.deepEqual(parseImportedAccount({ access: "a" }), { error: "missing refresh token" });
  assert.deepEqual(parseImportedAccount({ refresh: "r" }), { error: "missing access token" });
  assert.deepEqual(parseImportedAccount("nope"), { error: "entry is not an object" });
});

test("a seconds-based expiry is widened to milliseconds", () => {
  const parsed = parseImportedAccount({ access: "a", refresh: "r", expires: 1_700_000_000 });
  assert.equal((parsed as { expires: number }).expires, 1_700_000_000_000);
});

test("the file may be the store envelope or a bare array", () => {
  assert.deepEqual(parseImportFile({ version: 1, accounts: [1, 2] }), [1, 2]);
  assert.deepEqual(parseImportFile([1, 2]), [1, 2]);
  assert.deepEqual(parseImportFile({ version: 1 }), { error: "file has no `accounts` array" });
  assert.deepEqual(parseImportFile("x"), { error: "file must be a JSON object or array" });
});

/* ---------------------------------------------------------------- merging */

test("an import verifies, then stores the rotated credentials", async () => {
  const { server, base } = await fakeWorkOS(new Set(["good"]));
  try {
    const dir = tempDir();
    const store = new AccountStore(dir, silent);
    const config = { ...loadConfig(), workosApiBaseUrl: base, clineApiBaseUrl: base };
    const report = await createImporter(store, config, silent).import({
      version: 1,
      accounts: [{ access: "stale", refresh: "good", expires: 0, email: "good@example.com" }],
    });

    assert.equal(report.failed.length, 0);
    assert.equal(report.imported.length, 1);
    assert.equal(report.imported[0].action, "added");
    // The stored token is the rotated one, not what the file carried.
    assert.equal(store.list()[0].access, "rotated-access-good");
    assert.equal(store.list()[0].refresh, "rotated-good");
  } finally {
    server.close();
  }
});

test("re-importing the same account updates it in place", async () => {
  const { server, base } = await fakeWorkOS(new Set(["good"]));
  try {
    const dir = tempDir();
    const store = new AccountStore(dir, silent);
    const config = { ...loadConfig(), workosApiBaseUrl: base, clineApiBaseUrl: base };
    const importer = createImporter(store, config, silent);
    const file = { version: 1, accounts: [{ access: "x", refresh: "good", expires: 0, email: "good@example.com" }] };

    await importer.import(file);
    const firstId = store.list()[0].id;
    const second = await importer.import(file);

    assert.equal(store.count(), 1, "the second import must not duplicate the account");
    assert.equal(second.imported[0].id, firstId);
  } finally {
    server.close();
  }
});

test("an account whose refresh token is dead is reported, not stored", async () => {
  const { server, base } = await fakeWorkOS(new Set(["good"]));
  try {
    const dir = tempDir();
    const store = new AccountStore(dir, silent);
    const config = { ...loadConfig(), workosApiBaseUrl: base, clineApiBaseUrl: base };
    const report = await createImporter(store, config, silent).import({
      version: 1,
      accounts: [
        { access: "a", refresh: "dead", expires: 0, email: "dead@example.com" },
        { access: "a", refresh: "good", expires: 0, email: "good@example.com" },
      ],
    });

    assert.equal(store.count(), 1, "only the verifiable account is stored");
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0].index, 0, "the failing entry names its file position");
    assert.equal(report.imported.length, 1, "a bad entry does not abort the rest");
  } finally {
    server.close();
  }
});

test("a previously disabled account is revived by a verified import", async () => {
  const { server, base } = await fakeWorkOS(new Set(["good"]));
  try {
    const dir = tempDir();
    const store = new AccountStore(dir, silent);
    const config = { ...loadConfig(), workosApiBaseUrl: base, clineApiBaseUrl: base };
    const saved = store.saveCredentials(
      { access: "old", refresh: "good", expires: 0, email: "good@example.com" },
      { provider: "cline" },
    );
    store.update(saved.id, { disabled: true, lastError: "invalid_grant: re-login required" });

    await createImporter(store, config, silent).import({
      version: 1,
      accounts: [{ access: "x", refresh: "good", expires: 0, email: "good@example.com" }],
    });

    assert.equal(store.get(saved.id)?.disabled, false);
    assert.equal(store.get(saved.id)?.lastError, null);
  } finally {
    server.close();
  }
});
