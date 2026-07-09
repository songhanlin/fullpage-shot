// background.js — 协调整页截图流程，截完后打开编辑器页面。
// 截图由 content.js 负责滚动，本脚本负责调用 captureVisibleTab 抓取每一屏。

// 按 tabId 隔离分片，避免多个标签页同时截图时数据互相混入
const captures = new Map();

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab || tab.id == null) return;
  const url = tab.url || '';
  if (
    /^(chrome|edge|about|devtools|view-source|chrome-extension|moz-extension):/.test(url) ||
    url.startsWith('https://chromewebstore.google.com') ||
    url.startsWith('https://chrome.google.com/webstore')
  ) {
    await alertOnTab(tab.id, '当前页面不支持截图，请在普通网页上使用本扩展。');
    return;
  }
  captures.set(tab.id, []);
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content.js'],
    });
  } catch (e) {
    await alertOnTab(tab.id, '无法注入截图脚本：' + (e && e.message ? e.message : e));
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const tabId = sender && sender.tab ? sender.tab.id : null;

  if (msg && msg.type === 'captureFrame') {
    if (tabId == null || !captures.has(tabId)) {
      sendResponse({ ok: false, error: '截图会话已失效，请重新开始' });
      return false;
    }
    const winId = sender.tab.windowId;
    chrome.tabs
      .captureVisibleTab(winId, { format: 'png' })
      .then((dataUrl) => {
        const slices = captures.get(tabId);
        if (slices) slices.push({ y: msg.y, dataUrl });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }

  if (msg && msg.type === 'captureDone') {
    (async () => {
      try {
        const slices = (tabId != null && captures.get(tabId)) || [];
        captures.delete(tabId);
        // 每次截图独立存储键，避免多标签页并发时编辑器读到别人的数据
        const key = `captureData:${tabId}:${Date.now()}`;
        await chrome.storage.local.set({
          [key]: { meta: msg.meta, slices, ts: Date.now() },
        });
        await chrome.tabs.create({
          url: chrome.runtime.getURL('editor.html') + '?key=' + encodeURIComponent(key),
        });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'captureError') {
    if (tabId != null) captures.delete(tabId);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

// 清理旧版固定键，以及编辑器一直未消费（超过 1 天）的残留截图数据
async function purgeStaleCaptures() {
  try {
    const all = await chrome.storage.local.get(null);
    const now = Date.now();
    const stale = Object.keys(all).filter(
      (k) =>
        k === 'captureData' ||
        (k.startsWith('captureData:') && now - ((all[k] && all[k].ts) || 0) > 86400000),
    );
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch (_) {
    /* 清理失败不影响主流程 */
  }
}
chrome.runtime.onInstalled.addListener(purgeStaleCaptures);
chrome.runtime.onStartup.addListener(purgeStaleCaptures);

async function alertOnTab(tabId, message) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (m) => window.alert(m),
      args: [message],
    });
  } catch (_) {
    /* 页面可能不允许注入，忽略 */
  }
}
