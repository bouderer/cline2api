/**
 * proxyPool.mjs — 住宅代理池
 *
 * 背景：注册机的浏览器走系统代理（出口一个固定 IP），而 Node 的 fetch 是直连
 * （出口是本地运营商）。同一个账号前半程在"美国"、后半程在"广州"，这个地理跳变
 * 本身就是风控信号；而且高并发时几十个账号挤在同一个出口 IP 上打 Cloudflare，
 * 会被限流掐断（ERR_CONNECTION_CLOSED / ERR_TIMED_OUT）。
 *
 * 这个模块把 config/proxy/*.txt 里的住宅代理读进来，给每个账号分配一个，
 * 并且让浏览器和 Node 两侧走同一个出口。
 *
 * 文件格式（每行一个）：
 *   http://user:pass@host:port
 *   host:port:user:pass
 */

import fs from "node:fs";
import path from "node:path";
import { CONFIG_DIR } from "../paths.mjs";

const DEFAULT_FILES = [
  "as21928_http.txt",
  "as20057_http.txt",
  "as22394_http.txt",
  "proxy_443_backup_http.txt",
];

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

/** 把一行文本解析成 { server, username, password, raw } */
export function parseProxyLine(line) {
  const s = String(line || "").trim();
  if (!s || s.startsWith("#")) return null;

  // 形式一：URL
  if (/^https?:\/\//i.test(s)) {
    try {
      const u = new URL(s);
      if (!u.hostname || !u.port) return null;
      return {
        server: `${u.protocol}//${u.hostname}:${u.port}`,
        username: decodeURIComponent(u.username || ""),
        password: decodeURIComponent(u.password || ""),
        raw: s,
      };
    } catch { return null; }
  }

  // 形式二：host:port:user:pass
  const parts = s.split(":");
  if (parts.length >= 4) {
    const [host, port, ...rest] = parts;
    const pass = rest.pop();
    const user = rest.join(":");
    if (!host || !port) return null;
    return { server: `http://${host}:${port}`, username: user, password: pass, raw: s };
  }
  return null;
}

/** 读一个代理文件 */
export function readProxyFile(file) {
  try {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, "utf-8")
      .split(/\r?\n/)
      .map(parseProxyLine)
      .filter(Boolean);
  } catch { return []; }
}

/** 读出所有配置的代理池文件，合并去重 */
export function loadProxyPool() {
  const configured = env("REGISTER_PROXY_FILES");
  const names = configured
    ? configured.split(",").map((x) => x.trim()).filter(Boolean)
    : DEFAULT_FILES;

  const seen = new Set();
  const out = [];
  for (const name of names) {
    const file = path.isAbsolute(name) ? name : path.join(CONFIG_DIR, "proxy", name);
    for (const p of readProxyFile(file)) {
      if (seen.has(p.raw)) continue;
      seen.add(p.raw);
      out.push(p);
    }
  }
  return out;
}

/** 取 Playwright newContext 需要的代理对象 */
export function toPlaywrightProxy(p) {
  if (!p) return undefined;
  return {
    server: p.server,
    ...(p.username ? { username: p.username } : {}),
    ...(p.password ? { password: p.password } : {}),
  };
}

/**
 * 给一批账号分配代理。
 * 按 `REGISTER_PROXY_MODE` 决定：round-robin（默认）或 random。
 * 返回和输入等长的数组，元素可能为 null（池为空时表示直连/系统代理）。
 */
export function assignProxies(count, { pool, mode, log = () => {} } = {}) {
  const list = pool || loadProxyPool();
  if (!list.length) {
    log("未找到可用代理，将沿用系统代理/直连");
    return new Array(count).fill(null);
  }
  const m = String(mode || env("REGISTER_PROXY_MODE", "round")).toLowerCase();
  const out = [];
  for (let i = 0; i < count; i++) {
    if (m === "random") out.push(list[Math.floor(Math.random() * list.length)]);
    else out.push(list[i % list.length]);
  }
  return out;
}

/** 给 undici 用的 ProxyAgent 目标（带认证） */
export function toProxyUrl(p) {
  if (!p) return "";
  if (!p.username) return p.server;
  const u = new URL(p.server);
  u.username = encodeURIComponent(p.username);
  u.password = encodeURIComponent(p.password || "");
  return u.toString();
}

/** 脱敏显示，用于日志 */
export function describeProxy(p) {
  if (!p) return "(无代理)";
  try {
    const u = new URL(p.server);
    return `${u.hostname}:${u.port}`;
  } catch { return "(代理)"; }
}
