import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCapture,
  bvidFromPageUrl,
  bvidFromPlayurl,
  classify,
  cleanBiliTitle,
  createEmptyState,
  extOf,
  extractMediaUrl,
  extractRequestHeaders,
  getHeader,
  MAX_ENTRIES,
  segmentGroupKey,
} from '../dist/lib/sniff.js';

function cap(over = {}) {
  return {
    url: 'https://example.com/video.mp4',
    tabId: 1,
    contentType: 'video/mp4',
    type: 'video',
    ...over,
  };
}

test('extOf：仅从路径提取媒体扩展名', () => {
  assert.equal(extOf('https://a.com/v/bunny.mp4'), 'mp4');
  assert.equal(extOf('https://a.com/v/bunny.mp4?token=1'), 'mp4');
  assert.equal(extOf('https://a.com/v/BUNNY.MP4'), 'mp4');
  assert.equal(extOf('https://a.com/x.m3u8'), 'm3u8');
  assert.equal(extOf('https://a.com/page.php'), null);
  assert.equal(extOf('https://a.com/?file=a.mp4'), null);
  assert.equal(extOf('not a url'), null);
});

test('classify：扩展名与 Content-Type 双层判定', () => {
  assert.deepEqual(classify('https://a.com/x.m3u8', ''), { isMedia: true, type: 'hls', ext: 'm3u8' });
  assert.deepEqual(classify('https://a.com/playlist', 'application/vnd.apple.mpegurl'), { isMedia: true, type: 'hls', ext: 'm3u8' });
  assert.deepEqual(classify('https://a.com/x.mpd', ''), { isMedia: true, type: 'dash', ext: 'mpd' });
  assert.deepEqual(classify('https://a.com/x', 'application/dash+xml'), { isMedia: true, type: 'dash', ext: 'mpd' });
  assert.deepEqual(classify('https://a.com/seg.ts', ''), { isMedia: true, type: 'ts', ext: 'ts' });
  assert.deepEqual(classify('https://a.com/seg.m4s', ''), { isMedia: true, type: 'ts', ext: 'm4s' });
  assert.deepEqual(classify('https://a.com/x.mp4', ''), { isMedia: true, type: 'video', ext: 'mp4' });
  assert.deepEqual(classify('https://a.com/x', 'video/webm'), { isMedia: true, type: 'video', ext: null });
  assert.deepEqual(classify('https://a.com/x.mp3', ''), { isMedia: true, type: 'audio', ext: 'mp3' });
  assert.deepEqual(classify('https://a.com/x', 'audio/mpeg'), { isMedia: true, type: 'audio', ext: null });
  assert.deepEqual(classify('https://a.com/page.php', 'text/html'), { isMedia: false, type: null, ext: null });
});

test('getHeader：大小写不敏感', () => {
  const headers = [
    { name: 'Content-Type', value: 'video/mp4' },
    { name: 'CONTENT-LENGTH', value: '123' },
  ];
  assert.equal(getHeader(headers, 'content-type'), 'video/mp4');
  assert.equal(getHeader(headers, 'content-length'), '123');
  assert.equal(getHeader(headers, 'x-missing'), null);
});

test('applyCapture：新增、同 tab 去重、跨 tab 独立', () => {
  const state = createEmptyState();
  assert.equal(applyCapture(state, cap({ url: 'https://a.com/v.mp4' })).changed, 'added');
  assert.equal(applyCapture(state, cap({ url: 'https://a.com/v.mp4' })).changed, 'updated');
  assert.equal(state.entries.length, 1);
  assert.equal(applyCapture(state, cap({ url: 'https://a.com/v.mp4', tabId: 2 })).changed, 'added');
  assert.equal(state.entries.length, 2);
});

test('applyCapture：ts 分片聚合到 hls 清单，重复分片去重', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://a.com/x.m3u8', type: 'hls', contentType: 'application/vnd.apple.mpegurl' }));
  applyCapture(state, cap({ url: 'https://a.com/seg1.ts', type: 'ts', contentType: 'video/mp2t' }));
  applyCapture(state, cap({ url: 'https://a.com/seg2.ts', type: 'ts', contentType: 'video/mp2t' }));
  applyCapture(state, cap({ url: 'https://a.com/seg1.ts', type: 'ts', contentType: 'video/mp2t' }));
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].segmentCount, 2);
  assert.equal(state.segmentKeys.length, 2);
});

test('applyCapture：无清单时 ts 聚合为独立条目', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://a.com/s1.ts', type: 'ts' }));
  applyCapture(state, cap({ url: 'https://a.com/s2.ts', type: 'ts' }));
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0].type, 'ts');
  assert.equal(state.entries[0].segmentCount, 2);
});

