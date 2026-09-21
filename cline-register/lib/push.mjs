/**
 * push.mjs — 把注册机产出的 Cline 凭据推送到远程 cline2api 网关
 *
 * 远程网关需要实现 `POST /admin/api/accounts/import`（见 cline2api/README）。
 * 本模块只依赖 Node 内置能力，不引入任何第三方包。
 *
 * 环境变量（可写在 cline-register/.env 或仓库根 .env）：
 *   CLINE2API_REMOTE_URL     远程网关地址，例如 https://cline.example.com
 *   CLINE2API_ADMIN_TOKEN    远程网关的 ADMIN_TOKEN
 *   CLINE2API_IMPORT_PATH    可选，默认 /admin/api/accounts/import
 *   CLINE2API_PUSH_TIMEOUT_MS 可选，默认 30000
 *   HTTPS_PROXY / HTTP_PROXY 可选，走代理时设置
 */

const DEFAULT_IMPORT_PATH = "/admin/api/accounts/import";
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_BATCH = 500; // 单次请求最多推送多少条，避免请求体过大

function env(name, fallback = "") {
  return String(process.env[name] ?? fallback).trim();
}

export function readPushConfig() {
  const base = env("CLINE2API_REMOTE_URL").replace(/\/+$/, "");
  const token = env("CLINE2API_ADMIN_TOKEN");
  const path = env("CLINE2API_IMPORT_PATH", DEFAULT_IMPORT_PATH);
  const timeoutMs = Number(env("CLINE2API_PUSH_TIMEOUT_MS", String(DEFAULT_TIMEOUT_MS))) || DEFAULT_TIMEOUT_MS;
  return { base, token, path, timeoutMs };
}

export function assertPushConfig(cfg = readPushConfig()) {
  if (!cfg.base) {
    throw new Error("未配置 CLINE2API_REMOTE_URL（远程 cline2api 网关地址）");
  }
  if (!/^https?:\/\//i.test(cfg.base)) {
    throw new Error(`CLINE2API_REMOTE_URL 必须以 http:// 或 https:// 开头，当前: ${cfg.base}`);
  }
  if (!cfg.token) {
    throw new Error("未配置 CLINE2API_ADMIN_TOKEN（远程网关的管理令牌）");
  }
  return cfg;
}

/**
 * 把一条注册机记录转成网关导入接口要求的形状。
 * 注册机记录形如：
 *   { email, accessToken, refreshToken, expiresAt, ok, ... }
 * 网关要求：
 *   { email, access, refresh, expires, tokenType?, provider?, label? }
 *
 * @returns {object|null} null 表示该记录缺少必要字段，无法推送
 */
export function toImportRecord(rec) {
  if (!rec || typeof rec !== "object") return null;
  const email = typeof rec.email === "string" ? rec.email.trim() : "";
  const access = typeof rec.accessToken === "string" ? rec.accessToken.trim() : "";
  const refresh = typeof rec.refreshToken === "string" ? rec.refreshToken.trim() : "";
  let expires = rec.expiresAt;

  if (typeof expires === "string") {
    const numeric = Number(expires);
    expires = Number.isFinite(numeric) ? numeric : Date.parse(expires);
  }
  if (typeof expires === "number" && Number.isFinite(expires) && expires < 1e12) {
    // 秒级时间戳统一换算成毫秒，和网关内部表示保持一致
    expires *= 1000;
  }

  if (!email || !email.includes("@")) return null;
  if (!access || !refresh) return null;
  if (typeof expires !== "number" || !Number.isFinite(expires)) return null;

  return {
    email,
    access,
    refresh,
    expires,
    tokenType: "Bearer",
    provider: "cline",
    label: null,
  };
}

function chunk(list, size) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

async function postBatch(cfg, accounts, { fetchImpl = fetch } = {}) {
  const url = `${cfg.base}${cfg.path}`;
  const res = await fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      Authorization: `Bearer ${cfg.token}`,
    },
    body: JSON.stringify({ accounts }),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });

  const text = await res.text().catch(() => "");
  let payload = null;
  try { payload = JSON.parse(text); } catch {}

  if (!res.ok) {
    const detail = payload?.error?.message || payload?.error || text.slice(0, 300);
    throw new Error(`导入失败 HTTP ${res.status}${detail ? ` - ${detail}` : ""}`);
  }
  return {
    imported: Number(payload?.imported ?? 0) || 0,
    updated: Number(payload?.updated ?? 0) || 0,
    skipped: Number(payload?.skipped ?? 0) || 0,
    total: Number(payload?.total ?? accounts.length) || accounts.length,
    errors: Array.isArray(payload?.errors) ? payload.errors : [],
  };
}

/**
 * 批量推送账号到远程网关。
 *
 * @param {Array<object>} records 注册机记录（含 accessToken / refreshToken / expiresAt / email）
 * @param {{ log?: Function, fetchImpl?: typeof fetch, dryRun?: boolean }} [options]
 */
export async function pushAccounts(records, { log = console.log, fetchImpl = fetch, dryRun = false } = {}) {
  const cfg = readPushConfig();
  const mapped = [];
  const localSkipped = [];

  records.forEach((rec, index) => {
    const row = toImportRecord(rec);
    if (row) mapped.push(row);
    else localSkipped.push({ index, email: rec?.email ?? null, reason: "字段缺失或格式不正确" });
  });

  const summary = { imported: 0, updated: 0, skipped: localSkipped.length, total: records.length, errors: [...localSkipped] };

  if (mapped.length === 0) {
    log(`没有可推送的记录（共 ${records.length} 条，全部字段不完整）`);
    return summary;
  }

  if (dryRun) {
    log(`[dry-run] 将推送 ${mapped.length} 条到 ${cfg.base || "<未配置>"}${cfg.path}`);
    mapped.slice(0, 3).forEach((r) => log(`  - ${r.email} expires=${new Date(r.expires).toISOString()}`));
    if (mapped.length > 3) log(`  ... 其余 ${mapped.length - 3} 条`);
    return { ...summary, total: records.length };
  }

  assertPushConfig(cfg);
  log(`推送到 ${cfg.base}${cfg.path}，共 ${mapped.length} 条（分 ${chunk(mapped, MAX_BATCH).length} 批）`);

  for (const batch of chunk(mapped, MAX_BATCH)) {
    const res = await postBatch(cfg, batch, { fetchImpl });
    summary.imported += res.imported;
    summary.updated += res.updated;
    summary.skipped += res.skipped;
    if (res.errors.length) summary.errors.push(...res.errors);
    log(`  本批 ${batch.length} 条 -> 新增 ${res.imported} / 覆盖 ${res.updated} / 跳过 ${res.skipped}`);
  }

  // 只保留前 20 条错误，避免刷屏
  summary.errors = summary.errors.slice(0, 20);
  return summary;
}

/**
 * 探测远程网关是否可达、令牌是否有效。
 */
export async function probeRemote({ fetchImpl = fetch } = {}) {
  const cfg = readPushConfig();
  assertPushConfig(cfg);
  const url = `${cfg.base}/admin/api/status`;
  const res = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${cfg.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
  const text = await res.text().catch(() => "");
  let payload = null;
  try { payload = JSON.parse(text); } catch {}
  if (!res.ok) {
    const detail = payload?.error?.message || payload?.error || text.slice(0, 200);
    throw new Error(`探测失败 HTTP ${res.status}${detail ? ` - ${detail}` : ""}`);
  }
  return { url: cfg.base, status: res.status, payload };
}
