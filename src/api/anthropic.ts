/**
 * Anthropic Messages API compatibility (`POST /v1/messages`).
 *
 * Translates Anthropic requests into OpenAI chat-completions (which is what
 * api.cline.bot speaks), then converts the response back — both for buffered
 * JSON and for the SSE stream. This is what lets Claude Code and other
 * Anthropic-native clients use the gateway.
 */
import { randomUUID } from "node:crypto";
import type { Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import { isAuthorized } from "./openai.js";
import { callUpstreamWithFailover } from "../services/proxyChat.js";
import { SSE_HEADERS, openaiError, sanitizeOpenAIMessages } from "./http.js";

interface TextBlock { type: "text"; text: string }
interface ImageBlock {
  type: "image";
  source:
    | { type: "base64"; media_type: string; data: string }
    | { type: "url"; url: string };
}
interface ToolUseBlock { type: "tool_use"; id: string; name: string; input: unknown }
interface ToolResultBlock {
  type: "tool_result";
  tool_use_id: string;
  content?: string | Array<TextBlock | ImageBlock>;
  is_error?: boolean;
}
type ContentBlock = TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock | { type: string; [key: string]: unknown };

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | ContentBlock[];
}

interface AnthropicTool {
  name: string;
  description?: string;
  input_schema?: Record<string, unknown>;
}

interface AnthropicRequest {
  model: string;
  max_tokens?: number;
  messages: AnthropicMessage[];
  system?: string | TextBlock[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  stop_sequences?: string[];
  tools?: AnthropicTool[];
  tool_choice?: { type: "auto" | "any" | "none" | "tool"; name?: string };
  [key: string]: unknown;
}

type OpenAIMessage = Record<string, unknown>;

function textFromBlocks(blocks: Array<TextBlock | ImageBlock> | undefined): string {
  if (!Array.isArray(blocks)) return "";
  return blocks
    .filter((block) => block?.type === "text" && typeof block.text === "string")
    .map((block) => (block as TextBlock).text)
    .join("");
}

function imageToOpenAIPart(block: ImageBlock): Record<string, unknown> | null {
  const source = block.source;
  if (!source) return null;
  if (source.type === "base64") {
    return {
      type: "image_url",
      image_url: { url: `data:${source.media_type};base64,${source.data}` },
    };
  }
  if (source.type === "url") {
    return { type: "image_url", image_url: { url: source.url } };
  }
  return null;
}

/** Anthropic request -> OpenAI chat-completions request body. */
export function anthropicToOpenAI(body: AnthropicRequest): Record<string, unknown> {
  const messages: OpenAIMessage[] = [];

  const systemText =
    typeof body.system === "string" ? body.system : textFromBlocks(body.system as TextBlock[]);
  if (systemText.trim().length > 0) messages.push({ role: "system", content: systemText });

  for (const message of body.messages ?? []) {
    const content = message.content;
    if (typeof content === "string") {
      messages.push({ role: message.role, content });
      continue;
    }
    if (!Array.isArray(content)) continue;

    const parts: Array<Record<string, unknown>> = [];
    const toolCalls: Array<Record<string, unknown>> = [];

    for (const block of content as ContentBlock[]) {
      switch (block.type) {
        case "text": {
          parts.push({ type: "text", text: (block as TextBlock).text });
          break;
        }
        case "image": {
          const part = imageToOpenAIPart(block as ImageBlock);
          if (part) parts.push(part);
          break;
        }
        case "tool_use": {
          const toolUse = block as ToolUseBlock;
          toolCalls.push({
            id: toolUse.id,
            type: "function",
            function: {
              name: toolUse.name,
              arguments: JSON.stringify(toolUse.input ?? {}),
            },
          });
          break;
        }
        case "tool_result": {
          const result = block as ToolResultBlock;
          const resultText =
            typeof result.content === "string"
              ? result.content
              : textFromBlocks(result.content as Array<TextBlock | ImageBlock>);
          messages.push({
            role: "tool",
            tool_call_id: result.tool_use_id,
            content: resultText.length > 0 ? resultText : result.is_error ? "(tool error)" : "",
          });
          break;
        }
        default:
          break;
      }
    }

    if (message.role === "assistant") {
      const assistant: OpenAIMessage = {};
      const text = parts
        .filter((part) => part.type === "text")
        .map((part) => part.text as string)
        .join("");
      if (text.length > 0 || toolCalls.length === 0) assistant.content = text;
      if (toolCalls.length > 0) assistant.tool_calls = toolCalls;
      messages.push({ role: "assistant", ...assistant });
    } else if (parts.length > 0) {
      messages.push({
        role: "user",
        content: parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts,
      });
    }
  }

  const out: Record<string, unknown> = {
    model: body.model,
    messages,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 8192,
  };
  if (body.stream === true) out.stream = true;
  if (typeof body.temperature === "number") out.temperature = body.temperature;
  if (typeof body.top_p === "number") out.top_p = body.top_p;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length > 0) {
    out.stop = body.stop_sequences;
  }
  if (Array.isArray(body.tools) && body.tools.length > 0) {
    out.tools = body.tools.map((tool) => ({
      type: "function",
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.input_schema ?? { type: "object", properties: {} },
      },
    }));
  }
  const choice = body.tool_choice;
  if (choice) {
    if (choice.type === "auto") out.tool_choice = "auto";
    else if (choice.type === "any") out.tool_choice = "required";
    else if (choice.type === "none") out.tool_choice = "none";
    else if (choice.type === "tool" && choice.name) {
      out.tool_choice = { type: "function", function: { name: choice.name } };
    }
  }
  return out;
}

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
  model?: string;
  choices?: OpenAIChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function mapStopReason(finishReason: string | null | undefined): string {
  switch (finishReason) {
    case "length":
      return "max_tokens";
    case "tool_calls":
    case "function_call":
      return "tool_use";
    case "content_filter":
      return "stop_sequence";
    default:
      return "end_turn";
  }
}

