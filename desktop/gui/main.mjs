// Electron 主进程：窗口 + IPC + 扩展捕获接收（host.mjs 通过 http://127.0.0.1:17321/ingest 推送）
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, Notification, screen, shell, Tray } from 'electron';
import { execFile } from 'node:child_process';
import { createServer, request } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JobManager, deleteTaskFiles, isMediaUrl, sanitizeFileName } from '../lib/queue.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const smoke = process.argv.includes('--smoke');
const startHidden = process.argv.includes('--hidden'); // 开机自启动：静默进托盘
app.setAppUserModelId('com.xiuxiu.downloader'); // Windows 通知需要
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
const settings = { mode: 'balanced', maxConcurrent: 2, defaultThreads: 8, closeToTray: true, launchAtLogin: false, notifyDone: true, seenGuide: false, clipboardWatch: true };
let win = null;
let tray = null;
let trayNotified = false;
let trayActive = false;
let trayLastUpdate = 0;
let isQuitting = false;
let clipWin = null;
let clipLastText = '';
let clipTimer = null;
const clipSeen = new Map();
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
        if (typeof raw?.closeToTray === 'boolean') settings.closeToTray = raw.closeToTray;
        if (typeof raw?.launchAtLogin === 'boolean') settings.launchAtLogin = raw.launchAtLogin;
        if (typeof raw?.notifyDone === 'boolean') settings.notifyDone = raw.notifyDone;
        if (typeof raw?.seenGuide === 'boolean') settings.seenGuide = raw.seenGuide;
        if (typeof raw?.clipboardWatch === 'boolean') settings.clipboardWatch = raw.clipboardWatch;
        startClipboardWatch();
        if (typeof raw?.maxConcurrent === 'number') settings.maxConcurrent = Math.max(1, Math.min(8, Math.round(raw.maxConcurrent)));
        if (typeof raw?.defaultThreads === 'number') settings.defaultThreads = Math.max(1, Math.min(32, Math.round(raw.defaultThreads)));
        applyLaunchAtLogin();
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
      show: !smoke && !startHidden,
      title: '嗅嗅下载器',
      autoHideMenuBar: true,
      webPreferences: {
        preload: join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    void win.loadFile(join(here, 'renderer', 'index.html'));
    createTray();
    // 关闭窗口：托盘模式下最小化到托盘继续下载；否则退出（有任务时先确认）
    win.on('close', (e) => {
      if (smoke || isQuitting) return;
      if (settings.closeToTray) {
        e.preventDefault();
        win.hide();
        if (!trayNotified && tray !== null) {
          trayNotified = true;
          try {
            tray.displayBalloon({ title: '嗅嗅下载器', content: '已最小化到托盘，下载继续进行。右键托盘图标可退出。' });
          } catch {
            // 通知失败忽略
          }
        }
        return;
      }
      const running = runningCount();
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
          if (r.response === 0) quitApp();
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
                  .executeJavaScript('typeof window.api + "|" + document.getElementById("cap-count").textContent + "|" + document.getElementById("tasks").childElementCount + "|" + (document.getElementById("guide-modal") !== null ? 1 : 0) + "|" + (document.getElementById("s-launch") !== null ? 1 : 0)')
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

  // 非托盘模式下：关闭窗口即退出（托盘模式下窗口只是隐藏，不会触发这里）
  app.on('window-all-closed', () => {
    if (!settings.closeToTray) app.exit(0);
  });
}

function runningCount() {
  return jobs.getSnapshot().filter((t) => t.status === 'running' || t.status === 'queued').length;
}

// 退出流程：有任务先确认，然后清理托盘并强制退出
function quitApp() {
  if (isQuitting) return;
  const running = runningCount();
  const doQuit = () => {
    isQuitting = true;
    if (tray !== null) {
      tray.destroy();
      tray = null;
    }
    app.exit(0);
  };
  if (running === 0) {
    doQuit();
    return;
  }
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
      if (r.response === 0) doQuit();
    });
}

