import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Downloader,
  RateLimiter,
  loadState,
  planSegments,
  sleep,
  splitLargestUnfinished,
} from '../lib/downloader.mjs';

const TMP = join(tmpdir(), 'dl-test-' + process.pid);

function patternByte(pos) {
  return (pos * 31 + 7) & 0xff;
}

const hashCache = new Map();
function expectedHash(size) {
  let h = hashCache.get(size);
  if (h === undefined) {
    const hasher = createHash('sha256');
    const chunk = Buffer.allocUnsafe(1024 * 1024);
    for (let pos = 0; pos < size; pos += chunk.length) {
      const len = Math.min(chunk.length, size - pos);
      for (let i = 0; i < len; i += 1) chunk[i] = patternByte(pos + i);
      hasher.update(chunk.subarray(0, len));
    }
    h = hasher.digest('hex');
    hashCache.set(size, h);
  }
  return h;
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function parseRange(h, size) {
  if (h === undefined) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(h);
  if (m === null) return null;
  let start = m[1] === '' ? null : Number(m[1]);
  let end = m[2] === '' ? null : Number(m[2]);
  if (start === null && end === null) return null;
  if (start === null) {
    start = Math.max(0, size - end);
    end = size - 1;
  }
  if (end === null || end >= size) end = size - 1;
  if (start >= size || start > end) return null;
  return { start, end };
}

function startServer(opts) {
  const {
    size,
    chunkSize = 64 * 1024,
    delayPerChunkMs = 0,
    rangeDelayMs = null, // (start) => ms：按请求起始位置定制延迟，用于构造非对称场景
    noRange = false,
    advertiseRangeButIgnore = false,
    dropAfter = 0, // 每个请求服务超过该字节数后断开连接（>0 生效）
  } = opts;
  let active = 0;
  let maxActive = 0;

  const server = createServer((req, res) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    // 客户端主动中断（取消任务/降级重下）时避免未捕获的 EPIPE/ECONNRESET
    res.on('error', () => {});
    req.on('error', () => {});
    res.on('close', () => {
      active -= 1;
    });
    const isHead = req.method === 'HEAD';

    const streamRange = async (res2, start, len) => {
      const delayMs = rangeDelayMs !== null ? rangeDelayMs(start) : delayPerChunkMs;
      let pos = start;
      let served = 0;
      const chunk = Buffer.allocUnsafe(Math.min(chunkSize, 1024 * 1024));
      const closed = new Promise((resolve) => res2.once('close', resolve));
      for (;;) {
        // 客户端中断后 socket 已销毁：停止写入，避免 await drain 永久挂起
        if (res2.destroyed || res2.writableEnded) return;
        const n = Math.min(chunk.length, start + len - pos);
        if (n <= 0) break;
        for (let i = 0; i < n; i += 1) chunk[i] = patternByte(pos + i);
        if (dropAfter > 0 && served >= dropAfter) {
          res2.destroy();
          return;
        }
        if (!res2.write(chunk.subarray(0, n))) {
          await Promise.race([new Promise((resolve) => res2.once('drain', resolve)), closed]);
        }
        pos += n;
        served += n;
        if (delayMs > 0) await sleep(delayMs);
      }
      if (!res2.destroyed && !res2.writableEnded) res2.end();
    };

    if (noRange || advertiseRangeButIgnore) {
      res.writeHead(isHead ? 200 : 200, {
        'Content-Length': String(size),
        ...(advertiseRangeButIgnore ? { 'Accept-Ranges': 'bytes' } : {}),
      });
      if (isHead) {
        res.end();
        return;
      }
      void streamRange(res, 0, size);
      return;
    }

    const range = parseRange(req.headers.range, size);
    if (range === null) {
      res.writeHead(200, { 'Content-Length': String(size), 'Accept-Ranges': 'bytes' });
      if (isHead) {
        res.end();
        return;
      }
      void streamRange(res, 0, size);
      return;
    }
    res.writeHead(206, {
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + size,
      'Content-Length': String(range.end - range.start + 1),
      'Accept-Ranges': 'bytes',
    });
    if (isHead) {
      res.end();
      return;
    }
    void streamRange(res, range.start, range.end - range.start + 1);
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      resolve({
        url: 'http://127.0.0.1:' + port + '/file.bin',
        server,
        getMaxActive: () => maxActive,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

test.before(async () => {
  await mkdir(TMP, { recursive: true });
});
test.after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test('planSegments：连续覆盖且受 minSegment 约束', () => {
  const segs = planSegments(10 * 1024 * 1024, 4);
  assert.equal(segs.length, 4);
  assert.equal(segs[0].start, 0);
  assert.equal(segs[3].end, 10 * 1024 * 1024 - 1);
  for (let i = 1; i < segs.length; i += 1) assert.equal(segs[i].start, segs[i - 1].end + 1);
  assert.equal(planSegments(100 * 1024, 8).length, 1);
});

test('splitLargestUnfinished：切最大剩余段，不足阈值返回 null', () => {
  const segs = [
    { start: 0, end: 1023, cursor: 0 },
    { start: 1024, end: 9023, cursor: 1024 }, // 剩余 8000
  ];
  const second = splitLargestUnfinished(segs, 2048);
  assert.ok(second !== null);
  assert.equal(second.start, 1024 + 4000);
  assert.equal(segs[1].end, second.start - 1);
  assert.equal(splitLargestUnfinished(segs, 2048), null);
});

test('RateLimiter：1MB/s 下限速有效', async () => {
  const rl = new RateLimiter(1024 * 1024);
  const t0 = Date.now();
  await rl.acquire(1024 * 1024); // 起步突发，立即
  await rl.acquire(1024 * 1024); // 需等约 1s 补充令牌
  const dt = Date.now() - t0;
  assert.ok(dt >= 800, '应至少等待约 1s，实际 ' + dt + 'ms');
  assert.ok(dt <= 2500, '等待不应过久，实际 ' + dt + 'ms');
});

test('loadState：校验并恢复分段进度', async () => {
  const metaPath = join(TMP, 'm.meta.json');
  await writeFile(
    metaPath,
    JSON.stringify({ version: 1, url: 'http://x/f', total: 100, segments: [{ start: 0, end: 99, cursor: 50 }] }),
  );
  const segs = await loadState(metaPath, { finalUrl: 'http://x/f', total: 100 });
  assert.equal(segs.length, 1);
  assert.equal(segs[0].cursor, 50);
  assert.equal(await loadState(metaPath, { finalUrl: 'http://x/f', total: 200 }), null); // 总量不一致
  await writeFile(metaPath, 'not json');
  assert.equal(await loadState(metaPath, { finalUrl: 'http://x/f', total: 100 }), null);
});

test('多线程下载：正确性 + 并发连接 + 明显提速', async () => {
  const size = 32 * 1024 * 1024;
  const expected = expectedHash(size);
  const srv = await startServer({ size, delayPerChunkMs: 4 }); // 每连接约 16MB/s

  const outSingle = join(TMP, 'single.bin');
  const t1 = Date.now();
  await new Downloader({ url: srv.url, out: outSingle, connections: 1, fresh: true }).download();
  const singleMs = Date.now() - t1;
  assert.equal(await sha256File(outSingle), expected);
  assert.ok(singleMs >= 1200, '单线程应受每连接限速影响，实际 ' + singleMs + 'ms');

  const outMulti = join(TMP, 'multi.bin');
  const t2 = Date.now();
  await new Downloader({ url: srv.url, out: outMulti, connections: 4, fresh: true }).download();
  const multiMs = Date.now() - t2;
  assert.equal(await sha256File(outMulti), expected);
  assert.ok(multiMs < singleMs * 0.75, '多线程应明显更快: single=' + singleMs + 'ms multi=' + multiMs + 'ms');
  assert.ok(srv.getMaxActive() >= 2, '应观察到并发连接，实际峰值 ' + srv.getMaxActive());
  await srv.close();
});

test('限速端到端：6MB @1.5MB/s 耗时符合预期且内容完整', async () => {
  const size = 6 * 1024 * 1024;
  const srv = await startServer({ size });
  const out = join(TMP, 'limited.bin');
  const t0 = Date.now();
  await new Downloader({ url: srv.url, out, connections: 2, limitBytesPerSec: 1.5 * 1024 * 1024, fresh: true }).download();
  const dt = Date.now() - t0;
  assert.ok(dt >= 3000, '6MB @1.5MB/s 应 ≥3s，实际 ' + dt + 'ms');
  assert.ok(dt <= 9000, '耗时不应远超预期，实际 ' + dt + 'ms');
  assert.equal(await sha256File(out), expectedHash(size));
  await srv.close();
});

test('断点续传：中断后从进度恢复且哈希一致', async () => {
  const size = 24 * 1024 * 1024;
  const srv = await startServer({ size });
  const out = join(TMP, 'resume.bin');

  const ac = new AbortController();
  const dl1 = new Downloader({
    url: srv.url,
    out,
    connections: 2,
    limitBytesPerSec: 6 * 1024 * 1024,
    fresh: true,
    signal: ac.signal,
  });
  const timer = setTimeout(() => ac.abort(), 1200);
  let aborted = false;
  try {
    await dl1.download();
  } catch (err) {
    aborted = err?.name === 'AbortError';
  }
  clearTimeout(timer);
  assert.ok(aborted, '第一次下载应被中断');
  assert.equal(await stat(out + '.meta.json').then(() => true).catch(() => false), true, '中断后应保存 meta 进度文件');

  const r2 = await new Downloader({ url: srv.url, out, connections: 2, fresh: false }).download();
  assert.equal(r2.bytes, size);
  assert.equal(await sha256File(out), expectedHash(size));
  assert.equal(await stat(out + '.meta.json').then(() => true).catch(() => false), false, '完成后应删除 meta 文件');
  await srv.close();
});

test('服务器不支持 Range：降级单线程且内容完整', async () => {
  const size = 4 * 1024 * 1024;
  const srv = await startServer({ size, noRange: true });
  const out = join(TMP, 'norange.bin');
  const r = await new Downloader({ url: srv.url, out, connections: 8, fresh: true }).download();
  assert.equal(r.fallbackSingle, true);
  assert.equal(await sha256File(out), expectedHash(size));
  await srv.close();
});

test('服务器声明 Range 但实际忽略：中途降级单线程且内容完整', async () => {
  const size = 4 * 1024 * 1024;
  const srv = await startServer({ size, advertiseRangeButIgnore: true });
  const out = join(TMP, 'ignore-range.bin');
  try {
    const r = await new Downloader({ url: srv.url, out, connections: 4, fresh: true }).download();
    assert.equal(r.fallbackSingle, true);
    assert.equal(await sha256File(out), expectedHash(size));
  } finally {
    await srv.close();
  }
});

test('动态切分在途段：进度恰好等于总量（不重复计数）', async () => {
  const size = 4 * 1024 * 1024;
  // 段 0（0..2MB）很快，段 1（2MB..4MB）很慢：
  // 线程 1 先完成后切分段 1，触发"在途段边界收缩"场景
  const srv = await startServer({
    size,
    rangeDelayMs: (start) => (start < 2 * 1024 * 1024 ? 0 : 5),
  });
  const out = join(TMP, 'split-inflight.bin');
  const progress = [];
  const r = await new Downloader({
    url: srv.url,
    out,
    connections: 2,
    minSegment: 128 * 1024,
    fresh: true,
    onProgress: (p) => progress.push(p),
  }).download();
  assert.equal(r.bytes, size);
  assert.equal(await sha256File(out), expectedHash(size));
  assert.ok(progress.every((p) => p.completed <= size), '任何时刻进度都不应超过总量（无重复计数）');
  const last = progress[progress.length - 1];
  assert.equal(last.completed, size, '完成时应上报精确最终进度，实际 ' + last.completed);
  await srv.close();
});

test('连接中途断开：段内自动重试并完成', async () => {
  const size = 8 * 1024 * 1024;
  const srv = await startServer({ size, dropAfter: 3 * 1024 * 1024 }); // 每个请求 3MB 后断开
  const out = join(TMP, 'drop.bin');
  await new Downloader({ url: srv.url, out, connections: 2, fresh: true }).download();
  assert.equal(await sha256File(out), expectedHash(size));
  await srv.close();
});
