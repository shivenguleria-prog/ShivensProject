// popup.js
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
    statusEl.textContent = "Capturing…";
    try {
      const resp = await chrome.runtime.sendMessage({ action: "capture-visible" });
      if (resp && resp.success) {
        statusEl.textContent = "Opened in new tab.";
      } else {
        const err = resp && resp.error ? resp.error : "unknown error";
        alert("Capture failed: " + err);
        statusEl.textContent = "Failed to capture.";
        console.error("capture-visible failed:", resp);
      }
    } catch (e) {
      console.error("Popup -> background error:", e);
      alert("Message failed: " + (e && e.message ? e.message : e));
      statusEl.textContent = "Error: Could not start capture.";
    }
  });
})();
