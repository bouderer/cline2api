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
import { createLogger } from "../src/logger.js";
import { AccountStore } from "../src/store.js";
import { createApp } from "../src/index.js";
import { ProxyResolver } from "../src/cline/proxy.js";
import { ProxyStore } from "../src/services/proxyStore.js";

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
    /** Extra env, for tests that need a short streaming timeout. */
    env?: Record<string, string>;
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
    ...(options.env ?? {}),
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

test("an upstream that dies mid-stream is reported instead of silently truncating", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(
      'data: {"id":"1","object":"chat.completion.chunk","choices":[{"index":0,"delta":{"content":"half"},"finish_reason":null}]}\n\n',
    );
    // No finish_reason, no [DONE]: the connection just ends. A client reading
    // this as a normal close is how a truncated answer gets mistaken for a
    // complete one.
    setTimeout(() => res.destroy(), 20);
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
    const text = await response.text();
    // The bytes upstream managed to send are preserved...
    assert.match(text, /"content":"half"/);
    // ...and the missing terminal marker is reported in its place.
    assert.match(text, /upstream_stream_incomplete/);
    assert.doesNotMatch(text, /\[DONE\]/);
  });
});

test("a silent upstream stream is failed on the idle timeout", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(": ping\n\n");
    // Then nothing at all, forever.
  });

  await withGateway(
    upstream,
    async ({ app }) => {
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: authHeaders,
        body: JSON.stringify({
          model: "mock/model-1",
          stream: true,
          messages: [{ role: "user", content: "hi" }],
        }),
      });
      const text = await response.text();
      assert.match(text, /upstream_timeout/);
    },
    { env: { STREAM_IDLE_TIMEOUT_MS: "150" } },
  );
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
    // (subscription bucket before free bucket), then the ids we pin to the free
    // bucket ourselves, de-duplicated by id.
    assert.deepEqual(
      json.data.map((m) => m.id),
      ["mock/model-1", "mock/model-2", "cline-pass/mock-kimi", "mock/free-1", "cline-free/kimi-k3"],
    );
    // Entries merged in from the second catalog keep a provider owner when they
    // have one, and fall back to the bucket name otherwise.
    assert.equal(json.data[0]?.owned_by, "mock");
    assert.equal(json.data[2]?.owned_by, "cline-pass");
    assert.equal(json.data[3]?.owned_by, "cline-free");
    assert.equal(json.data[4]?.owned_by, "cline-free");
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
    // Not in the mock's free bucket, but the ledger bills it as free, so it is
    // pinned to the free bucket explicitly.
    assert.equal(byId.get("cline-free/kimi-k3"), "free");
    assert.deepEqual(json.counts, { total: 5, pass: 1, free: 3, credits: 1 });
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
    // The resolver pre-probes the pool on startup, so the raw request count
    // includes those round-trips. Only the chat-completions traffic belongs to
    // the failover story this test is telling.
    const chatCalls = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chatCalls.length, 2, "both accounts should have been tried");
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
    // The resolver pre-probes the pool on startup, so the raw request count
    // includes those round-trips. Only the chat-completions traffic belongs to
    // the failover story this test is telling.
    const chatCalls = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chatCalls.length, 2, "both accounts should have been tried");
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

/**
 * Bounds on how far one request may walk the pool.
 *
 * Failover is for the occasional dead account, not for a plan most of the pool
 * lacks. Uncapped, a request for a model only a couple of accounts can serve
 * turns into a pool-sized burst at the edge — which is what earns a 429 from
 * Cloudflare, and what makes the next request fail the same way.
 */

