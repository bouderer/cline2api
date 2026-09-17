/**
 * Cline authentication: WorkOS device-code login, token registration, refresh
 * and the "resolve valid credentials" contract.
 *
 * Behaviour mirrors sdk/packages/core/src/auth/cline.ts from the official repo,
 * including the error taxonomy that callers depend on:
 *
 *   - returns `null` ONLY when the refresh token was rejected (invalid grant,
 *     i.e. the user must sign in again);
 *   - returns the still-valid current credentials when a refresh fails
 *     transiently inside the retryable grace window;
 *   - throws for transient failures once the token is already expired, so
 *     callers never wipe stored credentials over a network blip.
 */
import {
  CLINE_AUTH_ENDPOINTS,
  DEVICE_GRANT_TYPE,
  WORKOS_ENDPOINTS,
  WORKOS_TOKEN_PREFIX,
} from "./constants.js";
import type {
  ClineCredentials,
  ClineTokenResponse,
  ClineTokenResponseData,
  DeviceAuthSession,
  TokenResolution,
} from "./types.js";

export class ClineAuthError extends Error {
  readonly status: number | undefined;
  readonly errorCode: string | undefined;
  readonly requestId: string | undefined;

  constructor(
    message: string,
    opts: { status?: number; errorCode?: string; requestId?: string } = {},
  ) {
    super(message);
    this.name = "ClineAuthError";
    this.status = opts.status;
    this.errorCode = opts.errorCode;
    this.requestId = opts.requestId;
  }

  /** Same heuristic the official SDK uses to detect a dead refresh token. */
  isLikelyInvalidGrant(): boolean {
    if (this.errorCode && /invalid_grant|invalid_token|unauthorized/i.test(this.errorCode)) {
      return true;
    }
    if (this.status === 400 || this.status === 401 || this.status === 403) {
      return /invalid|expired|revoked|unauthorized/i.test(this.message);
    }
    return false;
  }
}

export interface AuthEndpointOptions {
  clineApiBaseUrl: string;
  workosApiBaseUrl: string;
  clientId: string;
  requestTimeoutMs: number;
  headers?: Record<string, string>;
  provider?: string;
}

export function resolveUrl(base: string, path: string): string {
  return `${base.endsWith("/") ? base.slice(0, -1) : base}${path}`;
}

/** Stored/transport access tokens carry the `workos:` prefix. */
export function formatAccessToken(raw: string): string {
  const trimmed = raw.trim();
  return trimmed.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
    ? trimmed
    : `${WORKOS_TOKEN_PREFIX}${trimmed}`;
}

export function stripAccessToken(formatted: string): string {
  const trimmed = formatted.trim();
  return trimmed.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX)
    ? trimmed.slice(WORKOS_TOKEN_PREFIX.length)
    : trimmed;
}

function toEpochMs(value: string | number): number {
  if (typeof value === "number") {
    // Values below ~1e12 are seconds, not milliseconds.
    return value < 1e12 ? value * 1000 : value;
  }
  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) throw new Error(`Invalid expiresAt value: ${value}`);
  return parsed;
}

function toSeconds(value: unknown, fallback: number): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return fallback;
  return Math.floor(value);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function requireTokenData(payload: ClineTokenResponse, message: string): ClineTokenResponseData {
  if (!payload.success || !payload.data?.accessToken) throw new Error(message);
  return payload.data;
}

function toClineCredentials(
  data: ClineTokenResponseData,
  provider: string | undefined,
  fallback: Partial<ClineCredentials> = {},
): ClineCredentials {
  const accountId = data.userInfo?.clineUserId ?? fallback.accountId;
  const refresh = data.refreshToken ?? fallback.refresh;
  if (!refresh) throw new Error("Token response did not include a refresh token");
  const metadata = {
    ...(fallback.metadata ?? {}),
    provider,
    tokenType: data.tokenType,
    userInfo: data.userInfo,
  };
  delete (metadata as Record<string, unknown>).startedAt;
  return {
    access: data.accessToken,
    refresh,
    expires: toEpochMs(data.expiresAt),
    ...(accountId ? { accountId } : {}),
    ...(data.userInfo?.email || fallback.email
      ? { email: data.userInfo?.email || fallback.email }
      : {}),
    metadata,
  };
}

