// contentScript_fullpage_capture_zoomed.js
// Full-page capture script (without forced zoom).
// - Save as JPG first (0.97 → 0.95)
// - If both exceed 24MB, try WebP (0.97 → 0.92)
// - Scroll positions and measurements are calculated normally

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 24 * 1024 * 1024; // 24 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;

  // Output preferences
  const JPEG_QUALITY_HIGH = 0.97; // first attempt for JPEG
  const JPEG_QUALITY = 0.95; // second attempt for JPEG if high exceeds limit
  const WEBP_QUALITY_HIGH = 0.97; // fallback 1 for WebP
  const WEBP_QUALITY_FALLBACK = 0.92; // fallback 2 (assumed to be <= MAX_BYTES)
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

  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.95) {
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
      scrollingEl.scrollTo({ top: y, left: 0, behavior: 'auto' });
      await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
      const dataUrl = await safeCapture();
      capturedDataUrls.push(dataUrl);
    }

    // restore
    scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'auto' });
    scrollingEl.style.overflow = originalOverflow;
    fixedCache.forEach(it => {
      it.el.style.visibility = it.orig.visibility || '';
      it.el.style.pointerEvents = it.orig.pointerEvents || '';
    });

    // Load all captures as images
    const images = [];
    for (const d of capturedDataUrls) {
      const img = await loadImage(d);
      images.push({ img, width: img.width, height: img.height });
    }

    async function stitchImages(imgItems, mime = 'image/jpeg', quality = 0.95) {
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

    // 1️⃣ Try to make one big JPG at 0.97 (best quality)
    const { blob: jpgHighBlob } = await stitchImages(images, 'image/jpeg', JPEG_QUALITY_HIGH);
    if (jpgHighBlob.size <= MAX_BYTES) {
      saveBlob(jpgHighBlob, 'jpg');
      alert('Saved as JPG (quality 0.97, under 24MB)');
      return;
    }

    // 2️⃣ Try JPEG at 0.95
    const { blob: jpgBlob } = await stitchImages(images, 'image/jpeg', JPEG_QUALITY);
    if (jpgBlob.size <= MAX_BYTES) {
      saveBlob(jpgBlob, 'jpg');
      alert('Saved as JPG (quality 0.95, under 24MB)');
      return;
    }

    // 3️⃣ Try one WebP at high quality (0.97)
    let { blob: webpBlob } = await stitchImages(images, 'image/webp', WEBP_QUALITY_HIGH);
    if (webpBlob.size <= MAX_BYTES) {
      saveBlob(webpBlob, 'webp');
      alert('Saved as WebP (quality 0.97, under 24MB)');
      return;
    }

    // 4️⃣ If still >24MB, retry with WebP 0.92
    console.log(`JPG(0.97) was ${Math.round(jpgHighBlob.size / 1024 / 1024)}MB, JPG(0.95) was ${Math.round(jpgBlob.size / 1024 / 1024)}MB, WebP(0.97) was ${Math.round(webpBlob.size / 1024 / 1024)}MB. Retrying at WebP 0.92...`);
    const retry = await stitchImages(images, 'image/webp', WEBP_QUALITY_FALLBACK);
    webpBlob = retry.blob;

    if (webpBlob.size <= MAX_BYTES) {
      saveBlob(webpBlob, 'webp');
      alert('Saved as WebP (quality 0.92, reduced for size)');
      return;
    }

    // Safety fallback
    const batches = [];
    let currentBatch = [];
    for (let i = 0; i < images.length; i++) {
      const candidate = images[i];
      const tryBatch = currentBatch.concat([candidate]);
      const { blob: testBlob } = await stitchImages(tryBatch, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (testBlob.size <= MAX_BYTES) {
        currentBatch = tryBatch;
      } else {
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

    alert(`Saved as ${batches.length} WebP image(s) (each ≤${Math.round(MAX_BYTES / 1024 / 1024)}MB)`);

    function saveBlob(blob, ext, index = 0) {
      const base = (new URL(location.href)).hostname.replace(/\./g, '_');
      const name = index ? `${base}_part${index}.${ext}` : `${base}_fullpage.${ext}`;
      downloadBlob(blob, name);
    }
  }
})();
