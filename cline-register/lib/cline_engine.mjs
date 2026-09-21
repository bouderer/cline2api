/**
 * cline_engine.mjs — Cline 账号登录核心引擎
 *
 * 主链路（已验证可用）= 扩展回调流程：
 *   1) GET  /api/v1/auth/authorize?client_type=extension&callback_url=http://127.0.0.1:PORT/auth
 *      该请求 302 到 WorkOS，把 provider 换成 MicrosoftOAuth 即可直达微软登录
 *   2) 浏览器自动登录 Outlook；遇“添加备用邮箱”风控时用本地带 Graph API 的邮箱接码
 *   3) 跳过 FIDO/Passkey，接受微软授权同意页
 *   4) Cline 授权页点击 [Authorize]，浏览器回调到本地 127.0.0.1 拿 code
 *   5) POST /api/v1/auth/token 换 Cline 正式令牌
 *
 * 备用链路 = WorkOS 设备码（部分账号会触发 Radar 手机验证，故仅作兜底）
 */

import { chromium } from "../node_modules/playwright/index.mjs";
import fs from "fs";
import path from "path";
import http from "node:http";
import { LOG_DIR } from "../paths.mjs";

const CLINE_API = String(process.env.CLINE_API_BASE_URL || "https://api.cline.bot").replace(/\/+$/, "");
const WORKOS_API = String(process.env.WORKOS_API_BASE_URL || "https://api.workos.com").replace(/\/+$/, "");
const WORKOS_CLIENT_ID = process.env.WORKOS_CLIENT_ID || "client_01K3A541FN8TA3EPPHTD2325AR";
const GRAPH_CLIENT_ID = "9e5f94bc-e8a4-4e73-b8be-63364c29d753";
const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HEADLESS = String(process.env.REGISTER_HEADLESS || "true") !== "false";
const CALLBACK_PORTS = [48801, 48802, 48803, 48804, 48805, 48806];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ================= 辅助邮箱 Graph 接码 ================= */

export async function fetchGraphAccessToken(clientId, refreshToken) {
  const res = await fetch("https://login.microsoftonline.com/consumers/oauth2/v2.0/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: String(clientId || GRAPH_CLIENT_ID).trim(),
      grant_type: "refresh_token",
      refresh_token: String(refreshToken || "").trim().replace(/\$\$$/, ""),
      scope: "https://graph.microsoft.com/.default offline_access",
    }),
    signal: AbortSignal.timeout(20000),
  });
  const data = await res.json().catch(() => ({}));
  if (!data.access_token) throw new Error(`辅助邮箱 Graph 令牌获取失败: ${data.error || res.status}`);
  return data.access_token;
}

export async function pollGraphCode(graphToken, afterMs, maxWaitMs = 40000) {
  const started = Date.now();
  while (Date.now() - started < maxWaitMs) {
    try {
      const res = await fetch(
        "https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages?$top=8&$orderby=receivedDateTime%20desc",
        { headers: { Authorization: `Bearer ${graphToken}` }, signal: AbortSignal.timeout(15000) },
      );
      const data = await res.json().catch(() => ({}));
      for (const msg of data.value || []) {
        const at = Date.parse(msg.receivedDateTime || "");
        if (!Number.isFinite(at) || at < afterMs) continue;
        const text = `${msg.subject || ""} ${msg.bodyPreview || ""} ${msg.body?.content || ""}`;
        if (!/安全代码|security code/i.test(text)) continue;
        const m = text.match(/安全代码[：:\s]*(\d{6,7})/) || text.match(/[Ss]ecurity code[：:\s]*(\d{6,7})/) || text.match(/(\d{6})/);
        if (m) return m[1] || m[0];
      }
    } catch {}
    await sleep(2000);
  }
  return null;
}

/* ================= 本地回调接收 ================= */

