/**
 * Login-based admin authentication.
 *
 * The console used to gate on `ADMIN_TOKEN`, carried in the URL as `?token=`
 * and then in localStorage. That token dies the moment the page is opened
 * without it — a refresh on a bookmarked path, or a link opened in a new tab —
 * so the console asked for it again on every visit.
 *
 * The replacement is a username and password, the same ones grok-iq's admin
 * uses. grok-iq stores exactly one admin as a PBKDF2-SHA256 hash, so this
 * module verifies against that record rather than keeping a second password.
 * A successful login mints a random session token kept only in memory and set
 * as an HttpOnly cookie, which the browser sends back on every path and tab.
 *
 * `ADMIN_TOKEN` stays valid as a Bearer credential so the registrar and scripts
 * keep working; it is simply no longer something a person has to paste.
 */
import { pbkdf2Sync, randomBytes, timingSafeEqual } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

const PBKDF2_DIGEST = "sha256";
const PBKDF2_KEY_BYTES = 32;
/** grok-iq's admin table is constrained to a single row with this id. */
const ADMIN_USER_ID = 1;

export interface AdminCredential {
  readonly username: string;
  readonly passwordSalt: string;
  readonly passwordHash: string;
  readonly passwordIterations: number;
}

export interface AdminAuthOptions {
  /** Where to read the credential from. Defaults to nothing, i.e. no login. */
  readonly loadCredential?: () => AdminCredential | null;
  readonly now?: () => number;
  /** How long a console session stays valid. Defaults to 30 days. */
  readonly sessionTtlMs?: number;
}

const DEFAULT_SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface Session {
  username: string;
  expiresAt: number;
}

/**
 * Read grok-iq's single admin row.
 *
 * The file is opened read-only and closed immediately: grok-iq is the only
 * writer, and a login check must not take a lock on its database. A missing
 * file, a missing table, or a row that does not look like a PBKDF2 record all
 * read as "no credential", which the caller turns into "login unavailable".
 */
export function readGrokIqAdmin(dbPath: string): AdminCredential | null {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true, timeout: 3000 });
    const row = db
      .prepare(
        `SELECT username, password_salt AS passwordSalt, password_hash AS passwordHash,
                password_iterations AS passwordIterations
         FROM admin_users WHERE id = ?`,
      )
      .get(ADMIN_USER_ID) as
      | {
          username?: unknown;
          passwordSalt?: unknown;
          passwordHash?: unknown;
          passwordIterations?: unknown;
        }
      | undefined;
    if (!row) return null;
    const username = typeof row.username === "string" ? row.username.trim() : "";
    const passwordSalt = typeof row.passwordSalt === "string" ? row.passwordSalt.trim() : "";
    const passwordHash = typeof row.passwordHash === "string" ? row.passwordHash.trim() : "";
    const passwordIterations = Number(row.passwordIterations);
    if (!username || !passwordSalt || !/^[0-9a-f]+$/i.test(passwordHash)) return null;
    if (!Number.isInteger(passwordIterations) || passwordIterations < 1) return null;
    return { username, passwordSalt, passwordHash, passwordIterations };
  } catch {
    return null;
  } finally {
    db?.close();
  }
}

export class AdminAuth {
  private readonly loadCredential: () => AdminCredential | null;
  private readonly now: () => number;
  private readonly sessionTtlMs: number;
  private readonly sessions = new Map<string, Session>();

  constructor(options: AdminAuthOptions = {}) {
    this.loadCredential = options.loadCredential ?? (() => null);
    this.now = options.now ?? Date.now;
    this.sessionTtlMs = options.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  }

  /** Whether a password login can succeed at all right now. */
  available(): boolean {
    return this.loadCredential() !== null;
  }

  /**
   * Check a username and password against grok-iq's admin record.
   *
   * An unknown username still runs a full PBKDF2, so the response time does
   * not reveal whether the username exists. The comparison is constant time.
   */
  verify(username: string, password: string): boolean {
    const credential = this.loadCredential();
    const salt = credential ? decodeSalt(credential.passwordSalt) : null;
    const iterations = credential?.passwordIterations ?? 310_000;
    const actual = pbkdf2Sync(
      String(password ?? ""),
      salt ?? Buffer.alloc(16),
      iterations,
      PBKDF2_KEY_BYTES,
      PBKDF2_DIGEST,
    ).toString("hex");
    if (!credential || salt === null) return false;
    const named = credential.username === String(username ?? "").trim();
    const matches = hexEqual(actual, credential.passwordHash);
    return named && matches;
  }

  /** Mint a session for a username that has just been verified. */
  createSession(username: string): { token: string; maxAgeSeconds: number } {
    this.prune();
    const token = randomBytes(32).toString("base64url");
    this.sessions.set(token, { username, expiresAt: this.now() + this.sessionTtlMs });
    return { token, maxAgeSeconds: Math.floor(this.sessionTtlMs / 1000) };
  }

  /** The username behind a session token, or null when it is missing or stale. */
  authenticate(token: string | null | undefined): string | null {
    if (!token) return null;
    const session = this.sessions.get(token);
    if (!session) return null;
    if (session.expiresAt <= this.now()) {
      this.sessions.delete(token);
      return null;
    }
    return session.username;
  }

  revoke(token: string | null | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private prune(): void {
    const now = this.now();
    for (const [token, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(token);
    }
  }
}

function decodeSalt(encoded: string): Buffer | null {
  try {
    const salt = Buffer.from(encoded, "base64url");
    return salt.length > 0 ? salt : null;
  } catch {
    return null;
  }
}

function hexEqual(actual: string, expected: string): boolean {
  let expectedBytes: Buffer;
  try {
    expectedBytes = Buffer.from(expected, "hex");
  } catch {
    return false;
  }
  const actualBytes = Buffer.from(actual, "hex");
  if (actualBytes.length === 0 || actualBytes.length !== expectedBytes.length) return false;
  return timingSafeEqual(actualBytes, expectedBytes);
}

/** Read a named cookie out of a raw Cookie header. */
export function readCookie(header: string | null | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    if (part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value.length > 0 ? value : null;
  }
  return null;
}
