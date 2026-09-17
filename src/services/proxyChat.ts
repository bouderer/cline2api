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
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const forceRefresh = attempt === 1;
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
        upstream = await postChatCompletions(deps.config, body, {
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
        continue;
      }

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => "");
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
