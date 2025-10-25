// contentScript.js
// Adaptive full-page capture:
// - If stitched canvas would be <= SAFE_CANVAS_HEIGHT -> normal capture & stitch
// - Else -> apply client-side downscale (zoom), capture & stitch into single canvas
// - Finally: prefer PNG if <=19MB, else try WebP, else split into multiple WebPs <=19MB.
// - Uses safeCapture() to respect capture quotas and retries.

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---------------- CONFIG ----------------
  const MAX_BYTES = 19 * 1024 * 1024;       // 19 MB
  const SAFE_CANVAS_HEIGHT = 30000;         // safe canvas height threshold (px)
  const CAPTURE_DELAY_MS = 550;             // throttle between captures (ms)
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY = 0.92;
  const MIN_ZOOM = 0.15;                    // don't downscale below this fraction
  // ----------------------------------------

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => {
        console.error('Capture failed', e);
        alert('Capture failed: ' + (e && e.message ? e.message : e));
      });
    }
  });

  // ---------- Utilities ----------
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function safeCapture() {
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) {
      await wait(CAPTURE_DELAY_MS - since);
    }

    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'capture-visible' }, (resp) => resolve(resp));
      });
      lastCaptureTs = Date.now();

      if (res && res.success) return res.dataUrl;
      if (attempt === CAPTURE_MAX_RETRIES) {
        const errMsg = res?.error || 'Unknown capture error';
        throw new Error(`capture failed: ${errMsg}`);
      }
      const backoff = CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await wait(backoff);
    }
    throw new Error('capture failed unexpectedly');
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
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
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // Stitch images vertically into one or multiple canvas parts.
  // Returns array of { blob, width, height, mime } (usually one element unless tiling fallback occurs).
  async function stitchAndExport(images, preferMime = 'image/png', preferQuality = 0.92, maxCanvasHeight = SAFE_CANVAS_HEIGHT) {
    // compute total dims
    const width = Math.max(...images.map(i => i.width));
    const totalHeight = images.reduce((s, it) => s + it.height, 0);

    // if totalHeight small enough -> single canvas
    if (totalHeight <= maxCanvasHeight) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');

      let y = 0;
      for (const it of images) {
        ctx.drawImage(it.img, 0, y, it.width, it.height);
        y += it.height;
      }

      // Try PNG first if requested
      const pngBlob = await canvasToBlob(canvas, 'image/png');
      if (pngBlob.size <= MAX_BYTES && preferMime === 'image/png') {
        return [{ blob: pngBlob, width: canvas.width, height: canvas.height, mime: 'image/png' }];
      }

      // Otherwise try WebP
      const webpBlob = await canvasToBlob(canvas, 'image/webp', preferQuality);
      if (webpBlob.size <= MAX_BYTES) {
        return [{ blob: webpBlob, width: canvas.width, height: canvas.height, mime: 'image/webp' }];
      }

      // If PNG was under limit and preferred, keep PNG; else if WebP smaller, keep it; else return both candidates and caller decides
      return [{ blob: webpBlob, width: canvas.width, height: canvas.height, mime: 'image/webp' }];
    }

    // If too tall, fallback to tiled stitching (split vertically into safe tiles)
    const parts = [];
    let cursor = 0;
    while (cursor < totalHeight) {
      const tileHeight = Math.min(maxCanvasHeight, totalHeight - cursor);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = tileHeight;
      const ctx = canvas.getContext('2d');

      // draw appropriate portions of images into this tile
      let yInTile = 0;
      let remaining = tileHeight;
      // iterate through images tracking which portion belongs in this tile
      let acc = 0; // accumulated height from start
      for (const it of images) {
        const imgTop = acc;
        const imgBottom = acc + it.height;
        acc += it.height;

        // if this image intersects current tile (cursor .. cursor+tileHeight)
        const tileTop = cursor;
        const tileBottom = cursor + tileHeight;
        const interTop = Math.max(tileTop, imgTop);
        const interBottom = Math.min(tileBottom, imgBottom);
        if (interBottom > interTop) {
          const srcY = interTop - imgTop;                // y inside source image
          const drawH = interBottom - interTop;
          ctx.drawImage(it.img, 0, srcY, it.width, drawH, 0, yInTile, it.width, drawH);
          yInTile += drawH;
          remaining -= drawH;
          if (remaining <= 0) break;
        }
      }

      // export this tile (try webp first to reduce size)
      const tileWebp = await canvasToBlob(canvas, 'image/webp', preferQuality);
      parts.push({ blob: tileWebp, width: canvas.width, height: canvas.height, mime: 'image/webp' });
      cursor += tileHeight;
    }

    return parts;
  }

  // If a single-stitch is > MAX_BYTES (rare), split images into multiple batches where each batch's stitched blob <= MAX_BYTES
  async function splitIntoSizedWebPs(images, quality = WEBP_QUALITY) {
    const batches = [];
    let current = [];

    for (let i = 0; i < images.length; i++) {
      const candidate = images[i];
      const tryBatch = current.concat([candidate]);
      // quick test stitch
      const res = await stitchAndExport(tryBatch, 'image/webp', quality, SAFE_CANVAS_HEIGHT);
      // stitchAndExport returns array of parts; if it returns >1 part then the tryBatch is too tall; treat its combined blob sizes
      const combinedSize = res.reduce((s, p) => s + (p.blob?.size || 0), 0);
      if (combinedSize <= MAX_BYTES) {
        current = tryBatch;
      } else {
        if (current.length === 0) {
          // single candidate too big: attempt downscale (50%) on this single image
          const it = candidate;
          const tmp = document.createElement('canvas');
          tmp.width = Math.max(1, Math.floor(it.width / 2));
          tmp.height = Math.max(1, Math.floor(it.height / 2));
          const tctx = tmp.getContext('2d');
          tctx.drawImage(it.img, 0, 0, tmp.width, tmp.height);
          const scaledBlob = await canvasToBlob(tmp, 'image/webp', Math.max(0.75, quality - 0.1));
          batches.push({ blob: scaledBlob, mime: 'image/webp' });
        } else {
          // finalize current
          const finalParts = await stitchAndExport(current, 'image/webp', quality, SAFE_CANVAS_HEIGHT);
          // finalParts may be multiple tiles; push each (but ensure each <= MAX_BYTES; if not, still push)
          for (const p of finalParts) batches.push({ blob: p.blob, mime: p.mime });
          current = [candidate];
        }
      }
    }

    if (current.length > 0) {
      const finalParts = await stitchAndExport(current, 'image/webp', quality, SAFE_CANVAS_HEIGHT);
      for (const p of finalParts) batches.push({ blob: p.blob, mime: p.mime });
    }

    return batches;
  }

  // ---------- Main flow ----------
  async function startCapture() {
    if (!document.body) throw new Error('No document body');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    const origZoom = document.documentElement.style.zoom || '';

    // initial page metrics (CSS pixels)
    let totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    let totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Hide fixed/sticky elements to avoid duplicates
    const fixedEls = Array.from(document.querySelectorAll('*')).filter(el => {
      const s = getComputedStyle(el);
      return (s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none' && el.offsetParent !== null;
    });
    const fixedCache = fixedEls.map(el => ({ el, orig: { visibility: el.style.visibility, pointerEvents: el.style.pointerEvents } }));
    fixedEls.forEach(el => { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; });

    try {
      // Decide whether full stitched height would exceed safe canvas limit (in device pixels).
      // Because captureVisibleTab returns images in device pixels, we calculate devicePixelHeight estimate:
      const dpr = window.devicePixelRatio || 1;
      const estimatedPixelHeight = Math.round(totalHeight * dpr);

      // If estimatedPixelHeight <= SAFE_CANVAS_HEIGHT -> proceed normal, else apply downscale
      let zoomApplied = 1;
      if (estimatedPixelHeight > SAFE_CANVAS_HEIGHT) {
        // compute zoom factor to bring pixel height <= SAFE_CANVAS_HEIGHT
        zoomApplied = SAFE_CANVAS_HEIGHT / estimatedPixelHeight;
        zoomApplied = Math.max(MIN_ZOOM, zoomApplied); // clamp
        // apply zoom by CSS (affects layout and rendering size)
        document.documentElement.style.zoom = String(zoomApplied);
        // allow layout to stabilize
        await wait(200);
        // recompute metrics after zoom
        totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
        totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      }

      // Build capture positions (use current viewport)
      const positions = [];
      for (let y = 0; y < totalHeight; y += window.innerHeight) {
        positions.push(Math.min(y, totalHeight - window.innerHeight));
        if (y + window.innerHeight >= totalHeight) break;
      }

      // Capture tiles
      const capturedDataUrls = [];
      for (let i = 0; i < positions.length; i++) {
        const y = positions[i];
        scrollingEl.scrollTo({ top: y, left: 0, behavior: 'instant' });
        // wait for paint & lazy load
        await wait(CAPTURE_DELAY_MS);
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // Restore page scroll & overflow (keep zoom applied until we finish stitching if needed)
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
      scrollingEl.style.overflow = originalOverflow;
      fixedCache.forEach(item => {
        item.el.style.visibility = item.orig.visibility || '';
        item.el.style.pointerEvents = item.orig.pointerEvents || '';
      });

      // Load images (these are dataURLs with device pixels)
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // Try to stitch into single canvas (should succeed if zoomApplied reduced height)
      const singleAttempt = await stitchAndExport(images, 'image/png', 0.92, SAFE_CANVAS_HEIGHT);
      // stitchAndExport returns array (single or tiled parts). If one part => we can evaluate its size
      if (singleAttempt.length === 1 && singleAttempt[0].mime === 'image/png' && singleAttempt[0].blob.size <= MAX_BYTES) {
        // Good: PNG under limit
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.png`;
        downloadBlob(singleAttempt[0].blob, name);
        alert('Saved as PNG (under size limit).');
      } else {
        // Not PNG under limit. Try WebP single attempt using same images (higher compression)
        const webpAttempt = await stitchAndExport(images, 'image/webp', WEBP_QUALITY, SAFE_CANVAS_HEIGHT);
        // If webpAttempt produced multiple tiles (tiled fallback) or single but >MAX_BYTES -> split into sized webps
        if (webpAttempt.length === 1 && webpAttempt[0].blob.size <= MAX_BYTES) {
          const ext = webpAttempt[0].mime.includes('webp') ? 'webp' : 'png';
          const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.${ext}`;
          downloadBlob(webpAttempt[0].blob, name);
          alert('Saved as single WebP (PNG was too big).');
        } else {
          // Need to split into sized webp parts
          const parts = await splitIntoSizedWebPs(images, WEBP_QUALITY);
          for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            const ext = (p.mime && p.mime.includes('webp')) ? 'webp' : 'png';
            const fname = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_part${i+1}.${ext}`;
            downloadBlob(p.blob, fname);
          }
          alert(`Saved as ${parts.length} WebP part(s).`);
        }
      }
    } finally {
      // Always restore zoom to original
      document.documentElement.style.zoom = origZoom || '';
    }
  }

})();

