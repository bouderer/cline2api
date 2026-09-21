import { ProxyAgent, fetch as ufetch } from "undici";

function getCapDispatcher() {
  const p = String(
    process.env.CAPSOLVER_PROXY ||
    process.env.GROK_PROXY ||
    process.env.APICC_PROXY ||
    process.env.PROXY_URL ||
    "http://127.0.0.1:7897"
  ).trim();
  return p ? new ProxyAgent(p) : undefined;
}

async function capFetch(url, opts = {}) {
  const dispatcher = getCapDispatcher();
  return ufetch(url, { ...opts, dispatcher });
}

/**
 * CapSolver 验证码求解器
 *
 * 通过 API 调用 capsolver.com 解决各类验证码，无需 GUI。
 * 支持: Cloudflare Turnstile, reCAPTCHA, hCaptcha, FunCaptcha, ImageToText
 *
 * 用法:
 *   import { solveTurnstile, solveRecaptchaV2, solveImageToText } from "./capsolver_helper.mjs";
 *
 *   const token = await solveTurnstile({
 *     apiKey: "YOUR_CAPSOLVER_API_KEY",
 *     websiteURL: "https://zenmux.ai",
 *     websiteKey: "0x4AAAAAA...",
 *   });
 */

const CAPSOLVER_API_BASE = "https://api.capsolver.com";

// ============================================================
// 通用: 创建任务 + 轮询结果
// ============================================================

/**
 * 创建 CapSolver 任务并等待结果
 * @param {string} apiKey - CapSolver API Key
 * @param {object} task - 任务对象 (含 type 和其他参数)
 * @param {number} [pollInterval=1500] - 轮询间隔 (ms)
 * @param {number} [timeout=120000] - 超时 (ms)
 * @returns {Promise<object>} - solution 对象
 */
