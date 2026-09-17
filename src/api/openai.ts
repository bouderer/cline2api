/**
 * OpenAI-compatible surface: GET /v1/models and POST /v1/chat/completions.
 *
 * Upstream already speaks OpenAI chat-completions and returns a plain OpenAI
 * SSE stream (verified against the official VCR cassette
 * cline-anthropic-sonnet.json), so streaming is passed through byte-for-byte
 * and non-streaming bodies are only unwrapped if upstream wraps them in
 * `{success,data}`.
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
import { callUpstreamWithFailover } from "../services/proxyChat.js";
import { SSE_HEADERS, extractApiKey, openaiError, safeEqual, sanitizeOpenAIMessages } from "./http.js";

export interface OpenAIRouteDeps {
  config: AppConfig;
  logger: Logger;
  catalog: ModelCatalog;
  store: AccountStore;
  pool: AccountPool;
  tokens: TokenManager;
  /** Rolling request log shown in the admin UI. */
  requests?: RequestLog;
}

/**
 * Both API surfaces share this check: OpenAI clients send `Authorization:
 * Bearer`, Anthropic-native ones (Claude Code included) send `x-api-key`.
 */
export function isAuthorized(c: Context, deps: { config: AppConfig }): boolean {
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
    return chatCompletion(c, deps);
  });
}

/**
 * Body of a chat completion, shared by `/v1/chat/completions` (client key auth)
 * and the admin playground (`/admin/api/chat`, admin auth) so the two cannot
 * drift apart. Callers are responsible for authenticating first.
 */
export async function chatCompletion(c: Context, deps: OpenAIRouteDeps): Promise<Response> {
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
    ...(c.req.raw.signal ? { signal: c.req.raw.signal } : {}),
  });
  if (outcome.kind === "error") return outcome.response;

  const { response: upstream, accountId } = outcome;
  if (wantsStream) {
    return new Response(upstream.body, {
      status: 200,
      headers: { ...SSE_HEADERS, "x-account": accountId },
    });
  }

  const raw = await upstream.text();
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

