// SVG → PNG 渲染器（Electron/Chromium 渲染；品红底色 #FF00FF 后处理转透明）
// 用法：npx electron tools/render-icon.mjs [svg路径] [输出png路径]
// 说明：渲染页必须与 SVG 同目录（跨目录 file:// 子资源会被环境拦截）
import { app, BrowserWindow } from 'electron';
import { writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const svgPath = resolve(here, process.argv[2] ?? '../build/icon.svg');
const outPath = resolve(here, process.argv[3] ?? '../build/icon.png');
const pagePath = join(dirname(svgPath), '.render-icon-page.html');

console.log('[render-icon] svg=' + svgPath);
const pageHtml =
  '<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#FF00FF;width:512px;height:512px;overflow:hidden}</style></head>' +
  '<body><img src="' + basename(svgPath) + '" width="512" height="512" style="display:block"></body></html>';
writeFileSync(pagePath, pageHtml, 'utf8');

app.whenReady().then(async () => {
  console.log('[render-icon] ready');
  let win;
  try {
    win = new BrowserWindow({
      width: 512,
      height: 512,
      useContentSize: true,
      show: false,
      frame: false,
      webPreferences: { paintWhenInitiallyHidden: true },
    });
    console.log('[render-icon] window ok');
    await win.loadFile(pagePath);
    await new Promise((r) => setTimeout(r, 500));
    const cap = await win.webContents.capturePage({ x: 0, y: 0, width: 512, height: 512 });
    const img = cap.resize({ width: 512, height: 512 });
    const png = img.toPNG();
    console.log('[render-icon] captured ' + img.getSize().width + 'x' + img.getSize().height + ' bytes=' + png.length);
    writeFileSync(outPath, png);
    console.log('WROTE ' + outPath);
    rmSync(pagePath, { force: true });
    app.exit(0);
  } catch (err) {
    console.error('渲染失败: ' + String(err));
    rmSync(pagePath, { force: true });
    if (win !== undefined && !win.isDestroyed()) win.destroy();
    app.exit(1);
  }
});

setTimeout(() => {
  console.error('[render-icon] 超时');
  rmSync(pagePath, { force: true });
  app.exit(1);
}, 20000);
