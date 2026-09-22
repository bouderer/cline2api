/**
 * Free-quota signals.
 *
 * Two things are worth pinning here. First, that a probe result outranks a
 * traffic signal for the same day but a stale probe does not outlive its TTL —
 * the free bucket resets daily, so a verdict that never expires would claim an
 * account is exhausted forever. Second, that everything is scoped to the local
 * day, because "today's free quota" is the only claim the UI makes.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FreeQuotaStore, PROBE_TTL_MS } from "../src/services/freeQuota.js";
import { createLogger } from "../src/logger.js";

const logger = createLogger("error");

/** A store whose clock the test drives. */
function storeAt(clock: { now: number }): FreeQuotaStore {
  return new FreeQuotaStore({ logger, now: () => clock.now });
}

test("a traffic quota error is remembered for the account", () => {
  const clock = { now: Date.now() };
  const store = storeAt(clock);
  store.recordQuotaError("acct-1", "cline-free/kimi-k3", "daily free limit");

  const entry = store.get("acct-1");
  assert.equal(entry?.state, "exhausted");
  assert.equal(entry?.probed, false);
  assert.equal(entry?.model, "cline-free/kimi-k3");
  // An account nothing has been seen for reports nothing, rather than zero.
  assert.equal(store.get("acct-2"), null);
});

test("a probe result outranks a traffic signal for the same day", () => {
  const clock = { now: Date.now() };
  const store = storeAt(clock);
  // Traffic said exhausted; an explicit probe says the bucket answers again.
  store.recordQuotaError("acct-1", "cline-free/kimi-k3", "daily free limit");
  store.recordProbe("acct-1", "ok", null);

  const entry = store.get("acct-1");
  assert.equal(entry?.state, "ok");
  assert.equal(entry?.probed, true);
  // ...and a later traffic error must not overwrite the probe verdict.
  store.recordQuotaError("acct-1", "cline-free/kimi-k3", "daily free limit");
  assert.equal(store.get("acct-1")?.state, "ok");
});

test("a probe verdict expires, and everything resets at local midnight", () => {
  const base = new Date();
  base.setHours(10, 0, 0, 0);
  const clock = { now: base.getTime() };
  const store = storeAt(clock);
  store.recordProbe("acct-1", "exhausted", "free limit reached");
  assert.equal(store.get("acct-1")?.state, "exhausted");

  // Still the same day, but past the probe TTL: no verdict rather than a stale one.
  clock.now += PROBE_TTL_MS + 1000;
  assert.equal(store.get("acct-1"), null);

  // A fresh signal, then cross local midnight: the day's quota is gone with it.
  store.recordQuotaError("acct-1", "m", "daily free limit");
  assert.ok(store.get("acct-1"));
  clock.now = base.getTime() + 24 * 60 * 60 * 1000;
  assert.equal(store.get("acct-1"), null);
});

test("snapshot reports only the accounts asked about", () => {
  const clock = { now: Date.now() };
  const store = storeAt(clock);
  store.recordQuotaError("acct-1", "m", "daily free limit");
  store.recordProbe("acct-2", "ok", null);

  const snapshot = store.snapshot(["acct-1", "acct-2", "acct-3"]);
  assert.deepEqual(Object.keys(snapshot).sort(), ["acct-1", "acct-2"]);
  assert.equal(snapshot["acct-1"]?.state, "exhausted");
  assert.equal(snapshot["acct-2"]?.state, "ok");

  store.clear();
  assert.deepEqual(store.snapshot(), {});
});
