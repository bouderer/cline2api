/**
 * Account store. Credentials live in a single JSON file written atomically
 * (temp file + fsync + rename) with 0600 permissions, so a crash or a
 * concurrent read can never observe a half-written file.
 *
 * The registrar writes this file from outside the Node process. Reads reload
 * when the mtime changes so cline2api picks up a newly logged-in account
 * without a restart.
 */
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ClineCredentials, StoredAccount } from "./cline/types.js";
import type { Logger } from "./logger.js";

interface StoreFile {
  version: 1;
  accounts: StoredAccount[];
}

export class AccountStore {
  private readonly file: string;
  private accounts: StoredAccount[] = [];
  private mtimeMs = 0;

  constructor(
    dataDir: string,
    private readonly logger: Logger,
  ) {
    this.file = path.join(dataDir, "accounts.json");
    this.load();
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    if (!fs.existsSync(this.file)) {
      this.accounts = [];
      this.mtimeMs = 0;
      return;
    }
    const raw = fs.readFileSync(this.file, "utf8");
    this.mtimeMs = fs.statSync(this.file).mtimeMs;
    const parsed = JSON.parse(raw) as Partial<StoreFile>;
    const list = Array.isArray(parsed.accounts) ? parsed.accounts : [];
    this.accounts = list.filter(
      (item): item is StoredAccount =>
        typeof item?.id === "string" &&
        typeof item?.access === "string" &&
        typeof item?.refresh === "string",
    );
    this.logger.info(`loaded ${this.accounts.length} account(s) from store`);
  }

  private reloadIfChanged(): void {
    try {
      if (!fs.existsSync(this.file)) {
        if (this.mtimeMs !== 0 || this.accounts.length > 0) {
          this.accounts = [];
          this.mtimeMs = 0;
          this.logger.info("account store file removed; unloaded accounts");
        }
        return;
      }
      const mtimeMs = fs.statSync(this.file).mtimeMs;
      if (mtimeMs === this.mtimeMs) return;
      this.load();
    } catch (error) {
      this.logger.warn(`failed to reload account store: ${(error as Error).message}`);
    }
  }

  private persist(): void {
    const payload: StoreFile = { version: 1, accounts: this.accounts };
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      const dirFd = fs.openSync(dir, "r");
      try {
        fs.fsyncSync(dirFd);
      } finally {
        fs.closeSync(dirFd);
      }
    } catch {
      // Directory fsync is not available on every platform; the rename is
      // still atomic, so this is best-effort only.
    }
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = Date.now();
    }
  }

  list(): StoredAccount[] {
    this.reloadIfChanged();
    return this.accounts.map((account) => ({ ...account }));
  }

  listActive(): StoredAccount[] {
    this.reloadIfChanged();
    return this.accounts
      .filter((account) => !account.disabled)
      .map((account) => ({ ...account }));
  }

  get(id: string): StoredAccount | undefined {
    this.reloadIfChanged();
    const found = this.accounts.find((account) => account.id === id);
    return found ? { ...found } : undefined;
  }

  count(): number {
    this.reloadIfChanged();
    return this.accounts.length;
  }

  /** Insert or update by accountId, falling back to email, else insert new. */
  saveCredentials(
    credentials: ClineCredentials,
    options: { label?: string | null; provider?: string } = {},
  ): StoredAccount {
    this.reloadIfChanged();
    const now = Date.now();
    const existing = this.findExisting(credentials);
    const record: StoredAccount = {
      id: existing?.id ?? randomUUID(),
      label: options.label ?? existing?.label ?? null,
      email: credentials.email ?? existing?.email ?? null,
      accountId: credentials.accountId ?? existing?.accountId ?? null,
      access: credentials.access,
      refresh: credentials.refresh,
      expires: credentials.expires,
      tokenType:
        credentials.metadata?.tokenType ?? existing?.tokenType ?? "Bearer",
      provider: options.provider ?? credentials.metadata?.provider ?? existing?.provider ?? "cline",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      disabled: false,
      lastError: null,
    };
    if (existing) {
      this.accounts = this.accounts.map((account) =>
        account.id === record.id ? record : account,
      );
    } else {
      this.accounts = [...this.accounts, record];
    }
    this.persist();
    return { ...record };
  }

  private findExisting(credentials: ClineCredentials): StoredAccount | undefined {
    if (credentials.accountId) {
      const byAccount = this.accounts.find(
        (account) => account.accountId === credentials.accountId,
      );
      if (byAccount) return byAccount;
    }
    if (credentials.email) {
      return this.accounts.find((account) => account.email === credentials.email);
    }
    return undefined;
  }

  update(id: string, patch: Partial<StoredAccount>): StoredAccount | undefined {
    this.reloadIfChanged();
    const existing = this.accounts.find((account) => account.id === id);
    if (!existing) return undefined;
    const next: StoredAccount = { ...existing, ...patch, id: existing.id, updatedAt: Date.now() };
    this.accounts = this.accounts.map((account) => (account.id === id ? next : account));
    this.persist();
    return { ...next };
  }

  remove(id: string): boolean {
    this.reloadIfChanged();
    const before = this.accounts.length;
    this.accounts = this.accounts.filter((account) => account.id !== id);
    if (this.accounts.length === before) return false;
    this.persist();
    return true;
  }
}