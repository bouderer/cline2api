/** 控制台前端页面（原生 HTML/CSS/JS，无依赖）。 */

export const PAGE = String.raw`<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Cline 注册机</title>
<style>
  :root{
    --bg:#0f1115; --panel:#171a21; --panel2:#1d212a; --line:#272c37;
    --text:#e6e8ee; --muted:#8b93a7; --dim:#5d6577;
    --accent:#5b8cff; --ok:#2fbf71; --warn:#e0a33e; --err:#e2564d;
    --mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;
  }
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);
    font:14px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif}
  .wrap{max-width:1080px;margin:0 auto;padding:24px 20px 60px}
  header{display:flex;align-items:baseline;gap:12px;margin-bottom:20px;flex-wrap:wrap}
  h1{font-size:20px;margin:0;font-weight:650}
  header .sub{color:var(--muted);font-size:13px}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:18px}
  .stat{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:12px 14px}
  .stat .k{color:var(--muted);font-size:12px;margin-bottom:4px}
  .stat .v{font-size:22px;font-weight:650;font-variant-numeric:tabular-nums}
  .card{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:16px}
  .card h2{font-size:13px;margin:0 0 12px;font-weight:600;color:var(--muted);text-transform:uppercase;letter-spacing:.04em}
  .row{display:flex;gap:14px;flex-wrap:wrap;align-items:flex-end}
  .field{display:flex;flex-direction:column;gap:6px}
  .field label{font-size:12px;color:var(--muted)}
  input[type=number],input[type=text],select{background:var(--panel2);border:1px solid var(--line);color:var(--text);
    border-radius:8px;padding:8px 10px;font-size:14px;font-family:inherit;min-width:120px}
  input[type=range]{width:200px;accent-color:var(--accent)}
  .btn{background:var(--accent);color:#fff;border:0;border-radius:8px;padding:9px 18px;
    font-size:14px;font-weight:600;cursor:pointer;font-family:inherit}
  .btn:hover{filter:brightness(1.08)}
  .btn:disabled{opacity:.45;cursor:not-allowed}
  .btn.ghost{background:transparent;border:1px solid var(--line);color:var(--text)}
  .btn.danger{background:var(--err)}
  .hint{color:var(--dim);font-size:12px}
  .bar{height:8px;background:var(--panel2);border-radius:99px;overflow:hidden;margin:10px 0 6px}
  .bar > i{display:block;height:100%;background:var(--accent);width:0;transition:width .3s}
  #logs{background:#0b0d11;border:1px solid var(--line);border-radius:10px;padding:10px 12px;
    height:340px;overflow:auto;font-family:var(--mono);font-size:12.5px;line-height:1.7}
  #logs .l{white-space:pre-wrap;word-break:break-all}
  .l.info{color:#b9c0d0} .l.ok{color:var(--ok)} .l.warn{color:var(--warn)} .l.err{color:var(--err)}
  .l .t{color:var(--dim);margin-right:8px}
  .badge{display:inline-block;padding:2px 8px;border-radius:99px;font-size:12px;border:1px solid var(--line)}
  .badge.on{color:var(--ok);border-color:#1e4632;background:#122a1e}
  .badge.off{color:var(--muted)}
  .badge.run{color:var(--accent);border-color:#22366b;background:#141d33}
  table{width:100%;border-collapse:collapse;font-size:13px}
  th,td{text-align:left;padding:7px 8px;border-bottom:1px solid var(--line)}
  th{color:var(--muted);font-weight:500;font-size:12px}
  td.mono{font-family:var(--mono);font-size:12px}
  details summary{cursor:pointer;color:var(--muted);font-size:13px}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>Cline 注册机</h1>
    <span class="sub" id="hostnote"></span>
    <span style="margin-left:auto" id="runBadge" class="badge off">空闲</span>
  </header>

  <div class="grid">
    <div class="stat"><div class="k">待登录库存</div><div class="v" id="sInv">-</div></div>
    <div class="stat"><div class="k">辅助接码邮箱</div><div class="v" id="sHelp">-</div></div>
    <div class="stat"><div class="k">已成功登录</div><div class="v" id="sOk" style="color:var(--ok)">-</div></div>
    <div class="stat"><div class="k">失败待重试</div><div class="v" id="sBad" style="color:var(--warn)">-</div></div>
    <div class="stat"><div class="k">剩余未处理</div><div class="v" id="sPending">-</div></div>
    <div class="stat"><div class="k">已推送远端</div><div class="v" id="sPushed">-</div></div>
  </div>

  <div class="card">
    <h2>本轮设置</h2>
    <div class="row">
      <div class="field">
        <label>跑多少个（0 = 全部剩余）</label>
        <input type="number" id="count" min="0" value="10" />
      </div>
      <div class="field">
        <label>并发数 <span id="concVal" class="hint">2</span></label>
        <input type="range" id="concurrency" min="1" max="8" value="2" />
        <span class="hint">每个并发 = 一个 Chrome</span>
      </div>
      <div class="field">
        <label>范围</label>
        <select id="mode">
          <option value="pending">未处理（默认）</option>
          <option value="retry">仅失败的</option>
          <option value="all">全部库存</option>
        </select>
      </div>
      <div class="field">
        <label>链路</label>
        <select id="channel">
          <option value="callback">回调（推荐）</option>
          <option value="device">设备码</option>
        </select>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <label style="color:var(--text)"><input type="checkbox" id="push" checked /> 成功即推送远端</label>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <button class="btn" id="startBtn">开始</button>
      </div>
      <div class="field">
        <label>&nbsp;</label>
        <button class="btn danger" id="stopBtn" disabled>停止</button>
      </div>
    </div>
    <div class="hint" id="remoteNote" style="margin-top:10px"></div>
  </div>

  <div class="card" id="progCard" style="display:none">
    <h2>进度</h2>
    <div class="bar"><i id="progBar"></i></div>
    <div class="row">
      <span class="hint">完成 <b id="pDone">0</b> / <b id="pTotal">0</b></span>
      <span class="hint">成功 <b id="pOk" style="color:var(--ok)">0</b></span>
      <span class="hint">失败 <b id="pFail" style="color:var(--err)">0</b></span>
      <span class="hint">已推送 <b id="pPushed">0</b></span>
      <span class="hint">运行中 <b id="pRunning">0</b></span>
      <span class="hint" id="pEta" style="margin-left:auto"></span>
    </div>
  </div>

  <div class="card">
    <h2>实时日志</h2>
    <div id="logs"></div>
    <div class="row" style="margin-top:10px">
      <button class="btn ghost" id="clearLog">清屏</button>
      <label class="hint" style="color:var(--text)"><input type="checkbox" id="autoScroll" checked /> 自动滚动</label>
    </div>
  </div>

  <div class="card">
    <h2>已成功账号</h2>
    <details>
      <summary>展开列表（最多 200 条）</summary>
      <div id="accList" style="margin-top:10px"></div>
    </details>
  </div>
</div>

<script>
var $ = function(id){ return document.getElementById(id); };
var state = { running: false, total: 0, done: 0, startedAt: 0 };

function fmtDuration(ms){
  var s = Math.max(0, Math.round(ms/1000));
  if (s < 60) return s + ' 秒';
  return Math.floor(s/60) + ' 分 ' + (s%60) + ' 秒';
}

function logLine(level, text){
  var box = $('logs');
  var atBottom = box.scrollTop + box.clientHeight >= box.scrollHeight - 40;
  var div = document.createElement('div');
  div.className = 'l ' + (level || 'info');
  var t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  var span = document.createElement('span');
  span.className = 't'; span.textContent = t;
  div.appendChild(span);
  div.appendChild(document.createTextNode(text));
  box.appendChild(div);
  while (box.childElementCount > 1200) box.removeChild(box.firstChild);
  if ($('autoScroll').checked && atBottom) box.scrollTop = box.scrollHeight;
}

function renderProgress(){
  if (!state.running) return;
  $('pDone').textContent = state.done;
  $('pTotal').textContent = state.total;
  $('progBar').style.width = state.total ? (state.done / state.total * 100) + '%' : '0%';
  if (state.startedAt && state.done > 0){
    var per = (Date.now() - state.startedAt) / state.done;
    var left = Math.max(0, state.total - state.done);
    $('pEta').textContent = '预计还需 ' + fmtDuration(per * left);
  } else {
    $('pEta').textContent = '';
  }
}

async function refreshState(){
  try {
    var r = await fetch('/api/state');
    var s = await r.json();
    var snap = s.snapshot;
    $('sInv').textContent = snap.inventory;
    $('sHelp').textContent = snap.helpers;
    $('sOk').textContent = snap.ok;
    $('sBad').textContent = snap.failed;
    $('sPending').textContent = snap.pending;
    $('sPushed').textContent = snap.pushed;
    $('concurrency').max = String(snap.maxConcurrency || 8);
    $('remoteNote').innerHTML = snap.remote.configured
      ? '远端网关：<b>' + snap.remote.base + '</b>（成功即推送）'
      : '<span style="color:var(--warn)">未配置远端网关</span> -- 只写本地，稍后可 npm run push';

    var running = s.running;
    $('runBadge').textContent = running ? '运行中' : '空闲';
    $('runBadge').className = 'badge ' + (running ? 'run' : 'off');
    $('startBtn').disabled = running;
    $('stopBtn').disabled = !running;
    if (running && s.current){
      state.running = true; state.total = s.current.total; state.done = s.current.done || 0;
      $('pOk').textContent = s.current.ok || 0;
      $('pFail').textContent = s.current.fail || 0;
      $('pPushed').textContent = s.current.pushed || 0;
      $('progCard').style.display = '';
      renderProgress();
    } else if (!running){
      state.running = false;
    }
  } catch (e) {}
}

async function refreshAccounts(){
  try {
    var r = await fetch('/api/accounts');
    var d = await r.json();
    var rows = d.accounts.map(function(a){
      return '<tr><td class="mono">' + a.email + '</td><td>'
        + (a.pushed ? '<span class="badge on">已推送</span>' : '<span class="badge off">未推送</span>')
        + '</td><td class="mono">' + (a.boundAt ? a.boundAt.slice(0,19).replace('T',' ') : '') + '</td></tr>';
    }).join('');
    $('accList').innerHTML = '<table><thead><tr><th>邮箱</th><th>状态</th><th>时间</th></tr></thead><tbody>' + rows + '</tbody></table>';
  } catch (e) {}
}

$('concurrency').addEventListener('input', function(e){ $('concVal').textContent = e.target.value; });

$('startBtn').addEventListener('click', async function(){
  logLine('info', '--- 新一轮开始 ---');
  $('progCard').style.display = '';
  state.running = true; state.done = 0; state.total = 0; state.startedAt = Date.now();
  $('progBar').style.width = '0%';
  $('startBtn').disabled = true; $('stopBtn').disabled = false;
  try {
    var res = await fetch('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        count: Number($('count').value) || 0,
        concurrency: Number($('concurrency').value) || 1,
        mode: $('mode').value,
        device: $('channel').value === 'device',
        push: $('push').checked
      })
    });
    if (!res.ok) {
      var e = await res.json().catch(function(){ return {}; });
      logLine('err', '启动失败：' + (e.error || res.status));
      state.running = false;
      $('startBtn').disabled = false; $('stopBtn').disabled = true;
    }
  } catch (e) {
    logLine('err', '启动失败：' + e.message);
    state.running = false;
    $('startBtn').disabled = false; $('stopBtn').disabled = true;
  }
  refreshState();
});

$('stopBtn').addEventListener('click', async function(){
  $('stopBtn').disabled = true;
  await fetch('/api/stop', { method: 'POST' }).catch(function(){});
});

$('clearLog').addEventListener('click', function(){ $('logs').innerHTML = ''; });

var es = new EventSource('/api/events');
es.onmessage = function(m){
  var evt; try { evt = JSON.parse(m.data); } catch (e) { return; }
  switch (evt.type){
    case 'idle':
      state.running = false;
      $('progCard').style.display = 'none';
      break;
    case 'start':
      state.total = evt.total; state.startedAt = Date.now();
      $('pTotal').textContent = evt.total;
      $('progCard').style.display = '';
      logLine('info', '共 ' + evt.total + ' 个 | 并发 ' + evt.concurrency + ' | 链路 ' + evt.mode + (evt.push ? ' | 推送 ' + evt.remote : ' | 不推送'));
      break;
    case 'progress':
      state.done = evt.done; state.running = true;
      $('pOk').textContent = evt.ok; $('pFail').textContent = evt.fail; $('pPushed').textContent = evt.pushed;
      $('pRunning').textContent = evt.running;
      renderProgress();
      break;
    case 'log':
      logLine(evt.level, evt.text);
      break;
    case 'done':
      state.running = false; state.done = evt.total;
      $('pOk').textContent = evt.ok; $('pFail').textContent = evt.fail; $('pPushed').textContent = evt.pushed;
      $('pRunning').textContent = 0;
      renderProgress();
      logLine(evt.aborted ? 'warn' : 'ok',
        '--- 本轮结束：成功 ' + evt.ok + ' | 失败 ' + evt.fail + ' | 已推送 ' + evt.pushed + ' | 耗时 ' + fmtDuration(evt.ms) + (evt.aborted ? '（已中止）' : '') + ' ---');
      $('startBtn').disabled = false; $('stopBtn').disabled = true;
      refreshState(); refreshAccounts();
      break;
  }
};
es.onerror = function(){};

$('concVal').textContent = $('concurrency').value;
$('hostnote').textContent = location.host;
refreshState(); refreshAccounts();
setInterval(refreshState, 3000);
</script>
</body>
</html>`;
