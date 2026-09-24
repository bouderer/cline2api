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
import type { ProxyStore, StoredProxy } from "../services/proxyStore.js";

export interface ProxyResolverDeps {
  proxies: ProxyStore;
  store: AccountStore;
  logger: Logger;
}

/** A dispatcher together with the proxy that produced it. */
export interface ProxyRoute {
  dispatcher: Dispatcher;
  /** Null when the dispatcher is the direct connection rather than a proxy. */
  proxyId: string | null;
}

/**
 * How long a proxy stays out of rotation after it handed us a rate limit.
 *
 * The 429 names no account, so the only useful conclusion is that this exit
 * address is spent for now. Long enough to matter (a switch that immediately
 * came back to the same address would defeat the point), short enough that a
 * pool smaller than the demand can still reuse entries.
 */
const RATE_LIMIT_COOLDOWN_MS = 60_000;

/**
 * Hard stop on consecutive switches, per request.
 *
 * If every proxy in the pool is being refused, walking all of them on one
 * request is the burst that would get the whole pool blocked — the same failure
 * the account-level failover budget exists to prevent. Past this many switches
 * the call goes direct instead, which is a worse address but not another
 * refused one.
 *
 * Exported rather than held on the resolver: it counts switches within one
 * request, and resolver state is shared by every concurrent request, so a
 * counter there would be corrupted as soon as two clients overlapped.
 */
export const MAX_PROXY_SWITCHES = 3;

export class ProxyResolver {
  private readonly agents = new Map<string, { url: string; agent: Dispatcher }>();

  /** Probes running in the background, keyed by proxy id. */
  private readonly probing = new Map<string, Promise<void>>();

  constructor(private readonly deps: ProxyResolverDeps) {
    // Pre-warm the pool: when a request picks a tier-0 proxy, the tier-1 pool is
    // the failover path, and a burst that hits the wall has to find its exits
    // already measured. Probing every candidate on startup costs one round-trip
    // per proxy and pays for itself the first time a failover skips a dead one.
    this.deps.proxies.list().forEach((proxy) => {
      if (proxy.enabled) void this.probe(proxy);
    });
  }

  /**
   * Ceiling on cached agents.
   *
   * A `ProxyAgent` owns a keep-alive socket pool, so an unbounded cache is an
   * unbounded set of open sockets and file descriptors — fine for a handful of
   * pinned proxies, not fine for a rotating pool of hundreds, where a busy
   * minute would touch every entry. The cap is well above any real concurrency
   * so eviction stays rare, and evicted agents are closed rather than dropped,
   * or their sockets would outlive them.
   */
  private static readonly MAX_AGENTS = 64;

  private buildAgent(key: string, url: string): Dispatcher | undefined {
    try {
      const agent = new ProxyAgent({
        uri: url,
        // A dead proxy should surface quickly as a failed request instead of
        // holding the connection until the caller's own timeout fires.
        connectTimeout: 10_000,
        requestTls: { rejectUnauthorized: true },
      });
      this.remember(key, url, agent);
      return agent;
    } catch (error) {
      this.deps.logger.warn("failed to build proxy agent", {
        proxyId: key,
        error: (error as Error).message,
      });
      // Surfaced in the admin UI so a proxy that cannot even be constructed is
      // visible as broken rather than merely idle.
      this.deps.proxies.update(key, { lastError: (error as Error).message });
      return undefined;
    }
  }

