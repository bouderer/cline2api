/**
 * Free-tier quota probe.
 *
 * "How much free quota does this account have left?" has no endpoint. The free
 * bucket is capped per account per day and upstream answers with a plain quota
 * error once it is spent, so the only way to know is to ask for one token and
 * see whether it comes back.
 *
 * The probe is deliberately minimal and pinned:
 *
 *   - one account, no failover (`onlyAccountId`), so the verdict describes that
 *     account rather than whichever one in the pool could answer;
 *   - a free-bucket model, because that is the bucket whose quota is in
 *     question — a paid model would answer fine on a spent account;
 *   - a tiny output budget, since the answer is the status code, not the text.
 *
 * Cost is one real (free) request per account per probe, which is why this runs
 * on demand or on a schedule the operator chooses, never on page load.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import type { TokenManager } from "../cline/tokenManager.js";
import type { FreeQuotaStore } from "./freeQuota.js";
import { callUpstreamWithFailover } from "./proxyChat.js";
import type { ProxyChatDeps } from "./proxyChat.js";

/** A model in the free bucket, used only to read the quota verdict. */
export const DEFAULT_FREE_PROBE_MODEL = "cline-free/kimi-k3";

/** Small enough to cost nothing, large enough not to trip the empty-content path. */
const PROBE_MAX_TOKENS = 16;

export type FreeProbeOutcome = "ok" | "exhausted" | "error";

export interface FreeProbeResult {
  accountId: string;
  email: string | null;
  outcome: FreeProbeOutcome;
  /** Upstream status when a response was received. */
  status: number | null;
  /** Upstream's own words, trimmed, when the probe failed. */
  reason: string | null;
  model: string;
  latencyMs: number;
  checkedAt: number;
}

export interface FreeProbeDeps {
  config: AppConfig;
  logger: Logger;
  store: AccountStore;
  tokens: TokenManager;
  /** Everything the proxy path needs, minus the caller's request. */
  chat: ProxyChatDeps;
  quota: FreeQuotaStore;
}

/**
 * Quota errors upstream returns for a spent free bucket.
 *
 * Matched on text rather than status alone, because the failover path collapses
 * a per-account failure into one aggregated 502 whose body carries the original
 * reason ("... acct-1: daily free limit") — the 429/402 the account actually
 * received never reaches this call. The status is still required to be an error
 * status so a success body quoting the phrase cannot be misread as exhaustion.
 */
const FREE_QUOTA_ERROR = /daily free limit|free limit reached|INFERENCE_CAP_ERROR|free tier.*limit|quota exceeded/i;

export function isFreeQuotaError(status: number, text: string): boolean {
  if (status < 400) return false;
  return FREE_QUOTA_ERROR.test(text);
}

/** Short, log-safe version of upstream's message. */
function summarize(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? flat.slice(0, 200) : flat;
}

/** Extract upstream's `error.message` when the body is the usual JSON envelope. */
function errorMessage(text: string): string {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed === "object" && parsed !== null) {
      const record = parsed as Record<string, unknown>;
      const error = record.error;
      if (typeof error === "string") return summarize(error);
      if (typeof error === "object" && error !== null) {
        const message = (error as Record<string, unknown>).message;
        if (typeof message === "string") return summarize(message);
      }
      const message = record.message;
      if (typeof message === "string") return summarize(message);
    }
  } catch {
    // Not JSON: fall through to the raw text.
  }
  return summarize(text);
}

/**
 * Ask one account for one token on a free model, and report whether the free
 * quota answered. Never throws: every failure becomes an outcome.
 */
export async function probeFreeQuota(
  deps: FreeProbeDeps,
  accountId: string,
  options: { model?: string } = {},
): Promise<FreeProbeResult> {
  const startedAt = Date.now();
  const model = options.model ?? DEFAULT_FREE_PROBE_MODEL;
  const account = deps.store.get(accountId);
  const base = {
    accountId,
    email: account?.email ?? null,
    model,
    checkedAt: startedAt,
  };

  if (account === undefined) {
    return { ...base, outcome: "error", status: null, reason: "unknown account", latencyMs: 0 };
  }

  // The probe never streams and asks for one token: the body is discarded, only
  // the status matters, and a stream would be buffered here purely to read it.
  const body = {
    model,
    stream: false,
    max_tokens: PROBE_MAX_TOKENS,
    messages: [{ role: "user", content: "ping" }],
  };

  let status: number | null = null;
  let reason: string | null = null;
  let outcome: FreeProbeOutcome = "error";

  try {
    const result = await callUpstreamWithFailover(deps.chat, body, {
      taskId: `free-probe-${accountId}`,
      model,
      stream: false,
      onlyAccountId: accountId,
    });

    status = result.response.status;
    if (result.kind === "ok") {
      outcome = "ok";
    } else {
      const text = await result.response.text().catch(() => "");
      reason = text.length > 0 ? errorMessage(text) : `upstream ${status}`;
      outcome = isFreeQuotaError(status, text) ? "exhausted" : "error";
    }
  } catch (error) {
    reason = `probe failed: ${(error as Error).message}`;
    outcome = "error";
  }

  const latencyMs = Date.now() - startedAt;
  if (outcome !== "error") {
    deps.quota.recordProbe(accountId, outcome, reason);
  }
  deps.logger.info("free quota probed", { accountId, model, outcome, status, latencyMs });

  return { ...base, outcome, status, reason, latencyMs };
}