test("an entitlement 403 fails over without a token refresh or a retry", async () => {
  const upstream = await startMockUpstream();
  // acct-1's plan does not cover the model. This arrives as a 403, the same
  // status a revoked credential uses — so the two must be told apart by body.
  upstream.setChatHandler((req, res) => {
    if (String(req.headers.authorization).includes("seed-access")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "ENTITLEMENT_ERROR", message: "Error 403: the user is not subscribed to required model plan" },
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
      body: JSON.stringify({ model: "cline-pass/ent-test", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "served by acct-2");

    // Exactly one chat call each, and no refresh: the old code treated the 403
    // as a credential failure, so it rotated the token and asked acct-1 again
    // before moving on — two extra upstream calls per unentitled account.
    const chats = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chats.length, 2, `expected one call per account, got ${chats.length}`);
    assert.equal(
      upstream.requests.filter((r) => r.url === "/api/v1/auth/refresh").length,
      0,
      "an entitlement failure is not a credential failure; it must not refresh",
    );
  } finally {
    await upstream.close();
  }
});

test("a known-unentitled account is skipped on later requests", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((req, res) => {
    if (String(req.headers.authorization).includes("seed-access")) {
      res.writeHead(403, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "ENTITLEMENT_ERROR", message: "Error 403: the user is not subscribed to required model plan" },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  const expires = Date.now() + 3_600_000;
  seedAccounts(dataDir, [
    accountRecord("skip-1", "seed-access", "seed-refresh", expires),
    accountRecord("skip-2", "second-access", "second-refresh", expires),
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

  // Its own model name: the entitlement map is module-level and outlives a
  // test, so sharing a model with another test would inherit its verdict.
  const send = () =>
    app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "cline-pass/skip-test", messages: [{ role: "user", content: "hi" }] }),
    });

  try {
    assert.equal((await send()).status, 200);
    const afterFirst = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions").length;
    assert.equal(afterFirst, 2);

    // The second request must not re-ask the account already known to lack the
    // plan: an entitlement does not change by waiting, so the call cannot
    // succeed and only adds traffic.
    assert.equal((await send()).status, 200);
    const chats = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chats.length, 3, `expected acct-1 to be skipped, got ${chats.length} calls`);
  } finally {
    await upstream.close();
  }
});

test("a provider-wide 429 stops the walk instead of failing over the whole pool", async () => {
  const upstream = await startMockUpstream();
  // Cloudflare's shape: an HTML 429 with no error code in it. Nothing here says
  // which account is at fault, because none is — the edge is refusing.
  upstream.setChatHandler((_req, res) => {
    res.writeHead(429, { "content-type": "text/html; charset=UTF-8" });
    res.end('<!doctype html><meta charset="utf-8"><title>429</title>429 Too Many Requests');
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  const expires = Date.now() + 3_600_000;
  seedAccounts(
    dataDir,
    Array.from({ length: 6 }, (_, i) =>
      accountRecord(`acct-${i + 1}`, `access-${i + 1}`, `refresh-${i + 1}`, expires),
    ),
  );
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
      body: JSON.stringify({ model: "mock/model-1", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 429);
    // One attempt, not six: walking the pool would multiply the traffic that
    // caused the refusal and turn a burst into a ban.
    const chats = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chats.length, 1, `expected the walk to stop, got ${chats.length} calls`);
  } finally {
    await upstream.close();
  }
});

test("a Pass model is routed at the accounts that hold Pass, not the pool in order", async () => {
  // The shape this exists for: a large pool where only a couple of accounts
  // hold Cline Pass. Round-robin would offer the request to account after
  // account that cannot serve it, and the failover walk would never reach the
  // ones that can — so the model would be effectively unusable however long the
  // walk was allowed to run.
  const upstream = await startMockUpstream();
  upstream.setChatHandler((req, res) => {
    if (String(req.headers.authorization).includes("pass-access")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { content: "served by the Pass account" }, finish_reason: "stop" }] }));
      return;
    }
    res.writeHead(403, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        error: { code: "ENTITLEMENT_ERROR", message: "Error 403: the user is not subscribed to required model plan" },
      }),
    );
  });

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-proxy-"));
  const expires = Date.now() + 3_600_000;
  // The Pass holder is last, so plain pool order would reach it only after
  // every other account had been tried and refused.
  const accounts = [
    ...Array.from({ length: 20 }, (_, i) =>
      accountRecord(`free-${i + 1}`, `free-access-${i + 1}`, `free-refresh-${i + 1}`, expires),
    ),
    accountRecord("pass-holder", "pass-access", "pass-refresh", expires),
  ];
  seedAccounts(dataDir, accounts);
  const config = loadConfig({
    DATA_DIR: dataDir,
    PROXY_API_KEY: "test-key",
    CLINE_API_BASE_URL: upstream.url,
    WORKOS_API_BASE_URL: upstream.url,
    LOG_LEVEL: "error",
    REQUEST_TIMEOUT_MS: "5000",
  });
  const { app, capabilities } = createApp(config);

  try {
    // Seed the index as a completed sweep would: exactly one account holds Pass.
    capabilities.record("pass-holder", true);
    for (const account of accounts.slice(0, 20)) capabilities.record(account.id, false);

    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "cline-pass/routed", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200, "the Pass account must have been reached");
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "served by the Pass account");

    // One call, straight at the holder: not 21 attempts to rediscover what the
    // index already knew.
    const chats = upstream.requests.filter((r) => r.url === "/api/v1/chat/completions");
    assert.equal(chats.length, 1, `expected a single call, got ${chats.length}`);
  } finally {
    await upstream.close();
  }
});

