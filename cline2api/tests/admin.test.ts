/**
 * Admin surface for account operations: paging, per-account toggling, liveness
 * probes and the proxy pool.
 *
 * These cover the paths that change state on disk, so each test asserts on the
 * persisted store as well as the HTTP response — a handler that answers 200
 * while writing nothing is the failure mode worth catching.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createApp } from "../src/index.js";
import { ProxyStore, parseProxyUrl, redactProxyUrl } from "../src/services/proxyStore.js";
import { createLogger } from "../src/logger.js";
import { resolveWindow, MAX_WINDOW_MS, DEFAULT_WINDOW_MS } from "../src/cline/credits.js";

const adminHeaders = { Authorization: "Bearer admin-token", "Content-Type": "application/json" };

interface Recorded {
  url: string;
  body: string;
}

/** Upstream that answers the endpoints the admin surface touches. */
async function startUpstream(options: { refreshOk?: boolean } = {}) {
  const requests: Recorded[] = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url ?? "", body });
      const url = new URL(req.url ?? "/", "http://127.0.0.1");
      const json = (payload: unknown, status = 200): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };

      if (url.pathname === "/api/v1/auth/refresh") {
        if (options.refreshOk === false) {
          return json({ error: "invalid_grant", error_description: "refresh token revoked" }, 400);
        }
        return json({
          success: true,
          data: {
            accessToken: "rotated-access",
            refreshToken: "rotated-refresh",
            tokenType: "Bearer",
            expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
            userInfo: { email: "mock@example.com", clineUserId: "cu_mock" },
          },
        });
      }
      if (url.pathname === "/api/v1/users/me") {
        return json({ success: true, data: { id: "usr-mock" } });
      }
      if (/\/api\/v1\/users\/[^/]+\/balance$/.test(url.pathname)) {
        return json({ success: true, data: { userId: "usr-mock", balance: 500_000 } });
      }
      if (/\/api\/v1\/users\/[^/]+\/usages$/.test(url.pathname)) {
        return json({
          success: true,
          data: {
            items: [
              {
                id: "usg-1",
                createdAt: new Date().toISOString(),
                creditsUsed: 0,
                costUsd: 39,
                operation: "chat_completion",
                aiInferenceProviderName: "vercel",
                aiModelName: "Deepseek-v4.1-Flash",
                promptTokens: 8,
                completionTokens: 1,
                totalTokens: 9,
                cachedTokens: 0,
              },
            ],
            total: 0,
            nextToken: null,
          },
        });
      }
      if (url.pathname === "/api/v1/users/me/plan") {
        return json({ success: true, data: { plan: { displayName: "Mock", isActive: true } } });
      }
      if (url.pathname === "/api/v1/users/me/plan/usage-limits") {
        return json({ success: true, data: { limits: [] } });
      }
      if (url.pathname === "/api/v1/chat/completions") {
        return json({
          choices: [{ message: { content: "可用" }, finish_reason: "stop" }],
          usage: { total_tokens: 9 },
        });
      }
      return json({ error: "Not Found", success: false }, 404);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function accountRecord(id: string, index: number): Record<string, unknown> {
  return {
    id,
    label: null,
    email: `user${index}@example.com`,
    accountId: `cu_${id}`,
    access: "seed-access",
    refresh: "seed-refresh",
    expires: Date.now() + 3_600_000,
    tokenType: "Bearer",
    provider: "cline",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    disabled: false,
    lastError: null,
  };
}

function makeDataDir(accounts: number): string {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-admin-"));
  const list = Array.from({ length: accounts }, (_, i) => accountRecord(`acct-${i + 1}`, i + 1));
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({ version: 1, accounts: list }),
    "utf8",
  );
  return dataDir;
}

async function withGateway(
  accounts: number,
  run: (ctx: ReturnType<typeof createApp> & { dataDir: string; upstream: Awaited<ReturnType<typeof startUpstream>> }) => Promise<void>,
  options: { refreshOk?: boolean } = {},
): Promise<void> {
  const upstream = await startUpstream(options);
  const dataDir = makeDataDir(accounts);
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    ADMIN_TOKEN: "admin-token",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const ctx = createApp(config);
  try {
    await run({ ...ctx, dataDir, upstream });
  } finally {
    await upstream.close();
  }
}

