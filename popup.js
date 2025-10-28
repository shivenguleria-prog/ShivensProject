// popup.js
(function () {
  const btn =
    document.getElementById("captureBtn") ||
    document.getElementById("startCapture") ||
    document.querySelector("[data-action='capture']") ||
    document.querySelector("button"); // fallback to first button

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
    statusEl.textContent = "Capturing…";
    try {
      const resp = await chrome.runtime.sendMessage({ action: "capture-visible" });
      if (resp && resp.success) {
        statusEl.textContent = "Opened in new tab.";
      } else {
        statusEl.textContent = "Failed to capture.";
      }
    } catch (e) {
      console.error("Popup -> background error:", e);
      statusEl.textContent = "Error: Could not start capture.";
    }
  });
})();
