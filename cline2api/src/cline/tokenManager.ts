/**
 * Per-account token manager.
 *
 * Two responsibilities:
 *  1. single-flight refresh — when N concurrent requests hit an account whose
 *     token is expiring, exactly one WorkOS refresh is performed and the rest
 *     await the same promise. WorkOS rotates refresh tokens, so racing
 *     refreshes would invalidate each other and log the user out.
 *  2. persist rotated tokens immediately, so a restart never loses them.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import { formatAccessToken, getValidClineCredentials } from "./auth.js";
import { defaultClineHeaders } from "./constants.js";
import type { ProxyResolver } from "./proxy.js";
import type { ClineCredentials } from "./types.js";

export class TokenManager {
  private readonly inflight = new Map<string, Promise<string | null>>();

  constructor(
    private readonly store: AccountStore,
    private readonly config: AppConfig,
    private readonly logger: Logger,
    /** Optional: refresh through the account's assigned proxy. */
    private readonly proxies?: ProxyResolver,
  ) {}

  /** Returns a ready-to-send `Authorization` header, or null if re-login is needed. */
  getAuthorization(accountId: string, options: { forceRefresh?: boolean } = {}): Promise<string | null> {
    const pending = this.inflight.get(accountId);
    if (pending) return pending;
    const promise = this.resolve(accountId, options.forceRefresh === true).finally(() => {
      this.inflight.delete(accountId);
    });
    this.inflight.set(accountId, promise);
    return promise;
  }

  private authOptions(accountId: string): Parameters<typeof getValidClineCredentials>[1] {
    const dispatcher = this.proxies?.forAccount(accountId);
    return {
      clineApiBaseUrl: this.config.clineApiBaseUrl,
      workosApiBaseUrl: this.config.workosApiBaseUrl,
      clientId: this.config.workOsClientId,
      requestTimeoutMs: this.config.requestTimeoutMs,
      headers: defaultClineHeaders({
        clientName: this.config.clientName,
        clientVersion: this.config.clientVersion,
        platform: this.config.platform,
        platformVersion: this.config.platformVersion,
        coreVersion: this.config.coreVersion,
        taskId: "auth",
      }),
      provider: "cline",
      ...(dispatcher ? { dispatcher } : {}),
    };
  }

  private async resolve(accountId: string, forceRefresh: boolean): Promise<string | null> {
    const record = this.store.get(accountId);
    if (!record) return null;
    if (record.disabled && !forceRefresh) return null;

    const current: ClineCredentials = {
      access: record.access,
      refresh: record.refresh,
      expires: record.expires,
      ...(record.accountId ? { accountId: record.accountId } : {}),
      ...(record.email ? { email: record.email } : {}),
      metadata: { provider: record.provider, tokenType: record.tokenType },
    };

    const resolved = await getValidClineCredentials(current, this.authOptions(accountId), {
      forceRefresh,
      refreshBufferMs: this.config.refreshBufferMs,
      retryableTokenGraceMs: this.config.retryableTokenGraceMs,
    });

    if (resolved === null) {
      this.logger.warn("refresh token rejected; account needs a new login", {
        accountId,
        email: record.email,
      });
      this.store.update(accountId, {
        disabled: true,
        lastError: "invalid_grant: re-login required",
      });
      return null;
    }

    const rotated = resolved.refresh !== record.refresh || resolved.access !== record.access;
    if (rotated) {
      // Update in place by id. `saveCredentials` matches on accountId/email and
      // would insert a duplicate for accounts that carry neither.
      //
      // `disabled` is an operator choice, not a token-health flag, so a
      // successful rotation must not re-enable an account the operator turned
      // off. Only a prior refresh failure (`lastError`) is cleared here.
      this.store.update(accountId, {
        access: resolved.access,
        refresh: resolved.refresh,
        expires: resolved.expires,
        tokenType: resolved.metadata?.tokenType ?? record.tokenType,
        ...(resolved.accountId ? { accountId: resolved.accountId } : {}),
        ...(resolved.email ? { email: resolved.email } : {}),
        lastError: null,
      });
      this.logger.debug("persisted rotated credentials", {
        accountId,
        expiresAt: new Date(resolved.expires).toISOString(),
      });
    }
    return `Bearer ${formatAccessToken(resolved.access)}`;
  }
}