function createTray() {
  if (tray !== null || smoke) return;
  tray = new Tray(trayIcon(false));
  updateTrayStatus();
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (win !== null && !win.isDestroyed()) {
            win.show();
            win.focus();
          }
        },
      },
      { type: 'separator' },
      { label: '退出', click: () => quitApp() },
    ]),
  );
  tray.on('double-click', () => {
    if (win !== null && !win.isDestroyed()) {
      win.show();
      win.focus();
    }
  });
}

// 多分辨率托盘图标（active=绿色「下载中」变样）
function trayIcon(active) {
  const img = nativeImage.createEmpty();
  const names = ['tray-16', 'tray-24', 'tray-32'];
  const scales = [1.0, 1.5, 2.0];
  for (let i = 0; i < names.length; i += 1) {
    img.addRepresentation({
      scaleFactor: scales[i],
      buffer: readFileSync(join(here, '..', 'build', names[i] + (active ? '-active' : '') + '.png')),
    });
  }
  return img;
}

function fmtSpeed(bps) {
  if (typeof bps !== 'number' || !Number.isFinite(bps) || bps <= 0) return '—';
  const units = ['B/s', 'KB/s', 'MB/s', 'GB/s'];
  let v = bps;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return (v >= 100 ? String(Math.round(v)) : v.toFixed(1)) + ' ' + units[i];
}

// 托盘状态：空闲蓝图标；有任务绿色图标 + 悬浮显示任务数与实时速度（1s 节流）
function updateTrayStatus() {
  if (tray === null) return;
  const running = jobs.getSnapshot().filter((t) => t.status === 'running');
  const active = running.length > 0;
  const now = Date.now();
  if (now - trayLastUpdate < 1000 && active === trayActive) return;
  trayLastUpdate = now;
  if (active !== trayActive) {
    trayActive = active;
    tray.setImage(trayIcon(active));
  }
  if (active) {
    const speed = running.reduce((s, t) => s + (typeof t.progress?.speed === 'number' && Number.isFinite(t.progress.speed) ? t.progress.speed : 0), 0);
    tray.setToolTip('嗅嗅下载器\n下载中 ' + running.length + ' 个任务 · ' + fmtSpeed(speed));
  } else {
    tray.setToolTip('嗅嗅下载器\n空闲');
  }
}

