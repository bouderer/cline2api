/**
 * Upstream proxy pool.
 *
 * Every account can be pinned to its own HTTP(S) proxy, so a pool of accounts
 * is not also a single source IP. Two rules shape the design:
 *
 *  - A proxy is referenced by accounts, never copied into them. Editing a
 *    proxy's URL therefore fixes every account using it at once, and deleting
 *    one is refused while it is still in use rather than silently un-assigning
 *    accounts that would then quietly egress from the host's own IP.
 *  - Agents are cached per URL. Each ProxyAgent owns a connection pool, so
 *    building one per request would leak sockets and lose keep-alive.
 *
 * Credentials live in the URL (`http://user:pass@host:port`), which is why the
 * store file is written 0600 like `accounts.json` and why the admin API never
 * echoes a stored URL back — it returns a redacted form. The full URL is only
 * ever accepted on write.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface StoredProxy {
  id: string;
  label: string | null;
  /** Full URL including credentials. Never returned by the admin API as-is. */
  url: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  /** Last transport failure seen through this proxy, for the admin UI. */
  lastError: string | null;
  /**
   * What the upstream saw as this proxy's source address, as of the last probe.
   *
   * Measured rather than derived from the URL: a rotating pool hands out many
   * backends behind one hostname, so the host is not the exit. Null until
   * something probes it.
   */
  exitIp: string | null;
  exitIpCheckedAt: number | null;
  /**
   * Failover tier. Lower is preferred. The resolver only dips into a higher
   * tier when every proxy at the current tier is in cooldown — so `0` proxies
   * carry normal traffic and `1` proxies sit idle until the first tier is
   * exhausted. Direct egress (no proxy) is always the implicit tier below 0.
   */
  priority: number;
}

/**
 * How a request decides which proxy to egress through.
 *
 *  - `pinned`  — the proxy its account is bound to. Reproducible egress, which
 *                is what you want when chasing a per-IP limit for one account.
 *  - `sticky`  — hold one working proxy for everything and move only when it is
 *                refused. Uses each address up to its own limit instead of
 *                churning across the pool, and keeps connections alive.
 *  - `rotate`  — a different enabled proxy per request. Maximum spread, at the
 *                cost of a fresh connection each time.
 */
export type ProxyMode = "pinned" | "sticky" | "rotate";

const PROXY_MODES: readonly ProxyMode[] = ["pinned", "sticky", "rotate"];

export function isProxyMode(value: unknown): value is ProxyMode {
  return typeof value === "string" && (PROXY_MODES as readonly string[]).includes(value);
}

/**
 * Failover tier. 0 is used first; higher numbers only take traffic once every
 * proxy at the lower tier is cooling off. The bound keeps a typo like
 * `priority: 99999` from parking a proxy where nothing will ever reach it.
 */
export function isProxyPriority(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 100;
}

interface ProxyFile {
  version: 2;
  /**
   * Egress strategy for the whole pool.
   *
   * `mode` is the current shape; `enabled` is the earlier boolean, still read so
   * a file written before modes existed keeps working (true meant "rotate").
   */
  rotation?: { mode?: ProxyMode; enabled?: boolean };
  proxies: StoredProxy[];
}

/** Schemes undici's ProxyAgent accepts. */
const SUPPORTED_SCHEMES = new Set(["http:", "https:"]);

/**
 * Schemes the parser must name as unsupported rather than silently accept.
 *
 * undici 7 does carry experimental SOCKS support and `ProxyAgent` accepts a
 * `socks5://` URI, but authentication over it fails — the agent reports
 * "SOCKS5 authentication timeout" and every request through it dies as a 502
 * long after the URL was saved and shown as working. Since a SOCKS port almost
 * always also speaks HTTP CONNECT, the actionable answer is to say so at write
 * time instead of letting the operator debug a transport that never worked.
 */
const KNOWN_UNSUPPORTED_SCHEMES = new Set(["socks5:", "socks4:", "socks:"]);

/**
 * Validate a proxy URL and return a normalised form.
 *
 * Returning a reason rather than a boolean lets the API answer with something
 * an operator can act on, and keeps the store from ever holding a URL that
 * would only fail later at request time.
 */
export function parseProxyUrl(raw: string): { url: string } | { error: string } {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { error: "url must not be empty" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return { error: "url must be a valid URL, e.g. http://user:pass@host:port" };
  }
  if (KNOWN_UNSUPPORTED_SCHEMES.has(parsed.protocol)) {
    return {
      error: `unsupported scheme ${parsed.protocol} — undici cannot authenticate SOCKS proxies; ` +
        `this port most likely also speaks HTTP CONNECT, so try http://user:pass@host:port`,
    };
  }
  if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
    return { error: `unsupported scheme ${parsed.protocol} — use http or https` };
  }
  if (parsed.hostname.length === 0) return { error: "url must include a host" };
  return { url: parsed.toString() };
}

