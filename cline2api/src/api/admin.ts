/** Admin surface: login orchestration, account management, and authenticated control APIs. */
import type { Context, Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import type { LoginMode, LoginService } from "../services/loginService.js";
import { extractBearer, safeEqual } from "./http.js";
import type { CredentialSaveInput } from "../store.js";
import type { StoredAccount } from "../cline/types.js";
import { ADMIN_PAGE } from "../webui/page.js";
import { chatCompletion, unwrapEnvelope } from "./openai.js";
import { callUpstreamWithFailover } from "../services/proxyChat.js";
import { probeAccount } from "../services/accountCheck.js";
import { probeFreeQuota, DEFAULT_FREE_PROBE_MODEL } from "../services/freeQuotaProbe.js";
import type { FreeQuotaStore } from "../services/freeQuota.js";
import type { RateLimiter } from "../services/rateLimit.js";
import type { SweepRunner } from "../services/sweep.js";
import { fetchSubscription, type SubscriptionInfo } from "../cline/subscription.js";
import { fetchUsageLimits, type UsageWindow } from "../cline/usage.js";
import { fetchAccountCredits, resolveWindow, type AccountCredits, type ModelUsage, type ResolvedWindow, type UsageWindowRequest } from "../cline/credits.js";
import { ProxyStore, parseProxyUrl, redactProxyUrl } from "../services/proxyStore.js";
import type { ProxyResolver } from "../cline/proxy.js";

export interface AdminRouteDeps extends OpenAIRouteDeps {
  login: LoginService;
  proxies: ProxyStore;
  /** Resolves an account's assigned proxy to a dispatcher. */
  resolver: ProxyResolver;
  /** Free-tier quota signals: what traffic hit, plus on-demand probe results. */
  freeQuota: FreeQuotaStore;
  /** Live rate-limit settings and counters. */
  rateLimit: RateLimiter;
  /** Pool-wide liveness sweep, running server-side. */
  sweep: SweepRunner;
}

function remoteAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function normalizeAddress(value: string | undefined): string | undefined {
  if (!value) return undefined;
  let address = value.trim().toLowerCase();
  if (address.startsWith("::ffff:")) address = address.slice("::ffff:".length);
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  return address;
}

function isLoopbackAddress(value: string | undefined): boolean {
  const address = normalizeAddress(value);
  return address === "::1" || address === "127.0.0.1" || address?.startsWith("127.") === true;
}

/**
 * Trust order matters behind a reverse proxy:
 * - A non-loopback TCP peer is never treated as local, even if it spoofs XFF.
 * - When the TCP peer is loopback, inspect the right-most XFF hop (the value a
 *   local proxy appends) instead of the attacker-controlled left-most hop.
 * - Missing remoteAddress is kept as local for Hono's in-process test adapter;
 *   the production @hono/node-server always supplies one.
 *
 * This is defense in depth, not a substitute for ADMIN_TOKEN. Publicly exposed
 * deployments MUST set ADMIN_TOKEN; see README section 7.
 */
function isLoopback(c: Context): boolean {
  const remote = remoteAddress(c);
  const forwardedFor = c.req.header("x-forwarded-for");
  const forwarded = forwardedFor
    ?.split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .at(-1);

  if (forwarded) return isLoopbackAddress(remote) && isLoopbackAddress(forwarded);
  return remote === undefined || isLoopbackAddress(remote);
}

function isAdminAuthorized(c: Context, deps: AdminRouteDeps): boolean {
  const token = deps.config.adminToken;
  if (!token) return isLoopback(c);
  const provided =
    extractBearer(c.req.header("authorization")) ?? c.req.query("token") ?? null;
  return provided !== null && safeEqual(provided, token);
}

/**
 * Server-side pagination for the account-backed lists.
 *
 * A pool of a few hundred accounts makes an unpaginated table both slow to
 * render and expensive to build: every row costs upstream calls, so fetching
 * all of them to display twenty wastes the upstream budget. Both the usage and
 * credits routes slice the same `store.list()` order with the same parameters,
 * which is what keeps the two tables aligned row-for-row in the overview.
 */
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 200;

interface PageRequest {
  page: number;
  pageSize: number;
  offset: number;
}

interface PageMeta extends PageRequest {
  total: number;
  totalPages: number;
}

function resolvePage(query: (name: string) => string | undefined, total: number): PageMeta {
  const rawSize = Number.parseInt(query("pageSize") ?? "", 10);
  const pageSize =
    Number.isFinite(rawSize) && rawSize > 0 ? Math.min(rawSize, MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const rawPage = Number.parseInt(query("page") ?? "", 10);
  // Clamp rather than reject: a page past the end is what a shrinking pool
  // looks like, and the UI recovers by simply showing the last page.
  const page = Number.isFinite(rawPage) && rawPage > 0 ? Math.min(rawPage, totalPages) : 1;
  return { page, pageSize, offset: (page - 1) * pageSize, total, totalPages };
}

/** One account's plan + usage windows, as shown in the admin UI. */
interface AccountUsageRow {
  id: string;
  email: string | null;
  disabled: boolean;
  lastError: string | null;
  plan: SubscriptionInfo | null;
  limits: UsageWindow[];
  error: string | null;
}

const USAGE_CACHE_TTL_MS = 60_000;
const usageCache = new Map<string, { at: number; row: AccountUsageRow }>();

async function collectUsage(
  deps: AdminRouteDeps,
  page: PageMeta,
): Promise<{ accounts: AccountUsageRow[] } & Omit<PageMeta, "offset">> {
  const accounts = deps.store.list().slice(page.offset, page.offset + page.pageSize);
  const rows = await mapWithConcurrency(accounts, CREDITS_CONCURRENCY, async (account) => {
    const cached = usageCache.get(account.id);
    if (cached && Date.now() - cached.at < USAGE_CACHE_TTL_MS) return cached.row;

    const row: AccountUsageRow = {
      id: account.id,
      email: account.email,
      disabled: account.disabled,
      lastError: account.lastError,
      plan: null,
      limits: [],
      error: null,
    };

    const authorization = await deps.tokens
      // A disabled account is an operator choice, not a dead token. Forcing the
      // refresh keeps its refresh token rotating even while it is out of the
      // pool, so it can be turned back on later instead of needing a re-login.
      .getAuthorization(account.id, account.disabled ? { forceRefresh: true } : {})
      .catch(() => null);
    if (!authorization) {
      row.error = "re-login required";
      return row;
    }
    const dispatcher = deps.resolver.forAccount(account.id);
    const [plan, usage] = await Promise.all([
      fetchSubscription(deps.config, authorization, deps.logger, dispatcher),
      fetchUsageLimits(deps.config, authorization, deps.logger, dispatcher),
    ]);
    row.plan = plan;
    row.limits = usage.limits;
    row.error = plan.error ?? usage.error;
    usageCache.set(account.id, { at: Date.now(), row });
    return row;
  });
  return { accounts: rows, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages };
}

/**
 * Credit balances and window token totals, one row per account.
 *
 * Each row costs three upstream calls (uid, balance, usages), so a 90-account
 * pool is 270 requests; pagination keeps that to the rows actually on screen,
 * CREDITS_CONCURRENCY bounds the burst, and the whole result is cached for
 * CREDITS_CACHE_TTL_MS.
 */
interface AccountCreditsRow extends AccountCredits {
  id: string;
  email: string | null;
  disabled: boolean;
  lastError: string | null;
}

const CREDITS_CACHE_TTL_MS = 5 * 60_000;
const CREDITS_CONCURRENCY = 6;
const creditsCache = new Map<string, { at: number; row: AccountCreditsRow }>();

/**
 * One background sweep of the whole pool per window, so the overview's
 * headline counters fill in without anyone paging through every account.
 * Keyed by the window; a newer request for the same window joins the one
 * already running instead of starting a second sweep.
 */
const poolSweeps = new Map<string, Promise<void>>();

function sweepKey(window: ResolvedWindow): string {
  return `${window.windowMs}:${window.snappedToDay}`;
}

/** Run `worker` over `items` with at most `limit` in flight, order preserved. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index] as T);
    }
  });
  await Promise.all(runners);
  return results;
}

/** An all-zero credits row, for an account whose token cannot be resolved. */
function emptyCreditsRow(
  base: { id: string; email: string | null; disabled: boolean; lastError: string | null },
  window: ResolvedWindow,
  error: string,
): AccountCreditsRow {
  return {
    ...base,
    uid: null,
    balanceMicroUsd: null,
    balanceUsd: null,
    balanceCredits: null,
    window: {
      requests: 0,
      promptTokens: 0,
      completionTokens: 0,
      cachedTokens: 0,
      totalTokens: 0,
      costUnits: 0,
      costUsd: 0,
      creditsMicroUsd: 0,
    },
    models: [],
    since: window.since,
    until: window.until,
    windowMs: window.windowMs,
    snappedToDay: window.snappedToDay,
    lastUsage: null,
    error,
  };
}

async function collectCredits(
  deps: AdminRouteDeps,
  page: PageMeta,
  options: { force?: boolean; window?: UsageWindowRequest } = {},
): Promise<{ accounts: AccountCreditsRow[] } & Omit<PageMeta, "offset">> {
  const resolved = resolveWindow(options.window ?? {});
  const accounts = deps.store.list().slice(page.offset, page.offset + page.pageSize);
  const rows = await creditRows(deps, accounts, resolved, options);
  return { accounts: rows, page: page.page, pageSize: page.pageSize, total: page.total, totalPages: page.totalPages };
}

/**
 * Fetch one credits row per account, serving fresh cache hits and only going
 * upstream for the rest. Shared by the paginated endpoint and the pool sweep,
 * so a page the UI already loaded is never fetched twice.
 */
async function creditRows(
  deps: AdminRouteDeps,
  accounts: readonly StoredAccount[],
  resolved: ResolvedWindow,
  options: { force?: boolean; window?: UsageWindowRequest } = {},
): Promise<AccountCreditsRow[]> {
  return mapWithConcurrency(accounts, CREDITS_CONCURRENCY, async (account) => {
    const base = {
      id: account.id,
      email: account.email,
      disabled: account.disabled,
      lastError: account.lastError,
    };
    const cached = creditsCache.get(account.id);
    // Keyed on the window *length*, not its absolute edges: a rolling window's
    // `since` moves every call, and matching on it would make a row fetched a
    // second ago look stale. Rows stay for the TTL, which bounds how far the
    // summed window can drift from "right now".
    if (
      !options.force &&
      cached &&
      cached.row.windowMs === resolved.windowMs &&
      cached.row.snappedToDay === resolved.snappedToDay &&
      Date.now() - cached.at < CREDITS_CACHE_TTL_MS
    ) {
      return cached.row;
    }

    const authorization = await deps.tokens
      .getAuthorization(account.id, account.disabled ? { forceRefresh: true } : {})
      .catch(() => null);
    if (!authorization) {
      return emptyCreditsRow(base, resolved, "re-login required");
    }

    const credits = await fetchAccountCredits(deps.config, authorization, deps.logger, {
      ...(options.window ?? {}),
      dispatcher: deps.resolver.forAccount(account.id),
    });
    const row: AccountCreditsRow = { ...base, ...credits };
    creditsCache.set(account.id, { at: Date.now(), row });
    return row;
  });
}

/**
 * Fill the credits cache for every account, in the background.
 *
 * The overview headline is a pool-wide sum, but the row endpoint only fetches
 * the page on screen. Without this, the sum only ever covers accounts someone
 * happened to page to. One sweep runs per window at a time; repeat requests
 * join it rather than stacking more upstream load on top.
 */
function sweepCreditsPool(
  deps: AdminRouteDeps,
  options: { window?: UsageWindowRequest } = {},
): { started: boolean; accounts: number } {
  const resolved = resolveWindow(options.window ?? {});
  const key = sweepKey(resolved);
  if (poolSweeps.has(key)) return { started: false, accounts: deps.store.count() };
  // A rolling window's edges move between the pages of a long sweep, so pin
  // them once here. Every row of this sweep then covers the same range, and
  // the cache compares windows by length rather than by those edges.
  const pinned: UsageWindowRequest = {
    now: resolved.until,
    windowMs: resolved.windowMs,
    snapToDay: resolved.snappedToDay,
  };
  const accounts = deps.store.list();
  const run = creditRows(deps, accounts, resolved, { window: pinned })
    .catch((error) => {
      deps.logger.warn("credit pool sweep failed", { error: (error as Error).message });
    })
    .finally(() => {
      poolSweeps.delete(key);
    });
  poolSweeps.set(key, run.then(() => undefined));
  return { started: true, accounts: accounts.length };
}


/**
 * Pool-wide credit summary over the same cache the rows come from.
 *
 * The overview's headline counters must cover the whole pool, not the page on
 * screen: reading every account upstream just to render "287 accounts used
 * 221M tokens" would cost ~861 requests per refresh. Instead this walks the
 * in-memory row cache, summing every row that matches the requested window and
 * reporting how many accounts it actually stands on. A stale or missing cache
 * means fewer rows contribute — which is why `covered` and `total` travel with
 * the sums, so the UI can say "based on 41/287" rather than print a quiet
 * undercount as fact.
 */
interface PoolCreditSummary {
  window: UsageWindowRequest & { windowMs: number; snappedToDay: boolean };
  totals: {
    requests: number;
    promptTokens: number;
    completionTokens: number;
    cachedTokens: number;
    totalTokens: number;
    costUsd: number;
    balanceMicroUsd: number;
    balanceKnown: number;
  };
  /** Accounts whose cached rows contributed to this summary. */
  covered: number;
  /** Accounts in the pool right now. */
  total: number;
}

function summarizeCreditsPool(deps: AdminRouteDeps, options: { window?: UsageWindowRequest } = {}): PoolCreditSummary {
  const resolved = resolveWindow(options.window ?? {});
  const now = Date.now();
  const totals = {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUsd: 0,
    balanceMicroUsd: 0,
    balanceKnown: 0,
  };
  let covered = 0;
  const ids = new Set(deps.store.list().map((account) => account.id));
  for (const entry of creditsCache.values()) {
    if (now - entry.at >= CREDITS_CACHE_TTL_MS) continue;
    if (!ids.has(entry.row.id)) continue;
    if (entry.row.windowMs !== resolved.windowMs || entry.row.snappedToDay !== resolved.snappedToDay) continue;
    covered += 1;
    const window = entry.row.window;
    totals.requests += window.requests;
    totals.promptTokens += window.promptTokens;
    totals.completionTokens += window.completionTokens;
    totals.cachedTokens += window.cachedTokens;
    totals.totalTokens += window.totalTokens;
    totals.costUsd += window.costUsd;
    if (entry.row.balanceMicroUsd !== null && entry.row.balanceMicroUsd !== undefined) {
      totals.balanceMicroUsd += entry.row.balanceMicroUsd;
      totals.balanceKnown += 1;
    }
  }
  return {
    window: {
      windowMs: resolved.windowMs,
      snappedToDay: resolved.snappedToDay,
    },
    totals,
    covered,
    total: ids.size,
  };
}

const MAX_IMPORT_BODY_BYTES = 2 * 1024 * 1024;
const MAX_IMPORT_ACCOUNTS = 5_000;
const MAX_IMPORT_ERRORS = 20;

interface ImportErrorRow {
  index: number;
  email: string | null;
  reason: string;
}

interface ValidatedImportAccount {
  input: CredentialSaveInput;
  email: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function validateImportAccount(
  value: unknown,
  index: number,
): { valid: ValidatedImportAccount } | { error: ImportErrorRow } {
  if (!isRecord(value)) {
    return { error: { index, email: null, reason: "account must be an object" } };
  }

  const rawEmail = value.email;
  const email = typeof rawEmail === "string" ? rawEmail.trim() : null;
  const fail = (reason: string): { error: ImportErrorRow } => ({
    error: { index, email, reason },
  });

  if (!nonEmptyString(rawEmail) || !email?.includes("@")) {
    return fail("email must be a string containing @");
  }
  if (!nonEmptyString(value.access)) return fail("access must be a non-empty string");
  if (!nonEmptyString(value.refresh)) return fail("refresh must be a non-empty string");
  if (typeof value.expires !== "number" || !Number.isFinite(value.expires) || value.expires <= 0) {
    return fail("expires must be a positive epoch number");
  }

  const tokenType = nonEmptyString(value.tokenType) ? value.tokenType.trim() : "Bearer";
  const provider = nonEmptyString(value.provider) ? value.provider.trim() : "cline";
  const label = typeof value.label === "string" ? value.label : null;
  const accountId = nonEmptyString(value.accountId) ? value.accountId.trim() : undefined;
  const expires = value.expires < 1e12 ? value.expires * 1000 : value.expires;

  return {
    valid: {
      email,
      input: {
        credentials: {
          email,
          access: value.access.trim(),
          refresh: value.refresh.trim(),
          expires,
          ...(accountId ? { accountId } : {}),
          metadata: { provider, tokenType },
        },
        options: { label, provider },
      },
    },
  };
}
export function registerAdminRoutes(app: Hono, deps: AdminRouteDeps): void {  app.get("/", (c) => {
    if (!isAdminAuthorized(c, deps)) {
      return c.text("Admin UI is not exposed here. Set ADMIN_TOKEN or use localhost.", 403);
    }
    return c.html(ADMIN_PAGE);
  });

  const guard = (c: Context): Response | null =>
    isAdminAuthorized(c, deps) ? null : c.json({ error: "unauthorized" }, 401);

  /**
   * Window selection for the credits routes.
   *
   * `hours` is a float so the UI can offer 0.5h as well as 168h; `anchor=day`
   * switches from the default rolling window to local midnight. Out-of-range
   * values are clamped rather than rejected — a slider at the end of its track
   * should read the widest allowed window, not error.
   */
  const windowQuery = (c: Context): UsageWindowRequest => {
    const hours = Number.parseFloat(c.req.query("hours") ?? "");
    return {
      ...(Number.isFinite(hours) && hours > 0 ? { windowMs: hours * 60 * 60 * 1000 } : {}),
      snapToDay: c.req.query("anchor") === "day",
    };
  };

  app.get("/admin/api/status", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const accounts = deps.store.list();
    const models = await deps.catalog.list();
    return c.json({
      upstream: deps.config.clineApiBaseUrl,
      workos: deps.config.workosApiBaseUrl,
      accounts: {
        total: accounts.length,
        active: accounts.filter((account) => !account.disabled).length,
        disabled: accounts.filter((account) => account.disabled).length,
      },
      models: { count: models.length },
      loginModes: ["device", "callback"] as const,
      refreshBufferMs: deps.config.refreshBufferMs,
    });
  });

  /**
 * Account list, paginated and filterable.
 *
 * Filtering happens before pagination so `total` counts what the filter
 * matches, not the whole pool — otherwise a search that matches three accounts
 * still reports a dozen pages.
 */
app.get("/admin/api/accounts", (c) => {
    const denied = guard(c);
    if (denied) return denied;

    const query = (c.req.query("q") ?? "").trim().toLowerCase();
    const status = c.req.query("status") ?? "all";
    const filtered = deps.store.list().filter((account) => {
      if (status === "active" && account.disabled) return false;
      if (status === "disabled" && !account.disabled) return false;
      if (query.length === 0) return true;
      const haystack = `${account.email ?? ""} ${account.label ?? ""} ${account.id}`.toLowerCase();
      return haystack.includes(query);
    });

    const page = resolvePage((name) => c.req.query(name), filtered.length);
    return c.json({
      accounts: filtered.slice(page.offset, page.offset + page.pageSize).map((account) => ({
        id: account.id,
        email: account.email,
        label: account.label,
        provider: account.provider,
        disabled: account.disabled,
        lastError: account.lastError,
        proxyId: account.proxyId ?? null,
        expiresAt: account.expires,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })),
      page: page.page,
      pageSize: page.pageSize,
      total: page.total,
      totalPages: page.totalPages,
    });
  });

  /**
   * Toggle an account, or relabel it.
   *
   * Disabling is a manual override that survives token refreshes: the store
   * writes `disabled` on the record, and TokenManager honours it. Re-enabling
   * clears `lastError` too, because that field is what put the account out of
   * rotation in the first place and leaving it set would make the UI show a
   * healthy account as broken.
   */
  app.patch("/admin/api/accounts/:id", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { disabled?: unknown; label?: unknown; proxyId?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const patch: {
      disabled?: boolean;
      label?: string | null;
      lastError?: string | null;
      proxyId?: string | null;
    } = {};
    if (typeof body.disabled === "boolean") {
      patch.disabled = body.disabled;
      if (!body.disabled) patch.lastError = null;
    }
    if (body.label === null || typeof body.label === "string") patch.label = body.label;
    if (body.proxyId === null) {
      patch.proxyId = null;
    } else if (typeof body.proxyId === "string" && body.proxyId.length > 0) {
      // Validated here rather than at request time: an account pointing at a
      // proxy that does not exist would fail open (direct egress) and look
      // configured in the UI while doing nothing.
      if (!deps.proxies.get(body.proxyId)) {
        return c.json({ error: "unknown proxy" }, 400);
      }
      patch.proxyId = body.proxyId;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "nothing to update: pass `disabled`, `label` or `proxyId`" }, 400);
    }

    const updated = deps.store.update(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "unknown account" }, 404);
    return c.json({
      account: {
        id: updated.id,
        email: updated.email,
        label: updated.label,
        disabled: updated.disabled,
        lastError: updated.lastError,
        proxyId: updated.proxyId ?? null,
      },
    });
  });

  app.delete("/admin/api/accounts/:id", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const removed = deps.store.remove(c.req.param("id"));
    return c.json({ removed });
  });

  /** Batch account import for an external registrar. Invalid rows are skipped. */
  app.post("/admin/api/accounts/import", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    const declaredLength = Number.parseInt(c.req.header("content-length") ?? "", 10);
    if (Number.isFinite(declaredLength) && declaredLength > MAX_IMPORT_BODY_BYTES) {
      return c.json({ error: "request body exceeds 2 MB" }, 413);
    }

    const rawBody = await c.req.text().catch(() => "");
    if (Buffer.byteLength(rawBody, "utf8") > MAX_IMPORT_BODY_BYTES) {
      return c.json({ error: "request body exceeds 2 MB" }, 413);
    }

    let payload: unknown;
    try {
      payload = JSON.parse(rawBody) as unknown;
    } catch {
      return c.json({ error: "request body must be valid JSON" }, 400);
    }
    if (!isRecord(payload) || !Array.isArray(payload.accounts)) {
      return c.json({ error: "accounts must be an array" }, 400);
    }
    if (payload.accounts.length > MAX_IMPORT_ACCOUNTS) {
      return c.json({ error: `accounts must contain at most ${MAX_IMPORT_ACCOUNTS} entries` }, 400);
    }

    const errors: ImportErrorRow[] = [];
    const inputs: CredentialSaveInput[] = [];
    let skipped = 0;

    payload.accounts.forEach((value, index) => {
      const result = validateImportAccount(value, index);
      if ("error" in result) {
        skipped += 1;
        if (errors.length < MAX_IMPORT_ERRORS) errors.push(result.error);
        return;
      }
      inputs.push(result.valid.input);
    });

    const saved = deps.store.saveCredentialsBatch(inputs);
    let imported = 0;
    let updated = 0;
    for (const result of saved) {
      if (result.created) imported += 1;
      else updated += 1;
    }

    return c.json({
      imported,
      updated,
      skipped,
      total: payload.accounts.length,
      errors,
    });
  });

  app.get("/admin/api/login/modes", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({ modes: ["device", "callback"] as const, defaultMode: "device" as const });
  });

  app.post("/admin/api/login/start", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let mode: LoginMode = "device";
    try {
      const body = (await c.req.json()) as { mode?: unknown } | null;
      if (body !== null && typeof body.mode === "string") {
        if (body.mode !== "device" && body.mode !== "callback") {
          return c.json({ error: "mode must be device or callback" }, 400);
        }
        mode = body.mode;
      }
    } catch {
      // An empty body means the backward-compatible default: device code.
    }

    try {
      const session = await deps.login.start(mode);
      return c.json(session);
    } catch (error) {
      deps.logger.warn(`failed to start ${mode} login`, { error: (error as Error).message });
      return c.json({ error: (error as Error).message }, 502);
    }
  });
  app.get("/admin/api/login/:id", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const session = deps.login.get(c.req.param("id"));
    if (!session) return c.json({ error: "unknown session" }, 404);
    return c.json(session);
  });

  app.post("/admin/api/login/:id/cancel", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({ cancelled: deps.login.cancel(c.req.param("id")) });
  });

  /** Catalog split by billing bucket, for the admin model browser. */
  app.get("/admin/api/models", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const entries = await deps.catalog.list();
    const models = entries.map((entry) => ({
      id: entry.id,
      ownedBy: entry.owned_by,
      bucket: entry.bucket,
    }));
    return c.json({
      models,
      counts: {
        total: models.length,
        pass: models.filter((m) => m.bucket === "pass").length,
        free: models.filter((m) => m.bucket === "free").length,
        credits: models.filter((m) => m.bucket === "credits").length,
      },
    });
  });

  /**
   * Subscription state of the first usable account. A Cline Pass only covers
   * the `cline-pass/*` models; everything else bills against Cline Credits, so
   * the UI needs both facts side by side.
   */
  app.get("/admin/api/subscription", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const account = deps.pool.candidates()[0];
    if (!account) {
      return c.json({ plan: null, account: null, error: "no_accounts" });
    }
    const authorization = await deps.tokens.getAuthorization(account.id).catch(() => null);
    if (!authorization) {
      return c.json({ plan: null, account: { id: account.id, email: account.email }, error: "re-login required" });
    }
    const plan = await fetchSubscription(deps.config, authorization, deps.logger);
    return c.json({ plan, account: { id: account.id, email: account.email } });
  });

  /**
   * Per-account subscription + usage windows.
   *
   * Every account gets its own row: a pool mixes accounts with different plans
   * and different remaining quota, so showing only the first account's limits
   * would hide exactly the number that decides whether requests will succeed.
   * Upstream is queried at most once per account per TTL.
   */
  app.get("/admin/api/usage", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const page = resolvePage((name) => c.req.query(name), deps.store.count());
    return c.json(await collectUsage(deps, page));
  });

  /**
   * Pool-wide liveness sweep: status, start, cancel.
   *
   * Server-side so a several-hundred-account pass survives navigating away from
   * the page. `start` with a model runs a real completion per account (pinned,
   * so a failure is that account's); without one it only proves the credential.
   */
  app.get("/admin/api/sweep", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({ sweep: deps.sweep.status() });
  });

  app.post("/admin/api/sweep", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as {
      model?: unknown;
      activeOnly?: unknown;
      failedOnly?: unknown;
      concurrency?: unknown;
    };
    const result = deps.sweep.start({
      model: typeof body.model === "string" ? body.model : null,
      activeOnly: body.activeOnly === true,
      failedOnly: body.failedOnly === true,
      concurrency: typeof body.concurrency === "number" ? body.concurrency : undefined,
    });
    return c.json({ started: result.started, sweep: result.state });
  });

  app.post("/admin/api/sweep/cancel", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({ cancelled: deps.sweep.cancel(), sweep: deps.sweep.status() });
  });

  /**
   * Rate-limit settings plus live usage.
   *
   * `keys` counts keys that have made a request inside the current window, so
   * the console can say "12 keys active" rather than implying the whole pool of
   * client keys is being counted.
   */
  app.get("/admin/api/rate-limit", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json(deps.rateLimit.snapshot());
  });

  /**
   * Update the ceilings. Values are clamped server-side, and the sanitized
   * result is returned so the UI shows what was actually stored.
   */
  app.patch("/admin/api/rate-limit", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as Record<string, unknown>;
    const patch: { enabled?: boolean; globalPerMinute?: number; keyPerMinute?: number } = {};
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (typeof body.globalPerMinute === "number") patch.globalPerMinute = body.globalPerMinute;
    if (typeof body.keyPerMinute === "number") patch.keyPerMinute = body.keyPerMinute;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "nothing to update: pass `enabled`, `globalPerMinute` or `keyPerMinute`" }, 400);
    }
    const settings = deps.rateLimit.update(patch);
    deps.logger.info("rate limit settings updated", { ...settings });
    return c.json({ ...deps.rateLimit.snapshot(), settings });
  });

  /**
   * Clear the in-memory counters.
   *
   * Useful right after lowering a ceiling or when a runaway client has been
   * fixed: the window is otherwise a minute of history nobody wants to wait out.
   */
  app.post("/admin/api/rate-limit/reset", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    deps.rateLimit.reset();
    return c.json(deps.rateLimit.snapshot());
  });

  /**
   * Per-account credit balance plus the window's token totals.
   *
   * Separate from /admin/api/usage because the two answer different questions
   * and fail differently: usage windows 404 on an account with no plan (most
   * of a bulk-registered pool), while the balance is readable for every
   * account that can still authenticate.
   */
  app.get("/admin/api/credits", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const page = resolvePage((name) => c.req.query(name), deps.store.count());
    const force = c.req.query("refresh") === "1";
    return c.json(await collectCredits(deps, page, { force, window: windowQuery(c) }));
  });

  /**
   * Per-model usage over the selected window, across the whole pool.
   *
   * Built from the same per-account usage rows that feed the credits table, so
   * the two always agree. Coverage is reported for the same reason the summary
   * reports it: only accounts read recently contribute, and a model missing
   * from this list may just be one nobody has loaded yet.
   */
  app.get("/admin/api/usage/by-model", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const resolved = resolveWindow(windowQuery(c));
    const now = Date.now();
    const byId = new Map<string, ModelUsage>();
    let covered = 0;
    const ids = new Set(deps.store.list().map((account) => account.id));
    for (const entry of creditsCache.values()) {
      if (now - entry.at >= CREDITS_CACHE_TTL_MS) continue;
      if (!ids.has(entry.row.id)) continue;
      if (entry.row.windowMs !== resolved.windowMs) continue;
      if (entry.row.snappedToDay !== resolved.snappedToDay) continue;
      covered += 1;
      for (const model of entry.row.models ?? []) {
        const current = byId.get(model.id);
        if (current === undefined) {
          byId.set(model.id, { ...model });
          continue;
        }
        current.requests += model.requests;
        current.promptTokens += model.promptTokens;
        current.completionTokens += model.completionTokens;
        current.cachedTokens += model.cachedTokens;
        current.totalTokens += model.totalTokens;
        current.costUnits += model.costUnits;
        current.costUsd += model.costUsd;
        current.creditsMicroUsd += model.creditsMicroUsd;
      }
    }
    const models = [...byId.values()].sort(
      (a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id),
    );
    return c.json({
      models,
      covered,
      total: ids.size,
      window: { windowMs: resolved.windowMs, snappedToDay: resolved.snappedToDay },
    });
  });

  /**
   * Free-tier quota signals, keyed by account id.
   *
   * Two sources, kept distinct in the payload: `traffic` records what the pool
   * hit in real requests (free to collect), `probe` what an explicit probe saw.
   * Both are per day — upstream resets the free bucket on its own clock.
   */
  app.get("/admin/api/free-quota", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const accounts = deps.store.list();
    const signals = deps.freeQuota.snapshot(accounts.map((account) => account.id));
    return c.json({
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        disabled: account.disabled,
        signal: signals[account.id] ?? null,
      })),
      probeModel: DEFAULT_FREE_PROBE_MODEL,
      checkedAt: Date.now(),
    });
  });

  /**
   * Probe one account's free quota with a single minimal request.
   *
   * Costs one real (free-bucket) request, so it is on demand only — a sweep
   * across the pool belongs behind an explicit button, not a page load.
   */
  app.post("/admin/api/accounts/:id/free-quota", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const body = (await c.req.json().catch(() => ({}))) as { model?: unknown };
    const model = typeof body.model === "string" && body.model.length > 0 ? body.model : DEFAULT_FREE_PROBE_MODEL;
    const result = await probeFreeQuota(
      {
        config: deps.config,
        logger: deps.logger,
        store: deps.store,
        tokens: deps.tokens,
        chat: {
          config: deps.config,
          logger: deps.logger,
          pool: deps.pool,
          tokens: deps.tokens,
          store: deps.store,
          proxyResolver: deps.resolver,
          freeQuota: deps.freeQuota,
        },
        quota: deps.freeQuota,
      },
      c.req.param("id"),
      { model },
    );
    return c.json(result);
  });

  /**
   * Pool-wide credit summary for the overview headline counters.
   *
   * Reads only the in-memory row cache: the full-pool walk belongs to the
   * paginated row endpoint, where the UI explicitly asks for a page. Every
   * field this returns can also be derived from the per-account rows, so a
   * client can treat it as a rollup rather than a separate source of truth.
   */
  app.get("/admin/api/credits/summary", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const window = windowQuery(c);
    // Kick off a background sweep so the headline covers the whole pool, not
    // just the pages someone opened. It joins one already running for this
    // window, and the response below is whatever the cache holds right now.
    const sweep = sweepCreditsPool(deps, { window });
    const summary = summarizeCreditsPool(deps, { window });
    return c.json({ ...summary, refreshing: sweep.started || poolSweeps.has(sweepKey(resolveWindow(window))) });
  });

  /**
   * Liveness check for one account: does its credential still work?
   *
   * Forces a token refresh and calls `/users/me`, so it costs no inference.
   * This is what separates "the account is fine" from "the account has not
   * been used since its refresh token was revoked".
   */
  app.post("/admin/api/accounts/:id/probe", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const result = await probeAccount(
      { config: deps.config, logger: deps.logger, store: deps.store, tokens: deps.tokens },
      c.req.param("id"),
    );
    return c.json(result, result.ok ? 200 : 200);
  });

  /**
   * Send one real request through one specific account, for a chosen model.
   *
   * Pinned: failover is disabled so the result describes this account rather
   * than whichever account in the pool could answer. `stream` is forced off —
   * a streaming body would be buffered here purely to measure it, and the
   * caller wants a verdict, not text.
   */
  app.post("/admin/api/accounts/:id/test", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { model?: unknown; prompt?: unknown; maxTokens?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (model.length === 0) return c.json({ error: "`model` is required" }, 400);

    const accountId = c.req.param("id");
    if (!deps.store.get(accountId)) return c.json({ error: "unknown account" }, 404);

    const prompt =
      typeof body.prompt === "string" && body.prompt.trim().length > 0
        ? body.prompt.trim()
        : "只回复两个字：可用";
    // Reasoning models can spend a small budget entirely on thinking and
    // return nothing, which would read as a broken account. Give them room.
    const maxTokens =
      typeof body.maxTokens === "number" && Number.isFinite(body.maxTokens) && body.maxTokens > 0
        ? Math.min(Math.floor(body.maxTokens), 8192)
        : 2048;

    const startedAt = Date.now();
    const outcome = await callUpstreamWithFailover(
      deps,
      {
        model,
        messages: [{ role: "user", content: prompt }],
        max_tokens: maxTokens,
        stream: false,
      },
      { taskId: `admin-test-${accountId}`, model, stream: false, onlyAccountId: accountId },
    );
    const latencyMs = Date.now() - startedAt;

    if (outcome.kind === "error") {
      const text = await outcome.response.text().catch(() => "");
      return c.json({
        ok: false,
        accountId,
        model,
        latencyMs,
        status: outcome.response.status,
        error: text.slice(0, 500) || `HTTP ${outcome.response.status}`,
      });
    }

    const raw = await outcome.response.text().catch(() => "");
    let content: string | null = null;
    let usage: unknown = null;
    try {
      const parsed = unwrapEnvelope(JSON.parse(raw)) as {
        choices?: Array<{ message?: { content?: unknown } }>;
        usage?: unknown;
      };
      const first = parsed.choices?.[0]?.message?.content;
      content = typeof first === "string" ? first : null;
      usage = parsed.usage ?? null;
    } catch {
      // A 200 with an unparseable body is still a working account; report the
      // account as up and leave the content empty rather than failing it.
    }

    return c.json({
      ok: true,
      accountId,
      model,
      latencyMs,
      status: 200,
      content: content === null ? "" : content.slice(0, 500),
      usage,
      error: null,
    });
  });

  /**
   * Upstream proxy pool.
   *
   * URLs come back redacted — the stored form carries credentials in the
   * userinfo, so echoing it would put proxy passwords in browser history and
   * in any screenshot of the admin page. `usedBy` lets the UI warn before a
   * delete and makes an idle proxy visible.
   */
  app.get("/admin/api/proxies", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const accounts = deps.store.list();
    return c.json({
      proxies: deps.proxies.list().map((proxy) => ({
        id: proxy.id,
        label: proxy.label,
        url: redactProxyUrl(proxy.url),
        enabled: proxy.enabled,
        createdAt: proxy.createdAt,
        updatedAt: proxy.updatedAt,
        lastError: proxy.lastError,
        usedBy: accounts.filter((account) => account.proxyId === proxy.id).length,
      })),
    });
  });

  app.post("/admin/api/proxies", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { url?: unknown; label?: unknown; enabled?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    if (typeof body.url !== "string") return c.json({ error: "`url` is required" }, 400);

    const parsed = parseProxyUrl(body.url);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const duplicate = deps.proxies.list().find((proxy) => proxy.url === parsed.url);
    if (duplicate) return c.json({ error: "this proxy is already configured", id: duplicate.id }, 409);

    const created = deps.proxies.add({
      url: parsed.url,
      label: typeof body.label === "string" ? body.label : null,
      enabled: body.enabled !== false,
    });
    deps.logger.info("proxy added", { proxyId: created.id });
    return c.json({ proxy: { ...created, url: redactProxyUrl(created.url) } }, 201);
  });

  app.patch("/admin/api/proxies/:id", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { url?: unknown; label?: unknown; enabled?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const patch: { url?: string; label?: string | null; enabled?: boolean; lastError?: string | null } = {};
    if (typeof body.url === "string") {
      const parsed = parseProxyUrl(body.url);
      if ("error" in parsed) return c.json({ error: parsed.error }, 400);
      patch.url = parsed.url;
      // A new URL invalidates the old transport failure: leaving it set would
      // show a working proxy as broken until something failed again.
      patch.lastError = null;
    }
    if (body.label === null || typeof body.label === "string") patch.label = body.label;
    if (typeof body.enabled === "boolean") patch.enabled = body.enabled;
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "nothing to update: pass `url`, `label` or `enabled`" }, 400);
    }

    const updated = deps.proxies.update(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "unknown proxy" }, 404);
    return c.json({ proxy: { ...updated, url: redactProxyUrl(updated.url) } });
  });

  /**
   * Delete a proxy.
   *
   * Refused while accounts still reference it. Deleting anyway would leave
   * those accounts silently egressing from the host's own IP, which is the
   * exact thing the proxy existed to prevent — and it would not be visible
   * anywhere afterwards. `?force=1` reassigns them to direct in one step.
   */
  app.delete("/admin/api/proxies/:id", (c) => {
    const denied = guard(c);
    if (denied) return denied;

    const proxyId = c.req.param("id");
    if (!deps.proxies.get(proxyId)) return c.json({ error: "unknown proxy" }, 404);

    const holders = deps.store.list().filter((account) => account.proxyId === proxyId);
    const force = c.req.query("force") === "1";
    if (holders.length > 0 && !force) {
      return c.json(
        {
          error: `proxy is in use by ${holders.length} account(s)`,
          usedBy: holders.length,
          hint: "reassign them first, or repeat with ?force=1 to unassign",
        },
        409,
      );
    }
    for (const account of holders) deps.store.update(account.id, { proxyId: null });
    const removed = deps.proxies.remove(proxyId);
    deps.logger.info("proxy removed", { proxyId, unassigned: holders.length });
    return c.json({ removed, unassigned: holders.length });
  });

  /** Recent requests, newest first. */
  app.get("/admin/api/requests", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    if (!deps.requests) return c.json({ entries: [], stats: { total: 0, ok: 0, failed: 0, last5Minutes: 0 } });
    const requested = Number.parseInt(c.req.query("limit") ?? "100", 10);
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, 200) : 100;
    return c.json({ entries: deps.requests.list(limit), stats: deps.requests.stats() });
  });

  /**
   * Client API keys.
   *
   * The plaintext is returned exactly once, inside the create/rotate response.
   * Listing and updates never carry it — an operator who can read the admin
   * token could already exfiltrate by other means, but nothing in this surface
   * should make it easier, and a key table that echoes secrets ends up in
   * screenshots and browser history.
   */
  app.get("/admin/api/keys", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({ keys: deps.apiKeys.list() });
  });

  app.post("/admin/api/keys", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { label?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      body = {};
    }
    const label = typeof body.label === "string" && body.label.trim().length > 0
      ? body.label.trim().slice(0, 120)
      : null;
    const { record, plaintext } = deps.apiKeys.create(label);
    return c.json({ key: record, plaintext }, 201);
  });

  app.patch("/admin/api/keys/:id", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { enabled?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    if (typeof body.enabled !== "boolean") {
      return c.json({ error: "`enabled` must be a boolean" }, 400);
    }
    const result = deps.apiKeys.setEnabled(c.req.param("id"), body.enabled);
    if (result === null) return c.json({ error: "unknown key" }, 404);
    if ("error" in result) return c.json({ error: result.error }, 409);
    return c.json({ key: result });
  });

  /**
   * Rotate: the old secret stops working and a new one is returned once.
   *
   * Rotation is not delete-then-create, because there is a moment in between
   * where a racing in-flight request would fail with 401 for no operational
   * reason. The row (label, id, created-at) survives; only the secret and its
   * usage counters are replaced.
   */
  app.post("/admin/api/keys/:id/rotate", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const result = deps.apiKeys.rotate(c.req.param("id"));
    if (!result) return c.json({ error: "unknown key" }, 404);
    return c.json({ key: result.record, plaintext: result.plaintext });
  });

  app.delete("/admin/api/keys/:id", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const result = deps.apiKeys.remove(c.req.param("id"));
    if (result === false) return c.json({ error: "unknown key" }, 404);
    if (typeof result === "object" && "error" in result) {
      return c.json({ error: result.error }, 409);
    }
    return c.json({ removed: true });
  });

  /**
   * Playground: same chat path as /v1, authenticated with the admin token
   * instead of the client key so the browser never needs the client key.
   */
  app.post("/admin/api/chat", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return chatCompletion(c, deps);
  });
}
