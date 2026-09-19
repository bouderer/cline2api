/**
 * OpenAI Responses API compatibility (`POST /v1/responses`).
 *
 * Upstream speaks chat completions, so a Responses request is translated down
 * and the answer translated back — the mirror image of anthropic.ts. Both
 * directions and both transports are covered, which is what lets OpenAI-native
 * agents (Codex and anything else built on the Responses API) point straight at
 * this gateway instead of needing a converter in front of it.
 *
 * The translation is deliberately shallow: only the fields the two APIs agree
 * on are carried across. Anything Responses-only (store, previous_response_id,
 * background, …) is dropped rather than guessed at, because upstream has no
 * stateful response store to honour it.
 */
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import { isAuthorized, unwrapEnvelope } from "./openai.js";
import { callUpstreamWithFailover } from "../services/proxyChat.js";
import { SSE_HEADERS, openaiError, readReasoning, sanitizeOpenAIMessages } from "./http.js";

/* ------------------------------------------------------------------- types */

interface ResponsesRequest {
  model?: unknown;
  input?: unknown;
  instructions?: unknown;
  max_output_tokens?: unknown;
  stream?: unknown;
  temperature?: unknown;
  top_p?: unknown;
  tools?: unknown;
  tool_choice?: unknown;
  [key: string]: unknown;
}

type Json = Record<string, unknown>;

const isObject = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

/** Concatenate the text of whatever shape a content field arrived in. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => isObject(part) && typeof part.text === "string")
    .map((part) => (part as { text: string }).text)
    .join("");
}

function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
}

/* ------------------------------------------------ responses -> chat (request) */

/** One Responses content part -> one chat content part. */
function toChatPart(part: unknown): Json | null {
  if (!isObject(part)) return null;
  if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") &&
      typeof part.text === "string") {
    return { type: "text", text: part.text };
  }
  if (part.type === "input_image") {
    const url = typeof part.image_url === "string" ? part.image_url : null;
    return url ? { type: "image_url", image_url: { url } } : null;
  }
  return null;
}

/**
 * A Responses `content` field -> a chat `content` field. Plain text collapses to
 * a string (what every upstream expects for the common case); anything with
 * images stays a part array.
 */
function toChatContent(content: unknown): string | Json[] {
  if (typeof content === "string") return content;
  const parts = asArray(content).map(toChatPart).filter((part): part is Json => part !== null);
  if (parts.length === 0) return "";
  if (parts.every((part) => part.type === "text")) {
    return parts.map((part) => part.text as string).join("");
  }
  return parts;
}

export function toChatTools(tools: unknown): Json[] {
  return asArray(tools)
    .map((tool): Json | null => {
      if (!isObject(tool)) return null;
      // Already chat-shaped (some clients send both dialects in one field).
      if (isObject(tool.function) && typeof tool.function.name === "string") {
        return { type: "function", function: tool.function };
      }
      if (typeof tool.name !== "string" || tool.name.length === 0) return null;
      return {
        type: "function",
        function: {
          name: tool.name,
          ...(typeof tool.description === "string" ? { description: tool.description } : {}),
          parameters: isObject(tool.parameters) ? tool.parameters : { type: "object", properties: {} },
        },
      };
    })
    .filter((tool): tool is Json => tool !== null);
}

function toChatToolChoice(choice: unknown): unknown {
  if (typeof choice === "string") return choice;
  if (!isObject(choice)) return undefined;
  if (choice.type === "function") {
    const name = typeof choice.name === "string" ? choice.name : (choice.function as Json | undefined)?.name;
    return typeof name === "string" ? { type: "function", function: { name } } : undefined;
  }
  return undefined;
}

/**
 * Responses `input` -> chat `messages`.
 *
 * `input` is either a plain string or a list of items. The list mixes message
 * items with the tool-call items a previous turn produced, so consecutive
 * `function_call` items are folded back into the single assistant message that
 * chat completions expects, and each `function_call_output` becomes the `tool`
 * message answering it.
 */
