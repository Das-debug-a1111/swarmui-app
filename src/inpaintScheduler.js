// ── Inpaint Scheduler ─────────────────────────────────────────────────────────
// Dessiner un masque + un prompt une fois et les appliquer à plusieurs images
// importées localement, traitées séquentiellement via Forge (/sdapi/v1/img2img).
const InpaintScheduler = (() => {
  const q = id => document.getElementById(id);

  const S = {
    items:              [],
    nextId:             1,
    templateMaskCanvas: null, // dernier masque sauvegardé — copié sur les nouvelles images
    editingId:          null,
    running:            false,
    paused:             false,
    stopReq:            false,
    forgeOnline:        false,
    _retryTimer:        null,
    _abort:             null,
    // état de l'éditeur de masque pour l'item actuellement ouvert
    maskCanvas:         null,
    maskCtx:            null,
    drawing:            false,
    lastPos:            null,
    tool:               'brush',
    brushSize:          40,
    undoStack:          [],
    initialized:        false,
  };

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Forge connectivity ────────────────────────────────────────────────────
  function getForgeUrl() {
    return (q('ips-forge-url')?.value.trim() || localStorage.getItem('forge-url') || 'http://192.168.8.67:58190').replace(/\/$/, '');
  }

  function setForgeIndicator(online) {
    const el = q('ips-forge-indicator');
    if (!el) return;
    el.textContent = online ? '● Online' : '● Offline';
    el.style.color  = online ? 'var(--green)' : 'var(--red)';
  }

  async function loadForgeModels() {
    const d = await fetch(`${getForgeUrl()}/sdapi/v1/sd-models`).then(r => {
      if (!r.ok) throw new Error(`Forge /sd-models: ${r.status}`);
      return r.json();
    });
    const sel = q('ips-sel-model');
    if (!sel || !d?.length) return;
    sel.innerHTML = d.map(m => `<option value="${esc(m.title)}">${esc(m.title)}</option>`).join('');
  }

  async function loadForgeSamplers() {
    const d = await fetch(`${getForgeUrl()}/sdapi/v1/samplers`).then(r => {
      if (!r.ok) throw new Error(`Forge /samplers: ${r.status}`);
      return r.json();
    });
    const sel = q('ips-sampler');
    if (!sel || !d?.length) return;
    sel.innerHTML = d.map(s => `<option value="${esc(s.name)}">${esc(s.name)}</option>`).join('');
    if ([...sel.options].some(o => o.value === 'DPM++ 2M')) sel.value = 'DPM++ 2M';
  }

  async function loadForgeSchedulers() {
    const FALLBACK = ['Automatic','Karras','Exponential','Polyexponential','SGM Uniform','KL Optimal','Normal','Simple'];
    const sel = q('ips-scheduler');
    if (!sel) return;
    let names = FALLBACK;
    try {
      const d = await fetch(`${getForgeUrl()}/sdapi/v1/schedulers`).then(r => {
        if (!r.ok) throw new Error('no schedulers');
        return r.json();
      });
      if (d?.length) names = d.map(s => s.name || s.label || s);
    } catch { /* fallback list */ }
    sel.innerHTML = names.map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if ([...sel.options].some(o => o.value === 'Karras')) sel.value = 'Karras';
  }

  async function connectForge() {
    setForgeIndicator(false);
    try {
      await loadForgeModels();
      await loadForgeSamplers();
      await loadForgeSchedulers();
      S.forgeOnline = true;
      setForgeIndicator(true);
      updateButtons();
      if (S._retryTimer) { clearInterval(S._retryTimer); S._retryTimer = null; }
    } catch (e) {
      S.forgeOnline = false;
      setForgeIndicator(false);
      updateButtons();
      console.warn('[InpaintScheduler] Forge:', e.message);
      if (!S._retryTimer) {
        S._retryTimer = setInterval(async () => {
          try {
            await fetch(`${getForgeUrl()}/sdapi/v1/progress`, { method: 'GET' });
            clearInterval(S._retryTimer); S._retryTimer = null;
            connectForge();
          } catch { /* toujours offline */ }
        }, 10000);
      }
    }
  }

  function updateButtons() {
    const hasReady = S.items.some(it => it.status === 'ready');
    q('ips-btn-run').disabled   = !S.forgeOnline || S.running || !hasReady;
    q('ips-btn-pause').disabled = !S.running;
    q('ips-btn-stop').disabled  = !S.running;
  }

  // ── Presets (réglages partagés) ───────────────────────────────────────────
  const PRESET_KEY = 'swi-ips-presets';

  function getPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; }
  }
  function savePresetsData(obj) { localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); }

  function collectSettings() {
    return {
      model:     q('ips-sel-model').value,
      sampler:   q('ips-sampler').value,
      scheduler: q('ips-scheduler').value,
      steps:     q('ips-steps').value,
      cfg:       q('ips-cfg').value,
      denoise:   q('ips-denoise').value,
      mblur:     q('ips-mblur').value,
      fillMode:  q('ips-fill-mode').value,
      area:      document.querySelector('input[name="ips-area"]:checked')?.value,
      pad:       q('ips-pad').value,
      prompt:    q('ips-prompt').value,
      neg:       q('ips-neg').value,
    };
  }

  function applySettings(p) {
    const setSl = (id, valId, v, dec) => {
      const el = q(id); if (!el || v === undefined) return;
      el.value = v;
      if (valId && q(valId)) q(valId).textContent = (+v).toFixed(dec);
    };
    if (p.model     !== undefined && q('ips-sel-model')) q('ips-sel-model').value = p.model;
    if (p.sampler   !== undefined && q('ips-sampler'))   q('ips-sampler').value   = p.sampler;
    if (p.scheduler !== undefined && q('ips-scheduler')) q('ips-scheduler').value = p.scheduler;
    setSl('ips-steps',   'ips-steps-val',   p.steps,   0);
    setSl('ips-cfg',     'ips-cfg-val',     p.cfg,     1);
    setSl('ips-denoise', 'ips-denoise-val', p.denoise, 2);
    setSl('ips-mblur',   'ips-mblur-val',   p.mblur,   0);
    setSl('ips-pad',     'ips-pad-val',     p.pad,     0);
    if (p.fillMode !== undefined) q('ips-fill-mode').value = p.fillMode;
    if (p.area) { const el = document.querySelector(`input[name="ips-area"][value="${p.area}"]`); if (el) el.checked = true; }
    if (p.prompt !== undefined) q('ips-prompt').value = p.prompt;
    if (p.neg    !== undefined) q('ips-neg').value    = p.neg;
  }

  function renderPresetList() {
    const sel = q('ips-preset-sel');
    if (!sel) return;
    const presets = getPresets();
    sel.innerHTML = '<option value="">— Select —</option>' +
      Object.keys(presets).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }

  function savePreset() {
    const name = q('ips-preset-name').value.trim();
    if (!name) return;
    const presets = getPresets();
    presets[name] = collectSettings();
    savePresetsData(presets);
    renderPresetList();
    q('ips-preset-sel').value = name;
    q('ips-preset-name').value = '';
  }

  function loadPreset() {
    const name = q('ips-preset-sel').value;
    if (!name) return;
    const p = getPresets()[name];
    if (p) applySettings(p);
  }

  function deletePreset() {
    const name = q('ips-preset-sel').value;
    if (!name) return;
    const presets = getPresets();
    delete presets[name];
    savePresetsData(presets);
    renderPresetList();
  }

  // ── Queue management ──────────────────────────────────────────────────────
  function statusLabel(s) {
    return { 'no-mask': 'No mask', ready: 'Ready', running: 'Running…', done: 'Done', error: 'Error' }[s] || s;
  }

  function loadImageFile(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          const item = {
            id:         S.nextId++,
            name:       file.name,
            image:      img,
            maskCanvas: null,
            status:     'no-mask',
            resultURL:  null,
            errMsg:     null,
            prompt:     q('ips-prompt')?.value || '',
            negative:   q('ips-neg')?.value    || '',
            areaMode:   document.querySelector('input[name="ips-area"]:checked')?.value || 'only_masked',
            width:      img.width,
            height:     img.height,
          };
          if (S.templateMaskCanvas) {
            item.maskCanvas = document.createElement('canvas');
            item.maskCanvas.width  = S.templateMaskCanvas.width;
            item.maskCanvas.height = S.templateMaskCanvas.height;
            item.maskCanvas.getContext('2d').drawImage(S.templateMaskCanvas, 0, 0);
            item.status = 'ready';
          }
          resolve(item);
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  function addFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    // Un seul rendu une fois que toutes les images du lot sont chargées —
    // sinon chaque image décodée individuellement re-génère toute la grille
    // (grid.innerHTML = '') et peut arracher un bouton sous le clic de l'utilisateur.
    Promise.all(files.map(loadImageFile)).then(newItems => {
      newItems.forEach(item => S.items.push(item));
      renderQueue();
      updateButtons();
    });
  }

  function removeItem(id) {
    if (S.running) return;
    S.items = S.items.filter(it => it.id !== id);
    // Plus aucune image en file → le masque template n'a plus de sens,
    // sinon il restait appliqué aux prochaines images importées.
    if (!S.items.length) S.templateMaskCanvas = null;
    renderQueue();
    updateButtons();
  }

  function clearQueue() {
    if (S.running) return;
    S.items = [];
    S.templateMaskCanvas = null;
    renderQueue();
    updateButtons();
  }

  function resetDone() {
    if (S.running) return;
    S.items.forEach(it => {
      if (it.status === 'done' || it.status === 'error') {
        it.status    = it.maskCanvas ? 'ready' : 'no-mask';
        it.resultURL = null;
        it.errMsg    = null;
      }
    });
    renderQueue();
    updateButtons();
  }

  function renderQueue() {
    const grid = q('ips-grid');
    q('ips-count').textContent = `${S.items.length} image${S.items.length !== 1 ? 's' : ''}`;
    if (!S.items.length) {
      grid.innerHTML = '<div class="sws-empty">Aucune image — clique ＋ Ajouter des images.</div>';
      return;
    }
    grid.innerHTML = '';
    S.items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'ips-card';
      card.innerHTML = `
        <img class="ips-card-thumb" src="${esc(item.image.src)}" alt="">
        <div class="ips-card-body">
          <div class="ips-card-name" title="${esc(item.name)}">${esc(item.name)}</div>
          <span class="ips-card-badge ${item.status}">${statusLabel(item.status)}</span>
          <div class="ips-card-prompt" style="color:var(--text2)">${item.width}×${item.height} · ${item.areaMode === 'whole' ? 'Whole' : 'Masked'}</div>
          ${item.prompt ? `<div class="ips-card-prompt" title="${esc(item.prompt)}">${esc(item.prompt)}</div>` : ''}
          <div class="ips-card-actions">
            <button class="inp-btn-sm" data-act="mask">✏ Masque</button>
            <button class="inp-btn-sm inp-btn-danger" data-act="del">✕</button>
          </div>
        </div>`;
      card.querySelector('[data-act="mask"]').addEventListener('click', () => openMaskEditor(item.id));
      card.querySelector('[data-act="del"]').addEventListener('click', () => removeItem(item.id));
      grid.appendChild(card);
    });
  }

  // ── Mask editor (brush/eraser/undo/invert/clear) ──────────────────────────
  function setTool(tool) {
    S.tool = tool;
    q('ips-brush-btn').classList.toggle('on',  tool === 'brush');
    q('ips-eraser-btn').classList.toggle('on', tool === 'eraser');
  }

  function getPos(e) {
    const imgC = q('ips-c-img');
    const rect = imgC.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (imgC.width  / rect.width),
      y: (e.clientY - rect.top)  * (imgC.height / rect.height),
    };
  }

  function paintAt(pos, fromPos) {
    const ctx = S.maskCtx;
    if (!ctx) return;
    ctx.globalCompositeOperation = S.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = 'white';
    ctx.lineWidth   = S.brushSize;
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    if (fromPos) { ctx.moveTo(fromPos.x, fromPos.y); ctx.lineTo(pos.x, pos.y); }
    else         { ctx.moveTo(pos.x, pos.y); ctx.lineTo(pos.x, pos.y); }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    syncMaskDisplay();
  }

  function syncMaskDisplay() {
    const display = q('ips-c-mask');
    const dCtx = display.getContext('2d');
    dCtx.clearRect(0, 0, display.width, display.height);
    dCtx.drawImage(S.maskCanvas, 0, 0);
    dCtx.globalCompositeOperation = 'source-in';
    dCtx.fillStyle = '#ff2020';
    dCtx.fillRect(0, 0, display.width, display.height);
    dCtx.globalCompositeOperation = 'source-over';
  }

  function drawCursor(pos) {
    const c = q('ips-c-cur');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = S.tool === 'eraser' ? '#aaa' : '#fff';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, S.brushSize / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  function clearCursor() {
    const c = q('ips-c-cur');
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

  function openMaskEditor(id) {
    const item = S.items.find(it => it.id === id);
    if (!item) return;
    S.editingId = id;
    q('ips-main').classList.add('editing-mask');

    const wrap = q('ips-canvas-wrap');
    const maxW = (wrap?.clientWidth  || window.innerWidth  - 700) - 40;
    const maxH = (wrap?.clientHeight || window.innerHeight - 120) - 40;
    const scale = Math.min(maxW / item.image.width, maxH / item.image.height, 1);
    const dW = Math.round(item.image.width  * scale);
    const dH = Math.round(item.image.height * scale);

    const imgC = q('ips-c-img');
    imgC.width = dW; imgC.height = dH;
    imgC.getContext('2d').drawImage(item.image, 0, 0, dW, dH);

    S.maskCanvas = document.createElement('canvas');
    S.maskCanvas.width  = dW;
    S.maskCanvas.height = dH;
    S.maskCtx = S.maskCanvas.getContext('2d', { willReadFrequently: true });
    if (item.maskCanvas) S.maskCtx.drawImage(item.maskCanvas, 0, 0, dW, dH);
    S.undoStack = [];

    const maskC = q('ips-c-mask');
    maskC.width = dW; maskC.height = dH;
    maskC.style.opacity = q('ips-opacity-range').value / 100;
    syncMaskDisplay();

    const curC = q('ips-c-cur');
    curC.width = dW; curC.height = dH;

    const stack = q('ips-stack');
    stack.style.width  = dW + 'px';
    stack.style.height = dH + 'px';

    q('ips-item-prompt').value = item.prompt   || '';
    q('ips-item-neg').value    = item.negative || '';

    const areaEl = document.querySelector(`input[name="ips-item-area"][value="${item.areaMode}"]`);
    if (areaEl) areaEl.checked = true;
    q('ips-item-w').value = item.width;
    q('ips-item-h').value = item.height;
  }

  function saveMaskAndClose() {
    const item = S.items.find(it => it.id === S.editingId);
    if (item) {
      item.maskCanvas = document.createElement('canvas');
      item.maskCanvas.width  = S.maskCanvas.width;
      item.maskCanvas.height = S.maskCanvas.height;
      item.maskCanvas.getContext('2d').drawImage(S.maskCanvas, 0, 0);
      item.status = 'ready';

      S.templateMaskCanvas = document.createElement('canvas');
      S.templateMaskCanvas.width  = S.maskCanvas.width;
      S.templateMaskCanvas.height = S.maskCanvas.height;
      S.templateMaskCanvas.getContext('2d').drawImage(S.maskCanvas, 0, 0);

      item.prompt   = q('ips-item-prompt').value;
      item.negative = q('ips-item-neg').value;
      item.areaMode = document.querySelector('input[name="ips-item-area"]:checked')?.value || 'only_masked';
      item.width    = +q('ips-item-w').value  || item.image.width;
      item.height   = +q('ips-item-h').value  || item.image.height;
    }
    closeMaskEditor();
    renderQueue();
    updateButtons();
  }

  function closeMaskEditor() {
    S.editingId = null;
    q('ips-main').classList.remove('editing-mask');
  }

  // ── Batch run ──────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    const p = Math.round(pct * 100);
    q('ips-prog-bar').style.width   = p + '%';
    q('ips-prog-pct').textContent   = p + '%';
    q('ips-prog-status').textContent = label || '';
  }

  async function runOne(item) {
    const forgeUrl = getForgeUrl();
    const abort = new AbortController();
    S._abort = abort;

    const imgC = document.createElement('canvas');
    imgC.width  = item.image.width;
    imgC.height = item.image.height;
    imgC.getContext('2d').drawImage(item.image, 0, 0);
    const imageB64 = imgC.toDataURL('image/png');

    const maskC = document.createElement('canvas');
    maskC.width  = item.image.width;
    maskC.height = item.image.height;
    const mCtx = maskC.getContext('2d');
    mCtx.fillStyle = 'black';
    mCtx.fillRect(0, 0, maskC.width, maskC.height);
    mCtx.drawImage(item.maskCanvas, 0, 0, maskC.width, maskC.height);
    const maskB64 = maskC.toDataURL('image/png');

    const payload = {
      init_images:              [imageB64],
      mask:                     maskB64,
      mask_blur:                +q('ips-mblur').value,
      inpainting_fill:          +q('ips-fill-mode').value,
      inpaint_full_res:         item.areaMode === 'only_masked',
      inpaint_full_res_padding: +q('ips-pad').value,
      inpainting_mask_invert:   0,
      prompt:                   item.prompt   || '',
      negative_prompt:          item.negative || '',
      seed:                     -1,
      steps:                    +q('ips-steps').value,
      cfg_scale:                +q('ips-cfg').value,
      width:                    item.width  || item.image.width,
      height:                   item.height || item.image.height,
      sampler_name:             q('ips-sampler').value || 'DPM++ 2M',
      denoising_strength:       +q('ips-denoise').value,
      override_settings: { sd_model_checkpoint: q('ips-sel-model').value },
      override_settings_restore_afterwards: false,
      send_images: true,
      save_images: false,
    };
    const scheduler = q('ips-scheduler').value;
    if (scheduler) payload.scheduler = scheduler;

    let pollId = setInterval(async () => {
      try {
        const prog = await fetch(`${forgeUrl}/sdapi/v1/progress`).then(r => r.json());
        if (prog.progress > 0) setProgress(prog.progress, `Generating… ${Math.round(prog.progress * 100)}%`);
      } catch { /* ignore polling errors */ }
    }, 700);

    try {
      const resp = await fetch(`${forgeUrl}/sdapi/v1/img2img`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
        signal:  abort.signal,
      });
      if (!resp.ok) {
        const txt = await resp.text().catch(() => `HTTP ${resp.status}`);
        throw new Error(`Forge ${resp.status} — ${txt.slice(0, 200)}`);
      }
      const data = await resp.json();
      const resultB64 = data.images?.[0];
      if (!resultB64) throw new Error('No image in Forge response');
      item.resultURL = `data:image/png;base64,${resultB64}`;
      setProgress(1, 'Done');
    } finally {
      clearInterval(pollId);
      S._abort = null;
    }
  }

  function addToGallery(item) {
    q('ips-gallery').querySelector('.sws-gal-empty')?.remove();
    const card = document.createElement('div');
    card.className = 'ips-result-card';
    card.innerHTML = `<img src="${esc(item.resultURL)}" alt=""><button class="ips-result-dl" title="Download">⬇</button>`;
    card.querySelector('.ips-result-dl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = item.resultURL;
      a.download = `inpaint-${item.name.replace(/\.[^.]+$/, '')}.png`;
      a.click();
    });
    q('ips-gallery').appendChild(card);
  }

  async function runQueue() {
    if (!S.forgeOnline) { toast('Forge non connecté'); return; }
    if (S.running) return;
    const pending = S.items.filter(it => it.status === 'ready');
    if (!pending.length) { toast('Aucune image prête — dessine un masque'); return; }

    S.running = true; S.paused = false; S.stopReq = false;
    updateButtons();

    let done = 0;
    const total = pending.length;

    for (const item of S.items) {
      if (S.stopReq) break;
      if (item.status !== 'ready') continue;

      while (S.paused && !S.stopReq) await sleep(400);
      if (S.stopReq) break;

      item.status = 'running';
      renderQueue();
      q('ips-prog-name').textContent = item.name;
      q('ips-prog-name').style.color = '';
      q('ips-qcounter').textContent  = `${done + 1} / ${total}`;
      setProgress(0, 'Starting…');

      try {
        await runOne(item);
        item.status = 'done'; done++;
        addToGallery(item);
      } catch (e) {
        item.status = 'error'; item.errMsg = e.message;
        toast(`"${item.name}" a échoué: ${e.message}`);
      }
      renderQueue();
    }

    S.running = false; S.paused = false;
    updateButtons();
    q('ips-qcounter').textContent = '';

    if (!S.stopReq) {
      const failed = total - done;
      q('ips-prog-name').textContent = `Terminé — ${done}/${total}`;
      q('ips-prog-name').style.color = failed > 0 ? 'var(--yellow, #fa0)' : 'var(--green)';
      setProgress(1, '');
      toast(`Batch terminé — ${done}/${total} images réussies`);
    } else {
      q('ips-prog-name').textContent = 'Stopped';
      q('ips-prog-name').style.color = 'var(--red)';
      setProgress(0, '');
    }
  }

  function togglePause() {
    S.paused = !S.paused;
    q('ips-btn-pause').textContent = S.paused ? '▶ Resume' : '⏸ Pause';
  }

  function stopQueue() {
    S.stopReq = true; S.paused = false;
    if (S._abort) S._abort.abort();
  }

  async function downloadAllZip() {
    const doneItems = S.items.filter(it => it.status === 'done' && it.resultURL);
    if (!doneItems.length) { toast('Aucune image générée'); return; }
    const zip = new JSZip();
    doneItems.forEach((item, i) => {
      const b64 = item.resultURL.split(',')[1];
      zip.file(`${String(i + 1).padStart(3, '0')}_${item.name.replace(/\.[^.]+$/, '')}.png`, b64, { base64: true });
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inpaint-scheduler-${Date.now()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function clearGallery() {
    q('ips-gallery').innerHTML = '<div class="sws-gal-empty">Images will appear here</div>';
  }

  // ── UI binding ─────────────────────────────────────────────────────────────
  function bindSlider(id, valId, dec) {
    const el = q(id), out = q(valId);
    if (!el || !out) return;
    el.oninput = function () { out.textContent = (+this.value).toFixed(dec); };
  }

  function bindUI() {
    q('ips-btn-add').onclick = () => q('ips-file-input').click();
    q('ips-file-input').onchange = e => {
      if (e.target.files.length) addFiles(e.target.files);
      e.target.value = '';
    };
    q('ips-btn-run').onclick   = runQueue;
    q('ips-btn-pause').onclick = togglePause;
    q('ips-btn-stop').onclick  = stopQueue;
    q('ips-btn-reset').onclick = resetDone;
    q('ips-btn-clear').onclick = clearQueue;
    q('ips-forge-reconnect').onclick = connectForge;
    q('ips-free-swarm-vram').onclick = async () => {
      try {
        const res = await API.freeBackendMemory?.();
        toast(res ? '✅ VRAM SwarmUI libérée' : '⚠ SwarmUI non connecté');
      } catch (e) {
        toast(`❌ ${e.message}`);
      }
    };
    q('ips-dl-all').onclick    = downloadAllZip;
    q('ips-gal-clear').onclick = clearGallery;

    q('ips-preset-load').onclick = loadPreset;
    q('ips-preset-del').onclick  = deletePreset;
    q('ips-preset-save').onclick = savePreset;

    q('ips-brush-btn').onclick   = () => setTool('brush');
    q('ips-eraser-btn').onclick  = () => setTool('eraser');
    q('ips-undo-btn').onclick    = undo;
    q('ips-clear-btn').onclick   = clearMask;
    q('ips-invert-btn').onclick  = invertMask;
    q('ips-editor-back').onclick = closeMaskEditor;
    q('ips-editor-done').onclick = saveMaskAndClose;

    document.querySelectorAll('#ips-item-ratio-grid .inp-rbtn[data-w]').forEach(btn => {
      btn.onclick = () => { q('ips-item-w').value = btn.dataset.w; q('ips-item-h').value = btn.dataset.h; };
    });
    q('ips-item-auto-ratio').onclick = () => {
      const item = S.items.find(it => it.id === S.editingId);
      if (item) { q('ips-item-w').value = item.image.width; q('ips-item-h').value = item.image.height; }
    };

    q('ips-brush-range').oninput = function () {
      S.brushSize = +this.value;
      q('ips-brush-val').textContent = this.value;
    };
    q('ips-opacity-range').oninput = function () {
      q('ips-c-mask').style.opacity = this.value / 100;
    };

    const ctr = q('ips-canvas-wrap');
    ctr.onmousedown = e => {
      if (!S.maskCtx || e.button !== 0) return;
      saveUndo();
      S.drawing = true;
      S.lastPos = getPos(e);
      paintAt(S.lastPos, null);
    };
    ctr.onmousemove = e => {
      if (!S.maskCtx) return;
      const pos = getPos(e);
      drawCursor(pos);
      if (S.drawing) { paintAt(pos, S.lastPos); S.lastPos = pos; }
    };
    ctr.onmouseup    = () => { S.drawing = false; S.lastPos = null; };
    ctr.onmouseleave = () => { S.drawing = false; S.lastPos = null; clearCursor(); };

    bindSlider('ips-steps',   'ips-steps-val',   0);
    bindSlider('ips-cfg',     'ips-cfg-val',     1);
    bindSlider('ips-denoise', 'ips-denoise-val', 2);
    bindSlider('ips-mblur',   'ips-mblur-val',   0);
    bindSlider('ips-pad',     'ips-pad-val',     0);
  }

  function init() {
    if (S.initialized) return;
    S.initialized = true;
    bindUI();
    renderPresetList();
  }

  function onShow() {
    if (!S.forgeOnline) connectForge();
  }

  return { init, onShow };
})();
