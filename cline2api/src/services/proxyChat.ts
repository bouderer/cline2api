/**
 * Shared upstream call path: account selection, single-flight token refresh,
 * silent 401 retry and failover across accounts.
 */
import crypto from "node:crypto";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountPool } from "./accountPool.js";
import type { RequestLog } from "./requestLog.js";
import type { TokenManager } from "../cline/tokenManager.js";
import type { AccountStore } from "../store.js";
import type { FreeQuotaStore } from "./freeQuota.js";
import type { UsageLedger } from "./usageLedger.js";
import type { ProxyResolver } from "../cline/proxy.js";
import { MAX_PROXY_SWITCHES } from "../cline/proxy.js";
import { postChatCompletions } from "../cline/upstream.js";
import { openaiError } from "../api/http.js";
import type { CapabilityIndex } from "./accountCapabilities.js";

export interface ProxyChatDeps {
  config: AppConfig;
  logger: Logger;
  pool: AccountPool;
  tokens: TokenManager;
  /** Needed to resolve a pinned account by id, bypassing pool rotation. */
  store: AccountStore;
  /** Optional: when present, requests egress through the account's proxy. */
  proxyResolver?: ProxyResolver;
  /** Optional: when present, every attempt is recorded for the admin UI. */
  requests?: RequestLog;
  /** Optional: when present, free-tier quota failures are remembered. */
  freeQuota?: FreeQuotaStore;
  /**
   * Optional: which accounts hold which plan.
   *
   * Present, a Pass-only model is routed straight at the accounts that hold
   * Pass instead of being offered to the pool in round-robin order. Absent, the
   * old behaviour applies and failover discovers the same thing the expensive
   * way — one upstream call per account it tries.
   */
  capabilities?: CapabilityIndex;
  /** Optional: when present, served token counts are written to disk. */
  usageLedger?: UsageLedger;
}

export interface ServedUsage {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
}

export type UpstreamOutcome =
  | {
      kind: "ok";
      response: Response;
      accountId: string;
      recordUsage: (usage: ServedUsage) => void;
    }
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

/**
 * Accounts known not to be entitled to a model, by account + model.
 *
 * Kept apart from `cooldowns` because the two mean different things. A cooldown
 * is transient — a spent free quota refills, so the account is worth retrying
 * after a pause, and cooling only moves it to the back of the queue. An
 * entitlement is a property of the account's plan: it will not change by
 * waiting, so the account is skipped entirely until this expires. Without that
 * distinction a pool where two accounts hold a plan would still ask all of the
 * others on every single request.
 */
const entitlements = new Map<string, number>();
const ENTITLEMENT_MS = 6 * 60 * 60 * 1000;

function cooldownKey(accountId: string, model: string): string {
  return accountId + "|" + model;
}

/** Whether this account has been seen to lack the plan for this model. */
function isNotEntitled(accountId: string, model: string): boolean {
  const key = cooldownKey(accountId, model);
  const until = entitlements.get(key);
  if (until === undefined) return false;
  if (until <= Date.now()) {
    entitlements.delete(key);
    return false;
  }
  return true;
}

function markNotEntitled(accountId: string, model: string): void {
  entitlements.set(cooldownKey(accountId, model), Date.now() + ENTITLEMENT_MS);
}

/**
 * How many accounts one request may fail over through before giving up.
 *
 * Failover exists for a handful of dead accounts, not for a plan that most of
 * the pool lacks. Uncapped, a request for a model only a couple of accounts can
 * serve walks every account and turns one client call into a pool-sized burst
 * at the edge. Measured against the live pool: eight attempts was still enough
 * for repeated requests to trip Cloudflare's rate limit, so this is kept low —
 * the capability index is what makes a Pass request reach the right account,
 * not a longer walk.
 */
const MAX_FAILOVERS = 4;

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

/**
 * The account is signed in and healthy, but its plan does not cover this model.
 *
 * `ENTITLEMENT_ERROR` arrives as a **403**, which is the same status a revoked
 * credential uses — so the 403 branch has to tell them apart by body. Treating
 * this one as a credential failure is expensive twice over: the account gets a
 * pointless token refresh, and then a second identical request, before the loop
 * moves on. Across a pool where only a couple of accounts hold a given plan
 * that is ~2 upstream calls per account per request, which is what turns one
 * client request into enough traffic for Cloudflare to start answering 429.
 */
