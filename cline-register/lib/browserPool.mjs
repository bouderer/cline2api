/**
 * browserPool.mjs — 共享浏览器池
 *
 * 之前每个账号都 `chromium.launch()` 一次，跑 8 并发就是 8 个 Chrome 进程，
 * 内存直接吃掉 2–3 GB，这就是并发上不去的根本原因。
 *
 * 现在改成整个进程只启动一个 Chromium，每个账号用独立的 browser context
 * （cookie / 存储互相隔离，等价于无痕窗口）。实测同样并发下内存降一大截，
 * 因为省掉了 N 份浏览器主进程、GPU 进程和共享库。
 */

import { chromium } from "../node_modules/playwright/index.mjs";

const CHROME = process.env.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const HEADLESS = String(process.env.REGISTER_HEADLESS || "true") !== "false";

// 让并发跑得动的启动参数：关掉一堆用不上的子系统和后台行为
const LAUNCH_ARGS = [
  "--no-sandbox",
  "--disable-blink-features=AutomationControlled",
  "--disable-dev-shm-usage",
  "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows",
  "--disable-renderer-backgrounding",
  "--disable-features=Translate,BackForwardCache,AcceptCHFrame",
  "--no-first-run",
  "--no-default-browser-check",
];

export function createBrowserPool() {
  let browserPromise = null;
  let closed = false;
  let liveContexts = 0;

  async function getBrowser() {
    if (closed) throw new Error("浏览器池已关闭");
    if (!browserPromise) {
      browserPromise = chromium.launch({
        headless: HEADLESS,
        executablePath: CHROME,
        args: LAUNCH_ARGS,
      }).catch((e) => { browserPromise = null; throw e; });
    }
    return browserPromise;
  }

  return {
    /** 借一个隔离的 page（独立 cookie / storage），用完必须 release()。 */
    async acquire() {
      const browser = await getBrowser();
      const context = await browser.newContext();
      // 统一阻断 FIDO / Passkey 录入弹窗
      await context.addInitScript(() => {
        if (window.navigator?.credentials) {
          window.navigator.credentials.create = async () => {
            throw new DOMException("cancel", "NotAllowedError");
          };
        }
      });
      const page = await context.newPage();
      liveContexts += 1;

      let released = false;
      const release = async () => {
        if (released) return;
        released = true;
        liveContexts -= 1;
        await context.close().catch(() => {});
      };
      return { page, context, release };
    },

    stats() {
      return { liveContexts, started: Boolean(browserPromise) };
    },

    async close() {
      closed = true;
      const p = browserPromise;
      browserPromise = null;
      if (!p) return;
      const b = await p.catch(() => null);
      if (b) await b.close().catch(() => {});
    },
  };
}