test('applyCapture：m4s 优先聚合到 dash 清单', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://a.com/x.m3u8', type: 'hls', contentType: 'application/vnd.apple.mpegurl' }));
  applyCapture(state, cap({ url: 'https://a.com/x.mpd', type: 'dash', contentType: 'application/dash+xml' }));
  applyCapture(state, cap({ url: 'https://a.com/s1.m4s', type: 'ts', ext: 'm4s', contentType: 'video/mp4' }));
  assert.equal(state.entries.find((e) => e.type === 'dash')?.segmentCount, 1);
  assert.equal(state.entries.find((e) => e.type === 'hls')?.segmentCount, 0);
});

test('applyCapture：segmentKeys 持久化，模拟 SW 重启后不重复计数', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://a.com/x.m3u8', type: 'hls', contentType: 'application/vnd.apple.mpegurl' }));
  applyCapture(state, cap({ url: 'https://a.com/seg1.ts', type: 'ts', contentType: 'video/mp2t' }));
  const restored = createEmptyState();
  restored.nextId = state.nextId;
  restored.entries = state.entries;
  restored.segmentKeys = state.segmentKeys;
  applyCapture(restored, cap({ url: 'https://a.com/seg1.ts', type: 'ts', contentType: 'video/mp2t' }));
  assert.equal(restored.entries.find((e) => e.type === 'hls')?.segmentCount, 1);
});

test('extractRequestHeaders：提取 Cookie/Referer/UA', () => {
  const headers = [
    { name: 'Cookie', value: 'sid=abc' },
    { name: 'Referer', value: 'https://page.example/' },
    { name: 'User-Agent', value: 'UA/1.0' },
    { name: 'Accept', value: '*/*' },
  ];
  assert.deepEqual(extractRequestHeaders(headers), {
    cookie: 'sid=abc',
    referer: 'https://page.example/',
    userAgent: 'UA/1.0',
  });
  assert.deepEqual(extractRequestHeaders([]), {});
});

test('applyCapture：请求头随条目保存并可补全', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://a.com/v.mp4' }));
  assert.equal(state.entries[0]?.headers, null);
  applyCapture(state, cap({ url: 'https://a.com/v.mp4', headers: { cookie: 'sid=1', referer: 'https://p/' } }));
  assert.deepEqual(state.entries[0]?.headers, { cookie: 'sid=1', referer: 'https://p/' });
  applyCapture(state, cap({ url: 'https://a.com/v2.mp4', headers: { userAgent: 'UA' } }));
  assert.deepEqual(state.entries[0]?.headers, { userAgent: 'UA' });
});

test('extractMediaUrl：取 currentSrc/src/source 子元素，跳过 blob', () => {
  assert.equal(extractMediaUrl({ currentSrc: 'blob:https://x/1', src: 'https://a.com/v.mp4' }), 'https://a.com/v.mp4');
  assert.equal(extractMediaUrl({ currentSrc: 'https://a.com/cur.mp4', src: '' }), 'https://a.com/cur.mp4');
  assert.equal(extractMediaUrl({ src: 'blob:https://x/2', children: [{ src: 'https://a.com/s.mp4' }] }), 'https://a.com/s.mp4');
  assert.equal(extractMediaUrl({}), null);
  assert.equal(extractMediaUrl({ src: 'data:video/mp4;base64,xxx' }), null);
});

test('applyCapture：dedupeKey 同页只留一条并保留最新 URL', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://api.bilibili.com/x/player/wbi/playurl?sig=old', type: 'dash', dedupeKey: 'bili-playurl' }));
  applyCapture(state, cap({ url: 'https://api.bilibili.com/x/player/wbi/playurl?sig=new', type: 'dash', dedupeKey: 'bili-playurl', headers: { cookie: 'c=1' } }));
  assert.equal(state.entries.length, 1, '同 dedupeKey 应合并为一条');
  assert.equal(state.entries[0]?.url, 'https://api.bilibili.com/x/player/wbi/playurl?sig=new', '应保留最新 URL');
  assert.equal(state.entries[0]?.headers?.cookie, 'c=1');
  // 不同 tab 互不影响
  applyCapture(state, cap({ url: 'https://api.bilibili.com/x/player/wbi/playurl?sig=t2', type: 'dash', dedupeKey: 'bili-playurl', tabId: 2 }));
  assert.equal(state.entries.length, 2);
});

