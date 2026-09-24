/**
 * batch.mjs — 可复用的批处理引擎
 *
 * 把「挑账号 → 并发登录 → 落盘 → 推送 → 统计」这段逻辑从 CLI 里抽出来，
 * 让 CLI（register.mjs）和 Web 控制台（web.mjs）共用同一套实现。
 *
 * 邮箱库存规则（见 lib/mailPool.mjs）：
 *   目标 web 号   = config/mail/web_mail.txt（严格 2 列：邮箱----密码）
 *   辅助接码邮箱  = new_mail.txt + all_web_mail.txt（≥4 列），
 *                   剔除 used_mail.txt 与账号池里已用过的；
 *                   注册成功后整行追加进 used_mail.txt 标记已用。
 */

import fs from "fs";
import path from "path";
import { dataPath } from "../paths.mjs";
import { loginOne, loginOneDevice } from "./cline_engine.mjs";
import { createBrowserPool } from "./browserPool.mjs";
import { pushAccounts, readPushConfig } from "./push.mjs";
import {
  loadWebMails,
  loadHelperPool,
  markHelperUsed,
  parseMailLine,
} from "./mailPool.mjs";

// 并发上限可通过 REGISTER_MAX_CONCURRENCY 调整；内存充足就往上开。
export const MAX_CONCURRENCY = Math.max(1, Number(process.env.REGISTER_MAX_CONCURRENCY) || 64);
export const ACCOUNTS_FILE = dataPath("accounts_cline.json");
const CACHE_TOKEN_FILE = dataPath("last-token.json");

export { parseMailLine } from "./mailPool.mjs";

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

/** 汇总目标号 / 辅助邮箱 / 账号池三方状态，供快照与队列挑选。 */
export function loadInventory() {
  const targets = loadWebMails();
  const accounts = loadAccounts();
  const usedHelpers = accounts.map((a) => a.helperEmail).filter(Boolean);
  const helpers = loadHelperPool(usedHelpers);
  return {
    targets,
    helpers,
    targetEmails: new Set(targets.map((l) => parseMailLine(l).email)),
    helperEmails: new Set(helpers.map((l) => parseMailLine(l).email)),
    accounts,
  };
}

/** 当前库存 / 已成功 / 剩余未处理 / 远端配置，用于前端展示。 */
export function snapshot(inventory = loadInventory()) {
  const accounts = inventory.accounts ?? loadAccounts();
  const ok = accounts.filter((a) => a.ok);
  const bad = accounts.filter((a) => !a.ok);
  const okEmails = new Set(ok.map((a) => String(a.email || "").toLowerCase()));
  const pending = inventory.targets.filter((l) => !okEmails.has(parseMailLine(l).email));
  const targetOk = ok.filter((a) => inventory.targetEmails.has(String(a.email || "").toLowerCase()));
  const targetBad = bad.filter((a) => inventory.targetEmails.has(String(a.email || "").toLowerCase()));
  const remote = readPushConfig();

  return {
    inventory: inventory.targets.length,
    helpers: inventory.helpers.length,
    ok: targetOk.length,
    failed: targetBad.length,
    pending: pending.length,
    pushed: targetOk.filter((a) => a.pushedAt).length,
    accountOk: ok.length,
    accountFailed: bad.length,
    remote: { configured: Boolean(remote.base && remote.token), base: remote.base || null },
    maxConcurrency: MAX_CONCURRENCY,
    accountsFile: ACCOUNTS_FILE,
  };
}

/**
 * 挑出这一轮要处理的账号队列。
 * @param {{ mode?: "pending"|"retry"|"all", email?: string, count?: number, inventory?: object }} opts
 */