function readStore(dataDir: string): Array<Record<string, unknown>> {
  const raw = JSON.parse(fs.readFileSync(path.join(dataDir, "accounts.json"), "utf8")) as {
    accounts: Array<Record<string, unknown>>;
  };
  return raw.accounts;
}

/* ---------------- window resolution ---------------- */

test("resolveWindow defaults to a rolling day", () => {
  const now = Date.now();
  const w = resolveWindow({ now });
  assert.equal(w.windowMs, DEFAULT_WINDOW_MS);
  assert.equal(w.until, now);
  assert.equal(w.since, now - DEFAULT_WINDOW_MS);
  assert.equal(w.snappedToDay, false);
});

test("resolveWindow clamps out-of-range windows instead of failing", () => {
  const now = Date.now();
  assert.equal(resolveWindow({ now, windowMs: 1 }).windowMs, 60_000);
  assert.equal(resolveWindow({ now, windowMs: MAX_WINDOW_MS * 10 }).windowMs, MAX_WINDOW_MS);
  // A non-finite value falls back to the default rather than producing NaN.
  assert.equal(resolveWindow({ now, windowMs: Number.NaN }).windowMs, DEFAULT_WINDOW_MS);
});

test("snapToDay only applies to a day-scale window", () => {
  const noon = new Date(2026, 8, 21, 12, 34, 0).getTime();
  const day = resolveWindow({ now: noon, windowMs: DEFAULT_WINDOW_MS, snapToDay: true });
  assert.equal(day.snappedToDay, true);
  assert.equal(new Date(day.since).getHours(), 0);

  // A 30-minute window must not be snapped to midnight: that would return
  // however much of today has elapsed, the opposite of the request.
  const short = resolveWindow({ now: noon, windowMs: 30 * 60 * 1000, snapToDay: true });
  assert.equal(short.snappedToDay, false);
  assert.equal(short.since, noon - 30 * 60 * 1000);
});

/* ---------------- accounts: paging, filter, toggle ---------------- */

test("accounts page and filter server-side, counting the filtered set", async () => {
  await withGateway(25, async ({ app }) => {
    const first = (await (await app.request("/admin/api/accounts", { headers: adminHeaders })).json()) as {
      accounts: unknown[];
      page: number;
      total: number;
      totalPages: number;
      pageSize: number;
    };
    assert.equal(first.pageSize, 20);
    assert.equal(first.total, 25);
    assert.equal(first.totalPages, 2);
    assert.equal(first.accounts.length, 20);

    const second = (await (
      await app.request("/admin/api/accounts?page=2", { headers: adminHeaders })
    ).json()) as { accounts: unknown[]; page: number };
    assert.equal(second.page, 2);
    assert.equal(second.accounts.length, 5);

    // A page past the end clamps rather than erroring: that is what a pool
    // shrinking under the UI looks like.
    const beyond = (await (
      await app.request("/admin/api/accounts?page=99", { headers: adminHeaders })
    ).json()) as { page: number; accounts: unknown[] };
    assert.equal(beyond.page, 2);
    assert.equal(beyond.accounts.length, 5);

    const search = (await (
      await app.request("/admin/api/accounts?q=user7", { headers: adminHeaders })
    ).json()) as { accounts: Array<{ email: string }>; total: number };
    // Filtering happens before paging, so the total reflects the match.
    assert.equal(search.total, 1);
    assert.equal(search.accounts[0]?.email, "user7@example.com");
  });
});

test("PATCH disables an account, and re-enabling clears the stale error", async () => {
  await withGateway(1, async ({ app, dataDir }) => {
    const off = await app.request("/admin/api/accounts/acct-1", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ disabled: true, lastError: "should be ignored" }),
    });
    assert.equal(off.status, 200);
    const offBody = (await off.json()) as { account: { disabled: boolean } };
    assert.equal(offBody.account.disabled, true);
    assert.equal(readStore(dataDir)[0]?.disabled, true);

    // Simulate a refresh-token death, then re-enable: `lastError` must be
    // cleared, or the UI keeps showing a healthy account as broken.
    const store = readStore(dataDir);
    store[0]!.lastError = "invalid_grant: re-login required";
    fs.writeFileSync(
      path.join(dataDir, "accounts.json"),
      JSON.stringify({ version: 1, accounts: store }),
      "utf8",
    );

    const on = await app.request("/admin/api/accounts/acct-1", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ disabled: false }),
    });
    const onBody = (await on.json()) as { account: { disabled: boolean; lastError: string | null } };
    assert.equal(onBody.account.disabled, false);
    assert.equal(onBody.account.lastError, null);
  });
});

