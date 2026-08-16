/* 渲染层逻辑（纯 DOM，无框架） */
// 注意：contextBridge 暴露的 window.api 是 window 上的不可配置属性，
// 经典脚本顶层 const 同名会冲突，因此用模块脚本 + 重命名变量
const bridge = window.api;
const state = { tasks: new Map(), captures: [] };

// ---- 全局错误可见化（任何脚本错误都显示出来，而不是静默失败） ----
const errBanner = document.getElementById('err-banner');
function showError(msg) {
  errBanner.textContent = '⚠ ' + msg;
  errBanner.hidden = false;
  clearTimeout(showError.timer);
  showError.timer = setTimeout(() => {
    errBanner.hidden = true;
  }, 8000);
}
window.addEventListener('error', (e) => showError('页面脚本错误: ' + (e.message ?? '未知')));
window.addEventListener('unhandledrejection', (e) => {
  const reason = e.reason;
  showError('操作失败: ' + (reason?.message ?? String(reason)));
});

async function safeAddTask(task) {
  try {
    const r = await bridge.addTask(task);
    if (r !== null && typeof r === 'object' && r.error) {
      showError(r.error);
      return false;
    }
    return true;
  } catch (err) {
    showError('添加任务失败: ' + (err?.message ?? String(err)));
    return false;
  }
}

const tabDlBtn = document.getElementById('tab-dl');
const tabCapBtn = document.getElementById('tab-cap');
const viewDl = document.getElementById('view-dl');
const viewCap = document.getElementById('view-cap');
const capCount = document.getElementById('cap-count');
const tasksEl = document.getElementById('tasks');
const emptyEl = document.getElementById('empty');
const capturesEl = document.getElementById('captures');

const STATUS_LABEL = { queued: '排队中', running: '下载中', done: '已完成', error: '失败', canceled: '已取消' };
const TYPE_LABEL = { video: '视频', audio: '音频', hls: 'HLS', dash: 'DASH', ts: '分片' };

function switchTab(which) {
  const dl = which === 'dl';
  tabDlBtn.classList.toggle('active', dl);
  tabCapBtn.classList.toggle('active', !dl);
  viewDl.hidden = !dl;
  viewCap.hidden = dl;
}
tabDlBtn.addEventListener('click', () => switchTab('dl'));
tabCapBtn.addEventListener('click', () => switchTab('cap'));

// ---- 添加任务 ----
document.getElementById('add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const url = document.getElementById('f-url').value.trim();
  if (!/^https?:\/\//i.test(url)) {
    showError('请输入 http(s) 链接');
    return;
  }
  const headers = {};
  const cookie = document.getElementById('f-cookie').value.trim();
  const referer = document.getElementById('f-referer').value.trim();
  const ua = document.getElementById('f-ua').value.trim();
  if (cookie !== '') headers.Cookie = cookie;
  if (referer !== '') headers.Referer = referer;
  if (ua !== '') headers['User-Agent'] = ua;
  const threads = Math.max(1, Math.min(32, Number(document.getElementById('f-threads').value) || 8));
  const limitKB = Math.max(0, Number(document.getElementById('f-limit').value) || 0);
  const ok = await safeAddTask({
    url,
    kind: document.getElementById('f-kind').value,
    out: document.getElementById('f-out').value.trim() || null,
    threads,
    limitBytesPerSec: limitKB > 0 ? limitKB * 1024 : undefined,
    headers,
  });
  if (ok) {
    document.getElementById('f-url').value = '';
    document.getElementById('f-out').value = '';
  }
});

// 保存位置选择器
document.getElementById('f-browse').addEventListener('click', async () => {
  const url = document.getElementById('f-url').value.trim();
  const p = await bridge.chooseSavePath({ defaultName: fileNameOf(url) });
  if (p) document.getElementById('f-out').value = p;
});

// ---- 拖拽 URL ----
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  const text = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  const url = text.split('\n').map((s) => s.trim()).find((s) => /^https?:\/\//i.test(s));
  if (url !== undefined) document.getElementById('f-url').value = url;
});

