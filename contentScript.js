// contentScript.js
// Scroll + capture + adaptive format logic:
// - Save as PNG if total <= 19MB
// - Else try single WebP (primary q=0.97)
// - If primary WebP still >19MB, try fallback WebP (q=0.92)
// - If fallback still >19MB, split into multiple WebPs (q=0.92), each ≤19MB

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 19 * 1024 * 1024; // 19 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY_PRIMARY = 0.97; // try this first
  const WEBP_QUALITY_FALLBACK = 0.92; // fallback for single or split batches
  const ZOOM_FACTOR = 0.8; // <-- set desired zoom here (0.8 = 80%)
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
      img.onerror = reject;
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

    // apply zoom BEFORE measuring/layout so captures reflect zoomed view
    try {
      document.documentElement.style.zoom = String(ZOOM_FACTOR);

      // let layout reflow after zoom
      await new Promise(r => setTimeout(r, 120));

      const totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const viewportHeight = window.innerHeight;

      // Hide fixed/sticky elements
      const fixedEls = Array.from(document.querySelectorAll('*')).filter(el => {
        const s = getComputedStyle(el);
        return (s.position === 'fixed' || s.position === 'sticky') &&
               s.display !== 'none' &&
               el.offsetParent !== null;
      });
      const fixedCache = fixedEls.map(el => ({
        el,
        orig: { visibility: el.style.visibility, pointerEvents: el.style.pointerEvents }
      }));
      fixedEls.forEach(el => { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; });

      scrollingEl.style.overflow = 'hidden';

      const positions = [];
      for (let y = 0; y < totalHeight; y += viewportHeight) {
        positions.push(Math.min(y, totalHeight - viewportHeight));
        if (y + viewportHeight >= totalHeight) break;
      }

      const capturedDataUrls = [];
      for (const y of positions) {
        scrollingEl.scrollTo({ top: y, left: 0, behavior: 'instant' });
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // restore scroll/overflow/fixed elements BEFORE stitching so DOM returns to normal
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
      scrollingEl.style.overflow = originalOverflow;
      fixedCache.forEach(it => {
        it.el.style.visibility = it.orig.visibility || '';
        it.el.style.pointerEvents = it.orig.pointerEvents || '';
      });

      // restore zoom now (important before further DOM operations)
      document.documentElement.style.zoom = originalZoom;

      // Load all captures as images
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // helper: stitch vertically
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

      // 1️⃣ Try to make one big PNG
      const { blob: pngBlob } = await stitchImages(images, 'image/png');
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, 'png');
        alert('Saved as PNG (under 19MB)');
        return;
      }

      // 2️⃣ Try one WebP at PRIMARY quality first
      const { blob: webpPrimaryBlob } = await stitchImages(images, 'image/webp', WEBP_QUALITY_PRIMARY);
      if (webpPrimaryBlob.size <= MAX_BYTES) {
        saveBlob(webpPrimaryBlob, 'webp');
        alert(`Saved as single WebP (quality ${WEBP_QUALITY_PRIMARY})`);
        return;
      }

      // 3️⃣ Try one WebP at FALLBACK quality
      const { blob: webpFallbackBlob } = await stitchImages(images, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (webpFallbackBlob.size <= MAX_BYTES) {
        saveBlob(webpFallbackBlob, 'webp');
        alert(`Saved as single WebP (quality ${WEBP_QUALITY_FALLBACK})`);
        return;
      }

      // 4️⃣ Split into smaller WebPs ≤19MB using fallback quality
      const batches = [];
      let currentBatch = [];
      for (let i = 0; i < images.length; i++) {
        const candidate = images[i];
        const tryBatch = currentBatch.concat([candidate]);
        const { blob: testBlob } = await stitchImages(tryBatch, 'image/webp', WEBP_QUALITY_FALLBACK);
        if (testBlob.size <= MAX_BYTES) {
          currentBatch = tryBatch;
        } else {
          // finalize previous
          if (currentBatch.length > 0) {
            const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_FALLBACK);
            batches.push(blob);
          }
          currentBatch = [candidate];
        }
      }
      if (currentBatch.length > 0) {
        const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_FALLBACK);
        batches.push(blob);
      }

      for (let i = 0; i < batches.length; i++) {
        saveBlob(batches[i], 'webp', i + 1);
      }

      alert(`Saved as ${batches.length} WebP image(s) (each ≤19MB, quality ${WEBP_QUALITY_FALLBACK})`);

      // save helper
      function saveBlob(blob, ext, index = 0) {
        const base = (new URL(location.href)).hostname.replace(/\./g, '_');
        const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
        downloadBlob(blob, name);
      }
    } catch (err) {
      // ensure cleanup on error
      try { document.documentElement.style.zoom = originalZoom; } catch(e) {}
      try { scrollingEl.style.overflow = originalOverflow; } catch(e) {}
      throw err;
    }
  }
})();