/** Parse an error body defensively; upstream mixes `{error}` and `{message,code}`. */
export function parseAuthError(text: string): { message?: string; code?: string } {
  if (!text) return {};
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    const message =
      typeof parsed.message === "string"
        ? parsed.message
        : typeof parsed.error === "string"
          ? parsed.error
          : undefined;
    const code = typeof parsed.code === "string" ? parsed.code : undefined;
    return { ...(message ? { message } : {}), ...(code ? { code } : {}) };
  } catch {
    return { message: text.slice(0, 300) };
  }
}

/** Step 1: ask WorkOS for a device code + user code. */
export async function startDeviceAuth(options: {
  workosApiBaseUrl: string;
  clientId: string;
  requestTimeoutMs: number;
}): Promise<DeviceAuthSession> {
  const response = await fetch(
    resolveUrl(options.workosApiBaseUrl, WORKOS_ENDPOINTS.deviceAuthorization),
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: options.clientId }),
      signal: AbortSignal.timeout(options.requestTimeoutMs),
    },
  );
  const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new ClineAuthError(
      `Device authorization failed: ${response.status}${
        typeof payload.error_description === "string" ? ` - ${payload.error_description}` : ""
      }`,
      {
        status: response.status,
        ...(typeof payload.error === "string" ? { errorCode: payload.error } : {}),
        ...(response.headers.get("x-request-id")
          ? { requestId: response.headers.get("x-request-id") as string }
          : {}),
      },
    );
  }
  const deviceCode = payload.device_code;
  const userCode = payload.user_code;
  const verificationUri = payload.verification_uri;
  if (typeof deviceCode !== "string" || typeof userCode !== "string" || typeof verificationUri !== "string") {
    throw new Error("Invalid WorkOS device authorization response");
  }
  return {
    deviceCode,
    userCode,
    verificationUri,
    ...(typeof payload.verification_uri_complete === "string"
      ? { verificationUriComplete: payload.verification_uri_complete }
      : {}),
    expiresInSeconds: toSeconds(payload.expires_in, 300),
    pollIntervalSeconds: toSeconds(payload.interval, 5),
  };
}

export interface DevicePollResult {
  accessToken: string;
  refreshToken: string;
  tokenType: string;
}

/**
 * Step 2: poll WorkOS until the user approves in the browser.
 * Honours `authorization_pending` / `slow_down` exactly like the official SDK.
 */
export async function pollDeviceAuth(options: {
  workosApiBaseUrl: string;
  clientId: string;
  deviceCode: string;
  expiresInSeconds: number;
  pollIntervalSeconds: number;
  requestTimeoutMs: number;
  signal?: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<DevicePollResult> {
  const deadline = Date.now() + options.expiresInSeconds * 1000;
  let intervalSeconds = Math.max(1, options.pollIntervalSeconds);

  while (Date.now() <= deadline) {
    if (options.signal?.aborted) throw new Error("Device authorization cancelled");
    const response = await fetch(
      resolveUrl(options.workosApiBaseUrl, WORKOS_ENDPOINTS.authenticate),
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: DEVICE_GRANT_TYPE,
          device_code: options.deviceCode,
          client_id: options.clientId,
        }),
        signal: options.signal ?? AbortSignal.timeout(options.requestTimeoutMs),
      },
    );
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (response.ok) {
      const accessToken = payload.access_token;
      const refreshToken = payload.refresh_token;
      if (typeof accessToken !== "string" || typeof refreshToken !== "string") {
        throw new Error("Invalid WorkOS token response");
      }
      return {
        accessToken,
        refreshToken,
        tokenType: typeof payload.token_type === "string" ? payload.token_type : "Bearer",
      };
    }
    const errorCode = typeof payload.error === "string" ? payload.error : undefined;
    const description =
      typeof payload.error_description === "string" ? payload.error_description : undefined;
    switch (errorCode) {
      case "authorization_pending":
        await sleep(intervalSeconds * 1000);
        break;
      case "slow_down":
        intervalSeconds += 1;
        await sleep(intervalSeconds * 1000);
        break;
      case "access_denied":
      case "expired_token":
      case "invalid_grant":
        throw new ClineAuthError(description ?? "WorkOS authorization failed", {
          status: response.status,
          ...(errorCode ? { errorCode } : {}),
          ...(response.headers.get("x-request-id")
            ? { requestId: response.headers.get("x-request-id") as string }
            : {}),
        });
      default:
        throw new ClineAuthError(
          `WorkOS token polling failed: ${response.status}${description ? ` - ${description}` : ""}`,
          {
            status: response.status,
            ...(errorCode ? { errorCode } : {}),
            ...(response.headers.get("x-request-id")
              ? { requestId: response.headers.get("x-request-id") as string }
              : {}),
          },
        );
    }
    options.onProgress?.("Waiting for browser authentication confirmation...");
  }
  throw new Error("WorkOS device authorization timed out");
}