// ---- 剪贴板监听：复制下载链接弹「要下载吗」小窗 ----
function startClipboardWatch() {
  if (clipTimer !== null) {
    clearInterval(clipTimer);
    clipTimer = null;
  }
  if (!settings.clipboardWatch || smoke) return;
  clipTimer = setInterval(() => {
    try {
      const text = clipboard.readText().trim();
      if (text === '' || text === clipLastText || text.length > 4000) return;
      clipLastText = text;
      for (const m of text.matchAll(/https?:\/\/[^\s"'<>]+/g)) maybePromptClipUrl(m[0]);
    } catch {
      // 剪贴板被占用等异常：忽略
    }
  }, 900);
}

function maybePromptClipUrl(raw) {
  const url = raw.replace(/[.,;:!?)\]，。；：！？）]+$/, '');
  if (!/^https?:\/\//i.test(url)) return;
  const now = Date.now();
  if (clipSeen.has(url) && now - clipSeen.get(url) < 6 * 3600 * 1000) return;
  const snap = jobs.getSnapshot();
  if (snap.some((t) => t.url === url && ['running', 'queued', 'done'].includes(t.status))) return;
  clipSeen.set(url, now);
  if (clipSeen.size > 400) {
    const oldest = clipSeen.keys().next().value;
    if (oldest !== undefined) clipSeen.delete(oldest);
  }
  showClipPopup(url);
}

function showClipPopup(url) {
  if (win === null || win.isDestroyed()) return;
  if (clipWin === null || clipWin.isDestroyed()) {
    clipWin = new BrowserWindow({
      width: 380,
      height: 138,
      frame: false,
      resizable: false,
      movable: false,
      alwaysOnTop: true,
      skipTaskbar: true,
      show: false,
      webPreferences: {
        preload: join(here, 'preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    clipWin.setAlwaysOnTop(true, 'pop-up-menu');
    clipWin.on('closed', () => {
      clipWin = null;
    });
  }
  void clipWin.loadFile(join(here, 'renderer', 'clip-popup.html'), { query: { url } });
  const wa = screen.getPrimaryDisplay().workArea;
  clipWin.setPosition(wa.x + wa.width - 380 - 12, wa.y + wa.height - 138 - 12);
  clipWin.showInactive();
  setTimeout(() => {
    try {
      if (clipWin !== null && !clipWin.isDestroyed() && clipWin.isVisible()) clipWin.close();
    } catch {
      // 忽略
    }
  }, 20000);
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
        // 捕获日志：方便排查「这是什么文件」（userData/captures.log，制表符分隔）
        try {
          appendFileSync(
            join(app.getPath('userData'), 'captures.log'),
            [
              new Date().toISOString(),
              e.mediaType ?? 'video',
              e.size ?? '',
              e.contentType ?? '',
              e.url ?? '',
              e.pageUrl ?? '',
              e.pageTitle ?? '',
            ].join('\t') + '\n',
            'utf8',
          );
        } catch {
          // 日志失败不影响主流程
        }
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
ipcMain.handle('diag:check', async () => {
  const KEY_CHROME = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.downloader.sniffer';
  const KEY_EDGE = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.downloader.sniffer';
  const chrome = await regDefaultValue(KEY_CHROME);
  const edge = await regDefaultValue(KEY_EDGE);
  const manifestPath = chrome ?? edge ?? null;
  let manifestOk = false;
  if (manifestPath !== null) {
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf8'));
      manifestOk = raw?.name === 'com.downloader.sniffer' && typeof raw?.path === 'string' && existsSync(raw.path);
    } catch {
      manifestOk = false;
    }
  }
  return {
    version: app.getVersion(),
    chromeRegistered: chrome !== null,
    edgeRegistered: edge !== null,
    manifestPath,
    manifestOk,
    extensionFolder: app.isPackaged ? null : join(here, '..', '..', 'extension'),
  };
});

function regDefaultValue(key) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/ve'], { windowsHide: true, timeout: 8000 }, (err, stdout) => {
      if (err !== null) {
        resolve(null);
        return;
      }
      const m = /REG_SZ\s+(\S.*)/.exec(stdout);
      resolve(m !== null ? (m[1] ?? '').trim() : null);
    });
  });
}

ipcMain.handle('util:openExternal', async (_e, url) => {
  if (typeof url !== 'string' || !/^(https?:|edge:|chrome:|msedge:)/i.test(url)) return false;
  try {
    await shell.openExternal(url);
    return true;
  } catch {
    return false;
  }
});

ipcMain.handle('util:openPath', async (_e, p) => {
  if (typeof p !== 'string' || p === '') return false;
  try {
    return (await shell.openPath(p)) === '';
  } catch {
    return false;
  }
});

ipcMain.handle('util:chooseSavePath', async (_e, opts) => {
  const def = typeof opts?.defaultName === 'string' && opts.defaultName !== '' ? opts.defaultName : 'download';
  const r = await dialog.showSaveDialog(win, {
    title: '选择保存位置',
    defaultPath: join(app.getPath('downloads'), def),
    properties: ['createDirectory', 'showOverwriteConfirmation'],
  });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('app:getSnapshot', () => ({ tasks: jobs.getSnapshot().map(augmentTask), captures }));
ipcMain.handle('task:pause', (_e, id) => jobs.pause(Number(id)));
ipcMain.handle('task:resume', (_e, id) => jobs.resume(Number(id)));
ipcMain.handle('clip:close', () => {
  try {
    if (clipWin !== null && !clipWin.isDestroyed()) clipWin.close();
  } catch {
    // 忽略
  }
});
ipcMain.handle('util:showMain', () => {
  if (win !== null && !win.isDestroyed()) {
    win.show();
    win.focus();
  }
});

// 任务快照附加「是否存在续传点」（.meta.json），供渲染层显示可续传标记
function augmentTask(t) {
  return {
    ...t,
    hasMeta: typeof t.out === 'string' && t.out !== '' ? existsSync(t.out + '.meta.json') : false,
  };
}
ipcMain.handle('settings:get', () => ({ ...settings }));
ipcMain.handle('settings:set', async (_e, opts) => {
  if (typeof opts?.closeToTray === 'boolean') settings.closeToTray = opts.closeToTray;
  if (typeof opts?.launchAtLogin === 'boolean') {
    settings.launchAtLogin = opts.launchAtLogin;
    applyLaunchAtLogin();
  }
  if (typeof opts?.notifyDone === 'boolean') settings.notifyDone = opts.notifyDone;
  if (typeof opts?.seenGuide === 'boolean') settings.seenGuide = opts.seenGuide;
  if (typeof opts?.clipboardWatch === 'boolean') {
    settings.clipboardWatch = opts.clipboardWatch;
    startClipboardWatch();
  }
  if (typeof opts?.mode === 'string' && PRESETS[opts.mode] !== undefined) {
    const v = PRESETS[opts.mode];
    settings.mode = opts.mode;
    settings.maxConcurrent = v.maxConcurrent;
    settings.defaultThreads = v.defaultThreads;
    jobs.setMaxConcurrent(v.maxConcurrent);
  } else if (typeof opts?.maxConcurrent === 'number' || typeof opts?.defaultThreads === 'number') {
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

// 开机自启动（Windows 登录项）。开发模式不写注册表，避免把 electron.exe 写进去
function applyLaunchAtLogin() {
  if (!app.isPackaged || smoke) return;
  try {
    app.setLoginItemSettings({ openAtLogin: settings.launchAtLogin, path: process.execPath, args: ['--hidden'] });
  } catch {
    // 设置失败忽略（如某些受限环境）
  }
}

jobs.on('event', (ev) => {
  if (win !== null && !win.isDestroyed()) {
    // 状态类事件附加续传点信息；进度事件原样透传（避免高频 stat）
    if ((ev.type === 'status' || ev.type === 'created') && ev.data !== undefined) {
      win.webContents.send('task:event', { ...ev, data: augmentTask(ev.data) });
    } else {
      win.webContents.send('task:event', ev);
    }
  }
  if (!smoke) scheduleSaveHistory();
  if (settings.notifyDone && ev.type === 'status' && (ev.data?.status === 'done' || ev.data?.status === 'error')) {
    notifyTaskDone(ev.data);
  }
  updateTrayStatus();
});

// 下载完成/失败系统通知：点击打开文件位置
function notifyTaskDone(t) {
  if (t === undefined || t === null || smoke) return;
  const ok = t.status === 'done';
  const name = typeof t.out === 'string' ? basename(t.out) : (t.url ?? '未知任务');
  try {
    const n = new Notification({
      title: ok ? '✅ 下载完成' : '❌ 下载失败',
      body: name + (ok ? '' : '（' + String(t.error ?? '未知错误') + '）'),
      icon: join(here, '..', 'build', 'icon.png'),
      silent: !ok,
    });
    n.on('click', () => {
      if (win !== null && !win.isDestroyed()) {
        win.show();
        win.focus();
      }
      if (ok && typeof t.out === 'string') shell.showItemInFolder(t.out);
    });
    n.show();
  } catch {
    // 通知失败不影响下载
  }
}

// 历史持久化：仅保存终态任务（done/error/canceled），最多 200 条
function scheduleSaveHistory() {
  if (historyTimer !== null) return;
  historyTimer = setTimeout(() => {
    historyTimer = null;
    const finished = jobs
      .getSnapshot()
      .filter((t) => t.status === 'done' || t.status === 'error' || t.status === 'canceled' || t.status === 'paused')
      .slice(-200);
    writeFile(historyPath, JSON.stringify(finished), 'utf8').catch(() => {});
  }, 800);
}
