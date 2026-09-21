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
 * all of it, which is why the daily totals below are built from tokens rather
 * than from credits.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { defaultClineHeaders } from "./constants.js";

/** `balance` and `costUsd` arrive in millionths of a dollar. */
export const MICRO_USD = 1_000_000;
/** Cline's UI shows micro-USD / 1e4 and calls it credits, so 1 credit = $0.01. */
export const MICRO_USD_PER_CREDIT = 10_000;

/** Per-request page size. Upstream clamps anything larger down to 200. */
const USAGE_PAGE_LIMIT = 200;
/** Stop paging after this many pages even if the window is not covered yet. */
const USAGE_MAX_PAGES = 5;

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
  /** Micro-USD actually billed to the provider for this request. */
  costMicroUsd: number;
  creditsUsed: number;
}

/** Token and cost totals over one window, all zero when nothing was used. */
export interface UsageTotals {
  requests: number;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costMicroUsd: number;
  creditsUsed: number;
}

export interface AccountCredits {
  uid: string | null;
  /** Micro-USD; negative when the account has overspent. */
  balanceMicroUsd: number | null;
  balanceUsd: number | null;
  balanceCredits: number | null;
  /** Local-midnight-to-now totals for this account. */
  today: UsageTotals;
  lastUsage: UsageRecord | null;
  /** Upstream failure that made part of this row unavailable. */
  error: string | null;
}

function emptyTotals(): UsageTotals {
  return {
    requests: 0,
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    totalTokens: 0,
    costMicroUsd: 0,
    creditsUsed: 0,
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
): Promise<string | null> {
  try {
    const response = await fetch(`${config.clineApiBaseUrl}/api/v1/users/me`, {
      headers: headersFor(config, authorization, "admin-me"),
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
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
): Promise<number | null> {
  try {
    const response = await fetch(
      `${config.clineApiBaseUrl}/api/v1/users/${encodeURIComponent(uid)}/balance`,
      {
        headers: headersFor(config, authorization, "admin-balance"),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      },
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
    model: readString(item, "aiModelName"),
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
 * Usage records back to `since`, newest first.
 *
 * Upstream returns 200 items per page regardless of a larger `limit`, so this
 * walks the `cursor` until the window is covered. Bounded by USAGE_MAX_PAGES:
 * a busy account can otherwise page for a long time, and a slightly short
 * daily total is better than an admin page that never returns.
 */
export async function fetchUsagesSince(
  config: AppConfig,
  authorization: string,
  uid: string,
  since: number,
  logger: Logger,
): Promise<UsageRecord[]> {
  const collected: UsageRecord[] = [];
  let cursor: string | null = null;

  for (let page = 0; page < USAGE_MAX_PAGES; page += 1) {
    const url = new URL(
      `${config.clineApiBaseUrl}/api/v1/users/${encodeURIComponent(uid)}/usages`,
    );
    url.searchParams.set("limit", String(USAGE_PAGE_LIMIT));
    if (cursor !== null) url.searchParams.set("cursor", cursor);

    let payload: { data?: unknown };
    try {
      const response = await fetch(url, {
        headers: headersFor(config, authorization, "admin-usages"),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
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
    totals.costMicroUsd += record.costMicroUsd;
    totals.creditsUsed += record.creditsUsed;
  }
  return totals;
}

/**
 * Everything the admin UI shows for one account: balance, today's totals and
 * the most recent request. `authorization` must already be resolved by the
 * caller, so a dead credential surfaces as an error here rather than a
 * confusing empty row.
 */
export async function fetchAccountCredits(
  config: AppConfig,
  authorization: string,
  logger: Logger,
  options: { now?: number } = {},
): Promise<AccountCredits> {
  const uid = await fetchUserId(config, authorization, logger);
  if (uid === null) {
    return {
      uid: null,
      balanceMicroUsd: null,
      balanceUsd: null,
      balanceCredits: null,
      today: emptyTotals(),
      lastUsage: null,
      error: "user lookup failed",
    };
  }

  const since = startOfLocalDay(options.now ?? Date.now());
  const [balanceMicroUsd, usages] = await Promise.all([
    fetchBalance(config, authorization, uid, logger),
    fetchUsagesSince(config, authorization, uid, since, logger),
  ]);

  return {
    uid,
    balanceMicroUsd,
    balanceUsd: balanceMicroUsd === null ? null : balanceMicroUsd / MICRO_USD,
    balanceCredits:
      balanceMicroUsd === null ? null : balanceMicroUsd / MICRO_USD_PER_CREDIT,
    today: sumUsage(usages),
    lastUsage: usages[0] ?? null,
    error: null,
  };
}
