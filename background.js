// background.js
// Full-page capture service worker — unified version
// Supports queue-based visible tab captures for multiple requests,
// creates a blob URL and opens the extension viewer page.

let captureQueue = [];
let isCapturing = false;

/**
 * Capture the current visible tab with retries and backoff.
 */
async function captureWithRetries(maxRetries = 3, delayMs = 300) {
  for (let i = 0; i < maxRetries; i++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg",
        quality: 95,
      });
      if (dataUrl) return dataUrl;
    } catch (err) {
      console.warn(`[Capture] Retry ${i + 1}/${maxRetries} failed:`, err);
    }
    await sleep(delayMs * (i + 1)); // incremental backoff
  }
  throw new Error("captureVisibleTab failed after retries");
}

/**
 * Simple delay helper.
 */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Convert data URL to Blob
 */
function dataURLtoBlob(dataurl) {
  const arr = dataurl.split(',');
  const mimeMatch = arr[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const bstr = atob(arr[1]);
  let n = bstr.length;
  const u8arr = new Uint8Array(n);
  while (n--) {
    u8arr[n] = bstr.charCodeAt(n);
  }
  return new Blob([u8arr], { type: mime });
}

/**
 * Core handler for messages from content scripts or popup.
 * Expect message { action: "capture-visible" }.
 */
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === "capture-visible") {
    captureQueue.push({ sender, sendResponse });
    processQueue();
    return true; // keep port open for async reply
  }
});

/**
 * Sequentially process queued capture requests.
 */
async function processQueue() {
  if (isCapturing || captureQueue.length === 0) return;
  isCapturing = true;

  const task = captureQueue.shift();
  try {
    const dataUrl = await captureWithRetries();

    // create blob in extension (service worker) origin
    const blob = dataURLtoBlob(dataUrl);
    const blobUrl = URL.createObjectURL(blob);

    // Open the viewer page in a new tab and pass the blob URL as query param
    const viewerUrl = chrome.runtime.getURL(`viewer.html?src=${encodeURIComponent(blobUrl)}`);
    chrome.tabs.create({ url: viewerUrl }, (tab) => {
      // optionally respond to the sender with the tab id and blobUrl
      task.sendResponse({ success: true, dataUrl, blobUrl, tabId: tab?.id || null });
    });

    // OPTIONAL: If you want to auto-download immediately as before, uncomment:
    // const filename = `screenshot_${Date.now()}.jpg`;
    // chrome.downloads.download({ url: dataUrl, filename, conflictAction: 'uniquify' });

  } catch (error) {
    console.error("[Capture Error]", error);
    task.sendResponse({ success: false, error: error.message });
  }

  isCapturing = false;

  // Process next capture if queued
  if (captureQueue.length > 0) processQueue();
}
