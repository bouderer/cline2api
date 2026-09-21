/** Admin surface: login orchestration, account management, and authenticated control APIs. */
import type { Context, Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import type { LoginMode, LoginService } from "../services/loginService.js";
import { extractBearer, safeEqual } from "./http.js";
import type { CredentialSaveInput } from "../store.js";
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
