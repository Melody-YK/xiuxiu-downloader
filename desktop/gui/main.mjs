// Electron 主进程：窗口 + IPC + 扩展捕获接收（host.mjs 通过 http://127.0.0.1:17321/ingest 推送）
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { createServer, request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager, deleteTaskFiles, isMediaUrl, sanitizeFileName } from '../lib/queue.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
const INGEST_PORT = smoke ? 17322 : 17321; // 冒烟自检用独立端口，避免与正在运行的真实 GUI 冲突
if (smoke) {
  // 冒烟模式使用独立 userData：不与真实实例抢单实例锁，也不污染下载历史
  app.setPath('userData', join(tmpdir(), 'dl-gui-smoke'));
}
const jobs = new JobManager({ maxConcurrent: 2 });
const captures = [];
const PRESETS = {
  balanced: { maxConcurrent: 2, defaultThreads: 8 },
  aggressive: { maxConcurrent: 4, defaultThreads: 16 },
  conservative: { maxConcurrent: 1, defaultThreads: 4 },
};
const settings = { mode: 'balanced', maxConcurrent: 2, defaultThreads: 8 };
let win = null;
let historyPath = '';
let settingsPath = '';
let historyTimer = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win !== null && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    historyPath = join(app.getPath('userData'), 'history.json');
    settingsPath = join(app.getPath('userData'), 'settings.json');
    if (!smoke) {
      try {
        const raw = JSON.parse(await readFile(settingsPath, 'utf8'));
        settings.mode = PRESETS[raw?.mode] !== undefined || raw?.mode === 'custom' ? raw.mode : 'balanced';
        if (typeof raw?.maxConcurrent === 'number') settings.maxConcurrent = Math.max(1, Math.min(8, Math.round(raw.maxConcurrent)));
        if (typeof raw?.defaultThreads === 'number') settings.defaultThreads = Math.max(1, Math.min(32, Math.round(raw.defaultThreads)));
      } catch {
        // 无设置文件则用默认值
      }
      jobs.setMaxConcurrent(settings.maxConcurrent);
      try {
        const raw = JSON.parse(await readFile(historyPath, 'utf8'));
        jobs.restoreHistory(Array.isArray(raw) ? raw : []);
      } catch {
        // 无历史文件则忽略
      }
    }
    win = new BrowserWindow({
      width: 980,
      height: 660,
      show: !smoke,
      title: '嗅嗅下载器',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void win.loadFile(join(here, 'renderer', 'index.html'));
    // 关闭窗口：无任务直接退出；有任务先确认（防止误关丢下载）
    win.on('close', (e) => {
      if (smoke) return;
      const running = jobs.getSnapshot().filter((t) => t.status === 'running' || t.status === 'queued').length;
      if (running === 0) return;
      e.preventDefault();
      void dialog
        .showMessageBox(win, {
          type: 'warning',
          buttons: ['退出并中断', '取消'],
          defaultId: 1,
          cancelId: 1,
          title: '下载任务进行中',
          message: '有 ' + running + ' 个任务正在进行，退出将中断它们。',
        })
        .then((r) => {
          if (r.response === 0) {
            win.destroy();
            app.exit(0);
          }
        });
    });
    startIngestServer();
    if (smoke) {
      win.webContents.on('console-message', (_e, _level, message) => {
        console.log('[smoke][renderer] ' + message);
      });
      win.webContents.once('did-finish-load', () => {
        console.log('[smoke] renderer 加载成功, tasks=' + jobs.getSnapshot().length);
        // 端到端自检：模拟扩展捕获推送 → ingest 端点 → 渲染层计数
        const payload = Buffer.from(
          JSON.stringify({
            type: 'capture',
            autoDownload: true,
            entries: [{ url: 'http://127.0.0.1:9/smoke.mp4', mediaType: 'video', cookie: 'c=1', referer: 'https://p/', userAgent: 'UA' }],
          }),
          'utf8',
        );
        const req = request(
          {
            host: '127.0.0.1',
            port: INGEST_PORT,
            path: '/ingest',
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length },
          },
          (res) => {
            res.resume();
            res.on('end', () => {
              setTimeout(() => {
                void win.webContents
                  .executeJavaScript('typeof window.api + "|" + document.getElementById("cap-count").textContent + "|" + document.getElementById("tasks").childElementCount')
                  .then((txt) => {
                    console.log('[smoke] 捕获条目数=' + captures.length + ' 任务数=' + jobs.getSnapshot().length + ' 渲染层[api|cap-count|task行数]=' + txt);
                    app.exit(captures.length === 1 && jobs.getSnapshot().length === 1 && txt.includes('|1|') ? 0 : 1);
                  });
              }, 400);
            });
          },
        );
        req.on('error', (err) => {
          console.error('[smoke] ingest 失败: ' + err.message);
          app.exit(1);
        });
        req.end(payload);
      });
      setTimeout(() => {
        console.error('[smoke] 超时');
        app.exit(1);
      }, 15000);
    }
  });

  // 强制退出：确保关闭窗口后进程彻底结束（不留后台进程）
  app.on('window-all-closed', () => app.exit(0));
}

