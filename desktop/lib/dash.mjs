// DASH（mpd）最小解析：单 Period + SegmentTemplate($Number$/$RepresentationID$) + SegmentTimeline 计数
export function xmlAttr(tagText, name) {
  const re = new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i');
  const m = re.exec(tagText);
  return m !== null ? m[1] : null;
}

export function extractTags(xml, tagName) {
  const out = [];
  const re = new RegExp(
    '<' + tagName + '\\b([^>]*)>([\\s\\S]*?)<\\/' + tagName + '>|<' + tagName + '\\b([^>]*)\\/>',
    'gi',
  );
  let m;
  while ((m = re.exec(xml)) !== null) {
    out.push({ attrs: m[1] ?? m[3] ?? '', body: m[2] ?? '' });
  }
  return out;
}

function findBaseUrl(xml) {
  // 只接受"直接子级"的 BaseURL：若首个 BaseURL 之前已出现更深层容器标签，则它属于子级，不算本级
  const m = /<BaseURL>([^<]+)<\/BaseURL>/.exec(xml);
  if (m === null) return '';
  const nested = /<(AdaptationSet|Representation|SegmentTemplate|SegmentList)\b/i.exec(xml);
  if (nested !== null && nested.index < m.index) return '';
  return m[1].trim();
}

export function parseSegmentTimelineCount(templateXml) {
  let count = 0;
  const re = /<S\b([^>]*?)\/?>/gi;
  let m;
  while ((m = re.exec(templateXml)) !== null) {
    const d = Number(xmlAttr(m[1], 'd')) || 0;
    const r = Number(xmlAttr(m[1], 'r'));
    count += Number.isFinite(r) && r >= 0 ? r + 1 : 1;
  }
  return count;
}

export function parseMpd(text, baseUrl) {
  const periods = extractTags(text, 'Period');
  const period = periods[0] ?? { attrs: '', body: text };

  // 选择带宽最高的视频 Representation（无视频时选带宽最高的）
  let chosen = null;
  for (const as of extractTags(period.body, 'AdaptationSet')) {
    const mime = xmlAttr(as.attrs, 'mimeType') ?? xmlAttr(as.attrs, 'contentType');
    for (const repr of extractTags(as.body, 'Representation')) {
      const bandwidth = Number(xmlAttr(repr.attrs, 'bandwidth')) || 0;
      const isVideo = (mime ?? '').startsWith('video');
      const score = (isVideo ? 1e12 : 0) + bandwidth;
      const prev = chosen === null ? -1 : (chosen.isVideo ? 1e12 : 0) + chosen.bandwidth;
      if (chosen === null || score > prev) {
        chosen = { repr, as, bandwidth, isVideo, mime };
      }
    }
  }
  if (chosen === null) throw new Error('MPD 中未找到 Representation');
  const reprXml = chosen.repr.attrs + '>' + chosen.repr.body;
  const asXml = chosen.as.attrs + '>' + chosen.as.body;

  const st =
    extractTags(reprXml, 'SegmentTemplate')[0] ??
    extractTags(asXml, 'SegmentTemplate')[0] ??
    extractTags(period.body, 'SegmentTemplate')[0];
  if (st === undefined) throw new Error('仅支持 SegmentTemplate 形式的 MPD');
  const stXml = st.attrs + '>' + st.body;
  const media = xmlAttr(stXml, 'media');
  if (media === null) throw new Error('SegmentTemplate 缺少 media 属性');
  const initialization = xmlAttr(stXml, 'initialization');
  const id = xmlAttr(reprXml, 'id') ?? '';
  const startNumber = Number(xmlAttr(stXml, 'startNumber')) || 1;

  // BaseURL 逐级解析：MPD → Period → AdaptationSet → Representation
  let base = baseUrl;
  const mpdBase = findBaseUrl(text.slice(0, Math.max(0, text.indexOf('<Period'))));
  if (mpdBase !== '') base = new URL(mpdBase, base).toString();
  const periodBase = findBaseUrl(period.body);
  if (periodBase !== '') base = new URL(periodBase, base).toString();
  const asBase = findBaseUrl(asXml);
  if (asBase !== '') base = new URL(asBase, base).toString();
  const reprBase = findBaseUrl(reprXml);
  if (reprBase !== '') base = new URL(reprBase, base).toString();

  const buildUrlFrom = (tpl, num) => {
    let s = tpl.split('$RepresentationID$').join(id);
    s = s.replace(/\$Number(?:%0(\d+)d)?\$/, (_all, w) => (w !== undefined ? String(num).padStart(Number(w), '0') : String(num)));
    return new URL(s, base).toString();
  };

  return {
    initUrl: initialization !== null && initialization !== '' ? buildUrlFrom(initialization, startNumber) : null,
    count: parseSegmentTimelineCount(stXml),
    startNumber,
    buildSegmentUrl: (num) => buildUrlFrom(media, num),
    representation: { bandwidth: chosen.bandwidth, mime: chosen.mime ?? '', id },
  };
}

// 无 SegmentTimeline 时按顺序探测（HEAD，404 结束）
export async function probeSegmentCount(buildUrl, startNumber, headers, opts = {}) {
  const max = opts.max ?? 5000;
  let count = 0;
  for (let n = startNumber; n < startNumber + max; n += 1) {
    const url = buildUrl(n);
    try {
      const res = await fetch(url, { method: 'HEAD', headers, redirect: 'follow' });
      if (res.status === 404) break;
      if (!res.ok && res.status !== 206) break;
      try {
        await res.body?.cancel();
      } catch {
        // 忽略
      }
      count += 1;
    } catch {
      break;
    }
  }
  return count;
}
