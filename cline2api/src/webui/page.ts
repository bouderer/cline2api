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
    /* Chart series slots. Validated as a set against this surface: adjacent
       CVD ΔE 24.7, normal-vision ΔE 33.6, all ≥3:1 contrast (see dataviz).
       Slots 4-8 extend the same validated order for the per-model chart, where
       each model needs its own identity. The light slots 3, 4 and 5 sit below
       3:1 by design, which obligates the relief the per-model table provides. */
    --s1:#2a78d6; --s2:#eb6834; --s3:#1baf7a; --s4:#eda100;
    --s5:#e87ba4; --s6:#008300; --s7:#4a3aa7; --s8:#e34948;
    --grid:#e5e7eb; --axis:#c3c2b7;
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
      /* The same hues re-stepped for the dark surface, not an auto-flip. */
      --s1:#3987e5; --s2:#d95926; --s3:#199e70; --s4:#c98500;
      --s5:#d55181; --s6:#008300; --s7:#9085e9; --s8:#e66767;
      --grid:#252a33; --axis:#383835;
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

  /* ---------- charts ---------- */
  .chart-host { position:relative; width:100%; }
  .chart { display:block; width:100%; height:220px; overflow:visible; }
  /* Band edges separated by a 2px surface gap rather than a stroke: the gap is
     what makes touching marks read apart, and a stroke would add ink that is
     not data. */
  .c-area { stroke:var(--surface); stroke-width:2; }
  .c-line { fill:none; stroke-width:2; stroke-linejoin:round; stroke-linecap:round; }
  .c-dot { stroke:var(--surface); stroke-width:2; }
  .c-grid { stroke:var(--grid); stroke-width:1; }
  .c-tick { fill:var(--muted); font-size:11px; font-family:var(--sans); }
  .c-hit { fill:transparent; }
  .c-hit:hover { fill:var(--text); opacity:.04; }
  .legend { display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:var(--muted); }
  .legend .lg { display:inline-flex; align-items:center; gap:6px; }
  .legend .lg i { width:10px; height:10px; border-radius:3px; display:inline-block; }
  .chart-tip {
    position:absolute; pointer-events:none; z-index:5;
    background:var(--surface); border:1px solid var(--border-strong); border-radius:9px;
    box-shadow:var(--shadow); padding:8px 10px; font-size:12px; min-width:150px;
  }
  .chart-tip .tip-row { display:flex; justify-content:space-between; gap:14px; }
  .chart-tip .tip-k { color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
  .chart-tip .tip-v { font-variant-numeric:tabular-nums; }
  .chart-tip .tip-sw { width:9px; height:9px; border-radius:2px; display:inline-block; flex:none; }

  /* Pager under a paginated table, and under the overview's usage card. */
  .card-foot {
    padding:11px 18px; border-top:1px solid var(--border);
    display:flex; align-items:center; justify-content:space-between; gap:12px; flex-wrap:wrap;
    color:var(--muted); font-size:12.5px;
  }
  .card-foot:empty { display:none; }
  .pager { display:flex; align-items:center; gap:7px; }
  .pager button {
    font:inherit; font-size:12.5px; cursor:pointer; padding:5px 10px;
    border:1px solid var(--border-strong); border-radius:var(--radius-sm);
    background:var(--surface); color:var(--text);
  }
  .pager button:disabled { opacity:.45; cursor:not-allowed; }
  .pager .num { font-variant-numeric:tabular-nums; }
  input[type=number] {
    font:inherit; color:var(--text); background:var(--surface);
    border:1px solid var(--border-strong); border-radius:var(--radius-sm); padding:7px 10px;
  }
  label.row > input[type=checkbox] { width:auto; }
  /* A row whose last liveness check failed, so a sweep stays readable. */
  tr.row-failed td { background:var(--err-soft); }
  tr.row-failed td:first-child { box-shadow:inset 3px 0 0 var(--err); }

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
      <button data-view="quota">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 21a9 9 0 100-18 9 9 0 000 18zM12 12l4.5-4.5M12 3v2M21 12h-2M12 21v-2M3 12h2"/></svg>
        配额
      </button>
      <button data-view="proxies">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a9 9 0 100 18 9 9 0 000-18zM3 12h18M12 3c2.5 2.6 3.8 5.7 3.8 9S14.5 18.4 12 21c-2.5-2.6-3.8-5.7-3.8-9S9.5 5.6 12 3z"/></svg>
        代理
      </button>
      <button data-view="keys">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 2l-2 2m-7.6 7.6a5.5 5.5 0 11-7.78 7.78 5.5 5.5 0 017.78-7.78zm0 0L19 3.5m-3.5 3.5L18 9.5"/></svg>
        密钥
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
          <div class="k">今日 Token</div>
          <div class="v num" id="sToday">—</div>
          <div class="s" id="sTodayHint">—</div>
        </div>
        <div class="stat">
          <div class="k">配额占用最高</div>
          <div class="v num" id="sQuota">—</div>
          <div class="s" id="sQuotaHint">—</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <div>
            <h2>用量走势</h2>
            <div class="hint" id="ovChartHint">—</div>
          </div>
          <div class="actions">
            <button class="btn small" data-goto="quota">配额详情</button>
          </div>
        </div>
        <div class="card-body">
          <div id="ovChartWrap"><div class="muted sm">读取中…</div></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <h2>账号用量</h2>
          <div class="row">
            <label class="field" style="margin:0">
              <select id="winPreset" style="min-width:132px">
                <option value="1">最近 1 小时</option>
                <option value="6">最近 6 小时</option>
                <option value="24" selected>最近 24 小时</option>
                <option value="72">最近 3 天</option>
                <option value="168">最近 7 天</option>
                <option value="720">最近 30 天</option>
                <option value="custom">自定义…</option>
              </select>
            </label>
            <input type="number" id="winHours" min="0.1" max="720" step="0.5" value="24" style="width:88px; display:none" title="窗口长度（小时）" />
            <label class="row xs muted" id="winAnchorWrap" style="gap:5px; margin:0; cursor:pointer" title="从本地今天零点算起，而不是从现在往回滚 24 小时">
              <input type="checkbox" id="winAnchorDay" style="width:auto; margin:0" />
              从今天零点起
            </label>
            <button class="btn small" id="usageReload">重新读取</button>
          </div>
        </div>
        <div class="card-body" id="usageBody">
          <div class="muted sm">读取中…</div>
        </div>
        <div class="card-foot" id="usagePager"></div>
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

    <!-- ============ 配额 ============ -->
    <section class="view" id="view-quota">
      <div class="page-head">
        <div>
          <h1>配额</h1>
          <p>用量随时间的走势、按模型拆分，以及每个账号的免费额度状态。免费额度按「账号 × 模型」每天重置。</p>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>用量走势</h2>
            <div class="hint" id="chartHint">—</div>
          </div>
          <div class="row" style="gap:8px">
            <select id="chartMetric" style="width:auto; min-width:130px">
              <option value="totalTokens">Token</option>
              <option value="requests">请求数</option>
              <option value="costUsd">费用</option>
              <option value="cacheHitRate">缓存命中率</option>
            </select>
            <button class="btn small" id="chartReload">重新读取</button>
          </div>
        </div>
        <div class="card-body">
          <div id="chartWrap"></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <div>
            <h2>按模型走势</h2>
            <div class="hint" id="modelChartHint">—</div>
          </div>
          <div class="row" style="gap:8px">
            <select id="modelChartMetric" style="width:auto; min-width:110px">
              <option value="tokens">Token</option>
              <option value="requests">请求数</option>
            </select>
          </div>
        </div>
        <div class="card-body">
          <div id="modelChartWrap"><div class="muted sm">读取中…</div></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <div>
            <h2>按模型用量</h2>
            <div class="hint" id="modelUsageHint">—</div>
          </div>
          <button class="btn small" id="modelUsageReload">重新读取</button>
        </div>
        <div class="card-body tight" id="modelUsageBody">
          <div class="muted sm">读取中…</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <div>
            <h2>免费额度</h2>
            <div class="hint">上游没有查剩余额度的接口，所以这里给出的是可观测信号（真实请求撞到 <span class="mono">Daily free limit</span> 的时刻，或手动探测结果）加上按已用 token 推算的占用度。均为本地自然日。</div>
          </div>
          <div class="row" style="gap:8px">
            <button class="btn small" id="freeQuotaReload">刷新</button>
          </div>
        </div>
        <div class="card-body tight">
          <div class="row" style="gap:8px; margin-bottom:10px; flex-wrap:wrap">
            <input type="text" id="freeProbeModel" class="mono" style="min-width:260px"
              title="探测用的免费模型，必须是免费桶里的模型，否则探测不到免费额度" />
            <button class="btn small primary" id="freeProbeSelected">探测选中账号</button>
            <button class="btn small" id="freeProbeExhausted">只探「已耗尽」</button>
            <span class="xs muted" id="freeProbeStatus">—</span>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr>
                <th class="nowrap" style="width:34px"><input type="checkbox" id="freeProbeAll" title="全选 / 全不选" style="width:auto; margin:0" /></th>
                <th>账号</th><th class="nowrap">状态</th><th style="min-width:240px">免费额度占用</th><th class="nowrap">依据</th><th>说明</th>
              </tr></thead>
              <tbody id="freeQuotaBody"><tr><td colspan="6" class="empty sm">加载中…</td></tr></tbody>
            </table>
          </div>
        </div>
      </div>
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

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <div>
            <h2>全局测活</h2>
            <div class="hint" id="sweepHint">对全池每个账号发 1 次真实请求，确认那个账号现在真的能出结果。不传模型则按凭据阶段探测（省钱、不消耗额度）。</div>
          </div>
        </div>
        <div class="card-body">
          <div class="row" style="gap:8px; flex-wrap:wrap">
            <label class="field" style="margin:0; min-width:300px">
              <span>测试模型（可选，留空=只验凭据）</span>
              <input type="text" id="sweepModel" class="mono" list="sweepModelList" placeholder="cline-free/kimi-k3" />
            </label>
            <datalist id="sweepModelList"></datalist>
            <label class="row xs muted" style="gap:5px; margin:0; cursor:pointer" title="只测未被停用的账号">
              <input type="checkbox" id="sweepActiveOnly" checked style="width:auto; margin:0" />
              只测可用账号
            </label>
            <label class="row xs muted" style="gap:5px; margin:0; cursor:pointer" title="只测当前列表里被停用或最近报错的账号">
              <input type="checkbox" id="sweepFailedOnly" style="width:auto; margin:0" />
              只测失败账号
            </label>
            <label class="field" style="margin:0; max-width:110px">
              <span>并发</span>
              <input type="number" id="sweepConcurrency" min="1" max="24" value="6" />
            </label>
            <button class="btn primary" id="sweepStart">开始全局测活</button>
            <button class="btn small" id="sweepStop" style="display:none">中止</button>
          </div>
          <div style="margin-top:12px; display:none" id="sweepProgressWrap">
            <div class="bar"><i id="sweepProgressFill" style="width:0%"></i></div>
          </div>
          <div class="xs muted" id="sweepStatus" style="margin-top:8px; white-space:pre-wrap">—</div>
          <div class="xs err" id="sweepFailures" style="margin-top:6px; white-space:pre-wrap"></div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <h2>账号列表</h2>
          <div class="row">
            <select id="acctStatus" style="width:auto; min-width:110px">
              <option value="all">全部状态</option>
              <option value="active">仅可用</option>
              <option value="disabled">仅停用</option>
            </select>
            <input type="text" id="acctSearch" placeholder="搜索邮箱 / 标签…" style="width:190px" />
            <button class="btn small" id="acctReload">刷新</button>
          </div>
        </div>
        <div class="card-body" id="batchBar" style="display:none; padding-bottom:0">
          <div class="row" style="gap:8px">
            <span class="sm" id="batchCount">已选 0 个</span>
            <span class="spacer"></span>
            <button class="btn small" id="batchProbe">批量测活</button>
            <button class="btn small" id="batchSelectFailed" title="把已知失败的账号加入选择">选择失败</button>
            <button class="btn small" id="batchDisable">批量停用</button>
            <button class="btn small danger" id="batchDelete">批量删除</button>
            <button class="btn small ghost" id="batchClear">取消选择</button>
          </div>
          <div class="xs muted" id="batchStatus" style="margin-top:8px; white-space:pre-wrap"></div>
        </div>
        <div class="card-body tight">
          <table>
            <thead><tr>
              <th class="nowrap" style="width:34px"><input type="checkbox" id="acctSelectAll" title="选中本页全部" /></th>
              <th>账号</th><th class="nowrap">状态</th><th class="nowrap">令牌到期</th><th class="nowrap">代理</th><th class="nowrap" style="min-width:220px">操作</th>
            </tr></thead>
            <tbody id="accountsBody"><tr><td colspan="6" class="empty sm">加载中…</td></tr></tbody>
          </table>
        </div>
        <div class="card-foot" id="accountsPager"></div>
      </div>
    </section>

    <!-- ============ 代理 ============ -->
    <section class="view" id="view-proxies">
      <div class="page-head">
        <div>
          <h1>上游代理</h1>
          <p>给账号绑定出口代理，避免整池账号共用一个来源 IP。地址含密码，界面只显示打码形式。</p>
        </div>
        <div class="actions"><button class="btn primary" id="proxyAddBtn">新增代理</button></div>
      </div>

      <div class="card" id="proxyFormPanel" style="display:none">
        <div class="card-head">
          <div><h2>新增代理</h2><div class="hint">形如 <code>http://user:pass@host:port</code>，支持 http / https / socks4 / socks5。</div></div>
          <button class="btn small ghost" id="proxyFormClose">关闭</button>
        </div>
        <div class="card-body">
          <div class="grid two">
            <label class="field"><span>代理地址</span><input type="text" id="proxyUrl" placeholder="http://user:pass@host:port" autocomplete="off" /></label>
            <label class="field"><span>备注（可选）</span><input type="text" id="proxyLabel" placeholder="例如 美西住宅 / 提供商A" /></label>
          </div>
          <div class="row between" style="margin-top:12px">
            <div class="sm err" id="proxyError" style="display:none; white-space:pre-wrap"></div>
            <button class="btn primary" id="proxySubmit" style="margin-left:auto">保存</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head"><h2>代理列表</h2><button class="btn small" id="proxyReload">刷新</button></div>
        <div class="card-body tight">
          <table>
            <thead><tr><th>备注 / 地址</th><th class="nowrap">状态</th><th class="nowrap">被引用</th><th class="nowrap" style="min-width:190px">操作</th></tr></thead>
            <tbody id="proxiesBody"><tr><td colspan="4" class="empty sm">加载中…</td></tr></tbody>
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

    <!-- ============ 密钥 ============ -->
    <section class="view" id="view-keys">
      <div class="page-head">
        <div>
          <h1>请求密钥</h1>
          <p>客户端调用 /v1/* 用的密钥。明文只在创建或轮换时显示一次，之后无法找回，只能重新轮换。</p>
        </div>
        <div class="actions">
          <button class="btn" id="keyReload">刷新</button>
          <button class="btn primary" id="keyAddBtn">新建密钥</button>
        </div>
      </div>

      <div class="grid cols" id="keyStats">
        <div class="stat"><div class="k">密钥总数</div><div class="v num" id="kTotal">—</div></div>
        <div class="stat"><div class="k">启用中</div><div class="v num" id="kEnabled">—</div></div>
        <div class="stat"><div class="k">累计调用</div><div class="v num" id="kUses">—</div></div>
      </div>

      <div class="card" id="keyFormPanel" style="display:none; margin-top:14px">
        <div class="card-head">
          <div><h2>新建密钥</h2><div class="hint">备注用来区分用途，例如 Cursor / NextChat / 朋友。</div></div>
          <button class="btn small ghost" id="keyFormClose">关闭</button>
        </div>
        <div class="card-body">
          <label class="field" style="max-width:460px"><span>备注（可选）</span>
            <input type="text" id="keyLabel" placeholder="例如 给 Cursor 的" />
          </label>
          <div class="row between" style="margin-top:12px">
            <div class="sm err" id="keyError" style="display:none; white-space:pre-wrap"></div>
            <button class="btn primary" id="keySubmit" style="margin-left:auto">生成</button>
          </div>
          <div id="keyResult" style="display:none; margin-top:14px; padding:14px; border:1px solid var(--ok, #065f46); border-radius:10px">
            <div class="sm ok" style="font-weight:600">新密钥（只这一次）—— 关闭本面板前都可以复制：</div>
            <textarea readonly id="keyPlaintext" class="mono" rows="2" style="width:100%; margin-top:8px; resize:none"></textarea>
            <div class="row" style="margin-top:8px; gap:8px">
              <button class="btn small primary" id="keyCopy">复制密钥</button>
              <button class="btn small" id="keySelect">全选</button>
            </div>
          </div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-head">
          <div>
            <h2>限流</h2>
            <div class="hint">只作用于模型调用接口（<span class="mono">/v1/chat/completions</span>、<span class="mono">/v1/responses</span>、<span class="mono">/v1/messages</span>）。密钥超过每分钟上限会立刻返回 429，方便客户端换密钥；全站超过上限则先等待约 10 秒，仍无空位才拒绝。</div>
          </div>
          <div class="row" style="gap:8px">
            <span class="xs muted" id="rlEnabledLabel">—</span>
            <button class="btn small" id="rlReset">清零计数</button>
          </div>
        </div>
        <div class="card-body">
          <div class="row" style="gap:12px; flex-wrap:wrap; align-items:flex-end">
            <label class="field" style="margin:0; max-width:150px">
              <span>全站 / 分钟</span>
              <input type="number" id="rlGlobal" min="1" />
            </label>
            <label class="field" style="margin:0; max-width:150px">
              <span>每个密钥 / 分钟</span>
              <input type="number" id="rlKey" min="1" />
            </label>
            <label class="row xs" style="gap:5px; margin:0 0 6px; cursor:pointer">
              <input type="checkbox" id="rlEnabled" style="width:auto; margin:0" />
              启用限流
            </label>
            <button class="btn primary" id="rlSave" style="margin-bottom:2px">保存</button>
          </div>
          <div class="xs muted" id="rlUsage" style="margin-top:10px">—</div>
        </div>
      </div>

      <div class="card" style="margin-top:14px">
        <div class="card-body tight">
          <table>
            <thead><tr><th>备注 / 前缀</th><th class="nowrap">状态</th><th class="nowrap">调用</th><th class="nowrap">最后使用</th><th class="nowrap" style="min-width:210px">操作</th></tr></thead>
            <tbody id="keysBody"><tr><td colspan="5" class="empty sm">加载中…</td></tr></tbody>
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
    // execCommand is the fallback for contexts where the async clipboard is
    // denied (HTTP, a permission prompt dismissed, an iframe). It needs a
    // focused, selectable element, so a hidden textarea is created on demand.
    function fallback() {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.position = "fixed";
      area.style.left = "-9999px";
      document.body.appendChild(area);
      area.select();
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (e) { ok = false; }
      document.body.removeChild(area);
      toast(ok ? (okMsg || "已复制") : "复制失败，请手动选中文本", ok ? "ok" : "err");
    }
    if (navigator.clipboard && navigator.clipboard.writeText && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(
        function () { toast(okMsg || "已复制", "ok"); },
        fallback
      );
    } else {
      fallback();
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

  /* ---------- credit / token formatting ---------- */
  // Two dollar-ish scales come back from upstream and they are 100x apart, so
  // each has its own constant here rather than one shared divider:
  //   balance / creditsUsed -> micro-USD, 1e6 per USD
  //   costUsd               -> 1e8 per USD
  // The server already converts cost into dollars as costUsd; these helpers
  // only deal with the micro-USD fields.
  var COST_UNITS_PER_USD = 1e8;
  function fmtTok(n) {
    if (n === null || n === undefined) return "—";
    var v = Number(n) || 0;
    if (v >= 1e9) return (v / 1e9).toFixed(2) + "B";
    if (v >= 1e6) return (v / 1e6).toFixed(2) + "M";
    if (v >= 1e3) return (v / 1e3).toFixed(1) + "K";
    return String(v);
  }
  function fmtUsd(micro) {
    if (micro === null || micro === undefined) return "—";
    var v = Number(micro) / 1e6;
    return (v < 0 ? "-$" : "$") + Math.abs(v).toFixed(4);
  }
  /** costUsd totals already arrive scaled to USD by the server. */
  function fmtCost(usd) {
    if (usd === null || usd === undefined) return "—";
    var v = Number(usd) || 0;
    if (v === 0) return "$0";
    if (v < 0.01) return "$" + v.toFixed(5);
    return "$" + v.toFixed(4);
  }
  function fmtCredits(micro) {
    if (micro === null || micro === undefined) return "—";
    return (Number(micro) / 1e4).toFixed(2);
  }
  function fmtAgo(ts) {
    if (!ts) return "—";
    var secs = Math.max(0, Math.round((Date.now() - ts) / 1000));
    if (secs < 60) return secs + " 秒前";
    if (secs < 3600) return Math.round(secs / 60) + " 分钟前";
    if (secs < 86400) return Math.round(secs / 3600) + " 小时前";
    return Math.round(secs / 86400) + " 天前";
  }

  /** Run fn after ms of quiet, so a burst of keystrokes costs one call. */
  function debounce(fn, ms) {
    var timer = null;
    return function () {
      var self = this;
      var args = arguments;
      clearTimeout(timer);
      timer = setTimeout(function () { fn.apply(self, args); }, ms);
    };
  }

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
  /**
   * POST a JSON body (or PATCH/DELETE when a method is given).
   *
   * The body is passed as an object, not a pre-stringified one. An earlier
   * version whose signature was path/body/method had four call sites written
   * in the path/options shape instead, which silently sent the wrapper object
   * as the payload; the route then failed with a confusing "model is required"
   * or "Unknown route" rather than anything pointing at the caller.
   */
  function jsonApi(path, body, method) {
    return api(path, {
      method: method || "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
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
  var views = ["overview", "models", "play", "accounts", "quota", "proxies", "keys", "logs"];
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
    if (name === "accounts") { loadAccounts(); loadModels(); pollSweep(); }
    if (name === "proxies") loadProxyView();
    if (name === "keys") { loadKeys(); loadRateLimit(); }
    if (name === "overview") { loadStatus(); loadUsage(); loadMiniLogs(); loadTimeline(); }
    if (name === "quota") { loadTimeline(); loadModelUsage(); loadFreeQuota(); loadModels(); }
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

  /**
   * Render a pager into the host element.
   *
   * Paging is server-side: the usage and credits tables each cost upstream
   * calls per row, so fetching the whole pool to display twenty would spend the
   * upstream budget on rows nobody looks at. The pager therefore only reports
   * and requests page numbers; it never slices client-side.
   */
  function renderPager(host, page, totalPages, total, pageSize, onGo) {
    clear(host);
    if (!total) return;
    var from = (page - 1) * pageSize + 1;
    var to = Math.min(page * pageSize, total);
    var label = el("span", "xs muted",
      (total > pageSize ? ("第 " + from + "–" + to + " 条，共 " + total + " 条") : ("共 " + total + " 条")));

    var box = el("div", "pager");
    function step(text, target, disabled) {
      var b = el("button", null, text);
      b.disabled = disabled;
      if (!disabled) b.onclick = function () { onGo(target); };
      box.appendChild(b);
    }
    step("首页", 1, page <= 1);
    step("上一页", page - 1, page <= 1);
    box.appendChild(el("span", "num xs", page + " / " + totalPages));
    step("下一页", page + 1, page >= totalPages);
    step("末页", totalPages, page >= totalPages);

    host.appendChild(label);
    host.appendChild(box);
  }

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

  /**
   * Usage window for the overview's consumption columns.
   *
   * Default is a rolling 24 hours rather than "today", because a rolling window
   * is always full: two readings an hour apart are comparable, and the number
   * does not drop to zero at midnight. "按自然日" restores the calendar view.
   */
  var usageWindow = { hours: 24, anchorDay: false };
  var usagePage = 1;
  var usagePageSize = 20;
  var creditsById = {};
  var creditsLoaded = false;
  var creditsError = null;

  function windowQuery(extra) {
    var parts = ["hours=" + encodeURIComponent(usageWindow.hours)];
    if (usageWindow.anchorDay) parts.push("anchor=day");
    if (extra) parts.push(extra);
    return parts.join("&");
  }

  function windowLabel() {
    var h = usageWindow.hours;
    if (usageWindow.anchorDay) return "今天零点至今";
    var span = h < 1 ? (Math.round(h * 60) + " 分钟")
      : (h < 48 ? (h + " 小时") : (Math.round(h / 24) + " 天"));
    return "最近 " + span;
  }

  function loadCredits(force, page) {
    var q = windowQuery("page=" + page + "&pageSize=" + usagePageSize + (force ? "&refresh=1" : ""));
    return api("/admin/api/credits?" + q)
      .then(function (data) {
        var next = {};
        (data.accounts || []).forEach(function (row) { next[row.id] = row; });
        creditsById = next;
        creditsLoaded = true;
        creditsError = null;
        lastCreditsMeta = data;
        return data;
      })
      .catch(function (e) {
        creditsError = e.message;
        return null;
      });
  }

  function renderUsage(data, creditsMeta) {
    var body = $("usageBody");
    clear(body);
    var accounts = data.accounts || [];
    if (!accounts.length) {
      body.className = "muted sm";
      body.textContent = "还没有账号，先到「账号」页登录。";
      renderPager($("usagePager"), 1, 1, 0, usagePageSize, function () {});
      return;
    }
    body.className = "";

    var table = el("table");
    var thead = el("thead");
    var htr = el("tr");
    ["账号", "余额", "套餐", "用量（5 小时 / 周 / 月）", "下次重置"].forEach(function (t) { htr.appendChild(el("th", "nowrap", t)); });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el("tbody");
    var worst = 0;
    var worstLabel = "";

    accounts.forEach(function (a) {
      var tr = el("tr");
      var credit = creditsById[a.id] || null;

      var td1 = el("td");
      var acct = el("div", "acct");
      acct.appendChild(el("span", "mail", a.email || a.id));
      var tags = el("div", "row");
      tags.style.gap = "6px";
      if (a.disabled) tags.appendChild(el("span", "badge err", "需重新登录"));
      if (a.error) tags.appendChild(el("span", "badge warn", summarize(a.error, 28)));
      if (tags.childNodes.length) acct.appendChild(tags);

      // Consumption over the selected window: the line that answers "is this
      // account actually doing work", which a balance alone cannot.
      var windowLine = el("div", "xs faint");
      var creditWindow = credit ? credit.window : null;
      if (credit && credit.error) {
        windowLine.className = "xs warn";
        windowLine.textContent = "余额读取失败：" + summarize(credit.error, 40);
      } else if (creditWindow) {
        var bits = [windowLabel() + " " + fmtTok(creditWindow.totalTokens) + " tok"];
        bits.push((creditWindow.requests || 0) + " 次");
        if (creditWindow.cachedTokens) bits.push("缓存 " + fmtTok(creditWindow.cachedTokens));
        if (creditWindow.costUsd) bits.push(fmtCost(creditWindow.costUsd));
        windowLine.textContent = bits.join(" · ");
        acct.appendChild(windowLine);

        var lastLine = el("div", "xs faint");
        if (credit.lastUsage) {
          lastLine.textContent = "最后 " + fmtAgo(credit.lastUsage.at) +
            (credit.lastUsage.model ? " · " + credit.lastUsage.model : "");
        } else {
          lastLine.textContent = "窗口内无请求";
        }
        acct.appendChild(lastLine);
      } else if (creditsLoaded && !creditsError) {
        windowLine.textContent = windowLabel() + " —";
        acct.appendChild(windowLine);
      }
      td1.appendChild(acct);
      tr.appendChild(td1);

      var tdBal = el("td", "nowrap num");
      if (credit && credit.balanceMicroUsd !== null && credit.balanceMicroUsd !== undefined) {
        var bal = el("div", "sm", fmtUsd(credit.balanceMicroUsd));
        if (credit.balanceMicroUsd < 0) bal.className = "sm err";
        tdBal.appendChild(bal);
        tdBal.appendChild(el("div", "xs faint", fmtCredits(credit.balanceMicroUsd) + " credits"));
      } else {
        tdBal.appendChild(el("span", "sm faint", "—"));
      }
      tr.appendChild(tdBal);

      var td2 = el("td", "nowrap");
      var plan = a.plan;
      if (plan && !plan.error) {
        td2.appendChild(el("div", "sm", plan.displayName || "未知套餐"));
        var sub = el("div", "xs faint");
        var planBits = [];
        if (plan.interval) planBits.push(plan.interval);
        planBits.push(plan.isActive ? "生效中" : "未生效");
        if (plan.currentPeriodEnd) planBits.push("至 " + fmtDay(plan.currentPeriodEnd));
        sub.textContent = planBits.join(" · ");
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
    // The row totals only cover the visible rows; the headline counters
    // above come from the pool-wide summary endpoint instead.
    var note = "用量来自 /api/v1/users/me/plan/usage-limits；余额与 token 来自 /v1/users/{uid}/balance 与 /usages（每账号 60 秒缓存）。";
    if (creditsError) note += " 本次余额读取失败：" + summarize(creditsError, 60);
    body.appendChild(el("div", "xs muted", note));

    $("sQuota").textContent = worst ? worst + "%" : "—";
    $("sQuotaHint").textContent = worstLabel || "三个窗口均未上报用量";

    var meta = creditsMeta || { page: 1, pageSize: usagePageSize, total: accounts.length, totalPages: 1 };
    renderPager($("usagePager"), meta.page, meta.totalPages, meta.total, meta.pageSize, function (p) {
      usagePage = p;
      loadUsage(false, p);
    });
  }

  /* ---------- charts ---------- */
  /**
   * Inline-SVG usage charts.
   *
   * Hand-rolled rather than pulled from a library: the page is a single file
   * with no external assets, and the forms needed here (a stacked area for
   * token composition, a line for a rate) are a few dozen lines of path
   * arithmetic.
   *
   * Design rules the drawing follows, so the charts stay honest:
   *   - one y-axis, never two; a second measure gets its own chart;
   *   - thin marks (2px lines), a 2px surface gap between stacked bands, and a
   *     surface ring on markers, so touching marks read apart without borders;
   *   - a legend whenever there are two or more series, and identity never
   *     rides on color alone;
   *   - recessive hairline gridlines, and text in ink tokens, never series color.
   * Colors are the validated categorical slots declared as CSS variables at the
   * top of this file, so light and dark are two selected sets, not a flip.
   */
  var CHART = { w: 900, h: 220, padL: 56, padR: 16, padT: 14, padB: 26 };

  /** Short human label for a bucket's start time. */
  function bucketLabel(at, stepMs) {
    var d = new Date(at);
    var hh = String(d.getHours()).padStart(2, "0");
    var mm = String(d.getMinutes()).padStart(2, "0");
    if (stepMs >= 24 * 3600 * 1000) return (d.getMonth() + 1) + "/" + d.getDate();
    if (stepMs >= 3600 * 1000) return hh + ":00";
    return hh + ":" + mm;
  }

  function bucketStepMs(buckets) {
    if (buckets.length < 2) return 3600 * 1000;
    return buckets[1].at - buckets[0].at;
  }

  /** Compact axis numbers: 1.2K / 3.4M, and dollars for cost. */
  function axisNum(v, kind) {
    if (kind === "costUsd") return fmtCost(v);
    if (kind === "cacheHitRate") return Math.round(v * 100) + "%";
    return fmtTok(v);
  }

  /**
   * Build the SVG for a timeline.
   *
   * The metric picks the form: the token view stacks prompt/completion/cache
   * (the composition is the story), the rate view draws a single line.
   */
  function chartSvg(data, metric) {
    var buckets = data.buckets || [];
    if (!buckets.length) return null;
    var step = bucketStepMs(buckets);
    var W = CHART.w, H = CHART.h;
    var plotW = W - CHART.padL - CHART.padR;
    var plotH = H - CHART.padT - CHART.padB;

    // Series definition per metric. Stacked when the parts sum to the whole.
    var series, stacked = false, kind = metric;
    if (metric === "totalTokens") {
      // Cache is a subset of prompt, so it is drawn as its own band rather than
      // a fourth stack layer; completion sits on top of the rest.
      series = [
        { key: "cachedTokens", label: "缓存命中", varName: "--s1" },
        { key: "promptTokens", label: "输入（未命中）", varName: "--s2" },
        { key: "completionTokens", label: "输出", varName: "--s3" },
      ];
      stacked = true;
    } else if (metric === "costUsd") {
      series = [{ key: "costUsd", label: "费用", varName: "--s1" }];
    } else if (metric === "cacheHitRate") {
      series = [{ key: "cacheHitRate", label: "缓存命中率", varName: "--s3" }];
      kind = "cacheHitRate";
    } else {
      series = [{ key: "requests", label: "请求数", varName: "--s1" }];
    }

    // Stacked totals per bucket, with the cache band carved out of prompt so the
    // three bands sum to total tokens rather than double-counting the cache.
    var totals = buckets.map(function (b) {
      if (!stacked) return Number(b[series[0].key]) || 0;
      return (Number(b.promptTokens) || 0) + (Number(b.completionTokens) || 0);
    });
    var maxV = Math.max.apply(null, totals);
    if (!(maxV > 0)) maxV = 1;
    // Round the axis top to a clean step so the ticks read as round numbers.
    var mag = Math.pow(10, Math.floor(Math.log10(maxV)));
    maxV = Math.ceil(maxV / (mag / 2)) * (mag / 2);

    function x(i) { return CHART.padL + (buckets.length === 1 ? plotW / 2 : (plotW * i) / (buckets.length - 1)); }
    function y(v) { return CHART.padT + plotH - (plotH * v) / maxV; }

    var parts = [];
    var defs = [];

    if (stacked) {
      // y0 tracks the running baseline so each band sits on the previous one.
      var lower = buckets.map(function () { return 0; });
      series.forEach(function (s, si) {
        var upper = buckets.map(function (b, i) {
          var v = Number(b[s.key]) || 0;
          // The cache band is part of prompt: subtract it from the input band
          // so the stack sums to the real total instead of double-counting.
          if (s.key === "promptTokens") v -= Number(b.cachedTokens) || 0;
          if (v < 0) v = 0;
          return (lower[i] || 0) + v;
        });
        var top = upper.map(function (v, i) { return x(i) + "," + y(v); });
        var bottom = lower.map(function (v, i) { return x(i) + "," + y(v); }).reverse();
        parts.push('<polygon class="c-area" points="' + top.concat(bottom).join(" ") +
          '" fill="var(' + s.varName + ')" />');
        lower = upper;
      });
    } else {
      var pts = buckets.map(function (b, i) { return x(i) + "," + y(Number(b[series[0].key]) || 0); });
      parts.push('<polyline class="c-line" points="' + pts.join(" ") + '" stroke="var(' + series[0].varName + ')" />');
      // End marker, ringed in the surface color so it stays legible over the line.
      var lastX = x(buckets.length - 1);
      var lastY = y(Number(buckets[buckets.length - 1][series[0].key]) || 0);
      parts.push('<circle class="c-dot" cx="' + lastX + '" cy="' + lastY + '" r="4" fill="var(' + series[0].varName + ')" />');
    }

    // Gridlines + y ticks: hairline, solid, recessive.
    var ticks = 4;
    var grid = [];
    for (var t = 0; t <= ticks; t++) {
      var gv = (maxV * t) / ticks;
      var gy = y(gv);
      grid.push('<line class="c-grid" x1="' + CHART.padL + '" y1="' + gy + '" x2="' + (W - CHART.padR) + '" y2="' + gy + '" />');
      grid.push('<text class="c-tick" x="' + (CHART.padL - 8) + '" y="' + (gy + 3.5) + '" text-anchor="end">' +
        axisNum(gv, kind) + "</text>");
    }

    // X labels: first, middle, last only — a label per bucket is chaos.
    var xLabels = [];
    [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].forEach(function (i, k) {
      if (i < 0 || i >= buckets.length) return;
      if (k === 1 && buckets.length < 5) return;
      var anchor = k === 0 ? "start" : (k === 2 ? "end" : "middle");
      xLabels.push('<text class="c-tick" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' +
        bucketLabel(buckets[i].at, step) + "</text>");
    });

    // Hover hit layer: one invisible band per bucket, wider than the mark.
    var hits = buckets.map(function (b, i) {
      var bw = plotW / Math.max(1, buckets.length - 1);
      return '<rect class="c-hit" x="' + (x(i) - bw / 2) + '" y="' + CHART.padT + '" width="' + bw +
        '" height="' + plotH + '" data-i="' + i + '" />';
    });

    var svg = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img">' +
      defs.join("") + grid.join("") + parts.join("") + hits.join("") + xLabels.join("") + "</svg>";

    // The legend doubles as the identity channel: a colored key plus the label,
    // never a colored label.
    var legend = '<div class="legend">' + series.map(function (s) {
      return '<span class="lg"><i style="background:var(' + s.varName + ')"></i>' + s.label + "</span>";
    }).join("") + "</div>";

    return { svg: svg, legend: legend, step: step };
  }

  /**
   * A model id short enough for a legend but still unique.
   *
   * The last path segment alone is not enough: cline-free/kimi-k3,
   * moonshotai/kimi-k3 and cline-pass/kimi-k3 would all render as "kimi-k3",
   * so a legend of three swatches would name three different models
   * identically. The bucket is therefore kept whenever the bare name alone
   * would collide within the series being drawn.
   */
  function shortModelLabels(ids) {
    var bare = ids.map(function (id) {
      var parts = String(id).split("/");
      return parts[parts.length - 1] || id;
    });
    var counts = {};
    bare.forEach(function (b) { counts[b] = (counts[b] || 0) + 1; });
    return ids.map(function (id, i) {
      if (counts[bare[i]] === 1) return bare[i];
      // Only strip the cline- noise; the distinguishing part is the bucket.
      var parts = String(id).split("/");
      var bucket = parts.length > 1 ? parts[0].replace(/^cline-/, "") : "";
      return bucket ? bucket + "/" + bare[i] : bare[i];
    });
  }

  /**
   * Build the SVG for a per-model timeline.
   *
   * A stacked band per model, most-used at the bottom, so the reading is "who
   * is carrying the pool" rather than "where did these tokens come from". Each
   * model takes a categorical slot by its rank in the ranked series list, and
   * that list does not change when the metric or the window does — so a color
   * always means the same model within a session rather than being reassigned
   * by rank.
   */
  function chartSvgByModel(data, metric) {
    var models = data.models || [];
    var buckets = data.buckets || [];
    if (!models.length || !buckets.length) return null;
    var step = bucketStepMs(buckets);
    var W = CHART.w, H = CHART.h;
    var plotW = W - CHART.padL - CHART.padR;
    var plotH = H - CHART.padT - CHART.padB;
    var key = metric === "requests" ? "requests" : "tokens";
    var axisKind = key === "requests" ? "requests" : "totalTokens";

    var totals = buckets.map(function (_, i) {
      var sum = 0;
      models.forEach(function (m) { sum += Number(m[key][i]) || 0; });
      return sum;
    });
    var maxV = Math.max.apply(null, totals);
    if (!(maxV > 0)) maxV = 1;
    var mag = Math.pow(10, Math.floor(Math.log10(maxV)));
    maxV = Math.ceil(maxV / (mag / 2)) * (mag / 2);

    function x(i) { return CHART.padL + (buckets.length === 1 ? plotW / 2 : (plotW * i) / (buckets.length - 1)); }
    function y(v) { return CHART.padT + plotH - (plotH * v) / maxV; }

    var parts = [];
    var lower = buckets.map(function () { return 0; });
    // Names are computed once for the whole set: uniqueness can only be judged
    // against the siblings being drawn.
    var labels = shortModelLabels(models.map(function (m) { return m.id; }));
    models.forEach(function (m, mi) {
      var upper = buckets.map(function (_, i) {
        return (lower[i] || 0) + (Number(m[key][i]) || 0);
      });
      var top = upper.map(function (v, i) { return x(i) + "," + y(v); });
      var bottom = lower.map(function (v, i) { return x(i) + "," + y(v); }).reverse();
      // Eight validated slots; a ninth model folds into the same rotation, and
      // the table below carries identity for it regardless.
      var slot = (mi % 8) + 1;
      parts.push('<polygon class="c-area" points="' + top.concat(bottom).join(" ") +
        '" fill="var(--s' + slot + ')" />');
      lower = upper;
    });

    var ticks = 4;
    var grid = [];
    for (var t = 0; t <= ticks; t++) {
      var gv = (maxV * t) / ticks;
      var gy = y(gv);
      grid.push('<line class="c-grid" x1="' + CHART.padL + '" y1="' + gy + '" x2="' + (W - CHART.padR) + '" y2="' + gy + '" />');
      grid.push('<text class="c-tick" x="' + (CHART.padL - 8) + '" y="' + (gy + 3.5) + '" text-anchor="end">' +
        axisNum(gv, axisKind) + "</text>");
    }

    var xLabels = [];
    [0, Math.floor((buckets.length - 1) / 2), buckets.length - 1].forEach(function (i, k) {
      if (i < 0 || i >= buckets.length) return;
      if (k === 1 && buckets.length < 5) return;
      var anchor = k === 0 ? "start" : (k === 2 ? "end" : "middle");
      xLabels.push('<text class="c-tick" x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="' + anchor + '">' +
        bucketLabel(buckets[i].at, step) + "</text>");
    });

    var hits = buckets.map(function (b, i) {
      var bw = plotW / Math.max(1, buckets.length - 1);
      return '<rect class="c-hit" x="' + (x(i) - bw / 2) + '" y="' + CHART.padT + '" width="' + bw +
        '" height="' + plotH + '" data-i="' + i + '" />';
    });

    var svg = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img">' +
      grid.join("") + parts.join("") + hits.join("") + xLabels.join("") + "</svg>";

    var legend = '<div class="legend">' + labels.map(function (name, mi) {
      var slot = (mi % 8) + 1;
      return '<span class="lg"><i style="background:var(--s' + slot + ')"></i>' +
        name + "</span>";
    }).join("") + "</div>";

    return { svg: svg, legend: legend, models: models, labels: labels, step: step };
  }

  /** Render the chart plus its hover tooltip layer into the given wrap. */
  function renderChartInto(wrap, hintEl, data, metric) {
    clear(wrap);
    var built = chartSvg(data, metric);
    if (!built) {
      wrap.appendChild(el("div", "muted sm", "窗口内没有用量记录。"));
      if (hintEl) hintEl.textContent = windowLabel() + " · 暂无数据";
      return;
    }
    if (hintEl) {
      hintEl.textContent = windowLabel() + " · 已统计 " + data.covered + "/" + data.total +
        " 个账号 · " + (data.buckets || []).length + " 个时间点";
    }

    var host = el("div", "chart-host");
    host.innerHTML = built.svg; // built above from numbers only; no user text
    var legendRow = el("div");
    legendRow.innerHTML = built.legend;
    wrap.appendChild(host);
    wrap.appendChild(legendRow);

    var tip = el("div", "chart-tip");
    tip.style.display = "none";
    host.appendChild(tip);

    var buckets = data.buckets;
    host.querySelectorAll(".c-hit").forEach(function (rect) {
      rect.addEventListener("mousemove", function (ev) {
        var b = buckets[Number(this.getAttribute("data-i"))];
        if (!b) return;
        var box = host.getBoundingClientRect();
        var rows = [
          ["时间", new Date(b.at).toLocaleString()],
          ["请求", String(b.requests)],
          ["总 Token", fmtTok(b.totalTokens)],
          ["输入", fmtTok(b.promptTokens)],
          ["输出", fmtTok(b.completionTokens)],
          ["缓存命中", fmtTok(b.cachedTokens) + (b.promptTokens ? "（" + Math.round(100 * b.cachedTokens / b.promptTokens) + "%）" : "")],
          ["费用", b.costUsd ? fmtCost(b.costUsd) : "免费/订阅"],
        ];
        tip.innerHTML = "";
        rows.forEach(function (r) {
          var line = el("div", "tip-row");
          line.appendChild(el("span", "tip-k", r[0]));
          line.appendChild(el("span", "tip-v", r[1]));
          tip.appendChild(line);
        });
        tip.style.display = "block";
        // Keep the tooltip inside the host: clamp rather than let it overflow.
        var left = ev.clientX - box.left + 14;
        if (left + tip.offsetWidth > box.width) left = box.width - tip.offsetWidth - 4;
        tip.style.left = Math.max(0, left) + "px";
        tip.style.top = Math.max(0, ev.clientY - box.top - 12) + "px";
      });
      rect.addEventListener("mouseleave", function () { tip.style.display = "none"; });
    });
  }

  var timelineCache = null;
  function loadTimeline() {
    var q = windowQuery("");
    return api("/admin/api/usage/timeline" + (q ? "?" + q : "")).then(function (data) {
      timelineCache = data;
      renderChartInto($("chartWrap"), $("chartHint"), data, $("chartMetric").value);
      if ($("ovChartWrap")) renderChartInto($("ovChartWrap"), $("ovChartHint"), data, "totalTokens");
      renderModelChart(data);
      return data;
    }).catch(function (e) {
      [$("chartWrap"), $("ovChartWrap"), $("modelChartWrap")].forEach(function (wrap) {
        if (!wrap) return;
        clear(wrap);
        wrap.appendChild(el("div", "err sm", "走势读取失败：" + e.message));
      });
      if ($("chartHint")) $("chartHint").textContent = "读取失败";
    });
  }

  /**
   * The per-model chart: one stacked band per model, each its own color.
   *
   * The tooltip is where the per-model split is actually readable — a stacked
   * band tells you a model is large, not by how much — so it lists every series
   * with its value for the hovered bucket, largest first.
   */
  function renderModelChart(data) {
    var wrap = $("modelChartWrap");
    if (!wrap) return;
    var metric = $("modelChartMetric") ? $("modelChartMetric").value : "tokens";
    clear(wrap);
    var built = chartSvgByModel(data, metric);
    if (!built) {
      wrap.appendChild(el("div", "muted sm", "窗口内没有带模型信息的用量记录。"));
      if ($("modelChartHint")) $("modelChartHint").textContent = windowLabel() + " · 暂无数据";
      return;
    }
    if ($("modelChartHint")) {
      $("modelChartHint").textContent = windowLabel() + " · " + built.models.length + " 个模型 · " +
        (data.models && data.models.length < (data.modelsTotal || data.models.length)
          ? "已显示前 " + built.models.length + " 个" : "已统计 " + data.covered + "/" + data.total + " 个账号");
    }

    var host = el("div", "chart-host");
    host.innerHTML = built.svg; // numbers only; no user text
    var legendRow = el("div");
    legendRow.innerHTML = built.legend;
    wrap.appendChild(host);
    wrap.appendChild(legendRow);

    var tip = el("div", "chart-tip");
    tip.style.display = "none";
    host.appendChild(tip);

    var key = metric === "requests" ? "requests" : "tokens";
    var models = built.models;
    host.querySelectorAll(".c-hit").forEach(function (rect) {
      rect.addEventListener("mousemove", function (ev) {
        var i = Number(this.getAttribute("data-i"));
        var b = (data.buckets || [])[i];
        if (!b) return;
        var box = host.getBoundingClientRect();
        // Largest contributor first, and drop the zeros: a bucket where a model
        // did nothing is not worth a line.
        var rows = models.map(function (m, mi) {
          return { label: built.labels[mi], slot: (mi % 8) + 1, value: Number(m[key][i]) || 0 };
        }).filter(function (r) { return r.value > 0; })
          .sort(function (a, b) { return b.value - a.value; });

        tip.innerHTML = "";
        var head = el("div", "tip-row");
        head.appendChild(el("span", "tip-k", new Date(b.at).toLocaleString()));
        tip.appendChild(head);
        var total = el("div", "tip-row");
        total.appendChild(el("span", "tip-k", "合计"));
        total.appendChild(el("span", "tip-v", key === "requests" ? (b.requests + " 次") : fmtTok(b.totalTokens)));
        tip.appendChild(total);
        rows.forEach(function (r) {
          var line = el("div", "tip-row");
          var k = el("span", "tip-k");
          var swatch = el("i", "tip-sw");
          swatch.style.background = "var(--s" + r.slot + ")";
          k.appendChild(swatch);
          k.appendChild(el("span", null, r.label));
          line.appendChild(k);
          line.appendChild(el("span", "tip-v", key === "requests" ? (r.value + " 次") : fmtTok(r.value)));
          tip.appendChild(line);
        });
        tip.style.display = "block";
        var left = ev.clientX - box.left + 14;
        if (left + tip.offsetWidth > box.width) left = box.width - tip.offsetWidth - 4;
        tip.style.left = Math.max(0, left) + "px";
        tip.style.top = Math.max(0, ev.clientY - box.top - 12) + "px";
      });
      rect.addEventListener("mouseleave", function () { tip.style.display = "none"; });
    });
  }

  /* ---------- pool-wide liveness sweep ---------- */
  /**
   * Drive the server-side sweep.
   *
   * The work happens server-side (a pool of hundreds takes minutes and must
   * survive navigation), so this polls for progress rather than running the
   * requests itself. Polling stops as soon as the sweep reports it is done.
   */
  var sweepTimer = null;

  function sweepModelOptions() {
    var list = $("sweepModelList");
    clear(list);
    // Free-bucket models first: a sweep is one real request per account, and
    // free ones cost nothing — the cheapest way to answer "does this work".
    var free = [], pass = [], rest = [];
    (catalog || []).forEach(function (m) {
      if (m.bucket === "free") free.push(m.id);
      else if (m.bucket === "pass") pass.push(m.id);
      else rest.push(m.id);
    });
    free.concat(pass, rest).forEach(function (id) {
      var opt = document.createElement("option");
      opt.value = id;
      list.appendChild(opt);
    });
  }

  function renderSweep(sweep) {
    var running = sweep && sweep.running;
    $("sweepStart").disabled = running;
    $("sweepStop").style.display = running ? "inline-block" : "none";
    var wrap = $("sweepProgressWrap");
    var status = $("sweepStatus");
    var failures = $("sweepFailures");

    if (!sweep) {
      wrap.style.display = "none";
      status.textContent = assignedModelHint();
      failures.textContent = "";
      return;
    }

    wrap.style.display = "block";
    var pct = sweep.total ? Math.round(100 * sweep.done / sweep.total) : 100;
    $("sweepProgressFill").style.width = pct + "%";
    $("sweepProgressFill").parentNode.className = "bar" + (sweep.failed ? " warn" : "");

    var secs = Math.round(((sweep.finishedAt || Date.now()) - sweep.startedAt) / 1000);
    status.className = "xs " + (sweep.failed ? "warn" : (running ? "muted" : "ok"));
    status.textContent = (running ? "进行中 " : (sweep.cancelled ? "已中止 " : "完成 ")) +
      sweep.done + "/" + sweep.total + " · 通过 " + sweep.ok + " · 失败 " + sweep.failed +
      " · 用时 " + secs + "s" +
      (sweep.model ? " · 模型 " + sweep.model : " · 仅验凭据");

    failures.textContent = sweep.failures && sweep.failures.length
      ? "失败（最多列 50 个）：\n" + sweep.failures.map(function (f) {
          return "  " + (f.email || f.id) + " — " + summarize(f.error, 80);
        }).join("\n")
      : "";
  }

  function assignedModelHint() {
    return "模型留空 = 只验证凭据（不消耗额度）；填模型 = 每个账号发 1 次真实请求。";
  }

  function pollSweep() {
    api("/admin/api/sweep").then(function (data) {
      renderSweep(data.sweep);
      if (data.sweep && data.sweep.running) {
        sweepTimer = setTimeout(pollSweep, 2000);
      } else {
        sweepTimer = null;
        // The sweep is what flips accounts between disabled and active.
        loadAccounts();
        loadStatus();
      }
    }).catch(function (e) {
      $("sweepStatus").textContent = "测活状态读取失败：" + e.message;
      sweepTimer = null;
    });
  }

  function startSweep() {
    var model = $("sweepModel").value.trim();
    var payload = {
      activeOnly: $("sweepActiveOnly").checked,
      failedOnly: $("sweepFailedOnly").checked,
      concurrency: Number($("sweepConcurrency").value) || 6,
    };
    if (model) payload.model = model;
    if (model && !confirm("将用 " + model + " 对选中范围内的每个账号发 1 次真实请求，继续？")) return;
    jsonApi("/admin/api/sweep", payload).then(function (data) {
      if (!data.started) toast("已有一个测活在运行，正在显示它的进度", "err");
      else toast("测活已开始", "ok");
      renderSweep(data.sweep);
      if (sweepTimer) clearTimeout(sweepTimer);
      sweepTimer = setTimeout(pollSweep, 800);
    }).catch(function (e) { toast("启动失败：" + e.message, "err"); });
  }

  /* ---------- rate limit ---------- */
  function renderRateLimit(data) {
    var s = data.settings || {};
    $("rlGlobal").value = s.globalPerMinute || "";
    $("rlKey").value = s.keyPerMinute || "";
    $("rlEnabled").checked = s.enabled !== false;
    $("rlUsage").textContent = "当前窗口：全站 " + (data.globalUsed || 0) +
      " 次 · " + (data.keys || 0) + " 个密钥有请求";
    $("rlEnabledLabel").textContent = s.enabled === false ? "已关闭（不限流）" : "已启用";
  }

  function loadRateLimit() {
    api("/admin/api/rate-limit").then(renderRateLimit).catch(function (e) {
      $("rlUsage").textContent = "读取失败：" + e.message;
    });
  }

  function saveRateLimit() {
    var payload = {
      enabled: $("rlEnabled").checked,
      globalPerMinute: Number($("rlGlobal").value),
      keyPerMinute: Number($("rlKey").value),
    };
    jsonApi("/admin/api/rate-limit", payload, "PATCH").then(function (data) {
      renderRateLimit(data);
      toast("限流设置已保存", "ok");
    }).catch(function (e) { toast("保存失败：" + e.message, "err"); });
  }

  /**
   * Per-model usage over the same window as the account table.
   *
   * Reads the pool-wide rollup rather than the page rows, so the table is not
   * tied to which page of accounts happens to be open. Coverage is shown for
   * the same reason as the headline: only accounts read recently contribute.
   */
  function renderModelUsage(data) {
    var body = $("modelUsageBody");
    clear(body);
    var models = data.models || [];
    var rate = data.covered && data.total
      ? (data.covered >= data.total ? "全池 " + data.total + " 个账号"
        : "已统计 " + data.covered + "/" + data.total + " 个账号")
      : "尚无数据";
    $("modelUsageHint").textContent = windowLabel() + " · " + rate +
      (models.length ? " · " + models.length + " 个模型" : "");

    if (!models.length) {
      body.className = "";
      body.appendChild(el("div", "muted sm", "窗口内没有带模型信息的用量记录。"));
      return;
    }
    body.className = "tight";

    var table = el("table");
    var thead = el("thead");
    var htr = el("tr");
    ["模型", "渠道", "请求", "Token", "缓存命中", "费用"].forEach(function (t, i) {
      htr.appendChild(el("th", i >= 2 ? "nowrap num" : "nowrap", t));
    });
    thead.appendChild(htr);
    table.appendChild(thead);

    var tbody = el("tbody");
    models.forEach(function (m) {
      var tr = el("tr");

      var td1 = el("td");
      td1.appendChild(el("div", "mono sm", m.id));
      tr.appendChild(td1);

      var td2 = el("td", "nowrap");
      var bucket = m.bucket || "";
      var kind = bucket === "cline-free" ? "free"
        : (bucket === "cline-pass" ? "pass" : "warn");
      td2.appendChild(el("span", "badge " + kind, bucket || "未知"));
      tr.appendChild(td2);

      tr.appendChild(el("td", "nowrap num sm", m.requests));

      var td4 = el("td", "nowrap num sm");
      td4.appendChild(el("div", null, fmtTok(m.totalTokens)));
      td4.appendChild(el("div", "xs faint",
        "入 " + fmtTok(m.promptTokens) + " / 出 " + fmtTok(m.completionTokens)));
      tr.appendChild(td4);

      // Cache hit rate is the number this table exists for: it is what tells
      // apart a model whose prefix cache is working from one paying full price.
      var td5 = el("td", "nowrap num sm");
      var pct = m.promptTokens ? Math.round(100 * m.cachedTokens / m.promptTokens) : 0;
      var cls = "sm " + (pct >= 50 ? "ok" : (pct > 0 ? "warn" : "faint"));
      td5.appendChild(el("div", cls, m.cachedTokens ? (pct + "%") : "—"));
      if (m.cachedTokens) td5.appendChild(el("div", "xs faint", fmtTok(m.cachedTokens)));
      tr.appendChild(td5);

      var td6 = el("td", "nowrap num sm");
      if (m.costUsd) td6.textContent = fmtCost(m.costUsd);
      else td6.appendChild(el("span", "faint", "免费/订阅"));
      tr.appendChild(td6);

      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    body.appendChild(table);
  }

  function loadModelUsage() {
    var q = windowQuery("");
    api("/admin/api/usage/by-model" + (q ? "?" + q : "")).then(function (data) {
      renderModelUsage(data);
    }).catch(function (e) {
      var body = $("modelUsageBody");
      clear(body);
      body.className = "";
      body.appendChild(el("div", "err sm", "模型用量读取失败：" + e.message));
    });
  }

  /* ---------- free quota ---------- */
  /**
   * Free-tier quota signals.
   *
   * Upstream has no "remaining quota" endpoint, so the table shows what is
   * observable: a request in real traffic that hit the free limit today, or a
   * probe result. "未探测" is a real answer, not a failure — it means nothing
   * has asked upstream about this account yet.
   */
  var freeQuotaRows = [];
  /** accountId -> true, for the free-quota table's own selection. */
  var freeProbeSelected = {};
  /** Per-account, per-model daily ceiling, from the server. */
  var freeLimitPerModel = 15000000;
  function loadFreeQuota() {
    api("/admin/api/free-quota").then(function (data) {
      freeQuotaRows = data.accounts || [];
      if (data.freeLimitPerModel) freeLimitPerModel = data.freeLimitPerModel;
      if (!$("freeProbeModel").value) $("freeProbeModel").value = data.probeModel || "";
      renderFreeQuota();
    }).catch(function (e) {
      var body = $("freeQuotaBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "免费额度读取失败：" + e.message);
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }

  /**
   * Fullness of one model's free bucket on one account.
   *
   * The ceiling is an observed value, not a documented one, so the meter is
   * explicitly an estimate: it says "how much of the assumed daily allowance
   * this account has used on this model", and the authoritative signal stays
   * the real "Daily free limit" failure recorded separately.
   */
  function freeBucketMeter(model) {
    var pct = Math.max(0, Math.min(100, Math.round(100 * model.totalTokens / freeLimitPerModel)));
    var cls = pct >= 90 ? "err" : (pct >= 60 ? "warn" : "");
    var wrap = el("div", "quota");
    var q = el("div", "q");
    q.style.gridTemplateColumns = "1fr 44px";
    var bar = el("div", "bar " + cls);
    var fill = el("i");
    fill.style.width = pct + "%";
    bar.appendChild(fill);
    q.appendChild(bar);
    q.appendChild(el("div", "pct", pct + "%"));
    wrap.appendChild(q);
    var line = el("div", "xs faint mono");
    line.textContent = model.id.split("/").pop() + " · " + fmtTok(model.totalTokens);
    wrap.appendChild(line);
    return wrap;
  }

  /**
   * The account's fullest free bucket, plus a rolled-up view of the rest.
   *
   * Sorted by fullness so the account closest to its ceiling is the one the
   * meter describes; the remaining models are summarized rather than drawn,
   * because a row per model would make this table unusable at 800 accounts.
   */
  function freeBucketCell(row) {
    var models = (row.models || []).filter(function (m) { return m.totalTokens > 0; });
    if (!models.length) {
      return el("span", "xs faint", row.windowMs ? "窗口内无用量" : "尚无用量数据");
    }
    models.sort(function (a, b) { return b.totalTokens - a.totalTokens; });
    var cell = el("div");
    cell.appendChild(freeBucketMeter(models[0]));
    if (models.length > 1) {
      var others = models.slice(1, 4).map(function (m) {
        return m.id.split("/").pop() + " " + Math.round(100 * m.totalTokens / freeLimitPerModel) + "%";
      });
      var more = models.length > 4 ? " 等 " + models.length + " 个" : "";
      cell.appendChild(el("div", "xs faint", "另：" + others.join(" · ") + more));
    }
    return cell;
  }

  function renderFreeQuota() {
    var body = $("freeQuotaBody");
    clear(body);
    if (!freeQuotaRows.length) {
      var tr0 = el("tr");
      var td0 = el("td", "empty sm", "还没有账号。");
      td0.colSpan = 5;
      tr0.appendChild(td0);
      body.appendChild(tr0);
      return;
    }
    freeQuotaRows.forEach(function (row) {
      var tr = el("tr");

      // Its own selection, independent of the accounts page: this table lives
      // on the quota page, so sharing the accounts-page selection would mean
      // the button here could never find anything to probe.
      var td0 = el("td", "nowrap");
      var box = document.createElement("input");
      box.type = "checkbox";
      box.style.width = "auto";
      box.style.margin = "0";
      box.checked = freeProbeSelected[row.id] === true;
      box.onchange = function () {
        if (this.checked) freeProbeSelected[row.id] = true;
        else delete freeProbeSelected[row.id];
      };
      td0.appendChild(box);
      tr.appendChild(td0);

      var sig = row.signal;

      var td1 = el("td");
      td1.appendChild(el("div", null, row.email || row.id));
      if (row.disabled) td1.appendChild(el("div", "xs faint", "已停用"));
      tr.appendChild(td1);

      var td2 = el("td", "nowrap");
      if (sig && sig.state === "exhausted") td2.appendChild(el("span", "badge err", "已耗尽"));
      else if (sig && sig.state === "ok") td2.appendChild(el("span", "badge pass", "可用"));
      else td2.appendChild(el("span", "badge warn", "未探测"));
      tr.appendChild(td2);

      // The fullness meter is the estimated view; the badge above is the
      // observed one. Both are shown because they answer different questions:
      // "how close am I" and "has it actually failed".
      var td3 = el("td");
      td3.appendChild(freeBucketCell(row));
      tr.appendChild(td3);

      var td4 = el("td", "nowrap xs faint");
      if (sig) td4.textContent = (sig.probed ? "探测" : "真实请求") + " · " + fmtAgo(sig.at);
      else td4.textContent = "—";
      tr.appendChild(td4);

      var td5 = el("td", "xs");
      if (sig && sig.reason) {
        td5.appendChild(el("div", sig.state === "exhausted" ? "xs warn" : "xs faint",
          summarize(sig.reason, 70)));
      }
      if (!sig) td5.appendChild(el("span", "faint", "尚无信号，可用上方按钮探测"));
      tr.appendChild(td5);

      body.appendChild(tr);
    });
  }

  /**
   * Probe one account, then refresh just that row.
   *
   * Sequential by design for the batch paths: each probe is a real upstream
   * request on one pinned account, so firing a pool-wide sweep in parallel
   * would spike the very quota being measured.
   */
  function probeFreeQuota(accountId) {
    var model = $("freeProbeModel").value.trim();
    return jsonApi("/admin/api/accounts/" + encodeURIComponent(accountId) + "/free-quota",
      model ? { model: model } : {}).then(function (result) {
      return result;
    });
  }

  function runFreeProbe(ids, label) {
    if (!ids.length) { toast("没有可探测的账号", "err"); return; }
    if (!confirm("将对 " + ids.length + " 个账号各发 1 次真实请求（" + label + "），继续？")) return;
    var status = $("freeProbeStatus");
    var done = 0, ok = 0, exhausted = 0, failed = 0;
    status.textContent = "0/" + ids.length + " …";
    (function step(i) {
      if (i >= ids.length) {
        status.textContent = ids.length + " 个：可用 " + ok + " · 已耗尽 " + exhausted + " · 失败 " + failed;
        toast("探测完成", "ok");
        loadFreeQuota();
        return;
      }
      probeFreeQuota(ids[i]).then(function (r) {
        if (r.outcome === "ok") ok++;
        else if (r.outcome === "exhausted") exhausted++;
        else failed++;
      }).catch(function () { failed++; }).then(function () {
        done++;
        status.textContent = done + "/" + ids.length + " …";
        step(i + 1);
      });
    })(0);
  }


  function renderPoolSummaryData(data) {
    var t = data.totals || {};
    var label = windowLabel() + " · 全池 " + data.total + " 个账号";
    var cov = data.covered >= data.total
      ? "（全池已统计）"
      : "（已统计 " + data.covered + "/" + data.total + (data.refreshing ? "，其余统计中" : "") + "）";
    $("sToday").textContent = fmtTok(t.totalTokens || 0);
    var bits = [label];
    if (t.requests) bits.push(t.requests + " 次");
    if (t.cachedTokens) bits.push("缓存 " + fmtTok(t.cachedTokens));
    if (t.costUsd) bits.push(fmtCost(t.costUsd));
    if (t.balanceKnown) bits.push("合计余额 " + fmtUsd(t.balanceMicroUsd));
    bits.push(cov);
    $("sTodayHint").textContent = bits.join(" · ");
  }

  /** Re-read the pool summary until the background sweep has covered everyone. */
  var summaryPoll = null;
  function scheduleSummaryPoll(data) {
    if (summaryPoll) { clearTimeout(summaryPoll); summaryPoll = null; }
    if (!data || !data.refreshing || data.covered >= data.total) return;
    summaryPoll = setTimeout(function () { renderPoolSummaryAsync().catch(function () {}); }, 4000);
  }

  function loadUsage(force, page) {
    var target = page || usagePage;
    usagePage = target;
    var usageUrl = "/admin/api/usage?page=" + target + "&pageSize=" + usagePageSize;
    // The headline counters read the pool-wide summary; the table rows read
    // this page. All three are independent, so one slow leg must not blank the
    // other two — hence allSettled instead of all.
    Promise.allSettled([api(usageUrl), loadCredits(force, target), renderPoolSummaryAsync()]).then(function (res) {
      if (res[0].status === "fulfilled") {
        renderUsage(res[0].value, loadCreditsLastMeta());
      } else {
        var body = $("usageBody");
        clear(body);
        body.className = "err sm";
        body.textContent = "配额读取失败：" + (res[0].reason && res[0].reason.message ? res[0].reason.message : res[0].reason);
        $("sQuota").textContent = "—";
        $("sQuotaHint").textContent = "读取失败";
      }
    });
  }

  /** Last credits page metadata, so renderUsage can build its pager. */
  var lastCreditsMeta = null;
  function loadCreditsLastMeta() { return lastCreditsMeta; }

  /** Pool summary as a promise, so loadUsage can race it with the rows. */
  function renderPoolSummaryAsync() {
    var q = windowQuery("");
    return api("/admin/api/credits/summary" + (q ? "?" + q : "")).then(function (data) {
      renderPoolSummaryData(data);
      scheduleSummaryPoll(data);
      return data;
    }).catch(function (e) {
      $("sToday").textContent = "—";
      $("sTodayHint").textContent = "全池合计读取失败：" + e.message;
      throw e;
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
      // The sweep's model picker is fed from the same catalog, free bucket
      // first, so the two never disagree about what a valid id looks like.
      sweepModelOptions();
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
  /* ---------- account list: paging, filtering, per-account actions ---------- */
  var acctPage = 1;
  var acctPageSize = 20;
  var acctFilter = { q: "", status: "all" };
  var proxiesById = {};

  /**
   * Selection and liveness, both keyed by account id and kept across pages.
   *
   * Cross-page persistence matters for the batch flow: the point of "select
   * failure" is to sweep a pool that does not fit on one page, and a selection
   * that reset on every page turn would make that impossible without raising
   * the page size past what the upstream calls are worth.
   */
  var selectedIds = {};
  /** accountId -> last known liveness. Missing means never tested. */
  var probeCache = {};
  /** accountId -> account row, so batch actions do not need a visible row. */
  var knownAccounts = {};

  function selectedList() { return Object.keys(selectedIds); }

  function updateBatchBar() {
    var ids = selectedList();
    $("batchBar").style.display = ids.length ? "block" : "none";
    $("batchCount").textContent = "已选 " + ids.length + " 个";
  }

  function setSelected(id, on) {
    if (on) selectedIds[id] = true;
    else delete selectedIds[id];
    updateBatchBar();
  }

  function markRowFailed(id) {
    var row = document.getElementById("acct-row-" + id);
    if (row) row.classList.add("row-failed");
  }

  function probeOne(id) {
    return jsonApi("/admin/api/accounts/" + encodeURIComponent(id) + "/probe", {})
      .then(function (r) {
        probeCache[id] = r.ok === true;
        if (!r.ok) markRowFailed(id);
        return { id: id, ok: r.ok === true, error: r.error, latencyMs: r.latencyMs, stage: r.stage };
      })
      .catch(function (e) {
        probeCache[id] = false;
        markRowFailed(id);
        return { id: id, ok: false, error: e.message, latencyMs: 0, stage: "request" };
      });
  }

  /**
   * Sweep a set of accounts with a small in-flight cap.
   *
   * A forced refresh per account means an unbounded fan-out would burst the
   * upstream auth endpoint; the cap keeps a 100-account sweep civilised while
   * still finishing in seconds.
   */
  function probeMany(ids, onProgress) {
    var queue = ids.slice();
    var results = [];
    var done = 0;
    var CONCURRENCY = 5;

    function worker() {
      if (!queue.length) return Promise.resolve();
      var id = queue.shift();
      return probeOne(id).then(function (r) {
        results.push(r);
        done += 1;
        if (onProgress) onProgress(done, ids.length, r);
        return worker();
      });
    }
    var runners = [];
    for (var i = 0; i < Math.min(CONCURRENCY, ids.length); i++) runners.push(worker());
    return Promise.all(runners).then(function () { return results; });
  }

  function batchProbe() {
    var ids = selectedList();
    if (!ids.length) return;
    var status = $("batchStatus");
    var started = Date.now();
    status.textContent = "批量测活 0/" + ids.length + "…";
    $("batchProbe").disabled = true;
    probeMany(ids, function (done, total) {
      status.textContent = "批量测活 " + done + "/" + total + "…";
    }).then(function (results) {
      var failed = results.filter(function (r) { return !r.ok; });
      $("batchProbe").disabled = false;
      status.className = "xs " + (failed.length ? "err" : "ok");
      status.textContent = "测活完成：" + (results.length - failed.length) + " 存活 · " +
        failed.length + " 失败 · 用时 " + (Date.now() - started) + "ms" +
        (failed.length ? "\n失败：" + failed.map(function (f) {
          return (knownAccounts[f.id] ? (knownAccounts[f.id].email || f.id) : f.id) +
            "（" + summarize(f.error, 60) + "）";
        }).join("；") : "");
      // Leave only the failures selected: the next move after a sweep is
      // almost always to act on exactly those.
      if (failed.length) {
        selectedIds = {};
        failed.forEach(function (f) { selectedIds[f.id] = true; });
        updateBatchBar();
        syncRowCheckboxes();
      }
    });
  }

  function batchDisable() {
    var ids = selectedList();
    if (!ids.length) return;
    if (!confirm("停用选中的 " + ids.length + " 个账号？停用后不再参与轮询。")) return;
    var status = $("batchStatus");
    status.className = "xs muted";
    status.textContent = "停用中…";
    var queue = ids.slice();
    var done = 0;
    function step() {
      if (!queue.length) {
        status.className = "xs ok";
        status.textContent = "已停用 " + done + " 个";
        loadAccounts(); loadStatus();
        return Promise.resolve();
      }
      var id = queue.shift();
      return jsonApi("/admin/api/accounts/" + encodeURIComponent(id), { disabled: true }, "PATCH")
        .then(function () { done += 1; status.textContent = "停用中… " + done + "/" + ids.length; })
        .catch(function () { /* reported by the final count */ })
        .then(step);
    }
    step();
  }

  function batchDelete() {
    var ids = selectedList();
    if (!ids.length) return;
    if (!confirm("删除选中的 " + ids.length + " 个账号？删除后需要重新登录，且无法撤销。")) return;
    var status = $("batchStatus");
    status.className = "xs muted";
    status.textContent = "删除中…";
    var queue = ids.slice();
    var done = 0;
    function step() {
      if (!queue.length) {
        status.className = "xs ok";
        status.textContent = "已删除 " + done + " 个";
        selectedIds = {};
        updateBatchBar();
        loadAccounts(); loadStatus();
        return Promise.resolve();
      }
      var id = queue.shift();
      return api("/admin/api/accounts/" + encodeURIComponent(id), { method: "DELETE" })
        .then(function () {
          done += 1;
          delete selectedIds[id];
          updateBatchBar();
          status.textContent = "删除中… " + done + "/" + ids.length;
        })
        .catch(function () { /* reported by the final count */ })
        .then(step);
    }
    step();
  }

  function syncRowCheckboxes() {
    var boxes = document.querySelectorAll("#accountsBody input.row-check");
    var all = boxes.length > 0;
    for (var i = 0; i < boxes.length; i++) {
      boxes[i].checked = selectedIds[boxes[i].getAttribute("data-id")] === true;
      if (!boxes[i].checked) all = false;
    }
    var master = $("acctSelectAll");
    if (master) master.checked = all;
  }

  function loadProxies() {
    return api("/admin/api/proxies").then(function (data) {
      proxiesById = {};
      (data.proxies || []).forEach(function (p) { proxiesById[p.id] = p; });
      return data.proxies || [];
    }).catch(function () {
      proxiesById = {};
      return [];
    });
  }

  /** Pick which proxy an account egresses through. */
  function proxySelect(a) {
    var sel = el("select", "sm");
    sel.style.width = "auto";
    sel.style.minWidth = "104px";
    var none = el("option", null, "直连");
    none.value = "";
    sel.appendChild(none);
    Object.keys(proxiesById).forEach(function (id) {
      var p = proxiesById[id];
      var opt = el("option", null, (p.label || p.url) + (p.enabled ? "" : "（停用）"));
      opt.value = id;
      sel.appendChild(opt);
    });
    sel.value = a.proxyId || "";
    sel.onchange = function () {
      sel.disabled = true;
      jsonApi(
        "/admin/api/accounts/" + encodeURIComponent(a.id),
        { proxyId: sel.value || null },
        "PATCH"
      ).then(function () {
        toast(sel.value ? "已绑定代理" : "已改为直连", "ok");
        loadAccounts();
      }).catch(function (e) {
        toast("绑定失败：" + e.message, "err");
        sel.value = a.proxyId || "";
      }).finally(function () { sel.disabled = false; });
    };
    return sel;
  }

  function toggleAccount(a) {
    var next = !a.disabled;
    var verb = next ? "停用" : "启用";
    if (next && !confirm("停用账号 " + (a.email || a.id) + " ？停用后该账号不再参与轮询。")) return;
    jsonApi(
      "/admin/api/accounts/" + encodeURIComponent(a.id),
      { disabled: next },
      "PATCH"
    ).then(function () {
      toast(verb + "成功", "ok");
      loadAccounts(); loadStatus();
    }).catch(function (e) { toast(verb + "失败：" + e.message, "err"); });
  }

  /**
   * Send one real request through this account, for a chosen model.
   *
   * Pinned to the account, so the verdict describes it rather than whichever
   * account in the pool happened to answer. Opens an inline panel with a model
   * picker and a prompt box instead of firing immediately.
   */
  function openAccountTest(a, cell) {
    var existing = cell.querySelector(".test-panel");
    if (existing) { existing.remove(); return; }

    var panel = el("div", "test-panel");
    panel.style.cssText = "margin-top:8px; padding:10px; border:1px solid var(--border); border-radius:var(--radius-sm); background:var(--surface-2)";

    var sel = el("select", "sm");
    sel.style.width = "100%";
    var groups = [["pass", "订阅可用"], ["free", "免费"], ["credits", "需 Cline Credits"]];
    groups.forEach(function (g) {
      var set = catalog.filter(function (m) { return m.bucket === g[0]; });
      if (!set.length) return;
      var og = document.createElement("optgroup");
      og.label = g[1];
      set.slice(0, 120).forEach(function (m) {
        var o = el("option", null, m.id);
        o.value = m.id;
        og.appendChild(o);
      });
      sel.appendChild(og);
    });
    if (catalog.length) {
      var preferred = catalog.find(function (m) { return m.bucket === "free"; }) || catalog[0];
      sel.value = preferred.id;
    }
    panel.appendChild(el("div", "xs muted", "模型"));
    panel.appendChild(sel);

    var prompt = el("input", "sm");
    prompt.type = "text";
    prompt.value = "只回复两个字：可用";
    prompt.style.marginTop = "6px";
    panel.appendChild(el("div", "xs muted", "提示词"));
    panel.appendChild(prompt);

    var run = el("button", "btn small primary", "发送测试请求");
    run.style.marginTop = "8px";
    var out = el("div", "xs");
    out.style.cssText = "margin-top:8px; white-space:pre-wrap; word-break:break-word";
    panel.appendChild(run);
    panel.appendChild(out);

    /**
     * Two stages, so a dead account is not misread as a dead model.
     *
     * Stage 1 refreshes the credential and calls /users/me — no inference, and
     * the only step that can see a revoked refresh token. If it fails the
     * account is the problem and stage 2 is skipped, which is also what makes
     * this work as the liveness check: there is no separate 测活 button,
     * because running one on every row would just repeat stage 1.
     */
    run.onclick = function () {
      run.disabled = true;
      out.className = "xs muted";
      out.textContent = "1/2 检查凭据…";
      var t0 = Date.now();
      jsonApi("/admin/api/accounts/" + encodeURIComponent(a.id) + "/probe", {})
        .then(function (p) {
          if (!p.ok) {
            out.className = "xs err";
            out.textContent = "凭据失败 · " + p.latencyMs + "ms\n" +
              (p.stage === "credential" ? "令牌刷新被拒：" : "上游拒绝该凭据：") +
              summarize(p.error, 300);
            probeCache[a.id] = false;
            markRowFailed(a.id);
            return null;
          }
          out.textContent = "1/2 凭据正常（" + p.latencyMs + "ms）· 2/2 请求模型…";
          return jsonApi("/admin/api/accounts/" + encodeURIComponent(a.id) + "/test", {
            model: sel.value,
            prompt: prompt.value,
          });
        })
        .then(function (r) {
          if (!r) return;
          if (r.ok) {
            out.className = "xs ok";
            var tok = r.usage && r.usage.total_tokens ? (" · " + r.usage.total_tokens + " tok") : "";
            out.textContent = "可用 · 共 " + (Date.now() - t0) + "ms" + tok + "\n" + (r.content || "(空响应)");
            probeCache[a.id] = true;
          } else {
            out.className = "xs err";
            out.textContent = "模型失败 HTTP " + r.status + " · " + r.latencyMs + "ms\n" + summarize(r.error, 400);
            probeCache[a.id] = false;
            markRowFailed(a.id);
          }
        })
        .catch(function (e) {
          out.className = "xs err";
          out.textContent = "请求失败：" + e.message;
        }).finally(function () { run.disabled = false; });
    };

    cell.appendChild(panel);
  }

  function loadAccounts(page) {
    var target = page || acctPage;
    acctPage = target;
    var q = "?page=" + target + "&pageSize=" + acctPageSize +
      "&status=" + encodeURIComponent(acctFilter.status) +
      "&q=" + encodeURIComponent(acctFilter.q);

    Promise.all([api("/admin/api/accounts" + q), loadProxies()]).then(function (res) {
      var data = res[0];
      var body = $("accountsBody");
      clear(body);
      $("accountsEmpty").style.display = data.total ? "none" : "block";
      var accounts = data.accounts || [];
      if (!accounts.length) {
        var tr0 = el("tr");
        var td0 = el("td", "empty sm", acctFilter.q || acctFilter.status !== "all"
          ? "没有匹配的账号。"
          : "还没有账号。");
        td0.colSpan = 6;
        tr0.appendChild(td0);
        body.appendChild(tr0);
        renderPager($("accountsPager"), 1, 1, 0, acctPageSize, function () {});
        return;
      }

      accounts.forEach(function (a) {
        knownAccounts[a.id] = a;
        var tr = el("tr");
        tr.id = "acct-row-" + a.id;
        if (probeCache[a.id] === false) tr.classList.add("row-failed");

        var tdCheck = el("td", "nowrap");
        var box = el("input");
        box.type = "checkbox";
        box.className = "row-check";
        box.setAttribute("data-id", a.id);
        box.checked = selectedIds[a.id] === true;
        box.onchange = function () { setSelected(a.id, box.checked); syncRowCheckboxes(); };
        tdCheck.appendChild(box);
        tr.appendChild(tdCheck);

        var td1 = el("td");
        td1.appendChild(el("div", null, a.label ? (a.label + " · " + (a.email || a.id)) : (a.email || a.id)));
        td1.appendChild(el("div", "xs faint mono", a.id));
        tr.appendChild(td1);

        var td2 = el("td", "nowrap");
        td2.appendChild(el("span", "badge " + (a.disabled ? "err" : "pass"), a.disabled ? "已停用" : "可用"));
        if (a.lastError) td2.appendChild(el("div", "xs muted", summarize(a.lastError, 50)));
        tr.appendChild(td2);

        var td3 = el("td", "nowrap sm num", fmtExpiry(a.expiresAt));
        tr.appendChild(td3);

        var tdProxy = el("td", "nowrap");
        tdProxy.appendChild(proxySelect(a));
        tr.appendChild(tdProxy);

        var td4 = el("td", "nowrap");
        var test = el("button", "btn small", "单号测试");
        test.onclick = function () { openAccountTest(a, td4); };
        var toggle = el("button", "btn small", a.disabled ? "启用" : "停用");
        toggle.onclick = function () { toggleAccount(a); };
        var del = el("button", "btn small danger", "删除");
        del.onclick = function () { removeAccount(a); };
        [test, toggle, del].forEach(function (b) {
          b.style.marginRight = "5px";
          td4.appendChild(b);
        });
        tr.appendChild(td4);

        body.appendChild(tr);
      });

      renderPager($("accountsPager"), data.page, data.totalPages, data.total, data.pageSize, function (p) {
        loadAccounts(p);
      });
      syncRowCheckboxes();
    }).catch(function (e) {
      var body = $("accountsBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "账号读取失败：" + e.message);
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }
  function removeAccount(a) {
    if (!confirm("确定删除账号 " + (a.email || a.id) + " ？删除后需要重新登录。")) return;
    api("/admin/api/accounts/" + encodeURIComponent(a.id), { method: "DELETE" }).then(function () {
      delete selectedIds[a.id];
      updateBatchBar();
      toast("已删除", "ok");
      loadAccounts(); loadStatus(); loadUsage();
    }).catch(function (e) { toast("删除失败：" + e.message, "err"); });
  }

  /* ---------- client API keys ---------- */
  /**
   * Render a key row. The server never sends the plaintext, so there is no
   * "show" action here — creation and rotation are the only moments the secret
   * exists in the browser, and both display it in a dismissible panel next to
   * the form rather than in the table.
   */
  function renderKeys(list) {
    var body = $("keysBody");
    clear(body);
    var enabled = list.filter(function (k) { return k.enabled; }).length;
    var uses = list.reduce(function (sum, k) { return sum + (k.useCount || 0); }, 0);
    $("kTotal").textContent = list.length;
    $("kEnabled").textContent = enabled;
    $("kUses").textContent = uses;

    if (!list.length) {
      var tr0 = el("tr");
      var td0 = el("td", "empty sm", "还没有密钥。点右上角「新建密钥」。");
      td0.colSpan = 5;
      tr0.appendChild(td0);
      body.appendChild(tr0);
      return;
    }

    list.forEach(function (k) {
      var tr = el("tr");

      var td1 = el("td");
      td1.appendChild(el("div", null, k.label || "(无备注)"));
      var meta = el("div", "xs faint mono", k.prefix + "… · " + k.id.slice(0, 8));
      if (k.source === "env") meta.textContent += " · 来自环境变量";
      td1.appendChild(meta);
      tr.appendChild(td1);

      var td2 = el("td", "nowrap");
      td2.appendChild(el("span", "badge " + (k.enabled ? "pass" : "warn"), k.enabled ? "启用" : "停用"));
      tr.appendChild(td2);

      var td3 = el("td", "nowrap sm num");
      td3.textContent = k.useCount > 0 ? (k.useCount + " 次") : "未使用";
      if (k.lastUsedModel) td3.appendChild(el("div", "xs faint", k.lastUsedModel));
      tr.appendChild(td3);

      var td4 = el("td", "nowrap sm num");
      td4.textContent = k.lastUsedAt ? new Date(k.lastUsedAt).toLocaleString() : "—";
      tr.appendChild(td4);

      var td5 = el("td", "nowrap");
      var toggle = el("button", "btn small", k.enabled ? "停用" : "启用");
      toggle.onclick = function () { toggleKey(k, !k.enabled); };
      td5.appendChild(toggle);
      toggle.style.marginRight = "5px";

      var rotate = el("button", "btn small", "轮换");
      rotate.title = "旧密钥立即失效，新密钥只显示一次";
      rotate.onclick = function () { rotateKey(k); };
      td5.appendChild(rotate);
      rotate.style.marginRight = "5px";

      var del = el("button", "btn small danger", "删除");
      del.title = k.source === "env" ? "来自环境变量的密钥需先在环境中移除" : "删除后使用该密钥的客户端立即 401";
      del.onclick = function () { deleteKey(k); };
      td5.appendChild(del);
      tr.appendChild(td5);

      body.appendChild(tr);
    });
  }

  function loadKeys(options) {
    var keepSecret = options && options.keepSecret;
    api("/admin/api/keys").then(function (data) {
      renderKeys(data.keys || []);
      // The plaintext lives only in this panel — the server never sends it
      // again — so the refresh that follows a create or rotate must not wipe
      // it. Every other refresh (entering the view, the reload button) still
      // clears a secret that was already on screen.
      if (!keepSecret) $("keyResult").style.display = "none";
    }).catch(function (e) {
      var body = $("keysBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "密钥读取失败：" + e.message);
      td.colSpan = 5;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }

  function showPlaintextOnce(plaintext) {
    var box = $("keyResult");
    box.style.display = "block";
    var field = $("keyPlaintext");
    field.value = plaintext;
    // Copy from the field itself rather than a closed-over string, and do it
    // synchronously inside the click: an async clipboard call made after an
    // await loses the user-gesture and is rejected.
    $("keyCopy").onclick = function () { copy(field.value, "密钥已复制，妥善保存"); };
    $("keySelect").onclick = function () { field.focus(); field.select(); };
    box.scrollIntoView({ block: "center" });
    field.focus();
    field.select();
  }

  function submitKey() {
    var err = $("keyError");
    err.style.display = "none";
    jsonApi("/admin/api/keys", { label: $("keyLabel").value.trim() || null })
      .then(function (data) {
        toast("已生成", "ok");
        $("keyLabel").value = "";
        showPlaintextOnce(data.plaintext);
        loadKeys({ keepSecret: true });
      })
      .catch(function (e) {
        err.textContent = e.message;
        err.style.display = "block";
      });
  }

  function toggleKey(k, next) {
    if (!next && !confirm("停用密钥「" + (k.label || k.prefix) + "」？使用它的客户端会立即 401。")) return;
    jsonApi("/admin/api/keys/" + encodeURIComponent(k.id), { enabled: next }, "PATCH")
      .then(function () { toast(next ? "已启用" : "已停用", "ok"); loadKeys(); })
      .catch(function (e) { toast("更新失败：" + e.message, "err"); });
  }

  function rotateKey(k) {
    if (!confirm("轮换密钥「" + (k.label || k.prefix) + "」？旧密钥立即失效，新密钥只显示一次。")) return;
    api("/admin/api/keys/" + encodeURIComponent(k.id) + "/rotate", { method: "POST" })
      .then(function (data) {
        toast("已轮换，旧密钥已失效", "ok");
        showPlaintextOnce(data.plaintext);
        loadKeys({ keepSecret: true });
      })
      .catch(function (e) { toast("轮换失败：" + e.message, "err"); });
  }

  function deleteKey(k) {
    if (!confirm("删除密钥「" + (k.label || k.prefix) + "」？使用它的客户端会立即 401，且无法撤销。")) return;
    api("/admin/api/keys/" + encodeURIComponent(k.id), { method: "DELETE" })
      .then(function () { toast("已删除", "ok"); loadKeys(); })
      .catch(function (e) { toast("删除失败：" + e.message, "err"); });
  }

  /**
   * Add every account already known to have failed to the selection.
   *
   * Reads the liveness cache and each row's lastError, so accounts flagged by
   * a previous sweep or by the gateway itself can be swept up without testing
   * the whole pool again.
   */
  function selectFailed() {
    var added = 0;
    Object.keys(knownAccounts).forEach(function (id) {
      var a = knownAccounts[id];
      var failed = probeCache[id] === false || Boolean(a && a.lastError) || Boolean(a && a.disabled);
      if (failed && !selectedIds[id]) { selectedIds[id] = true; added += 1; }
    });
    updateBatchBar();
    syncRowCheckboxes();
    $("batchStatus").className = "xs muted";
    $("batchStatus").textContent = added
      ? ("已加入 " + added + " 个已知失败账号（含停用与带错误信息的）")
      : "本页没有已知失败的账号";
  }

  /* ---------- proxies ---------- */
  function loadProxyView() {
    loadProxies().then(function (list) {
      var body = $("proxiesBody");
      clear(body);
      if (!list.length) {
        var tr = el("tr");
        var td = el("td", "empty sm", "还没有配置代理。所有账号直连上游。");
        td.colSpan = 4;
        tr.appendChild(td);
        body.appendChild(tr);
        return;
      }
      list.forEach(function (p) {
        var tr = el("tr");

        var td1 = el("td");
        td1.appendChild(el("div", null, p.label || "(无备注)"));
        td1.appendChild(el("div", "xs faint mono", p.url));
        if (p.lastError) td1.appendChild(el("div", "xs err", "最近错误：" + summarize(p.lastError, 70)));
        tr.appendChild(td1);

        var td2 = el("td", "nowrap");
        td2.appendChild(el("span", "badge " + (p.enabled ? "pass" : "warn"), p.enabled ? "启用" : "停用"));
        tr.appendChild(td2);

        var td3 = el("td", "nowrap sm num", p.usedBy > 0 ? (p.usedBy + " 个账号") : "未使用");
        tr.appendChild(td3);

        var td4 = el("td", "nowrap");
        var toggle = el("button", "btn small", p.enabled ? "停用" : "启用");
        toggle.onclick = function () {
          jsonApi(
            "/admin/api/proxies/" + encodeURIComponent(p.id),
            { enabled: !p.enabled },
            "PATCH"
          ).then(function () { toast("已更新", "ok"); loadProxyView(); })
            .catch(function (e) { toast("更新失败：" + e.message, "err"); });
        };
        var del = el("button", "btn small danger", "删除");
        del.onclick = function () {
          var msg = p.usedBy > 0
            ? ("该代理被 " + p.usedBy + " 个账号引用。删除后这些账号会改为直连（从本机 IP 出网）。确定？")
            : ("确定删除代理 " + (p.label || p.url) + " ？");
          if (!confirm(msg)) return;
          var path = "/admin/api/proxies/" + encodeURIComponent(p.id) + (p.usedBy > 0 ? "?force=1" : "");
          api(path, { method: "DELETE" }).then(function (r) {
            toast(r.unassigned ? ("已删除，解绑 " + r.unassigned + " 个账号") : "已删除", "ok");
            loadProxyView();
          }).catch(function (e) { toast("删除失败：" + e.message, "err"); });
        };
        [toggle, del].forEach(function (b) { b.style.marginRight = "5px"; td4.appendChild(b); });
        tr.appendChild(td4);

        body.appendChild(tr);
      });
    }).catch(function (e) {
      var body = $("proxiesBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "代理读取失败：" + e.message);
      td.colSpan = 4;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }

  function submitProxy() {
    var err = $("proxyError");
    err.style.display = "none";
    var url = $("proxyUrl").value.trim();
    if (!url) {
      err.textContent = "请填写代理地址";
      err.style.display = "block";
      return;
    }
    jsonApi("/admin/api/proxies", {
      url: url,
      label: $("proxyLabel").value.trim() || null,
    }).then(function () {
      toast("已保存", "ok");
      $("proxyUrl").value = "";
      $("proxyLabel").value = "";
      $("proxyFormPanel").style.display = "none";
      loadProxyView();
    }).catch(function (e) {
      err.textContent = e.message;
      err.style.display = "block";
    });
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
  $("refreshAll").onclick = function () { loadStatus(); loadUsage(true); loadAccounts(); loadMiniLogs(); loadModels(true); toast("已刷新"); };
  // Forced, not cached: the button exists precisely to re-read upstream now.
  $("usageReload").onclick = function () { loadUsage(true); };
  $("modelUsageReload").onclick = function () { loadModelUsage(); toast("已刷新模型用量"); };
  $("chartReload").onclick = function () { loadTimeline(); toast("已刷新走势"); };
  $("chartMetric").onchange = function () {
    // Re-render from the cached timeline: switching the metric is a redraw, not
    // a new upstream read.
    if (timelineCache) renderChartInto($("chartWrap"), $("chartHint"), timelineCache, this.value);
    else loadTimeline();
  };
  $("modelChartMetric").onchange = function () {
    if (timelineCache) renderModelChart(timelineCache);
    else loadTimeline();
  };
  $("freeQuotaReload").onclick = function () { loadFreeQuota(); toast("已刷新免费额度"); };
  $("freeProbeSelected").onclick = function () {
    var ids = Object.keys(freeProbeSelected);
    runFreeProbe(ids, "选中的 " + ids.length + " 个账号");
  };
  $("freeProbeAll").onclick = function () {
    var on = this.checked;
    freeProbeSelected = {};
    if (on) {
      freeQuotaRows.forEach(function (row) { freeProbeSelected[row.id] = true; });
    }
    renderFreeQuota();
  };
  $("freeProbeExhausted").onclick = function () {
    var ids = freeQuotaRows
      .filter(function (row) { return row.signal && row.signal.state === "exhausted"; })
      .map(function (row) { return row.id; });
    runFreeProbe(ids, "标记为已耗尽的账号");
  };

  /* ---------- window + account filter controls ---------- */
  function syncWindowControls() {
    var preset = $("winPreset").value;
    var custom = preset === "custom";
    $("winHours").style.display = custom ? "inline-block" : "none";
    if (!custom) usageWindow.hours = Number(preset);
    else {
      var v = Number($("winHours").value);
      usageWindow.hours = (isFinite(v) && v > 0) ? Math.min(v, 720) : 24;
    }
    // Anchoring only changes the answer for a day-long window: shorter ones
    // ignore it server-side, and a multi-day window has no single midnight to
    // snap to. Hide it everywhere else so it cannot look like a no-op.
    var dayScale = usageWindow.hours >= 23 && usageWindow.hours <= 25;
    $("winAnchorWrap").style.display = dayScale ? "" : "none";
    if (!dayScale && usageWindow.anchorDay) {
      usageWindow.anchorDay = false;
      $("winAnchorDay").checked = false;
    }
  }
  $("winPreset").onchange = function () {
    syncWindowControls();
    usagePage = 1;
    loadUsage();
    // The charts and per-model table share this window, so they follow it too.
    loadTimeline();
    if ($("view-quota").classList.contains("active")) loadModelUsage();
  };
  $("winHours").onchange = function () {
    syncWindowControls();
    usagePage = 1;
    loadUsage();
    loadTimeline();
    if ($("view-quota").classList.contains("active")) loadModelUsage();
  };
  $("winAnchorDay").onchange = function () {
    usageWindow.anchorDay = this.checked;
    usagePage = 1;
    loadUsage();
    loadTimeline();
    if ($("view-quota").classList.contains("active")) loadModelUsage();
  };

  $("acctStatus").onchange = function () {
    acctFilter.status = this.value;
    acctPage = 1;
    loadAccounts(1);
  };
  $("acctSearch").oninput = debounce(function (event) {
    acctFilter.q = event.target.value.trim();
    acctPage = 1;
    loadAccounts(1);
  }, 250);
  $("acctReload").onclick = function () { loadAccounts(); toast("已刷新账号列表"); };

  $("acctSelectAll").onchange = function () {
    var on = this.checked;
    var boxes = document.querySelectorAll("#accountsBody input.row-check");
    for (var i = 0; i < boxes.length; i++) {
      setSelected(boxes[i].getAttribute("data-id"), on);
    }
    syncRowCheckboxes();
  };
  $("batchProbe").onclick = batchProbe;
  $("batchSelectFailed").onclick = selectFailed;
  $("batchDisable").onclick = batchDisable;
  $("batchDelete").onclick = batchDelete;
  $("batchClear").onclick = function () {
    selectedIds = {};
    probeCache = {};
    updateBatchBar();
    syncRowCheckboxes();
    $("batchStatus").textContent = "";
    loadAccounts();
  };

  $("proxyAddBtn").onclick = function () {
    $("proxyFormPanel").style.display = "block";
    $("proxyUrl").focus();
  };
  $("proxyFormClose").onclick = function () { $("proxyFormPanel").style.display = "none"; };
  $("proxySubmit").onclick = submitProxy;
  $("proxyReload").onclick = function () { loadProxyView(); toast("已刷新代理列表"); };

  $("rlSave").onclick = saveRateLimit;
  $("rlReset").onclick = function () {
    if (!confirm("清零当前限流计数？只影响这一分钟的历史，不改设置。")) return;
    api("/admin/api/rate-limit/reset", { method: "POST" }).then(function (data) {
      renderRateLimit(data);
      toast("计数已清零", "ok");
    }).catch(function (e) { toast("清零失败：" + e.message, "err"); });
  };

  $("sweepStart").onclick = startSweep;
  $("sweepStop").onclick = function () {
    if (!confirm("中止正在运行的测活？已完成的判定会保留。")) return;
    api("/admin/api/sweep/cancel", { method: "POST" }).then(function (data) {
      renderSweep(data.sweep);
      toast("已请求中止", "ok");
    }).catch(function (e) { toast("中止失败：" + e.message, "err"); });
  };

  $("keyAddBtn").onclick = function () {
    $("keyFormPanel").style.display = "block";
    $("keyResult").style.display = "none";
    $("keyLabel").focus();
  };
  $("keyFormClose").onclick = function () { $("keyFormPanel").style.display = "none"; };
  $("keySubmit").onclick = submitKey;
  $("keyReload").onclick = function () { loadKeys(); toast("已刷新密钥列表"); };

  /* ---------- boot ---------- */
  fillSnippets();
  renderChat();
  show(location.hash.slice(1) || "overview");
  loadLoginModes();
  loadAccounts();
  loadStatus();
  loadUsage();
  loadMiniLogs();
  loadTimeline();
  syncLogTimer();
})();
</script>
</body>
</html>`;
