/**
 * Credit balance and usage ledger, against a mock Cline upstream.
 *
 * The two things worth pinning down are the ones that fail silently against
 * the real API: the balance path needs a resolved uid, and the usage cursor
 * only works when it round-trips as `cursor`. Sending it as `nextToken` is
 * accepted with a 200 and returns page one again, so a test that only checked
 * status codes would pass while the daily total quietly stayed wrong.
 */
import assert from "node:assert/strict";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import test from "node:test";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.js";
import { createLogger } from "../src/logger.js";
import {
  COST_UNITS_PER_USD,
  MICRO_USD,
  fetchAccountCredits,
  fetchUsagesSince,
  resolveWindow,
  startOfLocalDay,
  sumUsage,
} from "../src/cline/credits.js";

const UID = "usr-test-1";
const logger = createLogger("error");

/**
 * Fixed anchor for every mock record: local noon on a fixed day.
 *
 * Anchoring to `Date.now()` makes the "today's totals" assertions depend on
 * when the suite runs — a few seconds after local midnight, most of the
 * synthetic history falls on the previous day and gets filtered out. A fixed
 * anchor keeps `startOfLocalDay` well inside the generated window at any hour.
 */
const ANCHOR = new Date(2026, 8, 21, 12, 0, 0).getTime();
const SPACING_MS = 1000;

interface Mock {
  url: string;
  paths: string[];
  close: () => Promise<void>;
}

/**
 * Serves the three credit endpoints. `total` records are exposed, newest
 * first, 200 to a page, paging only via `cursor`.
 */
