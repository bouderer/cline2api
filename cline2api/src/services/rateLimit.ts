/**
 * Request rate limiting for the model-call endpoints.
 *
 * Two ceilings, deliberately with different behaviour when they are hit,
 * because the two limits fail for different reasons:
 *
 *   - Per key (default 200/min): the caller is going too fast on one key. The
 *     right answer is an immediate 429 with `Retry-After`, so a client holding
 *     several keys can rotate to another one right away. Waiting here would
 *     defeat that — the point is to get off this key, not to hold the request.
 *   - Global (default 400/min): the whole gateway is saturated, so there is no
 *     other key to switch to. Here a request waits briefly for a slot to open
 *     (bounded by `maxWaitMs`) and only then gives up with a 429.
 *
 * Both are sliding windows: a fixed-window counter would let 200 requests
 * through at 12:00:59 and another 200 at 12:01:00, which is exactly the burst
 * the limit exists to prevent.
 *
 * Settings live in `data/ratelimit.json` so they can be changed from the admin
 * UI without a restart. The file is optional: with no file the env defaults
 * apply, so a deployment that never opens the UI still gets the limit.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface RateLimitSettings {
  enabled: boolean;
  /** Ceiling across all keys per minute. */
  globalPerMinute: number;
  /** Ceiling per client API key per minute. */
  keyPerMinute: number;
}

export const DEFAULT_RATE_LIMIT: RateLimitSettings = {
  enabled: true,
  globalPerMinute: 400,
  keyPerMinute: 200,
};

const WINDOW_MS = 60_000;

/** How long a request may wait for a global slot before it is refused. */
export const DEFAULT_MAX_WAIT_MS = 10_000;
const WAIT_TICK_MS = 100;

/** Hard bounds, so a typo in the UI cannot disable the limit by accident. */
const MIN_PER_MINUTE = 1;
const MAX_PER_MINUTE = 1_000_000;

export interface RateLimitDecision {
  allowed: boolean;
  /** Which ceiling refused it, when it was refused. */
  scope: "key" | "global" | null;
  /** The ceiling that applied. */
  limit: number;
  /** Requests counted in the current window for that scope. */
  used: number;
  /** Milliseconds until the oldest request in the window ages out. */
  retryAfterMs: number;
}

export interface RateLimitDeps {
  dataDir: string;
  logger: Logger;
  defaults?: Partial<RateLimitSettings>;
  /** Injectable for tests: the wait loop would otherwise sleep for real. */
  maxWaitMs?: number;
}

/**
 * Sliding-window counters plus the persisted settings behind them.
 *
 * Counters are in memory only: the limit is a property of live traffic, and
 * persisting it would make a restart inherit a window from a previous process.
 */
export class RateLimiter {
  private settings: RateLimitSettings;
  private readonly file: string;
  private readonly maxWaitMs: number;
  /** key id -> timestamps of counted requests. */
  private readonly perKey = new Map<string, number[]>();
  private global: number[] = [];

  constructor(private readonly deps: RateLimitDeps) {
    this.file = path.join(deps.dataDir, "ratelimit.json");
    this.maxWaitMs = deps.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
    this.settings = { ...DEFAULT_RATE_LIMIT, ...(deps.defaults ?? {}) };
    this.load();
  }

