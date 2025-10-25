// background.js
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.action === 'capture-visible') {
    // Determine the window to capture (sender.tab.windowId)
    const winId = sender.tab?.windowId;
    chrome.tabs.captureVisibleTab(winId, { format: 'png' }, (dataUrl) => {
      if (chrome.runtime.lastError) {
        sendResponse({ success: false, error: chrome.runtime.lastError.message });
      } else {
        sendResponse({ success: true, dataUrl });
      }
    });
    // Indicate async response
    return true;
  }
});
