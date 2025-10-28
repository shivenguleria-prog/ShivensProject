// viewer.js
// Lightweight image viewer/editor: zoom, pan, crop, rotate, flip, download

(() => {
  const qs = new URLSearchParams(location.search);
  const src = qs.get('src');
  const img = document.getElementById('mainImage');
  const container = document.getElementById('imgContainer');

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

  // overlay canvas for guidance if needed
  const overlayCanvas = document.getElementById('overlayCanvas');
  let overlayCtx = null;

  // transformation state
  let state = {
    scale: 1,
    translateX: 0,
    translateY: 0,
    rotation: 0, // degrees
    flipX: 1, // 1 or -1
    flipY: 1,
  };

  // image natural size
  let imgNatural = { w: 0, h: 0 };

  // pan/drag state
  let isPanning = false;
  let lastPointer = null;

  // selection/crop state
  let cropping = false;
  let cropStart = null;
  let cropRect = null; // {x,y,w,h} in container coords

  function init() {
    if (!src) {
      showError('No image source provided.');
      return;
    }
    img.onload = onImageLoad;
    img.onerror = () => showError('Could not load image.');
    img.src = src;

    zoomInBtn.onclick = () => changeScaleBy(1.1);
    zoomOutBtn.onclick = () => changeScaleBy(1 / 1.1);
    zoomRange.oninput = () => setScale(Number(zoomRange.value) / 100);
    resetBtn.onclick = resetTransform;
    fitBtn.onclick = fitToContainer;

    rotateLeft.onclick = () => { state.rotation = (state.rotation - 90) % 360; applyTransform(); }
    rotateRight.onclick = () => { state.rotation = (state.rotation + 90) % 360; applyTransform(); }
    flipH.onclick = () => { state.flipX *= -1; applyTransform(); }
    flipV.onclick = () => { state.flipY *= -1; applyTransform(); }

    startCropBtn.onclick = toggleCropMode;

    downloadBtn.onclick = () => exportCanvasAndDownload(downloadFormat.value);

    // pointer events for pan
    container.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('pointerup', onPointerUp);
    window.addEventListener('pointermove', onPointerMove);

    // selection drag events
    selection.addEventListener('pointerdown', onSelectionPointerDown);

    // resizing overlay canvas to match container
    window.addEventListener('resize', updateSizes);
  }

  function onImageLoad() {
    imgNatural.w = img.naturalWidth;
    imgNatural.h = img.naturalHeight;
    updateSizes();
    // default scale: keep as current/open behavior: set image zoom to fit
    fitToContainer();
  }

  function updateSizes() {
    // ensure overlay covers the container
    overlayCanvas.width = container.clientWidth;
    overlayCanvas.height = container.clientHeight;
    overlayCanvas.style.width = `${container.clientWidth}px`;
    overlayCanvas.style.height = `${container.clientHeight}px`;
    overlayCtx = overlayCanvas.getContext('2d');
    drawOverlay();
    // reposition selection if present
    if (cropRect) {
      positionSelectionElement();
    }
  }

  function drawOverlay() {
    if (!overlayCtx) return;
    overlayCtx.clearRect(0, 0, overlayCanvas.width, overlayCanvas.height);
    // could draw guides if needed
  }

  function applyTransform() {
    // Build CSS transform: translate -> rotate -> scale -> flip
    const { scale, translateX, translateY, rotation, flipX, flipY } = state;
    // order: translate + rotate + scale + flip
    const t = `translate(${translateX}px, ${translateY}px) rotate(${rotation}deg) scale(${scale * flipX}, ${scale * flipY})`;
    img.style.transform = t;
    // sync zoom range
    zoomRange.value = Math.round(scale * 100);
  }

  function changeScaleBy(factor) {
    setScale(state.scale * factor);
  }

  function setScale(s) {
    s = Math.max(0.1, Math.min(5, s));
    state.scale = s;
    applyTransform();
  }

  function resetTransform() {
    state = { scale: 1, translateX: 0, translateY: 0, rotation: 0, flipX: 1, flipY: 1 };
    cropping = false;
    cropRect = null;
    selection.hidden = true;
    applyTransform();
  }

  function fitToContainer() {
    // set scale so that image fits container
    const cw = container.clientWidth;
    const ch = container.clientHeight;
    if (!imgNatural.w || !imgNatural.h) return;
    const scaleX = cw / imgNatural.w;
    const scaleY = ch / imgNatural.h;
    const s = Math.min(scaleX, scaleY, 1); // don't upscale by default; keeps same behavior as earlier
    state.scale = s;
    state.translateX = 0;
    state.translateY = 0;
    applyTransform();
  }

  // Pointer handlers for pan
  function onPointerDown(e) {
    // ignore if we start a crop selection
    if (cropping && !cropStart) {
      // start crop area
      cropStart = getContainerCoords(e);
      cropRect = null;
      updateSelectionFromStart();
      return;
    }

    isPanning = true;
    lastPointer = { x: e.clientX, y: e.clientY };
    container.setPointerCapture(e.pointerId);
  }

  function onPointerUp(e) {
    if (cropping && cropStart) {
      // finish crop rectangle
      const end = getContainerCoords(e);
      finalizeCropRect(cropStart, end);
      cropStart = null;
      return;
    }

    isPanning = false;
    lastPointer = null;
  }

  function onPointerMove(e) {
    if (cropping && cropStart) {
      // update selection rect live
      const current = getContainerCoords(e);
      updateSelectionFromCoords(cropStart, current);
      return;
    }

    if (!isPanning || !lastPointer) return;
    const dx = e.clientX - lastPointer.x;
    const dy = e.clientY - lastPointer.y;
    lastPointer = { x: e.clientX, y: e.clientY };
    // adjust for scale so panning feels right
    state.translateX += dx;
    state.translateY += dy;
    applyTransform();
  }

  function getContainerCoords(e) {
    const r = container.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  // Selection helpers
  function toggleCropMode() {
    cropping = !cropping;
    if (!cropping) {
      // finishing crop mode (user turned off)
      cropStart = null;
      if (!cropRect) selection.hidden = true;
    } else {
      // entering crop mode
      cropRect = null;
      selection.hidden = true;
    }
  }

  function updateSelectionFromStart() {
    if (!cropStart) return;
    selection.hidden = false;
    selection.style.left = `${cropStart.x}px`;
    selection.style.top = `${cropStart.y}px`;
    selection.style.width = `4px`;
    selection.style.height = `4px`;
  }

  function updateSelectionFromCoords(a, b) {
    // a: start, b: current
    let x = Math.min(a.x, b.x);
    let y = Math.min(a.y, b.y);
    let w = Math.abs(b.x - a.x);
    let h = Math.abs(b.y - a.y);

    // enforce aspect if set and not 'free'
    const asp = aspectSelect.value;
    if (asp !== 'free') {
      const ratio = eval(asp); // safe values (1, 16/9, 4/3)
      if (w && h) {
        const currentRatio = w / h;
        if (currentRatio > ratio) {
          // width too large
          w = Math.round(h * ratio);
          if (b.x < a.x) x = Math.max(0, a.x - w);
        } else {
          // height too large
          h = Math.round(w / ratio);
          if (b.y < a.y) y = Math.max(0, a.y - h);
        }
      }
    }

    // clamp within container
    x = Math.max(0, Math.min(container.clientWidth - 2, x));
    y = Math.max(0, Math.min(container.clientHeight - 2, y));
    w = Math.max(2, Math.min(container.clientWidth - x, w));
    h = Math.max(2, Math.min(container.clientHeight - y, h));

    cropRect = { x, y, w, h };
    positionSelectionElement();
  }

  function finalizeCropRect(a, b) {
    updateSelectionFromCoords(a, b);
    cropping = false;
    cropStart = null;
  }

  function positionSelectionElement() {
    if (!cropRect) return;
    selection.hidden = false;
    selection.style.left = `${cropRect.x}px`;
    selection.style.top = `${cropRect.y}px`;
    selection.style.width = `${cropRect.w}px`;
    selection.style.height = `${cropRect.h}px`;
  }

  // allow moving selection box by dragging it
  let selDrag = null;
  function onSelectionPointerDown(e) {
    e.stopPropagation();
    selDrag = { startX: e.clientX, startY: e.clientY, orig: {...cropRect} };
    selection.setPointerCapture(e.pointerId);
    selection.onpointermove = (ev) => {
      if (!selDrag || !cropRect) return;
      const dx = ev.clientX - selDrag.startX;
      const dy = ev.clientY - selDrag.startY;
      let nx = selDrag.orig.x + dx;
      let ny = selDrag.orig.y + dy;
      // clamp
      nx = Math.max(0, Math.min(container.clientWidth - selDrag.orig.w, nx));
      ny = Math.max(0, Math.min(container.clientHeight - selDrag.orig.h, ny));
      cropRect.x = nx; cropRect.y = ny;
      positionSelectionElement();
    };
    selection.onpointerup = (ev) => {
      selection.onpointermove = null;
      selection.onpointerup = null;
      selDrag = null;
    };
  }

  // Export/cropping logic: we need to convert cropRect (container coords) into the original image pixel coordinates taking into account transforms: scale, translate, rotation, flips.
  function exportCanvasAndDownload(mimeType = 'image/webp') {
    // If cropRect not present -> we export current view (the visible viewport of the image in container)
    if (!imgNatural.w || !imgNatural.h) {
      return showError('Image not ready');
    }

    // Build an offscreen canvas sized to crop (or container)
    const crop = cropRect ? {...cropRect} : { x: 0, y: 0, w: container.clientWidth, h: container.clientHeight };

    // Create canvas of target pixel size — map container pixels to image pixels
    // We'll compute the transform matrix mapping image pixels to container pixels:
    // container <- translate(translateX,translateY) rotate(rotation) scale(scale*flipX,scale*flipY) image
    // But image element may be sized differently than natural size: we draw the image with its natural size as source.

    // Compute displayed image center and offset:
    // We'll compute the matrix step-by-step by drawing onto an intermediate canvas.

    // Strategy:
    // 1. Create an intermediate canvas matching container size
    // 2. Draw the transformed image into intermediate canvas using ctx transforms that match the CSS transforms
    // 3. Extract the crop rectangle from intermediate canvas and resample to an output canvas sized to cropRect (but scaled to pixel density)
    const dpr = window.devicePixelRatio || 1;
    const intCanvas = document.createElement('canvas');
    intCanvas.width = Math.round(container.clientWidth * dpr);
    intCanvas.height = Math.round(container.clientHeight * dpr);
    const ictx = intCanvas.getContext('2d');
    ictx.setTransform(dpr, 0, 0, dpr, 0, 0); // scale for DPR

    // center of container (for transform origin)
    const cx = container.clientWidth / 2;
    const cy = container.clientHeight / 2;

    // apply transforms: translate -> rotate -> scale/flip
    ictx.translate(cx + state.translateX, cy + state.translateY);
    const rad = state.rotation * Math.PI / 180;
    ictx.rotate(rad);
    ictx.scale(state.scale * state.flipX, state.scale * state.flipY);

    // Now draw image centered at origin
    // we draw image with its natural size and center it (so transform origin matches CSS center)
    ictx.drawImage(img, -imgNatural.w / 2, -imgNatural.h / 2, imgNatural.w, imgNatural.h);

    // Now crop from intCanvas
    const outCanvas = document.createElement('canvas');
    outCanvas.width = Math.round(crop.w * dpr);
    outCanvas.height = Math.round(crop.h * dpr);
    const outCtx = outCanvas.getContext('2d');

    outCtx.drawImage(
      intCanvas,
      Math.round(crop.x * dpr),
      Math.round(crop.y * dpr),
      Math.round(crop.w * dpr),
      Math.round(crop.h * dpr),
      0,
      0,
      Math.round(crop.w * dpr),
      Math.round(crop.h * dpr)
    );

    // Convert to requested mime type
    const mime = mimeType || 'image/webp';

    // turn into blob
    outCanvas.toBlob((blob) => {
      if (!blob) {
        showError('Export failed');
        return;
      }
      // create temporary download link
      const url = URL.createObjectURL(blob);
      const ext = mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : 'webp';
      const filename = `screenshot_${Date.now()}_cropped.${ext}`;

      // trigger download
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    }, mime);
  }

  function showError(msg) {
    alert(msg);
  }

  // initialize
  init();
})();