  /**
   * Pre-warm probe: verify a proxy can establish a tunnel before it is offered
   * to a request. A failure here parks the proxy immediately (tier 0 forever,
   * tier 1 for 5 minutes), so the first real request that would have drawn a
   * dead exit instead draws a live one. Success clears any stale unhealthy mark
   * — a pool that rotates its exit IP every couple of hours should not carry
   * yesterday's failure into today's window.
   *
   * Runs in the background so startup is not blocked by 20 slow residential
   * proxies; the dedup map means a second call for the same proxy returns the
   * in-flight probe instead of starting a duplicate.
   */
  private probe(proxy: { id: string; url: string; priority: number }): Promise<void> {
    const existing = this.probing.get(proxy.id);
    if (existing) return existing;
    const task = (async () => {
      const { probeProxyExit } = await import("../services/proxyExit.js");
      // A short timeout for the pre-warm: this is background work, not the
      // request path, and a dead proxy should be marked quickly so it is not
      // offered to the next burst. The 12s default is for an operator clicking
      // "probe" in the UI, where waiting is acceptable.
      const result = await probeProxyExit(proxy.url, this.deps.logger, 3_000);
      if (result.ok) {
        this.unhealthy.delete(proxy.id);
        this.deps.proxies.update(proxy.id, {
          exitIp: result.exitIp,
          exitIpCheckedAt: Date.now(),
          lastError: null,
        });
      } else {
        const until = proxy.priority > 0 ? Date.now() + 5 * 60_000 : Number.MAX_SAFE_INTEGER;
        this.unhealthy.set(proxy.id, until);
        this.deps.proxies.update(proxy.id, { lastError: result.error });
      }
      this.probing.delete(proxy.id);
    })();
    this.probing.set(proxy.id, task);
    return task;
  }

  /** Insert into the cache, evicting the oldest entry once it is over the cap. */
  private remember(key: string, url: string, agent: Dispatcher): void {
    this.agents.delete(key);
    this.agents.set(key, { url, agent });
    while (this.agents.size > ProxyResolver.MAX_AGENTS) {
      const oldest = this.agents.keys().next();
      if (oldest.done) break;
      const victim = this.agents.get(oldest.value);
      this.agents.delete(oldest.value);
      void victim?.agent.close().catch(() => undefined);
    }
  }

  /**
   * The proxy currently held in sticky mode, and when it may be replaced.
   *
   * Sticky is the default strategy because the rate limit is per exit address:
   * a pool exists to spread load across addresses, but spreading *every*
   * request re-opens a fresh connection each time and gives up keep-alive.
   * Holding one address until it is refused, then moving, uses each address to
   * its own limit instead of churning across all of them.
   */
  private sticky: { proxyId: string; url: string } | null = null;
  /** proxyId → epoch ms until which it is considered rate-limited. */
  private readonly cooling = new Map<string, number>();
  /**
   * proxyId → when a transport failure should stop keeping it out of rotation.
   *
   * A 429 says "this address is busy" and clears on its own cooldown; a network
   * failure ("fetch failed", a refused CONNECT, a timeout to the proxy itself)
   * says the hop is broken, and nothing about that heals by waiting — except
   * when the proxy is a rotating residential pool whose exit IP changes every
   * couple of hours: the same URL that just failed may be a healthy new exit in
   * five minutes. So tier 1 (the pool) gets a short retry window, while tier 0
   * (the stable, named proxies) stays out until an operator probes it clean.
   */
  private readonly unhealthy = new Map<string, number>();
  /**
   * Epoch ms until which DIRECT egress is considered rate-limited. In
   * direct-first mode a 429 from the host address cools it here, so the next
   * request goes straight to a proxy instead of re-hitting the refused direct
   * address on every call.
   */
  private directCoolingUntil = 0;

  /** Dispatcher for an account, or undefined when it has no usable proxy. */
  private accountProxy(accountId: string) {
    let proxyId: string | null | undefined;
    try {
      proxyId = this.deps.store.get(accountId)?.proxyId;
    } catch {
      return undefined;
    }
    if (!proxyId) return undefined;
    const proxy = this.deps.proxies.get(proxyId);
    if (!proxy || !proxy.enabled) return undefined;
    return proxy;
  }