function isEntitlementError(status: number, text: string): boolean {
  return status === 403 && /ENTITLEMENT_ERROR|not subscribed to required model plan/i.test(text);
}

/**
 * An upstream 429 that names nothing account-specific.
 *
 * Upstream sits behind Cloudflare, and a 429 from the edge arrives as an HTML
 * page with no error code in it. That is indistinguishable *by body* from a
 * provider-wide rate limit — and it is emphatically not a per-account problem,
 * so failing over to the next account sends another request at the same edge
 * that is already refusing us. Continuing the loop is what turns a burst into a
 * ban.
 */
function isProviderWideRateLimit(status: number, text: string): boolean {
  if (status !== 429) return false;
  return !isAccountScopedUpstreamError(status, text);
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
 * Wrap a successful upstream response so its body is counted as it streams to
 * the client, then report the total to the persisted request log.
 *
 * Returns the original response untouched when there is no body to count or no
 * log to report to, so this never becomes the reason a response fails. The
 * counting is a pass-through TeeStream: every byte the client reads is a byte
 * that crossed the egress hop, which is what the proxy invoice measures. The
 * completion line is joined to the entry by `requestId`; response size is only
 * known when the stream ends, long after the entry line was written.
 */
function countResponseBody(
  response: Response,
  requests: RequestLog | undefined,
  requestId: string,
): Response {
  if (!requests || !response.body) return response;
  let bytes = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      bytes += chunk.byteLength;
      controller.enqueue(chunk);
    },
    flush() {
      requests.complete(requestId, bytes);
    },
  });
  const countedBody = response.body.pipeThrough(counter);
  return new Response(countedBody, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
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

/**
 * One-off provider pin for a single paid model.
 *
 * z-ai/glm-5.3-flash: OpenRouter serves this id from a dozen hosts. Pinning
 * InferenceNet bills at that host's list price ($0.045/M prompt) instead of
 * the routing mix's average (verified 2026-09-25: unpinned calls landed on
 * Z.AI at $0.15/M, pinned calls billed at the InferenceNet rate). The pin
 * exists purely to pick the cheapest served price; quality is identical.
 *
 * Every other paid model is left unpinned on purpose: pinning buys nothing
 * (billing follows the model id, not the provider) and the wrong slug 404s
 * the request outright.
 *
 * Buckets that ignore the field entirely are not listed here: `cline-free/*`,
 * `cline-pass/*`, `vmc/*`, `private/*`, `stealth/*` all resolve server-side.
 */
const MODEL_PROVIDER_PIN: Readonly<Record<string, string>> = {
  "z-ai/glm-5.3-flash": "inference-net",
};

export interface PinResult {
  body: unknown;
  pinned: boolean;
}

export function applyProviderPin(body: unknown): PinResult {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { body, pinned: false };
  }
  const record = body as Record<string, unknown>;
  const model = typeof record.model === "string" ? record.model : "";
  // Never pin client-pinned models: an explicit `provider` in the request wins.
  if (record.provider !== undefined) return { body, pinned: false };
  const pin: string | undefined = MODEL_PROVIDER_PIN[model];
  if (pin === undefined) return { body, pinned: false };
  return {
    body: { ...record, provider: { only: [pin] } },
    pinned: true,
  };
}

