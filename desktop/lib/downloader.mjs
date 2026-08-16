// Phase 3：HTTP Range 多线程下载核心（纯 Node 实现，无第三方依赖）
// 能力：探测 → 分段规划 → 并发 Range 请求 → 动态切分（IDM 式）→ 断点续传 → 令牌桶限速 → 不支持 Range 时降级单线程
import { open, readFile, stat, unlink, writeFile } from 'node:fs/promises';

export const DEFAULT_CONNECTIONS = 8;
export const MIN_SEGMENT = 256 * 1024;
const RETRY_ATTEMPTS = 3;
const REPORT_INTERVAL = 200;
const SAVE_INTERVAL = 1000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class DownloadError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'DownloadError';
    this.code = code;
  }
}

// ---- 分段规划：把 [0, total-1] 切成 n 段，n 受 minSegment 约束 ----
export function planSegments(total, connections, minSegment = MIN_SEGMENT) {
  const n = Math.max(1, Math.min(connections, Math.ceil(total / minSegment)));
  const size = Math.floor(total / n);
  const segs = [];
  let start = 0;
  for (let i = 0; i < n; i += 1) {
    const end = i === n - 1 ? total - 1 : start + size - 1;
    segs.push({ start, end, cursor: start });
    start = end + 1;
  }
  return segs;
}

// 动态切分：把剩余最多的未完成段一分为二，返回新段（并入 segs）；无段可切返回 null
export function splitLargestUnfinished(segs, minSegment = MIN_SEGMENT) {
  let best = null;
  for (const s of segs) {
    const remaining = s.end - s.cursor + 1;
    if (remaining >= minSegment * 2 && (best === null || remaining > best.end - best.cursor + 1)) {
      best = s;
    }
  }
  if (best === null) return null;
  const mid = best.cursor + Math.floor((best.end - best.cursor + 1) / 2);
  const second = { start: mid, end: best.end, cursor: mid };
  best.end = mid - 1;
  segs.push(second);
  return second;
}

// ---- 探测：HEAD → 失败/不支持时用 1 字节 Range GET 兜底 ----
function parseLength(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parseContentRangeTotal(v) {
  if (v === null || v === undefined) return null;
  const m = /\/(\d+)$/.exec(v.trim());
  return m === null ? null : parseLength(m[1]);
}

export async function probe(url, headers, opts = {}) {
  const signal = opts.signal ?? null;
  const ac = new AbortController();
  const onAbort = () => ac.abort();
  if (signal !== null) signal.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ac.abort(), opts.timeoutMs ?? 20000);
  try {
    let res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow', signal: ac.signal });
    if (res.status === 405 || res.status === 501 || !res.ok) {
      // HEAD 不受支持：用 1 字节 Range GET 探测（不下载整文件）
      res = await fetch(url, { method: 'GET', headers: { ...headers, Range: 'bytes=0-0' }, redirect: 'follow', signal: ac.signal });
    }
    const h = res.headers;
    const supportsRange = (h.get('accept-ranges') ?? '').toLowerCase().includes('bytes');
    let total = parseLength(h.get('content-length'));
    if (res.status === 206) {
      const t = parseContentRangeTotal(h.get('content-range'));
      if (t !== null) total = t;
    }
    if (!res.ok && res.status !== 206) {
      throw new DownloadError('服务器返回 HTTP ' + res.status, 'PROBE_STATUS');
    }
    try {
      await res.body?.cancel();
    } catch {
      // 忽略
    }
    return {
      status: res.status,
      total,
      supportsRange: supportsRange || res.status === 206,
      finalUrl: res.url || url,
      contentType: h.get('content-type') ?? '',
    };
  } finally {
    clearTimeout(timer);
    if (signal !== null) signal.removeEventListener('abort', onAbort);
  }
}

// ---- 令牌桶限速（全局共享，跨所有连接） ----
export class RateLimiter {
  constructor(bytesPerSec) {
    this.rate = bytesPerSec;
    this.tokens = bytesPerSec; // 允许起步突发
    this.last = Date.now();
    this.chain = Promise.resolve();
  }

  acquire(bytes) {
    this.chain = this.chain.then(async () => {
      const now = Date.now();
      this.tokens = Math.min(this.rate, this.tokens + ((now - this.last) / 1000) * this.rate);
      this.last = now;
      const need = bytes - this.tokens;
      if (need > 0) {
        await sleep((need / this.rate) * 1000);
        this.tokens = 0;
        this.last = Date.now();
      } else {
        this.tokens -= bytes;
      }
    });
    return this.chain;
  }
}