  /**
   * Enabled proxies that are not currently cooling off.
   *
   * Falls back to the full enabled set when everything is cooling: at that point
   * the cooldown has stopped carrying information — nothing is available, and
   * picking from an empty set would silently turn into direct egress.
   */
  private candidates(): StoredProxy[] {
    let enabled: StoredProxy[];
    try {
      enabled = this.deps.proxies.list().filter((proxy) => proxy.enabled);
    } catch {
      return [];
    }
    if (enabled.length === 0) return [];
    const now = Date.now();
    const cool = enabled.filter((proxy) => (this.cooling.get(proxy.id) ?? 0) <= now);
    const usable = cool.length > 0 ? cool : enabled;
    // Health gate: a proxy whose last transport failed is skipped. Tier 0 (stable,
    // named proxies) stays out until an operator probes it clean — a broken hop
    // there does not heal on its own. Tier 1 (the rotating residential pool) gets
    // a short retry window because its exit IP changes every couple of hours, so
    // the same URL that just failed may be a fresh healthy exit in five minutes.
    const healthy = usable.filter((proxy) => {
      const until = this.unhealthy.get(proxy.id);
      return until === undefined || until <= now;
    });
    if (healthy.length > 0) {
      const minPriority = Math.min(...healthy.map((proxy) => proxy.priority));
      const chosen = healthy.filter((proxy) => proxy.priority === minPriority);
      // Pre-probe the failover path: when the current tier is about to be
      // exhausted, the next tier's exits must already be measured. A burst that
      // downgrades has no time to wait for 20 round-trips through a residential
      // proxy; probing them in the background while the current tier still works
      // means the downgrade finds its exits ready, not still warming up.
      const nextTier = minPriority + 1;
      usable
        .filter((proxy) => proxy.priority === nextTier)
        .forEach((proxy) => void this.probe(proxy));
      return chosen;
    }
    // All candidates are marked unhealthy: fall back to the full set rather than
    // fail closed, because a single probe might have raced a transient error and
    // the pool is the only way to find out whether anything is still alive.
    const minPriority = Math.min(...usable.map((proxy) => proxy.priority));
    return usable.filter((proxy) => proxy.priority === minPriority);
  }

  /** Random selection, so concurrent requests do not all take the same index. */
  private pick(pool: StoredProxy[]): StoredProxy {
    return pool[Math.floor(Math.random() * pool.length)]!;
  }

  /** Cached agent for a proxy, building it on first use. */
  private agentFor(proxy: StoredProxy): Dispatcher | undefined {
    const cached = this.agents.get(proxy.id);
    if (cached && cached.url === proxy.url) {
      // Refresh recency so a pinned proxy is not evicted ahead of one that was
      // touched once while rotating.
      this.agents.delete(proxy.id);
      this.agents.set(proxy.id, cached);
      return cached.agent;
    }
    if (cached) void cached.agent.close().catch(() => undefined);
    return this.buildAgent(proxy.id, proxy.url);
  }

  /** The sticky pick, replacing it when it is gone, disabled or cooling off. */
  private stickyProxy(): StoredProxy | undefined {
    const now = Date.now();
    if (this.sticky) {
      const current = this.deps.proxies.get(this.sticky.proxyId);
      const spent = (this.cooling.get(this.sticky.proxyId) ?? 0) > now;
      if (current && current.enabled && !spent && current.url === this.sticky.url) return current;
      // The held entry was removed, disabled, or edited to a new address.
      this.sticky = null;
    }
    const pool = this.candidates();
    if (pool.length === 0) return undefined;
    const chosen = this.pick(pool);
    this.sticky = { proxyId: chosen.id, url: chosen.url };
    return chosen;
  }

  /**
   * Dispatcher for an account, or undefined when it has no usable proxy.
   *
   * An account pointing at a missing or disabled proxy falls back to a direct
   * connection rather than failing the request. That is a deliberate trade:
   * a request from the host IP is better than a hard failure, and the admin UI
   * surfaces the assignment state so the mismatch is visible.
   */
  forAccount(accountId: string): Dispatcher | undefined {
    const proxy = this.accountProxy(accountId);
    if (!proxy) return undefined;
    return this.agentFor(proxy);
  }

  /** Pick a different enabled proxy for each call, for rotate mode. */
  rotating(): Dispatcher | undefined {
    const pool = this.candidates();
    if (pool.length === 0) return undefined;
    return this.agentFor(this.pick(pool));
  }

