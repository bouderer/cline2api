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
        res.end(JSON.stringify({ object: "list", data: [{ id: "mock/model-1", object: "model", owned_by: "mock" }] }));
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

test("/v1/models serves the live upstream catalog", async () => {
  const upstream = await startMockUpstream();
  await withGateway(upstream, async ({ app }) => {
    const response = await app.request("/v1/models", { headers: authHeaders });
    assert.equal(response.status, 200);
    const json = (await response.json()) as { data: Array<{ id: string }> };
    assert.deepEqual(json.data.map((m) => m.id), ["mock/model-1"]);
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
