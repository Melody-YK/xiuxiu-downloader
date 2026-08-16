// 下载任务队列：并发限制 / 取消 / 进度事件（纯 Node，GUI 与测试共用）
import { EventEmitter } from 'node:events';
import { join, resolve } from 'node:path';
import { Downloader } from './downloader.mjs';
import { downloadMedia } from './pipeline.mjs';

export function isMediaUrl(url) {
  return /\.(m3u8|mpd)([?#]|$)/i.test(url);
}

export function defaultFileName(url) {
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

export class JobManager extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.maxConcurrent = opts.maxConcurrent ?? 2;
    this.tasks = new Map();
    this.queue = [];
    this.running = 0;
    this.nextId = 1;
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
      threads: task.threads ?? 8,
      limitBytesPerSec: task.limitBytesPerSec ?? undefined,
      status: 'queued',
      progress: null,
      phase: '',
      error: null,
      createdAt: Date.now(),
      finishedAt: null,
      abort: null,
    };
    this.tasks.set(id, t);
    this.queue.push(id);
    this.emit('event', { id, type: 'created', data: this.snapshotOf(t) });
    this.pump();
    return id;
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
          onPhase: (s) => {
            t.phase = s;
            this.emit('event', { id: t.id, type: 'status', data: this.snapshotOf(t) });
          },
          onProgress: (p) => {
            t.progress = { completed: p.done, total: p.total, unit: 'segments' };
            this.emit('event', { id: t.id, type: 'progress', data: this.snapshotOf(t) });
          },
        });
      } else {
        const dl = new Downloader({
          url: t.url,
          out: t.out,
          headers: t.headers,
          connections: t.threads,
          limitBytesPerSec: t.limitBytesPerSec,
          signal: abort.signal,
          fresh: true,
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
      if (abort.signal.aborted) t.status = 'canceled';
      else {
        t.status = 'error';
        t.error = err?.message ?? String(err);
      }
    }
    this.emit('event', { id: t.id, type: 'status', data: this.snapshotOf(t) });
  }
}


