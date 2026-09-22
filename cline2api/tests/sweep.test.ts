/**
 * Pool-wide liveness sweep.
 *
 * Two properties are worth pinning: a second start joins the running sweep
 * rather than launching a competing one (both would fight over the same
 * upstream budget), and the model choice decides whether the sweep spends
 * inference — with no model it must only prove the credential.
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
import { AccountPool } from "../src/services/accountPool.js";
import { TokenManager } from "../src/cline/tokenManager.js";
import { FreeQuotaStore } from "../src/services/freeQuota.js";
import { SweepRunner } from "../src/services/sweep.js";
import type { ProxyResolver } from "../src/cline/proxy.js";

const logger = createLogger("error");

/** Upstream that answers the two things a sweep can touch. */
async function startUpstream(options: { refreshOk?: boolean; chatOk?: boolean } = {}) {
  const requests: string[] = [];
  const server = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      requests.push(req.url ?? "");
      const json = (payload: unknown, status = 200): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/api/v1/auth/refresh") {
        if (options.refreshOk === false) {
          return json({ error: "invalid_grant", error_description: "revoked" }, 400);
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
      if (req.url === "/api/v1/users/me") return json({ success: true, data: { id: "usr-1" } });
      if (req.url === "/api/v1/chat/completions") {
        if (options.chatOk === false) return json({ error: { message: "nope" } }, 500);
        return json({ choices: [{ message: { content: "可用" }, finish_reason: "stop" }] });
      }
      return json({ error: "Not Found" }, 404);
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

function makeRunner(
  upstreamUrl: string,
  accounts: number,
  options: { disabledIndexes?: number[] } = {},
): SweepRunner {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-sweep-"));
  const disabled = new Set(options.disabledIndexes ?? []);
  const list = Array.from({ length: accounts }, (_, i) => ({
    id: `acct-${i + 1}`,
    label: null,
    email: `user${i + 1}@example.com`,
    accountId: `cu_${i + 1}`,
    access: "seed-access",
    refresh: "seed-refresh",
    expires: Date.now() + 3_600_000,
    tokenType: "Bearer",
    provider: "cline",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    disabled: disabled.has(i + 1),
    lastError: null,
  }));
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({ version: 1, accounts: list }),
    "utf8",
  );
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    ADMIN_TOKEN: "admin-token",
    CLINE_API_BASE_URL: upstreamUrl,
    WORKOS_API_BASE_URL: upstreamUrl,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const store = new AccountStore(dataDir, logger);
  const pool = new AccountPool(store);
  const tokens = new TokenManager(store, config, logger);
  return new SweepRunner({
    config,
    logger,
    store,
    tokens,
    pool,
    // No proxies in these tests; the resolver is only consulted for an account
    // that has a proxy assigned, which none of them do.
    resolver: { forAccount: () => undefined } as unknown as ProxyResolver,
    freeQuota: new FreeQuotaStore({ logger }),
  });
}

/** Wait for the sweep to stop running, so assertions see a settled state. */
async function settle(runner: SweepRunner): Promise<void> {
  for (let i = 0; i < 200; i += 1) {
    const state = runner.status();
    if (state !== null && !state.running) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("sweep did not finish in time");
}

test("credential mode proves every account without spending inference", async () => {
  const upstream = await startUpstream();
  try {
    const runner = makeRunner(upstream.url, 4);
    const { started } = runner.start({});
    assert.equal(started, true);
    await settle(runner);

    const state = runner.status();
    assert.equal(state?.total, 4);
    assert.equal(state?.done, 4);
    assert.equal(state?.ok, 4);
    assert.equal(state?.failed, 0);
    assert.equal(state?.model, null);
    // Credential mode must not touch the completion endpoint at all.
    assert.equal(upstream.requests.filter((u) => u === "/api/v1/chat/completions").length, 0);
    assert.ok(upstream.requests.includes("/api/v1/users/me"));
  } finally {
    await upstream.close();
  }
});

test("model mode sends one pinned completion per account", async () => {
  const upstream = await startUpstream();
  try {
    const runner = makeRunner(upstream.url, 3);
    runner.start({ model: "cline-free/kimi-k3" });
    await settle(runner);

    const state = runner.status();
    assert.equal(state?.model, "cline-free/kimi-k3");
    assert.equal(state?.ok, 3);
    assert.equal(upstream.requests.filter((u) => u === "/api/v1/chat/completions").length, 3);
  } finally {
    await upstream.close();
  }
});

test("failedOnly and activeOnly narrow the set, and failures are reported", async () => {
  const upstream = await startUpstream({ chatOk: false });
  try {
    const runner = makeRunner(upstream.url, 4, { disabledIndexes: [2] });

    // Only the disabled account is in scope, so the sweep is one account wide.
    runner.start({ model: "cline-free/kimi-k3", failedOnly: true });
    await settle(runner);
    let state = runner.status();
    assert.equal(state?.total, 1);
    assert.equal(state?.failed, 1);
    assert.equal(state?.failures[0]?.id, "acct-2");
    assert.equal(state?.failures[0]?.email, "user2@example.com");

    // activeOnly skips it, leaving three.
    runner.start({ model: "cline-free/kimi-k3", activeOnly: true });
    await settle(runner);
    state = runner.status();
    assert.equal(state?.total, 3);
    assert.equal(state?.failed, 3);
  } finally {
    await upstream.close();
  }
});

test("a second start joins the running sweep instead of starting another", async () => {
  const upstream = await startUpstream();
  try {
    // Enough accounts, with a fresh runner, that the first pass is still in
    // flight when the second call arrives.
    const runner = makeRunner(upstream.url, 12);
    const first = runner.start({});
    assert.equal(first.started, true);
    const second = runner.start({});
    assert.equal(second.started, false, "a running sweep must not be replaced");
    assert.equal(second.state?.id, first.state?.id);

    await settle(runner);
    assert.equal(runner.status()?.ok, 12);
    assert.equal(runner.status()?.total, 12);
  } finally {
    await upstream.close();
  }
});

test("a refresh-token death is reported as a failure, not a pass", async () => {
  const upstream = await startUpstream({ refreshOk: false });
  try {
    const runner = makeRunner(upstream.url, 2);
    runner.start({});
    await settle(runner);
    const state = runner.status();
    assert.equal(state?.failed, 2);
    assert.equal(state?.ok, 0);
  } finally {
    await upstream.close();
  }
});
