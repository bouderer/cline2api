/**
 * Client API keys: CRUD, rotation, and last-use accounting.
 *
 * Every client request authenticates with one of these keys. The keys live in
 * a 0600 `apikeys.json` file next to `accounts.json` and `proxies.json`, using
 * the same atomic temp-file + fsync + rename persist pattern.
 *
 * Three rules shape this module:
 *
 *  - Only hashes are looked up at request time. The plaintext is shown exactly
 *    once, at creation, and never stored. `prefix` (first 8 chars) exists only
 *    so rows can be told apart; finding a key still requires trying every
 *    stored hash, which is how the Postgres `crypt()` comparison reads. With
 *    a small table this is deliberately a plain scan rather than an index.
 *  - Importing `PROXY_API_KEY` does not create a delete loop later. Each
 *    configured key is tagged with its source, so the legacy file line only
 *    shadows deletion while the env key is still set — and the admin API
 *    refuses to delete a key that would come straight back.
 *  - Disabling takes effect immediately: there is no key lookup cache to
 *    invalidate, so the row the request path reads is always the current one.
 *    The manager closes over `onMutation` to log creations/rotations/deletions
 *    in the same line the rest of the admin surface uses.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface StoredApiKey {
  id: string;
  label: string | null;
  keyHash: string;
  /** First characters of the plaintext — enough to tell rows apart, nothing more. */
  prefix: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
  lastUsedAt: number | null;
  lastUsedModel: string | null;
  useCount: number;
  /**
   * Where this row came from. `env` rows are seeded from PROXY_API_KEY and
   * disappear when the env var is removed; they cannot be renamed either,
   * because the name is the env var's position, not something to edit.
   */
  source: "env" | "managed";
}

interface ApiKeyFile {
  version: 1;
  keys: StoredApiKey[];
}

const HASH_PREFIX = "sha256:";
const PREFIX_CHARS = 8;

export function hashApiKey(plaintext: string): string {
  return HASH_PREFIX + createHash("sha256").update(plaintext, "utf8").digest("hex");
}

export function mintApiKey(): string {
  return `sk-cline-${randomBytes(24).toString("hex")}`;
}

export type ApiKeyEvent =
  | { type: "created"; id: string; label: string | null }
  | { type: "rotated"; id: string }
  | { type: "deleted"; id: string }
  | { type: "toggled"; id: string; enabled: boolean }
  | { type: "imported"; count: number };

export interface ApiKeyManagerDeps {
  dataDir: string;
  logger: Logger;
  /** Seed keys from the environment, in order. Migration only — see `syncFromEnv`. */
  envKeys?: readonly string[];
  onEvent?: (event: ApiKeyEvent) => void;
}

export class ApiKeyManager {
  private readonly file: string;
  private readonly logger: Logger;
  private keys: StoredApiKey[] = [];
  private mtimeMs = 0;
  private readonly onEvent?: (event: ApiKeyEvent) => void;

  constructor(deps: ApiKeyManagerDeps) {
    this.file = path.join(deps.dataDir, "apikeys.json");
    this.logger = deps.logger;
    this.onEvent = deps.onEvent;
    this.load();
    if (deps.envKeys && deps.envKeys.length > 0) {
      this.syncFromEnv(deps.envKeys);
    }
  }

  get filePath(): string {
    return this.file;
  }

  private load(): void {
    if (!fs.existsSync(this.file)) {
      this.keys = [];
      this.mtimeMs = 0;
      return;
    }
    try {
      const raw = fs.readFileSync(this.file, "utf8");
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
      const parsed = JSON.parse(raw) as Partial<ApiKeyFile>;
      const list = Array.isArray(parsed.keys) ? parsed.keys : [];
      this.keys = list.filter(
        (item): item is StoredApiKey =>
          typeof item?.id === "string" && typeof item?.keyHash === "string",
      );
    } catch (error) {
      this.logger.warn(`failed to read API key store: ${(error as Error).message}`);
      this.keys = [];
    }
  }

