// contentScript_select_and_crop_header.js
// Full flow: user selects header (drag/click) -> measure header height -> capture tiles -> crop header pixels from subsequent tiles -> stitch & save
// - No DOM modifications to the header (cropping only)
// - Uses background message { action: 'capture-visible' } which should call chrome.tabs.captureVisibleTab and return { success:true, dataUrl }

(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // ---- Configuration ----
  const MAX_BYTES = 24 * 1024 * 1024; // 24 MB
  const CAPTURE_DELAY_MS = 550;
  const CAPTURE_MAX_RETRIES = 3;
  const CAPTURE_RETRY_BASE_DELAY = 300;

  const JPEG_QUALITY_HIGH = 0.97; // first try JPG
  const JPEG_QUALITY = 0.95;      // second try JPG
  const WEBP_QUALITY_HIGH = 0.97; // third try WebP
  const WEBP_QUALITY_FALLBACK = 0.92; // final try WebP

  const MAX_CANVAS_HEIGHT = 30000; // batch stitching height

  // If seams appear, you can adjust this (in image pixels) to tune cropping
  const adjustPixels = 0; // e.g., -2, +2 to shrink/grow cropped region

  // ------------------------

  // Utility helpers
  function $(s) { return document.querySelector(s); }
  function timestamp() { return (new Date()).toISOString().replace(/[:.]/g, '-'); }

  // Canvas helpers
  function canvasToBlob(canvas, type = 'image/jpeg', quality = 0.95) {
    return new Promise(resolve => canvas.toBlob(blob => resolve(blob), type, quality));
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

  // Capture helper expects background to handle capture-visible
  let lastCaptureTs = 0;
  async function safeCapture() {
    const now = Date.now();
    const since = now - lastCaptureTs;
    if (since < CAPTURE_DELAY_MS) await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS - since));

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
        throw new Error(res?.error || 'capture failed');
      }
      const backoff = CAPTURE_RETRY_BASE_DELAY * Math.pow(2, attempt - 1);
      await new Promise(r => setTimeout(r, backoff));
    }
  }

  // Load image from dataUrl
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('Image load error'));
      img.src = dataUrl;
    });
  }

  // Stitch array of images vertically into a blob (mime, quality)
  async function stitchImagesToBlob(imgItems, mime = 'image/jpeg', quality = 0.95) {
    if (!imgItems || imgItems.length === 0) return { blob: null, width: 0, height: 0, mime };
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

  // Make batches by total height to keep canvases under MAX_CANVAS_HEIGHT
  function makeBatchesByHeight(images, maxHeight = MAX_CANVAS_HEIGHT) {
    const batches = [];
    let current = [];
    let currentH = 0;
    for (const img of images) {
      if (img.height > maxHeight) {
        if (current.length) { batches.push(current); current = []; currentH = 0; }
        batches.push([img]); // single big tile (risky but included)
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

  // Crop top 'cropPx' pixels from an Image object and return new image-like object { img, width, height }
  async function cropTopFromImage(img, cropPx) {
    if (!img || cropPx <= 0) return { img, width: img.width, height: img.height };
    const cw = img.width;
    const ch = img.height - cropPx;
    if (ch <= 0) return null; // nothing left after cropping
    const canvas = document.createElement('canvas');
    canvas.width = cw;
    canvas.height = ch;
    const ctx = canvas.getContext('2d');
    // draw source image from y=cropPx into dest y=0
    ctx.drawImage(img, 0, cropPx, cw, ch, 0, 0, cw, ch);
    const dataUrl = canvas.toDataURL('image/png'); // intermediate lossless
    const newImg = await loadImage(dataUrl);
    return { img: newImg, width: newImg.width, height: newImg.height };
  }

  // UI: selection overlay
  function createSelectionUI() {
    // overlay
    const overlay = document.createElement('div');
    overlay.id = '__fullpage_select_overlay';
    Object.assign(overlay.style, {
      position: 'fixed', left: '0', top: '0', right: '0', bottom: '0',
      zIndex: 2147483646, // very high
      cursor: 'crosshair',
      background: 'rgba(0,0,0,0.07)'
    });

    // selection rectangle
    const rect = document.createElement('div');
    rect.id = '__fullpage_select_rect';
    Object.assign(rect.style, {
      position: 'fixed',
      border: '2px dashed #0b84ff',
      background: 'rgba(11,132,255,0.08)',
      display: 'none',
      zIndex: 2147483647,
      pointerEvents: 'none'
    });

    // instruction box
    const instr = document.createElement('div');
    instr.id = '__fullpage_select_instr';
    Object.assign(instr.style, {
      position: 'fixed',
      left: '12px',
      top: '12px',
      zIndex: 2147483647,
      background: '#fff',
      color: '#111',
      padding: '8px 10px',
      borderRadius: '6px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.15)',
      fontFamily: 'Arial, sans-serif',
      fontSize: '13px'
    });
    instr.innerText = 'Drag to select the header area (or click). Press ESC to cancel.';

    document.documentElement.appendChild(overlay);
    document.documentElement.appendChild(rect);
    document.documentElement.appendChild(instr);

    return { overlay, rect, instr };
  }

  // Highlight candidate elements (outline) and show confirm UI
  function showCandidatesAndConfirm(candidates, onConfirm, onRetry, onCancel) {
    // highlight wrappers
    const highlights = [];
    for (const el of candidates) {
      const o = el.getBoundingClientRect();
      const h = document.createElement('div');
      Object.assign(h.style, {
        position: 'fixed',
        left: `${o.left}px`,
        top: `${o.top}px`,
        width: `${o.width}px`,
        height: `${o.height}px`,
        border: '2px solid rgba(255,165,0,0.95)',
        background: 'rgba(255,165,0,0.06)',
        zIndex: 2147483647,
        pointerEvents: 'none',
        boxSizing: 'border-box'
      });
      document.documentElement.appendChild(h);
      highlights.push(h);
    }

    // confirm panel
    const panel = document.createElement('div');
    Object.assign(panel.style, {
      position: 'fixed',
      right: '12px',
      top: '12px',
      zIndex: 2147483647,
      background: '#fff',
      padding: '8px',
      borderRadius: '6px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.15)',
      fontFamily: 'Arial, sans-serif',
      fontSize: '13px',
      display: 'flex',
      gap: '8px',
      alignItems: 'center'
    });

    const label = document.createElement('div');
    label.innerText = 'Use selected header?';
    const ok = document.createElement('button');
    ok.innerText = 'Yes';
    const retry = document.createElement('button');
    retry.innerText = 'Retry';
    const cancel = document.createElement('button');
    cancel.innerText = 'Cancel';

    [ok, retry, cancel].forEach(b => {
      Object.assign(b.style, { padding: '6px 8px', cursor: 'pointer', borderRadius: '4px', border: '1px solid #ccc', background: '#fff' });
    });
    ok.style.background = '#0b84ff'; ok.style.color = '#fff'; ok.style.borderColor = '#0b84ff';

    panel.appendChild(label);
    panel.appendChild(ok);
    panel.appendChild(retry);
    panel.appendChild(cancel);
    document.documentElement.appendChild(panel);

    function cleanup() {
      highlights.forEach(h => h.remove());
      panel.remove();
    }

    ok.addEventListener('click', () => { cleanup(); onConfirm(); });
    retry.addEventListener('click', () => { cleanup(); onRetry(); });
    cancel.addEventListener('click', () => { cleanup(); onCancel(); });
  }

  // Convert selection rect to candidate elements via intersection threshold
  function elementsIntersectingRect(selectionRect, minFraction = 0.2) {
    // selectionRect is { left, top, width, height } viewport CSS px
    const els = Array.from(document.querySelectorAll('body *'));
    const rectArea = selectionRect.width * selectionRect.height;
    const candidates = [];
    for (const el of els) {
      try {
        const s = getComputedStyle(el);
        if (s.display === 'none' || s.visibility === 'hidden') continue;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        // compute intersection area
        const ix = Math.max(0, Math.min(r.right, selectionRect.left + selectionRect.width) - Math.max(r.left, selectionRect.left));
        const iy = Math.max(0, Math.min(r.bottom, selectionRect.top + selectionRect.height) - Math.max(r.top, selectionRect.top));
        const interArea = ix * iy;
        // element area
        const elArea = r.width * r.height;
        // consider element if intersects selection by fraction of element or fraction of selection
        const fracEl = interArea / elArea;
        const fracSel = interArea / rectArea;
        if (fracEl >= minFraction || fracSel >= minFraction) {
          candidates.push(el);
        }
      } catch (e) {
        // ignore cross-origin or other exceptions
      }
    }
    // prefer elements that are at top (small top value) and fixed/sticky
    candidates.sort((a, b) => {
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const sa = (getComputedStyle(a).position === 'fixed' || getComputedStyle(a).position === 'sticky') ? 0 : 1;
      const sb = (getComputedStyle(b).position === 'fixed' || getComputedStyle(b).position === 'sticky') ? 0 : 1;
      if (sa !== sb) return sa - sb;
      return ra.top - rb.top || rb.height - ra.height;
    });
    return candidates;
  }

  // Pick a reasonable container ancestor for the candidates (stop at body/html)
  function pickBestContainer(candidates) {
    if (!candidates || candidates.length === 0) return null;
    // take the top candidate and climb until we find a container covering substantial width
    let el = candidates[0];
    let best = el;
    const docW = document.documentElement.clientWidth || window.innerWidth;
    while (el && el !== document.body && el !== document.documentElement) {
      const r = el.getBoundingClientRect();
      // prefer elements that span most of width or are fixed/sticky
      if ((r.width / docW) > 0.6 || getComputedStyle(el).position === 'fixed' || getComputedStyle(el).position === 'sticky') {
        best = el;
        break;
      }
      el = el.parentElement;
    }
    return best;
  }

  // Main: start user selection flow
  async function runSelectionThenCapture() {
    // Create UI
    const { overlay, rect, instr } = createSelectionUI();

    let startX = 0, startY = 0, selecting = false;

    function removeOverlay() {
      try { overlay.remove(); rect.remove(); instr.remove(); } catch (e) {}
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('keydown', onKeyDown);
    }

    function onKeyDown(e) {
      if (e.key === 'Escape') {
        removeOverlay();
        alert('Selection cancelled.');
      }
    }

    function onMouseDown(e) {
      selecting = true;
      startX = e.clientX; startY = e.clientY;
      rect.style.left = `${startX}px`;
      rect.style.top = `${startY}px`;
      rect.style.width = '0px';
      rect.style.height = '0px';
      rect.style.display = 'block';
    }

    function onMouseMove(e) {
      if (!selecting) return;
      const x = Math.min(e.clientX, startX);
      const y = Math.min(e.clientY, startY);
      const w = Math.abs(e.clientX - startX);
      const h = Math.abs(e.clientY - startY);
      rect.style.left = `${x}px`; rect.style.top = `${y}px`;
      rect.style.width = `${w}px`; rect.style.height = `${h}px`;
    }

    async function finalizeSelection() {
      selecting = false;
      const rstyle = rect.style;
      const sel = {
        left: parseFloat(rstyle.left || 0),
        top: parseFloat(rstyle.top || 0),
        width: parseFloat(rstyle.width || 0),
        height: parseFloat(rstyle.height || 0)
      };
      // if user clicked without dragging, try elementFromPoint at click
      if (sel.width === 0 || sel.height === 0) {
        // take center point of click
        const x = startX, y = startY;
        const el = document.elementFromPoint(x, y);
        if (!el) {
          alert('No element found at click point. Try dragging a rectangle instead.');
          return onRetry();
        }
        const crect = el.getBoundingClientRect();
        sel.left = crect.left; sel.top = crect.top; sel.width = crect.width; sel.height = crect.height;
      }

      // find candidate elements intersecting
      const candidates = elementsIntersectingRect(sel, 0.2);
      const container = pickBestContainer(candidates);
      if (!container) {
        alert('Could not identify header element. Try again and select a larger area around the header.');
        return onRetry();
      }

      // show highlights and confirmation
      showCandidatesAndConfirm([container], async () => {
        // on confirm
        removeOverlay();
        await proceedWithHeaderContainer(container);
      }, () => {
        // retry
        onRetry();
      }, () => {
        // cancel
        removeOverlay();
        alert('Selection cancelled.');
      });
    }

    function onMouseUp(e) {
      if (!selecting) return;
      finalizeSelection().catch(err => {
        console.error(err);
        alert('Selection failed: ' + (err && err.message));
        onRetry();
      });
    }

    function onRetry() {
      // reset rect and keep overlay
      rect.style.display = 'none';
      rect.style.left = '0px'; rect.style.top = '0px'; rect.style.width = '0px'; rect.style.height = '0px';
    }

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mousemove', onMouseMove);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('keydown', onKeyDown);
  }

  // After user picks container, proceed with capture + cropping stitching
  async function proceedWithHeaderContainer(container) {
    if (!container) { alert('No container provided'); return; }

    // Measure header bounding rect (CSS pixels)
    const rect = container.getBoundingClientRect();
    const headerCssHeight = Math.max(0, rect.height);
    const dpr = window.devicePixelRatio || 1;
    let headerImgHeight = Math.round(headerCssHeight * dpr) + adjustPixels;
    if (headerImgHeight < 0) headerImgHeight = 0;

    // Inform user
    const proceed = confirm(`Header detected with CSS height ${Math.round(headerCssHeight)} px. `
      + `Image pixel crop will be ${headerImgHeight} px (devicePixelRatio ${dpr}).\n\nProceed with capture?`);
    if (!proceed) { alert('Capture cancelled by user.'); return; }

    // Capture flow: first tile kept intact, subsequent tiles cropped
    try {
      await captureAndCropFlow(headerImgHeight);
    } catch (err) {
      console.error(err);
      alert('Capture failed: ' + (err && err.message));
    }
  }

  // Main capture/crop/stitch/save flow
  async function captureAndCropFlow(headerImgHeight) {
    if (!document.body) throw new Error('No document body');

    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;

    try {
      // Freeze scrolling to avoid jumps
      try { scrollingEl.style.overflow = 'hidden'; } catch (e) {}

      // calculate capture positions (regular viewport stepping)
      const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
      const viewportHeight = window.innerHeight;
      const positions = [];
      for (let y = 0; y < totalHeight; y += viewportHeight) {
        positions.push(Math.min(y, totalHeight - viewportHeight));
        if (y + viewportHeight >= totalHeight) break;
      }

      // Capture each position
      const capturedDataUrls = [];
      for (let i = 0; i < positions.length; i++) {
        const y = positions[i];
        scrollingEl.scrollTo({ top: y, left: 0, behavior: 'auto' });
        await new Promise(r => setTimeout(r, CAPTURE_DELAY_MS));
        const dataUrl = await safeCapture();
        capturedDataUrls.push(dataUrl);
      }

      // restore scroll/overflow
      try { scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'auto' }); scrollingEl.style.overflow = originalOverflow; } catch (e) {}

      // Convert to Image objects
      const images = [];
      for (let i = 0; i < capturedDataUrls.length; i++) {
        const dataUrl = capturedDataUrls[i];
        try {
          const img = await loadImage(dataUrl);
          images.push({ img, width: img.width, height: img.height });
        } catch (e) {
          console.warn('Failed to load tile', i, e);
        }
      }

      if (images.length === 0) throw new Error('No captured images');

      // Crop subsequent tiles (all except first) by headerImgHeight image pixels
      const processedImages = [];
      // First tile: keep whole
      processedImages.push(images[0]);

      for (let i = 1; i < images.length; i++) {
        const it = images[i];
        if (!it || !it.img) continue;
        const cropped = await cropTopFromImage(it.img, headerImgHeight);
        if (!cropped) {
          // if cropping removed everything, skip this tile
          console.warn('Tile fully cropped (skip)', i);
          continue;
        }
        processedImages.push({ img: cropped.img, width: cropped.width, height: cropped.height });
      }

      if (processedImages.length === 0) throw new Error('No images after cropping');

      // stitch in safe batches and encode with quality sequence per batch
      const batches = makeBatchesByHeight(processedImages, MAX_CANVAS_HEIGHT);
      const outputs = [];
      let partCounter = 0;

      for (const batch of batches) {
        // Try JPG 0.97
        let attempt = await stitchImagesToBlob(batch, 'image/jpeg', JPEG_QUALITY_HIGH);
        if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
          partCounter++; outputs.push({ blob: attempt.blob, ext: 'jpg', partIndex: partCounter });
          continue;
        }
        // JPG 0.95
        attempt = await stitchImagesToBlob(batch, 'image/jpeg', JPEG_QUALITY);
        if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
          partCounter++; outputs.push({ blob: attempt.blob, ext: 'jpg', partIndex: partCounter });
          continue;
        }
        // WEBP 0.97
        attempt = await stitchImagesToBlob(batch, 'image/webp', WEBP_QUALITY_HIGH);
        if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
          partCounter++; outputs.push({ blob: attempt.blob, ext: 'webp', partIndex: partCounter });
          continue;
        }
        // WEBP 0.92
        attempt = await stitchImagesToBlob(batch, 'image/webp', WEBP_QUALITY_FALLBACK);
        if (attempt.blob && attempt.blob.size <= MAX_BYTES) {
          partCounter++; outputs.push({ blob: attempt.blob, ext: 'webp', partIndex: partCounter });
          continue;
        }

        // safety: split single tiles within batch
        for (const single of batch) {
          const sa = await stitchImagesToBlob([single], 'image/webp', WEBP_QUALITY_FALLBACK);
          if (sa.blob) { partCounter++; outputs.push({ blob: sa.blob, ext: 'webp', partIndex: partCounter }); }
        }
      }

      // Save outputs
      const base = (new URL(location.href)).hostname.replace(/\./g, '_');
      const ts = timestamp();
      for (const out of outputs) {
        const filename = out.partIndex > 1 ? `${base}_part${out.partIndex}_${ts}.${out.ext}` : `${base}_fullpage_${ts}.${out.ext}`;
        downloadBlob(out.blob, filename);
      }

      if (outputs.length === 0) throw new Error('No output produced');

      if (outputs.length === 1) {
        alert(`Saved 1 file (${Math.round(outputs[0].blob.size / 1024 / 1024)} MB).`);
      } else {
        alert(`Saved ${outputs.length} files.`);
      }
    } finally {
      // ensure we restore overflow & scroll even on error
      try { scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'auto' }); scrollingEl.style.overflow = originalOverflow; } catch (e) {}
    }
  }

  // Entry: expose a small UI to begin selection flow (or you can run automatically)
  function addStarterButton() {
    // small floating button
    const btn = document.createElement('button');
    btn.id = '__fullpage_start_select';
    btn.innerText = 'Select header for fullpage capture';
    Object.assign(btn.style, {
      position: 'fixed',
      right: '12px',
      bottom: '12px',
      zIndex: 2147483647,
      background: '#0b84ff',
      color: '#fff',
      border: 'none',
      padding: '10px 12px',
      borderRadius: '8px',
      boxShadow: '0 6px 18px rgba(0,0,0,0.18)',
      cursor: 'pointer',
      fontFamily: 'Arial,sans-serif',
      fontSize: '13px'
    });

    btn.addEventListener('click', async () => {
      btn.remove();
      try {
        await runSelectionThenCapture();
      } catch (err) {
        console.error(err);
        alert('Selection/capture error: ' + (err && err.message));
      } finally {
        // re-add button so user can run again
        setTimeout(addStarterButton, 300);
      }
    });

    document.documentElement.appendChild(btn);
  }

  // Auto add button when script loads
  addStarterButton();

  // Optionally you could wire this to chrome.runtime.onMessage('start-capture') too.
})();
