// contentScript.js
// Full-page scroll capture + adaptive format (PNG → WebP) + zoom out + hide fixed/sticky elements.

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 19 * 1024 * 1024; // 19 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY_PRIMARY = 0.97;
  const WEBP_QUALITY_FALLBACK = 0.92;
  const ZOOM_FACTOR = 0.8; // 80% zoom
  const PNG_QUALITY = 0.92; // (PNG ignores quality, but included for API consistency)
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

  // ---------------- SAFE CAPTURE ----------------
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

  // --------------- UTILITIES -------------------
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

  // ---------------- MAIN ----------------
  async function startCapture() {
    if (!document.body) throw new Error('No document body found');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    const originalZoom = document.documentElement.style.zoom || '';

    try {
      // Apply zoom BEFORE measuring to capture zoomed view
      document.documentElement.style.zoom = String(ZOOM_FACTOR);
      await new Promise(r => setTimeout(r, 120)); // allow reflow after zoom

      // Measure after zoom applied
      const totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const viewportHeight = window.innerHeight;

      // ---- Hide fixed/sticky elements (menus, headers, etc.) ----
      const fixedEls = Array.from(document.querySelectorAll('*')).filter(el => {
        const s = getComputedStyle(el);
        return (s.position === 'fixed' || s.position === 'sticky') &&
               s.display !== 'none' &&
               el.offsetParent !== null &&
               el.offsetHeight > 0 &&
               el.offsetWidth > 0;
      });

      const fixedCache = fixedEls.map(el => ({
        el,
        orig: { visibility: el.style.visibility, pointerEvents: el.style.pointerEvents }
      }));
      fixedEls.forEach(el => {
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
      });

      scrollingEl.style.overflow = 'hidden';

      // ---- Compute scroll positions precisely after zoom ----
      const positions = [];
      let y = 0;
      while (y < totalHeight - viewportHeight) {
        positions.push(Math.round(y));
        y += viewportHeight;
      }
      positions.push(totalHeight - viewportHeight); // final scroll exactly to bottom

      // ---- Capture each viewport ----
      const capturedDataUrls = [];
      for (const pos of positions) {
        scrollingEl.scrollTo({ top: pos, left: 0, behavior: 'instant' });
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS)); // wait for layout settle
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // ---- Restore DOM state ----
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
      scrollingEl.style.overflow = originalOverflow;
      document.documentElement.style.zoom = originalZoom;

      fixedCache.forEach(it => {
        it.el.style.visibility = it.orig.visibility || '';
        it.el.style.pointerEvents = it.orig.pointerEvents || '';
      });

      // ---- Load captured images ----
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // ---- Stitch images vertically ----
      async function stitchImages(imgItems, mime = 'image/png', quality = 0.92) {
        const w = Math.max(...imgItems.map(i => i.width));
        const h = imgItems.reduce((s, i) => s + i.height, 0);
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        let y = 0;
        for (const it of imgItems) {
          ctx.drawImage(it.img, 0, y, it.width, it.height);
          y += it.height;
        }
        const blob = await canvasToBlob(canvas, mime, quality);
        return { blob, width: w, height: h, mime };
      }

      // ---- Step 1: PNG ----
      const { blob: pngBlob } = await stitchImages(images, 'image/png', PNG_QUALITY);
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, 'png');
        alert('Saved as PNG (under 19MB)');
        return;
      }

      // ---- Step 2: WebP @0.97 ----
      const { blob: webpPrimary } = await stitchImages(images, 'image/webp', WEBP_QUALITY_PRIMARY);
      if (webpPrimary.size <= MAX_BYTES) {
        saveBlob(webpPrimary, 'webp');
        alert('Saved as WebP (quality 0.97)');
        return;
      }

      // ---- Step 3: WebP @0.92 ----
      const { blob: webpFallback } = await stitchImages(images, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (webpFallback.size <= MAX_BYTES) {
        saveBlob(webpFallback, 'webp');
        alert('Saved as WebP (quality 0.92)');
        return;
      }

      // ---- Step 4: Split into batches ----
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
            batches.push({ blob, items: currentBatch.slice(), q: WEBP_QUALITY_PRIMARY });
          }
          currentBatch = [candidate];
        }
      }

      if (currentBatch.length > 0) {
        const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
        batches.push({ blob, items: currentBatch.slice(), q: WEBP_QUALITY_PRIMARY });
      }

      // Save each batch: fallback to lower quality if needed
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        if (b.blob.size <= MAX_BYTES) {
          saveBlob(b.blob, 'webp', i + 1);
          continue;
        }
        const { blob: fallbackBlob } = await stitchImages(b.items, 'image/webp', WEBP_QUALITY_FALLBACK);
        saveBlob(fallbackBlob, 'webp', i + 1);
      }

      alert(`Saved as ${batches.length} WebP image(s), split as needed (0.97 → 0.92 quality)`);

    } catch (err) {
      // ensure cleanup on error
      try { document.documentElement.style.zoom = originalZoom; } catch {}
      try { scrollingEl.style.overflow = originalOverflow; } catch {}
      console.error('Error during capture:', err);
      alert('Error: ' + err.message);
    }
  }

  // ---- Save helper ----
  function saveBlob(blob, ext, index = 0) {
    const base = (new URL(location.href)).hostname.replace(/\./g, '_');
    const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
    downloadBlob(blob, name);
  }
})();
