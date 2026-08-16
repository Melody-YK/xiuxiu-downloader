import test from 'node:test';
import assert from 'node:assert/strict';
import { STORAGE_KEY } from '../dist/lib/sniff.js';

// ---- mock chrome API（仅覆盖 background.ts 用到的部分） ----
function makeEvent() {
  const listeners = [];
  return {
    addListener(fn) {
      listeners.push(fn);
    },
    _emit(...args) {
      for (const fn of listeners) fn(...args);
    },
  };
}

const storageData = {};

globalThis.chrome = {
  storage: {
    local: {
      async get(key) {
        const out = {};
        out[key] = storageData[key];
        return out;
      },
      async set(obj) {
        Object.assign(storageData, obj);
      },
      async remove(key) {
        delete storageData[key];
      },
    },
    onChanged: makeEvent(),
  },
  webRequest: { onResponseStarted: makeEvent(), onBeforeSendHeaders: makeEvent() },
  tabs: {
    async get(tabId) {
      const tabs = { 5: { url: 'https://page.example/watch', title: '测试页' } };
      const tab = tabs[tabId];
      if (tab === undefined) throw new Error('tab not found: ' + String(tabId));
      return tab;
    },
  },
  runtime: { onMessage: makeEvent() },
};

// ---- 加载真实的 service worker 代码（注册监听器） ----
await import('../dist/background.js');

const fireResponse = globalThis.chrome.webRequest.onResponseStarted._emit;
const fireSendHeaders = globalThis.chrome.webRequest.onBeforeSendHeaders._emit;

let reqSeq = 0;
function mediaRes(over = {}) {
  return {
    requestId: 'req-' + String(++reqSeq),
    tabId: 5,
    statusCode: 200,
    url: 'https://cdn.example/bunny.mp4',
    initiator: 'https://page.example',
    responseHeaders: [
      { name: 'Content-Type', value: 'video/mp4' },
      { name: 'Content-Length', value: '1048576' },
    ],
    ...over,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

test('background：请求头捕获 → webRequest 过滤 → 聚合 → 持久化', async () => {
  // 请求头在 onBeforeSendHeaders 阶段缓存（requestId 关联）
  fireSendHeaders({
    requestId: 'req-video',
    tabId: 5,
    url: 'https://cdn.example/bunny.mp4',
    requestHeaders: [
      { name: 'Cookie', value: 'sid=abc' },
      { name: 'Referer', value: 'https://page.example/' },
      { name: 'User-Agent', value: 'TestUA/1.0' },
    ],
  });
  fireResponse(mediaRes({ requestId: 'req-video' }));
  fireResponse(mediaRes()); // 同 URL 重复请求（Range/重播），应被去重
  fireResponse(
    mediaRes({
      url: 'https://cdn.example/x36xhzz.m3u8',
      responseHeaders: [{ name: 'Content-Type', value: 'application/vnd.apple.mpegurl' }],
    }),
  );
  fireResponse(mediaRes({ url: 'https://cdn.example/seg1.ts', responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }] }));
  fireResponse(mediaRes({ url: 'https://cdn.example/seg2.ts', responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }] }));
  fireResponse(mediaRes({ url: 'https://cdn.example/seg1.ts', responseHeaders: [{ name: 'Content-Type', value: 'video/mp2t' }] }));
  fireResponse(mediaRes({ statusCode: 404, url: 'https://cdn.example/missing.mp4' })); // 4xx 忽略
  fireResponse(mediaRes({ url: 'https://page.example/index.html', responseHeaders: [{ name: 'Content-Type', value: 'text/html' }] })); // 非媒体忽略
  fireResponse(mediaRes({ tabId: -1, url: 'https://cdn.example/bg.mp4' })); // 非标签页请求忽略

  await sleep(600); // 等待防抖持久化（300ms）

  const stored = storageData[STORAGE_KEY];
  assert.ok(stored, '捕获状态应已持久化');
  assert.equal(stored.entries.length, 2, '仅 mp4 与 hls 两个条目');

  const video = stored.entries.find((e) => e.type === 'video');
  assert.equal(video?.url, 'https://cdn.example/bunny.mp4');
  assert.equal(video?.size, 1048576);
  assert.equal(video?.pageTitle, '测试页');
  assert.equal(video?.pageUrl, 'https://page.example/watch');
  assert.deepEqual(video?.headers, { cookie: 'sid=abc', referer: 'https://page.example/', userAgent: 'TestUA/1.0' });

  const hls = stored.entries.find((e) => e.type === 'hls');
  assert.equal(hls?.segmentCount, 2, '两个不同分片各计一次，重复分片不重复计数');
  assert.equal(hls?.headers, null, '未捕获到请求头的条目 headers 为 null');
});

test('background：popup 清空消息清空状态与存储', async () => {
  let response = null;
  globalThis.chrome.runtime.onMessage._emit({ type: 'clear' }, {}, (v) => {
    response = v;
  });
  await sleep(50);
  assert.deepEqual(response, { ok: true });
  assert.equal(storageData[STORAGE_KEY], undefined);
});