async function createTaskAndPoll(apiKey, task, pollInterval = 1500, timeout = 120_000) {
  // 1. 创建任务
  const createResp = await capFetch(`${CAPSOLVER_API_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task,
    }),
  });

  const createText = await createResp.text();
  if (!createResp.ok) {
    throw new Error(`CapSolver createTask HTTP ${createResp.status} ${createText.slice(0, 300)}`);
  }
  let createData;
  try { createData = JSON.parse(createText); } catch {
    throw new Error(`CapSolver createTask 非 JSON ${createText.slice(0, 200)}`);
  }

  if (createData.errorId !== 0) {
    throw new Error(`CapSolver createTask error: [${createData.errorCode}] ${createData.errorDescription}`);
  }

  const taskId = createData.taskId;
  if (!taskId) {
    throw new Error("CapSolver createTask: no taskId returned");
  }

  // 2. 轮询结果
  const startTime = Date.now();

  while (Date.now() - startTime < timeout) {
    await new Promise((r) => setTimeout(r, pollInterval));

    const resultResp = await capFetch(`${CAPSOLVER_API_BASE}/getTaskResult`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientKey: apiKey,
        taskId,
      }),
    });

    if (!resultResp.ok) {
      throw new Error(`CapSolver getTaskResult HTTP error: ${resultResp.status}`);
    }

    const resultData = await resultResp.json();

    if (resultData.errorId !== 0) {
      throw new Error(`CapSolver getTaskResult error: [${resultData.errorCode}] ${resultData.errorDescription}`);
    }

    if (resultData.status === "ready") {
      return resultData.solution;
    }

    // status === "processing" → 继续轮询
  }

  throw new Error(`CapSolver polling timeout after ${timeout}ms`);
}

// ============================================================
// Cloudflare Turnstile
// ============================================================

/**
 * 解决 Cloudflare Turnstile 验证码
 *
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.websiteURL - 页面 URL
 * @param {string} options.websiteKey - Turnstile sitekey (从 data-sitekey 属性获取)
 * @param {string} [options.action] - data-action 属性值 (可选)
 * @param {string} [options.cdata] - data-cdata 属性值 (可选)
 * @param {number} [options.timeout] - 超时毫秒数
 * @returns {Promise<{token: string, userAgent: string}>} Turnstile token 和 userAgent
 */
export async function solveTurnstile({ apiKey, websiteURL, websiteKey, proxy, action, cdata, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!websiteURL) throw new Error("websiteURL is required");
  if (!websiteKey) throw new Error("websiteKey (Turnstile sitekey) is required");

  const task = {
    type: proxy ? "AntiTurnstileTask" : "AntiTurnstileTaskProxyLess",
    websiteURL,
    websiteKey,
  };
  if (proxy) task.proxy = proxy;
  if (action) task.metadata = { ...(task.metadata || {}), action };
  if (cdata) task.metadata = { ...(task.metadata || {}), cdata };

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);

  if (!solution.token) {
    throw new Error("CapSolver returned no token for Turnstile");
  }

  return {
    token: solution.token,
    userAgent: solution.userAgent || null,
  };
}

// ============================================================
// reCAPTCHA v2
// ============================================================

/**
 * 解决 reCAPTCHA v2
 *
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.websiteURL - 页面 URL
 * @param {string} options.websiteKey - reCAPTCHA sitekey
 * @param {boolean} [options.isInvisible=false] - 是否是不可见 reCAPTCHA
 * @param {string} [options.action] - pageAction (可选)
 * @param {number} [options.timeout] - 超时毫秒数
 * @returns {Promise<{token: string}>} gRecaptchaResponse token
 */
export async function solveRecaptchaV2({ apiKey, websiteURL, websiteKey, isInvisible, action, proxy, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!websiteURL) throw new Error("websiteURL is required");
  if (!websiteKey) throw new Error("websiteKey is required");

  const task = {
    type: proxy ? "ReCaptchaV2Task" : "ReCaptchaV2TaskProxyLess",
    websiteURL,
    websiteKey,
  };

  if (isInvisible) task.isInvisible = true;
  if (action) task.pageAction = action;
  if (proxy) task.proxy = proxy;

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);

  if (!solution.gRecaptchaResponse) {
    throw new Error("CapSolver returned no token for reCAPTCHA v2");
  }

  return { token: solution.gRecaptchaResponse, userAgent: solution.userAgent || null };
}

// ============================================================
// reCAPTCHA v3
// ============================================================

/**
 * 解决 reCAPTCHA v3
 */
export async function solveRecaptchaV3({ apiKey, websiteURL, websiteKey, pageAction, minScore = 0.7, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const task = {
    type: "ReCaptchaV3TaskProxyLess",
    websiteURL,
    websiteKey,
    pageAction: pageAction || "verify",
    minScore,
  };

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return { token: solution.gRecaptchaResponse };
}

// ============================================================
// hCaptcha
// ============================================================

/**
 * 解决 hCaptcha
 */
export async function solveHCaptcha({ apiKey, websiteURL, websiteKey, isInvisible, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const task = {
    type: "HCaptchaTaskProxyLess",
    websiteURL,
    websiteKey,
  };

  if (isInvisible) task.isInvisible = true;

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return { token: solution.gRecaptchaResponse };
}

// ============================================================
// FunCaptcha (Arkose Labs)
// ============================================================

/**
 * 解决 FunCaptcha
 */
export async function solveFunCaptcha({ apiKey, websiteURL, websitePublicKey, subdomain, proxy, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const task = {
    type: proxy ? "FunCaptchaTask" : "FunCaptchaTaskProxyLess",
    websiteURL,
    websitePublicKey,
  };
  if (subdomain) task.funcaptchaApiJSSubdomain = subdomain;
  if (proxy) task.proxy = proxy;

  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return { token: solution.token };
}

// ============================================================
// Image-to-Text (OCR) — 同步返回，无需轮询
// ============================================================

/**
 * 图片文字识别 (OCR)
 * 注意: 此接口同步返回结果，不需要轮询
 *
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.body - Base64 编码的图片 (不含前缀)
 * @param {string} [options.module="common"] - 模块: "common" 或 "number"
 * @returns {Promise<{text: string}>} 识别出的文字
 */
export async function solveImageToText({ apiKey, body, module = "common" }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!body) throw new Error("body (base64 image) is required");

  const resp = await capFetch(`${CAPSOLVER_API_BASE}/createTask`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      clientKey: apiKey,
      task: {
        type: "ImageToTextTask",
        body,
        module,
      },
    }),
  });

  if (!resp.ok) {
    throw new Error(`CapSolver ImageToText HTTP error: ${resp.status}`);
  }

  const data = await resp.json();

  if (data.errorId !== 0) {
    throw new Error(`CapSolver ImageToText error: [${data.errorCode}] ${data.errorDescription}`);
  }

  return { text: data.solution?.text };
}

// ============================================================
// 查询余额
// ============================================================

/**
 * 查询 CapSolver 账户余额
 * @param {string} apiKey
 * @returns {Promise<{balance: number, currency: string}>}
 */
export async function getBalance(apiKey) {
  if (!apiKey) throw new Error("CapSolver API key is required");

  const resp = await capFetch(`${CAPSOLVER_API_BASE}/getBalance`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ clientKey: apiKey }),
  });

  if (!resp.ok) {
    throw new Error(`CapSolver getBalance HTTP error: ${resp.status}`);
  }

  const data = await resp.json();

  if (data.errorId !== 0) {
    throw new Error(`CapSolver getBalance error: [${data.errorCode}] ${data.errorDescription}`);
  }

  return { balance: data.balance, currency: data.currency || "USD" };
}

// ============================================================
// DataDome Slider
// ============================================================

/**
 * 解决 DataDome Slider 验证码
 * 
 * @param {object} options
 * @param {string} options.apiKey - CapSolver API Key
 * @param {string} options.websiteURL - 页面 URL (如 https://github.com/signup)
 * @param {string} options.captchaUrl - DataDome captcha iframe URL (必须包含 t=fe)
 * @param {string} [options.userAgent] - 浏览器 User-Agent
 * @param {string} [options.proxy] - 代理 (格式: "ip:port" 或 "user:pass@ip:port")
 * @param {number} [options.timeout] - 超时毫秒数
 * @returns {Promise<{cookie: string, userAgent: string}>} datadome cookie
 */
export async function solveDataDome({ apiKey, websiteURL, captchaUrl, userAgent, proxy, timeout }) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!websiteURL) throw new Error("websiteURL is required");
  if (!captchaUrl) throw new Error("captchaUrl is required");

  const task = {
    type: "DatadomeSliderTask",
    websiteURL,
    captchaUrl,
  };

  if (userAgent) task.userAgent = userAgent;
  if (proxy) task.proxy = proxy;

  const solution = await createTaskAndPoll(apiKey, task, 2000, timeout || 120_000);

  if (!solution.cookie) {
    throw new Error("CapSolver returned no cookie for DataDome");
  }

  return {
    cookie: solution.cookie,
    userAgent: solution.userAgent || null,
  };
}

// ============================================================
// 网易易盾 Yidun
// ============================================================
export async function solveYidun({ apiKey, websiteURL, websiteKey, userAgent, proxy, timeout } = {}) {
  if (!apiKey) throw new Error("CapSolver API key is required");
  if (!websiteURL) throw new Error("websiteURL is required");
  if (!websiteKey) throw new Error("websiteKey (Yidun captchaId) is required");
  const task = {
    type: proxy ? "AntiYidunTask" : "AntiYidunTaskProxyLess",
    websiteURL,
    websiteKey,
  };
  if (userAgent) task.userAgent = userAgent;
  if (proxy) task.proxy = proxy;
  const solution = await createTaskAndPoll(apiKey, task, 1500, timeout || 120_000);
  return {
    token: solution.token || solution.validate || solution.validateToken || "",
    validate: solution.validate || solution.token || "",
    userAgent: solution.userAgent || null,
    raw: solution,
  };
}
