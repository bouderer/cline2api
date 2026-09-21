#!/usr/bin/env node
/**
 * register.mjs — Cline 独立注册机（可单独运行，也可把凭据推到远程 cline2api）
 *
 * 注册流程（两条链路，自动选用）：
 *   主链路 = 扩展回调流程
 *     GET  /api/v1/auth/authorize?client_type=extension&callback_url=http://127.0.0.1:PORT/auth
 *     浏览器登录 Outlook → 接受授权 → 回调 http://127.0.0.1:PORT/auth?code=...
 *     POST /api/v1/auth/token 换 Cline 令牌
 *   备链路 = WorkOS 设备码（--device 强制使用）
 *     POST https://api.workos.com/user_management/authorize/device
 *     轮询 /user_management/authenticate → POST /api/v1/auth/register 换 Cline 令牌
 *
 * 用法（在仓库根目录执行）：
 *   node cline-register/register.mjs --status            查看账号池状态
 *   node cline-register/register.mjs --one               登录下一个待处理账号
 *   node cline-register/register.mjs --count 5           连续登录 5 个
 *   node cline-register/register.mjs --all               登录全部未完成账号
 *   node cline-register/register.mjs --retry             重试失败的账号
 *   node cline-register/register.mjs --email a@b.com     指定邮箱
 *   node cline-register/register.mjs --device            强制用设备码流程
 *   node cline-register/register.mjs --push              把已成功的凭据推到远程网关
 *   node cline-register/register.mjs --push --dry-run    只预览，不发请求
 *   node cline-register/register.mjs --push --all-ok     推送全部成功账号（默认只推还没推过的）
 *   node cline-register/register.mjs --probe             探测远程网关是否可达
 *
 * 推送目标通过环境变量配置（详见 .env.example）：
 *   CLINE2API_REMOTE_URL / CLINE2API_ADMIN_TOKEN
 */

import fs from "fs";
import path from "path";
import { REGISTER_DIR, mailPath, dataPath, LOG_DIR } from "./paths.mjs";
import { loginOne, loginOneDevice } from "./lib/cline_engine.mjs";
import { pushAccounts, probeRemote, readPushConfig } from "./lib/push.mjs";

const args = process.argv.slice(2);
const ACCOUNTS_FILE = dataPath("accounts_cline.json");
const CACHE_TOKEN_FILE = dataPath("last-token.json");
const LOG_FILE = path.join(LOG_DIR, "cline_register.log");

function log(...parts) {
  const line = `[${new Date().toISOString().slice(11, 19)}] ${parts.join(" ")}`;
  console.log(line);
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); fs.appendFileSync(LOG_FILE, line + "\n"); } catch {}
}

function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes("@") && l.includes("----"));
}

