/**
 * Credit balance and usage ledger.
 *
 * Three upstream endpoints, all verified live against api.cline.bot:
 *
 *   GET /api/v1/users/me            -> data.id is the uid the other two need
 *   GET /api/v1/users/{uid}/balance -> data.balance, in micro-USD
 *   GET /api/v1/users/{uid}/usages  -> { items, nextToken }, newest first
 *
 * Two details that are easy to get wrong:
 *
 *  - The balance endpoint takes a real uid. `/api/v1/users/me/balance` exists
 *    but answers 400 "Invalid request format" because its path parameter is
 *    validated as an id, so the uid has to be resolved first.
 *  - The usage page cursor round-trips as `?cursor=`, NOT as `?nextToken=`.
 *    Sending the response's `nextToken` back under its own name is accepted
 *    without complaint and silently returns the first page again, which reads
 *    as "the account has more history here" forever.
 *
 * Units: `balance` and `costUsd` are micro-USD (1e-6 USD). Cline's own UI
 * divides by 1e4 and calls the result "credits", so 1 credit = $0.01. We keep
 * USD as the primary unit and expose credits alongside it because the two
 * appear side by side in Cline's dashboard.
 *
 * `creditsUsed` is 0 on free-tier and Cline Pass traffic: those are billed to
 * the subscription, not drawn from the balance. Token counts are populated for
 * all of it, which is why the window totals below are built from tokens rather
 * than from credits.
 *
 * The window defaults to the last 24 hours rather than "today": a rolling
 * window is always full, so the number does not drop to zero at midnight, and
 * two readings an hour apart are comparable. `snapToDay` restores the calendar
 * behaviour when that is what is wanted.
 */
import type { Dispatcher } from "undici";
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { defaultClineHeaders } from "./constants.js";
import { fetchWith } from "./proxy.js";

/**
 * Three dollar-ish numbers, in three different scales. Mixing them up is a
 * silent 100x error, so each one is named for its own unit:
 *
 *   balance      1e-6 USD  — micro-USD. Proven by a live 402 whose body
 *                            reports the same account as `$-0.02` for a
 *                            balance of `-19229`.
 *   creditsUsed  1e-6 USD  — micro-USD. Cline's own UI renders it as
 *                            `creditsUsed / 1e6` with a `$` prefix.
 *   costUsd      1e-8 USD  — two orders finer than the other two. Proven by
 *                            cross-referencing one request: the chat response
 *                            reported `cost_details.upstream_inference_cost:
 *                            0.000039` for 8 prompt + 1 completion on
 *                            claude-sonnet-4.6, and the usage ledger holds the
 *                            same request with `costUsd: 3900`. 3900 / 1e8 =
 *                            0.000039.
 *
 * The live ratio `costUsd / creditsUsed` is exactly 100 across every paid
 * record, which is the 1e8 / 1e6 gap and confirms they are the same quantity.
 */
export const MICRO_USD = 1_000_000;
/** Divisor for `costUsd`. NOT the same as MICRO_USD — see above. */
export const COST_UNITS_PER_USD = 100_000_000;
/** Cline's UI shows micro-USD / 1e4 and calls it credits, so 1 credit = $0.01. */
export const MICRO_USD_PER_CREDIT = 10_000;

/** Per-request page size. Upstream clamps anything larger down to 200. */
const USAGE_PAGE_LIMIT = 200;

/**
 * Page cap, scaled to the window being read.
 *
 * A wider window covers more history, so a fixed cap would silently truncate
 * the totals on the widest setting. The cap only ever binds on a very busy
 * account: the walk stops as soon as it reaches the window start, so most
 * reads finish on the first page.
 */
function maxPagesFor(windowMs: number): number {
  const perHour = Math.ceil(windowMs / (60 * 60 * 1000));
  return Math.max(5, Math.min(50, perHour));
}

