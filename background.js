// background.js (MV3) — supports stitching flow
// Messages:
// - { action: 'start-full-capture' }  // from popup -> start flow (inject content script & send begin message)
// - { action: 'capture-for-stitch' } // from content script -> returns dataUrl of visible tab
// - { action: 'store-and-open', dataUrl } // from content script -> store & open viewer

// Helper: capture visible tab with retries
async function captureVisibleWithRetries(maxRetries = 3, delayMs = 200) {
  if (!chrome.tabs || typeof chrome.tabs.captureVisibleTab !== 'function') {
    throw new Error('chrome.tabs.captureVisibleTab not available');
  }
  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 });
      if (!dataUrl) throw new Error('empty dataUrl from captureVisibleTab');
      return dataUrl;
    } catch (err) {
      lastErr = err;
      console.warn(`[background] capture attempt ${i + 1} failed:`, err && err.message ? err.message : err);
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr || new Error('captureVisibleTab failed');
}

// Listener
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  // 1) Start-full-capture: inject content script and tell it to begin
  if (msg.action === 'start-full-capture') {
    (async () => {
      try {
        // Find active tab
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) {
          sendResponse({ success: false, error: 'No active tab' });
          return;
        }
        const tab = tabs[0];

        // Do not inject on restricted pages
        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome.google.com/webstore')) {
          sendResponse({ success: false, error: 'Cannot run on this page (internal or webstore).' });
          return;
        }

        // Inject contentScript.js into tab
        await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['contentScript.js']
        });

        // Tell the content script to begin stitch capture
        chrome.tabs.sendMessage(tab.id, { action: 'begin-stitch' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.error('[background] sendMessage to content script failed:', chrome.runtime.lastError.message);
            sendResponse({ success: false, error: `sendMessage failed: ${chrome.runtime.lastError.message}` });
            return;
          }
          sendResponse({ success: true, info: 'content script started' });
        });
      } catch (err) {
        console.error('[background] start-full-capture failed:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 2) capture-for-stitch: background captures and returns dataUrl directly
  if (msg.action === 'capture-for-stitch') {
    (async () => {
      try {
        const dataUrl = await captureVisibleWithRetries();
        sendResponse({ success: true, dataUrl });
      } catch (err) {
        console.error('[background] capture-for-stitch failed:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // 3) store-and-open: store provided dataURL under a key and open viewer.html?srcKey=...
  if (msg.action === 'store-and-open') {
    (async () => {
      try {
        const dataUrl = msg.dataUrl;
        if (!dataUrl) {
          sendResponse({ success: false, error: 'no dataUrl provided' });
          return;
        }
        const key = `capture_${Date.now()}`;
        await chrome.storage.local.set({ [key]: dataUrl });
        const viewerUrl = chrome.runtime.getURL(`viewer.html?srcKey=${encodeURIComponent(key)}`);
        await chrome.tabs.create({ url: viewerUrl });
        sendResponse({ success: true, key });
      } catch (err) {
        console.error('[background] store-and-open failed:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  return false;
});

