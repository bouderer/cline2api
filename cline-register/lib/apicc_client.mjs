// shared/apicc_client.mjs — api.cc 接码客户端（基于 api.sms8.net / api.cc）
// 支持单号 token 轮询、号码解析、分类归属与短信提取。
import "dotenv/config";
import "../paths.mjs";
import { ProxyAgent, fetch as ufetch } from "undici";

export const HK_CATE = 4;
export const GB_CATE = 6;
export const US_CATE = 2;

export function apiccKey() {
  const k = String(process.env.APICC_API_KEY || "").trim();
  return k;
}

export function recordBase() {
  return String(process.env.APICC_RECORD_BASE || "https://api.sms8.net").trim().replace(/\/+$/, "");
}

export function apiccBase() {
  return String(process.env.APICC_BASE || "https://api.cc").trim().replace(/\/+$/, "");
}

function dispatcher() {
  const p = String(
    process.env.APICC_PROXY ||
    process.env.CAPSOLVER_PROXY ||
    process.env.GROK_PROXY ||
    process.env.PROXY_URL ||
    "http://127.0.0.1:7897"
  ).trim();
  return p ? new ProxyAgent(p) : undefined;
}

export async function rawGet(url) {
  try {
    const r = await ufetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        Accept: "application/json, text/plain, */*",
      },
      dispatcher: dispatcher(),
      signal: AbortSignal.timeout(15000),
    });
    const text = await r.text().catch(() => "");
    let json = null;
    try { json = JSON.parse(text); } catch {}
    return { status: r.status, text, json, url };
  } catch (e) {
    return { status: 0, text: String(e.message || e), json: null, url, error: e };
  }
}

export function normalizePhone(raw) {
  let d = String(raw || "").replace(/\D+/g, "");
  if (d.startsWith("00")) d = d.slice(2);
  return d;
}

export function cateOf(phone) {
  const d = normalizePhone(phone);
  if (d.startsWith("852")) return HK_CATE;
  if (d.startsWith("44")) return GB_CATE;
  if (d.startsWith("1") && (d.length === 11 || d.length === 10)) return US_CATE;
  if (d.startsWith("62")) return 7;
  return 0;
}

export function localPhone(phone) {
  const d = normalizePhone(phone);
  if (d.startsWith("852")) return d.slice(3);
  if (d.startsWith("44")) return d.slice(2);
  if (d.startsWith("1") && d.length === 11) return d.slice(1);
  return d;
}

export function dialCode(phone) {
  const d = normalizePhone(phone);
  if (d.startsWith("852")) return "852";
  if (d.startsWith("44")) return "44";
  if (d.startsWith("1")) return "1";
  return "";
}

export function countryHint(phone) {
  const c = cateOf(phone);
  if (c === HK_CATE) return { cate: c, iso: "HK", name: "香港", dial: "852" };
  if (c === GB_CATE) return { cate: c, iso: "GB", name: "英国", dial: "44" };
  if (c === US_CATE) return { cate: c, iso: "US", name: "美国", dial: "1" };
  return { cate: c, iso: "", name: "", dial: dialCode(phone) };
}

export function parsePhoneTokens() {
  const raw = String(process.env.APICC_PHONE_TOKENS || process.env.APICC_PHONES || "").trim();
  const out = [];
  if (raw) {
    for (const line of raw.split(/[\r\n,;]+/)) {
      const s = line.trim();
      if (!s) continue;
      const parts = s.split(/----+|\|/).map((x) => x.trim()).filter(Boolean);
      if (parts.length >= 2) {
        out.push({ phone: normalizePhone(parts[0]), token: parts[1], cate: cateOf(parts[0]) });
      } else if (/^[0-9a-fA-F]{16,64}$/.test(s)) {
        out.push({ phone: "", token: s, cate: 0 });
      }
    }
  }
  const key = apiccKey();
  if (key && !out.some((x) => x.token.toLowerCase() === key.toLowerCase())) {
    out.push({ phone: "", token: key, cate: 0, account: true });
  }
  return out;
}

export function extractSmsText(payload) {
  if (payload == null) return "";
  if (typeof payload === "string") {
    if (/no verification code/i.test(payload) || /暂无验证码/.test(payload)) return "";
    return payload;
  }
  if (Array.isArray(payload)) return payload.map(extractSmsText).filter(Boolean).join("\n");
  if (typeof payload === "object") {
    const code = String(payload.code || "").trim();
    if (code && !/no verification/i.test(code) && code !== "0") return code;
    for (const k of ["sms", "content", "message", "msg", "text"]) {
      const v = String(payload[k] || "").trim();
      if (v && !/no verification/i.test(v) && !/暂无验证码/.test(v) && !/success/i.test(v)) return v;
    }
    if (payload.data) return extractSmsText(payload.data);
  }
  return "";
}

export function extractCode(text, re) {
  const s = String(text || "").trim();
  if (!s || /no verification/i.test(s)) return "";
  if (/^\d{4,8}$/.test(s)) return s;
  const rx = re || new RegExp(String(process.env.YOUDAO_SMS_RE || process.env.SMS_CODE_RE || "(\\d{4,8})"));
  const m = s.match(rx);
  return m ? m[1] : "";
}

export async function pollRecord(token, { format = "json4" } = {}) {
  const tok = String(token || "").trim();
  if (!tok) throw new Error("empty record token");
  const base = recordBase();
  const url = base + "/api/record?token=" + encodeURIComponent(tok) + (format ? "&format=" + encodeURIComponent(format) : "");
  return rawGet(url);
}

