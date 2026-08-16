import { bvidFromPageUrl, bvidFromPlayurl, cleanBiliTitle, NATIVE_HOST_NAME, STORAGE_KEY } from './lib/sniff.js';
const TYPE_LABEL = {
    video: '视频',
    audio: '音频',
    hls: 'HLS',
    dash: 'DASH',
    ts: '分片',
    stream: '分片流',
};
const debugEl = document.getElementById('debug');
const listEl = document.getElementById('list');
const countEl = document.getElementById('count');
const refreshBtn = document.getElementById('refresh');
const copyAllBtn = document.getElementById('copyAll');
const clearBtn = document.getElementById('clear');
const sendBtn = document.getElementById('send');
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
    if (areaName === 'local' && changes[STORAGE_KEY] !== undefined)
        void render();
});
void render();
// 标题补全（两种模式）：
// - B站：按 bvid 精确匹配（预览视频不贴标题）
// - 通用站点：条目属于当前活动标签页且标题为空时，用实时标签页标题补全
async function enrichTitles(entries) {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (tab === undefined || tab.url === undefined)
            return entries;
        const tabBvid = bvidFromPageUrl(tab.url);
        const rawTitle = tab.title ?? '';
        return entries.map((e) => {
            if (tabBvid !== '') {
                const matches = e.dedupeKey === 'bili:' + tabBvid || bvidFromPlayurl(e.url) === tabBvid;
                if (matches) {
                    const title = cleanBiliTitle(rawTitle);
                    if (title !== '' && e.pageTitle !== title) {
                        void chrome.runtime.sendMessage({ type: 'entry:title', url: e.url, title });
                        return { ...e, pageTitle: title };
                    }
                }
                return e;
            }
            if (e.tabId === tab.id && e.pageTitle === '' && rawTitle !== '') {
                void chrome.runtime.sendMessage({ type: 'entry:title', url: e.url, title: rawTitle });
                return { ...e, pageTitle: rawTitle };
            }
            return e;
        });
    }
    catch {
        return entries;
    }
}
// 诊断信息：帮助在真实站点上定位问题
async function updateDebugInfo(entries) {
    try {
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        const tab = tabs[0];
        if (tab === undefined) {
            debugEl.textContent = '诊断: 无活动标签页';
            return;
        }
        const tabBvid = tab.url !== undefined ? bvidFromPageUrl(tab.url) : '';
        const title = cleanBiliTitle(tab.title ?? '');
        let line = '诊断 | 页面: ' + (tab.url ?? '?') + ' | bvid: ' + (tabBvid !== '' ? tabBvid : '(未识别)') + ' | 标题: ' + (title !== '' ? title : '(空/默认)');
        const streamEntry = entries.find((e) => e.type === 'stream' && e.segmentUrls !== undefined && e.segmentUrls.length > 0);
        if (streamEntry !== undefined) {
            const urls = streamEntry.segmentUrls ?? [];
            const last = urls.length > 0 ? (urls[urls.length - 1] ?? '') : '';
            line += ' | 分片流 ' + streamEntry.segmentCount + ' 片 末片: ' + last;
        }
        debugEl.textContent = line;
    }
    catch {
        debugEl.textContent = '诊断: 读取标签页失败';
    }
}
async function readEntries() {
    const data = await chrome.storage.local.get(STORAGE_KEY);
    const raw = data[STORAGE_KEY];
    if (raw === null || typeof raw !== 'object')
        return [];
    const entries = raw.entries;
    return Array.isArray(entries) ? entries : [];
}
// 展示与发送共用的条目准备：过滤分片、隐藏无标题的 B站 playurl 条目、补全标题
async function prepareEntries() {
    const all = await readEntries();
    let entries = all.filter((e) => e.type !== 'ts');
    entries = await enrichTitles(entries);
    // 补全之后再隐藏：无标题的 B站 playurl 条目是推荐预览视频，不展示
    const isBili = (e) => (e.dedupeKey ?? '').startsWith('bili:') || /bilibili\.com\//.test(e.url);
    entries = entries.filter((e) => !(isBili(e) && e.pageTitle === ''));
    return entries;
}
async function render() {
    const entries = await prepareEntries();
    listEl.replaceChildren();
    countEl.textContent = String(entries.length) + ' 条';
    void updateDebugInfo(entries);
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
    name.textContent = entry.pageTitle !== '' ? entry.pageTitle : fileNameOf(entry.url);
    name.title = entry.url + ' | key=' + (entry.dedupeKey ?? '-') + ' | bvid=' + bvidFromPlayurl(entry.url);
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
    const delBtn = document.createElement('button');
    delBtn.className = 'del';
    delBtn.textContent = '删除';
    delBtn.title = '从捕获列表移除该条目';
    delBtn.addEventListener('click', () => {
        void chrome.runtime.sendMessage({ type: 'entry:remove', url: entry.url }).then(() => render());
    });
    row.append(head, meta, delBtn, copyBtn);
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
    const entries = await prepareEntries();
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
async function sendToDesktop() {
    const entries = await prepareEntries();
    if (entries.length === 0) {
        flashButton(sendBtn, '无记录可发送');
        return;
    }
    let port;
    try {
        port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    }
    catch {
        flashButton(sendBtn, '宿主未注册');
        return;
    }
    let done = false;
    const finish = (text) => {
        if (done)
            return;
        done = true;
        flashButton(sendBtn, text);
        port.disconnect();
    };
    port.onMessage.addListener((msg) => {
        if (typeof msg === 'object' && msg !== null) {
            const t = msg.type;
            if (t === 'ack') {
                finish('已发送 ' + String(msg.count ?? entries.length) + ' 条');
                return;
            }
            if (t === 'error') {
                finish('宿主返回错误');
            }
        }
    });
    port.onDisconnect.addListener(() => {
        if (chrome.runtime.lastError !== undefined)
            finish('宿主连接失败');
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
            segmentUrls: e.segmentUrls ?? [],
            truncated: e.truncated === true,
        })),
    });
    setTimeout(() => finish('宿主无响应'), 3000);
}