/**
 * Replace any password with `***` so a URL can be shown in the admin UI.
 *
 * The username is kept: operators distinguish entries by it far more often
 * than by host, and a bare `***@host` is unhelpful when several proxies share
 * a provider.
 */
export function redactProxyUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password.length > 0) parsed.password = "***";
    return parsed.toString();
  } catch {
    return "<invalid url>";
  }
}

export class ProxyStore {
  private readonly file: string;
  private proxies: StoredProxy[] = [];
  private mode: ProxyMode = "sticky";
  private mtimeMs = 0;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.file = path.join(dataDir, "proxies.json");
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  /** Egress strategy for the pool. */
  getMode(): ProxyMode {
    this.reloadIfChanged();
    return this.mode;
  }

  setMode(mode: ProxyMode): ProxyMode {
    this.reloadIfChanged();
    this.mode = mode;
    this.persist();
    return this.mode;
  }

  private load(): void {
    if (!fs.existsSync(this.file)) {
      this.proxies = [];
      this.mode = "pinned";
      this.mtimeMs = 0;
      return;
    }
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
      const parsed = JSON.parse(raw) as Partial<ProxyFile>;
      const rotation = parsed.rotation;
      this.mode = isProxyMode(rotation?.mode)
        ? rotation.mode
        // A file from before modes: `enabled: true` was the rotate setting.
        : rotation?.enabled === true
          ? "rotate"
          : "pinned";
      const list = Array.isArray(parsed.proxies) ? parsed.proxies : [];
      this.proxies = list
        .filter(
          (item): item is StoredProxy =>
            typeof item?.id === "string" && typeof item?.url === "string",
        )
        // Records written before the exit probe existed carry no exit fields;
        // normalise them so callers never have to distinguish "absent" from
        // "not measured". Records written before tiers existed default to
        // tier 0, which preserves the old "all enabled proxies are equal"
        // behaviour for anyone who never sets a priority.
        .map((item) => ({
          ...item,
          exitIp: typeof item.exitIp === "string" ? item.exitIp : null,
          exitIpCheckedAt: typeof item.exitIpCheckedAt === "number" ? item.exitIpCheckedAt : null,
          priority: typeof item.priority === "number" ? item.priority : 0,
        }));
    } catch (error) {
      this.logger.warn(`failed to read proxy store: ${(error as Error).message}`);
      this.proxies = [];
    }
  }

  private reloadIfChanged(): void {
    try {
      if (!fs.existsSync(this.file)) {
        if (this.mtimeMs !== 0 || this.proxies.length > 0) {
          this.proxies = [];
          this.mode = "pinned";
          this.mtimeMs = 0;
        }
        return;
      }
      const mtimeMs = fs.statSync(this.file).mtimeMs;
      if (mtimeMs === this.mtimeMs) return;
      this.load();
    } catch (error) {
      this.logger.warn(`failed to reload proxy store: ${(error as Error).message}`);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    // 0600: proxy URLs carry credentials.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      const body = {
        version: 2,
        rotation: { mode: this.mode },
        proxies: this.proxies,
      };
      fs.writeFileSync(fd, `${JSON.stringify(body, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = Date.now();
    }
  }

  list(): StoredProxy[] {
    this.reloadIfChanged();
    return this.proxies.map((proxy) => ({ ...proxy }));
  }

  get(id: string): StoredProxy | undefined {
    this.reloadIfChanged();
    const found = this.proxies.find((proxy) => proxy.id === id);
    return found ? { ...found } : undefined;
  }

  add(input: { url: string; label?: string | null; enabled?: boolean; priority?: number }): StoredProxy {
    this.reloadIfChanged();
    const now = Date.now();
    const record: StoredProxy = {
      id: randomUUID(),
      label: input.label ?? null,
      url: input.url,
      enabled: input.enabled !== false,
      createdAt: now,
      updatedAt: now,
      lastError: null,
      exitIp: null,
      exitIpCheckedAt: null,
      priority: input.priority ?? 0,
    };
    this.proxies = [...this.proxies, record];
    this.persist();
    return { ...record };
  }

  update(
    id: string,
    patch: {
      url?: string;
      label?: string | null;
      enabled?: boolean;
      lastError?: string | null;
      exitIp?: string | null;
      exitIpCheckedAt?: number | null;
      priority?: number;
    },
  ): StoredProxy | undefined {
    this.reloadIfChanged();
    const existing = this.proxies.find((proxy) => proxy.id === id);
    if (!existing) return undefined;
    const next: StoredProxy = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.proxies = this.proxies.map((proxy) => (proxy.id === id ? next : proxy));
    this.persist();
    return { ...next };
  }

  remove(id: string): boolean {
    this.reloadIfChanged();
    const before = this.proxies.length;
    this.proxies = this.proxies.filter((proxy) => proxy.id !== id);
    if (this.proxies.length === before) return false;
    this.persist();
    return true;
  }
}
