/**
 * In-memory request log for the admin UI.
 *
 * Deliberately not persisted: this is a rolling window for eyeballing "what did
 * the gateway just do", not an audit trail. Keep it bounded so a busy gateway
 * cannot grow the heap.
 */
export interface RequestLogEntry {
  /** Epoch millis when the request was accepted. */
  at: number;
  model: string;
  stream: boolean;
  /** HTTP status returned to the client. */
  status: number;
  durationMs: number;
  accountId: string | null;
  /** Failure reason when status is not 2xx. */
  error: string | null;
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

  constructor(private readonly limit = 200) {}

  record(entry: RequestLogEntry): void {
    this.total += 1;
    this.entries.push(entry);
    if (this.entries.length > this.limit) {
      this.entries.splice(0, this.entries.length - this.limit);
    }
  }

  /** Newest first. */
  list(limit = 100): RequestLogEntry[] {
    const size = Math.max(1, Math.min(limit, this.limit));
    return this.entries.slice(-size).reverse();
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
