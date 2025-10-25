// contentScript.js
// Fullpage capture with:
// - Zoom-out (restore after)
// - PNG-first, WebP primary (0.97) then fallback (0.92)
// - Precise scrolling to cover page without repeated bottom frames
// - Wait-for-scroll-and-stability + duplicate-detection to avoid repeated footer
// - Overlap-aware stitching (row-hash) to minimize overlaps
// - Batching to keep each final file ≤ 19MB when possible

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 19 * 1024 * 1024; // 19 MB
  const CAPTURE_DELAY_MS = 550; // delay between scroll and capturing visible
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY_PRIMARY = 0.97;
  const WEBP_QUALITY_FALLBACK = 0.92;
  const PNG_QUALITY = 0.92; // not used by PNG usually
  const ZOOM_FACTOR = 0.8; // 80% zoom
  const MAX_OVERLAP_CHECK = 800; // max rows to check for overlap to limit CPU
  const ROW_DIFF_TOLERANCE = 0; // exact row-match required; increase to allow small diffs
  const STABILITY_TIMEOUT_MS = 2500;
  const STABILITY_POLL_INTERVAL = 80;
  const STABILITY_STABLE_CHECKS = 3;
  const STABILITY_STABLE_DELAY = 120;
  const DUPLICATE_SAMPLE_STEP = 6; // sample every 6th pixel for duplicate test
  const DUPLICATE_PIXEL_TOL = 2; // per-channel tolerance for duplicate test
  // ------------------------

  let lastCaptureTs = 0;

  // listen for start-capture message
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

  // Wait until window.scrollY ~ targetY and scrollHeight stabilizes
  async function waitForScrollAndStability(targetY, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? STABILITY_TIMEOUT_MS;
    const pollInterval = opts.pollInterval ?? STABILITY_POLL_INTERVAL;
    const yTol = opts.yTol ?? 1;
    const stableChecks = opts.stableChecks ?? STABILITY_STABLE_CHECKS;
    const stableDelay = opts.stableDelay ?? STABILITY_STABLE_DELAY;

    const start = Date.now();
    while (Math.abs(window.scrollY - targetY) > yTol && (Date.now() - start) < timeoutMs) {
      await new Promise(r => setTimeout(r, pollInterval));
    }

    let lastH = document.documentElement.scrollHeight;
    let stableCount = 0;
    while (stableCount < stableChecks && (Date.now() - start) < timeoutMs) {
      await new Promise(r => setTimeout(r, stableDelay));
      const h = document.documentElement.scrollHeight;
      if (h === lastH) stableCount++;
      else {
        stableCount = 0;
        lastH = h;
      }
    }
    // small extra pause for lazy images to render
    await new Promise(r => setTimeout(r, 80));
  }

  // Compare two dataURLs approximately by sampling pixels
  async function imagesIdentical(dataUrlA, dataUrlB, opts = {}) {
    const pixelTolerance = opts.pixelTolerance ?? DUPLICATE_PIXEL_TOL;
    const sampleStep = opts.sampleStep ?? DUPLICATE_SAMPLE_STEP;

    if (!dataUrlA || !dataUrlB) return false;
    if (dataUrlA === dataUrlB) return true;

    const [imgA, imgB] = await Promise.all([loadImage(dataUrlA), loadImage(dataUrlB)]);
    if (imgA.width !== imgB.width || imgA.height !== imgB.height) return false;

    const w = imgA.width, h = imgA.height;
    const cA = document.createElement('canvas'); cA.width = w; cA.height = h;
    const cB = document.createElement('canvas'); cB.width = w; cB.height = h;
    const ctxA = cA.getContext('2d'), ctxB = cB.getContext('2d');
    ctxA.drawImage(imgA, 0, 0, w, h);
    ctxB.drawImage(imgB, 0, 0, w, h);

    const dA = ctxA.getImageData(0, 0, w, h).data;
    const dB = ctxB.getImageData(0, 0, w, h).data;

    for (let y = 0; y < h; y += sampleStep) {
      for (let x = 0; x < w; x += sampleStep) {
        const idx = (y * w + x) * 4;
        const dr = Math.abs(dA[idx]   - dB[idx]);
        const dg = Math.abs(dA[idx+1] - dB[idx+1]);
        const db = Math.abs(dA[idx+2] - dB[idx+2]);
        const da = Math.abs(dA[idx+3] - dB[idx+3]);
        if (dr > pixelTolerance || dg > pixelTolerance || db > pixelTolerance || da > pixelTolerance) {
          return false;
        }
      }
    }
    return true;
  }

  // Compute per-row hashes for an Image (used to detect overlap). Returns { width, height, rowHashes, img }
  async function computeRowHashes(img) {
    const w = img.width;
    const h = img.height;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;

    const rowHashes = new Uint32Array(h);
    for (let row = 0; row < h; row++) {
      let hash = 2166136261 >>> 0; // FNV-1a 32-bit init
      const baseIndex = row * w * 4;
      for (let x = 0; x < w; x++) {
        hash ^= data[baseIndex + x * 4];
        hash = Math.imul(hash, 16777619) >>> 0;
        hash ^= data[baseIndex + x * 4 + 1];
        hash = Math.imul(hash, 16777619) >>> 0;
        hash ^= data[baseIndex + x * 4 + 2];
        hash = Math.imul(hash, 16777619) >>> 0;
        hash ^= data[baseIndex + x * 4 + 3];
        hash = Math.imul(hash, 16777619) >>> 0;
      }
      rowHashes[row] = hash;
    }
    return { width: w, height: h, rowHashes, img };
  }

  // Find vertical overlap (rows) between end of aHashes and start of bHashes. Returns overlap row-count.
  function findVerticalOverlap(aHashes, bHashes, maxCheck) {
    const aH = aHashes.length;
    const bH = bHashes.length;
    const maxPossible = Math.min(maxCheck, aH, bH);
    if (maxPossible <= 0) return 0;

    for (let o = maxPossible; o >= 1; o--) {
      let ok = true;
      const aStart = aH - o;
      for (let r = 0; r < o; r++) {
        if (Math.abs(aHashes[aStart + r] - bHashes[r]) > ROW_DIFF_TOLERANCE) {
          ok = false;
          break;
        }
      }
      if (ok) return o;
    }
    return 0;
  }

  // ---------------- MAIN ----------------
  async function startCapture() {
    if (!document.body) throw new Error('No document body found');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    const originalZoom = document.documentElement.style.zoom || '';

    try {
      // apply zoom before measuring/layout
      document.documentElement.style.zoom = String(ZOOM_FACTOR);
      await new Promise(r => setTimeout(r, 160)); // allow reflow

      // measure after zoom applied
      const totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const viewportHeight = Math.max(window.innerHeight, document.documentElement.clientHeight);

      // hide fixed/sticky elements
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

      // precise positions: iterate viewportHeight steps, final position exactly bottom
      const positions = [];
      let yPos = 0;
      while (yPos < totalHeight - viewportHeight) {
        positions.push(Math.round(yPos));
        yPos += viewportHeight;
      }
      positions.push(Math.max(0, Math.round(totalHeight - viewportHeight)));

      // capture loop with stability + duplicate detection + nudge retry
      const capturedDataUrls = [];
      let prevDataUrl = null;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i];
        window.scrollTo({ top: pos, left: 0, behavior: 'instant' });

        // wait for scroll & layout stability
        await waitForScrollAndStability(pos, { timeoutMs: STABILITY_TIMEOUT_MS });

        // capture
        let dataUrl = await safeCapture();

        // duplicate detection
        let identical = false;
        if (prevDataUrl) {
          try {
            identical = await imagesIdentical(prevDataUrl, dataUrl, { pixelTolerance: DUPLICATE_PIXEL_TOL, sampleStep: DUPLICATE_SAMPLE_STEP });
          } catch (e) {
            console.warn('imagesIdentical error', e);
            identical = false;
          }
        }

        let nudgeAttempts = 0;
        while (identical && nudgeAttempts < 2) {
          nudgeAttempts++;
          // try tiny nudge: scroll 1px down, wait, capture, compare
          window.scrollBy(0, 1);
          await waitForScrollAndStability(window.scrollY, { timeoutMs: 600 });
          await new Promise(r => setTimeout(r, 120));
          dataUrl = await safeCapture();
          try {
            identical = await imagesIdentical(prevDataUrl, dataUrl, { pixelTolerance: DUPLICATE_PIXEL_TOL, sampleStep: DUPLICATE_SAMPLE_STEP });
          } catch (e) {
            identical = false;
          }
          if (!identical) break;
          // nudge back up and try again
          window.scrollBy(0, -1);
          await waitForScrollAndStability(window.scrollY, { timeoutMs: 600 });
          await new Promise(r => setTimeout(r, 120));
          dataUrl = await safeCapture();
          try {
            identical = await imagesIdentical(prevDataUrl, dataUrl, { pixelTolerance: DUPLICATE_PIXEL_TOL, sampleStep: DUPLICATE_SAMPLE_STEP });
          } catch (e) {
            identical = false;
          }
        }

        if (identical) {
          console.warn(`Skipping duplicate capture at pos ${pos} (index ${i}).`);
          // If it's the last frame, break loop to avoid endless attempts
          if (i === positions.length - 1) break;
          else continue;
        }

        // accept capture
        capturedDataUrls.push(dataUrl);
        prevDataUrl = dataUrl;
      }

      // restore scroll/overflow/fixed elements before heavy DOM ops
      scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
      scrollingEl.style.overflow = originalOverflow;
      fixedCache.forEach(it => {
        it.el.style.visibility = it.orig.visibility || '';
        it.el.style.pointerEvents = it.orig.pointerEvents || '';
      });

      // restore zoom
      document.documentElement.style.zoom = originalZoom;

      // load images and compute row hashes
      const loaded = [];
      for (let i = 0; i < capturedDataUrls.length; i++) {
        const img = await loadImage(capturedDataUrls[i]);
        const meta = await computeRowHashes(img); // may be heavy for big captures
        loaded.push(meta);
      }

      if (loaded.length === 0) {
        throw new Error('No captures were produced.');
      }

      // compute overlaps between consecutive images
      const overlaps = [];
      for (let i = 0; i < loaded.length - 1; i++) {
        const a = loaded[i];
        const b = loaded[i + 1];
        const maxCheck = Math.min(Math.floor(a.height / 2), Math.floor(b.height / 2), MAX_OVERLAP_CHECK);
        const o = findVerticalOverlap(a.rowHashes, b.rowHashes, maxCheck);
        overlaps.push(o);
      }

      // produce stitched canvas (removing overlaps)
      let stitchedWidth = 0;
      let stitchedHeight = 0;
      for (let i = 0; i < loaded.length; i++) {
        stitchedWidth = Math.max(stitchedWidth, loaded[i].width);
        stitchedHeight += loaded[i].height;
        if (i < overlaps.length) stitchedHeight -= overlaps[i];
      }

      const canvas = document.createElement('canvas');
      canvas.width = stitchedWidth;
      canvas.height = stitchedHeight;
      const ctx = canvas.getContext('2d');

      let yOff = 0;
      for (let i = 0; i < loaded.length; i++) {
        const meta = loaded[i];
        const skipTop = (i > 0) ? (overlaps[i - 1] || 0) : 0;
        if (skipTop === 0) {
          ctx.drawImage(meta.img, 0, 0, meta.width, meta.height, 0, yOff, meta.width, meta.height);
          yOff += meta.height;
        } else {
          const srcY = skipTop;
          const srcH = meta.height - skipTop;
          ctx.drawImage(meta.img, 0, srcY, meta.width, srcH, 0, yOff, meta.width, srcH);
          yOff += srcH;
        }
      }

      // helper to try saving canvas as blob
      async function trySaveCanvas(mime, quality) {
        return await canvasToBlob(canvas, mime, quality);
      }

      // Try PNG first
      const pngBlob = await trySaveCanvas('image/png', PNG_QUALITY);
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, 'png');
        alert('Saved as PNG (under 19MB)');
        return;
      }

      // Try WebP primary
      let webpPrimary = await trySaveCanvas('image/webp', WEBP_QUALITY_PRIMARY);
      if (webpPrimary.size <= MAX_BYTES) {
        saveBlob(webpPrimary, 'webp');
        alert('Saved as single WebP (quality ' + WEBP_QUALITY_PRIMARY + ')');
        return;
      }

      // Try WebP fallback
      let webpFallback = await trySaveCanvas('image/webp', WEBP_QUALITY_FALLBACK);
      if (webpFallback.size <= MAX_BYTES) {
        saveBlob(webpFallback, 'webp');
        alert('Saved as single WebP (quality ' + WEBP_QUALITY_FALLBACK + ')');
        return;
      }

      // If still too big, build batches using overlap-aware range stitching
      const batches = [];
      let batchStart = 0;

      // helper to stitch a range [s..e] inclusive into a blob
      async function stitchRangeToBlob(s, e, mime, quality) {
        let w = 0, h = 0;
        for (let k = s; k <= e; k++) {
          w = Math.max(w, loaded[k].width);
          h += loaded[k].height;
          if (k < e) h -= overlaps[k] || 0;
        }
        const c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        const cctx = c.getContext('2d');
        let y0 = 0;
        for (let k = s; k <= e; k++) {
          const meta = loaded[k];
          const skip = (k > s) ? (overlaps[k - 1] || 0) : 0;
          if (skip === 0) {
            cctx.drawImage(meta.img, 0, 0, meta.width, meta.height, 0, y0, meta.width, meta.height);
            y0 += meta.height;
          } else {
            const srcY = skip;
            const srcH = meta.height - skip;
            cctx.drawImage(meta.img, 0, srcY, meta.width, srcH, 0, y0, meta.width, srcH);
            y0 += srcH;
          }
        }
        const blob = await canvasToBlob(c, mime, quality);
        return blob;
      }

      // grow batches greedily until test blob exceeds MAX_BYTES
      for (let i = 0; i < loaded.length; i++) {
        const testBlob = await stitchRangeToBlob(batchStart, i, 'image/webp', WEBP_QUALITY_PRIMARY);
        if (testBlob.size <= MAX_BYTES) {
          if (i === loaded.length - 1) {
            batches.push({ s: batchStart, e: i });
          } else {
            continue; // grow batch
          }
        } else {
          if (i - 1 >= batchStart) {
            batches.push({ s: batchStart, e: i - 1 });
            batchStart = i;
          } else {
            // single element too large even alone at primary -> finalize single
            batches.push({ s: i, e: i });
            batchStart = i + 1;
          }
        }
      }

      // save batches (try primary -> fallback)
      for (let bi = 0; bi < batches.length; bi++) {
        const { s, e } = batches[bi];
        const blobPrimary = await stitchRangeToBlob(s, e, 'image/webp', WEBP_QUALITY_PRIMARY);
        if (blobPrimary.size <= MAX_BYTES) {
          saveBlob(blobPrimary, 'webp', bi + 1);
          continue;
        }
        const blobFallback = await stitchRangeToBlob(s, e, 'image/webp', WEBP_QUALITY_FALLBACK);
        if (blobFallback.size <= MAX_BYTES) {
          saveBlob(blobFallback, 'webp', bi + 1);
          continue;
        }
        // still too big — save fallback anyway and warn
        saveBlob(blobFallback, 'webp', bi + 1);
        console.warn(`Saved batch ${bi + 1} at fallback quality but size still > ${MAX_BYTES}.`);
      }

      alert(`Saved ${batches.length} WebP file(s) after batching (tried ${WEBP_QUALITY_PRIMARY} then ${WEBP_QUALITY_FALLBACK})`);
    } catch (err) {
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
