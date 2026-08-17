// 剪贴板弹窗逻辑：CSP 只允许外部脚本，禁止内联（曾导致按钮无响应）
(function () {
  const params = new URLSearchParams(location.search);
  const url = params.get('url') ?? '';
  const u = document.getElementById('u');
  if (u !== null) {
    u.textContent = url;
    u.title = url;
  }
  // 标题带上 URL：便于窗口枚举验证脚本确实执行
  document.title = '剪贴板下载: ' + (url === '' ? '(空)' : url.slice(0, 60));
  const ignore = document.getElementById('ignore');
  const go = document.getElementById('go');
  if (ignore !== null) {
    ignore.addEventListener('click', () => {
      window.api.closeClip();
    });
  }
  if (go !== null) {
    go.addEventListener('click', () => {
      if (url !== '') window.api.addTask({ url, kind: 'auto' });
      window.api.closeClip();
    });
  }
})();
