// 合并：二进制顺序拼接（TS 直接拼接；fMP4/DASH 初始化段已前置）→ ffmpeg 转封装 / 音视频合并
import { createReadStream, createWriteStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

export async function concatFiles(files, outPath) {
  const ws = createWriteStream(outPath);
  ws.setMaxListeners(0); // 同一个 WriteStream 被 pipeline 复用多次，避免默认 10 个监听器告警
  for (const f of files) {
    await pipeline(createReadStream(f), ws, { end: false });
  }
  ws.end();
  await new Promise((resolve, reject) => {
    ws.on('finish', resolve);
    ws.on('error', reject);
  });
  return outPath;
}

function runFfmpeg(args, out, errPrefix) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'ffmpeg',
      ['-y', '-hide_banner', '-loglevel', 'error', ...args, out],
      { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] },
    );
    let errOut = '';
    child.stderr.on('data', (d) => {
      errOut += d.toString();
    });
    child.on('error', (e) => reject(new Error('无法启动 ffmpeg（请确认已安装并在 PATH 中）: ' + e.message)));
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(errPrefix + ': ' + (errOut.trim().slice(-500) || 'exit ' + code)));
    });
  });
}

export function ffmpegRemux(input, out) {
  return runFfmpeg(['-i', input, '-c', 'copy', '-movflags', '+faststart'], out, 'ffmpeg 合并失败');
}

export function ffmpegMuxAV(video, audio, out) {
  return runFfmpeg(['-i', video, '-i', audio, '-c', 'copy', '-movflags', '+faststart'], out, 'ffmpeg 音视频合并失败');
}
