/**
 * The quota charts read token counts this gateway recorded itself, so the
 * ledger has to survive a restart and report a window accurately. The capture
 * helper is what feeds it: it must pull usage out of a stream without changing
 * what the client receives.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { UsageLedger } from "../src/services/usageLedger.js";
import { captureUsage, readUsage, recordJsonUsage } from "../src/services/usageCapture.js";

const logger = { debug() {}, info() {}, warn() {}, error() {}, child() { return this; }, redact() {} };

function ledger(now = 1_000_000): { dir: string; ledger: UsageLedger } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-usage-"));
  return { dir, ledger: new UsageLedger({ dataDir: dir, logger, flushEvery: 100, flushIntervalMs: 0, now: () => now }) };
}

test("records survive a reload and a window excludes what is outside it", () => {
  const { dir, ledger: first } = ledger();
  first.record({ at: 500, model: "m", accountId: "a", promptTokens: 10, completionTokens: 5, cachedTokens: 2, totalTokens: 15 });
  first.record({ at: 2_000, model: "m", accountId: "a", promptTokens: 1, completionTokens: 1, cachedTokens: 0, totalTokens: 2 });
  first.flush();

  const reloaded = new UsageLedger({ dataDir: dir, logger, flushIntervalMs: 0, now: () => 1_000_000 });
  const rows = reloaded.range(0, 1_000);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.totalTokens, 15);
  assert.equal(reloaded.range(0, 10_000).length, 2);
});

test("entries past the retention window are dropped on flush", () => {
  let now = 10_000_000;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cline2api-usage-"));
  const book = new UsageLedger({ dataDir: dir, logger, retainMs: 1_000, flushEvery: 100, flushIntervalMs: 0, now: () => now });
  book.record({ at: 1, model: "m", accountId: null, promptTokens: 1, completionTokens: 1, cachedTokens: 0, totalTokens: 2 });
  book.record({ at: now, model: "m", accountId: null, promptTokens: 3, completionTokens: 4, cachedTokens: 0, totalTokens: 7 });
  book.flush();
  assert.equal(book.range(0, now).length, 1);
  assert.equal(book.range(0, now)[0]?.totalTokens, 7);
});

test("readUsage accepts both chat and responses usage shapes", () => {
  assert.deepEqual(readUsage({ usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } } }),
    { promptTokens: 5, completionTokens: 2, cachedTokens: 3, totalTokens: 7 });
  assert.deepEqual(readUsage({ usage: { input_tokens: 4, output_tokens: 1 } }),
    { promptTokens: 4, completionTokens: 1, cachedTokens: 0, totalTokens: 5 });
  assert.equal(readUsage({ choices: [] }), null);
});

test("recordJsonUsage reads a wrapped envelope", () => {
  const seen: unknown[] = [];
  recordJsonUsage(JSON.stringify({ success: true, data: { usage: { prompt_tokens: 8, completion_tokens: 2, total_tokens: 10 } } }), (u) => seen.push(u));
  assert.equal((seen[0] as { totalTokens: number }).totalTokens, 10);
  recordJsonUsage("not json", () => seen.push("x"));
  assert.equal(seen.length, 1);
});

test("captureUsage records the trailing usage chunk and forwards every byte", async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
    'data: {"usage":{"prompt_tokens":9,"completion_tokens":3,"total_tokens":12,"prompt_tokens_details":{"cached_tokens":4}}}\n\n',
    "data: [DONE]\n\n",
  ];
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const seen: unknown[] = [];
  const forwarded = captureUsage(body, (usage) => seen.push(usage));
  const text = new TextDecoder().decode(await new Response(forwarded).arrayBuffer());
  assert.equal(text, chunks.join(""));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0], { promptTokens: 9, completionTokens: 3, cachedTokens: 4, totalTokens: 12 });
});
