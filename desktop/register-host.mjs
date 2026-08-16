import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 宿主名必须与扩展 extension/src/popup.ts 中 NATIVE_HOST_NAME 一致
const HOST_NAME = 'com.downloader.sniffer';
const here = dirname(fileURLToPath(import.meta.url));
const launcher = join(here, 'host.bat');
const manifestPath = join(here, 'native-host-manifest.json');

const ROOTS = [
  'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts',
  'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts',
];

if (process.argv.includes('--unregister')) {
  for (const root of ROOTS) {
    try {
      execFileSync('reg', ['delete', root + '\\' + HOST_NAME, '/f'], { stdio: 'ignore', windowsHide: true });
    } catch {
      // 键不存在则忽略
    }
  }
  console.log('已注销 ' + HOST_NAME + '（Chrome/Edge）');
  process.exit(0);
}

const manifest = {
  name: HOST_NAME,
  description: 'Xiuxiu Downloader native messaging host',
  path: launcher,
  type: 'stdio',
  // 未打包扩展的 ID 随机器/路径变化，Phase 2 用通配符放开；后续可按需收紧
  allowed_origins: ['chrome-extension://*/'],
};

// 启动器使用 node.exe 绝对路径：浏览器启动宿主进程时继承的 PATH 可能不含 node，绝对路径一劳永逸
const launcherContent = '@echo off\r\n\"' + process.execPath + '\" \"%~dp0host.mjs\" %*\r\n';
if (!existsSync(launcher) || readFileSync(launcher, 'utf8').trim() !== launcherContent.trim()) {
  writeFileSync(launcher, launcherContent, 'utf8');
  console.log('已更新启动器: ' + launcher);
}

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('已生成 native host manifest: ' + manifestPath);

for (const root of ROOTS) {
  execFileSync('reg', ['add', root + '\\' + HOST_NAME, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  console.log('已注册: ' + root + '\\' + HOST_NAME);
}
console.log('完成。Edge/Chrome 扩展可通过 connectNative 连接桌面宿主。');
