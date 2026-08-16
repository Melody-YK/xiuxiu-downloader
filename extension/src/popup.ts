import { STORAGE_KEY, type Entry, type MediaType } from './lib/sniff.js';

const TYPE_LABEL: Record<MediaType, string> = {
  video: '视频',
  audio: '音频',
  hls: 'HLS',
  dash: 'DASH',
  ts: '分片',
};

const listEl = document.getElementById('list') as HTMLDivElement;
const countEl = document.getElementById('count') as HTMLSpanElement;
const refreshBtn = document.getElementById('refresh') as HTMLButtonElement;
const copyAllBtn = document.getElementById('copyAll') as HTMLButtonElement;
const clearBtn = document.getElementById('clear') as HTMLButtonElement;
const sendBtn = document.getElementById('send') as HTMLButtonElement;

refreshBtn.addEventListener('click', () => {
  void render();
});
copyAllBtn.addEventListener('click', () => {
  void copyAll();
});
clearBtn.addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'clear' }).catch(() => undefined);
  void render();
});
sendBtn.addEventListener('click', () => {
  void sendToDesktop();
});

// 后台新捕获到内容时实时刷新列表
chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes[STORAGE_KEY] !== undefined) void render();
});

void render();

async function readEntries(): Promise<Entry[]> {
  const data = await chrome.storage.local.get(STORAGE_KEY);
  const raw: unknown = data[STORAGE_KEY];
  if (raw === null || typeof raw !== 'object') return [];
  const entries = (raw as { entries?: unknown }).entries;
  return Array.isArray(entries) ? (entries as Entry[]) : [];
}

async function render(): Promise<void> {
  const entries = await readEntries();
  listEl.replaceChildren();
  countEl.textContent = String(entries.length) + ' 条';
  if (entries.length === 0) {
    listEl.append(buildEmpty());
    return;
  }
  for (const entry of entries) listEl.append(buildRow(entry));
}

function buildRow(entry: Entry): HTMLElement {
  const row = document.createElement('div');
  row.className = 'row';

  const head = document.createElement('div');
  head.className = 'row-head';

  const badge = document.createElement('span');
  badge.className = 'badge badge-' + entry.type;
  badge.textContent = TYPE_LABEL[entry.type];

  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = fileNameOf(entry.url);
  name.title = entry.url;

  head.append(badge, name);

  const meta = document.createElement('div');
  meta.className = 'meta';
  const bits: string[] = [];
  if (entry.segmentCount > 0) bits.push('分片 ×' + String(entry.segmentCount));
  if (entry.size !== null) bits.push(formatSize(entry.size));
  bits.push(formatTime(entry.createdAt));
  const page = entry.pageTitle !== '' ? entry.pageTitle : pageHost(entry.pageUrl);
  if (page !== '') bits.push(page);
  meta.textContent = bits.join(' · ');

  const copyBtn = document.createElement('button');
  copyBtn.className = 'copy';
  copyBtn.textContent = '复制';
  copyBtn.addEventListener('click', () => {
    void copyRow(copyBtn, entry.url);
  });

  row.append(head, meta, copyBtn);
  return row;
}

function buildEmpty(): HTMLElement {
  const div = document.createElement('div');
  div.className = 'empty';

  const h = document.createElement('p');
  h.textContent = '暂无捕获记录';

  const steps = document.createElement('ol');
  for (const s of [
    '打开一个正在播放视频/音频的网页',
    '播放几秒，让浏览器发出媒体请求',
    '点击「刷新」查看捕获列表',
  ]) {
    const li = document.createElement('li');
    li.textContent = s;
    steps.append(li);
  }

  const note = document.createElement('p');
  note.className = 'note';
  note.textContent = '提示：blob:/MSE 流（如 YouTube）需要后续 Hook 层才能捕获。';

  div.append(h, steps, note);
  return div;
}

async function copyRow(btn: HTMLButtonElement, text: string): Promise<void> {
  const ok = await copyText(text);
  flashButton(btn, ok ? '✓ 已复制' : '复制失败');
}

async function copyAll(): Promise<void> {
  const entries = await readEntries();
  if (entries.length === 0) return;
  const ok = await copyText(entries.map((e) => e.url).join('\n'));
  flashButton(copyAllBtn, ok ? '✓ 已复制' : '复制失败');
}

function flashButton(btn: HTMLButtonElement, text: string): void {
  const prev = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = prev;
  }, 1200);
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // 继续走回退方案
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

function fileNameOf(url: string): string {
  let name = url;
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (seg !== undefined && seg !== '') name = seg;
  } catch {
    // 保留原样
  }
  try {
    name = decodeURIComponent(name);
  } catch {
    // 解码失败保留原样
  }
  if (name.length > 56) name = name.slice(0, 40) + '…' + name.slice(-12);
  return name;
}

function pageHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function formatSize(n: number): string {
  if (n < 1024) return String(n) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = -1;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + (units[u] ?? '');
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (x: number): string => String(x).padStart(2, '0');
  return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/** 与 desktop/register-host.mjs 中的宿主名保持一致 */
const NATIVE_HOST_NAME = 'com.downloader.sniffer';

async function sendToDesktop(): Promise<void> {
  const entries = await readEntries();
  if (entries.length === 0) {
    flashButton(sendBtn, '无记录可发送');
    return;
  }
  let port: chrome.runtime.Port;
  try {
    port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
  } catch {
    flashButton(sendBtn, '宿主未注册');
    return;
  }
  let done = false;
  const finish = (text: string): void => {
    if (done) return;
    done = true;
    flashButton(sendBtn, text);
    port.disconnect();
  };
  port.onMessage.addListener((msg: unknown) => {
    if (typeof msg === 'object' && msg !== null) {
      const t = (msg as { type?: unknown }).type;
      if (t === 'ack') {
        finish('已发送 ' + String((msg as { count?: unknown }).count ?? entries.length) + ' 条');
        return;
      }
      if (t === 'error') {
        finish('宿主返回错误');
      }
    }
  });
  port.onDisconnect.addListener(() => {
    if (chrome.runtime.lastError !== undefined) finish('宿主连接失败');
  });
  port.postMessage({
    type: 'capture',
    entries: entries.map((e) => ({
      url: e.url,
      mediaType: e.type,
      contentType: e.contentType,
      size: e.size,
      pageUrl: e.pageUrl,
      pageTitle: e.pageTitle,
      cookie: e.headers?.cookie ?? '',
      referer: e.headers?.referer ?? '',
      userAgent: e.headers?.userAgent ?? '',
    })),
  });
  setTimeout(() => finish('宿主无响应'), 3000);
}
