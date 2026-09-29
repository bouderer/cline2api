/**
 * Request log for the admin UI, with an optional persistent JSONL trail.
 *
 * The in-memory part stays a bounded rolling window for eyeballing "what did
 * the gateway just do". The persisted part is a daily-rotated append-only
 * JSONL file — the audit trail that answers "how many bytes went through
 * which exit yesterday", which the memory window can never answer because it
 * neither survives a restart nor remembers more than the last few minutes.
 */
import fs from "node:fs";
import path from "node:path";
import type { Logger } from "../logger.js";

export interface RequestLogEntry {
  /** Correlation id, shared with the completion line that carries respBytes. */
  id?: string;
  /** Epoch millis when the request was accepted. */
  at: number;
  model: string;
  stream: boolean;
  /** HTTP status returned to the client. */
  status: number;
  durationMs: number;
  accountId: string | null;
  /**
   * Which egress hop carried this request, by exit IP.
   *
   * The account id says who served it; this says which address Cline saw. When
   * a burst gets throttled, the account id is useless for the diagnosis — the
   * limit is per exit address, so the operator needs to know which addresses
   * were actually used and which one refused.
   */
  exitIp: string | null;
  /** Failure reason when status is not 2xx. */
  error: string | null;
  /** Caller's address, as seen through the reverse proxy. Null when unknown. */
  clientIp: string | null;
  /**
   * Upstream calls this request actually caused.
   *
   * The distinction matters because not every request the gateway answers is
   * traffic at Cline: a request that is rejected on auth, or that finds no
   * account, never leaves the host. Counting those as upstream load would
   * overstate what a rate limit is measuring.
   */
  upstreamCalls: number;
  /**
   * Request body size in bytes, when the route could measure it. Optional:
   * a request rejected before the body was read has nothing to report. This
   * is the cheap half of byte accounting — the request side is one
   * serialization of a body we already hold; the response side is a stream
   * and is not counted here.
   */
  reqBytes?: number;
  /**
   * Response body size in bytes. Only known once the stream to the client has
   * finished, which is after this entry is persisted — so it arrives on a
   * separate completion line (see `complete`) joined by `id`.
   */
  respBytes?: number;
}

/** Options for the persisted JSONL trail. */
export interface RequestLogSinkOptions {
  /** Directory to write daily JSONL files into. */
  dir: string;
  /** How many days of files to keep; older ones are pruned on rotation. */
  retainDays?: number;
  logger?: Logger;
}

export interface RequestLogStats {
  total: number;
  ok: number;
  failed: number;
  last5Minutes: number;
}

export class RequestLog {
  private readonly entries: RequestLogEntry[] = [];
  private total = 0;
  private readonly sink: RequestLogSinkOptions | null;
  /** Day string (YYYY-MM-DD, local) of the file currently open. */
  private sinkDay: string | null = null;
  private sinkStream: fs.WriteStream | null = null;
  /** True after the first write failure, so a broken disk cannot spam the log. */
  private sinkBroken = false;

  constructor(private readonly limit = 200, sink?: RequestLogSinkOptions) {
    this.sink = sink ?? null;
    if (this.sink) {
      try {
        fs.mkdirSync(this.sink.dir, { recursive: true });
      } catch (error) {
        this.sink?.logger?.warn("request log directory unusable, persistence disabled", {
          dir: this.sink.dir,
          error: (error as Error).message,
        });
        this.sinkBroken = true;
      }
    }
  }

  record(entry: RequestLogEntry): void {
    this.total += 1;
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
    this.persist({ kind: "entry", ...entry });
  }

  /**
   * Report the response size for an already-recorded request.
   *
   * The entry line was persisted when the request settled, but a streaming
   * response is still flowing at that point; its byte count only exists once
   * the client is done reading. Rather than hold entries open (unbounded
   * state) or rewrite lines (JSONL is append-only), this appends a small
   * completion record joined to its entry by id. Offline analysis sums both
   * kinds; the in-memory UI view ignores these.
   */
  complete(id: string, respBytes: number): void {
    this.persist({ kind: "complete", at: Date.now(), id, respBytes });
  }

