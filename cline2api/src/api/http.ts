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

/**
 * The address a request actually came from, for the request log.
 *
 * Behind the reverse proxy every request arrives from loopback, so the socket
 * address alone would log "127.0.0.1" for all traffic. Caddy appends the real
 * peer to `X-Forwarded-For`, which makes the *right-most* hop the one the proxy
 * observed and the earlier hops whatever the client claimed — so the right-most
 * is the only one worth recording. When the peer is not loopback the socket
 * address is authoritative and any XFF header is a client's own fiction.
 *
 * For logging only: nothing is authorized on this value. Admin authorization
 * has its own, stricter reading of the same headers in `admin.ts`.
 */
export function clientAddress(c: {
  env?: unknown;
  req: { header: (name: string) => string | undefined };
}): string | null {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  const socket = env?.incoming?.socket?.remoteAddress ?? null;
  const normalize = (value: string): string => {
    let address = value.trim();
    if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
    if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
    return address;
  };
  const forwarded = c.req
    .header("x-forwarded-for")
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);
  if (forwarded) return normalize(forwarded);
  return socket ? normalize(socket) : null;
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

/** Default idle ceiling for a stream that has gone completely silent. */
export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;

export interface StreamGuardOptions {
  /** Frames relayed to the client. */
  onChunk: (chunk: Uint8Array) => void;
  /**
   * Upstream closed without a terminal marker and `isComplete` says it never
   * sent one. Called instead of a silent close, so the client can tell a
   * finished answer from a broken one. Whatever bytes it returns are flushed as
   * the stream's final frame.
   */
  onIncomplete?: (reason: string) => Uint8Array | void;
  /** True once upstream has emitted its terminal marker (`[DONE]`). */
  isComplete: () => boolean;
  /** True once the client has gone; suppresses the incomplete report. */
  isClientGone?: () => boolean;
  /** How long silence may last before the stream is failed. 0 disables. */
  idleTimeoutMs?: number;
  /** Called when the client goes away, so upstream can be detached too. */
  onClientClose?: () => void;
}

/**
 * Tracks whether an OpenAI-style SSE body has emitted its `[DONE]` marker.
 *
 * Fed the same bytes that go to the client; keeps only a short tail, because
 * the marker can straddle a chunk boundary.
 */
export function doneMarkerTracker(): { push: (chunk: Uint8Array) => void; seen: () => boolean } {
  const decoder = new TextDecoder();
  let tail = "";
  let seen = false;
  return {
    push(chunk) {
      if (seen) return;
      tail += decoder.decode(chunk, { stream: true });
      if (tail.includes("[DONE]")) {
        seen = true;
        tail = "";
        return;
      }
      // Enough to catch a marker split across two chunks.
      if (tail.length > 32) tail = tail.slice(-32);
    },
    seen: () => seen,
  };
}

export interface IdleWatchdog {
  /**
   * Resolves `"idle"` once the timeout fires; `"stop"` only if `stop()` is
   * called first. Losing the race is harmless — the caller is expected to keep
   * awaiting the work it raced against.
   */
  readonly signal: Promise<"idle" | "stop">;
  /** Restart the countdown, for callers that only want idle *gaps* timed. */
  arm: () => void;
  /** Stop watching; the signal resolves `"stop"` and never fires again. */
  stop: () => void;
}

/**
 * A deadline that callers race against their own reads.
 *
 * Separate from `guardUpstreamStream` because the translating surfaces parse
 * the stream themselves and cannot hand the relay a plain `onChunk`. `arm()` is
 * what makes it an *idle* timeout on those surfaces: it is refreshed after
 * every upstream line, so a thinking pause is only fatal once it exceeds the
 * limit, not merely because the answer is long.
 */
export function idleWatchdog(timeoutMs: number): IdleWatchdog {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle: (reason: "idle" | "stop") => void = () => undefined;
  let settled = false;
  const signal = new Promise<"idle" | "stop">((resolve) => {
    settle = (reason) => {
      if (settled) return;
      settled = true;
      resolve(reason);
    };
  });
  // Never holds the process open, and never rejects.
  signal.catch(() => undefined);

  const arm = (): void => {
    if (settled) return;
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => settle("idle"), timeoutMs);
    timer.unref?.();
  };
  if (timeoutMs > 0) arm();

  return {
    signal,
    arm,
    stop: () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
      settle("stop");
    },
  };
}

