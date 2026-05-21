// content.js — 注入到目标页面，逐屏滚动并请求后台抓取，实现整页截图。
(async () => {
  if (window.__fpsBusy) return; // 防止重复触发
  window.__fpsBusy = true;

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const nextFrame = () =>
    new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));

  const docEl = document.documentElement;
  const body = document.body;

  // ---- 进度提示浮层 ----
  const overlay = document.createElement('div');
  overlay.style.cssText =
    'position:fixed;z-index:2147483647;top:14px;left:50%;transform:translateX(-50%);' +
    'background:#111827;color:#fff;font:14px/1.5 -apple-system,BlinkMacSystemFont,sans-serif;' +
    'padding:9px 18px;border-radius:10px;box-shadow:0 6px 22px rgba(0,0,0,.35);' +
    'pointer-events:none;letter-spacing:.5px;';
  overlay.textContent = '准备截图…';
  docEl.appendChild(overlay);
  const setText = (t) => {
    overlay.textContent = t;
  };

  // ---- 注入样式：隐藏滚动条、关闭平滑滚动 ----
  const style = document.createElement('style');
  style.textContent =
    'html::-webkit-scrollbar,body::-webkit-scrollbar{width:0!important;height:0!important;display:none!important;}' +
    'html{scroll-behavior:auto!important;scrollbar-width:none!important;}';
  docEl.appendChild(style);

  const startX = window.scrollX;
  const startY = window.scrollY;

  await sleep(150); // 等待隐藏滚动条后的重排

  const dpr = window.devicePixelRatio || 1;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const fullH = Math.max(
    docEl.scrollHeight,
    docEl.offsetHeight,
    docEl.clientHeight,
    body ? body.scrollHeight : 0,
    body ? body.offsetHeight : 0,
  );

  // ---- 收集 fixed / sticky 元素：只在第一屏保留，其后隐藏避免重复出现 ----
  const stickies = [];
  document.querySelectorAll('*').forEach((el) => {
    const pos = getComputedStyle(el).position;
    if (pos === 'fixed' || pos === 'sticky') {
      stickies.push({ el, vis: el.style.visibility });
    }
  });
  const hideStickies = () =>
    stickies.forEach((s) => {
      s.el.style.visibility = 'hidden';
    });
  const restoreStickies = () =>
    stickies.forEach((s) => {
      s.el.style.visibility = s.vis;
    });

  // ---- 计算每屏滚动位置 ----
  const positions = [];
  if (fullH <= vh) {
    positions.push(0);
  } else {
    for (let y = 0; y < fullH - vh; y += vh) positions.push(y);
    positions.push(fullH - vh); // 最后一屏对齐底部
  }

  let failed = null;
  try {
    for (let i = 0; i < positions.length; i++) {
      const py = positions[i];
      if (i === 1) hideStickies(); // 第二屏起隐藏固定元素
      window.scrollTo(0, py);
      await sleep(280); // 等待渲染与图片懒加载
      overlay.style.visibility = 'hidden'; // 抓取前隐藏自身浮层
      await nextFrame();
      const resp = await chrome.runtime.sendMessage({ type: 'captureFrame', y: py });
      overlay.style.visibility = 'visible';
      if (!resp || !resp.ok) throw new Error((resp && resp.error) || '截图调用失败');
      setText(`截图中… ${i + 1}/${positions.length}`);
      await sleep(380); // captureVisibleTab 限频约 2 次/秒
    }
    setText('正在生成编辑器…');
    await chrome.runtime.sendMessage({
      type: 'captureDone',
      meta: { vw, vh, fullH, dpr },
    });
  } catch (e) {
    failed = e;
    setText('截图失败：' + (e && e.message ? e.message : e));
    try {
      await chrome.runtime.sendMessage({ type: 'captureError', error: String(e) });
    } catch (_) {
      /* ignore */
    }
  } finally {
    restoreStickies();
    style.remove();
    window.scrollTo(startX, startY);
    await sleep(failed ? 2600 : 200);
    overlay.remove();
    window.__fpsBusy = false;
  }
})();