export async function callUpstreamWithFailover(
  deps: ProxyChatDeps,
  body: unknown,
  options: {
    taskId: string;
    model: string;
    stream: boolean;
    signal?: AbortSignal;
    /**
     * Pin the request to one account and disable failover.
     *
     * The admin account tester needs to know what *this* account does, so
     * walking the pool would defeat the point — a failure on the pinned
     * account has to surface as a failure, not be silently served by another.
     */
    onlyAccountId?: string;
    /**
     * Caller address, carried through so the request log can show who asked.
     * Not used for any decision; it exists because the answer to "why is this
     * box busy" is usually an address, and the account id alone does not say
     * which client sent it.
     */
    clientIp?: string | null;
  },
): Promise<UpstreamOutcome> {
  const startedAt = Date.now();
  // Correlation id joining the persisted entry line with its later
  // completion line (response bytes are only known when the stream ends).
  const requestId = crypto.randomUUID();
  // Provider pin: paid catalog models are pinned to the vendor's own
  // first-party endpoint for quality determinism. Billing is unaffected
  // (Cline bills by model id, not by which provider served it), and the
  // stream flag is untouched — a pinned request keeps the caller's own
  // streaming preference.
  const pin = applyProviderPin(body);
  if (pin.pinned) body = pin.body;
  // Counted as the loop actually posts, so a request rejected before any
  // upstream call is on record as costing nothing.
  let upstreamCalls = 0;
  // The exit that carried the last upstream call, for the request log. The
  // limit that throttles a burst is per exit address, so the account id alone
  // cannot explain a 429 — this is what says which address said no.
  let usedExit: string | null = null;
  // Request-side byte accounting for the persisted trail: the proxy bill is
  // per byte, so "which exit carried how much" needs sizes, and the request
  // body is the half we already hold. One serialization is cheap next to the
  // upstream call it describes.
  let reqBytes: number | undefined;
  try {
    reqBytes = Buffer.byteLength(JSON.stringify(body));
  } catch {
    reqBytes = undefined;
  }
  const record = (status: number, accountId: string | null, error: string | null): void => {
    deps.requests?.record({
      id: requestId,
      at: startedAt,
      model: options.model,
      stream: options.stream,
      status,
      durationMs: Date.now() - startedAt,
      accountId,
      exitIp: usedExit,
      error,
      clientIp: options.clientIp ?? null,
      upstreamCalls,
      reqBytes,
    });
  };

  /**
   * Write this request's token counts to the ledger once, when the response
   * has actually been served.
   *
   * Called by the route after it has read the body: the ledger must reflect
   * what the client received, and a request that failed over to another
   * account before producing anything has no usage to record.
   */
  const recordUsage = (accountId: string) => (usage: {
    promptTokens: number; completionTokens: number; cachedTokens: number; totalTokens: number;
  }): void => {
    deps.usageLedger?.record({ at: startedAt, model: options.model, accountId, ...usage });
  };

  const candidates =
    options.onlyAccountId === undefined
      ? deps.pool.candidates()
      : deps.store
          .list()
          .filter((account) => account.id === options.onlyAccountId);
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

  // Accounts known to lack a plan for this model are dropped outright rather
  // than moved to the back: an entitlement does not change by waiting, so a
  // retry would only add an upstream call that cannot succeed.
  let eligible = candidates.filter((account) => !isNotEntitled(account.id, options.model));

  // `cline-pass/*` is held by a handful of accounts in a pool of hundreds, so
  // round-robin almost never lands on one: the request is offered to account
  // after account that cannot serve it, and the failover walk burns an upstream
  // call on each without ever reaching the ones that would have worked.
  //
  // When the capability index knows who holds Pass, route this model straight
  // at them. The guard on `known` matters: an index that has read nothing would
  // report an empty Pass list, which means "not asked yet", not "nobody has it"
  // — and shortlisting on that would turn a working request into a 503.
  if (options.model.startsWith("cline-pass/")) {
    const known = deps.capabilities?.stats().known ?? 0;
    if (known > 0) {
      const holders = new Set(deps.capabilities?.clinePassAccounts() ?? []);
      const shortlist = eligible.filter((account) => holders.has(account.id));
      if (shortlist.length > 0) eligible = shortlist;
      // An empty shortlist means every Pass account is disabled or cooling;
      // fall through to the full list so the request still has a chance.
    }
  }

  // Accounts that already failed to pay for this model go last: the pool is
  // round-robin, and a Pass-only account cannot serve credit-billed models.
  const ordered = [
    ...eligible.filter((account) => !isCooling(account.id, options.model)),
    ...eligible.filter((account) => isCooling(account.id, options.model)),
  ];

  if (ordered.length === 0) {
    record(503, null, "no_entitled_accounts");
    return {
      kind: "error",
      response: openaiError(
        `No account in the pool is entitled to ${options.model}. ` +
          "Add an account whose plan covers it, or pick a different model.",
        503,
        { type: "server_error", code: "no_entitled_accounts" },
      ),
    };
  }

  let attempts = 0;

  for (const account of ordered) {
    if (attempts >= MAX_FAILOVERS) {
      failures.push(`stopped after ${attempts} accounts`);
      deps.logger.warn("failover budget exhausted", {
        model: options.model,
        attempts,
        candidates: ordered.length,
      });
      break;
    }
    attempts += 1;
    // Resolved once per account: the agent is pooled, and looking it up per
    // attempt would rebuild the map lookup on every retry. In sticky mode this
    // starts DIRECT (undefined): the host address is the cleanest signal and is
    // only abandoned for a proxy once it is refused (see initialRoute).
    let route = deps.proxyResolver?.initialRoute(account.id);

    // Three ways out of this loop: success, a dead credential, or a failure
    // that belongs to the request rather than the account. `refresh` forces one
    // token rotation after a 401; `escalate` retries once with a bigger token
    // budget when upstream reported an empty body.
    let refreshTried = false;
    let needRefresh = false;
    let escalated = false;
    let requestBody = body;
    // Egress changes made while serving this one request, and whether the
    // direct fallback has already been tried. A 429 is about the exit address,
    // not the account, so the answer is to change address and try again rather
    // than to walk the account pool.
    let proxySwitches = 0;
    let wentDirect = false;

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
        upstreamCalls += 1;
        usedExit = deps.proxyResolver?.describeExit(route?.proxyId) ?? "direct";
        upstream = await postChatCompletions(deps.config, requestBody, {
          authorization,
          taskId: options.taskId,
          ...(route?.dispatcher ? { dispatcher: route.dispatcher } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        const message = (error as Error).message;
        failures.push(`${account.id}: network ${message}`);
        deps.logger.warn("upstream request failed", {
          accountId: account.id,
          error: message,
        });
        // A transport failure through a proxy is not "the account is bad" — the
        // hop itself is broken. Park that exit so the next request does not draw
        // the same dead proxy and burn another account's attempt on it.
        deps.proxyResolver?.reportTransportFailure(route?.proxyId, message);
        break;
      }

      if (upstream.status === 401 || upstream.status === 403) {
        const detail = await upstream.text().catch(() => "");

        // A plan that does not cover this model, not a dead credential: the
        // token is fine and refreshing it changes nothing. Remember the account
        // cannot serve this model and move on — without the refresh-and-retry
        // the credential path would do, which doubles the upstream calls for
        // an answer that cannot differ.
        if (isEntitlementError(upstream.status, detail)) {
          markNotEntitled(account.id, options.model);
          // A Pass-only model refused here is direct evidence this account does
          // not hold Pass, which is what the index would otherwise have to
          // spend a plan lookup to learn.
          if (options.model.startsWith("cline-pass/")) deps.capabilities?.record(account.id, false);
          failures.push(`${account.id}: not entitled to model`);
          deps.logger.warn("account not entitled to model, failing over", {
            accountId: account.id,
            model: options.model,
          });
          break;
        }

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
          const reason = describeAccountScopedError(upstream.status, text);
          failures.push(`${account.id}: ${reason}`);
          // A free-tier quota failure is the only observable signal that this
          // account's free bucket is spent, so keep it for the admin view.
          if (reason === "daily free limit" || reason === "inference cap") {
            deps.freeQuota?.recordQuotaError(account.id, options.model, reason);
          }
          deps.logger.warn("account cannot serve model, failing over", {
            accountId: account.id,
            model: options.model,
            status: upstream.status,
          });
          break;
        }
        // A 429 carrying nothing account-specific came from the edge, not from
        // this account's quota: every other account would be refused by the
        // same edge, so walking the rest of the pool just multiplies the
        // traffic that caused it.
        //
        // What does help is leaving through a different address, which is the
        // whole point of the proxy pool. So the same account retries on a new
        // exit, and only once the pool has been walked (or the request has
        // already spent its switch budget) does the request fall back to a
        // direct connection — a worse address, but not another refused one.
        if (isProviderWideRateLimit(upstream.status, text)) {
          const limitedProxyId = route?.proxyId ?? null;
          // Cool whatever address just refused us — a proxy id, or the host's
          // own address when the route was direct (proxyId null). Cooling the
          // direct address is what makes the NEXT request start on a proxy
          // instead of re-paying one refused direct attempt every call.
          deps.proxyResolver?.reportRateLimited(limitedProxyId);

          const canSwitch = proxySwitches < MAX_PROXY_SWITCHES;
          if (canSwitch) {
            proxySwitches += 1;
            // Direct-first applies to the mid-request walk as well: the host
            // address is the cheapest and cleanest hop, so the moment its
            // cooldown has expired a request bouncing off proxies must return
            // to it instead of walking further down the proxy tiers. (The
            // request only started on a proxy because direct was cooling, and
            // long streams routinely outlive that 60s window.)
            if (limitedProxyId !== null && !wentDirect && !deps.proxyResolver?.directCooling()) {
              wentDirect = true;
              route = undefined;
              deps.logger.warn("direct egress recovered mid-request: preferring it over proxies", {
                accountId: account.id,
                model: options.model,
                from: deps.proxyResolver?.describeExit(limitedProxyId) ?? limitedProxyId,
                attempt: proxySwitches,
              });
              continue;
            }
            // After a direct 429 the direct address is cooling, so forRequest
            // hands back a proxy; after a proxy 429 it hands back a different
            // (or the same single) proxy. Either way the address changes.
            const next = deps.proxyResolver?.forRequest(account.id);
            // No progress means the pool has nothing else to offer (no proxy,
            // or every entry cooling). Retrying the same address is what turns
            // a throttle into a block, so only continue on a real change.
            if (next?.proxyId && next.proxyId !== limitedProxyId) {
              deps.logger.warn("upstream rate limit: switching proxy exit", {
                accountId: account.id,
                model: options.model,
                from: deps.proxyResolver?.describeExit(limitedProxyId) ?? "direct",
                to: deps.proxyResolver?.describeExit(next.proxyId) ?? next.proxyId,
                attempt: proxySwitches,
              });
              route = next;
              continue;
            }
          }

          // Out of switches (or nothing to switch to). If the refusal came from
          // a proxy and we have not tried direct yet, fall back to the host
          // address as the last resort.
          if (limitedProxyId !== null && !wentDirect) {
            wentDirect = true;
            route = undefined;
            deps.logger.warn("proxy exits exhausted: retrying direct", {
              accountId: account.id,
              model: options.model,
              lastExit: deps.proxyResolver?.describeExit(limitedProxyId) ?? "direct",
              switches: proxySwitches,
            });
            continue;
          }

          failures.push(`${account.id}: provider-wide rate limit`);
          deps.logger.warn("provider-wide rate limit, not failing over", {
            accountId: account.id,
            model: options.model,
            detail: text.slice(0, 200),
          });
          record(upstream.status, account.id, "provider-wide rate limit");
          return {
            kind: "error",
            response: new Response(text || JSON.stringify({ error: { message: "Too Many Requests" } }), {
              status: upstream.status,
              headers: {
                "content-type": upstream.headers.get("content-type") ?? "application/json",
              },
            }),
          };
        }

        deps.logger.warn("upstream error", {
          accountId: account.id,
          status: upstream.status,
          detail: text.slice(0, 300),
        });

        // An error the classifier does not recognise is assumed to belong to
        // the request rather than to this account, so it is returned as-is:
        // failing over would repeat a request that is already malformed.
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
      // Count response bytes as they stream to the client, and emit the
      // completion line for the persisted trail when the stream ends. The
      // proxy bill is mostly response side (streamed completions dwarf the
      // request), so this is the number that reconciles with the invoice.
      const counted = countResponseBody(upstream, deps.requests, requestId);
      return {
        kind: "ok",
        response: counted,
        accountId: account.id,
        recordUsage: recordUsage(account.id),
      };
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
