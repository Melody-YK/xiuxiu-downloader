import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseAttrList,
  parseByteRange,
  parseKeyTag,
  parseMasterPlaylist,
  parseMediaPlaylist,
} from '../lib/hls.mjs';

test('parseAttrList：引号与无引号值', () => {
  assert.deepEqual(parseAttrList('METHOD=AES-128,URI="key.bin",IV=0x01'), {
    METHOD: 'AES-128',
    URI: 'key.bin',
    IV: '0x01',
  });
});

test('parseMasterPlaylist：变体列表', () => {
  const master = '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000000,RESOLUTION=640x360,CODECS="avc1.4d401e"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=3000000,RESOLUTION=1920x1080\nhigh.m3u8\n';
  const vs = parseMasterPlaylist(master, 'http://x/master.m3u8');
  assert.equal(vs.length, 2);
  assert.equal(vs[0].url, 'http://x/low.m3u8');
  assert.equal(vs[0].bandwidth, 1000000);
  assert.equal(vs[1].url, 'http://x/high.m3u8');
  assert.equal(vs[1].bandwidth, 3000000);
});

test('parseMediaPlaylist：分片/密钥状态/IV/字节范围/MAP', () => {
  const m3u8 = [
    '#EXTM3U',
    '#EXT-X-VERSION:4',
    '#EXT-X-MEDIA-SEQUENCE:100',
    '#EXT-X-TARGETDURATION:10',
    '#EXT-X-KEY:METHOD=AES-128,URI="key.bin",IV=0x00000000000000000000000000000064',
    '#EXT-X-MAP:URI="init.mp4"',
    '#EXTINF:9.5,',
    'seg100.m4s',
    '#EXT-X-KEY:METHOD=NONE',
    '#EXTINF:5.0,',
    'seg101.m4s',
    '#EXT-X-BYTERANGE:1000@2000',
    '#EXTINF:1.0,',
    'seg102.m4s',
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
  const mp = parseMediaPlaylist(m3u8, 'http://x/media.m3u8');
  assert.equal(mp.segments.length, 3);
  assert.equal(mp.mediaSequence, 100);
  assert.equal(mp.endlist, true);
  assert.equal(mp.isVod, true);
  assert.equal(mp.hasFmp4, true);

  const s0 = mp.segments[0];
  assert.equal(s0.url, 'http://x/seg100.m4s');
  assert.equal(s0.key.method, 'AES-128');
  assert.equal(s0.key.url, 'http://x/key.bin');
  assert.equal(s0.key.iv, '00000000000000000000000000000064');
  assert.equal(s0.map.uri, 'http://x/init.mp4');

  assert.equal(mp.segments[1].key, null, 'METHOD=NONE 后不加密');
  assert.deepEqual(mp.segments[2].byterange, { length: 1000, offset: 2000 });
});

test('parseKeyTag：无 URI 的 SAMPLE-AES 视为不支持', () => {
  const k = parseKeyTag('#EXT-X-KEY:METHOD=SAMPLE-AES,URI="skd://xxx"');
  assert.equal(k.method, 'SAMPLE-AES');
});
