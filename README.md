# 嗅嗅下载器（Xiuxiu Downloader）

开源 IDM 平替：**浏览器扩展嗅探 + 桌面端多线程下载**。捕获网页中的视频/音频/HLS/DASH 地址，多线程分段下载、断点续传、限速；支持流媒体合并为 MP4（含 AES-128 解密、B站音视频轨合并）。名字由来：小狗一嗅，视频到手 🐶

## 特性

- 🕵️ **三层捕获**：DOM 扫描（视频旁「⬇ 下载」悬浮按钮）、webRequest 网络嗅探、fetch/XHR Hook（对付 MSE 动态站点）
- 🚀 **多线程下载**：HTTP Range 分段 + IDM 式动态切分、断点续传、令牌桶限速、不支持 Range 自动降级单线程
- 🎬 **流媒体**：HLS(m3u8)/DASH(mpd)/B站 playurl → 分片下载 → ffmpeg 合并 MP4；支持 AES-128 解密、fMP4、字节范围、无清单分片流
- 🖥️ **Electron GUI**：任务队列、实时进度/速度、扩展捕获一键下载（自动携带 Cookie/Referer/UA）、下载历史持久化、下载管理（单个/批量/全部删除，可选同时删除已下载文件）
- 🔗 **扩展 ↔ 桌面端联动**：native messaging（Chrome 官方协议）+ 本地 HTTP 推送，点击网页按钮直达桌面端开始下载

## 架构

[网页] ─捕获─▶ [MV3 扩展] ─native messaging─▶ [桌面宿主 host.mjs]
  │ DOM/webRequest/Hook        (stdio+长度前缀JSON)      │ HTTP 127.0.0.1:17321
  └─────────────▶ [Electron GUI] ◀───────────────────────┘
                       │
                       ├─ lib/downloader.mjs   Range 多线程下载核心
                       ├─ lib/pipeline.mjs    HLS/DASH/B站 流媒体管线
                       └─ ffmpeg 合并/转封装

## 目录结构

extension/   MV3 扩展（Chrome/Edge 通用，TypeScript）
desktop/     桌面端（纯 Node 核心 + Electron GUI，零第三方运行时依赖）
  lib/       下载核心 / 流媒体管线 / 任务队列 / 协议编解码
  gui/       Electron 界面
  cli.mjs / media-cli.mjs   命令行工具

## 下载安装包

不想装开发环境？直接到 [Releases](https://github.com/Melody-YK/xiuxiu-downloader/releases) 下载：

- `xiuxiu-downloader-*-portable.exe` —— 桌面端单文件版（双击即用，需系统安装 ffmpeg）
- `extension.zip` —— 解压后在浏览器「加载解压缩的扩展」中选择该目录

每次打 tag（`v*`）时由 GitHub Actions 自动构建发布。

## 快速开始（Windows）

前置要求：**Node.js ≥ 22**、**ffmpeg**（加入 PATH）、**Edge 或 Chrome**

1. 克隆仓库
2. 启动桌面端：
   ```powershell
   cd desktop
   npm install
   npm run gui
   ```
3. 构建并加载扩展：
   ```powershell
   cd extension
   npm install
   npm run build
   ```
   浏览器打开扩展管理页（Edge: `edge://extensions`，Chrome: `chrome://extensions`）→ 开启「开发人员模式」→「加载解压缩的扩展」→ 选择 `extension` 目录
4. 注册桌面宿主（扩展 ↔ 桌面端通信，只需一次）：
   ```powershell
   cd desktop
   npm run register
   ```

## 使用

| 场景 | 操作 |
|---|---|
| 直链下载 | GUI 粘贴/拖入 URL，多线程自动加速 |
| 视频旁按钮 | 直链 mp4/webm 站点播放后，视频左上角点「⬇ 下载」直达桌面端 |
| 流媒体（m3u8/mpd） | 播放视频 → 点扩展图标 → 捕获列表选 HLS/DASH 条目 → 「发送到桌面端」→ GUI 下载 |
| B站 | 播放 → 扩展列表选**带视频标题**的 DASH 条目 → 下载（音视频轨自动合并，需登录 Cookie 时扩展自动携带） |
| 请求头透传 | GUI「扩展捕获」一键下载自动带 Cookie/Referer/UA，防盗链站点不再 403 |

命令行：

```powershell
cd desktop
node cli.mjs <url> -o 文件 -n 8 -l 4096                 # 直链多线程下载（-n 线程 -l 限速KB/s）
node media-cli.mjs <m3u8|mpd 地址> -o out.mp4 --list    # 流媒体下载 / 列清晰度
node media-cli.mjs <B站 playurl 地址> -o out.mp4        # B站音视频轨合并
```

## 测试

双端自动化测试（本地服务器全链路，含提速/续传/限速/解密/合并等）：

```powershell
cd extension && npm test    # 27 个用例
cd desktop && npm test      # 44 个用例
```

## 打包 exe

```powershell
cd desktop
npm run pack               # electron-builder portable 单文件（需可访问 GitHub 下载打包组件）
npx electron-builder --win dir   # 网络受限时的替代：生成目录版，dist/win-unpacked 内 exe 双击即用
```

## 已知限制

- **DRM**（Widevine/PlayReady）明确不支持
- **blob:/MSE 站点**（如 YouTube）不显示视频旁按钮，但 popup 捕获列表仍可用
- **无清单分片流站点**：分片地址随播放被捕获，需完整播放（可静音+倍速）后再下载；部分站点分片带时效签名
- 商店政策：请勿以「下载付费平台视频」为卖点分发本扩展

## 常见问题

| 现象 | 处理 |
|---|---|
| 扩展「发送到桌面端」提示宿主连接失败 | 执行 `cd desktop && npm run register`；确认 node 已安装 |
| 下载 403 | 从「扩展捕获」列表点下载自动携带请求头，而不是手动粘贴 URL |
| 分片流提示「分片不连续」 | 拖动进度条会跳过中间分片；从头完整播放后再下载 |
| 改动扩展代码后无效果 | 重新 `npm run build` 并在扩展管理页点「重新加载」 |

## 开发

```powershell
cd extension && npm run build      # 扩展编译（dist/ 已提交，可直接加载）
cd desktop && npm run gui          # 开发模式启动 GUI（-- --smoke 为无窗口自检）
```

## 许可证

[MIT](LICENSE) © 2026 Melody-YK