/**
 * Relay an upstream SSE body to the client with the three guards a raw
 * passthrough lacks.
 *
 * The failure this exists for is a stream that ends without its terminal
 * marker: upstream drops the connection mid-answer (a provider-side 400, an
 * edge timeout), the raw body simply ends, and the client sees a truncated
 * response with no explanation — surfaced by typed SSE consumers as
 * "stream closed before response.completed".
 *
 *   1. Idle watchdog: no bytes for `idleTimeoutMs` aborts upstream and ends the
 *      stream, instead of holding a dead connection open until the client's
 *      own timeout. Long *thinking* pauses are not idle — the loop keeps
 *      emitting keep-alive comments, which reset any intermediary's timers.
 *   2. Completeness check: a close without the terminal marker is reported
 *      through `onIncomplete` rather than passed off as success.
 *   3. Cancellation: a client abort cancels the upstream body, which aborts the
 *      upstream request, so the gateway stops paying for a stream nobody reads.
 */
export function guardUpstreamStream(
  body: ReadableStream<Uint8Array>,
  options: StreamGuardOptions,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const idleMs = options.idleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;

      // Resolved by the watchdog only; never rejects, so it is safe to lose the
      // race and leave the losing read to settle on its own.
      let resolveIdle: () => void = () => undefined;
      const idle = new Promise<"idle">((resolve) => {
        resolveIdle = () => resolve("idle");
      });
      const timer = idleMs > 0
        ? setInterval(() => {
            resolveIdle();
            // Abort upstream's own request rather than merely dropping the
            // reader: a connection that has stopped delivering is no use.
            void reader.cancel("stream idle timeout").catch(() => undefined);
          }, idleMs)
        : null;
      timer?.unref?.();

      const stopTimer = (): void => {
        if (timer !== null) clearInterval(timer);
      };
      const emit = (bytes: Uint8Array | void): void => {
        if (!bytes) return;
        try {
          controller.enqueue(bytes);
        } catch {
          // Client already gone.
        }
      };
      const close = (): void => {
        stopTimer();
        try {
          controller.close();
        } catch {
          // Already closed, or cancelled by the client adapter.
        }
      };

      try {
        for (;;) {
          const raced = await Promise.race([
            reader.read().then(
              (result) => ({ kind: "read" as const, result }),
              (error: unknown) => ({ kind: "error" as const, error }),
            ),
            idle,
          ]);

          if (raced === "idle") {
            const seconds = Math.round(idleMs / 1000);
            const reason = `upstream idle for ${seconds}s`;
            if (options.isComplete()) {
              // Nothing more is coming, but the answer itself finished; a
              // comment line closes it without looking like a failure.
              emit(encoder.encode("\n\n: upstream idle; closing\n\n"));
            } else {
              emit(
                encoder.encode(
                  `data: ${JSON.stringify({
                    error: {
                      message: `Upstream sent nothing for ${seconds}s; closing the stream.`,
                      type: "upstream_timeout",
                    },
                  })}\n\n`,
                ),
              );
            }
            emit(options.onIncomplete?.(reason));
            close();
            return;
          }
          if (raced.kind === "error") throw raced.error;

          const { done, value } = raced.result;
          if (done) break;
          if (value) {
            // Relay first, then observe: a client that disconnects mid-enqueue
            // still leaves the tracker agreeing with what actually went out.
            controller.enqueue(value);
            options.onChunk(value);
          }
        }

        if (!options.isComplete() && options.isClientGone?.() !== true) {
          emit(options.onIncomplete?.("upstream closed before the terminal marker"));
        }
        close();
      } catch (error) {
        if (options.isClientGone?.() !== true) {
          emit(options.onIncomplete?.(`upstream stream error: ${(error as Error).message}`));
        }
        close();
      } finally {
        stopTimer();
        try {
          reader.releaseLock();
        } catch {
          // Reader already settled by cancel(); nothing to release.
        }
      }
    },
    cancel(reason) {
      options.onClientClose?.();
      void body.cancel(reason).catch(() => undefined);
    },
  });
}

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
