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
  scripting: {
    _calls: [],
    executeScript(opts) {
      globalThis.chrome.scripting._calls.push(opts);
      return Promise.resolve([]);
    },
  },
  tabs: {
    async get(tabId) {
      const tabs = { 5: { url: 'https://page.example/watch', title: '测试页' } };
      const tab = tabs[tabId];
      if (tab === undefined) throw new Error('tab not found: ' + String(tabId));
      return tab;
    },
  },
  runtime: {
    onMessage: makeEvent(),
    connectNative(name) {
      const port = {
        name,
        posted: [],
        postMessage(m) {
          port.posted.push(m);
        },
        disconnect() {
          port.disconnected = true;
        },
        onMessage: makeEvent(),
        onDisconnect: makeEvent(),
      };
      nativePorts.push(port);
      return port;
    },
  },
};
const nativePorts = [];

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

test('background：content 按钮下载 → connectNative 推送（带请求头 + autoDownload）', async () => {
  // 先捕获一个带请求头的视频条目
  fireSendHeaders({
    requestId: 'req-btn',
    tabId: 5,
    url: 'https://cdn.example/btn.mp4',
    requestHeaders: [{ name: 'Cookie', value: 'btn=1' }, { name: 'Referer', value: 'https://page.example/' }],
  });
  fireResponse(mediaRes({ requestId: 'req-btn', url: 'https://cdn.example/btn.mp4' }));
  await sleep(100); // 等条目异步入队（tabs.get → applyCapture）

  let resp = null;
  globalThis.chrome.runtime.onMessage._emit(
    { type: 'content:download', url: 'https://cdn.example/btn.mp4' },
    { tab: { id: 5 } },
    (r) => {
      resp = r;
    },
  );
  await sleep(50);
  assert.equal(nativePorts.length, 1, '应建立 native 连接');
  const msg = nativePorts[0].posted[0];
  assert.equal(msg.type, 'capture');
  assert.equal(msg.autoDownload, true);
  assert.equal(msg.entries.length, 1);
  assert.equal(msg.entries[0].url, 'https://cdn.example/btn.mp4');
  assert.equal(msg.entries[0].cookie, 'btn=1', '应带上捕获到的 Cookie');
  assert.equal(msg.entries[0].referer, 'https://page.example/');
  // 宿主回 ack 后按钮显示成功
  nativePorts[0].onMessage._emit({ type: 'ack', ok: true, count: 1 });
  await sleep(20);
  assert.deepEqual(resp, { ok: true });
});

test('background：hook 注入主世界 + hook 捕获动态 URL（带请求头）', async () => {
  globalThis.chrome.scripting._calls.length = 0;
  globalThis.chrome.runtime.onMessage._emit({ type: 'hook:inject' }, { tab: { id: 5 }, frameId: 0 }, () => {});
  await sleep(20);
  assert.equal(globalThis.chrome.scripting._calls.length, 1);
  assert.equal(globalThis.chrome.scripting._calls[0].world, 'MAIN');
  assert.deepEqual(globalThis.chrome.scripting._calls[0].files, ['page-hook.js']);

  fireSendHeaders({
    requestId: 'req-hook',
    tabId: 5,
    url: 'https://cdn.example/bili/playlist.m3u8',
    requestHeaders: [{ name: 'Cookie', value: 'bili=1' }],
  });
  globalThis.chrome.runtime.onMessage._emit(
    { type: 'hook:url', url: 'https://cdn.example/bili/playlist.m3u8' },
    { tab: { id: 5 } },
    () => {},
  );
  await sleep(600);
  const stored = storageData[STORAGE_KEY];
  const found = (stored?.entries ?? []).find((x) => x.url === 'https://cdn.example/bili/playlist.m3u8');
  assert.ok(found, 'hook 捕获的动态 URL 应入库');
  assert.equal(found.type, 'hls');
  assert.equal(found.headers?.cookie, 'bili=1', '应按 URL 补全请求头');
});

test('background：hook 捕获 B站 playurl 接口（无扩展名）为 dash 条目并带 Cookie', async () => {
  fireSendHeaders({
    requestId: 'req-bili',
    tabId: 5,
    url: 'https://api.bilibili.com/x/player/playurl?bvid=BV1x&cid=1&fnval=16',
    requestHeaders: [{ name: 'Cookie', value: 'SESSDATA=x' }],
  });
  globalThis.chrome.runtime.onMessage._emit(
    { type: 'hook:url', url: 'https://api.bilibili.com/x/player/playurl?bvid=BV1x&cid=1&fnval=16' },
    { tab: { id: 5 } },
    () => {},
  );
  await sleep(600);
  const stored = storageData[STORAGE_KEY];
  const found = (stored?.entries ?? []).find((x) => x.url.includes('playurl'));
  assert.ok(found, 'B站接口 URL 应入库');
  assert.equal(found.type, 'dash');
  assert.equal(found.headers?.cookie, 'SESSDATA=x');
});

test('background：webRequest 兜底捕获 B站 wbi playurl 接口（带 Cookie）', async () => {
  fireSendHeaders({
    requestId: 'req-wbi',
    tabId: 5,
    url: 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1x&cid=1',
    requestHeaders: [{ name: 'Cookie', value: 'SESSDATA=y' }],
  });
  fireResponse(
    mediaRes({
      requestId: 'req-wbi',
      url: 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1x&cid=1',
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    }),
  );
  // 播放器随后又请求了一次（新签名）——应合并为同一条并保留最新地址
  fireResponse(
    mediaRes({
      requestId: 'req-wbi2',
      url: 'https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1x&cid=1&fnval=16&fourk=1',
      responseHeaders: [{ name: 'Content-Type', value: 'application/json' }],
    }),
  );
  await sleep(600);
  const stored = storageData[STORAGE_KEY];
  const found = (stored?.entries ?? []).filter((x) => x.url.includes('wbi'));
  assert.equal(found.length, 1, '多次 playurl 请求应合并为一条');
  assert.ok(found[0].url.includes('fnval=16'), '应保留最新请求的地址');
  assert.equal(found[0].type, 'dash');
  assert.equal(found[0].headers?.cookie, 'SESSDATA=y');
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
