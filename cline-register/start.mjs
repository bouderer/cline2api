#!/usr/bin/env node
/**
 * start.mjs — 交互式启动器
 *
 * 直接 `node start.mjs` 或双击 start.cmd 即可。
 * 先展示账号池状态与远程网关配置，再问你要跑多少、并发多少，然后开始。
 *
 * 想跳过问答、直接用命令行参数，见 `node register.mjs --help`。
 */

import fs from "fs";
import readline from "node:readline/promises";
import { spawn } from "node:child_process";
import { REGISTER_DIR, mailPath, dataPath } from "./paths.mjs";
import { readPushConfig } from "./lib/push.mjs";
import { MAX_CONCURRENCY as REGISTER_MAX_CONCURRENCY } from "./lib/batch.mjs";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", bold: "\x1b[1m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};
const paint = (c, s) => `${c}${s}${C.reset}`;

const ACCOUNTS_FILE = dataPath("accounts_cline.json");
const MAX_CONCURRENCY = REGISTER_MAX_CONCURRENCY;

function readList(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8").split(/\r?\n/)
    .map((l) => l.trim()).filter((l) => l.includes("@") && l.includes("----"));
}

function loadAccounts() {
  try {
    const p = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, "utf-8"));
    return Array.isArray(p) ? p : [];
  } catch { return []; }
}

function banner() {
  console.log("");
  console.log(paint(C.cyan, "======================================================"));
  console.log(paint(C.bold, "        Cline 注册机 · 交互式启动器"));
  console.log(paint(C.cyan, "======================================================"));
  console.log("");
}

function showState() {
  const web = readList(mailPath("all_web_mail.txt")).concat(readList(mailPath("web_mail.txt")));
  const helpers = readList(mailPath("new_mail.txt"));
  const accounts = loadAccounts();
  const ok = accounts.filter((a) => a.ok);
  const bad = accounts.filter((a) => !a.ok);
  const okEmails = new Set(ok.map((a) => a.email.toLowerCase()));
  const pending = web.filter((l) => !okEmails.has(l.split("----")[0].trim().toLowerCase()));
  const remote = readPushConfig();

  console.log(paint(C.bold, "当前状态"));
  console.log(`  待登录账号库存   ${paint(C.bold, String(web.length))} 个`);
  console.log(`  辅助接码邮箱     ${paint(C.bold, String(helpers.length))} 个`);
  console.log(`  已成功登录       ${paint(C.green, String(ok.length))} 个`);
  console.log(`  失败待重试       ${paint(bad.length ? C.yellow : C.dim, String(bad.length))} 个`);
  console.log(`  剩余未处理       ${paint(C.bold, String(pending.length))} 个`);
  console.log("");
  console.log(paint(C.bold, "远程网关"));
  if (remote.base && remote.token) {
    console.log(`  ${paint(C.green, "已配置")}  ${remote.base}`);
    console.log(`  ${paint(C.dim, "每成功一个账号会自动推送（边跑边推）")}`);
  } else {
    console.log(`  ${paint(C.yellow, "未配置")}  ${paint(C.dim, "只写本地，稍后可 npm run push")}`);
  }
  console.log("");
  return { pending };
}

async function ask(rl, question, { defaultValue = "", validate } = {}) {
  for (;;) {
    const suffix = defaultValue !== "" ? paint(C.dim, ` [${defaultValue}]`) : "";
    const raw = (await rl.question(`${question}${suffix}: `)).trim();
    const value = raw === "" ? defaultValue : raw;
    const problem = validate ? validate(value) : undefined;
    if (!problem) return value;
    console.log(paint(C.red, `  ${problem}`));
  }
}

async function main() {
  banner();
  const { pending } = showState();

  if (pending.length === 0) {
    console.log(paint(C.green, "没有待处理的账号了 —— 库存里的账号都已经登录成功。"));
    console.log(paint(C.dim, "可以往 config/mail/all_web_mail.txt 里加新账号，或用 npm run retry 重试失败的。"));
    console.log("");
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  let count, concurrency;
  try {
    console.log(paint(C.bold, "请回答两个问题（直接回车用方括号里的默认值）"));
    console.log("");

    const countStr = await ask(rl, paint(C.cyan, "这次要跑多少个账号"), {
      defaultValue: "1",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return "请输入一个大于 0 的整数";
        if (n > pending.length) return `最多 ${pending.length} 个（剩余未处理数量）`;
        return undefined;
      },
    });

    const concStr = await ask(rl, paint(C.cyan, "并发数（同时开几个浏览器）"), {
      defaultValue: "1",
      validate: (v) => {
        const n = Number(v);
        if (!Number.isInteger(n) || n < 1) return "请输入一个大于 0 的整数";
        if (n > MAX_CONCURRENCY) return `上限是 ${MAX_CONCURRENCY}，再高容易把机器打爆`;
        return undefined;
      },
    });

    count = Number(countStr);
    concurrency = Number(concStr);

    console.log("");
    console.log(paint(C.bold, "即将开始"));
    console.log(`  账号数量  ${paint(C.bold, String(count))} 个`);
    console.log(`  并发数    ${paint(C.bold, String(concurrency))}`);
    if (concurrency > 3) {
      console.log(paint(C.yellow, `  注意：并发 ${concurrency} 会同时开 ${concurrency} 个 Chrome，内存与风控压力都不小`));
    }
    console.log(paint(C.dim, "  按 Ctrl+C 可中断，已成功的账号不会丢"));
    console.log("");

    const go = await ask(rl, paint(C.cyan, "确认开始？(y/N)"), { defaultValue: "n" });
    if (!/^y(es)?$/i.test(go)) {
      console.log(paint(C.dim, "已取消。"));
      console.log("");
      return;
    }
  } finally {
    rl.close();
  }

  console.log("");
  const child = spawn(
    process.execPath,
    ["register.mjs", "--count", String(count), "--concurrency", String(concurrency)],
    { cwd: REGISTER_DIR, stdio: "inherit", env: process.env },
  );
  child.on("exit", (code) => process.exit(code ?? 0));
}

main().catch((e) => {
  console.error(paint(C.red, `启动失败: ${e.message}`));
  process.exit(1);
});

