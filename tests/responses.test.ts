/**
 * Responses API surface: request translation, response translation, the SSE
 * translator, and the two behaviours that only exist on this path — the
 * tool-call round trip and the empty-content budget escalation.
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
import {
  openAIToResponses,
  responsesToOpenAI,
  translateStreamToResponses,
} from "../src/api/responses.js";
import { withRaisedTokenBudget } from "../src/services/proxyChat.js";

const authHeaders = { Authorization: "Bearer test-key", "Content-Type": "application/json" };

/* ------------------------------------------------------------- unit: request */

test("responses requests translate into chat completions", () => {
  const chat = responsesToOpenAI({
    model: "m",
    instructions: "be brief",
    max_output_tokens: 256,
    temperature: 0.5,
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "hello" }] },
      { type: "function_call", call_id: "call_1", name: "read", arguments: '{"path":"a"}' },
      { type: "function_call_output", call_id: "call_1", output: "file contents" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ],
    tools: [
      { type: "function", name: "read", description: "read a file", parameters: { type: "object", properties: {} } },
    ],
    tool_choice: { type: "function", name: "read" },
  });

  assert.equal(chat.model, "m");
  assert.equal(chat.max_tokens, 256);
  assert.equal(chat.temperature, 0.5);
  assert.deepEqual(chat.messages, [
    { role: "system", content: "be brief" },
    { role: "user", content: "hello" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read", arguments: '{"path":"a"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "file contents" },
    { role: "assistant", content: "done" },
  ]);
  assert.deepEqual(chat.tools, [
    { type: "function", function: { name: "read", description: "read a file", parameters: { type: "object", properties: {} } } },
  ]);
  assert.deepEqual(chat.tool_choice, { type: "function", function: { name: "read" } });
});

test("a plain string input becomes a single user message", () => {
  const chat = responsesToOpenAI({ model: "m", input: "hi" });
  assert.deepEqual(chat.messages, [{ role: "user", content: "hi" }]);
  assert.equal("max_tokens" in chat, false);
});

test("reasoning items echoed back are dropped, not forwarded as messages", () => {
  const chat = responsesToOpenAI({
    model: "m",
    input: [
      { type: "message", role: "user", content: "hi" },
      { type: "reasoning", id: "rs_1", summary: [{ type: "summary_text", text: "thinking" }] },
    ],
  });
  assert.deepEqual(chat.messages, [{ role: "user", content: "hi" }]);
});

/* ------------------------------------------------------------ unit: response */

test("a chat completion becomes a responses object", () => {
  const response = openAIToResponses(
    {
      id: "gen_1",
      created: 1_700_000_000,
      model: "m",
      choices: [
        {
          finish_reason: "tool_calls",
          message: {
            content: "let me look",
            reasoning_content: "I should read the file",
            tool_calls: [{ id: "call_1", function: { name: "read", arguments: "{}" } }],
          },
        },
      ],
      usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 },
    },
    "m",
  );
  assert.equal(response.object, "response");
  assert.equal(response.status, "completed");
  assert.match(String(response.id), /^resp_/);
  const output = response.output as Array<Record<string, unknown>>;
  assert.deepEqual(output.map((item) => item.type), ["reasoning", "message", "function_call"]);
  assert.deepEqual((output[1]?.content as Array<Record<string, unknown>>)[0], {
    type: "output_text",
    text: "let me look",
    annotations: [],
  });
  assert.equal(output[2]?.call_id, "call_1");
  assert.equal(output[2]?.name, "read");
  assert.deepEqual(response.usage, {
    input_tokens: 10,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 14,
  });
});

test("a length-truncated completion is reported as incomplete", () => {
  const response = openAIToResponses(
    { choices: [{ finish_reason: "length", message: { content: "half" } }] },
    "m",
  );
  assert.equal(response.status, "incomplete");
  assert.deepEqual(response.incomplete_details, { reason: "max_output_tokens" });
});

test("thinking is kept when upstream calls the field `reasoning`", () => {
  // Cline's own gateway uses `reasoning`; DeepSeek-style clients send
  // `reasoning_content`. Both must survive into a reasoning item.
  const response = openAIToResponses(
    { choices: [{ finish_reason: "stop", message: { content: "4", reasoning: "2 + 2" } }] },
    "m",
  );
  const output = response.output as Array<Record<string, unknown>>;
  assert.equal(output[0]?.type, "reasoning");
  assert.deepEqual(output[0]?.summary, [{ type: "summary_text", text: "2 + 2" }]);
});

