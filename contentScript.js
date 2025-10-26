// contentScript.js
// Full-page capture script
// FINAL VERSION: Incorporates CSS Freeze and Aggressive Pre-Stabilization for maximum stability.
// 
// MODIFICATIONS SUMMARY: 
// 1. **CRITICAL FIX**: Implemented a global CSS freeze to disable all transitions and animations
//    during capture, eliminating content toggling and mismatch between tiles.
// 2. Aggressive "Scroll to Bottom" technique used to force all lazy content to render.
// 3. Dynamic scrolling loop maintained to handle main page reflows.
// 4. CAPTURE_DELAY_MS kept at 550ms.

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 24 * 1024 * 1024; // 24 MB limit
  const CAPTURE_DELAY_MS = 550;       // Kept at 550ms
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;
  const PRE_SCROLL_STABILIZATION_MS = 1000; // Dedicated wait after forcing content load

  // Encoding qualities
  const JPEG_QUALITY_HIGH = 0.97;
  const JPEG_QUALITY = 0.95;
  const WEBP_QUALITY_HIGH = 0.97;
  const WEBP_QUALITY_FALLBACK = 0.92;

  // Safe canvas max height to avoid browser limits
  const MAX_CANVAS_HEIGHT = 30000; // px

  // ID for the temporary style element used for the CSS freeze
  const FREEZE_STYLE_ID = '__fullpage_capture_freeze';

  let lastCaptureTs = 0;

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => {
        console.error('Capture failed', e);
        console.log('Capture failed: ' + (e && e.message ? e.message : e));
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
  
  // UTILITY: Apply the CSS freeze rule (Disables animations, transitions, and fixed/sticky)
  function applyFreezeStyle() {
    let styleEl = document.getElementById(FREEZE_STYLE_ID);
    if (styleEl) return;

    styleEl = document.createElement('style');
    styleEl.id = FREEZE_STYLE_ID;
    
    // Aggressive CSS rule to halt all motion and positioning tied to viewport
    styleEl.textContent = `
      *, ::before, ::after {
        transition: none !important;
        animation: none !important;
        scroll-behavior: auto !important;
        /* Force fixed/sticky elements to static position (handles header repetition) */
        position: static !important;
        top: auto !important;
        bottom: auto !important;
        left: auto !important;
        right: auto !important;
        transform: none !important;
      }
    `;
    document.head.appendChild(styleEl);
  }

  // UTILITY: Remove the CSS freeze rule
  function removeFreezeStyle() {
    const styleEl = document.getElementById(FREEZE_STYLE_ID);
    if (styleEl) {
      styleEl.remove();
    }
  }
  
  // UTILITY: Aggressive stabilization routine (Scrolls to bottom/up to trigger all lazy loading)
  async function preStabilizeDOM(scrollingEl) {
    console.log('Forcing full DOM render by scrolling to bottom to stabilize height...');
    
    // Find a target element at the bottom of the page
    let bottomElement = document.querySelector('footer, .footer, #footer, body');
    
    if (!bottomElement) {
        bottomElement = document.body;
    }

    // Use scrollIntoView to force the entire page contents to render
    bottomElement.scrollIntoView({ behavior: 'auto', block: 'end' });
    
    // Wait for content to load, images to trigger, and DOM reflow to finish
    await new Promise(r => setTimeout(r, PRE_SCROLL_STABILIZATION_MS));
    
    // Restore the scroll position to the very top before starting the capture
    scrollingEl.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    
    // Wait for the final scroll-up to settle
    await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
    
    console.log('Pre-stabilization complete.');
  }


  // Main flow
  async function startCapture() {
    if (!document.body) throw new Error('No document body found');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const finalScrollRestore = scrollingEl.scrollTop;
    
    // 1. CRITICAL: Apply the global CSS freeze to prevent all animation/transition state changes
    applyFreezeStyle();
    
    // 2. Aggressive DOM Pre-Stabilization: Forces lazy content to render
    await preStabilizeDOM(scrollingEl); 
    
    const viewportHeight = window.innerHeight;
    const capturedDataUrls = [];

    // Prevent main page jumps during capture
    try {
      scrollingEl.style.overflow = 'hidden';
    } catch (e) {
      // ignore if cannot set
    }
    
    // 3. Dynamic Scrolling Loop
    let currentScrollTop = 0;
    
    try {
      // Wait once more after stabilization and scroll to top
      await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
      
      // Capture the first tile (y=0)
      const dataUrl0 = await safeCapture();
      capturedDataUrls.push(dataUrl0);

      // Loop until we reach the bottom of the scrollable content
      while (true) {
        // Calculate next target position
        let targetScrollTop = currentScrollTop + viewportHeight;

        // Scroll to the target position
        scrollingEl.scrollTo({ top: targetScrollTop, left: 0, behavior: 'auto' });
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS)); 

        // Update current position after scroll (crucial for handling reflows)
        currentScrollTop = scrollingEl.scrollTop;
        
        // Check if we've reached the bottom
        const maxScrollTop = scrollingEl.scrollHeight - viewportHeight;
        const isAtBottom = currentScrollTop >= maxScrollTop;

        // Capture the tile
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);

        // If we are at the very bottom, break the loop
        if (isAtBottom) break;
        
        // Safety break
        if (capturedDataUrls.length > 50) { 
          console.warn('Reached safety limit of 50 tiles.');
          break;
        }
      }

    } finally {
      // 4. Cleanup: Restore original state
      
      // Restore scroll/overflow
      try {
        // Use the saved scroll top from before capture started
        scrollingEl.scrollTo({ top: finalScrollRestore, left: 0, behavior: 'auto' }); 
        scrollingEl.style.overflow = originalOverflow;
      } catch (e) { /* ignore */ }
      
      // Remove the global CSS freeze style
      removeFreezeStyle();
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
      console.log(`Saved 1 file (${Math.round(outputs[0].blob.size / 1024 / 1024)} MB): ${base}_fullpage_${ts}.${outputs[0].ext}`);
    } else {
      console.log(`Saved ${outputs.length} file(s).`);
    }
  }

})();
