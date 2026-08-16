import { appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameParser, handleMessage, serializeMessage } from './lib/protocol.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const logPath = join(here, 'host.log');

function log(line) {
  // 协议帧只走 stdout；日志走 stderr + 文件，绝不混入协议通道
  console.error(line);
  try {
    appendFileSync(logPath, line + '\n', 'utf8');
  } catch {
    // 日志写入失败不影响协议通道
  }
}

function stamp() {
  const d = new Date();
  const p = (x) => String(x).padStart(2, '0');
  return (
    d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
    ' ' + p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds())
  );
}

const parser = new FrameParser(
  (msg) => {
    if (msg !== null && typeof msg === 'object' && msg.type === 'capture') {
      const entries = Array.isArray(msg.entries) ? msg.entries : [];
      log('[' + stamp() + '] 收到 ' + entries.length + ' 条捕获记录');
      let i = 0;
      for (const e of entries) {
        i += 1;
        log('  ' + i + '. [' + (e.mediaType ?? '?') + '] ' + (e.url ?? ''));
        log('     Content-Type: ' + (e.contentType || '-') + '  大小: ' + (e.size != null ? String(e.size) : '-'));
        log('     Cookie:   ' + (e.cookie || '(无)'));
        log('     Referer:  ' + (e.referer || '(无)'));
        log('     User-Agent: ' + (e.userAgent || '(无)'));
        log('     页面: ' + (e.pageTitle || '') + ' ' + (e.pageUrl || ''));
      }
    }
    for (const resp of handleMessage(msg)) {
      process.stdout.write(serializeMessage(resp));
    }
  },
  (err) => {
    log('[host] 解析错误: ' + err.message);
  },
);

process.stdin.on('data', (chunk) => parser.push(chunk));
process.stdin.on('end', () => process.exit(0));
process.stdin.on('error', (err) => {
  log('[host] stdin 错误: ' + err.message);
  process.exit(1);
});

log('[host] 已启动，等待扩展连接...');