export function listenCallback() {
  return new Promise((resolve, reject) => {
    let idx = 0;
    const next = () => {
      if (idx >= CALLBACK_PORTS.length) return reject(new Error("本地回调端口全部被占用"));
      const port = CALLBACK_PORTS[idx++];
      let resolveCode;
      const codePromise = new Promise((r) => { resolveCode = r; });
      const server = http.createServer((req, res) => {
        const url = new URL(req.url || "/", `http://127.0.0.1:${port}`);
        res.setHeader("Content-Type", "text/html; charset=utf-8");
        const code = url.searchParams.get("code");
        res.end(code ? "<h2>授权成功，可以关闭此页面。</h2>" : "<h2>等待授权…</h2>");
        if (code) resolveCode(code);
      });
      server.once("error", next);
      server.listen(port, "127.0.0.1", () => {
        resolve({ port, callbackUrl: `http://127.0.0.1:${port}/auth`, code: codePromise,
          close: () => new Promise((d) => server.close(() => d())) });
      });
    };
    next();
  });
}

/* ================= WorkOS 设备码（备用） ================= */

export async function startDeviceAuthorization() {
  const res = await fetch(`${WORKOS_API}/user_management/authorize/device`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: WORKOS_CLIENT_ID }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let device; try { device = JSON.parse(text); } catch {}
  if (!res.ok || !device?.device_code) throw new Error(`WorkOS 设备码申请失败 HTTP ${res.status}`);
  return device;
}

export async function pollDeviceTokens(device, { timeoutMs = 300000 } = {}) {
  const deadline = Date.now() + Math.min(timeoutMs, (device.expires_in || 300) * 1000);
  let interval = Math.max(2, device.interval || 5);
  while (Date.now() < deadline) {
    await sleep(interval * 1000);
    const res = await fetch(`${WORKOS_API}/user_management/authenticate`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: device.device_code, client_id: WORKOS_CLIENT_ID,
      }),
      signal: AbortSignal.timeout(30000),
    });
    const text = await res.text();
    let p; try { p = JSON.parse(text); } catch {}
    if (res.ok && typeof p?.access_token === "string") return { accessToken: p.access_token, refreshToken: p.refresh_token };
    if (p?.error === "authorization_pending") continue;
    if (p?.error === "slow_down") { interval += 2; continue; }
    if (["access_denied", "expired_token", "invalid_grant"].includes(p?.error)) throw new Error(`设备码登录失败: ${p?.error_description || p.error}`);
    if (!res.ok && res.status >= 500) continue;
    throw new Error(`设备码轮询失败 HTTP ${res.status}`);
  }
  throw new Error("设备码登录超时");
}

/* ================= Cline 会话注册 ================= */

