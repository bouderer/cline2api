/**
 * Single-file admin UI. Kept as a TS string so `tsc` needs no asset copy step.
 *
 * Layout: fixed sidebar + content pane, one section per hash route
 * (#overview / #models / #play / #accounts / #logs) so views are linkable.
 * Everything is plain DOM built with textContent — no innerHTML for anything
 * that carries data, no external assets, no build step.
 */
export const ADMIN_PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>cline2api</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Cpath d='M8 11h16M8 16h10M8 21h7' stroke='white' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E" />
<style>
  :root {
    color-scheme: light dark;
    --bg:#f5f6f8; --surface:#ffffff; --surface-2:#fafbfc; --border:#e5e7eb; --border-strong:#d5d8de;
    --text:#12141a; --muted:#6b7280; --faint:#9ca3af;
    --accent:#4f46e5; --accent-soft:#eef0ff; --accent-fg:#ffffff;
    --ok:#047857; --ok-soft:#e7f6ef;
    --warn:#b45309; --warn-soft:#fdf3e3;
    --err:#dc2626; --err-soft:#fdecec;
    --sky:#0369a1; --sky-soft:#e6f3fb;
    --radius:14px; --radius-sm:9px;
    --shadow:0 1px 2px rgba(16,24,40,.04), 0 8px 24px -16px rgba(16,24,40,.18);
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#0b0d11; --surface:#14171d; --surface-2:#181c23; --border:#252a33; --border-strong:#333944;
      --text:#e9ecf2; --muted:#98a1b2; --faint:#6b7484;
      --accent:#8b8cf9; --accent-soft:#1e2140; --accent-fg:#0b0d11;
      --ok:#34d399; --ok-soft:#10261d;
      --warn:#fbbf24; --warn-soft:#2a2110;
      --err:#f87171; --err-soft:#2c1516;
      --sky:#7dd3fc; --sky-soft:#0f2430;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 12px 32px -20px rgba(0,0,0,.8);
    }
  }
  * { box-sizing:border-box; }
  html, body { height:100%; }
  body {
    margin:0; background:var(--bg); color:var(--text);
    font:14px/1.6 var(--sans);
    -webkit-font-smoothing:antialiased;
  }
  a { color:var(--accent); }
  code, kbd, .mono { font-family:var(--mono); font-size:12.5px; }
  .num { font-variant-numeric:tabular-nums; }

  /* ---------- shell ---------- */
  .shell { display:grid; grid-template-columns:240px minmax(0,1fr); min-height:100vh; }
  .side {
    border-right:1px solid var(--border); background:var(--surface);
    padding:18px 14px; display:flex; flex-direction:column; gap:22px;
    position:sticky; top:0; height:100vh;
  }
  .brand { display:flex; align-items:center; gap:10px; padding:2px 6px 0; }
  .brand .mark {
    width:32px; height:32px; border-radius:9px; flex:none;
    background:linear-gradient(140deg,var(--accent),#22d3ee); color:#fff;
    display:grid; place-items:center; box-shadow:var(--shadow);
  }
  .brand .mark svg { width:17px; height:17px; }
  .brand .name { font-weight:650; letter-spacing:.2px; }
  .brand .ver { color:var(--faint); font-size:11.5px; }
  .nav { display:flex; flex-direction:column; gap:2px; }
  .nav button {
    display:flex; align-items:center; gap:10px; width:100%;
    padding:9px 10px; border:0; border-radius:var(--radius-sm);
    background:none; color:var(--muted); font:inherit; text-align:left; cursor:pointer;
  }
  .nav button svg { width:16px; height:16px; flex:none; opacity:.85; }
  .nav button:hover { background:var(--surface-2); color:var(--text); }
  .nav button.active { background:var(--accent-soft); color:var(--accent); font-weight:600; }
  .side-foot { margin-top:auto; display:flex; flex-direction:column; gap:8px; padding:0 6px; }
  .side-foot .line { display:flex; align-items:center; gap:7px; color:var(--faint); font-size:11.5px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
  .dot.ok { background:var(--ok); box-shadow:0 0 0 3px var(--ok-soft); }
  .dot.err { background:var(--err); box-shadow:0 0 0 3px var(--err-soft); }
  .side-foot .trunc { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }

  .main { padding:26px 30px 70px; max-width:1120px; }
  .page-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:20px; }
  .page-head h1 { font-size:21px; margin:0 0 3px; letter-spacing:-.2px; }
  .page-head p { margin:0; color:var(--muted); font-size:13px; }
  .page-head .actions { display:flex; gap:8px; flex:none; }
  .view { display:none; }
  .view.active { display:block; animation:fade .18s ease; }
  @keyframes fade { from { opacity:0; transform:translateY(2px); } to { opacity:1; transform:none; } }

  /* ---------- primitives ---------- */
  .card { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); }
  .card + .card { margin-top:14px; }
  .card-head { padding:15px 18px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .card-head h2 { font-size:14px; margin:0; font-weight:620; }
  .card-head .hint { color:var(--muted); font-size:12.5px; }
  .card-body { padding:18px; }
  .card-body.tight { padding:0; }
  .grid { display:grid; gap:14px; }
  .grid.cols { grid-template-columns:repeat(auto-fit,minmax(190px,1fr)); }
  .grid.two { grid-template-columns:repeat(auto-fit,minmax(300px,1fr)); }
  .row { display:flex; align-items:center; gap:10px; flex-wrap:wrap; }
  .row.between { justify-content:space-between; }
  .spacer { flex:1; }
  .muted { color:var(--muted); }
  .faint { color:var(--faint); }
  .ok { color:var(--ok); }
  .warn { color:var(--warn); }
  .err { color:var(--err); }
  .sm { font-size:12.5px; }
  .xs { font-size:11.5px; }

  button.btn {
    display:inline-flex; align-items:center; gap:7px; font:inherit; cursor:pointer;
    padding:8px 13px; border-radius:var(--radius-sm); border:1px solid var(--border-strong);
    background:var(--surface); color:var(--text); transition:border-color .12s,background .12s,opacity .12s;
  }
  button.btn svg { width:15px; height:15px; }
  button.btn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); }
  button.btn:disabled { opacity:.5; cursor:not-allowed; }
  button.btn.primary { background:var(--accent); border-color:var(--accent); color:var(--accent-fg); }
  button.btn.primary:hover:not(:disabled) { opacity:.92; color:var(--accent-fg); }
  button.btn.ghost { border-color:transparent; background:none; color:var(--muted); }
  button.btn.ghost:hover:not(:disabled) { background:var(--surface-2); color:var(--text); }
  button.btn.small { padding:4px 9px; font-size:12px; border-radius:7px; }
  button.btn.danger:hover:not(:disabled) { border-color:var(--err); color:var(--err); }

  .badge {
    display:inline-flex; align-items:center; gap:5px; padding:2px 9px;
    border-radius:999px; font-size:11.5px; font-weight:600; border:1px solid transparent; white-space:nowrap;
  }
  .badge.pass { background:var(--ok-soft); color:var(--ok); }
  .badge.free { background:var(--sky-soft); color:var(--sky); }
  .badge.credits { background:var(--surface-2); color:var(--muted); border-color:var(--border); }
  .badge.err { background:var(--err-soft); color:var(--err); }
  .badge.warn { background:var(--warn-soft); color:var(--warn); }

  input[type=text], input[type=password], select, textarea {
    font:inherit; color:var(--text); background:var(--surface);
    border:1px solid var(--border-strong); border-radius:var(--radius-sm); padding:8px 11px; width:100%;
  }
  input:focus, select:focus, textarea:focus { outline:2px solid var(--accent-soft); border-color:var(--accent); }
  textarea { min-height:82px; resize:vertical; line-height:1.6; }
  label.field { display:block; }
  label.field > span { display:block; color:var(--muted); font-size:12.5px; margin-bottom:6px; }
  .switch { display:inline-flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; cursor:pointer; user-select:none; }
  .switch input { appearance:none; width:36px; height:21px; border-radius:999px; background:var(--border-strong); position:relative; transition:background .15s; cursor:pointer; }
  .switch input::after { content:""; position:absolute; top:2px; left:2px; width:17px; height:17px; border-radius:50%; background:#fff; transition:transform .15s; }
  .switch input:checked { background:var(--accent); }
  .switch input:checked::after { transform:translateX(15px); }

  .stat { border:1px solid var(--border); border-radius:var(--radius-sm); padding:13px 15px; background:var(--surface-2); }
  .stat .k { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:6px; }
  .stat .v { font-size:23px; font-weight:650; letter-spacing:-.4px; margin-top:3px; }
  .stat .s { color:var(--faint); font-size:11.5px; }

  .pre {
    background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm);
    padding:12px 14px; white-space:pre-wrap; word-break:break-word; user-select:all; margin:0;
    font-family:var(--mono); font-size:12.5px; line-height:1.65;
  }
  .kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:7px 16px; align-items:baseline; }
  .kv .k { color:var(--muted); font-size:12.5px; white-space:nowrap; }
  .kv .v { min-width:0; overflow-wrap:anywhere; }
  .bar { height:6px; border-radius:999px; background:var(--border); overflow:hidden; }
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,var(--accent),#22d3ee); }
  .bar.warn > i { background:linear-gradient(90deg,var(--warn),#f59e0b); }
  .bar.err > i { background:linear-gradient(90deg,var(--err),#f87171); }
  .quota { display:flex; flex-direction:column; gap:6px; min-width:112px; }
  .quota .q { display:grid; grid-template-columns:34px 1fr 38px; align-items:center; gap:8px; }
  .quota .q .lbl { color:var(--faint); font-size:11px; }
  .quota .q .pct { text-align:right; font-size:11.5px; font-variant-numeric:tabular-nums; }
  .acct { display:flex; flex-direction:column; gap:2px; }
  .acct .mail { overflow-wrap:anywhere; }

  /* ---------- table ---------- */
  .table-wrap { max-height:min(62vh,620px); overflow:auto; border-radius:0 0 var(--radius) var(--radius); }
  table { width:100%; border-collapse:separate; border-spacing:0; }
  th, td { text-align:left; padding:10px 14px; font-size:13px; vertical-align:middle; }
  thead th {
    position:sticky; top:0; z-index:1; background:var(--surface); color:var(--muted);
    font-weight:600; font-size:12px; border-bottom:1px solid var(--border);
  }
  tbody tr + tr td { border-top:1px solid var(--border); }
  tbody tr:hover td { background:var(--surface-2); }
  td.nowrap, th.nowrap { white-space:nowrap; }
  .id-cell { font-family:var(--mono); font-size:12.5px; word-break:break-all; }
  .empty { padding:34px 18px; text-align:center; color:var(--muted); }
  .empty svg { width:26px; height:26px; opacity:.5; display:block; margin:0 auto 8px; }

  /* ---------- chips ---------- */
  .chips { display:flex; gap:8px; flex-wrap:wrap; }
  .chip {
    display:inline-flex; align-items:center; gap:7px; padding:6px 12px; cursor:pointer;
    border:1px solid var(--border); border-radius:999px; background:var(--surface); color:var(--muted);
    font:inherit; font-size:12.5px;
  }
  .chip:hover { border-color:var(--border-strong); color:var(--text); }
  .chip.active { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); font-weight:600; }
  .chip b { font-variant-numeric:tabular-nums; }

  /* ---------- playground ---------- */
  .chat { display:flex; flex-direction:column; gap:14px; max-height:52vh; overflow:auto; padding:4px 2px 8px; }
  .msg { display:flex; gap:10px; }
  .msg .avatar { width:26px; height:26px; border-radius:8px; flex:none; display:grid; place-items:center; font-size:11px; font-weight:700; }
  .msg.user .avatar { background:var(--accent-soft); color:var(--accent); }
  .msg.assistant .avatar { background:var(--ok-soft); color:var(--ok); }
  .msg .bubble { flex:1; min-width:0; }
  .msg .role { color:var(--faint); font-size:11.5px; margin-bottom:3px; }
  .msg .body { white-space:pre-wrap; word-break:break-word; }
  .msg .body.err { color:var(--err); }
  .caret { display:inline-block; width:7px; height:14px; background:var(--accent); vertical-align:-2px; animation:blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity:0; } }
  .model-picker { max-width:340px; }

  /* ---------- login ---------- */
  .login-box { display:none; margin-top:16px; border-top:1px solid var(--border); padding-top:16px; }
  .qr { background:#fff; padding:10px; border-radius:12px; border:1px solid var(--border); line-height:0; flex:none; }
  .qr svg { width:184px; height:184px; display:block; }
  .device-code { font-family:var(--mono); font-size:26px; letter-spacing:3px; font-weight:700; }

  #toast { position:fixed; left:50%; bottom:26px; transform:translate(-50%,10px); z-index:50;
    background:#111827; color:#fff; padding:10px 16px; border-radius:10px; font-size:13px;
    box-shadow:0 10px 30px -10px rgba(0,0,0,.5); opacity:0; transition:opacity .18s,transform .18s; pointer-events:none; max-width:80vw; }
  #toast.show { opacity:1; transform:translate(-50%,0); }

  @media (max-width:1000px) {
    .shell { grid-template-columns:1fr; }
    .side { position:static; height:auto; flex-direction:column; gap:14px; border-right:0; border-bottom:1px solid var(--border); }
    .nav { flex-direction:row; overflow-x:auto; gap:6px; }
    .nav button { width:auto; white-space:nowrap; }
    .side-foot { flex-direction:row; flex-wrap:wrap; }
    .main { padding:20px 16px 60px; }
  }
</style>
</head>
<body>
<div class="shell">
  <aside class="side">
    <div class="brand">
      <div class="mark">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg>
      </div>
      <div>
        <div class="name">cline2api</div>
        <div class="ver">Claude / OpenAI 兼容网关</div>
      </div>
    </div>

    <nav class="nav" id="nav">
      <button data-view="overview" class="active">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 19V5m0 14h16M8 19v-6m4 6V9m4 10v-4"/></svg>
        概览
      </button>
      <button data-view="models">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3zM4 7.5l8 4.5 8-4.5M12 12v9"/></svg>
        模型
      </button>
      <button data-view="play">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 01-8 8H8l-5 3 1.6-5.2A8 8 0 1121 12z"/></svg>
        试聊
      </button>
      <button data-view="accounts">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 20v-1.5a4 4 0 00-4-4H7a4 4 0 00-4 4V20M9.5 10.5a3.5 3.5 0 100-7 3.5 3.5 0 000 7zM21 20v-1.5a4 4 0 00-3-3.87M16.5 3.6a4 4 0 010 7.75"/></svg>
        账号
      </button>
      <button data-view="logs">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 6h16M4 12h16M4 18h10"/></svg>
        日志
      </button>
    </nav>

    <div class="side-foot">
      <div class="line"><span class="dot" id="healthDot"></span><span id="healthText">检查中…</span></div>
      <div class="line trunc" id="upstreamLine" title="">上游 —</div>
    </div>
  </aside>

  <main class="main">
    <!-- ============ 概览 ============ -->
    <section class="view active" id="view-overview">
      <div class="page-head">
        <div>
          <h1>概览</h1>
          <p>自托管 Cline 反代 · 设备码登录 · 令牌自动续期 · 失败转移</p>
        </div>
        <div class="actions">
          <button class="btn" id="refreshAll">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M20 11a8 8 0 10-2.3 5.7M20 5v6h-6"/></svg>
            刷新
          </button>
        </div>
      </div>

      <div class="grid cols">
        <div class="stat">
          <div class="k">可用账号</div>
          <div class="v num" id="sAccounts">—</div>
          <div class="s" id="sAccountsHint">—</div>
        </div>
        <div class="stat">
          <div class="k"><span class="badge pass">订阅</span> 可用模型</div>
          <div class="v num" id="sPass">—</div>
          <div class="s">不消耗 Cline Credits</div>
        </div>
        <div class="stat">
          <div class="k"><span class="badge free">免费</span> 模型</div>
          <div class="v num" id="sFree">—</div>
          <div class="s">上游 Free 页签同款</div>
        </div>
        <div class="stat">
          <div class="k">模型总数</div>
          <div class="v num" id="sTotal">—</div>
          <div class="s" id="sCreditsHint">—</div>
        </div>
        <div class="stat">
          <div class="k">配额占用最高</div>
          <div class="v num" id="sQuota">—</div>
          <div class="s" id="sQuotaHint">—</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <h2>账号配额</h2>
          <div class="row">
            <span class="hint" id="usageHint">套餐与 5 小时 / 周 / 月 三个窗口的用量</span>
            <button class="btn small" id="usageReload">重新读取</button>
          </div>
        </div>
        <div class="card-body" id="usageBody">
          <div class="muted sm">读取中…</div>
        </div>
      </div>

      <div class="grid two" style="margin-top:14px">
        <div class="card">
          <div class="card-head">
            <h2>OpenAI 兼容接口</h2>
            <button class="btn small" data-copy-target="snippetOpenai">复制</button>
          </div>
          <div class="card-body"><pre class="pre" id="snippetOpenai">-</pre></div>
        </div>
        <div class="card">
          <div class="card-head">
            <h2>Claude Code（Anthropic 协议）</h2>
            <button class="btn small" data-copy-target="snippetClaude">复制</button>
          </div>
          <div class="card-body"><pre class="pre" id="snippetClaude">-</pre></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <h2>最近请求</h2>
          <button class="btn small" data-goto="logs">查看全部</button>
        </div>
        <div class="card-body tight"><div class="table-wrap" style="max-height:260px">
          <table>
            <thead><tr><th class="nowrap">时间</th><th>模型</th><th class="nowrap">状态</th><th class="nowrap">耗时</th></tr></thead>
            <tbody id="miniLogs"><tr><td colspan="4" class="empty sm">还没有请求记录。</td></tr></tbody>
          </table>
        </div></div>
      </div>
    </section>

    <!-- ============ 模型 ============ -->
    <section class="view" id="view-models">
      <div class="page-head">
        <div>
          <h1>模型</h1>
          <p id="modelsSub">按计费方式分桶：订阅（Cline Pass）/ 免费 / 需 Cline Credits。</p>
        </div>
        <div class="actions"><button class="btn" id="modelsReload">刷新</button></div>
      </div>

      <div class="row between">
        <div class="chips" id="bucketChips"></div>
        <div style="min-width:230px; flex:0 1 300px"><input type="text" id="modelSearch" placeholder="搜索模型 ID…" /></div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>模型 ID</th>
                <th class="nowrap" style="width:96px">计费</th>
                <th class="nowrap" style="width:150px">测试</th>
                <th class="nowrap" style="width:96px"></th>
              </tr>
            </thead>
            <tbody id="modelsBody"><tr><td colspan="4" class="empty sm">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>
      <p class="muted sm" id="modelsNote" style="margin:12px 0 0"></p>
    </section>

    <!-- ============ 试聊 ============ -->
    <section class="view" id="view-play">
      <div class="page-head">
        <div>
          <h1>试聊</h1>
          <p>走 /admin/api/chat（管理令牌鉴权），浏览器里不需要客户端 Key。</p>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <div class="row" style="align-items:flex-end; gap:14px">
            <label class="field model-picker" style="flex:1 1 280px">
              <span>模型</span>
              <select id="playModel"></select>
            </label>
            <label class="switch"><input type="checkbox" id="playStream" checked /> 流式输出</label>
            <div class="spacer"></div>
            <button class="btn primary" id="playSend">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6L4 12z"/></svg>
              发送
            </button>
          </div>

          <label class="field" style="margin-top:14px">
            <span>提示词（Ctrl/⌘ + Enter 发送）</span>
            <textarea id="playInput">用三句话说明你是谁、由哪个模型驱动。</textarea>
          </label>

          <div class="row between" style="margin-top:16px">
            <span class="sm muted" id="playState">就绪</span>
            <button class="btn small ghost" id="playClear">清空对话</button>
          </div>
          <div class="chat" id="chat"></div>
        </div>
      </div>
    </section>

    <!-- ============ 账号 ============ -->
    <section class="view" id="view-accounts">
      <div class="page-head">
        <div>
          <h1>账号</h1>
          <p>账号池按轮询调度，401 静默续期，失效自动切换。每个账号需本人在官方页面确认。</p>
        </div>
        <div class="actions">
          <button class="btn" id="importBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 19h14"/></svg>
            导入账号
          </button>
          <button class="btn primary" id="loginBtn">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
            登录新账号
          </button>
        </div>
      </div>

      <div class="card" id="importPanel" style="display:none">
        <div class="card-head">
          <div>
            <h2>导入账号</h2>
            <div class="hint">粘贴 cline-register 导出的 JSON，失败记录会自动忽略。</div>
          </div>
          <button class="btn small ghost" id="importClose">关闭</button>
        </div>
        <div class="card-body">
          <label class="field">
            <span>账号 JSON</span>
            <textarea id="importInput" style="min-height:190px" placeholder="支持以下三种输入：&#10;1. 完整的 {&quot;accounts&quot;:[...]} 对象&#10;2. 直接粘贴 JSON 数组 [...]&#10;3. cline-register/data/accounts_cline.json 注册机记录数组（email / accessToken / refreshToken / expiresAt / ok）"></textarea>
          </label>
          <div class="row between" style="margin-top:12px; align-items:flex-start">
            <div class="sm err" id="importError" style="display:none; white-space:pre-wrap"></div>
            <button class="btn primary" id="importSubmit" style="margin-left:auto">开始导入</button>
          </div>
          <div class="sm muted" id="importResult" style="display:none; margin-top:12px"></div>
        </div>
      </div>

      <div class="card">
        <div class="card-body">
          <label class="field" style="max-width:460px; margin-bottom:14px">
            <span>登录方式</span>
            <select id="loginMode">
              <option value="device">设备码（推荐，无入向端口）</option>
            </select>
            <div class="muted xs" id="loginModeNote" style="margin-top:6px">设备码需要在浏览器中确认，不需要开放入向端口。</div>
          </label>
          <div class="login-box" id="loginBox">
            <div class="row" style="align-items:flex-start; gap:18px">
              <div class="qr" id="qrHolder"></div>
              <div style="flex:1; min-width:220px">
                <div class="muted sm">在浏览器中打开下面的链接，或扫描左侧二维码</div>
                <div style="margin:8px 0"><a id="verifyLink" href="#" target="_blank" rel="noreferrer"></a></div>
                <div id="userCodeBlock">
                  <div class="muted xs" id="userCodeLabel">设备码</div>
                  <div class="device-code" id="userCode">-</div>
                </div>
                <div class="sm warn" id="loginModeTip" style="display:none; margin-top:10px"></div>
                <div class="sm" style="margin-top:10px" id="loginState"></div>
                <div style="margin-top:14px"><button class="btn small" id="cancelBtn">取消本次登录</button></div>
              </div>
            </div>
          </div>
          <div id="accountsEmpty" class="muted sm">还没有账号。点击右上角「登录新账号」开始。</div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>账号列表</h2><span class="hint">令牌只存在服务端 data/accounts.json（0600）</span></div>
        <div class="card-body tight">
          <table>
            <thead><tr><th>账号</th><th class="nowrap">状态</th><th class="nowrap">令牌到期</th><th class="nowrap" style="width:70px"></th></tr></thead>
            <tbody id="accountsBody"><tr><td colspan="4" class="empty sm">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>

    <!-- ============ 日志 ============ -->
    <section class="view" id="view-logs">
      <div class="page-head">
        <div>
          <h1>日志</h1>
          <p>最近 200 条请求，只存在内存，重启即清空。</p>
        </div>
        <div class="actions">
          <label class="switch"><input type="checkbox" id="logAuto" checked /> 自动刷新</label>
          <button class="btn" id="logReload">刷新</button>
        </div>
      </div>

      <div class="grid cols">
        <div class="stat"><div class="k">本次启动请求</div><div class="v num" id="logTotal">—</div></div>
        <div class="stat"><div class="k">最近 5 分钟</div><div class="v num" id="logRecent">—</div></div>
        <div class="stat"><div class="k">失败</div><div class="v num err" id="logFailed">—</div></div>
      </div>

      <div class="row" style="margin-top:14px">
        <div class="chips" id="logChips">
          <button class="chip active" data-logfilter="">全部</button>
          <button class="chip" data-logfilter="ok">成功</button>
          <button class="chip" data-logfilter="fail">失败</button>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="table-wrap">
          <table>
            <thead><tr><th class="nowrap">时间</th><th>模型</th><th class="nowrap" style="width:70px">状态</th><th class="nowrap" style="width:90px">耗时</th><th>账号 / 错误</th></tr></thead>
            <tbody id="logsBody"><tr><td colspan="5" class="empty sm">加载中…</td></tr></tbody>
          </table>
        </div>
      </div>
    </section>
  </main>
</div>

<div id="toast"></div>

<script>
(function () {
  "use strict";

  var params = new URLSearchParams(location.search);
  var adminToken = params.get("token") || "";
  var pollTimer = null;
  var logTimer = null;
  var currentSession = null;
  var catalog = [];
  var logData = [];
  var logFilter = "";
  var bucketFilter = "";
  var chat = [];
  var streaming = false;

  /* ---------- token handling ---------- */
  function storeToken(value) {
    try { if (value) localStorage.setItem("cline2api.adminToken", value); } catch (e) { /* private mode */ }
  }
  function readStoredToken() {
    try { return localStorage.getItem("cline2api.adminToken") || ""; } catch (e) { return ""; }
  }
  if (adminToken) storeToken(adminToken); else adminToken = readStoredToken();

  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }
  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }
  function icon(path, stroke) {
    var ns = "http://www.w3.org/2000/svg";
    var svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("fill", "none");
    svg.setAttribute("stroke", "currentColor");
    svg.setAttribute("stroke-width", stroke || "2");
    svg.setAttribute("stroke-linecap", "round");
    svg.setAttribute("stroke-linejoin", "round");
    var p = document.createElementNS(ns, "path");
    p.setAttribute("d", path);
    svg.appendChild(p);
    return svg;
  }
  function toast(msg, kind) {
    var t = $("toast");
    t.textContent = msg;
    t.style.background = kind === "err" ? "#b91c1c" : (kind === "ok" ? "#065f46" : "#111827");
    t.classList.add("show");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.remove("show"); }, 2600);
  }
  function copy(text, okMsg) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast(okMsg || "已复制", "ok"); },
        function () { toast("复制失败", "err"); }
      );
    } else {
      toast("浏览器不支持剪贴板", "err");
    }
  }
  function fmtAbsolute(ts) {
    if (!ts) return "-";
    return new Date(ts).toLocaleString();
  }
  function fmtExpiry(ts) {
    if (!ts) return "-";
    var mins = Math.round((ts - Date.now()) / 60000);
    var rel = mins <= 0 ? "已过期" : (mins < 60 ? "剩 " + mins + " 分钟" : "剩 " + Math.round(mins / 60) + " 小时");
    return new Date(ts).toLocaleTimeString() + " · " + rel;
  }
  function fmtClock(ts) { return ts ? new Date(ts).toLocaleTimeString() : "-"; }
  function fmtDay(iso) { return iso ? String(iso).slice(0, 10) : "-"; }
  function summarize(text, max) {
    var s = String(text === undefined || text === null ? "" : text).replace(/\s+/g, " ").trim();
    var limit = max || 90;
    return s.length > limit ? s.slice(0, limit) + "…" : s;
  }
  function bucketLabel(b) { return b === "pass" ? "订阅" : (b === "free" ? "免费" : "Credits"); }

  function api(path, options) {
    var opts = options || {};
    var h = opts.headers || {};
    if (adminToken) h["Authorization"] = "Bearer " + adminToken;
    opts.headers = h;
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { showTokenPrompt(); throw new Error("未授权：管理令牌无效或缺失"); }
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
      return res.status === 204 ? null : res.json();
    });
  }
  function jsonApi(path, body, method) {
    return api(path, { method: method || "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  function showTokenPrompt() {
    if ($("tokenPrompt")) return;
    var box = el("div", "card");
    box.id = "tokenPrompt";
    box.style.marginBottom = "14px";
    var body = el("div", "card-body");
    body.appendChild(el("div", "sm", "这个管理台需要管理令牌（ADMIN_TOKEN）。粘贴一次后本浏览器会记住。"));
    var row = el("div", "row");
    row.style.marginTop = "10px";
    var input = el("input");
    input.type = "password";
    input.placeholder = "ADMIN_TOKEN";
    input.style.maxWidth = "340px";
    var btn = el("button", "btn primary", "保存");
    btn.onclick = function () {
      adminToken = input.value.trim();
      if (!adminToken) return;
      storeToken(adminToken);
      location.reload();
    };
    row.appendChild(input);
    row.appendChild(btn);
    body.appendChild(row);
    box.appendChild(body);
    document.querySelector(".main").insertBefore(box, document.querySelector(".main").firstChild);
  }

  /* ---------- routing ---------- */
  var views = ["overview", "models", "play", "accounts", "logs"];
  function show(name) {
    if (views.indexOf(name) < 0) name = "overview";
    views.forEach(function (v) {
      var section = $("view-" + v);
      if (section) section.classList.toggle("active", v === name);
    });
    var buttons = document.querySelectorAll("#nav button");
    for (var i = 0; i < buttons.length; i++) buttons[i].classList.toggle("active", buttons[i].getAttribute("data-view") === name);
    if (location.hash.slice(1) !== name) history.replaceState(null, "", "#" + name);
    if (name === "models") loadModels();
    if (name === "play") loadPlayModels();
    if (name === "logs") loadLogs();
    if (name === "overview") { loadStatus(); loadUsage(); loadMiniLogs(); }
  }
  var navButtons = document.querySelectorAll("#nav button");
  for (var i = 0; i < navButtons.length; i++) {
    navButtons[i].onclick = function () { show(this.getAttribute("data-view")); };
  }
  document.querySelectorAll("[data-goto]").forEach(function (b) {
    b.onclick = function () { show(this.getAttribute("data-goto")); };
  });
  window.addEventListener("hashchange", function () { show(location.hash.slice(1)); });

  /* ---------- overview ---------- */
  function snippetTexts() {
    var origin = location.origin;
    return {
      openai: 'from openai import OpenAI\n\nclient = OpenAI(\n    base_url="' + origin + '/v1",\n    api_key="<PROXY_API_KEY>",\n)\n\nstream = client.chat.completions.create(\n    model="cline-pass/kimi-k3",\n    messages=[{"role": "user", "content": "你好"}],\n    stream=True,\n)\nfor chunk in stream:\n    print(chunk.choices[0].delta.content or "", end="")',
      claude: '# 用订阅模型，不吃 Cline Credits\nexport ANTHROPIC_BASE_URL=' + origin + '\nexport ANTHROPIC_AUTH_TOKEN=<PROXY_API_KEY>\n\n# 注意：不要带 /v1 后缀，客户端会自己拼 /v1/messages\n# 模型填 cline-pass/kimi-k3、cline-pass/glm-5.3 这类 ID'
    };
  }
  function fillSnippets() {
    var s = snippetTexts();
    $("snippetOpenai").textContent = s.openai;
    $("snippetClaude").textContent = s.claude;
  }
  document.querySelectorAll("[data-copy-target]").forEach(function (b) {
    b.onclick = function () {
      var target = $(this.getAttribute("data-copy-target"));
      if (target) copy(target.textContent, "已复制接入片段");
    };
  });

  var WINDOW_LABEL = { five_hour: "5 小时", weekly: "本周", monthly: "本月" };
  var WINDOW_ORDER = ["five_hour", "weekly", "monthly"];

  function quotaBar(limit) {
    var wrap = el("div", "q");
    wrap.appendChild(el("span", "lbl", WINDOW_LABEL[limit.type] || limit.type));
    var pct = Math.max(0, Math.min(100, Number(limit.percentUsed) || 0));
    var bar = el("div", "bar" + (pct >= 90 ? " err" : (pct >= 70 ? " warn" : "")));
    var fill = el("i");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    if (limit.resetsAt) {
      bar.title = (WINDOW_LABEL[limit.type] || limit.type) + " 用量 " + pct + "%，重置于 " + new Date(limit.resetsAt).toLocaleString();
    }
    wrap.appendChild(bar);
    var num = el("span", "pct", pct + "%");
    if (pct >= 90) num.className = "pct err";
    else if (pct >= 70) num.className = "pct warn";
    wrap.appendChild(num);
    return wrap;
  }

  function nextReset(limits) {
    var soonest = null;
    limits.forEach(function (l) {
      if (!l.resetsAt) return;
      var t = Date.parse(l.resetsAt);
      if (isNaN(t)) return;
      if (soonest === null || t < soonest) soonest = t;
    });
    return soonest;
  }

  function renderUsage(data) {
    var body = $("usageBody");
    clear(body);
    var accounts = data.accounts || [];
    if (!accounts.length) {
      body.className = "muted sm";
      body.textContent = "还没有账号，先到「账号」页登录。";
      return;
    }
    body.className = "";

    var table = el("table");
    var thead = el("thead");
    var htr = el("tr");
    ["账号", "套餐", "用量（5 小时 / 周 / 月）", "下次重置"].forEach(function (t) { htr.appendChild(el("th", "nowrap", t)); });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el("tbody");
    var worst = 0;
    var worstLabel = "";

    accounts.forEach(function (a) {
      var tr = el("tr");

      var td1 = el("td");
      var acct = el("div", "acct");
      acct.appendChild(el("span", "mail", a.email || a.id));
      var tags = el("div", "row");
      tags.style.gap = "6px";
      if (a.disabled) tags.appendChild(el("span", "badge err", "需重新登录"));
      if (a.error) tags.appendChild(el("span", "badge warn", summarize(a.error, 28)));
      if (tags.childNodes.length) acct.appendChild(tags);
      td1.appendChild(acct);
      tr.appendChild(td1);

      var td2 = el("td", "nowrap");
      var plan = a.plan;
      if (plan && !plan.error) {
        td2.appendChild(el("div", "sm", plan.displayName || "未知套餐"));
        var sub = el("div", "xs faint");
        var bits = [];
        if (plan.interval) bits.push(plan.interval);
        bits.push(plan.isActive ? "生效中" : "未生效");
        if (plan.currentPeriodEnd) bits.push("至 " + fmtDay(plan.currentPeriodEnd));
        sub.textContent = bits.join(" · ");
        td2.appendChild(sub);
      } else {
        var badge = plan && plan.error ? ("读取失败：" + summarize(plan.error, 24)) : "—";
        td2.appendChild(el("span", "sm faint", badge));
      }
      tr.appendChild(td2);

      var td3 = el("td");
      if (a.limits && a.limits.length) {
        var quota = el("div", "quota");
        var byType = {};
        a.limits.forEach(function (l) { byType[l.type] = l; });
        var ordered = WINDOW_ORDER.map(function (t) { return byType[t]; }).filter(Boolean)
          .concat(a.limits.filter(function (l) { return WINDOW_ORDER.indexOf(l.type) < 0; }));
        ordered.forEach(function (l) {
          quota.appendChild(quotaBar(l));
          var pct = Number(l.percentUsed) || 0;
          if (pct > worst) {
            worst = pct;
            worstLabel = (a.email || a.id) + " · " + (WINDOW_LABEL[l.type] || l.type);
          }
        });
        td3.appendChild(quota);
      } else {
        td3.appendChild(el("span", "sm faint", a.error ? "—" : "无限制信息"));
      }
      tr.appendChild(td3);

      var td4 = el("td", "nowrap sm num");
      var reset = nextReset(a.limits || []);
      td4.textContent = reset ? new Date(reset).toLocaleString() : "—";
      tr.appendChild(td4);

      tbody.appendChild(tr);
    });

    table.appendChild(tbody);
    body.appendChild(table);
    body.appendChild(el("div", "xs muted", "用量来自上游 /api/v1/users/me/plan/usage-limits（每账号 60 秒缓存一次）。比例是上游按套餐额度算好的，不做本地估算。"));

    $("sQuota").textContent = worst ? worst + "%" : "—";
    $("sQuotaHint").textContent = worstLabel || "三个窗口均未上报用量";
  }

  function loadUsage() {
    api("/admin/api/usage").then(renderUsage).catch(function (e) {
      var body = $("usageBody");
      clear(body);
      body.className = "err sm";
      body.textContent = "配额读取失败：" + e.message;
      $("sQuota").textContent = "—";
      $("sQuotaHint").textContent = "读取失败";
    });
  }

  function loadStatus() {
    api("/admin/api/status").then(function (data) {
      $("sAccounts").textContent = data.accounts.active;
      $("sAccountsHint").textContent = "共 " + data.accounts.total + " 个" +
        (data.accounts.disabled ? "，" + data.accounts.disabled + " 个需重新登录" : "");
      $("sTotal").textContent = data.models.count;
      $("sCreditsHint").textContent = "实时拉取上游目录";
      $("upstreamLine").textContent = "上游 " + data.upstream;
      $("upstreamLine").title = data.upstream;
      var healthy = data.accounts.active > 0;
      $("healthDot").className = "dot " + (healthy ? "ok" : "err");
      $("healthText").textContent = healthy ? "服务正常" : "无可用账号";
      api("/admin/api/requests?limit=1").then(function (r) {
        var st = r.stats;
        if (st && st.total) {
          $("healthText").textContent += " · 本次已处理 " + st.total + " 次" + (st.failed ? "（失败 " + st.failed + "）" : "");
        }
      }).catch(function () { /* 统计拿不到不影响健康状态 */ });
    }).catch(function (e) {
      $("healthDot").className = "dot err";
      $("healthText").textContent = "状态读取失败";
      $("sAccounts").textContent = "—";
      $("sAccountsHint").textContent = e.message;
      $("sTotal").textContent = "—";
    });
  }

  function loadMiniLogs() {
    api("/admin/api/requests?limit=8").then(function (data) {
      var body = $("miniLogs");
      clear(body);
      if (!data.entries.length) {
        var tr = el("tr");
        var td = el("td", "empty sm", "还没有请求记录。");
        td.colSpan = 4;
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      data.entries.forEach(function (e) {
        var tr = el("tr");
        tr.appendChild(el("td", "nowrap sm mono", fmtClock(e.at)));
        tr.appendChild(el("td", "id-cell", e.model));
        var td = el("td", "nowrap");
        td.appendChild(statusBadge(e.status));
        tr.appendChild(td);
        tr.appendChild(el("td", "nowrap sm num", e.durationMs + " ms"));
        body.appendChild(tr);
      });
    }).catch(function () { /* 概览上的小块失败不值得打扰 */ });
  }
  function statusBadge(status) {
    var cls = status >= 200 && status < 300 ? "pass" : (status >= 500 ? "err" : "warn");
    return el("span", "badge " + cls, String(status));
  }

  /* ---------- models ---------- */
  function loadModels(force) {
    if (catalog.length && !force) { renderModels(); return; }
    api("/admin/api/models").then(function (data) {
      catalog = data.models;
      $("sPass").textContent = data.counts.pass;
      $("sFree").textContent = data.counts.free;
      renderChips(data.counts);
      renderModels();
      $("modelsNote").textContent = "共 " + data.counts.total + " 个模型 · 订阅 " + data.counts.pass +
        " · 免费 " + data.counts.free + " · 需 Credits " + data.counts.credits +
        "。列表来自上游 /api/v1/models 与 /api/v1/ai/cline/recommended-models 的合并结果。";
      if (data.counts.free === 0 && data.counts.pass === 0) {
        $("modelsNote").textContent += "（未读到 recommended-models，可能是上游临时不可用）";
      }
    }).catch(function (e) {
      var body = $("modelsBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "模型读取失败：" + e.message);
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }
  function renderChips(counts) {
    var box = $("bucketChips");
    clear(box);
    var defs = [
      { key: "", label: "全部", n: counts.total },
      { key: "pass", label: "订阅可用", n: counts.pass },
      { key: "free", label: "免费", n: counts.free },
      { key: "credits", label: "需 Credits", n: counts.credits }
    ];
    defs.forEach(function (d) {
      var chip = el("button", "chip" + (bucketFilter === d.key ? " active" : ""));
      chip.appendChild(el("span", null, d.label));
      chip.appendChild(el("b", null, d.n));
      chip.onclick = function () { bucketFilter = d.key; renderChips(counts); renderModels(); };
      box.appendChild(chip);
    });
  }
  function renderModels() {
    var body = $("modelsBody");
    var q = $("modelSearch").value.trim().toLowerCase();
    var rows = catalog.filter(function (m) {
      if (bucketFilter && m.bucket !== bucketFilter) return false;
      return !q || m.id.toLowerCase().indexOf(q) >= 0;
    });
    clear(body);
    if (!rows.length) {
      var tr = el("tr");
      var td = el("td", "empty sm", catalog.length ? "没有匹配的模型。" : "加载中…");
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    var limit = 250;
    rows.slice(0, limit).forEach(function (m) {
      var tr = el("tr");

      var td1 = el("td", "id-cell");
      td1.appendChild(el("span", null, m.id));
      var owner = el("div", "xs faint", m.ownedBy || "");
      td1.appendChild(owner);
      tr.appendChild(td1);

      var td2 = el("td", "nowrap");
      td2.appendChild(el("span", "badge " + m.bucket, bucketLabel(m.bucket)));
      tr.appendChild(td2);

      var td3 = el("td", "nowrap sm");
      td3.appendChild(el("span", "faint", "—"));
      tr.appendChild(td3);

      var td4 = el("td", "nowrap");
      var copyBtn = el("button", "btn small", "复制");
      copyBtn.onclick = function () { copy(m.id, "已复制 " + m.id); };
      var testBtn = el("button", "btn small primary", "测试");
      testBtn.style.marginLeft = "6px";
      testBtn.onclick = function () { testModel(m, testBtn, td3); };
      td4.appendChild(copyBtn);
      td4.appendChild(testBtn);
      tr.appendChild(td4);

      body.appendChild(tr);
    });
    if (rows.length > limit) {
      var trm = el("tr");
      var tdm = el("td", "empty sm", "只显示前 " + limit + " 条，请用搜索缩小范围。");
      tdm.colSpan = 4;
      trm.appendChild(tdm);
      body.appendChild(trm);
    }
  }
  function testModel(m, btn, cell) {
    btn.disabled = true;
    btn.textContent = "…";
    clear(cell);
    cell.appendChild(el("span", "faint", "请求中"));
    var started = Date.now();
    jsonApi("/admin/api/chat", {
      model: m.id,
      messages: [{ role: "user", content: "只回复两个字：可用" }],
      stream: false
    }).then(function (data) {
      clear(cell);
      var content = data && data.choices && data.choices[0] && data.choices[0].message
        ? data.choices[0].message.content : "";
      var okText = summarize(content || "(空响应)", 24);
      cell.appendChild(el("span", "badge pass", "可用"));
      cell.appendChild(el("div", "xs muted", okText + " · " + ((Date.now() - started) / 1000).toFixed(1) + "s"));
    }).catch(function (e) {
      clear(cell);
      cell.appendChild(el("span", "badge err", "失败"));
      cell.appendChild(el("div", "xs err", summarize(e.message, 60)));
    }).finally(function () {
      btn.disabled = false;
      btn.textContent = "测试";
    });
  }
  $("modelSearch").oninput = renderModels;
  $("modelsReload").onclick = function () { loadModels(true); toast("已刷新模型目录"); };

  /* ---------- playground ---------- */
  function loadPlayModels(force) {
    if (catalog.length && !force) { renderPlayModels(); return; }
    api("/admin/api/models").then(function (data) {
      catalog = data.models;
      renderChips(data.counts);
      renderPlayModels();
    }).catch(function (e) { toast("模型列表读取失败：" + e.message, "err"); });
  }
  function renderPlayModels() {
    var select = $("playModel");
    var previous = select.value;
    clear(select);
    [["pass", "订阅可用（不消耗 Credits）"], ["free", "免费"], ["credits", "需 Cline Credits"]].forEach(function (def) {
      var items = catalog.filter(function (m) { return m.bucket === def[0]; });
      if (!items.length) return;
      var group = el("optgroup");
      group.label = def[1] + " · " + items.length;
      items.forEach(function (m) {
        var option = el("option", null, m.id);
        option.value = m.id;
        group.appendChild(option);
      });
      select.appendChild(group);
    });
    if (previous) select.value = previous;
    if (!select.value) {
      var preferred = catalog.filter(function (m) { return m.bucket === "pass"; })[0] || catalog[0];
      if (preferred) select.value = preferred.id;
    }
    select.onchange = function () { $("playState").textContent = "就绪 · " + select.value; };
  }
  function renderChat() {
    var box = $("chat");
    clear(box);
    if (!chat.length) {
      box.appendChild(el("div", "empty sm", "还没有对话。选个模型，写点提示词，然后发送。"));
      return;
    }
    chat.forEach(function (m, index) {
      var wrap = el("div", "msg " + m.role);
      wrap.appendChild(el("div", "avatar", m.role === "user" ? "我" : "AI"));
      var bubble = el("div", "bubble");
      bubble.appendChild(el("div", "role", (m.role === "user" ? "你" : "模型") + (m.model ? " · " + m.model : "")));
      var body = el("div", "body" + (m.error ? " err" : ""), m.content);
      if (streaming && index === chat.length - 1 && m.role === "assistant" && !m.error) {
        body.appendChild(el("span", "caret"));
      }
      bubble.appendChild(body);
      if (m.meta) bubble.appendChild(el("div", "xs faint", m.meta));
      wrap.appendChild(bubble);
      box.appendChild(wrap);
    });
    box.scrollTop = box.scrollHeight;
  }
  function sendPlay() {
    var model = $("playModel").value;
    var prompt = $("playInput").value.trim();
    if (!model) { toast("先选择模型", "err"); return; }
    if (!prompt) { toast("先输入提示词", "err"); return; }
    var wantStream = $("playStream").checked;
    var btn = $("playSend");
    var state = $("playState");
    btn.disabled = true;
    state.className = "sm muted";
    state.textContent = "请求中…";

    chat.push({ role: "user", content: prompt });
    var answer = { role: "assistant", content: "", model: model, meta: "" };
    chat.push(answer);
    streaming = wantStream;
    renderChat();

    var started = Date.now();
    var firstChunk = 0;
    var usage = null;

    fetch("/admin/api/chat", {
      method: "POST",
      headers: (function () {
        var h = { "Content-Type": "application/json" };
        if (adminToken) h["Authorization"] = "Bearer " + adminToken;
        return h;
      })(),
      body: JSON.stringify({ model: model, messages: [{ role: "user", content: prompt }], stream: wantStream })
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
      }
      if (!wantStream) return res.json();
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) return null;
          buffer += decoder.decode(chunk.value, { stream: true });
          var lines = buffer.split("\n");
          buffer = lines.pop();
          lines.forEach(function (line) {
            line = line.trim();
            if (line.indexOf("data:") !== 0) return;
            var payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") return;
            var evt;
            try { evt = JSON.parse(payload); } catch (e) { return; }
            if (evt.usage) usage = evt.usage;
            if (evt.error) {
              answer.error = true;
              answer.content += "\n" + summarize(typeof evt.error === "string" ? evt.error : (evt.error.message || ""), 300);
              renderChat();
              return;
            }
            var choice = evt.choices && evt.choices[0];
            var delta = choice && choice.delta ? choice.delta : null;
            if (delta && delta.content) {
              if (!firstChunk) firstChunk = Date.now();
              answer.content += delta.content;
              renderChat();
            }
          });
          return pump();
        });
      }
      return pump();
    }).then(function () {
      streaming = false;
      var elapsed = (Date.now() - started) / 1000;
      var bits = [];
      if (firstChunk) bits.push("首字 " + ((firstChunk - started) / 1000).toFixed(2) + "s");
      bits.push("总 " + elapsed.toFixed(2) + "s");
      if (usage) {
        if (usage.total_tokens) bits.push("tokens " + usage.total_tokens);
        if (usage.cost !== undefined && usage.cost !== null) bits.push("cost " + usage.cost);
      }
      answer.meta = bits.join(" · ");
      state.className = "sm ok";
      state.textContent = "完成 · " + model + " · " + bits.join(" · ");
      renderChat();
    }).catch(function (e) {
      streaming = false;
      if (!answer.content) { answer.error = true; answer.content = e.message; }
      renderChat();
      state.className = "sm err";
      state.textContent = "失败：" + summarize(e.message, 120);
    }).finally(function () {
      btn.disabled = false;
    });
  }
  $("playSend").onclick = sendPlay;
  $("playClear").onclick = function () { chat = []; renderChat(); $("playState").textContent = "就绪"; };
  $("playInput").addEventListener("keydown", function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); sendPlay(); }
  });

  /* ---------- accounts ---------- */
  function modeText(mode) {
    return mode === "callback" ? "本地回调" : "设备码";
  }
  function updateLoginModeNote() {
    var mode = $("loginMode").value;
    $("loginModeNote").textContent = mode === "callback"
      ? "本地回调需要 48801–48806 对本机或容器可达。"
      : "设备码需要在浏览器中确认，不需要开放入向端口。";
  }
  function renderLoginModes(modes, defaultMode) {
    var select = $("loginMode");
    var supported = (Array.isArray(modes) ? modes : []).filter(function (mode) {
      return mode === "device" || mode === "callback";
    });
    if (!supported.length) supported = ["device"];
    var previous = select.value;
    clear(select);
    supported.forEach(function (mode) {
      var option = el("option", null, mode === "callback" ? "本地回调（需要 48801–48806 可达）" : "设备码（推荐，无入向端口）");
      option.value = mode;
      select.appendChild(option);
    });
    select.value = supported.indexOf(previous) >= 0 ? previous : (supported.indexOf(defaultMode) >= 0 ? defaultMode : supported[0]);
    updateLoginModeNote();
  }
  function loadLoginModes() {
    api("/admin/api/login/modes").then(function (data) {
      renderLoginModes(data && data.modes, data && data.defaultMode);
    }).catch(function () {
      renderLoginModes(["device"], "device");
    });
  }
  function setImportError(message) {
    $("importError").textContent = message || "";
    $("importError").style.display = message ? "block" : "none";
  }
  function clearImportMessages() {
    setImportError("");
    var result = $("importResult");
    clear(result);
    result.style.display = "none";
  }
  function importText(value) {
    return typeof value === "string" ? value.trim() : "";
  }
  function normalizeImportRecord(record) {
    if (!record || typeof record !== "object" || Array.isArray(record)) return null;
    var registrarShape = Object.prototype.hasOwnProperty.call(record, "ok") ||
      Object.prototype.hasOwnProperty.call(record, "accessToken") ||
      Object.prototype.hasOwnProperty.call(record, "refreshToken") ||
      Object.prototype.hasOwnProperty.call(record, "expiresAt");
    if (registrarShape && record.ok !== true) return null;
    var email = importText(record.email);
    var access = importText(record.access || record.accessToken);
    var refresh = importText(record.refresh || record.refreshToken);
    var expires = record.expires === undefined ? record.expiresAt : record.expires;
    if (typeof expires === "string" && expires.trim()) expires = Number(expires);
    if (!email || email.indexOf("@") < 0 || !access || !refresh || !Number.isFinite(expires) || expires <= 0) return null;
    var normalized = { email: email, access: access, refresh: refresh, expires: expires };
    var tokenType = importText(record.tokenType);
    var provider = importText(record.provider);
    var label = importText(record.label);
    var accountId = importText(record.accountId);
    if (tokenType) normalized.tokenType = tokenType;
    if (provider) normalized.provider = provider;
    if (label) normalized.label = label;
    if (accountId) normalized.accountId = accountId;
    return normalized;
  }
  function normalizeImportPayload(raw) {
    var rows;
    if (Array.isArray(raw)) rows = raw;
    else if (raw && typeof raw === "object" && Array.isArray(raw.accounts)) rows = raw.accounts;
    else return null;
    var accounts = [];
    rows.forEach(function (record) {
      var normalized = normalizeImportRecord(record);
      if (normalized) accounts.push(normalized);
    });
    return accounts;
  }
  function renderImportResult(data) {
    data = data || {};
    var box = $("importResult");
    clear(box);
    box.style.display = "block";
    box.appendChild(el("div", "ok", "新增 " + (data.imported || 0) + " / 覆盖 " + (data.updated || 0) + " / 跳过 " + (data.skipped || 0) + " / 共 " + (data.total || 0)));
    var errors = Array.isArray(data.errors) ? data.errors.slice(0, 20) : [];
    if (errors.length) {
      var list = el("div", "err");
      list.style.marginTop = "8px";
      list.appendChild(el("div", null, "错误明细："));
      errors.forEach(function (item) {
        var email = item && item.email ? "（" + item.email + "）" : "";
        var reason = item && item.reason ? item.reason : "未知错误";
        list.appendChild(el("div", null, "#" + ((item && item.index) || 0) + email + " " + reason));
      });
      box.appendChild(list);
    }
  }
  function submitImport() {
    clearImportMessages();
    var input = $("importInput");
    var text = input.value.trim();
    if (!text) { setImportError("请先粘贴要导入的 JSON。"); return; }
    var raw;
    try {
      raw = JSON.parse(text);
    } catch (error) {
      setImportError("JSON 解析失败：" + error.message);
      return;
    }
    var accounts = normalizeImportPayload(raw);
    if (accounts === null) {
      setImportError("格式不支持：请输入包含 accounts 数组的对象，或直接输入 JSON 数组。");
      return;
    }
    if (!accounts.length) {
      setImportError("没有合法的账号记录；已过滤 ok !== true、缺少令牌或邮箱的记录。");
      return;
    }
    var btn = $("importSubmit");
    btn.disabled = true;
    jsonApi("/admin/api/accounts/import", { accounts: accounts }).then(function (data) {
      renderImportResult(data);
      input.value = "";
      toast("账号导入完成", "ok");
      loadAccounts();
    }).catch(function (error) {
      setImportError("导入失败：" + error.message);
    }).finally(function () {
      btn.disabled = false;
    });
  }
  function loadAccounts() {
    api("/admin/api/accounts").then(function (data) {
      var body = $("accountsBody");
      clear(body);
      $("accountsEmpty").style.display = data.accounts.length ? "none" : "block";
      if (!data.accounts.length) {
        var tr = el("tr");
        var td = el("td", "empty sm", "还没有账号。");
        td.colSpan = 4;
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      data.accounts.forEach(function (a) {
        var tr = el("tr");
        var td1 = el("td");
        td1.appendChild(el("div", null, a.email || a.id));
        td1.appendChild(el("div", "xs faint mono", a.id));
        tr.appendChild(td1);

        var td2 = el("td", "nowrap");
        td2.appendChild(el("span", "badge " + (a.disabled ? "err" : "pass"), a.disabled ? "需重新登录" : "可用"));
        if (a.disabled && a.lastError) td2.appendChild(el("div", "xs muted", summarize(a.lastError, 50)));
        tr.appendChild(td2);

        var td3 = el("td", "nowrap sm num", fmtExpiry(a.expiresAt));
        tr.appendChild(td3);

        var td4 = el("td", "nowrap");
        var del = el("button", "btn small danger", "删除");
        del.onclick = function () { removeAccount(a); };
        td4.appendChild(del);
        tr.appendChild(td4);

        body.appendChild(tr);
      });
    }).catch(function (e) {
      var body = $("accountsBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "账号读取失败：" + e.message);
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }
  function removeAccount(a) {
    if (!confirm("确定删除账号 " + (a.email || a.id) + " ？删除后需要重新登录。")) return;
    api("/admin/api/accounts/" + encodeURIComponent(a.id), { method: "DELETE" }).then(function () {
      toast("已删除", "ok");
      loadAccounts(); loadStatus(); loadUsage();
    }).catch(function (e) { toast("删除失败：" + e.message, "err"); });
  }
  function setLoginState(text, kind) {
    var node = $("loginState");
    node.textContent = text;
    node.className = "sm " + (kind || "muted");
  }
  function showLogin(session) {
    currentSession = session;
    var mode = session.mode === "callback" ? "callback" : "device";
    var callback = mode === "callback";
    $("loginBox").style.display = "block";
    $("qrHolder").innerHTML = session.qrSvg || "";
    if ($("loginMode").querySelector('option[value="' + mode + '"]')) $("loginMode").value = mode;
    $("userCodeBlock").style.display = callback && !session.userCode ? "none" : "block";
    $("userCodeLabel").textContent = callback ? "本地回调端口" : "设备码";
    $("userCode").textContent = session.userCode || "";
    var uri = session.verificationUriComplete || session.verificationUri || "";
    var link = $("verifyLink");
    link.href = uri || "#";
    link.textContent = callback ? "点此在浏览器打开并确认" : (uri || "打开验证页面");
    var tip = $("loginModeTip");
    tip.style.display = callback ? "block" : "none";
    tip.textContent = callback ? "回调端口需对本机/容器可达，且浏览器需能访问对应端口。" : "";
    setLoginState("等待浏览器确认…（" + modeText(mode) + "）");
    stopPolling();
    pollTimer = setInterval(pollLogin, 2000);
  }
  function stopPolling() { if (pollTimer) { clearInterval(pollTimer); pollTimer = null; } }
  function pollLogin() {
    if (!currentSession) return;
    api("/admin/api/login/" + encodeURIComponent(currentSession.id)).then(function (s) {
      var mode = s.mode || (currentSession && currentSession.mode) || "device";
      if (s.status === "pending") { setLoginState("等待浏览器确认…（" + modeText(mode) + "）"); return; }
      stopPolling();
      if (s.status === "approved") {
        setLoginState("登录成功（" + modeText(mode) + "）" + (s.email ? "：" + s.email : ""), "ok");
        toast("账号已加入账号池", "ok");
        loadAccounts(); loadStatus(); loadUsage();
      } else {
        setLoginState("登录未完成：" + s.status + (s.error ? " - " + s.error : ""), "err");
      }
    }).catch(function (e) { setLoginState("轮询失败：" + e.message, "err"); });
  }
  $("loginBtn").onclick = function () {
    var btn = this;
    var mode = $("loginMode").value || "device";
    btn.disabled = true;
    jsonApi("/admin/api/login/start", { mode: mode }).then(showLogin).catch(function (e) {
      toast("发起登录失败：" + e.message, "err");
    }).finally(function () { btn.disabled = false; });
  };
  $("cancelBtn").onclick = function () {
    if (!currentSession) return;
    api("/admin/api/login/" + encodeURIComponent(currentSession.id) + "/cancel", { method: "POST" })
      .catch(function () { /* 取消失败无关紧要 */ })
      .finally(function () { stopPolling(); setLoginState("已取消"); });
  };
  $("loginMode").onchange = updateLoginModeNote;
  $("importBtn").onclick = function () {
    $("importPanel").style.display = "block";
    $("importInput").focus();
  };
  $("importClose").onclick = function () {
    $("importPanel").style.display = "none";
    clearImportMessages();
  };
  $("importSubmit").onclick = submitImport;

  /* ---------- logs ---------- */
  function loadLogs() {
    api("/admin/api/requests?limit=100").then(function (data) {
      logData = data.entries;
      $("logTotal").textContent = data.stats.total;
      $("logRecent").textContent = data.stats.last5Minutes;
      $("logFailed").textContent = data.stats.failed;
      renderLogs();
    }).catch(function (e) {
      var body = $("logsBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "日志读取失败：" + e.message);
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }
  function renderLogs() {
    var body = $("logsBody");
    var rows = logData.filter(function (e) {
      if (logFilter === "ok") return e.status >= 200 && e.status < 300;
      if (logFilter === "fail") return !(e.status >= 200 && e.status < 300);
      return true;
    });
    clear(body);
    if (!rows.length) {
      var tr = el("tr");
      var td = el("td", "empty sm", logData.length ? "当前筛选下没有记录。" : "还没有请求记录。");
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
      return;
    }
    rows.forEach(function (e) {
      var tr = el("tr");
      tr.appendChild(el("td", "nowrap sm mono", fmtClock(e.at)));

      var td2 = el("td", "id-cell");
      td2.appendChild(el("span", null, e.model));
      if (e.stream) {
        var streamTag = el("span", "xs faint");
        streamTag.textContent = " · 流式";
        td2.appendChild(streamTag);
      }
      tr.appendChild(td2);

      var td3 = el("td", "nowrap");
      td3.appendChild(statusBadge(e.status));
      tr.appendChild(td3);

      var td4 = el("td", "nowrap sm num", e.durationMs + " ms");
      tr.appendChild(td4);

      var td5 = el("td", "sm");
      if (e.error) {
        td5.className = "sm err";
        td5.textContent = summarize(e.error, 110);
      } else {
        td5.className = "sm faint mono";
        td5.textContent = e.accountId || "-";
      }
      tr.appendChild(td5);
      body.appendChild(tr);
    });
  }
  var logChips = document.querySelectorAll("#logChips .chip");
  for (var k = 0; k < logChips.length; k++) {
    logChips[k].onclick = function () {
      logFilter = this.getAttribute("data-logfilter");
      for (var j = 0; j < logChips.length; j++) logChips[j].classList.toggle("active", logChips[j] === this);
      renderLogs();
    };
  }
  $("logReload").onclick = loadLogs;
  function syncLogTimer() {
    if (logTimer) { clearInterval(logTimer); logTimer = null; }
    if ($("logAuto").checked) {
      logTimer = setInterval(function () {
        if ($("view-logs").classList.contains("active")) loadLogs();
      }, 5000);
    }
  }
  $("logAuto").onchange = syncLogTimer;
  $("refreshAll").onclick = function () { loadStatus(); loadUsage(); loadAccounts(); loadMiniLogs(); loadModels(true); toast("已刷新"); };
  $("usageReload").onclick = loadUsage;

  /* ---------- boot ---------- */
  fillSnippets();
  renderChat();
  show(location.hash.slice(1) || "overview");
  loadLoginModes();
  loadAccounts();
  loadStatus();
  loadUsage();
  loadMiniLogs();
  syncLogTimer();
})();
</script>
</body>
</html>`;