  /**
   * Route one request, returning both the dispatcher and which proxy it is.
   *
   * The id comes back so a 429 can be attributed to the address that caused it:
   * `reportRateLimited` needs to know which entry to put in cooldown, and the
   * dispatcher alone does not identify it.
   */
  forRequest(accountId: string): ProxyRoute | undefined {
    let mode: string;
    try {
      mode = this.deps.proxies.getMode();
    } catch {
      mode = "pinned";
    }

    if (mode === "rotate") {
      const pool = this.candidates();
      if (pool.length === 0) return undefined;
      const proxy = this.pick(pool);
      const dispatcher = this.agentFor(proxy);
      return dispatcher ? { dispatcher, proxyId: proxy.id } : undefined;
    }

    if (mode === "sticky") {
      const proxy = this.stickyProxy();
      if (!proxy) return undefined;
      const dispatcher = this.agentFor(proxy);
      if (!dispatcher) {
        // A sticky entry that cannot even be constructed is dead weight; drop it
        // so the next request tries a different one instead of failing here
        // forever.
        this.sticky = null;
        return undefined;
      }
      return { dispatcher, proxyId: proxy.id };
    }

    const proxy = this.accountProxy(accountId);
    if (!proxy) return undefined;
    const dispatcher = this.agentFor(proxy);
    return dispatcher ? { dispatcher, proxyId: proxy.id } : undefined;
  }

  /**
   * Report that a request through this proxy came back rate-limited.
   *
   * Called on the same signal the account loop uses to stop failing over: a 429
   * carrying nothing account-specific, which is an edge rate limit on the exit
   * address rather than anything about the account. The reply is to stop using
   * that address immediately, since retrying it is what turns a throttle into a
   * block.
   *
   * Direct egress (proxyId null) is ignored — there is nothing to switch away
   * from, and cooling the host's own address would be meaningless.
   */
  reportRateLimited(proxyId: string | null | undefined): void {
    if (!proxyId) {
      // Direct egress was refused. Cool the host address so the next request
      // opens on a proxy instead of paying one refused direct attempt per call.
      // Only sticky runs direct-first; in pinned/rotate a direct fallback that
      // 429s must NOT cool direct, or the mode's own proxy picks would be
      // overridden by a cooldown meant for the sticky strategy.
      let mode = "pinned";
      try {
        mode = this.deps.proxies.getMode();
      } catch {
        /* keep default */
      }
      if (mode === "sticky") {
        this.directCoolingUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
        this.deps.logger.warn("direct egress rate limited, cooling", {
          cooldownMs: RATE_LIMIT_COOLDOWN_MS,
        });
      }
      return;
    }
    this.cooling.set(proxyId, Date.now() + RATE_LIMIT_COOLDOWN_MS);
    if (this.sticky?.proxyId === proxyId) this.sticky = null;
    this.deps.logger.warn("proxy rate limited, switching", {
      exit: this.describeExit(proxyId),
      cooldownMs: RATE_LIMIT_COOLDOWN_MS,
      cooling: [...this.cooling.values()].filter((until) => until > Date.now()).length,
    });
  }

  /** True while the host's direct address is rate-limited. */
  directCooling(): boolean {
    return this.directCoolingUntil > Date.now();
  }

