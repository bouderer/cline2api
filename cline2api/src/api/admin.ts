/** Admin surface: login orchestration, account management, and authenticated control APIs. */
import type { Context, Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import type { LoginMode, LoginService } from "../services/loginService.js";
import { extractBearer, safeEqual } from "./http.js";
import { readCookie, type AdminAuth } from "../services/adminAuth.js";
import { AdminSettingsError, type AdminSettings } from "../services/adminSettings.js";
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
import type { UsageLedger } from "../services/usageLedger.js";
import { fetchSubscription, type SubscriptionInfo } from "../cline/subscription.js";
import { fetchUsageLimits, type UsageWindow } from "../cline/usage.js";
import { fetchAccountCredits, bucketUsage, bucketUsageByModel, resolveWindow, COST_UNITS_PER_USD, type AccountCredits, type ModelUsage, type ResolvedWindow, type UsageRecord, type UsageWindowRequest } from "../cline/credits.js";
import { ProxyStore, isProxyMode, isProxyPriority, parseProxyUrl, redactProxyUrl } from "../services/proxyStore.js";
import { probeProxyExit, probeProxyCline } from "../services/proxyExit.js";
import type { ProxyResolver } from "../cline/proxy.js";
import type { CapabilityIndex } from "../services/accountCapabilities.js";

export interface AdminRouteDeps extends OpenAIRouteDeps {
  login: LoginService;
  proxies: ProxyStore;
  /** Resolves an account's assigned proxy to a dispatcher. */
  resolver: ProxyResolver;
  /** Free-tier quota signals: what traffic hit, plus on-demand probe results. */
  freeQuota: FreeQuotaStore;
  /** Which accounts hold which plan, for routing Pass-only models. */
  capabilities: CapabilityIndex;
  /** Live rate-limit settings and counters. */
  rateLimit: RateLimiter;
  /** Pool-wide liveness sweep, running server-side. */
  sweep: SweepRunner;
  /** Token counts of traffic this gateway served, written as it happens. */
  usageLedger: UsageLedger;
  /** Username/password sessions for the console. */
  adminAuth: AdminAuth;
  /** Password and admin-token changes made from the settings page. */
  adminSettings: AdminSettings;
  /** The live admin token, which the settings page can rotate at runtime. */
  getAdminToken: () => string | null;
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

const SESSION_COOKIE = "cline2api_session";

/**
 * A request is an admin when any one of these holds:
 * - a live console session cookie, from a username/password login;
 * - a Bearer `ADMIN_TOKEN`, which the registrar and scripts use;
 * - the process is on loopback and no `ADMIN_TOKEN` is configured at all.
 *
 * The `?token=` query form is intentionally gone: it is what leaked the token
 * into URLs, browser history, and `Referer`, and it is what the console lost
 * on every navigation.
 */
function isAdminAuthorized(c: Context, deps: AdminRouteDeps): boolean {
  const session = readCookie(c.req.header("cookie"), SESSION_COOKIE);
  if (deps.adminAuth.authenticate(session)) return true;
  const token = deps.getAdminToken();
  if (!token) return isLoopback(c);
  const provided = extractBearer(c.req.header("authorization"));
  return provided !== null && safeEqual(provided, token);
}

function sessionCookie(token: string, maxAgeSeconds: number, secure: boolean): string {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    "HttpOnly",
    "Path=/",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
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
/**
 * Cached per-account credits rows.
 *
 * The raw usage records are kept alongside the summed row: the timeline needs
 * them to bucket by time, and re-fetching every account's ledger just to draw a
 * chart would multiply the upstream cost of opening the overview. They are
 * dropped for rows whose token could not be resolved, where there are none.
 */
const creditsCache = new Map<
  string,
  { at: number; row: AccountCreditsRow; records: readonly UsageRecord[] }
>();

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
    records: [],
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
    creditsCache.set(account.id, { at: Date.now(), row, records: credits.records });
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
    /** Credits drawn from balances over the window, micro-USD. */
    creditsUsedMicroUsd: number;
    /** Accounts in the window that actually drew on a balance. */
    creditsUsedKnown: number;
    /** Accounts with a positive remaining balance. */
    balancePositive: number;
    /** Accounts at or below zero — they cannot serve paid models. */
    balanceNegative: number;
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
    /**
     * Credits drawn from balances over the window, micro-USD.
     *
     * Separate from `balanceMicroUsd`, which is the *remaining* balance and is
     * a snapshot rather than a window sum: the two measure different things and
     * adding them together would be meaningless. Zero across a free-tier or
     * Pass pool, where traffic bills to the subscription instead.
     */
    creditsUsedMicroUsd: 0,
    /** Accounts in the window that actually drew on a balance. */
    creditsUsedKnown: 0,
    balancePositive: 0,
    balanceNegative: 0,
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
    totals.creditsUsedMicroUsd += window.creditsMicroUsd;
    if (window.creditsMicroUsd > 0) totals.creditsUsedKnown += 1;
    if (entry.row.balanceMicroUsd !== null && entry.row.balanceMicroUsd !== undefined) {
      totals.balanceMicroUsd += entry.row.balanceMicroUsd;
      totals.balanceKnown += 1;
      if (entry.row.balanceMicroUsd > 0) totals.balancePositive += 1;
      else totals.balanceNegative += 1;
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
export function registerAdminRoutes(app: Hono, deps: AdminRouteDeps): void {
  const serveAdminPage = (c: Context) => {
    // The page is served to everyone and gates itself: with no session it
    // shows the login screen, and every API call behind it is still guarded.
    // Refusing the document here is what made the login page unreachable —
    // the only way to see it was to already be authenticated.
    // The whole UI is one inlined HTML document with no asset URL to version,
    // so without this the browser applies heuristic caching and keeps serving
    // the previous build's markup and script after a redeploy — which reads as
    // "the new panel is missing" even though the server is serving it.
    return c.html(ADMIN_PAGE, 200, {
      "cache-control": "no-store, must-revalidate",
      pragma: "no-cache",
    });
  };
  app.get("/", serveAdminPage);
  // Client-side routes: every front-end path serves the same shell, so the
  // History API router can resolve /models, /console, /quota, etc. on load.
  app.get("/models", serveAdminPage);
  app.get("/console", serveAdminPage);
  app.get("/accounts", serveAdminPage);
  app.get("/quota", serveAdminPage);
  app.get("/proxies", serveAdminPage);
  app.get("/keys", serveAdminPage);
  app.get("/logs", serveAdminPage);
  app.get("/settings", serveAdminPage);

  const guard = (c: Context): Response | null =>
    isAdminAuthorized(c, deps) ? null : c.json({ error: "unauthorized" }, 401);

  app.post("/admin/api/auth/login", async (c) => {
    const body = await c.req.json().catch(() => null) as { username?: unknown; password?: unknown } | null;
    const username = typeof body?.username === "string" ? body.username : "";
    const password = typeof body?.password === "string" ? body.password : "";
    if (!deps.adminAuth.available()) {
      return c.json({ error: "登录未配置：找不到 grok-iq 的管理员账号" }, 503);
    }
    if (!deps.adminAuth.verify(username, password)) {
      return c.json({ error: "用户名或密码错误" }, 401);
    }
    const session = deps.adminAuth.createSession(username.trim());
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("set-cookie", sessionCookie(session.token, session.maxAgeSeconds, secure));
    return c.json({ ok: true, username: username.trim() });
  });

  app.post("/admin/api/auth/logout", (c) => {
    deps.adminAuth.revoke(readCookie(c.req.header("cookie"), SESSION_COOKIE));
    c.header("set-cookie", `${SESSION_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`);
    return c.json({ ok: true });
  });

  app.get("/admin/api/auth/status", (c) => {
    const username = deps.adminAuth.authenticate(readCookie(c.req.header("cookie"), SESSION_COOKIE));
    return c.json({ authenticated: username !== null, username, loginAvailable: deps.adminAuth.available() });
  });

  app.get("/admin/api/settings", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const username = deps.adminAuth.authenticate(readCookie(c.req.header("cookie"), SESSION_COOKIE));
    return c.json({
      username,
      passwordManaged: deps.config.grokIqDbPath !== null,
      token: deps.adminSettings.tokenStatus(deps.getAdminToken()),
      tokenManaged: deps.config.envFilePath !== null,
    });
  });

  app.post("/admin/api/settings/password", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const username = deps.adminAuth.authenticate(readCookie(c.req.header("cookie"), SESSION_COOKIE));
    if (!username) return c.json({ error: "请先登录后再修改密码" }, 403);
    const body = await c.req.json().catch(() => null) as { currentPassword?: unknown; newPassword?: unknown } | null;
    const currentPassword = typeof body?.currentPassword === "string" ? body.currentPassword : "";
    const newPassword = typeof body?.newPassword === "string" ? body.newPassword : "";
    try {
      deps.adminSettings.changePassword(username, currentPassword, newPassword, (u, p) => deps.adminAuth.verify(u, p));
    } catch (error) {
      if (error instanceof AdminSettingsError) return c.json({ error: error.message }, 400);
      throw error;
    }
    return c.json({ ok: true });
  });

  app.post("/admin/api/settings/token", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const body = await c.req.json().catch(() => null) as { token?: unknown } | null;
    const token = typeof body?.token === "string" ? body.token : "";
    try {
      const status = deps.adminSettings.setToken(token);
      deps.logger.info("admin token rotated from the settings page");
      return c.json({ ok: true, token: status });
    } catch (error) {
      if (error instanceof AdminSettingsError) return c.json({ error: error.message }, 400);
      throw error;
    }
  });

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
   * Usage over time, for the overview charts.
   *
   * Bucketed from the same per-account records the credits rows are built from,
   * so the chart and the table can never disagree. Empty buckets are kept as
   * zeros: a gap-free series would draw a straight line across an idle hour and
   * read as steady traffic.
   */
  app.get("/admin/api/usage/timeline", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const resolved = resolveWindow(windowQuery(c));
    const now = Date.now();
    const ids = new Set(deps.store.list().map((account) => account.id));
    // The charts read what this gateway itself served. That is already on
    // disk, so there is nothing to fetch and nothing to wait for — unlike the
    // per-account sweep, which asks upstream and takes minutes.
    const served = deps.usageLedger.range(resolved.since, resolved.until);
    const records: UsageRecord[] = served.map((entry) => ({
      id: "",
      at: entry.at,
      model: entry.model,
      operation: null,
      provider: null,
      promptTokens: entry.promptTokens,
      completionTokens: entry.completionTokens,
      totalTokens: entry.totalTokens,
      cachedTokens: entry.cachedTokens,
      // Market cost captured at serve time, in the ledger's USD; the bucket
      // field wants 1e-8-USD units (costUsd), so scale. Entries that predate
      // cost capture have no costUsd and stay 0 rather than inventing a value.
      costMicroUsd: Math.round((entry.costUsd ?? 0) * COST_UNITS_PER_USD),
      creditsUsed: 0,
    }));
    const covered = new Set(served.map((entry) => entry.accountId).filter((id) => id !== null)).size;
    const buckets = bucketUsage(records, resolved);
    // The same records, bucketed per model too: the two charts then share one
    // set of bucket boundaries and can be read against each other.
    const byModel = bucketUsageByModel(records, resolved);
    return c.json({
      buckets,
      models: byModel.models,
      covered,
      total: ids.size,
      window: {
        windowMs: resolved.windowMs,
        snappedToDay: resolved.snappedToDay,
        since: resolved.since,
        until: resolved.until,
      },
    });
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
    const window = windowQuery(c);
    const accounts = deps.store.list();
    const signals = deps.freeQuota.snapshot(accounts.map((account) => account.id));
    // The fullness meters read the same cache the usage table does, so on a
    // cold cache every account would draw at zero. `refresh=1` starts the same
    // pool sweep the usage page uses; without it the table still repaints from
    // whatever the cache holds. The sweep is a background job either way, so
    // the response below is what is known *now* — `refreshing` says a fuller
    // answer is coming and `covered` says how many accounts the meters stand on.
    const refresh = c.req.query("refresh") === "1";
    const sweep = refresh ? sweepCreditsPool(deps, { window }) : { started: false };
    return c.json({
      accounts: accounts.map((account) => ({
        id: account.id,
        email: account.email,
        disabled: account.disabled,
        signal: signals[account.id] ?? null,
        // Per-model consumption for this account, from the same cache the
        // usage table reads. The account row uses it to show how full each
        // free bucket is against the per-model daily ceiling.
        models: creditsCache.get(account.id)?.row.models ?? [],
        windowMs: creditsCache.get(account.id)?.row.windowMs ?? null,
      })),
      probeModel: DEFAULT_FREE_PROBE_MODEL,
      /** Free-tier ceiling per account per model, for the fullness bars. */
      freeLimitPerModel: deps.config.freeLimitTokensPerModel,
      /** True while a sweep is still filling the cache. */
      refreshing: sweep.started || poolSweeps.has(sweepKey(resolveWindow(window))),
      /** Accounts whose cached row contributed a meter above. */
      covered: accounts.reduce((n, account) => n + (creditsCache.has(account.id) ? 1 : 0), 0),
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
   * Which accounts hold which plan, and the sweep that finds out.
   *
   * `POST` starts a pool-wide plan read. It is a per-account upstream call, so
   * it is on demand rather than on page load — the same reasoning as the free
   * quota probe. `GET` reports what is known so far and whether a sweep is
   * still running, so the UI can poll instead of blocking on a job that takes
   * minutes on a pool this size.
   */
  app.get("/admin/api/capabilities", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const stats = deps.capabilities.stats();
    return c.json({
      ...stats,
      total: deps.store.count(),
      sweeping: deps.capabilities.sweeping(),
    });
  });

  app.post("/admin/api/capabilities/sweep", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const sweep = deps.capabilities.sweep();
    return c.json({
      started: sweep.started,
      accounts: sweep.accounts,
      ...deps.capabilities.stats(),
    });
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
    const all = deps.proxies.list().map((proxy) => ({
      id: proxy.id,
      label: proxy.label,
      url: redactProxyUrl(proxy.url),
      enabled: proxy.enabled,
      createdAt: proxy.createdAt,
      updatedAt: proxy.updatedAt,
      lastError: proxy.lastError,
      exitIp: proxy.exitIp,
      exitIpCheckedAt: proxy.exitIpCheckedAt,
      priority: proxy.priority,
      usedBy: accounts.filter((account) => account.proxyId === proxy.id).length,
    }));

    // A rotating pool runs to hundreds of entries, so the list view pages
    // rather than rendering all of them. Omitting `limit` still returns
    // everything: the account view builds its proxy dropdown from this same
    // endpoint and needs the complete set, not the first page of it.
    const limitRaw = Number(c.req.query("limit"));
    const offsetRaw = Number(c.req.query("offset"));
    const query = (c.req.query("q") ?? "").trim().toLowerCase();
    const filtered = query.length === 0
      ? all
      : all.filter((proxy) =>
          `${proxy.label ?? ""} ${proxy.url} ${proxy.exitIp ?? ""}`.toLowerCase().includes(query));
    // Priority-first ordering: the operator's own tier-0 entries lead, the
    // metered failover pool sorts to the back, and within a tier enabled rows
    // come before disabled ones (a wall of disabled pool entries should not
    // bury the live proxies). Stable tiebreak on createdAt keeps the order
    // from shuffling between page loads.
    filtered.sort(
      (a, b) =>
        a.priority - b.priority ||
        Number(b.enabled) - Number(a.enabled) ||
        a.createdAt - b.createdAt,
    );
    const total = filtered.length;
    const hasWindow = Number.isFinite(limitRaw) && limitRaw > 0;
    const limit = hasWindow ? Math.min(Math.floor(limitRaw), 500) : total;
    const offset = Number.isFinite(offsetRaw) && offsetRaw > 0 ? Math.floor(offsetRaw) : 0;
    const page = filtered.slice(offset, offset + limit);

    return c.json({
      proxies: page,
      total,
      offset,
      limit,
      mode: deps.proxies.getMode(),
      /** Enabled count across the whole pool, not just this page. */
      enabledTotal: all.filter((proxy) => proxy.enabled).length,
    });
  });

  /**
   * Add many proxies in one request.
   *
   * The registrar writes a list of hundreds at a time; one HTTP call per proxy
   * would make that a seconds-long loop and leave a half-imported pool behind if
   * it failed midway. Duplicates are reported rather than rejected, because the
   * common case is re-importing a list that overlaps the existing pool.
   */
  app.post("/admin/api/proxies/bulk", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { urls?: unknown; label?: unknown; enabled?: unknown; priority?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    const raw = typeof body.urls === "string" ? body.urls.split("\n") : body.urls;
    if (!Array.isArray(raw)) return c.json({ error: "`urls` must be an array or newline-separated string" }, 400);
    if (raw.length > 5000) return c.json({ error: "too many urls in one request (max 5000)" }, 400);
    if (body.priority !== undefined && !isProxyPriority(body.priority)) {
      return c.json({ error: "`priority` must be a non-negative integer" }, 400);
    }

    const existing = new Set(deps.proxies.list().map((proxy) => proxy.url));
    const labelPrefix = typeof body.label === "string" ? body.label.trim() : "";
    let added = 0;
    let duplicate = 0;
    const invalid: string[] = [];

    for (const entry of raw) {
      if (typeof entry !== "string") continue;
      const line = entry.trim();
      if (line.length === 0 || line.startsWith("#")) continue;
      const parsed = parseProxyUrl(line);
      if ("error" in parsed) {
        if (invalid.length < 10) invalid.push(`${line.slice(0, 60)}: ${parsed.error}`);
        continue;
      }
      if (existing.has(parsed.url)) {
        duplicate += 1;
        continue;
      }
      let label = labelPrefix.length > 0 ? labelPrefix : null;
      try {
        const host = new URL(parsed.url).hostname;
        label = labelPrefix.length > 0 ? `${labelPrefix}-${host}` : host;
      } catch {
        // Keep the bare prefix; the URL was already validated.
      }
      deps.proxies.add({
        url: parsed.url,
        label,
        enabled: body.enabled !== false,
        priority: body.priority,
      });
      existing.add(parsed.url);
      added += 1;
    }

    deps.logger.info("bulk proxies imported", { added, duplicate, invalid: invalid.length });
    return c.json({ added, duplicate, invalid, total: deps.proxies.list().length });
  });

  /**
   * Measure what address a proxy actually egresses from.
   *
   * Stored on the record so the list view can show it without probing on every
   * page load — a probe per row per render would be hundreds of outbound
   * requests each time an operator scrolled.
   */
  app.post("/admin/api/proxies/:id/probe", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const proxy = deps.proxies.get(c.req.param("id"));
    if (!proxy) return c.json({ error: "unknown proxy" }, 404);

    const result = await probeProxyExit(proxy.url, deps.logger);
    if (result.ok) {
      deps.proxies.update(proxy.id, {
        exitIp: result.exitIp,
        exitIpCheckedAt: Date.now(),
        lastError: null,
      });
      // A clean probe is the only signal that a transport-parked exit is alive
      // again — nothing else clears `unhealthy`, so a proxy that was pulled for
      // "fetch failed" only returns to the pool on this path.
      deps.resolver?.markHealthy(proxy.id);
      return c.json({ ok: true, exitIp: result.exitIp, latencyMs: result.latencyMs });
    }
    deps.proxies.update(proxy.id, { lastError: result.error, exitIpCheckedAt: Date.now() });
    return c.json({ ok: false, error: result.error });
  });

  /**
   * Probe whether a proxy can serve a gated free model through Cline.
   *
   * Distinct from the exit-IP probe: that one only proves reachability, this
   * one fires a real (free, 1-token) chat request through the proxy so the
   * product-surface gate on `cline-free/*` is actually exercised. Borrows one
   * live account's token; the account is chosen as the first enabled one and
   * only its credential is used — the request still leaves through the proxy.
   */
  app.post("/admin/api/proxies/:id/probe-cline", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const proxy = deps.proxies.get(c.req.param("id"));
    if (!proxy) return c.json({ error: "unknown proxy" }, 404);

    const account = deps.store.list().find((a) => !a.disabled);
    if (!account) return c.json({ error: "no enabled account to borrow a token from" }, 503);

    let authorization: string | null;
    try {
      authorization = await deps.tokens.getAuthorization(account.id);
    } catch (error) {
      return c.json({ error: `token resolution failed: ${(error as Error).message}` }, 502);
    }
    if (!authorization) return c.json({ error: "borrowed account needs re-login" }, 502);

    const result = await probeProxyCline(proxy.url, deps.config, authorization, deps.logger);
    deps.proxies.update(proxy.id, {
      lastError: result.ok ? null : (result.error ?? result.detail ?? `HTTP ${result.status}`),
    });
    return c.json(result, result.ok ? 200 : 502);
  });

  /**
   * Probe a batch of proxies, for filling the exit-IP column across a pool.
   *
   * Bounded and sequential on purpose: the pool can be hundreds of entries and
   * each probe opens a connection through a third party, so an unbounded fan-out
   * would be a burst of traffic at the provider for what is only a display
   * value.
   */
  app.post("/admin/api/proxies/probe-batch", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    let body: { ids?: unknown; missingOnly?: unknown; limit?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    const limit = Number.isFinite(Number(body.limit)) && Number(body.limit) > 0
      ? Math.min(Math.floor(Number(body.limit)), 100)
      : 30;

    const ids = Array.isArray(body.ids) ? body.ids.filter((id): id is string => typeof id === "string") : null;
    let targets = deps.proxies.list().filter((proxy) => proxy.enabled);
    if (ids) targets = targets.filter((proxy) => ids.includes(proxy.id));
    else if (body.missingOnly !== false) targets = targets.filter((proxy) => proxy.exitIp === null);
    targets = targets.slice(0, limit);

    let ok = 0;
    const failed: string[] = [];
    for (const proxy of targets) {
      const result = await probeProxyExit(proxy.url, deps.logger);
      if (result.ok) {
        deps.proxies.update(proxy.id, { exitIp: result.exitIp, exitIpCheckedAt: Date.now(), lastError: null });
        ok += 1;
      } else {
        deps.proxies.update(proxy.id, { lastError: result.error, exitIpCheckedAt: Date.now() });
        if (failed.length < 10) failed.push(`${proxy.label ?? proxy.id}: ${result.error}`);
      }
    }
    const remaining = deps.proxies.list().filter((p) => p.enabled && p.exitIp === null).length;
    return c.json({ probed: targets.length, ok, failed, remaining });
  });

  /**
   * Choose how requests pick a proxy: pinned, sticky, or rotate.
   *
   * A three-way setting rather than an on/off switch because the two spread
   * strategies solve different problems. Sticky holds one working address until
   * it is refused, which uses each address up to its own limit and keeps
   * connections alive; rotate spreads every request, which covers a pool that is
   * smaller per-address headroom but larger in count. Pinned is the escape hatch
   * that makes one account's egress reproducible.
   */
  app.post("/admin/api/proxies/mode", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    let body: { mode?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    if (!isProxyMode(body.mode)) {
      return c.json({ error: "`mode` must be one of pinned, sticky, rotate" }, 400);
    }
    const mode = deps.proxies.setMode(body.mode);
    // The resolver holds a sticky pick across requests; a mode change must not
    // leave it held from the previous strategy.
    deps.resolver.forgetSticky();
    deps.logger.info("proxy mode changed", { mode });
    return c.json({ mode });
  });

  app.post("/admin/api/proxies", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { url?: unknown; label?: unknown; enabled?: unknown; priority?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }
    if (typeof body.url !== "string") return c.json({ error: "`url` is required" }, 400);
    if (body.priority !== undefined && !isProxyPriority(body.priority)) {
      return c.json({ error: "`priority` must be a non-negative integer" }, 400);
    }

    const parsed = parseProxyUrl(body.url);
    if ("error" in parsed) return c.json({ error: parsed.error }, 400);

    const duplicate = deps.proxies.list().find((proxy) => proxy.url === parsed.url);
    if (duplicate) return c.json({ error: "this proxy is already configured", id: duplicate.id }, 409);

    const created = deps.proxies.add({
      url: parsed.url,
      label: typeof body.label === "string" ? body.label : null,
      enabled: body.enabled !== false,
      priority: body.priority,
    });
    deps.logger.info("proxy added", { proxyId: created.id });
    return c.json({ proxy: { ...created, url: redactProxyUrl(created.url) } }, 201);
  });

  app.patch("/admin/api/proxies/:id", async (c) => {
    const denied = guard(c);
    if (denied) return denied;

    let body: { url?: unknown; label?: unknown; enabled?: unknown; priority?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: "body must be valid JSON" }, 400);
    }

    const patch: {
      url?: string;
      label?: string | null;
      enabled?: boolean;
      lastError?: string | null;
      priority?: number;
    } = {};
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
    if (body.priority !== undefined) {
      if (!isProxyPriority(body.priority)) {
        return c.json({ error: "`priority` must be a non-negative integer" }, 400);
      }
      patch.priority = body.priority;
    }
    if (Object.keys(patch).length === 0) {
      return c.json({ error: "nothing to update: pass `url`, `label`, `enabled` or `priority`" }, 400);
    }

    const updated = deps.proxies.update(c.req.param("id"), patch);
    if (!updated) return c.json({ error: "unknown proxy" }, 404);
    // A URL change is a fresh start: the exit that failed before is not the exit
    // this request would take now, so any parked state from the old URL has to go
    // with it, or the replacement would sit out of rotation for no reason.
    if (patch.url) deps.resolver?.markHealthy(updated.id);
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
    // `source=persisted` reads the on-disk JSONL trail instead of the in-memory
    // ring, which caps at the constructor limit (1000). The cap here is what
    // keeps one response from loading a whole day's file; the UI pages within it.
    const persisted = c.req.query("source") === "persisted";
    const cap = persisted ? 5000 : 200;
    const limit = Number.isFinite(requested) && requested > 0 ? Math.min(requested, cap) : 100;
    const entries = persisted ? deps.requests.listPersisted(limit) : deps.requests.list(limit);
    return c.json({ entries, stats: deps.requests.stats(), source: persisted ? "persisted" : "memory" });
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
