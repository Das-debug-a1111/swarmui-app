// ── Watermark (batch) ────────────────────────────────────────────────────────
// Applique un logo et/ou un texte en filigrane à une ou plusieurs images.
// Positions stockées en fractions (0-1) du cadre affiché pour rester valables
// d'une image à l'autre quelle que soit sa résolution ("Apply to all").
const Watermark = (() => {
  const S = {
    images: [],       // { id, name, dataUrl, override: null | { logo:{x,y}, text:{x,y} } }
    activeId: null,

    wmB64:      null,
    wmOpacity:  0.8,
    wmScale:    0.2,   // fraction de la largeur de l'image de base
    wmRotation: 0,     // degrés
    logoEnabled: true,
    logoPosFrac: { x: 0.4, y: 0.4 },

    textEnabled: false,
    text: {
      content: '', font: 'Arial', color: '#ffffff', size: 32,
      opacity: 0.9, outline: 0, outlineColor: '#000000',
    },
    textPosFrac: { x: 0.35, y: 0.45 },

    applyToAll: true,
    dragTarget: null, dragOffX: 0, dragOffY: 0,
  };

  let initialized = false;
  function $(id) { return document.getElementById(id); }
  function genId() { return 'wmimg_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6); }
  function activeEntry() { return S.images.find(i => i.id === S.activeId) || null; }

  function init() {
    if (initialized) return;
    initialized = true;

    const stored = localStorage.getItem('swarm_wm_b64');
    if (stored) {
      S.wmB64 = stored;
      setWmStatus(localStorage.getItem('swarm_wm_name') || 'Watermark loaded');
    }

    bindDropZone();
    bindFileInputs();
    bindLogoControls();
    bindTextControls();
    bindExportControls();
    bindDrag($('wm-overlay-wrap'));
    bindDrag($('wm-text-overlay-wrap'));
  }

  // ── Loading images (multi) ────────────────────────────────────────────────
  function bindDropZone() {
    const dropZone = $('wm-drop-zone');
    dropZone.addEventListener('dragover',  e => { e.preventDefault(); dropZone.classList.add('over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('over'));
    dropZone.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('over');
      addFiles(e.dataTransfer.files);
    });

    const canvasArea = $('wm-canvas-area');
    canvasArea.addEventListener('dragover',  e => { e.preventDefault(); canvasArea.classList.add('over'); });
    canvasArea.addEventListener('dragleave', () => canvasArea.classList.remove('over'));
    canvasArea.addEventListener('drop', e => {
      e.preventDefault();
      canvasArea.classList.remove('over');
      addFiles(e.dataTransfer.files);
    });
  }

  function bindFileInputs() {
    const openFilePicker = () => $('wm-file-input').click();
    $('wm-load-base').addEventListener('click', openFilePicker);
    $('wm-load-base-tb').addEventListener('click', openFilePicker);
    $('wm-file-input').addEventListener('change', e => {
      addFiles(e.target.files);
      e.target.value = '';
    });

    $('wm-load-wm').addEventListener('click', () => $('wm-wm-file-input').click());
    $('wm-wm-file-input').addEventListener('change', e => {
      if (e.target.files[0]) loadWmFile(e.target.files[0]);
      e.target.value = '';
    });
    $('wm-clear-wm').addEventListener('click', () => {
      S.wmB64 = null;
      localStorage.removeItem('swarm_wm_b64');
      localStorage.removeItem('swarm_wm_name');
      setWmStatus('');
      $('wm-overlay-wrap').style.display = 'none';
    });
  }

  function addFiles(fileList) {
    const files = [...fileList].filter(f => f.type && f.type.startsWith('image/'));
    if (!files.length) return;
    Promise.all(files.map(f => fileToDataUrl(f).then(dataUrl => ({ id: genId(), name: f.name, dataUrl, override: null }))))
      .then(entries => {
        const wasEmpty = S.images.length === 0;
        S.images.push(...entries);
        renderImageList();
        if (wasEmpty) selectImage(entries[0].id);
      });
  }

  function selectImage(id) {
    S.activeId = id;
    const entry = activeEntry();
    if (!entry) return;
    const baseImg = $('wm-base-img');
    baseImg.src = entry.dataUrl;
    baseImg.onload = () => {
      $('wm-drop-zone').style.display   = 'none';
      $('wm-canvas-area').style.display = 'flex';
      if (S.logoEnabled && S.wmB64) showWmOverlay(); else $('wm-overlay-wrap').style.display = 'none';
      renderTextOverlay();
      applyOverlayPositions();
      renderImageList();
    };
  }

  function removeImage(id) {
    S.images = S.images.filter(i => i.id !== id);
    if (S.activeId === id) {
      S.activeId = null;
      if (S.images.length) selectImage(S.images[0].id);
      else {
        $('wm-canvas-area').style.display = 'none';
        $('wm-drop-zone').style.display   = '';
      }
    }
    renderImageList();
  }

  function renderImageList() {
    const list = $('wm-image-list');
    list.innerHTML = '';
    S.images.forEach(entry => {
      const div = document.createElement('div');
      div.className = 'wm-thumb' + (entry.id === S.activeId ? ' active' : '');
      div.innerHTML = `<img src="${entry.dataUrl}" alt=""><span class="wm-thumb-remove" title="Remove">✕</span>`;
      div.querySelector('img').addEventListener('click', () => selectImage(entry.id));
      div.querySelector('.wm-thumb-remove').addEventListener('click', e => { e.stopPropagation(); removeImage(entry.id); });
      list.appendChild(div);
    });
    const countEl = $('wm-export-all-count');
    if (countEl) countEl.textContent = S.images.length ? `(${S.images.length})` : '';
  }

  async function loadFromSrc(url) {
    if (!url.startsWith('data:')) {
      try {
        const res  = await fetch(url);
        const blob = await res.blob();
        url = await fileToDataUrl(blob);
      } catch (_) { /* fallback: use URL directly */ }
    }
    const entry = { id: genId(), name: 'sent-' + Date.now(), dataUrl: url, override: null };
    S.images.push(entry);
    renderImageList();
    selectImage(entry.id);
  }

  // ── Logo watermark ────────────────────────────────────────────────────────
  function bindLogoControls() {
    $('wm-enable-logo').addEventListener('change', function () {
      S.logoEnabled = this.checked;
      if (S.logoEnabled && S.wmB64) showWmOverlay(); else $('wm-overlay-wrap').style.display = 'none';
    });
    $('wm-opacity').addEventListener('input', function () {
      S.wmOpacity = parseFloat(this.value);
      $('wm-opacity-val').textContent = Math.round(S.wmOpacity * 100) + '%';
      $('wm-overlay').style.opacity = S.wmOpacity;
    });
    $('wm-scale').addEventListener('input', function () {
      S.wmScale = parseFloat(this.value);
      $('wm-scale-val').textContent = Math.round(S.wmScale * 100) + '%';
      applyWmSize();
    });
    $('wm-rotate').addEventListener('input', function () {
      S.wmRotation = parseFloat(this.value);
      $('wm-rotate-val').textContent = S.wmRotation + '°';
      $('wm-overlay-wrap').style.transform = `rotate(${S.wmRotation}deg)`;
    });
  }

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
    if (S.activeId && S.logoEnabled) showWmOverlay();
  }

  async function extractKraImage(file) {
    try {
      const buf = await file.arrayBuffer();
      const zip = await JSZip.loadAsync(buf);
      let entry = zip.file('mergedimage.png');
      if (!entry) {
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

  function showWmOverlay() {
    const overlay     = $('wm-overlay');
    const overlayWrap = $('wm-overlay-wrap');
    overlay.src = S.wmB64;
    overlay.style.opacity = S.wmOpacity;
    overlay.onload = () => {
      applyWmSize();
      overlayWrap.style.transform = `rotate(${S.wmRotation}deg)`;
      overlayWrap.style.display = 'block';
      applyOverlayPositions();
    };
  }

  function applyWmSize() {
    const overlay = $('wm-overlay');
    const wrap    = $('wm-canvas-wrap');
    if (!overlay.naturalWidth || !wrap.clientWidth) return;
    const newW = wrap.clientWidth * S.wmScale;
    const newH = newW * (overlay.naturalHeight / overlay.naturalWidth);
    overlay.style.width  = newW + 'px';
    overlay.style.height = newH + 'px';
  }

  function setWmStatus(name) {
    const el = $('wm-wm-status');
    if (!el) return;
    el.textContent = name;
    $('wm-clear-wm').style.display = name ? 'inline-block' : 'none';
  }

  // ── Text watermark ────────────────────────────────────────────────────────
  function bindTextControls() {
    $('wm-enable-text').addEventListener('change', function () {
      S.textEnabled = this.checked;
      document.querySelectorAll('.wm-text-ctrl').forEach(el => el.style.display = S.textEnabled ? '' : 'none');
      renderTextOverlay();
    });
    $('wm-text-content').addEventListener('input', function () { S.text.content = this.value; renderTextOverlay(); });
    $('wm-text-font').addEventListener('change', function () { S.text.font = this.value; renderTextOverlay(); });
    $('wm-text-color').addEventListener('input', function () { S.text.color = this.value; renderTextOverlay(); });
    $('wm-text-opacity').addEventListener('input', function () {
      S.text.opacity = parseFloat(this.value);
      $('wm-text-opacity-val').textContent = Math.round(S.text.opacity * 100) + '%';
      renderTextOverlay();
    });
    $('wm-text-size').addEventListener('input', function () {
      S.text.size = parseFloat(this.value);
      $('wm-text-size-val').textContent = S.text.size + 'px';
      renderTextOverlay();
    });
    $('wm-text-outline').addEventListener('input', function () {
      S.text.outline = parseFloat(this.value);
      $('wm-text-outline-val').textContent = S.text.outline + 'px';
      renderTextOverlay();
    });
    $('wm-text-outline-color').addEventListener('input', function () { S.text.outlineColor = this.value; renderTextOverlay(); });
  }

  function renderTextOverlay() {
    const wrap = $('wm-text-overlay-wrap');
    const el   = $('wm-text-overlay');
    if (!S.textEnabled || !S.text.content) { wrap.style.display = 'none'; return; }
    const baseImg = $('wm-base-img');
    const wrapEl  = $('wm-canvas-wrap');
    const ratio   = (baseImg.naturalWidth && wrapEl.clientWidth) ? (wrapEl.clientWidth / baseImg.naturalWidth) : 1;
    el.textContent = S.text.content;
    el.style.font = `${S.text.size * ratio}px ${S.text.font}`;
    el.style.color = S.text.color;
    el.style.opacity = S.text.opacity;
    el.style.webkitTextStroke = S.text.outline > 0 ? `${S.text.outline * ratio}px ${S.text.outlineColor}` : '';
    wrap.style.display = 'block';
  }

  // ── Drag (logo or text overlay) ───────────────────────────────────────────
  function bindDrag(wrapEl) {
    wrapEl.addEventListener('mousedown', e => {
      S.dragTarget = wrapEl;
      const r = wrapEl.getBoundingClientRect();
      S.dragOffX = e.clientX - r.left;
      S.dragOffY = e.clientY - r.top;
      e.preventDefault();
    });
  }
  document.addEventListener('mousemove', e => {
    if (!S.dragTarget) return;
    const wrap = $('wm-canvas-wrap');
    const wr   = wrap.getBoundingClientRect();
    S.dragTarget.style.left = (e.clientX - wr.left - S.dragOffX) + 'px';
    S.dragTarget.style.top  = (e.clientY - wr.top  - S.dragOffY) + 'px';
  });
  document.addEventListener('mouseup', () => {
    if (S.dragTarget) commitPosition(S.dragTarget);
    S.dragTarget = null;
  });

  function commitPosition(wrapEl) {
    const wrap = $('wm-canvas-wrap');
    if (!wrap.clientWidth || !wrap.clientHeight) return;
    const isLogo = wrapEl.id === 'wm-overlay-wrap';
    const frac = {
      x: (parseFloat(wrapEl.style.left) || 0) / wrap.clientWidth,
      y: (parseFloat(wrapEl.style.top)  || 0) / wrap.clientHeight,
    };
    if (S.applyToAll || !S.activeId) {
      if (isLogo) S.logoPosFrac = frac; else S.textPosFrac = frac;
    } else {
      const entry = activeEntry();
      if (entry) {
        entry.override = entry.override || {};
        entry.override[isLogo ? 'logo' : 'text'] = frac;
      }
    }
  }

  function resolveFrac(entry, key) {
    if (!S.applyToAll && entry && entry.override && entry.override[key]) return entry.override[key];
    return key === 'logo' ? S.logoPosFrac : S.textPosFrac;
  }

  function applyOverlayPositions() {
    const wrap  = $('wm-canvas-wrap');
    const entry = activeEntry();
    const logoFrac = resolveFrac(entry, 'logo');
    const textFrac = resolveFrac(entry, 'text');
    $('wm-overlay-wrap').style.left      = (logoFrac.x * wrap.clientWidth)  + 'px';
    $('wm-overlay-wrap').style.top       = (logoFrac.y * wrap.clientHeight) + 'px';
    $('wm-text-overlay-wrap').style.left = (textFrac.x * wrap.clientWidth)  + 'px';
    $('wm-text-overlay-wrap').style.top  = (textFrac.y * wrap.clientHeight) + 'px';
  }

  // ── Export ────────────────────────────────────────────────────────────────
  function bindExportControls() {
    $('wm-apply-all').addEventListener('change', function () {
      S.applyToAll = this.checked;
      applyOverlayPositions();
    });
    $('wm-export-format').addEventListener('change', function () {
      $('wm-quality-lbl').style.display = this.value === 'jpg' ? '' : 'none';
      $('wm-quality').style.display     = this.value === 'jpg' ? '' : 'none';
    });
    $('wm-quality').addEventListener('input', function () {
      $('wm-quality-val').textContent = this.value + '%';
    });
    $('wm-quality-val').textContent = $('wm-quality').value + '%';
    $('wm-export').addEventListener('click', exportCurrent);
    $('wm-export-all').addEventListener('click', exportAllZip);
    $('wm-copy').addEventListener('click', copyImage);
  }

  function loadImageAsync(src) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload  = () => resolve(img);
      img.onerror = reject;
      img.src = src;
    });
  }

  async function buildWatermarkedCanvasFor(entry) {
    const baseImg = await loadImageAsync(entry.dataUrl);
    const canvas  = document.createElement('canvas');
    canvas.width  = baseImg.naturalWidth;
    canvas.height = baseImg.naturalHeight;
    const ctx = canvas.getContext('2d');

    const format = $('wm-export-format').value;
    if (format === 'jpg') { ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, canvas.width, canvas.height); }
    ctx.drawImage(baseImg, 0, 0);

    if (S.logoEnabled && S.wmB64) {
      const logoImg = await loadImageAsync(S.wmB64);
      const frac = resolveFrac(entry, 'logo');
      const w = canvas.width * S.wmScale;
      const h = w * (logoImg.naturalHeight / logoImg.naturalWidth);
      const x = frac.x * canvas.width, y = frac.y * canvas.height;
      ctx.save();
      ctx.globalAlpha = S.wmOpacity;
      ctx.translate(x + w / 2, y + h / 2);
      ctx.rotate(S.wmRotation * Math.PI / 180);
      ctx.drawImage(logoImg, -w / 2, -h / 2, w, h);
      ctx.restore();
    }

    if (S.textEnabled && S.text.content) {
      const frac = resolveFrac(entry, 'text');
      const x = frac.x * canvas.width, y = frac.y * canvas.height;
      ctx.save();
      ctx.globalAlpha = S.text.opacity;
      ctx.font = `${S.text.size}px ${S.text.font}`;
      ctx.textBaseline = 'top';
      if (S.text.outline > 0) {
        ctx.lineWidth = S.text.outline;
        ctx.strokeStyle = S.text.outlineColor;
        ctx.strokeText(S.text.content, x, y);
      }
      ctx.fillStyle = S.text.color;
      ctx.fillText(S.text.content, x, y);
      ctx.restore();
    }

    return canvas;
  }

  function canvasToDataUrl(canvas) {
    const format = $('wm-export-format').value;
    if (format === 'jpg') return canvas.toDataURL('image/jpeg', (parseFloat($('wm-quality').value) || 92) / 100);
    return canvas.toDataURL('image/png');
  }

  async function exportCurrent() {
    const entry = activeEntry();
    if (!entry) return;
    const canvas = await buildWatermarkedCanvasFor(entry);
    const format = $('wm-export-format').value;
    const a = document.createElement('a');
    a.download = `watermarked_${Date.now()}.${format === 'jpg' ? 'jpg' : 'png'}`;
    a.href = canvasToDataUrl(canvas);
    a.click();
  }

  async function exportAllZip() {
    if (!S.images.length) { toast('Aucune image à exporter'); return; }
    const btn = $('wm-export-all');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Compression…';
    try {
      const zip = new JSZip();
      const format = $('wm-export-format').value === 'jpg' ? 'jpg' : 'png';
      let n = 0;
      for (const entry of S.images) {
        try {
          const canvas = await buildWatermarkedCanvasFor(entry);
          const dataUrl = canvasToDataUrl(canvas);
          const base64  = dataUrl.split(',')[1];
          const base    = (entry.name || `image_${++n}`).replace(/\.[^.]+$/, '');
          zip.file(`${base}_watermarked.${format}`, base64, { base64: true });
        } catch (e) { console.warn('[Watermark] export failed for', entry.name, e); }
      }
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `watermarked_${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast(`✅ ${S.images.length} image${S.images.length > 1 ? 's' : ''} exportées`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  async function copyImage() {
    const entry = activeEntry();
    if (!entry) return;
    try {
      const canvas = await buildWatermarkedCanvasFor(entry);
      const blob = await new Promise(r => canvas.toBlob(r, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('✅ Image copiée !');
    } catch (e) {
      toast('❌ Copie impossible: ' + e.message);
    }
  }

  // ── Helpers ───────────────────────────────────────────────────────────────
  function fileToDataUrl(file) {
    return new Promise(resolve => {
      const r = new FileReader();
      r.onload = e => resolve(e.target.result);
      r.readAsDataURL(file);
    });
  }

  return { init, loadFromSrc };
})();
