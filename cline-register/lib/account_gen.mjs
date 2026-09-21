/**
 * 按 README 规则从邮箱生成 GitHub 用户名和密码
 *
 * 用户名 = @前部分，从第1个字符每隔一个取 + "outlook"
 * 密码   = @前部分，从第2个字符每隔一个取 + "outlook123"
 *
 * 例: cgxdcqxey → cxcxyoutlook / gdqeoutlook123
 */
import { readFileSync } from "fs";

export function generateAccount(localPart) {
  const chars = localPart.replace(/[^a-z0-9]/gi, "").split("");
  if (!chars.length) throw new Error("空邮箱前缀");

  // 用户名: 位置 1,3,5,...
  let user = "";
  for (let i = 0; i < chars.length; i += 2) user += chars[i];
  // 密码: 位置 2,4,6,...
  let pass = "";
  for (let i = 1; i < chars.length; i += 2) pass += chars[i];

  return {
    username: user + "outlook",
    password: pass + "outlook123",
  };
}

// 从 new_mail.txt 取下一个未注册邮箱
export function loadEmails(path = "new_mail.txt") {
  return readFileSync(path, "utf-8")
    .split("\n")
    .map(l => l.trim())
    .filter(l => l.includes("@outlook.com"));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const local = process.argv[2];
  if (local) {
    const a = generateAccount(local);
    console.log(`邮箱前缀: ${local}`);
    console.log(`用户名: ${a.username}`);
    console.log(`密码:   ${a.password}`);
  } else {
    // 列出从 bcofchham 之后下一个未注册
    const emails = loadEmails();
    console.log("=== 全部邮箱及生成的账号 ===");
    for (const e of emails) {
      const local = e.split("@")[0];
      const a = generateAccount(local);
      console.log(`${e}  |  user=${a.username}  |  pass=${a.password}`);
    }
  }
}
