/**
 * The capability index: which accounts hold which plan.
 *
 * The pool is round-robin, so a plan held by a couple of accounts out of
 * hundreds is effectively unreachable — a Pass request is handed to account
 * after account that cannot serve it, and the failover walk never arrives at
 * the ones that can. The index is what makes that routing decision possible,
 * so what matters here is that it reads the plan authoritatively, that a
 * failed read never masquerades as "no Pass", and that a cold index is not
 * mistaken for an empty one.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import { AccountStore } from "../src/store.js";
import { ProxyResolver } from "../src/cline/proxy.js";
import { ProxyStore } from "../src/services/proxyStore.js";
import { TokenManager } from "../src/cline/tokenManager.js";
import { CapabilityIndex, CAPABILITY_TTL_MS } from "../src/services/accountCapabilities.js";

const logger = createLogger("error");

interface Upstream {
  url: string;
  planCalls: string[];
  close: () => Promise<void>;
  /** Account ids whose plan lookup should fail, as if upstream were down. */
  failing: Set<string>;
}

/** Upstream that answers the plan endpoint, keyed by the token it was given. */
async function startUpstream(
  passFor: (token: string) => boolean,
  hasPlanFor: (token: string) => boolean = () => true,
): Promise<Upstream> {
  const planCalls: string[] = [];
  const failing = new Set<string>();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const token = String(req.headers.authorization ?? "").replace("Bearer ", "");
    const json = (payload: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (url.pathname === "/api/v1/auth/refresh") {
      return json({
        success: true,
        data: {
          accessToken: `access-${token}`,
          refreshToken: `refresh-${token}`,
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          userInfo: { email: `${token}@example.com`, clineUserId: `cu_${token}` },
        },
      });
    }
    if (url.pathname === "/api/v1/users/me/plan") {
      planCalls.push(token);
      if (failing.has(token)) return json({ error: "upstream exploded" }, 500);
      // The pool's normal state: no subscription at all, answered with a 404.
      if (!hasPlanFor(token)) return json({ error: "Not Found" }, 404);
      const pass = passFor(token);
      return json({
        success: true,
        data: {
          plan: {
            displayName: pass ? "Cline Pass (Monthly)" : "Free",
            isActive: true,
            entitlements: { cline_pass: { enabled: pass } },
          },
        },
      });
    }
    return json({ error: "Not Found" }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    planCalls,
    failing,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function buildIndex(
  upstream: Upstream,
  tokens: Array<{ id: string; token: string }>,
  now: () => number = Date.now,
): { index: CapabilityIndex; dataDir: string } {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-caps-"));
  const expires = Date.now() + 3_600_000;
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: tokens.map((t) => ({
        id: t.id,
        label: null,
        email: `${t.token}@example.com`,
        accountId: `cu_${t.token}`,
        access: t.token,
        refresh: t.token,
        expires,
        tokenType: "Bearer",
        provider: "cline",
        createdAt: Date.now(),
        updatedAt: Date.now(),
        disabled: false,
        lastError: null,
      })),
    }),
    "utf8",
  );
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
  });
  const store = new AccountStore(dataDir, logger);
  const proxies = new ProxyStore(dataDir, logger);
  const resolver = new ProxyResolver({ proxies, store, logger });
  const manager = new TokenManager(store, config, logger, resolver);
  return {
    index: new CapabilityIndex({ config, logger, store, tokens: manager, resolver, now }),
    dataDir,
  };
}

test("the sweep learns which accounts hold Cline Pass", async () => {
  // Identified by the rotated credential the plan call carries, not the seeded
  // `access` value: the token manager refreshes before calling upstream.
  const upstream = await startUpstream((token) => token === "workos:pass-token");
  const { index } = buildIndex(upstream, [
    { id: "acct-pass", token: "pass-token" },
    { id: "acct-free-1", token: "free-1" },
    { id: "acct-free-2", token: "free-2" },
  ]);
  try {
    assert.deepEqual(index.stats(), { known: 0, clinePass: 0 }, "cold to start");

    index.sweep();
    await index.settled();

    assert.deepEqual(index.stats(), { known: 3, clinePass: 1 });
    assert.deepEqual(index.clinePassAccounts(), ["acct-pass"]);
    assert.equal(index.get("acct-pass")?.clinePass, true);
    assert.equal(index.get("acct-free-1")?.clinePass, false);
  } finally {
    await upstream.close();
  }
});

