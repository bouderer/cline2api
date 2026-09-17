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

/** SSE headers that keep intermediaries from buffering the stream. */
export const SSE_HEADERS: Record<string, string> = {
  "content-type": "text/event-stream; charset=utf-8",
  "cache-control": "no-cache, no-transform",
  connection: "keep-alive",
  "x-accel-buffering": "no",
};