// ---- 断点续传状态 ----
export async function loadState(metaPath, p) {
  try {
    const raw = JSON.parse(await readFile(metaPath, 'utf8'));
    if (raw.version !== 1) return null;
    if (raw.total !== p.total) return null;
    if (raw.url !== p.finalUrl) return null;
    if (!Array.isArray(raw.segments) || raw.segments.length === 0) return null;
    for (const s of raw.segments) {
      if (typeof s.start !== 'number' || typeof s.end !== 'number' || typeof s.cursor !== 'number') return null;
      if (s.cursor < s.start || s.cursor > s.end + 1) return null;
    }
    return raw.segments;
  } catch {
    return null;
  }
}

export class Downloader {
  constructor(opts) {
    this.url = opts.url;
    this.out = opts.out;
    this.headers = opts.headers ?? {};
    this.connections = opts.connections ?? DEFAULT_CONNECTIONS;
    this.minSegment = opts.minSegment ?? MIN_SEGMENT;
    this.limiter = opts.limitBytesPerSec != null && opts.limitBytesPerSec > 0
      ? new RateLimiter(opts.limitBytesPerSec)
      : null;
    this.fresh = opts.fresh ?? false;
    this.onProgress = opts.onProgress ?? (() => {});
    this.signal = opts.signal ?? null;
    this.metaPath = this.out + '.meta.json';
    this.state = null;
    this.total = null;
    this.completedBytes = 0;
    this.fallbackSingle = false;
    this.multiAbort = null;
    this.startedAt = 0;
    this.lastReportAt = 0;
    this.lastReportBytes = 0;
    this.lastSaveAt = 0;
  }

  async download() {
    this.startedAt = Date.now();
    const p = await probe(this.url, this.headers, { signal: this.signal });
    this.total = p.total;
    if (p.total === null || !p.supportsRange) {
      this.fallbackSingle = true;
      return this.downloadSingle(p, !this.fresh && p.total !== null);
    }
    try {
      return await this.downloadMulti(p);
    } catch (err) {
      await this.saveState().catch(() => {});
      throw err;
    }
  }

  async downloadMulti(p) {
    // 恢复或初始化分段
    let segments = null;
    if (!this.fresh) segments = await loadState(this.metaPath, p);
    if (segments === null) {
      segments = planSegments(p.total, this.connections, this.minSegment);
      await this.allocFile(p.total);
    } else {
      const st = await stat(this.out).catch(() => null);
      if (st === null || st.size !== p.total) {
        segments = planSegments(p.total, this.connections, this.minSegment);
        await this.allocFile(p.total);
      }
    }

    this.state = { version: 1, url: p.finalUrl, total: p.total, segments };
    this.completedBytes = segments.reduce((acc, s) => acc + (s.cursor - s.start), 0);
    this.multiAbort = new AbortController();
    const signal = this.signal !== null
      ? AbortSignal.any([this.signal, this.multiAbort.signal])
      : this.multiAbort.signal;

    const queue = segments.slice();
    const worker = async () => {
      for (;;) {
        if (signal.aborted) return;
        let seg = queue.shift();
        if (seg === undefined) seg = splitLargestUnfinished(segments, this.minSegment);
        if (seg === null) return;
        const fh = await open(this.out, 'r+');
        try {
          await this.downloadRange(fh, seg, signal);
        } finally {
          await fh.close().catch(() => {});
        }
      }
    };

    const workers = [];
    const nWorkers = Math.min(this.connections, segments.length);
    for (let i = 0; i < nWorkers; i += 1) workers.push(worker());

    const results = await Promise.allSettled(workers);
    const rejected = results.find((r) => r.status === 'rejected');
    if (rejected !== undefined) {
      const reason = rejected.reason;
      if (reason instanceof DownloadError && reason.code === 'NO_RANGE') {
        // 服务器中途忽略 Range：降级单线程重下
        this.fallbackSingle = true;
        await this.allocFile(p.total);
        await unlink(this.metaPath).catch(() => {});
        this.state = null;
        return this.downloadSingle(p, false);
      }
      throw reason;
    }
    if (segments.some((s) => s.cursor <= s.end)) {
      throw new DownloadError('分段未全部完成', 'INCOMPLETE');
    }
    this.reportProgress(true);
    await unlink(this.metaPath).catch(() => {});
    this.state = null;
    const elapsedMs = Date.now() - this.startedAt;
    return {
      bytes: p.total,
      total: p.total,
      elapsedMs,
      avgSpeed: p.total / (elapsedMs / 1000),
      connections: nWorkers,
      fallbackSingle: false,
    };
  }

