# 嗅探下载器（IDM 平替）

浏览器扩展（捕获媒体地址）+ 桌面端（多线程下载 / 流媒体合并）。当前处于 **Phase 1：MVP 嗅探扩展** 阶段。

## 架构

[网页] --chrome.webRequest--> [MV3 扩展] 捕获媒体 URL + 请求信息
                                   |  （Phase 2：native messaging，stdio + 长度前缀 JSON）
                                   v
                         [桌面端 Node 程序] Range 多线程下载 / m3u8-mpd 合并

## 目录结构

extension/   MV3 扩展（Chrome/Edge 通用）
  manifest.json / popup.html / popup.css
  src/        TypeScript 源码（background 捕获 + popup UI + lib 纯逻辑）
  tests/      单元测试 + background 冒烟测试（node --test，mock chrome API）
  dist/       tsc 构建产物（已提交，可直接加载）
desktop/     桌面端（native messaging 宿主已就绪；下载核心 Phase 3 起）
  lib/protocol.mjs   消息帧编解码（4 字节小端长度 + JSON）
  host.mjs / host.bat native messaging 宿主（stdio + stderr/文件日志）
  register-host.mjs  生成 manifest 并注册 Chrome/Edge 注册表
  lib/downloader.mjs Range 多线程下载核心（动态切分/续传/限速/降级单线程）
  cli.mjs            下载器 CLI：node cli.mjs <url> [选项]
  tests/             协议 + 宿主 + 下载器测试（本地服务器全链路）

## 环境

Node v22.19.0 / npm 10.9.3 / git 2.49.0；ffmpeg 已安装（Phase 4 使用）。
原环境使用 pnpm，本环境未安装，改用 npm；脚本为通用 npm 脚本，后续可随时切回 pnpm。

## 阶段进度

- [x] **Phase 1：MVP 嗅探扩展**（已完成，待验收）
- [x] **Phase 2：native messaging 桥**（已完成，待验收）
- [x] **Phase 3：多线程下载核心**（已完成，待验收）
- [ ] Phase 4：流媒体（m3u8/mpd → 分片 → AES-128 解密 → ffmpeg 合并）
- [ ] Phase 5：GUI 与打磨（可选）

## Phase 1 验证步骤（Edge）

1. 加载扩展：edge://extensions → 打开「开发人员模式」→「加载解压缩的扩展」→ 选择本仓库的 extension/ 目录。
   （Chrome 同理：chrome://extensions）
2. 打开测试页并播放几秒：
   - 直链视频：https://test-videos.co.uk/vids/bigbuckbunny/mp4_h264/1080/Big_Buck_Bunny_1080_10s_1MB.mp4
   - HLS 播放页：https://test-streams.mux.dev/ （页面内 hls.js 播放器会自动请求 m3u8 与 ts 分片）
3. 点击工具栏扩展图标，popup 应列出捕获到的媒体 URL（类型徽标 + 大小 + 来源页面）。
   点击「复制」复制单条，「复制全部」复制所有 URL，「清空」重置列表。
4. 若列表为空：点击「刷新」，或重新加载网页再播放一次（扩展安装前已建立的连接不被观察，需要新请求）。

预期结果：视频页捕获到「视频」条目；HLS 播放页捕获到「HLS」清单条目，且「分片 ×N」随播放增长。

## Phase 2 验证步骤（native messaging 桥）

1. 注册宿主：cd desktop && npm run register（无需依赖；生成 native-host-manifest.json 并写入 Chrome/Edge 两条注册表路径）
2. Edge 重新加载扩展（manifest 新增了 nativeMessaging 权限）：edge://extensions → 扩展卡片上点「重新加载」
3. 打开测试视频页重新播放几秒（让请求经过新增的请求头监听，条目带上 Cookie/Referer/UA）
4. popup 点「发送到桌面端」：按钮应显示「已发送 N 条」
5. 查看 desktop/host.log（或手动运行 node desktop/host.mjs 观察控制台）：每条 URL + Cookie/Referer/UA 应被打印

常见问题：按钮显示「宿主未注册」→ 先执行 npm run register；「宿主连接失败」→ 检查 node 在系统 PATH（宿主由浏览器启动，继承浏览器进程的环境变量）。

## Phase 3 使用与验证（多线程下载核心）

cd desktop

# 多线程下载（默认 8 连接，自动动态切分）
node cli.mjs https://proof.ovh.net/files/100Mb.dat -o 100MB.bin -n 8
# 单线程对照
node cli.mjs https://proof.ovh.net/files/100Mb.dat -o 100MB-single.bin -n 1 --fresh
# 限速 4MB/s
node cli.mjs <url> -o out.bin -n 8 -l 4096
# 透传请求头（避免 403）
node cli.mjs <url> --cookie "..." --referer "..." -u "UA"
# 中断续传：下载中途 Ctrl+C 或关窗口，再次运行相同命令自动续传（<out>.meta.json 记录每段进度）

验收点（自动化测试已覆盖并全部通过）：
1. 多线程提速：受控限速服务器上单线程约 2s → 4 线程约 0.5s（可测量提速）；本机带宽饱和时两者接近属正常
2. 断点续传：中断后再次运行从断点恢复，最终文件与完整下载 SHA256 一致（公开文件实测通过）
3. 服务器不支持/忽略 Range 时自动降级单线程并正常完成；连接中途断开自动重试

## 开发

cd extension
npm install        # 安装 typescript / @types/chrome
npm run build      # 编译 src → dist（改动源码后需重新 build，再在浏览器里点「重新加载」）
npm run watch      # 持续编译
npm test           # 单元 + 冒烟测试（pretest 会自动先 build）

# 桌面端（desktop/，无第三方依赖）
npm run download -- <url> [-o 文件] [-n 线程] [-l KB/s] [--cookie C] [--referer R] [-u UA]
npm run register    # 注册 native messaging 宿主（Chrome/Edge 注册表）
npm run unregister  # 注销
npm test            # 协议 + 宿主 + 下载器测试

> dist/ 是构建产物，已提交以便直接加载；修改 src/ 后请重新构建并提交。

## 关键边界

- MV3 webRequest 只能观察、不能拦截——对嗅探场景无影响。
- 当前仅捕获 http(s) 媒体请求；blob:/MSE 流（如 YouTube）需后续 Hook 层。
- DRM（Widevine/PlayReady）明确不支持；m3u8 的 AES-128 属于可解密范围（Phase 4）。
- 扩展声明 <all_urls> 权限，安装时的权限警告属正常现象。
- nativeMessaging 权限同样有安装警告，属正常；宿主注册在 HKCU（当前用户），卸载用 desktop 的 npm run unregister。

## 测试资源

- 大文件测速：https://speed.hetzner.de/1GB.bin 、https://proof.ovh.net/files/100Mb.dat
- HLS：https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
- Apple 示例流：https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
- 直链视频：https://test-videos.co.uk/bigbuckbunny/mp4-h264
