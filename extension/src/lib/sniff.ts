// 纯逻辑模块：媒体请求判定、分类与捕获状态聚合。
// 同时被 background service worker（经 tsc 编译）与 Node 单元测试引用，
// 因此这里不得依赖 chrome.* 或任何浏览器专属 API。

export type MediaType = 'video' | 'audio' | 'hls' | 'dash' | 'ts';

export interface Classification {
  isMedia: boolean;
  /** 媒体大类；非媒体请求为 null */
  type: MediaType | null;
  /** URL 路径中的媒体扩展名（小写）；无匹配则为 null */
  ext: string | null;
}

/** 请求头透传信息（桌面端下载时带回 Cookie/Referer/UA） */
export interface RequestHeaders {
  cookie?: string;
  referer?: string;
  userAgent?: string;
}

export interface Entry {
  id: number;
  type: MediaType;
  url: string;
  tabId: number;
  pageUrl: string;
  pageTitle: string;
  contentType: string;
  ext: string | null;
  /** 请求头透传信息；未捕获为 null */
  headers?: RequestHeaders | null;
  /** 响应 Content-Length；未知为 null */
  size: number | null;
  /** 已观察到的分片请求数（仅 hls/dash/ts 条目有意义） */
  segmentCount: number;
  createdAt: number;
  lastSeenAt: number;
}

export interface CaptureState {
  nextId: number;
  entries: Entry[];
  /** 近期分片请求键（tabId|url），用于持久化去重 */
  segmentKeys: string[];
}

export interface Capture {
  url: string;
  tabId: number;
  contentType: string;
  type: MediaType;
  headers?: RequestHeaders;
  ext?: string | null;
  size?: number | null;
  pageUrl?: string;
  pageTitle?: string;
  /** 捕获时间戳（默认当前时间） */
  at?: number;
}

export type CaptureChange = 'added' | 'updated' | 'segmented' | 'ignored';

export interface CaptureResult {
  changed: CaptureChange;
  entry?: Entry;
}

/** chrome.storage 键名 */
export const STORAGE_KEY = 'capturedMedia';

/** 与 desktop/register-host.mjs 中的宿主名保持一致 */
export const NATIVE_HOST_NAME = 'com.downloader.sniffer';

/** 捕获列表条数上限（防止 storage 配额与 popup 渲染压力） */
export const MAX_ENTRIES = 200;
/** 近期分片键保留数量 */
const MAX_SEGMENT_KEYS = 800;

const VIDEO_EXTS = new Set(['mp4', 'webm', 'flv', 'm4v', 'mov', 'avi', 'mkv', 'f4v', '3gp', 'ogv']);
const AUDIO_EXTS = new Set(['m4a', 'mp3', 'aac', 'ogg', 'oga', 'wav', 'opus', 'flac']);
/** 流媒体分片扩展名 */
const SEGMENT_EXTS = new Set(['ts', 'm4s']);
const ALL_EXTS = new Set([...VIDEO_EXTS, ...AUDIO_EXTS, ...SEGMENT_EXTS, 'm3u8', 'mpd']);

/** 从 URL 路径提取媒体扩展名（只看 pathname，避免查询参数误判） */
export function extOf(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const m = /\.([A-Za-z0-9]{2,5})$/.exec(pathname);
  if (m === null) return null;
  const ext = (m[1] ?? '').toLowerCase();
  return ALL_EXTS.has(ext) ? ext : null;
}

/** 按扩展名 + Content-Type 双层判定媒体请求并分类 */
export function classify(url: string, contentType: string): Classification {
  const ct = contentType.toLowerCase();
  const ext = extOf(url);
  if (ext === 'm3u8' || ct.includes('mpegurl')) {
    return { isMedia: true, type: 'hls', ext: ext ?? 'm3u8' };
  }
  if (ext === 'mpd' || ct.includes('dash+xml')) {
    return { isMedia: true, type: 'dash', ext: ext ?? 'mpd' };
  }
  if (ext === 'ts' || ext === 'm4s') {
    return { isMedia: true, type: 'ts', ext };
  }
  if (ct.startsWith('video/') || ct === 'application/mp4' || (ext !== null && VIDEO_EXTS.has(ext))) {
    return { isMedia: true, type: 'video', ext };
  }
  if (ct.startsWith('audio/') || (ext !== null && AUDIO_EXTS.has(ext))) {
    return { isMedia: true, type: 'audio', ext };
  }
  return { isMedia: false, type: null, ext };
}

export interface HeaderLike {
  name?: string;
  value?: string;
}

/** 大小写不敏感地读取响应头 */
export function getHeader(headers: readonly HeaderLike[], name: string): string | null {
  const want = name.toLowerCase();
  for (const h of headers) {
    if (h.name !== undefined && h.name.toLowerCase() === want) {
      return h.value ?? null;
    }
  }
  return null;
}

