// contentScript.js (Safer replacement)
// - Zoom-out scaling
// - PNG -> WebP(primary 0.97) -> WebP(fallback 0.92) -> split if >19MB
// - Detect & hide top headers/menus safely (no global API overrides)
// - Compute scroll positions after applying zoom
// - Reapply forced styles before each capture to counter dynamic scripts

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 19 * 1024 * 1024; // 19 MB
  const CAPTURE_DELAY_MS = 700; // slightly longer to allow lazy load
  const CAPTURE_POST_SCROLL_WAIT = 400; // additional wait after scroll
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY_PRIMARY = 0.97;
  const WEBP_QUALITY_FALLBACK = 0.92;
  const ZOOM_FACTOR = 0.8; // 80% zoom out
  const HEADER_SELECTORS = [
    'header', '[role="banner"]', '.header', '#header', '.site-header', '.topbar', '.navbar', '.masthead'
  ];
  // ------------------------

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => {
        console.error('Capture failed', e);
        alert('Capture failed: ' + (e && e.message ? e.message : e));
      });
    }
  });

  // ---------- SAFE CAPTURE (messages to background) ----------
  async function safeCapture() {
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) {
      await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS - since));
    }

    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'capture-visible' }, resolve);
      });
      lastCaptureTs = Date.now();

      if (res && res.success) return res.dataUrl;
      if (attempt === CAPTURE_MAX_RETRIES) {
        const errMsg = res?.error || 'Unknown capture error';
        throw new Error(`capture failed: ${errMsg}`);
      }
      const backoff = CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  // ---------- Utilities ----------
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(new Error('Image load failed: ' + e));
      img.src = dataUrl;
    });
  }

  function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
    return new Promise((resolve) => {
      canvas.toBlob(blob => resolve(blob), type, quality);
    });
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // ---------- Detect likely header elements by selectors and visual test ----------
  // Returns array of elements to hide (headers) and array of visually fixed elements.
  async function detectHeadersAndFixed() {
    // Gather candidates from common header selectors (fast)
    const headerCandidates = [];
    for (const sel of HEADER_SELECTORS) {
      document.querySelectorAll(sel).forEach(el => {
        if (el && el.offsetParent !== null) headerCandidates.push(el);
      });
    }

    // De-duplicate
    const headerSet = new Set(headerCandidates);

    // Also run a light visual scan to find elements that don't move on small scrolls (potentially fixed)
    // but keep this limited to elements near the top of viewport to avoid huge list
    const visuallyFixed = [];
    const smallScroll = 120;
    const toTest = Array.from(document.querySelectorAll('body *')).filter(el => {
      try {
        const r = el.getBoundingClientRect();
        // only test elements visible near top area and with size
        return r.width > 20 && r.height > 10 && r.top < window.innerHeight * 0.35;
      } catch (e) { return false; }
    });

    const before = new Map();
    toTest.forEach(el => before.set(el, el.getBoundingClientRect().top));
    window.scrollBy(0, smallScroll);
    await new Promise(r => setTimeout(r, 120));
    toTest.forEach(el => {
      const beforeTop = before.get(el);
      const afterTop = el.getBoundingClientRect().top;
      if (Math.abs(afterTop - beforeTop) < 1) {
        visuallyFixed.push(el);
      }
    });
    window.scrollBy(0, -smallScroll);
    await new Promise(r => setTimeout(r, 80));

    // Combine: headers (from selectors) + visuallyFixed
    const headers = Array.from(headerSet);
    const fixedUnique = visuallyFixed.filter(el => !headerSet.has(el) && !headers.includes(el));
    return { headers, visuallyFixed: fixedUnique };
  }

  // ---------- Main capture ----------
  async function startCapture() {
    if (!document.body) throw new Error('No document body found');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    const originalZoom = document.documentElement.style.zoom || '';

    // We'll track elements and their inline style backups to restore later
    const styleBackups = [];

    try {
      // 1) Apply zoom BEFORE measuring
      document.documentElement.style.zoom = String(ZOOM_FACTOR);
      await new Promise(r => setTimeout(r, 150)); // allow reflow

      // 2) Detect headers and fixed elements (safe detection)
      const { headers, visuallyFixed } = await detectHeadersAndFixed();

      // 3) Backup inline styles and hide headers (display:none) and force visuallyFixed to static
      const toModify = [];
      headers.forEach(el => {
        try {
          toModify.push({ el, mode: 'hide' });
        } catch (e) {}
      });
      visuallyFixed.forEach(el => {
        try {
          toModify.push({ el, mode: 'static' });
        } catch (e) {}
      });

      for (const it of toModify) {
        const el = it.el;
        const backup = {
          el,
          inline: {
            position: el.style.position,
            top: el.style.top,
            bottom: el.style.bottom,
            zIndex: el.style.zIndex,
            transform: el.style.transform,
            display: el.style.display
          },
          mode: it.mode
        };
        styleBackups.push(backup);

        if (it.mode === 'hide') {
          // hide the header/menu during capture
          el.style.setProperty('display', 'none', 'important');
        } else {
          // force it into normal flow
          el.style.setProperty('position', 'static', 'important');
          el.style.setProperty('top', 'auto', 'important');
          el.style.setProperty('bottom', 'auto', 'important');
          el.style.setProperty('z-index', 'auto', 'important');
          el.style.setProperty('transform', 'none', 'important');
          // if it's hidden for some reason, make sure it's visible
          if (getComputedStyle(el).display === 'none') {
            el.style.setProperty('display', 'block', 'important');
          }
        }
      }

      // 4) Measure after zoom & adjustments
      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const viewportHeight = window.innerHeight;

      scrollingEl.style.overflow = 'hidden';

      // 5) Compute scroll positions (no overlap)
      const positions = [];
      let y = 0;
      while (y < totalHeight - viewportHeight) {
        positions.push(Math.round(y));
        y += viewportHeight;
      }
      positions.push(Math.max(0, totalHeight - viewportHeight));

      // 6) Capture loop: reapply forced styles before each capture as a safety and wait for lazy loads
      const capturedDataUrls = [];
      for (const pos of positions) {
        scrollingEl.scrollTo({ top: pos, left: 0, behavior: 'instant' });
        // allow JS-based lazy loaders to run and images to fetch
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
        // extra short wait for images after scroll
        await new Promise(r => setTimeout(r, CAPTURE_POST_SCROLL_WAIT));

        // re-apply forced styles before taking snapshot (defensive)
        for (const b of styleBackups) {
          try {
            if (b.mode === 'hide') {
              b.el.style.setProperty('display', 'none', 'important');
            } else {
              b.el.style.setProperty('position', 'static', 'important');
              b.el.style.setProperty('transform', 'none', 'important');
              b.el.style.setProperty('top', 'auto', 'important');
              b.el.style.setProperty('bottom', 'auto', 'important');
              b.el.style.setProperty('z-index', 'auto', 'important');
            }
          } catch (e) {}
        }

        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // 7) Restore scroll/overflow and zoom BEFORE stitching
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
      scrollingEl.style.overflow = originalOverflow;
      document.documentElement.style.zoom = originalZoom;

      // 8) Restore inline styles we changed
      for (const b of styleBackups) {
        try {
          const s = b.el.style;
          s.position = b.inline.position || '';
          s.top = b.inline.top || '';
          s.bottom = b.inline.bottom || '';
          s.zIndex = b.inline.zIndex || '';
          s.transform = b.inline.transform || '';
          s.display = b.inline.display || '';
        } catch (e) {}
      }

      // 9) Load captures as images
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // Helper: stitch vertically
      async function stitchImages(imgItems, mime = 'image/png', quality = 0.92) {
        const w = Math.max(...imgItems.map(i => i.width));
        const h = imgItems.reduce((s, i) => s + i.height, 0);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        let yoffset = 0;
        for (const it of imgItems) {
          ctx.drawImage(it.img, 0, yoffset, it.width, it.height);
          yoffset += it.height;
        }
        const blob = await canvasToBlob(canvas, mime, quality);
        return { blob, width: w, height: h, mime };
      }

      // 10) Try PNG
      const { blob: pngBlob } = await stitchImages(images, 'image/png');
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, 'png');
        alert('Saved as PNG (under 19MB)');
        return;
      }

      // 11) Try WebP primary
      const { blob: webpPrimary } = await stitchImages(images, 'image/webp', WEBP_QUALITY_PRIMARY);
      if (webpPrimary.size <= MAX_BYTES) {
        saveBlob(webpPrimary, 'webp');
        alert('Saved as WebP (quality ' + WEBP_QUALITY_PRIMARY + ')');
        return;
      }

      // 12) Try WebP fallback
      const { blob: webpFallback } = await stitchImages(images, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (webpFallback.size <= MAX_BYTES) {
        saveBlob(webpFallback, 'webp');
        alert('Saved as WebP (quality ' + WEBP_QUALITY_FALLBACK + ')');
        return;
      }

      // 13) Split into batches (try primary then fallback per batch)
      const batches = [];
      let currentBatch = [];
      for (let i = 0; i < images.length; i++) {
        const candidate = images[i];
        const tryBatch = currentBatch.concat([candidate]);
        const { blob: testBlob } = await stitchImages(tryBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
        if (testBlob.size <= MAX_BYTES) {
          currentBatch = tryBatch;
        } else {
          if (currentBatch.length > 0) {
            const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
            batches.push({ items: currentBatch.slice(), blobPrimary: blob });
          }
          currentBatch = [candidate];
          const { blob: singleTest } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
          if (singleTest.size > MAX_BYTES) {
            // push as single batch to handle fallback later
            batches.push({ items: currentBatch.slice(), blobPrimary: singleTest });
            currentBatch = [];
          }
        }
      }
      if (currentBatch.length > 0) {
        const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
        batches.push({ items: currentBatch.slice(), blobPrimary: blob });
      }

      // 14) Save batches
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        if (b.blobPrimary && b.blobPrimary.size <= MAX_BYTES) {
          saveBlob(b.blobPrimary, 'webp', i + 1);
          continue;
        }
        const { blob: bf } = await stitchImages(b.items, 'image/webp', WEBP_QUALITY_FALLBACK);
        if (bf.size <= MAX_BYTES) {
          saveBlob(bf, 'webp', i + 1);
        } else {
          saveBlob(bf, 'webp', i + 1); // last resort: save anyway
          console.warn(`Saved batch ${i + 1} but it still exceeds ${MAX_BYTES} bytes.`);
        }
      }

      alert(`Saved as ${batches.length} WebP image(s) (attempted ${WEBP_QUALITY_PRIMARY} then ${WEBP_QUALITY_FALLBACK})`);
    } catch (err) {
      // try best-effort restore
      try { document.documentElement.style.zoom = originalZoom; } catch (e) {}
      try { scrollingEl.style.overflow = originalOverflow; } catch (e) {}
      try { scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' }); } catch (e) {}
      for (const b of styleBackups) {
        try {
          const s = b.el.style;
          s.position = b.inline.position || '';
          s.top = b.inline.top || '';
          s.bottom = b.inline.bottom || '';
          s.zIndex = b.inline.zIndex || '';
          s.transform = b.inline.transform || '';
          s.display = b.inline.display || '';
        } catch (e) {}
      }
      console.error('capture error', err);
      alert('Capture failed: ' + (err && err.message ? err.message : err));
    }
  }

  // Helper saving function
  function saveBlob(blob, ext, index = 0) {
    const base = new URL(location.href).hostname.replace(/\./g, '_');
    const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
    downloadBlob(blob, name);
  }
})();
