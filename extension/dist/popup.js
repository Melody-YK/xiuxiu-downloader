import { STORAGE_KEY } from './lib/sniff.js';
const TYPE_LABEL = {
    video: '视频',
    audio: '音频',
    hls: 'HLS',
    dash: 'DASH',
    ts: '分片',
};
const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const refreshBtn = document.getElementById('refresh');
const copyAllBtn = document.getElementById('copyAll');
const clearBtn = document.getElementById('clear');
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
// 后台新捕获到内容时实时刷新列表
chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes[STORAGE_KEY] !== undefined)
        void render();
});
void render();
async function readEntries() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const raw = data[STORAGE_KEY];
    if (raw === null || typeof raw !== 'object')
        return [];
    const entries = raw.entries;
    return Array.isArray(entries) ? entries : [];
}
async function render() {
    const entries = await readEntries();
    listEl.replaceChildren();
    countEl.textContent = String(entries.length) + ' 条';
    if (entries.length === 0) {
        listEl.append(buildEmpty());
        return;
    }
    for (const entry of entries)
        listEl.append(buildRow(entry));
}
function buildRow(entry) {
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
    const bits = [];
    if (entry.segmentCount > 0)
        bits.push('分片 ×' + String(entry.segmentCount));
    if (entry.size !== null)
        bits.push(formatSize(entry.size));
    bits.push(formatTime(entry.createdAt));
    const page = entry.pageTitle !== '' ? entry.pageTitle : pageHost(entry.pageUrl);
    if (page !== '')
        bits.push(page);
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
function buildEmpty() {
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
async function copyRow(btn, text) {
    const ok = await copyText(text);
    flashButton(btn, ok ? '✓ 已复制' : '复制失败');
}
async function copyAll() {
    const entries = await readEntries();
    if (entries.length === 0)
        return;
    const ok = await copyText(entries.map((e) => e.url).join('\n'));
    flashButton(copyAllBtn, ok ? '✓ 已复制' : '复制失败');
}
function flashButton(btn, text) {
    const prev = btn.textContent;
    btn.textContent = text;
    setTimeout(() => {
        btn.textContent = prev;
    }, 1200);
}
async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    }
    catch {
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
    }
    catch {
        return false;
    }
}
function fileNameOf(url) {
    let name = url;
    try {
        const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
        if (seg !== undefined && seg !== '')
            name = seg;
    }
    catch {
        // 保留原样
    }
    try {
        name = decodeURIComponent(name);
    }
    catch {
        // 解码失败保留原样
    }
    if (name.length > 56)
        name = name.slice(0, 40) + '…' + name.slice(-12);
    return name;
}
function pageHost(url) {
    try {
        return new URL(url).host;
    }
    catch {
        return url;
    }
}
function formatSize(n) {
    if (n < 1024)
        return String(n) + ' B';
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n;
    let u = -1;
    while (v >= 1024 && u < units.length - 1) {
        v /= 1024;
        u += 1;
    }
    return v.toFixed(v >= 100 ? 0 : 1) + ' ' + (units[u] ?? '');
}
function formatTime(ts) {
    const d = new Date(ts);
    const p = (x) => String(x).padStart(2, '0');
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}
