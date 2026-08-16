// HLS（m3u8）解析：master 变体选择 + 媒体清单（分片/AES-128 密钥/初始化段/字节范围）
export function parseAttrList(s) {
  const out = {};
  const re = /([A-Za-z0-9-]+)=("([^"]*)"|([^,]*))/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    out[m[1]] = m[3] !== undefined ? m[3] : (m[4] ?? '');
  }
  return out;
}

export function parseByteRange(v) {
  const m = /^(\d+)(?:@(\d+))?$/.exec(String(v ?? '').trim());
  if (m === null) return null;
  return { length: Number(m[1]), offset: m[2] !== undefined ? Number(m[2]) : null };
}

export function parseKeyTag(line) {
  const attrs = parseAttrList(line.slice('#EXT-X-KEY:'.length));
  return {
    method: attrs.METHOD ?? 'NONE',
    uri: attrs.URI !== undefined ? attrs.URI : null,
    iv: attrs.IV !== undefined ? String(attrs.IV).replace(/^0x/i, '') : null,
  };
}

// 返回变体列表（带宽/分辨率/URL）；非 master 返回空数组
export function parseMasterPlaylist(text, baseUrl) {
  const variants = [];
  let pending = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXT-X-STREAM-INF')) {
      const attrs = parseAttrList(line.slice('#EXT-X-STREAM-INF:'.length));
      pending = {
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        resolution: attrs.RESOLUTION ?? null,
        codecs: attrs.CODECS ?? null,
      };
      continue;
    }
    if (line.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      pending = null;
      continue;
    }
    if (line.startsWith('#')) continue;
    if (pending !== null) {
      variants.push({ ...pending, url: new URL(line, baseUrl).toString() });
      pending = null;
    }
  }
  return variants;
}

// 返回 { segments, mediaSequence, targetDuration, endlist, playlistType, isVod, hasFmp4 }
export function parseMediaPlaylist(text, baseUrl) {
  let currentKey = null;
  let currentMap = null;
  let pendingByterange = null;
  let pendingDuration = null;
  let mediaSequence = 0;
  let endlist = false;
  let playlistType = null;
  let targetDuration = null;
  let hasFmp4 = false;
  const segments = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '') continue;
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = Number(line.split(':')[1]) || 0;
      continue;
    }
    if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = Number(line.split(':')[1]) || null;
      continue;
    }
    if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.split(':')[1].trim();
      continue;
    }
    if (line.startsWith('#EXT-X-ENDLIST')) {
      endlist = true;
      continue;
    }
    if (line.startsWith('#EXT-X-KEY:')) {
      const key = parseKeyTag(line);
      currentKey = key.method === 'NONE' || key.method === '' ? null : key;
      continue;
    }
    if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttrList(line.slice('#EXT-X-MAP:'.length));
      currentMap = attrs.URI !== undefined && attrs.URI !== ''
        ? { uri: new URL(attrs.URI, baseUrl).toString(), byterange: parseByteRange(attrs.BYTERANGE) }
        : null;
      hasFmp4 = true;
      continue;
    }
    if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingByterange = parseByteRange(line.split(':')[1]);
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const m = /^#EXTINF:([\d.]+)/.exec(line);
      pendingDuration = m !== null ? Number(m[1]) : 0;
      continue;
    }
    if (line.startsWith('#')) continue;
    segments.push({
      url: new URL(line, baseUrl).toString(),
      duration: pendingDuration ?? 0,
      byterange: pendingByterange,
      key: currentKey !== null && currentKey.uri !== null
        ? { ...currentKey, url: new URL(currentKey.uri, baseUrl).toString() }
        : null,
      map: currentMap,
    });
    pendingByterange = null;
    pendingDuration = null;
  }
  return {
    segments,
    mediaSequence,
    targetDuration,
    endlist,
    playlistType,
    isVod: endlist || playlistType === 'VOD',
    hasFmp4,
  };
}
