/**
 * Rate limiting.
 *
 * The behaviour worth pinning is the asymmetry between the two ceilings: a key
 * over its limit must be refused *immediately* (so a client holding several
 * keys can rotate), while a globally saturated gateway must wait briefly before
 * giving up. Getting that backwards would either stall key rotation or drop
 * traffic that a moment's patience would have served.
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
import { RateLimiter } from "../src/services/rateLimit.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("error");

function makeLimiter(
  settings: { globalPerMinute?: number; keyPerMinute?: number } = {},
  maxWaitMs = 0,
): RateLimiter {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-rl-"));
  return new RateLimiter({
    dataDir,
    logger,
    maxWaitMs,
    defaults: { globalPerMinute: settings.globalPerMinute ?? 3, keyPerMinute: settings.keyPerMinute ?? 2 },
  });
}

test("a key over its ceiling is refused at once, without waiting", async () => {
  const limiter = makeLimiter();
  // maxWaitMs is 0 here, so a wait would be indistinguishable from a refusal;
  // the assertion that matters is which ceiling refused and with what advice.
  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k1")).allowed, true);

  const third = await limiter.acquire("k1");
  assert.equal(third.allowed, false);
  assert.equal(third.scope, "key");
  assert.equal(third.limit, 2);
  assert.ok(third.retryAfterMs > 0, "a refusal must tell the client when to retry");

  // A different key is unaffected: that is what makes switching keys work.
  assert.equal((await limiter.acquire("k2")).allowed, true);
});

test("the global ceiling refuses once the whole gateway is saturated", async () => {
  const limiter = makeLimiter({ globalPerMinute: 2, keyPerMinute: 100 });
  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k2")).allowed, true);

  const third = await limiter.acquire("k3");
  assert.equal(third.allowed, false);
  assert.equal(third.scope, "global");
  assert.equal(third.limit, 2);
});

test("a saturated gateway waits for a slot instead of refusing immediately", async () => {
  // A short budget: the point is that it waited before refusing, and a rolling
  // minute cannot free up inside the test either way.
  const limiter = makeLimiter({ globalPerMinute: 1, keyPerMinute: 100 }, 400);
  assert.equal((await limiter.acquire("k1")).allowed, true);

  const started = Date.now();
  const decision = await limiter.acquire("k2");
  const waited = Date.now() - started;
  assert.equal(decision.allowed, false);
  assert.equal(decision.scope, "global");
  assert.ok(waited >= 100, `expected a wait before giving up, waited ${waited}ms`);
  assert.ok(waited < 2000, `expected a bounded wait, waited ${waited}ms`);
});

test("disabling the limiter lets everything through", async () => {
  const limiter = makeLimiter({ globalPerMinute: 1, keyPerMinute: 1 });
  limiter.update({ enabled: false });
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await limiter.acquire("k1")).allowed, true);
  }
  // Re-enabling starts refusing again against a fresh ceiling.
  limiter.update({ enabled: true });
  limiter.reset();
  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k1")).allowed, false);
});

test("settings persist and are clamped, and a corrupt file keeps the defaults", () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-rl-"));
  const limiter = new RateLimiter({ dataDir, logger });
  // Defaults apply when there is no file at all.
  assert.equal(limiter.getSettings().globalPerMinute, 400);
  assert.equal(limiter.getSettings().keyPerMinute, 200);

  const saved = limiter.update({ globalPerMinute: 1234, keyPerMinute: 7 });
  assert.equal(saved.globalPerMinute, 1234);
  assert.equal(saved.keyPerMinute, 7);
  // Out-of-range values are clamped rather than accepted verbatim.
  assert.equal(limiter.update({ keyPerMinute: 0 }).keyPerMinute, 1);
  assert.equal(limiter.update({ keyPerMinute: -5 }).keyPerMinute, 1);

  const reopened = new RateLimiter({ dataDir, logger });
  assert.equal(reopened.getSettings().globalPerMinute, 1234);
  assert.equal(reopened.getSettings().keyPerMinute, 1);

  // A corrupt file must not silently remove the limit.
  fs.writeFileSync(path.join(dataDir, "ratelimit.json"), "{not json", "utf8");
  const recovered = new RateLimiter({ dataDir, logger });
  assert.equal(recovered.getSettings().globalPerMinute, 400);
  assert.equal(recovered.getSettings().keyPerMinute, 200);
});

test("counters age out of the sliding window", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-rl-"));
  const limiter = new RateLimiter({
    dataDir,
    logger,
    maxWaitMs: 0,
    defaults: { globalPerMinute: 100, keyPerMinute: 2 },
  });
  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k1")).allowed, false);

  // Backdate the recorded requests past the one-minute window: the same key
  // must be allowed again, which a fixed-window counter would also do but a
  // never-resetting counter would not.
  const internals = limiter as unknown as { perKey: Map<string, number[]>; global: number[] };
  const old = Date.now() - 61_000;
  internals.perKey.set("k1", internals.perKey.get("k1")!.map(() => old));
  internals.global = internals.global.map(() => old);

  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k1")).allowed, true);
  assert.equal((await limiter.acquire("k1")).allowed, false);
});

/* ---------------- through the gateway ---------------- */

test("the limiter gates model calls only, and refuses with 429 + Retry-After", async () => {
  const upstream = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      const json = (payload: unknown, status = 200): void => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (req.url === "/api/v1/auth/refresh") {
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
      if (req.url === "/api/v1/models") return json({ data: [] });
      if (req.url === "/api/v1/ai/cline/recommended-models") return json({ free: [], clinePass: [] });
      if (req.url === "/api/v1/chat/completions") {
        return json({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] });
      }
      return json({ success: true, data: {} });
    });
  });
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-rl-app-"));
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "acct-1",
          label: null,
          email: "u@example.com",
          accountId: "cu_1",
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
  // Seed the settings file so the app boots with a ceiling of one per minute.
  fs.writeFileSync(
    path.join(dataDir, "ratelimit.json"),
    JSON.stringify({ enabled: true, globalPerMinute: 1, keyPerMinute: 1 }),
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
  const { app } = createApp(config);
  const headers = { Authorization: "Bearer test-key", "Content-Type": "application/json" };

  try {
    const body = JSON.stringify({ model: "mock/m", messages: [{ role: "user", content: "hi" }] });
    const first = await app.request("/v1/chat/completions", { method: "POST", headers, body });
    assert.equal(first.status, 200);

    const second = await app.request("/v1/chat/completions", { method: "POST", headers, body });
    assert.equal(second.status, 429);
    assert.equal(second.headers.get("retry-after") !== null, true);
    const payload = (await second.json()) as { error: { code: string } };
    assert.equal(payload.error.code, "key_rate_limited");

    // /v1/models is a free catalog read and the operator's own routes are not
    // gated, so a client polling models cannot throttle the console.
    const models = await app.request("/v1/models", { headers });
    assert.equal(models.status, 200);
    const admin = await app.request("/admin/api/rate-limit", {
      headers: { Authorization: "Bearer admin-token" },
    });
    assert.equal(admin.status, 200);
  } finally {
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

