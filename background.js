// background.js (MV3)
// Receives popup request, captures visible tab, converts to Blob,
// creates an object URL in the extension context, and opens viewer.html.

function dataURLtoBlob(dataurl) {
  const parts = dataurl.split(',');
  const mimeMatch = parts[0].match(/:(.*?);/);
  const mime = mimeMatch ? mimeMatch[1] : 'image/png';
  const binary = atob(parts[1]);
  const len = binary.length;
  const u8 = new Uint8Array(len);
  for (let i = 0; i < len; i++) u8[i] = binary.charCodeAt(i);
  return new Blob([u8], { type: mime });
}

async function captureVisibleWithRetries(maxRetries = 3, delayMs = 250) {
  let lastErr;
  for (let i = 0; i < maxRetries; i++) {
    try {
      const dataUrl = await chrome.tabs.captureVisibleTab(null, {
        format: "jpeg",
        quality: 95
      });
      if (dataUrl) return dataUrl;
    } catch (e) {
      lastErr = e;
      await new Promise(r => setTimeout(r, delayMs * (i + 1)));
    }
  }
  throw lastErr || new Error("captureVisibleTab failed");
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg && msg.action === "capture-visible") {
    (async () => {
      try {
        const dataUrl = await captureVisibleWithRetries();

        // IMPORTANT: create object URL here (extension context), not in the page.
        const blob = dataURLtoBlob(dataUrl);
        const blobUrl = URL.createObjectURL(blob);

        const viewerUrl = chrome.runtime.getURL(
          `viewer.html?src=${encodeURIComponent(blobUrl)}`
        );

        await chrome.tabs.create({ url: viewerUrl });

        // If you also want to auto-download immediately, uncomment below:
        // await chrome.downloads.download({
        //   url: dataUrl,
        //   filename: `screenshot_${Date.now()}.jpg`,
        //   conflictAction: "uniquify"
        // });

        sendResponse({ success: true, blobUrl });
      } catch (error) {
        console.error("[Background] capture failed:", error);
        sendResponse({ success: false, error: error?.message || String(error) });
      }
    })();

    return true; // keep the message channel open for async sendResponse
  }
});
