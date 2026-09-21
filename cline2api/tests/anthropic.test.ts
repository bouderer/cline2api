import assert from "node:assert/strict";
import test from "node:test";
import {
  anthropicToOpenAI,
  openAIToAnthropicMessage,
  translateStreamToAnthropic,
} from "../src/api/anthropic.js";

test("system prompt and user text map to OpenAI messages", () => {
  const out = anthropicToOpenAI({
    model: "anthropic/claude-sonnet-4.6",
    max_tokens: 128,
    system: "be terse",
    messages: [{ role: "user", content: "hello" }],
  });
  assert.equal(out.model, "anthropic/claude-sonnet-4.6");
  assert.equal(out.max_tokens, 128);
  assert.deepEqual(out.messages, [
    { role: "system", content: "be terse" },
    { role: "user", content: "hello" },
  ]);
});

test("image blocks become OpenAI image_url parts", () => {
  const out = anthropicToOpenAI({
    model: "m",
    max_tokens: 16,
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: "what is this" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        ],
      },
    ],
  }) as { messages: Array<{ content: unknown }> };
  const parts = out.messages[0]?.content as Array<Record<string, unknown>>;
  assert.equal(parts.length, 2);
  assert.deepEqual(parts[1], { type: "image_url", image_url: { url: "data:image/png;base64,AAA" } });
});

test("assistant tool_use and user tool_result map to OpenAI tool protocol", () => {
  const out = anthropicToOpenAI({
    model: "m",
    max_tokens: 16,
    messages: [
      { role: "user", content: "weather?" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "toolu_1", name: "get_weather", input: { city: "SH" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "sunny" }],
      },
    ],
  }) as { messages: Array<Record<string, unknown>> };
  const assistant = out.messages[1];
  assert.deepEqual(assistant?.tool_calls, [
    {
      id: "toolu_1",
      type: "function",
      function: { name: "get_weather", arguments: '{"city":"SH"}' },
    },
  ]);
  assert.deepEqual(out.messages[2], { role: "tool", tool_call_id: "toolu_1", content: "sunny" });
});

test("tools and tool_choice are translated", () => {
  const out = anthropicToOpenAI({
    model: "m",
    max_tokens: 16,
    messages: [{ role: "user", content: "hi" }],
    tools: [{ name: "t", description: "d", input_schema: { type: "object" } }],
    tool_choice: { type: "any" },
  }) as Record<string, unknown>;
  assert.deepEqual(out.tool_choice, "required");
  assert.deepEqual(out.tools, [
    { type: "function", function: { name: "t", description: "d", parameters: { type: "object" } } },
  ]);
  assert.equal("stream" in out, false);
});

test("a buffered completion becomes an Anthropic message", () => {
  const msg = openAIToAnthropicMessage(
    {
      id: "chatcmpl-1",
      model: "m",
      choices: [{ message: { content: "hi there" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 7, completion_tokens: 3 },
    },
    "fallback-model",
  );
  assert.equal(msg.type, "message");
  assert.equal(msg.role, "assistant");
  assert.equal(msg.model, "m");
  assert.deepEqual(msg.content, [{ type: "text", text: "hi there" }]);
  assert.equal(msg.stop_reason, "end_turn");
  assert.deepEqual(msg.usage, {
    input_tokens: 7,
    output_tokens: 3,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  });
});

test("a prompt-cache read is carved out of input_tokens", () => {
  // Anthropic counts the cache read *beside* input_tokens, not inside it, while
  // upstream's prompt_tokens is the whole prompt. Reporting the total as
  // input_tokens too would make the two overlap for anything that bills the sum.
  const msg = openAIToAnthropicMessage(
    {
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 2036,
        completion_tokens: 12,
        cache_creation_input_tokens: 100,
        prompt_tokens_details: { cached_tokens: 1920 },
      },
    },
    "m",
  );
  assert.deepEqual(msg.usage, {
    input_tokens: 16,
    output_tokens: 12,
    cache_read_input_tokens: 1920,
    cache_creation_input_tokens: 100,
  });
});

test("a cache breakdown larger than the prompt cannot go negative", () => {
  const msg = openAIToAnthropicMessage(
    {
      choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 1,
        cache_creation_input_tokens: 60,
        prompt_tokens_details: { cached_tokens: 60 },
      },
    },
    "m",
  );
  assert.equal(msg.usage.input_tokens, 0);
});