test("PATCH rejects an empty patch and an unknown proxy", async () => {
  await withGateway(1, async ({ app }) => {
    const empty = await app.request("/admin/api/accounts/acct-1", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ unrelated: 1 }),
    });
    assert.equal(empty.status, 400);

    // An account pointing at a proxy that does not exist would fail open and
    // look configured, so the reference is validated up front.
    const bogus = await app.request("/admin/api/accounts/acct-1", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ proxyId: "does-not-exist" }),
    });
    assert.equal(bogus.status, 400);
  });
});

/* ---------------- probe ---------------- */

test("a probe reports a live account and forces a refresh", async () => {
  await withGateway(1, async ({ app, upstream }) => {
    const response = await app.request("/admin/api/accounts/acct-1/probe", {
      method: "POST",
      headers: adminHeaders,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as { ok: boolean; uid: string | null; stage: string };
    assert.equal(body.ok, true);
    assert.equal(body.uid, "usr-mock");
    assert.equal(body.stage, "ok");
    // The refresh is the only step that can detect a revoked refresh token, so
    // the probe must actually take it even though the access token is valid.
    assert.ok(upstream.requests.some((r) => r.url === "/api/v1/auth/refresh"));
  });
});

test("a probe on a revoked refresh token fails at the credential stage", async () => {
  await withGateway(
    1,
    async ({ app }) => {
      const response = await app.request("/admin/api/accounts/acct-1/probe", {
        method: "POST",
        headers: adminHeaders,
      });
      const body = (await response.json()) as { ok: boolean; stage: string; error: string | null };
      assert.equal(body.ok, false);
      assert.equal(body.stage, "credential");
      assert.match(body.error ?? "", /re-login|refresh/i);
    },
    { refreshOk: false },
  );
});

/* ---------------- per-account test ---------------- */

test("a per-account test pins that account and returns usage", async () => {
  await withGateway(3, async ({ app }) => {
    const response = await app.request("/admin/api/accounts/acct-2/test", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ model: "anthropic/claude-sonnet-4.6", prompt: "hi" }),
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      ok: boolean;
      accountId: string;
      content: string;
      usage: { total_tokens: number } | null;
    };
    assert.equal(body.ok, true);
    assert.equal(body.accountId, "acct-2");
    assert.equal(body.content, "可用");
    assert.equal(body.usage?.total_tokens, 9);
  });
});

test("a per-account test requires a model and a known account", async () => {
  await withGateway(1, async ({ app }) => {
    const noModel = await app.request("/admin/api/accounts/acct-1/test", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({}),
    });
    assert.equal(noModel.status, 400);

    const unknown = await app.request("/admin/api/accounts/nope/test", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ model: "m" }),
    });
    assert.equal(unknown.status, 404);
  });
});

/* ---------------- proxy store ---------------- */

test("parseProxyUrl accepts the supported schemes and rejects the rest", () => {
  assert.ok("url" in parseProxyUrl("http://user:pass@host:8080"));
  assert.ok("url" in parseProxyUrl("socks5://host:1080"));
  assert.ok("error" in parseProxyUrl(""));
  assert.ok("error" in parseProxyUrl("not a url"));
  assert.ok("error" in parseProxyUrl("ftp://host:21"));
});

test("redactProxyUrl hides the password but keeps the username", () => {
  const redacted = redactProxyUrl("http://alice:s3cret@proxy.example:8080");
  assert.ok(!redacted.includes("s3cret"), "password must not survive redaction");
  assert.ok(redacted.includes("alice"), "username is how operators tell entries apart");
  assert.ok(redacted.includes("proxy.example"));
});

test("the proxy store persists 0600 and round-trips", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxystore-"));
  const store = new ProxyStore(dataDir, createLogger("error"));
  const created = store.add({ url: "http://u:p@host:8080", label: "US" });
  assert.equal(store.list().length, 1);
  assert.equal(store.get(created.id)?.label, "US");

  // Proxy URLs carry credentials, so the file must not be world-readable.
  const mode = fs.statSync(path.join(dataDir, "proxies.json")).mode & 0o777;
  assert.equal(mode, 0o600);

  // A second instance sees the same data, which is how a restart keeps them.
  const reopened = new ProxyStore(dataDir, createLogger("error"));
  assert.equal(reopened.list()[0]?.url, "http://u:p@host:8080");

  assert.equal(store.remove(created.id), true);
  assert.equal(store.remove(created.id), false);
});

