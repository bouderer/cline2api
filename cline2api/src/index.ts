/**
 * cline2api entrypoint.
 *
 * Exposes:
 *   /v1/models            OpenAI model list (live upstream catalog)
 *   /v1/chat/completions  OpenAI chat completions
 *   /v1/messages          Anthropic Messages API (for Claude Code)
 *   /                     admin UI (localhost, or ADMIN_TOKEN when exposed)
 *   /healthz              liveness
 */
import { serve } from "@hono/node-server";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Hono } from "hono";
import { loadConfig, type AppConfig } from "./config.js";
import { createLogger } from "./logger.js";
import { AccountStore } from "./store.js";
import { AccountPool } from "./services/accountPool.js";
import { RequestLog } from "./services/requestLog.js";
import { TokenManager } from "./cline/tokenManager.js";
import { ModelCatalog } from "./cline/models.js";
import { LoginService } from "./services/loginService.js";
import { isAuthorized, registerOpenAIRoutes } from "./api/openai.js";
import { openaiError } from "./api/http.js";
import { registerAnthropicRoutes } from "./api/anthropic.js";
import { registerAdminRoutes } from "./api/admin.js";

export function createApp(config: AppConfig = loadConfig()) {
  const secrets = [...config.proxyApiKeys, ...(config.adminToken ? [config.adminToken] : [])];
  const logger = createLogger(config.logLevel, secrets);
  const store = new AccountStore(config.dataDir, logger);
  const pool = new AccountPool(store);
  const tokens = new TokenManager(store, config, logger);
  const catalog = new ModelCatalog(config, logger);
  const login = new LoginService(config, store, logger);
  const requests = new RequestLog();

  const deps = { config, logger, store, pool, tokens, catalog, requests };
  const app = new Hono();

  // Security net for the whole public API namespace. Route handlers retain
  // their own checks so registerOpenAIRoutes remains safe when mounted alone.
  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c, deps)) {
      return openaiError("Missing or invalid API key.", 401, { code: "invalid_api_key" });
    }
    await next();
  });
  registerAdminRoutes(app, { ...deps, login });
  registerOpenAIRoutes(app, deps);
  registerAnthropicRoutes(app, deps);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.notFound((c) =>
    c.json({ error: { message: `Unknown route ${c.req.path}`, type: "invalid_request_error" } }, 404),
  );
  app.onError((error, c) => {
    logger.error("unhandled error", { path: c.req.path, error: error.message });
    return c.json({ error: { message: "Internal gateway error", type: "server_error" } }, 500);
  });

  return { app, config, logger, store };
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (isMain) {
  const { app, config, logger, store } = createApp();
  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(`cline2api listening on http://${config.host}:${info.port}`);
    logger.info(`OpenAI base URL: http://${config.host}:${info.port}/v1`);
    logger.info(`admin UI:        http://${config.host}:${info.port}/`);
    logger.info(`upstream:        ${config.clineApiBaseUrl}`);
    logger.info(
      `client API key:  ${config.proxyApiKeys.length} configured` +
        (process.env.PROXY_API_KEY ? "" : ` (generated, see proxy-api-key.txt in DATA_DIR)`),
    );
    logger.info(`accounts loaded: ${store.count()}`);
  });
}