function inputToMessages(input: unknown): Json[] {
  const messages: Json[] = [];
  if (typeof input === "string") {
    if (input.length > 0) messages.push({ role: "user", content: input });
    return messages;
  }
  if (!Array.isArray(input)) return messages;

  let pendingCalls: Json[] | null = null;
  const flushCalls = (): void => {
    if (pendingCalls === null) return;
    messages.push({ role: "assistant", content: null, tool_calls: pendingCalls });
    pendingCalls = null;
  };

  for (const item of input) {
    if (typeof item === "string") {
      flushCalls();
      messages.push({ role: "user", content: item });
      continue;
    }
    if (!isObject(item)) continue;

    if (item.type === "function_call") {
      (pendingCalls ??= []).push({
        id: typeof item.call_id === "string" ? item.call_id : newId("call"),
        type: "function",
        function: {
          name: typeof item.name === "string" ? item.name : "unknown_tool",
          arguments: typeof item.arguments === "string" ? item.arguments : "{}",
        },
      });
      continue;
    }

    if (item.type === "function_call_output") {
      flushCalls();
      const output = textOf(item.output);
      messages.push({
        role: "tool",
        tool_call_id: typeof item.call_id === "string" ? item.call_id : "",
        content: output.length > 0 ? output : "(tool returned no text output)",
      });
      continue;
    }

    // Reasoning items are upstream's own output echoed back; chat completions
    // has nowhere to put them.
    if (item.type === "reasoning") {
      flushCalls();
      continue;
    }

    flushCalls();
    const role =
      item.role === "assistant" ? "assistant" : item.role === "system" || item.role === "developer" ? "system" : "user";
    const content = toChatContent(item.content);
    messages.push({ role, content });
  }

  flushCalls();
  return messages;
}

/** Responses request -> OpenAI chat-completions request body. */
export function responsesToOpenAI(body: ResponsesRequest): Json {
  const messages: Json[] = [];
  const instructions = textOf(body.instructions);
  if (instructions.trim().length > 0) messages.push({ role: "system", content: instructions });
  messages.push(...inputToMessages(body.input));

  const out: Json = { model: body.model, messages };
  const maxOutput = typeof body.max_output_tokens === "number" ? body.max_output_tokens : body.max_tokens;
  if (typeof maxOutput === "number") out.max_tokens = maxOutput;
  if (body.stream === true) out.stream = true;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;

  const tools = toChatTools(body.tools);
  if (tools.length > 0) out.tools = tools;
  const toolChoice = toChatToolChoice(body.tool_choice);
  if (toolChoice !== undefined) out.tool_choice = toolChoice;
  return out;
}

/* ----------------------------------------------- chat -> responses (response) */

