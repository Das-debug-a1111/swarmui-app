const Watermark = (() => {
  let S = {
    baseUrl:   null,
    wmB64:     null,
    wmOpacity: 0.8,
    wmScale:   1.0,
    dragging:  false,
    dragOffX:  0,
    dragOffY:  0,
  };

  let initialized = false;

  function $(id) { return document.getElementById(id); }

  function init() {
    if (initialized) return;
    initialized = true;

    // Restore saved watermark
    const stored = localStorage.getItem('swarm_wm_b64');
    if (stored) {
      S.wmB64 = stored;
      setWmStatus(localStorage.getItem('swarm_wm_name') || 'Watermark loaded');
    }

    // Drop zone — base image
    const dropZone = $('wm-drop-zone');
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', ()  => dropZone.classList.remove('over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f) loadBaseFile(f);
    });

    // Both buttons (drop zone + toolbar) trigger the same file input
    const openFilePicker = () => $('wm-file-input').click();
    $('wm-load-base').addEventListener('click', openFilePicker);
    $('wm-load-base-tb').addEventListener('click', openFilePicker);
    $('wm-file-input').addEventListener('change', e => {
      if (e.target.files[0]) loadBaseFile(e.target.files[0]);
      e.target.value = '';
    });

    // Also accept drag-drop on the canvas area (once an image is loaded)
    const canvasArea = $('wm-canvas-area');
    canvasArea.addEventListener('dragover',  e => { e.preventDefault(); canvasArea.classList.add('over'); });
    canvasArea.addEventListener('dragleave', ()  => canvasArea.classList.remove('over'));
    canvasArea.addEventListener('drop', e => {
      e.preventDefault();
      canvasArea.classList.remove('over');
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) loadBaseFile(f);
    });

    // Watermark file
    $('wm-load-wm').addEventListener('click', () => $('wm-wm-file-input').click());
    $('wm-wm-file-input').addEventListener('change', e => {
      if (e.target.files[0]) loadWmFile(e.target.files[0]);
      e.target.value = '';
    });

    // Clear watermark
    $('wm-clear-wm').addEventListener('click', () => {
      S.wmB64 = null;
      localStorage.removeItem('swarm_wm_b64');
      localStorage.removeItem('swarm_wm_name');
      setWmStatus('');
      $('wm-overlay-wrap').style.display = 'none';
    });

    // Opacity slider
    $('wm-opacity').addEventListener('input', function () {
      S.wmOpacity = parseFloat(this.value);
      $('wm-opacity-val').textContent = Math.round(S.wmOpacity * 100) + '%';
      $('wm-overlay').style.opacity = S.wmOpacity;
    });

    // Scale slider
    $('wm-scale').addEventListener('input', function () {
      S.wmScale = parseFloat(this.value);
      $('wm-scale-val').textContent = S.wmScale.toFixed(2) + '×';
      applyWmSize();
    });

    // Export
    $('wm-export').addEventListener('click', exportImage);
    $('wm-copy').addEventListener('click', copyImage);

    // Drag watermark overlay
    const overlayWrap = $('wm-overlay-wrap');
    overlayWrap.addEventListener('mousedown', e => {
      S.dragging = true;
      const r = overlayWrap.getBoundingClientRect();
      S.dragOffX = e.clientX - r.left;
      S.dragOffY = e.clientY - r.top;
      e.preventDefault();
    });
    document.addEventListener('mousemove', e => {
      if (!S.dragging) return;
      const wrap = $('wm-canvas-wrap');
      const wr   = wrap.getBoundingClientRect();
      overlayWrap.style.left = (e.clientX - wr.left - S.dragOffX) + 'px';
      overlayWrap.style.top  = (e.clientY - wr.top  - S.dragOffY) + 'px';
    });
    document.addEventListener('mouseup', () => { S.dragging = false; });
  }

  // ── Load base image ──────────────────────────────────────────────────────────

  function loadBaseFile(file) {
    fileToDataUrl(file).then(loadFromSrc);
  }

  async function loadFromSrc(url) {
    // Convert remote URL to data URL to avoid canvas taint on export
    if (!url.startsWith('data:')) {
      try {
        const res  = await fetch(url);
        const blob = await res.blob();
        url = await fileToDataUrl(blob);
      } catch (_) { /* fallback: use URL directly */ }
    }
    S.baseUrl = url;
    const baseImg = $('wm-base-img');
    baseImg.src = url;
    baseImg.onload = () => {
      $('wm-drop-zone').style.display    = 'none';
      $('wm-canvas-area').style.display  = 'flex';
      if (S.wmB64) showWmOverlay();
    };
  }

  // ── Load watermark ───────────────────────────────────────────────────────────

  async function loadWmFile(file) {
    let dataUrl;
    if (file.name.toLowerCase().endsWith('.kra')) {
      dataUrl = await extractKraImage(file);
      if (!dataUrl) {
        alert('Could not extract image from .kra file.\nIn Krita: Image → Flatten image before saving, or use File → Export.');
        return;
      }
    } else {
      dataUrl = await fileToDataUrl(file);
    }
    S.wmB64 = dataUrl;
    localStorage.setItem('swarm_wm_b64',  dataUrl);
    localStorage.setItem('swarm_wm_name', file.name);
    setWmStatus(file.name);
    if (S.baseUrl) showWmOverlay();
  }

  async function extractKraImage(file) {
    try {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      // mergedimage.png = flattened result Krita saves automatically
      let entry = zip.file('mergedimage.png');
      if (!entry) {
        // fallback: first layer PNG
        const keys = Object.keys(zip.files).filter(k => k.startsWith('layers/') && k.endsWith('.png'));
        if (keys.length) entry = zip.file(keys[0]);
      }
      if (!entry) return null;
      const blob = await entry.async('blob');
      return fileToDataUrl(blob);
    } catch (e) {
      console.error('[Watermark] KRA extract error:', e);
      return null;
    }
  }

  // ── Display watermark ────────────────────────────────────────────────────────

  function showWmOverlay() {
    const overlay     = $('wm-overlay');
    const overlayWrap = $('wm-overlay-wrap');
    overlay.src = S.wmB64;
    overlay.style.opacity = S.wmOpacity;
    overlay.onload = () => {
      applyWmSize();
      centerWm();
      overlayWrap.style.display = 'block';
    };
  }

  function applyWmSize() {
    const overlay     = $('wm-overlay');
    const overlayWrap = $('wm-overlay-wrap');
    if (!overlay.naturalWidth) return;

    const newW = overlay.naturalWidth  * S.wmScale;
    const newH = overlay.naturalHeight * S.wmScale;

    // Keep the visual center fixed while resizing
    const oldW    = parseFloat(overlay.style.width)         || newW;
    const oldH    = parseFloat(overlay.style.height)        || newH;
    const oldLeft = parseFloat(overlayWrap.style.left || '0');
    const oldTop  = parseFloat(overlayWrap.style.top  || '0');

    overlay.style.width  = newW + 'px';
    overlay.style.height = newH + 'px';

    overlayWrap.style.left = (oldLeft + (oldW - newW) / 2) + 'px';
    overlayWrap.style.top  = (oldTop  + (oldH - newH) / 2) + 'px';
  }

  function centerWm() {
    const wrap        = $('wm-canvas-wrap');
    const overlay     = $('wm-overlay');
    const overlayWrap = $('wm-overlay-wrap');
    const wmW = overlay.naturalWidth  * S.wmScale;
    const wmH = overlay.naturalHeight * S.wmScale;
    overlayWrap.style.left = ((wrap.clientWidth  - wmW) / 2) + 'px';
    overlayWrap.style.top  = ((wrap.clientHeight - wmH) / 2) + 'px';
  }

  function setWmStatus(name) {
    const el = $('wm-wm-status');
    if (!el) return;
    el.textContent = name;
    $('wm-clear-wm').style.display = name ? 'inline-block' : 'none';
  }

  // ── Export ───────────────────────────────────────────────────────────────────

  function buildWatermarkedCanvas() {
    const baseImg = $('wm-base-img');
    const canvas  = document.createElement('canvas');
    canvas.width  = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(baseImg, 0, 0);

    const overlayWrap = $('wm-overlay-wrap');
    if (S.wmB64 && overlayWrap.style.display !== 'none') {
      const overlay = $('wm-overlay');
      const scaleX  = baseImg.naturalWidth  / baseImg.clientWidth;
      const scaleY  = baseImg.naturalHeight / baseImg.clientHeight;
      const x = parseInt(overlayWrap.style.left || '0') * scaleX;
      const y = parseInt(overlayWrap.style.top  || '0') * scaleY;
      const w = overlay.clientWidth  * scaleX;
      const h = overlay.clientHeight * scaleY;
      ctx.globalAlpha = S.wmOpacity;
      ctx.drawImage(overlay, x, y, w, h);
      ctx.globalAlpha = 1;
    }
    return canvas;
  }

  function exportImage() {
    if (!S.baseUrl) return;
    const a      = document.createElement('a');
    a.download   = 'watermarked_' + Date.now() + '.png';
    a.href       = buildWatermarkedCanvas().toDataURL('image/png');
    a.click();
  }

  async function copyImage() {
    if (!S.baseUrl) return;
    try {
      const blob = await new Promise(r => buildWatermarkedCanvas().toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('✅ Image copiée !');
    } catch (e) {
      toast('❌ Copie impossible: ' + e.message);
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────

  function fileToDataUrl(file) {
    return new Promise(resolve => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.readAsDataURL(file);
    });
  }

  return { init, loadFromSrc };
})();
