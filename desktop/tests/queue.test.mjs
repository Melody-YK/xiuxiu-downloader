import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { JobManager, isMediaUrl, sanitizeFileName } from '../lib/queue.mjs';
import { sleep } from '../lib/downloader.mjs';

const TMP = join(tmpdir(), 'queue-test-' + process.pid);

test.before(async () => {
  await mkdir(TMP, { recursive: true });
});
test.after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function patternByte(pos) {
  return (pos * 31 + 7) & 0xff;
}

// 静态文件服务器（支持 Range 与每块延迟）
function startServer(files, delayMs = 0) {
  const server = createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '');
    const buf = files[path];
    if (buf === undefined) {
      res.writeHead(404);
      res.end();
      return;
    }
    const m = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range ?? '');
    if (m !== null) {
      const s = Number(m[1]);
      const e = Math.min(Number(m[2]), buf.length - 1);
      const slice = buf.subarray(s, e + 1);
      res.writeHead(206, { 'Content-Range': 'bytes ' + s + '-' + e + '/' + buf.length, 'Content-Length': String(slice.length) });
      res.end(slice);
      return;
    }
    if (delayMs > 0) {
      const parts = [];
      for (let i = 0; i < buf.length; i += 64 * 1024) parts.push(buf.subarray(i, i + 64 * 1024));
      let i = 0;
      res.writeHead(200, { 'Content-Length': String(buf.length) });
      const push = () => {
        if (res.destroyed || res.writableEnded) return; // 客户端中断后停止，避免挂起
        if (i >= parts.length) {
          res.end();
          return;
        }
        res.write(parts[i]);
        i += 1;
        setTimeout(push, delayMs);
      };
      push();
      return;
    }
    res.writeHead(200, { 'Content-Length': String(buf.length) });
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ base: 'http://127.0.0.1:' + server.address().port + '/', server }));
  });
}

function waitFor(pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const timer = setInterval(() => {
      if (pred()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(timer);
        reject(new Error('waitFor 超时'));
      }
    }, 30);
  });
}

function makeFile(size) {
  const buf = Buffer.allocUnsafe(size);
  for (let i = 0; i < size; i += 1) buf[i] = patternByte(i);
  return buf;
}

test('isMediaUrl：识别 m3u8/mpd', () => {
  assert.equal(isMediaUrl('https://a.com/x.m3u8'), true);
  assert.equal(isMediaUrl('https://a.com/x.m3u8?token=1'), true);
  assert.equal(isMediaUrl('https://a.com/x.mpd'), true);
  assert.equal(isMediaUrl('https://a.com/x.mp4'), false);
});

test('sanitizeFileName：清洗非法字符与限长', () => {
  assert.equal(sanitizeFileName('1桶半™≠ 一桶半！教你识别"心机商标"'), '1桶半™≠ 一桶半！教你识别_心机商标_');
  assert.equal(sanitizeFileName('a/b:c*d?e<f>g|h'), 'a_b_c_d_e_f_g_h');
  assert.equal(sanitizeFileName('   '), 'download');
  assert.equal(sanitizeFileName('x'.repeat(200)).length, 80);
  assert.equal(sanitizeFileName('结尾有空格和点.. '), '结尾有空格和点');
});

test('file 任务：排队 → 进度事件 → 完成且内容正确', async () => {
  const src = makeFile(2 * 1024 * 1024);
  const { base, server } = await startServer({ 'f.bin': src });
  const jobs = new JobManager({ maxConcurrent: 1 });
  const events = [];
  jobs.on('event', (ev) => events.push(ev));
  const out = join(TMP, 'q1.bin');
  jobs.add({ url: base + 'f.bin', out, kind: 'file', threads: 2, headers: {} });

  await waitFor(() => jobs.getSnapshot()[0]?.status === 'done');
  assert.ok(events.some((e) => e.type === 'progress'), '应发出进度事件');
  assert.ok(events.some((e) => e.type === 'status' && e.data.status === 'running'));
  assert.equal((await readFile(out)).equals(src), true, '内容应一致');
  server.close();
});

test('并发限制：同时最多 1 个任务运行', async () => {
  const src = makeFile(512 * 1024);
  const { base, server } = await startServer({ 'f.bin': src }, 15); // 慢服务器
  const jobs = new JobManager({ maxConcurrent: 1 });
  const outA = join(TMP, 'qa.bin');
  const outB = join(TMP, 'qb.bin');
  const idA = jobs.add({ url: base + 'f.bin', out: outA, kind: 'file', threads: 1 });
  const idB = jobs.add({ url: base + 'f.bin', out: outB, kind: 'file', threads: 1 });

  await waitFor(() => {
    const s = jobs.getSnapshot();
    return s[0]?.status === 'running' && s[1]?.status === 'queued';
  });
  let seenBothRunning = false;
  const timer = setInterval(() => {
    const running = jobs.getSnapshot().filter((t) => t.status === 'running').length;
    if (running > 1) seenBothRunning = true;
  }, 20);
  await waitFor(() => jobs.getSnapshot().every((t) => t.status === 'done'));
  clearInterval(timer);
  assert.equal(seenBothRunning, false, '并发数不应超过 1');
  assert.equal(jobs.getSnapshot()[0].id, idA);
  assert.equal(jobs.getSnapshot()[1].id, idB);
  server.close();
});

