/**
 * Integration tests against a mock Cline upstream. These exercise the real
 * gateway wiring — account store, token manager, header construction, SSE
 * pass-through, silent 401 refresh and Anthropic translation — without
 * needing live credentials.
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

interface Recorded {
  url: string;
  method: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface MockUpstream {
  url: string;
  requests: Recorded[];
  close: () => Promise<void>;
  setChatHandler: (handler: (req: Recorded, res: http.ServerResponse) => void) => void;
  setRefreshHandler: (handler: (req: Recorded, res: http.ServerResponse) => void) => void;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const requests: Recorded[] = [];
  let chatHandler: (req: Recorded, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-1", choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  };
  let refreshHandler: (req: Recorded, res: http.ServerResponse) => void = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: {
          accessToken: "rotated-access",
          refreshToken: "rotated-refresh",
          tokenType: "Bearer",
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          userInfo: { email: "mock@example.com", clineUserId: "cu_mock" },
        },
      }),
    );
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const recorded: Recorded = {
        url: req.url ?? "",
        method: req.method ?? "",
        headers: req.headers,
        body,
      };
      requests.push(recorded);
      const url = recorded.url;

      if (url === "/api/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            object: "list",
            data: [
              { id: "mock/model-1", object: "model", owned_by: "mock" },
              { id: "mock/model-2", object: "model", owned_by: "mock" },
            ],
          }),
        );
        return;
      }
      if (url === "/api/v1/ai/cline/recommended-models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            recommended: [{ id: "mock/recommended-1" }],
            free: [{ id: "mock/model-1" }, { id: "mock/free-1" }],
            clinePass: [{ id: "cline-pass/mock-kimi" }],
          }),
        );
        return;
      }
      if (url === "/api/v1/users/me/plan") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              plan: {
                displayName: "Mock Pass",
                interval: "Monthly",
                isActive: true,
                entitlements: { cline_pass: { enabled: true } },
              },
              currentPeriodStart: "2026-09-01T00:00:00Z",
              currentPeriodEnd: "2026-10-01T00:00:00Z",
            },
          }),
        );
        return;
      }
      if (url === "/api/v1/users/me/plan/usage-limits") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            success: true,
            data: {
              limits: [
                { type: "five_hour", percentUsed: 12, resetsAt: "2026-09-17T14:00:00Z" },
                { type: "weekly", percentUsed: 34, resetsAt: "2026-09-23T18:00:00Z" },
                { type: "monthly", percentUsed: 56, resetsAt: "2026-10-16T18:00:00Z" },
              ],
            },
          }),
        );
        return;
      }
      if (url === "/api/v1/auth/refresh") {
        refreshHandler(recorded, res);
        return;
      }
      if (url === "/api/v1/chat/completions") {
        chatHandler(recorded, res);
        return;
      }
      res.writeHead(404, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    setChatHandler: (handler) => {
      chatHandler = handler;
    },
    setRefreshHandler: (handler) => {
      refreshHandler = handler;
    },
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}

function accountRecord(
  id: string,
  access: string,
  refresh: string,
  expires: number,
): Record<string, unknown> {
  return {
    id,
    label: null,
    email: "mock@example.com",
    accountId: "cu_mock",
    access,
    refresh,
    expires,
    tokenType: "Bearer",
    provider: "cline",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    disabled: false,
    lastError: null,
  };
}

/** Write several accounts at once, for pool fail-over tests. */
function seedAccounts(dataDir: string, accounts: Array<Record<string, unknown>>): void {
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({ version: 1, accounts }),
    "utf8",
  );
}

