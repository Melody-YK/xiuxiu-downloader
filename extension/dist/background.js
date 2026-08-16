import { applyCapture, classify, createEmptyState, getHeader, STORAGE_KEY, } from './lib/sniff.js';
// ---- 状态管理：内存为唯一事实源，chrome.storage 为持久化镜像 ----
let state = createEmptyState();
/** SW 生命周期内的快速去重（持久化去重依赖 state.entries / segmentKeys） */
const memoryDedupe = new Set();
let writeTimer = null;
let pendingWrite = Promise.resolve();
const loaded = loadState();
async function loadState() {
    try {
        const stored = await chrome.storage.local.get(STORAGE_KEY);
        const raw = stored[STORAGE_KEY];
        if (isCaptureState(raw)) {
            state = { nextId: raw.nextId, entries: raw.entries, segmentKeys: raw.segmentKeys };
        }
    }
    catch (err) {
        console.warn('[sniffer] 读取捕获记录失败', err);
    }
    for (const e of state.entries)
        memoryDedupe.add(keyOf(e.tabId, e.url));
}
function isCaptureState(v) {
    if (typeof v !== 'object' || v === null)
        return false;
    const o = v;
    return typeof o['nextId'] === 'number' && Array.isArray(o['entries']) && Array.isArray(o['segmentKeys']);
}
function keyOf(tabId, url) {
    return String(tabId) + '|' + url;
}
/** 防抖持久化：HLS 分片请求密集，不能每次都全量写 storage */
function schedulePersist() {
    if (writeTimer !== null)
        return;
    writeTimer = setTimeout(() => {
        writeTimer = null;
        const snapshot = state;
        pendingWrite = pendingWrite.then(async () => {
            try {
                await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
            }
            catch (err) {
                console.warn('[sniffer] 保存捕获记录失败', err);
            }
        });
    }, 300);
}
// ---- 网络嗅探：MV3 中 webRequest 只读观察 ----
chrome.webRequest.onResponseStarted.addListener((details) => {
    void handleResponse(details);
}, { urls: ['<all_urls>'] }, ['responseHeaders']);
async function handleResponse(details) {
    try {
        await loaded;
        // 非 2xx/3xx 或非页面标签请求（如其他扩展）不处理
        if (details.statusCode >= 400 || details.tabId < 0)
            return;
        const url = details.url ?? '';
        if (!/^https?:\/\//i.test(url))
            return;
        const headers = details.responseHeaders ?? [];
        const contentType = getHeader(headers, 'content-type') ?? '';
        const cls = classify(url, contentType);
        if (!cls.isMedia || cls.type === null)
            return;
        const dedupeKey = keyOf(details.tabId, url);
        if (memoryDedupe.has(dedupeKey))
            return;
        memoryDedupe.add(dedupeKey);
        if (memoryDedupe.size > 20000)
            memoryDedupe.clear();
        const size = parseSize(getHeader(headers, 'content-length'));
        const page = await getPageInfo(details.tabId, details.initiator ?? '');
        const capture = {
            url,
            tabId: details.tabId,
            contentType,
            type: cls.type,
            ext: cls.ext,
            size,
            pageUrl: page.url,
            pageTitle: page.title,
        };
        const result = applyCapture(state, capture);
        if (result.changed !== 'ignored')
            schedulePersist();
        if (result.changed === 'added') {
            console.log('[sniffer] 捕获', result.entry?.type, url.slice(0, 140));
        }
    }
    catch (err) {
        console.warn('[sniffer] 处理响应失败', err);
    }
}
function parseSize(v) {
    if (v === null || v === '')
        return null;
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
}
async function getPageInfo(tabId, fallbackUrl) {
    try {
        const tab = await chrome.tabs.get(tabId);
        return { url: tab.url ?? fallbackUrl, title: tab.title ?? '' };
    }
    catch {
        return { url: fallbackUrl, title: '' };
    }
}
// ---- popup 消息 ----
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (typeof message === 'object' && message !== null && message.type === 'clear') {
        state = createEmptyState();
        memoryDedupe.clear();
        pendingWrite = pendingWrite.then(async () => {
            try {
                await chrome.storage.local.remove(STORAGE_KEY);
            }
            catch (err) {
                console.warn('[sniffer] 清空捕获记录失败', err);
            }
        });
        sendResponse({ ok: true });
    }
});
