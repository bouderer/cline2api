/**
 * Which accounts can serve which kind of model.
 *
 * The pool is round-robin and has no idea that its accounts differ in what they
 * are entitled to. That is fine while most accounts can serve most models, and
 * disastrous for the ones held by a handful of accounts: Cline Pass covers
 * `cline-pass/*`, and in a pool of 1658 accounts only a couple hold it. Round
 * robin picks the next account in sequence, so a Pass request is almost always
 * handed to an account that cannot serve it — and the failover path then walks
 * on, learning "not this one" a few accounts at a time and never reaching the
 * ones that would have worked.
 *
 * `GET /users/me/plan` answers this authoritatively and cheaply: it reports the
 * plan's `cline_pass` entitlement without spending any inference. So the index
 * is built by asking once per account, in the background, and is then consulted
 * on the request path where it turns an unbounded walk into a shortlist.
 *
 * Persisted to `data/capabilities.json` so a restart does not drop the index
 * back to `known: 0` — which would make the request path fall through to a
 * full pool walk for `cline-pass/*` until a sweep refilled it. The TTL still
 * applies on load, so a stale file only routes at accounts whose plan was read
 * recently; the startup sweep then re-verifies the rest.
 */
import fs from "node:fs";
import path from "node:path";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import type { TokenManager } from "../cline/tokenManager.js";
import type { ProxyResolver } from "../cline/proxy.js";
import { fetchSubscription } from "../cline/subscription.js";

/** One account's known entitlements. */
export interface AccountCapability {
  /** The plan includes Cline Pass, so it can serve `cline-pass/*`. */
  clinePass: boolean;
  /** When this was read, epoch millis. */
  at: number;
}

export interface CapabilityIndexOptions {
  config: AppConfig;
  logger: Logger;
  store: AccountStore;
  tokens: TokenManager;
  resolver: ProxyResolver;
  readonly now?: () => number;
  /** Accounts read at once. Mirrors the credits sweep's bound. */
  concurrency?: number;
}

/** How long a reading stays good. Plans change on a billing cycle, not by the minute. */
export const CAPABILITY_TTL_MS = 6 * 60 * 60 * 1000;

const DEFAULT_CONCURRENCY = 6;