function seedAccount(
  dataDir: string,
  refresh = "seed-refresh",
  expires = Date.now() + 3_600_000,
  identity: { email: string | null; accountId: string | null } = {
    email: "mock@example.com",
    accountId: "cu_mock",
  },
): void {
  fs.mkdirSync(dataDir, { recursive: true });
  const account = {
    id: "acct-1",
    label: null,
    email: "mock@example.com",
    accountId: "cu_mock",
    access: "seed-access",
    refresh,
    expires,
    tokenType: "Bearer",
    provider: "cline",
    createdAt: Date.now(),
    updatedAt: Date.now(),
    disabled: false,
    lastError: null,
  };
  fs.writeFileSync(path.join(dataDir, "accounts.json"), JSON.stringify({ version: 1, accounts: [account] }), "utf8");
}

async function withGateway(
  upstream: MockUpstream,
  run: (ctx: { app: ReturnType<typeof createApp>; dataDir: string }) => Promise<void>,
  options: {
    seed?: boolean;
    refresh?: string;
    expires?: number;
    identity?: { email: string | null; accountId: string | null };
  } = {},
): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  if (options.seed !== false) {
    if (options.identity) seedAccount(dataDir, options.refresh, options.expires, options.identity);
    else seedAccount(dataDir, options.refresh, options.expires);
  }
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const ctx = createApp(config);
  try {
    await run(ctx);
  } finally {
    await upstream.close();
  }
}

const authHeaders = { Authorization: "Bearer test-key", "Content-Type": "application/json" };

test("streaming chat is passed through byte-for-byte with official headers", async () => {
  const upstream = await startMockUpstream();
  const sse =
    'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
    "data: [DONE]\n\n";
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(sse);
  });

  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "mock/model-1",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    assert.equal(await response.text(), sse);

    const upstreamCall = upstream.requests.find((r) => r.url === "/api/v1/chat/completions");
    assert.ok(upstreamCall, "upstream should have been called");
    assert.equal(upstreamCall.headers.authorization, "Bearer workos:seed-access");
    assert.equal(upstreamCall.headers["x-client-version"], "3.0.62");
    assert.equal(upstreamCall.headers["x-client-type"], "cline-sdk");
    assert.equal(upstreamCall.headers["x-core-version"], "0.0.83");
    assert.equal(upstreamCall.headers["http-referer"], "https://cline.bot");
    assert.ok(typeof upstreamCall.headers["x-task-id"] === "string");

    const sent = JSON.parse(upstreamCall.body);
    assert.equal(sent.stream, true);
    assert.equal(sent.stream_options.include_usage, true);
    assert.equal(sent.model, "mock/model-1");
  });
});

test("non-streaming responses are unwrapped from a success/data envelope", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        success: true,
        data: { id: "chatcmpl-9", choices: [{ message: { content: "wrapped" }, finish_reason: "stop" }] },
      }),
    );
  });
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as Record<string, unknown>;
    assert.equal(json.success, undefined);
    assert.equal((json.choices as Array<{ message: { content: string } }>)[0]?.message.content, "wrapped");
  });
});

test("a 401 from upstream triggers a silent refresh and one retry", async () => {
  const upstream = await startMockUpstream();
  let chatCalls = 0;
  upstream.setChatHandler((_req, res) => {
    chatCalls += 1;
    if (chatCalls === 1) {
      res.writeHead(401, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized: Please make sure you're using the latest version of Cline" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "chatcmpl-2", choices: [{ message: { content: "after refresh" }, finish_reason: "stop" }] }));
  });

  await withGateway(upstream, async ({ app, store }) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "after refresh");

    const chatHeaders = upstream.requests
      .filter((r) => r.url === "/api/v1/chat/completions")
      .map((r) => r.headers.authorization);
    assert.deepEqual(chatHeaders, ["Bearer workos:seed-access", "Bearer workos:rotated-access"]);

    const refreshCall = upstream.requests.find((r) => r.url === "/api/v1/auth/refresh");
    assert.ok(refreshCall, "refresh endpoint should have been called");
    assert.deepEqual(JSON.parse(refreshCall.body), {
      refreshToken: "seed-refresh",
      grantType: "refresh_token",
    });

    // Rotated refresh token must be persisted immediately.
    assert.equal(store.get("acct-1")?.refresh, "rotated-refresh");
    assert.equal(store.get("acct-1")?.access, "rotated-access");
  });
});

