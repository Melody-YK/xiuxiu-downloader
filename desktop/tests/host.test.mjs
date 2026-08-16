import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser, serializeMessage } from '../lib/protocol.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function runHost(guiPort) {
  const child = spawn(process.execPath, ['host.mjs'], {
    cwd: rootDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, XIUXIU_GUI_PORT: String(guiPort) },
  });
  const frames = [];
  const parser = new FrameParser((m) => frames.push(m), () => {});
  let stderrText = '';
  child.stdout.on('data', (c) => parser.push(c));
  child.stderr.on('data', (c) => {
    stderrText += c.toString('utf8');
  });
  return { child, frames, getStderr: () => stderrText };
}

function waitFor(pred, timeoutMs = 5000) {
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
    }, 20);
  });
}

test('host：capture → ack + 日志 + 转发到 GUI 端口；ping → pong', async () => {
  // 本地假 GUI：只验证转发到达，绝不打扰真实 GUI（17321）
  const received = [];
  const gui = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => {
      body += c.toString('utf8');
    });
    req.on('end', () => {
      received.push({ method: req.method, url: req.url, body: JSON.parse(body) });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  await new Promise((resolve) => gui.listen(0, '127.0.0.1', resolve));
  const guiPort = gui.address().port;

  const { child, frames, getStderr } = runHost(guiPort);
  try {
    child.stdin.write(
      serializeMessage({
        type: 'capture',
        entries: [
          {
            url: 'https://cdn.example/bunny.mp4',
            mediaType: 'video',
            contentType: 'video/mp4',
            size: 1048576,
            pageUrl: 'https://page.example/watch',
            pageTitle: '测试页',
            cookie: 'sid=abc',
            referer: 'https://page.example/',
            userAgent: 'TestUA/1.0',
          },
        ],
      }),
    );
    await waitFor(() => frames.length >= 1);
    assert.deepEqual(frames[0], { type: 'ack', ok: true, count: 1 });
    await waitFor(() => received.length >= 1);
    assert.equal(received[0].method, 'POST');
    assert.equal(received[0].url, '/ingest');
    assert.equal(received[0].body.type, 'capture');
    assert.equal(received[0].body.entries[0].url, 'https://cdn.example/bunny.mp4');
    assert.equal(received[0].body.entries[0].size, 1048576);
    const stderr = getStderr();
    assert.ok(stderr.includes('https://cdn.example/bunny.mp4'), '日志应打印 URL');
    assert.ok(stderr.includes('sid=abc'), '日志应打印 Cookie');
    assert.ok(stderr.includes('https://page.example/'), '日志应打印 Referer');
    assert.ok(stderr.includes('TestUA/1.0'), '日志应打印 User-Agent');

    child.stdin.write(serializeMessage({ type: 'ping' }));
    await waitFor(() => frames.length >= 2);
    assert.deepEqual(frames[1], { type: 'pong' });
  } finally {
    try {
      child.stdin.end();
    } catch {
      // 进程已退出则忽略
    }
    await new Promise((resolve) => {
      child.on('exit', resolve);
      setTimeout(resolve, 2000);
    });
    await new Promise((resolve) => gui.close(resolve));
  }
});
