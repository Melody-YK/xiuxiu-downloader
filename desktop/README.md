# desktop

桌面端宿主程序（Phase 2 已实现 native messaging 桥；Phase 3 起实现下载核心）。

## 文件

lib/protocol.mjs     消息帧编解码：4 字节小端长度 + UTF-8 JSON（Chrome 官方协议）
host.mjs             宿主主体：读 stdin 帧 → 打印收到的 URL/Cookie/Referer/UA → 回 ack
host.bat             启动器（Chrome 要求 path 指向可执行文件，经 .bat 转发给 node；已提交）
register-host.mjs    生成 native-host-manifest.json 并写入注册表（Chrome/Edge 两条路径）：
                     HKCU\Software\Google\Chrome\NativeMessagingHosts\com.downloader.sniffer
                     HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.downloader.sniffer
tests/               协议单测 + 宿主集成测试（spawn host.mjs 验证帧往返）

## 使用

npm run register      # 注册（生成 manifest，写入注册表）
npm run unregister    # 注销
npm test              # 运行测试

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
