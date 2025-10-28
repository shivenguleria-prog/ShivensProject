// popup.js — send start-capture to background
(function () {
  const btn =
    document.getElementById("captureBtn") ||
    document.getElementById("startCapture") ||
    document.querySelector("button");

  const statusEl =
    document.getElementById("status") ||
    document.getElementById("statusText") ||
    document.querySelector(".status") ||
    { textContent: "" };

  if (!btn) {
    console.warn("Popup: no capture button found. Ensure #captureBtn exists.");
    return;
  }

  btn.addEventListener("click", async () => {
    statusEl.textContent = "Initializing capture…";
    try {
      const resp = await chrome.runtime.sendMessage({ action: 'start-capture' });
      if (resp && resp.success) {
        statusEl.textContent = 'Capture started — observe the tab.';
      } else {
        const err = resp && resp.error ? resp.error : 'unknown error';
        alert('Could not start capture: ' + err);
        statusEl.textContent = 'Failed';
        console.error('start-capture response:', resp);
      }
    } catch (e) {
      console.error('popup -> background error:', e);
      alert('Message failed: ' + (e && e.message ? e.message : e));
      statusEl.textContent = 'Error';
    }
  });
})();
