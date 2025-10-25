document.getElementById('capture').addEventListener('click', async () => {
  const statusEl = document.getElementById('status');
  statusEl.textContent = 'Preparing...';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    statusEl.textContent = 'No active tab';
    return;
  }

  // Inject content script (ensures contentScript.js is available in the page context)
  await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    files: ['contentScript.js']
  });

  // Ask the content script to start
  chrome.tabs.sendMessage(tab.id, { action: 'start-capture' }, (resp) => {
    // optional: we can listen for any immediate response
    // actual progress will be shown via in-page alerts or downloads
  });

  // Close popup to let content script run in page tab
  window.close();
});