export function buildQueue({ mode = "pending", email = "", count = 0, inventory = loadInventory() } = {}) {
  const web = inventory.targets;
  const accounts = inventory.accounts ?? loadAccounts();
  const okEmails = new Set(accounts.filter((a) => a.ok).map((a) => String(a.email || "").toLowerCase()));
  const failEmails = new Set(accounts.filter((a) => !a.ok).map((a) => String(a.email || "").toLowerCase()));

  let queue;
  if (email) {
    const hit = web.find((l) => parseMailLine(l).email === email.trim().toLowerCase());
    if (!hit) throw new Error(`邮箱不在目标账号库存中（目标号必须是 web_mail.txt 里 2 列的 邮箱----密码 记录）: ${email}`);
    queue = [hit];
  } else if (mode === "retry") {
    queue = web.filter((l) => failEmails.has(parseMailLine(l).email));
  } else if (mode === "all") {
    queue = web;
  } else {
    queue = web.filter((l) => !okEmails.has(parseMailLine(l).email));
  }
  if (count > 0) queue = queue.slice(0, count);
  return { queue, web, accounts, inventory };
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
  const { queue, web, accounts: initialAccounts, inventory } = buildQueue({ mode, email, count });

  if (!queue.length) {
    onEvent({ type: "done", ok: 0, fail: 0, pushed: 0, pushFail: 0, total: 0, ms: 0, aborted: false });
    return { ok: 0, fail: 0, pushed: 0, pushFail: 0, total: 0, ms: 0, aborted: false };
  }

  const runner = device ? loginOneDevice : loginOne;

  // 默认「一个 Chrome + N 个独立 context」。
  // 指纹/IP 本来就和独立 Chrome 一样（同机器同 IP），但内存占用只要 1/N，
  // 所以并发能开得更高。想退回每账号独立 Chrome 就设 REGISTER_SHARED_BROWSER=false。
  const sharedBrowser = String(process.env.REGISTER_SHARED_BROWSER ?? "true").toLowerCase() !== "false";
  const pool = sharedBrowser ? createBrowserPool() : null;
  const helperLines = inventory.helpers;
  if (!helperLines.length) {
    throw new Error(
      "没有可用的辅助接码邮箱：new_mail.txt / all_web_mail.txt 里需要 ≥4 列格式（第 4 列为 Graph refreshToken），且未被 used_mail.txt 标记。",
    );
  }

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

  // 高并发会同时开很多浏览器标签，提前提醒一句
  if (conc > 8) {
    onEvent({
      type: "log", level: "warn",
      text: `并发 ${conc} 会同时开 ${conc} 个浏览器标签，内存约 ${(conc * 0.25).toFixed(1)} GB，机器可能变卡`,
    });
  }

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
    const [webEmail, webPass] = parseMailLine(line).fields;
    const idx = Math.max(0, web.indexOf(line));
    const helperLine = helperLines[idx % helperLines.length];
    const hs = parseMailLine(helperLine).fields;
    const helperEmail = hs[0];
    const helperRt = hs[3];
    if (helperEmail.toLowerCase() === webEmail.toLowerCase()) {
      throw new Error(`辅助邮箱与目标账号相同：${helperEmail}`);
    }

    const emit = (level, text) =>
      onEvent({ type: "log", level, text, email: webEmail, index });

    onEvent({ type: "account-start", email: webEmail, helperEmail, index, total: queue.length });
    emit("info", `开始 ${webEmail}（接码 ${helperEmail}）`);

    try {
      const rec = await runner({
        webEmail, webPass, helperEmail, helperRt,
        log: (msg) => emit("info", String(msg).replace(/^\s+/, "")),
        signal,
        pool,
      });
      const record = { email: webEmail, password: webPass, helperEmail, ok: true, ...rec };
      await commit((list) => [
        ...list.filter((a) => a.email.toLowerCase() !== webEmail.toLowerCase()),
        record,
      ]);
      updateCacheToken(rec);
      markHelperUsed(helperLine, { targetEmail: webEmail });
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

  try {
    await Promise.all(Array.from({ length: conc }, () => worker()));
  } finally {
    await writeChain;
    if (pool) await pool.close();
  }

  const ms = Date.now() - started;
  const result = { ...stats, total: queue.length, ms, aborted };
  onEvent({ type: "done", ...result });
  return result;
}