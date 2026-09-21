/**
 * Account liveness check.
 *
 * Answers one question — "does this account still work?" — without spending
 * inference. That distinction matters: the pool contains accounts whose refresh
 * token was rejected silently weeks ago, and proving them dead with a chat
 * completion would bill a real request to find out.
 *
 * Two stages, reported separately so a failure says which half broke:
 *
 *   1. credential — a forced refresh. This is the only step that can detect a
 *      revoked refresh token, because TokenManager keeps serving a still-valid
 *      access token otherwise.
 *   2. identity — `GET /api/v1/users/me` with the resolved token. This proves
 *      the access token is accepted upstream, which a refresh alone does not.
 *
 * A refresh rotates the refresh token, so a successful probe persists the new
 * credentials through the normal TokenManager path rather than leaving a
 * half-updated record behind.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import type { TokenManager } from "../cline/tokenManager.js";
import { defaultClineHeaders } from "../cline/constants.js";

export type ProbeStage = "credential" | "identity" | "ok";

export interface ProbeResult {
  accountId: string;
  email: string | null;
  ok: boolean;
  /** Which stage the account reached; `ok` means both passed. */
  stage: ProbeStage;
  /** Upstream HTTP status when one was received. */
  status: number | null;
  latencyMs: number;
  /** Upstream user id, present only when the identity stage succeeded. */
  uid: string | null;
  error: string | null;
  checkedAt: number;
}

export interface ProbeDeps {
  config: AppConfig;
  logger: Logger;
  store: AccountStore;
  tokens: TokenManager;
}

/**
 * `GET /api/v1/users/me`, keeping the status code.
 *
 * Deliberately not reusing the credits helper: it collapses every failure to
 * `null`, and a liveness report that cannot say "401" versus "network timeout"
 * is not worth showing.
 */
async function checkIdentity(
  config: AppConfig,
  authorization: string,
): Promise<{ uid: string | null; status: number | null; error: string | null }> {
  let response: Response;
  try {
    response = await fetch(`${config.clineApiBaseUrl}/api/v1/users/me`, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...defaultClineHeaders({
          clientName: config.clientName,
          clientVersion: config.clientVersion,
          platform: config.platform,
          platformVersion: config.platformVersion,
          coreVersion: config.coreVersion,
          taskId: "admin-probe",
        }),
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
  } catch (error) {
    return { uid: null, status: null, error: (error as Error).message };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    return {
      uid: null,
      status: response.status,
      error: detail.slice(0, 200) || `HTTP ${response.status}`,
    };
  }

  try {
    const payload = (await response.json()) as { data?: { id?: unknown } };
    const id = payload.data?.id;
    if (typeof id !== "string" || id.length === 0) {
      return { uid: null, status: response.status, error: "response carried no user id" };
    }
    return { uid: id, status: response.status, error: null };
  } catch {
    return { uid: null, status: response.status, error: "response was not valid JSON" };
  }
}

export async function probeAccount(deps: ProbeDeps, accountId: string): Promise<ProbeResult> {
  const startedAt = Date.now();
  const account = deps.store.get(accountId);
  const base = {
    accountId,
    email: account?.email ?? null,
    checkedAt: startedAt,
  };

  if (!account) {
    return {
      ...base,
      ok: false,
      stage: "credential",
      status: null,
      latencyMs: 0,
      uid: null,
      error: "unknown account",
    };
  }

  // A disabled account is skipped by TokenManager unless the refresh is forced,
  // and forcing it here is exactly what a liveness check should do: an operator
  // testing a disabled account wants to know whether it could come back.
  let authorization: string | null;
  try {
    authorization = await deps.tokens.getAuthorization(accountId, { forceRefresh: true });
  } catch (error) {
    return {
      ...base,
      ok: false,
      stage: "credential",
      status: null,
      latencyMs: Date.now() - startedAt,
      uid: null,
      error: `token refresh failed: ${(error as Error).message}`,
    };
  }
  if (!authorization) {
    return {
      ...base,
      ok: false,
      stage: "credential",
      status: null,
      latencyMs: Date.now() - startedAt,
      uid: null,
      error: "refresh token rejected: re-login required",
    };
  }

  const identity = await checkIdentity(deps.config, authorization);
  const latencyMs = Date.now() - startedAt;
  if (identity.uid === null) {
    return {
      ...base,
      ok: false,
      stage: "identity",
      status: identity.status,
      latencyMs,
      uid: null,
      error: identity.error ?? "upstream rejected the refreshed credential",
    };
  }

  return {
    ...base,
    ok: true,
    stage: "ok",
    status: identity.status,
    latencyMs,
    uid: identity.uid,
    error: null,
  };
}
