// 下载任务队列：并发限制 / 取消 / 进度事件（纯 Node，GUI 与测试共用）
import { EventEmitter } from 'node:events';
import { unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { Downloader } from './downloader.mjs';
import { downloadMedia } from './pipeline.mjs';
import { isBiliPlayurlUrl } from './bili.mjs';

export function isMediaUrl(url) {
  return /\.(m3u8|mpd)([?#]|$)/i.test(url) || isBiliPlayurlUrl(url);
}

export function defaultFileName(url) {
  if (isBiliPlayurlUrl(url)) {
    const m = /[?&]bvid=([A-Za-z0-9]+)/.exec(url);
    if (m !== null && m[1]) return 'bilibili_' + m[1] + '.mp4';
    return 'bilibili_video.mp4';
  }
  try {
    const seg = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (seg !== undefined && seg !== '') {
      try {
        return decodeURIComponent(seg);
      } catch {
        return seg;
      }
    }
  } catch {
    // 忽略
  }
  return 'download.bin';
}

export function ensureMp4Ext(name) {
  return /\.mp4$/i.test(name) ? name : name + '.mp4';
}

/** 删除任务产出的文件（主文件 + 可能的续传进度文件），不存在则忽略 */
export async function deleteTaskFiles(out) {
  if (typeof out !== 'string' || out === '') return;
  await unlink(out).catch(() => {});
  await unlink(out + '.meta.json').catch(() => {});
}

/** 文件名清洗：去掉 Windows 非法字符，限长，防空白 */
export function sanitizeFileName(name) {
  let s = String(name ?? '').replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim();
  if (s.length > 80) s = s.slice(0, 80);
  s = s.replace(/[. ]+$/, '');
  return s === '' ? 'download' : s;
}

export class JobManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.tasks = new Map();
    this.queue = [];
    this.running = 0;
    this.nextId = 1;
  }

  /** 运行中调整全局并发数（1-8），立即生效 */
  setMaxConcurrent(n) {
    this.maxConcurrent = Math.max(1, Math.min(8, Math.round(Number(n) || 1)));
    this.pump();
  }

  add(task) {
    const id = this.nextId;
    this.nextId += 1;
    const isMedia = task.kind === 'media' || (task.kind === 'auto' && isMediaUrl(task.url));
    let name;
    if (task.out !== undefined && task.out !== null && task.out !== '') {
      name = resolve(task.out);
    } else {
      const base = isMedia ? ensureMp4Ext(defaultFileName(task.url)) : defaultFileName(task.url);
      name = task.outDir !== undefined && task.outDir !== null ? join(resolve(task.outDir), base) : resolve(base);
    }
    const t = {
      id,
      url: task.url,
      out: name,
      headers: task.headers ?? {},
      kind: task.kind ?? 'auto',
      isMedia,
      streamUrls: Array.isArray(task.streamUrls) ? task.streamUrls : undefined,
      threads: task.threads ?? 8,
      adaptiveConnections: task.adaptiveConnections === true,
      limitBytesPerSec: task.limitBytesPerSec ?? undefined,
      status: 'queued',
      progress: null,
      phase: '',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      abort: null,
      pausedByUser: false,
    };
    this.tasks.set(id, t);
    this.queue.push(id);
    this.emit('event', { id, type: 'created', data: this.snapshotOf(t) });
    this.pump();
    return id;
  }

  remove(id) {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status === 'running' && t.abort !== null) t.abort.abort();
    if (t.status === 'queued') this.queue = this.queue.filter((x) => x !== id);
    this.tasks.delete(id);
    this.emit('event', { id, type: 'removed', data: { id } });
    return true;
  }

  /** 暂停：运行中→中止并标记 paused（保留续传点）；排队中→直接移出队列 */
  pause(id) {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status === 'running') {
      if (t.abort !== null) {
        t.pausedByUser = true;
        t.abort.abort();
      }
      return true;
    }
    if (t.status === 'queued') {
      this.queue = this.queue.filter((x) => x !== id);
      t.status = 'paused';
      t.finishedAt = Date.now();
      this.emit('event', { id, type: 'status', data: this.snapshotOf(t) });
      return true;
    }
    return false;
  }

  /** 继续：暂停/失败任务重新入队（.meta.json 续传点保留，自动续传） */
  resume(id) {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status !== 'paused' && t.status !== 'error' && t.status !== 'canceled') return false;
    t.status = 'queued';
    t.error = null;
    t.phase = '';
    t.progress = null;
    t.finishedAt = null;
    t.pausedByUser = false;
    this.queue.push(id);
    this.emit('event', { id, type: 'status', data: this.snapshotOf(t) });
    this.pump();
    return true;
  }

  cancel(id) {
    const t = this.tasks.get(id);
    if (t === undefined) return false;
    if (t.status === 'queued') {
      this.queue = this.queue.filter((x) => x !== id);
      t.status = 'canceled';
      t.finishedAt = Date.now();
      this.emit('event', { id, type: 'status', data: this.snapshotOf(t) });
      return true;
    }
    if (t.status === 'running' && t.abort !== null) t.abort.abort();
    return true;
  }

  getSnapshot() {
    return Array.from(this.tasks.values()).map((t) => this.snapshotOf(t));
  }

  /** 恢复历史记录（重启后展示已完成/失败/取消的任务，不重新排队） */
  restoreHistory(items) {
    for (const it of items ?? []) {
      if (typeof it?.id !== 'number' || this.tasks.has(it.id)) continue;
      const t = {
        id: it.id,
        url: it.url ?? '',
        out: it.out ?? '',
        headers: it.headers !== undefined && it.headers !== null && typeof it.headers === 'object' ? it.headers : {},
        kind: it.kind ?? 'auto',
        isMedia: it.isMedia === true,
        streamUrls: Array.isArray(it.streamUrls) ? it.streamUrls : undefined,
        threads: typeof it.threads === 'number' ? it.threads : 8,
        adaptiveConnections: it.adaptiveConnections === true,
        limitBytesPerSec: typeof it.limitBytesPerSec === 'number' ? it.limitBytesPerSec : undefined,
        status: it.status === 'error' || it.status === 'canceled' || it.status === 'paused' ? it.status : 'done',
        progress: null,
        phase: it.phase ?? '',
        error: it.error ?? null,
        createdAt: it.createdAt ?? Date.now(),
        finishedAt: it.finishedAt ?? null,
        abort: null,
        pausedByUser: false,
      };
      this.tasks.set(t.id, t);
      this.nextId = Math.max(this.nextId, t.id + 1);
    }
  }

  snapshotOf(t) {
    return {
      id: t.id,
      url: t.url,
      out: t.out,
      kind: t.kind,
      isMedia: t.isMedia,
      status: t.status,
      progress: t.progress,
      phase: t.phase,
      error: t.error,
      createdAt: t.createdAt,
      finishedAt: t.finishedAt,
      headers: t.headers,
      threads: t.threads,
      streamUrls: t.streamUrls,
      limitBytesPerSec: t.limitBytesPerSec,
      adaptiveConnections: t.adaptiveConnections,
    };
  }

  pump() {
    while (this.running < this.maxConcurrent && this.queue.length > 0) {
      const id = this.queue.shift();
      const t = this.tasks.get(id);
      if (t === undefined) continue;
      this.running += 1;
      this.run(t).finally(() => {
        this.running -= 1;
        this.pump();
      });
    }
  }

  async run(t) {
    const abort = new AbortController();
    t.abort = abort;
    t.status = 'running';
    this.emit('event', { id: t.id, type: 'status', data: this.snapshotOf(t) });
    try {
      if (t.isMedia) {
        await downloadMedia({
          url: t.url,
          out: t.out,
          headers: t.headers,
          connections: t.threads,
          keep: false,
          signal: abort.signal,
          streamUrls: t.streamUrls,
          onPhase: (s) => {
            t.phase = s;
            this.emit('event', { id: t.id, type: 'status', data: this.snapshotOf(t) });
          },
          onProgress: (p) => {
            t.progress = {
              completed: p.completed ?? p.done ?? 0,
              total: p.total ?? null,
              speed: p.speed ?? undefined,
              unit: p.unit ?? 'segments',
            };
            this.emit('event', { id: t.id, type: 'progress', data: this.snapshotOf(t) });
          },
        });
      } else {
        // 不强制 fresh：.meta.json 存在时自动续传（暂停/继续、断点恢复的关键）
        const dl = new Downloader({
          url: t.url,
          out: t.out,
          headers: t.headers,
          connections: t.threads,
          limitBytesPerSec: t.limitBytesPerSec,
          adaptiveConnections: t.adaptiveConnections,
          signal: abort.signal,
          onProgress: (p) => {
            t.progress = { completed: p.completed, total: p.total, speed: p.speed, unit: 'bytes' };
            this.emit('event', { id: t.id, type: 'progress', data: this.snapshotOf(t) });
          },
        });
        await dl.download();
      }
      t.status = 'done';
      t.finishedAt = Date.now();
      t.progress = null;
    } catch (err) {
      t.finishedAt = Date.now();
      if (abort.signal.aborted) t.status = t.pausedByUser ? 'paused' : 'canceled';
      else {
        t.status = 'error';
        t.error = err?.message ?? String(err);
      }
      t.pausedByUser = false;
    }
    this.emit('event', { id: t.id, type: 'status', data: this.snapshotOf(t) });
  }
}


