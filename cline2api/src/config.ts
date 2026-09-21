/**
 * Runtime configuration. Everything is environment-driven so that no secret
 * ever has to live in the repository.
 */
import path from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface AppConfig {
  readonly host: string;
  readonly port: number;
  readonly dataDir: string;
  /**
   * Client API keys as configured in the environment.
   *
   * These are a *seed*, not the table of record: on boot each value is
   * imported into the on-disk key store and authentication reads from the
   * store. Keeping the config field means existing deployments keep working
   * with no action — the first boot imports what they already have.
   */
  readonly proxyApiKeys: readonly string[];
  readonly adminToken: string | null;
  /** Upstream Cline API origin, e.g. https://api.cline.bot */
  readonly clineApiBaseUrl: string;
  /** WorkOS API origin, e.g. https://api.workos.com */
  readonly workosApiBaseUrl: string;
  /** WorkOS OAuth client id used by the official Cline environment. */
  readonly workOsClientId: string;
  readonly requestTimeoutMs: number;
  /** Refresh this long before the access token expires (default 5 min). */
  readonly refreshBufferMs: number;
  /** Keep a still-valid token if a refresh fails transiently within this grace. */
  readonly retryableTokenGraceMs: number;
  /** Headers the official SDK sends; upstream may gate on these. */
  readonly clientName: string;
  readonly clientVersion: string;
  readonly platform: string;
  readonly platformVersion: string;
  readonly coreVersion: string;
  readonly modelCacheTtlMs: number;
  readonly logLevel: LogLevel;
}

const LEVELS: readonly LogLevel[] = ["debug", "info", "warn", "error"];

function readString(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name];
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = readString(env, name);
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function readLogLevel(env: NodeJS.ProcessEnv): LogLevel {
  const raw = readString(env, "LOG_LEVEL")?.toLowerCase();
  return LEVELS.includes(raw as LogLevel) ? (raw as LogLevel) : "info";
}

function stripTrailingSlash(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

/**
 * Client API keys as configured in the environment.
 *
 * No minting anymore: an empty PROXY_API_KEY simply means "nothing is
 * seeded from the environment". The on-disk key store mints its own key on
 * first boot if there is nothing to import, which covers the same cold-start
 * case without coupling key generation to config loading.
 */
function resolveProxyApiKeys(env: NodeJS.ProcessEnv): string[] {
  return (readString(env, "PROXY_API_KEY") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const dataDir = path.resolve(readString(env, "DATA_DIR") ?? "./data");
  return {
    host: readString(env, "HOST") ?? "127.0.0.1",
    port: readInt(env, "PORT", 8787),
    dataDir,
    proxyApiKeys: resolveProxyApiKeys(env),
    adminToken: readString(env, "ADMIN_TOKEN") ?? null,
    clineApiBaseUrl: stripTrailingSlash(
      readString(env, "CLINE_API_BASE_URL") ?? "https://api.cline.bot",
    ),
    workosApiBaseUrl: stripTrailingSlash(
      readString(env, "WORKOS_API_BASE_URL") ?? "https://api.workos.com",
    ),
    workOsClientId:
      readString(env, "WORKOS_CLIENT_ID") ??
      "client_01K3A541FN8TA3EPPHTD2325AR",
    requestTimeoutMs: readInt(env, "REQUEST_TIMEOUT_MS", 30_000),
    refreshBufferMs: readInt(env, "REFRESH_BUFFER_MS", 5 * 60 * 1000),
    retryableTokenGraceMs: readInt(env, "RETRYABLE_TOKEN_GRACE_MS", 30_000),
    clientName: readString(env, "CLINE_CLIENT_NAME") ?? "cline-sdk",
    clientVersion: readString(env, "CLINE_CLIENT_VERSION") ?? "3.0.62",
    platform: readString(env, "CLINE_PLATFORM") ?? process.platform,
    platformVersion: readString(env, "CLINE_PLATFORM_VERSION") ?? "unknown",
    coreVersion: readString(env, "CLINE_CORE_VERSION") ?? "0.0.83",
    modelCacheTtlMs: readInt(env, "MODEL_CACHE_TTL_MS", 5 * 60 * 1000),
    logLevel: readLogLevel(env),
  };
}