test("a cold capability index does not shortlist an empty Pass list", async () => {
  // The trap: an index that has read nothing reports zero Pass holders, which
  // means "not asked yet" rather than "nobody has it". Shortlisting on that
  // would turn a working request into a 503, so routing stays on the pool order
  // until the index actually knows something.
  const upstream = await startMockUpstream();
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "cline-pass/cold", messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200, "a cold index must not block the request");
    assert.ok(upstream.requests.some((r) => r.url === "/api/v1/chat/completions"));
  });
});

// --- Failover tiers -------------------------------------------------------

test("priority tiers: only the lowest tier serves until it cools off", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-tiers-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  // Tiers only govern the shared pool, so the pool must be the strategy under
  // test: pinned mode ignores it and follows each account's own binding.
  proxies.setMode("sticky");
  const hot = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const warm = proxies.add({ url: "http://u:p@10.0.0.2:8080", priority: 1 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  // Tier 0 is the only candidate while it is healthy.
  assert.deepEqual(
    resolver.forRequest("acct").proxyId,
    hot.id,
    "tier 0 should serve while healthy",
  );

  // Cool tier 0; tier 1 must take over.
  resolver.reportRateLimited(hot.id);
  assert.equal(
    resolver.forRequest("acct").proxyId,
    warm.id,
    "tier 1 should absorb traffic once every tier-0 proxy is cooling",
  );

  // A proxy with no explicit priority still lands in tier 0, so pools written
  // before tiers existed behave exactly as they used to.
  const legacy = proxies.add({ url: "http://u:p@10.0.0.3:8080" });
  assert.equal(legacy.priority, 0);
});

test("priority tiers: a higher tier that is itself cooling is never selected", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-tiers-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  proxies.setMode("sticky");
  const hot = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const spare = proxies.add({ url: "http://u:p@10.0.0.9:8080", priority: 1 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  resolver.reportRateLimited(hot.id);
  assert.equal(resolver.forRequest("acct").proxyId, spare.id);

  // Everything in the pool is spent: the resolver falls back to returning a
  // candidate rather than nothing, so the request still has one more attempt
  // before the account-level failover budget gives up.
  resolver.reportRateLimited(spare.id);
  const fallback = resolver.forRequest("acct");
  assert.ok(fallback, "an all-cooling pool must still offer a route");
});

test("transport failure parks the exit until a clean probe brings it back", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-unhealthy-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  proxies.setMode("rotate");
  const dead = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const alive = proxies.add({ url: "http://u:p@10.0.0.2:8080", priority: 0 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  // Before any failure both exits are in the pool.
  const first = resolver.forRequest("acct");
  assert.ok(first, "pool must offer a route");

  // One transport failure parks it; the next request must not draw it.
  resolver.reportTransportFailure(dead.id, "fetch failed");
  assert.equal(
    resolver.forRequest("acct").proxyId,
    alive.id,
    "a parked exit must not be offered again",
  );

  // It stays parked across repeated draws.
  for (let i = 0; i < 5; i++) {
    assert.equal(resolver.forRequest("acct").proxyId, alive.id);
  }

  // A clean probe is the only way back.
  resolver.markHealthy(dead.id);
  const back = resolver.forRequest("acct");
  assert.ok(back, "a healed proxy must return to the pool");
});

test("pre-probe marks a dead failover proxy before it is needed", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-preprobe-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  proxies.setMode("rotate");
  // Tier 0 is healthy; tier 1 is a dead proxy that would only be discovered
  // the hard way when a burst downgrades and burns one request finding out.
  const hot = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const dead = proxies.add({ url: "http://u:p@10.0.0.99:9999", priority: 1 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  // While tier 0 serves, the resolver pre-probes tier 1 in the background.
  resolver.forRequest("acct");
  // Wait for the background probe to finish rather than guessing a timeout:
  // probing a dead TCP endpoint takes however long the OS takes to refuse it,
  // and a fixed sleep would flake on a loaded box.
  return new Promise<void>((resolve, reject) => {
    const deadline = Date.now() + 15_000;
    const tick = () => {
      try {
        const probing = (resolver as never as { probing: Map<string, Promise<void>> }).probing;
        if (probing.size === 0) {
          const parked = (resolver as never as { unhealthy: Map<string, number> }).unhealthy;
          assert.ok(parked.has(dead.id), "dead tier-1 proxy should be parked by pre-probe");
          resolve();
        } else if (Date.now() > deadline) {
          reject(new Error("probe did not finish in 15s"));
        } else {
          setTimeout(tick, 100);
        }
      } catch (e) { reject(e); }
    };
    tick();
  });
});

test("sticky failover releases back to the cheaper tier once it recovers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-sticky-release-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  proxies.setMode("sticky");
  const hot = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const metered = proxies.add({ url: "http://u:p@10.0.0.9:8080", priority: 1 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  // Tier 0 cools off; sticky falls to the metered tier.
  resolver.reportRateLimited(hot.id);
  assert.equal(
    resolver.forRequest("acct").proxyId,
    metered.id,
    "tier 1 absorbs traffic while every tier-0 proxy cools",
  );

  // The tier-0 cooldown expires. The very next request must fall back to
  // tier 0 instead of holding the metered exit — holding it is what turns a
  // one-minute blip into a day of paid residential traffic.
  const cooling = (resolver as never as { cooling: Map<string, number> }).cooling;
  cooling.set(hot.id, Date.now() - 1);
  assert.equal(
    resolver.forRequest("acct").proxyId,
    hot.id,
    "sticky must release the failover tier once a cheaper tier is ready",
  );

  // And it stays there: subsequent requests keep drawing tier 0.
  for (let i = 0; i < 5; i++) {
    assert.equal(resolver.forRequest("acct").proxyId, hot.id);
  }
});

test("sticky hold survives while no cheaper tier is usable", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-sticky-hold-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  proxies.setMode("sticky");
  const dead = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const metered = proxies.add({ url: "http://u:p@10.0.0.9:8080", priority: 1 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  // Park the only tier-0 proxy (transport failure = out until probed clean).
  resolver.reportTransportFailure(dead.id, "fetch failed");
  assert.equal(resolver.forRequest("acct").proxyId, metered.id);

  // With tier 0 still parked, the sticky hold on the metered proxy must
  // persist — releasing it would only churn exits without anything cheaper
  // to move to.
  for (let i = 0; i < 5; i++) {
    assert.equal(
      resolver.forRequest("acct").proxyId,
      metered.id,
      "the hold must survive while no cheaper tier is usable",
    );
  }

  // Once the operator probes tier 0 clean, the next request releases.
  resolver.markHealthy(dead.id);
  assert.equal(resolver.forRequest("acct").proxyId, dead.id);
});

test("direct-first: direct egress resumes the moment its cooldown expires", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-direct-first-"));
  const logger = createLogger("error");
  const proxies = new ProxyStore(dir, logger);
  const store = new AccountStore(dir, logger);
  proxies.setMode("sticky");
  const hot = proxies.add({ url: "http://u:p@10.0.0.1:8080", priority: 0 });
  const resolver = new ProxyResolver({ proxies, store, logger });

  // Fresh resolver, direct not cooling: the route is direct (undefined).
  assert.equal(
    resolver.initialRoute("acct"),
    undefined,
    "with a clean direct address, requests must not touch any proxy",
  );

  // Direct gets refused: it cools, and routes fall to the proxy tier.
  resolver.reportRateLimited(null);
  const routed = resolver.initialRoute("acct");
  assert.ok(routed, "while direct cools, a proxy must carry the request");
  assert.equal(routed!.proxyId, hot.id);

  // Direct recovers (cooldown expires): the very next request is direct
  // again — it must not keep riding the proxy just because sticky holds one.
  const coolingUntil = (resolver as never as { directCoolingUntil: number });
  coolingUntil.directCoolingUntil = Date.now() - 1;
  assert.equal(
    resolver.initialRoute("acct"),
    undefined,
    "direct egress must resume immediately once its cooldown expires",
  );
});