interface OpenAIToolCall {
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface OpenAIChoice {
  message?: { content?: string | null; tool_calls?: OpenAIToolCall[]; reasoning_content?: string };
  finish_reason?: string | null;
}

interface OpenAICompletion {
  id?: string;
  created?: number;
  model?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

function messageItem(text: string): Json {
  return {
    type: "message",
    id: newId("msg"),
    status: "completed",
    role: "assistant",
    content: [{ type: "output_text", text, annotations: [] }],
  };
}

function reasoningItem(text: string): Json {
  return {
    type: "reasoning",
    id: newId("rs"),
    summary: [{ type: "summary_text", text }],
  };
}

function functionCallItem(call: OpenAIToolCall): Json {
  return {
    type: "function_call",
    id: newId("fc"),
    call_id: call.id ?? newId("call"),
    name: call.function?.name ?? "unknown_tool",
    arguments: typeof call.function?.arguments === "string" ? call.function.arguments : "{}",
    status: "completed",
  };
}

function toResponsesUsage(usage: OpenAICompletion["usage"]): Json {
  const input = usage?.prompt_tokens ?? 0;
  const output = usage?.completion_tokens ?? 0;
  return {
    input_tokens: input,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: output,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: usage?.total_tokens ?? input + output,
  };
}

/** The `output` items a chat completion corresponds to, in order. */
export function outputItems(completion: OpenAICompletion): Json[] {
  const choice = completion.choices?.[0];
  const items: Json[] = [];
  const reasoning = readReasoning(choice?.message);
  if (reasoning !== null) items.push(reasoningItem(reasoning));
  const text = choice?.message?.content;
  if (typeof text === "string" && text.length > 0) items.push(messageItem(text));
  for (const call of choice?.message?.tool_calls ?? []) items.push(functionCallItem(call));
  return items;
}

function responseEnvelope(input: {
  id: string;
  createdAt: number;
  model: string;
  status: "in_progress" | "completed" | "incomplete";
  output: Json[];
  usage?: Json;
  incompleteReason?: string;
  request?: ResponsesRequest;
}): Json {
  const request = input.request ?? {};
  return {
    id: input.id,
    object: "response",
    created_at: input.createdAt,
    status: input.status,
    error: null,
    incomplete_details:
      input.status === "incomplete" ? { reason: input.incompleteReason ?? "max_output_tokens" } : null,
    instructions: typeof request.instructions === "string" ? request.instructions : null,
    max_output_tokens:
      typeof request.max_output_tokens === "number" ? request.max_output_tokens : null,
    model: input.model,
    output: input.output,
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: false,
    temperature: typeof request.temperature === "number" ? request.temperature : null,
    text: { format: { type: "text" } },
    tool_choice: typeof request.tool_choice === "string" ? request.tool_choice : "auto",
    tools: toChatTools(request.tools),
    top_p: typeof request.top_p === "number" ? request.top_p : null,
    truncation: "disabled",
    usage: input.usage ?? null,
    metadata: isObject(request.metadata) ? request.metadata : {},
  };
}

/** Chat completion -> Responses object (non-streaming). */
export function openAIToResponses(
  completion: OpenAICompletion,
  model: string,
  request?: ResponsesRequest,
): Json {
  const choice = completion.choices?.[0];
  const status = choice?.finish_reason === "length" ? "incomplete" : "completed";
  return responseEnvelope({
    id: completion.id && completion.id.startsWith("resp_") ? completion.id : newId("resp"),
    createdAt: completion.created ?? Math.floor(Date.now() / 1000),
    model: completion.model ?? model,
    status,
    output: outputItems(completion),
    usage: toResponsesUsage(completion.usage),
    ...(request ? { request } : {}),
  });
}

/* ------------------------------------------------------------------- stream */

function sse(event: string, data: Json): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Split an upstream SSE body into individual `data:` payloads. */
async function* iterateSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let index = buffer.indexOf("\n");
      while (index >= 0) {
        yield buffer.slice(0, index).replace(/\r$/, "");
        buffer = buffer.slice(index + 1);
        index = buffer.indexOf("\n");
      }
    }
    if (buffer.length > 0) yield buffer.replace(/\r$/, "");
  } finally {
    reader.releaseLock();
  }
}

type ItemKind = "reasoning" | "message" | "function_call";

/**
 * Chat-completions SSE -> Responses SSE.
 *
 * The Responses wire format is item-oriented where chat is delta-oriented, so
 * this keeps one item open at a time and closes it (emitting the `*.done`
 * events and appending it to the response's `output`) whenever upstream starts
 * a different kind of content. The terminal `response.completed` carries the
 * fully assembled response, which is what non-streaming clients read too.
 */
