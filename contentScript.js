// contentScript.js
// Injected into the page. Listens for { action: 'begin-stitch' } from background,
// then performs scroll-capture-stitch and sends final dataUrl to background { action: 'store-and-open', dataUrl }.

(() => {
  console.log('[contentScript] loaded and waiting for begin-stitch');

  // Wait for message from background to start
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg && msg.action === 'begin-stitch') {
      // run the stitch flow
      (async () => {
        try {
          const result = await performFullPageStitch();
          console.log('[contentScript] stitch complete, sending to background', result && result.length);
          // send to background to store & open viewer
          const resp = await chrome.runtime.sendMessage({ action: 'store-and-open', dataUrl: result });
          if (!resp || !resp.success) {
            alert('Failed to open viewer: ' + (resp && resp.error ? resp.error : 'unknown'));
          }
        } catch (err) {
          console.error('[contentScript] performFullPageStitch failed:', err);
          alert('Capture failed: ' + (err && err.message ? err.message : String(err)));
        }
      })();
      sendResponse({ started: true });
    }
  });

  // Helper: small delay
  function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

  // Get document & viewport sizes
  function getSizes() {
    const body = document.body;
    const html = document.documentElement;
    const totalWidth = Math.max(body.scrollWidth, body.offsetWidth, html.clientWidth, html.scrollWidth, html.offsetWidth);
    const totalHeight = Math.max(body.scrollHeight, body.offsetHeight, html.clientHeight, html.scrollHeight, html.offsetHeight);
    const viewportWidth = Math.max(document.documentElement.clientWidth, window.innerWidth || 0);
    const viewportHeight = Math.max(document.documentElement.clientHeight, window.innerHeight || 0);
    return { totalWidth, totalHeight, viewportWidth, viewportHeight };
  }

  // Scroll to position and wait for layout
  async function scrollToY(y) {
    window.scrollTo(0, y);
    // wait for scroll/paint: longer for pages with lazy load
    await wait(300); // base wait
    // additional wait for images lazy-loading and layout; try to detect if images still loading — but 300ms usually OK
    await wait(200);
  }

  // Ask background to capture visible tab — returns dataUrl
  function captureVisible() {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ action: 'capture-for-stitch' }, (resp) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (!resp || !resp.success) {
          reject(new Error(resp && resp.error ? resp.error : 'capture failed'));
          return;
        }
        resolve(resp.dataUrl);
      });
    });
  }

  // Stitch images (dataURL array) into one tall canvas
  async function stitchImages(dataUrls, pageWidth, pageHeight, viewportWidth, viewportHeight) {
    // create images and wait to load
    const imgs = await Promise.all(dataUrls.map(url => new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = (e) => rej(e);
      i.src = url;
    })));

    // full size canvas
    const canvas = document.createElement('canvas');
    canvas.width = pageWidth;
    canvas.height = pageHeight;
    const ctx = canvas.getContext('2d');

    // draw each tile at appropriate y
    for (let idx = 0; idx < imgs.length; idx++) {
      const y = idx * viewportHeight;
      // If last tile extends beyond total page, draw only the portion needed
      ctx.drawImage(imgs[idx], 0, 0, viewportWidth, viewportHeight, 0, y, viewportWidth, viewportHeight);
    }

    // If pageWidth < viewportWidth (rare), or scaling is necessary, you can adjust here.
    return canvas.toDataURL('image/png');
  }

  // Main flow
  async function performFullPageStitch() {
    const sizes = getSizes();
    console.log('[contentScript] sizes:', sizes);
    const { totalWidth, totalHeight, viewportWidth, viewportHeight } = sizes;

    // set viewport to page width? We capture what the browser shows (we rely on captureVisibleTab)
    const steps = Math.ceil(totalHeight / viewportHeight);
    console.log('[contentScript] steps:', steps);

    const dataUrls = [];
    // Optional: hide fixed-position elements that would show in every tile (like sticky header)
    const fixedEls = Array.from(document.querySelectorAll('header, .fixed, .sticky, [data-fixed], .site-header, .navbar')).filter(Boolean);
    const fixedOriginalStyles = [];
    for (const el of fixedEls) {
      fixedOriginalStyles.push({ el, style: el.getAttribute('style') || '' });
      try { el.style.visibility = 'hidden'; } catch (e) {}
    }

    for (let i = 0; i < steps; i++) {
      const y = i * viewportHeight;
      await scrollToY(y);
      // Wait a tick, then capture
      try {
        const d = await captureVisible();
        // store
        dataUrls.push(d);
        console.log(`[contentScript] captured tile ${i + 1}/${steps}`);
      } catch (err) {
        console.error('[contentScript] capture error at step', i, err);
        // restore fixed elements before error alert
        for (const s of fixedOriginalStyles) {
          try { s.el.setAttribute('style', s.style); } catch (_) {}
        }
        throw err;
      }
    }

    // restore fixed elements
    for (const s of fixedOriginalStyles) {
      try { s.el.setAttribute('style', s.style); } catch (_) {}
    }

    // stitch
    const stitchedDataUrl = await stitchImages(dataUrls, totalWidth, totalHeight, viewportWidth, viewportHeight);
    // scroll back to top
    window.scrollTo(0, 0);
    return stitchedDataUrl;
  }

})();
