import { applyCapture, classify, createEmptyState, extOf, extractRequestHeaders, getHeader, NATIVE_HOST_NAME, STORAGE_KEY, } from './lib/sniff.js';
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
// ---- 请求头嗅探：onBeforeSendHeaders 只读观察（Cookie/Referer/UA 需 extraHeaders） ----
const headerCache = new Map();
chrome.webRequest.onBeforeSendHeaders.addListener((details) => {
    if (details.tabId < 0)
        return;
    const url = details.url ?? '';
    if (!/^https?:\/\//i.test(url))
        return;
    if (extOf(url) === null)
        return; // 仅缓存疑似媒体请求，避免全量开销
    const h = extractRequestHeaders(details.requestHeaders ?? []);
    if (h.cookie !== undefined || h.referer !== undefined || h.userAgent !== undefined) {
        headerCache.set(details.requestId, h);
        if (headerCache.size > 2000) {
            const oldest = headerCache.keys().next().value;
            if (oldest !== undefined)
                headerCache.delete(oldest);
        }
    }
}, { urls: ['<all_urls>'] }, ['requestHeaders', 'extraHeaders']);
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
        const reqHeaders = headerCache.get(details.requestId);
        if (reqHeaders !== undefined)
            headerCache.delete(details.requestId);
        const size = parseSize(getHeader(headers, 'content-length'));
        const page = await getPageInfo(details.tabId, details.initiator ?? '');
        const capture = {
            url,
            tabId: details.tabId,
            contentType,
            type: cls.type,
            ext: cls.ext,
            headers: reqHeaders,
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
// content script 的下载按钮：带上已捕获的请求头推送桌面端（GUI 自动建任务）
async function handleContentDownload(msg, sender, sendResponse) {
    try {
        const url = typeof msg.url === 'string' ? msg.url : '';
        if (!/^https?:\/\//i.test(url)) {
            sendResponse({ ok: false, error: '无效 URL' });
            return;
        }
        const tabId = sender.tab?.id ?? -1;
        const entry = state.entries.find((e) => e.tabId === tabId && e.url === url);
        const payload = {
            url,
            mediaType: entry?.type ?? (classify(url, '').type ?? 'video'),
            contentType: entry?.contentType ?? '',
            size: entry?.size ?? null,
            pageUrl: entry?.pageUrl ?? '',
            pageTitle: entry?.pageTitle ?? '',
            cookie: entry?.headers?.cookie ?? '',
            referer: entry?.headers?.referer ?? '',
            userAgent: entry?.headers?.userAgent ?? '',
        };
        const port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
        const ok = await new Promise((resolve) => {
            let done = false;
            const finish = (v) => {
                if (done)
                    return;
                done = true;
                resolve(v);
                try {
                    port.disconnect();
                }
                catch {
                    // 忽略
                }
            };
            port.onMessage.addListener((m) => {
                if (typeof m === 'object' && m !== null && m.type === 'ack')
                    finish(true);
            });
            port.onDisconnect.addListener(() => {
                if (chrome.runtime.lastError !== undefined)
                    finish(false);
            });
            port.postMessage({ type: 'capture', entries: [payload], autoDownload: true });
            setTimeout(() => finish(false), 3000);
        });
        sendResponse({ ok });
    }
    catch {
        sendResponse({ ok: false, error: '宿主未连接' });
    }
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
// ---- 消息：popup 清空 / content script 下载请求 ----
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (typeof message !== 'object' || message === null)
        return;
    const t = message.type;
    if (t === 'clear') {
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
        return;
    }
    if (t === 'content:download') {
        void handleContentDownload(message, sender, sendResponse);
        return true; // 异步响应
    }
});
