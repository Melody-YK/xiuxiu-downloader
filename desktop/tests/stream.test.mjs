import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { downloadMedia } from '../lib/pipeline.mjs';

const TMP = join(tmpdir(), 'stream-test-' + process.pid);
test.before(async () => {
  await mkdir(TMP, { recursive: true });
});
test.after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('分片流 E2E：连续 mp4 分片 → 按序拼接 → mp4 可播放（需 ffmpeg）', { skip: !hasFfmpeg }, async () => {
  const dir = join(TMP, 'e2e');
  await mkdir(dir, { recursive: true });
  const files = {};
  for (let i = 1; i <= 3; i += 1) {
    const p = join(dir, 'seg_' + String(i).padStart(5, '0') + '.mp4');
    const r = spawnSync('ffmpeg', [
      '-y', '-hide_banner', '-loglevel', 'error',
      '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15',
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', p,
    ]);
    assert.equal(r.status, 0);
    files['seg_' + String(i).padStart(5, '0') + '.mp4'] = await readFile(p);
  }
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
    res.writeHead(200, { 'Content-Length': String(buf.length) });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const out = join(TMP, 'stream-out.mp4');
  const result = await downloadMedia({
    url: base + 'seg_00001.mp4',
    out,
    headers: {},
    connections: 3,
    streamUrls: ['seg_00003.mp4', 'seg_00001.mp4', 'seg_00002.mp4'].map((f) => base + f), // 乱序传入，验证按序号排序
    onPhase: () => {},
    onProgress: () => {},
  });
  assert.equal(result.kind, 'stream');
  assert.equal(result.segments, 3);
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  const duration = Number(probe.stdout.trim());
  assert.ok(duration >= 5 && duration <= 7, '3×2s 分片应约 6s，实际 ' + duration);
  server.close();
});