// ---- 任务列表 ----
function buildTaskRow() {
  const row = document.createElement('div');
  row.className = 'task';

  const head = document.createElement('div');
  head.className = 't-head';
  const name = document.createElement('span');
  name.className = 't-name';
  const status = document.createElement('span');
  status.className = 't-status';
  head.append(name, status);

  const meta = document.createElement('div');
  meta.className = 't-meta';

  const barWrap = document.createElement('div');
  barWrap.className = 't-bar';
  const bar = document.createElement('div');
  bar.className = 't-bar-fill';
  barWrap.append(bar);

  const ops = document.createElement('div');
  ops.className = 't-ops';
  const cancelBtn = document.createElement('button');
  cancelBtn.textContent = '取消';
  const openBtn = document.createElement('button');
  openBtn.textContent = '打开位置';
  ops.append(cancelBtn, openBtn);

  row.append(head, meta, barWrap, ops);

  return {
    row,
    bind: (t) => {
      name.textContent = fileNameOf(t.url);
      name.title = t.url;
      cancelBtn.onclick = () => void bridge.cancelTask(t.id);
      openBtn.onclick = () => void bridge.openFolder(t.out);
    },
    update: (t) => {
      status.textContent = STATUS_LABEL[t.status] ?? t.status;
      status.className = 't-status st-' + t.status;
      const parts = [];
      if (t.phase !== '') parts.push(t.phase);
      if (t.progress !== null && t.progress !== undefined) {
        if (t.progress.unit === 'segments') {
          parts.push('分片 ' + t.progress.completed + '/' + t.progress.total);
          const pct = t.progress.total > 0 ? (t.progress.completed / t.progress.total) * 100 : 0;
          bar.style.width = Math.min(100, pct).toFixed(1) + '%';
        } else {
          const pct = t.progress.total > 0 ? (t.progress.completed / t.progress.total) * 100 : 0;
          parts.push(Math.min(100, pct).toFixed(1) + '%  ' + fmtSize(t.progress.speed ?? 0) + '/s');
          bar.style.width = Math.min(100, pct).toFixed(1) + '%';
        }
      }
      if (t.status === 'error' && t.error !== null) {
        parts.push(
          t.error.includes('403')
            ? t.error + '（可能需要请求头：从「扩展捕获」列表点下载会自动携带 Cookie/Referer/UA）'
            : t.error,
        );
      }
      if (t.status === 'done') parts.push(t.out);
      meta.textContent = parts.join(' · ');
      meta.title = parts.join(' · ');
      cancelBtn.hidden = !(t.status === 'queued' || t.status === 'running');
      openBtn.hidden = t.status !== 'done';
    },
  };
}

function upsertTask(t) {
  let entry = state.tasks.get(t.id);
  if (entry === undefined) {
    entry = buildTaskRow();
    entry.bind(t);
    state.tasks.set(t.id, entry);
    tasksEl.append(entry.row);
  }
  entry.update(t);
  emptyEl.hidden = state.tasks.size > 0;
}

// ---- 扩展捕获列表 ----
function renderCaptures() {
  capturesEl.replaceChildren();
  const visible = state.captures.filter((c) => c.mediaType !== 'ts');
  if (visible.length === 0) {
    capturesEl.textContent = '暂无捕获。在扩展 popup 点「发送到桌面端」。';
    return;
  }
  for (const c of visible) {
    const row = document.createElement('div');
    row.className = 'cap';
    const badge = document.createElement('span');
    badge.className = 'badge badge-' + (c.mediaType ?? 'video');
    badge.textContent = TYPE_LABEL[c.mediaType] ?? (c.mediaType ?? '媒体');
    const name = document.createElement('span');
    name.className = 'c-name';
    name.textContent = fileNameOf(c.url);
    name.title = c.url;
    const meta = document.createElement('div');
    meta.className = 'c-meta';
    meta.textContent = (c.pageTitle ?? '') + (c.size != null ? ' · ' + fmtSize(c.size) : '');
    const dl = document.createElement('button');
    dl.className = 'primary';
    dl.textContent = '下载';
    dl.addEventListener('click', () => {
      if (c.mediaType === 'ts') {
        showError('这是单个分片地址，不能直接下载；请在列表里选择 HLS/DASH 清单条目（B站选 playurl 接口条目）');
        return;
      }
      const headers = {};
      if (c.cookie) headers.Cookie = c.cookie;
      if (c.referer) headers.Referer = c.referer;
      if (c.userAgent) headers['User-Agent'] = c.userAgent;
      void safeAddTask({
        url: c.url,
        kind: c.mediaType === 'hls' || c.mediaType === 'dash' ? 'media' : 'auto',
        headers,
      }).then((ok) => {
        if (ok) switchTab('dl');
      });
    });
    row.append(badge, name, meta, dl);
    capturesEl.append(row);
  }
}

// ---- 工具 ----
function fileNameOf(url) {
  let name = url;
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (seg !== undefined && seg !== '') name = seg;
  } catch {
    // 忽略
  }
  try {
    name = decodeURIComponent(name);
  } catch {
    // 忽略
  }
  if (name.length > 48) name = name.slice(0, 32) + '…' + name.slice(-12);
  return name;
}

function fmtSize(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return (v >= 100 || u === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[u];
}

// ---- 启动：恢复快照 + 订阅事件 ----
void (async () => {
  const snap = await bridge.getSnapshot();
  for (const t of snap.tasks) upsertTask(t);
  state.captures = snap.captures ?? [];
  capCount.textContent = String(state.captures.length);
  renderCaptures();
  emptyEl.hidden = state.tasks.size > 0;

  bridge.onTaskEvent((ev) => {
    upsertTask(ev.data);
  });
  bridge.onCapture((entries) => {
    state.captures.unshift(...entries);
    if (state.captures.length > 100) state.captures.length = 100;
    capCount.textContent = String(state.captures.length);
    renderCaptures();
  });
})();
