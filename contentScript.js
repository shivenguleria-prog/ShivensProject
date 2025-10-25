// contentScript.js
(() => {
  if (window.__FULLPAGE_CAPTURE_INSTALLED) return;
  window.__FULLPAGE_CAPTURE_INSTALLED = true;

  // Main listener
  chrome.runtime.onMessage.addListener((msg, _sender, _resp) => {
    if (msg && msg.action === 'start-capture') {
      startCapture().catch(e => {
        console.error('Capture failed', e);
        alert('Capture failed: ' + (e && e.message ? e.message : e));
      });
    }
  });

  // Utility: send message to background to capture visible viewport
  function captureVisible() {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ action: 'capture-visible' }, (res) => {
        resolve(res);
      });
    });
  }

  // Utility: load image element from dataURL
  function loadImage(dataUrl) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = (e) => reject(e);
      img.src = dataUrl;
    });
  }

  // Utility: canvas -> blob (promisified)
  function canvasToBlob(canvas, type='image/png', quality=0.92) {
    return new Promise((resolve) => {
      canvas.toBlob(blob => resolve(blob), type, quality);
    });
  }

  // Download helper
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

  async function startCapture() {
    const MAX_BYTES = 20 * 1024 * 1024; // 20 MB threshold

    // 1) get page metrics & scroll container
    const scrollingEl = document.scrollingElement || document.documentElement;
    const originalOverflow = scrollingEl.style.overflow;
    const originalScrollTop = scrollingEl.scrollTop;
    const totalWidth = Math.max(document.documentElement.scrollWidth, document.body.scrollWidth);
    const totalHeight = Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    // device pixel ratio can cause captured image pixel size to differ; images will tell real sizes

    // 2) hide fixed/sticky elements (simple heuristic)
    const fixedEls = Array.from(document.querySelectorAll('*')).filter(el => {
      const s = getComputedStyle(el);
      return (s.position === 'fixed' || s.position === 'sticky') && s.display !== 'none' && el.offsetParent !== null;
    });
    const fixedCache = fixedEls.map(el => ({ el, orig: { visibility: el.style.visibility, pointerEvents: el.style.pointerEvents } }));
    fixedEls.forEach(el => { el.style.visibility = 'hidden'; el.style.pointerEvents = 'none'; });

    // prevent scrollbars from changing layout
    scrollingEl.style.overflow = 'hidden';

    // 3) prepare list of y positions to capture
    const positions = [];
    for (let y = 0; y < totalHeight; y += viewportHeight) {
      positions.push(Math.min(y, totalHeight - viewportHeight));
      if (y + viewportHeight >= totalHeight) break;
    }

    // 4) capture each viewport
    const capturedDataUrls = [];
    for (let i = 0; i < positions.length; i++) {
      const y = positions[i];
      scrollingEl.scrollTo({ top: y, left: 0, behavior: 'instant' });

      // wait for paint & lazy-load
      await new Promise(r => requestAnimationFrame(() => setTimeout(r, 180)));

      const res = await captureVisible();
      if (!res || !res.success) {
        // restore UI before throwing
        cleanup();
        throw new Error('capture failed: ' + (res?.error || 'unknown'));
      }
      capturedDataUrls.push(res.dataUrl);
    }

    // after capture, restore original page scroll & styles
    scrollingEl.scrollTo({ top: originalScrollTop, left: 0, behavior: 'instant' });
    scrollingEl.style.overflow = originalOverflow;
    fixedCache.forEach(item => {
      item.el.style.visibility = item.orig.visibility || '';
      item.el.style.pointerEvents = item.orig.pointerEvents || '';
    });

    // 5) stitch into batches such that each final image blob <= MAX_BYTES
    // We'll build batches incrementally. For each candidate batch, draw all images onto a temp canvas,
    // convert to blob and check size. If size <= MAX_BYTES keep; else finalize previous batch and start new.

    // First convert dataUrls to Image elements and record widths/heights
    const images = [];
    for (const dataUrl of capturedDataUrls) {
      const img = await loadImage(dataUrl);
      images.push({ img, width: img.width, height: img.height });
    }

    // Stitch helper: given an array of images, create canvas and return blob
    async function stitchImagesToBlob(imgItems) {
      // total dims
      const w = Math.max(...imgItems.map(i => i.width));
      const h = imgItems.reduce((sum, it) => sum + it.height, 0);

      // create canvas
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext('2d');

      let y = 0;
      for (const it of imgItems) {
        ctx.drawImage(it.img, 0, y, it.width, it.height);
        y += it.height;
      }

      const blob = await canvasToBlob(canvas, 'image/png');
      return { blob, width: w, height: h };
    }

    // Build batches
    const batches = [];
    let currentBatch = [];

    for (let i = 0; i < images.length; i++) {
      const candidateBatch = currentBatch.concat([images[i]]);
      // test candidate
      const { blob } = await stitchImagesToBlob(candidateBatch);
      if (blob.size <= MAX_BYTES) {
        // keep candidate as current
        currentBatch = candidateBatch;
      } else {
        if (currentBatch.length === 0) {
          // single image chunk itself > MAX_BYTES (rare but possible if one viewport image is huge).
          // We'll accept it but attempt to downscale: create a scaled version (50%) to try to fit.
          console.warn('Single chunk exceeds limit, attempting downscale for chunk index', i);
          // create scaled canvas
          const it = images[i];
          const tmpCanvas = document.createElement('canvas');
          tmpCanvas.width = Math.floor(it.width / 2);
          tmpCanvas.height = Math.floor(it.height / 2);
          const ctx = tmpCanvas.getContext('2d');
          ctx.drawImage(it.img, 0, 0, tmpCanvas.width, tmpCanvas.height);
          const scaledBlob = await canvasToBlob(tmpCanvas, 'image/png', 0.9);
          if (scaledBlob.size <= MAX_BYTES) {
            // save scaled blob as its own batch (we do direct download later)
            batches.push({ blob: scaledBlob, info: `scaled_single_${i}` });
            currentBatch = [];
          } else {
            // cannot fit even when scaled; accept as single (user will get >20MB)
            batches.push({ blob, info: `single_too_large_${i}` });
            currentBatch = [];
          }
        } else {
          // finalize currentBatch (without images[i])
          const { blob } = await stitchImagesToBlob(currentBatch);
          batches.push({ blob, info: `batch_${batches.length}` });
          // start new batch with images[i]
          currentBatch = [images[i]];
          // edge: if images[i] by itself > MAX_BYTES, the loop will handle next iteration (above)
        }
      }
    }

    // push remaining currentBatch
    if (currentBatch.length > 0) {
      const { blob } = await stitchImagesToBlob(currentBatch);
      batches.push({ blob, info: `batch_${batches.length}` });
    }

    // 6) download each batch blob with sensible filename
    const urlBase = (new URL(location.href)).hostname.replace(/\./g, '_');
    for (let i = 0; i < batches.length; i++) {
      const b = batches[i];
      const filename = `${urlBase}_fullpage_${i + 1}.png`;
      downloadBlob(b.blob, filename);
    }

    alert(`Capture complete. ${batches.length} image(s) downloaded.`);

    // cleanup was already applied after capture; nothing more needed
  }

  // nothing to cleanup here as we restored earlier, but keep function for future changes
  function cleanup() { /* placeholder */ }

})();