  private reloadIfChanged(): void {
    try {
      if (!fs.existsSync(this.file)) {
        if (this.mtimeMs !== 0 || this.keys.length > 0) {
          this.keys = [];
          this.mtimeMs = 0;
        }
        return;
      }
      const mtimeMs = fs.statSync(this.file).mtimeMs;
      if (mtimeMs === this.mtimeMs) return;
      this.load();
    } catch (error) {
      this.logger.warn(`failed to reload API key store: ${(error as Error).message}`);
    }
  }

  private persist(): void {
    const dir = path.dirname(this.file);
    fs.mkdirSync(dir, { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    // 0600: hashes are not plaintext, but the file also signals its own
    // sensitivity — a 0644 apikeys.json would invite careless copies.
    const fd = fs.openSync(tmp, "w", 0o600);
    try {
      fs.writeFileSync(fd, `${JSON.stringify({ version: 1, keys: this.keys }, null, 2)}\n`, "utf8");
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, this.file);
    try {
      this.mtimeMs = fs.statSync(this.file).mtimeMs;
    } catch {
      this.mtimeMs = Date.now();
    }
  }

  /** Public rows, without hashes. */
  list(): Array<Omit<StoredApiKey, "keyHash">> {
    this.reloadIfChanged();
    return this.keys.map(({ keyHash: _hash, ...rest }) => ({ ...rest }));
  }

  get(id: string): Omit<StoredApiKey, "keyHash"> | undefined {
    this.reloadIfChanged();
    const found = this.keys.find((key) => key.id === id);
    if (!found) return undefined;
    const { keyHash: _hash, ...rest } = found;
    return { ...rest };
  }

  /**
   * Find a key by its plaintext. Updates last-use stats as a side effect —
   * the lookup is the only point where id, model and time are all known, so
   * splitting it into "check" + "record" would double the scans and risk
   * forgetting the second half.
   *
   * Returns the stored row (with hash) on match, null otherwise.
   */
  verify(plaintext: string, model?: string): StoredApiKey | null {
    this.reloadIfChanged();
    const hash = hashApiKey(plaintext);
    const found = this.keys.find((key) => key.enabled && key.keyHash === hash);
    if (!found) return null;
    found.useCount += 1;
    found.lastUsedAt = Date.now();
    if (model) found.lastUsedModel = model;
    this.persist();
    return { ...found };
  }

  /** Read-only check without touching last-use. Used by tests and the playground. */
  matches(plaintext: string): StoredApiKey | null {
    this.reloadIfChanged();
    const hash = hashApiKey(plaintext);
    const found = this.keys.find((key) => key.enabled && key.keyHash === hash);
    return found ? { ...found } : null;
  }

  count(): number {
    this.reloadIfChanged();
    return this.keys.length;
  }

  countEnabled(): number {
    this.reloadIfChanged();
    return this.keys.filter((key) => key.enabled).length;
  }

  create(label?: string | null): { record: Omit<StoredApiKey, "keyHash">; plaintext: string } {
    this.reloadIfChanged();
    const plaintext = mintApiKey();
    const now = Date.now();
    const record: StoredApiKey = {
      id: randomUUID(),
      label: label ?? null,
      keyHash: hashApiKey(plaintext),
      prefix: plaintext.slice(0, PREFIX_CHARS),
      enabled: true,
      createdAt: now,
      updatedAt: now,
      lastUsedAt: null,
      lastUsedModel: null,
      useCount: 0,
      source: "managed",
    };
    this.keys = [...this.keys, record];
    this.persist();
    this.onEvent?.({ type: "created", id: record.id, label: record.label });
    const { keyHash: _hash, ...rest } = record;
    return { record: { ...rest }, plaintext };
  }

  rotate(id: string): { record: Omit<StoredApiKey, "keyHash">; plaintext: string } | null {
    this.reloadIfChanged();
    const existing = this.keys.find((key) => key.id === id);
    if (!existing) return null;
    const plaintext = mintApiKey();
    existing.keyHash = hashApiKey(plaintext);
    existing.prefix = plaintext.slice(0, PREFIX_CHARS);
    existing.updatedAt = Date.now();
    // A rotated key starts with a clean usage record: the old counters belong
    // to the old secret, and keeping them would imply the new one was used.
    existing.lastUsedAt = null;
    existing.lastUsedModel = null;
    existing.useCount = 0;
    this.persist();
    this.onEvent?.({ type: "rotated", id });
    const { keyHash: _hash, ...rest } = existing;
    return { record: { ...rest }, plaintext };
  }

  /**
   * Toggle a key. Refuses to disable the last enabled key rather than
   * locking every client out — including the operator who just clicked the
   * button.
   */
  setEnabled(id: string, enabled: boolean): Omit<StoredApiKey, "keyHash"> | { error: string } | null {
    this.reloadIfChanged();
    const existing = this.keys.find((key) => key.id === id);
    if (!existing) return null;
    if (!enabled && existing.enabled && this.keys.filter((key) => key.enabled).length <= 1) {
      return { error: "cannot disable the last enabled key" };
    }
    existing.enabled = enabled;
    existing.updatedAt = Date.now();
    this.persist();
    this.onEvent?.({ type: "toggled", id, enabled });
    const { keyHash: _hash, ...rest } = existing;
    return { ...rest };
  }

  remove(id: string): boolean | { error: string } {
    this.reloadIfChanged();
    const existing = this.keys.find((key) => key.id === id);
    if (!existing) return false;
    if (existing.source === "env") {
      return { error: "this key comes from PROXY_API_KEY and cannot be deleted here — unset it in the environment first" };
    }
    this.keys = this.keys.filter((key) => key.id !== id);
    this.persist();
    this.onEvent?.({ type: "deleted", id });
    return true;
  }

  /**
   * One-way import of the legacy `PROXY_API_KEY` env values.
   *
   * Each configured plaintext becomes (or already is) an `env` row, matched by
   * hash so re-imports on restart are idempotent. Rows whose hash no longer
   * matches any configured value are dropped — that is how removing an env key
   * takes effect without a manual step. Managed rows are never touched.
   *
   * Refuses to leave the store with zero enabled keys: if the env list is
   * empty and no managed enabled key exists, the last env row is kept and the
   * caller is told why, so removing PROXY_API_KEY cannot lock out the gateway.
   */
  syncFromEnv(configured: readonly string[]): { imported: number; dropped: number; held: boolean } {
    this.reloadIfChanged();
    const hashes = new Set(configured.map(hashApiKey));
    let imported = 0;
    let dropped = 0;
    const kept: StoredApiKey[] = [];

    for (const key of this.keys) {
      if (key.source === "managed") {
        kept.push(key);
        continue;
      }
      if (hashes.has(key.keyHash)) {
        kept.push(key);
      } else {
        dropped += 1;
      }
    }

    let index = 0;
    for (const plaintext of configured) {
      index += 1;
      const hash = hashApiKey(plaintext);
      if (kept.some((key) => key.keyHash === hash)) continue;
      const now = Date.now();
      kept.push({
        id: randomUUID(),
        label: `env #${index}`,
        keyHash: hash,
        prefix: plaintext.slice(0, PREFIX_CHARS),
        enabled: true,
        createdAt: now,
        updatedAt: now,
        lastUsedAt: null,
        lastUsedModel: null,
        useCount: 0,
        source: "env",
      });
      imported += 1;
    }

    // Never strand the gateway with nothing to authenticate: hold one row.
    let held = false;
    if (!kept.some((key) => key.enabled)) {
      const lastEnv = [...this.keys].reverse().find((key) => key.source === "env");
      if (lastEnv) {
        kept.push(lastEnv);
        held = true;
      }
    }

    if (imported > 0 || dropped > 0) {
      this.keys = kept;
      this.persist();
      if (imported > 0) this.onEvent?.({ type: "imported", count: imported });
    } else if (this.keys.length !== kept.length) {
      this.keys = kept;
      this.persist();
    }
    return { imported, dropped, held };
  }
}
