// contentScript.js
// Robust adaptive capture: detects scroll container, retries with progressive downscale
// until stitched pixel height <= SAFE_CANVAS_HEIGHT.
// Also keeps PNG->WebP->split logic (19MB) from previous version.

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // --------- config ----------
  const MAX_BYTES = 19 * 1024 * 1024;
  const SAFE_CANVAS_HEIGHT = 30000; // target safe max (px) - adjust down if issues
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY = 0.92;
  const MIN_ZOOM = 0.12; // do not shrink below this
  const ZOOM_RETRY_FACTOR = 0.88; // reduce zoom by ~12% each retry
  // ---------------------------

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => {
        console.error('Capture failed', e);
        alert('Capture failed: ' + (e && e.message ? e.message : e));
      });
    }
  });

  // ---------- helpers ----------
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function safeCapture() {
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) await wait(CAPTURE_DELAY_MS - since);

    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise(resolve => chrome.runtime.sendMessage({ action: 'capture-visible' }, resp => resolve(resp)));
      lastCaptureTs = Date.now();
      if (res && res.success) return res.dataUrl;
      if (attempt === CAPTURE_MAX_RETRIES) {
        const err = res?.error || 'Unknown capture error';
        throw new Error('capture failed: ' + err);
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
      img.onerror = reject;
      img.src = dataUrl;
    });
  }

  function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
    return new Promise(resolve => canvas.toBlob(b => resolve(b), type, quality));
  }

  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  // detect the main scroll container (element with the largest scrollHeight)
  function detectScrollContainer() {
    let best = document.scrollingElement || document.documentElement;
    let maxScroll = (best.scrollHeight || 0);
    // check common scrollable elements
    const all = Array.from(document.querySelectorAll('body, html, div, main, section, article'));
    for (const el of all) {
      try {
        const sh = el.scrollHeight || 0;
        if (sh > maxScroll) {
          maxScroll = sh;
          best = el;
        }
      } catch (e) { /* ignore */ }
    }
    return best;
  }

  // attempt capture at a given CSS zoom. returns { images: [{img,width,height}], totalPixelHeight }
  async function attemptCaptureAtZoom(zoom) {
    // apply zoom
    const origZoom = document.documentElement.style.zoom || '';
    document.documentElement.style.zoom = String(zoom);
    // wait for layout and paint
    await wait(220);
    // choose scroll container AFTER zoom & layout
    const scrollEl = detectScrollContainer();
    const originalScroll = scrollEl.scrollTop;
    const originalOverflow = scrollEl.style.overflow;
    scrollEl.style.overflow = 'hidden';

    const totalCssHeight = Math.max(scrollEl.scrollHeight || document.documentElement.scrollHeight, document.body.scrollHeight || 0);
    const viewportCssH = window.innerHeight;

    // build positions in CSS pixels
    const positions = [];
    for (let y = 0; y < totalCssHeight; y += viewportCssH) {
      positions.push(Math.min(y, totalCssHeight - viewportCssH));
      if (y + viewportCssH >= totalCssHeight) break;
    }

    const dataUrls = [];
    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      // scroll the detected container
      scrollEl.scrollTo({ top: y, left: 0, behavior: 'instant' });
      // wait paint & lazy load
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 420)));
      const dataUrl = await safeCapture();
      dataUrls.push(dataUrl);
    }

    // restore scroll & overflow but keep zoom applied until caller finishes
    scrollEl.scrollTo({ top: originalScroll, left: 0, behavior: 'instant' });
    scrollEl.style.overflow = originalOverflow;
    // load images to get actual pixel heights returned by captureVisibleTab
    const images = [];
    for (const d of dataUrls) {
      const img = await loadImage(d);
      images.push({ img, width: img.width, height: img.height });
    }

    // compute total pixel height
    const totalPixelHeight = images.reduce((s, it) => s + it.height, 0);
    // restore original zoom now (caller may want to)
    document.documentElement.style.zoom = origZoom || '';
    return { images, totalPixelHeight, positionsCount: positions.length };
  }

  // stitch images into single canvas (or tiled if too tall) and return array of { blob, mime }
  async function stitchAndExportImages(images, preferQuality = WEBP_QUALITY) {
    const width = Math.max(...images.map(i => i.width));
    const totalHeight = images.reduce((s, it) => s + it.height, 0);

    // if safe -> single canvas
    if (totalHeight <= SAFE_CANVAS_HEIGHT) {
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = totalHeight;
      const ctx = canvas.getContext('2d');
      let y = 0;
      for (const it of images) {
        ctx.drawImage(it.img, 0, y, it.width, it.height);
        y += it.height;
      }
      // prefer PNG if small enough
      const png = await canvasToBlob(canvas, 'image/png');
      if (png.size <= MAX_BYTES) return [{ blob: png, mime: 'image/png' }];
      const webp = await canvasToBlob(canvas, 'image/webp', preferQuality);
      if (webp.size <= MAX_BYTES) return [{ blob: webp, mime: 'image/webp' }];
      // fallback: return webp (may be > MAX_BYTES) and caller can split
      return [{ blob: webp, mime: 'image/webp' }];
    }

    // tiled fallback (split into vertical tiles each <= SAFE_CANVAS_HEIGHT)
    const parts = [];
    let cursor = 0;
    while (cursor < totalHeight) {
      const tileH = Math.min(SAFE_CANVAS_HEIGHT, totalHeight - cursor);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = tileH;
      const ctx = canvas.getContext('2d');

      // draw the correct slices of images into this tile
      let yInTile = 0;
      let acc = 0;
      for (const it of images) {
        const imgTop = acc;
        const imgBottom = acc + it.height;
        acc += it.height;
        const tileTop = cursor;
        const tileBottom = cursor + tileH;
        const interTop = Math.max(tileTop, imgTop);
        const interBottom = Math.min(tileBottom, imgBottom);
        if (interBottom > interTop) {
          const srcY = interTop - imgTop;
          const drawH = interBottom - interTop;
          ctx.drawImage(it.img, 0, srcY, it.width, drawH, 0, yInTile, it.width, drawH);
          yInTile += drawH;
          if (yInTile >= tileH) break;
        }
      }
      const tileWebp = await canvasToBlob(canvas, 'image/webp', preferQuality);
      parts.push({ blob: tileWebp, mime: 'image/webp' });
      cursor += tileH;
    }
    return parts;
  }

  // if large single stitched blob > MAX_BYTES, split into size-limited WebPs (by chunking image array)
  async function splitIntoSizedWebPs(images, quality = WEBP_QUALITY) {
    const batches = [];
    let current = [];
    for (let i = 0; i < images.length; i++) {
      const candidate = images[i];
      const tryBatch = current.concat([candidate]);
      const parts = await stitchAndExportImages(tryBatch, quality);
      // compute combined size (sum of parts)
      const combined = parts.reduce((s, p) => s + (p.blob?.size || 0), 0);
      if (combined <= MAX_BYTES) {
        current = tryBatch;
      } else {
        if (current.length === 0) {
          // single candidate too big — downscale this image as a fallback
          const it = candidate;
          const tmp = document.createElement('canvas');
          tmp.width = Math.max(1, Math.floor(it.width / 2));
          tmp.height = Math.max(1, Math.floor(it.height / 2));
          const tctx = tmp.getContext('2d');
          tctx.drawImage(it.img, 0, 0, tmp.width, tmp.height);
          const scaled = await canvasToBlob(tmp, 'image/webp', Math.max(0.75, quality - 0.1));
          batches.push({ blob: scaled, mime: 'image/webp' });
        } else {
          // finalize current
          const finalParts = await stitchAndExportImages(current, quality);
          for (const p of finalParts) batches.push({ blob: p.blob, mime: p.mime });
          current = [candidate];
        }
      }
    }
    if (current.length > 0) {
      const finalParts = await stitchAndExportImages(current, WEBP_QUALITY);
      for (const p of finalParts) batches.push({ blob: p.blob, mime: p.mime });
    }
    return batches;
  }

  // ---------- main ----------
  async function startCapture() {
    if (!document.body) throw new Error('No document body');

    const scrollEl = detectScrollContainer();
    const originalOverflow = scrollEl.style.overflow;
    const originalScrollTop = scrollEl.scrollTop;
    const origZoom = document.documentElement.style.zoom || '';

    try {
      // compute initial heights and DPR
      let totalCssH = Math.max(scrollEl.scrollHeight || document.documentElement.scrollHeight, document.body.scrollHeight || 0);
      const dpr = window.devicePixelRatio || 1;
      console.log('[capture] initial totalCssH', totalCssH, 'dpr', dpr);

      // estimate pixel height of stitched image at zoom=1
      let estimatedPixelH = Math.round(totalCssH * dpr);
      console.log('[capture] estimatedPixelH (no zoom)', estimatedPixelH, 'SAFE limit', SAFE_CANVAS_HEIGHT);

      // if already safe, just capture at zoom=1
      let zoom = 1;
      if (estimatedPixelH <= SAFE_CANVAS_HEIGHT) {
        // single attempt at original zoom
        console.log('[capture] within safe canvas, capturing at zoom=1');
      } else {
        // compute initial zoom to try
        zoom = Math.max(MIN_ZOOM, SAFE_CANVAS_HEIGHT / estimatedPixelH);
        console.log('[capture] initial computed zoom', zoom);
      }

      // We'll attempt captures with progressive zoom reductions until stitched totalPixelHeight <= SAFE_CANVAS_HEIGHT
      let attempt = 0;
      let capturedImages = null;
      let lastPositionsCount = 0;

      while (true) {
        attempt++;
        console.log(`[capture] attempt ${attempt} with zoom ${zoom.toFixed(3)}`);
        const { images, totalPixelHeight, positionsCount } = await attemptCaptureAtZoom(zoom);
        console.log(`[capture] got images count ${images.length}, totalPixelHeight ${totalPixelHeight}, positions ${positionsCount}`);
        // If safe, keep these images and break
        if (totalPixelHeight <= SAFE_CANVAS_HEIGHT) {
          capturedImages = images;
          lastPositionsCount = positionsCount;
          console.log('[capture] totalPixelHeight is safe -> proceed stitching');
          break;
        }
        // else reduce zoom and retry (if possible)
        if (zoom <= MIN_ZOOM + 1e-6) {
          // we cannot reduce more; accept images and fall back to tiled stitching
          capturedImages = images;
          lastPositionsCount = positionsCount;
          console.warn('[capture] reached MIN_ZOOM but still too tall; will use tiled fallback');
          break;
        }
        // reduce zoom and retry
        zoom = Math.max(MIN_ZOOM, zoom * ZOOM_RETRY_FACTOR);
        console.log('[capture] reducing zoom to', zoom);
        // slight delay before retry
        await wait(120);
      }

      // Now we have capturedImages (array). Stitch & export using existing logic (PNG->WebP->split)
      const firstStitch = await stitchAndExportImages(capturedImages, WEBP_QUALITY);
      // if single small PNG returned:
      if (firstStitch.length === 1 && firstStitch[0].mime === 'image/png' && firstStitch[0].blob.size <= MAX_BYTES) {
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.png`;
        downloadBlob(firstStitch[0].blob, name);
        alert('Saved PNG (under limit).');
        return;
      }
      // try webp single
      if (firstStitch.length === 1 && firstStitch[0].mime.includes('webp') && firstStitch[0].blob.size <= MAX_BYTES) {
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.webp`;
        downloadBlob(firstStitch[0].blob, name);
        alert('Saved WebP (single file under limit).');
        return;
      }

      // else split into sized webps
      const parts = await splitIntoSizedWebPs(capturedImages, WEBP_QUALITY);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ext = (p.mime && p.mime.includes('webp')) ? 'webp' : 'png';
        const fname = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_part${i+1}.${ext}`;
        downloadBlob(p.blob, fname);
      }
      alert(`Saved ${parts.length} parts.`);

    } finally {
      // cleanup restore
      try { detectScrollContainer().style.overflow = originalOverflow; } catch(e) {}
      try { detectScrollContainer().scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' }); } catch(e) {}
      document.documentElement.style.zoom = origZoom || '';
    }
  }

})();
