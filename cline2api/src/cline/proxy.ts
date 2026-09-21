/**
 * Turns an account's assigned proxy into a request dispatcher.
 *
 * Node's global `fetch` is undici underneath but does not expose the
 * `dispatcher` option in its types, so requests are built here and cast once
 * rather than at every call site.
 *
 * Agents are cached per proxy id and rebuilt when the proxy's URL changes: a
 * ProxyAgent owns a connection pool, so constructing one per request would
 * leak sockets and lose keep-alive, while never rebuilding would keep routing
 * through an address the operator just replaced.
 */
import { Agent, ProxyAgent, type Dispatcher } from "undici";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import type { ProxyStore } from "../services/proxyStore.js";

export interface ProxyResolverDeps {
  proxies: ProxyStore;
  store: AccountStore;
  logger: Logger;
}

export class ProxyResolver {
  private readonly agents = new Map<string, { url: string; agent: Dispatcher }>();

  constructor(private readonly deps: ProxyResolverDeps) {}

  /**
   * Dispatcher for an account, or undefined when it has no usable proxy.
   *
   * An account pointing at a missing or disabled proxy falls back to a direct
   * connection rather than failing the request. That is a deliberate trade:
   * a request from the host IP is better than a hard failure, and the admin UI
   * surfaces the assignment state so the mismatch is visible.
   */
  forAccount(accountId: string): Dispatcher | undefined {
    let proxyId: string | null | undefined;
    try {
      proxyId = this.deps.store.get(accountId)?.proxyId;
    } catch {
      return undefined;
    }
    if (!proxyId) return undefined;

    const proxy = this.deps.proxies.get(proxyId);
    if (!proxy || !proxy.enabled) return undefined;

    const cached = this.agents.get(proxyId);
    if (cached && cached.url === proxy.url) return cached.agent;
    if (cached) void cached.agent.close().catch(() => undefined);

    try {
      const agent = new ProxyAgent({
        uri: proxy.url,
        // A dead proxy should surface quickly as a failed request instead of
        // holding the connection until the caller's own timeout fires.
        connectTimeout: 10_000,
        requestTls: { rejectUnauthorized: true },
      });
      this.agents.set(proxyId, { url: proxy.url, agent });
      return agent;
    } catch (error) {
      this.deps.logger.warn("failed to build proxy agent", {
        proxyId,
        error: (error as Error).message,
      });
      this.deps.proxies.update(proxyId, { lastError: (error as Error).message });
      return undefined;
    }
  }

  /** Direct-connection agent, used when nothing is assigned. */
  private direct: Dispatcher | null = null;

  directAgent(): Dispatcher {
    this.direct ??= new Agent({ connectTimeout: 10_000 });
    return this.direct;
  }

  /** Release every pooled connection; called on shutdown and in tests. */
  async close(): Promise<void> {
    const open = [...this.agents.values()].map((entry) => entry.agent.close().catch(() => undefined));
    this.agents.clear();
    if (this.direct) {
      open.push(this.direct.close().catch(() => undefined));
      this.direct = null;
    }
    await Promise.all(open);
  }
}

/**
 * `fetch` with an optional dispatcher.
 *
 * Cast once, here: undici accepts `dispatcher` at runtime, but the DOM types
 * backing global fetch do not declare it.
 */
export function fetchWith(
  url: string | URL,
  init: RequestInit,
  dispatcher: Dispatcher | undefined,
): Promise<Response> {
  if (dispatcher === undefined) return fetch(url, init);
  return fetch(url, { ...init, dispatcher } as RequestInit & { dispatcher: Dispatcher });
}