/* ------------------------------------------------------------- unit: stream */

/** Drive the translator with a fixed chat SSE body and return its output. */
async function translate(sse: string, model = "m"): Promise<string> {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(sse));
      controller.close();
    },
  });
  const out = translateStreamToResponses(stream, model);
  const reader = out.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
  }
  return text;
}

test("a chat SSE stream becomes responses SSE events", async () => {
  const text = await translate(
    'data: {"choices":[{"delta":{"reasoning_content":"hmm"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hel"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"lo"},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n",
  );
  const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
  assert.deepEqual(events, [
    "response.created",
    "response.in_progress",
    "response.output_item.added",
    "response.reasoning_summary_part.added",
    "response.reasoning_summary_text.delta",
    "response.reasoning_summary_text.done",
    "response.reasoning_summary_part.done",
    "response.output_item.done",
    "response.output_item.added",
    "response.content_part.added",
    "response.output_text.delta",
    "response.output_text.delta",
    "response.output_text.done",
    "response.content_part.done",
    "response.output_item.done",
    "response.completed",
  ]);
  assert.match(text, /"delta":"Hel"/);
  assert.match(text, /"delta":"lo"/);
  const completed = JSON.parse(text.slice(text.lastIndexOf("data: ") + 6).trim());
  assert.equal(completed.type, "response.completed");
  const output = completed.response.output as Array<Record<string, unknown>>;
  assert.equal(output.length, 2);
  assert.deepEqual(output[0]?.summary, [{ type: "summary_text", text: "hmm" }]);
  assert.deepEqual(output[1]?.content, [{ type: "output_text", text: "Hello", annotations: [] }]);
  assert.deepEqual(completed.response.usage.input_tokens, 5);
  assert.deepEqual(completed.response.usage.output_tokens, 2);
});

test("streamed tool calls keep their own output items", async () => {
  const text = await translate(
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"read","arguments":"{\\"p\\":"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"1}"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_2","function":{"name":"write","arguments":"{}"}}]},"finish_reason":null}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}\n\n' +
      "data: [DONE]\n\n",
  );
  const completed = JSON.parse(text.slice(text.lastIndexOf("data: ") + 6).trim());
  const output = completed.response.output as Array<Record<string, unknown>>;
  assert.deepEqual(output.map((item) => item.type), ["function_call", "function_call"]);
  assert.equal(output[0]?.name, "read");
  assert.equal(output[0]?.arguments, '{"p":1}');
  assert.equal(output[1]?.name, "write");
  assert.match(text, /event: response\.function_call_arguments\.delta/);
});

test("an empty upstream stream still yields a well-formed envelope", async () => {
  const text = await translate("data: [DONE]\n\n");
  assert.match(text, /event: response.created/);
  assert.match(text, /event: response.completed/);
});

/* ---------------------------------------------------------- unit: escalation */

test("only a small output budget is raised for the retry", () => {
  assert.deepEqual(withRaisedTokenBudget({ model: "m", max_tokens: 16 }), {
    model: "m",
    max_tokens: 2048,
  });
  assert.deepEqual(withRaisedTokenBudget({ model: "m", max_output_tokens: 512 }), {
    model: "m",
    max_output_tokens: 2048,
  });
  // Already roomy, or nothing to raise: leave the request alone.
  assert.equal(withRaisedTokenBudget({ model: "m", max_tokens: 4096 }), null);
  assert.equal(withRaisedTokenBudget({ model: "m" }), null);
  assert.equal(withRaisedTokenBudget("not-a-body"), null);
});

/* -------------------------------------------------------------- end to end */

interface MockUpstream {
  url: string;
  requests: Array<{ url: string; body: string; headers: http.IncomingHttpHeaders }>;
  setChatHandler: (handler: (req: { body: string }, res: http.ServerResponse) => void) => void;
  close: () => Promise<void>;
}

async function startMockUpstream(): Promise<MockUpstream> {
  const requests: MockUpstream["requests"] = [];
  let chatHandler = (_req: { body: string }, res: http.ServerResponse): void => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" }, finish_reason: "stop" }] }));
  };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      const recorded = { url: req.url ?? "", body, headers: req.headers };
      requests.push(recorded);
      if (recorded.url === "/api/v1/models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: [{ id: "mock/model-1", owned_by: "mock" }] }));
        return;
      }
      if (recorded.url === "/api/v1/ai/cline/recommended-models") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ free: [], clinePass: [] }));
        return;
      }
      if (recorded.url === "/api/v1/chat/completions") {
        chatHandler(recorded, res);
        return;
      }
      res.writeHead(404).end("{}");
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
    close: () =>
      new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

