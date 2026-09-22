/**
 * Pool-wide liveness sweep.
 *
 * Runs on the server rather than in the browser for three reasons: a pool of
 * several hundred accounts takes minutes, the operator will navigate away
 * mid-sweep, and a page reload must not orphan hundreds of in-flight requests
 * against upstream.
 *
 * Two modes, and the difference matters:
 *
 *   - Credential mode (no model): forces a token refresh and calls
 *     `/users/me`. Costs no inference, so it is safe to run across the whole
 *     pool and answers "can this account still authenticate?".
 *   - Model mode: sends one real completion to a chosen model, pinned to the
 *     account. It answers the stronger question — "does this account actually
 *     work right now?" — but spends a (free, when the model is in the free
 *     bucket) request per account, so it is opt-in.
 *
 * Only one sweep runs at a time. A second request joins the running one
 * instead of starting a competing pass, because both would fight over the same
 * upstream budget and the results would interleave.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import type { TokenManager } from "../cline/tokenManager.js";
import type { AccountPool } from "./accountPool.js";
import type { ProxyResolver } from "../cline/proxy.js";
import type { FreeQuotaStore } from "./freeQuota.js";
import { probeAccount } from "./accountCheck.js";
import { callUpstreamWithFailover, type ProxyChatDeps } from "./proxyChat.js";

export interface SweepFailure {
  id: string;
  email: string | null;
  error: string;
}

export interface SweepState {
  id: string;
  running: boolean;
  /** Model used, or null for credential-only mode. */
  model: string | null;
  total: number;
  done: number;
  ok: number;
  failed: number;
  startedAt: number;
  finishedAt: number | null;
  /** Newest failures, capped so a dead pool cannot grow the payload forever. */
  failures: SweepFailure[];
  cancelled: boolean;
}

/** Failures kept in the response; the counters still cover every account. */
const MAX_FAILURES = 50;

export interface SweepDeps {
  config: AppConfig;
  logger: Logger;
  store: AccountStore;
  tokens: TokenManager;
  pool: AccountPool;
  resolver: ProxyResolver;
  freeQuota: FreeQuotaStore;
}

const DEFAULT_CONCURRENCY = 6;
const MAX_CONCURRENCY = 24;

export interface SweepRequest {
  model?: string | null;
  activeOnly?: boolean;
  /** Restrict to accounts the pool already knows are broken. */
  failedOnly?: boolean;
  concurrency?: number;
}

export class SweepRunner {
  private current: (SweepState & { cancel: boolean }) | null = null;

  constructor(private readonly deps: SweepDeps) {}

  /** The running sweep, or the last finished one. */
  status(): SweepState | null {
    if (this.current === null) return null;
    const { cancel: _cancel, ...state } = this.current;
    return { ...state, failures: state.failures.map((f) => ({ ...f })) };
  }

  cancel(): boolean {
    if (this.current === null || !this.current.running) return false;
    this.current.cancel = true;
    return true;
  }

  /**
   * Start a sweep, or return the one already running.
   *
   * Returns `started: false` when a sweep was already in flight, so the caller
   * can say so rather than implying a second pass began.
   */
  start(request: SweepRequest = {}): { started: boolean; state: SweepState | null } {
    if (this.current?.running === true) return { started: false, state: this.status() };

    const model = typeof request.model === "string" && request.model.trim().length > 0
      ? request.model.trim()
      : null;
    const all = this.deps.store.list();
    const selected = all.filter((account) => {
      if (account.id.length === 0) return false;
      if (request.failedOnly === true) return account.disabled || account.lastError !== null;
      if (request.activeOnly === true) return !account.disabled;
      return true;
    });
    const concurrency = Math.max(
      1,
      Math.min(MAX_CONCURRENCY, Math.floor(request.concurrency ?? DEFAULT_CONCURRENCY) || DEFAULT_CONCURRENCY),
    );

    this.current = {
      id: `sweep-${Date.now().toString(36)}`,
      running: true,
      model,
      total: selected.length,
      done: 0,
      ok: 0,
      failed: 0,
      startedAt: Date.now(),
      finishedAt: null,
      failures: [],
      cancelled: false,
      cancel: false,
    };
    const state = this.current;

    this.deps.logger.info("liveness sweep started", {
      id: state.id,
      model,
      total: state.total,
      concurrency,
    });

    void this.run(state, selected, concurrency);
    return { started: true, state: this.status() };
  }

  private async run(
    state: SweepState & { cancel: boolean },
    accounts: ReturnType<AccountStore["list"]>,
    concurrency: number,
  ): Promise<void> {
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        if (state.cancel) return;
        const index = next;
        next += 1;
        const account = accounts[index];
        if (account === undefined) return;

        const failure = await this.checkOne(account.id, state.model);
        state.done += 1;
        if (failure === null) {
          state.ok += 1;
        } else {
          state.failed += 1;
          if (state.failures.length < MAX_FAILURES) {
            state.failures.push({ id: account.id, email: account.email, error: failure });
          }
        }
      }
    };

    try {
      await Promise.all(Array.from({ length: Math.min(concurrency, accounts.length) }, worker));
    } catch (error) {
      this.deps.logger.error("liveness sweep failed", { id: state.id, error: (error as Error).message });
    } finally {
      state.running = false;
      state.finishedAt = Date.now();
      this.deps.logger.info("liveness sweep finished", {
        id: state.id,
        done: state.done,
        ok: state.ok,
        failed: state.failed,
        cancelled: state.cancel,
      });
    }
  }

  /** Returns null when the account is healthy, else a short reason. */
  private async checkOne(accountId: string, model: string | null): Promise<string | null> {
    if (model === null) {
      const result = await probeAccount(
        { config: this.deps.config, logger: this.deps.logger, store: this.deps.store, tokens: this.deps.tokens },
        accountId,
      );
      return result.ok ? null : (result.error ?? "probe failed");
    }

    const chat: ProxyChatDeps = {
      config: this.deps.config,
      logger: this.deps.logger,
      pool: this.deps.pool,
      tokens: this.deps.tokens,
      store: this.deps.store,
      proxyResolver: this.deps.resolver,
      freeQuota: this.deps.freeQuota,
    };
    try {
      const outcome = await callUpstreamWithFailover(
        chat,
        {
          model,
          messages: [{ role: "user", content: "只回复两个字：可用" }],
          // Reasoning models can spend a small budget entirely on thinking,
          // which would read as a broken account.
          max_tokens: 2048,
          stream: false,
        },
        { taskId: `sweep-${accountId}`, model, stream: false, onlyAccountId: accountId },
      );
      if (outcome.kind === "ok") return null;
      const text = await outcome.response.text().catch(() => "");
      return text.slice(0, 200) || `HTTP ${outcome.response.status}`;
    } catch (error) {
      return `request failed: ${(error as Error).message}`;
    }
  }
}
