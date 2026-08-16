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
desktop/     桌面端（Phase 2 起实现：native messaging 宿主 + 下载核心）

## 环境

Node v22.19.0 / npm 10.9.3 / git 2.49.0；ffmpeg 已安装（Phase 4 使用）。
原环境使用 pnpm，本环境未安装，改用 npm；脚本为通用 npm 脚本，后续可随时切回 pnpm。

## 阶段进度

- [x] **Phase 1：MVP 嗅探扩展**（已完成，待验收）
- [ ] Phase 2：native messaging 桥（推送 URL + Cookie/Referer/UA）
- [ ] Phase 3：多线程下载核心（Range 分段 / 断点续传 / 动态线程）
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

## 开发

cd extension
npm install        # 安装 typescript / @types/chrome
npm run build      # 编译 src → dist（改动源码后需重新 build，再在浏览器里点「重新加载」）
npm run watch      # 持续编译
npm test           # 纯逻辑单元测试（pretest 会自动先 build）

> dist/ 是构建产物，已提交以便直接加载；修改 src/ 后请重新构建并提交。

## 关键边界

- MV3 webRequest 只能观察、不能拦截——对嗅探场景无影响。
- 当前仅捕获 http(s) 媒体请求；blob:/MSE 流（如 YouTube）需后续 Hook 层。
- DRM（Widevine/PlayReady）明确不支持；m3u8 的 AES-128 属于可解密范围（Phase 4）。
- 扩展声明 <all_urls> 权限，安装时的权限警告属正常现象。

## 测试资源

- 大文件测速：https://speed.hetzner.de/1GB.bin 、https://proof.ovh.net/files/100Mb.dat
- HLS：https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
- Apple 示例流：https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_fmp4/master.m3u8
- 直链视频：https://test-videos.co.uk/bigbuckbunny/mp4-h264