async function withGateway(
  upstream: MockUpstream,
  run: (app: ReturnType<typeof createApp>["app"]) => Promise<void>,
): Promise<void> {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-responses-"));
  fs.writeFileSync(
    path.join(dataDir, "accounts.json"),
    JSON.stringify({
      version: 1,
      accounts: [
        {
          id: "acct-1",
          label: null,
          email: "mock@example.com",
          accountId: "cu_mock",
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
    await run(app);
  } finally {
    await upstream.close();
  }
}

test("POST /v1/responses answers a Responses client end to end", async () => {
  const upstream = await startMockUpstream();
  await withGateway(upstream, async (app) => {
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({
        model: "mock/model-1",
        instructions: "be brief",
        max_output_tokens: 128,
        input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "hi" }] }],
      }),
    });
    assert.equal(response.status, 200);
    const json = (await response.json()) as Record<string, unknown>;
    assert.equal(json.object, "response");
    assert.equal(json.status, "completed");
    assert.equal(json.max_output_tokens, 128);
    assert.equal(json.instructions, "be brief");
    const output = json.output as Array<Record<string, unknown>>;
    assert.equal(output[0]?.type, "message");
    assert.deepEqual(output[0]?.content, [{ type: "output_text", text: "ok", annotations: [] }]);

    // ...and upstream must have seen an ordinary chat-completions request.
    const call = upstream.requests.find((r) => r.url === "/api/v1/chat/completions");
    const sent = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
    assert.equal(sent.model, "mock/model-1");
    assert.equal(sent.max_tokens, 128);
    assert.deepEqual(sent.messages, [
      { role: "system", content: "be brief" },
      { role: "user", content: "hi" },
    ]);
  });
});

test("POST /v1/responses streams responses-shaped events", async () => {
  const upstream = await startMockUpstream();
  upstream.setChatHandler((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"choices":[{"delta":{"content":"hi"},"finish_reason":null}]}\n\n' +
        'data: {"choices":[{"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n' +
        "data: [DONE]\n\n",
    );
  });
  await withGateway(upstream, async (app) => {
    const response = await app.request("/v1/responses", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", stream: true, input: "hi" }),
    });
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /event: response.output_text.delta/);
    assert.match(text, /event: response.completed/);

    const call = upstream.requests.find((r) => r.url === "/api/v1/chat/completions");
    const sent = JSON.parse(call?.body ?? "{}") as Record<string, unknown>;
    assert.equal(sent.stream, true);
    assert.deepEqual(sent.stream_options, { include_usage: true });
  });
});

test("a small token budget that upstream answers with nothing is retried once, larger", async () => {
  const upstream = await startMockUpstream();
  const bodies: Array<Record<string, unknown>> = [];
  upstream.setChatHandler((req, res) => {
    const body = JSON.parse(req.body) as Record<string, unknown>;
    bodies.push(body);
    if (body.max_tokens !== 2048) {
      res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "empty response content", success: false }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "second try" }, finish_reason: "stop" }] }));
  });
  await withGateway(upstream, async (app) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 200, "the empty-content 500 must not reach the client");
    const json = (await response.json()) as { choices: Array<{ message: { content: string } }> };
    assert.equal(json.choices[0]?.message.content, "second try");
    assert.deepEqual(bodies.map((body) => body.max_tokens), [16, 2048]);
    // One account, two attempts — not a failover.
    assert.equal(upstream.requests.filter((r) => r.url === "/api/v1/chat/completions").length, 2);
  });
});

test("an empty response that survives the bigger budget is reported, not retried forever", async () => {
  const upstream = await startMockUpstream();
  let calls = 0;
  upstream.setChatHandler((_req, res) => {
    calls += 1;
    res.writeHead(500, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "empty response content", success: false }));
  });
  await withGateway(upstream, async (app) => {
    const response = await app.request("/v1/chat/completions", {
      method: "POST",
      headers: authHeaders,
      body: JSON.stringify({ model: "mock/model-1", max_tokens: 16, messages: [{ role: "user", content: "hi" }] }),
    });
    assert.equal(response.status, 500);
    assert.equal(calls, 2, "exactly one escalation retry");
  });
});