/** Longest window the admin surface will read. Anything more is clamped. */
export const MAX_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
/** Default window: a rolling day, so it never resets to zero at midnight. */
export const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface UsageRecord {
  id: string;
  /** Epoch millis. Upstream sends an ISO-8601 UTC timestamp. */
  at: number;
  model: string | null;
  operation: string | null;
  provider: string | null;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens: number;
  /**
   * Upstream provider cost for this request, in 1e-8 USD.
   *
   * Named for what upstream calls the field (`costUsd`), which is misleading:
   * see COST_UNITS_PER_USD for why this is not micro-USD.
   */
  costMicroUsd: number;
  /** Charged to the account, in micro-USD. Zero on free and Pass traffic. */
  creditsUsed: number;
}

/**
 * One model's share of a window's usage.
 *
 * `id` is a display id the catalog understands, reconstructed from the two
 * fields upstream actually sends (`aiModelTypeName` + `aiModelName`). Those
 * are not consistent: the same model arrives as `cline-free/kimi-k3` on one
 * account and `Deepseek-v4.1-Flash` (a bare display name, no bucket) on
 * another, so the bucket prefix is only added when the name does not already
 * carry one. Without the bucket these would key as different models and the
 * per-model totals would silently split.
 */
export interface ModelUsage {
  id: string;
  /** The bucket upstream billed it under: `cline-free`, `cline-pass`, `z-ai`, ... */
  bucket: string | null;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUnits: number;
  costUsd: number;
  creditsMicroUsd: number;
}

/** Token and cost totals over one window, all zero when nothing was used. */
export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /** Summed `costUsd` units, 1e8 per USD. Kept raw for exact totals. */
  costUnits: number;
  /** The same total in dollars, scaled once here so callers cannot mis-scale it. */
  costUsd: number;
  /** Summed `creditsUsed`, micro-USD. */
  creditsMicroUsd: number;
}

export interface AccountCredits {
  uid: string | null;
  /** Micro-USD; negative when the account has overspent. */
  balanceMicroUsd: number | null;
  balanceUsd: number | null;
  balanceCredits: number | null;
  /** Totals over the requested window for this account. */
  window: UsageTotals;
  /** The same window split by model, biggest by tokens first. */
  models: ModelUsage[];
  /**
   * The window's raw records, newest first.
   *
   * Kept on the result so a caller can bucket them by time (the timeline) or
   * re-aggregate a different way without paying for a second upstream read.
   */
  records: readonly UsageRecord[];
  /** Window bounds, epoch millis, echoed so the UI can label the column. */
  since: number;
  until: number;
  windowMs: number;
  /** True when the window was snapped to local midnight instead of rolling. */
  snappedToDay: boolean;
  lastUsage: UsageRecord | null;
  /** Upstream failure that made part of this row unavailable. */
  error: string | null;
}

/** Window selection plus the egress the account is assigned to. */
export interface AccountCreditsOptions extends UsageWindowRequest {
  dispatcher?: Dispatcher;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUnits: 0,
    costUsd: 0,
    creditsMicroUsd: 0,
  };
}

