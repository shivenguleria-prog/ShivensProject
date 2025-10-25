// contentScript.js
// Fullpage capture with zoom, PNG-first, dual-WebP, precise scrolling and overlap minimization.

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
  const PNG_QUALITY = 0.92; // PNG ignores quality mostly, kept param
  const ZOOM_FACTOR = 0.8; // 80% zoom
  const ROW_HASH_MOD = 4294967291; // large prime for simple hash reduce
  const MAX_OVERLAP_CHECK = 800; // maximum rows to consider for overlap (cap for perf)
  const ROW_DIFF_TOLERANCE = 0; // exact row match required (set >0 to allow small diffs)
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

  // Compute per-row hash array for an Image object
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
    // compute a simple rolling hash per row
    for (let row = 0; row < h; row++) {
      let hash = 2166136261 >>> 0; // FNV offset basis (32-bit)
      const baseIndex = row * w * 4;
      for (let x = 0; x < w; x++) {
        // read RGBA
        const r = data[baseIndex + x * 4];
        const g = data[baseIndex + x * 4 + 1];
        const b = data[baseIndex + x * 4 + 2];
        const a = data[baseIndex + x * 4 + 3];
        // fold pixels into hash
        hash ^= r; hash = Math.imul(hash, 16777619) >>> 0;
        hash ^= g; hash = Math.imul(hash, 16777619) >>> 0;
        hash ^= b; hash = Math.imul(hash, 16777619) >>> 0;
        hash ^= a; hash = Math.imul(hash, 16777619) >>> 0;
      }
      rowHashes[row] = hash;
    }
    return { width: w, height: h, rowHashes, img };
  }

  // Determine vertical overlap (rows) between top of b and bottom of a
  // returns number of overlapping rows (0..maxPossible)
  function findVerticalOverlap(aHashes, bHashes, maxCheck) {
    // aHashes, bHashes are Uint32Array of per-row hashes
    const aH = aHashes.length;
    const bH = bHashes.length;
    const maxPossible = Math.min(maxCheck, aH, bH);
    if (maxPossible <= 0) return 0;

    // We'll look for the largest overlap, scanning from maxPossible down to 1.
    // For each candidate overlap 'o', check if the last 'o' rows of A match first 'o' rows of B.
    for (let o = maxPossible; o >= 1; o--) {
      let ok = true;
      const aStart = aH - o;
      const bStart = 0;
      for (let r = 0; r < o; r++) {
        if (Math.abs(aHashes[aStart + r] - bHashes[bStart + r]) > ROW_DIFF_TOLERANCE) {
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
      await new Promise(r => setTimeout(r, 160)); // allow layout reflow

      // measure after zoom
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

      // Precise positions: cover the page with no overlapping repeats; final position exactly at bottom
      const positions = [];
      let y = 0;
      while (y < totalHeight - viewportHeight) {
        positions.push(Math.round(y));
        y += viewportHeight;
      }
      positions.push(Math.max(0, Math.round(totalHeight - viewportHeight))); // ensure final bottom

      // capture each viewport position
      const capturedDataUrls = [];
      for (const pos of positions) {
        scrollingEl.scrollTo({ top: pos, left: 0, behavior: 'instant' });
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

      // restore zoom
      document.documentElement.style.zoom = originalZoom;

      // load images and compute per-row hashes (used for overlap detection)
      const loaded = [];
      for (let i = 0; i < capturedDataUrls.length; i++) {
        const d = capturedDataUrls[i];
        const img = await loadImage(d);
        // For large captures this can be heavy; but we limit overlap checks later
        const meta = await computeRowHashes(img);
        loaded.push(meta);
      }

      // detect vertical overlaps between consecutive images
      const overlaps = []; // overlaps[i] = number of rows overlapped between loaded[i] and loaded[i+1]
      for (let i = 0; i < loaded.length - 1; i++) {
        const a = loaded[i];
        const b = loaded[i + 1];
        // choose reasonable max check: min(height/2, MAX_OVERLAP_CHECK)
        const maxCheck = Math.min(Math.floor(a.height / 2), Math.floor(b.height / 2), MAX_OVERLAP_CHECK);
        const o = findVerticalOverlap(a.rowHashes, b.rowHashes, maxCheck);
        overlaps.push(o);
      }

      // Stitch images vertically while removing overlaps
      // Calculate final stitched height
      let stitchedWidth = 0;
      let stitchedHeight = 0;
      for (let i = 0; i < loaded.length; i++) {
        stitchedWidth = Math.max(stitchedWidth, loaded[i].width);
        stitchedHeight += loaded[i].height;
        if (i < overlaps.length) stitchedHeight -= overlaps[i]; // subtract overlapped rows
      }

      // create canvas and draw with offsets adjusted for overlaps
      const canvas = document.createElement('canvas');
      canvas.width = stitchedWidth;
      canvas.height = stitchedHeight;
      const ctx = canvas.getContext('2d');

      let yOffset = 0;
      for (let i = 0; i < loaded.length; i++) {
        const meta = loaded[i];
        // If overlap with previous exists, we draw skipping the top 'overlapPrev' rows of this image
        let skipTop = 0;
        if (i > 0) {
          skipTop = overlaps[i - 1] || 0;
        }
        if (skipTop === 0) {
          ctx.drawImage(meta.img, 0, 0, meta.width, meta.height, 0, yOffset, meta.width, meta.height);
          yOffset += meta.height;
        } else {
          // draw only the portion from skipTop..height
          const srcY = skipTop;
          const srcH = meta.height - skipTop;
          ctx.drawImage(meta.img, 0, srcY, meta.width, srcH, 0, yOffset, meta.width, srcH);
          yOffset += srcH;
        }
      }

      // Helper to attempt and save with given mime/quality
      async function trySave(mime, quality) {
        const blob = await canvasToBlob(canvas, mime, quality);
        return blob;
      }

      // 1) Try PNG full
      const pngBlob = await trySave('image/png', PNG_QUALITY);
      if (pngBlob.size <= MAX_BYTES) {
        saveBlob(pngBlob, 'png');
        alert('Saved as PNG (under 19MB)');
        return;
      }

      // 2) Try WebP primary
      let webpPrimary = await trySave('image/webp', WEBP_QUALITY_PRIMARY);
      if (webpPrimary.size <= MAX_BYTES) {
        saveBlob(webpPrimary, 'webp');
        alert('Saved as single WebP (quality ' + WEBP_QUALITY_PRIMARY + ')');
        return;
      }

      // 3) Try WebP fallback
      let webpFallback = await trySave('image/webp', WEBP_QUALITY_FALLBACK);
      if (webpFallback.size <= MAX_BYTES) {
        saveBlob(webpFallback, 'webp');
        alert('Saved as single WebP (quality ' + WEBP_QUALITY_FALLBACK + ')');
        return;
      }

      // 4) If still too big, split into batches intelligently using overlap-aware stitching per batch
      // We'll build batches of consecutive captured frames grouping until the stitched webp at primary is > MAX_BYTES,
      // then finalize the previous group. For each final group we will try primary then fallback.
      const batches = [];
      let batchStart = 0;

      // helper to produce a stitched blob for a range [s,e] inclusive using same approach above
      async function stitchRangeToBlob(s, e, mime, quality) {
        // determine stitched width/height for this range using precomputed overlaps
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
        let yOff = 0;
        for (let k = s; k <= e; k++) {
          const meta = loaded[k];
          const skipTop = (k > s) ? (overlaps[k - 1] || 0) : 0;
          if (skipTop === 0) {
            cctx.drawImage(meta.img, 0, 0, meta.width, meta.height, 0, yOff, meta.width, meta.height);
            yOff += meta.height;
          } else {
            const srcY = skipTop;
            const srcH = meta.height - skipTop;
            cctx.drawImage(meta.img, 0, srcY, meta.width, srcH, 0, yOff, meta.width, srcH);
            yOff += srcH;
          }
        }
        const blob = await canvasToBlob(c, mime, quality);
        return blob;
      }

      // Build batches
      for (let i = 0; i < loaded.length; i++) {
        // attempt to grow a batch from batchStart..i
        const testBlob = await stitchRangeToBlob(batchStart, i, 'image/webp', WEBP_QUALITY_PRIMARY);
        if (testBlob.size <= MAX_BYTES) {
          // still fits — continue to next
          if (i === loaded.length - 1) {
            // last one fits too, finalize
            batches.push({ s: batchStart, e: i, preferred: 'primary' });
          }
          continue;
        } else {
          // testBlob > MAX_BYTES — we must finalize the previous batch batchStart..i-1 (if any)
          if (i - 1 >= batchStart) {
            batches.push({ s: batchStart, e: i - 1, preferred: 'primary' });
            batchStart = i; // new batch starting at i
          } else {
            // single capture at i already too big at primary — finalize it (we'll try fallback when saving)
            batches.push({ s: i, e: i, preferred: 'primary' });
            batchStart = i + 1;
          }
        }
      }

      // Save batches (try primary quality blob first; if > MAX_BYTES, try fallback; if still >MAX_BYTES, save fallback anyway)
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
        // still too big — save fallback and warn
        saveBlob(blobFallback, 'webp', bi + 1);
        console.warn(`Saved batch ${bi + 1} at fallback quality but size still > ${MAX_BYTES}.`);
      }

      alert(`Saved ${batches.length} WebP file(s) after batching (tried ${WEBP_QUALITY_PRIMARY} then ${WEBP_QUALITY_FALLBACK})`);

    } catch (err) {
      // cleanup on error
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