export function parseRecord(r) {
  const j = r?.json;
  const text = String(r?.text || "");
  if (!j) return { ok: false, empty: true, text: text.slice(0, 200) };
  if (Number(j.code) === 404 || /404 not found/i.test(String(j.msg || ""))) {
    return { ok: false, notFound: true, text: text.slice(0, 200) };
  }
  const data = (j.data && typeof j.data === "object") ? j.data : {};
  const dataCode = String(data.code || "").trim();
  const hasValidCode = Boolean(dataCode && !/no verification/i.test(dataCode) && dataCode !== "0");
  const sms = hasValidCode ? dataCode : (extractSmsText(data) || extractSmsText(j));
  const otp = hasValidCode ? dataCode : extractCode(sms);
  const tel = data.tel || data.phone || j.tel || j.phone || "";
  const expiredDate = data.expired_date || data.end_time || "";

  return {
    ok: Boolean(otp) || hasValidCode,
    hasCode: Boolean(otp),
    code: j.code,
    msg: j.msg,
    tel: String(tel || ""),
    sms,
    otp,
    expiredDate,
    raw: j,
  };
}

export async function listNumbers() {
  const tokens = parsePhoneTokens();
  const rows = [];
  for (const t of tokens) {
    const r = await pollRecord(t.token, { format: "json4" });
    const parsed = parseRecord(r);
    rows.push({
      ...t,
      phone: t.phone || parsed.tel || "",
      cate: t.cate || cateOf(t.phone || parsed.tel || ""),
      record: parsed,
      http: r.status,
    });
  }
  return rows;
}

export function pickPreferred(rows, want = ["HK", "GB"]) {
  const ranked = [];
  for (const iso of want) {
    const cate = iso === "HK" ? HK_CATE : iso === "GB" ? GB_CATE : iso === "US" ? US_CATE : 0;
    for (const r of rows) {
      if (r.account && !r.phone) continue;
      if (r.notFound || r.record?.notFound) continue;
      if (r.cate === cate || countryHint(r.phone).iso === iso) ranked.push(r);
    }
  }
  for (const r of rows) {
    if (r.account && !r.phone) continue;
    if (!ranked.includes(r)) ranked.push(r);
  }
  return ranked;
}

export async function getNumber(service = "HK,GB") {
  const want = String(service || process.env.YOUDAO_SERVICE || "HK,GB").toUpperCase();
  const isos = want.split(/[,\s]+/).filter(Boolean);
  const rows = await listNumbers();
  const hit = pickPreferred(rows, isos)[0];
  if (!hit || (!hit.phone && hit.record?.notFound)) {
    throw new Error(
      "api.cc 没有可用号（请在 .env 中设置 APICC_PHONE_TOKENS=号码----recordToken 或 APICC_API_KEY）"
    );
  }
  return {
    status: hit.http || 200,
    text: JSON.stringify(hit.record?.raw || hit),
    json: {
      phone: hit.phone,
      number: hit.phone,
      token: hit.token,
      order: hit.token,
      cate: hit.cate,
      country: countryHint(hit.phone).iso,
      dial: countryHint(hit.phone).dial,
      local: localPhone(hit.phone),
    },
  };
}

export async function getSms(orderOrToken, { tries = 24, intervalMs = 5000, codeRe } = {}) {
  const token = String(orderOrToken || "").trim();
  if (!token) throw new Error("empty sms token");
  for (let i = 0; i < tries; i++) {
    const r = await pollRecord(token, { format: "json4" });
    const parsed = parseRecord(r);
    if (parsed.notFound && i === 0) {
      const r3 = await pollRecord(token, { format: "json3" });
      const p3 = parseRecord(r3);
      if (p3.otp) return { code: p3.otp, raw: p3.sms, polls: i + 1, tel: p3.tel };
      if (p3.notFound) throw new Error("record token 无效 (404 not found)");
    }
    if (parsed.otp) return { code: parsed.otp, raw: parsed.sms, polls: i + 1, tel: parsed.tel };
    await new Promise((r2) => setTimeout(r2, intervalMs));
  }
  throw new Error("收码超时（token=" + token.slice(0, 8) + "…，" + tries + " 次轮询无码）");
}

export async function releaseNumber() {
  return { status: 0, text: "api.cc record token 无需释放", json: null };
}

// -------------------------------------------------------------
// CLI 命令运行支持
// -------------------------------------------------------------
const args = process.argv.slice(2);
if (args.includes("--balance") || args.includes("--list") || args.includes("--probe")) {
  listNumbers().then((rows) => {
    console.log("RECORD_BASE:", recordBase());
    console.log("TOKENS CONFIGURED:", rows.length);
    for (const r of rows) {
      const phone = r.phone ? r.phone.slice(0, 4) + "****" : "(no-phone)";
      const st = r.record?.notFound ? "not-found" : (r.record?.otp ? `has-code(${r.record.otp})` : (r.record?.sms ? "has-sms" : "waiting-code"));
      console.log("-", phone, "token=" + r.token.slice(0, 8) + "…", "cate=" + r.cate, "http=" + r.http, st, (r.record?.sms || r.record?.text || "").slice(0, 80));
    }
  }).catch((e) => {
    console.log("ERR", String(e.message || e).slice(0, 300));
    process.exit(1);
  });
}
