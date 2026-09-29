/**
 * OpenAI-compatible surface: GET /v1/models and POST /v1/chat/completions.
 *
 * Upstream already speaks OpenAI chat-completions and returns a plain OpenAI
 * SSE stream (verified against the official VCR cassette
 * cline-anthropic-sonnet.json), so streaming is relayed byte-for-byte and
 * non-streaming bodies are only unwrapped if upstream wraps them in
 * `{success,data}`. "Byte-for-byte" is the payload contract: the relay may
 * still append a terminal error frame when upstream never sent its own
 * terminator — see `guardedOpenAIStream`.
 */
import { randomUUID } from "node:crypto";
import type { Context, Hono } from "hono";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { ModelCatalog } from "../cline/models.js";
import type { AccountStore } from "../store.js";
import type { AccountPool } from "../services/accountPool.js";
import type { RequestLog } from "../services/requestLog.js";
import type { TokenManager } from "../cline/tokenManager.js";
import type { ApiKeyManager } from "../services/apiKeys.js";
import { callUpstreamWithFailover } from "../services/proxyChat.js";
import type { CapabilityIndex } from "../services/accountCapabilities.js";
import { captureUsage, recordJsonUsage } from "../services/usageCapture.js";
import {
  SSE_HEADERS,
  doneMarkerTracker,
  extractApiKey,
  guardUpstreamStream,
  openaiError,
  safeEqual,
  sanitizeOpenAIMessages,
  clientAddress,
} from "./http.js";

export interface OpenAIRouteDeps {
  config: AppConfig;
  logger: Logger;
  catalog: ModelCatalog;
  store: AccountStore;
  pool: AccountPool;
  tokens: TokenManager;
  apiKeys: ApiKeyManager;
  /** Rolling request log shown in the admin UI. */
  requests?: RequestLog;
  /**
   * Which accounts hold which plan. Present, a Pass-only model is routed at the
   * accounts that hold Pass rather than offered to the pool in round-robin
   * order; see the capability index for why that matters on a large pool.
   */
  capabilities?: CapabilityIndex;
}

/**
 * Both API surfaces share this check: OpenAI clients send `Authorization:
 * Bearer`, Anthropic-native ones (Claude Code included) send `x-api-key`.
 *
 * Matching runs against the on-disk key table, not the env config, and it
 * records last-use so the admin UI can show which key each client actually
 * uses. Reads and writes are per-request with no key cache, so a key disabled
 * in the admin UI stops working immediately.
 */
export function isAuthorized(c: Context, deps: { apiKeys: ApiKeyManager }): boolean {
  const provided = extractApiKey(c.req.header("authorization"), c.req.header("x-api-key"));
  if (!provided) return false;
  return deps.apiKeys.matches(provided) !== null;
}

/**
 * Same check, recording which model the key was used for.
 *
 * Called after the request has been validated, so the recorded model is the
 * one that was actually served rather than whatever the client typed.
 */
export function recordKeyUse(deps: { apiKeys: ApiKeyManager }, c: Context, model: string): void {
  const provided = extractApiKey(c.req.header("authorization"), c.req.header("x-api-key"));
  if (!provided) return;
  deps.apiKeys.verify(provided, model);
}

/** Backwards-compatible helper for routes constructed without a key manager. */
export function isAuthorizedByConfig(c: Context, deps: { config: AppConfig }): boolean {
  const provided = extractApiKey(c.req.header("authorization"), c.req.header("x-api-key"));
  if (!provided) return false;
  return deps.config.proxyApiKeys.some((key) => safeEqual(provided, key));
}

interface ChatBody {
  model?: unknown;
  messages?: unknown;
  stream?: unknown;
  stream_options?: unknown;
  [key: string]: unknown;
}

/** Unwrap `{success:true,data:...}` when present; otherwise return as-is. */
export function unwrapEnvelope(payload: unknown): unknown {
  if (
    payload !== null &&
    typeof payload === "object" &&
    !Array.isArray(payload) &&
    (payload as { success?: unknown }).success === true &&
    "data" in (payload as Record<string, unknown>)
  ) {
    return (payload as Record<string, unknown>).data;
  }
  return payload;
}

