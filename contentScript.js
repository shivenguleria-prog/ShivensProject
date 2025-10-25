// contentScript.js
// Full-page scroll + capture + stitch script with:
//  - safeCapture() to avoid MAX_CAPTURE_VISIBLE_TAB_CALLS_PER_SECOND quota
//  - retries on capture failures
//  - splitting output images so each final PNG <= 20 MB (approx)
//  - simple hiding of fixed/sticky elements during capture
(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 20 * 1024 * 1024; // 20 MB
  const CAPTURE_DELAY_MS = 550; // safe delay between captures (ms)
  const CAPTURE_MAX_RETRIES = 3; // retries per capture
  const CAPTURE_RETRY_BASE_DELAY = 300; // ms, exponential backoff base
  // ------------------------

  // State for throttling
  let lastCaptureTs = 0;

  // Listen for the "start-capture" message from popup
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => {
        console.error('Capture failed', e);
        alert('Capture failed: ' + (e && e.message ? e.message : e));
      });
    }
  });

  // Safe capture wrapper: enforces a minimum delay between captureVisible calls
  async function safeCapture() {
    // Ensure a minimum spacing from last capture
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) {
      await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS - since));
    }

    // Attempt capture with retries and exponential backoff
    for (let attempt = 1; attempt <= CAPTURE_MAX_RETRIES; attempt++) {
      const res = await new Promise(resolve => {
        chrome.runtime.sendMessage({ action: 'capture-visible' }, (resp) => resolve(resp));
      });

      lastCaptureTs = Date.now();

      if (res && res.success) {
        return res.dataUrl;
      } else {
        // If we've exhausted retries, throw meaningful error
        if (attempt === CAPTURE_MAX_RETRIES) {
          const errMsg = res?.error || 'Unknown capture error';
          throw new Error(`capture failed: ${errMsg}`);
        }
        // Wait with exponential backoff before retry
        const backoff = CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
        await new Promise(r => setTimeout(r, backoff));
      }
    }
    throw new Error('capture failed unexpectedly');
  }

  // Load an image element from a data URL
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
  }

  // Convert canvas to blob (promisified)
  function canvasToBlob(canvas, type = 'image/png', quality = 0.92) {
    return new Promise((resolve) => {
      canvas.toBlob(blob => resolve(blob), type, quality);
    });
  }

  // Download a blob with a filename
  function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    // Some pages block click()-based downloads inside certain contexts; append to body to be safe
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  // Main capture flow
  async function startCapture() {
    // Basic safeguards
    if (!document.body) throw new Error('No document body found');

    // Get scroll container (most pages use document.scrollingElement)
    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;

    // Page metrics
    const totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;

    // Hide fixed/sticky elements heuristically
    const fixedEls = Array.from(document.querySelectorAll('*')).filter(el => {
      const s = getComputedStyle(el);
      return (s.position === 'fixed' || s.position === 'sticky') &&
             s.display !== 'none' &&
             el.offsetParent !== null;
    });
    const fixedCache = fixedEls.map(el => ({ el, orig: { visibility: el.style.visibility, pointerEvents: el.style.pointerEvents } }));
    fixedEls.forEach(el => { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; });

    // Prevent scrollbar shifts
    scrollingEl.style.overflow = 'hidden';

    // Build capture Y positions (ensuring last chunk reaches bottom)
    const positions = [];
    for (let y = 0; y < totalHeight; y += viewportHeight) {
      positions.push(Math.min(y, totalHeight - viewportHeight));
      if (y + viewportHeight >= totalHeight) break;
    }

    // Capture each viewport safely
    const capturedDataUrls = [];
    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      scrollingEl.scrollTo({ top: y, left: 0, behavior: 'instant' });

      // Give the page time to paint and lazy-load content.
      // We intentionally wait enough to avoid the capture quota errors.
      await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));

      // Do the safe capture with retries/throttle
      const dataUrl = await safeCapture();
      capturedDataUrls.push(dataUrl);
    }

    // Restore scroll & styles early
    scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
    scrollingEl.style.overflow = originalOverflow;
    fixedCache.forEach(item => {
      item.el.style.visibility = item.orig.visibility || '';
      item.el.style.pointerEvents = item.orig.pointerEvents || '';
    });

    // Convert captured data URLs to image elements and get sizes
    const images = [];
    for (const d of capturedDataUrls) {
      const img = await loadImage(d);
      images.push({ img, width: img.width, height: img.height });
    }

    // Helper: stitch a set of images vertically into a canvas and return a blob
    async function stitchImagesToBlob(imgItems, mime = 'image/png', quality = 0.92) {
      // Determine canvas size (width = max width, height = sum heights)
      const w = Math.max(...imgItems.map(it => it.width));
      const h = imgItems.reduce((sum, it) => sum + it.height, 0);

      // Create canvas (note: very large canvases may fail in some browsers)
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
      return { blob, width: w, height: h };
    }

    // Build batches so each final blob is <= MAX_BYTES
    const batches = [];
    let currentBatch = [];

    for (let i = 0; i < images.length; i++) {
      const candidate = images[i];
      const tryBatch = currentBatch.concat([candidate]);

      // Test-stitch the tryBatch and check size
      const { blob: testBlob } = await stitchImagesToBlob(tryBatch);

      if (testBlob.size <= MAX_BYTES) {
        // Accept candidate into current batch
        currentBatch = tryBatch;
      } else {
        if (currentBatch.length === 0) {
          // Single candidate itself exceeds MAX_BYTES. Try downscaling it (50%) as fallback.
          console.warn('Single chunk exceeds 20MB, attempting scaling on index', i);

          // scale down the single image by 50% (reduces size significantly)
          const it = candidate;
          const tmpCanvas = document.createElement('canvas');
          tmpCanvas.width = Math.max(1, Math.floor(it.width / 2));
          tmpCanvas.height = Math.max(1, Math.floor(it.height / 2));
          const tctx = tmpCanvas.getContext('2d');
          tctx.drawImage(it.img, 0, 0, tmpCanvas.width, tmpCanvas.height);
          const scaledBlob = await canvasToBlob(tmpCanvas, 'image/png', 0.9);

          if (scaledBlob.size <= MAX_BYTES) {
            batches.push({ blob: scaledBlob, info: `scaled_single_${i}` });
            currentBatch = [];
          } else {
            // If still too large, push as-is (user will get >20MB)
            batches.push({ blob: testBlob, info: `single_too_large_${i}` });
            currentBatch = [];
          }
        } else {
          // Finalize currentBatch and start new batch with candidate
          const { blob: finalized } = await stitchImagesToBlob(currentBatch);
          batches.push({ blob: finalized, info: `batch_${batches.length}` });

          // Start with candidate as new currentBatch
          currentBatch = [candidate];

          // Edge: ensure candidate alone isn't > MAX_BYTES; loop will handle it next pass
        }
      }
    }

    // Finalize any remaining currentBatch
    if (currentBatch.length > 0) {
      const { blob } = await stitchImagesToBlob(currentBatch);
      batches.push({ blob, info: `batch_${batches.length}` });
    }

    // Download each batch with sensible filename (hostname + index)
    const urlBase = (new URL(location.href)).hostname.replace(/\./g, '_').replace(/[:]/g, '_');
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      const filename = `${urlBase}_fullpage_${i + 1}.png`;
      downloadBlob(b.blob, filename);
    }

    alert(`Capture complete — downloaded ${batches.length} image(s).`);
  }

})();
