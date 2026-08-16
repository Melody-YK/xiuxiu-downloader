import test from 'node:test';
import assert from 'node:assert/strict';
import { FrameParser, handleMessage, serializeMessage } from '../lib/protocol.mjs';

test('serializeMessage：4 字节小端长度前缀 + UTF-8 JSON', () => {
  const buf = serializeMessage({ type: 'ping' });
  const json = JSON.stringify({ type: 'ping' });
  assert.equal(buf.length, 4 + json.length);
  assert.equal(buf.readUInt32LE(0), json.length);
  assert.equal(buf.subarray(4).toString('utf8'), json);

  const zh = serializeMessage({ url: 'https://a.com/视频.mp4' });
  const zhJson = JSON.stringify({ url: 'https://a.com/视频.mp4' });
  assert.equal(zh.readUInt32LE(0), Buffer.byteLength(zhJson, 'utf8'));
});

test('FrameParser：逐字节分块重组与多帧粘包', () => {
  const msgs = [];
  const parser = new FrameParser((m) => msgs.push(m), (e) => { throw e; });
  const f1 = serializeMessage({ type: 'ping' });
  const f2 = serializeMessage({ type: 'capture', entries: [{ url: 'https://a.com/1.mp4' }] });
  const all = Buffer.concat([f1, f2]);
  for (let i = 0; i < all.length; i += 1) parser.push(all.subarray(i, i + 1));
  assert.equal(msgs.length, 2);
  assert.deepEqual(msgs[0], { type: 'ping' });
  assert.equal(msgs[1].entries[0].url, 'https://a.com/1.mp4');

  const f3 = serializeMessage({ type: 'ping' });
  parser.push(f3.subarray(0, 2)); // 半帧挂起
  assert.equal(msgs.length, 2);
  parser.push(f3.subarray(2));
  assert.equal(msgs.length, 3);
});

test('FrameParser：非法 JSON 与超长帧上报错误', () => {
  const errors = [];
  const parser = new FrameParser(() => {}, (e) => errors.push(e.message));
  const bad = Buffer.from([6, 0, 0, 0, 0x6e, 0x6f, 0x74, 0x6a, 0x73, 0x6f]); // 'notjso'
  parser.push(bad);
  assert.equal(errors.length, 1);
  assert.ok(errors[0].startsWith('invalid JSON'));

  const huge = Buffer.alloc(4);
  huge.writeUInt32LE(2 * 1024 * 1024, 0);
  parser.push(huge);
  assert.equal(errors.length, 2);
  assert.ok(errors[1].startsWith('frame too large'));
});

test('handleMessage：ping/capture/未知类型/非法消息', () => {
  assert.deepEqual(handleMessage({ type: 'ping' }), [{ type: 'pong' }]);
  assert.deepEqual(handleMessage({ type: 'capture', entries: [{ url: 'u' }, { url: 'v' }] }), [
    { type: 'ack', ok: true, count: 2 },
  ]);
  assert.deepEqual(handleMessage({ type: 'capture' }), [{ type: 'ack', ok: true, count: 0 }]);
  assert.equal(handleMessage({ type: 'weird' })[0].type, 'error');
  assert.equal(handleMessage('not-an-object')[0].type, 'error');
});
