// contentScript.js
// Full-page capture script
// MODIFIED: Added logic to temporarily hide fixed/sticky headers during capture.
// - No forced zoom, no hiding fixed/sticky elements
// - Disables scrolling during capture and restores afterwards
// - Encoding sequence per batch: JPG(0.97) -> JPG(0.95) -> WebP(0.97) -> WebP(0.92)
// - Max per-file size: 24 MB
// - Uses background message { action: 'capture-visible' } to get visible capture dataUrl

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 24 * 1024 * 1024; // 24 MB limit
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;

  // Encoding qualities
  const JPEG_QUALITY_HIGH = 0.97; // first try JPG
  const JPEG_QUALITY = 0.95;      // second try JPG
  const WEBP_QUALITY_HIGH = 0.97; // third try WebP
  const WEBP_QUALITY_FALLBACK = 0.92; // final try WebP

  // Safe canvas max height to avoid browser limits (tweak if needed)
  const MAX_CANVAS_HEIGHT = 30000; // px

  // --- STICKY/FIXED HEADER HIDING CONFIG ---
  // IMPORTANT: You might need to adjust these selectors for the specific website.
  // These are common selectors for sticky elements.
  const FIXED_ELEMENT_SELECTORS = [
    'header',
    '.fixed',
    '.sticky',
    '[style*="position: fixed"]',
    '[style*="position: sticky"]'
  ];
  // ------------------------------------------

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
        try {
          chrome.runtime.sendMessage({ action: 'capture-visible' }, resolve);
        } catch (err) {
          resolve({ success: false, error: err && err.message });
        }
      });
      lastCaptureTs = Date.now();

      if (res && res.success && res.dataUrl) return res.dataUrl;
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
      img.onerror = (e) => reject(new Error('Image load error'));
      img.src = dataUrl;
    });
  }

  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.95) {
    return new Promise((resolve) => {
      // toBlob may provide null in rare cases; resolve null to be checked by caller
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
    // revoke after short delay to ensure download has started
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function timestamp() {
    return (new Date()).toISOString().replace(/[:.]/g, '-');
  }

  // Split images into height-constrained batches to avoid huge canvases
  function makeBatchesByHeight(images, maxHeight = MAX_CANVAS_HEIGHT) {
    const batches = [];
    let current = [];
    let currentH = 0;
    for (const img of images) {
      // If single tile exceeds maxHeight, still put it in its own batch (risk-y but necessary)
      if (img.height > maxHeight) {
        if (current.length) {
          batches.push(current);
          current = [];
          currentH = 0;
        }
        batches.push([img]);
        continue;
      }
      if (currentH + img.height > maxHeight) {
        if (current.length) batches.push(current);
        current = [img];
        currentH = img.height;
      } else {
        current.push(img);
        currentH += img.height;
      }
    }
    if (current.length) batches.push(current);
    return batches;
  }

  // Stitch an array of image items vertically into a canvas blob
  async function stitchImagesToBlob(imgItems, mime = 'image/jpeg', quality = 0.95) {
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
  
  // New utility to collect and temporarily hide fixed elements
  function hideFixedElements(selectors) {
    const elementsToRestore = [];
    for (const selector of selectors) {
      try {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          // Check for fixed/sticky position before hiding
          const style = window.getComputedStyle(el);
          const position = style.getPropertyValue('position');

          // Only proceed if the element is actually fixed/sticky
          if (position === 'fixed' || position === 'sticky') {
            const originalDisplay = el.style.getPropertyValue('display');
            const originalImportance = el.style.getPropertyPriority('display');
            
            elementsToRestore.push({ el, originalDisplay, originalImportance });
            
            // Hide element
            el.style.setProperty('display', 'none', 'important');
          }
        });
      } catch (e) {
        console.warn(`Error querying selector '${selector}':`, e);
      }
    }
    return elementsToRestore;
  }

  // New utility to restore elements
  function restoreFixedElements(elementsToRestore) {
    elementsToRestore.forEach(({ el, originalDisplay, originalImportance }) => {
      // Restore original display style
      if (originalDisplay) {
        el.style.setProperty('display', originalDisplay, originalImportance);
      } else {
        el.style.removeProperty('display');
      }
    });
  }


  // Main flow
  async function startCapture() {
    if (!document.body) throw new Error('No document body found');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    
    // --- NEW: Identify and hide fixed/sticky elements ---
    const elementsToRestore = hideFixedElements(FIXED_ELEMENT_SELECTORS);
    
    // Calculate full page positions BEFORE capturing
    const totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportHeight = window.innerHeight;

    // Prevent page jumps during capture
    try {
      scrollingEl.style.overflow = 'hidden';
    } catch (e) {
      // ignore if cannot set
    }

    const positions = [];
    for (let y = 0; y < totalHeight; y += viewportHeight) {
      positions.push(Math.min(y, totalHeight - viewportHeight));
      if (y + viewportHeight >= totalHeight) break;
    }

    const capturedDataUrls = [];
    try {
      for (const y of positions) {
        // scroll to position (behavior auto for compatibility)
        scrollingEl.scrollTo({ top: y, left: 0, behavior: 'auto' });
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }
    } finally {
      // restore scroll/overflow AND fixed elements
      try {
        scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'auto' });
        scrollingEl.style.overflow = originalOverflow;
      } catch (e) { /* ignore */ }
      
      // --- NEW: Restore fixed/sticky elements ---
      restoreFixedElements(elementsToRestore);
    }
    
    // Load captured dataUrls into Image objects
    const images = [];
    for (let idx = 0; idx < capturedDataUrls.length; idx++) {
      const d = capturedDataUrls[idx];
      try {
        const img = await loadImage(d);
        images.push({ img, width: img.width, height: img.height });
      } catch (err) {
        console.warn('Failed to load tile', idx, err);
        // Skip this tile — proceed with others
      }
    }

    if (images.length === 0) throw new Error('No captured images to stitch');

    // Break into safe height batches
    const heightBatches = makeBatchesByHeight(images, MAX_CANVAS_HEIGHT);

    const outputs = []; // { blob, ext, partIndex }
    let partCounter = 0;
    for (let b = 0; b < heightBatches.length; b++) {
      const batch = heightBatches[b];

      // Try sequence on this batch: JPG(0.97) -> JPG(0.95) -> WEBP(0.97) -> WEBP(0.92)
      // 1) JPG 0.97
      let attempt = await stitchImagesToBlob(batch, 'image/jpeg', JPEG_QUALITY_HIGH);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
        partCounter++;
        outputs.push({ blob: attempt.blob, ext: 'jpg', partIndex: partCounter });
        continue;
      }

      // 2) JPG 0.95
      attempt = await stitchImagesToBlob(batch, 'image/jpeg', JPEG_QUALITY);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
        partCounter++;
        outputs.push({ blob: attempt.blob, ext: 'jpg', partIndex: partCounter });
        continue;
      }

      // 3) WEBP 0.97
      attempt = await stitchImagesToBlob(batch, 'image/webp', WEBP_QUALITY_HIGH);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
        partCounter++;
        outputs.push({ blob: attempt.blob, ext: 'webp', partIndex: partCounter });
        continue;
      }

      // 4) WEBP 0.92
      attempt = await stitchImagesToBlob(batch, 'image/webp', WEBP_QUALITY_FALLBACK);
      if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
        partCounter++;
        outputs.push({ blob: attempt.blob, ext: 'webp', partIndex: partCounter });
        continue;
      }

      // Safety: If even WEBP 0.92 exceeds MAX_BYTES (unexpected), split the batch into single-image parts
      // and encode each separately (very unlikely unless individual tiles are huge).
      for (let i = 0; i < batch.length; i++) {
        const single = [batch[i]];
        let sAttempt = await stitchImagesToBlob(single, 'image/webp', WEBP_QUALITY_FALLBACK);
        if (sAttempt.blob) {
          if (sAttempt.blob.size <= MAX_BYTES) {
            partCounter++;
            outputs.push({ blob: sAttempt.blob, ext: 'webp', partIndex: partCounter });
          } else {
            // If even a single tile is too big, still push it (user may prefer it) — but warn in console
            console.warn('Single tile exceeds MAX_BYTES; pushing as-is', sAttempt.blob.size);
            partCounter++;
            outputs.push({ blob: sAttempt.blob, ext: 'webp', partIndex: partCounter });
          }
        }
      }
    }

    // Save outputs with timestamped filenames
    const base = (new URL(location.href)).hostname.replace(/\./g, '_');
    const ts = timestamp();
    for (const out of outputs) {
      const filename = out.partIndex > 1
        ? `${base}_part${out.partIndex}_${ts}.${out.ext}`
        : `${base}_fullpage_${ts}.${out.ext}`;
      downloadBlob(out.blob, filename);
    }

    if (outputs.length === 0) {
      throw new Error('Failed to produce any output blobs');
    }

    // Inform user (brief)
    if (outputs.length === 1) {
      alert(`Saved 1 file (${Math.round(outputs[0].blob.size / 1024 / 1024)} MB): ${base}_fullpage_${ts}.${outputs[0].ext}`);
    } else {
      alert(`Saved ${outputs.length} file(s).`);
    }
  }

})();
