/** Admin surface: device-code login orchestration and account management. */
import type { Context, Hono } from "hono";
import type { OpenAIRouteDeps } from "./openai.js";
import type { LoginService } from "../services/loginService.js";
import { extractBearer, safeEqual } from "./http.js";
import { ADMIN_PAGE } from "../webui/page.js";

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

export function registerAdminRoutes(app: Hono, deps: AdminRouteDeps): void {
  app.get("/", (c) => {
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
}
