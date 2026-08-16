#!/usr/bin/env node
// 多线程下载器 CLI
// 用法: node cli.mjs <url> [-o out] [-n 线程数] [-l 限速KB/s] [--cookie C] [--referer R] [-u UA] [--header "Name: Value"] [--fresh]
import { basename, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { Downloader, DownloadError } from './lib/downloader.mjs';

const { values, positionals } = parseArgs({
  options: {
    out: { type: 'string', short: 'o' },
    connections: { type: 'string', short: 'n' },
    limit: { type: 'string', short: 'l' },
    cookie: { type: 'string' },
    referer: { type: 'string' },
    'user-agent': { type: 'string', short: 'u' },
    header: { type: 'string', multiple: true },
    fresh: { type: 'boolean' },
    help: { type: 'boolean', short: 'h' },
  },
  allowPositionals: true,
});

function usage() {
  console.log('用法: node cli.mjs <url> [选项]');
  console.log('  -o, --out <文件>        输出路径（默认取 URL 文件名）');
  console.log('  -n, --connections <n>   并发连接数（默认 8，自动动态切分）');
  console.log('  -l, --limit <KB/s>      全局限速（KB/s）');
  console.log('      --cookie <str>      请求 Cookie（透传，避免 403）');
  console.log('      --referer <str>     请求 Referer');
  console.log('  -u, --user-agent <str>  请求 User-Agent');
  console.log('      --header "N: V"     自定义请求头（可多次）');
  console.log('      --fresh             忽略已有进度，重新下载');
  console.log('  -h, --help              显示帮助');
  console.log('下载中断后，用相同命令重新运行即可续传（依赖 <out>.meta.json 进度文件）。');
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

let out = values.out;
if (out === undefined) {
  try {
    out = basename(new URL(url).pathname) || 'download.bin';
  } catch {
    out = 'download.bin';
  }
}
out = resolve(out);

const connections = values.connections !== undefined ? Math.max(1, Number(values.connections) || 1) : undefined;
const limit = values.limit !== undefined ? Math.max(0, Number(values.limit)) * 1024 : undefined;

const ac = new AbortController();
let interrupted = false;
process.on('SIGINT', () => {
  interrupted = true;
  console.error('\n收到中断，保存进度后退出...');
  ac.abort();
});

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let u = 0;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u += 1;
  }
  return (v >= 100 || u === 0 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[u];
}

const dl = new Downloader({
  url,
  out,
  headers,
  connections,
  limitBytesPerSec: limit,
  fresh: values.fresh ?? false,
  signal: ac.signal,
  onProgress: (pr) => {
    const pct = pr.total != null && pr.total > 0 ? Math.min(100, (pr.completed / pr.total) * 100) : null;
    const line =
      (pct !== null ? pct.toFixed(1).padStart(5) + '%' : fmtBytes(pr.completed)) +
      '  ' + fmtBytes(pr.speed) + '/s' +
      (pr.total != null ? '  共 ' + fmtBytes(pr.total) : '');
    process.stdout.write('\r' + line.padEnd(50));
  },
});

try {
  const result = await dl.download();
  process.stdout.write('\r' + ' '.repeat(60) + '\r');
  const mode = result.fallbackSingle ? '单线程（服务器不支持/忽略 Range）' : result.connections + ' 线程';
  console.log('完成: ' + out);
  console.log('大小: ' + fmtBytes(result.bytes) + '  用时: ' + (result.elapsedMs / 1000).toFixed(1) + 's  平均: ' + fmtBytes(result.avgSpeed) + '/s  ' + mode);
} catch (err) {
  process.stdout.write('\n');
  if (err?.name === 'AbortError' || interrupted) {
    console.error('已中断，进度已保存；用相同命令重新运行可续传。');
    process.exit(130);
  }
  if (err instanceof DownloadError) {
    console.error('下载失败: ' + err.message);
  } else {
    console.error('下载失败: ' + (err?.message ?? String(err)));
  }
  process.exit(1);
}
