# desktop

桌面端宿主程序（native messaging 桥 + 多线程下载核心 + 流媒体 + Electron GUI，Phase 1-5 已完成）。

## 文件

lib/protocol.mjs     消息帧编解码：4 字节小端长度 + UTF-8 JSON（Chrome 官方协议）
host.mjs             宿主主体：读 stdin 帧 → 打印收到的 URL/Cookie/Referer/UA → 回 ack
host.bat             启动器（Chrome 要求 path 指向可执行文件，经 .bat 转发给 node；已提交）
lib/downloader.mjs   Range 多线程下载核心（探测/动态切分/断点续传/令牌桶限速/降级单线程）
cli.mjs              下载器 CLI：node cli.mjs <url> [-o out] [-n 线程] [-l KB/s] [--cookie C] [--referer R] [-u UA] [--fresh]
lib/hls.mjs          HLS 解析（master 变体/媒体清单/AES-128/EXT-X-MAP/byterange）
lib/dash.mjs         DASH 最小解析（SegmentTemplate + SegmentTimeline）
lib/segments.mjs     分片下载（并发 + AES-128 解密 + fMP4 初始化段前置）
lib/merge.mjs        分片合并 + ffmpeg 转封装
media-cli.mjs        流媒体 CLI：node media-cli.mjs <m3u8|mpd 地址> [-o out.mp4] [--variant N] [--list]
lib/pipeline.mjs      流媒体管线（CLI 与 GUI 共用）
lib/queue.mjs         下载任务队列（并发限制/取消/进度事件）
gui/                  Electron GUI：npm run gui 启动（扩展捕获经 host.mjs → 127.0.0.1:17321 推送；autoDownload 标记自动建任务）
register-host.mjs    生成 native-host-manifest.json 并写入注册表（Chrome/Edge 两条路径）：
                     HKCU\Software\Google\Chrome\NativeMessagingHosts\com.downloader.sniffer
                     HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.downloader.sniffer
tests/               协议单测 + 宿主集成测试（spawn host.mjs 验证帧往返）

## 使用

node cli.mjs https://proof.ovh.net/files/100Mb.dat -o 100MB.bin -n 8   # 多线程下载
node cli.mjs <url> -l 4096 --cookie "..." --referer "..." -u "UA"        # 限速 + 透传请求头
node media-cli.mjs https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8 -o out.mp4   # HLS → mp4
node media-cli.mjs <m3u8|mpd 地址> --list                               # 列出清晰度
npm run gui                                                             # 图形界面（扩展捕获一键下载）
# 中断（Ctrl+C / 关窗口）后再次运行相同命令自动续传（<out>.meta.json 记录每段进度）

npm run register      # 注册（生成 manifest，写入注册表）
npm run unregister    # 注销
npm test              # 运行测试（协议 + 宿主 + 下载器）

注册后：扩展 popup 点「发送到桌面端」→ 宿主收到 capture 消息 → 回 ack；
收到的 URL/Cookie/Referer/UA 打印在 desktop/host.log（同时输出 stderr）。

## 协议（与扩展约定）

扩展 → 宿主：{ type: 'capture', entries: [{ url, mediaType, contentType, size, pageUrl, pageTitle, cookie, referer, userAgent }] }
宿主 → 扩展：{ type: 'ack', ok: true, count: N }
其他：ping → pong；未知/非法消息 → { type: 'error', message }

宿主名 com.downloader.sniffer 与扩展 extension/src/popup.ts 的 NATIVE_HOST_NAME 保持一致。

## 注意

- native-host-manifest.json 与 host.log 为生成物（含本机绝对路径），已 gitignore；换机器需重新 npm run register。
- 协议帧只走 stdout；所有日志走 stderr + host.log，绝不混入协议通道。
