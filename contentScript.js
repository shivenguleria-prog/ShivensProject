// contentScript_option4_offset_positions.js
(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  const MAX_BYTES = 24 * 1024 * 1024;
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const JPEG_QUALITY_HIGH = 0.97, JPEG_QUALITY = 0.95, WEBP_QUALITY_HIGH = 0.97, WEBP_QUALITY_FALLBACK = 0.92;
  const MAX_CANVAS_HEIGHT = 30000;

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => { console.error(e); alert('Capture failed: ' + e.message); });
    }
  });

  async function safeCapture() {
    const now = Date.now(), since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS - since));
    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise(resolve => {
        try { chrome.runtime.sendMessage({ action: 'capture-visible' }, resolve); }
        catch (err) { resolve({ success: false, error: err && err.message }); }
      });
      lastCaptureTs = Date.now();
      if (res && res.success && res.dataUrl) return res.dataUrl;
      if (attempt === CAPTURE_MAX_RETRIES) throw new Error(res?.error || 'capture failed');
      const backoff = CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load error'));
      img.src = dataUrl;
    });
  }
  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.95) {
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, quality));
  }
  function downloadBlob(blob, filename) { const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove(); setTimeout(()=>URL.revokeObjectURL(url),1000); }
  function timestamp() { return (new Date()).toISOString().replace(/[:.]/g,'-'); }

  // measure top fixed elements' cumulative max height
  function measureTopFixedHeight() {
    const els = Array.from(document.querySelectorAll('*'));
    let maxBottom = 0;
    for (const el of els) {
      const s = getComputedStyle(el);
      if ((s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none' && el.offsetParent !== null) {
        const r = el.getBoundingClientRect();
        // consider only those anchored near the top
        if (r.bottom > 0 && r.top <= 8) {
          maxBottom = Math.max(maxBottom, Math.ceil(r.bottom));
        }
      }
    }
    return maxBottom; // in CSS pixels
  }

  function makeBatchesByHeight(images, maxHeight = MAX_CANVAS_HEIGHT) {
    const batches = []; let current = [], currentH = 0;
    for (const img of images) {
      if (img.height > maxHeight) { if (current.length) { batches.push(current); current = []; currentH = 0; } batches.push([img]); continue; }
      if (currentH + img.height > maxHeight) { if (current.length) batches.push(current); current = [img]; currentH = img.height; } else { current.push(img); currentH += img.height; }
    }
    if (current.length) batches.push(current);
    return batches;
  }

  async function stitchImagesToBlob(imgItems, mime = 'image/jpeg', quality = 0.95) {
    const w = Math.max(...imgItems.map(i => i.width));
    const h = imgItems.reduce((s, i) => s + i.height, 0);
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d'); let y = 0;
    for (const it of imgItems) { ctx.drawImage(it.img, 0, y, it.width, it.height); y += it.height; }
    const blob = await canvasToBlob(canvas, mime, quality);
    return { blob, width: w, height: h, mime };
  }

  async function startCapture() {
    if (!document.body) throw new Error('No document body');
    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;

    // first capture top viewport normally (header retained once)
    const totalHeightInitial = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportHeight = window.innerHeight;

    try { scrollingEl.style.overflow = 'hidden'; } catch (e){}

    // first tile (0)
    scrollingEl.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
    const firstDataUrl = await safeCapture();

    // measure header area (top fixed elements) AFTER first capture
    const headerHeight = measureTopFixedHeight();

    // Now compute positions for the remaining captures, offset so we don't re-capture the header
    const positions = [0]; // we already captured top
    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    // start from y = viewportHeight, step by viewportHeight
    for (let y = viewportHeight; y < totalHeight; y += viewportHeight) {
      // scroll position should be y - headerHeight (so captured viewport begins below header)
      const scrollY = Math.min(Math.max(y - headerHeight, 0), totalHeight - viewportHeight);
      positions.push(scrollY);
      if (y + viewportHeight >= totalHeight) break;
    }

    // ensure unique positions (sometimes headerHeight or rounding can cause duplicates)
    const uniquePositions = Array.from(new Set(positions));

    const capturedDataUrls = [firstDataUrl];
    for (let i = 1; i < uniquePositions.length; i++) {
      const y = uniquePositions[i];
      scrollingEl.scrollTo({ top: y, left: 0, behavior: 'auto' });
      await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
      const dataUrl = await safeCapture();
      capturedDataUrls.push(dataUrl);
    }

    // restore scroll/overflow
    try { scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'auto' }); scrollingEl.style.overflow = originalOverflow; } catch (e) {}

    // convert loads
    const images = [];
    for (const d of capturedDataUrls) {
      try { const img = await loadImage(d); images.push({ img, width: img.width, height: img.height }); } catch (e) { console.warn('tile load fail', e); }
    }
    if (images.length === 0) throw new Error('No tiles to stitch');

    // batches & encode
    const batches = makeBatchesByHeight(images, MAX_CANVAS_HEIGHT);
    const outputs = []; let partCounter = 0;

    for (const batch of batches) {
      let attempt = await stitchImagesToBlob(batch, 'image/jpeg', JPEG_QUALITY_HIGH);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) { partCounter++; outputs.push({ blob: attempt.blob, ext: 'jpg', partIndex: partCounter }); continue; }
      attempt = await stitchImagesToBlob(batch, 'image/jpeg', JPEG_QUALITY);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) { partCounter++; outputs.push({ blob: attempt.blob, ext: 'jpg', partIndex: partCounter }); continue; }
      attempt = await stitchImagesToBlob(batch, 'image/webp', WEBP_QUALITY_HIGH);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) { partCounter++; outputs.push({ blob: attempt.blob, ext: 'webp', partIndex: partCounter }); continue; }
      attempt = await stitchImagesToBlob(batch, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) { partCounter++; outputs.push({ blob: attempt.blob, ext: 'webp', partIndex: partCounter }); continue; }
      for (const single of batch) {
        const sa = await stitchImagesToBlob([single], 'image/webp', WEBP_QUALITY_FALLBACK);
        if (sa.blob) { partCounter++; outputs.push({ blob: sa.blob, ext: 'webp', partIndex: partCounter }); }
      }
    }

    const base = (new URL(location.href)).hostname.replace(/\./g,'_');
    const ts = timestamp();
    for (const out of outputs) {
      const filename = out.partIndex > 1 ? `${base}_part${out.partIndex}_${ts}.${out.ext}` : `${base}_fullpage_${ts}.${out.ext}`;
      downloadBlob(out.blob, filename);
    }
    if (outputs.length === 0) throw new Error('No outputs');
    alert(`Saved ${outputs.length} file(s).`);
  }
})();
