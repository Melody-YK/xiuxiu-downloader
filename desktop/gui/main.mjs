// Electron 主进程：窗口 + IPC + 扩展捕获接收（host.mjs 通过 http://127.0.0.1:17321/ingest 推送）
import { app, BrowserWindow, ipcMain, shell } from 'electron';
import { createServer, request } from 'node:http';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager } from '../lib/queue.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const INGEST_PORT = 17321;
const smoke = process.argv.includes('--smoke');
if (smoke) {
  // 冒烟模式使用独立 userData：不与真实实例抢单实例锁，也不污染下载历史
  app.setPath('userData', join(tmpdir(), 'dl-gui-smoke'));
}
const jobs = new JobManager({ maxConcurrent: 2 });
const captures = [];
let win = null;
let historyPath = '';
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
    if (!smoke) {
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
      title: '嗅探下载器',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void win.loadFile(join(here, 'renderer', 'index.html'));
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

  app.on('window-all-closed', () => app.quit());
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
          at: Date.now(),
        });
        // 网页下载按钮（autoDownload）直达：自动建立下载任务并带上请求头
        if (msg.autoDownload === true && typeof e.url === 'string' && e.url !== '') {
          const headers = {};
          if (e.cookie) headers.Cookie = e.cookie;
          if (e.referer) headers.Referer = e.referer;
          if (e.userAgent) headers['User-Agent'] = e.userAgent;
          jobs.add({
            url: e.url,
            kind: e.mediaType === 'hls' || e.mediaType === 'dash' ? 'media' : 'auto',
            headers,
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

ipcMain.handle('task:add', (_e, task) => {
  const id = jobs.add({
    url: String(task?.url ?? ''),
    out: task?.out ?? null,
    outDir: app.getPath('downloads'),
    headers: task?.headers ?? {},
    kind: task?.kind ?? 'auto',
    threads: task?.threads ?? 8,
    limitBytesPerSec: task?.limitBytesPerSec ?? undefined,
  });
  return id;
});
ipcMain.handle('task:cancel', (_e, id) => jobs.cancel(id));
ipcMain.handle('util:openFolder', (_e, p) => {
  if (typeof p === 'string' && p !== '') shell.showItemInFolder(p);
});
ipcMain.handle('app:getSnapshot', () => ({ tasks: jobs.getSnapshot(), captures }));

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
