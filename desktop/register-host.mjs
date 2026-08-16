import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// 宿主名必须与扩展 extension/src/popup.ts 中 NATIVE_HOST_NAME 一致
const HOST_NAME = 'com.downloader.sniffer';
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = join(here, 'native-host-manifest.json');
const launcherExe = join(here, 'host-launcher.exe');
const launcherCs = join(here, 'host-launcher.cs');
const batLauncher = join(here, 'host.bat');

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

function findCsc() {
  const base = process.env.WINDIR ?? 'C:\\Windows';
  const candidates = [
    join(base, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe'),
    join(base, 'Microsoft.NET', 'Framework', 'v4.0.30319', 'csc.exe'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}

// 浏览器启动原生宿主只接受真实可执行文件，.bat 依赖系统兜底不可靠：
// 编译一个 C# 启动器，把 stdin/stdout/stderr 原样转发给 node host.mjs。
const csSource = `using System;
using System.Diagnostics;
using System.IO;
using System.Threading.Tasks;

internal static class Program
{
    private static void Log(string file, string line)
    {
        try { File.AppendAllText(file, line + Environment.NewLine); }
        catch (Exception) { }
    }

    private static int Main()
    {
        string node = @"${process.execPath}";
        string script = @"${join(here, 'host.mjs')}";
        string logFile = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, "host.log");
        try
        {
            // 路径无空格可直接传；如需通用可在运行时给 Arguments 加引号
            var psi = new ProcessStartInfo(node, script)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                CreateNoWindow = true,
                WorkingDirectory = Path.GetDirectoryName(script) ?? AppDomain.CurrentDomain.BaseDirectory,
            };
            var p = Process.Start(psi);
            var si = Console.OpenStandardInput();
            var so = Console.OpenStandardOutput();
            var se = Console.OpenStandardError();
            var t1 = Task.Run(delegate
            {
                try { si.CopyTo(p.StandardInput.BaseStream); }
                catch (Exception) { }
                try { p.StandardInput.Close(); }
                catch (Exception) { }
            });
            var t2 = Task.Run(delegate
            {
                try { p.StandardOutput.BaseStream.CopyTo(so); so.Flush(); }
                catch (Exception) { }
            });
            var t3 = Task.Run(delegate
            {
                try { p.StandardError.BaseStream.CopyTo(se); se.Flush(); }
                catch (Exception) { }
            });
            p.WaitForExit();
            try { Task.WaitAll(new Task[] { t1, t2, t3 }, 8000); }
            catch (Exception) { }
            return p.ExitCode;
        }
        catch (Exception ex)
        {
            Log(logFile, "[launcher] " + ex.Message);
            return 1;
        }
    }
}
`;

let launchPath = null;
const csc = findCsc();
if (csc !== null) {
  writeFileSync(launcherCs, csSource, 'utf8');
  try {
    execFileSync(csc, ['/nologo', '/target:exe', '/platform:anycpu', '/out:' + launcherExe, launcherCs], {
      stdio: 'ignore',
      windowsHide: true,
    });
    if (existsSync(launcherExe)) {
      launchPath = launcherExe;
      console.log('已编译宿主启动器: ' + launcherExe);
    }
  } catch (err) {
    console.warn('C# 启动器编译失败，回退 host.bat: ' + (err && err.message ? err.message : String(err)));
  }
}

if (launchPath === null) {
  // 兜底：无编译器时退回 .bat（绝对 node 路径）
  const batContent = '@echo off\r\n\"' + process.execPath + '\" \"%~dp0host.mjs\" %*\r\n';
  if (!existsSync(batLauncher) || readFileSync(batLauncher, 'utf8').trim() !== batContent.trim()) {
    writeFileSync(batLauncher, batContent, 'utf8');
  }
  launchPath = batLauncher;
  console.log('使用 host.bat 启动器: ' + batLauncher);
}

const manifest = {
  name: HOST_NAME,
  description: 'Xiuxiu Downloader native messaging host',
  path: launchPath,
  type: 'stdio',
  // 未打包扩展的 ID 随机器/路径变化，用通配符放开；后续可按需收紧
  allowed_origins: ['chrome-extension://*/'],
};

writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8');
console.log('已生成 native host manifest: ' + manifestPath);

for (const root of ROOTS) {
  execFileSync('reg', ['add', root + '\\' + HOST_NAME, '/ve', '/t', 'REG_SZ', '/d', manifestPath, '/f'], {
    stdio: 'ignore',
    windowsHide: true,
  });
  console.log('已注册: ' + root + '\\' + HOST_NAME);
}
console.log('完成。Edge/Chrome 扩展可通过 connectNative 连接桌面宿主（' + launchPath + '）。');
