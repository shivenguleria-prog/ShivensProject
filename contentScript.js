// contentScript.js — merged stable version
// - Load/DOM stability waits
// - First tile with header, then hide sticky/fixed
// - Adaptive scrolling (reflow-aware)
// - Footer final sweep (lazy-load aware)
// - pHash duplicate guard for last tile
// - JPG export only

(() => {
  if (window.__FPC_INSTALLED__) return;
  window.__FPC_INSTALLED__ = true;

  const RT = chrome.runtime;

  // ---------- config ----------
  const CFG = {
    minCaptureGapMs: 550,
    captureRetries: 3,
    captureRetryBaseMs: 280,
    domStableWindowMs: 800,
    domStableTimeoutMs: 4000,
    viewportSettleMs: 250,
    maxTiles: 120,
    bottomStableChecks: 6,
    bottomStableIntervalMs: 350,
    phashNearDupe: 5,       // hamming distance < 5 => duplicate
    debugHud: true
  };

  // ---------- runtime state ----------
  let busy = false;
  let lastCaptureAt = 0;
  let observers = [];
  let dynamicObserver = null;

  // ---------- entry ----------
  RT.onMessage.addListener((msg) => {
    if (msg?.action === 'start-capture') {
      if (busy) return;
      busy = true;
      startCapture().catch(err => {
        console.error('[FPC] failed:', err);
        alert('Capture failed: ' + (err?.message || err));
      }).finally(() => { busy = false; });
    }
  });

  // ---------- main ----------
  async function startCapture() {
    const hud = CFG.debugHud ? makeHud() : null;
    setHud(hud, 'Preparing…');

    await waitForLoad();
    await waitForStableDOM(CFG.domStableTimeoutMs, CFG.domStableWindowMs);

    const scrollEl = findScrollable();
    const imgs = [];
    let lastHash = null;

    // scroll top + settle
    scrollEl.scrollTo({ top: 0, left: 0, behavior: 'auto' });
    await delay(CFG.viewportSettleMs);

    // Detect bands/overlays
    const headers = detectHeaders();
    const footers = detectFooters();
    const overlays = detectOverlays();
    const headerBandPx = measureHeaderBand(headers);
    const cropTopDpx = Math.max(0, Math.round(headerBandPx * (window.devicePixelRatio || 1)));

    // First tile WITH header
    setHud(hud, 'Capturing top…');
    const topData = await safeCapture();
    const topImg  = await loadImage(topData);
    imgs.push({ img: topImg, cropTop: 0 });
    lastHash = await computePHash(topImg);

    // Now hide sticky/fixed candidates
    const locks = hideAndLock([...headers, ...footers, ...overlays]);
    dynamicObserver = observeAndNukeNewBands();
    await delay(300);

    // Adaptive loop
    const vpH = window.innerHeight;
    let step = Math.max(24, vpH - headerBandPx);
    let prevScrollTop = 0;
    let target = step;
    let tiles = 1;

    while (true) {
      if (tiles >= CFG.maxTiles) { console.warn('[FPC] safety max tiles hit'); break; }

      // if already near bottom, leave loop (final sweep will handle)
      const maxTop = scrollEl.scrollHeight - vpH - 2;
      if (scrollEl.scrollTop >= maxTop) break;

      scrollEl.scrollTo({ top: target, left: 0, behavior: 'auto' });
      await delay(CFG.viewportSettleMs);
      await waitForStableDOM(CFG.domStableTimeoutMs, CFG.domStableWindowMs);

      const actualTop = scrollEl.scrollTop;
      if (Math.abs((actualTop - prevScrollTop) - step) > Math.max(12, step * 0.25)) {
        step = Math.max(16, actualTop - prevScrollTop); // adapt to reflow
      }
      prevScrollTop = actualTop;

      setHud(hud, `Capturing… (${tiles + 1})`);
      const url = await safeCapture();
      const img = await loadImage(url);
      const h = await computePHash(img);

      // simple duplicate guard (helps when bottom area doesn't change)
      if (lastHash && hamming(h, lastHash) < CFG.phashNearDupe) {
        console.log('[FPC] duplicate-ish tile — stopping loop.');
        break;
      }
      lastHash = h;
      imgs.push({ img, cropTop: cropTopDpx });
      tiles++;
      target = actualTop + step;
    }

    // Final footer sweep — let lazy loads finish
    setHud(hud, 'Finalizing footer…');
    await driveToBottom(scrollEl, vpH);
    await delay(500);

    const finalData = await safeCapture();
    const finalImg  = await loadImage(finalData);
    const finalHash = await computePHash(finalImg);
    if (!lastHash || hamming(finalHash, lastHash) >= CFG.phashNearDupe) {
      imgs.push({ img: finalImg, cropTop: cropTopDpx });
    }

    // Stitch
    setHud(hud, 'Stitching…');
    const blob = await stitch(imgs);
    cleanupLocks(locks);
    if (dynamicObserver) dynamicObserver.disconnect();
    killHud(hud);

    // ***********************************************
    // START: MODIFIED OUTPUT HANDLING FOR VIEWER
    // ***********************************************

    const name = `${location.hostname}_fullpage_${Date.now()}.jpg`;
    
    // 1. Download the full image
    downloadBlob(blob, name);

    // 2. Convert blob to Data URL for viewer
    setHud(hud, 'Preparing viewer…');
    const dataUrl = await new Promise(res => {
        const reader = new FileReader();
        reader.onloadend = () => res(reader.result);
        reader.readAsDataURL(blob);
    });

    // 3. Store the large Data URL in chrome.storage.local
    const storageKey = 'fpc_latest_img';
    await chrome.storage.local.set({ [storageKey]: dataUrl });
    
    // 4. Open the new viewer page bundled with the extension
    const viewerUrl = chrome.runtime.getURL('viewer.html');
    window.open(viewerUrl, '_blank');

    // ***********************************************
    // END: MODIFIED OUTPUT HANDLING FOR VIEWER
    // ***********************************************
  }

  // ---------- capture / waits ----------
  async function safeCapture() {
    const now = Date.now();
    const gap = now - lastCaptureAt;
    if (gap < CFG.minCaptureGapMs) await delay(CFG.minCaptureGapMs - gap);

    let lastErr;
    for (let a = 1; a <= CFG.captureRetries; a++) {
      const res = await new Promise(resolve => {
        try { RT.sendMessage({ action: 'capture-visible' }, resolve); }
        catch (e) { resolve({ success: false, error: e?.message }); }
      });
      lastCaptureAt = Date.now();
      if (res?.success && res.dataUrl) return res.dataUrl;
      lastErr = res?.error || 'unknown capture error';
      await delay(CFG.captureRetryBaseMs * Math.pow(2, a - 1));
    }
    throw new Error('capture failed: ' + lastErr);
  }

  async function waitForLoad() {
    if (document.readyState === 'complete') return;
    await new Promise(r => window.addEventListener('load', r, { once: true }));
  }

  async function waitForStableDOM(timeout, stableWin) {
    return new Promise(resolve => {
      let last = Date.now();
      const mo = new MutationObserver(() => (last = Date.now()));
      mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true });

      const start = Date.now();
      const tick = () => {
        const now = Date.now();
        if (now - last >= stableWin || now - start > timeout) {
          mo.disconnect();
          resolve();
        } else {
          setTimeout(tick, 100);
        }
      };
      setTimeout(tick, 100);
    });
  }

  async function driveToBottom(scrollEl, vpH) {
    // Push to near bottom, then wait until height stabilizes
    let lastH = scrollEl.scrollHeight;
    scrollEl.scrollTo({ top: Math.max(0, lastH - vpH), behavior: 'auto' });
    await delay(400);
    let stable = 0;
    while (stable < CFG.bottomStableChecks) {
      await delay(CFG.bottomStableIntervalMs);
      const h = scrollEl.scrollHeight;
      if (Math.abs(h - lastH) > 80) {
        lastH = h;
        scrollEl.scrollTo({ top: Math.max(0, h - vpH), behavior: 'auto' });
        stable = 0;
      } else {
        stable++;
      }
    }
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: 'auto' });
    await delay(250);
  }

  // ---------- detect & suppress UI ----------
  function detectHeaders() {
    return Array.from(document.querySelectorAll('body *')).filter(el => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const nameish = /header|nav|topbar|masthead|site-header|menu/i.test(el.id + ' ' + el.className);
      const isTop = r.top < 250 && r.bottom > 0;
      if (!isTop && !nameish) return false;
      if (!['fixed', 'sticky'].includes(s.position) && !nameish) return false;
      return el.offsetHeight >= 28 && el.offsetWidth >= 120;
    });
  }
  function detectFooters() {
    return Array.from(document.querySelectorAll('body *')).filter(el => {
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      const nameish = /footer|cookie|subscribe|bottom|chat|banner/i.test(el.id + ' ' + el.className);
      const isBottom = r.bottom > window.innerHeight - 250;
      if (!isBottom && !nameish) return false;
      if (!['fixed', 'sticky'].includes(s.position) && !nameish) return false;
      return el.offsetHeight >= 24 && el.offsetWidth >= 120;
    });
  }
  function detectOverlays() {
    return Array.from(document.querySelectorAll('body *')).filter(el => {
      const s = getComputedStyle(el);
      if (!['fixed', 'sticky'].includes(s.position)) return false;
      const r = el.getBoundingClientRect();
      // likely modal/tooltip/chat widgets not at very top
      return r.top > window.innerHeight * 0.2 || r.left > window.innerWidth * 0.2;
    });
  }
  function measureHeaderBand(els) {
    if (!els?.length) return 0;
    let max = 0;
    for (const el of els) {
      const r = el.getBoundingClientRect();
      if (r.top < 220 && r.bottom > 0) max = Math.max(max, r.bottom);
    }
    return Math.min(max, Math.floor(window.innerHeight * 0.6));
  }
  function hideAndLock(els) {
    const locks = [];
    for (const el of els) {
      try {
        if (!el || !el.style) continue;
        const rec = {
          el,
          display: el.style.display,
          visibility: el.style.visibility,
          opacity: el.style.opacity,
          pointerEvents: el.style.pointerEvents
        };
        el.style.setProperty('display', 'none', 'important');
        el.style.setProperty('visibility', 'hidden', 'important');
        el.style.setProperty('opacity', '0', 'important');
        el.style.setProperty('pointer-events', 'none', 'important');
        locks.push(rec);
      } catch {}
    }
    return locks;
  }
  function cleanupLocks(locks) {
    for (const r of locks) {
      const el = r.el;
      if (!el || !el.style) continue;
      el.style.setProperty('display', r.display || '');
      el.style.setProperty('visibility', r.visibility || '');
      el.style.setProperty('opacity', r.opacity || '');
      el.style.setProperty('pointer-events', r.pointerEvents || '');
    }
  }
  function observeAndNukeNewBands() {
    const mo = new MutationObserver(muts => {
      for (const m of muts) {
        m.addedNodes?.forEach(n => {
          if (n.nodeType !== 1) return;
          const el = n;
          const s  = getComputedStyle(el);
          const nameish = /header|nav|topbar|masthead|footer|cookie|chat|banner/i.test(el.id + ' ' + el.className);
          if (nameish || ['fixed','sticky'].includes(s.position)) {
            try { el.remove(); } catch {}
          }
        });
      }
    });
    mo.observe(document.body || document.documentElement, { childList: true, subtree: true });
    return mo;
  }

  // ---------- stitch ----------
  async function stitch(items) {
    const width = Math.max(...items.map(t => t.img.width));
    const height = items.reduce((h, t) => h + (t.img.height - (t.cropTop || 0)), 0);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');

    let y = 0;
    for (const t of items) {
      const sy = Math.max(0, t.cropTop || 0);
      const sh = t.img.height - sy;
      ctx.drawImage(t.img, 0, sy, t.img.width, sh, 0, y, t.img.width, sh);
      y += sh;
    }
    return await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.95));
  }

  // ---------- helpers ----------
  function findScrollable() {
    // prefer the element with biggest scroll span
    const cands = [document.scrollingElement || document.documentElement, document.body, ...document.querySelectorAll('body *')];
    let best = cands[0], span = 0;
    for (const el of cands) {
      try {
        const s = (el.scrollHeight || 0) - (el.clientHeight || 0);
        if (s > span && (el.clientHeight || 0) > 0) { best = el; span = s; }
      } catch {}
    }
    return best || (document.scrollingElement || document.documentElement);
  }

  function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('image load failed'));
      i.src = url;
    });
  }

  function downloadBlob(blob, name) {
    const u = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = u; a.download = name; a.click();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
  }

  // pHash (32×32 grayscale + DCT, take 8×8 top-left excluding DC)
  async function computePHash(img) {
    const N = 32;
    const c = document.createElement('canvas');
    const ctx = c.getContext('2d');
    c.width = N; c.height = N;
    ctx.drawImage(img, 0, 0, N, N);
    const data = ctx.getImageData(0, 0, N, N).data;
    const g = new Float64Array(N*N);
    for (let i=0, j=0; i<data.length; i+=4, j++) {
      g[j] = 0.299*data[i] + 0.587*data[i+1] + 0.114*data[i+2];
    }
    const d = dct2(g, N);
    const vals = [];
    for (let y=0; y<8; y++) for (let x=0; x<8; x++) vals.push(d[y*N + x]);
    const median = vals.slice(1).sort((a,b)=>a-b)[32];
    let h = 0n;
    for (let i=0; i<64; i++) if (vals[i] > median) h |= (1n << BigInt(i));
    return h;
  }
  function hamming(a, b) {
    let x = (a ^ b), c = 0;
    while (x) { c += Number(x & 1n); x >>= 1n; }
    return c;
  }
  function dct2(src, N) {
    const dst = new Float64Array(N*N);
    const c = (v) => (v === 0 ? Math.SQRT1_2 : 1);
    for (let u=0; u<N; u++) for (let v=0; v<N; v++) {
      let sum = 0;
      for (let y=0; y<N; y++) for (let x=0; x<N; x++) {
        sum += src[y*N + x] *
               Math.cos(((2*x+1)*u*Math.PI)/(2*N)) *
               Math.cos(((2*y+1)*v*Math.PI)/(2*N));
      }
      dst[v*N + u] = 0.25 * c(u) * c(v) * sum;
    }
    return dst;
  }

  // HUD
  function makeHud() {
    const el = document.createElement('div');
    el.style.cssText = 'position:fixed;top:12px;right:12px;z-index:2147483647;background:rgba(0,0,0,.75);color:#fff;padding:8px 10px;border-radius:8px;font:12px/1.4 system-ui, -apple-system, Segoe UI, Roboto;pointer-events:none';
    el.textContent = '…';
    document.documentElement.appendChild(el);
    return el;
  }
  function setHud(el, t){ if(el) el.textContent = t; }
  function killHud(el){ if(el) el.remove(); }
})();