export interface MediaElementLike {
  currentSrc?: string;
  src?: string;
  children?: ArrayLike<unknown>;
}

/** 从 <video>/<audio> 元素提取可下载的媒体地址（跳过 blob:/data:，兼容 MSE 占位） */
export function extractMediaUrl(el: MediaElementLike): string | null {
  const candidates: unknown[] = [el.currentSrc, el.src];
  if (el.children !== undefined) {
    for (let i = 0; i < el.children.length; i += 1) {
      const child = el.children[i];
      if (typeof child === 'object' && child !== null && 'src' in child) {
        candidates.push((child as { src?: unknown }).src);
      }
    }
  }
  for (const c of candidates) {
    if (typeof c === 'string' && c !== '' && /^https?:\/\//i.test(c)) return c;
  }
  return null;
}

/** 从 requestHeaders 提取透传所需的 Cookie/Referer/User-Agent */
export function extractRequestHeaders(headers: readonly HeaderLike[]): RequestHeaders {
  const out: RequestHeaders = {};
  const cookie = getHeader(headers, 'cookie');
  if (cookie !== null) out.cookie = cookie;
  const referer = getHeader(headers, 'referer');
  if (referer !== null) out.referer = referer;
  const ua = getHeader(headers, 'user-agent');
  if (ua !== null) out.userAgent = ua;
  return out;
}

export function createEmptyState(): CaptureState {
  return { nextId: 1, entries: [], segmentKeys: [] };
}

/**
 * 将一次媒体捕获应用到状态上：
 * - 同 tab 重复 URL：刷新 lastSeenAt（Range 分段请求、重播等会命中这里）
 * - ts/m4s 分片：聚合到所属 hls/dash 清单条目的 segmentCount，避免列表被刷屏
 * - 其余：新增条目，超出 MAX_ENTRIES 丢弃最旧
 */
export function applyCapture(state: CaptureState, cap: Capture): CaptureResult {
  const at = cap.at ?? Date.now();
  const key = cap.tabId + '|' + cap.url;

  const existing = state.entries.find((e) => e.tabId === cap.tabId && e.url === cap.url);
  if (existing !== undefined) {
    existing.lastSeenAt = at;
    if (cap.size != null && existing.size == null) existing.size = cap.size;
    if (cap.headers !== undefined) existing.headers = { ...existing.headers, ...cap.headers };
    moveToFront(state, existing);
    return { changed: 'updated', entry: existing };
  }

  if (cap.type === 'ts') {
    if (state.segmentKeys.includes(key)) {
      return { changed: 'ignored' };
    }
    state.segmentKeys.push(key);
    if (state.segmentKeys.length > MAX_SEGMENT_KEYS) state.segmentKeys.shift();

    const host = findSegmentHost(state, cap.tabId, cap.ext ?? 'ts');
    if (host !== null) {
      host.segmentCount += 1;
      host.lastSeenAt = at;
      moveToFront(state, host);
      return { changed: 'segmented', entry: host };
    }
    const standalone = state.entries.find((e) => e.tabId === cap.tabId && e.type === 'ts');
    if (standalone !== undefined) {
      standalone.segmentCount += 1;
      standalone.lastSeenAt = at;
      moveToFront(state, standalone);
      return { changed: 'segmented', entry: standalone };
    }
  }

  const entry: Entry = {
    id: state.nextId,
    type: cap.type,
    url: cap.url,
    tabId: cap.tabId,
    pageUrl: cap.pageUrl ?? '',
    pageTitle: cap.pageTitle ?? '',
    contentType: cap.contentType,
    ext: cap.ext ?? null,
    headers: cap.headers ?? null,
    size: cap.size ?? null,
    segmentCount: cap.type === 'ts' ? 1 : 0,
    createdAt: at,
    lastSeenAt: at,
  };
  state.nextId += 1;
  state.entries.unshift(entry);
  if (state.entries.length > MAX_ENTRIES) state.entries.length = MAX_ENTRIES;
  return { changed: 'added', entry };
}

/** m4s 优先归到 dash，ts 优先归到 hls（entries 保持最新在前） */
function findSegmentHost(state: CaptureState, tabId: number, segExt: string): Entry | null {
  const order: MediaType[] = segExt === 'm4s' ? ['dash', 'hls'] : ['hls', 'dash'];
  for (const t of order) {
    const found = state.entries.find((e) => e.tabId === tabId && e.type === t);
    if (found !== undefined) return found;
  }
  return null;
}

function moveToFront(state: CaptureState, entry: Entry): void {
  const i = state.entries.indexOf(entry);
  if (i > 0) {
    state.entries.splice(i, 1);
    state.entries.unshift(entry);
  }
}
