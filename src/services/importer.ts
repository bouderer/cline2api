/**
 * Account import.
 *
 * Lets the admin UI take a gateway account file (`{version, accounts:[…]}`,
 * the exact shape `AccountStore` writes) and merge it into the live store, so
 * accounts collected elsewhere do not have to be re-authenticated through the
 * device-login flow one at a time.
 *
 * Two deliberate choices:
 *
 *  - **Verify before saving.** Each incoming account is refreshed against
 *    WorkOS first. A file may be stale, truncated or hand-edited, and adopting
 *    its access token blindly would put an already-dead account into the pool
 *    where every request pays for the discovery. A refresh also *rotates* the
 *    token, so the credentials that end up stored are the fresh ones rather
 *    than whatever the file happened to carry.
 *
 *  - **Revive on success.** An account that a previous rejection left `disabled`
 *    is re-enabled when its credentials verify, because a verified refresh is
 *    stronger evidence than the stored failure that disabled it.
 *
 * Imports are all-or-nothing per account: one bad entry is reported in
 * `results` and skipped, never aborting the rest of the file.
 */
import type { AppConfig } from "../config.js";
import type { Logger } from "../logger.js";
import type { AccountStore } from "../store.js";
import { defaultClineHeaders } from "../cline/constants.js";
import { getValidClineCredentials } from "../cline/auth.js";
import type { ClineCredentials, StoredAccount } from "../cline/types.js";

/** One entry's outcome, as shown in the admin UI. */
export interface ImportResult {
  email: string | null;
  accountId: string | null;
  /** `added` for a new account, `updated` when it matched an existing one. */
  action: "added" | "updated";
  id: string;
}

export interface ImportFailure {
  /** Index in the incoming array, so a bad entry can be found in the file. */
  index: number;
  email: string | null;
  reason: string;
}

export interface ImportReport {
  /** Accounts written to the store. */
  imported: ImportResult[];
  /** Entries rejected before saving, with why. */
  failed: ImportFailure[];
}

/**
 * Coerce one parsed entry into `ClineCredentials`.
 *
 * Accepts the `StoredAccount` shape the store writes, and also a bare
 * `ClineCredentials` object, since a file holding a single account is often
 * written by hand. Field aliases cover the common OAuth spellings so an
 * exported file does not have to be reshaped by hand first.
 */
export function parseImportedAccount(raw: unknown): ClineCredentials | { error: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { error: "entry is not an object" };
  }
  const entry = raw as Record<string, unknown>;
  const str = (key: string): string | undefined => {
    const value = entry[key];
    return typeof value === "string" && value.length > 0 ? value : undefined;
  };

  const access = str("access") ?? str("access_token") ?? str("accessToken");
  const refresh = str("refresh") ?? str("refresh_token") ?? str("refreshToken");
  if (!access) return { error: "missing access token" };
  if (!refresh) return { error: "missing refresh token" };

  // Expiry is optional: a refresh below replaces it with the real value, so a
  // missing or unparseable one is only a hint, never a reason to reject.
  let expires = 0;
  const rawExpires = entry.expires ?? entry.expires_at ?? entry.expiresAt;
  if (typeof rawExpires === "number" && Number.isFinite(rawExpires)) {
    // Values below ~1e12 are seconds, not milliseconds.
    expires = rawExpires < 1e12 ? rawExpires * 1000 : rawExpires;
  } else if (typeof rawExpires === "string") {
    const parsed = Date.parse(rawExpires);
    expires = Number.isNaN(parsed) ? 0 : parsed;
  }

  const email = str("email") ?? null;
  const accountId = str("accountId") ?? str("account_id") ?? str("clineUserId") ?? null;

  return {
    access,
    refresh,
    expires,
    ...(email ? { email } : {}),
    ...(accountId ? { accountId } : {}),
    metadata: {
      ...(typeof entry.provider === "string" ? { provider: entry.provider } : {}),
      ...(typeof entry.tokenType === "string" ? { tokenType: entry.tokenType } : {}),
    },
  };
}

/** Pull the account array out of any of the accepted file shapes. */
export function parseImportFile(payload: unknown): unknown[] | { error: string } {
  if (Array.isArray(payload)) return payload;
  if (typeof payload !== "object" || payload === null) {
    return { error: "file must be a JSON object or array" };
  }
  const list = (payload as { accounts?: unknown }).accounts;
  if (Array.isArray(list)) return list;
  return { error: "file has no `accounts` array" };
}

export interface Importer {
  import(payload: unknown): Promise<ImportReport>;
}

export function createImporter(
  store: AccountStore,
  config: AppConfig,
  logger: Logger,
): Importer {
  const authOptions = () => ({
    clineApiBaseUrl: config.clineApiBaseUrl,
    workosApiBaseUrl: config.workosApiBaseUrl,
    clientId: config.workOsClientId,
    requestTimeoutMs: config.requestTimeoutMs,
    headers: defaultClineHeaders({
      clientName: config.clientName,
      clientVersion: config.clientVersion,
      platform: config.platform,
      platformVersion: config.platformVersion,
      coreVersion: config.coreVersion,
      taskId: "import",
    }),
    provider: "cline",
  });

  return {
    async import(payload: unknown): Promise<ImportReport> {
      const list = parseImportFile(payload);
      if (!Array.isArray(list)) throw new Error(list.error);

      const imported: ImportResult[] = [];
      const failed: ImportFailure[] = [];

      for (let index = 0; index < list.length; index += 1) {
        const parsed = parseImportedAccount(list[index]);
        if ("error" in parsed) {
          failed.push({ index, email: null, reason: parsed.error });
          continue;
        }

        // Verify (and rotate) before adopting. A dead refresh token fails
        // closed here rather than poisoning the pool for every later request.
        let resolved: ClineCredentials | null;
        try {
          resolved = await getValidClineCredentials(parsed, authOptions(), { forceRefresh: true });
        } catch (error) {
          failed.push({
            index,
            email: parsed.email ?? null,
            reason: `verification failed: ${(error as Error).message}`,
          });
          continue;
        }
        if (resolved === null) {
          failed.push({ index, email: parsed.email ?? null, reason: "refresh token rejected" });
          continue;
        }

        // `saveCredentials` matches on accountId then email, so an entry that
        // already exists is updated in place instead of duplicated.
        const before = store.count();
        const saved = store.saveCredentials(resolved, { provider: "cline" });
        imported.push({
          email: saved.email,
          accountId: saved.accountId,
          action: store.count() > before ? "added" : "updated",
          id: saved.id,
        });
        logger.info("imported account", {
          accountId: saved.id,
          email: saved.email,
          verified: true,
        });
      }

      return { imported, failed };
    },
  };
}

/** Re-exported for the admin UI's account listing. */
export type ImportedAccount = StoredAccount;