export function translateStreamToResponses(
  body: ReadableStream<Uint8Array>,
  model: string,
  request?: ResponsesRequest,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const responseId = newId("resp");
  const createdAt = Math.floor(Date.now() / 1000);
  const output: Json[] = [];
  let sequence = 0;
  let created = false;
  let nextIndex = 0;
  let openKind: ItemKind | null = null;
  let openIndex = -1;
  let openItem: Json | null = null;
  let openText = "";
  let openArgs = "";
  /** Chat tool-call index -> output index, so parallel calls stay separate. */
  const toolItems = new Map<number, number>();
  let promptTokens = 0;
  let completionTokens = 0;
  let status: "completed" | "incomplete" = "completed";

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (event: string, data: Json): void => {
        controller.enqueue(encoder.encode(sse(event, { type: event, sequence_number: sequence++, ...data })));
      };
      const envelope = (state: "in_progress" | "completed" | "incomplete"): Json =>
        responseEnvelope({
          id: responseId,
          createdAt,
          model,
          status: state,
          output,
          ...(state === "in_progress"
            ? {}
            : {
                usage: toResponsesUsage({
                  prompt_tokens: promptTokens,
                  completion_tokens: completionTokens,
                }),
                ...(state === "incomplete" ? { incompleteReason: "max_output_tokens" } : {}),
              }),
          ...(request ? { request } : {}),
        });

      /** Emit the closing events for the open item and keep it in `output`. */
      const closeItem = (): void => {
        if (openKind === null || openItem === null) return;
        if (openKind === "message") {
          write("response.output_text.done", { item_id: openItem.id, output_index: openIndex, content_index: 0, text: openText });
          write("response.content_part.done", {
            item_id: openItem.id,
            output_index: openIndex,
            content_index: 0,
            part: { type: "output_text", text: openText, annotations: [] },
          });
          openItem.content = [{ type: "output_text", text: openText, annotations: [] }];
          openItem.status = "completed";
        } else if (openKind === "reasoning") {
          write("response.reasoning_summary_text.done", { item_id: openItem.id, output_index: openIndex, summary_index: 0, text: openText });
          write("response.reasoning_summary_part.done", {
            item_id: openItem.id,
            output_index: openIndex,
            summary_index: 0,
            part: { type: "summary_text", text: openText },
          });
          openItem.summary = [{ type: "summary_text", text: openText }];
          openItem.status = "completed";
        } else {
          write("response.function_call_arguments.done", { item_id: openItem.id, output_index: openIndex, arguments: openArgs });
          openItem.arguments = openArgs;
          openItem.status = "completed";
        }
        write("response.output_item.done", { output_index: openIndex, item: openItem });
        output.push(openItem);
        openKind = null;
        openIndex = -1;
        openItem = null;
        openText = "";
        openArgs = "";
      };

      const open = (kind: ItemKind, item: Json): number => {
        if (!created) {
          created = true;
          write("response.created", { response: envelope("in_progress") });
          write("response.in_progress", { response: envelope("in_progress") });
        }
        const index = nextIndex++;
        openKind = kind;
        openIndex = index;
        openItem = item;
        openText = "";
        openArgs = "";
        write("response.output_item.added", { output_index: index, item });
        if (kind === "message") {
          write("response.content_part.added", {
            item_id: item.id,
            output_index: index,
            content_index: 0,
            part: { type: "output_text", text: "", annotations: [] },
          });
        }
        if (kind === "reasoning") {
          write("response.reasoning_summary_part.added", {
            item_id: item.id,
            output_index: index,
            summary_index: 0,
            part: { type: "summary_text", text: "" },
          });
        }
        return index;
      };

      try {
        for await (const line of iterateSSE(body)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0 || payload === "[DONE]") continue;

          let chunk: OpenAICompletion & { choices?: Array<OpenAIChoice & { delta?: Json }> };
          try {
            chunk = JSON.parse(payload) as typeof chunk;
          } catch {
            continue;
          }
          if (chunk.usage) {
            promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
            completionTokens = chunk.usage.completion_tokens ?? completionTokens;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason === "length") status = "incomplete";

          const delta = (choice as { delta?: Json }).delta ?? {};
          const reasoning = readReasoning(delta);
          if (reasoning !== null) {
            if (openKind !== "reasoning") {
              closeItem();
              open("reasoning", { type: "reasoning", id: newId("rs"), summary: [] });
            }
            openText += reasoning;
            write("response.reasoning_summary_text.delta", {
              item_id: openItem?.id,
              output_index: openIndex,
              summary_index: 0,
              delta: reasoning,
            });
          }

          const content = delta.content;
          if (typeof content === "string" && content.length > 0) {
            if (openKind !== "message") {
              closeItem();
              open("message", { type: "message", id: newId("msg"), status: "in_progress", role: "assistant", content: [] });
            }
            openText += content;
            write("response.output_text.delta", {
              item_id: openItem?.id,
              output_index: openIndex,
              content_index: 0,
              delta: content,
            });
          }

          const toolCalls = delta.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const raw of toolCalls as Json[]) {
              const toolIndex = typeof raw.index === "number" ? raw.index : 0;
              const fn = isObject(raw.function) ? raw.function : {};
              let index = toolItems.get(toolIndex);
              if (index === undefined) {
                closeItem();
                index = open("function_call", {
                  type: "function_call",
                  id: newId("fc"),
                  call_id: typeof raw.id === "string" && raw.id.length > 0 ? raw.id : newId("call"),
                  name: typeof fn.name === "string" ? fn.name : "unknown_tool",
                  arguments: "",
                  status: "in_progress",
                });
                toolItems.set(toolIndex, index);
              }
              const args = fn.arguments;
              if (typeof args === "string" && args.length > 0) {
                openArgs += args;
                write("response.function_call_arguments.delta", {
                  item_id: openItem?.id,
                  output_index: index,
                  delta: args,
                });
              }
            }
          }
        }

        closeItem();
        if (!created) {
          // Upstream produced nothing at all: still answer with a well-formed
          // envelope so a Responses client sees an empty turn, not a broken stream.
          created = true;
          write("response.created", { response: envelope("in_progress") });
          write("response.in_progress", { response: envelope("in_progress") });
        }
        write("response.completed", { response: envelope(status) });
        controller.close();
      } catch (error) {
        try {
          const message = (error as Error).message;
          write("response.failed", {
            response: { ...envelope("incomplete"), status: "failed", error: { code: "stream_error", message } },
          });
        } catch {
          // controller already closed
        }
        controller.close();
      }
    },
  });
}