test("a rejected refresh token disables the account instead of throwing", async () => {
  const upstream = await startMockUpstream();
  upstream.setRefreshHandler((_req, res) => {
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ message: "The refresh token is invalid or expired", code: "invalid_grant" }));
  });
  await withGateway(
    upstream,
    async ({ app, store }) => {
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 502);

      const refreshCall = upstream.requests.find((r) => r.url === "/api/v1/auth/refresh");
      assert.ok(refreshCall, "an expired token must trigger a refresh attempt");
      // The dead account must be parked rather than retried forever.
      assert.equal(store.get("acct-1")?.disabled, true);
      assert.match(store.get("acct-1")?.lastError ?? "", /invalid_grant|re-login/i);
      // No chat request may be attempted with a credential we know is dead.
      assert.equal(upstream.requests.filter((r) => r.url === "/api/v1/chat/completions").length, 0);
    },
    { seed: true, refresh: "dead-refresh", expires: Date.now() - 1000 },
  );
});

test("/v1/messages translates an Anthropic request and streams Anthropic events", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"Hey"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":1}}\n\n' +
        "data: [DONE]\n\n",
    );
  });

  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/messages", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        max_tokens: 64,
        system: "be brief",
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);
    const text = await response.text();
    assert.match(text, /event: message_start/);
    assert.match(text, /event: content_block_delta/);
    assert.match(text, /"text_delta","text":"Hey"/);
    assert.match(text, /event: message_stop/);

    // The Anthropic request must have become an OpenAI request upstream.
    const call = upstream.requests.find((r) => r.url === "/api/v1/chat/completions");
    assert.ok(call);
    const sent = JSON.parse(call.body);
    assert.equal(sent.model, "anthropic/claude-sonnet-4.6");
    assert.deepEqual(sent.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
    assert.equal(sent.stream, true);
  });
});

test("/v1/models serves the live upstream catalog plus the recommended buckets", async () => {
  const upstream = await startMockUpstream();
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/models", { headers: authHeaders });
    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      data: Array<Record<string, unknown>>;
    };
    // Provider catalog first, then the ids only recommended-models knows about
    // (subscription bucket before free bucket), de-duplicated by id.
    assert.deepEqual(
      json.data.map((m) => m.id),
      ["mock/model-1", "mock/model-2", "cline-pass/mock-kimi", "mock/free-1"],
    );
    // Entries merged in from the second catalog keep a provider owner when they
    // have one, and fall back to the bucket name otherwise.
    assert.equal(json.data[0]?.owned_by, "mock");
    assert.equal(json.data[2]?.owned_by, "cline-pass");
    assert.equal(json.data[3]?.owned_by, "cline-free");
    // The billing bucket is internal — /v1/models stays pure OpenAI shape.
    for (const entry of json.data) assert.ok(!("bucket" in entry));
  });
});

test("an Anthropic-native client authenticates with x-api-key", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  await withGateway(upstream, async ({ app }) => {
    const accepted = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "test-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock/model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(accepted.status, 200);

    const rejected = await app.request("/v1/messages", {
      method: "POST",
      headers: { "x-api-key": "wrong-key", "Content-Type": "application/json" },
      body: JSON.stringify({ model: "mock/model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(rejected.status, 401);
  });
});

test("requests without a valid gateway key are rejected before reaching upstream", async () => {
  const upstream = await startMockUpstream();
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "m", messages: [] }),
    });
    assert.equal(response.status, 401);
    assert.equal(upstream.requests.length, 0);
  });
});



test("a rotated token for an account without id/email updates in place instead of duplicating", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  await withGateway(
    upstream,
    async ({ app, store }) => {
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
      });
      assert.equal(response.status, 200);
      // Refresh must have happened (the seeded token was already expired)...
      assert.ok(upstream.requests.some((r) => r.url === "/api/v1/auth/refresh"));
      // ...and must still leave exactly one account behind.
      assert.equal(store.count(), 1);
      assert.equal(store.get("acct-1")?.refresh, "rotated-refresh");
    },
    {
      seed: true,
      refresh: "seed-refresh",
      expires: Date.now() - 1000,
      identity: { email: null, accountId: null },
    },
  );
});

