// 流媒体下载管线（CLI 与 GUI 共用）：清单解析 → 分片下载 → 合并 → ffmpeg 转封装
import { basename, dirname, join } from 'node:path';
import { mkdir, rm } from 'node:fs/promises';
import { parseMasterPlaylist, parseMediaPlaylist } from './hls.mjs';
import { parseMpd, probeSegmentCount } from './dash.mjs';
import { downloadSegments } from './segments.mjs';
import { concatFiles, ffmpegConcat, ffmpegMuxAV, ffmpegRemux } from './merge.mjs';
import { Downloader } from './downloader.mjs';
import { isBiliPlayurlUrl, parseBiliPlayurl } from './bili.mjs';

const BILI_DEFAULT_HEADERS = {
  Referer: 'https://www.bilibili.com/',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
};

// 无清单站点的 mp4 分片流：按序号排序 → 并发下载 → 拼接 → ffmpeg 转封装
function segIndexOf(u) {
  try {
    const m = /(\d+)(\.[A-Za-z0-9]{2,5})$/.exec(new URL(u).pathname);
    return m !== null ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

async function downloadStream(opts) {
  const { out, headers = {}, connections = 8, keep = false, signal, onProgress = () => {}, onPhase = () => {} } = opts;
  const urls = [...opts.streamUrls].sort((a, b) => segIndexOf(a) - segIndexOf(b));
  // 空洞检测：索引不连续说明有分片未被请求（如拖动进度条跳过），硬拼会产出坏文件
  const indices = urls.map(segIndexOf);
  const uniqueIdx = new Set(indices).size === indices.length;
  if (uniqueIdx && indices.length > 1) {
    for (let i = 1; i < indices.length; i += 1) {
      if (indices[i] !== indices[i - 1] + 1) {
        throw new Error(
          '分片不连续（缺失 ' + (indices[i - 1] + 1) + '..' + (indices[i] - 1) +
          '），无法完整拼接。请从头完整播放后再下载（可倍速+静音；拖动进度条不会补齐中间分片）',
        );
      }
    }
  }
  onPhase('分片流: ' + urls.length + ' 个分片' + (opts.truncated === true ? '（已截断，仅前段）' : ''));
  const workDir = join(dirname(out), basename(out) + '.parts');
  await rm(workDir, { recursive: true, force: true });
  const tasks = urls.map((u) => ({ url: u, byterange: null, key: null, map: null }));
  const files = await downloadSegments(tasks, { headers, connections, workDir, signal, onProgress });
  onPhase('ffmpeg 拼接分片');
  try {
    // 每片都是独立 MP4 时使用 concat demuxer。
    await ffmpegConcat(files, out);
  } catch (firstError) {
    // 部分站点返回 fMP4/TS 片段，片段本身没有 moov；改为二进制顺序拼接后再转封装。
    onPhase('尝试按 fMP4/TS 顺序拼接');
    const merged = await concatFiles(files, join(workDir, 'merged-stream.bin'));
    try {
      await ffmpegRemux(merged, out);
    } catch (fallbackError) {
      const detail = fallbackError?.message ?? firstError?.message ?? String(fallbackError);
      throw new Error('分片无法组成可播放视频：' + detail + '。请从头完整播放后重新捕获，且不要在播放结束前点击下载。');
    }
  }
  if (!keep) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  return { out, kind: 'stream', segments: urls.length, label: '分片流' };
}

async function downloadBili(opts) {
  const { url, out, headers = {}, connections = 8, keep = false, signal, onProgress = () => {}, onPhase = () => {} } = opts;
  const h = { ...BILI_DEFAULT_HEADERS, ...headers };
  onPhase('请求 B站播放地址接口');
  const res = await fetch(url, { headers: h, redirect: 'follow', signal });
  if (!res.ok) {
    throw new Error('B站接口请求失败: HTTP ' + res.status + (res.status === 403 ? '（可能被风控，需登录 Cookie）' : ''));
  }
  const json = await res.json();
  const parsed = parseBiliPlayurl(json);
  const workDir = join(dirname(out), basename(out) + '.parts');
  await rm(workDir, { recursive: true, force: true });
  await mkdir(workDir, { recursive: true });

  try {
    if (parsed.kind === 'flv') {
      onPhase('flv 单轨下载');
      const dl = new Downloader({ url: parsed.url, out: join(workDir, 'video.flv'), headers: h, connections, signal, onProgress });
      await dl.download();
      onPhase('ffmpeg 转封装');
      await ffmpegRemux(join(workDir, 'video.flv'), out);
    } else {
      const videoPath = join(workDir, 'video.m4s');
      const audioPath = join(workDir, 'audio.m4s');
      onPhase('下载视频轨 ' + (parsed.video.codecs || '') + ' ' + (parsed.video.width ?? '') + 'x' + (parsed.video.height ?? ''));
      const vdl = new Downloader({ url: parsed.video.url, out: videoPath, headers: h, connections, signal, onProgress });
      await vdl.download();
      if (parsed.audio !== null) {
        onPhase('下载音频轨');
        const adl = new Downloader({
          url: parsed.audio.url,
          out: audioPath,
          headers: h,
          connections: Math.max(1, Math.min(4, connections)),
          signal,
          onProgress,
        });
        await adl.download();
        onPhase('合并音视频');
        await ffmpegMuxAV(videoPath, audioPath, out);
      } else {
        onPhase('ffmpeg 转封装');
        await ffmpegRemux(videoPath, out);
      }
    }
    return { out, kind: parsed.kind, segments: 2, label: 'B站' };
  } finally {
    if (!keep) await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function downloadMedia(opts) {
  const {
    url,
    out,
    headers = {},
    connections = 8,
    variantIdx = 0,
    keep = false,
    signal,
    onProgress = () => {},
    onPhase = () => {},
  } = opts;

  if (Array.isArray(opts.streamUrls) && opts.streamUrls.length > 0) return downloadStream(opts);
  if (isBiliPlayurlUrl(url)) return downloadBili(opts);

  onPhase('请求清单');
  const res = await fetch(url, { headers, redirect: 'follow', signal });
  if (!res.ok) throw new Error('清单请求失败: HTTP ' + res.status);
  const text = await res.text();
  const finalUrl = res.url || url;

  let tasks;
  let kind; // 'ts' | 'fmp4' | 'dash'
  let label;
  if (/<(MPD|mpd)\b/i.test(text)) {
    const mpd = parseMpd(text, finalUrl);
    let count = mpd.count;
    if (count === 0) {
      onPhase('探测分片数量');
      count = await probeSegmentCount(mpd.buildSegmentUrl, mpd.startNumber, headers);
    }
    if (count === 0) throw new Error('未找到 DASH 分片');
    label = 'DASH: ' + mpd.representation.mime + ' ' + (mpd.representation.bandwidth / 1000).toFixed(0) + 'kbps, ' + count + ' 个分片';
    tasks = [];
    for (let i = 0; i < count; i += 1) tasks.push({ url: mpd.buildSegmentUrl(mpd.startNumber + i) });
    kind = 'dash';
  } else {
    const variants = parseMasterPlaylist(text, finalUrl);
    let mediaText = text;
    let mediaUrl = finalUrl;
    if (variants.length > 0) {
      const v = variants[Math.min(variantIdx, variants.length - 1)];
      label = '选择清晰度: ' + (v.resolution ?? '?') + ' ' + (v.bandwidth / 1000).toFixed(0) + 'kbps';
      const r2 = await fetch(v.url, { headers, redirect: 'follow', signal });
      if (!r2.ok) throw new Error('media playlist 请求失败: HTTP ' + r2.status);
      mediaText = await r2.text();
      mediaUrl = r2.url || v.url;
    }
    const mp = parseMediaPlaylist(mediaText, mediaUrl);
    if (mp.segments.length === 0) throw new Error('未解析到分片');
    label = 'HLS: ' + mp.segments.length + ' 个分片' + (mp.isVod ? ' (VOD)' : ' (直播，仅当前清单)') + (mp.hasFmp4 ? ' [fMP4]' : ' [TS]');
    tasks = mp.segments.map((s, i) => ({
      url: s.url,
      byterange: s.byterange,
      key: s.key,
      ivSeq: mp.mediaSequence + i,
      map: s.map,
    }));
    kind = mp.hasFmp4 ? 'fmp4' : 'ts';
  }
  onPhase(label);

  for (const t of tasks) {
    if (t.key !== null && t.key !== undefined && t.key.method !== 'AES-128') {
      throw new Error('暂不支持的加密方式: ' + t.key.method + '（DRM 明确不支持）');
    }
  }

  const workDir = join(dirname(out), basename(out) + '.parts');
  await rm(workDir, { recursive: true, force: true });
  onPhase('下载分片 (' + connections + ' 并发)');
  const files = await downloadSegments(tasks, { headers, connections, workDir, signal, onProgress });
  onPhase('合并分片');
  const mergedExt = kind === 'ts' ? '.ts' : '.mp4';
  const merged = await concatFiles(files, join(workDir, 'merged' + mergedExt));
  onPhase('ffmpeg 转封装');
  await ffmpegRemux(merged, out);
  if (!keep) await rm(workDir, { recursive: true, force: true });
  return { out, kind, segments: tasks.length, label };
}