function startIngestServer() {
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/ingest') {
      res.writeHead(404);
      res.end();
      return;
    }
    let body = '';
    req.on('data', (c) => {
      body += c.toString('utf8');
      if (body.length > 1024 * 1024) req.destroy();
    });
    req.on('end', () => {
      let entries = [];
      let msg = { autoDownload: false };
      try {
        msg = JSON.parse(body);
        entries = Array.isArray(msg.entries) ? msg.entries : [];
      } catch {
        res.writeHead(400);
        res.end();
        return;
      }
      pruneCaptures();
      for (const e of entries) {
        captures.unshift({
          url: e.url ?? '',
          mediaType: e.mediaType ?? 'video',
          contentType: e.contentType ?? '',
          size: e.size ?? null,
          pageUrl: e.pageUrl ?? '',
          pageTitle: e.pageTitle ?? '',
          cookie: e.cookie ?? '',
          referer: e.referer ?? '',
          userAgent: e.userAgent ?? '',
          segmentUrls: Array.isArray(e.segmentUrls) ? e.segmentUrls : [],
          truncated: e.truncated === true,
          at: Date.now(),
        });
        // 网页下载按钮（autoDownload）直达：自动建立下载任务并带上请求头
        if (msg.autoDownload === true && typeof e.url === 'string' && e.url !== '') {
          const headers = {};
          if (e.cookie) headers.Cookie = e.cookie;
          if (e.referer) headers.Referer = e.referer;
          if (e.userAgent) headers['User-Agent'] = e.userAgent;
          const kind = e.mediaType === 'hls' || e.mediaType === 'dash' || e.mediaType === 'stream' ? 'media' : 'auto';
          jobs.add({
            url: e.url,
            out: outForTask({ kind, out: null }, e.url),
            outDir: app.getPath('downloads'),
            kind,
            headers,
            streamUrls: Array.isArray(e.segmentUrls) ? e.segmentUrls : undefined,
          });
        }
      }
      if (captures.length > 100) captures.length = 100;
      if (win !== null && !win.isDestroyed()) {
        if (!win.isFocused()) win.flashFrame(true);
        win.webContents.send('capture:new', entries);
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });
  server.on('error', (err) => {
    console.error('[gui] 捕获接收端口启动失败（可能已有实例占用）: ' + (err?.code ?? ''));
  });
  server.listen(INGEST_PORT, '127.0.0.1');
}

// 捕获条目带标题时用标题作文件名（如 B站视频名），否则保持默认命名；同名自动加序号
function outForTask(task, url) {
  if (task?.out) return task.out;
  const cap = captures.find((c) => c.url === url);
  const title = cap?.pageTitle?.trim();
  if (title === undefined || title === '') return null;
  const kind = task?.kind ?? 'auto';
  const isMedia = kind === 'media' || (kind === 'auto' && isMediaUrl(url));
  let ext = '.mp4';
  if (!isMedia) {
    try {
      ext = extname(new URL(url).pathname) || '.bin';
    } catch {
      ext = '.bin';
    }
  }
  let candidate = join(app.getPath('downloads'), sanitizeFileName(title) + ext);
  let n = 2;
  while (jobs.getSnapshot().some((t) => t.out === candidate)) {
    candidate = join(app.getPath('downloads'), sanitizeFileName(title) + ' (' + n + ')' + ext);
    n += 1;
  }
  return candidate;
}

