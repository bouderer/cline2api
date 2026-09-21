/** Structured logger that never emits credential material. */
import type { LogLevel } from "./config.js";

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const SECRET_KEYS = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api[-_]?key|access[-_]?token|refresh[-_]?token|token|password|secret|code|device_code|user_code)$/i;
const JWT_LIKE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g;
const PREFIXED_SECRET = /\b(?:sk|rk|pk|workos)[-_:][A-Za-z0-9._-]{12,}\b/gi;
const BEARER = /\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const EMAIL = /\b([A-Za-z0-9._%+-]{1,64})@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b/g;

export function redactEmail(value: string): string {
  return value.replace(EMAIL, (_match, local: string, domain: string) => {
    const head = local.slice(0, 2);
    return `${head}${"*".repeat(Math.max(1, Math.min(local.length - head.length, 6)))}@${domain}`;
  });
}

export function redactString(value: string, extraSecrets: readonly string[] = []): string {
  let out = value.replace(BEARER, "Bearer <REDACTED>");
  out = out.replace(PREFIXED_SECRET, "<REDACTED>");
  out = out.replace(JWT_LIKE, "<REDACTED>");
  out = redactEmail(out);
  for (const secret of extraSecrets) {
    if (secret.length >= 6) out = out.split(secret).join("<REDACTED>");
  }
  return out;
}

export function redactValue(value: unknown, extraSecrets: readonly string[] = [], depth = 0): unknown {
  if (depth > 6) return "<TRUNCATED>";
  if (typeof value === "string") return redactString(value, extraSecrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactValue(item, extraSecrets, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    out[key] = SECRET_KEYS.test(key) ? "<REDACTED>" : redactValue(child, extraSecrets, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(message: string, meta?: unknown): void;
  info(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, meta?: unknown): void;
  child(extraSecrets: readonly string[]): Logger;
}

export function createLogger(level: LogLevel, secrets: readonly string[] = []): Logger {
  const threshold = RANK[level];
  const emit = (at: LogLevel, message: string, meta?: unknown, extra: readonly string[] = []): void => {
    if (RANK[at] < threshold) return;
    const line = `${new Date().toISOString()} ${at.toUpperCase().padEnd(5)} ${redactString(message, [...secrets, ...extra])}`;
    const sink = at === "error" ? console.error : at === "warn" ? console.warn : console.log;
    if (meta === undefined) sink(line);
    else sink(line, JSON.stringify(redactValue(meta, [...secrets, ...extra])));
  };
  return {
    debug: (m, meta) => emit("debug", m, meta),
    info: (m, meta) => emit("info", m, meta),
    warn: (m, meta) => emit("warn", m, meta),
    error: (m, meta) => emit("error", m, meta),
    child: (extraSecrets) => createLogger(level, [...secrets, ...extraSecrets]),
  };
}
