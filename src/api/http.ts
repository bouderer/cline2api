/** Shared HTTP helpers: OpenAI-shaped errors and timing-safe key checks. */
import { timingSafeEqual } from "node:crypto";

export interface ApiErrorBody {
  error: {
    message: string;
    type: string;
    code?: string;
  };
}

export function openaiError(
  message: string,
  status: number,
  options: { type?: string; code?: string; extraHeaders?: Record<string, string> } = {},
): Response {
  const body: ApiErrorBody = {
    error: {
      message,
      type: options.type ?? (status >= 500 ? "server_error" : "invalid_request_error"),
      ...(options.code ? { code: options.code } : {}),
    },
  };
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...(options.extraHeaders ?? {}) },
  });
}

export function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

export function extractBearer(header: string | null | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() ?? null;
}

/**
 * Client credential from either header style: `Authorization: Bearer` is what
 * OpenAI SDKs send, `x-api-key` is what Anthropic-native clients (Claude Code,
 * the Anthropic SDK) send. Bearer wins when both are present.
 */
export function extractApiKey(
  authorization: string | null | undefined,
  xApiKey: string | null | undefined,
): string | null {
  const bearer = extractBearer(authorization);
  if (bearer) return bearer;
  const key = xApiKey?.trim();
  return key ? key : null;
}

/** SSE headers that keep intermediaries from buffering the stream. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};

/**
 * Reasoning text carried by an OpenAI-style message or delta, if any.
 *
 * The field name is not consistent across the providers behind Cline: its
 * gateway sends `reasoning`, while DeepSeek-style clients and several other
 * providers send `reasoning_content`. Both are the model's thinking, and both
 * belong in an Anthropic `thinking` block or a Responses `reasoning` item —
 * which is otherwise silently dropped, since neither API has that field.
 */
export function readReasoning(message: unknown): string | null {
  if (typeof message !== "object" || message === null) return null;
  const record = message as Record<string, unknown>;
  for (const field of ["reasoning_content", "reasoning"]) {
    const value = record[field];
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}

/**
 * Placeholder used when a message would otherwise carry no text at all.
 * Several upstreams (Vercel AI Gateway included) reject empty message content
 * with 400 (`user message must have content`), which surfaces to clients as a
 * stream that dies right after a tool call returns. A short placeholder keeps
 * the turn structure intact instead of dropping the message.
 */
export const EMPTY_TOOL_OUTPUT_PLACEHOLDER = "(tool returned no text output)";
export const EMPTY_MESSAGE_PLACEHOLDER = "(empty content)";
/** Reply synthesized for a tool call the client never answered. */
export const NO_TOOL_ANSWER_PLACEHOLDER = "(no tool output returned)";

function sanitizePart(part: unknown, toolOutput: boolean): Record<string, unknown> | null {
  if (typeof part !== "object" || part === null) return null;
  const p = part as Record<string, unknown>;
  if (p.type === "text") {
    if (typeof p.text === "string" && p.text.trim().length > 0) return { type: "text", text: p.text };
    return null;
  }
  // image_url parts and anything else pass through untouched.
  return { ...p };
}

/**
 * Ensure every OpenAI-style message carries non-empty content, and that every
 * `tool_calls` group is answered immediately by one `tool` message per id.
 *
 * Runs on both ingress paths (direct OpenAI clients and the Anthropic
 * translator) right before the body is forwarded upstream. Two failure modes
 * this exists for, both seen live against the Vercel gateway:
 *
 *  1. `messages.N.content must not be empty` — harnesses routinely send an
 *     empty `tool_result`, or a turn whose only text block is empty.
 *  2. `An assistant message with 'tool_calls' must be followed by tool messages
 *     responding to each 'tool_call_id'` / `incomplete parallel tool-call
 *     group` — a parallel tool call went unanswered (the client dropped one, or
 *     the user interrupted), or the answers are not adjacent to the assistant
 *     turn. Anthropic content blocks arrive in whatever order the client chose,
 *     so the translator can emit user text between the two.
 */
export function sanitizeOpenAIMessages(messages: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(messages)) return [];
  return groupToolAnswers(normalizeMessageContent(messages));
}

/** Fill empty content so no message reaches upstream blank. */
function normalizeMessageContent(messages: unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const raw of messages) {
    if (typeof raw !== "object" || raw === null) continue;
    const message = { ...(raw as Record<string, unknown>) };
    const role = message.role;
    const hasToolCalls =
      Array.isArray(message.tool_calls) && (message.tool_calls as unknown[]).length > 0;

    const content = message.content;
    if (typeof content === "string") {
      if (content.trim().length === 0) {
        if (role === "assistant" && hasToolCalls) {
          // OpenAI-valid: an assistant turn that only makes tool calls.
          message.content = null;
        } else {
          message.content = role === "tool" ? EMPTY_TOOL_OUTPUT_PLACEHOLDER : EMPTY_MESSAGE_PLACEHOLDER;
        }
      }
    } else if (Array.isArray(content)) {
      const toolOutput = role === "tool";
      const kept = (content as unknown[])
        .map((part) => sanitizePart(part, toolOutput))
        .filter((part): part is Record<string, unknown> => part !== null);
      if (kept.length === 0) {
        if (role === "assistant" && hasToolCalls) {
          message.content = null;
        } else {
          message.content = [
            { type: "text", text: toolOutput ? EMPTY_TOOL_OUTPUT_PLACEHOLDER : EMPTY_MESSAGE_PLACEHOLDER },
          ];
        }
      } else {
        message.content = kept;
      }
    } else if (content === null || content === undefined) {
      if (!(role === "assistant" && hasToolCalls)) {
        message.content = role === "tool" ? EMPTY_TOOL_OUTPUT_PLACEHOLDER : EMPTY_MESSAGE_PLACEHOLDER;
      }
    }
    out.push(message);
  }
  return out;
}

/**
 * Make every `tool_calls` group contiguous and complete: unanswered calls get
 * a synthesized `tool` reply, and answers that drifted away are pulled up next
 * to their assistant message. Everything else keeps its relative order.
 */
function groupToolAnswers(
  messages: Array<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const answerById = new Map<string, Record<string, unknown>>();
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const id = message.tool_call_id;
    if (typeof id === "string" && !answerById.has(id)) answerById.set(id, message);
  }

  const out: Array<Record<string, unknown>> = [];
  const emitted = new Set<Record<string, unknown>>();
  for (const message of messages) {
    if (message.role === "tool") {
      // Already emitted as part of its group, or it is the one we pull forward.
      if (emitted.has(message)) continue;
      const id = message.tool_call_id;
      const owner = typeof id === "string" ? answerById.get(id) : undefined;
      if (owner !== undefined && owner !== message && emitted.has(owner)) continue;
      out.push(message);
      emitted.add(message);
      continue;
    }

    out.push(message);
    if (message.role !== "assistant" || !Array.isArray(message.tool_calls)) continue;

    for (const call of message.tool_calls as Array<Record<string, unknown>>) {
      const id = call?.id;
      if (typeof id !== "string" || id.length === 0) continue;
      const answer = answerById.get(id);
      if (answer === undefined) {
        // Providers reject the whole request when a call goes unanswered.
        out.push({ role: "tool", tool_call_id: id, content: NO_TOOL_ANSWER_PLACEHOLDER });
        continue;
      }
      if (!emitted.has(answer)) {
        out.push(answer);
        emitted.add(answer);
      }
    }
  }
  return out;
}
