/**
 * mailPool.mjs — 邮箱库存层
 *
 * 文件约定（config/mail/ 下）：
 *   web_mail.txt    目标 web 号：邮箱----密码（只有 2 列）
 *   new_mail.txt    待用的辅助接码邮箱（≥4 列，第 4 列是 Graph refreshToken）
 *   all_web_mail.txt 辅助邮箱全量存档（≥4 列）
 *   used_mail.txt   已被使用过的辅助邮箱（注册成功后自动追加）
 *
 * 规则（与 register-for-openrouter 对齐）：
 *   - 目标账号只从 web_mail.txt 取；
 *   - 辅助邮箱从 new_mail.txt + all_web_mail.txt 合并去重，
 *     剔除 used_mail.txt 与账号池里已用过的；
 *   - 注册成功后调用 markHelperUsed() 追加到 used_mail.txt，
 *     原库存文件不动、不删行。
 */

import fs from "fs";
import path from "path";
import { mailPath } from "../paths.mjs";

export const WEB_MAIL_FILE = "web_mail.txt";
export const HELPER_NEW_FILE = "new_mail.txt";
export const HELPER_ALL_FILE = "all_web_mail.txt";
export const HELPER_USED_FILE = "used_mail.txt";

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf-8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.includes("@") && l.includes("----"));
}

/** 解析一行库存记录，保留原始行。 */
export function parseMailLine(line) {
  const fields = String(line).split("----").map((s) => s.trim());
  return {
    raw: String(line).trim(),
    fields,
    email: String(fields[0] || "").toLowerCase(),
    password: fields[1] || "",
  };
}

/** 目标 web 号：web_mail.txt 里严格 2 列的行，按邮箱去重。 */
export function loadWebMails() {
  const out = [];
  const seen = new Set();
  for (const line of readLines(mailPath(WEB_MAIL_FILE))) {
    const rec = parseMailLine(line);
    if (rec.fields.length !== 2 || !rec.email.includes("@") || !rec.password) continue;
    if (seen.has(rec.email)) continue;
    seen.add(rec.email);
    out.push(rec.raw);
  }
  return out;
}

function loadUsedHelperEmails() {
  const used = new Set();
  for (const line of readLines(mailPath(HELPER_USED_FILE))) {
    used.add(parseMailLine(line).email);
  }
  return used;
}

/**
 * 辅助接码邮箱：new_mail.txt + all_web_mail.txt 中 ≥4 列的行。
 * 按邮箱去重；剔除 used_mail.txt 里已标记的，以及 extraUsed（账号池里
 * helperEmail 字段）里已用过的。返回原始行（保持记录完整，供标记已用时存档）。
 */
export function loadHelperPool(extraUsed = []) {
  const used = loadUsedHelperEmails();
  for (const e of extraUsed) used.add(String(e || "").toLowerCase());

  const out = [];
  const seen = new Set();
  for (const name of [HELPER_NEW_FILE, HELPER_ALL_FILE]) {
    for (const line of readLines(mailPath(name))) {
      const rec = parseMailLine(line);
      if (rec.fields.length < 4 || !rec.email.includes("@")) continue;
      if (!rec.fields[3]) continue; // 必须有 Graph refreshToken
      if (seen.has(rec.email)) continue;
      seen.add(rec.email);
      if (used.has(rec.email)) continue;
      out.push(rec.raw);
    }
  }
  return out;
}

/** 标记一个辅助邮箱已用：整行追加到 used_mail.txt（不存在则自动创建）。 */
export function markHelperUsed(helperLine, { targetEmail = "" } = {}) {
  const file = mailPath(HELPER_USED_FILE);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const rec = parseMailLine(helperLine);
    const stamp = new Date().toISOString();
    const note = targetEmail ? `  # used-by ${targetEmail} @ ${stamp}` : `  # used @ ${stamp}`;
    fs.appendFileSync(file, rec.raw + note + "\n", "utf-8");
  } catch {}
}