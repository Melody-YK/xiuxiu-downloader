// 页面主世界钩子（第 3 层捕获）：拦截 fetch/XHR 上报动态媒体 URL。
// 由 background 通过 chrome.scripting.executeScript({ world: 'MAIN' }) 注入，
// 不受页面 CSP 限制；专治 MSE 站点（B站/YouTube 等）——分片地址由 JS 动态请求，DOM 里只有 blob:。
(function () {
  'use strict';
  if (window.__SNIFFER_HOOKED__) return;
  window.__SNIFFER_HOOKED__ = true;

  var MEDIA_RE = /\.(m3u8|mpd|mp4|webm|flv|f4v|m4s|m4a|m4v|ts|mp3|aac|ogg|wav|mov|avi|mkv|opus|flac)(?:[?#]|$)/i;
  var BILI_RE = /bilibili\.com\/(x\/player\/(wbi\/)?playurl|pgc\/player\/web\/playurl)/i;
  var seen = {};

  function bvidFromUrl(url) {
    var m = /[?&]bvid=([A-Za-z0-9]+)/.exec(url);
    if (m) return m[1];
    var e = /[?&]ep_id=(\d+)/.exec(url);
    if (e) return 'ep' + e[1];
    var a = /[?&]aid=(\d+)/.exec(url);
    if (a) return 'av' + a[1];
    return '';
  }

  function report(url) {
    if (typeof url !== 'string' || url === '' || url.indexOf('http') !== 0) return;
    if (!MEDIA_RE.test(url) && !BILI_RE.test(url)) return;
    if (seen[url]) return;
    seen[url] = true;
    var bvid = '';
    var title = '';
    if (BILI_RE.test(url)) {
      bvid = bvidFromUrl(url);
      try {
        var st = window.__INITIAL_STATE__;
        // 只给主视频贴页面里的真实标题；预览视频（bvid 不符）不贴标题，避免张冠李戴
        if (st && st.videoData && (!bvid || String(st.videoData.bvid || '') === bvid)) {
          title = st.videoData.title || '';
        }
      } catch (e) {
        // 忽略
      }
    }
    try {
      window.postMessage({ source: 'sniffer-page-hook', url: url, bvid: bvid, title: title }, '*');
    } catch (e) {
      // 忽略
    }
  }

  // fetch 钩子（flv.js / hls.js / dash.js 等播放器都用它）
  var origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      try {
        var u = typeof input === 'string' ? input : (input && input.url ? input.url : '');
        report(u);
      } catch (e) {
        // 忽略
      }
      return origFetch.apply(this, arguments);
    };
  }

  // XHR 钩子
  var origOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      report(url);
    } catch (e) {
      // 忽略
    }
    return origOpen.apply(this, arguments);
  };
})();