/* ---------------- proxy API ---------------- */

test("the proxy API never echoes a stored password", async () => {
  await withGateway(1, async ({ app, dataDir }) => {
    const created = await app.request("/admin/api/proxies", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ url: "http://alice:s3cret@proxy.example:8080", label: "US" }),
    });
    assert.equal(created.status, 201);
    const createdBody = (await created.json()) as { proxy: { id: string; url: string } };
    assert.ok(!createdBody.proxy.url.includes("s3cret"));

    const listed = (await (await app.request("/admin/api/proxies", { headers: adminHeaders })).json()) as {
      proxies: Array<{ url: string; usedBy: number }>;
    };
    assert.equal(listed.proxies.length, 1);
    assert.ok(!listed.proxies[0]!.url.includes("s3cret"));
    // The file on disk keeps the real URL; only the response is redacted.
    const onDisk = fs.readFileSync(path.join(dataDir, "proxies.json"), "utf8");
    assert.ok(onDisk.includes("s3cret"));
  });
});

test("a proxy in use cannot be deleted without force", async () => {
  await withGateway(2, async ({ app, dataDir }) => {
    const created = (await (
      await app.request("/admin/api/proxies", {
        method: "POST",
        headers: adminHeaders,
        body: JSON.stringify({ url: "http://host:8080" }),
      })
    ).json()) as { proxy: { id: string } };

    await app.request("/admin/api/accounts/acct-1", {
      method: "PATCH",
      headers: adminHeaders,
      body: JSON.stringify({ proxyId: created.proxy.id }),
    });

    const refused = await app.request(`/admin/api/proxies/${created.proxy.id}`, {
      method: "DELETE",
      headers: adminHeaders,
    });
    assert.equal(refused.status, 409);
    // Refusing is the point: deleting would leave the accounts egressing from
    // the host IP with nothing in the UI saying so.
    assert.equal(readStore(dataDir)[0]?.proxyId, created.proxy.id);

    const forced = (await (
      await app.request(`/admin/api/proxies/${created.proxy.id}?force=1`, {
        method: "DELETE",
        headers: adminHeaders,
      })
    ).json()) as { removed: boolean; unassigned: number };
    assert.equal(forced.removed, true);
    assert.equal(forced.unassigned, 1);
    assert.equal(readStore(dataDir)[0]?.proxyId, null);
  });
});

test("the proxy API rejects duplicates and bad URLs", async () => {
  await withGateway(1, async ({ app }) => {
    const first = await app.request("/admin/api/proxies", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ url: "http://host:8080" }),
    });
    assert.equal(first.status, 201);

    const dup = await app.request("/admin/api/proxies", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ url: "http://host:8080" }),
    });
    assert.equal(dup.status, 409);

    const bad = await app.request("/admin/api/proxies", {
      method: "POST",
      headers: adminHeaders,
      body: JSON.stringify({ url: "ftp://host:21" }),
    });
    assert.equal(bad.status, 400);
  });
});

/* ---------------- credits paging + window ---------------- */

test("credits paging and window reach upstream per page, not per pool", async () => {
  await withGateway(30, async ({ app, upstream }) => {
    upstream.requests.length = 0;
    const response = await app.request("/admin/api/credits?page=1&pageSize=5&hours=6", {
      headers: adminHeaders,
    });
    assert.equal(response.status, 200);
    const body = (await response.json()) as {
      accounts: Array<{ window: { requests: number; costUsd: number }; windowMs: number }>;
      page: number;
      total: number;
      totalPages: number;
    };
    assert.equal(body.accounts.length, 5);
    assert.equal(body.total, 30);
    assert.equal(body.totalPages, 6);
    assert.equal(body.accounts[0]?.windowMs, 6 * 60 * 60 * 1000);
    assert.equal(body.accounts[0]?.window.requests, 1);
    // 39 cost units at 1e8 per USD — not 1e6, which would be 100x too large.
    assert.equal(body.accounts[0]?.window.costUsd, 0.00000039);

    // Five rows, three upstream calls each: paging is what keeps a 90-account
    // pool from costing 270 calls to render twenty rows.
    const meCalls = upstream.requests.filter((r) => r.url === "/api/v1/users/me").length;
    assert.equal(meCalls, 5);
  });
});