test("tool calls in a buffered completion become tool_use blocks", () => {
  const msg = openAIToAnthropicMessage(
    {
      choices: [
        {
          message: {
            tool_calls: [{ id: "call_1", function: { name: "f", arguments: '{"x":1}' } }],
          },
          finish_reason: "tool_calls",
        },
      ],
    },
    "m",
  );
  assert.equal(msg.stop_reason, "tool_use");
  assert.deepEqual(msg.content, [
    { type: "tool_use", id: "call_1", name: "f", input: { x: 1 } },
  ]);
});

function openAIStream(chunks: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
      }
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    },
  });
}

async function drain(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    out += decoder.decode(value, { stream: true });
  }
  return out;
}

test("streamed text is re-framed as Anthropic SSE events", async () => {
  const other = translateStreamToAnthropic(
    openAIStream([
      { choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "Hel" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: { content: "lo" }, finish_reason: null }] },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 5, completion_tokens: 2 } },
    ]),
    "m",
  );
  const text = await drain(other);
  const events = text
    .split("\n")
    .filter((line) => line.startsWith("event: "))
    .map((line) => line.slice(7));
  assert.deepEqual(events, [
    "message_start",
    "content_block_start",
    "content_block_delta",
    "content_block_delta",
    "content_block_stop",
    "message_delta",
    "message_stop",
  ]);
  assert.match(text, /"text_delta","text":"Hel"/);
  assert.match(text, /"text_delta","text":"lo"/);
  assert.match(text, /"stop_reason":"end_turn"/);
  assert.match(text, /"output_tokens":2/);
});

test("streamed cache usage survives into message_delta", async () => {
  const other = translateStreamToAnthropic(
    openAIStream([
      { choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }] },
      {
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: {
          prompt_tokens: 2036,
          completion_tokens: 12,
          cache_creation_input_tokens: 0,
          prompt_tokens_details: { cached_tokens: 1920 },
        },
      },
    ]),
    "m",
  );
  const text = await drain(other);
  assert.match(
    text,
    /"usage":\{"input_tokens":116,"output_tokens":12,"cache_read_input_tokens":1920,"cache_creation_input_tokens":0\}/,
  );
});

test("a later chunk without details does not erase the cache breakdown", async () => {
  const other = translateStreamToAnthropic(
    openAIStream([
      {
        choices: [{ index: 0, delta: { content: "ok" }, finish_reason: null }],
        usage: {
          prompt_tokens: 100,
          completion_tokens: 2,
          prompt_tokens_details: { cached_tokens: 64 },
        },
      },
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { total_tokens: 166 } },
    ]),
    "m",
  );
  const text = await drain(other);
  assert.match(text, /"cache_read_input_tokens":64/);
  assert.match(text, /"input_tokens":36/);
});

test("streamed reasoning_content becomes a thinking block", async () => {
  const stream = translateStreamToAnthropic(
    openAIStream([
      { choices: [{ delta: { reasoning_content: "hmm" }, finish_reason: null }] },
      { choices: [{ delta: { content: "answer" }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "stop" }] },
    ]),
    "m",
  );
  const text = await drain(stream);
  assert.match(text, /"type":"thinking"/);
  assert.match(text, /"thinking_delta","thinking":"hmm"/);
  assert.match(text, /"type":"text","text":""/);
  assert.match(text, /"text_delta","text":"answer"/);
});

test("streamed tool calls become tool_use blocks with input_json_delta", async () => {
  const stream = translateStreamToAnthropic(
    openAIStream([
      {
        choices: [
          {
            delta: { tool_calls: [{ index: 0, id: "call_9", function: { name: "f", arguments: '{"a"' } }] },
            finish_reason: null,
          },
        ],
      },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: ":1}" } }] }, finish_reason: null }] },
      { choices: [{ delta: {}, finish_reason: "tool_calls" }] },
    ]),
    "m",
  );
  const text = await drain(stream);
  assert.match(text, /"type":"tool_use","id":"call_9","name":"f"/);
  assert.match(text, /"input_json_delta","partial_json":"\{\\"a\\""/);
  assert.match(text, /"input_json_delta","partial_json":":1\}"/);
  assert.match(text, /"stop_reason":"tool_use"/);
});