function headersFor(config: AppConfig, authorization: string, taskId: string): Record<string, string> {
  return {
    Authorization: authorization,
    Accept: "application/json",
    ...defaultClineHeaders({
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      platform: config.platform,
      platformVersion: config.platformVersion,
      coreVersion: config.coreVersion,
      taskId,
    }),
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function readNumber(source: Record<string, unknown>, key: string): number {
  const value = source[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** Local midnight for the day containing `now`, as epoch millis. */
export function startOfLocalDay(now: number = Date.now()): number {
  const date = new Date(now);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** `/api/v1/users/me` — the uid every other call in this file needs. */
export async function fetchUserId(
  config: AppConfig,
  authorization: string,
  logger: Logger,
  dispatcher?: Dispatcher,
): Promise<string | null> {
  try {
    const response = await fetchWith(
      `${config.clineApiBaseUrl}/api/v1/users/me`,
      {
        headers: headersFor(config, authorization, "admin-me"),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
      dispatcher,
    );
    if (!response.ok) {
      logger.warn("user lookup failed", { status: response.status });
      return null;
    }
    const payload = (await response.json()) as { data?: unknown };
    const id = readString(asRecord(payload.data), "id");
    return id;
  } catch (error) {
    logger.warn("user lookup failed", { error: (error as Error).message });
    return null;
  }
}

/** `GET /api/v1/users/{uid}/balance`. Returns micro-USD, or null on failure. */
export async function fetchBalance(
  config: AppConfig,
  authorization: string,
  uid: string,
  logger: Logger,
  dispatcher?: Dispatcher,
): Promise<number | null> {
  try {
    const response = await fetchWith(
      `${config.clineApiBaseUrl}/api/v1/users/${encodeURIComponent(uid)}/balance`,
      {
        headers: headersFor(config, authorization, "admin-balance"),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
      dispatcher,
    );
    if (!response.ok) {
      logger.warn("balance lookup failed", { status: response.status });
      return null;
    }
    const payload = (await response.json()) as { data?: unknown };
    const balance = asRecord(payload.data).balance;
    return typeof balance === "number" && Number.isFinite(balance) ? balance : null;
  } catch (error) {
    logger.warn("balance lookup failed", { error: (error as Error).message });
    return null;
  }
}

function toUsageRecord(raw: unknown): UsageRecord | null {
  const item = asRecord(raw);
  const id = readString(item, "id");
  const createdAt = readString(item, "createdAt");
  if (!id || !createdAt) return null;
  const at = Date.parse(createdAt);
  if (Number.isNaN(at)) return null;
  return {
    id,
    at,
    model: normalizeModelId(
      readString(item, "aiModelTypeName"),
      readString(item, "aiModelName"),
    ),
    operation: readString(item, "operation"),
    provider: readString(item, "aiInferenceProviderName"),
    promptTokens: readNumber(item, "promptTokens"),
    completionTokens: readNumber(item, "completionTokens"),
    totalTokens: readNumber(item, "totalTokens"),
    cachedTokens: readNumber(item, "cachedTokens"),
    costMicroUsd: readNumber(item, "costUsd"),
    creditsUsed: readNumber(item, "creditsUsed"),
  };
}

/**
 * Rebuild a usable model id from the ledger's two model fields.
 *
 * Upstream is inconsistent about which of the two is populated: a usage row
 * carries either the full catalog id (`cline-free/kimi-k3`) or a bare display
 * name (`Deepseek-v4.1-Flash`, `Muse Spark 1.3 Contributor`) plus a bucket in
 * `aiModelTypeName`. A name that already looks like an id is kept as-is —
 * prefixing it would produce `cline-free/cline-free/kimi-k3` and split one
 * model's totals across two keys.
 */
export function normalizeModelId(bucket: string | null, name: string | null): string | null {
  if (name === null) return bucket;
  if (name.includes("/")) return name;
  return bucket === null ? name : `${bucket}/${name}`;
}

/**
 * Usage records back to `since`, newest first.
 *
 * Upstream returns 200 items per page regardless of a larger `limit`, so this
 * walks the `cursor` until the window is covered. `windowMs` only sets the page
 * cap — the walk itself stops at `since`.
 */
export async function fetchUsagesSince(
  config: AppConfig,
  authorization: string,
  uid: string,
  since: number,
  logger: Logger,
  windowMs: number = DEFAULT_WINDOW_MS,
  dispatcher?: Dispatcher,
): Promise<UsageRecord[]> {
  const collected: UsageRecord[] = [];
  let cursor: string | null = null;
  const maxPages = maxPagesFor(windowMs);

  for (let page = 0; page < maxPages; page += 1) {
    const url = new URL(
      `${config.clineApiBaseUrl}/api/v1/users/${encodeURIComponent(uid)}/usages`,
    );
    url.searchParams.set("limit", String(USAGE_PAGE_LIMIT));
    if (cursor !== null) url.searchParams.set("cursor", cursor);

    let payload: { data?: unknown };
    try {
      const response = await fetchWith(
        url,
        {
          headers: headersFor(config, authorization, "admin-usages"),
          signal: AbortSignal.timeout(config.requestTimeoutMs),
        },
        dispatcher,
      );
      if (!response.ok) {
        logger.warn("usage lookup failed", { status: response.status, page });
        break;
      }
      payload = (await response.json()) as { data?: unknown };
    } catch (error) {
      logger.warn("usage lookup failed", { error: (error as Error).message, page });
      break;
    }

    const data = asRecord(payload.data);
    const items = Array.isArray(data.items) ? data.items : [];
    if (items.length === 0) break;

    let reachedWindowStart = false;
    for (const raw of items) {
      const record = toUsageRecord(raw);
      if (record === null) continue;
      // Newest first, so the first record older than the window ends the walk.
      if (record.at < since) {
        reachedWindowStart = true;
        break;
      }
      collected.push(record);
    }
    if (reachedWindowStart) break;

    const next = readString(data, "nextToken");
    if (next === null || next === cursor) break;
    cursor = next;
  }

  return collected;
}

export function sumUsage(records: readonly UsageRecord[]): UsageTotals {
  const totals = emptyTotals();
  for (const record of records) {
    totals.requests += 1;
    totals.promptTokens += record.promptTokens;
    totals.completionTokens += record.completionTokens;
    totals.cachedTokens += record.cachedTokens;
    totals.totalTokens += record.totalTokens;
    totals.costUnits += record.costMicroUsd;
    totals.creditsMicroUsd += record.creditsUsed;
  }
  totals.costUsd = totals.costUnits / COST_UNITS_PER_USD;
  return totals;
}

/** Bucket prefix of a normalized id, e.g. `cline-free` in `cline-free/kimi-k3`. */
function bucketOf(id: string): string | null {
  const slash = id.indexOf("/");
  return slash > 0 ? id.slice(0, slash) : null;
}

/**
 * Per-model totals over one window, biggest spender first.
 *
 * A record with no model at all is dropped rather than bucketed under a
 * "unknown" row: on a free-tier account those are the requests upstream billed
 * nothing for, and inventing a model name for them would make the table look
 * like it covers more than it does.
 */
export function sumUsageByModel(records: readonly UsageRecord[]): ModelUsage[] {
  const byId = new Map<string, ModelUsage>();
  for (const record of records) {
    if (record.model === null) continue;
    let entry = byId.get(record.model);
    if (entry === undefined) {
      entry = {
        id: record.model,
        bucket: bucketOf(record.model),
        requests: 0,
        promptTokens: 0,
        completionTokens: 0,
        cachedTokens: 0,
        totalTokens: 0,
        costUnits: 0,
        costUsd: 0,
        creditsMicroUsd: 0,
      };
      byId.set(record.model, entry);
    }
    entry.requests += 1;
    entry.promptTokens += record.promptTokens;
    entry.completionTokens += record.completionTokens;
    entry.cachedTokens += record.cachedTokens;
    entry.totalTokens += record.totalTokens;
    entry.costUnits += record.costMicroUsd;
    entry.creditsMicroUsd += record.creditsUsed;
  }
  const rows = [...byId.values()];
  for (const row of rows) row.costUsd = row.costUnits / COST_UNITS_PER_USD;
  // Token count, not cost: on free and Pass traffic every cost is zero, so
  // sorting by cost would leave the busiest models in arbitrary order.
  rows.sort((a, b) => b.totalTokens - a.totalTokens || a.id.localeCompare(b.id));
  return rows;
}

/** One time bucket in a usage timeline. */
export interface UsageBucket {
  /** Bucket start, epoch millis. */
  at: number;
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUnits: number;
  costUsd: number;
  /** Tokens that hit the prompt cache, as a fraction of prompt tokens (0-1). */
  cacheHitRate: number;
}

/**
 * The bucket step for a window, snapped to a human-sized interval.
 *
 * Split out so the by-time and by-model passes share one definition of the
 * bucket boundaries; if the two disagreed the series could not be read together.
 */
export function bucketStepFor(window: ResolvedWindow, target = 48): number {
  const span = Math.max(1, window.until - window.since);
  const rough = span / target;
  const STEPS = [
    60_000, 5 * 60_000, 15 * 60_000, 30 * 60_000,
    60 * 60_000, 3 * 60 * 60_000, 6 * 60 * 60_000, 12 * 60 * 60_000,
    24 * 60 * 60_000, 7 * 24 * 60 * 60_000,
  ];
  return STEPS.find((s) => s >= rough) ?? STEPS[STEPS.length - 1]!;
}

/**
 * Bucket a window's records into a timeline.
 *
 * The bucket size is chosen from the window so the series lands in a readable
 * range rather than 1440 points: too many buckets and every point is noise,
 * too few and the shape disappears. Empty buckets are emitted as zeros so the
 * x-axis stays linear in time — a gap-free series would draw a straight line
 * across an hour of no traffic and read as sustained usage.
 */
export function bucketUsage(records: readonly UsageRecord[], window: ResolvedWindow): UsageBucket[] {
  const step = bucketStepFor(window);
  const start = Math.floor(window.since / step) * step;
  const count = Math.max(1, Math.ceil((window.until - start) / step));

  const buckets: UsageBucket[] = Array.from({ length: count }, (_, i) => ({
    at: start + i * step,
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costUnits: 0,
    costUsd: 0,
    cacheHitRate: 0,
  }));

  for (const record of records) {
    const index = Math.min(count - 1, Math.max(0, Math.floor((record.at - start) / step)));
    const bucket = buckets[index]!;
    bucket.requests += 1;
    bucket.promptTokens += record.promptTokens;
    bucket.completionTokens += record.completionTokens;
    bucket.cachedTokens += record.cachedTokens;
    bucket.totalTokens += record.totalTokens;
    bucket.costUnits += record.costMicroUsd;
  }
  for (const bucket of buckets) {
    bucket.costUsd = bucket.costUnits / COST_UNITS_PER_USD;
    bucket.cacheHitRate = bucket.promptTokens > 0 ? bucket.cachedTokens / bucket.promptTokens : 0;
  }
  return buckets;
}

/** One model's series across a timeline: a bucket-aligned array of totals. */
export interface ModelTimeline {
  id: string;
  bucket: string | null;
  /** Parallel to the timeline's buckets, same length and order. */
  tokens: number[];
  requests: number[];
  total: number;
}

export interface UsageTimeline {
  buckets: UsageBucket[];
  models: ModelTimeline[];
}

/**
 * Bucket a window's records by time *and* by model.
 *
 * Two series shapes are produced from one pass: the pool total per bucket, and
 * each model's tokens per bucket aligned to the same bucket boundaries. The
 * alignment is the point — a model chart whose x-axis drifted from the total
 * chart's would make the two impossible to read together.
 *
 * Only the models that carry the window are returned, most tokens first, since
 * a legend past a handful of entries stops being readable. `maxModels` caps it
 * and the caller is told what was dropped through the returned totals.
 */
export function bucketUsageByModel(
  records: readonly UsageRecord[],
  window: ResolvedWindow,
  options: { maxModels?: number } = {},
): UsageTimeline {
  const buckets = bucketUsage(records, window);
  const step = bucketStepFor(window);
  const start = Math.floor(window.since / step) * step;

  const indexFor = (at: number): number => {
    const i = Math.floor((at - start) / step);
    return Math.min(buckets.length - 1, Math.max(0, i));
  };

  const byModel = new Map<string, ModelTimeline>();
  for (const record of records) {
    if (record.model === null) continue;
    let series = byModel.get(record.model);
    if (series === undefined) {
      series = {
        id: record.model,
        bucket: bucketOf(record.model),
        tokens: new Array<number>(buckets.length).fill(0),
        requests: new Array<number>(buckets.length).fill(0),
        total: 0,
      };
      byModel.set(record.model, series);
    }
    const i = indexFor(record.at);
    series.tokens[i] = (series.tokens[i] ?? 0) + record.totalTokens;
    series.requests[i] = (series.requests[i] ?? 0) + 1;
    series.total += record.totalTokens;
  }

  const all = [...byModel.values()].sort((a, b) => b.total - a.total || a.id.localeCompare(b.id));
  const maxModels = options.maxModels ?? 8;
  return { buckets, models: all.slice(0, maxModels) };
}

/** The window an admin read covers, resolved from request options. */
export interface UsageWindowRequest {
  /** Window length in millis. Clamped to [1 minute, MAX_WINDOW_MS]. */
  windowMs?: number;
  /**
   * Snap the start to local midnight instead of a rolling window. Only
   * meaningful for a roughly day-long window; it is ignored otherwise.
   */
  snapToDay?: boolean;
  /** Reference time, defaulting to now. Tests pass a fixed value. */
  now?: number;
}

export interface ResolvedWindow {
  since: number;
  until: number;
  windowMs: number;
  snappedToDay: boolean;
}

const MIN_WINDOW_MS = 60 * 1000;

/** Turn request options into concrete bounds, clamping anything out of range. */
export function resolveWindow(options: UsageWindowRequest = {}): ResolvedWindow {
  const until = options.now ?? Date.now();
  const requested = options.windowMs ?? DEFAULT_WINDOW_MS;
  const windowMs = Math.max(
    MIN_WINDOW_MS,
    Math.min(MAX_WINDOW_MS, Number.isFinite(requested) ? requested : DEFAULT_WINDOW_MS),
  );

  // Snapping only makes sense for a day-scale window: for a 15-minute window it
  // would return however much of today has elapsed instead of the last 15
  // minutes, which is the opposite of what was asked for.
  const dayish = windowMs >= 23 * 60 * 60 * 1000 && windowMs <= 25 * 60 * 60 * 1000;
  if (options.snapToDay === true && dayish) {
    return { since: startOfLocalDay(until), until, windowMs, snappedToDay: true };
  }
  return { since: until - windowMs, until, windowMs, snappedToDay: false };
}

/**
 * Everything the admin UI shows for one account: balance, the window's totals
 * and the most recent request. `authorization` must already be resolved by the
 * caller, so a dead credential surfaces as an error here rather than a
 * confusing empty row.
 */
export async function fetchAccountCredits(
  config: AppConfig,
  authorization: string,
  logger: Logger,
  options: AccountCreditsOptions = {},
): Promise<AccountCredits> {
  const window = resolveWindow(options);
  const uid = await fetchUserId(config, authorization, logger, options.dispatcher);
  if (uid === null) {
    return {
      uid: null,
      balanceMicroUsd: null,
      balanceUsd: null,
      balanceCredits: null,
      window: emptyTotals(),
      models: [],
      records: [],
      since: window.since,
      until: window.until,
      windowMs: window.windowMs,
      snappedToDay: window.snappedToDay,
      lastUsage: null,
      error: "user lookup failed",
    };
  }

  const [balanceMicroUsd, usages] = await Promise.all([
    fetchBalance(config, authorization, uid, logger, options.dispatcher),
    fetchUsagesSince(
      config,
      authorization,
      uid,
      window.since,
      logger,
      window.windowMs,
      options.dispatcher,
    ),
  ]);

  return {
    uid,
    balanceMicroUsd,
    balanceUsd: balanceMicroUsd === null ? null : balanceMicroUsd / MICRO_USD,
    balanceCredits:
      balanceMicroUsd === null ? null : balanceMicroUsd / MICRO_USD_PER_CREDIT,
    window: sumUsage(usages),
    models: sumUsageByModel(usages),
    records: usages,
    since: window.since,
    until: window.until,
    windowMs: window.windowMs,
    snappedToDay: window.snappedToDay,
    lastUsage: usages[0] ?? null,
    error: null,
  };
}
