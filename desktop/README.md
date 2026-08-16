# desktop

桌面端宿主程序。Phase 2 起实现：

1. native messaging 宿主（stdio + 4 字节小端长度前缀 JSON）
2. native host manifest + 注册表注册（Chrome/Edge 两条路径）
3. Phase 3：HTTP Range 多线程下载核心
4. Phase 4：m3u8/mpd 解析、AES-128 解密、ffmpeg 合并

当前为空，待 Phase 1 验收后开工。