/** OpenAI completion -> Anthropic message (non-streaming). */
export function openAIToAnthropicMessage(completion: OpenAICompletion, model: string): Record<string, unknown> {
  const choice = completion.choices?.[0];
  const blocks: Array<Record<string, unknown>> = [];

  const reasoning = choice?.message?.reasoning_content;
  if (typeof reasoning === "string" && reasoning.length > 0) {
    blocks.push({ type: "thinking", thinking: reasoning });
  }
  const text = choice?.message?.content;
  if (typeof text === "string" && text.length > 0) {
    blocks.push({ type: "text", text });
  }
  for (const call of choice?.message?.tool_calls ?? []) {
    let input: unknown = {};
    try {
      input = call.function?.arguments ? JSON.parse(call.function.arguments) : {};
    } catch {
      input = {};
    }
    blocks.push({
      type: "tool_use",
      id: call.id ?? `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      name: call.function?.name ?? "unknown_tool",
      input,
    });
  }

  return {
    id: completion.id ?? `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
    type: "message",
    role: "assistant",
    model: completion.model ?? model,
    content: blocks,
    stop_reason: mapStopReason(choice?.finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: completion.usage?.prompt_tokens ?? 0,
      output_tokens: completion.usage?.completion_tokens ?? 0,
    },
  };
}

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

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

/** OpenAI SSE -> Anthropic SSE. */
export function translateStreamToAnthropic(
  body: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const messageId = `msg_${randomUUID().replace(/-/g, "").slice(0, 24)}`;
  const toolBlocks = new Map<number, number>();
  let nextIndex = 0;
  let openIndex = -1;
  let openKind: "text" | "thinking" | "tool" | null = null;
  let stopReason = "end_turn";
  let inputTokens = 0;
  let outputTokens = 0;
  let started = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (chunk: string): void => controller.enqueue(encoder.encode(chunk));
      const beginMessage = (): void => {
        if (started) return;
        started = true;
        write(
          sse("message_start", {
            type: "message_start",
            message: {
              id: messageId,
              type: "message",
              role: "assistant",
              model,
              content: [],
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: 0, output_tokens: 0 },
            },
          }),
        );
      };
      const closeBlock = (): void => {
        if (openKind === null || openIndex < 0) return;
        write(sse("content_block_stop", { type: "content_block_stop", index: openIndex }));
        openKind = null;
        openIndex = -1;
      };
      const openBlock = (kind: "text" | "thinking" | "tool", block: Record<string, unknown>): number => {
        beginMessage();
        const index = nextIndex++;
        openIndex = index;
        openKind = kind;
        write(
          sse("content_block_start", {
            type: "content_block_start",
            index,
            content_block: block,
          }),
        );
        return index;
      };
      const delta = (index: number, payload: Record<string, unknown>): void => {
        write(sse("content_block_delta", { type: "content_block_delta", index, delta: payload }));
      };

      try {
        for await (const line of iterateSSE(body)) {
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (payload.length === 0) continue;
          if (payload === "[DONE]") break;

          let chunk: OpenAICompletion & { choices?: Array<OpenAIChoice & { delta?: Record<string, unknown> }> };
          try {
            chunk = JSON.parse(payload) as typeof chunk;
          } catch {
            continue;
          }
          if (chunk.usage) {
            inputTokens = chunk.usage.prompt_tokens ?? inputTokens;
            outputTokens = chunk.usage.completion_tokens ?? outputTokens;
          }
          const choice = chunk.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) stopReason = mapStopReason(choice.finish_reason);

          const d = (choice as { delta?: Record<string, unknown> }).delta ?? {};
          const reasoning = d.reasoning_content;
          if (typeof reasoning === "string" && reasoning.length > 0) {
            if (openKind !== "thinking") {
              closeBlock();
              openBlock("thinking", { type: "thinking", thinking: "" });
            }
            delta(openIndex, { type: "thinking_delta", thinking: reasoning });
          }
          const content = d.content;
          if (typeof content === "string" && content.length > 0) {
            if (openKind !== "text") {
              closeBlock();
              openBlock("text", { type: "text", text: "" });
            }
            delta(openIndex, { type: "text_delta", text: content });
          }
          const toolCalls = d.tool_calls;
          if (Array.isArray(toolCalls)) {
            for (const raw of toolCalls as Array<Record<string, unknown>>) {
              const toolIndex = typeof raw.index === "number" ? raw.index : 0;
              const fn = (raw.function ?? {}) as Record<string, unknown>;
              let blockIndex = toolBlocks.get(toolIndex);
              if (blockIndex === undefined) {
                closeBlock();
                const name = typeof fn.name === "string" ? fn.name : "unknown_tool";
                const id =
                  typeof raw.id === "string" && raw.id.length > 0
                    ? raw.id
                    : `toolu_${randomUUID().replace(/-/g, "").slice(0, 20)}`;
                blockIndex = openBlock("tool", { type: "tool_use", id, name, input: {} });
                toolBlocks.set(toolIndex, blockIndex);
              }
              const args = fn.arguments;
              if (typeof args === "string" && args.length > 0) {
                delta(blockIndex, { type: "input_json_delta", partial_json: args });
              }
            }
          }
        }

        closeBlock();
        beginMessage();
        write(
          sse("message_delta", {
            type: "message_delta",
            delta: { stop_reason: stopReason, stop_sequence: null },
            usage: { input_tokens: inputTokens, output_tokens: outputTokens },
          }),
        );
        write(sse("message_stop", { type: "message_stop" }));
        controller.close();
      } catch (error) {
        try {
          write(
            sse("error", {
              type: "error",
              error: { type: "api_error", message: (error as Error).message },
            }),
          );
        } catch {
          // controller already closed
        }
        controller.close();
      }
    },
  });
}

