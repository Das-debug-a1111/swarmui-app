// ── Inpaint par lot (mode « Inpaint » de l'onglet Scheduler) ──────────────────
// Plusieurs photos importées localement, chacune avec un ou plusieurs masques (une couleur et un prompt
// par masque), traitées séquentiellement via Forge (/sdapi/v1/img2img). Les masques d'une photo sont
// appliqués l'un après l'autre : le résultat du masque 1 devient l'image de départ du masque 2, etc.
const InpaintScheduler = (() => {
  const q = id => document.getElementById(id);

  const MASK_COLORS = ['#ff3b3b', '#3b82ff', '#22c55e', '#f59e0b', '#a855f7', '#ec4899', '#14b8a6', '#eab308'];

  const S = {
    items:       [],
    nextId:      1,
    nextMaskId:  1,
    template:    null,  // masques du dernier éditeur validé — copiés sur les nouvelles photos
    editingId:   null,
    running:     false,
    paused:      false,
    stopReq:     false,
    forgeOnline: false,
    _retryTimer: null,
    _abort:      null,
    count:       Math.max(1, Math.min(16, +localStorage.getItem('ips-count') || 1)),
    // éditeur de masques de la photo ouverte
    editMasks:   [],    // [{ id, color, canvas, ctx, prompt, negative }] à la taille d'affichage
    activeMask:  0,
    drawing:     false,
    lastPos:     null,
    tool:        'brush',
    brushSize:   40,
    undoStack:   [],    // [{ maskId, data }]
    initialized: false,
    galUrls:     new Set(),   // blobs affichés dans la galerie : révoqués seulement au vidage de la galerie
  };

  function esc(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
  const colorFor = i => MASK_COLORS[i % MASK_COLORS.length];

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

  async function launchForge() {
    const btn = q('ips-forge-launch');
    if (!btn) return;
    const originalText = btn.textContent;
    btn.disabled = true;
    try {
      const pickScript = () => window.electronAPI.pickLaunchScript(
        'forgeLaunchScript',
        'Sélectionne le script de lancement de Forge',
        'Choisis webui-user.bat (ou ton propre .bat) dans le dossier Forge',
      );
      const cfg = await window.electronAPI.configGet();
      if (!cfg?.forgeLaunchScript) {
        const picked = await pickScript();
        if (!picked) return;
      }
      btn.textContent = '⏳ Démarrage…';
      let res = await window.electronAPI.launchProcess('forgeLaunchScript');
      if (res?.error === 'script_not_found' || res?.error === 'no_script_configured') {
        const picked = await pickScript();
        if (!picked) return;
        res = await window.electronAPI.launchProcess('forgeLaunchScript');
      }
      if (res?.error) { showErrorToast(`Erreur lancement Forge : ${res.error}`); return; }
      connectForge();   // réessaie toutes les 10 s jusqu'à ce que Forge réponde
    } finally {
      btn.disabled = false;
      btn.textContent = originalText;
    }
  }

  function updateButtons() {
    const hasReady = S.items.some(it => it.status === 'ready');
    q('ips-btn-run').disabled   = !S.forgeOnline || S.running || !hasReady;
    q('ips-btn-pause').disabled = !S.running;
    q('ips-btn-stop').disabled  = !S.running;
  }

  // ── Nombre d'images par photo ─────────────────────────────────────────────
  function syncCount() {
    const custom = ![1, 2, 4, 8].includes(S.count);
    document.querySelectorAll('#ips-seg-count button').forEach(b => b.classList.toggle('active', +b.dataset.v === S.count));
    q('ips-count-custom').classList.toggle('active', custom);
    if (custom) q('ips-count-custom').value = S.count;
    else if (document.activeElement !== q('ips-count-custom')) q('ips-count-custom').value = '';
  }
  function setCount(v) {
    S.count = Math.max(1, Math.min(16, parseInt(v, 10) || 1));
    localStorage.setItem('ips-count', S.count);
    syncCount();
  }

  // ── Presets (réglages partagés) ───────────────────────────────────────────
  const PRESET_KEY = 'swi-ips-presets';

  function getPresets() {
    try { return JSON.parse(localStorage.getItem(PRESET_KEY) || '{}'); } catch { return {}; }
  }
  function savePresetsData(obj) {
    try { localStorage.setItem(PRESET_KEY, JSON.stringify(obj)); return true; }
    catch (e) { showErrorToast(`Preset non sauvegardé (stockage plein) : ${e.message}`); return false; }
  }

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
      count:     S.count,
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
    if (p.count) setCount(p.count);
  }

  function renderPresetList() {
    const sel = q('ips-preset-sel');
    if (!sel) return;
    const presets = getPresets();
    sel.innerHTML = '<option value="">— Preset —</option>' +
      Object.keys(presets).sort().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
  }

  async function savePreset() {
    const name = q('ips-preset-name').value.trim() || q('ips-preset-sel').value;
    if (!name) return;
    const presets = getPresets();
    if (presets[name] && !await uiConfirm({ title: `Remplacer « ${name} » ?`, okLabel: 'Remplacer' })) return;
    presets[name] = collectSettings();
    if (!savePresetsData(presets)) return;
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

  async function deletePreset() {
    const name = q('ips-preset-sel').value;
    if (!name || !await uiConfirm({ title: `Supprimer « ${name} » ?`, okLabel: 'Supprimer', danger: true })) return;
    const presets = getPresets();
    delete presets[name];
    savePresetsData(presets);
    renderPresetList();
  }

  // ── Masques : copies et tests ─────────────────────────────────────────────
  function copyCanvas(src, w = src.width, h = src.height) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(src, 0, 0, w, h);
    return c;
  }

  function canvasIsEmpty(c) {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i] > 10) return false;
    return true;
  }

  const cloneMasks = masks => masks.map(m => ({ id: S.nextMaskId++, color: m.color, canvas: copyCanvas(m.canvas), prompt: m.prompt, negative: m.negative }));

  // ── File d'images ─────────────────────────────────────────────────────────
  function statusLabel(s) {
    return { 'no-mask': 'Sans masque', ready: 'Prête', running: 'En cours…', done: 'Terminée', error: 'Erreur' }[s] || s;
  }

  // Les cartes affichent une petite miniature JPEG plutôt que l'image complète (des dizaines d'images
  // de plusieurs Mo dans le DOM figeaient l'onglet sur les gros lots).
  function makeThumb(img, max = 320) {
    const k = Math.min(1, max / Math.max(img.width, img.height));
    const c = document.createElement('canvas');
    c.width  = Math.max(1, Math.round(img.width  * k));
    c.height = Math.max(1, Math.round(img.height * k));
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8);
  }

  function loadImageFile(file) {
    return new Promise(resolve => {
      // URL d'objet plutôt que data URL : les octets restent dans le stockage du navigateur, pas en base64 dans le tas JS
      const srcUrl = URL.createObjectURL(file);
      const img = new Image();
      img.onerror = () => { URL.revokeObjectURL(srcUrl); resolve(null); };
      img.onload = () => {
        const item = {
          id:       S.nextId++,
          name:     file.name,
          image:    img,
          srcUrl,
          masks:    S.template ? cloneMasks(S.template) : [],
          status:   S.template ? 'ready' : 'no-mask',
          results:  [],   // [{ blob, url }]
          errMsg:   null,
          areaMode: document.querySelector('input[name="ips-area"]:checked')?.value || 'only_masked',
          width:    img.width,
          height:   img.height,
          thumb:    makeThumb(img),
        };
        resolve(item);
      };
      img.src = srcUrl;
    });
  }

  function releaseResults(item) {
    item.results.forEach(r => { if (!S.galUrls.has(r.url)) URL.revokeObjectURL(r.url); });
    item.results = [];
  }

  function releaseItemMedia(item) {
    if (item.srcUrl) URL.revokeObjectURL(item.srcUrl);
    releaseResults(item);
  }

  async function addFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    // Par paquets : un gros lot ne décode pas des centaines d'images d'un coup, et un fichier illisible est ignoré
    const CHUNK = 6;
    const failed = [];
    for (let i = 0; i < files.length; i += CHUNK) {
      q('ips-count').textContent = `chargement ${Math.min(i + CHUNK, files.length)}/${files.length}…`;
      const slice = files.slice(i, i + CHUNK);
      const items = await Promise.all(slice.map(loadImageFile));
      items.forEach((item, k) => item ? S.items.push(item) : failed.push(slice[k].name));
    }
    renderQueue();
    updateButtons();
    if (failed.length) showErrorToast(`${failed.length} image(s) illisible(s) ignorée(s) : ${failed.slice(0, 3).join(', ')}${failed.length > 3 ? '…' : ''}`);
  }

  function removeItem(id) {
    if (S.running) return;
    const gone = S.items.find(it => it.id === id);
    if (gone) releaseItemMedia(gone);
    S.items = S.items.filter(it => it.id !== id);
    // Plus aucune photo : les masques modèles n'ont plus de sens pour les prochaines
    if (!S.items.length) S.template = null;
    renderQueue();
    updateButtons();
  }

  async function clearQueue() {
    if (S.running || !S.items.length) return;
    if (!await uiConfirm({ title: 'Vider la file ?', html: `<p>${S.items.length} photo${S.items.length > 1 ? 's' : ''} et leurs masques seront retirés.</p>`, okLabel: 'Vider', danger: true })) return;
    S.items.forEach(releaseItemMedia);
    S.items = [];
    S.template = null;
    renderQueue();
    updateButtons();
  }

  function resetDone() {
    if (S.running) return;
    S.items.forEach(it => {
      if (it.status === 'done' || it.status === 'error') {
        releaseResults(it);
        it.status = it.masks.length ? 'ready' : 'no-mask';
        it.errMsg = null;
      }
    });
    renderQueue();
    updateButtons();
  }

  function renderQueue() {
    const grid = q('ips-grid');
    q('ips-count').textContent = S.items.length ? `${S.items.length} photo${S.items.length !== 1 ? 's' : ''}` : '';
    grid.innerHTML = '';
    S.items.forEach(item => {
      const card = document.createElement('div');
      card.className = 'ips-card ' + item.status;
      const firstPrompt = item.masks[0]?.prompt || '';
      card.innerHTML = `
        <img class="ips-card-thumb" alt="">
        <div class="ips-card-body">
          <div class="ips-card-name" title="${esc(item.name)}">${esc(item.name)}</div>
          <span class="ips-card-badge ${item.status}">${statusLabel(item.status)}${item.status === 'done' && item.results.length > 1 ? ` · ${item.results.length} images` : ''}</span>
          <div class="ips-card-masks">
            ${item.masks.length
              ? item.masks.map(m => `<span class="ips-dot" style="--c:${m.color}" title="${esc(m.prompt)}"></span>`).join('') + ` ${item.masks.length} masque${item.masks.length > 1 ? 's' : ''}`
              : 'Aucun masque'}
          </div>
          ${firstPrompt ? `<div class="ips-card-prompt" title="${esc(firstPrompt)}">${esc(firstPrompt)}</div>` : ''}
          ${item.status === 'error' && item.errMsg ? `<div class="ips-card-prompt" style="color:var(--red)" title="${esc(item.errMsg)}">${esc(item.errMsg)}</div>` : ''}
          <div class="ips-card-actions">
            <button class="q-btn sm" data-act="mask">✏ Masques</button>
            <button class="q-btn sm danger" data-act="del" title="Retirer">✕</button>
          </div>
        </div>`;
      card.querySelector('.ips-card-thumb').src = item.thumb;
      card.querySelector('[data-act="mask"]').addEventListener('click', () => openMaskEditor(item.id));
      card.querySelector('[data-act="del"]').addEventListener('click', () => removeItem(item.id));
      card.querySelector('.ips-card-thumb').addEventListener('click', () => openMaskEditor(item.id));
      grid.appendChild(card);
    });
  }

  // ── Éditeur de masques ────────────────────────────────────────────────────
  const activeMask = () => S.editMasks[S.activeMask];

  function setTool(tool) {
    S.tool = tool;
    q('ips-brush-btn').classList.toggle('on',  tool === 'brush');
    q('ips-eraser-btn').classList.toggle('on', tool === 'eraser');
  }

  function setBrushSize(v, fromField = false) {
    S.brushSize = Math.max(1, Math.min(500, Math.round(+v) || 1));
    q('ips-brush-range').value = Math.min(S.brushSize, 200);
    if (!fromField) q('ips-brush-val').value = S.brushSize;
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
    const m = activeMask();
    if (!m) return;
    const ctx = m.ctx;
    ctx.globalCompositeOperation = S.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.strokeStyle = 'white';
    ctx.lineWidth   = S.brushSize / (S.displayK || 1);
    ctx.lineCap     = 'round';
    ctx.lineJoin    = 'round';
    ctx.beginPath();
    if (fromPos) { ctx.moveTo(fromPos.x, fromPos.y); ctx.lineTo(pos.x, pos.y); }
    else         { ctx.moveTo(pos.x, pos.y); ctx.lineTo(pos.x, pos.y); }
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    syncMaskDisplay();
  }

  // Tous les masques, chacun dans sa couleur ; les autres que l'actif un peu effacés
  const _tint = document.createElement('canvas');
  function syncMaskDisplay() {
    const display = q('ips-c-mask');
    const dCtx = display.getContext('2d');
    dCtx.clearRect(0, 0, display.width, display.height);
    _tint.width = display.width; _tint.height = display.height;
    const tCtx = _tint.getContext('2d');
    S.editMasks.forEach((m, i) => {
      tCtx.globalCompositeOperation = 'source-over';
      tCtx.clearRect(0, 0, _tint.width, _tint.height);
      tCtx.drawImage(m.canvas, 0, 0);
      tCtx.globalCompositeOperation = 'source-in';
      tCtx.fillStyle = m.color;
      tCtx.fillRect(0, 0, _tint.width, _tint.height);
      dCtx.globalAlpha = i === S.activeMask ? 1 : 0.5;
      dCtx.drawImage(_tint, 0, 0);
    });
    dCtx.globalAlpha = 1;
  }

  function drawCursor(pos) {
    const c = q('ips-c-cur');
    const ctx = c.getContext('2d');
    ctx.clearRect(0, 0, c.width, c.height);
    ctx.strokeStyle = S.tool === 'eraser' ? '#aaa' : (activeMask()?.color || '#fff');
    ctx.lineWidth = 2 / (S.displayK || 1);
    ctx.beginPath();
    ctx.arc(pos.x, pos.y, S.brushSize / (S.displayK || 1) / 2, 0, Math.PI * 2);
    ctx.stroke();
  }

  function clearCursor() {
    const c = q('ips-c-cur');
    if (c) c.getContext('2d').clearRect(0, 0, c.width, c.height);
  }

  // Chaque étape d'annulation est une ImageData pleine taille : historique plafonné en nombre et en octets
  const UNDO_BUDGET = 192 * 1024 * 1024;

  function saveUndo() {
    const m = activeMask();
    if (!m) return;
    S.undoStack.push({ maskId: m.id, data: m.ctx.getImageData(0, 0, m.canvas.width, m.canvas.height) });
    let total = S.undoStack.reduce((n, f) => n + f.data.data.length, 0);
    while (S.undoStack.length > 1 && (S.undoStack.length > 30 || total > UNDO_BUDGET)) {
      total -= S.undoStack.shift().data.data.length;
    }
  }

  function undo() {
    const step = S.undoStack.pop();
    if (!step) return;
    const m = S.editMasks.find(x => x.id === step.maskId);
    if (!m) return undo();   // masque supprimé depuis : étape suivante
    m.ctx.putImageData(step.data, 0, 0);
    S.activeMask = S.editMasks.indexOf(m);
    renderMaskList();
    syncMaskDisplay();
  }

  function clearMask() {
    const m = activeMask();
    if (!m) return;
    saveUndo();
    m.ctx.clearRect(0, 0, m.canvas.width, m.canvas.height);
    syncMaskDisplay();
  }

  function invertMask() {
    const m = activeMask();
    if (!m) return;
    saveUndo();
    const w = m.canvas.width, h = m.canvas.height;
    const id = m.ctx.getImageData(0, 0, w, h);
    const d  = id.data;
    for (let i = 0; i < d.length; i += 4) {
      const painted = d[i + 3] > 10;
      d[i] = d[i + 1] = d[i + 2] = 255;
      d[i + 3] = painted ? 0 : 255;
    }
    m.ctx.putImageData(id, 0, 0);
    syncMaskDisplay();
  }

  function newEditMask(w, h, i, prompt = '', negative = '') {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return { id: S.nextMaskId++, color: colorFor(i), canvas, ctx: canvas.getContext('2d', { willReadFrequently: true }), prompt, negative };
  }

  function addMask() {
    const c = q('ips-c-img');
    const usedColors = new Set(S.editMasks.map(m => m.color));
    const i = MASK_COLORS.findIndex(col => !usedColors.has(col));
    const m = newEditMask(c.width, c.height, i === -1 ? S.editMasks.length : i);
    S.editMasks.push(m);
    S.activeMask = S.editMasks.length - 1;
    renderMaskList();
    syncMaskDisplay();
    setTimeout(() => q('ips-masks').querySelector(`[data-mid="${m.id}"] textarea`)?.focus(), 30);
  }

  async function deleteMask(i) {
    if (S.editMasks.length <= 1) { clearMask(); return; }
    const m = S.editMasks[i];
    if (!canvasIsEmpty(m.canvas) && !await uiConfirm({ title: `Supprimer le masque ${i + 1} ?`, okLabel: 'Supprimer', danger: true })) return;
    S.editMasks.splice(i, 1);
    S.activeMask = Math.min(S.activeMask, S.editMasks.length - 1);
    renderMaskList();
    syncMaskDisplay();
  }

  function renderMaskList() {
    const list = q('ips-masks');
    list.innerHTML = '';
    S.editMasks.forEach((m, i) => {
      const row = document.createElement('div');
      row.className = 'ips-mask-row' + (i === S.activeMask ? ' active' : '');
      row.style.setProperty('--c', m.color);
      row.dataset.mid = m.id;
      row.innerHTML = `
        <span class="ips-dot" style="--c:${m.color}"></span>
        <div class="ips-mask-fields">
          <b>Masque ${i + 1}</b>
          <textarea rows="2" placeholder="Que mettre dans cette zone ?"></textarea>
          <textarea rows="1" placeholder="Negative (optionnel, sinon celui par défaut)"></textarea>
        </div>
        <button class="ips-mask-del" title="Supprimer ce masque">✕</button>`;
      const [pTa, nTa] = row.querySelectorAll('textarea');
      pTa.value = m.prompt || '';
      nTa.value = m.negative || '';
      pTa.addEventListener('input', () => { m.prompt = pTa.value; });
      nTa.addEventListener('input', () => { m.negative = nTa.value; });
      if (typeof TagComplete !== 'undefined') { TagComplete.attach(pTa); TagComplete.attach(nTa); }
      const select = () => {
        if (S.activeMask === i) return;
        S.activeMask = i;
        list.querySelectorAll('.ips-mask-row').forEach((r, k) => r.classList.toggle('active', k === i));
        syncMaskDisplay();
      };
      row.addEventListener('mousedown', select);
      pTa.addEventListener('focus', select);
      nTa.addEventListener('focus', select);
      row.querySelector('.ips-mask-del').addEventListener('click', e => { e.stopPropagation(); deleteMask(i); });
      list.appendChild(row);
    });
  }

  function openMaskEditor(id) {
    const item = S.items.find(it => it.id === id);
    if (!item || S.running) return;
    S.editingId = id;
    q('ips-main').classList.add('editing-mask');

    // Résolution de travail fixe (précise), indépendante de la taille de la fenêtre ; l'affichage
    // est ensuite ajusté à la place disponible par fitEditor() (et suit les redimensionnements).
    const scale = Math.min(1, 1600 / Math.max(item.image.width, item.image.height));
    const dW = Math.round(item.image.width  * scale);
    const dH = Math.round(item.image.height * scale);

    const imgC = q('ips-c-img');
    imgC.width = dW; imgC.height = dH;
    imgC.getContext('2d').drawImage(item.image, 0, 0, dW, dH);

    // Copies de travail (validées seulement par « ✓ Valider »)
    S.editMasks = item.masks.map((m, i) => {
      const em = newEditMask(dW, dH, i, m.prompt, m.negative);
      em.color = m.color;
      em.ctx.drawImage(m.canvas, 0, 0, dW, dH);
      return em;
    });
    if (!S.editMasks.length) S.editMasks.push(newEditMask(dW, dH, 0, q('ips-prompt').value, ''));
    S.activeMask = 0;
    S.undoStack = [];

    const maskC = q('ips-c-mask');
    maskC.width = dW; maskC.height = dH;
    maskC.style.opacity = q('ips-opacity-range').value / 100;
    const curC = q('ips-c-cur');
    curC.width = dW; curC.height = dH;
    renderMaskList();
    requestAnimationFrame(fitEditor);
    syncMaskDisplay();

    const areaEl = document.querySelector(`input[name="ips-item-area"][value="${item.areaMode}"]`);
    if (areaEl) areaEl.checked = true;
    q('ips-item-w').value = item.width;
    q('ips-item-h').value = item.height;
  }

  function fitEditor() {
    if (!S.editingId) return;
    const wrap = q('ips-canvas-wrap'), c = q('ips-c-img');
    const k = Math.min((wrap.clientWidth - 40) / c.width, (wrap.clientHeight - 40) / c.height, 1);
    S.displayK = k > 0 ? k : 1;   // la taille du pinceau est en pixels d'écran
    const stack = q('ips-stack');
    stack.style.width  = Math.max(1, Math.round(c.width  * k)) + 'px';
    stack.style.height = Math.max(1, Math.round(c.height * k)) + 'px';
  }

  function saveMaskAndClose() {
    const item = S.items.find(it => it.id === S.editingId);
    if (item) {
      const kept = S.editMasks.filter(m => !canvasIsEmpty(m.canvas));
      item.masks = kept.map(m => ({ id: m.id, color: m.color, canvas: copyCanvas(m.canvas), prompt: m.prompt.trim(), negative: m.negative.trim() }));
      if (item.status !== 'running') item.status = item.masks.length ? 'ready' : 'no-mask';
      if (item.masks.length) S.template = item.masks.map(m => ({ ...m, canvas: copyCanvas(m.canvas) }));
      if (item.masks.length && q('ips-apply-others').checked) {
        const others = S.items.filter(it => it !== item && !it.masks.length && it.status === 'no-mask');
        others.forEach(it => { it.masks = cloneMasks(item.masks); it.status = 'ready'; });
        if (others.length) toast(`Masques appliqués à ${others.length} autre${others.length > 1 ? 's' : ''} photo${others.length > 1 ? 's' : ''}`);
      }
      item.areaMode = document.querySelector('input[name="ips-item-area"]:checked')?.value || 'only_masked';
      item.width    = +q('ips-item-w').value || item.image.width;
      item.height   = +q('ips-item-h').value || item.image.height;
      const empty = S.editMasks.length - kept.length;
      if (empty) toast(`${empty} masque${empty > 1 ? 's' : ''} vide${empty > 1 ? 's' : ''} ignoré${empty > 1 ? 's' : ''}`);
    }
    closeMaskEditor();
    renderQueue();
    updateButtons();
  }

  function closeMaskEditor() {
    S.editingId = null;
    S.editMasks = [];
    S.undoStack = [];
    q('ips-main').classList.remove('editing-mask');
  }

  // ── Lancement ─────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    const p = Math.round(Math.min(1, Math.max(0, pct)) * 100);
    q('ips-prog-bar').style.width   = p + '%';
    q('ips-prog-pct').textContent   = S.running ? p + '%' : '';
    q('ips-prog-status').textContent = label || '';
  }

  function maskToB64(canvas, w, h) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const ctx = c.getContext('2d');
    ctx.fillStyle = 'black';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(canvas, 0, 0, w, h);
    return c.toDataURL('image/png');
  }

  // Une passe Forge : un masque sur une image ; renvoie `count` images en base64
  async function forgePass(item, initB64, mask, count, onProgress) {
    const forgeUrl = getForgeUrl();
    const abort = new AbortController();
    S._abort = abort;
    const defaultNeg = q('ips-neg').value || '';
    const payload = {
      init_images:              [initB64],
      mask:                     maskToB64(mask.canvas, item.image.width, item.image.height),
      mask_blur:                +q('ips-mblur').value,
      inpainting_fill:          +q('ips-fill-mode').value,
      inpaint_full_res:         item.areaMode === 'only_masked',
      inpaint_full_res_padding: +q('ips-pad').value,
      inpainting_mask_invert:   0,
      prompt:                   mask.prompt || q('ips-prompt').value || '',
      negative_prompt:          mask.negative || defaultNeg,
      seed:                     -1,
      steps:                    +q('ips-steps').value,
      cfg_scale:                +q('ips-cfg').value,
      width:                    item.width  || item.image.width,
      height:                   item.height || item.image.height,
      sampler_name:             q('ips-sampler').value || 'DPM++ 2M',
      denoising_strength:       +q('ips-denoise').value,
      n_iter:                   count,   // passes successives : même VRAM qu'une seule image
      batch_size:               1,
      override_settings: { sd_model_checkpoint: q('ips-sel-model').value, return_grid: false },
      override_settings_restore_afterwards: false,
      send_images: true,
      save_images: false,
    };
    const scheduler = q('ips-scheduler').value;
    if (scheduler) payload.scheduler = scheduler;

    const pollId = setInterval(async () => {
      try {
        const prog = await fetch(`${forgeUrl}/sdapi/v1/progress`).then(r => r.json());
        if (prog.progress > 0) onProgress(prog.progress);
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
      // Forge ajoute une grille en tête quand il y a plusieurs images : on garde les N dernières
      const images = (data.images || []).slice(-count);
      if (!images.length) throw new Error('Pas d\'image dans la réponse de Forge');
      return images.map(b => `data:image/png;base64,${b}`);
    } finally {
      clearInterval(pollId);
      S._abort = null;
    }
  }

  // Une photo : masque 1 en `count` exemplaires, puis chaque exemplaire passe par les masques suivants
  async function runOne(item, label) {
    const imgC = document.createElement('canvas');
    imgC.width  = item.image.width;
    imgC.height = item.image.height;
    imgC.getContext('2d').drawImage(item.image, 0, 0);
    const original = imgC.toDataURL('image/png');

    const nMasks = item.masks.length;
    const totalPasses = 1 + (nMasks - 1) * S.count;
    let pass = 0;
    const step = (txt) => p => setProgress((pass + p) / totalPasses, `${label} — ${txt}`);

    let variants = await forgePass(item, original, item.masks[0], S.count,
      step(`masque 1/${nMasks}${S.count > 1 ? ` · ${S.count} images` : ''}`));
    pass++;
    for (let k = 1; k < nMasks; k++) {
      for (let v = 0; v < variants.length; v++) {
        if (S.stopReq) throw new Error('stopped');
        const [out] = await forgePass(item, variants[v], item.masks[k], 1,
          step(`masque ${k + 1}/${nMasks}${variants.length > 1 ? ` · image ${v + 1}/${variants.length}` : ''}`));
        variants[v] = out;
        pass++;
      }
    }

    releaseResults(item);
    for (const dataUrl of variants) {
      const blob = await (await fetch(dataUrl)).blob();
      item.results.push({ blob, url: URL.createObjectURL(blob) });
    }
  }

  function addToGallery(item, result) {
    q('ips-gallery').querySelector('.sws-gal-empty')?.remove();
    const card = document.createElement('div');
    card.className = 'ips-result-card';
    card.innerHTML = `<img src="${esc(result.url)}" alt="" title="${esc(item.name)}">
      <div class="ips-result-actions">
        <button class="ips-result-copy" title="Copier l'image">📋</button>
        <button class="ips-result-dl" title="Télécharger">⬇</button>
      </div>`;
    card.querySelector('img').addEventListener('click', () => openLightbox(result.url, 'ips-gallery', '.ips-result-card > img'));
    card.querySelector('.ips-result-copy').addEventListener('click', () => copyImageToClipboard(result.url));
    card.querySelector('.ips-result-dl').addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = result.url;
      a.download = `inpaint-${item.name.replace(/\.[^.]+$/, '')}.png`;
      a.click();
    });
    q('ips-gallery').appendChild(card);
    S.galUrls.add(result.url);
  }

  async function runQueue() {
    if (!S.forgeOnline) { showErrorToast('Forge non connecté'); return; }
    if (S.running) return;
    const pending = S.items.filter(it => it.status === 'ready');
    if (!pending.length) { showErrorToast('Aucune photo prête — dessine au moins un masque'); return; }
    if (S.editingId) closeMaskEditor();

    S.running = true; S.paused = false; S.stopReq = false;
    updateButtons();

    let done = 0, failed = 0;
    // Des photos peuvent être ajoutées pendant le lancement : le total est recalculé à chaque tour
    const total = () => done + failed + S.items.filter(it => it.status === 'ready' || it.status === 'running').length;

    for (const item of S.items) {
      if (S.stopReq) break;
      if (item.status !== 'ready') continue;

      while (S.paused && !S.stopReq) await sleep(400);
      if (S.stopReq) break;

      item.status = 'running';
      renderQueue();
      q('ips-prog-name').textContent = item.name;
      q('ips-prog-name').style.color = '';
      const tot = total();
      q('ips-qcounter').textContent  = `Photo ${done + failed + 1} sur ${tot}`;
      setProgress(0, 'Démarrage…');

      try {
        await runOne(item, `Photo ${done + failed + 1}/${tot}`);
        item.status = 'done'; done++;
        item.results.forEach(r => addToGallery(item, r));
      } catch (e) {
        if (S.stopReq) { item.status = 'ready'; break; }
        item.status = 'error'; item.errMsg = e.message; failed++;
        showErrorToast(`« ${item.name} » a échoué : ${e.message}`);
      }
      renderQueue();
    }

    S.running = false; S.paused = false;
    q('ips-btn-pause').textContent = '⏸';
    updateButtons();
    q('ips-qcounter').textContent = '';
    renderQueue();

    if (!S.stopReq) {
      const all = done + failed;
      q('ips-prog-name').textContent = failed ? `Terminé — ${failed} en erreur` : 'Terminé';
      q('ips-prog-name').style.color = failed > 0 ? 'var(--orange)' : 'var(--green)';
      setProgress(1, `${done}/${all} photo${all > 1 ? 's' : ''}`);
    } else {
      q('ips-prog-name').textContent = 'Arrêté';
      q('ips-prog-name').style.color = 'var(--red)';
      setProgress(0, '');
    }
  }

  function togglePause() {
    S.paused = !S.paused;
    q('ips-btn-pause').textContent = S.paused ? '▶' : '⏸';
  }

  function stopQueue() {
    S.stopReq = true; S.paused = false;
    if (S._abort) S._abort.abort();
  }

  async function downloadAllZip() {
    const results = S.items.filter(it => it.status === 'done').flatMap(it => it.results.map((r, k) => ({ it, r, k })));
    if (!results.length) { showErrorToast('Aucune image générée'); return; }
    const zip = new JSZip();
    results.forEach(({ it, r, k }, i) => {
      const base = it.name.replace(/\.[^.]+$/, '');
      zip.file(`${String(i + 1).padStart(3, '0')}_${base}${it.results.length > 1 ? `_${k + 1}` : ''}.png`, r.blob);
    });
    const blob = await zip.generateAsync({ type: 'blob' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `inpaint-par-lot-${Date.now()}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }

  function clearGallery() {
    const live = new Set(S.items.flatMap(it => it.results.map(r => r.url)));
    S.galUrls.forEach(u => { if (!live.has(u)) URL.revokeObjectURL(u); });
    S.galUrls.clear();
    q('ips-gallery').innerHTML = '<div class="sws-gal-empty">Les retouches apparaîtront ici</div>';
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
    q('ips-forge-launch').onclick = launchForge;
    if (window.electronAPI?.platform === 'win32') q('ips-forge-launch').style.display = '';
    q('ips-free-swarm-vram').onclick = async () => {
      try {
        const res = await API.freeBackendMemory?.();
        toast(res ? '✅ VRAM SwarmUI libérée' : '⚠ SwarmUI non connecté');
      } catch (e) {
        showErrorToast(e.message);
      }
    };
    q('ips-dl-all').onclick    = downloadAllZip;
    q('ips-gal-clear').onclick = clearGallery;

    q('ips-preset-load').onclick = loadPreset;
    q('ips-preset-del').onclick  = deletePreset;
    q('ips-preset-save').onclick = savePreset;

    // Nombre d'images par photo
    document.querySelectorAll('#ips-seg-count button').forEach(b => b.addEventListener('click', () => { q('ips-count-custom').value = ''; setCount(b.dataset.v); }));
    q('ips-count-custom').addEventListener('change', e => { if (e.target.value !== '') setCount(e.target.value); });
    q('ips-count-custom').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    syncCount();

    // Éditeur
    q('ips-brush-btn').onclick   = () => setTool('brush');
    q('ips-eraser-btn').onclick  = () => setTool('eraser');
    q('ips-undo-btn').onclick    = undo;
    q('ips-clear-btn').onclick   = clearMask;
    q('ips-invert-btn').onclick  = invertMask;
    q('ips-editor-back').onclick = closeMaskEditor;
    q('ips-editor-done').onclick = saveMaskAndClose;
    q('ips-mask-add').onclick    = addMask;

    document.querySelectorAll('#ips-item-ratio-grid .inp-rbtn[data-w]').forEach(btn => {
      btn.onclick = () => { q('ips-item-w').value = btn.dataset.w; q('ips-item-h').value = btn.dataset.h; };
    });
    q('ips-item-auto-ratio').onclick = () => {
      const item = S.items.find(it => it.id === S.editingId);
      if (item) { q('ips-item-w').value = item.image.width; q('ips-item-h').value = item.image.height; }
    };

    q('ips-brush-range').oninput = function () { setBrushSize(this.value); };
    q('ips-brush-val').oninput   = function () { if (+this.value >= 1) setBrushSize(this.value, true); };
    q('ips-brush-val').onchange  = function () { setBrushSize(this.value); };
    q('ips-brush-val').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    q('ips-opacity-range').oninput = function () { q('ips-c-mask').style.opacity = this.value / 100; };
    document.addEventListener('keydown', e => {
      if (!S.editingId || (e.key !== '[' && e.key !== ']')) return;
      const a = document.activeElement;
      if (a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && a.type === 'text'))) return;
      e.preventDefault();
      const stepSize = S.brushSize < 20 ? 2 : S.brushSize < 100 ? 5 : 10;
      setBrushSize(S.brushSize + (e.key === ']' ? stepSize : -stepSize));
    });

    window.addEventListener('resize', fitEditor);
    const ctr = q('ips-canvas-wrap');
    ctr.onmousedown = e => {
      if (!activeMask() || e.button !== 0) return;
      saveUndo();
      S.drawing = true;
      S.lastPos = getPos(e);
      paintAt(S.lastPos, null);
    };
    ctr.onmousemove = e => {
      if (!activeMask()) return;
      const pos = getPos(e);
      drawCursor(pos);
      if (S.drawing) { paintAt(pos, S.lastPos); S.lastPos = pos; }
    };
    ctr.onmouseup    = () => { S.drawing = false; S.lastPos = null; };
    ctr.onmouseleave = () => { S.drawing = false; S.lastPos = null; clearCursor(); };

    // Glisser des photos directement sur la file
    const main = q('ips-main');
    main.addEventListener('dragover', e => { if (!S.editingId) e.preventDefault(); });
    main.addEventListener('drop', e => {
      if (S.editingId) return;
      e.preventDefault();
      if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
    });

    bindSlider('ips-steps',   'ips-steps-val',   0);
    bindSlider('ips-cfg',     'ips-cfg-val',     1);
    bindSlider('ips-denoise', 'ips-denoise-val', 2);
    bindSlider('ips-mblur',   'ips-mblur-val',   0);
    bindSlider('ips-pad',     'ips-pad-val',     0);
  }

  function init() {
    if (S.initialized) return;
    S.initialized = true;
    const forgeInp = q('ips-forge-url');
    const savedForge = localStorage.getItem('forge-url');
    if (savedForge && forgeInp) forgeInp.value = savedForge;
    forgeInp?.addEventListener('change', () => localStorage.setItem('forge-url', forgeInp.value.trim()));
    bindUI();
    renderPresetList();
    renderQueue();
  }

  function onShow() {
    if (!S.forgeOnline) connectForge();
  }

  return { init, onShow };
})();
