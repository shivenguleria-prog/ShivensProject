// contentScript.js
// Full-page capture with:
// - Pre-scroll to allow lazy-loading
// - Automatic zoom adjustment based on DPR and page height
// - Safe stitched export (PNG → WebP → split if >19MB)

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---------- CONFIG ----------
  const MAX_BYTES = 19 * 1024 * 1024;  // 19 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const WEBP_QUALITY = 0.92;
  const SAFE_CANVAS_HEIGHT = 30000;  // Chrome safe limit
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

  // ----------- Utilities -----------
  function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

  async function safeCapture() {
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) await wait(CAPTURE_DELAY_MS - since);

    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise(resolve =>
        chrome.runtime.sendMessage({ action: 'capture-visible' }, resp => resolve(resp))
      );
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

  function detectScrollContainer() {
    let best = document.scrollingElement || document.documentElement;
    let maxScroll = best ? (best.scrollHeight || 0) : 0;
    const candidates = Array.from(document.querySelectorAll('body, html, div, main, section, article'));
    for (const el of candidates) {
      try {
        const sh = el.scrollHeight || 0;
        if (sh > maxScroll) {
          maxScroll = sh;
          best = el;
        }
      } catch {}
    }
    return best;
  }

  async function preScrollAndStabilize(scrollEl, { stepPx = null, stabilizeRounds = 2, waitPerStepMs = 500 } = {}) {
    const origScrollTop = scrollEl.scrollTop;
    const origOverflow = scrollEl.style.overflow;
    scrollEl.style.overflow = 'hidden';

    const viewportH = window.innerHeight;
    if (!stepPx) stepPx = viewportH;

    try { scrollEl.scrollTo({ top: 0, left: 0, behavior: 'instant' }); await wait(120); } catch {}

    let lastHeight = Math.max(scrollEl.scrollHeight || 0, document.documentElement.scrollHeight || 0);
    let stableCount = 0;
    let y = 0;

    while (y < lastHeight - 1) {
      y = Math.min(y + stepPx, lastHeight - viewportH);
      try { scrollEl.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch {}
      await wait(waitPerStepMs);
      const currentHeight = Math.max(scrollEl.scrollHeight || 0, document.documentElement.scrollHeight || 0);
      if (currentHeight !== lastHeight) {
        lastHeight = currentHeight;
        stableCount = 0;
      }
      if (y >= lastHeight - viewportH - 1) {
        stableCount++;
        if (stableCount >= stabilizeRounds) break;
      }
    }

    try { scrollEl.scrollTo({ top: lastHeight - viewportH, left: 0, behavior: 'instant' }); } catch {}
    await wait(waitPerStepMs);

    const finalHeight = Math.max(scrollEl.scrollHeight || 0, document.documentElement.scrollHeight || 0);
    const positions = [];
    for (let pos = 0; pos < finalHeight; pos += viewportH) {
      positions.push(Math.min(pos, finalHeight - viewportH));
      if (pos + viewportH >= finalHeight) break;
    }

    try { scrollEl.scrollTo({ top: origScrollTop, left: 0, behavior: 'instant' }); } catch {}
    scrollEl.style.overflow = origOverflow;

    return { finalHeight, positions, viewportH };
  }

  async function stitchAndExportBlobs(images) {
    const width = Math.max(...images.map(i => i.width));
    const totalHeight = images.reduce((s, it) => s + it.height, 0);

    async function canvasBlob(imgArr, mime = 'image/png', q = 0.92) {
      const w = Math.max(...imgArr.map(i => i.width));
      const h = imgArr.reduce((s, it) => s + it.height, 0);
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');
      let y = 0;
      for (const it of imgArr) {
        ctx.drawImage(it.img, 0, y, it.width, it.height);
        y += it.height;
      }
      const blob = await canvasToBlob(canvas, mime, q);
      return { blob, width: w, height: h };
    }

    if (totalHeight <= SAFE_CANVAS_HEIGHT) {
      const png = await canvasBlob(images, 'image/png', 0.92);
      if (png.blob.size <= MAX_BYTES) return [{ blob: png.blob, mime: 'image/png' }];

      const webp = await canvasBlob(images, 'image/webp', WEBP_QUALITY);
      if (webp.blob.size <= MAX_BYTES) return [{ blob: webp.blob, mime: 'image/webp' }];

      return [{ blob: webp.blob, mime: 'image/webp' }];
    }

    const parts = [];
    let cursor = 0;
    while (cursor < totalHeight) {
      const tileH = Math.min(SAFE_CANVAS_HEIGHT, totalHeight - cursor);
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = tileH;
      const ctx = canvas.getContext('2d');

      let yInTile = 0, acc = 0;
      for (const it of images) {
        const imgTop = acc, imgBottom = acc + it.height;
        acc += it.height;
        const tileTop = cursor, tileBottom = cursor + tileH;
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

      const tileWebp = await canvasToBlob(canvas, 'image/webp', WEBP_QUALITY);
      parts.push({ blob: tileWebp, mime: 'image/webp' });
      cursor += tileH;
    }
    return parts;
  }

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
          const it = candidate;
          const tmp = document.createElement('canvas');
          tmp.width = Math.max(1, Math.floor(it.width / 2));
          tmp.height = Math.max(1, Math.floor(it.height / 2));
          tmp.getContext('2d').drawImage(it.img, 0, 0, tmp.width, tmp.height);
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

  // ----------- Main capture flow -----------
  async function startCapture() {
    if (!document.body) throw new Error('No document body');

    const scrollEl = detectScrollContainer();
    const originalScroll = scrollEl.scrollTop;
    const originalOverflow = scrollEl.style.overflow;
    const origZoom = document.documentElement.style.zoom || '';

    try {
      // === Auto Zoom Adjustment (Dynamic DPR Scaling) ===
      const cssHeight = Math.max(document.body.scrollHeight, document.documentElement.scrollHeight);
      const dpr = window.devicePixelRatio || 1;
      const estimatedPixels = cssHeight * dpr;
      if (estimatedPixels > SAFE_CANVAS_HEIGHT) {
        const scale = SAFE_CANVAS_HEIGHT / estimatedPixels;
        document.documentElement.style.zoom = scale.toString();
        console.log(`[Auto Zoom] Applying zoom: ${scale.toFixed(3)} to prevent exceeding GPU limit`);
      } else {
        console.log(`[Auto Zoom] No zoom needed (estimated ${estimatedPixels}px)`);
      }

      // === Pre-scroll to stabilize content ===
      const pre = await preScrollAndStabilize(scrollEl, { stabilizeRounds: 2, waitPerStepMs: 550 });
      console.log('[preScroll] Final height:', pre.finalHeight, 'Positions:', pre.positions.length);

      // === Capture each position ===
      const capturedDataUrls = [];
      for (let i = 0; i < pre.positions.length; i++) {
        const y = pre.positions[i];
        try { scrollEl.scrollTo({ top: y, left: 0, behavior: 'instant' }); } catch {}
        await new Promise(r => requestAnimationFrame(() => setTimeout(r, 420)));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // === Load images ===
      const images = [];
      for (const d of capturedDataUrls) {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      }

      // === Stitch & Export ===
      const stitched = await stitchAndExportBlobs(images);

      if (stitched.length === 1 && stitched[0].mime === 'image/png' && stitched[0].blob.size <= MAX_BYTES) {
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.png`;
        downloadBlob(stitched[0].blob, name);
        alert('Saved PNG (under limit).');
        return;
      }

      if (stitched.length === 1 && stitched[0].mime.includes('webp') && stitched[0].blob.size <= MAX_BYTES) {
        const name = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_fullpage.webp`;
        downloadBlob(stitched[0].blob, name);
        alert('Saved WebP (single file).');
        return;
      }

      const parts = await splitIntoSizedWebPs(images);
      for (let i = 0; i < parts.length; i++) {
        const p = parts[i];
        const ext = (p.mime && p.mime.includes('webp')) ? 'webp' : 'png';
        const fname = `${(new URL(location.href)).hostname.replace(/\./g,'_')}_part${i+1}.${ext}`;
        downloadBlob(p.blob, fname);
      }
      alert(`Saved ${parts.length} image(s).`);
    } finally {
      try { scrollEl.style.overflow = originalOverflow; } catch {}
      try { scrollEl.scrollTo({ top: originalScroll, left: 0, behavior: 'instant' }); } catch {}
      document.documentElement.style.zoom = origZoom;
    }
  }
})();
