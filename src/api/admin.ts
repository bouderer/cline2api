/** Admin surface: device-code login orchestration and account management. */
import type { Context, Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import type { LoginService } from "../services/loginService.js";
import { extractBearer, safeEqual } from "./http.js";
import { ADMIN_PAGE } from "../webui/page.js";
import { chatCompletion } from "./openai.js";
import { fetchSubscription, type SubscriptionInfo } from "../cline/subscription.js";
import { fetchUsageLimits, type UsageWindow } from "../cline/usage.js";

export interface AdminRouteDeps extends OpenAIRouteDeps {
  login: LoginService;
}

function remoteAddress(c: Context): string | undefined {
  const env = c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined;
  return env?.incoming?.socket?.remoteAddress;
}

function isLoopback(c: Context): boolean {
  const address = remoteAddress(c);
  return (
    address === "127.0.0.1" ||
    address === "::1" ||
    address === "::ffff:127.0.0.1" ||
    address === undefined
  );
}

function isAdminAuthorized(c: Context, deps: AdminRouteDeps): boolean {
  const token = deps.config.adminToken;
  if (!token) return isLoopback(c);
  const provided =
    extractBearer(c.req.header("authorization")) ?? c.req.query("token") ?? null;
  return provided !== null && safeEqual(provided, token);
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

async function collectUsage(deps: AdminRouteDeps): Promise<{ accounts: AccountUsageRow[] }> {
  const accounts = deps.store.list();
  const rows = await Promise.all(
    accounts.map(async (account): Promise<AccountUsageRow> => {
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

      const authorization = await deps.tokens.getAuthorization(account.id).catch(() => null);
      if (!authorization) {
        row.error = "re-login required";
        return row;
      }
      const [plan, usage] = await Promise.all([
        fetchSubscription(deps.config, authorization, deps.logger),
        fetchUsageLimits(deps.config, authorization, deps.logger),
      ]);
      row.plan = plan;
      row.limits = usage.limits;
      row.error = plan.error ?? usage.error;
      usageCache.set(account.id, { at: Date.now(), row });
      return row;
    }),
  );
  return { accounts: rows };
}

export function registerAdminRoutes(app: Hono, deps: AdminRouteDeps): void {  app.get("/", (c) => {
    if (!isAdminAuthorized(c, deps)) {
      return c.text("Admin UI is not exposed here. Set ADMIN_TOKEN or use localhost.", 403);
    }
    return c.html(ADMIN_PAGE);
  });

  const guard = (c: Context): Response | null =>
    isAdminAuthorized(c, deps) ? null : c.json({ error: "unauthorized" }, 401);

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
      refreshBufferMs: deps.config.refreshBufferMs,
    });
  });

  app.get("/admin/api/accounts", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return c.json({
      accounts: deps.store.list().map((account) => ({
        id: account.id,
        email: account.email,
        label: account.label,
        provider: account.provider,
        disabled: account.disabled,
        lastError: account.lastError,
        expiresAt: account.expires,
        createdAt: account.createdAt,
        updatedAt: account.updatedAt,
      })),
    });
  });

  app.delete("/admin/api/accounts/:id", (c) => {
    const denied = guard(c);
    if (denied) return denied;
    const removed = deps.store.remove(c.req.param("id"));
    return c.json({ removed });
  });

  app.post("/admin/api/login/start", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    try {
      const session = await deps.login.start();
      return c.json(session);
    } catch (error) {
      deps.logger.warn("failed to start device login", { error: (error as Error).message });
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
    return c.json(await collectUsage(deps));
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
   * Playground: same chat path as /v1, authenticated with the admin token
   * instead of the client key so the browser never needs the client key.
   */
  app.post("/admin/api/chat", async (c) => {
    const denied = guard(c);
    if (denied) return denied;
    return chatCompletion(c, deps);
  });
}
