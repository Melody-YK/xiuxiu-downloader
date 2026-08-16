import test from 'node:test';
import assert from 'node:assert/strict';
import { createCipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { decryptAes128, downloadSegments, ivBuffer } from '../lib/segments.mjs';

const TMP = join(tmpdir(), 'seg-test-' + process.pid);

test.before(async () => {
  await mkdir(TMP, { recursive: true });
});
test.after(async () => {
  await rm(TMP, { recursive: true, force: true });
});

function startStaticServer(files) {
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
      res.writeHead(206, {
        'Content-Range': 'bytes ' + s + '-' + e + '/' + buf.length,
        'Content-Length': String(slice.length),
      });
      res.end(slice);
      return;
    }
    res.writeHead(200, { 'Content-Length': String(buf.length) });
    res.end(buf);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ base: 'http://127.0.0.1:' + server.address().port + '/', server }));
  });
}

test('decryptAes128：PKCS7 填充剥离', () => {
  const key = Buffer.from('0123456789abcdef');
  const iv = Buffer.from('000102030405060708090a0b0c0d0e0f', 'hex');
  for (const len of [100, 112, 128]) {
    const plain = randomBytes(len);
    const c = createCipheriv('aes-128-cbc', key, iv);
    const enc = Buffer.concat([c.update(plain), c.final()]);
    assert.ok(decryptAes128(enc, key, iv).equals(plain), '长度 ' + len + ' 应解密还原');
  }
});

test('ivBuffer：显式 IV 与序号 IV', () => {
  const hex = '00000000000000000000000000000064';
  assert.equal(ivBuffer({ iv: hex }, 999).toString('hex'), hex);
  assert.equal(ivBuffer({ iv: null }, 100).toString('hex'), '00000000000000000000000000000064');
});

test('downloadSegments：AES-128 解密 + 初始化段前置 + 字节范围', async () => {
  const key = Buffer.from('0123456789abcdef');
  const ivHex = '00000000000000000000000000000001';
  const iv = Buffer.from(ivHex, 'hex');
  const plainSeg = randomBytes(2048);
  const c = createCipheriv('aes-128-cbc', key, iv);
  const encSeg = Buffer.concat([c.update(plainSeg), c.final()]);
  const init = randomBytes(64);
  const bigFile = Buffer.concat([randomBytes(300), randomBytes(500), randomBytes(400)]);

  const { base, server } = await startStaticServer({
    'key.bin': key,
    'enc.ts': encSeg,
    'init.mp4': init,
    'single.bin': bigFile,
  });

  const workDir = join(TMP, 'work');
  const files = await downloadSegments(
    [
      {
        url: base + 'enc.ts',
        key: { url: base + 'key.bin', method: 'AES-128', iv: ivHex },
        ivSeq: 0,
        map: { uri: base + 'init.mp4', byterange: null },
        byterange: null,
      },
      { url: base + 'single.bin', byterange: { offset: 300, length: 500 }, key: null, map: null },
    ],
    { headers: {}, connections: 2, workDir, onProgress: () => {} },
  );
  const f0 = await readFile(files[0]);
  assert.ok(f0.equals(Buffer.concat([init, plainSeg])), '分片 0 应为 init + 解密后内容');
  const f1 = await readFile(files[1]);
  assert.ok(f1.equals(bigFile.subarray(300, 800)), '分片 1 应为指定字节范围');
  server.close();
});