  /** Current settings, a copy so callers cannot mutate the live ones. */
  getSettings(): RateLimitSettings {
    return { ...this.settings };
  }

  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as Partial<RateLimitSettings>;
      this.settings = this.sanitize({ ...this.settings, ...raw });
    } catch (error) {
      // A corrupt file must not silently remove the limit: keep the defaults.
      this.deps.logger.warn("rate limit settings unreadable; using defaults", {
        error: (error as Error).message,
      });
    }
  }

  /** Persist new settings. Returns the sanitized values actually stored. */
  update(patch: Partial<RateLimitSettings>): RateLimitSettings {
    this.settings = this.sanitize({ ...this.settings, ...patch });
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(this.settings, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.deps.logger.error("failed to persist rate limit settings", {
        error: (error as Error).message,
      });
    }
    return this.getSettings();
  }

  private sanitize(next: RateLimitSettings): RateLimitSettings {
    const clamp = (value: unknown, fallback: number): number => {
      const n = typeof value === "number" && Number.isFinite(value) ? Math.floor(value) : fallback;
      return Math.max(MIN_PER_MINUTE, Math.min(MAX_PER_MINUTE, n));
    };
    return {
      enabled: next.enabled !== false,
      globalPerMinute: clamp(next.globalPerMinute, DEFAULT_RATE_LIMIT.globalPerMinute),
      keyPerMinute: clamp(next.keyPerMinute, DEFAULT_RATE_LIMIT.keyPerMinute),
    };
  }

  /** Drop timestamps that have aged out of the window. */
  private prune(list: number[], now: number): number[] {
    const cutoff = now - WINDOW_MS;
    let index = 0;
    while (index < list.length && (list[index] as number) <= cutoff) index += 1;
    return index === 0 ? list : list.slice(index);
  }

  private millisUntilFree(list: number[], limit: number, now: number): number {
    // The window frees a slot when its oldest entry ages out.
    const oldest = list[list.length - limit];
    if (oldest === undefined) return 0;
    return Math.max(0, oldest + WINDOW_MS - now);
  }

  /**
   * Count one request against both windows.
   *
   * `keyId` is null for callers that authenticated some other way; those still
   * count against the global ceiling but have no per-key one of their own.
   */
  private tryAcquire(keyId: string | null, now: number): RateLimitDecision {
    this.global = this.prune(this.global, now);
    const keyList = keyId === null ? null : this.prune(this.perKey.get(keyId) ?? [], now);
    if (keyId !== null && keyList !== null) this.perKey.set(keyId, keyList);

    if (keyList !== null && keyList.length >= this.settings.keyPerMinute) {
      return {
        allowed: false,
        scope: "key",
        limit: this.settings.keyPerMinute,
        used: keyList.length,
        retryAfterMs: this.millisUntilFree(keyList, this.settings.keyPerMinute, now),
      };
    }
    if (this.global.length >= this.settings.globalPerMinute) {
      return {
        allowed: false,
        scope: "global",
        limit: this.settings.globalPerMinute,
        used: this.global.length,
        retryAfterMs: this.millisUntilFree(this.global, this.settings.globalPerMinute, now),
      };
    }

    keyList?.push(now);
    this.global.push(now);
    return {
      allowed: true,
      scope: null,
      limit: this.settings.keyPerMinute,
      used: keyList?.length ?? this.global.length,
      retryAfterMs: 0,
    };
  }

  /**
   * Decide whether a request may proceed, waiting out a *global* saturation.
   *
   * A per-key refusal returns immediately: the caller should switch keys, and
   * making it wait would hold a connection open for a limit that another key
   * can already serve.
   */
  async acquire(keyId: string | null, signal?: AbortSignal): Promise<RateLimitDecision> {
    if (!this.settings.enabled) {
      return { allowed: true, scope: null, limit: 0, used: 0, retryAfterMs: 0 };
    }

    const first = this.tryAcquire(keyId, Date.now());
    if (first.allowed || first.scope === "key") return first;

    const deadline = Date.now() + this.maxWaitMs;
    for (;;) {
      if (signal?.aborted === true) return first;
      const now = Date.now();
      if (now >= deadline) return this.tryAcquire(keyId, now);
      const wait = Math.min(first.retryAfterMs || WAIT_TICK_MS, deadline - now, WAIT_TICK_MS * 5);
      await new Promise((resolve) => setTimeout(resolve, Math.max(WAIT_TICK_MS, wait)));
      const attempt = this.tryAcquire(keyId, Date.now());
      if (attempt.allowed || attempt.scope === "key") return attempt;
    }
  }

  /** Current usage, for the admin view. */
  snapshot(): { settings: RateLimitSettings; globalUsed: number; keys: number } {
    const now = Date.now();
    this.global = this.prune(this.global, now);
    let keys = 0;
    for (const [id, list] of this.perKey) {
      const pruned = this.prune(list, now);
      if (pruned.length === 0) this.perKey.delete(id);
      else {
        this.perKey.set(id, pruned);
        keys += 1;
      }
    }
    return { settings: this.getSettings(), globalUsed: this.global.length, keys };
  }

  /** Forget all counters. Used by tests and after a settings change. */
  reset(): void {
    this.global = [];
    this.perKey.clear();
  }
}