test('applyCapture：dedupeKey 更新时非空标题覆盖、空标题保留原值', () => {
  const state = createEmptyState();
  applyCapture(state, cap({ url: 'https://b.b/p?sig=1', type: 'dash', dedupeKey: 'k', pageTitle: '' }));
  assert.equal(state.entries[0]?.pageTitle, '');
  applyCapture(state, cap({ url: 'https://b.b/p?sig=2', type: 'dash', dedupeKey: 'k', pageTitle: '真实标题' }));
  assert.equal(state.entries[0]?.pageTitle, '真实标题', '新捕获带有效标题应覆盖');
  applyCapture(state, cap({ url: 'https://b.b/p?sig=3', type: 'dash', dedupeKey: 'k', pageTitle: '' }));
  assert.equal(state.entries[0]?.pageTitle, '真实标题', '空标题不应覆盖已有标题');
});

test('cleanBiliTitle：去后缀（含分区后缀）、默认标题视为空', () => {
  assert.equal(cleanBiliTitle('胖龙做一锅筋头巴脑_哔哩哔哩_bilibili'), '胖龙做一锅筋头巴脑');
  assert.equal(cleanBiliTitle('没蟹壳的时候，我看清了很多人！_哔哩哔哩bilibili_王者荣耀'), '没蟹壳的时候，我看清了很多人！');
  assert.equal(cleanBiliTitle('哔哩哔哩 (゜-゜)つロ 干杯~-bilibili'), '');
  assert.equal(cleanBiliTitle('普通页面标题'), '普通页面标题');
});

test('bvid 提取：playurl 查询参数与页面路径', () => {
  assert.equal(bvidFromPlayurl('https://api.bilibili.com/x/player/wbi/playurl?bvid=BV1xx&cid=1'), 'BV1xx');
  assert.equal(bvidFromPlayurl('https://api.bilibili.com/pgc/player/web/playurl?ep_id=12345'), 'ep12345');
  assert.equal(bvidFromPlayurl('https://a.com/x?aid=999'), 'av999');
  assert.equal(bvidFromPlayurl('https://a.com/x'), '');
  assert.equal(bvidFromPageUrl('https://www.bilibili.com/video/BV1Mybk65EBt/?spm=1'), 'BV1Mybk65EBt');
  assert.equal(bvidFromPageUrl('https://www.bilibili.com/bangumi/play/ep12345'), 'ep12345');
  assert.equal(bvidFromPageUrl('https://www.bilibili.com/'), '');
});

test('segmentGroupKey：连续编号分片归一化分组', () => {
  assert.equal(segmentGroupKey('https://cdn.x.com/v/123/seg_00001.mp4?token=a'), 'cdn.x.com/v/123/seg_.mp4');
  assert.equal(segmentGroupKey('https://cdn.x.com/v/123/seg_00002.mp4?token=b'), 'cdn.x.com/v/123/seg_.mp4');
  assert.equal(segmentGroupKey('https://cdn.x.com/file-1.mp4'), 'cdn.x.com/file-.mp4');
  assert.equal(segmentGroupKey('https://cdn.x.com/123.mp4'), null, '纯数字文件名不分组');
  assert.equal(segmentGroupKey('https://cdn.x.com/bunny.mp4'), null, '无编号不分组');
  assert.equal(segmentGroupKey('not a url'), null);
});

test('applyCapture：连续 mp4 分片聚合为分片流（stream）', () => {
  const state = createEmptyState();
  const g = (i) => ({
    url: 'https://cdn.x.com/seg_' + String(i).padStart(5, '0') + '.mp4',
    tabId: 1,
    contentType: 'video/mp4',
    type: 'video',
    groupKey: 'cdn.x.com/seg_.mp4',
  });
  assert.equal(applyCapture(state, g(1)).changed, 'added');
  assert.equal(state.entries.length, 1);
  assert.equal(state.entries[0]?.type, 'video', '首片仍是普通视频条目');
  const r2 = applyCapture(state, g(2));
  assert.equal(r2.changed, 'segmented');
  assert.equal(state.entries.length, 1, '不新增条目');
  assert.equal(state.entries[0]?.type, 'stream', '第二片出现时转为分片流');
  assert.deepEqual(state.entries[0]?.segmentUrls, [g(1).url, g(2).url]);
  applyCapture(state, g(3));
  assert.equal(state.entries[0]?.segmentCount, 3);
  // 不同分组互不影响
  applyCapture(state, { ...g(1), url: 'https://cdn.x.com/other_1.mp4', groupKey: 'cdn.x.com/other_.mp4' });
  assert.equal(state.entries.length, 2);
  assert.equal(state.entries[0]?.type, 'video');
});

test('applyCapture：列表条数上限', () => {
  const state = createEmptyState();
  for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
    applyCapture(state, cap({ url: 'https://a.com/v' + i + '.mp4' }));
  }
  assert.equal(state.entries.length, MAX_ENTRIES);
  assert.equal(state.entries[0].url, 'https://a.com/v204.mp4');
});
