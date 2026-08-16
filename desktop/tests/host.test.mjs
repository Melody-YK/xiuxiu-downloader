import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser, serializeMessage } from '../lib/protocol.mjs';

const rootDir = join(dirname(fileURLToPath(import.meta.url)), '..');

function runHost() {
  const child = spawn(process.execPath, ['host.mjs'], {
    cwd: rootDir,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
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

test('host：capture → ack + 日志打印 URL/Cookie/Referer/UA；ping → pong', async () => {
  const { child, frames, getStderr } = runHost();
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
  }
});