test("/admin/api/models groups the catalog into billing buckets", async () => {
  const upstream = await startMockUpstream();
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/admin/api/models", { headers: authHeaders });
    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      models: Array<{ id: string; bucket: string }>;
      counts: { total: number; pass: number; free: number; credits: number };
    };
    const byId = new Map(json.models.map((m) => [m.id, m.bucket]));
    assert.equal(byId.get("cline-pass/mock-kimi"), "pass");
    assert.equal(byId.get("mock/free-1"), "free");
    // The bucket comes from whichever catalog declared it: model-1 is in the
    // provider catalog *and* the free bucket, and the free bucket wins.
    assert.equal(byId.get("mock/model-1"), "free");
    assert.equal(byId.get("mock/model-2"), "credits");
    assert.deepEqual(json.counts, { total: 4, pass: 1, free: 2, credits: 1 });
  });
});

test("/admin/api/chat answers through the playground path", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "playground ok" }, finish_reason: "stop" }] }));
  });
  await withGateway(upstream, async ({ app }) => {
    // No client key: the playground authenticates with the admin token.
    const response = await app.request("/admin/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "cline-pass/mock-kimi", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "playground ok");
  });
});

test("the request log records outcomes and keeps only the newest entries", async () => {
  const upstream = await startMockUpstream();
  await withGateway(upstream, async ({ app }) => {
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
    });
    upstream.setChatHandler((_req, res) => {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "upstream exploded" }));
    });
    await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
    });

    const response = await app.request("/admin/api/requests", { headers: authHeaders });
    const json = (await response.json()) as {
      entries: Array<{ status: number; error: string | null; model: string }>;
      stats: { total: number; ok: number; failed: number };
    };
    assert.equal(json.stats.total, 2);
    assert.equal(json.stats.ok, 1);
    assert.equal(json.stats.failed, 1);
    // Newest first.
    assert.equal(json.entries[0]?.status, 500);
    assert.match(json.entries[0]?.error ?? "", /upstream exploded/);
    assert.equal(json.entries[1]?.status, 200);
  });
});

test("an account that cannot pay for the model fails over to one that can", async () => {
  const upstream = await startMockUpstream();
  // acct-1 is the Pass-only account: credit-billed models are refused for it.
  upstream.setChatHandler((req, res) => {
    if (String(req.headers.authorization).includes("seed-access")) {
      res.writeHead(402, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "insufficient_credits", message: "Insufficient balance. Your Cline Credits balance is $-0.02" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "paid by acct-2" }, finish_reason: "stop" }] }));
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  const expires = Date.now() + 3_600_000;
  seedAccounts(dataDir, [
    accountRecord("acct-1", "seed-access", "seed-refresh", expires),
    accountRecord("acct-2", "second-access", "second-refresh", expires),
  ]);
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app } = createApp(config);

  try {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "anthropic/claude-sonnet-4.6",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200, "should have failed over instead of returning the 402");
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "paid by acct-2");
    assert.equal(upstream.requests.length, 2, "both accounts should have been tried");
  } finally {
    await upstream.close();
  }
});

test("/admin/api/usage reports every account's plan and usage windows", async () => {
  const upstream = await startMockUpstream();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  const expires = Date.now() + 3_600_000;
  seedAccounts(dataDir, [
    accountRecord("acct-1", "seed-access", "seed-refresh", expires),
    accountRecord("acct-2", "second-access", "second-refresh", expires),
  ]);
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app } = createApp(config);
  try {
    const response = await app.request("/admin/api/usage", { headers: authHeaders });
    assert.equal(response.status, 200);
    const json = (await response.json()) as {
      accounts: Array<{ id: string; limits: Array<{ type: string; percentUsed: number }> }>;
    };
    // One row per account — the whole point: a pool's accounts do not share quota.
    assert.equal(json.accounts.length, 2);
    for (const row of json.accounts) {
      assert.deepEqual(
        row.limits.map((l) => l.type),
        ["five_hour", "weekly", "monthly"],
      );
    }
  } finally {
    await upstream.close();
  }
});