export function registerOpenAIRoutes(app: Hono, deps: OpenAIRouteDeps): void {
  app.get("/v1/models", async (c) => {
    if (!isAuthorized(c, deps)) {
      return openaiError("Missing or invalid API key.", 401, { code: "invalid_api_key" });
    }
    const entries = await deps.catalog.list();
    return c.json({ object: "list", data: ModelCatalog.toOpenAIModels(entries) });
  });

  app.post("/v1/chat/completions", async (c) => {
    if (!isAuthorized(c, deps)) {
      return openaiError("Missing or invalid API key.", 401, { code: "invalid_api_key" });
    }
    return chatCompletion(c, deps, { recordKeyUse: true });
  });
}

/**
 * Body of a chat completion, shared by `/v1/chat/completions` (client key auth)
 * and the admin playground (`/admin/api/chat`, admin auth) so the two cannot
 * drift apart. Callers are responsible for authenticating first.
 */
export async function chatCompletion(
  c: Context,
  deps: OpenAIRouteDeps,
  options: { recordKeyUse?: boolean } = {},
): Promise<Response> {
  let body: ChatBody;
  try {
    body = (await c.req.json()) as ChatBody;
  } catch {
    return openaiError("Request body must be valid JSON.", 400);
  }
  if (typeof body.model !== "string" || body.model.length === 0) {
    return openaiError("`model` is required.", 400, { code: "missing_model" });
  }
  if (!Array.isArray(body.messages)) {
    return openaiError("`messages` must be an array.", 400, { code: "invalid_messages" });
  }

  const wantsStream = body.stream === true;
  // Tool-harness clients routinely send empty content on the message that
  // carries tool results (or even on plain turns); several upstreams 400 on
  // that, killing the stream right after a tool call returns. Fill before
  // forwarding. Runs on `body` (not the stream-augmented copy) so both share it.
  body.messages = sanitizeOpenAIMessages(body.messages);
  const upstreamBody = wantsStream
    ? {
        ...body,
        stream_options: {
          include_usage: true,
          ...(typeof body.stream_options === "object" && body.stream_options !== null
            ? (body.stream_options as Record<string, unknown>)
            : {}),
        },
      }
    : body;

  const outcome = await callUpstreamWithFailover(deps, upstreamBody, {
    taskId: randomUUID(),
    model: body.model,
    stream: wantsStream,
    clientIp: clientAddress(c),
    ...(c.req.raw.signal ? { signal: c.req.raw.signal } : {}),
  });
  if (outcome.kind === "error") return outcome.response;
  // Authenticated with the client key, so this is genuine usage of that key —
  // unlike the admin playground, which authenticates with the admin token.
  if (options.recordKeyUse) recordKeyUse(deps, c, body.model);

  const { response: upstream, accountId, recordUsage } = outcome;
  if (wantsStream && upstream.body) {
    return new Response(guardedOpenAIStream(c, deps, captureUsage(upstream.body, recordUsage), body.model), {
      status: 200,
      headers: { ...SSE_HEADERS, "x-account": accountId },
    });
  }

  const raw = await upstream.text();
  recordJsonUsage(raw, recordUsage);
  try {
    const parsed = unwrapEnvelope(JSON.parse(raw));
    return new Response(JSON.stringify(parsed), {
      status: 200,
      headers: { "content-type": "application/json", "x-account": accountId },
    });
  } catch {
    return new Response(raw, {
      status: 200,
      headers: {
        "content-type": upstream.headers.get("content-type") ?? "application/json",
        "x-account": accountId,
      },
    });
  }
}

/**
 * Fold an SSE chat-completions stream into a single completion object, for
 * callers that asked for JSON but whose request was provider-pinned into a
 * stream (a pinned free provider may only speak SSE). Token counts come from
 * the terminal usage chunk when it arrives — the stream runs through
 * `captureUsage`, so the ledger sees the same numbers as a streamed client.
 */
