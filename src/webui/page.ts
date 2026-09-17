/**
 * Single-file admin UI. Kept as a TS string so `tsc` needs no asset copy step.
 * All user-supplied values are written with textContent, never innerHTML.
 */
export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cline2api 管理台</title>
<style>
  :root { color-scheme: light dark; --fg:#111; --muted:#666; --line:#e3e3e3; --accent:#2b6cb0; --bg:#fff; --panel:#fafafa; --err:#c53030; --ok:#2f855a; }
  @media (prefers-color-scheme: dark) {
    :root { --fg:#e8e8e8; --muted:#9aa0a6; --line:#333; --accent:#63b3ed; --bg:#161616; --panel:#1e1e1e; --err:#fc8181; --ok:#68d391; }
  }
  * { box-sizing:border-box; }
  body { margin:0; padding:28px 20px 60px; font:14px/1.55 ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Microsoft YaHei",sans-serif; background:var(--bg); color:var(--fg); }
  main { max-width:900px; margin:0 auto; }
  h1 { font-size:20px; margin:0 0 4px; }
  h2 { font-size:15px; margin:28px 0 10px; }
  .sub { color:var(--muted); margin:0 0 20px; }
  .card { border:1px solid var(--line); border-radius:10px; padding:16px; background:var(--panel); }
  button { font:inherit; padding:7px 13px; border-radius:8px; border:1px solid var(--line); background:var(--bg); color:var(--fg); cursor:pointer; }
  button:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  button:disabled { opacity:.5; cursor:not-allowed; }
  button.primary { background:var(--accent); color:#fff; border-color:var(--accent); }
  button.primary:hover:not(:disabled) { color:#fff; opacity:.9; }
  table { width:100%; border-collapse:collapse; }
  th,td { text-align:left; padding:8px 6px; border-bottom:1px solid var(--line); font-size:13px; vertical-align:top; }
  th { color:var(--muted); font-weight:600; }
  code,kbd { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:12.5px; }
  .code { background:var(--bg); border:1px solid var(--line); border-radius:8px; padding:10px 12px; display:inline-block; user-select:all; }
  .big { font-size:22px; letter-spacing:2px; font-weight:600; }
  .row { display:flex; gap:14px; align-items:center; flex-wrap:wrap; }
  .qr { background:#fff; padding:8px; border-radius:10px; border:1px solid var(--line); line-height:0; }
  .qr svg { width:200px; height:200px; display:block; }
  .muted { color:var(--muted); }
  .err { color:var(--err); }
  .ok { color:var(--ok); }
  .pill { display:inline-block; padding:1px 8px; border-radius:999px; border:1px solid var(--line); font-size:12px; }
  #toast { position:fixed; left:50%; bottom:26px; transform:translateX(-50%); background:#222; color:#fff; padding:9px 16px; border-radius:9px; opacity:0; transition:opacity .2s; pointer-events:none; }
  #toast.show { opacity:.95; }
</style>
</head>
<body>
<main>
  <h1>cline2api 管理台</h1>
  <p class="sub">自托管 Cline 反代 · WorkOS 设备码登录 · 自动续期</p>

  <div class="card">
    <div class="row" style="justify-content:space-between">
      <div>
        <div class="muted" id="statusLine">加载中…</div>
        <div style="margin-top:6px">
          Base URL：<span class="code" id="baseUrl">-</span>
        </div>
      </div>
      <div class="row">
        <button id="refreshBtn">刷新</button>
        <button class="primary" id="loginBtn">登录新账号</button>
      </div>
    </div>
    <div id="loginBox" style="display:none; margin-top:18px; border-top:1px solid var(--line); padding-top:16px">
      <div class="row" style="align-items:flex-start">
        <div class="qr" id="qrHolder"></div>
        <div>
          <div class="muted">在浏览器中打开下面的链接，或扫描左侧二维码：</div>
          <div style="margin:8px 0"><a id="verifyLink" href="#" target="_blank" rel="noreferrer"></a></div>
          <div class="muted">设备码</div>
          <div class="big" id="userCode">-</div>
          <div class="muted" style="margin-top:8px" id="loginState"></div>
          <div style="margin-top:12px"><button id="cancelBtn">取消本次登录</button></div>
        </div>
      </div>
    </div>
  </div>

  <h2>已登录账号</h2>
  <table>
    <thead><tr><th>账号</th><th>状态</th><th>令牌到期</th><th></th></tr></thead>
    <tbody id="accountsBody"><tr><td colspan="4" class="muted">加载中…</td></tr></tbody>
  </table>
  <p class="muted" style="margin-top:10px">令牌只保存在服务端 <code>data/accounts.json</code>（0600 权限），页面和日志都不会显示。</p>
</main>
<div id="toast"></div>
<script>
  var adminToken = new URLSearchParams(location.search).get("token") || "";
  var pollTimer = null;
  var currentSession = null;

  function headers(extra) {
    var h = extra || {};
    if (adminToken) h["Authorization"] = "Bearer " + adminToken;
    return h;
  }
  function toast(msg) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.add("show");
    setTimeout(function () { t.classList.remove("show"); }, 2200);
  }
  function fmt(ts) {
    if (!ts) return "-";
    var d = new Date(ts);
    var mins = Math.round((ts - Date.now()) / 60000);
    var rel = mins <= 0 ? "已过期" : "剩余 " + mins + " 分钟";
    return d.toLocaleString() + "（" + rel + "）";
  }
  async function api(path, options) {
    var res = await fetch(path, options || {});
    if (!res.ok) {
      var text = await res.text();
      throw new Error(text || ("HTTP " + res.status));
    }
    return res.status === 204 ? null : res.json();
  }
  async function loadStatus() {
    try {
      var data = await api("/admin/api/status", { headers: headers() });
      document.getElementById("statusLine").textContent =
        "账号 " + data.accounts.active + " 个可用 / 共 " + data.accounts.total +
        " 个 · 模型 " + data.models.count + " 个 · 上游 " + data.upstream;
      document.getElementById("baseUrl").textContent = location.origin + "/v1";
    } catch (e) {
      document.getElementById("statusLine").textContent = "状态读取失败：" + e.message;
    }
  }
  async function loadAccounts() {
    var body = document.getElementById("accountsBody");
    try {
      var data = await api("/admin/api/accounts", { headers: headers() });
      if (!data.accounts.length) {
        body.innerHTML = '<tr><td colspan="4" class="muted">还没有账号，点击右上角“登录新账号”。</td></tr>';
        return;
      }
      body.innerHTML = "";
      data.accounts.forEach(function (a) {
        var tr = document.createElement("tr");
        var td1 = document.createElement("td");
        td1.textContent = a.email || a.id;
        var td2 = document.createElement("td");
        var pill = document.createElement("span");
        pill.className = "pill" + (a.disabled ? " err" : " ok");
        pill.textContent = a.disabled ? "需重新登录" : "可用";
        td2.appendChild(pill);
        if (a.disabled && a.lastError) {
          var note = document.createElement("div");
          note.className = "muted";
          note.textContent = a.lastError;
          td2.appendChild(note);
        }
        var td3 = document.createElement("td");
        td3.textContent = fmt(a.expiresAt);
        var td4 = document.createElement("td");
        var del = document.createElement("button");
        del.textContent = "删除";
        del.onclick = function () { removeAccount(a.id); };
        td4.appendChild(del);
        tr.appendChild(td1); tr.appendChild(td2); tr.appendChild(td3); tr.appendChild(td4);
        body.appendChild(tr);
      });
    } catch (e) {
      body.innerHTML = '<tr><td colspan="4" class="err"></td></tr>';
      body.querySelector("td").textContent = "账号读取失败：" + e.message;
    }
  }
  async function removeAccount(id) {
    if (!confirm("确定删除该账号？删除后需要重新登录。")) return;
    try {
      await api("/admin/api/accounts/" + encodeURIComponent(id), { method: "DELETE", headers: headers() });
      toast("已删除");
      await Promise.all([loadAccounts(), loadStatus()]);
    } catch (e) { toast("删除失败：" + e.message); }
  }
  function showLogin(session) {
    currentSession = session;
    document.getElementById("loginBox").style.display = "block";
    document.getElementById("qrHolder").innerHTML = session.qrSvg || "";
    document.getElementById("userCode").textContent = session.userCode || "-";
    var link = document.getElementById("verifyLink");
    link.href = session.verificationUriComplete || session.verificationUri || "#";
    link.textContent = session.verificationUriComplete || session.verificationUri || "";
    setLoginState("等待浏览器确认…");
    startPolling();
  }
  function setLoginState(text, isErr) {
    var el = document.getElementById("loginState");
    el.textContent = text;
    el.className = isErr ? "err" : "muted";
  }
  function startPolling() {
    stopPolling();
    pollTimer = setInterval(pollLogin, 2000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }
  async function pollLogin() {
    if (!currentSession) return;
    try {
      var s = await api("/admin/api/login/" + encodeURIComponent(currentSession.id), { headers: headers() });
      if (s.status === "pending") { setLoginState("等待浏览器确认…"); return; }
      stopPolling();
      if (s.status === "approved") {
        setLoginState("登录成功，已保存账号" + (s.email ? "：" + s.email : ""), false);
        toast("登录成功");
        await Promise.all([loadAccounts(), loadStatus()]);
      } else {
        setLoginState("登录未完成：" + s.status + (s.error ? " - " + s.error : ""), true);
      }
    } catch (e) { setLoginState("轮询失败：" + e.message, true); }
  }
  document.getElementById("loginBtn").onclick = async function () {
    var btn = this;
    btn.disabled = true;
    try {
      var session = await api("/admin/api/login/start", { method: "POST", headers: headers() });
      showLogin(session);
    } catch (e) { toast("发起登录失败：" + e.message); }
    finally { btn.disabled = false; }
  };
  document.getElementById("cancelBtn").onclick = async function () {
    if (!currentSession) return;
    try { await api("/admin/api/login/" + encodeURIComponent(currentSession.id) + "/cancel", { method: "POST", headers: headers() }); } catch (e) { /* ignore */ }
    stopPolling();
    setLoginState("已取消");
  };
  document.getElementById("refreshBtn").onclick = function () { loadStatus(); loadAccounts(); };
  Promise.all([loadStatus(), loadAccounts()]);
</script>
</body>
</html>`;
