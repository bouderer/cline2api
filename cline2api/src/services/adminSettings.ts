/**
 * Settings the console's own admin can change: the password, and the token the
 * registrar and scripts authenticate with.
 *
 * Both live outside the process on purpose. The password is grok-iq's single
 * admin row, so changing it here changes the grok-iq login too — there is one
 * password, not two. The token is `ADMIN_TOKEN` in the gateway's `.env`, which
 * is what the container was started from, so a change survives a restart
 * instead of drifting away from the file the next boot reads.
 */
import { randomBytes, pbkdf2Sync } from "node:crypto";
import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";

const PBKDF2_DIGEST = "sha256";
const PBKDF2_KEY_BYTES = 32;
/** grok-iq hashes with this many iterations; a reset keeps that cost. */
const PBKDF2_ITERATIONS = 310_000;
const ADMIN_USER_ID = 1;

export class AdminSettingsError extends Error {}

export interface AdminSettingsOptions {
  /** grok-iq's SQLite database, opened read-write for the password change. */
  readonly grokIqDbPath?: string | null;
  /** The gateway `.env` whose `ADMIN_TOKEN` line is rewritten. */
  readonly envFilePath?: string | null;
  /** Apply a new token to the running process, so it takes effect immediately. */
  readonly applyToken?: (token: string) => void;
}

export interface TokenStatus {
  /** Whether a token is configured at all. */
  readonly configured: boolean;
  /** A non-secret preview, so the page can show which token is active. */
  readonly preview: string | null;
}

export class AdminSettings {
  constructor(private readonly options: AdminSettingsOptions = {}) {}

  tokenStatus(token: string | null): TokenStatus {
    if (!token) return { configured: false, preview: null };
    const preview = token.length <= 8 ? "••••" : `${token.slice(0, 4)}…${token.slice(-4)}`;
    return { configured: true, preview };
  }

  /**
   * Replace grok-iq's admin password.
   *
   * The current password is checked first, so a stolen session alone cannot
   * lock the owner out. The hash is written in grok-iq's own format, which
   * means grok-iq's login accepts it with no further step.
   */
  changePassword(username: string, currentPassword: string, nextPassword: string, verify: (username: string, password: string) => boolean): void {
    const dbPath = this.options.grokIqDbPath;
    if (!dbPath) throw new AdminSettingsError("未配置 grok-iq 数据库，无法修改密码");
    if (!verify(username, currentPassword)) throw new AdminSettingsError("当前密码不正确");
    if (nextPassword.length < 8) throw new AdminSettingsError("新密码至少需要 8 位");
    if (nextPassword.length > 256) throw new AdminSettingsError("新密码最多 256 位");

    const salt = randomBytes(16);
    const hash = pbkdf2Sync(nextPassword, salt, PBKDF2_ITERATIONS, PBKDF2_KEY_BYTES, PBKDF2_DIGEST).toString("hex");
    let db: DatabaseSync | null = null;
    try {
      db = new DatabaseSync(dbPath, { timeout: 3000 });
      const result = db
        .prepare(
          `UPDATE admin_users
           SET password_salt = ?, password_hash = ?, password_iterations = ?, updated_at = CURRENT_TIMESTAMP
           WHERE id = ? AND username = ?`,
        )
        .run(salt.toString("base64url"), hash, PBKDF2_ITERATIONS, ADMIN_USER_ID, username);
      if (Number(result.changes) !== 1) throw new AdminSettingsError("没有找到要修改的管理员账号");
    } catch (error) {
      if (error instanceof AdminSettingsError) throw error;
      throw new AdminSettingsError(`写入 grok-iq 数据库失败：${(error as Error).message}`);
    } finally {
      db?.close();
    }
  }

  /**
   * Set a new `ADMIN_TOKEN`.
   *
   * Rewrites the `.env` line in place and then tells the caller to apply it,
   * so the registrar's next push and the running process agree. An empty
   * token is refused: clearing it would fall the admin API back to the
   * loopback-only bypass, which is not what a settings form should do.
   */
  setToken(token: string): TokenStatus {
    const next = token.trim();
    if (next.length < 16) throw new AdminSettingsError("Admin Token 至少需要 16 位");
    if (/\s/.test(next)) throw new AdminSettingsError("Admin Token 不能包含空白字符");
    const file = this.options.envFilePath;
    if (!file) throw new AdminSettingsError("未配置 .env 路径，无法保存 Admin Token");
    rewriteEnvLine(file, "ADMIN_TOKEN", next);
    this.options.applyToken?.(next);
    return this.tokenStatus(next);
  }
}

/**
 * Replace one `KEY=value` line, preserving every other line and comment.
 *
 * The value is written bare, so it must not need quoting. A missing key is
 * appended rather than dropped, and the write is atomic so a crash mid-save
 * cannot truncate the file.
 */
export function rewriteEnvLine(file: string, key: string, value: string): void {
  const original = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const lines = original.length > 0 ? original.split("\n") : [];
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let replaced = false;
  const next = lines.map((line) => {
    if (replaced || !pattern.test(line)) return line;
    replaced = true;
    return `${key}=${value}`;
  });
  if (!replaced) next.push(`${key}=${value}`);
  const body = next.join("\n");
  const out = body.endsWith("\n") ? body : `${body}\n`;
  // A bind-mounted single file cannot be replaced by rename — Docker holds the
  // inode, so the rename fails with EBUSY. Write the temp file first (so a crash
  // still cannot leave a truncated original), then fall back to writing the
  // content in place when the target turns out to be a mount point.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, out, { mode: 0o600 });
  try {
    fs.renameSync(tmp, file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EBUSY") {
      fs.writeFileSync(file, out, { mode: 0o600 });
      fs.rmSync(tmp, { force: true });
      return;
    }
    fs.rmSync(tmp, { force: true });
    throw error;
  }
}
