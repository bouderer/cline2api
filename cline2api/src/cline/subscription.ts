/**
 * Subscription / plan lookup.
 *
 * `GET /api/v1/users/me/plan` is the endpoint Cline's own UI reads to decide
 * whether to show the "Cline Pass" badge, and it is what tells us which model
 * ids the account may call without spending Cline Credits. Verified live:
 *
 *   { data: { planHistoryId, userId, plan: { displayName, interval, isActive,
 *     entitlements: { cline_pass: { enabled: true } } }, subscriptionId,
 *     currentPeriodStart, currentPeriodEnd }, success: true }
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import { defaultClineHeaders } from "./constants.js";

export interface SubscriptionInfo {
  displayName: string | null;
  interval: string | null;
  isActive: boolean;
  clinePassEnabled: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  error: string | null;
}

function readString(source: Record<string, unknown>, key: string): string | null {
  const value = source[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export async function fetchSubscription(
  config: AppConfig,
  authorization: string,
  logger: Logger,
): Promise<SubscriptionInfo> {
  const empty: SubscriptionInfo = {
    displayName: null,
    interval: null,
    isActive: false,
    clinePassEnabled: false,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    error: null,
  };

  try {
    const response = await fetch(`${config.clineApiBaseUrl}/api/v1/users/me/plan`, {
      headers: {
        Authorization: authorization,
        Accept: "application/json",
        ...defaultClineHeaders({
          clientName: config.clientName,
          clientVersion: config.clientVersion,
          platform: config.platform,
          platformVersion: config.platformVersion,
          coreVersion: config.coreVersion,
          taskId: "admin-plan",
        }),
      },
      signal: AbortSignal.timeout(config.requestTimeoutMs),
    });
    if (!response.ok) {
      return { ...empty, error: `HTTP ${response.status}` };
    }
    const payload = (await response.json()) as { data?: unknown };
    const data =
      typeof payload.data === "object" && payload.data !== null
        ? (payload.data as Record<string, unknown>)
        : {};
    const plan =
      typeof data.plan === "object" && data.plan !== null
        ? (data.plan as Record<string, unknown>)
        : {};
    const entitlements =
      typeof plan.entitlements === "object" && plan.entitlements !== null
        ? (plan.entitlements as Record<string, unknown>)
        : {};
    const pass =
      typeof entitlements.cline_pass === "object" && entitlements.cline_pass !== null
        ? (entitlements.cline_pass as Record<string, unknown>)
        : {};

    return {
      displayName: readString(plan, "displayName") ?? readString(plan, "name"),
      interval: readString(plan, "interval"),
      isActive: plan.isActive === true,
      clinePassEnabled: pass.enabled === true,
      currentPeriodStart: readString(data, "currentPeriodStart"),
      currentPeriodEnd: readString(data, "currentPeriodEnd"),
      error: null,
    };
  } catch (error) {
    logger.warn("plan lookup failed", { error: (error as Error).message });
    return { ...empty, error: (error as Error).message };
  }
}