export async function collectCompletionFromStream(
  body: ReadableStream<Uint8Array>,
  recordUsage: (usage: { promptTokens: number; completionTokens: number; cachedTokens: number; totalTokens: number }) => void,
  model: string,
): Promise<Record<string, unknown> | null> {
  const decoder = new TextDecoder();
  const reader = captureUsage(body, recordUsage).getReader();
  let buffer = "";
  let id: string | null = null;
  let created: number | null = null;
  const contentParts: string[] = [];
  const reasoningParts: string[] = [];
  let finishReason: string | null = null;
  let sawChunk = false;

  const handleEvent = (data: string): void => {
    if (data === "[DONE]") return;
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (typeof payload !== "object" || payload === null) return;
    const record = payload as Record<string, unknown>;
    if (typeof record.id === "string") id = record.id;
    if (typeof record.created === "number") created = record.created;
    const choices = Array.isArray(record.choices) ? record.choices : [];
    for (const choice of choices) {
      if (typeof choice !== "object" || choice === null) continue;
      const delta = (choice as Record<string, unknown>).delta;
      if (typeof delta === "object" && delta !== null) {
        const d = delta as Record<string, unknown>;
        if (typeof d.content === "string") contentParts.push(d.content);
        if (typeof d.reasoning === "string") reasoningParts.push(d.reasoning);
        else if (typeof d.reasoning_content === "string") reasoningParts.push(d.reasoning_content);
      }
      const fr = (choice as Record<string, unknown>).finish_reason;
      if (typeof fr === "string") finishReason = fr;
    }
    sawChunk = true;
  };

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 2);
      for (const line of frame.split("\n")) {
        if (line.startsWith("data:")) handleEvent(line.slice(5).trim());
      }
    }
  }
  if (!sawChunk || id === null) return null;

  const message: Record<string, unknown> = {
    role: "assistant",
    content: contentParts.join(""),
  };
  if (reasoningParts.length > 0) message.reasoning = reasoningParts.join("");
  return {
    id,
    object: "chat.completion",
    created: created ?? Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message,
        finish_reason: finishReason ?? "stop",
      },
    ],
  };
}

/**
 * Upstream's OpenAI SSE, relayed with the incompleteness guards from http.ts.
 *
 * The body used to be passed through untouched, which meant a connection that
 * dropped mid-answer reached the client as a stream that simply ended: no
 * error, no `[DONE]`. A strict SSE consumer reports that as a disconnect with
 * nothing to show, and any client that trusts the stream treats a truncated
 * answer as a finished one.
 *
 * The bytes still go out unmodified — this only watches whether the terminal
 * marker ever arrived, and appends an error frame in its place when it did not.
 */
function guardedOpenAIStream(
  c: Context,
  deps: OpenAIRouteDeps,
  upstreamBody: ReadableStream<Uint8Array>,
  model: string,
): ReadableStream<Uint8Array> {
  const done = doneMarkerTracker();
  const encoder = new TextEncoder();
  const clientGone = (): boolean => c.req.raw.signal.aborted;

  return guardUpstreamStream(upstreamBody, {
    onChunk: (chunk) => done.push(chunk),
    isComplete: () => done.seen(),
    isClientGone: clientGone,
    idleTimeoutMs: deps.config.streamIdleTimeoutMs,
    onIncomplete: (reason) => {
      deps.logger.warn("upstream stream ended without a terminal marker", { model, reason });
      if (clientGone()) return;
      // Runs in place of the missing `[DONE]`, so a client reading the stream
      // sees why the answer stopped instead of a bare truncation.
      return encoder.encode(
        `data: ${JSON.stringify({
          error: {
            message: `Upstream stream ended before completion (${reason}); the response above may be truncated.`,
            type: "upstream_stream_incomplete",
          },
        })}\n\n`,
      );
    },
  });
}

