// 纯逻辑模块：媒体请求判定、分类与捕获状态聚合。
// 同时被 background service worker（经 tsc 编译）与 Node 单元测试引用，
// 因此这里不得依赖 chrome.* 或任何浏览器专属 API。
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
export function extOf(url) {
    let pathname;
    try {
        pathname = new URL(url).pathname;
    }
    catch {
        return null;
    }
    const m = /\.([A-Za-z0-9]{2,5})$/.exec(pathname);
    if (m === null)
        return null;
    const ext = (m[1] ?? '').toLowerCase();
    return ALL_EXTS.has(ext) ? ext : null;
}
/** 按扩展名 + Content-Type 双层判定媒体请求并分类 */
export function classify(url, contentType) {
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
/** 大小写不敏感地读取响应头 */
export function getHeader(headers, name) {
    const want = name.toLowerCase();
    for (const h of headers) {
        if (h.name !== undefined && h.name.toLowerCase() === want) {
            return h.value ?? null;
        }
    }
    return null;
}
/** 从 B站 playurl 地址提取视频标识（bvid/ep_id/aid） */
/** 分片流分组键：去掉查询参数与文件名尾部数字（seg_00001.mp4 → seg_.mp4）。
 *  无法安全分组（纯数字文件名等）返回 null。 */
export function segmentGroupKey(url) {
    try {
        const u = new URL(url);
        const base = u.pathname.split('/').filter(Boolean).pop() ?? '';
        const m = /^(.*?)(\d+)(\.[A-Za-z0-9]{2,5})$/.exec(base);
        if (m === null)
            return null;
        const stem = m[1] ?? '';
        if (stem === '' || /^[_.-]+$/.test(stem))
            return null;
        return (u.host + u.pathname.replace(/[^/]*$/, '') + stem + (m[3] ?? '')).toLowerCase();
    }
    catch {
        return null;
    }
}
/** 单个分片流条目允许保存的分片地址上限 */
export const MAX_SEGMENT_URLS = 5000;
export function bvidFromPlayurl(url) {
    const m = /[?&]bvid=([A-Za-z0-9]+)/.exec(url);
    if (m !== null)
        return m[1] ?? '';
    const e = /[?&]ep_id=(\d+)/.exec(url);
    if (e !== null)
        return 'ep' + (e[1] ?? '');
    const a = /[?&]aid=(\d+)/.exec(url);
    if (a !== null)
        return 'av' + (a[1] ?? '');
    return '';
}
/** 从 B站页面地址提取视频标识（/video/BVxxx、/ep123、/av123） */
/** B站页面尚未加载视频信息时的默认标签页标题（视为无效标题） */
export const BILI_DEFAULT_TITLE = '哔哩哔哩 (゜-゜)つロ 干杯~-bilibili';
/** 清理 B站标签页标题：去掉 _哔哩哔哩 起的各种后缀（含分区后缀如 _哔哩哔哩bilibili_王者荣耀）；默认标题视为空 */
export function cleanBiliTitle(t) {
    const s = t.replace(/_哔哩哔哩[\s\S]*$/, '').trim();
    return s === '' || s === BILI_DEFAULT_TITLE ? '' : s;
}
export function bvidFromPageUrl(url) {
    const m = /\/video\/(BV[0-9A-Za-z]+)/.exec(url);
    if (m !== null)
        return m[1] ?? '';
    const ep = /\/ep(\d+)/.exec(url);
    if (ep !== null)
        return 'ep' + (ep[1] ?? '');
    const av = /\/av(\d+)/.exec(url);
    if (av !== null)
        return 'av' + (av[1] ?? '');
    return '';
}
/** B站 CDN 的 m4s/ts 分片：playurl 未捕获时直接丢弃，避免刷屏的无效条目 */
export function isBiliSegment(url) {
    try {
        const h = new URL(url).host.toLowerCase();
        return /bilivideo\.com|bilibili\.com/.test(h) && /\.(m4s|ts)([?#]|$)/i.test(url);
    }
    catch {
        return false;
    }
}
/** 从 <video>/<audio> 元素提取可下载的媒体地址（跳过 blob:/data:，兼容 MSE 占位） */
export function extractMediaUrl(el) {
    const candidates = [el.currentSrc, el.src];
    if (el.children !== undefined) {
        for (let i = 0; i < el.children.length; i += 1) {
            const child = el.children[i];
            if (typeof child === 'object' && child !== null && 'src' in child) {
                candidates.push(child.src);
            }
        }
    }
    for (const c of candidates) {
        if (typeof c === 'string' && c !== '' && /^https?:\/\//i.test(c))
            return c;
    }
    return null;
}
/** 从 requestHeaders 提取透传所需的 Cookie/Referer/User-Agent */
export function extractRequestHeaders(headers) {
    const out = {};
    const cookie = getHeader(headers, 'cookie');
    if (cookie !== null)
        out.cookie = cookie;
    const referer = getHeader(headers, 'referer');
    if (referer !== null)
        out.referer = referer;
    const ua = getHeader(headers, 'user-agent');
    if (ua !== null)
        out.userAgent = ua;
    return out;
}
export function createEmptyState() {
    return { nextId: 1, entries: [], segmentKeys: [] };
}
/**
 * 将一次媒体捕获应用到状态上：
 * - 同 tab 重复 URL：刷新 lastSeenAt（Range 分段请求、重播等会命中这里）
 * - ts/m4s 分片：聚合到所属 hls/dash 清单条目的 segmentCount，避免列表被刷屏
 * - 其余：新增条目，超出 MAX_ENTRIES 丢弃最旧
 */
export function applyCapture(state, cap) {
    const at = cap.at ?? Date.now();
    const key = cap.tabId + '|' + cap.url;
    const existing = state.entries.find((e) => e.tabId === cap.tabId && (e.url === cap.url || (cap.dedupeKey !== undefined && e.dedupeKey === cap.dedupeKey)));
    if (existing !== undefined) {
        existing.lastSeenAt = at;
        if (cap.size != null && existing.size == null)
            existing.size = cap.size;
        if (cap.headers !== undefined)
            existing.headers = { ...existing.headers, ...cap.headers };
        // 新捕获带了有效标题时覆盖（如 B站页面标题晚于 playurl 请求更新）
        if (cap.pageTitle !== undefined && cap.pageTitle !== '')
            existing.pageTitle = cap.pageTitle;
        if (cap.dedupeKey !== undefined && existing.url !== cap.url) {
            // 同 dedupeKey 的旧条目换成最新 URL（B站 playurl 签名会过期，保留最新请求）
            existing.url = cap.url;
            existing.ext = cap.ext ?? existing.ext;
            if (cap.contentType !== '')
                existing.contentType = cap.contentType;
        }
        moveToFront(state, existing);
        return { changed: 'updated', entry: existing };
    }
    // 无清单站点的连续 mp4 分片：第二片出现时把首片条目标记为「分片流」
    if (cap.groupKey !== undefined && cap.groupKey !== null && (cap.type === 'video' || cap.type === 'audio')) {
        // 已有 HLS/DASH 清单时，任何同页的 MP4/fMP4 分片都只计数，不单独列出。
        const manifestHost = findSegmentHost(state, cap.tabId, cap.ext ?? 'mp4');
        if (manifestHost !== null) {
            manifestHost.segmentCount += 1;
            manifestHost.lastSeenAt = at;
            moveToFront(state, manifestHost);
            return { changed: 'segmented', entry: manifestHost };
        }
        const grouped = state.entries.find((e) => e.tabId === cap.tabId &&
            e.groupKey === cap.groupKey &&
            (e.type === 'video' || e.type === 'audio' || e.type === 'stream'));
        if (grouped !== undefined) {
            if (grouped.type === 'stream') {
                if (grouped.segmentUrls !== undefined && !grouped.segmentUrls.includes(cap.url)) {
                    if (grouped.segmentUrls.length >= MAX_SEGMENT_URLS)
                        grouped.truncated = true;
                    else
                        grouped.segmentUrls.push(cap.url);
                    grouped.segmentCount = grouped.segmentUrls.length;
                }
                grouped.lastSeenAt = at;
                moveToFront(state, grouped);
                return { changed: 'segmented', entry: grouped };
            }
            // 首片仍是普通条目：原地转换为分片流
            grouped.type = 'stream';
            grouped.segmentUrls = [grouped.url, cap.url];
            grouped.segmentCount = 2;
            grouped.lastSeenAt = at;
            moveToFront(state, grouped);
            return { changed: 'segmented', entry: grouped };
        }
    }
    if (cap.type === 'ts') {
        if (state.segmentKeys.includes(key)) {
            return { changed: 'ignored' };
        }
        state.segmentKeys.push(key);
        if (state.segmentKeys.length > MAX_SEGMENT_KEYS)
            state.segmentKeys.shift();
        // 已有 hls/dash 清单宿主：分片只计数，不进列表
        const host = findSegmentHost(state, cap.tabId, cap.ext ?? 'ts');
        if (host !== null) {
            host.segmentCount += 1;
            host.lastSeenAt = at;
            moveToFront(state, host);
            return { changed: 'segmented', entry: host };
        }
        // B站 CDN 的 m4s/ts 分片：无清单宿主时直接丢弃（单段无下载价值，签名短期失效，
        // 刷新页面后 playurl 会被捕获得到 dash 条目，届时分片自然归入）
        if (isBiliSegment(cap.url)) {
            return { changed: 'ignored' };
        }
        // 无清单宿主：按 groupKey 聚成「分片流」条目；完全无法归类的孤立分片直接丢弃
        // （孤立分片会刷屏，且多为短期签名地址，单独下载无意义、下载也会失败）
        if (cap.groupKey !== undefined && cap.groupKey !== null && cap.groupKey !== '') {
            let grouped = state.entries.find((e) => e.tabId === cap.tabId && e.groupKey === cap.groupKey && (e.type === 'stream' || e.type === 'ts'));
            if (grouped === undefined) {
                const entry = {
                    id: state.nextId,
                    type: 'stream',
                    url: cap.url,
                    tabId: cap.tabId,
                    pageUrl: cap.pageUrl ?? '',
                    pageTitle: cap.pageTitle ?? '',
                    contentType: cap.contentType,
                    ext: cap.ext ?? null,
                    headers: cap.headers ?? null,
                    dedupeKey: null,
                    groupKey: cap.groupKey,
                    size: cap.size ?? null,
                    segmentCount: 1,
                    createdAt: at,
                    lastSeenAt: at,
                };
                entry.segmentUrls = [cap.url];
                state.nextId += 1;
                state.entries.unshift(entry);
                if (state.entries.length > MAX_ENTRIES)
                    state.entries.length = MAX_ENTRIES;
                return { changed: 'added', entry };
            }
            if (grouped.type === 'ts') {
                // 旧版本遗留的独立 ts 条目：升级为分片流
                grouped.type = 'stream';
                grouped.segmentUrls = [grouped.url];
            }
            if (grouped.segmentUrls === undefined)
                grouped.segmentUrls = [];
            if (!grouped.segmentUrls.includes(cap.url)) {
                if (grouped.segmentUrls.length >= MAX_SEGMENT_URLS)
                    grouped.truncated = true;
                else
                    grouped.segmentUrls.push(cap.url);
                grouped.segmentCount = grouped.segmentUrls.length;
            }
            grouped.lastSeenAt = at;
            moveToFront(state, grouped);
            return { changed: 'segmented', entry: grouped };
        }
        return { changed: 'ignored' };
    }
    const entry = {
        id: state.nextId,
        type: cap.type,
        url: cap.url,
        tabId: cap.tabId,
        pageUrl: cap.pageUrl ?? '',
        pageTitle: cap.pageTitle ?? '',
        contentType: cap.contentType,
        ext: cap.ext ?? null,
        headers: cap.headers ?? null,
        dedupeKey: cap.dedupeKey ?? null,
        groupKey: cap.groupKey ?? null,
        size: cap.size ?? null,
        segmentCount: 0,
        createdAt: at,
        lastSeenAt: at,
    };
    state.nextId += 1;
    state.entries.unshift(entry);
    // m4s 可能先于 DASH/playurl 到达：先产生的临时分片流应归并到同页清单，
    // 否则每个音视频分组都会显示成“分片 ×1”。真正下载仍走 DASH/playurl 管线。
    if (entry.type === 'dash' || entry.type === 'hls') {
        const pending = state.entries.filter((e) => e !== entry && e.tabId === entry.tabId && e.type === 'stream' && (e.ext === 'm4s' || e.ext === 'mp4'));
        if (pending.length > 0) {
            entry.segmentCount += pending.reduce((sum, e) => sum + (e.segmentCount || e.segmentUrls?.length || 0), 0);
            for (const e of pending) {
                const i = state.entries.indexOf(e);
                if (i >= 0)
                    state.entries.splice(i, 1);
            }
        }
    }
    if (state.entries.length > MAX_ENTRIES)
        state.entries.length = MAX_ENTRIES;
    return { changed: 'added', entry };
}
/** fMP4/m4s 优先归到 DASH，TS 优先归到 HLS；普通 MP4 分片也按 DASH 优先。 */
function findSegmentHost(state, tabId, segExt) {
    const order = segExt === 'm4s' ? ['dash', 'hls'] : ['hls', 'dash'];
    for (const t of order) {
        const found = state.entries.find((e) => e.tabId === tabId && e.type === t);
        if (found !== undefined)
            return found;
    }
    return null;
}
function moveToFront(state, entry) {
    const i = state.entries.indexOf(entry);
    if (i > 0) {
        state.entries.splice(i, 1);
        state.entries.unshift(entry);
    }
}