  /** Local YYYY-MM-DD for an epoch-ms timestamp. */
  private static dayOf(at: number): string {
    const d = new Date(at);
    const p = (n: number): string => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /**
   * Append one entry to the daily JSONL file.
   *
   * Failures are demoted to a single warning and persistence is disabled:
   * the request log is an observability aid, and a full or unwritable disk
   * must never take down request serving or bury the real errors.
   */
  private persist(entry: { at: number } & Record<string, unknown>): void {
    if (!this.sink || this.sinkBroken) return;
    try {
      const day = RequestLog.dayOf(entry.at);
      if (day !== this.sinkDay) {
        this.sinkStream?.end();
        this.sinkStream = fs.createWriteStream(
          path.join(this.sink!.dir, `requests-${day}.jsonl`),
          { flags: "a" },
        );
        this.sinkStream.on("error", (error) => {
          this.sinkBroken = true;
          this.sink?.logger?.warn("request log write failed, persistence disabled", {
            error: error.message,
          });
        });
        this.sinkDay = day;
        this.prune(day);
      }
      this.sinkStream?.write(JSON.stringify(entry) + "\n");
    } catch (error) {
      this.sinkBroken = true;
      this.sink?.logger?.warn("request log persistence disabled", {
        error: (error as Error).message,
      });
    }
  }

  /** Drop daily files older than the retention window. Cheap: one readdir per rotation. */
  private prune(today: string): void {
    const retainDays = this.sink?.retainDays ?? 30;
    const cutoff = new Date(today + "T00:00:00").getTime() - retainDays * 86_400_000;
    let names: string[];
    try {
      names = fs.readdirSync(this.sink!.dir);
    } catch {
      return;
    }
    for (const name of names) {
      const m = /^requests-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
      if (!m) continue;
      if (new Date(m[1]! + "T00:00:00").getTime() < cutoff) {
        fs.rm(path.join(this.sink!.dir, name), { force: true }, () => undefined);
      }
    }
  }

  /** Newest first. */
  list(limit = 100): RequestLogEntry[] {
    const size = Math.max(1, Math.min(limit, this.limit));
    return this.entries.slice(-size).reverse();
  }

  /**
   * Newest-first entries from the persisted JSONL trail, newest day first.
   *
   * Serves limits far beyond the in-memory window: the memory ring exists for
   * the quick "what just happened" view, while the file is the real history.
   * Completion lines (response bytes, written when a stream ends) are joined
   * onto their entry by id. Reads only the tail of the file — enough bytes for
   * the requested entries at a generous average line size — so a day's log
   * never gets fully loaded to answer a small query.
   */
  listPersisted(limit: number): RequestLogEntry[] {
    if (!this.sink || this.sinkBroken) return this.list(limit);
    const wanted = Math.max(1, limit);
    const entries: RequestLogEntry[] = [];
    const completions = new Map<string, number>();
    // Walk day files newest-first; stop as soon as enough entries are gathered.
    const day = RequestLog.dayOf(Date.now());
    for (const file of this.recentFiles(day, 2)) {
      if (entries.length >= wanted) break;
      let text: string;
      try {
        const fd = fs.openSync(file, "r");
        try {
          const size = fs.fstatSync(fd).size;
          // ~600B per line average (entry + its completion), doubled for
          // safety, so the tail window holds at least `wanted` entries.
          const readFrom = Math.max(0, size - wanted * 1200);
          const buf = Buffer.alloc(size - readFrom);
          fs.readSync(fd, buf, 0, buf.length, readFrom);
          text = buf.toString("utf8");
        } finally {
          fs.closeSync(fd);
        }
      } catch {
        continue;
      }
      const lines = text.split("\n");
      // First partial line from a mid-line readFrom: drop it.
      // Two passes: a completion line is appended AFTER its entry (the stream
      // ends later), so the join map must be fully built before entries read it.
      for (const line of lines) {
        if (!line) continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (d.kind === "complete" && typeof d.id === "string" && typeof d.respBytes === "number") {
          completions.set(d.id, d.respBytes);
        }
      }
      for (const line of lines) {
        if (!line) continue;
        let d: Record<string, unknown>;
        try {
          d = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }
        if (d.kind === "complete") continue;
        if (d.kind === "entry" || (d.kind === undefined && typeof d.model === "string")) {
          const entry = d as unknown as RequestLogEntry;
          const rb = entry.id !== undefined ? completions.get(entry.id) : undefined;
          entries.push(rb === undefined ? entry : { ...entry, respBytes: rb });
        }
      }
    }
    entries.sort((a, b) => b.at - a.at);
    return entries.slice(0, wanted);
  }

  /** Existing requests-*.jsonl paths for `day` and the `extra` days before it. */
  private recentFiles(today: string, extra: number): string[] {
    const files: string[] = [];
    const base = new Date(today + "T00:00:00").getTime();
    for (let i = 0; i <= extra; i++) {
      const d = new Date(base - i * 86_400_000);
      const p = path.join(this.sink!.dir, `requests-${RequestLog.dayOf(d.getTime())}.jsonl`);
      if (fs.existsSync(p)) files.push(p);
    }
    return files;
  }

  stats(): RequestLogStats {
    const cutoff = Date.now() - 5 * 60 * 1000;
    let ok = 0;
    let failed = 0;
    let recent = 0;
    for (const entry of this.entries) {
      if (entry.status >= 200 && entry.status < 300) ok += 1;
      else failed += 1;
      if (entry.at >= cutoff) recent += 1;
    }
    return { total: this.total, ok, failed, last5Minutes: recent };
  }
}
