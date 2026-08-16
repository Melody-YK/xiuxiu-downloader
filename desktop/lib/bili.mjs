// B站 playurl 接口支持：解析 JSON（dash 双轨 / flv 单轨）并择优
// 注意：B站不走 .mpd 清单，播放地址接口返回 JSON，里面才是 m4s/flv 真实地址
export function isBiliPlayurlUrl(url) {
  // 按路径识别（不限定域名）：真实 B站接口与本地测试服务器均适用（含 WBI 签名路径）
  return /\/(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/playurl)/i.test(url);
}

function pickBest(list) {
  if (!Array.isArray(list)) return null;
  let best = null;
  for (const it of list) {
    if (typeof it?.baseUrl !== 'string' || it.baseUrl === '') continue;
    const bw = Number(it.bandwidth) || 0;
    if (best === null || bw > best.bandwidth) {
      best = {
        url: it.baseUrl,
        bandwidth: bw,
        id: it.id ?? null,
        mimeType: it.mimeType ?? '',
        codecs: it.codecs ?? '',
        width: it.width ?? null,
        height: it.height ?? null,
      };
    }
  }
  return best;
}

export function parseBiliPlayurl(json) {
  const data = json?.data ?? json?.result ?? json ?? null;
  if (data === null || typeof data !== 'object') throw new Error('B站接口返回格式异常');
  if (typeof data.code === 'number' && data.code !== 0) {
    throw new Error('B站接口错误: code ' + data.code + (data.code === -404 ? '（需要大会员/登录）' : ''));
  }
  if (Array.isArray(data.durl) && data.durl.length > 0) {
    const first = data.durl[0];
    if (typeof first?.url !== 'string' || first.url === '') throw new Error('B站 flv 地址缺失');
    return { kind: 'flv', url: first.url, quality: data.quality ?? null };
  }
  const dash = data.dash;
  if (dash === null || typeof dash !== 'object') throw new Error('B站接口未返回 dash/durl（可能需要登录）');
  const video = pickBest(dash.video);
  const audio = pickBest(dash.audio);
  if (video === null) throw new Error('B站接口未返回视频流');
  return { kind: 'dash', video, audio };
}
