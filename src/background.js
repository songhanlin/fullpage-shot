// background.js — 协调整页截图流程，截完后打开编辑器页面。
// 截图由 content.js 负责滚动，本脚本负责调用 captureVisibleTab 抓取每一屏。

let slices = [];

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
  slices = [];
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
  if (msg && msg.type === 'captureFrame') {
    const winId = sender.tab.windowId;
    chrome.tabs
      .captureVisibleTab(winId, { format: 'png' })
      .then((dataUrl) => {
        slices.push({ y: msg.y, dataUrl });
        sendResponse({ ok: true });
      })
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true; // 异步响应
  }

  if (msg && msg.type === 'captureDone') {
    (async () => {
      try {
        await chrome.storage.local.set({
          captureData: { meta: msg.meta, slices, ts: Date.now() },
        });
        slices = [];
        await chrome.tabs.create({ url: chrome.runtime.getURL('editor.html') });
        sendResponse({ ok: true });
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
    })();
    return true;
  }

  if (msg && msg.type === 'captureError') {
    slices = [];
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

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
