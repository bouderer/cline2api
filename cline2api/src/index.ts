/**
 * cline2api entrypoint.
 *
 * Exposes:
 *   /v1/models            OpenAI model list (live upstream catalog)
 *   /v1/chat/completions  OpenAI chat completions
 *   /v1/responses         OpenAI Responses API
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
import { ProxyStore } from "./services/proxyStore.js";
import { ProxyResolver } from "./cline/proxy.js";
import { TokenManager } from "./cline/tokenManager.js";
import { ModelCatalog } from "./cline/models.js";
import { LoginService } from "./services/loginService.js";
import { ApiKeyManager } from "./services/apiKeys.js";
import { FreeQuotaStore } from "./services/freeQuota.js";
import { RateLimiter } from "./services/rateLimit.js";
import { SweepRunner } from "./services/sweep.js";
import { isAuthorized, registerOpenAIRoutes } from "./api/openai.js";
import { extractApiKey, openaiError } from "./api/http.js";
import { registerResponsesRoutes } from "./api/responses.js";
import { registerAnthropicRoutes } from "./api/anthropic.js";
import { registerAdminRoutes } from "./api/admin.js";

export function createApp(config: AppConfig = loadConfig()) {
  const logger = createLogger(config.logLevel, [
    ...(config.adminToken ? [config.adminToken] : []),
  ]);
  const store = new AccountStore(config.dataDir, logger);
  const proxies = new ProxyStore(config.dataDir, logger);
  const pool = new AccountPool(store);
  const resolver = new ProxyResolver({ proxies, store, logger });
  const tokens = new TokenManager(store, config, logger, resolver);
  const catalog = new ModelCatalog(config, logger);
  const login = new LoginService(config, store, logger);
  const apiKeys = new ApiKeyManager({
    dataDir: config.dataDir,
    logger,
    envKeys: config.proxyApiKeys,
    onEvent: (event) => {
      if (event.type === "created") {
        logger.info("client API key created", { id: event.id, label: event.label });
      } else if (event.type === "rotated") {
        logger.info("client API key rotated", { id: event.id });
      } else if (event.type === "deleted") {
        logger.info("client API key deleted", { id: event.id });
      } else if (event.type === "toggled") {
        logger.info("client API key toggled", { id: event.id, enabled: event.enabled });
      } else if (event.type === "imported") {
        logger.info("client API keys imported from environment", { count: event.count });
      }
    },
  });

  // First boot with no keys anywhere: mint one so the gateway is usable the
  // same way an empty PROXY_API_KEY used to. The plaintext is logged once at
  // startup and never again.
  if (apiKeys.count() === 0) {
    const { record, plaintext } = apiKeys.create("初始密钥（自动生成）");
    logger.info(`client API key generated: ${plaintext} (id ${record.id})`);
  }

  const requests = new RequestLog();
  const freeQuota = new FreeQuotaStore({ logger });
  const rateLimit = new RateLimiter({
    dataDir: config.dataDir,
    logger,
    defaults: {
      globalPerMinute: config.rateLimitGlobalPerMinute,
      keyPerMinute: config.rateLimitKeyPerMinute,
    },
  });

  const sweep = new SweepRunner({ config, logger, store, tokens, pool, resolver, freeQuota });

  const deps = {
    config,
    logger,
    store,
    pool,
    tokens,
    catalog,
    requests,
    proxies,
    resolver,
    proxyResolver: resolver,
    apiKeys,
    freeQuota,
    rateLimit,
    sweep,
  };
  const app = new Hono();

  // Security net for the whole public API namespace. Route handlers retain
  // their own checks so registerOpenAIRoutes remains safe when mounted alone.
  app.use("/v1/*", async (c, next) => {
    if (!isAuthorized(c, deps)) {
      return openaiError("Missing or invalid API key.", 401, { code: "invalid_api_key" });
    }
    await next();
  });

  /**
   * Rate limit the model-call endpoints only.
   *
   * `/v1/models` is a catalog read that costs nothing upstream, and the admin
   * and health routes are the operator's own — counting those would let a
   * client's catalogue polling throttle the console someone is debugging with.
   */
  const MODEL_PATHS = ["/v1/chat/completions", "/v1/responses", "/v1/messages"];
  app.use("*", async (c, next) => {
    if (!MODEL_PATHS.includes(c.req.path)) {
      await next();
      return;
    }
    const key = deps.apiKeys.matches(
      extractApiKey(c.req.header("authorization"), c.req.header("x-api-key")) ?? "",
    );
    const decision = await deps.rateLimit.acquire(key?.id ?? null, c.req.raw.signal);
    if (!decision.allowed) {
      const seconds = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
      return openaiError(
        decision.scope === "key"
          ? `Rate limit exceeded for this API key (${decision.limit}/min). Retry in ${seconds}s, or use another key.`
          : `Gateway rate limit exceeded (${decision.limit}/min). Retry in ${seconds}s.`,
        429,
        {
          type: "rate_limit_error",
          code: decision.scope === "key" ? "key_rate_limited" : "gateway_rate_limited",
          // Set on the returned Response, not on the context: the handler
          // returns its own Response, which would drop a context header.
          extraHeaders: { "retry-after": String(seconds) },
        },
      );
    }
    await next();
  });
  registerAdminRoutes(app, { ...deps, login });
  registerOpenAIRoutes(app, deps);
  registerResponsesRoutes(app, deps);
  registerAnthropicRoutes(app, deps);

  app.get("/healthz", (c) => c.json({ ok: true }));

  app.notFound((c) =>
    c.json({ error: { message: `Unknown route ${c.req.path}`, type: "invalid_request_error" } }, 404),
  );
  app.onError((error, c) => {
    logger.error("unhandled error", { path: c.req.path, error: error.message });
    return c.json({ error: { message: "Internal gateway error", type: "server_error" } }, 500);
  });

  return { app, config, logger, store, apiKeys };
}

const entry = process.argv[1];
const isMain = entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;

if (isMain) {
  const { app, config, logger, store, apiKeys } = createApp();
  serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) => {
    logger.info(`cline2api listening on http://${config.host}:${info.port}`);
    logger.info(`OpenAI base URL: http://${config.host}:${info.port}/v1`);
    logger.info(`admin UI:        http://${config.host}:${info.port}/`);
    logger.info(`upstream:        ${config.clineApiBaseUrl}`);
    logger.info(`client API keys: ${apiKeys.countEnabled()} enabled of ${apiKeys.count()} (managed in the admin UI)`);
    logger.info(`accounts loaded: ${store.count()}`);
  });
}