test("a failed plan read leaves the account unknown rather than marking it unentitled", async () => {
  const upstream = await startUpstream(() => true);
  const { index } = buildIndex(upstream, [
    { id: "acct-ok", token: "ok" },
    { id: "acct-down", token: "down" },
  ]);
  // The second account's plan lookup fails. Recording "no Pass" for it would
  // route Pass traffic away from an account that may well hold it, so the read
  // must leave no entry at all.
  //
  // Keyed on the credential the mock actually receives. The seeded `access`
  // value is opaque to the fixture, so the token manager refreshes it first and
  // the plan call carries the rotated one (`workos:<refresh>`).
  upstream.failing.add("workos:down");
  try {
    index.sweep();
    await index.settled();

    assert.equal(index.get("acct-down"), null, "a failed read must not record a verdict");
    assert.deepEqual(index.stats(), { known: 1, clinePass: 1 });
  } finally {
    await upstream.close();
  }
});

test("a reading expires rather than being trusted forever", async () => {
  const upstream = await startUpstream(() => true);
  const clock = { now: Date.now() };
  const { index } = buildIndex(upstream, [{ id: "acct-1", token: "t1" }], () => clock.now);
  try {
    index.record("acct-1", true);
    assert.equal(index.get("acct-1")?.clinePass, true);
    assert.deepEqual(index.stats(), { known: 1, clinePass: 1 });

    // Past the TTL the reading is gone, so a caller falls back to the pool
    // order instead of trusting a plan that may have lapsed.
    clock.now += CAPABILITY_TTL_MS + 1;
    assert.equal(index.get("acct-1"), null);
    assert.deepEqual(index.stats(), { known: 0, clinePass: 0 });
    assert.deepEqual(index.clinePassAccounts(), []);
  } finally {
    await upstream.close();
  }
});

test("a second sweep joins the one in flight instead of stacking upstream calls", async () => {
  const upstream = await startUpstream(() => true);
  const { index } = buildIndex(upstream, [
    { id: "acct-1", token: "t1" },
    { id: "acct-2", token: "t2" },
  ]);
  try {
    const first = index.sweep();
    const second = index.sweep();
    assert.equal(first.started, true);
    assert.equal(second.started, false, "the repeat call must not start a second pass");
    await index.settled();

    // Exactly one plan read per account, not two.
    assert.equal(upstream.planCalls.length, 2, `expected 2 plan calls, got ${upstream.planCalls.length}`);
  } finally {
    await upstream.close();
  }
});

test("an account with no plan at all is recorded as having no Pass", async () => {
  // Most of a bulk-registered pool has no subscription, and upstream answers
  // `GET /users/me/plan` with a 404 for them. That is a definitive "no Pass",
  // not a failure to read — treating it as one would leave the index empty and
  // stop a Pass request from ever being routed.
  const upstream = await startUpstream(
    (token) => token === "workos:pass-token",
    (token) => token === "workos:pass-token",
  );
  const { index } = buildIndex(upstream, [
    { id: "acct-pass", token: "pass-token" },
    { id: "acct-none-1", token: "none-1" },
    { id: "acct-none-2", token: "none-2" },
  ]);
  try {
    index.sweep();
    await index.settled();

    assert.deepEqual(index.stats(), { known: 3, clinePass: 1 });
    assert.equal(index.get("acct-none-1")?.clinePass, false, "a 404 must be recorded as no Pass");
  } finally {
    await upstream.close();
  }
});
