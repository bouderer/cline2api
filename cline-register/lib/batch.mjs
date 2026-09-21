/**
 * batch.mjs — 可复用的批处理引擎
 *
 * 把「挑账号 → 并发登录 → 落盘 → 推送 → 统计」这段逻辑从 CLI 里抽出来，
 * 让 CLI（register.mjs）和 Web 控制台（web.mjs）共用同一套实现。
 *
 * 通过事件回调把进度吐给调用方，调用方决定怎么展示（终端打印 / SSE 推给浏览器）。
 */

import fs from "fs";
import path from "path";
import { mailPath, dataPath } from "../paths.mjs";
import { loginOne, loginOneDevice } from "./cline_engine.mjs";
import { pushAccounts, readPushConfig } from "./push.mjs";

export const MAX_CONCURRENCY = 8;
export const ACCOUNTS_FILE = dataPath("accounts_cline.json");
const CACHE_TOKEN_FILE = dataPath("last-token.json");

export function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l.includes("@") && l.includes("----"));
}

export function loadAccounts() {
  try {
    const p = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

export function saveAccounts(list) {
  fs.mkdirSync(path.dirname(ACCOUNTS_FILE), { recursive: true });
  const tmp = `${ACCOUNTS_FILE}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2));
  fs.renameSync(tmp, ACCOUNTS_FILE);
}

function updateCacheToken(rec) {
  try {
    fs.mkdirSync(path.dirname(CACHE_TOKEN_FILE), { recursive: true });
    fs.writeFileSync(CACHE_TOKEN_FILE, JSON.stringify({
      accessToken: rec.accessToken,
      refreshToken: rec.refreshToken,
      expiresAt: rec.expiresAt,
      source: "device",
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch {}
}

/** 当前库存 / 已成功 / 剩余未处理 / 远端配置，用于前端展示。 */
export function snapshot() {
  const web = readList(mailPath("all_web_mail.txt")).concat(readList(mailPath("web_mail.txt")));
  const helpers = readList(mailPath("new_mail.txt"));
  const accounts = loadAccounts();
  const ok = accounts.filter((a) => a.ok);
  const bad = accounts.filter((a) => !a.ok);
  const okEmails = new Set(ok.map((a) => a.email.toLowerCase()));
  const pending = web.filter((l) => !okEmails.has(l.split("----")[0].trim().toLowerCase()));
  const remote = readPushConfig();

  return {
    inventory: web.length,
    helpers: helpers.length,
    ok: ok.length,
    failed: bad.length,
    pending: pending.length,
    pushed: ok.filter((a) => a.pushedAt).length,
    remote: { configured: Boolean(remote.base && remote.token), base: remote.base || null },
    maxConcurrency: MAX_CONCURRENCY,
    accountsFile: ACCOUNTS_FILE,
  };
}

/**
 * 挑出这一轮要处理的账号队列。
 * @param {{ mode?: "pending"|"retry"|"all", email?: string, count?: number }} opts
 */
export function buildQueue({ mode = "pending", email = "", count = 0 } = {}) {
  const web = readList(mailPath("all_web_mail.txt")).concat(readList(mailPath("web_mail.txt")));
  const accounts = loadAccounts();
  const okEmails = new Set(accounts.filter((a) => a.ok).map((a) => a.email.toLowerCase()));
  const failEmails = new Set(accounts.filter((a) => !a.ok).map((a) => a.email.toLowerCase()));

  let queue;
  if (email) {
    const hit = web.find((l) => l.toLowerCase().startsWith(email.toLowerCase()));
    if (!hit) throw new Error(`邮箱不在库存中: ${email}`);
    queue = [hit];
  } else if (mode === "retry") {
    queue = web.filter((l) => failEmails.has(l.split("----")[0].trim().toLowerCase()));
  } else if (mode === "all") {
    queue = web;
  } else {
    queue = web.filter((l) => !okEmails.has(l.split("----")[0].trim().toLowerCase()));
  }
  if (count > 0) queue = queue.slice(0, count);
  return { queue, web, accounts };
}

/**
 * 跑一轮批处理。
 *
 * @param {object} opts
 * @param {number} [opts.count]          处理多少个（0 / 不传 = 全部待处理）
 * @param {number} [opts.concurrency]    并发数，1..8
 * @param {boolean} [opts.device]        true 用设备码链路
 * @param {boolean} [opts.push]          true 表示成功即推送
 * @param {"pending"|"retry"|"all"} [opts.mode]
 * @param {string} [opts.email]          只处理指定邮箱
 * @param {(evt: object) => void} [opts.onEvent]  进度事件回调
 * @param {AbortSignal} [opts.signal]    中止信号
 * @returns {Promise<{ok:number,fail:number,pushed:number,pushFail:number,ms:number,total:number,aborted:boolean}>}
 */
export async function runBatch({
  count = 0,
  concurrency = 1,
  device = false,
  push = true,
  mode = "pending",
  email = "",
  onEvent = () => {},
  signal,
} = {}) {
  const conc = Math.min(MAX_CONCURRENCY, Math.max(1, Number(concurrency) || 1));
  const { queue, web, accounts: initialAccounts } = buildQueue({ mode, email, count });

  if (!queue.length) {
    onEvent({ type: "done", ok: 0, fail: 0, pushed: 0, pushFail: 0, total: 0, ms: 0, aborted: false });
    return { ok: 0, fail: 0, pushed: 0, pushFail: 0, total: 0, ms: 0, aborted: false };
  }

  const runner = device ? loginOneDevice : loginOne;
  const helperLines = readList(mailPath("new_mail.txt"));
  if (!helperLines.length) throw new Error("没有辅助接码邮箱，请检查 config/mail/new_mail.txt");

  const remote = readPushConfig();
  const canPush = push && Boolean(remote.base && remote.token);

  let accounts = initialAccounts;
  let writeChain = Promise.resolve();
  const commit = (mutate) => {
    writeChain = writeChain
      .then(() => { accounts = mutate(accounts) ?? accounts; saveAccounts(accounts); })
      .catch((e) => onEvent({ type: "log", level: "warn", text: `写账号池失败: ${e.message}` }));
    return writeChain;
  };

  const started = Date.now();
  const stats = { ok: 0, fail: 0, pushed: 0, pushFail: 0 };
  let cursor = 0;
  let aborted = false;
  let running = 0;

  onEvent({
    type: "start",
    total: queue.length,
    concurrency: conc,
    mode: device ? "device" : "callback",
    push: canPush,
    remote: canPush ? remote.base : null,
  });

  async function handleOne(index) {
    const line = queue[index];
    const [webEmail, webPass] = line.split("----").map((s) => s.trim());
    const idx = Math.max(0, web.indexOf(line));
    const hs = helperLines[idx % helperLines.length].split("----").map((s) => s.trim());
    const helperEmail = hs[0];
    const helperRt = hs[3];

    const emit = (level, text) =>
      onEvent({ type: "log", level, text, email: webEmail, index });

    onEvent({ type: "account-start", email: webEmail, helperEmail, index, total: queue.length });
    emit("info", `开始 ${webEmail}（接码 ${helperEmail}）`);

    try {
      const rec = await runner({
        webEmail, webPass, helperEmail, helperRt,
        log: (msg) => emit("info", String(msg).replace(/^\s+/, "")),
        signal,
      });
      const record = { email: webEmail, password: webPass, helperEmail, ok: true, ...rec };
      await commit((list) => [
        ...list.filter((a) => a.email.toLowerCase() !== webEmail.toLowerCase()),
        record,
      ]);
      updateCacheToken(rec);
      stats.ok += 1;
      emit("ok", `成功 ${webEmail}`);
      onEvent({ type: "account-ok", email: webEmail, index, total: queue.length });

      if (canPush) {
        try {
          const result = await pushAccounts([record], { log: (m) => emit("info", String(m)) });
          if (result.imported + result.updated > 0) {
            stats.pushed += 1;
            const stamp = new Date().toISOString();
            await commit((list) => list.map((a) =>
              a.email.toLowerCase() === webEmail.toLowerCase() ? { ...a, pushedAt: stamp } : a));
            emit("ok", `已推送 ${webEmail}`);
            onEvent({ type: "account-pushed", email: webEmail, index, total: queue.length });
          } else {
            stats.pushFail += 1;
            emit("warn", `推送未计入（skipped=${result.skipped}）`);
          }
        } catch (e) {
          stats.pushFail += 1;
          emit("warn", `推送失败（本地已保存，可稍后重推）: ${e.message}`);
        }
      }
    } catch (e) {
      stats.fail += 1;
      await commit((list) => [
        ...list.filter((a) => a.email.toLowerCase() !== webEmail.toLowerCase()),
        {
          email: webEmail, password: webPass, helperEmail, ok: false,
          error: e.message, attemptedAt: new Date().toISOString(),
        },
      ]);
      emit("err", `失败 ${webEmail} -> ${e.message}`);
      onEvent({ type: "account-fail", email: webEmail, error: e.message, index, total: queue.length });
    }
  }

  async function worker() {
    for (;;) {
      if (aborted || (signal && signal.aborted)) { aborted = true; return; }
      const index = cursor++;
      if (index >= queue.length) return;
      running += 1;
      onEvent({ type: "progress", done: stats.ok + stats.fail, total: queue.length, running, ok: stats.ok, fail: stats.fail, pushed: stats.pushed });
      try {
        await handleOne(index);
      } finally {
        running -= 1;
        onEvent({ type: "progress", done: stats.ok + stats.fail, total: queue.length, running, ok: stats.ok, fail: stats.fail, pushed: stats.pushed });
      }
      if (!aborted && index + 1 < queue.length) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  await Promise.all(Array.from({ length: conc }, () => worker()));
  await writeChain;

  const ms = Date.now() - started;
  const result = { ...stats, total: queue.length, ms, aborted };
  onEvent({ type: "done", ...result });
  return result;
}
