/**
 * web.mjs — 本地 Web 控制台（前端）
 *
 * 启动后打开 http://127.0.0.1:8788/ 就能：
 *   - 看到库存 / 已成功 / 剩余 / 远端配置
 *   - 设定「跑多少个」和「并发数」
 *   - 点开始，实时看每个账号的进度和日志
 *   - 随时点停止
 *
 * 只监听 127.0.0.1，不对外。
 */

import http from "node:http";
import { URL } from "node:url";
import { snapshot, runBatch, MAX_CONCURRENCY, ACCOUNTS_FILE, loadAccounts } from "./lib/batch.mjs";
import { probeRemote } from "./lib/push.mjs";
import { PAGE } from "./lib/webpage.mjs";

const HOST = process.env.REGISTER_WEB_HOST || "127.0.0.1";
const PORT = Number(process.env.REGISTER_WEB_PORT || 8788);

// ---- 当前任务状态（同一时刻只允许跑一轮）-------------------------------
let current = null;
const history = [];

function broadcast(evt) {
  if (!current) return;
  current.events.push(evt);
  if (current.events.length > 3000) current.events.splice(0, current.events.length - 3000);
  for (const res of current.subscribers) {
    try { res.write("data: " + JSON.stringify(evt) + "\n\n"); } catch {}
  }
}

function json(res, code, body) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(body));
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new Error("请求体过大");
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
  catch { throw new Error("请求体不是合法 JSON"); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://" + (req.headers.host || "localhost"));

  try {
    if (req.method === "GET" && url.pathname === "/api/state") {
      return json(res, 200, {
        snapshot: snapshot(),
        running: Boolean(current),
        current: current
          ? { total: current.total, done: current.done, ok: current.ok, fail: current.fail,
              pushed: current.pushed, concurrency: current.concurrency }
          : null,
        history: history.slice(-10),
      });
    }

    if (req.method === "GET" && url.pathname === "/api/accounts") {
      const list = loadAccounts();
      return json(res, 200, {
        ok: list.filter((a) => a.ok).length,
        failed: list.filter((a) => !a.ok).length,
        accounts: list.filter((a) => a.ok).slice(-200).reverse().map((a) => ({
          email: a.email, helperEmail: a.helperEmail,
          pushed: Boolean(a.pushedAt), boundAt: a.boundAt,
        })),
        failedAccounts: list.filter((a) => !a.ok).slice(-100).reverse().map((a) => ({
          email: a.email, error: String(a.error || "").slice(0, 200),
        })),
      });
    }

    if (req.method === "POST" && url.pathname === "/api/probe") {
      const r = await probeRemote();
      return json(res, 200, { ok: true, base: r.url, status: r.status });
    }

    if (req.method === "POST" && url.pathname === "/api/start") {
      if (current) return json(res, 409, { error: "已经有一轮在跑了，先停止或等它结束" });

      const body = await readBody(req);
      const count = Math.max(0, Number(body.count) || 0);
      const concurrency = Math.min(MAX_CONCURRENCY, Math.max(1, Number(body.concurrency) || 1));
      const mode = ["pending", "retry", "all"].includes(body.mode) ? body.mode : "pending";
      const device = Boolean(body.device);
      const push = body.push !== false;
      const email = typeof body.email === "string" ? body.email.trim() : "";

      const controller = new AbortController();
      current = {
        controller, subscribers: new Set(), events: [],
        total: 0, done: 0, ok: 0, fail: 0, pushed: 0,
        concurrency, startedAt: Date.now(),
        options: { count, concurrency, mode, device, push, email },
      };

      runBatch({
        count, concurrency, device, push, mode, email,
        signal: controller.signal,
        onEvent: (evt) => {
          if (!current) return;
          if (evt.type === "start") current.total = evt.total;
          if (evt.type === "progress") {
            current.done = evt.done; current.ok = evt.ok; current.fail = evt.fail; current.pushed = evt.pushed;
          }
          if (evt.type === "done") {
            current.done = evt.total; current.ok = evt.ok; current.fail = evt.fail; current.pushed = evt.pushed;
          }
          broadcast(evt);
        },
      }).then((result) => {
        history.push({
          at: new Date().toISOString(), ...current?.options,
          ok: result.ok, fail: result.fail, pushed: result.pushed,
          total: result.total, ms: result.ms, aborted: result.aborted,
        });
      }).catch((e) => {
        broadcast({ type: "log", level: "err", text: "批处理异常: " + e.message });
        broadcast({ type: "done", ok: 0, fail: 0, pushed: 0, total: 0, ms: 0, aborted: true, error: e.message });
      }).finally(() => {
        setTimeout(() => { current = null; }, 5000);
      });

      return json(res, 202, { started: true, concurrency, count, mode, device, push });
    }

    if (req.method === "POST" && url.pathname === "/api/stop") {
      if (!current) return json(res, 409, { error: "当前没有在跑的任务" });
      current.controller.abort();
      broadcast({ type: "log", level: "warn", text: "收到停止指令，正在收尾（已在跑的账号会跑完当前一步）…" });
      return json(res, 200, { stopping: true });
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(": connected\n\n");
      const subscribers = current ? current.subscribers : null;
      if (subscribers) {
        subscribers.add(res);
        for (const evt of current.events) {
          try { res.write("data: " + JSON.stringify(evt) + "\n\n"); } catch {}
        }
      } else {
        res.write("data: " + JSON.stringify({ type: "idle" }) + "\n\n");
      }
      const ping = setInterval(() => { try { res.write(": ping\n\n"); } catch {} }, 15000);
      req.on("close", () => { clearInterval(ping); if (subscribers) subscribers.delete(res); });
      return;
    }

    if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      return res.end(PAGE);
    }

    return json(res, 404, { error: "not found" });
  } catch (e) {
    return json(res, 500, { error: String(e.message || e) });
  }
});

server.listen(PORT, HOST, () => {
  console.log("");
  console.log("  Cline 注册机 · Web 控制台");
  console.log("  打开: http://" + HOST + ":" + PORT + "/");
  console.log("  账号池: " + ACCOUNTS_FILE);
  console.log("  按 Ctrl+C 退出");
  console.log("");
});