test("empty message content is filled before reaching upstream", async () => {
  const upstream = await startMockUpstream();
  let seenBody: string | null = null;
  upstream.setChatHandler((req, res) => {
    seenBody = req.body;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  await withGateway(upstream, async ({ app }) => {
    // A tool-result message with empty content, plus an empty user turn:
    // exactly what tool harnesses send and what upstream 400s on.
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "mock/model-1",
        messages: [
          { role: "user", content: "hi" },
          {
            role: "assistant",
            content: "",
            tool_calls: [{ id: "call_1", type: "function", function: { name: "x", arguments: "{}" } }],
          },
          { role: "tool", tool_call_id: "call_1", content: "" },
          { role: "user", content: "" },
        ],
      }),
    });
    assert.equal(response.status, 200);
    assert.ok(seenBody, "upstream should have been called");
    const sent = JSON.parse(seenBody as string);
    const contents = sent.messages.map((m: { content: unknown }) => m.content);
    assert.deepEqual(contents, ["hi", null, "(tool returned no text output)", "(empty content)"]);
  });
});

test("a per-account daily quota error fails over to another account", async () => {
  const upstream = await startMockUpstream();
  // acct-1 has spent its daily free quota; acct-2 still has some.
  upstream.setChatHandler((req, res) => {
    if (String(req.headers.authorization).includes("seed-access")) {
      res.writeHead(429, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "INFERENCE_CAP_ERROR", message: "Error 429: Daily free limit reached on model x. Try again in 21h" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "served by acct-2" }, finish_reason: "stop" }] }));
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  const expires = Date.now() + 3_600_000;
  seedAccounts(dataDir, [
    accountRecord("acct-1", "seed-access", "seed-refresh", expires),
    accountRecord("acct-2", "second-access", "second-refresh", expires),
  ]);
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app } = createApp(config);
  try {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "cline-free/muse-spark-1.3-contributor",
        messages: [{ role: "user", content: "hi" }],
      }),
    });
    assert.equal(response.status, 200, "the daily-limit 429 must not be surfaced verbatim");
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "served by acct-2");
    assert.equal(upstream.requests.length, 2, "both accounts should have been tried");
  } finally {
    await upstream.close();
  }
});

test("unanswered parallel tool calls get replies and answers are pulled adjacent", async () => {
  const upstream = await startMockUpstream();
  let seen: Array<Record<string, unknown>> = [];
  upstream.setChatHandler((req, res) => {
    seen = (JSON.parse(req.body) as { messages: Array<Record<string, unknown>> }).messages;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "mock/model-1",
        messages: [
          { role: "user", content: "go" },
          {
            role: "assistant",
            content: null,
            tool_calls: [
              { id: "call_a", type: "function", function: { name: "a", arguments: "{}" } },
              { id: "call_b", type: "function", function: { name: "b", arguments: "{}" } },
            ],
          },
          // The client only answered call_a, and drifted it behind a user turn.
          { role: "user", content: "meanwhile" },
          { role: "tool", tool_call_id: "call_a", content: "result a" },
        ],
      }),
    });
    assert.equal(response.status, 200);

    const shape = seen.map((m) =>
      m.role === "tool" ? `tool:${m.tool_call_id}` : `${m.role}${m.tool_calls ? "+calls" : ""}`,
    );
    // Both calls answered, contiguously, right after the assistant turn.
    assert.deepEqual(shape, ["user", "assistant+calls", "tool:call_a", "tool:call_b", "user"]);
    assert.equal(seen[3]?.content, "(no tool output returned)");
    assert.equal(seen[2]?.content, "result a");
  });
});
