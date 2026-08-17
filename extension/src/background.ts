import {
  applyCapture,
  bvidFromPageUrl,
  bvidFromPlayurl,
  classify,
  cleanBiliTitle,
  createEmptyState,
  extOf,
  extractRequestHeaders,
  getHeader,
  NATIVE_HOST_NAME,
  segmentGroupKey,
  STORAGE_KEY,
  type Capture,
  type CaptureState,
  type RequestHeaders,
} from './lib/sniff.js';

// ---- 状态管理：内存为唯一事实源，chrome.storage 为持久化镜像 ----
let state: CaptureState = createEmptyState();
/** SW 生命周期内的快速去重（持久化去重依赖 state.entries / segmentKeys） */
const memoryDedupe = new Set<string>();
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let pendingWrite: Promise<void> = Promise.resolve();
const loaded = loadState();

/** 捕获条目生命周期：超过该时长未再出现的条目自动清理 */
const ENTRY_TTL = 2 * 60 * 60 * 1000;

async function loadState(): Promise<void> {
  try {
    const stored = await chrome.storage.local.get(STORAGE_KEY);
    const raw: unknown = stored[STORAGE_KEY];
    if (isCaptureState(raw)) {
      const now = Date.now();
      state = {
        nextId: raw.nextId,
        entries: raw.entries.filter((e) => now - (e.lastSeenAt ?? e.createdAt ?? now) < ENTRY_TTL),
        segmentKeys: raw.segmentKeys,
      };
    }
  } catch (err) {
    console.warn('[sniffer] 读取捕获记录失败', err);
  }
  for (const e of state.entries) memoryDedupe.add(keyOf(e.tabId, e.url));
}

function isCaptureState(v: unknown): v is CaptureState {
  if (typeof v !== 'object' || v === null) return false;
  const o = v as Record<string, unknown>;
  return typeof o['nextId'] === 'number' && Array.isArray(o['entries']) && Array.isArray(o['segmentKeys']);
}

function keyOf(tabId: number, url: string): string {
  return String(tabId) + '|' + url;
}


/** 防抖持久化：HLS 分片请求密集，不能每次都全量写 storage */
function schedulePersist(): void {
  if (writeTimer !== null) return;
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const snapshot = state;
    pendingWrite = pendingWrite.then(async () => {
      try {
        await chrome.storage.local.set({ [STORAGE_KEY]: snapshot });
      } catch (err) {
        console.warn('[sniffer] 保存捕获记录失败', err);
      }
    });
  }, 300);
}

// ---- 请求头嗅探：onBeforeSendHeaders 只读观察（Cookie/Referer/UA 需 extraHeaders） ----
/** B站播放地址接口（无媒体扩展名，但必须透传请求头；含 WBI 签名路径） */
const BILI_PLAYURL_RE = /bilibili\.com\/(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/playurl)/i;
const headerCache = new Map<string, RequestHeaders>();
/** URL 级请求头（tabId|url），供 hook 层按 URL 补全透传头 */
const headersByUrl = new Map<string, RequestHeaders>();

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (details.tabId < 0) return;
    const url = details.url ?? '';
    if (!/^https?:\/\//i.test(url)) return;
    if (extOf(url) === null && !BILI_PLAYURL_RE.test(url)) return; // 仅缓存疑似媒体请求，避免全量开销
    const h = extractRequestHeaders(details.requestHeaders ?? []);
    if (h.cookie !== undefined || h.referer !== undefined || h.userAgent !== undefined) {
      headerCache.set(details.requestId, h);
      headersByUrl.set(keyOf(details.tabId, url), h);
      if (headerCache.size > 2000) {
        const oldest = headerCache.keys().next().value;
        if (oldest !== undefined) headerCache.delete(oldest);
      }
      if (headersByUrl.size > 2000) {
        const oldest = headersByUrl.keys().next().value;
        if (oldest !== undefined) headersByUrl.delete(oldest);
      }
    }
  },
  { urls: ['<all_urls>'] },
  ['requestHeaders', 'extraHeaders'],
);

// ---- 网络嗅探：MV3 中 webRequest 只读观察 ----
chrome.webRequest.onResponseStarted.addListener(
  (details) => {
    void handleResponse(details);
  },
  { urls: ['<all_urls>'] },
  ['responseHeaders'],
);

