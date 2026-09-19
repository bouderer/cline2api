/**
 * Shared upstream call path: account selection, single-flight token refresh,
 * silent 401 retry and failover across accounts.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountPool } from "./accountPool.js";
import type { RequestLog } from "./requestLog.js";
import type { TokenManager } from "../cline/tokenManager.js";
import { postChatCompletions } from "../cline/upstream.js";
import { openaiError } from "../api/http.js";

export interface ProxyChatDeps {
  config: AppConfig;
  logger: Logger;
  pool: AccountPool;
  tokens: TokenManager;
  /** Optional: when present, every attempt is recorded for the admin UI. */
  requests?: RequestLog;
}

export type UpstreamOutcome =
  | { kind: "ok"; response: Response; accountId: string }
  | { kind: "error"; response: Response };

/**
 * Per-account, per-model cooldown.
 *
 * Accounts in the same pool are not interchangeable: one may hold Cline Credits
 * and another may only have a Cline Pass, so `anthropic/claude-*` succeeds on
 * the first and fails with `insufficient_credits` on the second. Without this,
 * round-robin would keep handing those models to the account that cannot pay.
 * Keyed by account + model, and it expires on its own.
 */
const cooldowns = new Map<string, number>();
const COOLDOWN_MS = 90_000;

function cooldownKey(accountId: string, model: string): string {
  return accountId + "|" + model;
}

function isCooling(accountId: string, model: string): boolean {
  const until = cooldowns.get(cooldownKey(accountId, model));
  if (until === undefined) return false;
  if (until <= Date.now()) {
    cooldowns.delete(cooldownKey(accountId, model));
    return false;
  }
  return true;
}

function cool(accountId: string, model: string): void {
  cooldowns.set(cooldownKey(accountId, model), Date.now() + COOLDOWN_MS);
}

/**
 * Upstream errors that belong to *this account* rather than to the request.
 *
 * Two families qualify: billing (`insufficient_credits` — a Pass-only account
 * asked for a credit-billed model) and per-account quota (`INFERENCE_CAP_ERROR`
 * / "Daily free limit reached" — the free tier is capped per account, per day).
 * Both are worth retrying on another account, because accounts in a pool differ
 * in what they can pay for and in how much free quota they have left.
 *
 * Deliberately NOT matched: provider-wide 429s on a shared pool (retrying just
 * adds latency) and malformed requests.
 */
function isAccountScopedUpstreamError(status: number, text: string): boolean {
  if (status !== 402 && status !== 400 && status !== 429) return false;
  return /insufficient_credits|insufficient balance|credit balance|INFERENCE_CAP_ERROR|daily free limit|free limit reached|exceeded your current quota|quota exceeded/i.test(
    text,
  );
}

/** Short, log-safe reason for an account-scoped failure. */
function describeAccountScopedError(status: number, text: string): string {
  if (/insufficient_credits|insufficient balance|credit balance/i.test(text)) {
    return "insufficient credits";
  }
  if (/daily free limit|free limit reached/i.test(text)) return "daily free limit";
  if (/INFERENCE_CAP_ERROR/i.test(text)) return "inference cap";
  return `upstream ${status}`;
}

/**
 * Upstream's way of saying a reasoning model spent its whole token budget
 * thinking and had nothing left to say (`{"error":"empty response content"}`).
 *
 * This is not the account's fault, so failing over to another account would
 * just repeat it — the only thing that helps is asking for a bigger budget.
 * Clients that hard-code a small `max_tokens` (a 16-token health check, a
 * 512-token default in some UIs) otherwise see a hard failure on every
 * thinking model while streaming requests, which have no such limit, keep
 * working. Raising the ceiling cannot cost more than the model actually emits;
 * it only stops the budget from being the thing that breaks the request.
 */
const EMPTY_CONTENT_ERROR = /empty response content/i;
const ESCALATED_MAX_TOKENS = 2048;

export function isEmptyContentError(text: string): boolean {
  return EMPTY_CONTENT_ERROR.test(text);
}

/**
 * Copy of a request body with a small output budget raised; null when the
 * caller already asked for room to think, or when it set no budget at all —
 * upstream's own default is larger than ours, so adding one would shrink it.
 */
export function withRaisedTokenBudget(body: unknown): unknown | null {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  const field = (["max_tokens", "max_completion_tokens", "max_output_tokens"] as const).find(
    (name) => typeof record[name] === "number",
  );
  if (field === undefined) return null;
  const current = record[field] as number;
  if (current >= ESCALATED_MAX_TOKENS) return null;
  return { ...record, [field]: ESCALATED_MAX_TOKENS };
}