/* -------------------------------------------------------------------- route */

export function registerResponsesRoutes(app: Hono, deps: OpenAIRouteDeps): void {
  app.post("/v1/responses", async (c) => {
    if (!isAuthorized(c, deps)) {
      return openaiError("Missing or invalid API key.", 401, { code: "invalid_api_key" });
    }
    let body: ResponsesRequest;
    try {
      body = (await c.req.json()) as ResponsesRequest;
    } catch {
      return openaiError("Request body must be valid JSON.", 400);
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      return openaiError("`model` is required.", 400, { code: "missing_model" });
    }
    if (typeof body.input !== "string" && !Array.isArray(body.input)) {
      return openaiError("`input` must be a string or an array of items.", 400, { code: "invalid_input" });
    }

    const wantsStream = body.stream === true;
    const openaiBody = responsesToOpenAI(body);
    // Same empty-content guard the other two surfaces use; see http.ts.
    openaiBody.messages = sanitizeOpenAIMessages(openaiBody.messages);
    const upstreamBody = wantsStream
      ? {
          ...openaiBody,
          stream_options: {
            include_usage: true,
            ...(typeof body.stream_options === "object" && body.stream_options !== null
              ? (body.stream_options as Json)
              : {}),
          },
        }
      : openaiBody;

    const outcome = await callUpstreamWithFailover(deps, upstreamBody, {
      taskId: randomUUID(),
      model: body.model,
      stream: wantsStream,
      ...(c.req.raw.signal ? { signal: c.req.raw.signal } : {}),
    });
    if (outcome.kind === "error") return outcome.response;

    const { response: upstream, accountId } = outcome;
    if (wantsStream && upstream.body) {
      return new Response(translateStreamToResponses(upstream.body, body.model, body), {
        status: 200,
        headers: { ...SSE_HEADERS, "x-account": accountId },
      });
    }

    const raw = await upstream.text();
    let completion: OpenAICompletion;
    try {
      completion = unwrapEnvelope(JSON.parse(raw)) as OpenAICompletion;
    } catch {
      return openaiError(`Upstream returned a non-JSON response: ${raw.slice(0, 200)}`, 502, {
        type: "upstream_error",
      });
    }
    return new Response(JSON.stringify(openAIToResponses(completion, body.model, body)), {
      status: 200,
      headers: { "content-type": "application/json", "x-account": accountId },
    });
  });
}
