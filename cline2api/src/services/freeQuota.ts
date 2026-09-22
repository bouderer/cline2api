/**
 * Free-tier quota state, one entry per account.
 *
 * Upstream exposes no endpoint for "how much free quota is left": the free
 * bucket (`cline-free/*`) is capped per account per day and the only signal is
 * a failed request — `Daily free limit reached` / `INFERENCE_CAP_ERROR`. So this
 * module keeps the two things that *are* observable:
 *
 *   - what the pool has already hit today (recorded when a chat request fails
 *     with an account-scoped quota error, for free), and
 *   - what an explicit probe saw (an opt-in, on-demand request).
 *
 * The two are deliberately kept separate rather than merged into one
 * `exhausted` flag. A probe is one request at one instant; a failure observed
 * in traffic is that account's real workload hitting the wall. Collapsing them
 * would throw away which one the operator is looking at, and the UI shows both.
 *
 * "Today" is local midnight: upstream resets the free quota on its own clock,
 * which we cannot read, and local midnight is the closest bound we can state
 * without guessing. Entries therefore expire at the next local midnight.
 */
import type { Logger } from "../logger.js";

export type FreeQuotaState = "unknown" | "ok" | "exhausted";

export interface FreeQuotaEntry {
  accountId: string;
  /** Result of the newest signal we have. */
  state: FreeQuotaState;
  /** Epoch millis of that signal. */
  at: number;
  /** The model the signal was about, when it came from traffic. */
  model: string | null;
  /** Upstream's own words, trimmed for display. */
  reason: string | null;
  /** True when the signal came from the on-demand probe rather than traffic. */
  probed: boolean;
}

/** How long one probe's verdict is trusted before it is worth re-probing. */
export const PROBE_TTL_MS = 6 * 60 * 60 * 1000;

export interface FreeQuotaStoreDeps {
  logger: Logger;
  /** Injectable so tests do not depend on the wall clock. */
  now?: () => number;
}

function startOfLocalDay(now: number): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

export class FreeQuotaStore {
  /** accountId -> newest signal. */
  private readonly entries = new Map<string, FreeQuotaEntry>();
  private readonly now: () => number;

  constructor(private readonly deps: FreeQuotaStoreDeps) {
    this.now = deps.now ?? (() => Date.now());
  }

  /**
   * Record a quota error seen in real traffic.
   *
   * Called from the proxy's failover path, where the same account+model failure
   * happens on every request until the quota resets, so this is cheap and
   * always current. A probe result from the same day wins over a traffic
   * signal: the probe is about the free bucket as a whole, the traffic error
   * only about one model.
   */
  recordQuotaError(accountId: string, model: string | null, reason: string): void {
    // A probe verdict covers the whole free bucket, so it outranks a traffic
    // error about one model — but only while that verdict is still current.
    // Reading it through `get` (rather than off the map) is what keeps a stale,
    // expired probe from blocking every later signal for the rest of the day.
    const existing = this.get(accountId);
    if (existing?.probed === true) return;
    this.entries.set(accountId, {
      accountId,
      state: "exhausted",
      at: this.now(),
      model,
      reason,
      probed: false,
    });
    this.deps.logger.debug("free quota error recorded", { accountId, model, reason });
  }

  /** Record the outcome of an explicit probe. Overrides a traffic signal. */
  recordProbe(accountId: string, state: Exclude<FreeQuotaState, "unknown">, reason: string | null): void {
    this.entries.set(accountId, {
      accountId,
      state,
      at: this.now(),
      model: null,
      reason,
      probed: true,
    });
  }

  /**
   * The newest signal for one account, or `null` when there is none today.
   *
   * A probe verdict older than PROBE_TTL_MS is dropped: the free quota resets
   * daily, so a stale probe would claim an account is still exhausted long
   * after it recovered.
   */
  get(accountId: string): FreeQuotaEntry | null {
    const entry = this.entries.get(accountId);
    if (entry === undefined) return null;
    const now = this.now();
    if (entry.at < startOfLocalDay(now)) {
      this.entries.delete(accountId);
      return null;
    }
    if (entry.probed && now - entry.at > PROBE_TTL_MS) return null;
    return { ...entry };
  }

  /** All current signals, keyed by account id. Expired entries are dropped. */
  snapshot(accountIds?: readonly string[]): Record<string, FreeQuotaEntry> {
    const out: Record<string, FreeQuotaEntry> = {};
    for (const id of accountIds ?? [...this.entries.keys()]) {
      const entry = this.get(id);
      if (entry !== null) out[id] = entry;
    }
    return out;
  }

  /** Drop the stored signals. Used by tests, and after a pool import. */
  clear(): void {
    this.entries.clear();
  }
}
