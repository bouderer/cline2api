/**
 * Every constant in this file is taken from the official Cline sources rather
 * than guessed:
 *
 *  - sdk/packages/core/src/auth/cline.ts      (auth endpoints + flow)
 *  - sdk/packages/shared/.../cline-environment.ts (production environment)
 *  - sdk/packages/llms/src/providers/request-headers.ts (required headers)
 *  - sdk/packages/llms/src/providers/vendors/cline.ts (base URL)
 *
 * The device-code endpoint was additionally verified live against WorkOS.
 */

/** Relative to CLINE_API_BASE_URL. */
export const CLINE_AUTH_ENDPOINTS = {
  authorize: "/api/v1/auth/authorize",
  token: "/api/v1/auth/token",
  register: "/api/v1/auth/register",
  refresh: "/api/v1/auth/refresh",
} as const;

/** Relative to WORKOS_API_BASE_URL. */
export const WORKOS_ENDPOINTS = {
  deviceAuthorization: "/user_management/authorize/device",
  authenticate: "/user_management/authenticate",
} as const;

/** Production environment block from @cline/shared CLINE_ENVIRONMENTS. */
export const CLINE_PRODUCTION_ENV = {
  appBaseUrl: "https://app.cline.bot",
  apiBaseUrl: "https://api.cline.bot",
  workOsClientId: "client_01K3A541FN8TA3EPPHTD2325AR",
} as const;

export const DEFAULT_WORKOS_API_BASE_URL = "https://api.workos.com";

/** Chat + catalog live under this prefix (cline.ts: baseUrl ?? .../api/v1). */
export const CLINE_API_V1_PATH = "/api/v1";
export const CLINE_CHAT_PATH = "/api/v1/chat/completions";
export const CLINE_MODELS_PATH = "/api/v1/models";

/** Stored/transport access tokens carry this prefix (cline.ts: t9 = "workos:"). */
export const WORKOS_TOKEN_PREFIX = "workos:";

export const DEVICE_GRANT_TYPE =
  "urn:ietf:params:oauth:grant-type:device_code";

/**
 * Headers the official SDK attaches to cline/cline-pass requests. Upstream
 * returns a generic 401 ("make sure you're using the latest version of Cline")
 * when the caller is not recognised, so we mirror them exactly.
 */
export function defaultClineHeaders(input: {
  clientName: string;
  clientVersion: string;
  platform: string;
  platformVersion: string;
  coreVersion: string;
  taskId: string;
  multiRoot?: boolean;
}): Record<string, string> {
  return {
    "HTTP-Referer": "https://cline.bot",
    "X-Title": "Cline",
    "User-Agent": `Cline/${input.clientVersion}`,
    "X-IS-MULTIROOT": input.multiRoot === true ? "true" : "false",
    "X-CLIENT-TYPE": input.clientName,
    "X-CLIENT-VERSION": input.clientVersion,
    "X-PLATFORM": input.platform,
    "X-PLATFORM-VERSION": input.platformVersion,
    "X-CORE-VERSION": input.coreVersion,
    "X-Task-ID": input.taskId,
  };
}

/** Fallback catalog used only when the live /api/v1/models call fails. */
export const FALLBACK_MODEL_IDS: readonly string[] = [
  "anthropic/claude-sonnet-4.6",
  "anthropic/claude-fable-5.1",
  "openai/gpt-6-astra",
  "openai/gpt-6-astra-pro",
  "google/gemini-3.8-flash",
  "z-ai/glm-5.3-flash",
  "deepseek/deepseek-v4.1-flash",
  "qwen/qwen3.8-max-0902",
  "moonshotai/kimi-k3",
  "meta/muse-spark-1.3",
  "minimax/minimax-m3",
  "x-ai/grok-4.6",
];
