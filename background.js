// background.js
// Integrates with your merged contentScript.js that:
//  - listens for { action: 'start-capture' } to begin
//  - calls chrome.runtime.sendMessage({ action: 'capture-visible' }) to request captures

// Helper: captureVisibleTab with retries
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

// Message handler
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || !msg.action) return false;

  // popup -> background: start capture flow
  if (msg.action === 'start-capture') {
    (async () => {
      try {
        // find active tab
        const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
        if (!tabs || !tabs[0]) {
          sendResponse({ success: false, error: 'No active tab found' });
          return;
        }
        const tab = tabs[0];

        // do not run on internal chrome pages or webstore
        if (!tab.url || tab.url.startsWith('chrome://') || tab.url.startsWith('chrome.google.com/webstore')) {
          sendResponse({ success: false, error: 'Cannot inject into this page (internal/webstore).' });
          return;
        }

        // Inject contentScript.js (MV3 runtime injection)
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['contentScript.js']
          });
        } catch (injErr) {
          console.error('[background] injection failed:', injErr);
          // If contentScript was already registered statically via manifest content_scripts, injection may fail - still try to message
        }

        // Give the page a small tick to register listeners (optional)
        await new Promise((r) => setTimeout(r, 60));

        // Send message to content script to begin capture (content script listens for 'start-capture')
        chrome.tabs.sendMessage(tab.id, { action: 'start-capture' }, (resp) => {
          if (chrome.runtime.lastError) {
            console.error('[background] sendMessage to content script failed:', chrome.runtime.lastError.message);
            sendResponse({ success: false, error: chrome.runtime.lastError.message });
            return;
          }
          sendResponse({ success: true, info: 'capture started in page' });
        });
      } catch (err) {
        console.error('[background] start-capture failed:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true; // keep channel open
  }

  // contentScript -> background: actual capture request for a tile
  if (msg.action === 'capture-visible') {
    (async () => {
      try {
        const dataUrl = await captureVisibleWithRetries(3, 250);
        sendResponse({ success: true, dataUrl });
      } catch (err) {
        console.error('[background] capture-visible failed:', err);
        sendResponse({ success: false, error: err && err.message ? err.message : String(err) });
      }
    })();
    return true;
  }

  // Optionally other actions...
  return false;
});
