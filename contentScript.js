// contentScript.js
// Full-page capture with:
// - Zoom-out scaling
// - PNG -> WebP(primary 0.97) -> WebP(fallback 0.92) -> split if >19MB
// - Fixed/sticky and JS-pinned headers handled
// - Option 1: temporarily disable site scroll JS (prevents site from re-sticking header during programmatic scroll)
// - Precise scroll positions computed after zoom
//
// Drop this into your extension (replace existing contentScript.js)

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
  const ZOOM_FACTOR = 0.8; // 80% zoom out
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
      img.onerror = (e) => reject(new Error("Image load failed: " + e));
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

  // ---------- SITE SCROLL-JS DISABLER (Option 1) ----------
  // This tries to prevent site JS from reacting to programmatic scrolls.
  // Strategy:
  // 1) Backup and null window.onscroll / document.onscroll
  // 2) Install capture-phase listeners that stop propagation for scroll/wheel/touch/pointer
  // 3) Override EventTarget.prototype.addEventListener temporarily to block new scroll/wheel listeners
  // 4) Temporarily override IntersectionObserver.observe to noop (prevents some observers reacting)
  //
  // Restore everything after capture.

  const siteDisableState = {
    backed: false,
    backup: {},
    blockerListeners: [],
  };

  function disableSiteScrollJS() {
    if (siteDisableState.backed) return;
    siteDisableState.backed = true;

    // backup simple properties
    siteDisableState.backup.windowOnScroll = window.onscroll;
    siteDisableState.backup.documentOnScroll = document.onscroll;

    try {
      window.onscroll = null;
    } catch (e) {}
    try {
      document.onscroll = null;
    } catch (e) {}

    // override addEventListener to prevent new scroll-related listeners
    siteDisableState.backup.addEventListener = EventTarget.prototype.addEventListener;
    siteDisableState.backup.removeEventListener = EventTarget.prototype.removeEventListener;

    EventTarget.prototype.addEventListener = function (type, listener, options) {
      const blocked = /^(scroll|wheel|touchstart|touchmove|touchend|pointermove|mousewheel)$/i;
      if (blocked.test(type)) {
        // swallow adding scroll-related listener while disabled
        return;
      }
      return siteDisableState.backup.addEventListener.call(this, type, listener, options);
    };

    EventTarget.prototype.removeEventListener = function (type, listener, options) {
      // allow normal removal (use original remove)
      return siteDisableState.backup.removeEventListener.call(this, type, listener, options);
    };

    // Add capture-phase blockers that stop propagation of scroll-like events
    const blockTypes = ["scroll", "wheel", "touchmove", "pointermove", "mousewheel", "touchstart", "touchend"];
    blockTypes.forEach((t) => {
      const handler = function (e) {
        // prevent site handlers from receiving these events (capture phase)
        try {
          e.stopImmediatePropagation();
        } catch (err) {}
        // Don't preventDefault for scroll events to avoid breaking scrollTo behavior
      };
      window.addEventListener(t, handler, { capture: true, passive: false });
      document.addEventListener(t, handler, { capture: true, passive: false });
      siteDisableState.blockerListeners.push({ type: t, handler });
    });

    // Override IntersectionObserver.observe to noop temporarily (some sites use it to change header)
    siteDisableState.backup.IntersectionObserver = window.IntersectionObserver;
    try {
      window.IntersectionObserver = class {
        constructor() {}
        observe() {}
        unobserve() {}
        disconnect() {}
      };
    } catch (e) {
      // ignore
    }

    // Also attempt to pause requestAnimationFrame-driven scripts by wrapping raf? (We won't override raf; it's risky)
    // For many sites this will be sufficient.
  }

  function restoreSiteScrollJS() {
    if (!siteDisableState.backed) return;
    siteDisableState.backed = false;

    try {
      window.onscroll = siteDisableState.backup.windowOnScroll;
    } catch (e) {}
    try {
      document.onscroll = siteDisableState.backup.documentOnScroll;
    } catch (e) {}

    // restore addEventListener/removeEventListener
    if (siteDisableState.backup.addEventListener) {
      EventTarget.prototype.addEventListener = siteDisableState.backup.addEventListener;
    }
    if (siteDisableState.backup.removeEventListener) {
      EventTarget.prototype.removeEventListener = siteDisableState.backup.removeEventListener;
    }

    // remove blocker listeners
    siteDisableState.blockerListeners.forEach(({ type, handler }) => {
      try {
        window.removeEventListener(type, handler, { capture: true });
      } catch (e) {}
      try {
        document.removeEventListener(type, handler, { capture: true });
      } catch (e) {}
    });
    siteDisableState.blockerListeners = [];

    // restore IntersectionObserver
    if (siteDisableState.backup.IntersectionObserver) {
      try {
        window.IntersectionObserver = siteDisableState.backup.IntersectionObserver;
      } catch (e) {}
    }

    siteDisableState.backup = {};
  }

  // ---------- DETECT VISUALLY FIXED ELEMENTS (kept but run after we disable site scripts) ----------
  async function detectVisuallyFixedElements() {
    const scrollTest = 150;
    const allEls = Array.from(document.querySelectorAll("body *"));
    const candidates = allEls.filter((el) => el.offsetParent !== null && el.getClientRects().length);

    const beforePositions = new Map();
    for (const el of candidates) {
      beforePositions.set(el, el.getBoundingClientRect().top);
    }

    window.scrollBy(0, scrollTest);
    await new Promise((r) => setTimeout(r, 120));

    const fixedDetected = [];
    for (const el of candidates) {
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

    // We'll cache modified elements to restore later
    let styleCache = [];
    let visuallyFixed = [];

    try {
      // 0) Disable site scroll JS aggressively (Option 1)
      disableSiteScrollJS();

      // 1) Apply zoom (before measuring)
      document.documentElement.style.zoom = String(ZOOM_FACTOR);
      await new Promise((r) => setTimeout(r, 150)); // allow reflow

      // 2) Detect visually fixed elements now that site scroll handlers are mostly disabled
      visuallyFixed = await detectVisuallyFixedElements();

      // 3) Cache and force them to normal flow
      styleCache = visuallyFixed.map((el) => ({
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
        try {
          el.style.setProperty("position", "static", "important");
          el.style.setProperty("top", "auto", "important");
          el.style.setProperty("bottom", "auto", "important");
          el.style.setProperty("z-index", "auto", "important");
          el.style.setProperty("transform", "none", "important");
          // ensure it's visible in normal flow
          if (getComputedStyle(el).display === "none") {
            el.style.setProperty("display", "block", "important");
          }
        } catch (e) {
          // ignore
        }
      });

      // 4) Measure after zoom & adjustments
      const totalHeight = Math.max(
        document.documentElement.scrollHeight,
        document.body.scrollHeight
      );
      const viewportHeight = window.innerHeight;

      scrollingEl.style.overflow = "hidden";

      // 5) Compute scroll positions (no overlap)
      const positions = [];
      let y = 0;
      while (y < totalHeight - viewportHeight) {
        positions.push(Math.round(y));
        y += viewportHeight;
      }
      positions.push(Math.max(0, totalHeight - viewportHeight));

      // 6) Capture each viewport
      const capturedDataUrls = [];
      for (const pos of positions) {
        scrollingEl.scrollTo({ top: pos, left: 0, behavior: "instant" });
        await new Promise((r) => setTimeout(r, CAPTURE_DELAY_MS));
        // Re-apply forced styles each iteration as a safety (in case some inline script slipped through)
        for (const it of styleCache) {
          try {
            it.el.style.setProperty("position", "static", "important");
            it.el.style.setProperty("transform", "none", "important");
            it.el.style.setProperty("top", "auto", "important");
            it.el.style.setProperty("bottom", "auto", "important");
            it.el.style.setProperty("z-index", "auto", "important");
          } catch (e) {}
        }

        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // 7) Restore DOM (scroll, overflow, zoom) BEFORE stitching
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: "instant" });
      scrollingEl.style.overflow = originalOverflow;
      document.documentElement.style.zoom = originalZoom;

      // Restore visually-fixed elements' styles
      for (const it of styleCache) {
        try {
          const s = it.el.style;
          s.position = it.orig.position || "";
          s.top = it.orig.top || "";
          s.bottom = it.orig.bottom || "";
          s.zIndex = it.orig.zIndex || "";
          s.transform = it.orig.transform || "";
          s.display = it.orig.display || "";
        } catch (e) {}
      }

      // 8) Restore site JS handlers
      restoreSiteScrollJS();

      // 9) Load all captures as images
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

      // 10) PNG first
      const { blob: pngBlob } = await stitchImages(images, "image/png");
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, "png");
        alert("Saved as PNG (under 19MB)");
        return;
      }

      // 11) WebP primary
      const { blob: webpPrimary } = await stitchImages(images, "image/webp", WEBP_QUALITY_PRIMARY);
      if (webpPrimary.size <= MAX_BYTES) {
        saveBlob(webpPrimary, "webp");
        alert("Saved as WebP (quality " + WEBP_QUALITY_PRIMARY + ")");
        return;
      }

      // 12) WebP fallback
      const { blob: webpFallback } = await stitchImages(images, "image/webp", WEBP_QUALITY_FALLBACK);
      if (webpFallback.size <= MAX_BYTES) {
        saveBlob(webpFallback, "webp");
        alert("Saved as WebP (quality " + WEBP_QUALITY_FALLBACK + ")");
        return;
      }

      // 13) Split into batches (try primary then fallback per batch)
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
            batches.push({ items: currentBatch.slice(), blobPrimary: blob });
          }
          currentBatch = [candidate];
          // If single candidate is already too large at primary, we'll push it and handle fallback later
          const { blob: singleTest } = await stitchImages(currentBatch, "image/webp", WEBP_QUALITY_PRIMARY);
          if (singleTest.size > MAX_BYTES) {
            batches.push({ items: currentBatch.slice(), blobPrimary: singleTest });
            currentBatch = [];
          }
        }
      }
      if (currentBatch.length > 0) {
        const { blob } = await stitchImages(currentBatch, "image/webp", WEBP_QUALITY_PRIMARY);
        batches.push({ items: currentBatch.slice(), blobPrimary: blob });
      }

      // 14) Save each batch
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        if (b.blobPrimary && b.blobPrimary.size <= MAX_BYTES) {
          saveBlob(b.blobPrimary, "webp", i + 1);
          continue;
        }
        const { blob: bf } = await stitchImages(b.items, "image/webp", WEBP_QUALITY_FALLBACK);
        if (bf.size <= MAX_BYTES) {
          saveBlob(bf, "webp", i + 1);
        } else {
          // last resort: save fallback even if > MAX_BYTES
          saveBlob(bf, "webp", i + 1);
          console.warn(`Saved batch ${i + 1} but it still exceeds ${MAX_BYTES} bytes.`);
        }
      }

      alert(`Saved as ${batches.length} WebP image(s) (attempted ${WEBP_QUALITY_PRIMARY} then ${WEBP_QUALITY_FALLBACK})`);
    } catch (err) {
      // attempt cleanup
      try { document.documentElement.style.zoom = originalZoom; } catch (e) {}
      try { scrollingEl.style.overflow = originalOverflow; } catch (e) {}
      try { scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: "instant" }); } catch (e) {}
      try {
        for (const it of styleCache) {
          const s = it.el.style;
          s.position = it.orig.position || "";
          s.top = it.orig.top || "";
          s.bottom = it.orig.bottom || "";
          s.zIndex = it.orig.zIndex || "";
          s.transform = it.orig.transform || "";
          s.display = it.orig.display || "";
        }
      } catch (e) {}
      try { restoreSiteScrollJS(); } catch (e) {}
      console.error(err);
      alert("Capture failed: " + (err && err.message ? err.message : err));
    }
  }

  // Helper: save blob
  function saveBlob(blob, ext, index = 0) {
    const base = new URL(location.href).hostname.replace(/\./g, "_");
    const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
    downloadBlob(blob, name);
  }
})();
