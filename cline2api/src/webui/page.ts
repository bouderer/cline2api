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
<title>cline2api · 控制台</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%234f46e5'/%3E%3Cpath d='M8 11h16M8 16h10M8 21h7' stroke='white' stroke-width='2.6' stroke-linecap='round'/%3E%3C/svg%3E" />
<style>
  :root {
    color-scheme: light dark;
    /* Warm paper: cream base, ink text, terracotta accent. */
    --bg:#f5f1ea; --surface:#fdfbf7; --surface-2:#f7f3ec; --border:#e3ddd2; --border-strong:#d0c8b8;
    --text:#2a2520; --muted:#6b6156; --faint:#a39a8c;
    --accent:#c2410c; --accent-soft:#fbe9dd; --accent-fg:#fdfbf7;
    --ok:#4d7c0f; --ok-soft:#eef4e0;
    --warn:#b45309; --warn-soft:#fdf1e2;
    --err:#b91c1c; --err-soft:#fce8e8;
    --sky:#0e7490; --sky-soft:#e0f2f5;
    --radius:14px; --radius-sm:9px;
    --shadow:0 1px 2px rgba(42,37,32,.06), 0 4px 12px -6px rgba(42,37,32,.08), 0 12px 28px -18px rgba(42,37,32,.10);
    --shadow-hover:0 1px 2px rgba(42,37,32,.06), 0 6px 16px -6px rgba(42,37,32,.12), 0 18px 36px -18px rgba(42,37,32,.16);
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,"Liberation Mono",monospace;
    --sans:ui-sans-serif,-apple-system,"Segoe UI",Roboto,"Helvetica Neue",Arial,"PingFang SC","Hiragino Sans GB","Microsoft YaHei",sans-serif;
    /* Chart series: warm-toned, readable on cream. */
    --s1:#c2410c; --s2:#0e7490; --s3:#4d7c0f; --s4:#a16207;
    --s5:#be185d; --s6:#6d28d9; --s7:#0f766e; --s8:#b91c1c;
    --grid:#e8e2d6; --axis:#c8c0b0;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg:#1a1712; --surface:#221e18; --surface-2:#2a251e; --border:#38322a; --border-strong:#4a4238;
      --text:#e8e0d4; --muted:#a39a8c; --faint:#6b6156;
      --accent:#fb923c; --accent-soft:#3a2416; --accent-fg:#1a1712;
      --ok:#a3e635; --ok-soft:#1a2608;
      --warn:#fbbf24; --warn-soft:#2a2110;
      --err:#f87171; --err-soft:#2c1516;
      --sky:#22d3ee; --sky-soft:#0c2331;
      --shadow:0 1px 2px rgba(0,0,0,.4), 0 8px 20px -8px rgba(0,0,0,.5), 0 20px 40px -24px rgba(0,0,0,.6);
      --shadow-hover:0 1px 2px rgba(0,0,0,.4), 0 10px 24px -8px rgba(0,0,0,.55), 0 26px 48px -24px rgba(0,0,0,.7);
      --s1:#fb923c; --s2:#22d3ee; --s3:#a3e635; --s4:#fbbf24;
      --s5:#f472b6; --s6:#a78bfa; --s7:#2dd4bf; --s8:#f87171;
      --grid:#38322a; --axis:#4a4238;
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

  /* ---------- shell: topbar layout, no sidebar ---------- */
  .shell { display:flex; flex-direction:column; min-height:100vh; }
  .topbar {
    background:var(--surface); border-bottom:1px solid var(--border);
    position:sticky; top:0; z-index:40; backdrop-filter:blur(8px);
  }
  .topbar-inner {
    max-width:1400px; margin:0 auto; padding:0 24px;
    display:flex; align-items:center; justify-content:space-between; gap:24px;
    height:64px;
  }
  .brand { display:flex; align-items:center; gap:11px; flex:none; }
  .brand .mark {
    width:36px; height:36px; border-radius:11px; flex:none;
    background:linear-gradient(140deg,#c2410c,#ea580c); color:#fff;
    display:grid; place-items:center; box-shadow:0 4px 12px -4px rgba(194,65,12,.4);
  }
  .brand .mark svg { width:19px; height:19px; }
  .brand .name { font-weight:700; letter-spacing:.2px; font-size:15px; color:var(--text); }
  .brand .ver { color:var(--faint); font-size:11.5px; margin-top:1px; }

  .nav { display:flex; align-items:center; gap:4px; flex:1; justify-content:center; }
  .nav a {
    display:inline-flex; align-items:center; padding:8px 14px; border-radius:8px;
    color:var(--muted); font-size:13.5px; font-weight:500; text-decoration:none;
    transition:background .14s, color .14s;
  }
  .nav a:hover { background:var(--surface-2); color:var(--text); }
  .nav a.active { background:var(--accent-soft); color:var(--accent); font-weight:600; }

  .topbar-right { flex:none; display:flex; align-items:center; gap:10px; }
  .topbar-right .line { display:flex; align-items:center; gap:7px; color:var(--faint); font-size:12px; }
  .dot { width:7px; height:7px; border-radius:50%; background:var(--faint); flex:none; }
  .dot.ok { background:var(--ok); box-shadow:0 0 0 3px var(--ok-soft); }
  .dot.err { background:var(--err); box-shadow:0 0 0 3px var(--err-soft); }

  .main { flex:1; width:100%; max-width:1400px; margin:0 auto; padding:28px 24px 80px; }
  .page-head { display:flex; align-items:flex-start; justify-content:space-between; gap:16px; margin-bottom:24px; }
  .page-head h1 {
    font-size:28px; margin:0 0 4px; letter-spacing:-.8px; font-weight:700;
    color:var(--text);
  }
  .page-head p { margin:0; color:var(--muted); font-size:14px; }
  .page-head .actions { display:flex; gap:8px; flex:none; }
  .view { display:none; }
  .view.active { display:block; animation:fade .2s ease; }
  @keyframes fade { from { opacity:0; transform:translateY(4px); } to { opacity:1; transform:none; } }

  /* Dashboard hero band: full-width, colored, sets the tone. */
  /* KPI strip: one dense row, so the charts below get the vertical space. */
  .kpis {
    display:grid; grid-template-columns:repeat(auto-fit,minmax(132px,1fr));
    gap:0; margin-bottom:18px; border:1px solid var(--border); border-radius:var(--radius);
    background:var(--surface); box-shadow:var(--shadow); overflow:hidden;
  }
  .kpi { padding:16px 18px; border-right:1px solid var(--border); }
  .kpi:last-child { border-right:0; }
  .kpi .k { color:var(--muted); font-size:11px; font-weight:600; letter-spacing:.3px;
            text-transform:uppercase; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
  .kpi .v { font-size:23px; font-weight:700; letter-spacing:-.7px; margin-top:5px; line-height:1.05;
            font-variant-numeric:tabular-nums; }
  .kpi .s { color:var(--faint); font-size:11px; margin-top:4px; white-space:nowrap;
            overflow:hidden; text-overflow:ellipsis; }

  /* Dashboard: charts carry the page, side column for leaderboards. */
  .dash { display:grid; grid-template-columns:minmax(0,2.1fr) minmax(260px,1fr); gap:18px; align-items:start; }
  .dash-main { display:flex; flex-direction:column; gap:18px; min-width:0; }
  .dash-side { display:flex; flex-direction:column; gap:18px; min-width:0; }
  .dash .card + .card { margin-top:0; }
  .chart-lg .chart { height:260px; }
  .chart-sm .chart { height:150px; }

  /* Ranked bars: a model leaderboard that reads faster than a table. */
  .rank { display:flex; flex-direction:column; }
  .rank-row { display:grid; grid-template-columns:minmax(0,1fr) auto; gap:10px;
              padding:9px 18px; align-items:center; border-top:1px solid var(--border); }
  .rank-row:first-child { border-top:0; }
  .rank-row .nm { min-width:0; }
  .rank-row .nm .t { font-size:12.5px; font-family:var(--mono); white-space:nowrap;
                     overflow:hidden; text-overflow:ellipsis; }
  .rank-row .nm .bar { height:5px; border-radius:999px; background:var(--border); margin-top:5px; overflow:hidden; }
  .rank-row .nm .bar > i { display:block; height:100%; border-radius:999px; }
  .rank-row .val { text-align:right; white-space:nowrap; }
  .rank-row .val .n { font-size:13px; font-weight:650; font-variant-numeric:tabular-nums; }
  .rank-row .val .u { color:var(--faint); font-size:10.5px; }

  /* ---------- primitives ---------- */
  .card {
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow);
    transition:box-shadow .18s ease, transform .18s ease;
  }
  .card:hover { box-shadow:var(--shadow-hover); }
  .card + .card { margin-top:18px; }
  .card-head { padding:18px 22px; border-bottom:1px solid var(--border); display:flex; align-items:center; justify-content:space-between; gap:12px; }
  .card-head h2 { font-size:15px; margin:0; font-weight:650; letter-spacing:-.2px; }
  .card-head .hint { color:var(--muted); font-size:12.5px; margin-top:3px; }
  .card-body { padding:22px; }
  .card-body.tight { padding:0; }
  .grid { display:grid; gap:18px; }
  .grid.cols { grid-template-columns:repeat(auto-fit,minmax(210px,1fr)); }
  .grid.two { grid-template-columns:repeat(auto-fit,minmax(320px,1fr)); }
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

  /* ---------- tabs ---------- */
  .tabs { display:flex; gap:4px; margin-bottom:18px; border-bottom:1px solid var(--border); padding-bottom:0; }
  .tab {
    padding:10px 16px; border:0; border-radius:8px 8px 0 0; background:none;
    color:var(--muted); font:inherit; font-size:13.5px; font-weight:500; cursor:pointer;
    transition:color .14s, background .14s; margin-bottom:-1px; border-bottom:2px solid transparent;
  }
  .tab:hover { color:var(--text); background:var(--surface-2); }
  .tab.active { color:var(--accent); border-bottom-color:var(--accent); font-weight:600; }
  .tab-panel { display:none; }
  .tab-panel.active { display:block; animation:fade .2s ease; }

  button.btn {
    display:inline-flex; align-items:center; gap:7px; font:inherit; cursor:pointer;
    padding:8px 14px; border-radius:var(--radius-sm); border:1px solid var(--border-strong);
    background:var(--surface); color:var(--text);
    transition:border-color .14s, background .14s, opacity .14s, box-shadow .14s, transform .14s;
  }
  button.btn svg { width:15px; height:15px; }
  button.btn:hover:not(:disabled) { border-color:var(--accent); color:var(--accent); box-shadow:var(--shadow); }
  button.btn:active:not(:disabled) { transform:translateY(1px); }
  button.btn:disabled { opacity:.5; cursor:not-allowed; }
  button.btn.primary {
    background:linear-gradient(160deg, #c2410c, #ea580c); border-color:transparent; color:var(--accent-fg);
    box-shadow:0 2px 8px -2px rgba(194,65,12,.5);
  }
  button.btn.primary:hover:not(:disabled) { opacity:.94; color:var(--accent-fg); box-shadow:0 4px 12px -2px rgba(194,65,12,.6); }
  button.btn.ghost { border-color:transparent; background:none; color:var(--muted); }
  button.btn.ghost:hover:not(:disabled) { background:var(--surface-2); color:var(--text); box-shadow:none; }
  button.btn.small { padding:5px 10px; font-size:12px; border-radius:8px; }
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
    border:1px solid var(--border-strong); border-radius:var(--radius-sm); padding:8px 12px; width:100%;
    transition:border-color .14s, box-shadow .14s;
  }
  input:focus, select:focus, textarea:focus {
    outline:none; border-color:var(--accent);
    box-shadow:0 0 0 3px var(--accent-soft);
  }
  textarea { min-height:82px; resize:vertical; line-height:1.6; }
  label.field { display:block; }
  label.field > span { display:block; color:var(--muted); font-size:12.5px; margin-bottom:6px; }
  .switch { display:inline-flex; align-items:center; gap:8px; color:var(--muted); font-size:13px; cursor:pointer; user-select:none; }
  .switch input { appearance:none; width:36px; height:21px; border-radius:999px; background:var(--border-strong); position:relative; transition:background .15s; cursor:pointer; }
  .switch input::after { content:""; position:absolute; top:2px; left:2px; width:17px; height:17px; border-radius:50%; background:#fff; transition:transform .15s; }
  .switch input:checked { background:var(--accent); }
  .switch input:checked::after { transform:translateX(15px); }

  .stat {
    border:1px solid var(--border); border-radius:var(--radius); padding:22px; background:var(--surface);
    box-shadow:var(--shadow); transition:box-shadow .18s ease, transform .18s ease;
    position:relative; overflow:hidden;
  }
  .stat:hover { box-shadow:var(--shadow-hover); transform:translateY(-2px); }
  .stat .ico {
    width:36px; height:36px; border-radius:10px; display:grid; place-items:center;
    margin-bottom:14px; font-size:15px; font-weight:700;
  }
  .stat .ico svg { width:17px; height:17px; }
  .stat .ico.c1 { background:#fbe9dd; color:#c2410c; }
  .stat .ico.c2 { background:#eef4e0; color:#4d7c0f; }
  .stat .ico.c3 { background:#e0f2f5; color:#0e7490; }
  .stat .ico.c4 { background:#fdf1e2; color:#b45309; }
  .stat .ico.c5 { background:#fce8e8; color:#b91c1c; }
  .stat .ico.c6 { background:#f3e8ff; color:#6d28d9; }
  .stat .k { color:var(--muted); font-size:12px; display:flex; align-items:center; gap:6px; font-weight:600; letter-spacing:.2px; text-transform:uppercase; }
  .stat .v { font-size:34px; font-weight:700; letter-spacing:-1.2px; margin-top:4px; line-height:1.05; font-variant-numeric:tabular-nums; }
  .stat .s { color:var(--faint); font-size:11.5px; margin-top:8px; line-height:1.4; }

  .pre {
    background:var(--surface-2); border:1px solid var(--border); border-radius:var(--radius-sm);
    padding:12px 14px; white-space:pre-wrap; word-break:break-word; user-select:all; margin:0;
    font-family:var(--mono); font-size:12.5px; line-height:1.65;
  }
  .kv { display:grid; grid-template-columns:auto minmax(0,1fr); gap:7px 16px; align-items:baseline; }
  .kv .k { color:var(--muted); font-size:12.5px; white-space:nowrap; }
  .kv .v { min-width:0; overflow-wrap:anywhere; }
  .bar { height:6px; border-radius:999px; background:var(--border); overflow:hidden; }
  /* Usage/fullness meters: a single gradient from a pale blue (empty, left) to
     a deep red (full, right). The filled portion slides across it, so the same
     gradient reads as "how full" at any width. */
  .bar > i { display:block; height:100%; background:linear-gradient(90deg,#93c5fd,#f59e0b,#b91c1c); }
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
  .c-area { stroke:var(--surface); stroke-width:1; }
  .c-areaflat { stroke:none; }
  .c-line { fill:none; stroke-width:2.2; stroke-linejoin:round; stroke-linecap:round; }
  .c-dot { stroke:var(--surface); stroke-width:2; }
  .c-grid { stroke:var(--grid); stroke-width:1; stroke-dasharray:3 5; }
  .c-tick { fill:var(--muted); font-size:11px; font-family:var(--sans); }
  .c-hit { fill:transparent; }
  .c-hit:hover { fill:var(--text); opacity:.04; }
  /* Series colors.
     A mark carries its color as currentColor from one of the .sN classes below,
     rather than putting var(--sN) straight into the fill/stroke attribute.

     That indirection is load-bearing, not style. Safari/WebKit does not resolve
     a CSS custom property inside an SVG presentation attribute, so a
     fill="var(--s1)" paints nothing there: every band, line and gradient stop
     comes out invisible and the chart shows only its gridlines and axis labels,
     which reads as "the chart never loaded". A custom property in a stylesheet
     rule is resolved by every engine, and currentColor is plain SVG 1.1, so
     this pairing works everywhere.

     stop-color is listed here too, rather than left to the attribute: it is a
     real CSS property, so the class rule resolves the variable for gradient
     stops without relying on currentColor resolving from inside a gradient. */
  .s1 { color:var(--s1); stop-color:var(--s1); }
  .s2 { color:var(--s2); stop-color:var(--s2); }
  .s3 { color:var(--s3); stop-color:var(--s3); }
  .s4 { color:var(--s4); stop-color:var(--s4); }
  .s5 { color:var(--s5); stop-color:var(--s5); }
  .s6 { color:var(--s6); stop-color:var(--s6); }
  .s7 { color:var(--s7); stop-color:var(--s7); }
  .s8 { color:var(--s8); stop-color:var(--s8); }
  .legend { display:flex; gap:16px; flex-wrap:wrap; margin-top:10px; font-size:12px; color:var(--muted); }
  .legend .lg { display:inline-flex; align-items:center; gap:6px; }
  .legend .lg i { width:10px; height:10px; border-radius:3px; display:inline-block; }
  /* The swatch paints itself from the series class's color, so a swatch and
     its band can never pick different tokens. */
  .legend .lg i[class] { background:currentColor; }
  .chart-tip {
    position:absolute; pointer-events:none; z-index:5;
    background:var(--surface); border:1px solid var(--border-strong); border-radius:9px;
    box-shadow:var(--shadow); padding:8px 10px; font-size:12px; min-width:150px;
  }
  .chart-tip .tip-row { display:flex; justify-content:space-between; gap:14px; }
  .chart-tip .tip-k { color:var(--muted); display:inline-flex; align-items:center; gap:6px; }
  .chart-tip .tip-v { font-variant-numeric:tabular-nums; }
  .chart-tip .tip-sw { width:9px; height:9px; border-radius:2px; display:inline-block; flex:none; background:currentColor; }

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
  th, td { text-align:left; padding:14px 18px; font-size:13px; vertical-align:middle; }
  thead th {
    position:sticky; top:0; z-index:1; background:var(--surface); color:var(--muted);
    font-weight:600; font-size:11.5px; letter-spacing:.4px; text-transform:uppercase;
    border-bottom:1px solid var(--border); padding:12px 18px;
  }
  tbody tr { transition:background .1s; }
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

  /* ---------- console workbench ---------- */
  .workbench { display:grid; grid-template-columns:228px minmax(0,1fr); gap:14px; align-items:start; }
  .wb-side {
    position:sticky; top:24px; max-height:calc(100vh - 48px);
    display:flex; flex-direction:column; overflow:hidden;
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow);
  }
  .wb-side-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:11px 12px; border-bottom:1px solid var(--border); font-size:13px; font-weight:650; }
  .wb-side-search { padding:10px 10px 2px; }
  .wb-side-search input { padding:6px 10px; font-size:12.5px; }
  .wb-sessions { flex:1; min-height:72px; overflow:auto; padding:6px 8px 8px; display:flex; flex-direction:column; gap:2px; }
  .wb-side-foot { padding:9px 12px; border-top:1px solid var(--border); color:var(--faint); font-size:11px; font-variant-numeric:tabular-nums; }
  .sess { display:flex; align-items:center; gap:4px; padding:7px 8px; border-radius:9px; border:1px solid transparent; cursor:pointer; }
  .sess:hover { background:var(--surface-2); }
  .sess.active { background:var(--accent-soft); border-color:rgba(194,65,12,.28); }
  .sess .meta { flex:1; min-width:0; }
  .sess .t { font-size:12.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sess.active .t { color:var(--accent); font-weight:650; }
  .sess .s2 { color:var(--faint); font-size:10.5px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
  .sess input { padding:4px 7px; font-size:12.5px; }
  .sess .acts { display:flex; gap:1px; opacity:.35; transition:opacity .12s; }
  .sess:hover .acts, .sess.active .acts { opacity:1; }

  .ico-btn { display:inline-grid; place-items:center; padding:3px; border:0; border-radius:6px; background:none; color:var(--faint); cursor:pointer; font:inherit; font-size:11px; }
  .ico-btn:hover { background:var(--surface-2); color:var(--accent); }
  .ico-btn svg { width:13px; height:13px; }

  .wb-main { display:flex; flex-direction:column; gap:12px; min-width:0; }
  .wb-toolbar {
    display:flex; align-items:center; gap:8px; flex-wrap:wrap;
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius);
    box-shadow:var(--shadow); padding:9px 12px;
  }
  /* A run in flight keeps the transcript readable: the session rail stops
     responding rather than silently switching under a live stream. */
  .busy .wb-side { opacity:.55; pointer-events:none; }

  /* searchable model combo */
  .combo { position:relative; flex:1 1 260px; max-width:420px; display:flex; align-items:center; }
  .combo input { padding-right:34px; font-family:var(--mono); font-size:12.5px; }
  .combo-btn { position:absolute; right:3px; width:26px; height:26px; display:grid; place-items:center; border:0; border-radius:7px; background:none; color:var(--muted); cursor:pointer; font-size:12px; }
  .combo-btn:hover { background:var(--surface-2); color:var(--text); }
  .combo-pop {
    position:absolute; top:calc(100% + 5px); left:0; right:0; z-index:30;
    display:flex; flex-direction:column; max-height:330px; overflow:hidden;
    background:var(--surface); border:1px solid var(--border-strong); border-radius:var(--radius-sm); box-shadow:var(--shadow-hover);
  }
  .combo-pop[hidden] { display:none; }
  .combo-pop-head { padding:7px 10px; border-bottom:1px solid var(--border); color:var(--muted); font-size:10.5px; }
  .combo-list { overflow:auto; padding:4px; }
  .combo-group { padding:7px 9px 3px; color:var(--faint); font-size:10.5px; text-transform:uppercase; letter-spacing:.4px; }
  .combo-item { display:flex; align-items:center; gap:8px; padding:6px 9px; border-radius:7px; cursor:pointer; font-family:var(--mono); font-size:12px; }
  .combo-item .b { margin-left:auto; font-family:var(--sans); font-size:10.5px; }
  .combo-item:hover, .combo-item.hi { background:var(--surface-2); }
  .combo-item.sel { background:var(--accent-soft); color:var(--accent); font-weight:650; }
  .combo-empty { padding:18px 12px; text-align:center; color:var(--muted); font-size:12px; }

  /* parameter panel */
  .wb-params { display:flex; flex-wrap:wrap; gap:14px 18px; background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:14px 16px; }
  .wb-params[hidden] { display:none; }
  .param { flex:1 1 170px; min-width:0; display:block; }
  .param.wide { flex:1 1 100%; }
  .param > span { display:block; color:var(--muted); font-size:12px; margin-bottom:6px; }
  .param-actions { display:flex; align-items:center; }
  button.btn.active { border-color:var(--accent); color:var(--accent); background:var(--accent-soft); }

  /* ---------- conversation ---------- */
  .chat {
    display:flex; flex-direction:column; gap:16px;
    height:calc(100vh - 430px); min-height:300px; max-height:74vh; overflow:auto;
    padding:16px 18px;
    background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow);
  }
  .welcome { margin:auto; text-align:center; max-width:520px; padding:14px; }
  .welcome .w-title { font-size:16px; font-weight:650; }
  .welcome .w-sub { color:var(--muted); font-size:12.5px; margin-top:6px; }
  .welcome .w-chips { display:flex; flex-direction:column; gap:7px; margin-top:16px; }
  .welcome .w-chips .btn { justify-content:flex-start; text-align:left; }

  .msg { display:flex; gap:10px; }
  .msg .avatar { width:26px; height:26px; border-radius:8px; flex:none; display:grid; place-items:center; font-size:11px; font-weight:700; }
  .msg.user .avatar { background:var(--accent-soft); color:var(--accent); }
  .msg.assistant .avatar { background:var(--ok-soft); color:var(--ok); }
  .msg .bubble { flex:1; min-width:0; }
  .msg .role { color:var(--faint); font-size:11.5px; margin-bottom:3px; display:flex; gap:6px; align-items:center; flex-wrap:wrap; }
  .msg .body { white-space:pre-wrap; word-break:break-word; }
  .msg .body.md { white-space:normal; }
  .msg .body.err { color:var(--err); }
  .msg .body > *:first-child { margin-top:0; }
  .msg .body > *:last-child { margin-bottom:0; }
  .msg .body p, .msg .body ul, .msg .body ol { margin:0 0 9px; }
  .msg .body ul, .msg .body ol { padding-left:20px; }
  .msg .body li { margin:2px 0; }
  .msg .body h3 { font-size:14.5px; margin:12px 0 7px; }
  .msg .body blockquote { margin:0 0 9px; padding:2px 0 2px 11px; border-left:3px solid var(--border-strong); color:var(--muted); }
  .msg .body hr { border:0; border-top:1px solid var(--border); margin:12px 0; }
  .msg .body a { word-break:break-all; }
  .msg .body code.inline { background:var(--surface-2); border:1px solid var(--border); border-radius:5px; padding:1px 5px; font-size:12px; }
  .msg .body .codeblock { border:1px solid var(--border); border-radius:var(--radius-sm); overflow:hidden; background:var(--surface-2); margin:0 0 9px; }
  .msg .body .code-head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:3px 9px; border-bottom:1px solid var(--border); color:var(--faint); font-size:10.5px; }
  .msg .body .codeblock pre { margin:0; padding:10px 12px; border:0; border-radius:0; background:none; overflow:auto; }
  .msg .body .codeblock code { font-family:var(--mono); font-size:12px; line-height:1.65; white-space:pre; }
  /* The global table styles are for data tables; a Markdown table inside a
     bubble has to opt out of the sticky header and the row hover. */
  .msg .body table.md { border-collapse:collapse; width:100%; margin:0 0 9px; }
  .msg .body table.md th, .msg .body table.md td { position:static; border:1px solid var(--border); padding:5px 9px; font-size:12.5px; background:none; text-transform:none; letter-spacing:0; }
  .msg .body table.md thead th { background:var(--surface-2); font-weight:650; }
  .msg .body table.md tbody tr:hover td { background:none; }
  .msg .msg-meta { color:var(--faint); font-size:11px; margin-top:5px; font-variant-numeric:tabular-nums; }
  .msg-tools { display:flex; gap:2px; margin-top:5px; opacity:.4; transition:opacity .12s; }
  .msg:hover .msg-tools { opacity:1; }
  .msg-edit { display:flex; flex-direction:column; gap:8px; }
  .msg-edit textarea { min-height:70px; }
  .tok.k { color:var(--s6); font-weight:600; }
  .tok.s { color:var(--s7); }
  .tok.n { color:var(--s4); }
  .tok.c { color:var(--faint); font-style:italic; }
  .caret { display:inline-block; width:7px; height:14px; background:var(--accent); vertical-align:-2px; animation:blink 1s steps(2) infinite; }
  @keyframes blink { 50% { opacity:0; } }

  /* composer */
  .wb-composer { background:var(--surface); border:1px solid var(--border); border-radius:var(--radius); box-shadow:var(--shadow); padding:12px 14px; transition:border-color .14s; }
  .wb-composer:focus-within { border-color:var(--border-strong); }
  .wb-composer textarea { border:0; background:none; padding:0; min-height:58px; resize:none; }
  .wb-composer textarea:focus { box-shadow:none; }
  .wb-composer-foot { display:flex; align-items:center; gap:12px; margin-top:9px; }

  /* ---------- login ---------- */
  .login-box { display:none; margin-top:16px; border-top:1px solid var(--border); padding-top:16px; }
  .qr { background:#fff; padding:10px; border-radius:12px; border:1px solid var(--border); line-height:0; flex:none; }
  .qr svg { width:184px; height:184px; display:block; }
  .device-code { font-family:var(--mono); font-size:26px; letter-spacing:3px; font-weight:700; }

  #toast { position:fixed; left:50%; bottom:28px; transform:translate(-50%,12px); z-index:60;
    background:#241911; color:#f6efe6; border:1px solid rgba(246,239,230,.14); padding:12px 18px; border-radius:12px;
    font-size:13.5px; font-weight:550; letter-spacing:.1px;
    box-shadow:0 12px 32px -12px rgba(20,14,8,.6); opacity:0; transition:opacity .2s,transform .2s; pointer-events:none; max-width:80vw; }
  #toast.show { opacity:1; transform:translate(-50%,0); }


  /* Login screen. Full page, not a card dropped on the console. */
  #loginGate { position:fixed; inset:0; z-index:50; display:flex; background:var(--bg); }
  #loginGate[hidden] { display:none; }
  .login-aside {
    flex:1.1; display:flex; flex-direction:column; justify-content:space-between;
    padding:40px 48px; color:#f6efe6;
    background:
      radial-gradient(900px 420px at 15% -10%, rgba(234,88,12,.45), transparent 60%),
      radial-gradient(700px 380px at 110% 110%, rgba(180,83,9,.35), transparent 60%),
      linear-gradient(160deg,#3a2418 0%,#241911 55%,#1a120d 100%);
  }
  .login-brand { display:flex; align-items:center; gap:12px; font-weight:700; letter-spacing:.3px; }
  .login-brand .mark { width:38px; height:38px; border-radius:12px; background:linear-gradient(140deg,#ea580c,#c2410c); display:grid; place-items:center; box-shadow:0 6px 16px -6px rgba(234,88,12,.7); }
  .login-brand .mark svg { width:20px; height:20px; }
  .login-pitch h2 { font-size:34px; line-height:1.25; font-weight:680; letter-spacing:-.6px; margin:0 0 14px; }
  .login-pitch p { margin:0; max-width:420px; color:rgba(246,239,230,.72); font-size:15px; line-height:1.7; }
  .login-points { display:flex; flex-direction:column; gap:14px; margin-top:28px; }
  .login-point { display:flex; gap:12px; align-items:flex-start; }
  .login-point .n { flex:none; width:26px; height:26px; border-radius:8px; background:rgba(234,88,12,.18); color:#fdba74; display:grid; place-items:center; font-size:13px; font-weight:700; }
  .login-point div { font-size:13.5px; line-height:1.55; color:rgba(246,239,230,.8); }
  .login-point strong { display:block; color:#f6efe6; font-weight:620; margin-bottom:1px; }
  .login-aside .foot { color:rgba(246,239,230,.45); font-size:12px; }
  .login-main { flex:1; display:flex; align-items:center; justify-content:center; padding:32px 24px; }
  .login-card { width:100%; max-width:380px; }
  .login-card h1 { font-size:26px; font-weight:700; letter-spacing:-.5px; margin:0 0 6px; }
  .login-card .sub { color:var(--muted); font-size:13.5px; margin-bottom:26px; }
  .login-card .field { margin-bottom:16px; }
  .login-card .field input { padding:11px 13px; font-size:14.5px; background:var(--surface); }
  #loginError { color:var(--err); font-size:13px; min-height:20px; margin:2px 0 8px; }
  .login-card .btn { width:100%; justify-content:center; padding:11px 16px; font-size:15px; }
  @media (max-width:860px) { .login-aside { display:none; } }

  /* Login gate. Covers the console until a session cookie exists. */

  body:not(.authed) .shell { display:none; }
  @media (max-width:1000px) {
    .main { padding:20px 16px 60px; }
    .page-head h1 { font-size:22px; }
    .topbar-inner {
      height:auto; flex-wrap:wrap; gap:10px;
      padding:10px 16px;
    }
    .nav { order:3; flex:1 1 100%; flex-wrap:wrap; justify-content:flex-start; gap:4px; }
    .nav a { padding:6px 10px; font-size:13px; }
    .topbar-right { width:100%; justify-content:flex-start; flex-wrap:wrap; gap:6px 12px; }
    .topbar-right .line { max-width:100%; }
    .brand .mark { width:30px; height:30px; border-radius:9px; }
    .workbench { grid-template-columns:1fr; }
    .wb-side { position:static; max-height:280px; }
    .chat { height:auto; max-height:62vh; }
    .combo { max-width:none; }
  }
</style>
</head>
<body>
<div id="loginGate" hidden>
  <aside class="login-aside">
    <div class="login-brand">
      <div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M4 12h10M4 17h7"/></svg></div>
      cline2api
    </div>
    <div class="login-pitch">
      <h2>一个入口，看完整条网关。</h2>
      <p>账号、配额、密钥和每一次调用，都在登录之后。</p>
      <div class="login-points">
        <div class="login-point"><span class="n">1</span><div><strong>账号池</strong>上千个 Cline 账号的状态、订阅和额度。</div></div>
        <div class="login-point"><span class="n">2</span><div><strong>用量</strong>按模型和时间看清流量花在哪里。</div></div>
        <div class="login-point"><span class="n">3</span><div><strong>控制台</strong>直接对任意模型发起一次调用。</div></div>
      </div>
    </div>
    <div class="foot">与 grok-iq 共用同一个管理员账号。</div>
  </aside>
  <main class="login-main">
    <form class="login-card" id="loginForm" autocomplete="on">
      <h1>登录</h1>
      <div class="sub">使用 grok-iq 的管理员用户名和密码。</div>
      <label class="field"><span>用户名</span>
        <input id="loginUser" name="username" autocomplete="username" spellcheck="false" autofocus />
      </label>
      <label class="field"><span>密码</span>
        <input id="loginPass" name="password" type="password" autocomplete="current-password" />
      </label>
      <div id="loginError"></div>
      <button class="btn primary" id="loginSubmit" type="submit">登录</button>
    </form>
  </main>
</div>
<div class="shell">
  <header class="topbar">
    <div class="topbar-inner">
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
        <a href="/" data-route="overview" class="active">概览</a>
        <a href="/models" data-route="models">模型</a>
        <a href="/console" data-route="play">控制台</a>
        <a href="/accounts" data-route="accounts">账号</a>
        <a href="/quota" data-route="quota">配额</a>
        <a href="/proxies" data-route="proxies">代理</a>
        <a href="/keys" data-route="keys">密钥</a>
        <a href="/logs" data-route="logs">日志</a>
        <a href="/settings" data-route="settings">设置</a>
      </nav>

      <div class="topbar-right">
        <div class="line" id="upstreamLine" style="max-width:280px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap" title="">上游 —</div>
        <div class="line"><span class="dot" id="healthDot"></span><span id="healthText">检查中…</span></div>
        <button class="btn" id="logoutBtn" type="button">退出</button>
      </div>
    </div>
  </header>

  <main class="main" id="main">
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

      <div class="kpis">
        <div class="kpi">
          <div class="k">可用账号</div>
          <div class="v num" id="sAccounts">—</div>
          <div class="s" id="sAccountsHint">—</div>
        </div>
        <div class="kpi">
          <div class="k">今日 Token</div>
          <div class="v num" id="sToday">—</div>
          <div class="s" id="sTodayHint">—</div>
        </div>
        <div class="kpi">
          <div class="k">订阅模型</div>
          <div class="v num" id="sPass">—</div>
          <div class="s">不消耗 Credits</div>
        </div>
        <div class="kpi">
          <div class="k">免费模型</div>
          <div class="v num" id="sFree">—</div>
          <div class="s">上游 Free 同款</div>
        </div>
        <div class="kpi">
          <div class="k">模型总数</div>
          <div class="v num" id="sTotal">—</div>
          <div class="s" id="sCreditsHint">—</div>
        </div>
        <div class="kpi">
          <div class="k">配额占用最高</div>
          <div class="v num" id="sQuota">—</div>
          <div class="s" id="sQuotaHint">—</div>
        </div>
      </div>

      <div class="dash">
        <div class="dash-main">
          <div class="card chart-lg">
            <div class="card-head">
              <div>
                <h2>用量走势</h2>
                <div class="hint" id="ovChartHint">—</div>
              </div>
              <div class="row" style="gap:8px">
                <select id="ovChartMetric" style="width:auto; min-width:118px">
                  <option value="totalTokens">Token</option>
                  <option value="requests">请求数</option>
                  <option value="cacheHitRate">缓存命中率</option>
                </select>
                <button class="btn small" data-goto="quota">详情</button>
              </div>
            </div>
            <div class="card-body">
              <div id="ovChartWrap"><div class="muted sm">读取中…</div></div>
            </div>
          </div>

          <div class="card chart-sm">
            <div class="card-head">
              <div>
                <h2>按模型走势</h2>
                <div class="hint" id="ovModelChartHint">—</div>
              </div>
            </div>
            <div class="card-body">
              <div id="ovModelChartWrap"><div class="muted sm">读取中…</div></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <h2>最近请求</h2>
              <button class="btn small" data-goto="logs">查看全部</button>
            </div>
            <div class="card-body tight"><div class="table-wrap" style="max-height:240px">
              <table>
                <thead><tr><th class="nowrap">时间</th><th>模型</th><th class="nowrap">状态</th><th class="nowrap">耗时</th></tr></thead>
                <tbody id="miniLogs"><tr><td colspan="4" class="empty sm">还没有请求记录。</td></tr></tbody>
              </table>
            </div></div>
          </div>
        </div>

        <div class="dash-side">
          <div class="card">
            <div class="card-head">
              <div>
                <h2>模型排行</h2>
                <div class="hint" id="ovTopModelsHint">—</div>
              </div>
            </div>
            <div class="card-body tight">
              <div class="rank" id="ovTopModels"><div class="muted sm" style="padding:16px 18px">读取中…</div></div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <h2>接入方式</h2>
            </div>
            <div class="card-body">
              <div class="xs faint" style="margin-bottom:6px">OpenAI 兼容</div>
              <pre class="pre" id="snippetOpenai" style="max-height:120px; overflow:auto">-</pre>
              <button class="btn small" data-copy-target="snippetOpenai" style="margin-top:8px">复制</button>
              <div class="xs faint" style="margin:14px 0 6px">Claude Code（Anthropic）</div>
              <pre class="pre" id="snippetClaude" style="max-height:120px; overflow:auto">-</pre>
              <button class="btn small" data-copy-target="snippetClaude" style="margin-top:8px">复制</button>
            </div>
          </div>
        </div>
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
          <p>用量随时间的走势、按模型拆分，以及每个账号的免费额度状态。</p>
        </div>
        <div class="actions">
          <label class="field" style="margin:0">
            <select id="winPreset" style="min-width:148px">
              <option value="1">最近 1 小时</option>
              <option value="6">最近 6 小时</option>
              <option value="24" selected>最近 24 小时</option>
              <option value="72">最近 3 天</option>
              <option value="168">最近 7 天</option>
              <option value="720">最近 30 天</option>
              <option value="custom">自定义…</option>
            </select>
          </label>
          <input type="number" id="winHours" min="0.1" max="720" step="0.5" value="24"
            style="width:92px; display:none" title="窗口长度（小时）" />
          <label class="row xs muted" id="winAnchorWrap" style="gap:5px; margin:0; cursor:pointer"
            title="从本地今天零点算起，而不是从现在往回滚 24 小时">
            <input type="checkbox" id="winAnchorDay" style="width:auto; margin:0" />
            从今天零点起
          </label>
        </div>
      </div>

      <div class="tabs" id="quotaTabs">
        <button class="tab active" data-quota-tab="charts">用量走势</button>
        <button class="tab" data-quota-tab="models">按模型</button>
        <button class="tab" data-quota-tab="credits">Credits</button>
        <button class="tab" data-quota-tab="free">免费额度</button>
      </div>

      <div class="tab-panel active" id="quotaTab-charts">
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
      </div>

      <div class="tab-panel" id="quotaTab-models">
        <div class="card">
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
      </div>

      <div class="tab-panel" id="quotaTab-credits">
        <div class="card">
          <div class="card-head">
            <div>
              <h2>Credits</h2>
              <div class="hint">每个账号的 Cline Credits 余额与窗口内消耗。1 credit = $0.01；负数表示已透支。免费桶和 Cline Pass 的流量不计入 Credits，所以这些账号的消耗为 0。</div>
              <div class="hint" id="creditsHint">—</div>
            </div>
            <div class="row" style="gap:8px">
              <button class="btn small" id="creditsReload">重新读取</button>
              <button class="btn small" id="capSweep" title="逐个读取每个账号的套餐，用于把 cline-pass 模型路由到真正有权限的账号">扫描账号权限</button>
            </div>
          </div>
          <div class="card-body tight">
            <div class="hint" id="capHint" style="padding:12px 18px 0">—</div>
            <div class="kpis" style="padding:16px 18px 0" id="creditTotals">
              <div class="kpi">
                <div class="k">合计余额</div>
                <div class="v num" id="crBalance">—</div>
                <div class="s" id="crBalanceHint">—</div>
              </div>
              <div class="kpi">
                <div class="k">窗口内消耗</div>
                <div class="v num" id="crUsed">—</div>
                <div class="s" id="crUsedHint">—</div>
              </div>
              <div class="kpi">
                <div class="k">正余额账号</div>
                <div class="v num" id="crPositive">—</div>
                <div class="s" id="crPositiveHint">—</div>
              </div>
              <div class="kpi">
                <div class="k">已透支账号</div>
                <div class="v num" id="crNegative">—</div>
                <div class="s" id="crNegativeHint">—</div>
              </div>
            </div>
            <div class="table-wrap">
              <table>
                <thead><tr>
                  <th>账号</th>
                  <th class="nowrap num">余额（credits）</th>
                  <th class="nowrap num">余额（USD）</th>
                  <th class="nowrap num">窗口消耗</th>
                  <th class="nowrap num">请求</th>
                  <th class="nowrap">上次使用</th>
                </tr></thead>
                <tbody id="creditsBody"><tr><td colspan="6" class="empty sm">加载中…</td></tr></tbody>
              </table>
            </div>
            <div class="card-foot" id="creditsPager"></div>
          </div>
        </div>
      </div>

      <div class="tab-panel" id="quotaTab-free">
        <div class="card">
          <div class="card-head">
            <div>
              <h2>免费额度</h2>
              <div class="hint">上游没有查剩余额度的接口，所以这里给出的是可观测信号（真实请求撞到 <span class="mono">Daily free limit</span> 的时刻，或手动探测结果）加上按已用 token 推算的占用度。</div>
              <div class="hint" id="freeQuotaHint">—</div>
            </div>
            <div class="row" style="gap:8px">
              <button class="btn small" id="freeQuotaReload">重新扫描全池</button>
            </div>
          </div>
          <div class="card-body tight">
            <div class="row" style="gap:8px; margin-bottom:10px; flex-wrap:wrap; padding:16px 18px 0">
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
      </div>
    </section>

    <!-- ============ 控制台 ============ -->
    <section class="view" id="view-play">
      <div class="page-head">
        <div>
          <h1>控制台</h1>
          <p>多会话工作台 · 走 /admin/api/chat（管理令牌鉴权），浏览器里不需要客户端 Key。</p>
        </div>
      </div>

      <div class="workbench" id="wb">
        <aside class="wb-side">
          <div class="wb-side-head">
            <span>会话</span>
            <button class="btn small" id="playNew">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>
              新建
            </button>
          </div>
          <div class="wb-side-search"><input type="text" id="playSessionSearch" placeholder="搜索会话…" /></div>
          <div class="wb-sessions" id="playSessions"></div>
          <div class="wb-side-foot">
            <button class="btn small ghost" id="playClear">清空当前会话</button>
          </div>
        </aside>

        <div class="wb-main">
          <div class="wb-toolbar">
            <div class="combo" id="playCombo">
              <input type="text" id="playModelFilter" autocomplete="off" spellcheck="false" placeholder="搜索模型…" aria-label="模型" />
              <button class="combo-btn" id="playComboToggle" type="button" title="展开模型列表" aria-label="展开模型列表">▾</button>
              <div class="combo-pop" id="playPop" hidden>
                <div class="combo-pop-head" id="playPopHead">—</div>
                <div class="combo-list" id="playModelList"></div>
              </div>
            </div>
            <button class="btn small" id="playParamsToggle" type="button" title="显示或隐藏采样参数">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M15 4.5v5M9 14.5v5"/></svg>
              参数
            </button>
            <span class="spacer"></span>
            <label class="switch"><input type="checkbox" id="playStream" checked /> 流式输出</label>
            <button class="btn primary" id="playSend">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6L4 12z"/></svg>
              发送
            </button>
            <button class="btn danger" id="playStop" type="button" hidden>
              <svg viewBox="0 0 24 24" fill="currentColor"><rect x="6.5" y="6.5" width="11" height="11" rx="2"/></svg>
              停止
            </button>
          </div>

          <div class="wb-params" id="playParams" hidden>
            <label class="param" style="flex:1 1 100%">
              <span>系统提示词 system</span>
              <textarea id="playSystem" placeholder="留空则不下发 system 消息" style="min-height:64px"></textarea>
            </label>
            <label class="param">
              <span>temperature <b class="num" id="playTempVal">1.00</b></span>
              <input type="range" id="playTemp" min="0" max="2" step="0.05" value="1" style="width:100%; padding:0" />
            </label>
            <label class="param">
              <span>max_tokens <input class="num" type="number" id="playMaxTokens" min="0" max="200000" step="256" placeholder="留空 = 不限制" style="width:118px; padding:4px 8px; margin-left:6px" /></span>
            </label>
            <label class="param">
              <span>历史消息条数上限 <input class="num" type="number" id="playHistory" min="0" max="200" step="2" value="0" style="width:96px; padding:4px 8px; margin-left:6px" /></span>
            </label>
            <div class="param param-actions">
              <button class="btn small" id="playParamsReset" type="button">恢复默认</button>
            </div>
          </div>

          <div class="chat" id="chat"></div>

          <div class="wb-composer">
            <textarea id="playInput" placeholder="输入提示词…（Enter 发送 · Shift+Enter 换行 · Ctrl/⌘+Enter 也发送）"></textarea>
            <div class="wb-composer-foot">
              <span class="sm muted" id="playState">就绪</span>
              <span class="spacer"></span>
              <span class="xs faint" id="playCount"></span>
            </div>
          </div>
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
        <div class="actions">
          <button class="btn" id="proxyProbeBtn">探测出口 IP（本页）</button>
          <button class="btn primary" id="proxyAddBtn">新增 / 批量导入</button>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div>
            <h2>出口轮换</h2>
            <div class="hint">开启后每个请求从已启用的代理里随机选一条出网；关闭则按账号绑定的那条出网。<b>关闭</b>时账号出口可复现，排查按 IP 限流时用这个。</div>
          </div>
          <select id="proxyModeSelect" class="sm" style="width:auto">
            <option value="pinned">按账号绑定</option>
            <option value="sticky">粘性（用坏再换）</option>
            <option value="rotate">每条请求轮换</option>
          </select>
        </div>
        <div class="card-body tight">
          <div class="row between sm">
            <div id="proxyRotationStats" class="muted">—</div>
          </div>
        </div>
      </div>

      <div class="card" id="proxyFormPanel" style="display:none">
        <div class="card-head">
          <div><h2>新增 / 批量导入</h2><div class="hint">形如 <code>http://user:pass@host:port</code>，支持 http / https。SOCKS 端口通常同时支持 HTTP CONNECT，把 scheme 换成 <code>http://</code> 即可。多行一次导入，每行一条。</div></div>
          <button class="btn small ghost" id="proxyFormClose">关闭</button>
        </div>
        <div class="card-body">
          <div class="grid two">
            <label class="field"><span>代理地址（可多行）</span><textarea id="proxyUrl" rows="6" placeholder="http://user:pass@host:port" autocomplete="off" spellcheck="false"></textarea></label>
            <label class="field"><span>备注前缀（可选）</span><input type="text" id="proxyLabel" placeholder="例如 美西住宅 / 提供商A" /></label>
          </div>
          <div class="grid two">
            <label class="field"><span>优先级（可选）</span><input type="number" id="proxyPriority" min="0" step="1" placeholder="0" /><span class="hint">0 = 先用；数字更大的是备用层，只在上一层全部被限流时才接手。</span></label>
          </div>
          <div class="row between" style="margin-top:12px">
            <div class="sm err" id="proxyError" style="display:none; white-space:pre-wrap"></div>
            <button class="btn primary" id="proxySubmit" style="margin-left:auto">保存</button>
          </div>
        </div>
      </div>

      <div class="card">
        <div class="card-head">
          <div><h2>代理列表</h2><div class="hint" id="proxyListHint">—</div></div>
          <div class="row">
            <input type="text" id="proxySearch" class="sm" placeholder="搜索备注 / 地址 / 出口 IP" style="width:220px" />
            <select id="proxyPageSize" class="sm" style="width:auto">
              <option value="20">20 / 页</option>
              <option value="50" selected>50 / 页</option>
              <option value="100">100 / 页</option>
              <option value="200">200 / 页</option>
            </select>
            <button class="btn small" id="proxyReload">刷新</button>
          </div>
        </div>
        <div class="card-body tight">
          <table>
            <thead><tr><th>备注 / 地址</th><th class="nowrap">优先级</th><th class="nowrap">出口 IP</th><th class="nowrap">状态</th><th class="nowrap">被引用</th><th class="nowrap" style="min-width:230px">操作</th></tr></thead>
            <tbody id="proxiesBody"><tr><td colspan="6" class="empty sm">加载中…</td></tr></tbody>
          </table>
        </div>
        <div class="card-body tight row between">
          <div class="sm muted" id="proxyPageInfo">—</div>
          <div class="row">
            <button class="btn small" id="proxyPrev">上一页</button>
            <button class="btn small" id="proxyNext">下一页</button>
          </div>
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
            <thead><tr><th class="nowrap">时间</th><th>模型</th><th class="nowrap" style="width:70px">状态</th><th class="nowrap" style="width:90px">耗时</th><th class="nowrap" style="width:120px">来源 IP</th><th class="nowrap" style="width:120px">出口 IP</th><th class="nowrap" style="width:70px">上游调用</th><th>账号 / 错误</th></tr></thead>
            <tbody id="logsBody"><tr><td colspan="8" class="empty sm">加载中…</td></tr></tbody>
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

    <!-- ============ 设置 ============ -->
    <section class="view" id="view-settings">
      <div class="page-head">
        <div>
          <h1>设置</h1>
          <p>管理员账号与访问凭据。密码与 grok-iq 共用，改一处两边同时生效。</p>
        </div>
      </div>

      <div class="dash">
        <div class="dash-main">
          <div class="card">
            <div class="card-head">
              <div>
                <h2>管理员密码</h2>
                <div class="hint" id="pwHint">修改后，grok-iq 的登录密码也会一起改变。</div>
              </div>
            </div>
            <div class="card-body">
              <div class="xs muted" id="pwUser" style="margin-bottom:14px">当前账号 —</div>
              <label class="field"><span>当前密码</span><input id="pwCurrent" type="password" autocomplete="current-password" /></label>
              <label class="field" style="margin-top:12px"><span>新密码</span><input id="pwNew" type="password" autocomplete="new-password" /></label>
              <label class="field" style="margin-top:12px"><span>确认新密码</span><input id="pwConfirm" type="password" autocomplete="new-password" /></label>
              <div class="row" style="margin-top:16px">
                <button class="btn primary" id="pwSave" type="button">更新密码</button>
                <span class="xs" id="pwMsg"></span>
              </div>
            </div>
          </div>

          <div class="card">
            <div class="card-head">
              <div>
                <h2>Admin Token</h2>
                <div class="hint">注册机和脚本用它推送账号、调用管理接口。控制台登录不使用它。</div>
              </div>
            </div>
            <div class="card-body">
              <div class="xs muted" id="tkStatus" style="margin-bottom:14px">—</div>
              <label class="field"><span>新的 Admin Token</span><input id="tkValue" spellcheck="false" autocomplete="off" placeholder="至少 16 位，不能含空格" /></label>
              <div class="row" style="margin-top:16px">
                <button class="btn" id="tkGenerate" type="button">生成随机令牌</button>
                <button class="btn primary" id="tkSave" type="button">保存</button>
                <span class="xs" id="tkMsg"></span>
              </div>
            </div>
          </div>
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
  var authed = false;
  var pollTimer = null;
  var logTimer = null;
  var currentSession = null;
  var catalog = [];
  var logData = [];
  var logFilter = "";
  var bucketFilter = "";
  /* Console workbench state. Sessions and panel defaults are persisted under
     WB_KEY; everything else is per-tab. */
  var WB_KEY = "cline2api.console.v1";
  var wbBuckets = [
    { key: "pass", label: "订阅可用 · 不消耗 Credits", short: "订阅" },
    { key: "free", label: "免费", short: "免费" },
    { key: "credits", label: "需 Cline Credits", short: "Credits" }
  ];
  var wbDefaults = { system: "", temperature: 1, maxTokens: null, history: 0 };
  var wbState = { paramsOpen: false, model: "", stream: true, sessions: [], active: "" };
  var wbSeq = 0;
  var wbRun = null;          // AbortController of the in-flight request, or null
  var wbLiveIndex = -1;      // index of the message currently streaming
  var wbLiveBody = null;     // its body node, patched in place per chunk
  var wbComboOpen = false;
  var wbComboHi = -1;
  var wbEditIndex = -1;
  var wbRenameId = "";
  var wbQuery = "";

  /* ---------- session handling ----------
     The session lives in an HttpOnly cookie the browser attaches itself, so
     nothing here is stored or read. authed only tracks whether the gate has
     let the page through, so a 401 can send the user back to the login card. */


  /* ---------- tiny helpers ---------- */
  function $(id) { return document.getElementById(id); }
  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) {
      // A node or fragment is appended as-is: textContent would stringify it
      // to its "[object DocumentFragment]" tag.
      if (typeof text === "object" && (text.nodeType || text.nodeType === 11)) node.appendChild(text);
      else node.textContent = String(text);
    }
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
    t.style.background = kind === "err" ? "#7f1d1d" : (kind === "ok" ? "#14532d" : "#241911");
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
  /** Rough in-page token estimate, only for the live counter: the authoritative
      usage arrives from upstream and is stored on the message. */
  function estimateTokens(text) {
    var s = String(text || "");
    var cjk = (s.match(/[㐀-鿿豈-﫿]/g) || []).length;
    return cjk + Math.ceil((s.length - cjk) / 4);
  }
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
  /**
   * A credit balance or spend, in credits (1 credit = 1e4 micro-USD).
   *
   * A negative balance is real — an account can overspend into the red — so the
   * sign is kept rather than hidden behind an absolute value. Two decimals is
   * how Cline's own dashboard renders the same number. The second argument adds
   * an explicit "+" for a spend, where the direction should not have to be
   * inferred from the column heading alone.
   */
  function fmtCredits(micro, signed) {
    if (micro === null || micro === undefined) return "—";
    var v = Number(micro) / 1e4;
    if (!isFinite(v)) return "—";
    return (signed && v > 0 ? "+" : "") + v.toFixed(2);
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
    opts.headers = h;
    opts.credentials = "same-origin";
    return fetch(path, opts).then(function (res) {
      if (res.status === 401) { showLogin(); throw new Error("未登录或登录已失效"); }
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

  function showLogin() {
    var gate = $("loginGate");
    if (gate) gate.hidden = false;
    document.body.classList.remove("authed");
    authed = false;
    var err = $("loginError");
    if (err) err.textContent = "登录已失效，请重新登录。";
  }

  /* ---------- routing: real URL paths, not hash ---------- */
  var routes = {
    "/": "overview",
    "/models": "models",
    "/console": "play",
    "/accounts": "accounts",
    "/quota": "quota",
    "/proxies": "proxies",
    "/keys": "keys",
    "/logs": "logs",
    "/settings": "settings"
  };
  var views = Object.values(routes);

  function routeFromPath(path) {
    return routes[path] || "overview";
  }
  function pathFromRoute(name) {
    for (var p in routes) if (routes[p] === name) return p;
    return "/";
  }

  function show(name, push) {
    if (views.indexOf(name) < 0) name = "overview";
    views.forEach(function (v) {
      var section = $("view-" + v);
      if (section) section.classList.toggle("active", v === name);
    });
    var links = document.querySelectorAll("#nav a");
    for (var i = 0; i < links.length; i++) links[i].classList.toggle("active", links[i].getAttribute("data-route") === name);
    var path = pathFromRoute(name);
    if (push !== false && location.pathname !== path) history.pushState(null, "", path);
    if (name === "models") loadModels();
    if (name === "play") { renderSessions(); renderChat(); loadPlayModels(); }
    if (name === "logs") loadLogs();
    if (name === "accounts") { loadAccounts(); loadModels(); pollSweep(); }
    if (name === "proxies") loadProxyView();
    if (name === "keys") { loadKeys(); loadRateLimit(); }
    if (name === "settings") loadSettings();
    if (name === "overview") { loadStatus(); loadUsage(); loadMiniLogs(); loadTimeline(); }
    if (name === "quota") { loadTimeline(); loadModelUsage(); loadCredits(); loadCapabilities(); loadFreeQuota(); loadModels(); }
  }

  document.querySelectorAll("#nav a").forEach(function (a) {
    a.onclick = function (e) { e.preventDefault(); show(this.getAttribute("data-route")); };
  });
  document.querySelectorAll("[data-goto]").forEach(function (b) {
    b.onclick = function () { show(this.getAttribute("data-goto")); };
  });
  window.addEventListener("popstate", function () { show(routeFromPath(location.pathname), false); });

  /* ---------- quota tabs ---------- */
  document.querySelectorAll("#quotaTabs .tab").forEach(function (tab) {
    tab.onclick = function () {
      var target = this.getAttribute("data-quota-tab");
      document.querySelectorAll("#quotaTabs .tab").forEach(function (t) {
        t.classList.toggle("active", t.getAttribute("data-quota-tab") === target);
      });
      document.querySelectorAll("#view-quota .tab-panel").forEach(function (p) {
        p.classList.toggle("active", p.id === "quotaTab-" + target);
      });
    };
  });

  // Initial route from URL, preserving ?token= for auth. Deferred to the end
  // of the script: show() dispatches to loaders that close over state declared
  // further down (var hoists the binding but not its value), so calling it here
  // would run them against undefined.
  var booted = false;
  function bootRoute() { show(routeFromPath(location.pathname), false); }

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

  /**
   * The series class for a --sN token name: "--s1" -> "s1".
   *
   * Marks carry their color through a class rather than a var() in the
   * fill/stroke attribute — see the series-color note in the stylesheet for
   * why. Kept as a function so the token name stays the single source of truth
   * for which slot a series occupies.
   */
  function seriesClass(varName) {
    return String(varName).replace(/^--/, "");
  }

  /** Short human label for a bucket's start time on a chart axis. */
  function axisBucketLabel(at, stepMs) {
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
  var chartUidCounter = 0;

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

    // Multi-line, not stacked: each series starts from the zero baseline, so the
    // axis is driven by the single largest value, not their sum.
    var maxV = 0;
    series.forEach(function (s) {
      buckets.forEach(function (b) {
        var v = Number(b[s.key]) || 0;
        if (s.key === "promptTokens") v -= Number(b.cachedTokens) || 0;
        if (v > maxV) maxV = v;
      });
    });
    if (!(maxV > 0)) maxV = 1;
    // Round the axis top to a clean step so the ticks read as round numbers.
    var mag = Math.pow(10, Math.floor(Math.log10(maxV)));
    maxV = Math.ceil(maxV / (mag / 2)) * (mag / 2);

    function x(i) { return CHART.padL + (buckets.length === 1 ? plotW / 2 : (plotW * i) / (buckets.length - 1)); }
    function y(v) { return CHART.padT + plotH - (plotH * v) / maxV; }

    var parts = [];
    var defs = [];
    // Unique prefix per rendered chart: several charts share the document, and
    // url(#ag0)/url(#glow) are document-level fragment refs, so identical ids make
    // one chart paint with another chart's gradient/filter. Prefix them.
    var uid = "c" + (chartUidCounter += 1) + "-";

    // One line per series, all from zero — never stacked. A soft translucent
    // area under each (the perspective) keeps overlapping lines readable.
    series.forEach(function (s, si) {
      defs.push('<linearGradient id="'+uid+'ag'+si+'" x1="0" y1="0" x2="0" y2="1">' +
        '<stop class="' + seriesClass(s.varName) + '" offset="0%" stop-color="currentColor" stop-opacity="0.30"/>' +
        '<stop class="' + seriesClass(s.varName) + '" offset="100%" stop-color="currentColor" stop-opacity="0.02"/></linearGradient>');
      var pts = buckets.map(function (b, i) {
        var v = Number(b[s.key]) || 0;
        // The cache band is part of prompt: subtract it so the input line shows
        // uncached input only and the two do not double-count.
        if (s.key === "promptTokens") v -= Number(b.cachedTokens) || 0;
        if (v < 0) v = 0;
        return x(i) + "," + y(v);
      });
      var areaPts = pts.concat([x(buckets.length - 1) + "," + y(0), x(0) + "," + y(0)]);
      parts.push('<polygon class="c-area ' + seriesClass(s.varName) + '" points="' + areaPts.join(" ") +
        '" fill="url(#' + uid + 'ag' + si + ')" />');
      parts.push('<polyline class="c-line ' + seriesClass(s.varName) + '" points="' + pts.join(" ") +
        '" stroke="currentColor" fill="none" />');
    });
    // End marker on the first series only, so multi-line charts stay clean.
    if (series.length > 0) {
      var lastPts = buckets.map(function (b, i) {
        var v = Number(b[series[0].key]) || 0;
        if (series[0].key === "promptTokens") v -= Number(b.cachedTokens) || 0;
        if (v < 0) v = 0;
        return v;
      });
      var lastX = x(buckets.length - 1);
      var lastY = y(lastPts[lastPts.length - 1] || 0);
      parts.push('<circle class="c-dot ' + seriesClass(series[0].varName) + '" cx="' + lastX + '" cy="' + lastY + '" r="4" fill="currentColor" />');
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
        axisBucketLabel(buckets[i].at, step) + "</text>");
    });

    // Hover hit layer: one invisible band per bucket, wider than the mark.
    var hits = buckets.map(function (b, i) {
      var bw = plotW / Math.max(1, buckets.length - 1);
      return '<rect class="c-hit" x="' + (x(i) - bw / 2) + '" y="' + CHART.padT + '" width="' + bw +
        '" height="' + plotH + '" data-i="' + i + '" />';
    });

    var svg = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img">' +
      "<defs>" + defs.join("") + "</defs>" + grid.join("") + parts.join("") + hits.join("") + xLabels.join("") + "</svg>";

    // The legend doubles as the identity channel: a colored key plus the label,
    // never a colored label. The key is classed rather than inline-styled so it
    // reads the same color definition its band does.
    var legend = '<div class="legend">' + series.map(function (s) {
      return '<span class="lg"><i class="' + seriesClass(s.varName) + '"></i>' + s.label + "</span>";
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
  // HTML-escape text that goes into innerHTML (model ids come from upstream).
  function escHtml(t) {
    return String(t).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  }

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

    // Multi-line, not stacked: every model starts from zero on its own scale, so
    // the axis is driven by the single largest model value, not their sum.
    var maxV = 0;
    models.forEach(function (m) {
      (m[key] || []).forEach(function (v) { var n = Number(v) || 0; if (n > maxV) maxV = n; });
    });
    if (!(maxV > 0)) maxV = 1;
    var mag = Math.pow(10, Math.floor(Math.log10(maxV)));
    maxV = Math.ceil(maxV / (mag / 2)) * (mag / 2);

    function x(i) { return CHART.padL + (buckets.length === 1 ? plotW / 2 : (plotW * i) / (buckets.length - 1)); }
    function y(v) { return CHART.padT + plotH - (plotH * v) / maxV; }

    var parts = [];
    var defs = [];
    // Unique prefix per rendered chart — see chartSvg for why the gradient ids
    // cannot be shared across charts on one page.
    var uid = "c" + (chartUidCounter += 1) + "-";
    // Names are computed once for the whole set: uniqueness can only be judged
    // against the siblings being drawn.
    var labels = shortModelLabels(models.map(function (m) { return m.id; }));
    models.forEach(function (m, mi) {
      // One independent line per model, all from the zero baseline — never stacked.
      var pts = buckets.map(function (_, i) {
        return x(i) + "," + y(Number(m[key][i]) || 0);
      });
      // Eight validated slots; a ninth model folds into the same rotation, and
      // the table below carries identity for it regardless.
      var slot = (mi % 8) + 1;
      // A soft translucent area under each line (the "perspective"), fading to
      // near-invisible at the baseline so overlapping lines stay readable.
      defs.push('<linearGradient id="'+uid+'mg'+mi+'" x1="0" y1="0" x2="0" y2="1">' +
        '<stop class="s' + slot + '" offset="0%" stop-color="currentColor" stop-opacity="0.30"/>' +
        '<stop class="s' + slot + '" offset="100%" stop-color="currentColor" stop-opacity="0.02"/></linearGradient>');
      var areaPts = pts.concat([x(buckets.length - 1) + "," + y(0), x(0) + "," + y(0)]);
      parts.push('<polygon class="c-area s' + slot + '" points="' + areaPts.join(" ") +
        '" fill="url(#' + uid + 'mg' + mi + ')" />');
      parts.push('<polyline class="c-line s' + slot + '" points="' + pts.join(" ") +
        '" stroke="currentColor" fill="none" />');
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
        axisBucketLabel(buckets[i].at, step) + "</text>");
    });

    var hits = buckets.map(function (b, i) {
      var bw = plotW / Math.max(1, buckets.length - 1);
      return '<rect class="c-hit" x="' + (x(i) - bw / 2) + '" y="' + CHART.padT + '" width="' + bw +
        '" height="' + plotH + '" data-i="' + i + '" />';
    });

    var svg = '<svg class="chart" viewBox="0 0 ' + W + " " + H + '" preserveAspectRatio="none" role="img">' +
      "<defs>" + defs.join("") + "</defs>" + grid.join("") + parts.join("") + hits.join("") + xLabels.join("") + "</svg>";

    var legend = '<div class="legend">' + labels.map(function (name, mi) {
      var slot = (mi % 8) + 1;
      // Class, not an inline background:var(...): same reason as the marks,
      // and it keeps the swatch and the band on one definition of the color.
      return '<span class="lg"><i class="s' + slot + '"></i>' +
        escHtml(name) + "</span>";
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
      if ($("ovChartWrap")) {
        renderChartInto($("ovChartWrap"), $("ovChartHint"), data,
          $("ovChartMetric") ? $("ovChartMetric").value : "totalTokens");
      }
      renderModelChart(data, "modelChartWrap", "modelChartHint");
      renderModelChart(data, "ovModelChartWrap", "ovModelChartHint");
      renderTopModels(data);
      return data;
    }).catch(function (e) {
      [$("chartWrap"), $("ovChartWrap"), $("modelChartWrap"), $("ovModelChartWrap")].forEach(function (wrap) {
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
  function renderModelChart(data, wrapId, hintId) {
    var wrap = $(wrapId || "modelChartWrap");
    var hint = $(hintId || "modelChartHint");
    if (!wrap) return;
    var metric = hintId === "ovModelChartHint" ? "tokens"
      : ($("modelChartMetric") ? $("modelChartMetric").value : "tokens");
    clear(wrap);
    var built = chartSvgByModel(data, metric);
    if (!built) {
      wrap.appendChild(el("div", "muted sm", "窗口内没有带模型信息的用量记录。"));
      if (hint) hint.textContent = windowLabel() + " · 暂无数据";
      return;
    }
    if (hint) {
      hint.textContent = windowLabel() + " · " + built.models.length + " 个模型 · " +
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
          var swatch = el("i", "tip-sw s" + r.slot);
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
  /**
   * Top-models leaderboard for the overview's side column.
   *
   * Built from the same timeline payload the charts use, so the ranking can
   * never disagree with the bands above it. Bars are scaled against the
   * leader, which is the only comparison that reads at this size.
   */
  function renderTopModels(data) {
    var host = $("ovTopModels");
    if (!host) return;
    var models = (data.models || []).slice().sort(function (a, b) {
      return (Number(b.total) || 0) - (Number(a.total) || 0);
    }).slice(0, 8);
    clear(host);
    if (!models.length) {
      var empty = el("div", "muted sm", "窗口内没有用量记录。");
      empty.style.padding = "16px 18px";
      host.appendChild(empty);
      if ($("ovTopModelsHint")) $("ovTopModelsHint").textContent = windowLabel() + " · 暂无数据";
      return;
    }
    var top = Number(models[0].total) || 1;
    models.forEach(function (m, i) {
      var row = el("div", "rank-row");
      var nm = el("div", "nm");
      var name = String(m.id || "").split("/").pop();
      nm.appendChild(el("div", "t", name));
      var bar = el("div", "bar");
      var fill = el("i", "s" + ((i % 8) + 1));
      fill.style.width = Math.max(2, Math.round(100 * (Number(m.total) || 0) / top)) + "%";
      fill.style.background = "currentColor";
      bar.appendChild(fill);
      nm.appendChild(bar);
      row.appendChild(nm);
      var val = el("div", "val");
      val.appendChild(el("div", "n", fmtTok(m.total)));
      // requests is a per-bucket array on the timeline payload, so sum it here;
      // Number() on the array would be NaN and the count would read 0.
      var reqTotal = Array.isArray(m.requests)
        ? m.requests.reduce(function (s, n) { return s + (Number(n) || 0); }, 0)
        : (Number(m.requests) || 0);
      val.appendChild(el("div", "u", reqTotal.toLocaleString() + " 次"));
      row.appendChild(val);
      host.appendChild(row);
    });
    if ($("ovTopModelsHint")) {
      $("ovTopModelsHint").textContent = windowLabel() + " · 前 " + models.length + " 名";
    }
  }

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
      body.className = "card-body";
      body.appendChild(el("div", "muted sm", "窗口内没有带模型信息的用量记录。"));
      return;
    }
    body.className = "card-body tight";

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

  /* ---------- credits ---------- */
  /**
   * Per-account Cline Credits, and the pool's total.
   *
   * Paged and server-side like the usage tables: each row costs three upstream
   * calls (uid, balance, usages), so rendering every account would be hundreds
   * of requests on a pool this size. The server caches rows for five minutes
   * and shares that cache with the free-quota meters, so switching tabs does
   * not re-read upstream.
   *
   * The two numbers per account answer different questions and are deliberately
   * not summed together:
   *   - 余额 is what is left on the balance, a snapshot that can be negative;
   *   - 窗口消耗 is what this window drew from it, which is 0 for free-tier and
   *     Cline Pass traffic because those bill to the subscription instead.
   */
  var creditsPage = 1;
  var CREDITS_PAGE_SIZE = 25;

  function loadCredits(page, force) {
    creditsPage = page || creditsPage;
    var q = windowQuery("page=" + creditsPage + "&pageSize=" + CREDITS_PAGE_SIZE +
      (force ? "&refresh=1" : ""));
    return api("/admin/api/credits?" + q).then(function (data) {
      renderCredits(data);
      return data;
    }).catch(function (e) {
      var body = $("creditsBody");
      if (!body) return;
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "Credits 读取失败：" + e.message);
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
      $("creditsHint").textContent = "读取失败";
    });
  }

  function renderCredits(data) {
    var accounts = data.accounts || [];
    var body = $("creditsBody");
    var hint = $("creditsHint");
    clear(body);

    // The headline cards cover the whole pool, not this page: the server sums
    // every account whose cached row matches the window and reports how many
    // that was. Refreshed alongside the rows so the two never drift apart.
    loadCreditsSummary();

    if (!accounts.length) {
      var tr0 = el("tr");
      var td0 = el("td", "empty sm", "还没有账号。");
      td0.colSpan = 6;
      tr0.appendChild(td0);
      body.appendChild(tr0);
      renderPager($("creditsPager"), 1, 1, 0, CREDITS_PAGE_SIZE, function () {});
      if (hint) hint.textContent = windowLabel();
      return;
    }

    accounts.forEach(function (a) {
      var tr = el("tr");

      var td1 = el("td");
      td1.appendChild(el("div", null, a.email || a.id));
      if (a.disabled) td1.appendChild(el("div", "xs faint", "已停用"));
      if (a.error) td1.appendChild(el("div", "xs warn", summarize(a.error, 40)));
      tr.appendChild(td1);

      // Balance: the headline number for this table, so it carries the unit in
      // the heading and the sign in the cell.
      var td2 = el("td", "nowrap num");
      if (a.balanceMicroUsd === null || a.balanceMicroUsd === undefined) {
        td2.appendChild(el("span", "faint", "—"));
      } else {
        var neg = a.balanceMicroUsd < 0;
        td2.appendChild(el("div", neg ? "sm err" : "sm", fmtCredits(a.balanceMicroUsd)));
        if (neg) td2.appendChild(el("div", "xs faint", "已透支"));
      }
      tr.appendChild(td2);

      var td3 = el("td", "nowrap num sm");
      if (a.balanceUsd === null || a.balanceUsd === undefined) td3.appendChild(el("span", "faint", "—"));
      else td3.textContent = (a.balanceUsd < 0 ? "-$" : "$") + Math.abs(a.balanceUsd).toFixed(4);
      tr.appendChild(td3);

      // Spend over the window. Zero is a real answer here (free/Pass traffic),
      // so it is shown as 0.00 rather than dressed up as missing data.
      var td4 = el("td", "nowrap num sm");
      var used = a.window ? a.window.creditsMicroUsd : null;
      if (used === null || used === undefined) {
        td4.appendChild(el("span", "faint", "—"));
      } else if (used > 0) {
        td4.appendChild(el("div", "sm", fmtCredits(used, true)));
      } else {
        td4.appendChild(el("div", "faint", "0.00"));
      }
      tr.appendChild(td4);

      tr.appendChild(el("td", "nowrap num sm", a.window ? a.window.requests : 0));

      var td6 = el("td", "nowrap xs faint");
      if (a.lastUsage) {
        td6.appendChild(el("div", null, fmtAgo(a.lastUsage.at)));
        if (a.lastUsage.model) td6.appendChild(el("div", "xs faint mono", summarize(a.lastUsage.model, 34)));
      } else {
        td6.textContent = "窗口内无请求";
      }
      tr.appendChild(td6);

      body.appendChild(tr);
    });

    renderPager($("creditsPager"), data.page, data.totalPages, data.total, data.pageSize, function (p) {
      loadCredits(p);
    });
    if (hint) {
      hint.textContent = windowLabel() + " · 第 " + data.page + "/" + data.totalPages +
        " 页，共 " + data.total + " 个账号";
    }
  }

  /**
   * The pool-wide credit headline cards.
   *
   * Reads the same summary endpoint the overview uses. It is a rollup of the
   * server's row cache rather than a second source of truth, so it can cover
   * more accounts than the page on screen — the covered count says how many it
   * actually stands on, and the sweep that fills the rest is kicked off
   * server-side.
   */
  function loadCreditsSummary() {
    var q = windowQuery("");
    return api("/admin/api/credits/summary" + (q ? "?" + q : "")).then(function (data) {
      var t = data.totals || {};
      if (!$("crBalance")) return data;

      $("crBalance").textContent = t.balanceKnown ? fmtCredits(t.balanceMicroUsd) : "—";
      $("crBalanceHint").textContent = t.balanceKnown
        ? "已读到 " + t.balanceKnown + "/" + data.total + " 个账号"
        : "尚未读到余额";

      $("crUsed").textContent = t.creditsUsedKnown ? fmtCredits(t.creditsUsedMicroUsd, true) : "0.00";
      $("crUsedHint").textContent = t.creditsUsedKnown
        ? t.creditsUsedKnown + " 个账号在花余额；免费与订阅流量不计"
        : "本窗口没有账号消耗余额";

      // Positive vs overdrawn is the split that decides which accounts can
      // still serve paid models, so it gets its own card rather than being left
      // to be read off the sign in the table. With no balance read yet both are
      // zero rather than "—", because "no account is known to be overdrawn" is
      // the honest reading of an empty cache.
      $("crPositive").textContent = t.balanceKnown ? String(t.balancePositive || 0) : "—";
      $("crPositiveHint").textContent = t.balanceKnown
        ? "余额 > 0，共读到 " + t.balanceKnown + " 个" : "尚未读到余额";
      $("crNegative").textContent = t.balanceKnown ? String(t.balanceNegative || 0) : "—";
      $("crNegativeHint").textContent = t.balanceKnown
        ? "余额 ≤ 0，需充值" : "尚未读到余额";
      return data;
    }).catch(function () {
      if ($("crBalance")) $("crBalance").textContent = "—";
      return null;
    });
  }


  /**
   * Account entitlements, and the sweep that discovers them.
   *
   * Routing a cline-pass request needs to know which accounts hold Pass —
   * in a pool this size that is a handful out of thousands, so round-robin
   * would almost never land on one. The sweep reads each account's plan
   * upstream, which is a real call per account, so it is a button rather than
   * part of the page load. It runs server-side in the background, so this polls
   * instead of blocking on a job that takes minutes.
   */
  var capPoll = null;

  function loadCapabilities() {
    if (capPoll) { clearTimeout(capPoll); capPoll = null; }
    return api("/admin/api/capabilities").then(function (data) {
      var hint = $("capHint");
      if (!hint) return data;
      if (!data.known) {
        hint.textContent = "尚未扫描。cline-pass 模型目前按号池顺序尝试，" +
          "池中只有极少数账号持有 Cline Pass，因此大多会失败。点「扫描账号权限」建立索引。";
      } else {
        var bits = ["已读取 " + data.known + "/" + data.total + " 个账号",
          "其中 " + data.clinePass + " 个持有 Cline Pass"];
        if (data.sweeping) bits.push("扫描中…");
        else if (data.clinePass === 0) bits.push("无账号持有 Pass，cline-pass 模型不可用");
        if (data.known < data.total && !data.sweeping) bits.push("（未读到的账号仍按号池顺序尝试）");
        hint.textContent = bits.join(" · ");
      }
      if (data.sweeping) capPoll = setTimeout(function () { loadCapabilities().catch(function () {}); }, 4000);
      return data;
    }).catch(function (e) {
      if ($("capHint")) $("capHint").textContent = "权限读取失败：" + e.message;
      return null;
    });
  }

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
  /** Accounts the last response could draw a meter for. */
  var freeQuotaCovered = 0;
  /** Timer for the poll that runs while the server is filling the cache. */
  var freeQuotaPoll = null;
  /**
   * Load the table.
   *
   * "force" starts a pool-wide credits sweep on the server. The meters are
   * derived from the credits cache, which the usage page fills a page at a
   * time, so without a sweep a reload on a cold cache would just redraw the
   * same zeroes. The sweep is a background job, so the response carries the
   * current (possibly partial) picture plus "refreshing", and the caller polls
   * until it settles — which is why the button says 重新扫描全池 rather than
   * pretending the data is already fresh.
   */
  function loadFreeQuota(force) {
    if (freeQuotaPoll) { clearTimeout(freeQuotaPoll); freeQuotaPoll = null; }
    var q = windowQuery(force ? "refresh=1" : "");
    return api("/admin/api/free-quota" + (q ? "?" + q : "")).then(function (data) {
      freeQuotaRows = data.accounts || [];
      freeQuotaCovered = data.covered || 0;
      if (data.freeLimitPerModel) freeLimitPerModel = data.freeLimitPerModel;
      if (!$("freeProbeModel").value) $("freeProbeModel").value = data.probeModel || "";
      renderFreeQuota();
      // While the sweep runs, keep re-reading: each poll repaints however much
      // of the pool has landed. 4s is the same cadence the overview summary
      // uses for its own sweep.
      if (data.refreshing && $("view-quota").classList.contains("active")) {
        freeQuotaPoll = setTimeout(function () { loadFreeQuota(false).catch(function () {}); }, 4000);
      }
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
    // Single blue->red gradient; the fill slides across it so any width reads as
    // "how full" on the same scale. No class switching needed.
    var wrap = el("div", "quota");
    var q = el("div", "q");
    q.style.gridTemplateColumns = "1fr 44px";
    var bar = el("div", "bar");
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
      // Expandable: one tap reveals every free model on this account, fullest
      // first; tap again to collapse back to just the leader.
      var rest = models.slice(1);
      var toggle = el("button", "btn small ghost", "展开 ▾ (" + rest.length + ")");
      toggle.style.padding = "0 6px";
      toggle.style.fontSize = "11px";
      var detail = el("div");
      detail.style.display = "none";
      detail.style.marginTop = "6px";
      rest.forEach(function (m) {
        detail.appendChild(freeBucketMeter(m));
      });
      var open = false;
      toggle.onclick = function () {
        open = !open;
        detail.style.display = open ? "" : "none";
        toggle.textContent = open ? "收起 ▴" : ("展开 ▾ (" + rest.length + ")");
      };
      cell.appendChild(toggle);
      cell.appendChild(detail);
    }
    return cell;
  }

  function renderFreeQuota() {
    var body = $("freeQuotaBody");
    var hint = $("freeQuotaHint");
    if (hint) {
      var stale = freeQuotaRows.length - freeQuotaCovered;
      hint.textContent = windowLabel() + " · 占用度已统计 " + freeQuotaCovered + "/" + freeQuotaRows.length +
        (stale > 0 ? "，其余 " + stale + " 个本次窗口尚未取到（点上方按钮扫描）" : "");
    }
    clear(body);
    if (!freeQuotaRows.length) {
      var tr0 = el("tr");
      var td0 = el("td", "empty sm", "还没有账号。");
      td0.colSpan = 7;
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
    // Balance and spend are separate quantities: the first is what is left, a
    // snapshot; the second is what this window drew from it. Both are in
    // credits here because that is the unit Cline's own dashboard shows.
    if (t.balanceKnown) bits.push("合计余额 " + fmtCredits(t.balanceMicroUsd) + " credits");
    if (t.creditsUsedKnown) bits.push("本窗口消耗 " + fmtCredits(t.creditsUsedMicroUsd, true) + " credits");
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

  /** Pool summary: the headline counters and the hero band's 今日 Token. */
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

  /** Account quotas live on the accounts page now; overview keeps only the pool summary. */
  function loadUsage() { return renderPoolSummaryAsync(); }


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

  /* ---------- console (控制台) ---------- */
  /* A workbench around /admin/api/chat: several persisted sessions, a
     searchable model combo, a sampling panel, per-message actions, and a live
     stream with an abort switch. Sessions (and the panel defaults) live in
     localStorage under WB_KEY; everything else is per-tab.

     The page is one String.raw template, so a literal backtick cannot appear
     anywhere in this script — every Markdown fence marker is built from its
     code point instead. */
  var BT = String.fromCharCode(96);
  var RE_FENCE = new RegExp("^" + BT + "{3,}\\s*([\\w+#.\\-]*)\\s*$");
  var MD_INLINE_SRC = BT + "([^" + BT + "\\n]+)" + BT +
    "|\\*\\*([^*\\n]+)\\*\\*" +
    "|__([^_\\n]+)__" +
    "|\\*([^*\\n]+)\\*" +
    "|_([^_\\n]+)_" +
    "|\\[([^\\]\\n]*)\\]\\(([^)\\s]+)\\)" +
    "|(https?:\\/\\/[^\\s<>()]+)" +
    "|(\\n)";

  function wbNewId() {
    wbSeq += 1;
    return "s" + Date.now().toString(36) + wbSeq.toString(36);
  }
  function wbSession(id) {
    var sid = id || wbState.active;
    for (var i = 0; i < wbState.sessions.length; i++) {
      if (wbState.sessions[i].id === sid) return wbState.sessions[i];
    }
    return null;
  }
  function wbPersist() {
    try {
      localStorage.setItem(WB_KEY, JSON.stringify({
        model: wbState.model, stream: wbState.stream, paramsOpen: wbState.paramsOpen,
        active: wbState.active, sessions: wbState.sessions
      }));
    } catch (e) { /* private mode, or a full quota: session state is a nicety */ }
  }
  function setPlayState(text, kind) {
    var node = $("playState");
    node.className = kind ? "sm " + kind : "sm muted";
    node.textContent = text;
  }
  function wbTitle(text) {
    return summarize(String(text || "").replace(/[\r\n]+/g, " ").trim(), 34) || "新会话";
  }
  function wbTouch(s, content) {
    s.updatedAt = Date.now();
    if (content && (!s.title || s.title === "新会话")) s.title = wbTitle(content);
    wbPersist();
  }

  /* ---------- parameter panel ---------- */
  function readNum(id, fallback) {
    var raw = $(id).value.trim();
    if (!raw) return fallback;
    var n = Number(raw);
    return isFinite(n) ? n : fallback;
  }
  function wbSyncTempLabel() { $("playTempVal").textContent = Number($("playTemp").value).toFixed(2); }
  function wbReadParams() {
    var maxRaw = $("playMaxTokens").value.trim();
    var temp = readNum("playTemp", wbDefaults.temperature);
    return {
      system: $("playSystem").value,
      temperature: Math.max(0, Math.min(2, temp)),
      maxTokens: maxRaw ? Math.max(0, Math.floor(Number(maxRaw) || 0)) : null,
      history: Math.max(0, Math.floor(readNum("playHistory", 0)))
    };
  }
  function wbApplyParams(p) {
    var params = p || wbDefaults;
    $("playSystem").value = params.system || "";
    $("playTemp").value = String(params.temperature === undefined || params.temperature === null ? 1 : params.temperature);
    $("playMaxTokens").value = params.maxTokens === null || params.maxTokens === undefined ? "" : String(params.maxTokens);
    $("playHistory").value = String(params.history === undefined || params.history === null ? 0 : params.history);
    wbSyncTempLabel();
  }
  /** A session carries its own generation settings, so switching sessions does
      not silently re-sample with the previous one's parameters. */
  function wbSessionDefaults(s) {
    var src = s || {};
    return {
      model: src.model || "",
      stream: src.stream === undefined ? true : !!src.stream,
      system: src.system || "",
      temperature: src.temperature === undefined || src.temperature === null ? 1 : Number(src.temperature),
      maxTokens: src.maxTokens === undefined ? null : src.maxTokens,
      history: src.history === undefined || src.history === null ? 0 : Number(src.history)
    };
  }
  function wbSetSessionDefaults(s) {
    var p = wbReadParams();
    s.system = p.system;
    s.temperature = p.temperature;
    s.maxTokens = p.maxTokens;
    s.history = p.history;
    s.stream = $("playStream").checked;
  }

  /* ---------- session store ---------- */
  function wbNewSession() {
    var s = wbSessionDefaults({});
    s.id = wbNewId();
    s.title = "新会话";
    s.messages = [];
    s.createdAt = Date.now();
    s.updatedAt = s.createdAt;
    return s;
  }
  function wbLoadState() {
    var raw = null;
    try { raw = localStorage.getItem(WB_KEY); } catch (e) { raw = null; }
    var saved = null;
    if (raw) { try { saved = JSON.parse(raw); } catch (e) { saved = null; } }
    if (saved && Object.prototype.toString.call(saved.sessions) === "[object Array]") {
      saved.sessions.forEach(function (s) {
        if (!s || typeof s.id !== "string") return;
        var clean = wbSessionDefaults(s);
        clean.id = s.id;
        clean.title = typeof s.title === "string" && s.title ? s.title : "新会话";
        clean.messages = Object.prototype.toString.call(s.messages) === "[object Array]" ? s.messages : [];
        clean.createdAt = Number(s.createdAt) || Date.now();
        clean.updatedAt = Number(s.updatedAt) || clean.createdAt;
        wbState.sessions.push(clean);
      });
    }
    if (saved) {
      if (typeof saved.model === "string") wbState.model = saved.model;
      if (saved.stream !== undefined) wbState.stream = !!saved.stream;
      wbState.paramsOpen = !!saved.paramsOpen;
      if (typeof saved.active === "string") wbState.active = saved.active;
    }
    if (!wbState.sessions.length) wbState.sessions.push(wbNewSession());
    wbState.sessions.sort(function (a, b) { return b.updatedAt - a.updatedAt; });
    if (!wbSession(wbState.active)) wbState.active = wbState.sessions[0].id;
    var active = wbSession();
    if (!wbState.model && active && active.model) wbState.model = active.model;
    if (active && !active.model && wbState.model) active.model = wbState.model;
    $("playParams").hidden = !wbState.paramsOpen;
    $("playParamsToggle").classList.toggle("active", wbState.paramsOpen);
    $("playStream").checked = wbState.stream;
  }
  function wbOpenSession(id) {
    if (!id || id === wbState.active) return;
    var prev = wbSession();
    if (prev) wbSetSessionDefaults(prev);
    wbState.active = id;
    var s = wbSession();
    if (s) {
      var defaults = wbSessionDefaults(s);
      wbApplyParams(defaults);
      wbState.stream = defaults.stream;
      $("playStream").checked = defaults.stream;
      if (defaults.model) wbSetModel(defaults.model);
    }
    wbEditIndex = -1;
    renderSessions();
    renderChat();
    wbPersist();
    setPlayState("就绪 · 已切换到「" + (s ? s.title : "") + "」", "muted");
  }
  function wbCreateSession() {
    var prev = wbSession();
    if (prev) wbSetSessionDefaults(prev);
    var s = wbNewSession();
    s.model = wbState.model;
    wbState.sessions.unshift(s);
    wbState.active = s.id;
    wbEditIndex = -1;
    renderSessions();
    renderChat();
    wbPersist();
    $("playInput").focus();
    setPlayState("新会话", "muted");
  }
  function wbRemoveSession(id) {
    var s = wbSession(id);
    if (!s) return;
    if (s.messages.length && !confirm("删除会话「" + s.title + "」？其中 " + s.messages.length + " 条消息会一起删掉。")) return;
    wbState.sessions = wbState.sessions.filter(function (x) { return x.id !== id; });
    if (!wbState.sessions.length) wbState.sessions.push(wbNewSession());
    if (wbState.active === id) {
      wbState.active = wbState.sessions[0].id;
      var next = wbSession();
      if (next) {
        var defaults = wbSessionDefaults(next);
        wbApplyParams(defaults);
        wbState.stream = defaults.stream;
        $("playStream").checked = defaults.stream;
        if (defaults.model) wbSetModel(defaults.model);
      }
      renderChat();
    }
    renderSessions();
    wbPersist();
  }
  function wbStartRename(id) { wbRenameId = id; renderSessions(); }
  function wbCommitRename(id, value) {
    var s = wbSession(id);
    if (s) {
      s.title = summarize(String(value || "").trim(), 40) || s.title;
      s.updatedAt = Date.now();
    }
    wbRenameId = "";
    wbPersist();
    renderSessions();
  }
  function wbRenameKey(e, id) {
    if (e.key === "Enter") { e.preventDefault(); wbCommitRename(id, e.target.value); }
    else if (e.key === "Escape") { e.preventDefault(); wbRenameId = ""; renderSessions(); }
  }
  function renderSessions() {
    var box = $("playSessions");
    var query = wbQuery.trim().toLowerCase();
    clear(box);
    var list = wbState.sessions.filter(function (s) {
      if (!query) return true;
      return s.title.toLowerCase().indexOf(query) >= 0 || String(s.model || "").toLowerCase().indexOf(query) >= 0;
    });
    if (!list.length) box.appendChild(el("div", "muted sm", "没有匹配的会话。"));
    list.forEach(function (s) {
      var row = el("div", "sess" + (s.id === wbState.active ? " active" : ""));
      if (wbRenameId === s.id) {
        var input = el("input");
        input.type = "text";
        input.value = s.title;
        input.onkeydown = function (e) { wbRenameKey(e, s.id); };
        input.onblur = function () { if (wbRenameId === s.id) wbCommitRename(s.id, input.value); };
        row.appendChild(input);
        box.appendChild(row);
        setTimeout(function () { input.focus(); input.select(); }, 0);
        return;
      }
      var meta = el("div", "meta");
      meta.appendChild(el("div", "t", s.title));
      meta.appendChild(el("div", "s2", (s.model || "未选模型") + " · " + s.messages.length + " 条 · " + fmtAgo(s.updatedAt)));
      row.appendChild(meta);
      var acts = el("div", "acts");
      var rename = el("button", "ico-btn");
      rename.type = "button";
      rename.title = "重命名";
      rename.setAttribute("aria-label", "重命名");
      rename.appendChild(icon("M4 20h4L20 8l-4-4L4 16v4z", "2"));
      rename.onclick = function (e) { e.stopPropagation(); wbStartRename(s.id); };
      var del = el("button", "ico-btn");
      del.type = "button";
      del.title = "删除";
      del.setAttribute("aria-label", "删除");
      del.appendChild(icon("M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13", "2"));
      del.onclick = function (e) { e.stopPropagation(); wbRemoveSession(s.id); };
      acts.appendChild(rename);
      acts.appendChild(del);
      row.appendChild(acts);
      row.onclick = function () { wbOpenSession(s.id); };
      box.appendChild(row);
    });
  }

  /* ---------- model combo ---------- */
  function wbBucketOrder(b) { return b === "pass" ? 0 : (b === "free" ? 1 : 2); }
  function wbBucketShort(b) {
    for (var i = 0; i < wbBuckets.length; i++) if (wbBuckets[i].key === b) return wbBuckets[i].short;
    return "—";
  }
  function wbModelItem(id) {
    var found = null;
    catalog.forEach(function (m) { if (m.id === id) found = m; });
    return found;
  }
  function wbSetModel(id) {
    wbState.model = id || "";
    if (wbState.model) $("playModelFilter").value = wbState.model;
    var s = wbSession();
    if (s) { s.model = wbState.model; wbPersist(); }
    renderSessions();
  }
  function wbComboItems() {
    var q = $("playModelFilter").value.trim().toLowerCase();
    // The box holds the committed id between edits; showing only that one row
    // would make the list look empty right after a pick.
    if (q === wbState.model.toLowerCase()) q = "";
    return catalog.filter(function (m) {
      return !q || m.id.toLowerCase().indexOf(q) >= 0;
    }).sort(function (a, b) {
      return wbBucketOrder(a.bucket) - wbBucketOrder(b.bucket) || a.id.localeCompare(b.id);
    });
  }
  function wbScrollCombo() {
    var node = $("playModelList").querySelector(".combo-item.hi");
    if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
  }
  function renderCombo() {
    var list = wbComboItems();
    var head = $("playPopHead");
    var host = $("playModelList");
    clear(host);
    if (!catalog.length) {
      head.textContent = "模型目录读取中…";
      host.appendChild(el("div", "combo-empty", "模型列表还没读回来，稍候再试。"));
      return;
    }
    if (wbComboHi >= list.length) wbComboHi = list.length - 1;
    head.textContent = "共 " + list.length + " 个 · ↑↓ 选择 · Enter 确认";
    if (!list.length) {
      host.appendChild(el("div", "combo-empty", "没有匹配的模型。"));
      return;
    }
    var bucket = "";
    list.forEach(function (m, i) {
      if (m.bucket !== bucket) {
        bucket = m.bucket;
        host.appendChild(el("div", "combo-group", bucketLabel(m.bucket)));
      }
      var row = el("div", "combo-item" + (m.id === wbState.model ? " sel" : "") + (i === wbComboHi ? " hi" : ""));
      row.appendChild(el("span", null, m.id));
      row.appendChild(el("span", "b faint", wbBucketShort(m.bucket)));
      row.onmousedown = function (e) { e.preventDefault(); wbPickModel(m.id); };
      host.appendChild(row);
    });
  }
  function wbOpenCombo() {
    wbComboOpen = true;
    renderCombo();
    $("playPop").hidden = false;
  }
  function wbCloseCombo() {
    wbComboOpen = false;
    wbComboHi = -1;
    $("playPop").hidden = true;
  }
  function wbPickModel(id) {
    wbSetModel(id);
    wbCloseCombo();
    setPlayState("就绪 · " + id, "muted");
  }
  function wbComboKey(e) {
    var items = wbComboItems();
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!wbComboOpen) { wbOpenCombo(); return; }
      var step = e.key === "ArrowDown" ? 1 : -1;
      wbComboHi = Math.max(0, Math.min(items.length - 1, (wbComboHi < 0 ? (step > 0 ? -1 : 0) : wbComboHi) + step));
      renderCombo();
      wbScrollCombo();
      return;
    }
    if (e.key === "Enter" || e.key === "Tab") {
      if (!items.length) { wbCloseCombo(); return; }
      e.preventDefault();
      wbPickModel(items[wbComboHi >= 0 && items[wbComboHi] ? wbComboHi : 0].id);
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      if (wbComboOpen) { wbCloseCombo(); return; }
      $("playModelFilter").value = wbState.model;
    }
  }

  /* ---------- Markdown → DOM ---------- */
  /* Model output is untrusted text, so every node below is built with
     textContent; no HTML string is ever assembled from a response. */
  function mdSafeUrl(url) {
    var u = String(url || "").trim();
    return /^(https?:\/\/|mailto:|\/|#)/i.test(u) ? u : "";
  }
  function mdInline(text) {
    // A fresh regex per call: the recursive bold/italic case would otherwise
    // clobber the outer scan's lastIndex.
    var re = new RegExp(MD_INLINE_SRC, "g");
    var frag = document.createDocumentFragment();
    var src = String(text === undefined || text === null ? "" : text);
    var last = 0;
    var m;
    while ((m = re.exec(src))) {
      if (m.index > last) frag.appendChild(document.createTextNode(src.slice(last, m.index)));
      last = re.lastIndex;
      if (m[1] !== undefined) {
        frag.appendChild(el("code", "inline", m[1]));
      } else if (m[2] !== undefined || m[3] !== undefined) {
        var strong = el("strong");
        strong.appendChild(mdInline(m[2] !== undefined ? m[2] : m[3]));
        frag.appendChild(strong);
      } else if (m[4] !== undefined || m[5] !== undefined) {
        var em = el("em");
        em.appendChild(mdInline(m[4] !== undefined ? m[4] : m[5]));
        frag.appendChild(em);
      } else if (m[6] !== undefined) {
        var href = mdSafeUrl(m[7]);
        if (href) {
          var link = el("a", null, m[6]);
          link.href = href;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          frag.appendChild(link);
        } else {
          frag.appendChild(document.createTextNode(m[0]));
        }
      } else if (m[8] !== undefined) {
        var bare = mdSafeUrl(m[8]);
        if (bare) {
          var link2 = el("a", null, m[8]);
          link2.href = bare;
          link2.target = "_blank";
          link2.rel = "noopener noreferrer";
          frag.appendChild(link2);
        } else {
          frag.appendChild(document.createTextNode(m[0]));
        }
      } else if (m[9] !== undefined) {
        frag.appendChild(document.createElement("br"));
      }
    }
    if (last < src.length) frag.appendChild(document.createTextNode(src.slice(last)));
    return frag;
  }
  var HL_LANGS = ["js", "javascript", "ts", "typescript", "json", "py", "python", "bash", "sh",
    "shell", "sql", "go", "rust", "java", "c", "cpp", "tsx", "jsx"];
  function highlightCode(node, code, lang) {
    var key = String(lang || "").toLowerCase();
    if (!code || HL_LANGS.indexOf(key) < 0) { node.textContent = code; return; }
    // One master regex, tried left to right, keeps the scanner stateless: a
    // keyword inside a string is consumed as part of the string alternative.
    var re = new RegExp([
      "(\\/\\/[^\\n]*|#[^\\n]*|--[^\\n]*)",
      "(\"(?:\\\\.|[^\"\\\\])*\"|'(?:\\\\.|[^'\\\\])*')",
      "(" + BT + "(?:\\\\.|[^" + BT + "\\\\])*" + BT + ")",
      "(\\b\\d+(?:\\.\\d+)?\\b)",
      "(\\b(?:function|return|const|let|var|if|else|for|while|class|new|import|from|export|default|await|async|try|catch|throw|typeof|def|lambda|None|True|False|self|true|false|null|undefined|package|func|type|struct|interface|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|JOIN|GROUP|ORDER|BY|LIMIT)\\b)"
    ].join("|"), "g");
    var last = 0;
    var m;
    while ((m = re.exec(code))) {
      if (m.index > last) node.appendChild(document.createTextNode(code.slice(last, m.index)));
      last = re.lastIndex;
      var cls = m[1] !== undefined ? "c" : (m[2] !== undefined || m[3] !== undefined ? "s" : (m[4] !== undefined ? "n" : "k"));
      node.appendChild(el("span", "tok " + cls, m[0]));
    }
    if (last < code.length) node.appendChild(document.createTextNode(code.slice(last)));
  }
  function mdCode(lang, code) {
    var box = el("div", "codeblock");
    var head = el("div", "code-head");
    head.appendChild(el("span", null, lang || "code"));
    var btn = el("button", "ico-btn");
    btn.type = "button";
    btn.title = "复制代码";
    btn.setAttribute("aria-label", "复制代码");
    btn.appendChild(icon("M9 9V5h10v10h-4M5 9h10v10H5z", "2"));
    btn.onclick = function () { copy(code, "已复制代码"); };
    head.appendChild(btn);
    box.appendChild(head);
    var pre = el("pre");
    var codeEl = el("code");
    highlightCode(codeEl, code, lang);
    pre.appendChild(codeEl);
    box.appendChild(pre);
    return box;
  }
  function mdCells(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(function (c) { return c.trim(); });
  }
  function mdTable(rows) {
    var table = el("table", "md");
    var header = mdCells(rows[0]);
    var rest = rows.slice(1);
    if (rest.length && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(rest[0])) rest = rest.slice(1);
    var thead = el("thead");
    var htr = el("tr");
    header.forEach(function (c) {
      var th = el("th");
      th.appendChild(mdInline(c));
      htr.appendChild(th);
    });
    thead.appendChild(htr);
    table.appendChild(thead);
    var tbody = el("tbody");
    rest.forEach(function (r) {
      var tr = el("tr");
      mdCells(r).forEach(function (c) {
        var td = el("td");
        td.appendChild(mdInline(c));
        tr.appendChild(td);
      });
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    return table;
  }
  function renderMarkdown(text) {
    var frag = document.createDocumentFragment();
    var lines = String(text === undefined || text === null ? "" : text).replace(/\r\n?/g, "\n").split("\n");
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      var fence = RE_FENCE.exec(line);
      if (fence) {
        var body = [];
        i += 1;
        while (i < lines.length && !RE_FENCE.exec(lines[i])) { body.push(lines[i]); i += 1; }
        if (i < lines.length) i += 1;
        frag.appendChild(mdCode(fence[1] || "", body.join("\n")));
        continue;
      }
      if (!line.trim()) { i += 1; continue; }
      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) { frag.appendChild(el("hr")); i += 1; continue; }
      var heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading) { frag.appendChild(el("h3", null, heading[2])); i += 1; continue; }
      if (/^\s*>/.test(line)) {
        var quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) { quote.push(lines[i].replace(/^\s*>\s?/, "")); i += 1; }
        var bq = el("blockquote");
        bq.appendChild(mdInline(quote.join(" ")));
        frag.appendChild(bq);
        continue;
      }
      if (/^\s*\|.*\|\s*$/.test(line)) {
        var rows = [];
        while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) { rows.push(lines[i]); i += 1; }
        frag.appendChild(mdTable(rows));
        continue;
      }
      if (/^\s*([-*+]|\d+[.)])\s+/.test(line)) {
        var list = el(/^\s*\d+[.)]\s+/.test(line) ? "ol" : "ul");
        while (i < lines.length && lines[i].trim() && /^\s*([-*+]|\d+[.)])\s+/.test(lines[i])) {
          list.appendChild(el("li", null, mdInline(lines[i].replace(/^\s*([-*+]|\d+[.)])\s+/, ""))));
          i += 1;
        }
        frag.appendChild(list);
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !RE_FENCE.exec(lines[i]) &&
             !/^\s*(#{1,6}\s|>|\||([-*+]|\d+[.)])\s)/.test(lines[i])) {
        para.push(lines[i]);
        i += 1;
      }
      if (!para.length) { para.push(line); i += 1; }
      var p = el("p");
      p.appendChild(mdInline(para.join("\n")));
      frag.appendChild(p);
    }
    return frag;
  }

  /* ---------- transcript ---------- */
  function msgMeta(m) {
    var bits = [];
    if (m.meta) bits.push(m.meta);
    if (m.usage) {
      var u = m.usage;
      if (u.total_tokens !== undefined && u.total_tokens !== null) {
        bits.push("↑" + fmtTok(u.prompt_tokens) + " ↓" + fmtTok(u.completion_tokens) + " = " + fmtTok(u.total_tokens) + " tokens");
      }
      if (u.cached_tokens) bits.push("缓存 " + fmtTok(u.cached_tokens));
      if (u.cost !== undefined && u.cost !== null) bits.push("cost " + u.cost);
    } else if (m.role === "assistant" && m.content && !m.error) {
      bits.push("≈" + fmtTok(estimateTokens(m.content)) + " tokens（估算）");
    }
    return bits.join(" · ");
  }
  function msgBtn(title, path, onclick) {
    var b = el("button", "ico-btn");
    b.type = "button";
    b.title = title;
    b.setAttribute("aria-label", title);
    b.appendChild(icon(path, "2"));
    b.onclick = onclick;
    return b;
  }
  function msgTools(m, index) {
    var tools = el("div", "msg-tools");
    if (m.role === "user") {
      tools.appendChild(msgBtn("编辑后重新发送", "M4 20h4L20 8l-4-4L4 16v4z", function () { wbStartEdit(index); }));
    } else {
      tools.appendChild(msgBtn("重新生成", "M20 11a8 8 0 10-2.3 5.7M20 5v6h-6", function () { wbRegenerate(index); }));
      tools.appendChild(msgBtn("编辑内容", "M4 20h4L20 8l-4-4L4 16v4z", function () { wbStartEdit(index); }));
    }
    tools.appendChild(msgBtn("复制", "M9 9V5h10v10h-4M5 9h10v10H5z", function () { copy(m.content, "已复制"); }));
    tools.appendChild(msgBtn("删除这条消息", "M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13", function () { wbDeleteMessage(index); }));
    return tools;
  }
  function editBox(m, index) {
    var box = el("div", "msg-edit");
    var area = el("textarea");
    area.value = m.content;
    area.onkeydown = function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); wbSaveEdit(index, area.value); }
      else if (e.key === "Escape") { e.preventDefault(); wbEditIndex = -1; renderChat(); }
    };
    box.appendChild(area);
    var row = el("div", "row");
    var save = el("button", "btn small primary", m.role === "user" ? "保存并重新发送" : "保存修改");
    save.type = "button";
    save.onclick = function () { wbSaveEdit(index, area.value); };
    var cancel = el("button", "btn small", "取消");
    cancel.type = "button";
    cancel.onclick = function () { wbEditIndex = -1; renderChat(); };
    row.appendChild(save);
    row.appendChild(cancel);
    box.appendChild(row);
    setTimeout(function () { area.focus(); }, 0);
    return box;
  }
  function renderMessage(m, index) {
    var wrap = el("div", "msg " + (m.role === "user" ? "user" : "assistant"));
    wrap.appendChild(el("div", "avatar", m.role === "user" ? "我" : "AI"));
    var bubble = el("div", "bubble");
    var role = el("div", "role");
    role.appendChild(el("span", null, m.role === "user" ? "你" : (m.model ? "模型 · " + m.model : "模型")));
    if (m.role === "user" && m.edited) role.appendChild(el("span", "faint", "已编辑"));
    if (m.role === "assistant" && m.error) role.appendChild(el("span", "badge err", "错误"));
    if (m.role === "assistant" && m.aborted) role.appendChild(el("span", "badge warn", "已中断"));
    if (wbLiveIndex === index) role.appendChild(el("span", "badge warn", "生成中"));
    bubble.appendChild(role);
    if (wbEditIndex === index) {
      bubble.appendChild(editBox(m, index));
    } else {
      var body = el("div", "body");
      if (m.role === "assistant" && !m.error) {
        body.className = "body md";
        body.appendChild(renderMarkdown(m.content));
      } else {
        if (m.error) body.className = "body err";
        body.textContent = m.content;
      }
      if (wbLiveIndex === index) {
        body.appendChild(el("span", "caret"));
        wbLiveBody = body;
      }
      bubble.appendChild(body);
    }
    var meta = msgMeta(m);
    if (meta) bubble.appendChild(el("div", "msg-meta", meta));
    bubble.appendChild(msgTools(m, index));
    wrap.appendChild(bubble);
    return wrap;
  }
  function wbWelcome() {
    var box = el("div", "welcome");
    box.appendChild(el("div", "w-title", "开始一个新对话"));
    var s = wbSession();
    box.appendChild(el("div", "w-sub", (s && s.model ? "当前模型 " + s.model + " · " : "") +
      "支持 Markdown 渲染、逐条重发、参数覆盖与会话持久化；每条消息都可编辑、重新生成或删除。"));
    var chips = el("div", "w-chips");
    [
      "用三句话说明你是谁、由哪个模型驱动。",
      "用 TypeScript 写一个带指数退避重试的 fetch 封装，并解释每一处。",
      "把这段 JSON 整理成一张 Markdown 表格：{'a': 1, 'b': [2, 3]}",
      "解释什么是缓存命中率，以及它在计费上的意义。"
    ].forEach(function (text) {
      var b = el("button", "btn small", text);
      b.type = "button";
      b.onclick = function () {
        $("playInput").value = text;
        wbAutoGrow();
        $("playInput").focus();
      };
      chips.appendChild(b);
    });
    box.appendChild(chips);
    return box;
  }
  function renderChat() {
    var box = $("chat");
    var s = wbSession();
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 72;
    clear(box);
    var messages = s ? s.messages : [];
    if (!messages.length) {
      box.appendChild(wbWelcome());
    } else {
      messages.forEach(function (m, index) { box.appendChild(renderMessage(m, index)); });
    }
    if (atBottom || wbLiveIndex >= 0) box.scrollTop = box.scrollHeight;
    wbSyncComposer();
  }
  /** Per-chunk patch of just the streaming bubble: rebuilding the whole
      transcript on every delta is what makes a long answer stutter. */
  function wbPatchLive() {
    var s = wbSession();
    var index = wbLiveIndex;
    var m = s && index >= 0 ? s.messages[index] : null;
    if (!m || !wbLiveBody || m.error) { renderChat(); return; }
    var box = $("chat");
    var atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 72;
    clear(wbLiveBody);
    wbLiveBody.className = "body md";
    wbLiveBody.appendChild(renderMarkdown(m.content));
    wbLiveBody.appendChild(el("span", "caret"));
    if (atBottom) box.scrollTop = box.scrollHeight;
    wbSyncComposer();
  }
  function wbAutoGrow() {
    var area = $("playInput");
    area.style.height = "auto";
    area.style.height = Math.min(220, Math.max(58, area.scrollHeight)) + "px";
  }
  function wbSyncComposer() {
    var busy = !!wbRun;
    $("playSend").hidden = busy;
    $("playStop").hidden = !busy;
    $("playStream").disabled = busy;
    $("wb").classList.toggle("busy", busy);
    var s = wbSession();
    if (!s || !s.messages.length) {
      $("playCount").textContent = "";
      return;
    }
    var tokens = s.messages.reduce(function (n, m) { return n + estimateTokens(m.content); }, 0);
    $("playCount").textContent = s.messages.length + " 条消息 · ≈" + fmtTok(tokens) + " tokens";
  }

  /* ---------- message operations ---------- */
  function wbStartEdit(index) {
    var s = wbSession();
    if (!s || !s.messages[index]) return;
    wbEditIndex = index;
    renderChat();
  }
  function wbSaveEdit(index, value) {
    var s = wbSession();
    if (!s || !s.messages[index]) return;
    var text = String(value || "").trim();
    if (!text) { toast("内容不能为空", "err"); return; }
    var msg = s.messages[index];
    wbEditIndex = -1;
    if (msg.role === "user") {
      s.messages[index] = { role: "user", content: text, edited: true };
      // Everything after an edited prompt was generated from the old one.
      s.messages = s.messages.slice(0, index + 1);
      wbTouch(s, text);
      renderSessions();
      renderChat();
      wbSend();
      return;
    }
    msg.content = text;
    msg.error = false;
    msg.aborted = false;
    msg.meta = "";
    msg.usage = null;
    wbTouch(s);
    renderChat();
  }
  function wbDeleteMessage(index) {
    var s = wbSession();
    if (!s || !s.messages[index]) return;
    s.messages.splice(index, 1);
    wbTouch(s);
    renderChat();
  }
  function wbRegenerate(index) {
    var s = wbSession();
    if (!s || !s.messages[index] || s.messages[index].role !== "assistant") return;
    if (wbRun) { toast("上一个请求还在生成中", "err"); return; }
    s.messages = s.messages.slice(0, index);
    wbTouch(s);
    renderChat();
    wbSend();
  }
  function wbClearMessages() {
    var s = wbSession();
    if (!s) return;
    if (!s.messages.length) { toast("当前会话已经是空的"); return; }
    if (!confirm("清空当前会话的 " + s.messages.length + " 条消息？")) return;
    s.messages = [];
    s.title = "新会话";
    wbTouch(s);
    renderSessions();
    renderChat();
    setPlayState("已清空", "muted");
  }

  /* ---------- request ---------- */
  function wbBuildMessages(s, params) {
    var history = s.messages.map(function (m) { return { role: m.role, content: m.content }; });
    if (params.history > 0 && history.length > params.history) history = history.slice(history.length - params.history);
    var out = [];
    if (params.system.trim()) out.push({ role: "system", content: params.system });
    return out.concat(history);
  }
  function wbSubmitPrompt() {
    var s = wbSession();
    if (!s) return;
    if (wbRun) { toast("上一个请求还在生成中", "err"); return; }
    var text = $("playInput").value.trim();
    if (!text) { toast("先输入提示词", "err"); $("playInput").focus(); return; }
    if (!wbState.model && !$("playModelFilter").value.trim()) {
      toast("先选一个模型", "err");
      $("playModelFilter").focus();
      return;
    }
    s.messages.push({ role: "user", content: text });
    $("playInput").value = "";
    wbAutoGrow();
    wbTouch(s, text);
    renderSessions();
    renderChat();
    wbSend();
  }
  /** Rebound by the in-flight run: abort settles the answer immediately. */
  var wbAbort = function () {};
  function wbSend() {
    var s = wbSession();
    if (!s) return;
    if (wbRun) { toast("上一个请求还在生成中", "err"); return; }
    wbAbort = function () {};
    var model = wbState.model || $("playModelFilter").value.trim();
    var last = s.messages[s.messages.length - 1];
    if (!model) { toast("先选一个模型", "err"); $("playModelFilter").focus(); return; }
    if (!last || last.role !== "user") { toast("先输入提示词", "err"); return; }

    wbState.model = model;
    s.model = model;
    wbSetSessionDefaults(s);

    var wantStream = $("playStream").checked;
    var params = wbReadParams();
    var body = { model: model, messages: wbBuildMessages(s, params), stream: wantStream };
    // Only override the upstream defaults when the panel actually asks for
    // something non-default: several models 400 on a temperature they ignore.
    if (params.temperature !== wbDefaults.temperature) body.temperature = params.temperature;
    if (params.maxTokens) body.max_tokens = params.maxTokens;

    var index = s.messages.length;
    var answer = { role: "assistant", content: "", model: model, meta: "", error: false, aborted: false, usage: null };
    s.messages.push(answer);
    wbTouch(s);

    var ctrl = new AbortController();
    var finished = false;
    wbRun = ctrl;
    wbLiveIndex = index;
    wbLiveBody = null;
    var started = Date.now();
    var firstChunk = 0;
    renderChat();
    setPlayState("请求中…", "muted");

    var headers = { "Content-Type": "application/json" };

    function finish(aborted) {
      if (finished) return;
      finished = true;
      var elapsed = (Date.now() - started) / 1000;
      var bits = [];
      if (firstChunk) {
        bits.push("首字 " + ((firstChunk - started) / 1000).toFixed(2) + "s");
        if (answer.content.length && elapsed > 0.2) bits.push((answer.content.length / elapsed).toFixed(0) + " 字/秒");
      }
      bits.push("总 " + elapsed.toFixed(2) + "s");
      if (aborted) {
        answer.aborted = true;
        if (!answer.content) answer.content = "(已停止)";
        answer.meta = "已中断 · " + elapsed.toFixed(2) + "s";
        setPlayState("已中断 · " + model, "muted");
      } else {
        answer.meta = bits.join(" · ");
        setPlayState((answer.error ? "出错" : "完成") + " · " + model + " · " + bits.join(" · "), answer.error ? "err" : "ok");
      }
      wbTouch(s);
      wbRun = null;
      wbLiveIndex = -1;
      wbLiveBody = null;
      renderChat();
      renderSessions();
    }
    /** Abort settles the UI immediately: a transport can take a while to
        notice, and the run must never outlive the click that stopped it. */
    function abortRun() { finish(true); ctrl.abort(); }
    wbAbort = abortRun;

    function consume(line) {
      var trimmed = line.trim();
      if (trimmed.indexOf("data:") !== 0) return;
      var payload = trimmed.slice(5).trim();
      if (!payload || payload === "[DONE]") return;
      var evt = null;
      try { evt = JSON.parse(payload); } catch (err) { return; }
      if (evt.usage) answer.usage = evt.usage;
      if (evt.error) {
        answer.error = true;
        answer.content += (answer.content ? "\n" : "") +
          summarize(typeof evt.error === "string" ? evt.error : (evt.error.message || "上游错误"), 300);
        renderChat();
        return;
      }
      var choice = evt.choices && evt.choices[0];
      var delta = choice && choice.delta ? choice.delta : null;
      var piece = delta && typeof delta.content === "string" ? delta.content : "";
      if (piece) {
        if (!firstChunk) firstChunk = Date.now();
        answer.content += piece;
        wbPatchLive();
      }
    }

    fetch("/admin/api/chat", {
      method: "POST",
      credentials: "same-origin",
      headers: headers,
      signal: ctrl.signal,
      body: JSON.stringify(body)
    }).then(function (res) {
      if (!res.ok) return res.text().then(function (t) { throw new Error(t || ("HTTP " + res.status)); });
      if (!wantStream) {
        return res.json().then(function (data) {
          var choice = data && data.choices && data.choices[0];
          var content = choice && choice.message ? choice.message.content : "";
          answer.content = typeof content === "string" ? content : (content ? JSON.stringify(content) : "");
          if (data && data.usage) answer.usage = data.usage;
          if (!answer.content) answer.content = "(空响应)";
        });
      }
      var reader = res.body.getReader();
      var decoder = new TextDecoder();
      var buffer = "";
      function pump() {
        return reader.read().then(function (chunk) {
          if (chunk.done) {
            if (buffer.trim()) consume(buffer);
            return null;
          }
          buffer += decoder.decode(chunk.value, { stream: true });
          var lines = buffer.split("\n");
          buffer = lines.pop() || "";
          lines.forEach(consume);
          return pump();
        });
      }
      return pump();
    }).then(function () {
      if (finished) return;
      finish(false);
    }).catch(function (e) {
      if (finished) return;
      if (ctrl.signal.aborted) { finish(true); return; }
      var message = e && e.message ? e.message : String(e);
      // Streamed text is kept as a partial answer; only an empty turn becomes
      // an error bubble, so no output is ever thrown away.
      if (!answer.content) {
        answer.error = true;
        answer.content = message;
      }
      answer.meta = "总 " + ((Date.now() - started) / 1000).toFixed(2) + "s";
      setPlayState("失败：" + summarize(message, 120), "err");
      wbTouch(s);
      wbRun = null;
      wbLiveIndex = -1;
      wbLiveBody = null;
      renderChat();
      renderSessions();
    });
  }

  /* ---------- console wiring ---------- */
  function wbAfterCatalog() {
    if (!wbModelItem(wbState.model)) {
      var preferred = null;
      for (var i = 0; i < catalog.length; i++) {
        if (catalog[i].bucket === "pass") { preferred = catalog[i]; break; }
      }
      var next = preferred || catalog[0];
      if (next) wbSetModel(next.id);
      else if (wbState.model) $("playModelFilter").value = wbState.model;
    }
    var s = wbSession();
    if (s && !s.model) { s.model = wbState.model; wbPersist(); renderSessions(); }
    if (wbComboOpen) renderCombo();
  }
  function loadPlayModels(force) {
    if (catalog.length && !force) { wbAfterCatalog(); return; }
    api("/admin/api/models").then(function (data) {
      catalog = data.models;
      renderChips(data.counts);
      wbAfterCatalog();
    }).catch(function (e) { toast("模型列表读取失败：" + e.message, "err"); });
  }
  function wbInit() {
    wbLoadState();
    var s = wbSession();
    wbApplyParams(wbSessionDefaults(s));
    if (wbState.model) $("playModelFilter").value = wbState.model;
    wbBindConsole();
    renderSessions();
    renderChat();
  }
  function wbBindConsole() {
    $("playNew").onclick = wbCreateSession;
    $("playClear").onclick = wbClearMessages;
    $("playSessionSearch").oninput = function () { wbQuery = this.value; renderSessions(); };
    $("playSend").onclick = wbSubmitPrompt;
    // Indirection on purpose: wbAbort is rebound by each run, and the handler
    // is installed once at boot.
    $("playStop").onclick = function () { wbAbort(); };
    $("playInput").addEventListener("keydown", function (e) {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); wbSubmitPrompt(); }
    });
    $("playInput").addEventListener("input", wbAutoGrow);
    $("playStream").onchange = function () {
      wbState.stream = this.checked;
      var s = wbSession();
      if (s) s.stream = this.checked;
      wbPersist();
    };
    $("playParamsToggle").onclick = function () {
      wbState.paramsOpen = !wbState.paramsOpen;
      $("playParams").hidden = !wbState.paramsOpen;
      this.classList.toggle("active", wbState.paramsOpen);
      wbPersist();
    };
    $("playParamsReset").onclick = function () { wbApplyParams(wbDefaults); toast("参数已恢复默认", "ok"); };
    $("playTemp").oninput = wbSyncTempLabel;
    $("playSystem").addEventListener("keydown", function (e) {
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); $("playInput").focus(); }
    });

    var filter = $("playModelFilter");
    filter.addEventListener("focus", function () { filter.select(); wbOpenCombo(); });
    filter.addEventListener("input", function () { wbComboHi = -1; wbOpenCombo(); });
    filter.addEventListener("keydown", wbComboKey);
    filter.addEventListener("blur", function () {
      setTimeout(function () {
        if ($("playCombo").contains(document.activeElement)) return;
        wbCloseCombo();
        if (filter.value.trim() !== wbState.model && !wbModelItem(filter.value.trim())) filter.value = wbState.model;
      }, 0);
    });
    $("playComboToggle").onclick = function (e) {
      e.stopPropagation();
      if (wbComboOpen) { wbCloseCombo(); return; }
      filter.focus();
      wbOpenCombo();
    };
    document.addEventListener("click", function (e) {
      if (wbComboOpen && !$("playCombo").contains(e.target)) wbCloseCombo();
    });
  }

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
    // No limit: the account row dropdown is built from every proxy, and the
    // list view pages separately through loadProxyView.
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
  var proxyPage = 1;
  var proxyPageSize = 50;
  var proxySearch = "";
  var proxyTotal = 0;
  var proxyMode = "sticky";

  var PROXY_MODE_LABEL = {
    pinned: "按账号绑定",
    sticky: "粘性（用坏再换）",
    rotate: "每条请求轮换"
  };

  function loadProxyView() {
    var qs = "?limit=" + proxyPageSize + "&offset=" + ((proxyPage - 1) * proxyPageSize) +
      (proxySearch ? "&q=" + encodeURIComponent(proxySearch) : "");
    return api("/admin/api/proxies" + qs).then(function (data) {
      var list = data.proxies || [];
      proxyTotal = data.total || 0;
      proxyMode = data.mode || "pinned";
      // Deliberately not merged into proxiesById: this is one page of a
      // paginated list, while the account-row dropdown is built from the whole
      // pool. Mixing the two would leave that dropdown showing only the rows
      // the list happened to be paging through. loadProxies() owns that cache
      // and always refills it from the full set.

      var modeSel = $("proxyModeSelect");
      if (modeSel) modeSel.value = proxyMode;
      var stats = $("proxyRotationStats");
      if (stats) {
        stats.textContent = "当前策略：" + (PROXY_MODE_LABEL[proxyMode] || proxyMode) +
          "　已启用 " + (data.enabledTotal || 0) + " 条 / 共 " + proxyTotal + " 条";
      }
      var hint = $("proxyListHint");
      if (hint) {
        hint.textContent = proxySearch
          ? ("匹配 " + proxyTotal + " 条")
          : ("共 " + proxyTotal + " 条");
      }

      var body = $("proxiesBody");
      clear(body);
      if (!list.length) {
        var tr = el("tr");
        var td = el("td", "empty sm", proxySearch
          ? "没有匹配的代理。"
          : "还没有配置代理。所有账号直连上游。");
        td.colSpan = 6;
        tr.appendChild(td);
        body.appendChild(tr);
      } else {
        list.forEach(function (p) { body.appendChild(proxyRow(p)); });
      }

      var pages = Math.max(1, Math.ceil(proxyTotal / proxyPageSize));
      if (proxyPage > pages) proxyPage = pages;
      var info = $("proxyPageInfo");
      if (info) {
        info.textContent = proxyTotal === 0
          ? "—"
          : ("第 " + proxyPage + " / " + pages + " 页　·　第 " +
             ((proxyPage - 1) * proxyPageSize + 1) + "–" +
             Math.min(proxyPage * proxyPageSize, proxyTotal) + " 条");
      }
      $("proxyPrev").disabled = proxyPage <= 1;
      $("proxyNext").disabled = proxyPage >= pages;
      return list;
    }).catch(function (e) {
      var body = $("proxiesBody");
      clear(body);
      var tr = el("tr");
      var td = el("td", "empty err sm", "代理读取失败：" + e.message);
      td.colSpan = 6;
      tr.appendChild(td);
      body.appendChild(tr);
    });
  }

  function proxyRow(p) {
    var tr = el("tr");
    // Read back by the batch probe, so it never has to track page state twice.
    tr.setAttribute("data-proxy-id", p.id);

    var td1 = el("td");
    td1.appendChild(el("div", null, p.label || "(无备注)"));
    td1.appendChild(el("div", "xs faint mono", p.url));
    if (p.lastError) td1.appendChild(el("div", "xs err", "最近错误：" + summarize(p.lastError, 70)));
    tr.appendChild(td1);

    // Tier 0 carries normal traffic; higher tiers only wake up once every
    // lower tier is cooling off, so the number is the pool's failover order.
    var tdPrio = el("td", "nowrap sm mono");
    var prio = typeof p.priority === "number" ? p.priority : 0;
    tdPrio.textContent = prio === 0 ? "0（主）" : String(prio);
    if (prio > 0) tdPrio.className = "nowrap sm mono faint";
    tr.appendChild(tdPrio);

    // Exit IP is measured on demand, not inferred from the URL: a rotating
    // pool hands out many backends behind one host, so the host is not the exit.
    var tdIp = el("td", "nowrap mono sm");
    if (p.exitIp) {
      tdIp.textContent = p.exitIp;
      if (p.exitIpCheckedAt) {
        tdIp.appendChild(el("div", "xs faint", fmtAgo(p.exitIpCheckedAt)));
      }
    } else {
      tdIp.appendChild(el("span", "xs faint", "未探测"));
    }
    tr.appendChild(tdIp);

    var td2 = el("td", "nowrap");
    td2.appendChild(el("span", "badge " + (p.enabled ? "pass" : "warn"), p.enabled ? "启用" : "停用"));
    tr.appendChild(td2);

    var td3 = el("td", "nowrap sm num", p.usedBy > 0 ? (p.usedBy + " 个账号") : "未使用");
    tr.appendChild(td3);

    var td4 = el("td", "nowrap");
    var probe = el("button", "btn small", "探测");
    probe.onclick = function () {
      probe.disabled = true;
      probe.textContent = "探测中…";
      jsonApi("/admin/api/proxies/" + encodeURIComponent(p.id) + "/probe", {}, "POST")
        .then(function (r) {
          toast(r.ok ? ("出口 IP：" + r.exitIp + "（" + r.latencyMs + "ms）") : ("探测失败：" + r.error), r.ok ? "ok" : "err");
          loadProxyView();
        })
        .catch(function (e) {
          toast("探测失败：" + e.message, "err");
          probe.disabled = false;
          probe.textContent = "探测";
        });
    };
    // Real gated-model check through this proxy: the exit-IP probe only proves
    // reachability, this fires an actual free chat request so the Cline
    // product-surface gate is exercised.
    var probeCline = el("button", "btn small", "测Cline");
    probeCline.onclick = function () {
      probeCline.disabled = true;
      probeCline.textContent = "测Cline…";
      jsonApi("/admin/api/proxies/" + encodeURIComponent(p.id) + "/probe-cline", {}, "POST")
        .then(function (r) {
          if (r.ok) {
            toast("Cline 可用：" + (r.status || 200) + "（" + (r.latencyMs || 0) + "ms）", "ok");
          } else {
            var detail = r.detail ? (" · " + summarize(r.detail, 50)) : "";
            toast("Cline 失败：" + (r.status ? ("HTTP " + r.status) : (r.error || "未知")) + detail, "err");
          }
          loadProxyView();
        })
        .catch(function (e) {
          toast("测 Cline 失败：" + e.message, "err");
          probeCline.disabled = false;
          probeCline.textContent = "测Cline";
        });
    };
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
    [probe, probeCline, toggle, del].forEach(function (b) { b.style.marginRight = "5px"; td4.appendChild(b); });
    tr.appendChild(td4);
    return tr;
  }

  /**
   * Probe the exit address of every enabled proxy on the current page.
   *
   * Sequential and capped server-side: each probe opens a connection through a
   * third party, so a full-pool sweep would be a burst of traffic at the
   * provider for what is only a display value.
   */
  function probeProxiesOnPage() {
    var btn = $("proxyProbeBtn");
    var ids = loadProxyViewIds();
    if (!ids.length) { toast("本页没有待探测的代理", "err"); return; }
    btn.disabled = true;
    btn.textContent = "探测中…";
    jsonApi("/admin/api/proxies/probe-batch", { ids: ids, limit: ids.length }, "POST")
      .then(function (r) {
        toast("已探测 " + r.probed + " 条，成功 " + r.ok + " 条" + (r.remaining ? ("，剩余未探测 " + r.remaining) : ""), "ok");
        btn.disabled = false;
        btn.textContent = "探测出口 IP（本页）";
        loadProxyView();
      })
      .catch(function (e) {
        toast("批量探测失败：" + e.message, "err");
        btn.disabled = false;
        btn.textContent = "探测出口 IP（本页）";
      });
  }

  /** Ids currently rendered, read back from the rows so paging stays the source of truth. */
  function loadProxyViewIds() {
    var ids = [];
    var rows = $("proxiesBody").querySelectorAll("tr");
    for (var i = 0; i < rows.length; i++) {
      var id = rows[i].getAttribute("data-proxy-id");
      if (id) ids.push(id);
    }
    return ids;
  }

  function submitProxy() {
    var err = $("proxyError");
    err.style.display = "none";
    var raw = $("proxyUrl").value.trim();
    if (!raw) {
      err.textContent = "请填写代理地址";
      err.style.display = "block";
      return;
    }
    var lines = raw.split(/\n+/).map(function (l) { return l.trim(); }).filter(Boolean);
    var label = $("proxyLabel").value.trim();
    // Blank means "leave it at the default tier" rather than 0, so the field
    // is genuinely optional and the server keeps its own default.
    var prioRaw = $("proxyPriority").value.trim();
    var priority = prioRaw === "" ? null : Number(prioRaw);
    if (priority !== null && (!Number.isInteger(priority) || priority < 0)) {
      err.className = "sm err";
      err.textContent = "优先级必须是不小于 0 的整数";
      err.style.display = "block";
      return;
    }
    // One line stays a single add so the duplicate case reports the same way it
    // always did; several lines go through bulk, which reports counts rather
    // than failing the whole import on one bad line.
    var call = lines.length === 1
      ? jsonApi("/admin/api/proxies", { url: lines[0], label: label || null, priority: priority })
          .then(function () { return { added: 1, duplicate: 0, invalid: [] }; })
      : jsonApi("/admin/api/proxies/bulk", { urls: lines, label: label || null, priority: priority }, "POST");

    call.then(function (r) {
      var parts = ["新增 " + r.added + " 条"];
      if (r.duplicate) parts.push("重复 " + r.duplicate + " 条");
      if (r.invalid && r.invalid.length) parts.push("无效 " + r.invalid.length + " 条");
      toast(parts.join("，"), "ok");
      if (r.invalid && r.invalid.length) {
        err.className = "sm err";
        err.textContent = "以下条目未导入：\n" + r.invalid.join("\n");
        err.style.display = "block";
      }
      $("proxyUrl").value = "";
      if (r.invalid && r.invalid.length) return;  // keep the form open to fix them
      $("proxyLabel").value = "";
      $("proxyFormPanel").style.display = "none";
      loadProxyView();
      loadProxies();
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
      td.colSpan = 8;
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
      td.colSpan = 7;
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

      var tdIp = el("td", "nowrap sm mono", e.clientIp || "—");
      tr.appendChild(tdIp);

      // Which exit Cline saw. The rate limit that throttles a burst is per
      // exit address, so this is the column that explains a 429 — the account
      // id does not.
      var tdExit = el("td", "nowrap sm mono", e.exitIp || "—");
      if (e.exitIp === "direct") tdExit.className = "nowrap sm mono faint";
      tr.appendChild(tdExit);

      // Zero means the request never left this host — rejected on auth, or no
      // account could serve it. Shown distinctly so a failed request is not
      // mistaken for load that Cline's rate limit counted.
      var calls = typeof e.upstreamCalls === "number" ? e.upstreamCalls : 0;
      var tdCalls = el("td", "nowrap sm num" + (calls === 0 ? " faint" : ""), String(calls));
      tr.appendChild(tdCalls);

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
  $("modelUsageReload").onclick = function () { loadModelUsage(); toast("已刷新模型用量"); };
  // Forced, not cached: this is the button that re-reads upstream now.
  $("chartReload").onclick = function () { loadTimeline(); loadUsage(true); toast("已刷新走势"); };
  $("ovChartMetric").onchange = function () {
    if (timelineCache) {
      renderChartInto($("ovChartWrap"), $("ovChartHint"), timelineCache, this.value);
    }
  };
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
  $("freeQuotaReload").onclick = function () {
    loadFreeQuota(true);
    toast("已开始扫描全池，数字会陆续补齐");
  };
  $("creditsReload").onclick = function () {
    // Forced: this is the button that re-reads every balance upstream now,
    // rather than serving the five-minute row cache.
    loadCredits(1, true);
    toast("已重新读取 Credits");
  };
  $("capSweep").onclick = function () {
    var btn = this;
    btn.disabled = true;
    // A job per account upstream, so the server acknowledges and runs it in the
    // background; the poll in loadCapabilities repaints as it lands.
    api("/admin/api/capabilities/sweep", { method: "POST" }).then(function (data) {
      toast(data.started ? "已开始扫描账号权限" : "已有扫描在进行中", "ok");
      return loadCapabilities();
    }).catch(function (e) {
      toast("扫描失败：" + e.message, "err");
    }).finally(function () { btn.disabled = false; });
  };
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
    loadUsage();
    // The charts and per-model table share this window, so they follow it too.
    loadTimeline();
    if ($("view-quota").classList.contains("active")) { loadModelUsage(); loadCredits(1, true); loadFreeQuota(true); }
  };
  $("winHours").onchange = function () {
    syncWindowControls();
    loadUsage();
    loadTimeline();
    if ($("view-quota").classList.contains("active")) { loadModelUsage(); loadCredits(1, true); loadFreeQuota(true); }
  };
  $("winAnchorDay").onchange = function () {
    usageWindow.anchorDay = this.checked;
    loadUsage();
    loadTimeline();
    if ($("view-quota").classList.contains("active")) { loadModelUsage(); loadCredits(1, true); loadFreeQuota(true); }
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
  $("proxyProbeBtn").onclick = probeProxiesOnPage;
  $("proxyPrev").onclick = function () { if (proxyPage > 1) { proxyPage -= 1; loadProxyView(); } };
  $("proxyNext").onclick = function () { proxyPage += 1; loadProxyView(); };
  $("proxyPageSize").onchange = function () {
    proxyPageSize = parseInt(this.value, 10) || 50;
    proxyPage = 1;
    loadProxyView();
  };
  // Typing filters server-side, debounced so a fast typist does not issue one
  // request per keystroke against a pool of hundreds.
  var proxySearchTimer = null;
  $("proxySearch").oninput = function () {
    var value = this.value.trim();
    if (proxySearchTimer) clearTimeout(proxySearchTimer);
    proxySearchTimer = setTimeout(function () {
      proxySearch = value;
      proxyPage = 1;
      loadProxyView();
    }, 250);
  };
  $("proxyModeSelect").onchange = function () {
    var mode = this.value;
    jsonApi("/admin/api/proxies/mode", { mode: mode }, "POST")
      .then(function (r) {
        toast("已切换为「" + (PROXY_MODE_LABEL[r.mode] || r.mode) + "」", "ok");
        loadProxyView();
      })
      .catch(function (e) {
        toast("切换失败：" + e.message, "err");
        loadProxyView();
      });
  };

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


  /* ---------- settings ---------- */
  function settingsMsg(id, text, ok) {
    var node = $(id);
    node.textContent = text;
    node.style.color = ok ? "var(--ok)" : "var(--err)";
  }
  function loadSettings() {
    api("/admin/api/settings").then(function (data) {
      $("pwUser").textContent = data.username ? ("当前账号 " + data.username) : "当前账号 —";
      $("pwHint").textContent = data.passwordManaged
        ? "修改后，grok-iq 的登录密码也会一起改变。"
        : "未挂载 grok-iq 数据库，此处无法修改密码。";
      $("pwSave").disabled = !data.passwordManaged;
      var tk = data.token || {};
      $("tkStatus").textContent = tk.configured ? ("当前令牌 " + tk.preview) : "尚未设置 Admin Token";
      $("tkSave").disabled = !data.tokenManaged;
      $("tkGenerate").disabled = !data.tokenManaged;
    }).catch(function (e) { toast("读取设置失败：" + e.message, "err"); });
  }
  function randomToken() {
    var bytes = new Uint8Array(24);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, function (b) { return b.toString(16).padStart(2, "0"); }).join("");
  }
  $("pwSave").onclick = function () {
    var next = $("pwNew").value;
    if (next.length < 8) { settingsMsg("pwMsg", "新密码至少 8 位", false); return; }
    if (next !== $("pwConfirm").value) { settingsMsg("pwMsg", "两次输入的新密码不一致", false); return; }
    $("pwSave").disabled = true;
    jsonApi("/admin/api/settings/password", { currentPassword: $("pwCurrent").value, newPassword: next })
      .then(function () {
        $("pwCurrent").value = ""; $("pwNew").value = ""; $("pwConfirm").value = "";
        settingsMsg("pwMsg", "密码已更新，grok-iq 同步生效", true);
      })
      .catch(function (e) { settingsMsg("pwMsg", e.message, false); })
      .then(function () { $("pwSave").disabled = false; });
  };
  $("tkGenerate").onclick = function () { $("tkValue").value = randomToken(); $("tkValue").focus(); };
  $("tkSave").onclick = function () {
    var value = $("tkValue").value.trim();
    if (value.length < 16) { settingsMsg("tkMsg", "至少 16 位", false); return; }
    if (!confirm("保存后，旧的 Admin Token 立即失效，注册机需要同步更新。继续？")) return;
    $("tkSave").disabled = true;
    jsonApi("/admin/api/settings/token", { token: value })
      .then(function (data) {
        $("tkValue").value = "";
        $("tkStatus").textContent = "当前令牌 " + data.token.preview;
        settingsMsg("tkMsg", "已保存并立即生效，记得更新注册机的配置", true);
      })
      .catch(function (e) { settingsMsg("tkMsg", e.message, false); })
      .then(function () { $("tkSave").disabled = false; });
  };

  /* ---------- login gate ---------- */
  function setAuthed(on) {
    authed = on;
    document.body.classList.toggle("authed", on);
    var gate = $("loginGate");
    if (gate) gate.hidden = on;
  }
  function submitLogin(ev) {
    if (ev) ev.preventDefault();
    var btn = $("loginSubmit");
    var err = $("loginError");
    btn.disabled = true;
    err.textContent = "";
    fetch("/admin/api/auth/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: $("loginUser").value.trim(), password: $("loginPass").value })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) { return { ok: res.ok, data: data }; });
    }).then(function (r) {
      if (!r.ok) { err.textContent = (r.data && r.data.error) || "登录失败"; return; }
      $("loginPass").value = "";
      setAuthed(true);
      boot();
    }).catch(function () { err.textContent = "无法连接服务器"; })
      .then(function () { btn.disabled = false; });
  }
  $("loginForm").addEventListener("submit", submitLogin);
  $("logoutBtn").onclick = function () {
    fetch("/admin/api/auth/logout", { method: "POST", credentials: "same-origin" })
      .finally(function () { location.reload(); });
  };

  function boot() {
    if (booted) return;
    booted = true;
    fillSnippets();
    wbInit();
    bootRoute();
    loadLoginModes();
    loadAccounts();
    syncLogTimer();
  }

  /* ---------- boot ---------- */
  fetch("/admin/api/auth/status", { credentials: "same-origin" }).then(function (res) {
    return res.ok ? res.json() : { authenticated: false };
  }).then(function (data) {
    if (data && data.authenticated) { setAuthed(true); boot(); }
    else { setAuthed(false); }
  }).catch(function () { setAuthed(false); });
})();
</script>
</body>
</html>`;