  /**
   * Report that a request through this proxy failed at the transport layer.
   *
   * Unlike a 429 — which says "busy, wait" — a transport failure means the hop
   * itself is broken: CONNECT refused, the proxy's upstream is down, the auth
   * that worked yesterday is now being rejected. Tier 0 proxies (stable, named
   * exits) stay parked until an operator probes them clean; tier 1 proxies (the
   * rotating residential pool) get a short retry window because their exit IP
   * changes every couple of hours, so the same URL that just failed may be a
   * fresh healthy exit in five minutes.
   */
  reportTransportFailure(proxyId: string | null | undefined, error: string): void {
    if (!proxyId) return;
    const proxy = this.deps.proxies.get(proxyId);
    const tier = proxy?.priority ?? 0;
    // Tier 1 gets 5 minutes; tier 0 stays until probed. The exact number is a
    // guess at the pool's rotation cadence, not a measurement.
    const until = tier > 0 ? Date.now() + 5 * 60_000 : Number.MAX_SAFE_INTEGER;
    this.unhealthy.set(proxyId, until);
    if (this.sticky?.proxyId === proxyId) this.sticky = null;
    this.deps.logger.warn("proxy transport failure, parking exit", {
      exit: this.describeExit(proxyId),
      error: error.slice(0, 120),
      retryInMs: until === Number.MAX_SAFE_INTEGER ? "until probed" : 5 * 60_000,
    });
  }

  /** Clear the parked state after a successful probe. */
  markHealthy(proxyId: string): void {
    if (this.unhealthy.delete(proxyId)) {
      this.deps.logger.info("proxy back in rotation after clean probe", {
        exit: this.describeExit(proxyId),
      });
    }
  }

  /**
   * Initial route for a request in direct-first order.
   *
   * Pinned mode is untouched: an account bound to a proxy keeps its own egress.
   * Rotate keeps spreading every request. Only sticky — the default — flips to
   * direct-first: the host's own address is the cleanest signal upstream sees
   * (a real machine, not a shared residential exit), so it is used until it is
   * refused, and only then does a proxy take over for the cooldown window.
   */
  initialRoute(accountId: string): ProxyRoute | undefined {
    let mode: string;
    try {
      mode = this.deps.proxies.getMode();
    } catch {
      mode = "pinned";
    }
    if (mode !== "sticky") return this.forRequest(accountId);
    // Sticky, direct-first: honour an account-pinned proxy only when direct is
    // cooling; otherwise start on the host address.
    if (this.directCooling()) {
      const proxy = this.stickyProxy();
      if (!proxy) return undefined;
      const dispatcher = this.agentFor(proxy);
      return dispatcher ? { dispatcher, proxyId: proxy.id } : undefined;
    }
    return undefined; // direct
  }

  /**
   * Drop the held address and every cooldown.
   *
   * Called when the operator changes mode or edits the pool: a held address from
   * the previous strategy would keep deciding egress for requests the new
   * setting was meant to govern, and a cooldown recorded under the old pool may
   * refer to a proxy that no longer exists.
   */
  forgetSticky(): void {
    this.sticky = null;
    this.cooling.clear();
  }

  /** Diagnostics for the admin UI: what is held, what is cooling. */
  state(): { stickyProxyId: string | null; cooling: number } {
    const now = Date.now();
    return {
      stickyProxyId: this.sticky?.proxyId ?? null,
      cooling: [...this.cooling.values()].filter((until) => until > now).length,
    };
  }

  /**
   * Human-readable name for an exit, for logs.
   *
   * A UUID in a log line tells an operator nothing about which address was
   * throttled; the exit IP and the operator's own label do. When the exit IP
   * is known it is the whole answer — the proxy host is an implementation
   * detail. Until a probe fills it in, host:port is the best available
   * identity. Falls back to a short id when the pool entry is gone (a log
   * written for a proxy that was deleted mid-flight) so the line still
   * identifies something.
   */
  describeExit(proxyId: string | null | undefined): string {
    if (!proxyId) return "direct";
    const proxy = this.deps.proxies.get(proxyId);
    if (!proxy) return `proxy:${proxyId.slice(0, 8)}`;
    if (proxy.exitIp) return proxy.exitIp;
    const hop = (() => {
      try {
        const u = new URL(proxy.url);
        return u.port ? `${u.hostname}:${u.port}` : u.hostname;
      } catch {
        return proxy.label ?? "proxy";
      }
    })();
    return proxy.label ? `${hop}(${proxy.label})` : hop;
  }

  /** Dispatcher for an account, ignoring rotation. Used by the admin probe. */
  pinned(accountId: string): Dispatcher | undefined {
    return this.forAccount(accountId);
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