test('取消任务：排队取消与运行中取消', async () => {
  const src = makeFile(2 * 1024 * 1024);
  const { base, server } = await startServer({ 'f.bin': src }, 20);
  const jobs = new JobManager({ maxConcurrent: 1 });
  const idA = jobs.add({ url: base + 'f.bin', out: join(TMP, 'ca.bin'), kind: 'file', threads: 1 });
  const idB = jobs.add({ url: base + 'f.bin', out: join(TMP, 'cb.bin'), kind: 'file', threads: 1 });

  await waitFor(() => jobs.getSnapshot().find((t) => t.id === idA)?.status === 'running');
  assert.equal(jobs.cancel(idB), true, '取消排队任务');
  await waitFor(() => jobs.getSnapshot().find((t) => t.id === idB)?.status === 'canceled');
  assert.equal(jobs.cancel(idA), true, '取消运行中任务');
  await waitFor(() => jobs.getSnapshot().find((t) => t.id === idA)?.status === 'canceled');
  server.close();
});

test('错误任务：404 → status=error 且带错误信息', async () => {
  const { base, server } = await startServer({});
  const jobs = new JobManager({ maxConcurrent: 1 });
  jobs.add({ url: base + 'missing.bin', out: join(TMP, 'err.bin'), kind: 'file', threads: 1 });
  await waitFor(() => jobs.getSnapshot()[0]?.status === 'error');
  assert.ok((jobs.getSnapshot()[0].error ?? '').length > 0);
  server.close();
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('restoreHistory：恢复已完成任务且不重新排队', () => {
  const jobs = new JobManager({ maxConcurrent: 2 });
  jobs.restoreHistory([
    { id: 7, url: 'https://a.com/v.mp4', out: 'C:\\tmp\\v.mp4', kind: 'file', isMedia: false, status: 'done', createdAt: 1000, finishedAt: 2000 },
    { id: 8, url: 'https://a.com/x.m3u8', out: 'C:\\tmp\\x.mp4', kind: 'media', isMedia: true, status: 'error', error: '403', createdAt: 3000, finishedAt: 4000 },
  ]);
  const snap = jobs.getSnapshot();
  assert.equal(snap.length, 2);
  assert.equal(snap[0].status, 'done');
  assert.equal(snap[1].status, 'error');
  // 新任务 id 不与历史冲突
  const id = jobs.add({ url: 'https://a.com/n.mp4', kind: 'file' });
  assert.equal(id, 9);
  assert.equal(jobs.getSnapshot().length, 3);
  assert.equal(jobs.getSnapshot()[0].status, 'done', '历史任务不参与排队');
});

test('media 任务：本地 m3u8 → mp4（需 ffmpeg）', { skip: !hasFfmpeg }, async () => {
  const dir = join(TMP, 'media');
  await mkdir(dir, { recursive: true });
  const N = 2;
  for (let i = 0; i < N; i += 1) {
    const r = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', join(dir, 'seg' + i + '.ts'),
    ]);
    assert.equal(r.status, 0);
  }
  const playlist = '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2.0,\nseg0.ts\n#EXTINF:2.0,\nseg1.ts\n#EXT-X-ENDLIST\n';
  const files = { 'seg0.ts': await readFile(join(dir, 'seg0.ts')), 'seg1.ts': await readFile(join(dir, 'seg1.ts')), 'index.m3u8': Buffer.from(playlist) };
  const { base, server } = await startServer(files);
  const jobs = new JobManager({ maxConcurrent: 1 });
  const out = join(TMP, 'qm.mp4');
  jobs.add({ url: base + 'index.m3u8', out, kind: 'media', threads: 4 });
  await waitFor(() => jobs.getSnapshot()[0]?.status === 'done');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(probe.status, 0);
  assert.ok(probe.stdout.includes('h264'));
  server.close();
});

test('media 任务：mpd SegmentTemplate → mp4（需 ffmpeg）', { skip: !hasFfmpeg }, async () => {
  // ffmpeg 生成一个 fragmented mp4，mpd 用单分片 SegmentTemplate 引用整个文件
  const dir = join(TMP, 'dash');
  await mkdir(dir, { recursive: true });
  const seg = join(dir, 'seg.mp4');
  const r = spawnSync('ffmpeg', [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15',
    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', seg,
  ]);
  assert.equal(r.status, 0);
  const mpd =
    '<?xml version="1.0"?><MPD><Period><AdaptationSet mimeType="video/mp4">' +
    '<Representation id="v0" bandwidth="1000000"><SegmentTemplate media="seg.mp4" startNumber="1">' +
    '<SegmentTimeline><S t="0" d="2000000"/></SegmentTimeline></SegmentTemplate></Representation>' +
    '</AdaptationSet></Period></MPD>';
  const files = { 'seg.mp4': await readFile(seg), 'manifest.mpd': Buffer.from(mpd) };
  const { base, server } = await startServer(files);
  const jobs = new JobManager({ maxConcurrent: 1 });
  const out = join(TMP, 'qd.mp4');
  jobs.add({ url: base + 'manifest.mpd', out, kind: 'media', threads: 2 });
  await waitFor(() => ['done', 'error'].includes(jobs.getSnapshot()[0]?.status), 20000);
  const snap = jobs.getSnapshot()[0];
  assert.equal(snap.status, 'done', '任务应完成，错误: ' + (snap.error ?? ''));
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(probe.status, 0);
  assert.ok(probe.stdout.includes('h264'));
  server.close();
});