/**
 * Step 3: exchange WorkOS tokens for Cline credentials by registering them
 * with the Cline API. This is the official "register" call; it is what mints
 * the account record Cline itself stores.
 */
export async function registerWorkOSTokens(
  workosTokens: DevicePollResult,
  options: AuthEndpointOptions,
): Promise<ClineCredentials> {
  const response = await fetch(resolveUrl(options.clineApiBaseUrl, CLINE_AUTH_ENDPOINTS.register), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({
      accessToken: workosTokens.accessToken,
      refreshToken: workosTokens.refreshToken,
    }),
    signal: AbortSignal.timeout(options.requestTimeoutMs),
  });
  if (!response.ok) {
    const details = parseAuthError(await response.text().catch(() => ""));
    throw new ClineAuthError(
      `Token registration failed: ${response.status}${details.message ? ` - ${details.message}` : ""}`,
      {
        status: response.status,
        ...(details.code ? { errorCode: details.code } : {}),
        ...(response.headers.get("x-request-id")
          ? { requestId: response.headers.get("x-request-id") as string }
          : {}),
      },
    );
  }
  const json = (await response.json()) as ClineTokenResponse;
  return toClineCredentials(
    requireTokenData(json, "Invalid token exchange response"),
    options.provider,
    { metadata: { sessionStartedAtMs: Date.now() } },
  );
}

/**
 * Refresh an access token. WorkOS rotates the refresh token on every refresh,
 * so callers MUST persist the returned value.
 */
export async function refreshClineToken(
  current: ClineCredentials,
  options: AuthEndpointOptions,
): Promise<ClineCredentials> {
  const response = await fetch(resolveUrl(options.clineApiBaseUrl, CLINE_AUTH_ENDPOINTS.refresh), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(options.headers ?? {}),
    },
    body: JSON.stringify({ refreshToken: current.refresh, grantType: "refresh_token" }),
    signal: AbortSignal.timeout(options.requestTimeoutMs),
  });
  if (!response.ok) {
    const details = parseAuthError(await response.text().catch(() => ""));
    throw new ClineAuthError(
      `Token refresh failed: ${response.status}${details.message ? ` - ${details.message}` : ""}`,
      {
        status: response.status,
        ...(details.code ? { errorCode: details.code } : {}),
        ...(response.headers.get("x-request-id")
          ? { requestId: response.headers.get("x-request-id") as string }
          : {}),
      },
    );
  }
  const json = (await response.json()) as ClineTokenResponse;
  const provider =
    (current.metadata?.provider as string | undefined) ?? options.provider;
  return toClineCredentials(
    requireTokenData(json, "Invalid token refresh response"),
    provider,
    current,
  );
}

export function isCredentialExpiring(credentials: ClineCredentials, bufferMs: number): boolean {
  return credentials.expires - Date.now() <= bufferMs;
}

/**
 * Resolve usable credentials, refreshing when required.
 * See the module docstring for the exact null/throw contract.
 */
export async function getValidClineCredentials(
  current: ClineCredentials | null,
  options: AuthEndpointOptions,
  resolution: TokenResolution = {},
): Promise<ClineCredentials | null> {
  if (!current) return null;
  const refreshBufferMs = resolution.refreshBufferMs ?? 5 * 60 * 1000;
  const retryableTokenGraceMs = resolution.retryableTokenGraceMs ?? 30_000;
  const forceRefresh = resolution.forceRefresh === true;

  if (!forceRefresh && !isCredentialExpiring(current, refreshBufferMs)) {
    return current;
  }
  try {
    return await refreshClineToken(current, options);
  } catch (error) {
    if (error instanceof ClineAuthError && error.isLikelyInvalidGrant()) {
      // Dead refresh token: the caller must trigger a new login.
      return null;
    }
    if (current.expires - Date.now() > retryableTokenGraceMs) {
      // Transient failure while the current token is still usable.
      return current;
    }
    throw error;
  }
}