ipcMain.handle('task:add', (_e, task) => {
  const url = String(task?.url ?? '').trim();
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: '链接无效（需要 http(s) 开头）' };
  const id = jobs.add({
    url,
    out: outForTask(task, url),
    outDir: app.getPath('downloads'),
    headers: task?.headers ?? {},
    kind: task?.kind ?? 'auto',
    threads: task?.threads ?? 8,
    adaptiveConnections: task?.adaptiveConnections === true,
    limitBytesPerSec: task?.limitBytesPerSec ?? undefined,
    streamUrls: Array.isArray(task?.streamUrls) ? task.streamUrls : undefined,
  });
  return { ok: true, id };
});
ipcMain.handle('task:cancel', (_e, id) => jobs.cancel(id));
ipcMain.handle('task:remove', (_e, id) => jobs.remove(id));
ipcMain.handle('task:removeMany', async (_e, opts) => {
  const ids = Array.isArray(opts?.ids) ? opts.ids : [];
  const withFiles = opts?.withFiles === true;
  for (const id of ids) {
    const t = jobs.getSnapshot().find((x) => x.id === id);
    if (withFiles && t !== undefined && t.out !== null) await deleteTaskFiles(t.out);
    jobs.remove(id);
  }
  return { ok: true };
});
ipcMain.handle('task:removeAll', async (_e, opts) => {
  const withFiles = opts?.withFiles === true;
  const ids = jobs.getSnapshot().map((t) => t.id);
  for (const id of ids) {
    const t = jobs.getSnapshot().find((x) => x.id === id);
    if (withFiles && t !== undefined && t.out !== null) await deleteTaskFiles(t.out);
    jobs.remove(id);
  }
  return { ok: true };
});
ipcMain.handle('capture:removeAll', () => {
  captures.length = 0;
});
ipcMain.handle('util:openFolder', (_e, p) => {
  if (typeof p === 'string' && p !== '') shell.showItemInFolder(p);
});
ipcMain.handle('capture:remove', (_e, url) => {
  const i = captures.findIndex((c) => c.url === url);
  if (i >= 0) captures.splice(i, 1);
});

/** 捕获条目生命周期：超过 2 小时未更新的条目自动清理 */
const CAPTURE_TTL = 2 * 60 * 60 * 1000;
function pruneCaptures() {
  const now = Date.now();
  while (captures.length > 0 && now - (captures[captures.length - 1].at ?? 0) > CAPTURE_TTL) captures.pop();
}
ipcMain.handle('util:chooseSavePath', async (_e, opts) => {
  const def = typeof opts?.defaultName === 'string' && opts.defaultName !== '' ? opts.defaultName : 'download';
  const r = await dialog.showSaveDialog(win, {
    title: '选择保存位置',
    defaultPath: join(app.getPath('downloads'), def),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('app:getSnapshot', () => ({ tasks: jobs.getSnapshot(), captures }));
ipcMain.handle('settings:get', () => ({ ...settings }));
ipcMain.handle('settings:set', async (_e, opts) => {
  if (typeof opts?.mode === 'string' && PRESETS[opts.mode] !== undefined) {
    const v = PRESETS[opts.mode];
    settings.mode = opts.mode;
    settings.maxConcurrent = v.maxConcurrent;
    settings.defaultThreads = v.defaultThreads;
    jobs.setMaxConcurrent(v.maxConcurrent);
  } else {
    settings.mode = 'custom';
    if (typeof opts?.maxConcurrent === 'number') {
      settings.maxConcurrent = Math.max(1, Math.min(8, Math.round(opts.maxConcurrent)));
      jobs.setMaxConcurrent(settings.maxConcurrent);
    }
    if (typeof opts?.defaultThreads === 'number') {
      settings.defaultThreads = Math.max(1, Math.min(32, Math.round(opts.defaultThreads)));
    }
  }
  await writeFile(settingsPath, JSON.stringify(settings), 'utf8').catch(() => {});
  return { ...settings };
});

jobs.on('event', (ev) => {
  if (win !== null && !win.isDestroyed()) win.webContents.send('task:event', ev);
  if (!smoke) scheduleSaveHistory();
});

// 历史持久化：仅保存终态任务（done/error/canceled），最多 200 条
function scheduleSaveHistory() {
  if (historyTimer !== null) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    const finished = jobs
      .getSnapshot()
      .filter((t) => t.status === 'done' || t.status === 'error' || t.status === 'canceled')
      .slice(-200);
    writeFile(historyPath, JSON.stringify(finished), 'utf8').catch(() => {});
  }, 800);
}