export function registerAnthropicRoutes(app: Hono, deps: OpenAIRouteDeps): void {
  app.post("/v1/messages", async (c) => {
    if (!isAuthorized(c, deps)) {
      return openaiError("Missing or invalid API key.", 401, { code: "invalid_api_key" });
    }
    let body: AnthropicRequest;
    try {
      body = (await c.req.json()) as AnthropicRequest;
    } catch {
      return openaiError("Request body must be valid JSON.", 400);
    }
    if (typeof body.model !== "string" || body.model.length === 0) {
      return openaiError("`model` is required.", 400, { code: "missing_model" });
    }
    if (!Array.isArray(body.messages)) {
      return openaiError("`messages` must be an array.", 400, { code: "invalid_messages" });
    }

    const openaiBody = anthropicToOpenAI(body);
    // Empty tool results (or turns reduced to zero text) must be filled before
    // forwarding; see sanitizeOpenAIMessages in http.ts.
    openaiBody.messages = sanitizeOpenAIMessages(openaiBody.messages);
    const wantsStream = body.stream === true;

    const outcome = await callUpstreamWithFailover(deps, openaiBody, {
      taskId: randomUUID(),
      model: body.model,
      stream: wantsStream,
      ...(c.req.raw.signal ? { signal: c.req.raw.signal } : {}),
    });
    if (outcome.kind === "error") return outcome.response;

    const { response: upstream, accountId } = outcome;
    if (wantsStream && upstream.body) {
      return new Response(translateStreamToAnthropic(upstream.body, body.model), {
        status: 200,
        headers: { ...SSE_HEADERS, "x-account": accountId },
      });
    }

    const raw = await upstream.text();
    let completion: OpenAICompletion;
    try {
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      completion =
        parsed.success === true && parsed.data
          ? (parsed.data as OpenAICompletion)
          : (parsed as OpenAICompletion);
    } catch {
      return openaiError(`Upstream returned a non-JSON response: ${raw.slice(0, 200)}`, 502, {
        type: "upstream_error",
      });
    }
    return new Response(JSON.stringify(openAIToAnthropicMessage(completion, body.model)), {
      status: 200,
      headers: { "content-type": "application/json", "x-account": accountId },
    });
  });
}


