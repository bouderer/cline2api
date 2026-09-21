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
}

interface ProxyFile {
  version: 1;
  proxies: StoredProxy[];
}

/** Schemes undici's ProxyAgent accepts. */
const SUPPORTED_SCHEMES = new Set(["http:", "https:", "socks5:", "socks4:"]);

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
  if (!SUPPORTED_SCHEMES.has(parsed.protocol)) {
    return { error: `unsupported scheme ${parsed.protocol} — use http, https, socks4 or socks5` };
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

  private load(): void {
    if (!fs.existsSync(this.file)) {
      this.proxies = [];
      this.mtimeMs = 0;
      return;
    }
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
      const parsed = JSON.parse(raw) as Partial<ProxyFile>;
      const list = Array.isArray(parsed.proxies) ? parsed.proxies : [];
      this.proxies = list.filter(
        (item): item is StoredProxy =>
          typeof item?.id === "string" && typeof item?.url === "string",
      );
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
      fs.writeFileSync(fd, `${JSON.stringify({ version: 1, proxies: this.proxies }, null, 2)}\n`, "utf8");
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

  add(input: { url: string; label?: string | null; enabled?: boolean }): StoredProxy {
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
    };
    this.proxies = [...this.proxies, record];
    this.persist();
    return { ...record };
  }

  update(
    id: string,
    patch: { url?: string; label?: string | null; enabled?: boolean; lastError?: string | null },
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
