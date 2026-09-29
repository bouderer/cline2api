/**
 * The gateway's own record of what passed through it.
 *
 * The quota charts used to be drawn from each account's upstream usage, which
 * meant fetching every account before the page could show anything. That is
 * unnecessary for traffic this gateway served: the response already reports
 * its own token counts, so they are written down here as they happen and the
 * charts read them back with no upstream call at all.
 *
 * What this cannot see is usage that never came through the gateway — another
 * client using the account directly, or the upstream balance and free-tier
 * ceiling. Those stay on the account sweep. This ledger is only "what we
 * served", and it only starts the moment it was switched on.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface UsageEntry {
  /** Epoch millis when the request was accepted. */
  at: number;
  model: string;
  accountId: string | null;
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  /**
   * Market cost of the request in USD, as reported by upstream
   * (`usage.market_cost`, falling back to `usage.cost`). Optional: older
   * ledger rows predate it, and a free model's market cost is still nonzero.
   */
  costUsd?: number;
}

export interface UsageLedgerOptions {
  dataDir: string;
  logger: Logger;
  /** How far back to keep. Defaults to 31 days, just past the widest chart. */
  retainMs?: number;
  /** How many entries to buffer before writing. Defaults to 25. */
  flushEvery?: number;
  /** Flush at least this often so a quiet period still reaches disk. */
  flushIntervalMs?: number;
  readonly now?: () => number;
}

const DEFAULT_RETAIN_MS = 31 * 24 * 60 * 60 * 1000;
const DEFAULT_FLUSH_EVERY = 25;
const DEFAULT_FLUSH_INTERVAL_MS = 5_000;

export class UsageLedger {
  private readonly file: string;
  private readonly retainMs: number;
  private readonly flushEvery: number;
  private readonly now: () => number;
  private entries: UsageEntry[] = [];
  private pending: UsageEntry[] = [];
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly options: UsageLedgerOptions) {
    this.file = path.join(options.dataDir, "usage.json");
    this.retainMs = options.retainMs ?? DEFAULT_RETAIN_MS;
    this.flushEvery = options.flushEvery ?? DEFAULT_FLUSH_EVERY;
    this.now = options.now ?? Date.now;
    this.entries = this.load();
    if (options.flushIntervalMs !== 0) {
      this.timer = setInterval(() => this.flush(), options.flushIntervalMs ?? DEFAULT_FLUSH_INTERVAL_MS);
      this.timer.unref?.();
    }
  }

  /** Remember one served request. Buffered, so this never blocks the response. */
  record(entry: UsageEntry): void {
    if (!entry.model || entry.totalTokens < 0) return;
    this.pending.push(entry);
    if (this.pending.length >= this.flushEvery) this.flush();
  }

  /** Entries inside a window, oldest first. */
  range(since: number, until: number): UsageEntry[] {
    this.flush();
    return this.entries.filter((entry) => entry.at >= since && entry.at <= until);
  }

  /** Write anything buffered and drop entries past the retention window. */
  flush(): void {
    if (this.pending.length === 0) return;
    const cutoff = this.now() - this.retainMs;
    // The buffer is pruned too: an entry can be older than the window by the
    // time it is written, and keeping it would make retention a suggestion.
    const fresh = this.pending.filter((entry) => entry.at >= cutoff);
    this.entries = this.entries.filter((entry) => entry.at >= cutoff).concat(fresh);
    this.pending = [];
    this.write();
  }

  /** Stop the flush timer and write what is left. */
  close(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.flush();
  }

  private load(): UsageEntry[] {
    try {
      if (!fs.existsSync(this.file)) return [];
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8")) as { entries?: unknown };
      if (!Array.isArray(raw.entries)) return [];
      return raw.entries.filter(isUsageEntry);
    } catch (error) {
      this.options.logger.warn("usage ledger unreadable; starting empty", {
        error: (error as Error).message,
      });
      return [];
    }
  }

  private write(): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify({ version: 1, entries: this.entries })}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (error) {
      this.options.logger.error("failed to persist usage ledger", { error: (error as Error).message });
    }
  }
}

function isUsageEntry(value: unknown): value is UsageEntry {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<UsageEntry>;
  return (
    typeof entry.at === "number" &&
    typeof entry.model === "string" &&
    typeof entry.promptTokens === "number" &&
    typeof entry.completionTokens === "number" &&
    typeof entry.cachedTokens === "number" &&
    typeof entry.totalTokens === "number"
  );
}

/**
 * Pull token counts out of an OpenAI-shaped payload.
 *
 * Accepts both the chat-completions shape (`prompt_tokens`) and the Responses
 * shape (`input_tokens`), since both endpoints report usage and both should
 * land in the same ledger. Returns null when the payload carries no usage
 * block, which is what a content-only response looks like.
 */
export function usageFromPayload(payload: unknown): Omit<UsageEntry, "at" | "model" | "accountId"> | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const block = usage as Record<string, unknown>;
  const prompt = numberFrom(block.prompt_tokens) ?? numberFrom(block.input_tokens);
  const completion = numberFrom(block.completion_tokens) ?? numberFrom(block.output_tokens);
  if (prompt === null && completion === null) return null;
  const cached =
    numberFrom((block.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens) ??
    numberFrom((block.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens) ??
    0;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  return {
    promptTokens,
    completionTokens,
    cachedTokens: cached,
    totalTokens: numberFrom(block.total_tokens) ?? promptTokens + completionTokens,
  };
}

function numberFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
