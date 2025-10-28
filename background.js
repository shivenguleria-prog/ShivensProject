// background.js (MV3)
// Capture visible tab, store data URL to chrome.storage.local, open viewer.html with key.

async function captureVisibleWithRetries(maxRetries = 3, delayMs = 250) {
  if (!chrome.tabs || typeof chrome.tabs.captureVisibleTab !== 'function') {
    throw new Error('chrome.tabs.captureVisibleTab is not available in this context');
  }

  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 });
      if (!dataUrl) throw new Error('captureVisibleTab returned empty dataUrl');
      return dataUrl;
    } catch (err) {
      lastErr = err;
      console.warn(`[background] capture attempt ${i + 1} failed:`, err && err.message ? err.message : err);
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr || new Error('captureVisibleTab failed after retries');
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.action !== 'capture-visible') return false;

  (async () => {
    try {
      console.log('[background] capture-visible request received');

      // 1) capture visible tab
      let dataUrl;
      try {
        dataUrl = await captureVisibleWithRetries(3, 300);
        console.log('[background] capture succeeded, size:', (dataUrl && dataUrl.length) || 0);
      } catch (capErr) {
        console.error('[background] capture failed:', capErr);
        sendResponse({ success: false, error: `capture failed: ${capErr && capErr.message ? capErr.message : String(capErr)}` });
        return;
      }

      // 2) store dataUrl in chrome.storage.local under a stable key
      const storageKey = `capture_${Date.now()}`;
      try {
        await chrome.storage.local.set({ [storageKey]: dataUrl });
        console.log('[background] stored dataUrl to chrome.storage.local as', storageKey);
      } catch (stErr) {
        console.error('[background] storage.set failed:', stErr);
        sendResponse({ success: false, error: `storage.set failed: ${stErr && stErr.message ? stErr.message : String(stErr)}` });
        return;
      }

      // 3) open viewer.html passing the storage key (not the full base64)
      try {
        const viewerUrl = chrome.runtime.getURL(`viewer.html?srcKey=${encodeURIComponent(storageKey)}`);
        await chrome.tabs.create({ url: viewerUrl });
        console.log('[background] opened viewer:', viewerUrl);
      } catch (openErr) {
        console.error('[background] open viewer failed:', openErr);
        sendResponse({ success: false, error: `open viewer failed: ${openErr && openErr.message ? openErr.message : String(openErr)}` });
        return;
      }

      // success
      sendResponse({ success: true, key: storageKey });
    } catch (fatal) {
      console.error('[background] unexpected error:', fatal);
      sendResponse({ success: false, error: `unexpected: ${fatal && fatal.message ? fatal.message : String(fatal)}` });
    }
  })();

  return true; // keep the sendResponse channel open
});
