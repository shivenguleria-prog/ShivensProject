// contentScript.js
// Scroll + capture + adaptive format logic:
// - Save as PNG if total <= 19MB
// - Else try single WebP (q=0.97)
// - If WebP still >19MB, retry WebP (q=0.92)
// - If still >19MB, split into multiple WebPs (try 0.97 then 0.92 per batch)

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 19 * 1024 * 1024; // 19 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY_PRIMARY = 0.97; // primary webp quality
  const WEBP_QUALITY_FALLBACK = 0.92; // fallback webp quality if primary > MAX_BYTES
  const PNG_QUALITY = 0.92; // used only for canvas.toBlob if needed (PNG ignores quality but we keep param)
  const ZOOM_FACTOR = 0.8; // 80% zoom
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
      // Apply zoom so captures reflect the zoomed layout
      document.documentElement.style.zoom = String(ZOOM_FACTOR);
      await new Promise(r => setTimeout(r, 120)); // let layout settle

      // Measure after zoom applied
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

      // Capture each viewport position
      const capturedDataUrls = [];
      for (const y of positions) {
        scrollingEl.scrollTo({ top: y, left: 0, behavior: 'instant' });
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // restore scroll/overflow/fixed elements BEFORE stitching
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
      scrollingEl.style.overflow = originalOverflow;
      fixedCache.forEach(it => {
        it.el.style.visibility = it.orig.visibility || '';
        it.el.style.pointerEvents = it.orig.pointerEvents || '';
      });

      // restore zoom before DOM operations after captures
      document.documentElement.style.zoom = originalZoom;

      // Load images
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

      // 1) Try PNG full
      const { blob: pngBlob } = await stitchImages(images, 'image/png', PNG_QUALITY);
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, 'png');
        alert('Saved as PNG (under 19MB)');
        return;
      }

      // 2) Try full WebP at primary quality
      const { blob: webpPrimary } = await stitchImages(images, 'image/webp', WEBP_QUALITY_PRIMARY);
      if (webpPrimary.size <= MAX_BYTES) {
        saveBlob(webpPrimary, 'webp');
        alert('Saved as single WebP (quality ' + WEBP_QUALITY_PRIMARY + ')');
        return;
      }

      // 3) Try full WebP at fallback quality
      const { blob: webpFallback } = await stitchImages(images, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (webpFallback.size <= MAX_BYTES) {
        saveBlob(webpFallback, 'webp');
        alert('Saved as single WebP (quality ' + WEBP_QUALITY_FALLBACK + ')');
        return;
      }

      // 4) Need to split into batches — attempt to form batches using primary quality
      const batches = [];
      let currentBatch = [];

      for (let i = 0; i < images.length; i++) {
        const candidate = images[i];
        const tryBatch = currentBatch.concat([candidate]);
        const { blob: testBlob } = await stitchImages(tryBatch, 'image/webp', WEBP_QUALITY_PRIMARY);

        if (testBlob.size <= MAX_BYTES) {
          // fits at primary quality — accept it
          currentBatch = tryBatch;
        } else {
          // doesn't fit at primary quality
          if (currentBatch.length > 0) {
            // finalize previous batch
            const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
            batches.push({ blob, items: currentBatch.slice(), q: WEBP_QUALITY_PRIMARY });
          }
          // start new batch with candidate
          currentBatch = [candidate];

          // if single candidate is already > MAX_BYTES at primary, we still add it as single-item batch.
          // We'll attempt fallback quality later when saving.
          const { blob: singleTest } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
          if (singleTest.size > MAX_BYTES) {
            // still oversized at primary; continue and let fallback handle when saving
            // finalize this single-item batch now so we don't loop infinitely
            const { blob: singleBlobPrimary } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
            batches.push({ blob: singleBlobPrimary, items: currentBatch.slice(), q: WEBP_QUALITY_PRIMARY });
            currentBatch = [];
          }
        }
      }

      if (currentBatch.length > 0) {
        const { blob } = await stitchImages(currentBatch, 'image/webp', WEBP_QUALITY_PRIMARY);
        batches.push({ blob, items: currentBatch.slice(), q: WEBP_QUALITY_PRIMARY });
      }

      // Save each batch: try primary quality first, if too big then fallback quality
      for (let i = 0; i < batches.length; i++) {
        const b = batches[i];
        // If the blob we already computed at primary is <= MAX_BYTES, use it
        if (b.blob.size <= MAX_BYTES) {
          saveBlob(b.blob, 'webp', i + 1);
          continue;
        }
        // else try fallback
        const { blob: bf } = await stitchImages(b.items, 'image/webp', WEBP_QUALITY_FALLBACK);
        if (bf.size <= MAX_BYTES) {
          saveBlob(bf, 'webp', i + 1);
        } else {
          // as a last resort, save the fallback (even if > MAX_BYTES) but warn the user
          saveBlob(bf, 'webp', i + 1);
          console.warn(`Batch ${i + 1} still exceeds ${MAX_BYTES} bytes even at fallback quality (${WEBP_QUALITY_FALLBACK}). Saved anyway.`);
        }
      }

      alert(`Saved as ${batches.length} WebP image(s) (attempted quality ${WEBP_QUALITY_PRIMARY} then ${WEBP_QUALITY_FALLBACK})`);
    } catch (err) {
      // ensure cleanup on error
      try { document.documentElement.style.zoom = originalZoom; } catch (e) {}
      try { scrollingEl.style.overflow = originalOverflow; } catch (e) {}
      throw err;
    }
  }

  // save helper
  function saveBlob(blob, ext, index = 0) {
    const base = (new URL(location.href)).hostname.replace(/\./g, '_');
    const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
    downloadBlob(blob, name);
  }
})();
