#!/usr/bin/env node
// 流媒体下载 CLI：node media-cli.mjs <m3u8|mpd url> [-o out.mp4] [-n 线程] [--variant N] [--list] [--cookie C] [--referer R] [-u UA] [--keep]
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { parseMasterPlaylist } from './lib/hls.mjs';
import { downloadMedia } from './lib/pipeline.mjs';

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
  if (values.list) {
    const res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
    if (!res.ok) throw new Error('清单请求失败: HTTP ' + res.status);
    const text = await res.text();
    const variants = parseMasterPlaylist(text, res.url || url);
    if (variants.length === 0) {
      console.log('该清单没有多清晰度变体（本身就是媒体清单）。');
      process.exit(0);
    }
    console.log('可用清晰度（--variant 选择，默认 0 = 最高）：');
    variants.forEach((v, i) => {
      console.log('  [' + i + '] ' + (v.resolution ?? '?') + ' ' + (v.bandwidth / 1000).toFixed(0) + 'kbps ' + (v.codecs ?? ''));
    });
    process.exit(0);
  }

  const t0 = Date.now();
  const result = await downloadMedia({
    url,
    out,
    headers,
    connections,
    variantIdx,
    keep: values.keep ?? false,
    signal: ac.signal,
    onPhase: (s) => console.log(s),
    onProgress: (p) => {
      process.stdout.write('\r  分片 ' + p.done + '/' + p.total);
    },
  });
  process.stdout.write('\n');
  console.log('完成: ' + result.out + '  用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's');
} catch (err) {
  process.stdout.write('\n');
  console.error('失败: ' + (err?.message ?? String(err)));
  process.exit(1);
}
