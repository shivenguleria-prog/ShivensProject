// contentScript.js
// Full-page capture with zoom, adaptive WebP, and smart header handling
// Keeps the header visible only in the first capture, hides it for the rest.

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 19 * 1024 * 1024; // 19 MB
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY_PRIMARY = 0.97;
  const WEBP_QUALITY_FALLBACK = 0.92;
  const ZOOM_FACTOR = 0.8; // Zoom out to 80%
  // ------------------------

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === "start-capture") {
      startCapture().catch((e) => {
        console.error("Capture failed", e);
        alert("Capture failed: " + (e && e.message ? e.message : e));
      });
    }
  });

  // ---------- SAFE CAPTURE ----------
  async function safeCapture() {
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) {
      await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS - since));
    }

    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ action: "capture-visible" }, resolve);
      });
      lastCaptureTs = Date.now();

      if (res && res.success) return res.dataUrl;
      if (attempt === CAPTURE_MAX_RETRIES) {
        const errMsg = res?.error || "Unknown capture error";
        throw new Error(`capture failed: ${errMsg}`);
      }
      const backoff = CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  // ---------- UTILITIES ----------
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function canvasToBlob(canvas, type = "image/png", quality = 0.92) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), type, quality);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  async function detectVisuallyFixedElements() {
    const scrollTest = 150;
    const fixedCandidates = Array.from(document.querySelectorAll("body *"))
      .filter((el) => el.offsetParent !== null && el.getClientRects().length);

    const beforePositions = new Map();
    for (const el of fixedCandidates) {
      beforePositions.set(el, el.getBoundingClientRect().top);
    }

    window.scrollBy(0, scrollTest);
    await new Promise((r) => setTimeout(r, 120));

    const fixedDetected = [];
    for (const el of fixedCandidates) {
      const beforeTop = beforePositions.get(el);
      const afterTop = el.getBoundingClientRect().top;
      if (Math.abs(afterTop - beforeTop) < 1) fixedDetected.push(el);
    }

    window.scrollBy(0, -scrollTest);
    await new Promise((r) => setTimeout(r, 100));

    return fixedDetected;
  }

  // ---------- MAIN CAPTURE ----------
  async function startCapture() {
    if (!document.body) throw new Error("No document body found");

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    const originalZoom = document.documentElement.style.zoom || "";

    try {
      // 1️⃣ Apply zoom
      document.documentElement.style.zoom = String(ZOOM_FACTOR);
      await new Promise((r) => setTimeout(r, 150));

      // 2️⃣ Detect visually fixed elements
      const visuallyFixed = await detectVisuallyFixedElements();
      const styleCache = visuallyFixed.map((el) => ({
        el,
        orig: {
          position: el.style.position,
          top: el.style.top,
          bottom: el.style.bottom,
          zIndex: el.style.zIndex,
          transform: el.style.transform,
          display: el.style.display,
        },
      }));

      visuallyFixed.forEach((el) => {
        el.style.setProperty("position", "static", "important");
        el.style.setProperty("top", "auto", "important");
        el.style.setProperty("bottom", "auto", "important");
        el.style.setProperty("z-index", "auto", "important");
        el.style.setProperty("transform", "none", "important");
      });

      // 3️⃣ Find header element (common header selectors)
      const header = document.querySelector(
        "header, .header, #header, nav, .navbar, #navbar"
      );

      // 4️⃣ Measure after zoom
      const totalHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      );
      const viewportHeight = window.innerHeight;
      scrollingEl.style.overflow = "hidden";

      // 5️⃣ Compute scroll positions
      const positions = [];
      let y = 0;
      while (y < totalHeight - viewportHeight) {
        positions.push(Math.round(y));
        y += viewportHeight;
      }
      positions.push(totalHeight - viewportHeight);

      // 6️⃣ Capture loop
      const capturedDataUrls = [];
      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        scrollingEl.scrollTo({ top: pos, left: 0, behavior: "instant" });

        // 👇 Hide header after first capture
        if (i === 1 && header) {
          header.style.setProperty("display", "none", "important");
        }

        await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // 7️⃣ Restore scroll, overflow, zoom, header, and fixed styles
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: "instant" });
      scrollingEl.style.overflow = originalOverflow;
      document.documentElement.style.zoom = originalZoom;

      if (header) header.style.display = styleCache.find(s => s.el === header)?.orig.display || "";

      for (const it of styleCache) {
        const s = it.el.style;
        s.position = it.orig.position || "";
        s.top = it.orig.top || "";
        s.bottom = it.orig.bottom || "";
        s.zIndex = it.orig.zIndex || "";
        s.transform = it.orig.transform || "";
        s.display = it.orig.display || "";
      }

      // 8️⃣ Load captures
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // Helper: stitch vertically
      async function stitchImages(imgItems, mime = "image/png", quality = 0.92) {
        const w = Math.max(...imgItems.map((i) => i.width));
        const h = imgItems.reduce((s, i) => s + i.height, 0);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext("2d");
        let y = 0;
        for (const it of imgItems) {
          ctx.drawImage(it.img, 0, y, it.width, it.height);
          y += it.height;
        }
        const blob = await canvasToBlob(canvas, mime, quality);
        return { blob, width: w, height: h, mime };
      }

      // 9️⃣ Try PNG
      const { blob: pngBlob } = await stitchImages(images, "image/png");
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, "png");
        alert("Saved as PNG (under 19MB)");
        return;
      }

      // 🔟 Try WebP (0.97 → 0.92)
      const { blob: webp97 } = await stitchImages(images, "image/webp", WEBP_QUALITY_PRIMARY);
      if (webp97.size <= MAX_BYTES) {
        saveBlob(webp97, "webp");
        alert("Saved as WebP (quality 0.97)");
        return;
      }

      const { blob: webp92 } = await stitchImages(images, "image/webp", WEBP_QUALITY_FALLBACK);
      if (webp92.size <= MAX_BYTES) {
        saveBlob(webp92, "webp");
        alert("Saved as WebP (quality 0.92)");
        return;
      }

      // 11️⃣ Split into batches
      const batches = [];
      let currentBatch = [];
      for (let i = 0; i < images.length; i++) {
        const candidate = images[i];
        const tryBatch = currentBatch.concat([candidate]);
        const { blob: testBlob } = await stitchImages(tryBatch, "image/webp", WEBP_QUALITY_PRIMARY);
        if (testBlob.size <= MAX_BYTES) {
          currentBatch = tryBatch;
        } else {
          if (currentBatch.length > 0) {
            const { blob } = await stitchImages(currentBatch, "image/webp", WEBP_QUALITY_PRIMARY);
            batches.push(blob);
          }
          currentBatch = [candidate];
        }
      }
      if (currentBatch.length > 0) {
        const { blob } = await stitchImages(currentBatch, "image/webp", WEBP_QUALITY_PRIMARY);
        batches.push(blob);
      }

      // 12️⃣ Save batches
      for (let i = 0; i < batches.length; i++) {
        let blob = batches[i];
        if (blob.size > MAX_BYTES) {
          const { blob: fallback } = await stitchImages(
            [images[i]],
            "image/webp",
            WEBP_QUALITY_FALLBACK
          );
          blob = fallback;
        }
        saveBlob(blob, "webp", i + 1);
      }

      alert(`Saved as ${batches.length} WebP image(s) (each ≤19MB)`);

      // Helper
      function saveBlob(blob, ext, index = 0) {
        const base = new URL(location.href).hostname.replace(/\./g, "_");
        const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
        downloadBlob(blob, name);
      }
    } catch (err) {
      console.error(err);
      alert("Capture failed: " + err.message);
      try { document.documentElement.style.zoom = originalZoom; } catch {}
      try { scrollingEl.style.overflow = originalOverflow; } catch {}
    }
  }
})();