async function startMock(total = 3): Promise<Mock> {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    paths.push(url.pathname + (url.search || ""));
    const json = (body: unknown, status = 200): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };

    if (url.pathname === "/api/v1/users/me") {
      return json({ success: true, data: { id: UID } });
    }
    if (url.pathname === `/api/v1/users/${UID}/balance`) {
      return json({ success: true, data: { userId: UID, balance: 500_000 } });
    }
    if (url.pathname === `/api/v1/users/${UID}/usages`) {
      const limit = Math.min(Number(url.searchParams.get("limit") ?? 10), 200);
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const items = Array.from({ length: total }, (_, index) => ({
        id: `usg-${index}`,
        createdAt: new Date(ANCHOR - index * SPACING_MS).toISOString(),
        creditsUsed: 0,
        costUsd: 1000 + index,
        operation: "chat_completion",
        aiInferenceProviderName: "vercel",
        aiModelName: "Deepseek-v4.1-Flash",
        promptTokens: 100,
        completionTokens: 20,
        totalTokens: 120,
        cachedTokens: 5,
      })).slice(offset, offset + limit);
      const nextOffset = offset + items.length;
      return json({
        success: true,
        data: {
          items,
          total: 0,
          nextToken: nextOffset < total ? String(nextOffset) : null,
        },
      });
    }
    return json({ error: "Not Found", success: false }, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const configUrl = `http://127.0.0.1:${port}`;
  return {
    url: configUrl,
    paths,
    close: () => new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

function configFor(url: string) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-credits-"));
  return loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
}

test("startOfLocalDay lands on local midnight", () => {
  const noon = new Date(2026, 8, 21, 12, 34, 56).getTime();
  const start = new Date(startOfLocalDay(noon));
  assert.equal(start.getHours(), 0);
  assert.equal(start.getMinutes(), 0);
  assert.equal(start.getSeconds(), 0);
  assert.equal(start.getDate(), 21);
});

test("sumUsage adds every token and cost field", () => {
  const totals = sumUsage([
    {
      id: "a",
      at: 1,
      model: null,
      operation: null,
      provider: null,
      promptTokens: 10,
      completionTokens: 2,
      cachedTokens: 1,
      totalTokens: 12,
      costMicroUsd: 100,
      creditsUsed: 0,
    },
    {
      id: "b",
      at: 2,
      model: null,
      operation: null,
      provider: null,
      promptTokens: 20,
      completionTokens: 4,
      cachedTokens: 3,
      totalTokens: 24,
      costMicroUsd: 200,
      creditsUsed: 5,
    },
  ]);
  assert.deepEqual(totals, {
    requests: 2,
    promptTokens: 30,
    completionTokens: 6,
    cachedTokens: 4,
    totalTokens: 36,
    costUnits: 300,
    // costUsd is 1e8 per USD, NOT 1e6: 300 units is $0.000003, not $0.0003.
    costUsd: 0.000003,
    creditsMicroUsd: 5,
  });
});

test("costUsd and creditsUsed are 100x apart, as upstream reports them", () => {
  // The real ratio measured across every paid record in the live ledger. A
  // single shared divider silently overstates one of them by 100x, which is
  // exactly the bug this pins down.
  const paid = { costUnits: 3900, creditsMicroUsd: 39 };
  assert.equal(paid.costUnits / COST_UNITS_PER_USD, 0.000039);
  assert.equal(paid.creditsMicroUsd / MICRO_USD, 0.000039);
  assert.equal(paid.costUnits / paid.creditsMicroUsd, 100);
});

test("usages page through the cursor until the window is covered", async () => {
  const upstream = await startMock(450);
  const config = configFor(upstream.url);
  try {
    const records = await fetchUsagesSince(config, "Bearer workos:x", UID, 0, logger);
    assert.equal(records.length, 450);
    // 450 records at 200 a page is three requests, and only the second and
    // third carry a cursor.
    const usagePaths = upstream.paths.filter((p) => p.includes("/usages"));
    assert.equal(usagePaths.length, 3);
    assert.ok(!usagePaths[0]?.includes("cursor"));
    assert.ok(usagePaths[1]?.includes("cursor=200"));
    assert.ok(usagePaths[2]?.includes("cursor=400"));
    // The response names the field nextToken; sending it back under that name
    // is silently ignored, so assert it never appears in a request.
    assert.ok(!upstream.paths.some((p) => p.includes("nextToken")));
  } finally {
    await upstream.close();
  }
});

test("a window that starts mid-history stops paging early", async () => {
  const upstream = await startMock(450);
  const config = configFor(upstream.url);
  try {
    // 2.5s back covers the three newest records (they are a second apart).
    const since = ANCHOR - 2500;
    const records = await fetchUsagesSince(config, "Bearer workos:x", UID, since, logger);
    assert.equal(records.length, 3);
    assert.equal(upstream.paths.filter((p) => p.includes("/usages")).length, 1);
  } finally {
    await upstream.close();
  }
});

test("account credits resolve the uid, then read balance and today's totals", async () => {
  const upstream = await startMock(3);
  const config = configFor(upstream.url);
  try {
    const credits = await fetchAccountCredits(config, "Bearer workos:x", logger, { now: ANCHOR });
    assert.equal(credits.uid, UID);
    assert.equal(credits.error, null);
    assert.equal(credits.balanceMicroUsd, 500_000);
    assert.equal(credits.balanceUsd, 0.5);
    // 1 credit = $0.01, so $0.50 is 50 credits.
    assert.equal(credits.balanceCredits, 50);
    assert.equal(credits.window.requests, 3);
    assert.equal(credits.window.totalTokens, 360);
    assert.equal(credits.window.costUnits, 3003);
    // 3003 cost units at 1e8 per USD.
    assert.equal(credits.window.costUsd, 0.00003003);
    assert.equal(credits.lastUsage?.model, "Deepseek-v4.1-Flash");
    // The balance path takes the uid, not "me".
    assert.ok(upstream.paths.some((p) => p === `/api/v1/users/${UID}/balance`));
    assert.ok(!upstream.paths.some((p) => p.includes("/users/me/balance")));
  } finally {
    await upstream.close();
  }
});

test("a rejected balance lookup degrades to a null balance, keeping the rest", async () => {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (url.pathname === "/api/v1/users/me") {
      return send(200, { success: true, data: { id: UID } });
    }
    if (url.pathname.endsWith("/balance")) {
      return send(403, { error: "forbidden" });
    }
    return send(200, { success: true, data: { items: [], nextToken: null } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const config = configFor(`http://127.0.0.1:${port}`);
  try {
    const credits = await fetchAccountCredits(config, "Bearer workos:x", logger);
    assert.equal(credits.uid, UID);
    assert.equal(credits.balanceMicroUsd, null);
    assert.equal(credits.balanceUsd, null);
    assert.equal(credits.balanceCredits, null);
    assert.equal(credits.window.requests, 0);
    assert.equal(credits.error, null);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("a failed user lookup reports an error instead of an empty row", async () => {
  const server = http.createServer((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  const config = configFor(`http://127.0.0.1:${port}`);
  try {
    const credits = await fetchAccountCredits(config, "Bearer workos:dead", logger);
    assert.equal(credits.uid, null);
    assert.equal(credits.balanceMicroUsd, null);
    assert.equal(credits.error, "user lookup failed");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("micro-USD converts to USD and credits at the documented rates", () => {
  assert.equal(MICRO_USD, 1_000_000);
  // -19229 micro-USD is the real negative balance used to verify the unit:
  // upstream's own 402 body reports the same account as $-0.02.
  assert.equal(-19229 / MICRO_USD, -0.019229);
});
