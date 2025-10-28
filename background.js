// background.js (defensive, verbose)
// Replaces previous background script to add robust error handling and clearer logs.

function dataURLtoBlob(dataurl) {
  const parts = dataurl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(parts[1] || '');
  const len = binary.length;
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

/**
 * Safely create an object URL. If URL.createObjectURL is unavailable or fails
 * (some pages override URL or createObjectURL is not present in some contexts),
 * convert the blob to a data URL as a fallback.
 *
 * Returns a Promise that resolves to a string (blob:... or data:...).
 */
function safeCreateObjectUrl(blob) {
  return new Promise((resolve, reject) => {
    try {
      if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
        try {
          const o = URL.createObjectURL(blob);
          return resolve(o);
        } catch (e) {
          console.warn('[background] URL.createObjectURL threw, falling back to FileReader', e);
          // fall through to FileReader fallback
        }
      } else if (typeof webkitURL !== 'undefined' && typeof webkitURL.createObjectURL === 'function') {
        try {
          const o = webkitURL.createObjectURL(blob);
          return resolve(o);
        } catch (e) {
          console.warn('[background] webkitURL.createObjectURL threw, falling back to FileReader', e);
        }
      }
    } catch (outer) {
      console.warn('[background] check for createObjectURL failed', outer);
    }

    // Fallback: convert Blob -> dataURL via FileReader
    try {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = (err) => reject(err || new Error('FileReader error'));
      reader.readAsDataURL(blob);
    } catch (frErr) {
      reject(frErr);
    }
  });
}

/**
 * Try capturing the visible tab with retries and backoff.
 */
async function captureVisibleWithRetries(maxRetries = 3, delayMs = 250) {
  if (!chrome.tabs || typeof chrome.tabs.captureVisibleTab !== 'function') {
    throw new Error('chrome.tabs.captureVisibleTab is not available in this context');
  }

  let lastErr = null;
  for (let i = 0; i < maxRetries; i++) {
    try {
      // captureVisibleTab returns a data URL (string) or throws
      const dataUrl = await chrome.tabs.captureVisibleTab(null, { format: 'jpeg', quality: 95 });
      if (!dataUrl) throw new Error('captureVisibleTab returned empty dataUrl');
      return dataUrl;
    } catch (err) {
      lastErr = err;
      console.warn(`[background] capture attempt ${i + 1} failed:`, err && err.message ? err.message : err);
      // small exponential backoff
      await new Promise((r) => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr || new Error('captureVisibleTab failed after retries');
}

/**
 * Main message handler. Accepts { action: "capture-visible" }.
 * Returns detailed error messages on failure (so popup can display them).
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.action !== 'capture-visible') return false;

  (async () => {
    try {
      console.log('[background] capture-visible request received');

      // 1) Perform the capture
      let dataUrl;
      try {
        dataUrl = await captureVisibleWithRetries(3, 300);
        console.log('[background] capture succeeded, bytes:', (dataUrl && dataUrl.length) || 0);
      } catch (capErr) {
        console.error('[background] captureVisibleWithRetries failed:', capErr);
        sendResponse({ success: false, error: `capture failed: ${capErr && capErr.message ? capErr.message : String(capErr)}` });
        return;
      }

      // 2) Convert data URL to Blob
      let blob;
      try {
        blob = dataURLtoBlob(dataUrl);
        console.log('[background] converted dataUrl to Blob, size:', blob.size);
      } catch (convErr) {
        console.error('[background] dataURL -> Blob conversion failed:', convErr);
        sendResponse({ success: false, error: `conversion failed: ${convErr && convErr.message ? convErr.message : String(convErr)}` });
        return;
      }

      // 3) Create object URL (safe)
      let objectUrl;
      try {
        objectUrl = await safeCreateObjectUrl(blob);
        console.log('[background] created object URL (or data URL fallback), length:', (objectUrl && objectUrl.length) || 0);
      } catch (urlErr) {
        console.error('[background] safeCreateObjectUrl failed:', urlErr);
        sendResponse({ success: false, error: `object URL creation failed: ${urlErr && urlErr.message ? urlErr.message : String(urlErr)}` });
        return;
      }

      // 4) Open viewer.html with objectUrl
      try {
        const viewerUrl = chrome.runtime.getURL(`viewer.html?src=${encodeURIComponent(objectUrl)}`);
        await chrome.tabs.create({ url: viewerUrl });
        console.log('[background] opened viewer:', viewerUrl);
      } catch (openErr) {
        console.error('[background] failed to open viewer tab:', openErr);
        sendResponse({ success: false, error: `open tab failed: ${openErr && openErr.message ? openErr.message : String(openErr)}` });
        return;
      }

      // success
      sendResponse({ success: true, blobUrl: objectUrl });
    } catch (fatal) {
      console.error('[background] unexpected error:', fatal);
      sendResponse({ success: false, error: `unexpected: ${fatal && fatal.message ? fatal.message : String(fatal)}` });
    }
  })();

  return true; // indicates async sendResponse
});
