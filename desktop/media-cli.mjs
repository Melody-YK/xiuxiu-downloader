#!/usr/bin/env node
// 流媒体下载 CLI：node media-cli.mjs <m3u8|mpd url> [-o out.mp4] [-n 线程] [--variant N] [--list] [--cookie C] [--referer R] [-u UA] [--keep]
import { basename, dirname, join, resolve } from 'node:path';
import { rm } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { parseMasterPlaylist, parseMediaPlaylist } from './lib/hls.mjs';
import { parseMpd, probeSegmentCount } from './lib/dash.mjs';
import { downloadSegments } from './lib/segments.mjs';
import { concatFiles, ffmpegRemux } from './lib/merge.mjs';

const { values, positionals } = parseArgs({
  options: {
    out: { type: 'string', short: 'o' },
    connections: { type: 'string', short: 'n' },
    variant: { type: 'string' },
    list: { type: 'boolean' },
    cookie: { type: 'string' },
    referer: { type: 'string' },
    'user-agent': { type: 'string', short: 'u' },
    header: { type: 'string', multiple: true },
    keep: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

function usage() {
  console.log('用法: node media-cli.mjs <m3u8|mpd 地址> [选项]');
  console.log('  -o, --out <文件>        输出 mp4 路径（默认 output.mp4）');
  console.log('  -n, --connections <n>   分片下载并发数（默认 8）');
  console.log('      --variant <N>       master 清单选第 N 个清晰度（默认 0 = 最高）');
  console.log('      --list              列出 master 清单全部清晰度后退出');
  console.log('      --cookie <str>      请求 Cookie（透传，避免 403）');
  console.log('      --referer <str>     请求 Referer');
  console.log('  -u, --user-agent <str>  请求 User-Agent');
  console.log('      --header "N: V"     自定义请求头（可多次）');
  console.log('      --keep              保留中间分片目录（<out>.parts）');
  console.log('支持：HLS(m3u8，含 AES-128/字节范围/fMP4) 与 DASH(mpd，SegmentTemplate)；DRM 不支持。');
}

if (values.help || positionals.length !== 1) {
  usage();
  process.exit(values.help ? 0 : 1);
}

const url = positionals[0];
const headers = {};
if (values.cookie !== undefined) headers.Cookie = values.cookie;
if (values.referer !== undefined) headers.Referer = values.referer;
if (values['user-agent'] !== undefined) headers['User-Agent'] = values['user-agent'];
for (const h of values.header ?? []) {
  const i = h.indexOf(':');
  if (i <= 0) {
    console.error('无效 --header（应为 "Name: Value"）: ' + h);
    process.exit(1);
  }
  headers[h.slice(0, i).trim()] = h.slice(i + 1).trim();
}

let out = values.out ?? 'output.mp4';
out = resolve(out);
const connections = values.connections !== undefined ? Math.max(1, Number(values.connections) || 1) : 8;
const variantIdx = values.variant !== undefined ? Math.max(0, Number(values.variant) || 0) : 0;

const ac = new AbortController();
process.on('SIGINT', () => {
  console.error('\n中断');
  ac.abort();
});

try {
  const res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
  if (!res.ok) throw new Error('清单请求失败: HTTP ' + res.status);
  const text = await res.text();
  const finalUrl = res.url || url;

  let tasks;
  let kind; // 'ts' | 'fmp4' | 'dash'
  if (/<(MPD|mpd)\b/i.test(text)) {
    const mpd = parseMpd(text, finalUrl);
    let count = mpd.count;
    if (count === 0) {
      console.log('清单无 SegmentTimeline，探测分片数量...');
      count = await probeSegmentCount(mpd.buildSegmentUrl, mpd.startNumber, headers);
    }
    if (count === 0) throw new Error('未找到 DASH 分片');
    console.log('DASH: ' + mpd.representation.mime + ' ' + (mpd.representation.bandwidth / 1000).toFixed(0) + 'kbps, ' + count + ' 个分片');
    tasks = [];
    for (let i = 0; i < count; i += 1) tasks.push({ url: mpd.buildSegmentUrl(mpd.startNumber + i) });
    kind = 'dash';
  } else {
    const variants = parseMasterPlaylist(text, finalUrl);
    let mediaText = text;
    let mediaUrl = finalUrl;
    if (variants.length > 0) {
      if (values.list) {
        console.log('可用清晰度（--variant 选择，默认 0 = 最高）：');
        variants.forEach((v, i) => {
          console.log('  [' + i + '] ' + (v.resolution ?? '?') + ' ' + (v.bandwidth / 1000).toFixed(0) + 'kbps ' + (v.codecs ?? ''));
        });
        process.exit(0);
      }
      const v = variants[Math.min(variantIdx, variants.length - 1)];
      console.log('选择清晰度: ' + (v.resolution ?? '?') + ' ' + (v.bandwidth / 1000).toFixed(0) + 'kbps ' + (v.codecs ?? ''));
      const r2 = await fetch(v.url, { headers, redirect: 'follow', signal: ac.signal });
      if (!r2.ok) throw new Error('media playlist 请求失败: HTTP ' + r2.status);
      mediaText = await r2.text();
      mediaUrl = r2.url || v.url;
    }
    const mp = parseMediaPlaylist(mediaText, mediaUrl);
    if (mp.segments.length === 0) throw new Error('未解析到分片');
    console.log(
      'HLS: ' + mp.segments.length + ' 个分片' +
      (mp.isVod ? ' (VOD)' : ' (直播/无 ENDLIST，仅下载当前清单)') +
      (mp.hasFmp4 ? ' [fMP4]' : ' [TS]'),
    );
    tasks = mp.segments.map((s, i) => ({
      url: s.url,
      byterange: s.byterange,
      key: s.key,
      ivSeq: mp.mediaSequence + i,
      map: s.map,
    }));
    kind = mp.hasFmp4 ? 'fmp4' : 'ts';
  }

  for (const t of tasks) {
    if (t.key !== null && t.key !== undefined && t.key.method !== 'AES-128') {
      throw new Error('暂不支持的加密方式: ' + t.key.method + '（DRM 明确不支持）');
    }
  }

  const workDir = join(dirname(out), basename(out) + '.parts');
  await rm(workDir, { recursive: true, force: true });
  console.log('下载分片... (' + connections + ' 并发)');
  const t0 = Date.now();
  const files = await downloadSegments(tasks, {
    headers,
    connections,
    workDir,
    signal: ac.signal,
    onProgress: (p) => {
      process.stdout.write('\r  分片 ' + p.done + '/' + p.total);
    },
  });
  process.stdout.write('\n');
  const mergedExt = kind === 'ts' ? '.ts' : '.mp4';
  console.log('合并分片...');
  const merged = await concatFiles(files, join(workDir, 'merged' + mergedExt));
  console.log('ffmpeg 转封装 mp4...');
  await ffmpegRemux(merged, out);
  if (!values.keep) await rm(workDir, { recursive: true, force: true });
  console.log('完成: ' + out + '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
} catch (err) {
  process.stdout.write('\n');
  console.error('失败: ' + (err?.message ?? String(err)));
  process.exit(1);
}