export class CapabilityIndex {
  private readonly entries = new Map<string, AccountCapability>();
  private readonly now: () => number;
  private readonly concurrency: number;
  private readonly file: string;
  /** The sweep in flight, so repeat calls join it instead of stacking. */
  private inFlight: Promise<void> | null = null;
  /** Debounce persistence: a sweep records hundreds of entries at once. */
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly options: CapabilityIndexOptions) {
    this.now = options.now ?? Date.now;
    this.concurrency = options.concurrency ?? DEFAULT_CONCURRENCY;
    this.file = path.join(options.config.dataDir, "capabilities.json");
    this.load();
  }

  /** Load persisted readings, dropping ones past the TTL. Never throws. */
  private load(): void {
    try {
      if (!fs.existsSync(this.file)) return;
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as {
        entries?: Record<string, AccountCapability>;
      };
      const entries = raw.entries ?? {};
      for (const [id, entry] of Object.entries(entries)) {
        if (typeof entry?.at === "number" && typeof entry?.clinePass === "boolean") {
          this.entries.set(id, { clinePass: entry.clinePass, at: entry.at });
        }
      }
      const { known, clinePass } = this.stats();
      this.options.logger.info("capability index loaded", { known, clinePass });
    } catch (error) {
      // A corrupt file must not block startup: a cold index is recoverable by sweep.
      this.options.logger.warn("capability index unreadable; starting cold", {
        error: (error as Error).message,
      });
    }
  }

  /** Persist the index. Debounced; safe to call on every record. */
  private persist(): void {
    if (this.saveTimer !== null) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        const entries: Record<string, AccountCapability> = {};
        for (const [id, entry] of this.entries) entries[id] = entry;
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tmp, `${JSON.stringify({ entries }, null, 2)}\n`, { mode: 0o600 });
        fs.renameSync(tmp, this.file);
      } catch (error) {
        this.options.logger.warn("failed to persist capability index", {
          error: (error as Error).message,
        });
      }
    }, 500);
    // Do not hold the event loop open for a pending save.
    if (typeof this.saveTimer.unref === "function") this.saveTimer.unref();
  }

  /** The stored reading, or null when there is none or it has expired. */
  get(accountId: string): AccountCapability | null {
    const entry = this.entries.get(accountId);
    if (entry === undefined) return null;
    if (this.now() - entry.at >= CAPABILITY_TTL_MS) return null;
    return entry;
  }

  /** Record what a plan lookup said. Called by the sweep and by traffic. */
  record(accountId: string, clinePass: boolean): void {
    this.entries.set(accountId, { clinePass, at: this.now() });
    this.persist();
  }

  /** Accounts whose stored reading says they hold Cline Pass. */
  clinePassAccounts(): string[] {
    const out: string[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.clinePass && this.now() - entry.at < CAPABILITY_TTL_MS) out.push(id);
    }
    return out;
  }

  /**
   * How many accounts have been read, and how many of them hold Pass.
   *
   * `known` is what the request path uses to decide whether it can trust a
   * shortlist: with nothing read, an empty Pass list means "not asked yet"
   * rather than "nobody has it", and those two must not be conflated.
   */
  stats(): { known: number; clinePass: number } {
    let known = 0;
    let pass = 0;
    for (const entry of this.entries.values()) {
      if (this.now() - entry.at >= CAPABILITY_TTL_MS) continue;
      known += 1;
      if (entry.clinePass) pass += 1;
    }
    return { known, clinePass: pass };
  }

  /**
   * Read every account's plan, in the background.
   *
   * Repeat calls join the sweep in flight rather than stacking another pass on
   * top: this is a per-account upstream call, and a page that polls while it
   * runs must not multiply the load.
   */
  sweep(): { started: boolean; accounts: number } {
    const accounts = this.options.store.list();
    if (this.inFlight !== null) return { started: false, accounts: accounts.length };

    const run = this.runSweep(accounts)
      .catch((error) => {
        this.options.logger.warn("capability sweep failed", { error: (error as Error).message });
      })
      .finally(() => {
        this.inFlight = null;
      });
    this.inFlight = run;
    return { started: true, accounts: accounts.length };
  }

  /** Whether a sweep is in flight, so a caller can poll for completion. */
  sweeping(): boolean {
    return this.inFlight !== null;
  }

  /** Settle the in-flight sweep. Used by tests and shutdown. */
  async settled(): Promise<void> {
    await this.inFlight;
  }

  private async runSweep(accounts: readonly { id: string; disabled: boolean }[]): Promise<void> {
    let next = 0;
    const runners = Array.from(
      { length: Math.min(this.concurrency, accounts.length) },
      async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= accounts.length) return;
          const account = accounts[index]!;
          await this.read(account.id, account.disabled);
        }
      },
    );
    await Promise.all(runners);
    const { known, clinePass } = this.stats();
    this.options.logger.info("capability sweep finished", { known, clinePass });
  }

  /**
   * Read one account's plan.
   *
   * A plan that does not exist is the common case, not an error: most accounts
   * in a bulk-registered pool have no subscription at all, and upstream answers
   * `GET /users/me/plan` with a 404 for them. That is a definitive "no Pass",
   * so it is recorded. Only a genuine failure — a network error, a 5xx, a dead
   * credential — leaves the entry alone, because recording "no Pass" on a read
   * that did not happen would route Pass traffic away from an account that may
   * well hold it.
   */
  private async read(accountId: string, disabled: boolean): Promise<void> {
    const authorization = await this.options.tokens
      // A disabled account is still worth reading: it may be turned back on,
      // and forcing the refresh keeps its token rotating meanwhile.
      .getAuthorization(accountId, disabled ? { forceRefresh: true } : {})
      .catch(() => null);
    if (!authorization) return;

    const plan = await fetchSubscription(
      this.options.config,
      authorization,
      this.options.logger,
      this.options.resolver.forAccount(accountId),
    );
    if (plan.error !== null && !isMissingPlan(plan.error)) return;
    this.record(accountId, plan.clinePassEnabled === true);
  }
}

/**
 * Whether a plan lookup's error means "this account has no plan".
 *
 * `fetchSubscription` reports a non-2xx as `HTTP <status>`. A 404 is the pool's
 * normal state rather than a failure to read, and treating it as one would
 * leave most of the index empty.
 */
function isMissingPlan(error: string): boolean {
  return /^HTTP 404$/.test(error.trim());
}
