import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseMediaPlaylist } from '../lib/hls.mjs';
import { downloadSegments } from '../lib/segments.mjs';
import { concatFiles, ffmpegRemux } from '../lib/merge.mjs';

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('ffmpeg 环境检查', { skip: !hasFfmpeg }, () => {
  assert.ok(true);
});

test('HLS 全链路：ffmpeg 生成 TS 分片 → 解析 → 下载 → 合并 → mp4 可播放', { skip: !hasFfmpeg }, async () => {
  const dir = join(tmpdir(), 'hls-e2e-' + process.pid);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  try {
    const N = 4;
    for (let i = 0; i < N; i += 1) {
      const r = spawnSync('ffmpeg', [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15',
        '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-f', 'mpegts', join(dir, 'seg' + i + '.ts'),
      ]);
      assert.equal(r.status, 0, 'ffmpeg 生成分片失败: ' + r.stderr);
    }
    const playlist = '#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:2\n' +
      Array.from({ length: N }, (_v, i) => '#EXTINF:2.0,\nseg' + i + '.ts\n').join('') +
      '#EXT-X-ENDLIST\n';
    await writeFile(join(dir, 'index.m3u8'), playlist);

    const server = createServer((req, res) => {
      const path = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\//, '');
      readFile(join(dir, path))
        .then((buf) => {
          res.writeHead(200, { 'Content-Length': String(buf.length) });
          res.end(buf);
        })
        .catch(() => {
          res.writeHead(404);
          res.end();
        });
    });
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    const base = 'http://127.0.0.1:' + server.address().port + '/';

    const mp = parseMediaPlaylist(playlist, base + 'index.m3u8');
    assert.equal(mp.segments.length, N);
    const files = await downloadSegments(
      mp.segments.map((s) => ({ url: s.url, key: null, map: null, byterange: null })),
      { headers: {}, connections: 4, workDir: join(dir, 'parts'), onProgress: () => {} },
    );
    const merged = await concatFiles(files, join(dir, 'merged.ts'));
    const out = join(dir, 'out.mp4');
    await ffmpegRemux(merged, out);

    const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], {
      encoding: 'utf8',
    });
    assert.equal(probe.status, 0, 'ffprobe 失败: ' + probe.stderr);
    assert.ok(probe.stdout.includes('h264'), '输出应含 h264 视频流，实际: ' + probe.stdout);
    server.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
