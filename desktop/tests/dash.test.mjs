import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMpd, parseSegmentTimelineCount } from '../lib/dash.mjs';

test('parseSegmentTimelineCount：r 重复展开', () => {
  assert.equal(parseSegmentTimelineCount('<SegmentTimeline><S t="0" d="2000000" r="4"/></SegmentTimeline>'), 5);
  assert.equal(parseSegmentTimelineCount('<SegmentTimeline><S d="1"/><S d="1" r="1"/></SegmentTimeline>'), 3);
});

test('parseMpd：BaseURL 逐级解析 + 视频 Representation 择优 + URL 生成', () => {
  const mpd = `<?xml version="1.0"?>
<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" mediaPresentationDuration="PT10S">
  <BaseURL>base/</BaseURL>
  <Period>
    <AdaptationSet mimeType="audio/mp4">
      <Representation id="a0" bandwidth="128000">
        <SegmentTemplate media="a_$Number$.m4s" initialization="a-init.mp4" startNumber="1">
          <SegmentTimeline><S t="0" d="2000000" r="4"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
    <AdaptationSet mimeType="video/mp4" segmentAlignment="true">
      <Representation id="v0" bandwidth="3000000" width="1920" height="1080">
        <BaseURL>high/</BaseURL>
        <SegmentTemplate media="chunk_$Number%05d$.m4s" initialization="init.mp4" startNumber="1">
          <SegmentTimeline><S t="0" d="2000000" r="4"/></SegmentTimeline>
        </SegmentTemplate>
      </Representation>
    </AdaptationSet>
  </Period>
</MPD>`;
  const p = parseMpd(mpd, 'http://x/manifest.mpd');
  assert.equal(p.count, 5);
  assert.equal(p.representation.bandwidth, 3000000);
  assert.equal(p.representation.mime, 'video/mp4');
  assert.equal(p.initUrl, 'http://x/base/high/init.mp4');
  assert.equal(p.buildSegmentUrl(p.startNumber), 'http://x/base/high/chunk_00001.m4s');
  assert.equal(p.buildSegmentUrl(p.startNumber + 4), 'http://x/base/high/chunk_00005.m4s');
});

test('parseMpd：SegmentList 形式应明确报错（仅支持 SegmentTemplate）', () => {
  const mpd = `<MPD><Period>
    <AdaptationSet mimeType="video/mp4">
      <Representation id="v" bandwidth="1000000"><SegmentList><SegmentURL media="s1.m4s"/></SegmentList></Representation>
    </AdaptationSet>
  </Period></MPD>`;
  assert.throws(() => parseMpd(mpd, 'http://x/m.mpd'), /SegmentTemplate/);
});
