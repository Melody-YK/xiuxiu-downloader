"use strict";
function extractMediaUrl(el) {
    const candidates = [el.currentSrc, el.src];
    if (el.children !== undefined) {
        for (let i = 0; i < el.children.length; i += 1) {
            const child = el.children[i];
            if (typeof child === 'object' && child !== null && 'src' in child) {
                candidates.push(child.src);
            }
        }
    }
    for (const c of candidates) {
        if (typeof c === 'string' && c !== '' && /^https?:\/\//i.test(c))
            return c;
    }
    return null;
}
const processed = new WeakSet();
let scanTimer = null;
let contextInvalidated = false;
function sendRuntimeMessage(message, callback) {
    if (contextInvalidated)
        return;
    try {
        chrome.runtime.sendMessage(message, (response) => {
            if (chrome.runtime.lastError !== undefined) {
                contextInvalidated = true;
                return;
            }
            callback?.(response);
        });
    }
    catch {
        contextInvalidated = true;
    }
}
function throttle(fn, ms) {
    let last = 0;
    return () => {
        const now = Date.now();
        if (now - last < ms)
            return;
        last = now;
        fn();
    };
}
function scheduleScan() {
    if (scanTimer !== null)
        return;
    scanTimer = setTimeout(() => {
        scanTimer = null;
        scan();
    }, 500);
}
function scan() {
    const els = document.querySelectorAll('video, audio');
    for (const el of els) {
        if (!(el instanceof HTMLElement) || processed.has(el))
            continue;
        processed.add(el);
        attachButton(el);
    }
}
function attachButton(el) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = '⬇ 下载';
    btn.title = '下载此媒体（嗅嗅下载器）';
    btn.style.cssText =
        'position:fixed;z-index:2147483647;display:none;padding:4px 10px;border:none;border-radius:6px;' +
            'background:#0969da;color:#fff;font:12px/1.4 system-ui,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,0.3);';
    document.body.appendChild(btn);
    const update = throttle(() => {
        // 取不到 http(s) 地址（如 MSE blob 流）时不显示按钮
        if (extractMediaUrl(el) === null) {
            btn.style.display = 'none';
            return;
        }
        const r = el.getBoundingClientRect();
        if (r.width < 100 || r.height < 80 || r.bottom < 0 || r.top > window.innerHeight || r.right < 0 || r.left > window.innerWidth) {
            btn.style.display = 'none';
            return;
        }
        btn.style.display = 'block';
        btn.style.left = String(Math.max(4, r.left + 8)) + 'px';
        btn.style.top = String(Math.max(4, r.top + 8)) + 'px';
    }, 150);
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    el.addEventListener('loadedmetadata', update);
    btn.addEventListener('click', () => {
        const url = extractMediaUrl(el);
        if (url === null) {
            btn.textContent = '✕ 无地址';
            setTimeout(() => {
                btn.textContent = '⬇ 下载';
            }, 1500);
            return;
        }
        sendRuntimeMessage({ type: 'content:download', url }, (resp) => {
            const ok = typeof resp === 'object' && resp !== null && resp.ok === true;
            btn.textContent = ok ? '✓ 已发送' : '✕ 失败';
            setTimeout(() => {
                btn.textContent = '⬇ 下载';
            }, 1500);
        });
    });
    // 元素被移除（SPA 切页等）时清理按钮
    const observer = new MutationObserver(() => {
        if (!document.body.contains(el)) {
            observer.disconnect();
            btn.remove();
            window.removeEventListener('scroll', update, true);
            window.removeEventListener('resize', update);
        }
    });
    observer.observe(document.body, { childList: true, subtree: true });
}
const rootObserver = new MutationObserver(() => scheduleScan());
rootObserver.observe(document.documentElement, { childList: true, subtree: true });
scheduleScan();
// ---- 第 3 层捕获：请求后台向主世界注入 fetch/XHR 钩子，并转发钩子回报的媒体 URL ----
sendRuntimeMessage({ type: 'hook:inject' });
window.addEventListener('message', (ev) => {
    if (ev.source !== window)
        return;
    const data = ev.data;
    if (data !== null && typeof data === 'object' && data.source === 'sniffer-page-hook' && typeof data.url === 'string') {
        sendRuntimeMessage({ type: 'hook:url', url: data.url, bvid: typeof data.bvid === 'string' ? data.bvid : '', title: typeof data.title === 'string' ? data.title : '' });
    }
});
