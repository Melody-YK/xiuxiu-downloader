// 分片下载器：并发下载 + AES-128 解密（PKCS7 去填充）+ fMP4 初始化段前置 + 字节范围
import { createDecipheriv } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function decryptAes128(data, key, iv) {
  const d = createDecipheriv('aes-128-cbc', key, iv);
  // Node 默认会自动剥 PKCS7 填充；这里显式关闭并自行处理（HLS 规范 RFC 8216 要求 PKCS7）
  d.setAutoPadding(false);
  const out = Buffer.concat([d.update(data), d.final()]);
  const pad = out.length > 0 ? out[out.length - 1] : 0;
  if (pad > 0 && pad <= 16) return out.subarray(0, out.length - pad);
  return out;
}

export function ivBuffer(keyObj, seq) {
  if (keyObj.iv !== null && keyObj.iv !== undefined && keyObj.iv !== '') {
    return Buffer.from(keyObj.iv, 'hex');
  }
  const b = Buffer.alloc(16);
  b.writeUInt32BE(seq >>> 0, 12);
  return b;
}

export async function fetchBytes(url, headers, byterange, signal) {
  const h = { ...headers };
  if (byterange !== null && byterange !== undefined && byterange.length != null) {
    const start = byterange.offset ?? 0;
    h.Range = 'bytes=' + start + '-' + (start + byterange.length - 1);
  }
  const res = await fetch(url, { headers: h, redirect: 'follow', signal });
  if (!res.ok && res.status !== 206) {
    try {
      await res.body?.cancel();
    } catch {
      // 忽略
    }
    throw new Error('分片下载失败: HTTP ' + res.status + ' ' + url);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  if (byterange !== null && byterange !== undefined && byterange.length != null && buf.length !== byterange.length) {
    throw new Error('字节范围长度不符: ' + url);
  }
  return buf;
}

// tasks: [{ url, byterange?, key?: {url,method,iv}, ivSeq, map?: {uri,byterange} }]
// 返回按任务顺序排列的本地文件路径
export async function downloadSegments(tasks, opts) {
  const { headers = {}, connections = 8, workDir, onProgress = () => {}, signal } = opts;
  await mkdir(workDir, { recursive: true });
  const keyCache = new Map();
  const results = new Array(tasks.length);
  let next = 0;
  let done = 0;
  let firstErr = null;

  const worker = async () => {
    for (;;) {
      if (signal?.aborted) return;
      const i = next;
      next += 1;
      if (i >= tasks.length) return;
      const t = tasks[i];
      try {
        let data = await fetchBytes(t.url, headers, t.byterange ?? null, signal);
        if (t.key !== null && t.key !== undefined && t.key.method === 'AES-128') {
          let keyBuf = keyCache.get(t.key.url);
          if (keyBuf === undefined) {
            keyBuf = await fetchBytes(t.key.url, headers, null, signal);
            if (keyBuf.length !== 16) throw new Error('AES-128 密钥长度应为 16 字节: ' + t.key.url);
            keyCache.set(t.key.url, keyBuf);
          }
          data = decryptAes128(data, keyBuf, ivBuffer(t.key, t.ivSeq));
        }
        if (t.map !== null && t.map !== undefined) {
          const init = await fetchBytes(t.map.uri, headers, t.map.byterange ?? null, signal);
          data = Buffer.concat([init, data]);
        }
        const file = join(workDir, 'seg_' + String(i).padStart(5, '0') + '.bin');
        await writeFile(file, data);
        results[i] = file;
        done += 1;
        onProgress({ done, total: tasks.length, index: i, bytes: data.length });
      } catch (err) {
        if (firstErr === null) firstErr = err;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(connections, tasks.length) }, () => worker()));
  if (firstErr !== null) throw firstErr;
  if (results.some((r) => r === undefined)) throw new Error('分片未全部下载完成');
  return results;
}
