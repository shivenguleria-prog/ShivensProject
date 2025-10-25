// contentScript.js
// Pre-scroll-first capture script:
// - Pre-scroll to bottom to allow lazy-load and compute stable scrollHeight & positions
// - Then capture each collected position via safeCapture()
// - Stitch/export logic as before (PNG -> WebP -> split if needed)

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---------- CONFIG ----------
  const MAX_BYTES = 19 * 1024 * 1024;   // 19 MB per output file
  const CAPTURE_DELAY_MS = 550;         // throttle between captures (ms)
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY = 0.92;
  const SAFE_CANVAS_HEIGHT = 30000;     // used by stitcher if needed
  // ----------------------------

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(err => {
        console.error('Capture failed', err);
        alert('Capture failed: ' + (err && err.message ? err.message : err));
      });
    }
  });

  // --------- Utilities ----------
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
      img.onerror = (e) => reject(e);
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

  // Find the element that is the main scroll container (largest scrollHeight)
  function detectScrollContainer() {
    let best = document.scrollingElement || document.documentElement;
    let maxScroll = best ? (best.scrollHeight || 0) : 0;

    // check some common elements and all divs to be safer
    const candidates = Array.from(document.querySelectorAll('body, html, div, main, section, article'));
    for (const el of candidates) {
      try {
        const sh = el.scrollHeight || 0;
        if (sh > maxScroll) {
          maxScroll = sh;
          best = el;
        }
      } catch (e) {
        // ignore cross-origin or other issues
      }
    }
    return best;
  }

  // Pre-scroll the container from top to bottom to allow lazy-loads and compute stable scrollHeight.
  // Returns final scrollHeight (CSS px) and captured positions array (CSS y offsets).
  // Options:
  //   stepPx: how many CSS pixels to scroll each step (default = viewport height)
  //   stabilizeRounds: how many consecutive checks of unchanged scrollHeight to consider stable
  //   waitPerStepMs: wait after each scroll to allow loading/paint
  async function preScrollAndStabilize(scrollEl, { stepPx = null, stabilizeRounds = 2, waitPerStepMs = 500 } = {}) {
    const origScrollTop = scrollEl.scrollTop;
    const origOverflow = scrollEl.style.overflow;
    scrollEl.style.overflow = 'hidden'; // prevent extra UI changes during pre-scroll

    // compute step = viewport height CSS px if not provided
    const viewportH = window.innerHeight;
    if (!stepPx) stepPx = viewportH;

    // start from top
    try {
      scrollEl.scrollTo({ top: 0, left: 0, behavior: 'instant' });
      await wait(120);
    } catch (e) {}

    // iterative prescroll: walk to bottom, capturing current scrollHeight
    let lastHeight = Math.max(scrollEl.scrollHeight || 0, document.documentElement.scrollHeight || 0);
    let stableCount = 0;
    let y = 0;

    // first pass: scroll to bottom in steps
    while (y < lastHeight - 1) {
      y = Math.min(y + stepPx, lastHeight - viewportH);
      try {
        scrollEl.scrollTo({ top: y, left: 0, behavior: 'instant' });
      } catch (e) {}
      // wait paint & lazy-load
      await wait(waitPerStepMs);

      // re-evaluate scrollHeight (page may have injected content)
      const currentHeight = Math.max(scrollEl.scrollHeight || 0, document.documentElement.scrollHeight || 0);

      if (currentHeight !== lastHeight) {
        // content grew — reset walking to reflect new height
        lastHeight = currentHeight;
        // continue from current y (which may now be < new bottom)
        // do not increase stableCount
        stableCount = 0;
      }

      // If at/near bottom and content stable for a couple rounds, we can stop
      if (y >= lastHeight - viewportH - 1) {
        // wait additional stabilization rounds
        stableCount++;
        if (stableCount >= stabilizeRounds) break;
      }
    }

    // final bottom pass to ensure bottom reached and stable
    try {
      scrollEl.scrollTo({ top: lastHeight - viewportH, left: 0, behavior: 'instant' });
    } catch (e) {}
    await wait(waitPerStepMs);

    // read final stable height and reset scroll to top
    const finalHeight = Math.max(scrollEl.scrollHeight || 0, document.documentElement.scrollHeight || 0);

    // build final positions array (CSS offsets)
    const positions = [];
    for (let pos = 0; pos < finalHeight; pos += viewportH) {
      positions.push(Math.min(pos, finalHeight - viewportH));
      if (pos + viewportH >= finalHeight) break;
    }

    // restore original scroll/overflow
    try { scrollEl.scrollTo({ top: origScrollTop, left: 0, behavior: 'instant' }); } catch (e) {}
    scrollEl.style.overflow = origOverflow;

    return { finalHeight, positions, viewportH };
  }

  // Stitch images vertically and return array of blobs (may be multiple parts if too tall).
  // Uses PNG -> WebP -> split logic similar to earlier scripts.
  async function stitchAndExportBlobs(images) {
    const width = Math.max(...images.map(i => i.width));
    const totalHeight = images.reduce((s, it) => s + it.height, 0);

    // Helper to make single canvas and return blob for a given mime
    async function canvasBlobFromImages(imgArray, mime='image/png', quality=0.92) {
      const w = Math.max(...imgArray.map(i => i.width));
      const h = imgArray.reduce((s, it) => s + it.height, 0);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      let y = 0;
      for (const it of imgArray) {
        ctx.drawImage(it.img, 0, y, it.width, it.height);
        y += it.height;
      }
      const blob = await canvasToBlob(canvas, mime, quality);
      return { blob, width: w, height: h };
    }

    // If total height is small enough for single canvas, try single export
    if (totalHeight <= SAFE_CANVAS_HEIGHT) {
      const pngRes = await canvasBlobFromImages(images, 'image/png', 0.92);
      if (pngRes.blob.size <= MAX_BYTES) return [{ blob: pngRes.blob, mime: 'image/png' }];

      // try webp
      const webpRes = await canvasBlobFromImages(images, 'image/webp', WEBP_QUALITY);
      if (webpRes.blob.size <= MAX_BYTES) return [{ blob: webpRes.blob, mime: 'image/webp' }];

      // return webp even if larger (caller will split)
      return [{ blob: webpRes.blob, mime: 'image/webp' }];
    }

    // If too tall, tile into vertical parts each <= SAFE_CANVAS_HEIGHT
    const parts = [];
    let cursor = 0;
    while (cursor < totalHeight) {
      const tileH = Math.min(SAFE_CANVAS_HEIGHT, totalHeight - cursor);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = tileH;
      const ctx = canvas.getContext('2d');

      // draw relevant slices
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

      // export tile as webp (smaller)
      const tileWebp = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
      parts.push({ blob: tileWebp, mime: 'image/webp' });
      cursor += tileH;
    }
    return parts;
  }

  // If a stitched blob is still > MAX_BYTES, split into multiple webp parts by chunking images into batches
  async function splitIntoSizedWebPs(images) {
    const result = [];
    let current = [];
    for (let i = 0; i < images.length; i++) {
      const candidate = images[i];
      const tryBatch = current.concat([candidate]);
      const parts = await stitchAndExportBlobs(tryBatch);
      const totalSize = parts.reduce((s, p) => s + (p.blob?.size || 0), 0);
      if (totalSize <= MAX_BYTES) {
        current = tryBatch;
      } else {
        if (current.length === 0) {
          // single candidate too large — downscale the single image
          const it = candidate;
          const tmp = document.createElement('canvas');
          tmp.width = Math.max(1, Math.floor(it.width / 2));
          tmp.height = Math.max(1, Math.floor(it.height / 2));
          const tctx = tmp.getContext('2d');
          tctx.drawImage(it.img, 0, 0, tmp.width, tmp.height);
          const scaledBlob = await canvasToBlob(tmp, 'image/webp', Math.max(0.75, WEBP_QUALITY - 0.1));
          result.push({ blob: scaledBlob, mime: 'image/webp' });
        } else {
          const finalized = await stitchAndExportBlobs(current);
          for (const p of finalized) result.push({ blob: p.blob, mime: p.mime });
          current = [candidate];
        }
      }
    }
    if (current.length > 0) {
      const finalized = await stitchAndExportBlobs(current);
      for (const p of finalized) result.push({ blob: p.blob, mime: p.mime });
    }
    return result;
  }

  // ---------- Main capture flow ----------
  async function startCapture() {
    if (!document.body) throw new Error('No document body');

    const scrollEl = detectScrollContainer();
    const originalScroll = scrollEl.scrollTop;
    const originalOverflow = scrollEl.style.overflow;
    const origZoom = document.documentElement.style.zoom || '';

    try {
      // 1) PRE-SCROLL: walk the page to the bottom allowing lazy-loaded content to append and stabilize
      const pre = await preScrollAndStabilize(scrollEl, { stabilizeRounds: 2, waitPerStepMs: 550 });
      console.log('[preScroll] finalHeight', pre.finalHeight, 'positions', pre.positions.length);

      // 2) CAPTURE each collected position (these are CSS offsets reflecting stable layout)
      // We'll scroll the same container to each position and call safeCapture()
      const capturedDataUrls = [];
      for (let i = 0; i < pre.positions.length; i++) {
        const y = pre.positions[i];
        try { scrollEl.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch (e) {}
        // Wait for paint & lazy loads
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 420)));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // 3) Convert captured data URLs to Image objects (these images are in device pixels)
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // 4) Stitch & export (PNG -> WebP -> split)
      const stitched = await stitchAndExportBlobs(images);

      // If stitched result is single png under limit, save it; else if webp single, save it; else split
      if (stitched.length === 1 && stitched[0].mime === 'image/png' && stitched[0].blob.size <= MAX_BYTES) {
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.png`;
        downloadBlob(stitched[0].blob, name);
        alert('Saved full-page PNG (under limit).');
        return;
      }

      if (stitched.length === 1 && stitched[0].mime.includes('webp') && stitched[0].blob.size <= MAX_BYTES) {
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.webp`;
        downloadBlob(stitched[0].blob, name);
        alert('Saved full-page WebP (single file).');
        return;
      }

      // Otherwise, ensure each exported piece <= MAX_BYTES (split if needed)
      const parts = await splitIntoSizedWebPs(images);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ext = p.mime && p.mime.includes('webp') ? 'webp' : 'png';
        const fname = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_part${i+1}.${ext}`;
        downloadBlob(p.blob, fname);
      }
      alert(`Saved ${parts.length} image(s).`);

    } finally {
      // restore state
      try { scrollEl.style.overflow = originalOverflow; } catch (e) {}
      try { scrollEl.scrollTo({ top: originalScroll, left: 0, behavior: 'instant' }); } catch (e) {}
      document.documentElement.style.zoom = origZoom || '';
    }
  }

})();

