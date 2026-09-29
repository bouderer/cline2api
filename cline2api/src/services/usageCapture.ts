/**
 * Reading token counts off a response without disturbing it.
 *
 * The usage ledger wants what upstream reported, but the bytes also have to
 * reach the client unchanged and without added latency. So a stream is forked
 * with `tee`: one branch is parsed for the usage block, the other is what the
 * caller sends on. The parse runs detached and never blocks the forward.
 */
import type { UsageLedger, UsageEntry } from "./usageLedger.js";

type Usage = Omit<UsageEntry, "at" | "model" | "accountId">;

/** Chat-completions and Responses usage blocks, whichever the payload uses. */
export function readUsage(payload: unknown): Usage | null {
  if (typeof payload !== "object" || payload === null) return null;
  const usage = (payload as { usage?: unknown }).usage;
  if (typeof usage !== "object" || usage === null) return null;
  const block = usage as Record<string, unknown>;
  const prompt = num(block.prompt_tokens) ?? num(block.input_tokens);
  const completion = num(block.completion_tokens) ?? num(block.output_tokens);
  if (prompt === null && completion === null) return null;
  const cached =
    num((block.prompt_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens) ??
    num((block.input_tokens_details as { cached_tokens?: unknown } | undefined)?.cached_tokens) ??
    0;
  const promptTokens = prompt ?? 0;
  const completionTokens = completion ?? 0;
  // Market cost is the number worth charting: `cost` is 0 on the free bucket,
  // while `market_cost` carries the real inference price for both free and
  // paid models. Take whichever is present, market first.
  const costUsd = num(block.market_cost) ?? num(block.cost) ?? undefined;
  return {
    promptTokens,
    completionTokens,
    cachedTokens: cached,
    totalTokens: num(block.total_tokens) ?? promptTokens + completionTokens,
    ...(costUsd !== undefined ? { costUsd } : {}),
  };
}

/**
 * Watch an SSE body for its usage and record it, returning the body untouched.
 *
 * Upstream sends usage in a trailing `data:` chunk. Each such chunk overwrites
 * the tally field by field, so a chunk that only carries totals does not wipe
 * a cache count an earlier chunk already reported. Recording happens when the
 * stream ends, which is the one moment the tally is complete.
 */
export function captureUsage(
  body: ReadableStream<Uint8Array>,
  record: (usage: Usage) => void,
): ReadableStream<Uint8Array> {
  const counters = blankTally();
  let seen = false;
  const settle = (): void => {
    if (seen && counters.totalTokens > 0) {
      record({
        promptTokens: counters.promptTokens,
        completionTokens: counters.completionTokens,
        cachedTokens: counters.cachedTokens,
        totalTokens: counters.totalTokens,
        ...(counters.costUsd !== undefined ? { costUsd: counters.costUsd } : {}),
      });
    }
  };

  // One pass over one branch. The body is not teed: the caller reads the stream
  // this returns, and every chunk is tallied on its way through, so there is no
  // second consumer to keep alive.
  //
  // The earlier shape here teed the body and drained the mirror branch in a
  // detached `tally()`. That made teardown non-terminating: `tee()` completes a
  // branch's `cancel()` only once *both* branches are cancelled, so cancelling
  // the forwarded branch alone left the tee parked and the detached drain
  // awaiting input that would never arrive. Any caller awaiting that cancel —
  // the streaming Responses surface does, on idle timeout against a silent
  // upstream — then waited forever.
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const reader = body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line.startsWith("data:")) {
              const usage = readUsage(parseJSON(line.slice(5)));
              if (usage) {
                seen = true;
                // Last-write-wins per field, so a trailing totals-only chunk
                // does not erase a cache/reasoning count reported earlier.
                if (usage.promptTokens) counters.promptTokens = usage.promptTokens;
                if (usage.completionTokens) counters.completionTokens = usage.completionTokens;
                if (usage.cachedTokens) counters.cachedTokens = usage.cachedTokens;
                if (usage.totalTokens) counters.totalTokens = usage.totalTokens;
                if (usage.costUsd !== undefined) counters.costUsd = usage.costUsd;
              }
            }
            newline = buffer.indexOf("\n");
          }
          controller.enqueue(value);
        }
        controller.close();
      } catch (error) {
        controller.error(error);
      } finally {
        reader.releaseLock();
        settle();
      }
    },
    cancel(reason) {
      // Waited on, not fired and forgotten: cancelling upstream is what lets
      // the caller's own teardown finish, and a rejection here would surface as
      // a request that never closes.
      return body.cancel(reason).then(settle, () => undefined);
    },
  });
}

/** Mutable usage counters, shared by the consuming loop and the settle path. */
function blankTally(): {
  promptTokens: number;
  completionTokens: number;
  cachedTokens: number;
  totalTokens: number;
  costUsd?: number;
} {
  return { promptTokens: 0, completionTokens: 0, cachedTokens: 0, totalTokens: 0 };
}


function parseJSON(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Record a non-streaming JSON body, returning it unchanged for the client. */
export function recordJsonUsage(raw: string, record: (usage: Usage) => void): void {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return;
  }
  if (typeof payload === "object" && payload !== null && (payload as { data?: unknown }).data) {
    const inner = readUsage((payload as { data?: unknown }).data);
    if (inner) {
      record(inner);
      return;
    }
  }
  const usage = readUsage(payload);
  if (usage && usage.totalTokens > 0) record(usage);
}

export type { UsageLedger };
