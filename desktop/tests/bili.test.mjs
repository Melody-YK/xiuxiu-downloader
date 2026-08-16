import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { isBiliPlayurlUrl, parseBiliPlayurl } from '../lib/bili.mjs';
import { downloadMedia } from '../lib/pipeline.mjs';

const TMP = join(tmpdir(), 'bili-test-' + process.pid);
test.before(async () => {
  await mkdir(TMP, { recursive: true });
});
test.after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

test('isBiliPlayurlUrl：识别 playurl 接口', () => {
  assert.equal(isBiliPlayurlUrl('https://api.bilibili.com/x/player/playurl?bvid=BV1xx&cid=1&fnval=16'), true);
  assert.equal(isBiliPlayurlUrl('https://api.bilibili.com/pgc/player/web/playurl?ep_id=1'), true);
  assert.equal(isBiliPlayurlUrl('https://a.com/x.mpd'), false);
});

test('parseBiliPlayurl：dash 择优 + flv + 错误码', () => {
  const dashJson = {
    code: 0,
    data: {
      quality: 80,
      dash: {
        video: [
          { id: 32, baseUrl: 'https://upos/low.m4s', bandwidth: 500000, codecs: 'avc1.64001f', width: 640, height: 360 },
          { id: 80, baseUrl: 'https://upos/high.m4s', bandwidth: 2000000, codecs: 'avc1.640032', width: 1920, height: 1080 },
        ],
        audio: [
          { id: 30216, baseUrl: 'https://upos/a64.m4s', bandwidth: 64000, codecs: 'mp4a.40.2' },
          { id: 30280, baseUrl: 'https://upos/a128.m4s', bandwidth: 128000, codecs: 'mp4a.40.2' },
        ],
      },
    },
  };
  const p = parseBiliPlayurl(dashJson);
  assert.equal(p.kind, 'dash');
  assert.equal(p.video.url, 'https://upos/high.m4s');
  assert.equal(p.video.width, 1920);
  assert.equal(p.audio.url, 'https://upos/a128.m4s');

  const flv = parseBiliPlayurl({ code: 0, data: { durl: [{ url: 'https://upos/v.flv' }] } });
  assert.equal(flv.kind, 'flv');
  assert.equal(flv.url, 'https://upos/v.flv');

  assert.throws(() => parseBiliPlayurl({ code: -404, data: null }), /-404/);
  assert.throws(() => parseBiliPlayurl({ code: 0, data: {} }), /未返回/);
});

const hasFfmpeg = spawnSync('ffmpeg', ['-version'], { stdio: 'ignore' }).status === 0;

test('B站管线 E2E：本地 playurl JSON → 双轨下载合并（需 ffmpeg）', { skip: !hasFfmpeg }, async () => {
  const dir = join(TMP, 'e2e');
  await mkdir(dir, { recursive: true });
  const video = join(dir, 'video.mp4');
  const audio = join(dir, 'audio.mp4');
  assert.equal(
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=2:size=320x240:rate=15', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', video]).status,
    0,
  );
  assert.equal(
    spawnSync('ffmpeg', ['-y', '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=2', '-c:a', 'aac', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', audio]).status,
    0,
  );

  const files = { 'video.mp4': await readFile(video), 'audio.mp4': await readFile(audio) };
  const server = createServer((req, res) => {
    res.on('error', () => {});
    req.on('error', () => {});
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/x/player/playurl') {
      const json = JSON.stringify({
        code: 0,
        data: {
          dash: {
            video: [{ baseUrl: 'http://127.0.0.1:' + server.address().port + '/video.mp4', bandwidth: 1000000, codecs: 'avc1', width: 320, height: 240 }],
            audio: [{ baseUrl: 'http://127.0.0.1:' + server.address().port + '/audio.mp4', bandwidth: 128000, codecs: 'mp4a' }],
          },
        },
      });
      res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) });
      res.end(json);
      return;
    }
    const buf = files[u.pathname.slice(1)];
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
    res.writeHead(200, { 'Content-Length': String(buf.length) });
    res.end(buf);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const out = join(TMP, 'bili-out.mp4');
  const result = await downloadMedia({ url: base + 'x/player/playurl?bvid=1&cid=1', out, headers: {}, connections: 2, onPhase: () => {}, onProgress: () => {} });
  assert.equal(result.kind, 'dash');
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', out], { encoding: 'utf8' });
  assert.equal(probe.status, 0, probe.stderr);
  assert.ok(probe.stdout.includes('h264'));
  assert.ok(probe.stdout.includes('aac'), '应包含音频轨');
  server.close();
});
