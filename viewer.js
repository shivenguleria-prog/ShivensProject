// viewer.js — zoom, pan, crop (free or aspect), rotate, flip, reset, download
(() => {
  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');

  const img = document.getElementById('mainImage');
  const container = document.getElementById('imgContainer');
  const overlayCanvas = document.getElementById('overlayCanvas');

  const zoomRange = document.getElementById('zoomRange');
  const zoomInBtn = document.getElementById('zoomIn');
  const zoomOutBtn = document.getElementById('zoomOut');
  const resetBtn = document.getElementById('resetBtn');
  const fitBtn = document.getElementById('fitBtn');

  const rotateLeft = document.getElementById('rotateLeft');
  const rotateRight = document.getElementById('rotateRight');
  const flipH = document.getElementById('flipH');
  const flipV = document.getElementById('flipV');

  const startCropBtn = document.getElementById('startCrop');
  const selection = document.getElementById('selection');
  const aspectSelect = document.getElementById('aspectSelect');

  const downloadBtn = document.getElementById('downloadBtn');
  const downloadFormat = document.getElementById('downloadFormat');

  let overlayCtx = null;

  let state = { scale: 1, translateX: 0, translateY: 0, rotation: 0, flipX: 1, flipY: 1 };
  let natural = { w: 0, h: 0 };

  let isPanning = false;
  let lastPointer = null;

  let cropping = false;
  let cropStart = null;
  let cropRect = null; // {x,y,w,h} in container coords

  function init() {
    if (!src) return alert('No image source provided.');
    img.onload = onLoad;
    img.onerror = () => alert('Could not load image.');
    img.src = src;

    zoomInBtn.onclick = () => changeScale(1.1);
    zoomOutBtn.onclick = () => changeScale(1/1.1);
    zoomRange.oninput = () => setScale(Number(zoomRange.value)/100);
    resetBtn.onclick = reset;
    fitBtn.onclick = fit;

    rotateLeft.onclick = () => { state.rotation = (state.rotation - 90) % 360; apply(); };
    rotateRight.onclick = () => { state.rotation = (state.rotation + 90) % 360; apply(); };
    flipH.onclick = () => { state.flipX *= -1; apply(); };
    flipV.onclick = () => { state.flipY *= -1; apply(); };

    startCropBtn.onclick = toggleCrop;

    downloadBtn.onclick = () => exportAndDownload(downloadFormat.value);

    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);

    selection.addEventListener('pointerdown', onSelectionDown);

    window.addEventListener('resize', resizeOverlay);
  }

  function onLoad() {
    natural.w = img.naturalWidth;
    natural.h = img.naturalHeight;
    resizeOverlay();
    fit(); // default: fit to screen (do not upscale)
  }

  function resizeOverlay() {
    overlayCanvas.width = container.clientWidth;
    overlayCanvas.height = container.clientHeight;
    overlayCanvas.style.width = `${container.clientWidth}px`;
    overlayCanvas.style.height = `${container.clientHeight}px`;
    overlayCtx = overlayCanvas.getContext('2d');
    if (cropRect) positionSelection();
  }

  function apply() {
    const { scale, translateX, translateY, rotation, flipX, flipY } = state;
    img.style.transform = `translate(${translateX}px, ${translateY}px) rotate(${rotation}deg) scale(${scale * flipX}, ${scale * flipY})`;
    zoomRange.value = Math.round(scale * 100);
  }

  function setScale(s) {
    state.scale = Math.min(5, Math.max(0.1, s));
    apply();
  }
  function changeScale(factor) { setScale(state.scale * factor); }

  function reset() {
    state = { scale: 1, translateX: 0, translateY: 0, rotation: 0, flipX: 1, flipY: 1 };
    cropping = false; cropRect = null; selection.hidden = true;
    apply();
  }

  function fit() {
    if (!natural.w || !natural.h) return;
    const cw = container.clientWidth, ch = container.clientHeight;
    const s = Math.min(cw / natural.w, ch / natural.h, 1); // don't upscale by default
    state.scale = s; state.translateX = 0; state.translateY = 0;
    apply();
  }

  // pan
  function onPointerDown(e) {
    if (cropping && !cropStart) {
      cropStart = getCoords(e);
      cropRect = null;
      startSelection();
      return;
    }
    isPanning = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    container.setPointerCapture(e.pointerId);
  }
  function onPointerUp() {
    if (cropping && cropStart) { finalizeSelection(getCoords(event)); cropStart = null; }
    isPanning = false; lastPointer = null;
  }
  function onPointerMove(e) {
    if (cropping && cropStart) { updateSelection(getCoords(e)); return; }
    if (!isPanning || !lastPointer) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    state.translateX += dx; state.translateY += dy; apply();
  }
  function getCoords(e) {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // crop helpers
  function toggleCrop() {
    cropping = !cropping;
    if (!cropping) { cropStart = null; if (!cropRect) selection.hidden = true; }
    else { cropRect = null; selection.hidden = true; }
  }
  function startSelection() {
    if (!cropStart) return;
    selection.hidden = false;
    selection.style.left = `${cropStart.x}px`;
    selection.style.top = `${cropStart.y}px`;
    selection.style.width = `4px`;
    selection.style.height = `4px`;
  }
  function updateSelection(current) {
    let x = Math.min(cropStart.x, current.x);
    let y = Math.min(cropStart.y, current.y);
    let w = Math.abs(current.x - cropStart.x);
    let h = Math.abs(current.y - cropStart.y);

    const asp = aspectSelect.value;
    if (asp !== 'free' && w && h) {
      const ratio = Function(`return (${asp})`)(); // safe: fixed values from select
      const cur = w / h;
      if (cur > ratio) { w = Math.round(h * ratio); if (current.x < cropStart.x) x = cropStart.x - w; }
      else { h = Math.round(w / ratio); if (current.y < cropStart.y) y = cropStart.y - h; }
    }

    // clamp
    x = Math.max(0, Math.min(container.clientWidth - 2, x));
    y = Math.max(0, Math.min(container.clientHeight - 2, y));
    w = Math.max(2, Math.min(container.clientWidth - x, w));
    h = Math.max(2, Math.min(container.clientHeight - y, h));

    cropRect = { x, y, w, h };
    positionSelection();
  }
  function finalizeSelection(end) { updateSelection(end); cropping = false; }
  function positionSelection() {
    selection.hidden = false;
    selection.style.left = `${cropRect.x}px`;
    selection.style.top = `${cropRect.y}px`;
    selection.style.width = `${cropRect.w}px`;
    selection.style.height = `${cropRect.h}px`;
  }

  // move selection by dragging it
  let selDrag = null;
  function onSelectionDown(e) {
    e.stopPropagation();
    selDrag = { sx: e.clientX, sy: e.clientY, orig: { ...cropRect } };
    selection.setPointerCapture(e.pointerId);
    selection.onpointermove = ev => {
      if (!selDrag || !cropRect) return;
      const dx = ev.clientX - selDrag.sx, dy = ev.clientY - selDrag.sy;
      let nx = selDrag.orig.x + dx, ny = selDrag.orig.y + dy;
      nx = Math.max(0, Math.min(container.clientWidth - selDrag.orig.w, nx));
      ny = Math.max(0, Math.min(container.clientHeight - selDrag.orig.h, ny));
      cropRect.x = nx; cropRect.y = ny; positionSelection();
    };
    selection.onpointerup = () => { selection.onpointermove = null; selection.onpointerup = null; selDrag = null; };
  }

  // export
  function exportAndDownload(mime = 'image/webp') {
    if (!natural.w || !natural.h) return alert('Image not ready');

    const crop = cropRect ? { ...cropRect } :
      { x: 0, y: 0, w: container.clientWidth, h: container.clientHeight };

    const dpr = window.devicePixelRatio || 1;
    const intCanvas = document.createElement('canvas');
    intCanvas.width = Math.round(container.clientWidth * dpr);
    intCanvas.height = Math.round(container.clientHeight * dpr);
    const ictx = intCanvas.getContext('2d');
    ictx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const cx = container.clientWidth / 2;
    const cy = container.clientHeight / 2;

    ictx.translate(cx + state.translateX, cy + state.translateY);
    ictx.rotate(state.rotation * Math.PI / 180);
    ictx.scale(state.scale * state.flipX, state.scale * state.flipY);
    ictx.drawImage(img, -natural.w / 2, -natural.h / 2, natural.w, natural.h);

    const out = document.createElement('canvas');
    out.width = Math.round(crop.w * dpr);
    out.height = Math.round(crop.h * dpr);
    const octx = out.getContext('2d');

    octx.drawImage(
      intCanvas,
      Math.round(crop.x * dpr),
      Math.round(crop.y * dpr),
      Math.round(crop.w * dpr),
      Math.round(crop.h * dpr),
      0, 0,
      Math.round(crop.w * dpr),
      Math.round(crop.h * dpr)
    );

    out.toBlob(blob => {
      if (!blob) return alert('Export failed');
      const url = URL.createObjectURL(blob);
      const ext = mime === 'image/png' ? 'png' : (mime === 'image/jpeg' ? 'jpg' : 'webp');
      const a = document.createElement('a');
      a.href = url;
      a.download = `screenshot_${Date.now()}_cropped.${ext}`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1500);
    }, mime);
  }

  init();
})();
