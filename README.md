# 嗅嗅下载器（Xiuxiu Downloader）

一个“浏览器扩展 + Windows 桌面端”的媒体下载工具：嗅探网页中的视频、音频、HLS/DASH 流媒体地址，并交给桌面端下载、合并和转封装。

> 仅下载你有权保存的内容。项目不支持 DRM/Widevine/PlayReady。

## 下载什么文件？

GitHub Releases：https://github.com/Melody-YK/xiuxiu-downloader/releases

| 文件 | 作用 | 适合谁 |
|---|---|---|
| xiuxiu-downloader-*-portable.exe | Windows 桌面端便携版，负责下载、任务管理和流媒体合并 | 所有人，双击即可运行 |
| extension.zip | Chrome/Edge MV3 浏览器扩展 | 需要嗅探网页视频的人 |
| xiuxiu-desktop-dir.zip | 桌面端完整解压目录 | 便携版无法启动或需要排查问题时使用 |

普通用户通常只需要下载前两个：portable.exe 和 extension.zip。

## 安装与首次使用（Windows）

### 1. 安装桌面端

双击 portable.exe 即可运行。HLS/DASH、音视频合并和部分分片视频需要 ffmpeg：

~~~powershell
ffmpeg -version
~~~

如果提示找不到命令，请安装 ffmpeg，并把其目录加入系统 PATH，然后重新启动桌面端。

### 2. 安装浏览器扩展

1. 解压 extension.zip。
2. 打开 Edge 的 edge://extensions/ 或 Chrome 的 chrome://extensions/。
3. 开启“开发人员模式”。
4. 点击“加载解压缩的扩展”，选择解压后的扩展目录。

### 3. 注册桌面端通信

如果扩展提示无法连接桌面端，在源码目录执行：

~~~powershell
cd desktop
npm install
npm run register
~~~

## 怎么下载视频？

### 普通直链

把 MP4、WebM 等地址粘贴到桌面端，或在扩展捕获列表点击“下载”。

### HLS/DASH 流媒体

1. 打开视频网页并开始播放。
2. 点击浏览器扩展图标。
3. 在捕获列表选择 HLS/DASH 条目。
4. 点击“发送到桌面端”或“下载”。

### 连续分片视频

部分网站会不断生成 MP4/fMP4/TS 分片，而不是提供完整视频文件。请让视频从头完整播放，等待分片数量停止增长后再下载；不要拖动进度条跳过中间片段，否则可能缺片或生成不可播放文件。

### B 站视频

选择带视频标题的 DASH 条目下载，桌面端会自动下载视频轨和音频轨并合并为 MP4。需要登录权限时，请从扩展捕获列表下载，以便携带 Cookie、Referer 和 User-Agent。

## 主要功能

- 页面按钮、网络请求、fetch/XHR Hook 三层嗅探。
- HTTP Range 多线程下载、断点续传、限速和自适应连接数。
- HLS（m3u8）、DASH（mpd）和 B 站 playurl 处理。
- AES-128 HLS 解密、fMP4/TS 分片合并和 ffmpeg 转封装。
- 下载队列、暂停/继续、历史记录和批量删除。
- 显示实时速度、平均速度和最高速度。

## 项目结构

| 路径 | 作用 |
|---|---|
| extension/ | Chrome/Edge 扩展源码与构建产物 |
| desktop/gui/ | Electron 图形界面与托盘逻辑 |
| desktop/lib/downloader.mjs | 普通文件多线程下载、断点续传和限速 |
| desktop/lib/pipeline.mjs | HLS/DASH/分片流/B 站媒体下载管线 |
| desktop/lib/segments.mjs | 分片下载、AES-128 解密和初始化段处理 |
| desktop/lib/merge.mjs | 分片拼接、ffmpeg 转封装和音视频合并 |
| desktop/host.mjs | 扩展与桌面端之间的通信桥接 |
| .github/workflows/release.yml | 打 tag 后自动测试、打包并创建 Release |

## 从源码运行

要求：Node.js 22+、ffmpeg、Chrome 或 Edge。

~~~powershell
cd extension
npm install
npm test
npm run build

cd ..\desktop
npm install
npm test
npm run gui
~~~

## 常见问题

**扩展提示无法连接桌面端？**

运行 cd desktop; npm run register，并确认桌面端正在运行。

**下载结果是分片、不是视频？**

不要直接下载单个 TS/M4S 分片；选择 HLS/DASH 清单，或等待无清单分片流捕获完整后再下载。

**下载 403？**

优先从扩展捕获列表点击下载，不要手动复制地址，这样会自动携带必要请求头。

**清空或删除后还能重新嗅探吗？**

可以。当前版本会清理相关去重状态，重新播放视频即可再次捕获。

## 许可证

MIT License，见 LICENSE。

项目地址：https://github.com/Melody-YK/xiuxiu-downloader