  async downloadRange(fh, seg, signal) {
    let attempt = 0;
    while (seg.cursor <= seg.end) {
      if (signal.aborted) return;
      try {
        const start = seg.cursor;
        const end = seg.end;
        const headers = { ...this.headers, 'Accept-Encoding': 'identity', Range: 'bytes=' + start + '-' + end };
        const res = await fetch(this.url, { headers, redirect: 'follow', signal });
        if (res.status === 200) {
          try { await res.body?.cancel(); } catch { /* 忽略 */ }
          this.multiAbort?.abort();
          throw new DownloadError('服务器忽略 Range 请求（返回 200），降级单线程', 'NO_RANGE');
        }
        if (res.status !== 206) {
          try { await res.body?.cancel(); } catch { /* 忽略 */ }
          throw new DownloadError('Range 请求失败: HTTP ' + res.status, 'HTTP');
        }
        const reader = res.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          // 段边界可能在下载途中被动态切分收缩，只写入属于本段的部分，避免与新半段重叠
          const remaining = seg.end - seg.cursor + 1;
          if (remaining <= 0) {
            await reader.cancel().catch(() => {});
            break;
          }
          const n = Math.min(value.length, remaining);
          if (this.limiter !== null) await this.limiter.acquire(n);
          await fh.write(value, 0, n, seg.cursor);
          seg.cursor += n;
          this.completedBytes += n;
          this.reportProgress();
          this.saveStateSoon();
        }
        return;
      } catch (err) {
        if (signal.aborted || this.signal?.aborted) throw err;
        attempt += 1;
        if (attempt >= RETRY_ATTEMPTS) throw err;
        await sleep(250 * attempt);
      }
    }
  }

  async downloadSingle(p, allowResume) {
    let startFrom = 0;
    if (allowResume) {
      const st = await stat(this.out).catch(() => null);
      if (st !== null) startFrom = st.size;
    }
    const headers = { ...this.headers, 'Accept-Encoding': 'identity' };
    if (startFrom > 0) headers.Range = 'bytes=' + startFrom + '-';
    const res = await fetch(this.url, { headers, redirect: 'follow', signal: this.signal });
    if (!res.ok && res.status !== 206) {
      try { await res.body?.cancel(); } catch { /* 忽略 */ }
      throw new DownloadError('下载失败: HTTP ' + res.status, 'HTTP');
    }
    const resuming = res.status === 206;
    const fh = await open(this.out, resuming ? 'a' : 'w');
    try {
      let written = resuming ? startFrom : 0;
      const reader = res.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (this.limiter !== null) await this.limiter.acquire(value.length);
        await fh.write(value);
        written += value.length;
        this.completedBytes = written;
        this.reportProgress();
      }
      this.reportProgress(true);
      const elapsedMs = Date.now() - this.startedAt;
      return {
        bytes: written,
        total: this.total,
        elapsedMs,
        avgSpeed: written / (elapsedMs / 1000),
        connections: 1,
        fallbackSingle: true,
      };
    } finally {
      await fh.close().catch(() => {});
    }
  }

  async allocFile(total) {
    const fh = await open(this.out, 'w');
    try {
      await fh.truncate(total);
    } finally {
      await fh.close().catch(() => {});
    }
  }

  reportProgress(force = false) {
    const now = Date.now();
    const dt = now - this.lastReportAt;
    if (!force && this.lastReportAt !== 0 && dt < REPORT_INTERVAL) return;
    const speed = dt > 0 ? ((this.completedBytes - this.lastReportBytes) / dt) * 1000 : 0;
    this.lastReportAt = now;
    this.lastReportBytes = this.completedBytes;
    this.onProgress({ completed: this.completedBytes, total: this.total, speed });
  }

  saveStateSoon() {
    const now = Date.now();
    if (now - this.lastSaveAt < SAVE_INTERVAL) return;
    this.lastSaveAt = now;
    this.saveState().catch(() => {});
  }

  async saveState() {
    if (this.state === null) return;
    await writeFile(this.metaPath, JSON.stringify(this.state), 'utf8');
  }
}