function loadAccounts() {
  try {
    const parsed = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch { return []; }
}

function saveAccounts(list) {
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

function printStatus() {
  const accounts = loadAccounts();
  const ok = accounts.filter((a) => a.ok);
  const bad = accounts.filter((a) => !a.ok);
  const pushed = ok.filter((a) => a.pushedAt).length;

  console.log("\n================== Cline 账号池 ==================");
  console.log(`已登录成功  : ${ok.length}`);
  console.log(`失败待重试  : ${bad.length}`);
  console.log(`已推送远程  : ${pushed}`);
  console.log(`账号池文件  : ${ACCOUNTS_FILE}`);
  console.log(`最新凭据快照: ${CACHE_TOKEN_FILE}`);

  const cfg = readPushConfig();
  console.log(`远程网关    : ${cfg.base || "（未配置 CLINE2API_REMOTE_URL）"}`);

  if (ok.length) {
    console.log("\n--- 最近 10 个成功账号 ---");
    ok.slice(-10).forEach((a, i) => {
      const when = a.boundAt ? a.boundAt.slice(0, 19).replace("T", " ") : "-";
      console.log(`  ${i + 1}. ${a.email}  ${a.pushedAt ? "[已推送]" : "[未推送]"}  ${when}`);
    });
  }
  if (bad.length) {
    console.log("\n--- 失败清单 ---");
    bad.forEach((a, i) => console.log(`  ${i + 1}. ${a.email} -> ${a.error}`));
  }
  console.log("=================================================\n");
}

function pickNumber(name, fallback) {
  const eq = args.find((a) => a.startsWith(`--${name}=`));
  if (eq) return Number(eq.split("=").slice(1).join("=")) || fallback;
  const i = args.indexOf(`--${name}`);
  if (i >= 0 && args[i + 1] && !args[i + 1].startsWith("--")) return Number(args[i + 1]) || fallback;
  return fallback;
}

/** 推送已成功的记录到远程网关。 */
async function runPush() {
  const accounts = loadAccounts();
  let candidates = accounts.filter((a) => a.ok && a.accessToken && a.refreshToken);

  if (!args.includes("--all-ok")) {
    candidates = candidates.filter((a) => !a.pushedAt);
  }
  if (!candidates.length) {
    log("没有需要推送的账号（全部已推送，或用 --all-ok 强制全量重推）");
    printStatus();
    return;
  }

  const dryRun = args.includes("--dry-run");
  log(`准备推送 ${candidates.length} 个账号${dryRun ? "（dry-run 预览）" : ""}`);

  const result = await pushAccounts(candidates, { log, dryRun });
  log(`推送结果：新增 ${result.imported} / 覆盖 ${result.updated} / 跳过 ${result.skipped} / 合计 ${result.total}`);
  if (result.errors.length) {
    log("部分错误：");
    result.errors.forEach((e) => log(`  #${e.index} ${e.email ?? "-"} -> ${e.reason}`));
  }

  if (!dryRun && (result.imported > 0 || result.updated > 0)) {
    const stamp = new Date().toISOString();
    const okEmails = new Set(candidates.map((c) => c.email.toLowerCase()));
    const next = accounts.map((a) =>
      a.ok && okEmails.has(a.email.toLowerCase()) ? { ...a, pushedAt: stamp } : a,
    );
    saveAccounts(next);
    log(`已在账号池中标记 pushedAt=${stamp}`);
  }
}

async function main() {
  // 纯查询/推送类命令，先处理
  if (args.includes("--probe")) {
    const cfg = readPushConfig();
    log(`探测远程网关 ${cfg.base || "（未配置）"} ...`);
    const res = await probeRemote();
    log(`可达，HTTP ${res.status}`);
    log(JSON.stringify(res.payload, null, 2));
    return;
  }

  if (args.includes("--status") || args.includes("-s")) {
    printStatus();
    return;
  }

  if (args.includes("--push")) {
    await runPush();
    return;
  }

  if (args.length === 0) {
    printStatus();
    console.log("用法：");
    console.log("  --one | --count N | --all | --retry | --email <邮箱>   登录账号");
    console.log("  --push [--dry-run] [--all-ok]                          推送凭据到远程网关");
    console.log("  --probe                                                探测远程网关");
    console.log("  --status                                               查看账号池");
    return;
  }

  const webLines = readList(mailPath("all_web_mail.txt")).concat(readList(mailPath("web_mail.txt")));
  const helperLines = readList(mailPath("new_mail.txt"));
  if (!webLines.length) throw new Error("没有待登录邮箱，请检查 cline-register/config/mail/all_web_mail.txt");
  if (!helperLines.length) throw new Error("没有辅助接码邮箱，请检查 cline-register/config/mail/new_mail.txt");

  let accounts = loadAccounts();
  const done = new Set(accounts.filter((a) => a.ok).map((a) => a.email.toLowerCase()));

  const specific =
    (args.find((a) => a.startsWith("--email="))?.split("=").slice(1).join("=")) ||
    (args.includes("--email") ? args[args.indexOf("--email") + 1] : "");

  let queue;
  if (specific) {
    const hit = webLines.find((l) => l.toLowerCase().startsWith(specific.toLowerCase()));
    if (!hit) throw new Error(`邮箱不在库存中: ${specific}`);
    queue = [hit];
  } else if (args.includes("--retry")) {
    const failed = new Set(accounts.filter((a) => !a.ok).map((a) => a.email.toLowerCase()));
    queue = webLines.filter((l) => failed.has(l.split("----")[0].trim().toLowerCase()));
  } else {
    queue = webLines.filter((l) => !done.has(l.split("----")[0].trim().toLowerCase()));
  }

  if (!args.includes("--all")) {
    const n = pickNumber("count", 1);
    queue = queue.slice(0, n);
  }

  if (!queue.length) { log("没有需要处理的账号"); printStatus(); return; }

  const runner = args.includes("--device") ? loginOneDevice : loginOne;
  log(`本轮处理 ${queue.length} 个账号（链路：${args.includes("--device") ? "设备码" : "回调"}，库存共 ${webLines.length}）`);

  const newlySucceeded = [];

  for (let i = 0; i < queue.length; i++) {
    const [webEmail, webPass] = queue[i].split("----").map((s) => s.trim());
    const idx = Math.max(0, webLines.indexOf(queue[i]));
    const hs = helperLines[idx % helperLines.length].split("----").map((s) => s.trim());
    const helperEmail = hs[0];
    const helperRt = hs[3];

    log(`\n>>> [${i + 1}/${queue.length}] ${webEmail} <<<`);
    try {
      const rec = await runner({ webEmail, webPass, helperEmail, helperRt, log });
      accounts = accounts.filter((a) => a.email.toLowerCase() !== webEmail.toLowerCase());
      const record = { email: webEmail, password: webPass, helperEmail, ok: true, ...rec };
      accounts.push(record);
      saveAccounts(accounts);
      updateCacheToken(rec);
      newlySucceeded.push(record);
      log(`[${i + 1}/${queue.length}] 成功: ${webEmail}`);
    } catch (e) {
      log(`[${i + 1}/${queue.length}] 失败: ${webEmail} -> ${e.message}`);
      accounts = accounts.filter((a) => a.email.toLowerCase() !== webEmail.toLowerCase());
      accounts.push({
        email: webEmail, password: webPass, helperEmail, ok: false,
        error: e.message, attemptedAt: new Date().toISOString(),
      });
      saveAccounts(accounts);
    }
    if (i + 1 < queue.length) await new Promise((r) => setTimeout(r, 2000));
  }

  log("\n本轮结束");

  // 若配置了远程网关且本轮有成功，自动推送一次
  if (newlySucceeded.length && !args.includes("--no-push")) {
    const cfg = readPushConfig();
    if (cfg.base && cfg.token) {
      try {
        log(`自动推送到远程网关 ${cfg.base} ...`);
        const result = await pushAccounts(newlySucceeded, { log });
        log(`推送结果：新增 ${result.imported} / 覆盖 ${result.updated} / 跳过 ${result.skipped}`);
        const stamp = new Date().toISOString();
        const okEmails = new Set(newlySucceeded.map((c) => c.email.toLowerCase()));
        saveAccounts(accounts.map((a) =>
          a.ok && okEmails.has(a.email.toLowerCase()) ? { ...a, pushedAt: stamp } : a,
        ));
      } catch (e) {
        log(`自动推送失败（本地凭据已保存，可稍后 --push 重试）: ${e.message}`);
      }
    } else {
      log("未配置远程网关，跳过自动推送（本地凭据已保存）");
    }
  }

  printStatus();
}

main().catch((e) => { log(`[FATAL] ${e.message}`); process.exit(1); });

