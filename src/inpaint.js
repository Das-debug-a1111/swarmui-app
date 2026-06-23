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
    pendingCrop:      null,  // kept for compat but unused with Forge
    pendingWhole:     false, // kept for compat but unused with Forge
    originalMetadata: null,  // raw JSON metadata from the source image
    forgeOnline:      false,
    _retryTimer:      null,
    _abort:           null,  // AbortController for in-flight Forge request
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

  // ── Inpaint instances ──────────────────────────────────────────────────────
  const _instStates = [{}]; // one state object per instance

  function serializeCanvas() {
    if (!S.maskCanvas || !S.image) return { imageData: null, maskData: null };
    // Full-res image
    const imgC = document.createElement('canvas');
    imgC.width = S.image.width; imgC.height = S.image.height;
    imgC.getContext('2d').drawImage(S.image, 0, 0);
    // Full-res mask (black bg, white = painted)
    const mskC = document.createElement('canvas');
    mskC.width = S.image.width; mskC.height = S.image.height;
    const mCtx = mskC.getContext('2d');
    mCtx.fillStyle = 'black';
    mCtx.fillRect(0, 0, mskC.width, mskC.height);
    mCtx.drawImage(S.maskCanvas, 0, 0, mskC.width, mskC.height);
    return {
      imageData: imgC.toDataURL('image/jpeg', 0.92), // JPEG to save memory
      maskData:  mskC.toDataURL('image/png'),
    };
  }

  function restoreCanvas(imageData, maskData) {
    if (!imageData) {
      // No image → show drop zone, clear canvas state
      S.image = null; S.imageData = null; S.maskCanvas = null; S.maskCtx = null;
      q('inp-stack').style.display  = 'none';
      q('inp-drop-zone').style.display = '';
      q('inp-c-img').width = q('inp-c-mask').width = q('inp-c-cur').width = 0;
      return;
    }
    const img = new Image();
    img.onload = () => {
      S.image = img; S.imageData = imageData;
      setupCanvas(img);
      if (maskData) {
        const mImg = new Image();
        mImg.onload = () => {
          if (!S.maskCtx) return;
          // Scale the stored mask back to canvas dimensions
          S.maskCtx.clearRect(0, 0, S.maskCanvas.width, S.maskCanvas.height);
          // Only draw white (painted) pixels from the mask
          const tmpC = document.createElement('canvas');
          tmpC.width  = S.maskCanvas.width;
          tmpC.height = S.maskCanvas.height;
          const tmpCtx = tmpC.getContext('2d');
          tmpCtx.drawImage(mImg, 0, 0, tmpC.width, tmpC.height);
          // Extract alpha from white pixels
          const id  = tmpCtx.getImageData(0, 0, tmpC.width, tmpC.height);
          const out = S.maskCtx.createImageData(tmpC.width, tmpC.height);
          for (let i = 0; i < id.data.length; i += 4) {
            const lum = id.data[i]; // R channel (white = 255, black = 0)
            out.data[i]     = 255;
            out.data[i + 1] = 255;
            out.data[i + 2] = 255;
            out.data[i + 3] = lum; // alpha = brightness
          }
          S.maskCtx.putImageData(out, 0, 0);
          syncMaskDisplay();
        };
        mImg.src = maskData;
      }
    };
    img.src = imageData;
  }

  function collectInpaintState() {
    const canvas = serializeCanvas();
    return {
      ...collectSettings(),
      imageData: canvas.imageData,
      maskData:  canvas.maskData,
    };
  }

  function applyInpaintState(state) {
    const s = state || {};
    applySettings(s);
    restoreCanvas(s.imageData ?? null, s.maskData ?? null);
  }

  // ── Forge connection ───────────────────────────────────────────────────────
  function getForgeUrl() {
    return (q('inp-forge-url')?.value.trim() || localStorage.getItem('forge-url') || 'http://192.168.8.67:58190').replace(/\/$/, '');
  }

  function setForgeIndicator(online) {
    const el = q('inp-forge-indicator');
    if (!el) return;
    el.textContent = online ? '● Online' : '● Offline';
    el.style.color  = online ? 'var(--green)' : 'var(--red)';
  }

  function showOffline() {
    const el = q('inp-forge-offline');
    if (el) el.style.display = '';
  }
  function hideOffline() {
    const el = q('inp-forge-offline');
    if (el) el.style.display = 'none';
  }

  // ── Forge LoRAs ────────────────────────────────────────────────────────────
  let _forgeLoras = []; // [{name, alias}]

  async function loadForgeLoras() {
    try {
      const d = await fetch(`${getForgeUrl()}/sdapi/v1/loras`).then(r => r.json());
      _forgeLoras = Array.isArray(d) ? d : [];
      // Refresh any open LoRA selects
      q('inp-lora-list')?.querySelectorAll('.inp-lora-sel').forEach(sel => {
        const cur = sel.value;
        sel.innerHTML = loraOptions();
        if (cur) sel.value = cur;
      });
    } catch { _forgeLoras = []; }
  }

  function loraOptions() {
    return '<option value="">— Select LoRA —</option>' +
      _forgeLoras.map(l =>
        `<option value="${esc(l.name)}">${esc(l.alias || l.name)}</option>`
      ).join('');
  }

  function addInpLora(name = '', weight = 0.8) {
    const list = q('inp-lora-list');
    const row  = document.createElement('div');
    row.className = 'inp-lora-row';
    row.innerHTML = `
      <select class="inp-sel inp-lora-sel" style="flex:1;min-width:0;font-size:11px">${loraOptions()}</select>
      <input type="number" class="inp-field inp-lora-weight" value="${weight}"
             min="0" max="2" step="0.05" style="width:52px;text-align:center;font-size:11px" title="Weight">
      <button class="inp-btn-sm inp-btn-danger inp-lora-del" style="padding:2px 6px" title="Remove">✕</button>`;
    list.appendChild(row);
    if (name) row.querySelector('.inp-lora-sel').value = name;
    row.querySelector('.inp-lora-del').addEventListener('click', () => {
      row.remove();
      updateInpLoraCount();
    });
    updateInpLoraCount();
  }

  function updateInpLoraCount() {
    const n  = q('inp-lora-list')?.querySelectorAll('.inp-lora-row').length ?? 0;
    const el = q('inp-lora-count');
    if (el) el.textContent = n ? `(${n})` : '';
    const list = q('inp-lora-list');
    if (list) list.style.display = n ? '' : 'none';
    if (q('inp-lora-arrow')) q('inp-lora-arrow').textContent = n ? '▼' : '▶';
  }

  function collectInpLoras() {
    return [...(q('inp-lora-list')?.querySelectorAll('.inp-lora-row') || [])].map(row => ({
      name:   row.querySelector('.inp-lora-sel').value,
      weight: +row.querySelector('.inp-lora-weight').value || 0.8,
    })).filter(l => l.name);
  }

  function buildPromptWithLoras(prompt) {
    const loras = collectInpLoras();
    if (!loras.length) return prompt;
    const tags = loras.map(l => `<lora:${l.name}:${l.weight}>`).join(' ');
    return prompt ? `${prompt} ${tags}` : tags;
  }

  async function loadForgeModels() {
    const d = await fetch(`${getForgeUrl()}/sdapi/v1/sd-models`).then(r => {
      if (!r.ok) throw new Error(`Forge /sd-models: ${r.status}`);
      return r.json();
    });
    const sel = q('inp-sel-model');
    if (!sel || !d?.length) return;
    const saved = localStorage.getItem('forge-inp-model');
    sel.innerHTML = d.map(m =>
      `<option value="${esc(m.title)}"${m.title === saved ? ' selected' : ''}>${esc(m.title)}</option>`
    ).join('');
    if (saved && [...sel.options].some(o => o.value === saved)) sel.value = saved;
  }

  async function loadForgeSamplers() {
    const d = await fetch(`${getForgeUrl()}/sdapi/v1/samplers`).then(r => {
      if (!r.ok) throw new Error(`Forge /samplers: ${r.status}`);
      return r.json();
    });
    const sel = q('inp-sampler');
    if (!sel || !d?.length) return;
    const saved = localStorage.getItem('forge-inp-sampler') || 'DPM++ 2M';
    sel.innerHTML = d.map(s =>
      `<option value="${esc(s.name)}"${s.name === saved ? ' selected' : ''}>${esc(s.name)}</option>`
    ).join('');
    if (saved) sel.value = saved;
  }

  async function loadForgeSchedulers() {
    const FALLBACK = ['Automatic','Karras','Exponential','Polyexponential','SGM Uniform','KL Optimal','Normal','Simple'];
    const sel = q('inp-scheduler');
    if (!sel) return;
    const saved = localStorage.getItem('forge-inp-scheduler') || 'Karras';
    let names = FALLBACK;
    try {
      const d = await fetch(`${getForgeUrl()}/sdapi/v1/schedulers`).then(r => {
        if (!r.ok) throw new Error('no schedulers');
        return r.json();
      });
      if (d?.length) names = d.map(s => s.name || s.label || s);
    } catch { /* use fallback */ }
    sel.innerHTML = names.map(n =>
      `<option value="${esc(n)}"${n === saved ? ' selected' : ''}>${esc(n)}</option>`
    ).join('');
    if (saved) sel.value = saved;
  }

  async function connectForge() {
    setStatus('Connecting to Forge…');
    setForgeIndicator(false);
    try {
      await loadForgeModels();
      await loadForgeSamplers();
      await loadForgeSchedulers();
      await loadForgeLoras();
      S.forgeOnline = true;
      setForgeIndicator(true);
      hideOffline();
      setStatus('');
      if (S._retryTimer) { clearInterval(S._retryTimer); S._retryTimer = null; }
    } catch (e) {
      S.forgeOnline = false;
      setForgeIndicator(false);
      showOffline();
      setStatus('');
      const hint = e.message.includes('404')
        ? 'Forge tourne mais API désactivée — ajoutez --api au lancement'
        : e.message.includes('Failed to fetch') || e.message.includes('NetworkError')
          ? 'Forge inaccessible — vérifiez que Forge est démarré (pc forge)'
          : e.message;
      console.warn('[Inpaint] Forge:', hint);
      // Show hint in the offline notice
      const noticeEl = q('inp-forge-offline')?.querySelector('.inp-forge-hint');
      if (noticeEl) noticeEl.textContent = hint;
      // Retry automatique toutes les 10s tant que Forge est offline
      if (!S._retryTimer) {
        S._retryTimer = setInterval(async () => {
          try {
            await fetch(`${getForgeUrl()}/sdapi/v1/progress`, { method: 'GET' });
            // Forge répond → reconnecter proprement
            clearInterval(S._retryTimer); S._retryTimer = null;
            connectForge();
          } catch { /* toujours offline */ }
        }, 10000);
      }
    }
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    if (S.initialized) return;
    S.initialized = true;
    // Restore saved Forge URL into input before binding
    const savedUrl = localStorage.getItem('forge-url');
    if (savedUrl && q('inp-forge-url')) q('inp-forge-url').value = savedUrl;
    bindUI();
    renderPresetList();

    // Instance bar
    createInstanceBar(q('inp-inst-bar'), {
      onSave:   (idx) => { _instStates[idx] = collectInpaintState(); },
      onLoad:   (idx) => { applyInpaintState(_instStates[idx]); },
      onNew:    (idx) => { _instStates[idx] = {}; },
      onRemove: (idx) => { _instStates.splice(idx, 1); },
    });

    document.querySelectorAll('#inp-sidebar .inp-sec-hdr').forEach(hdr => {
      hdr.addEventListener('click', e => {
        if (e.target.closest('button')) return;
        const body = hdr.nextElementSibling;
        if (!body || !body.classList.contains('inp-sec-body')) return;
        hdr.classList.toggle('collapsed');
        body.classList.toggle('hidden');
      });
    });
  }

  // Called each time the tab becomes active
  function onShow() {
    if (!S.initialized) init();
    connectForge();
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
    bindSlider('inp-denoise',       'inp-denoise-val',       2);
    bindSlider('inp-mblur',         'inp-mblur-val',         0);
    bindSlider('inp-pad',           'inp-pad-val',           0);
    bindSlider('inpp-steps',        'inpp-steps-val',        0);
    bindSlider('inpp-cfg',          'inpp-cfg-val',          1);
    bindSlider('inp-soft-bias',        'inp-soft-bias-val',        1);
    bindSlider('inp-soft-str',         'inp-soft-str-val',         2);
    bindSlider('inp-soft-contrast',    'inp-soft-contrast-val',    1);
    bindSlider('inp-soft-maskinf',     'inp-soft-maskinf-val',     2);
    bindSlider('inp-soft-diffthresh',  'inp-soft-diffthresh-val',  2);
    bindSlider('inp-soft-diffcontrast','inp-soft-diffcontrast-val',1);

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

    // Save model/sampler selection (Forge-specific keys)
    q('inp-sel-model').onchange = () => localStorage.setItem('forge-inp-model',     q('inp-sel-model').value);
    q('inp-sampler').onchange   = () => localStorage.setItem('forge-inp-sampler',   q('inp-sampler').value);
    q('inp-scheduler').onchange = () => localStorage.setItem('forge-inp-scheduler', q('inp-scheduler').value);

    // LoRA section toggle + add
    q('inp-lora-toggle')?.addEventListener('click', e => {
      if (e.target.closest('#inp-lora-add')) return; // handled separately
      const list  = q('inp-lora-list');
      const arrow = q('inp-lora-arrow');
      if (!list) return;
      const open = list.style.display === 'none' || list.style.display === '';
      // Only toggle if there are rows (otherwise "add" opens it)
      if (q('inp-lora-list').querySelectorAll('.inp-lora-row').length) {
        list.style.display = list.style.display === 'none' ? '' : 'none';
        if (arrow) arrow.textContent = list.style.display === 'none' ? '▶' : '▼';
      }
    });
    q('inp-lora-add')?.addEventListener('click', e => {
      e.stopPropagation();
      addInpLora();
    });

    // Forge URL persistence + reconnect
    q('inp-forge-url')?.addEventListener('change', () => {
      localStorage.setItem('forge-url', q('inp-forge-url').value.trim());
    });
    q('inp-forge-reconnect')?.addEventListener('click', connectForge);

    // Soft Inpainting — show/hide sub-params
    q('inpp-soft')?.addEventListener('change', () => {
      const panel = q('inpp-soft-params');
      if (panel) panel.style.display = q('inpp-soft').checked ? '' : 'none';
    });

    // Generate
    q('inp-gen-btn').onclick = generate;

    // Add to Scheduler
    q('inp-sched-btn').onclick = () => {
      if (!S.image) { setStatus('⚠ Charge une image d\'abord'); return; }
      if (typeof Scheduler === 'undefined') { setStatus('⚠ Scheduler non disponible'); return; }

      const { imageData, maskData } = serializeCanvas();
      if (!imageData) { setStatus('⚠ Canvas vide'); return; }

      const loras = [...document.querySelectorAll('#inp-lora-list .inp-lora-row')].map(row => ({
        model:  row.querySelector('.inp-lora-sel')?.value  || '',
        weight: +(row.querySelector('.inp-lora-weight')?.value ?? 1),
      })).filter(l => l.model);

      Scheduler.addInpaintTask({
        name:     `Inpaint — ${new Date().toLocaleTimeString()}`,
        prompt:   q('inp-prompt')?.value   || '',
        negative: q('inp-neg')?.value      || '',
        model:    q('inp-sel-model')?.value || '',
        steps:    +(q('inpp-steps')?.value || 20),
        cfg:      +(q('inpp-cfg')?.value   || 7),
        seed:     -1,
        count:    1,
        width:    S.image.width,
        height:   S.image.height,
        loras,
        inpaint: {
          image:     imageData,
          mask:      maskData,
          denoising: +(q('inp-denoise')?.value ?? 0.75),
          maskMode:  getRadio('inp-mmode') || 'masked',
        },
      });
      setStatus('✅ Ajouté au Scheduler !');
    };

    q('inp-clear-history').onclick = () => {
      q('inp-results').innerHTML = '';
      if (q('inp-dl-history')) q('inp-dl-history').style.display = 'none';
    };

    q('inp-dl-history').onclick = async () => {
      const imgs = [...q('inp-results').querySelectorAll('img:not(#inp-live-preview)')];
      if (!imgs.length) return;
      const btn = q('inp-dl-history');
      btn.disabled = true; btn.textContent = '⏳';
      try {
        const zip  = new JSZip();
        const date = new Date().toISOString().slice(0, 10);
        let idx = 1;
        for (const img of imgs) {
          try {
            const res  = await fetch(img.src);
            const blob = await res.blob();
            const ext  = blob.type.includes('png') ? 'png' : 'jpg';
            zip.file(`inpaint_${date}_${String(idx).padStart(3, '0')}.${ext}`, blob);
            idx++;
          } catch { /* skip */ }
        }
        const blob = await zip.generateAsync({ type: 'blob' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = `inpaint_${date}.zip`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      } finally {
        btn.disabled = false; btn.textContent = '⬇';
      }
    };

    // Context menu (results)
    const ctxMenu = q('inp-ctx-menu');
    document.addEventListener('click', () => ctxMenu?.classList.remove('open'));
    q('inp-ctx-use').onclick = () => {
      const src = ctxMenu?._src;
      ctxMenu?.classList.remove('open');
      if (src) loadFromSrc(src);
    };
    q('inp-ctx-watermark').onclick = () => {
      const src = ctxMenu?._src;
      ctxMenu?.classList.remove('open');
      if (src) sendToWatermark(src);
    };
    q('inp-ctx-img2vid').onclick = () => {
      const src = ctxMenu?._src;
      ctxMenu?.classList.remove('open');
      if (src) sendToImg2Vid(src);
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
    q('inp-w').value = S.image.width;
    q('inp-h').value = S.image.height;
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
      model:        q('inp-sel-model').value,
      prompt:       q('inp-prompt').value,
      neg:          q('inp-neg').value,
      denoise:      q('inp-denoise').value,
      mblur:        q('inp-mblur').value,
      mmode:        getRadio('inp-mmode'),
      area:         getRadio('inp-area'),
      pad:          q('inp-pad').value,
      fillMode:     q('inp-fill-mode')?.value   ?? '1',
      sampler:      q('inp-sampler').value,
      scheduler:    q('inp-scheduler').value,
      steps:        q('inpp-steps').value,
      cfg:          q('inpp-cfg').value,
      soft:         q('inpp-soft').checked,
      softBias:        q('inp-soft-bias')?.value          ?? '1',
      softStr:         q('inp-soft-str')?.value           ?? '0.5',
      softContrast:    q('inp-soft-contrast')?.value      ?? '4',
      softMaskInf:     q('inp-soft-maskinf')?.value        ?? '0',
      softDiffThresh:  q('inp-soft-diffthresh')?.value     ?? '0.5',
      softDiffContrast:q('inp-soft-diffcontrast')?.value   ?? '2',
      w:            q('inp-w').value,
      h:            q('inp-h').value,
      loras:        collectInpLoras(),
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
    if (p.soft !== undefined) {
      q('inpp-soft').checked = p.soft;
      const panel = q('inpp-soft-params');
      if (panel) panel.style.display = p.soft ? '' : 'none';
    }
    if (p.fillMode !== undefined && q('inp-fill-mode')) q('inp-fill-mode').value = p.fillMode;
    if (p.softBias        !== undefined) setSl('inp-soft-bias',         'inp-soft-bias-val',         p.softBias,        1);
    if (p.softStr         !== undefined) setSl('inp-soft-str',          'inp-soft-str-val',          p.softStr,         2);
    if (p.softContrast    !== undefined) setSl('inp-soft-contrast',     'inp-soft-contrast-val',     p.softContrast,    1);
    if (p.softMaskInf     !== undefined) setSl('inp-soft-maskinf',      'inp-soft-maskinf-val',      p.softMaskInf,     2);
    if (p.softDiffThresh  !== undefined) setSl('inp-soft-diffthresh',   'inp-soft-diffthresh-val',   p.softDiffThresh,  2);
    if (p.softDiffContrast!== undefined) setSl('inp-soft-diffcontrast', 'inp-soft-diffcontrast-val', p.softDiffContrast,1);
    if (p.mmode)      { const el = document.querySelector(`input[name="inp-mmode"][value="${p.mmode}"]`); if (el) el.checked = true; }
    if (p.area)       { const el = document.querySelector(`input[name="inp-area"][value="${p.area}"]`);   if (el) el.checked = true; }
    if (p.sampler)    q('inp-sampler').value   = p.sampler;
    if (p.scheduler)  q('inp-scheduler').value = p.scheduler;
    if (p.w)          q('inp-w').value = p.w;
    if (p.h)          q('inp-h').value = p.h;
    // LoRAs
    if (p.loras !== undefined) {
      q('inp-lora-list').innerHTML = '';
      (p.loras || []).forEach(l => addInpLora(l.name, l.weight));
      updateInpLoraCount();
    }
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
    if (!S.image)        { setStatus('⚠ Load an image first'); return; }
    if (!S.forgeOnline)  { setStatus('⚠ Forge is offline — click ↺ to reconnect'); return; }
    if (S.running)       return;

    S.running = true;
    const btn = q('inp-gen-btn');
    btn.textContent      = '⏹ Stop';
    btn.style.background = 'var(--red)';

    // History separator
    const results = q('inp-results');
    if (results.children.length > 0) {
      const sep = document.createElement('div');
      sep.className   = 'inp-hist-sep';
      sep.textContent = new Date().toLocaleTimeString();
      results.prepend(sep);
    }

    setProgress(0);
    setStatus('Preparing…');

    const forgeUrl = getForgeUrl();
    const abort    = new AbortController();
    S._abort = abort;

    // Stop handler — interrupt Forge + abort the fetch
    btn.onclick = () => {
      fetch(`${forgeUrl}/sdapi/v1/interrupt`, { method: 'POST' }).catch(() => {});
      abort.abort();
      btn.textContent = 'Stopping…';
      btn.disabled    = true;
    };

    let pollId = null;

    try {
      // ── Export full-res image & mask ──────────────────────────────────────
      const imgC = document.createElement('canvas');
      imgC.width  = S.image.width;
      imgC.height = S.image.height;
      imgC.getContext('2d').drawImage(S.image, 0, 0);
      const imageB64 = imgC.toDataURL('image/png');

      const maskC   = document.createElement('canvas');
      maskC.width   = S.image.width;
      maskC.height  = S.image.height;
      const mCtx    = maskC.getContext('2d');
      mCtx.fillStyle = 'black';
      mCtx.fillRect(0, 0, maskC.width, maskC.height);
      mCtx.drawImage(S.maskCanvas, 0, 0, maskC.width, maskC.height);
      const maskB64 = maskC.toDataURL('image/png');

      const onlyMasked  = getRadio('inp-area') === 'only_masked';
      const softEnabled = q('inpp-soft')?.checked;
      const scheduler   = q('inp-scheduler')?.value;

      const payload = {
        init_images:              [imageB64],
        mask:                     maskB64,
        mask_blur:                +q('inp-mblur').value,
        inpainting_fill:          +(q('inp-fill-mode')?.value ?? 1),
        inpaint_full_res:         onlyMasked,
        inpaint_full_res_padding: +q('inp-pad').value,
        inpainting_mask_invert:   getRadio('inp-mmode') === 'not_masked' ? 1 : 0,
        prompt:                   buildPromptWithLoras(q('inp-prompt').value || ''),
        negative_prompt:          q('inp-neg').value     || '',
        seed:                     -1,
        steps:                    +q('inpp-steps').value,
        cfg_scale:                +q('inpp-cfg').value,
        width:                    +q('inp-w').value,
        height:                   +q('inp-h').value,
        sampler_name:             q('inp-sampler').value || 'DPM++ 2M',
        denoising_strength:       +q('inp-denoise').value,
        override_settings: { sd_model_checkpoint: q('inp-sel-model').value },
        override_settings_restore_afterwards: false,
        send_images:  true,
        save_images:  false,
      };
      if (scheduler) payload.scheduler = scheduler;

      if (softEnabled) {
        payload.alwayson_scripts = {
          'Soft Inpainting': {
            args: [
              true,
              +(q('inp-soft-bias')?.value          ?? 1.0),
              +(q('inp-soft-str')?.value           ?? 0.5),
              +(q('inp-soft-contrast')?.value      ?? 4.0),
              +(q('inp-soft-maskinf')?.value        ?? 0.0),
              +(q('inp-soft-diffthresh')?.value     ?? 0.5),
              +(q('inp-soft-diffcontrast')?.value   ?? 2.0),
            ],
          },
        };
      }

      // ── Progress polling ──────────────────────────────────────────────────
      pollId = setInterval(async () => {
        try {
          const prog = await fetch(`${forgeUrl}/sdapi/v1/progress`).then(r => r.json());
          if (prog.progress > 0) {
            setProgress(Math.round(prog.progress * 100));
            setStatus(`Generating… ${Math.round(prog.progress * 100)}%`);
          }
          if (prog.current_image) showLivePreview(`data:image/png;base64,${prog.current_image}`);
        } catch { /* ignore polling errors */ }
      }, 700);

      setStatus('Sending to Forge…');
      setProgress(2);

      // ── POST to Forge ─────────────────────────────────────────────────────
      const resp = await fetch(`${forgeUrl}/sdapi/v1/img2img`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  abort.signal,
      });

      clearInterval(pollId); pollId = null;

      if (!resp.ok) {
        const txt = await resp.text().catch(() => `HTTP ${resp.status}`);
        throw new Error(`Forge ${resp.status} — ${txt.slice(0, 200)}`);
      }

      const data = await resp.json();
      hideLivePreview();
      setProgress(100);
      setStatus('✅ Done');

      const resultB64 = data.images?.[0];
      if (!resultB64) throw new Error('No image in Forge response');

      // Forge handles compositing (inpaint_full_res) — just show the result
      S.pendingCrop  = null;
      S.pendingWhole = false;
      await showResult(`data:image/png;base64,${resultB64}`);

    } catch (err) {
      if (pollId) { clearInterval(pollId); pollId = null; }
      hideLivePreview();
      if (err.name === 'AbortError') {
        setStatus('⛔ Stopped');
      } else {
        setStatus(`❌ ${err.message}`);
        console.error('[Inpaint/Forge]', err);
        // Forge a peut-être planté — marquer offline et tenter une reconnexion
        S.forgeOnline = false;
        setForgeIndicator(false);
        showOffline();
        connectForge(); // reconnexion silencieuse en arrière-plan
      }
    }

    S.running    = false;
    S._abort     = null;
    btn.disabled = false;
    btn.textContent      = '▶ Generate';
    btn.style.background = '';
    btn.onclick          = generate;
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
    if (q('inp-dl-history')) q('inp-dl-history').style.display = '';
  }

  // ── Public API ─────────────────────────────────────────────────────────────
  return { init, onShow, loadFromSrc };

})();