export async function registerClineSession(workos) {
  const res = await fetch(`${CLINE_API}/api/v1/auth/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ accessToken: workos.accessToken, refreshToken: workos.refreshToken }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch {}
  if (!res.ok || typeof data?.data?.accessToken !== "string") {
    throw new Error(`Cline 会话注册失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return {
    accessToken: data.data.accessToken,
    refreshToken: typeof data.data.refreshToken === "string" ? data.data.refreshToken : workos.refreshToken,
    expiresAt: data.data.expiresAt,
  };
}

export async function exchangeAuthorizationCode(code, callbackUrl) {
  const res = await fetch(`${CLINE_API}/api/v1/auth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ grant_type: "authorization_code", code, client_type: "extension", redirect_uri: callbackUrl }),
    signal: AbortSignal.timeout(30000),
  });
  const text = await res.text();
  let data; try { data = JSON.parse(text); } catch {}
  if (!res.ok || typeof data?.data?.accessToken !== "string") {
    throw new Error(`授权码换令牌失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
  }
  return { accessToken: data.data.accessToken, refreshToken: data.data.refreshToken, expiresAt: data.data.expiresAt };
}

/* ================= 浏览器安全流转 ================= */

async function titleOf(page) { try { return await page.title(); } catch { return ""; } }
async function textOf(page) { try { return (await page.innerText("body")).replace(/\s+/g, " "); } catch { return ""; } }

/**
 * 自动完成微软登录 + 各类安全页（备用邮箱接码 / FIDO 跳过 / 同意 / Cline 授权）。
 * 返回 true 表示成功抵达本地回调。
 */
export async function driveLogin({ page, webEmail, webPass, helperEmail, helperRt, callbackUrl, log = () => {} }) {
  let graphToken = null;
  const graph = async () => (graphToken ??= await fetchGraphAccessToken(GRAPH_CLIENT_ID, helperRt));

  // 邮箱
  await page.waitForSelector("input[name=loginfmt], input[type=email]", { timeout: 25000 });
  await page.fill("input[name=loginfmt], input[type=email]", webEmail);
  await (await page.$("#idSIButton9, input[type=submit], button[type=submit]")).click();
  log("   已提交邮箱");

  // 密码
  let pw = null;
  for (let i = 0; i < 14; i++) {
    await sleep(1500);
    try {
      for (const x of await page.$$("input[type=password]")) if (await x.isVisible()) { pw = x; break; }
      if (pw) break;
      const up = await page.getByText("使用密码", { exact: false });
      if (await up.count()) await up.first().click().catch(() => {});
    } catch {}
  }
  if (!pw) throw new Error("未找到密码输入框");
  await pw.fill(webPass);
  await (await page.$("#idSIButton9, input[type=submit], button[type=submit]")).click();
  log("   已提交密码");

  for (let step = 0; step < 24; step++) {
    await sleep(2600);
    const url = page.url();
    const title = await titleOf(page);
    const text = await textOf(page);

    if (url.startsWith("http://127.0.0.1") || url.startsWith("http://localhost")) return true;
    if (/policy_denied|radar-challenge/.test(url)) {
      throw new Error(url.includes("radar-challenge") ? "被要求手机号验证（Radar）" : "Cline 拒绝授权（policy_denied）");
    }

    // 风控：绑定备用邮箱 / 输入验证码
    if (url.includes("credentialaction") || title.includes("保护你的帐户") || title.includes("输入你的代码") || text.includes("输入你的代码")) {
      if (title.includes("输入你的代码") || text.includes("输入我们发送到")) {
        log("   -> 拉取邮箱安全代码");
        const code = await pollGraphCode(await graph(), Date.now() - 45000, 40000);
        if (!code) throw new Error("未能从辅助邮箱获取安全代码");
        log(`   -> 安全代码 ${code}`);
        const inp = await page.waitForSelector("input", { timeout: 15000 });
        await inp.click();
        await page.keyboard.type(String(code), { delay: 90 });
        await sleep(4000);
        continue;
      }
      const addBtn = await page.$("button:has-text('添加电子邮件'), input[value='添加电子邮件'], #iLandingViewAction");
      if (addBtn && (await addBtn.isVisible())) { log("   -> 点击 [添加电子邮件]"); await addBtn.click().catch(() => {}); await sleep(2500); continue; }
      const em = await page.$("input[type=email], input[type=text], #EmailAddress");
      if (em && (await em.isVisible())) {
        log(`   -> 填入辅助邮箱 ${helperEmail}`);
        await em.fill(helperEmail); await sleep(400);
        const sb = await page.$("input[type=submit], button[type=submit], #iNext, button:has-text('下一步')");
        if (sb) { await sb.click().catch(() => {}); await sleep(3500); }
        continue;
      }
    }

    // 条款更新
    if (url.includes("tou/accrue") || title.includes("更新条款")) {
      log("   -> 确认服务协议更新");
      const n = await page.$("#iNext, input[type=submit], button[type=submit]");
      if (n) { await n.click().catch(() => {}); continue; }
    }

    // FIDO / Passkey
    if (url.includes("fido/create")) {
      log("   -> 跳过 FIDO 通行密钥");
      const s = await page.$("#idBtn_Back, a[id*=Cancel], button[id*=Cancel], input[id*=Cancel], button:has-text('跳过')");
      if (s && (await s.isVisible())) { await s.click().catch(() => {}); await sleep(2500); continue; }
    }

    // Cline 授权确认页
    if (url.includes("app.cline.bot/auth/callback")) {
      const b = await page.$("button:has-text('Authorize'), button:has-text('授权'), button[type=submit]");
      if (b && (await b.isVisible())) { log("   -> 点击 [Authorize]"); await b.click().catch(() => {}); await sleep(3000); continue; }
    }

    // 通用确认
    const btn = await page.$(
      "#idSIButton9, input[value=是], input[value=接受], input[value=Accept], button:has-text('继续'), button:has-text('接受'), button:has-text('Authorize'), button:has-text('是')",
    );
    if (btn && (await btn.isVisible())) { await btn.click().catch(() => {}); continue; }
  }
  throw new Error("安全流转步数用尽，未收到回调");
}

/* ================= 对外主入口 ================= */

async function launch() {
  const browser = await chromium.launch({ headless: HEADLESS, executablePath: CHROME, args: ["--no-sandbox", "--disable-blink-features=AutomationControlled"] });
  const context = await browser.newContext();
  await context.addInitScript(() => {
    if (window.navigator?.credentials) {
      window.navigator.credentials.create = async () => { throw new DOMException("cancel", "NotAllowedError"); };
    }
  });
  return { browser, page: await context.newPage() };
}

/** 主链路：扩展回调流程。 */
export async function loginOne({ webEmail, webPass, helperEmail, helperRt, log = () => {} }) {
  log(`[目标账号] ${webEmail}`);
  log(`[辅助接码] ${helperEmail}`);

  const waiter = await listenCallback();
  log(`1. 本地回调已监听: ${waiter.callbackUrl}`);

  const az = new URL("/api/v1/auth/authorize", CLINE_API);
  az.searchParams.set("client_type", "extension");
  az.searchParams.set("callback_url", waiter.callbackUrl);
  az.searchParams.set("redirect_uri", waiter.callbackUrl);
  const ares = await fetch(az, { redirect: "manual" });
  const loc = new URL(ares.headers.get("location"));
  loc.searchParams.set("provider", "MicrosoftOAuth");

  const { browser, page } = await launch();
  try {
    log("2. 打开微软授权页并自动登录");
    await page.goto(loc.toString(), { waitUntil: "domcontentloaded", timeout: 45000 });
    await driveLogin({ page, webEmail, webPass, helperEmail, helperRt, callbackUrl: waiter.callbackUrl, log });

    log("3. 等待回调授权码");
    const code = await Promise.race([waiter.code, sleep(20000).then(() => null)]);
    if (!code) {
      const shot = path.join(LOG_DIR, `fail_${String(webEmail).split("@")[0]}.png`);
      await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
      throw new Error(`未收到回调授权码，截图: ${shot}`);
    }

    log("4. 换取 Cline 令牌");
    const tokens = await exchangeAuthorizationCode(code, waiter.callbackUrl);
    log(`>>> 成功: ${webEmail} <<<`);
    return { email: webEmail, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, boundAt: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
    await waiter.close().catch(() => {});
  }
}

/** 备用链路：WorkOS 设备码（备用邮箱接码仍可用）。 */
export async function loginOneDevice({ webEmail, webPass, helperEmail, helperRt, log = () => {} }) {
  const device = await startDeviceAuthorization();
  log(`1. 设备码: ${device.user_code}`);
  const { browser, page } = await launch();
  try {
    await page.goto(device.verification_uri_complete || device.verification_uri, { waitUntil: "domcontentloaded" });
    await sleep(2500);
    const c = await page.$("button[type=submit]");
    if (c) { await c.click().catch(() => {}); await sleep(2500); }
    const ms = await page.$("a:has-text('Microsoft'), button:has-text('Microsoft')");
    if (ms && (await ms.isVisible())) { await ms.click(); await sleep(3000); }
    await driveLogin({ page, webEmail, webPass, helperEmail, helperRt, callbackUrl: "", log });
    const tokens = await pollDeviceTokens(device, { timeoutMs: 120000 });
    const cline = await registerClineSession(tokens);
    return { email: webEmail, ...cline, boundAt: new Date().toISOString() };
  } finally {
    await browser.close().catch(() => {});
  }
}
