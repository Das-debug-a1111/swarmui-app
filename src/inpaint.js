// ── Inpaint Module ────────────────────────────────────────────────────────────
const Inpaint = (() => {
  const q = id => document.getElementById(id);

  const STD_SIZES = [
    { label: '3:2',  w: 1152, h: 768  },
    { label: '2:3',  w: 768,  h: 1152 },
    { label: '16:9', w: 1344, h: 768  },
    { label: '9:16', w: 768,  h: 1344 },
    { label: '1:1',  w: 1024, h: 1024 },
  ];

  const S = {
    image:            null,
    imageData:        null,
    maskCanvas:       null,
    maskCtx:          null,
    drawing:          false,
    tool:             'brush',
    brushSize:        40,
    brushOpacity:     1.0,
    undoStack:        [],
    running:          false,
    initialized:      false,
    pendingCrop:      null,  // bbox for only_masked recomposite
    pendingWhole:     false, // flag for whole-picture recomposite
    originalMetadata: null,  // raw JSON metadata from the source image
  };

  // ── PNG tEXt chunk injector ───────────────────────────────────────────────
  function crc32(buf) {
    let c = 0xFFFFFFFF;
    const table = crc32._t || (crc32._t = (() => {
      const t = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let v = n;
        for (let k = 0; k < 8; k++) v = (v & 1) ? (0xEDB88320 ^ (v >>> 1)) : (v >>> 1);
        t[n] = v;
      }
      return t;
    })());
    for (let i = 0; i < buf.length; i++) c = table[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  function extractPngMeta(buf) {
    const bytes = new Uint8Array(buf);
    const view  = new DataView(buf);
    let off = 8;
    while (off < buf.byteLength - 12) {
      const len  = view.getUint32(off); off += 4;
      const type = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]); off += 4;
      if (type === 'tEXt') {
        const raw = bytes.slice(off, off + len);
        const nul = raw.indexOf(0);
        if (new TextDecoder().decode(raw.slice(0, nul)) === 'parameters')
          return new TextDecoder().decode(raw.slice(nul + 1));
      }
      if (type === 'IEND') break;
      off += len + 4;
    }
    return null;
  }

  function injectJpegCom(jpgBuf, text) {
    const commentBytes = new TextEncoder().encode(text);
    const segLen = 2 + commentBytes.length;
    const com = new Uint8Array(4 + commentBytes.length);
    com[0] = 0xFF; com[1] = 0xFE;
    com[2] = (segLen >> 8) & 0xFF;
    com[3] = segLen & 0xFF;
    com.set(commentBytes, 4);
    const jpg = new Uint8Array(jpgBuf);
    const out = new Uint8Array(2 + com.length + jpg.length - 2);
    out.set(jpg.slice(0, 2));
    out.set(com, 2);
    out.set(jpg.slice(2), 2 + com.length);
    return out.buffer;
  }

  function injectPngMetadataBuf(buf, metadataJson) {
    const raw = new Uint8Array(buf);
    const view = new DataView(raw.buffer);

    // Build tEXt chunk: key\0value
    const enc     = new TextEncoder();
    const keyVal  = new Uint8Array([...enc.encode('parameters'), 0, ...enc.encode(metadataJson)]);
    const typeArr = enc.encode('tEXt');
    const crcBuf  = new Uint8Array([...typeArr, ...keyVal]);
    const crc     = crc32(crcBuf);

    // Chunk = 4 (len) + 4 (type) + data + 4 (crc)
    const chunk = new Uint8Array(4 + 4 + keyVal.length + 4);
    const cv    = new DataView(chunk.buffer);
    cv.setUint32(0, keyVal.length);
    chunk.set(typeArr, 4);
    chunk.set(keyVal, 8);
    cv.setUint32(8 + keyVal.length, crc);

    // Insert after IHDR chunk (offset 8 sig + 4 len + 4 type + 13 data + 4 crc = 33)
    const out = new Uint8Array(raw.length + chunk.length);
    out.set(raw.slice(0, 33), 0);
    out.set(chunk, 33);
    out.set(raw.slice(33), 33 + chunk.length);

    return out.buffer;
  }

  const PRESET_KEY = 'swi-inpaint-presets';

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (S.initialized) return;
    S.initialized = true;
    bindUI();
    renderPresetList();
    // Collapsible sections
    document.querySelectorAll('#inp-sidebar .inp-sec-hdr').forEach(hdr => {
      hdr.addEventListener('click', e => {
        if (e.target.closest('button')) return; // don't collapse when clicking Sync btn
        const body = hdr.nextElementSibling;
        if (!body || !body.classList.contains('inp-sec-body')) return;
        hdr.classList.toggle('collapsed');
        body.classList.toggle('hidden');
      });
    });
  }

  // Called each time the tab becomes active
  function onShow() {
    syncModels();
    syncSamplers();
    syncSchedulers();
  }

  // Mirror models from main selector
  function syncModels() {
    const src = q('sel-model');
    const dst = q('inp-sel-model');
    if (!src || !dst) return;
    if (src.options.length <= 1) return; // not loaded yet
    const prev = dst.value;
    dst.innerHTML = src.innerHTML;
    const saved = localStorage.getItem('swarm-inp-model');
    dst.value = saved || src.value || '';
    if (dst.value !== prev && prev) dst.value = prev;
  }

  // Mirror sampler from main selector
  function syncSamplers() {
    const src = q('sel-sampler');
    const dst = q('inp-sampler');
    if (!src || !dst) return;
    if (src.options.length === 0) return;
    const prev = dst.value;
    dst.innerHTML = src.innerHTML;
    const saved = localStorage.getItem('swarm-inp-sampler');
    dst.value = saved || src.value || '';
    if (dst.value !== prev && prev) dst.value = prev;
  }

  // Mirror scheduler from main selector
  function syncSchedulers() {
    const src = q('sel-scheduler');
    const dst = q('inp-scheduler');
    if (!src || !dst) return;
    if (src.options.length === 0) return;
    const prev = dst.value;
    dst.innerHTML = src.innerHTML;
    const saved = localStorage.getItem('swarm-inp-scheduler');
    dst.value = saved || src.value || '';
    if (dst.value !== prev && prev) dst.value = prev;
  }

  // ── Bind UI ────────────────────────────────────────────────────────────────
  function bindUI() {
    // Toolbar buttons
    q('inp-brush-btn').onclick  = () => setTool('brush');
    q('inp-eraser-btn').onclick = () => setTool('eraser');
    q('inp-undo-btn').onclick   = undo;
    q('inp-clear-btn').onclick  = clearMask;
    q('inp-invert-btn').onclick = invertMask;

    q('inp-brush-range').oninput = function () {
      S.brushSize = +this.value;
      q('inp-brush-val').textContent = this.value;
    };
    q('inp-opacity-range').oninput = function () {
      const c = q('inp-c-mask');
      if (c) c.style.opacity = this.value / 100;
    };
    q('inp-brush-opacity').oninput = function () {
      S.brushOpacity = this.value / 100;
      q('inp-brush-opacity-val').textContent = this.value;
    };

    // File loading
    q('inp-toolbar-load').onclick = () => q('inp-file-input').click();
    q('inp-drop-btn').onclick     = () => q('inp-file-input').click();
    q('inp-file-input').onchange  = e => { if (e.target.files[0]) loadFile(e.target.files[0]); };

    // Drag & drop
    const ctr = q('inp-canvas-wrap');
    ctr.ondragover = e => e.preventDefault();
    ctr.ondrop = e => {
      e.preventDefault();
      const f = e.dataTransfer.files[0];
      if (f && f.type.startsWith('image/')) loadFile(f);
    };

    // Canvas mouse events
    ctr.onmousedown = e => {
      if (!S.image || e.button !== 0) return;
      saveUndo();
      S.drawing = true;
      paintAt(getPos(e));
    };
    ctr.onmousemove = e => {
      if (!S.image) return;
      const pos = getPos(e);
      drawCursor(pos);
      if (S.drawing) paintAt(pos);
    };
    ctr.onmouseup    = () => { S.drawing = false; };
    ctr.onmouseleave = () => { S.drawing = false; clearCursor(); };

    // Sliders
    bindSlider('inp-denoise',    'inp-denoise-val',    2);
    bindSlider('inp-mblur',      'inp-mblur-val',      0);
    bindSlider('inp-pad',        'inp-pad-val',        0);
    bindSlider('inpp-steps',     'inpp-steps-val',     0);
    bindSlider('inpp-cfg',       'inpp-cfg-val',       1);

    // Size ratio buttons
    document.querySelectorAll('.inp-rbtn[data-w]').forEach(btn => {
      btn.onclick = () => { q('inp-w').value = btn.dataset.w; q('inp-h').value = btn.dataset.h; };
    });
    q('inp-auto-ratio').onclick = applyAutoRatio;

    // Area toggle (no auto-ratio on change)
    document.querySelectorAll('input[name="inp-area"]').forEach(r => {
      r.onchange = () => {};
    });

    // Paste
    document.addEventListener('paste', e => {
      if (!q('view-inpaint').classList.contains('active')) return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) loadFile(file);
          break;
        }
      }
    });

    // Presets
    q('inpp-preset-save').onclick = savePreset;
    q('inpp-preset-load').onclick = loadPreset;
    q('inpp-preset-del').onclick  = deletePreset;

    // Sync prompts from main tab

    // Save model/sampler selection
    q('inp-sel-model').onchange = () => localStorage.setItem('swarm-inp-model',   q('inp-sel-model').value);
    q('inp-sampler').onchange    = () => localStorage.setItem('swarm-inp-sampler',    q('inp-sampler').value);
    q('inp-scheduler').onchange  = () => localStorage.setItem('swarm-inp-scheduler', q('inp-scheduler').value);

    // Generate
    q('inp-gen-btn').onclick = generate;
    q('inp-clear-history').onclick = () => { q('inp-results').innerHTML = ''; };

    // Context menu (results)
    const ctxMenu = q('inp-ctx-menu');
    document.addEventListener('click', () => ctxMenu?.classList.remove('open'));
    q('inp-ctx-use').onclick = () => {
      const src = ctxMenu?._src;
      ctxMenu?.classList.remove('open');
      if (src) loadFromSrc(src);
    };
    q('inp-ctx-dl').onclick = async () => {
      const src = ctxMenu?._src;
      ctxMenu?.classList.remove('open');
      if (!src) return;
      try {
        const res   = await fetch(src);
        const buf   = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50;

        // Extract metadata: from result PNG first, fallback to source image metadata
        const metaJson = (isPNG ? extractPngMeta(buf) : null) || S.originalMetadata || null;

        let blob;
        if (isPNG) {
          const bmp = await createImageBitmap(new Blob([buf], { type: 'image/png' }));
          const c   = document.createElement('canvas');
          c.width = bmp.width; c.height = bmp.height;
          c.getContext('2d').drawImage(bmp, 0, 0);
          blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
        } else {
          blob = new Blob([buf], { type: 'image/jpeg' });
        }

        // Inject metadata as JPEG COM segment
        if (metaJson) {
          const jpgBuf = await blob.arrayBuffer();
          blob = new Blob([injectJpegCom(jpgBuf, metaJson)], { type: 'image/jpeg' });
        }

        const a = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = `inpaint-${Date.now()}.jpg`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
      } catch {
        const a = document.createElement('a'); a.href = src; a.download = `inpaint-${Date.now()}.jpg`; a.click();
      }
    };
  }

  function bindSlider(id, valId, dec) {
    const sl = q(id), vl = q(valId);
    if (sl && vl) sl.oninput = function () { vl.textContent = (+this.value).toFixed(dec); };
  }

  // ── Tool ───────────────────────────────────────────────────────────────────
  function setTool(tool) {
    S.tool = tool;
    q('inp-brush-btn').classList.toggle('on', tool === 'brush');
    q('inp-eraser-btn').classList.toggle('on', tool === 'eraser');
  }

  // ── Canvas ─────────────────────────────────────────────────────────────────
  function getPos(e) {
    const imgC = q('inp-c-img');
    const rect  = imgC.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (imgC.width  / rect.width),
      y: (e.clientY - rect.top)  * (imgC.height / rect.height),
    };
  }

  function paintAt(pos) {
    const ctx = S.maskCtx;
    if (S.tool === 'eraser') {
      ctx.globalCompositeOperation = 'destination-out';
      ctx.fillStyle = 'white';
    } else {
      ctx.globalCompositeOperation = 'source-over';
      const a = Math.round(S.brushOpacity * 255).toString(16).padStart(2, '0');
      ctx.fillStyle = `#ffffff${a}`;
    }
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, S.brushSize / 2, 0, Math.PI * 2);
    ctx.fill();
    syncMaskDisplay();
  }

  function syncMaskDisplay() {
    const display = q('inp-c-mask');
    const dCtx = display.getContext('2d');
    dCtx.clearRect(0, 0, display.width, display.height);
    dCtx.drawImage(S.maskCanvas, 0, 0);
    dCtx.globalCompositeOperation = 'source-in';
    dCtx.fillStyle = '#ff2020';
    dCtx.fillRect(0, 0, display.width, display.height);
    dCtx.globalCompositeOperation = 'source-over';
  }

  function drawCursor(pos) {
    const c = q('inp-c-cur');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = S.tool === 'eraser' ? '#aaa' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, S.brushSize / 2, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = ctx.strokeStyle;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function clearCursor() {
    const c = q('inp-c-cur');
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  function saveUndo() {
    if (!S.maskCtx) return;
    S.undoStack.push(S.maskCtx.getImageData(0, 0, S.maskCanvas.width, S.maskCanvas.height));
    if (S.undoStack.length > 30) S.undoStack.shift();
  }

  function undo() {
    if (!S.undoStack.length || !S.maskCtx) return;
    S.maskCtx.putImageData(S.undoStack.pop(), 0, 0);
    syncMaskDisplay();
  }

  function clearMask() {
    if (!S.maskCtx) return;
    saveUndo();
    S.maskCtx.clearRect(0, 0, S.maskCanvas.width, S.maskCanvas.height);
    syncMaskDisplay();
  }

  function invertMask() {
    if (!S.maskCtx) return;
    saveUndo();
    const w = S.maskCanvas.width, h = S.maskCanvas.height;
    const id = S.maskCtx.getImageData(0, 0, w, h);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const painted = d[i + 3] > 10;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = painted ? 0 : 255;
    }
    S.maskCtx.putImageData(id, 0, 0);
    syncMaskDisplay();
  }

  // ── Image load ─────────────────────────────────────────────────────────────
  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = e => {
      const img = new Image();
      img.onload = () => { S.image = img; S.imageData = e.target.result; setupCanvas(img); };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  }

  function loadFromSrc(src) {
    setStatus('Loading image…');
    S.originalMetadata = null;
    if (src.startsWith('data:')) {
      const img = new Image();
      img.onload = () => { S.image = img; S.imageData = src; setupCanvas(img); setStatus(''); };
      img.src = src;
    } else {
      fetch(src)
        .then(r => r.blob())
        .then(async blob => {
          // Parse metadata from binary
          try {
            const buf   = await blob.arrayBuffer();
            const bytes = new Uint8Array(buf);
            const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50;
            const isJPG = bytes[0] === 0xFF && bytes[1] === 0xD8;
            if (isPNG) {
              const view = new DataView(buf);
              let off = 8;
              while (off < buf.byteLength - 12) {
                const len  = view.getUint32(off); off += 4;
                const type = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]); off += 4;
                if (type === 'tEXt') {
                  const raw = bytes.slice(off, off + len);
                  const nul = raw.indexOf(0);
                  if (new TextDecoder().decode(raw.slice(0, nul)) === 'parameters') {
                    S.originalMetadata = new TextDecoder().decode(raw.slice(nul + 1)); break;
                  }
                }
                if (type === 'IEND') break;
                off += len + 4;
              }
            } else if (isJPG) {
              let off = 2;
              while (off < bytes.length - 4) {
                if (bytes[off] !== 0xFF) break;
                const marker = bytes[off + 1];
                const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
                if (marker === 0xE1) {
                  const hdr = new TextDecoder('ascii').decode(bytes.slice(off + 4, off + 10));
                  if (hdr.startsWith('Exif\0')) {
                    const exifBase = off + 10;
                    const tiff = new DataView(buf, exifBase);
                    const le   = tiff.getUint16(0) === 0x4949;
                    const rd16 = o => tiff.getUint16(o, le);
                    const rd32 = o => tiff.getUint32(o, le);
                    const ifd0 = rd32(4); const n0 = rd16(ifd0);
                    let exifIfdOff = 0;
                    for (let i = 0; i < n0; i++) { const e = ifd0 + 2 + i * 12; if (rd16(e) === 0x8769) { exifIfdOff = rd32(e + 8); break; } }
                    if (exifIfdOff) {
                      const nE = rd16(exifIfdOff);
                      for (let i = 0; i < nE; i++) {
                        const e = exifIfdOff + 2 + i * 12;
                        if (rd16(e) === 0x9286) {
                          const count = rd32(e + 4), valOff = rd32(e + 8);
                          const rawFull = new Uint8Array(buf, exifBase + valOff, count);
                          const prefix  = new TextDecoder('ascii').decode(rawFull.slice(0, 8));
                          const skip    = prefix.trimEnd().replace(/\0/g, '').match(/^(ASCII|UNICODE|JIS)$/) ? 8 : 0;
                          S.originalMetadata = new TextDecoder().decode(rawFull.slice(skip)).replace(/\0/g, '').trim();
                          break;
                        }
                      }
                    }
                  }
                }
                if (marker === 0xDA) break;
                off += 2 + segLen;
              }
            }
          } catch {}
          return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload  = e => resolve(e.target.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
          });
        })
        .then(dataUrl => {
          const img = new Image();
          img.onload = () => { S.image = img; S.imageData = dataUrl; setupCanvas(img); setStatus(''); };
          img.src = dataUrl;
        })
        .catch(err => setStatus(`❌ ${err.message}`));
    }
  }

  function setupCanvas(img) {
    const wrap = q('inp-canvas-wrap');
    const maxW = (wrap?.clientWidth  || window.innerWidth  - 340) - 40;
    const maxH = (wrap?.clientHeight || window.innerHeight - 120) - 40;
    const scale = Math.min(maxW / img.width, maxH / img.height, 1);
    const dW = Math.round(img.width  * scale);
    const dH = Math.round(img.height * scale);

    const imgC = q('inp-c-img');
    imgC.width = dW; imgC.height = dH;
    imgC.getContext('2d').drawImage(img, 0, 0, dW, dH);

    S.maskCanvas = document.createElement('canvas');
    S.maskCanvas.width  = dW;
    S.maskCanvas.height = dH;
    S.maskCtx = S.maskCanvas.getContext('2d', { willReadFrequently: true });
    S.undoStack = [];

    const maskC = q('inp-c-mask');
    maskC.width = dW; maskC.height = dH;
    maskC.style.opacity = q('inp-opacity-range').value / 100;

    const curC = q('inp-c-cur');
    curC.width = dW; curC.height = dH;

    const stack = q('inp-stack');
    stack.style.width   = dW + 'px';
    stack.style.height  = dH + 'px';
    stack.style.display = 'block';
    q('inp-drop-zone').style.display = 'none';
  }

  // ── Size helpers ───────────────────────────────────────────────────────────
  function applyAutoRatio() {
    if (!S.image) return;
    const ratio = S.image.width / S.image.height;
    let best = STD_SIZES[0], bestDiff = Infinity;
    for (const sz of STD_SIZES) {
      const diff = Math.abs(sz.w / sz.h - ratio);
      if (diff < bestDiff) { bestDiff = diff; best = sz; }
    }
    q('inp-w').value = best.w;
    q('inp-h').value = best.h;
  }

  function syncSizeToArea() {
    if (!S.image) return;
    const mode = getRadio('inp-area');
    if (mode === 'only_masked') {
      // Show original dims — actual generation is 1024×1024 crop + recomposite
      q('inp-w').value = S.image.width;
      q('inp-h').value = S.image.height;
    } else {
      // Whole picture: pick best SDXL-native ratio matching the image aspect
      applyAutoRatio();
    }
  }

  // ── Mask export ────────────────────────────────────────────────────────────
  function exportMask() {
    const out = document.createElement('canvas');
    out.width  = S.image.width;
    out.height = S.image.height;
    const ctx = out.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(S.maskCanvas, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  function getMaskBBox() {
    const w = S.maskCanvas.width, h = S.maskCanvas.height;
    const d = S.maskCtx.getImageData(0, 0, w, h).data;
    let x1 = w, y1 = h, x2 = 0, y2 = 0;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (d[(y * w + x) * 4 + 3] > 10) {
          if (x < x1) x1 = x; if (x > x2) x2 = x;
          if (y < y1) y1 = y; if (y > y2) y2 = y;
        }
      }
    }
    if (x1 > x2) return null;
    return { x1, y1, x2, y2 };
  }

  function buildOnlyMaskedPayload(targetW, targetH, padding) {
    const bbox = getMaskBBox();
    if (!bbox) return null;

    const dW    = S.maskCanvas.width, dH = S.maskCanvas.height;
    const scaleX = S.image.width / dW, scaleY = S.image.height / dH;

    const ox1 = Math.max(0,              Math.floor((bbox.x1 - padding / scaleX) * scaleX));
    const oy1 = Math.max(0,              Math.floor((bbox.y1 - padding / scaleY) * scaleY));
    const ox2 = Math.min(S.image.width,  Math.ceil ((bbox.x2 + padding / scaleX) * scaleX));
    const oy2 = Math.min(S.image.height, Math.ceil ((bbox.y2 + padding / scaleY) * scaleY));
    const cW  = ox2 - ox1, cH = oy2 - oy1;

    const initCrop = document.createElement('canvas');
    initCrop.width = targetW; initCrop.height = targetH;
    initCrop.getContext('2d').drawImage(S.image, ox1, oy1, cW, cH, 0, 0, targetW, targetH);

    const maskOrig = document.createElement('canvas');
    maskOrig.width = S.image.width; maskOrig.height = S.image.height;
    const mCtx = maskOrig.getContext('2d');
    mCtx.fillStyle = 'black'; mCtx.fillRect(0, 0, maskOrig.width, maskOrig.height);
    mCtx.drawImage(S.maskCanvas, 0, 0, S.image.width, S.image.height);

    const maskCrop = document.createElement('canvas');
    maskCrop.width = targetW; maskCrop.height = targetH;
    const mcCtx = maskCrop.getContext('2d');
    mcCtx.fillStyle = 'black'; mcCtx.fillRect(0, 0, targetW, targetH);
    mcCtx.drawImage(maskOrig, ox1, oy1, cW, cH, 0, 0, targetW, targetH);

    return {
      initImage: initCrop.toDataURL('image/png'),
      maskImage: maskCrop.toDataURL('image/png'),
      bbox: { ox1, oy1, cW, cH },
    };
  }

  function recompositeResult(resultSrc, bbox) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const out = document.createElement('canvas');
        out.width = S.image.width; out.height = S.image.height;
        const ctx = out.getContext('2d');
        ctx.drawImage(S.image, 0, 0);
        ctx.drawImage(img, 0, 0, img.naturalWidth, img.naturalHeight,
          bbox.ox1, bbox.oy1, bbox.cW, bbox.cH);
        resolve(out.toDataURL('image/png'));
      };
      img.src = resultSrc;
    });
  }

  // Whole-picture recomposite:
  // 1. Draw original image at full resolution
  // 2. Scale result (SDXL size) back to original resolution
  // 3. Clip result to masked area using the original mask
  // 4. Layer clipped result on top of original
  function recompositeWhole(resultSrc) {
    return new Promise(resolve => {
      const img = new Image();
      img.onload = () => {
        const W = S.image.width, H = S.image.height;

        // Scale result to original resolution
        const resultFull = document.createElement('canvas');
        resultFull.width = W; resultFull.height = H;
        resultFull.getContext('2d').drawImage(img, 0, 0, W, H);

        // Clip result to masked area (keep only white-mask pixels)
        const resultCtx = resultFull.getContext('2d');
        resultCtx.globalCompositeOperation = 'destination-in';
        resultCtx.drawImage(S.maskCanvas, 0, 0, W, H);
        resultCtx.globalCompositeOperation = 'source-over';

        // Composite: original first, then masked result on top
        const out = document.createElement('canvas');
        out.width = W; out.height = H;
        const ctx = out.getContext('2d');
        ctx.drawImage(S.image, 0, 0);
        ctx.drawImage(resultFull, 0, 0);

        resolve(out.toDataURL('image/png'));
      };
      img.src = resultSrc;
    });
  }

  // ── Presets ────────────────────────────────────────────────────────────────
  function getPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; }
  }
  function savePresetsData(obj) { localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); }

  function collectSettings() {
    return {
      model:   q('inp-sel-model').value,
      prompt:  q('inp-prompt').value,
      neg:     q('inp-neg').value,
      denoise: q('inp-denoise').value,
      mblur:   q('inp-mblur').value,
      mmode:   getRadio('inp-mmode'),
      area:    getRadio('inp-area'),
      pad:     q('inp-pad').value,
      sampler:    q('inp-sampler').value,
      scheduler:  q('inp-scheduler').value,
      steps:    q('inpp-steps').value,
      cfg:      q('inpp-cfg').value,
      soft:     q('inpp-soft').checked,
      w:        q('inp-w').value,
      h:       q('inp-h').value,
    };
  }

  function applySettings(p) {
    const setSl = (id, valId, v, dec) => {
      const el = q(id); if (!el || v === undefined) return;
      el.value = v;
      if (valId && q(valId)) q(valId).textContent = (+v).toFixed(dec);
    };
    if (p.model  !== undefined && q('inp-sel-model')) q('inp-sel-model').value = p.model;
    if (p.prompt !== undefined) q('inp-prompt').value = p.prompt;
    if (p.neg    !== undefined) q('inp-neg').value    = p.neg;
    setSl('inp-denoise', 'inp-denoise-val', p.denoise, 2);
    setSl('inp-mblur',   'inp-mblur-val',   p.mblur,   0);
    setSl('inp-pad',     'inp-pad-val',     p.pad,     0);
    setSl('inpp-steps',     'inpp-steps-val',     p.steps,    0);
    setSl('inpp-cfg',       'inpp-cfg-val',       p.cfg,      1);
    if (p.soft !== undefined) q('inpp-soft').checked = p.soft;
    if (p.mmode)   { const el = document.querySelector(`input[name="inp-mmode"][value="${p.mmode}"]`);   if (el) el.checked = true; }
    if (p.area)    { const el = document.querySelector(`input[name="inp-area"][value="${p.area}"]`);     if (el) el.checked = true; }
    if (p.sampler)    q('inp-sampler').value    = p.sampler;
    if (p.scheduler)  q('inp-scheduler').value  = p.scheduler;
    if (p.w)       q('inp-w').value = p.w;
    if (p.h)       q('inp-h').value = p.h;
  }

  function renderPresetList() {
    const sel = q('inpp-preset-sel');
    if (!sel) return;
    const presets = getPresets();
    sel.innerHTML = '<option value="">— Select —</option>' +
      Object.keys(presets).sort().map(n => `<option value="${n}">${n}</option>`).join('');
  }

  function savePreset() {
    const name = q('inpp-preset-name').value.trim();
    if (!name) return;
    const presets = getPresets();
    presets[name] = collectSettings();
    savePresetsData(presets);
    renderPresetList();
    q('inpp-preset-sel').value = name;
    q('inpp-preset-name').value = '';
  }

  function loadPreset() {
    const name = q('inpp-preset-sel').value;
    if (!name) return;
    const p = getPresets()[name];
    if (p) applySettings(p);
  }

  function deletePreset() {
    const name = q('inpp-preset-sel').value;
    if (!name) return;
    const presets = getPresets();
    delete presets[name];
    savePresetsData(presets);
    renderPresetList();
  }

  // ── Generate ───────────────────────────────────────────────────────────────
  function setStatus(msg) { const el = q('inp-status'); if (el) el.textContent = msg; }
  function setProgress(pct) { const el = q('inp-pbar'); if (el) el.style.width = pct + '%'; }
  function getRadio(name)   { return document.querySelector(`input[name="${name}"]:checked`)?.value; }

  async function generate() {
    if (!S.image)                 { setStatus('⚠ Load an image first'); return; }
    if (!q('inp-sel-model').value){ setStatus('⚠ Select a model'); return; }
    if (S.running) return;

    S.running = true;
    const btn = q('inp-gen-btn');
    btn.textContent   = 'Stop';
    btn.style.background = 'var(--red)';
    // Add separator between generations (history)
    const results = q('inp-results');
    if (results.children.length > 0) {
      const sep = document.createElement('div');
      sep.className = 'inp-hist-sep';
      sep.textContent = new Date().toLocaleTimeString();
      results.prepend(sep);
    }
    setProgress(0);
    setStatus('Connecting…');

    try {
      const session = await API.getSession();
      setStatus('Generating…');
      setProgress(8);

      const pad  = +q('inp-pad').value;
      const mode = getRadio('inp-area');

      const payload = {
        session_id:               session,
        images:                   1,
        model:                    q('inp-sel-model').value,
        prompt:                   q('inp-prompt').value || '',
        negativeprompt:           q('inp-neg').value    || '',
        steps:                    +q('inpp-steps').value,
        cfgscale:                 +q('inpp-cfg').value,
        seed:                     -1,
        width:                    +q('inp-w').value,
        height:                   +q('inp-h').value,
        sampler:                  q('inp-sampler').value   || undefined,
        scheduler:                q('inp-scheduler').value || undefined,
        initimagecreativity:      +q('inp-denoise').value,
        maskblur:                 +q('inp-mblur').value,
        initimagerecompositemask: getRadio('inp-mmode') !== 'not_masked',
        maskbehavior:             q('inpp-soft').checked ? 'Differential' : 'Simple Latent',
      };

      if (mode === 'only_masked') {
        // Ratio-correct target size based on bbox
        const rawBbox = getMaskBBox();
        if (!rawBbox) {
          setStatus('⚠ Paint a mask first');
          S.running = false;
          btn.textContent = 'Generate'; btn.style.background = '';
          return;
        }
        const cropW = +q('inp-w').value || 1024;
        const cropH = +q('inp-h').value || 1024;

        const crop = buildOnlyMaskedPayload(cropW, cropH, pad);
        if (!crop) {
          setStatus('⚠ Paint a mask first');
          S.running = false;
          btn.textContent = 'Generate'; btn.style.background = '';
          return;
        }
        payload.initimage = crop.initImage;
        payload.maskimage = crop.maskImage;
        payload.width     = cropW;
        payload.height    = cropH;
        S.pendingCrop  = crop.bbox;
        S.pendingWhole = false;
      } else {
        // Whole picture: resize image + mask to the SDXL target size.
        // We handle the recomposite ourselves (client-side) so SwarmUI just generates.
        const tW = +q('inp-w').value;
        const tH = +q('inp-h').value;

        // Initimage: original scaled to SDXL target
        const initC = document.createElement('canvas');
        initC.width = tW; initC.height = tH;
        initC.getContext('2d').drawImage(S.image, 0, 0, tW, tH);

        // Maskimage: mask scaled to SDXL target (black bg, white = inpaint)
        const maskC = document.createElement('canvas');
        maskC.width = tW; maskC.height = tH;
        const mCtx = maskC.getContext('2d');
        mCtx.fillStyle = 'black';
        mCtx.fillRect(0, 0, tW, tH);
        mCtx.drawImage(S.maskCanvas, 0, 0, tW, tH);

        payload.initimage                = initC.toDataURL('image/png');
        payload.maskimage                = maskC.toDataURL('image/png');
        payload.initimagerecompositemask = false; // we composite ourselves
        S.pendingCrop  = null;
        S.pendingWhole = true;
        if (pad > 0) payload.maskgrow = pad;
      }

      await new Promise((resolve, reject) => {
        const ws = new WebSocket(`ws://${API.host}/API/GenerateText2ImageWS`);
        ws.onopen    = () => ws.send(JSON.stringify(payload));
        let gotDone = false, gotImage = false;
        ws.onmessage = async e => {
          const msg = JSON.parse(e.data);
          if (msg.error) { reject(new Error(msg.error)); ws.close(); return; }
          if (msg.gen_progress) {
            const gp = msg.gen_progress;
            const pct = gp.overall_percent ?? gp.current_percent ?? 0;
            setProgress(8 + pct * 88);
            setStatus(`Generating… ${Math.round(pct * 100)}%`);
            if (gp.preview) showLivePreview(gp.preview);
          }
          if (msg.image) { gotImage = true; hideLivePreview(); await showResult(msg.image); }
          if (msg.done === true) { gotDone = true; setProgress(100); setStatus('✅ Done'); ws.close(); resolve(); }
        };
        ws.onerror = () => reject(new Error('WebSocket error'));
        ws.onclose = () => { if (!gotDone && !gotImage) reject(new Error('Generation failed — server closed unexpectedly')); else resolve(); };
      });

    } catch (err) {
      setStatus(`❌ ${err.message}`);
      console.error('[Inpaint]', err);
      if (typeof showErrorToast === 'function') showErrorToast(err.message);
    }

    S.running = false;
    btn.textContent   = 'Generate';
    btn.style.background = '';
  }

  function showLivePreview(dataUrl) {
    let el = q('inp-live-preview');
    if (!el) {
      el = document.createElement('img');
      el.id = 'inp-live-preview';
      el.style.cssText = 'width:100%;border-radius:8px;opacity:0.8;border:2px dashed var(--accent);margin-bottom:8px;display:block;';
      q('inp-results').prepend(el);
    }
    el.src = dataUrl;
  }

  function hideLivePreview() {
    const el = q('inp-live-preview');
    if (el) el.remove();
  }

  async function showResult(imgData) {
    let src = imgData.startsWith('data:') ? imgData
            : imgData.startsWith('http')  ? imgData
            : `http://${API.host}/${imgData.replace(/^\//, '')}`;
    if (S.pendingWhole) {
      src = await recompositeWhole(src);
    } else if (S.pendingCrop) {
      src = await recompositeResult(src, S.pendingCrop);
    }
    const img = document.createElement('img');
    img.src   = src;
    img.title = 'Click to open fullscreen';
    img.onclick = () => {
      const lb = document.getElementById('lightbox');
      const lbImg = document.getElementById('lightbox-img');
      if (lb && lbImg) { lbImg.src = src; lb.classList.remove('hidden'); }
    };
    img.addEventListener('contextmenu', e => {
      e.preventDefault();
      const ctxMenu = q('inp-ctx-menu');
      if (!ctxMenu) return;
      ctxMenu._src = src;
      ctxMenu.style.left = Math.min(e.clientX, window.innerWidth  - 190) + 'px';
      ctxMenu.style.top  = Math.min(e.clientY, window.innerHeight - 60)  + 'px';
      ctxMenu.classList.add('open');
    });
    q('inp-results').prepend(img);
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return { init, onShow, loadFromSrc };

})();
