/**
 * Subscription usage windows.
 *
 * `GET /api/v1/users/me/plan/usage-limits` is the endpoint Cline's own web app
 * reads to render the "5 hour / weekly / monthly" gauges. Verified live:
 *
 *   { data: { limits: [ { type: "five_hour", percentUsed: 0,
 *                         resetsAt: "2026-09-17T14:18:02.77756325Z" }, ... ] },
 *     success: true }
 *
 * The `inferenceCapThreshold` numbers on `/users/me/plan` are the raw USD caps
 * (the internal plan reports 1e9, i.e. effectively uncapped), so the percentage
 * from this endpoint is what actually matters for display.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { defaultClineHeaders } from "./constants.js";

export type UsageWindowType = "five_hour" | "weekly" | "monthly" | string;

export interface UsageWindow {
  type: UsageWindowType;
  /** 0-100. Upstream reports a number; anything else is clamped when read. */
  percentUsed: number;
  resetsAt: string | null;
}

export interface UsageLimitsResult {
  limits: UsageWindow[];
  error: string | null;
}

export async function fetchUsageLimits(
  config: AppConfig,
  authorization: string,
  logger: Logger,
): Promise<UsageLimitsResult> {
  try {
    const response = await fetch(`${config.clineApiBaseUrl}/api/v1/users/me/plan/usage-limits`, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...defaultClineHeaders({
          clientName: config.clientName,
          clientVersion: config.clientVersion,
          platform: config.platform,
          platformVersion: config.platformVersion,
          coreVersion: config.coreVersion,
          taskId: "admin-usage",
        }),
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) return { limits: [], error: `HTTP ${response.status}` };

    const payload = (await response.json()) as { data?: { limits?: unknown } };
    const raw = payload.data?.limits;
    if (!Array.isArray(raw)) return { limits: [], error: null };

    const limits: UsageWindow[] = raw
      .filter(
        (item): item is Record<string, unknown> => typeof item === "object" && item !== null,
      )
      .map((item) => ({
        type: typeof item.type === "string" ? item.type : "unknown",
        percentUsed:
          typeof item.percentUsed === "number" && Number.isFinite(item.percentUsed)
            ? Math.max(0, Math.min(100, item.percentUsed))
            : 0,
        resetsAt: typeof item.resetsAt === "string" ? item.resetsAt : null,
      }));
    return { limits, error: null };
  } catch (error) {
    logger.warn("usage limits lookup failed", { error: (error as Error).message });
    return { limits: [], error: (error as Error).message };
  }
}