export async function callUpstreamWithFailover(
  deps: ProxyChatDeps,
  body: unknown,
  options: { taskId: string; model: string; stream: boolean; signal?: AbortSignal },
): Promise<UpstreamOutcome> {
  const startedAt = Date.now();
  const record = (status: number, accountId: string | null, error: string | null): void => {
    deps.requests?.record({
      at: startedAt,
      model: options.model,
      stream: options.stream,
      status,
      durationMs: Date.now() - startedAt,
      accountId,
      error,
    });
  };

  const candidates = deps.pool.candidates();
  if (candidates.length === 0) {
    record(503, null, "no_accounts");
    return {
      kind: "error",
      response: openaiError(
        "No Cline account is registered or all accounts need re-login. Open the admin UI and sign in.",
        503,
        { type: "server_error", code: "no_accounts" },
      ),
    };
  }

  const failures: string[] = [];

  // Accounts that already failed to pay for this model go last: the pool is
  // round-robin, and a Pass-only account cannot serve credit-billed models.
  const ordered = [
    ...candidates.filter((account) => !isCooling(account.id, options.model)),
    ...candidates.filter((account) => isCooling(account.id, options.model)),
  ];

  for (const account of ordered) {
    // Three ways out of this loop: success, a dead credential, or a failure
    // that belongs to the request rather than the account. `refresh` forces one
    // token rotation after a 401; `escalate` retries once with a bigger token
    // budget when upstream reported an empty body.
    let refreshTried = false;
    let needRefresh = false;
    let escalated = false;
    let requestBody = body;

    for (;;) {
      const forceRefresh = needRefresh;
      needRefresh = false;

      let authorization: string | null;
      try {
        authorization = await deps.tokens.getAuthorization(account.id, { forceRefresh });
      } catch (error) {
        failures.push(`${account.id}: token ${(error as Error).message}`);
        deps.logger.warn("token resolution failed", {
          accountId: account.id,
          error: (error as Error).message,
        });
        break;
      }
      if (!authorization) {
        failures.push(`${account.id}: re-login required`);
        break;
      }

      let upstream: Response;
      try {
        upstream = await postChatCompletions(deps.config, requestBody, {
          authorization,
          taskId: options.taskId,
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        failures.push(`${account.id}: network ${(error as Error).message}`);
        deps.logger.warn("upstream request failed", {
          accountId: account.id,
          error: (error as Error).message,
        });
        break;
      }

      if (upstream.status === 401 || upstream.status === 403) {
        const detail = await upstream.text().catch(() => "");
        failures.push(`${account.id}: upstream ${upstream.status}`);
        deps.logger.warn("upstream rejected credentials", {
          accountId: account.id,
          status: upstream.status,
          detail: detail.slice(0, 200),
        });
        if (!refreshTried) {
          refreshTried = true;
          needRefresh = true;
          continue;
        }
        break;
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");

        // The reasoning budget swallowed the answer: same account, bigger
        // budget. Another account would only repeat the same model's behaviour.
        if (!escalated && isEmptyContentError(text)) {
          const raised = withRaisedTokenBudget(requestBody);
          if (raised !== null) {
            escalated = true;
            requestBody = raised;
            deps.logger.warn("upstream returned no text; retrying with a larger token budget", {
              accountId: account.id,
              model: options.model,
              maxTokens: ESCALATED_MAX_TOKENS,
            });
            continue;
          }
        }

        // This account cannot serve this model (no credits, or its own daily
        // free quota is spent): another account in the pool may be able to, so
        // fail over instead of surfacing the per-account error.
        if (isAccountScopedUpstreamError(upstream.status, text)) {
          cool(account.id, options.model);
          failures.push(`${account.id}: ${describeAccountScopedError(upstream.status, text)}`);
          deps.logger.warn("account cannot serve model, failing over", {
            accountId: account.id,
            model: options.model,
            status: upstream.status,
          });
          break;
        }
        deps.logger.warn("upstream error", {
          accountId: account.id,
          status: upstream.status,
          detail: text.slice(0, 300),
        });
        record(upstream.status, account.id, text.slice(0, 300) || "upstream error");
        return {
          kind: "error",
          response: new Response(text || JSON.stringify({ error: { message: "Upstream error" } }), {
            status: upstream.status,
            headers: {
              "content-type": upstream.headers.get("content-type") ?? "application/json",
            },
          }),
        };
      }

      deps.logger.info("proxied chat completion", {
        accountId: account.id,
        model: options.model,
        stream: options.stream,
      });
      record(200, account.id, null);
      return { kind: "ok", response: upstream, accountId: account.id };
    }
  }

  const failure = `All registered Cline accounts failed: ${failures.join("; ") || "unknown error"}`;
  deps.logger.error("all accounts failed", { failures });
  record(502, null, failures.join("; ") || "unknown error");
  return {
    kind: "error",
    response: openaiError(failure, 502, { type: "upstream_error", code: "all_accounts_failed" }),
  };
}
