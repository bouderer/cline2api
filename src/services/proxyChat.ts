/**
 * Shared upstream call path: account selection, single-flight token refresh,
 * silent 401 retry and failover across accounts.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountPool } from "./accountPool.js";
import type { TokenManager } from "../cline/tokenManager.js";
import { postChatCompletions } from "../cline/upstream.js";
import { openaiError } from "../api/http.js";

export interface ProxyChatDeps {
  config: AppConfig;
  logger: Logger;
  pool: AccountPool;
  tokens: TokenManager;
}

export type UpstreamOutcome =
  | { kind: "ok"; response: Response; accountId: string }
  | { kind: "error"; response: Response };

export async function callUpstreamWithFailover(
  deps: ProxyChatDeps,
  body: unknown,
  options: { taskId: string; model: string; stream: boolean; signal?: AbortSignal },
): Promise<UpstreamOutcome> {
  const candidates = deps.pool.candidates();
  if (candidates.length === 0) {
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

  for (const account of candidates) {
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
        deps.logger.warn("upstream error", {
          accountId: account.id,
          status: upstream.status,
          detail: text.slice(0, 300),
        });
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
      return { kind: "ok", response: upstream, accountId: account.id };
    }
  }

  deps.logger.error("all accounts failed", { failures });
  return {
    kind: "error",
    response: openaiError(
      `All registered Cline accounts failed: ${failures.join("; ") || "unknown error"}`,
      502,
      { type: "upstream_error", code: "all_accounts_failed" },
    ),
  };
}