async function handleResponse(details: chrome.webRequest.OnResponseStartedDetails): Promise<void> {
  try {
    await loaded;
    // 非 2xx/3xx 或非页面标签请求（如其他扩展）不处理
    if (details.statusCode >= 400 || details.tabId < 0) return;
    const url = details.url ?? '';
    if (!/^https?:\/\//i.test(url)) return;

    const headers = details.responseHeaders ?? [];
    const contentType = getHeader(headers, 'content-type') ?? '';
    const isBiliPlayurl = BILI_PLAYURL_RE.test(url);
    const cls = classify(url, contentType);
    // webRequest 兜底：B站 playurl 接口无媒体扩展名，单独识别（不依赖页面 Hook）
    if (!isBiliPlayurl && (!cls.isMedia || cls.type === null)) return;

    const dedupeKey = keyOf(details.tabId, url);
    if (memoryDedupe.has(dedupeKey)) return;
    memoryDedupe.add(dedupeKey);
    if (memoryDedupe.size > 20000) memoryDedupe.clear();

    const reqHeaders = headerCache.get(details.requestId);
    if (reqHeaders !== undefined) headerCache.delete(details.requestId);

    const size = parseSize(getHeader(headers, 'content-length'));
    const page = await getPageInfo(details.tabId, details.initiator ?? '');
    const bvid = isBiliPlayurl ? bvidFromPlayurl(url) : '';
    let pageTitle = isBiliPlayurl ? cleanBiliTitle(page.title) : page.title;
    if (isBiliPlayurl && pageTitle !== '') {
      // 只给「当前页面视频」的 playurl 贴标题；侧栏预览视频（bvid 与页面不符）不贴，避免张冠李戴
      const tabBvid = bvidFromPageUrl(page.url);
      if (tabBvid === '' || bvid === '' || tabBvid !== bvid) pageTitle = '';
    }

    const capture: Capture = {
      url,
      tabId: details.tabId,
      contentType,
      type: isBiliPlayurl ? 'dash' : (cls.type ?? 'video'),
      ext: cls.ext,
      headers: reqHeaders,
      dedupeKey: isBiliPlayurl ? 'bili:' + (bvid !== '' ? bvid : 'playurl') : undefined,
      groupKey: !isBiliPlayurl ? segmentGroupKey(url) : null,
      size,
      pageUrl: page.url,
      pageTitle,
    };
    const result = applyCapture(state, capture);
    if (result.changed !== 'ignored') schedulePersist();
    if (result.changed === 'added') {
      console.log('[sniffer] 捕获', result.entry?.type, url.slice(0, 140));
    }
  } catch (err) {
    console.warn('[sniffer] 处理响应失败', err);
  }
}

function parseSize(v: string | null): number | null {
  if (v === null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

// 向页面主世界注入 fetch/XHR 钩子（第 3 层捕获，B站/YouTube 等 MSE 站点）
function injectPageHook(sender: chrome.runtime.MessageSender): void {
  const tabId = sender.tab?.id;
  if (tabId === undefined) return;
  const frameId = sender.frameId ?? 0;
  chrome.scripting
    .executeScript({ target: { tabId, frameIds: [frameId] }, world: 'MAIN', files: ['page-hook.js'] })
    .catch((err) => {
      console.warn('[sniffer] hook 注入失败', err);
    });
}

// hook 层捕获的动态媒体 URL：分类入库（尽量补全请求头）
async function applyHookUrl(
  url: string,
  sender: chrome.runtime.MessageSender,
  bvid?: string,
  title?: string,
): Promise<void> {
  try {
    await loaded;
    if (!/^https?:\/\//i.test(url)) return;
    const tabId = sender.tab?.id ?? -1;
    if (tabId < 0) return;
    const isBili = BILI_PLAYURL_RE.test(url);
    const cls = classify(url, '');
    if (!isBili && (!cls.isMedia || cls.type === null)) return;
    const key = keyOf(tabId, url);
    const headers = headersByUrl.get(key);
    if (headers !== undefined) headersByUrl.delete(key);
    const bid = isBili ? (bvid !== undefined && bvid !== '' ? bvid : bvidFromPlayurl(url) || 'playurl') : '';
    const result = applyCapture(state, {
      url,
      tabId,
      contentType: '',
      type: isBili ? 'dash' : (cls.type ?? 'video'),
      ext: cls.ext,
      headers,
      dedupeKey: isBili ? 'bili:' + bid : undefined,
      groupKey: !isBili ? segmentGroupKey(url) : null,
      pageTitle: isBili ? (title ?? '') : undefined,
    });
    if (result.changed !== 'ignored') schedulePersist();
    if (result.changed === 'added') {
      console.log('[sniffer] hook 捕获', result.entry?.type, url.slice(0, 120));
    }
  } catch (err) {
    console.warn('[sniffer] hook 处理失败', err);
  }
}

// content script 的下载按钮：带上已捕获的请求头推送桌面端（GUI 自动建任务）
async function handleContentDownload(
  msg: { url?: unknown },
  sender: chrome.runtime.MessageSender,
  sendResponse: (resp: { ok: boolean; error?: string }) => void,
): Promise<void> {
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
    const nativeError = await tryNativeSend([payload], true);
    if (nativeError === null) {
      sendResponse({ ok: true });
      return;
    }
    // 原生通道失败：直连桌面端本地端口兜底
    try {
      const res = await fetch(GUI_INGEST_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'capture', entries: [payload], autoDownload: true }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      sendResponse({ ok: true });
      return;
    } catch {
      sendResponse({ ok: false, error: nativeError + '；直连桌面端失败，请先启动嗅嗅下载器' });
    }
  } catch {
    sendResponse({ ok: false, error: '发送失败' });
  }
}

const GUI_INGEST_URL = 'http://127.0.0.1:17321/ingest';

/** 通过原生消息发送捕获；成功返回 null，失败返回可读原因 */
function tryNativeSend(entries: unknown[], autoDownload: boolean): Promise<string | null> {
  return new Promise((resolve) => {
    let port: chrome.runtime.Port;
    try {
      port = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    } catch {
      resolve('宿主未注册');
      return;
    }
    let done = false;
    const finish = (v: string | null): void => {
      if (done) return;
      done = true;
      resolve(v);
      try {
        port.disconnect();
      } catch {
        // 忽略
      }
    };
    port.onMessage.addListener((m: unknown) => {
      if (typeof m === 'object' && m !== null && (m as { type?: unknown }).type === 'ack') finish(null);
    });
    port.onDisconnect.addListener(() => {
      if (chrome.runtime.lastError !== undefined) {
        finish('宿主连接失败: ' + (chrome.runtime.lastError.message ?? '未知错误'));
      } else {
        finish('宿主连接中断');
      }
    });
    port.postMessage({ type: 'capture', entries, autoDownload });
    setTimeout(() => finish('宿主无响应'), 3000);
  });
}

async function getPageInfo(tabId: number, fallbackUrl: string): Promise<{ url: string; title: string }> {
  try {
    const tab = await chrome.tabs.get(tabId);
    return { url: tab.url ?? fallbackUrl, title: tab.title ?? '' };
  } catch {
    return { url: fallbackUrl, title: '' };
  }
}

// ---- 消息：popup 清空 / content script 下载请求 ----
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (typeof message !== 'object' || message === null) return;
  const t = (message as { type?: unknown }).type;
  if (t === 'clear') {
    state = createEmptyState();
    memoryDedupe.clear();
    pendingWrite = pendingWrite.then(async () => {
      try {
        await chrome.storage.local.remove(STORAGE_KEY);
      } catch (err) {
        console.warn('[sniffer] 清空捕获记录失败', err);
      }
    });
    sendResponse({ ok: true });
    return;
  }
  if (t === 'content:download') {
    void handleContentDownload(message as { url?: unknown }, sender, sendResponse);
    return true; // 异步响应
  }
  if (t === 'hook:inject') {
    injectPageHook(sender);
    sendResponse({ ok: true });
    return;
  }
  if (t === 'entry:title') {
    const m = message as { url?: unknown; title?: unknown };
    const url = typeof m.url === 'string' ? m.url : '';
    const title = typeof m.title === 'string' ? m.title : '';
    if (url !== '' && title !== '') {
      const e = state.entries.find((x) => x.url === url);
      if (e !== undefined) {
        e.pageTitle = title;
        schedulePersist();
      }
    }
    sendResponse({ ok: true });
    return;
  }
  if (t === 'entry:remove') {
    const url = typeof (message as { url?: unknown }).url === 'string' ? ((message as { url?: string }).url ?? '') : '';
    if (url !== '') {
      const removed = state.entries.filter((e) => e.url === url);
      const removedGroups = new Set(removed.map((e) => e.groupKey).filter((v): v is string => typeof v === 'string' && v !== ''));
      state.entries = state.entries.filter((e) => e.url !== url && !(e.groupKey !== undefined && e.groupKey !== null && removedGroups.has(e.groupKey)));
      // 删除分片流后清掉相关持久化分片键，否则相同视频重新播放仍会被判为重复。
      const removedUrls = new Set(removed.flatMap((e) => e.segmentUrls ?? [e.url]));
      state.segmentKeys = state.segmentKeys.filter((k) => ![...removedUrls].some((u) => k.endsWith('|' + u)));
      // 内存去重只服务于当前请求生命周期；删除后清空它不会影响 state.entries 的持久化去重。
      memoryDedupe.clear();
      schedulePersist();
    }
    sendResponse({ ok: true });
    return;
  }
  if (t === 'hook:url') {
    const m = message as { url?: unknown; bvid?: unknown; title?: unknown };
    const url = typeof m.url === 'string' ? m.url : '';
    void applyHookUrl(url, sender, typeof m.bvid === 'string' ? m.bvid : undefined, typeof m.title === 'string' ? m.title : undefined);
    sendResponse({ ok: true });
    return;
  }
});
