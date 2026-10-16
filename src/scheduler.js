// ── SwarmUI Scheduler (native tab) ────────────────────────────────────────────
// File d'attente de générations. Deux sortes de tâches :
//  • « snapshot » : copie exacte des réglages de Txt2Img ou d'Edit (bouton « ＋ File »), envoyée telle quelle ;
//  • manuelles / inpaint : formulaire simple (ancien format, toujours pris en charge).
const Scheduler = (() => {
  'use strict';

  // ── Ratios (formulaire manuel) ──────────────────────────────────────────────
  const RATIOS = {
    '1:1':  {w:1024,h:1024}, '4:3': {w:1152,h:896},  '3:2': {w:1216,h:832},
    '16:9': {w:1344,h:768},  '21:9':{w:1536,h:640},
    '3:4':  {w:896,h:1152},  '2:3': {w:832,h:1216},  '9:16':{w:768,h:1344},
  };

  // ── State ───────────────────────────────────────────────────────────────────
  const S = {
    models:      [],
    cnModels:    [],
    loraModels:  [],
    presets:     [],
    tasks:       [],
    taskPresets: [],
    connected:   false,
    connecting:  false,
    running:     false,
    paused:      false,
    stopReq:     false,
    currentWS:   null,
    nextId:      1,
    collapsedGroups: new Set(),
    galCollapsed:    new Set(),
    galSubCollapsed: new Set(),
    initialized: false,
    ready:       null,   // Promise : file chargée depuis IndexedDB
    run:         null,   // { totalImgs, doneImgs, startedAt } pendant un lancement
    runActive:   false,  // une file tournait quand l'app a été fermée
    scheduledAt: null,   // lancement programmé (timestamp)
    schedTimer:  null,
    varSource:   null,   // tâche dont on crée des variations
    dragId:      null,
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc   = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const el    = id => document.getElementById(id);
  const toast = (msg, type = 'success') => (type === 'error' ? showErrorToast(msg) : window.toast(msg));
  const shortModel = m => String(m || '').split('/').pop().replace(/\.(safetensors|gguf|ckpt|sft)$/i, '');

  const ICON = {
    edit:  '<svg viewBox="0 0 24 24"><path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>',
    vary:  '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>',
    dup:   '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
    retry: '<svg viewBox="0 0 24 24"><path d="M3 12a9 9 0 1 0 3-6.7L3 8"/><path d="M3 3v5h5"/></svg>',
    del:   '<svg viewBox="0 0 24 24"><path d="M3 6h18"/><path d="M8 6V4h8v2"/><path d="M6 6l1 14h10l1-14"/></svg>',
    grip:  '<svg viewBox="0 0 24 24"><circle cx="9" cy="6" r="1.3"/><circle cx="15" cy="6" r="1.3"/><circle cx="9" cy="12" r="1.3"/><circle cx="15" cy="12" r="1.3"/><circle cx="9" cy="18" r="1.3"/><circle cx="15" cy="18" r="1.3"/></svg>',
    img:   '<svg viewBox="0 0 24 24"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 15l5-5 4 4 3-3 6 6"/><circle cx="8.5" cy="8.5" r="1.5"/></svg>',
  };

  // ── Stockage (IndexedDB) ────────────────────────────────────────────────────
  // localStorage plafonne à ~5 Mo pour toute l'app : une tâche avec ses images (référence, ControlNet,
  // Edit) le dépassait vite et la sauvegarde échouait sans bruit. IndexedDB n'a pas cette limite.
  const DB = { name: 'swarm-scheduler', store: 'kv', db: null };
  function dbOpen() {
    if (DB.db) return Promise.resolve(DB.db);
    return new Promise((res, rej) => {
      const r = indexedDB.open(DB.name, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(DB.store);
      r.onsuccess = () => { DB.db = r.result; res(DB.db); };
      r.onerror   = () => rej(r.error);
    });
  }
  async function dbGet(key) {
    const db = await dbOpen();
    return new Promise((res, rej) => {
      const q = db.transaction(DB.store).objectStore(DB.store).get(key);
      q.onsuccess = () => res(q.result);
      q.onerror   = () => rej(q.error);
    });
  }
  async function dbSet(key, val) {
    const db = await dbOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB.store, 'readwrite');
      tx.objectStore(DB.store).put(val, key);
      tx.oncomplete = () => res();
      tx.onerror    = () => rej(tx.error);
    });
  }

  // ── API ──────────────────────────────────────────────────────────────────────
  async function fetchModels(path = '', depth = 3) {
    if (depth <= 0) return [];
    const d = await API.post('/API/ListModels', {
      session_id:  API.session,
      path, depth,
      sortBy:      'Name',
      allowRemote: false,
      sortReverse: false,
      dataImages:  false,
    });
    let models = (d.files || []).map(f => ({
      value: path ? `${path}/${f.name}` : f.name,
      label: f.title || f.name,
    }));
    for (const folder of (d.folders || [])) {
      const sub = path ? `${path}/${folder}` : folder;
      try { models = models.concat(await fetchModels(sub, depth - 1)); } catch {}
    }
    return models;
  }

  async function fetchCNModels() {
    S.cnModels = [];
    try {
      const d = await API.post('/API/ListModels', {
        session_id: API.session, path: '', depth: 3,
        subtype: 'ControlNet', sortBy: 'Name', sortReverse: false,
      });
      S.cnModels = d.files || [];
    } catch(e) { console.warn('[Scheduler] CN fetch error:', e); }
    populateCNModels();
  }

  function populateCNModels() {
    const sel = el('sws-f-cn-model');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Modèle ControlNet —</option>' +
      S.cnModels.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
  }

  async function fetchPresets() {
    S.presets = await API.listPresets();
  }

  function friendlyProcName(name) {
    if (!name || name === 'None') return 'None (no preprocessing)';
    return name
      .replace(/Preprocessor$/i, '')
      .replace(/DepthMap$/i, ' Depth')
      .replace(/([a-z])([A-Z])/g, '$1 $2')
      .replace(/[-_+]/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
  }

  async function fetchCNPreprocessors() {
    try {
      const d = await API.listParams();
      const params = d.list || [];
      const param = params.find(p => p.id === 'controlnetpreprocessor');
      if (param?.values?.length) {
        const sel = el('sws-f-cn-type');
        if (sel) {
          const saved = localStorage.getItem('swarm-cn-preprocessor') || 'None';
          sel.innerHTML = param.values.map(v =>
            `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(friendlyProcName(v))}</option>`
          ).join('');
        }
      }
      const upParam = params.find(p => p.id === 'refinerupscalemethod');
      if (upParam?.values?.length) {
        const hfSel = el('sws-f-hf-method');
        if (hfSel) {
          const saved = localStorage.getItem('swarm-upscale-method') || 'model-remacri_original.pth';
          hfSel.innerHTML = upParam.values.map(v =>
            `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(friendlyUpscaleName(v))}</option>`
          ).join('');
        }
      }
    } catch(e) { console.warn('[Scheduler] params:', e); }
  }

  function friendlyUpscaleName(v) {
    if (v.startsWith('pixel-')) return 'Pixel — ' + v.slice(6).charAt(0).toUpperCase() + v.slice(7);
    if (v.startsWith('model-')) return 'Model — ' + v.slice(6).replace(/\.[^.]+$/, '');
    return v;
  }

  async function fetchLoRAs() {
    try {
      const d = await API.listLoRAs();
      S.loraModels = d.files || d.models || [];
    } catch (e) { console.warn('[Scheduler] LoRAs:', e); }
  }

  // Connexion silencieuse : réutilise la session de l'app (plus de bouton « Connect » séparé)
  async function connect() {
    if (S.running || S.connecting || S.connected) return;
    if (!App.connected && !API.session) return;
    S.connecting = true;
    setStatus('Chargement des modèles…');
    try {
      if (!API.session) await API.getSession();
      S.models = await fetchModels();
      await fetchCNModels();
      await fetchLoRAs();
      await fetchCNPreprocessors();
      await fetchPresets();
      S.connected = true;
      setStatus('');
      populateModels();
      requestNotifPermission();
    } catch(e) {
      S.connected = false;
      setStatus('Connexion à SwarmUI impossible : ' + e.message);
    } finally {
      S.connecting = false;
      updateButtons();
    }
  }

  function setStatus(txt) {
    const s = el('sws-prog-status');
    if (s) s.textContent = txt;
  }

  // ── LoRA helpers (formulaire manuel) ────────────────────────────────────────
  function addLoraRow(model = '', weight = 1) {
    const list = el('sws-lora-list');
    const row  = document.createElement('div');
    row.className = 'sws-lora-row';
    row.innerHTML = `
      <select class="sws-sel sws-lora-sel" style="flex:1;min-width:0"></select>
      <input type="number" class="sws-inp sws-lora-weight" value="${weight}"
             min="0" max="2" step="0.05" style="width:60px;text-align:center" title="Poids">
      <button class="sws-lora-del" title="Retirer">✕</button>`;
    list.appendChild(row);
    const sel = row.querySelector('.sws-lora-sel');
    sel.innerHTML = '<option value="">— LoRA —</option>' +
      S.loraModels.map(m =>
        `<option value="${esc(m.name)}"${m.name === model ? ' selected' : ''}>${esc(m.title || m.name)}</option>`
      ).join('');
    if (model) sel.value = model;
    row.querySelector('.sws-lora-del').addEventListener('click', () => {
      row.remove();
      updateLoraCount();
    });
    updateLoraCount();
  }

  function updateLoraCount() {
    const n  = el('sws-lora-list').querySelectorAll('.sws-lora-row').length;
    const c = el('sws-lora-count');
    if (c) c.textContent = n ? `(${n})` : '';
  }

  function collectLoras() {
    return [...document.querySelectorAll('#sws-lora-list .sws-lora-row')].map(row => ({
      model:  row.querySelector('.sws-lora-sel').value,
      weight: +row.querySelector('.sws-lora-weight').value || 1,
    })).filter(l => l.model);
  }

  function resetLoraEditor() {
    el('sws-lora-list').innerHTML = '';
    updateLoraCount();
    el('sws-lora-body').classList.remove('open');
    el('sws-lora-arrow').textContent = '▶';
  }

  function loadLorasIntoEditor(loras = []) {
    el('sws-lora-list').innerHTML = '';
    loras.forEach(l => addLoraRow(l.model, l.weight));
    const hasLoras = loras.length > 0;
    el('sws-lora-body').classList.toggle('open', hasLoras);
    el('sws-lora-arrow').textContent = hasLoras ? '▼' : '▶';
  }

  // ── Batch download ──────────────────────────────────────────────────────────
  async function downloadImgs(imgEls, label) {
    const imgs = [...imgEls];
    if (!imgs.length) { toast('Aucune image à télécharger', 'error'); return; }
    toast(`Préparation du ZIP — ${imgs.length} image${imgs.length > 1 ? 's' : ''}…`);
    const zip = new JSZip();
    let n = 0;
    for (const img of imgs) {
      try {
        const res  = await fetch(img.src);
        const blob = await res.blob();
        const ext  = blob.type.includes('png') ? 'png' : 'jpg';
        zip.file(`${String(++n).padStart(4, '0')}.${ext}`, blob);
      } catch (e) { console.warn('[DL]', img.src, e); }
    }
    if (n === 0) { toast('Aucune image n\'a pu être récupérée', 'error'); return; }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = (label || 'images').replace(/[^a-z0-9_\-]/gi, '_') + '.zip';
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    toast(`${n} image${n > 1 ? 's' : ''} téléchargée${n > 1 ? 's' : ''}`);
  }

  function addGroupDlBtn(hdr, getImgs, label) {
    const btn = document.createElement('button');
    btn.className = 'sws-gal-dl-btn';
    btn.title     = 'Télécharger en ZIP';
    btn.textContent = '⬇';
    btn.addEventListener('click', e => { e.stopPropagation(); downloadImgs(getImgs(), label); });
    hdr.appendChild(btn);
  }

  function populateModels() {
    const opts = S.models.length
      ? '<option value="">— Modèle —</option>' +
        S.models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('')
      : '<option value="">— Aucun modèle trouvé —</option>';
    const mainSel = el('sws-f-model');
    if (mainSel) { const cur = mainSel.value; mainSel.innerHTML = opts; if (cur) mainSel.value = cur; }
    const hfSel = el('sws-f-hf-model');
    if (hfSel) {
      const cur = hfSel.value;
      hfSel.innerHTML = '<option value="">— Même que le principal —</option>' +
        S.models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');
      if (cur) hfSel.value = cur;
    }
  }

  // ── Files enregistrées (« Task presets ») ───────────────────────────────────
  function saveTaskPresetsStorage() {
    dbSet('taskPresets', S.taskPresets).catch(e => toast('Impossible d\'enregistrer : ' + e.message, 'error'));
  }

  function openTaskPresetsModal() {
    renderTaskPresetsList();
    el('sws-tp-name').value = '';
    el('sws-tp-modal').classList.add('open');
    setTimeout(() => el('sws-tp-name').focus(), 50);
  }

  function closeTaskPresetsModal() {
    el('sws-tp-modal').classList.remove('open');
  }

  function renderTaskPresetsList() {
    const list = el('sws-tp-list');
    if (!S.taskPresets.length) {
      list.innerHTML = '<div class="sws-preset-empty">Aucune file enregistrée.</div>';
      return;
    }
    list.innerHTML = S.taskPresets.map(p => {
      const date   = new Date(p.createdAt).toLocaleDateString();
      const gNames = p.groups.length ? p.groups.map(g => esc(g)).join(', ') : '';
      return `
        <div class="sws-tp-item">
          <div class="sws-tp-item-info">
            <div class="sws-preset-title">${esc(p.name)}</div>
            <div class="sws-preset-meta">${p.taskCount} tâche${p.taskCount > 1 ? 's' : ''} · ${p.groups.length} groupe${p.groups.length !== 1 ? 's' : ''} · ${date}</div>
            ${gNames ? `<div class="sws-preset-desc">${gNames}</div>` : ''}
          </div>
          <div class="sws-tp-item-actions">
            <button class="sws-btn primary" onclick="Scheduler._loadTaskPreset(${p.id})">Charger</button>
            <button class="sws-btn danger sm" onclick="Scheduler._deleteTaskPreset(${p.id})">✕</button>
          </div>
        </div>`;
    }).join('');
  }

  function saveCurrentAsTaskPreset() {
    const name = el('sws-tp-name').value.trim();
    if (!name) { toast('Donne un nom à la file', 'error'); return; }
    if (!S.tasks.length) { toast('Aucune tâche à sauvegarder', 'error'); return; }
    const groups = [...new Set(S.tasks.map(t => t.group).filter(Boolean))];
    S.taskPresets.unshift({
      id:        Date.now(),
      name,
      createdAt: Date.now(),
      groups,
      taskCount: S.tasks.length,
      tasks:     structuredClone(S.tasks.map(t => ({ ...t, status: 'pending', errMsg: '', doneImages: 0 }))),
    });
    saveTaskPresetsStorage();
    renderTaskPresetsList();
    el('sws-tp-name').value = '';
    toast(`File « ${name} » enregistrée`);
  }

  async function loadTaskPreset(id) {
    const preset = S.taskPresets.find(p => p.id === id);
    if (!preset) return;
    if (S.tasks.length && !await uiConfirm({ title: `Charger « ${preset.name} » ?`, html: '<p>La file actuelle sera remplacée.</p>', okLabel: 'Charger' })) return;
    S.nextId = 1;
    S.tasks  = preset.tasks.map(t => makeTask(t));
    save(); render(); closeTaskPresetsModal();
    toast(`« ${preset.name} » chargée — ${preset.taskCount} tâches`);
  }

  async function deleteTaskPreset(id) {
    const preset = S.taskPresets.find(p => p.id === id);
    if (!preset || !await uiConfirm({ title: `Supprimer « ${preset.name} » ?`, okLabel: 'Supprimer', danger: true })) return;
    S.taskPresets = S.taskPresets.filter(p => p.id !== id);
    saveTaskPresetsStorage();
    renderTaskPresetsList();
  }

  // ── Presets SwarmUI → tâche manuelle ────────────────────────────────────────
  function openPresetPicker() {
    if (!S.connected) { toast('Pas encore connecté à SwarmUI', 'error'); connect(); return; }
    renderPresetList('');
    el('sws-preset-search').value = '';
    el('sws-preset-modal').classList.add('open');
    setTimeout(() => el('sws-preset-search').focus(), 50);
  }

  function closePresetPicker() {
    el('sws-preset-modal').classList.remove('open');
  }

  function renderPresetList(filter) {
    const list = el('sws-preset-list');
    const q = filter.toLowerCase().trim();
    const filtered = q
      ? S.presets.filter(p => p.title.toLowerCase().includes(q) || (p.description||'').toLowerCase().includes(q))
      : S.presets;

    if (!filtered.length) {
      list.innerHTML = `<div class="sws-preset-empty">${q ? 'Aucun preset ne correspond.' : 'Aucun preset trouvé.'}</div>`;
      return;
    }

    list.innerHTML = filtered.map((p, i) => {
      const pm = p.param_map || {};
      const model = pm.model ? pm.model.split('/').pop().slice(0, 24) : '';
      const meta  = [model, pm.steps ? `${pm.steps} steps` : '', pm.cfgscale ? `CFG ${pm.cfgscale}` : ''].filter(Boolean).join(' · ');
      const hasThumb = p.preview_image && !p.preview_image.includes('placeholder');
      const thumb = hasThumb
        ? `<img class="sws-preset-thumb" src="${esc(p.preview_image)}" alt="" onerror="this.style.display='none'">`
        : `<div class="sws-preset-thumb q-thumb-ph">${ICON.img}</div>`;
      return `
        <div class="sws-preset-item" onclick="Scheduler._applyPreset(${i})">
          ${thumb}
          <div class="sws-preset-info">
            <div class="sws-preset-title">${esc(p.title)}</div>
            ${p.description ? `<div class="sws-preset-desc">${esc(p.description)}</div>` : ''}
            ${meta ? `<div class="sws-preset-meta">${esc(meta)}</div>` : ''}
          </div>
        </div>`;
    }).join('');

    Scheduler._filteredPresets = filtered;
  }

  function applyPreset(idx) {
    const filtered = Scheduler._filteredPresets || S.presets;
    const p = filtered[idx];
    if (!p) return;
    closePresetPicker();

    const pm = p.param_map || {};
    const w = pm.width  || 1024;
    const h = pm.height || 1024;
    let ratio = 'custom';
    for (const [key, dims] of Object.entries(RATIOS)) {
      if (dims.w === w && dims.h === h) { ratio = key; break; }
    }

    openModal();
    el('sws-modal-title').textContent = `Nouvelle tâche — preset « ${p.title} »`;
    el('sws-f-name').value     = p.title;
    el('sws-f-prompt').value   = pm.prompt         || '';
    el('sws-f-neg').value      = pm.negativeprompt || '';
    el('sws-f-steps').value    = pm.steps          || 20;
    el('sws-f-cfg').value      = pm.cfgscale       || 7;
    el('sws-f-count').value    = 4;
    el('sws-f-seed').value     = pm.seed           ?? -1;
    el('sws-f-sampler').value  = pm.sampler        || '';
    el('sws-f-w').value        = w;
    el('sws-f-h').value        = h;
    el('sws-f-ratio').value    = ratio;
    onRatioChange();
    if (pm.model) el('sws-f-model').value = pm.model;
  }

  // ── Requête d'une tâche ─────────────────────────────────────────────────────
  function buildTaskPayload(task, count) {
    let payload;
    if (task.type === 'snapshot') {
      payload = structuredClone(task.payload || {});
    } else {
      payload = {
        prompt:         task.prompt,
        negativeprompt: task.negative || '',
        model:          task.model,
        steps:          +task.steps || 20,
        cfgscale:       +task.cfg   || 7,
        width:          +task.width || 1024,
        height:         +task.height|| 1024,
        seed:           task.seed ?? -1,
      };
      if (task.sampler) payload.sampler = task.sampler;
      const activeLoras = (task.loras || []).filter(l => l.model);
      if (activeLoras.length) {
        payload.loras       = activeLoras.map(l => l.model).join(',');
        payload.loraweights = activeLoras.map(l => l.weight ?? 1).join(',');
      }
      const cn = task.controlnet;
      if (cn && cn.enabled && cn.image) {
        payload.controlnetimageinput = cn.image;
        payload.controlnetstrength  = cn.strength ?? 1;
        payload.controlnetstart     = cn.start    ?? 0;
        payload.controlnetend       = cn.end      ?? 1;
        if (cn.model)               payload.controlnetmodel = cn.model;
        if (cn.type && cn.type !== 'none') payload.controlnetpreprocessor = cn.type;
      }
      const hf = task.hiresfix;
      if (hf && hf.enabled) {
        payload.refinermethod            = 'PostApply';
        payload.refinerupscale           = hf.scale  ?? 1.5;
        payload.refinercontrolpercentage = hf.pct    ?? 0.2;
        payload.refinerupscalemethod     = hf.method || 'pixel-lanczos';
        payload.refinersteps             = hf.steps  ?? 10;
        payload.refinercfgscale          = hf.cfg    ?? 7;
        if (hf.model) payload.refinermodel = hf.model;
      }
      if (task.type === 'inpaint' && task.inpaint?.image) {
        payload.initimage            = task.inpaint.image;
        payload.maskimage            = task.inpaint.mask;
        payload.initimagecreativity  = task.inpaint.denoising ?? 0.75;
        if (task.inpaint.maskMode === 'not_masked') payload.maskgrowamount = -1;
      }
    }
    payload.images     = count;
    payload.session_id = API.session;
    return payload;
  }

  // ── Génération (WebSocket) ──────────────────────────────────────────────────
  // Résout quand SwarmUI annonce la fin ; échoue si la connexion coupe avant (les images déjà reçues
  // sont comptées par onImage, le réessai ne génère que celles qui manquent).
  function generateWS(task, count, onImage) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${API.wsOrigin}/API/GenerateText2ImageWS`);
      S.currentWS = ws;
      let gotDone = false, gotImage = false, settled = false;
      const fail = err => { if (!settled) { settled = true; reject(err); } };
      const ok   = () => { if (!settled) { settled = true; resolve(); } };

      ws.onopen = () => ws.send(JSON.stringify(buildTaskPayload(task, count)));

      ws.onmessage = evt => {
        let msg; try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg.error) { fail(new Error(msg.error)); ws.close(); return; }
        if (msg.status !== undefined) {
          const s = String(msg.status);
          if (s.toLowerCase().startsWith('error')) { fail(new Error(s)); ws.close(); return; }
        }
        if (msg.gen_progress) {
          const p = msg.gen_progress;
          const pct = p.overall_percent ?? p.current_percent ?? 0;
          setTaskProgress(pct, `Image ${(task.doneImages || 0) + 1} sur ${task.count}`);
          if (p.preview) showLivePreview(p.preview);
        }
        if (msg.image) {
          hideLivePreview();
          const imgObj  = typeof msg.image === 'object' ? msg.image : null;
          const rawPath = imgObj ? (imgObj.image || imgObj.url || '') : msg.image;
          const src = rawPath.startsWith('http') || rawPath.startsWith('data:')
            ? rawPath
            : `${API.origin}/${rawPath.replace(/^\//, '')}`;
          if (src) { gotImage = true; onImage(src); }
        }
        if (msg.done) { gotDone = true; ws.close(); }
      };

      ws.onclose = () => {
        S.currentWS = null;
        if (S.stopReq) fail(new Error('stopped'));
        else if (gotDone) ok();
        else fail(new Error(gotImage ? 'Connexion coupée en cours de génération' : 'Connexion coupée par le serveur avant la fin'));
      };
      ws.onerror = () => { S.currentWS = null; fail(new Error('Erreur WebSocket')); };
    });
  }

  // ── Lancement de la file ────────────────────────────────────────────────────
  const RETRYABLE = /websocket|connexion coupée|failed to fetch|network|timeout|closed/i;
  const remainingOf = t => Math.max(0, (+t.count || 1) - (t.doneImages || 0));
  const pendingTasks = () => S.tasks.filter(t => t.enabled && (t.status === 'pending' || t.status === 'running'));

  // Attend que SwarmUI/ComfyUI soit démarré et ne charge plus rien (ex. juste après un redémarrage)
  async function waitBackendReady() {
    const t0 = Date.now();
    let waiting = false;
    while (!S.stopReq) {
      try {
        const st = await API.getStatus();
        const b  = st?.backend_status;
        if (!b || (b.status === 'running' && !b.any_loading)) return;
      } catch { /* réseau coupé : on réessaie */ }
      if (!waiting) { setTaskProgress(0, 'En attente de SwarmUI (démarrage ou chargement)…'); waiting = true; }
      if (Date.now() - t0 > 10 * 60_000) throw new Error('SwarmUI ne répond plus depuis 10 minutes');
      await sleep(3000);
    }
  }

  async function runQueue() {
    if (S.running) return;
    if (!S.connected) await connect();
    if (!S.connected) { toast('Pas connecté à SwarmUI', 'error'); return; }
    if (!API.session) { try { await API.getSession(); } catch(e) { toast('Session SwarmUI : ' + e.message, 'error'); return; } }
    if (!pendingTasks().length) { toast('Aucune tâche en attente', 'error'); return; }

    clearSchedule();
    el('q-resume').hidden = true;
    S.running = true; S.paused = false; S.stopReq = false;
    S.runActive = true;
    dbSet('runActive', true).catch(() => {});
    updateButtons();

    // La galerie repart de zéro à chaque lancement (voulu)
    el('sws-gallery').innerHTML = '<div class="sws-gal-empty">Les images de la file apparaîtront ici</div>';
    S.galCollapsed.clear();
    S.galSubCollapsed.clear();

    S.run = { doneImgs: 0, totalImgs: 0, startedAt: Date.now() };
    let doneTasks = 0, failed = 0;

    // On reprend la file à chaque tour : les tâches ajoutées ou réordonnées pendant le lancement sont prises en compte
    while (!S.stopReq) {
      const task = S.tasks.find(t => t.enabled && (t.status === 'pending' || t.status === 'running'));
      if (!task) break;
      while (S.paused && !S.stopReq) await sleep(400);
      if (S.stopReq) break;

      task.status = 'running'; task.errMsg = '';
      el('sws-prog-name').textContent = task.name;
      updateGlobal(doneTasks + failed);
      render();

      let attempt = 0;
      while (!S.stopReq) {
        try {
          await waitBackendReady();
          if (S.stopReq) break;
          const count = remainingOf(task);
          if (count <= 0) break;
          setTaskProgress(0, attempt ? `Nouvel essai (${attempt}/2)…` : 'Démarrage…');
          await generateWS(task, count, src => {
            task.doneImages = (task.doneImages || 0) + 1;
            task.thumb = src;
            S.run.doneImgs++;
            addToGallery(src, task.name, task.group || '');
            updateGlobal(doneTasks + failed);
            renderTaskProgress(task);
            save();
          });
          break;
        } catch (e) {
          if (S.stopReq) break;
          if (RETRYABLE.test(e.message) && attempt < 2) {
            attempt++;
            setTaskProgress(0, `Connexion perdue — nouvel essai dans 8 s (${attempt}/2)…`);
            await sleep(8000);
            continue;
          }
          task.status = 'error'; task.errMsg = e.message; failed++;
          toast(`« ${task.name} » a échoué : ${e.message}`, 'error');
          break;
        }
      }

      if (S.stopReq) {
        if (task.status === 'running') task.status = 'pending';
      } else if (task.status === 'running') {
        task.status = 'done'; task.doneImages = 0; doneTasks++;
        notify(`✅ ${task.name}`, `${task.count} image${task.count > 1 ? 's' : ''} (${doneTasks} tâche${doneTasks > 1 ? 's' : ''} terminée${doneTasks > 1 ? 's' : ''})`, 'sws-task-done');
      }
      save(); render();
    }

    S.running = false; S.paused = false;
    S.runActive = false;
    dbSet('runActive', false).catch(() => {});
    hideLivePreview();
    updateButtons();
    el('sws-btn-pause').textContent = '⏸ Pause';

    const nameEl = el('sws-prog-name');
    if (S.stopReq) {
      nameEl.textContent = 'Arrêtée';
      setTaskProgress(0, 'Les tâches non terminées restent en attente.');
    } else if (doneTasks > 0) {
      nameEl.textContent = failed ? `Terminée — ${failed} tâche${failed > 1 ? 's' : ''} en erreur` : 'Terminée';
      setTaskProgress(1, `${doneTasks} tâche${doneTasks > 1 ? 's' : ''} · ${S.run.doneImgs} image${S.run.doneImgs > 1 ? 's' : ''} en ${formatDuration(Date.now() - S.run.startedAt)}`);
      notify('✅ File terminée', `${doneTasks} tâche${doneTasks > 1 ? 's' : ''} terminée${doneTasks > 1 ? 's' : ''}${failed ? ` (${failed} en erreur)` : ''}`, 'sws-queue-done');
    } else {
      nameEl.textContent = 'Échec';
      setTaskProgress(0, `${failed} tâche${failed > 1 ? 's' : ''} en erreur`);
      notify('❌ File en échec', `${failed} tâche${failed > 1 ? 's' : ''} en erreur`, 'sws-queue-done');
    }
    el('q-eta').textContent = '';
    render();
  }

  function togglePause() {
    S.paused = !S.paused;
    el('sws-btn-pause').textContent = S.paused ? '▶ Reprendre' : '⏸ Pause';
    if (S.paused) setTaskProgress(undefined, 'Pause après l\'image en cours…');
  }

  function stopQueue() {
    S.stopReq = true; S.paused = false;
    if (S.currentWS) { S.currentWS.close(); S.currentWS = null; }
    updateButtons();
  }

  // ── Progression ─────────────────────────────────────────────────────────────
  function formatDuration(ms) {
    const m = Math.round(ms / 60000);
    if (m < 1) return 'moins d\'une minute';
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, '0')}`;
  }

  function setTaskProgress(pct, status) {
    if (pct !== undefined) {
      const p = Math.min(1, Math.max(0, pct));
      el('sws-prog-bar').style.width = `${p * 100}%`;
      el('sws-prog-pct').textContent = S.running ? `${Math.round(p * 100)}%` : '';
    }
    if (status !== undefined) setStatus(status);
  }
  const setProgress = setTaskProgress;

  // Barre globale : images faites / total (le total inclut les tâches ajoutées en cours de route) + temps restant
  function updateGlobal(finishedTasks = 0) {
    if (!S.run) return;
    const remaining = pendingTasks().reduce((n, t) => n + remainingOf(t), 0);
    const total = S.run.doneImgs + remaining;
    S.run.totalImgs = total;
    el('q-global-bar').style.width = total ? `${(S.run.doneImgs / total) * 100}%` : '0%';
    const nTasks = finishedTasks + pendingTasks().length;
    el('sws-qcounter').textContent = `Tâche ${Math.min(finishedTasks + 1, nTasks)} sur ${nTasks} · ${S.run.doneImgs} / ${total} images`;
    if (S.run.doneImgs > 0 && remaining > 0) {
      const perImg = (Date.now() - S.run.startedAt) / S.run.doneImgs;
      el('q-eta').textContent = `· encore ≈ ${formatDuration(perImg * remaining)}`;
    } else el('q-eta').textContent = '';
  }

  function showLivePreview(dataUrl) {
    const img = el('q-live');
    img.src = dataUrl;
    img.hidden = false;
  }

  function hideLivePreview() {
    const img = el('q-live');
    if (img) { img.hidden = true; img.removeAttribute('src'); }
  }

  // ── Galerie ─────────────────────────────────────────────────────────────────
  function addToGallery(src, name, group) {
    const gallery = el('sws-gallery');
    const empty = gallery.querySelector('.sws-gal-empty');
    if (empty) empty.remove();

    const gKey = (group || '').replace(/\W+/g, '_');
    const nKey = (name  || 'Unnamed').replace(/\W+/g, '_');

    let grid;

    if (group) {
      const grpId = 'sws-gal-grp-' + gKey;
      let grp = el(grpId);
      if (!grp) {
        grp = document.createElement('div');
        grp.className = 'sws-gal-group';
        grp.id = grpId;
        const ghdr = document.createElement('div');
        ghdr.className = 'sws-gal-group-hdr';
        ghdr.addEventListener('click', () => toggleGalTopGroup(group, ghdr));
        const gbody = document.createElement('div');
        gbody.className = 'sws-gal-group-body';
        grp.appendChild(ghdr);
        grp.appendChild(gbody);
        gallery.insertBefore(grp, gallery.firstChild);
      }

      const gbody = grp.querySelector('.sws-gal-group-body');
      const ghdr  = grp.querySelector('.sws-gal-group-hdr');

      const sectId = 'sws-gal-sect-' + gKey + '-' + nKey;
      let sect = el(sectId);
      if (!sect) {
        sect = document.createElement('div');
        sect.className = 'sws-gal-sect';
        sect.id = sectId;
        const shdr = document.createElement('div');
        shdr.className = 'sws-gal-sect-hdr';
        const subKey = group + ':' + name;
        shdr.addEventListener('click', () => toggleGalSubGroup(subKey, shdr));
        const sgrid = document.createElement('div');
        sgrid.className = 'sws-gal-sect-grid';
        sect.appendChild(shdr);
        sect.appendChild(sgrid);
        gbody.insertBefore(sect, gbody.firstChild);
      }

      grid = sect.querySelector('.sws-gal-sect-grid');
      const shdr = sect.querySelector('.sws-gal-sect-hdr');
      grid.insertBefore(galleryItem(src, name, grid), grid.firstChild);

      const sCount = grid.querySelectorAll('.sws-gal-item').length;
      const subKey = group + ':' + name;
      const subCol = S.galSubCollapsed.has(subKey);
      shdr.innerHTML = `<span>${esc(name)}</span><span>${sCount} image${sCount > 1 ? 's' : ''} ${subCol ? '▸' : '▾'}</span>`;
      shdr.classList.toggle('collapsed', subCol);

      const total = grp.querySelectorAll('.sws-gal-item').length;
      const topCol = S.galCollapsed.has(group);
      ghdr.innerHTML = `<span>${esc(group)}</span><span class="sws-ghdr-info">${total} image${total > 1 ? 's' : ''} ${topCol ? '▸' : '▾'}</span>`;
      ghdr.classList.toggle('collapsed', topCol);
      addGroupDlBtn(ghdr, () => grp.querySelectorAll('.sws-gal-item img'), group);

    } else {
      const sectId = 'sws-gal-sect-' + nKey;
      let sect = el(sectId);
      if (!sect) {
        sect = document.createElement('div');
        sect.className = 'sws-gal-sect';
        sect.id = sectId;
        const hdr = document.createElement('div');
        hdr.className = 'sws-gal-sect-hdr';
        hdr.addEventListener('click', () => toggleGalGroup(nKey, hdr));
        const sgrid = document.createElement('div');
        sgrid.className = 'sws-gal-sect-grid';
        sect.appendChild(hdr);
        sect.appendChild(sgrid);
        gallery.insertBefore(sect, gallery.firstChild);
      }

      grid = sect.querySelector('.sws-gal-sect-grid');
      const hdr = sect.querySelector('.sws-gal-sect-hdr');
      grid.insertBefore(galleryItem(src, name, grid), grid.firstChild);

      const count = grid.querySelectorAll('.sws-gal-item').length;
      const col = S.galCollapsed.has(nKey);
      hdr.innerHTML = `<span>${name ? esc(name) : 'Tout'}</span><span class="sws-ghdr-info">${count} image${count > 1 ? 's' : ''} ${col ? '▸' : '▾'}</span>`;
      hdr.classList.toggle('collapsed', col);
      addGroupDlBtn(hdr, () => grid.querySelectorAll('img'), name || 'images');
    }
  }

  function galleryItem(src, name, grid) {
    const item = document.createElement('div');
    item.className = 'sws-gal-item';
    item.title = name || '';
    item.onclick = () => openLightbox(src, grid);
    item.addEventListener('contextmenu', e => { e.preventDefault(); openGalCtx(src, grid, e.clientX, e.clientY); });
    const img = document.createElement('img');
    img.src = src; img.alt = name || ''; img.loading = 'lazy';
    item.appendChild(img);
    return item;
  }

  function toggleGalTopGroup(group, hdr) {
    if (S.galCollapsed.has(group)) S.galCollapsed.delete(group);
    else S.galCollapsed.add(group);
    const body = hdr.nextElementSibling;
    const total = body ? body.querySelectorAll('.sws-gal-item').length : 0;
    const col = S.galCollapsed.has(group);
    hdr.innerHTML = `<span>${esc(group)}</span><span class="sws-ghdr-info">${total} image${total > 1 ? 's' : ''} ${col ? '▸' : '▾'}</span>`;
    hdr.classList.toggle('collapsed', col);
    addGroupDlBtn(hdr, () => body?.querySelectorAll('.sws-gal-item img') || [], group);
  }

  function toggleGalSubGroup(subKey, hdr) {
    if (S.galSubCollapsed.has(subKey)) S.galSubCollapsed.delete(subKey);
    else S.galSubCollapsed.add(subKey);
    const grid = hdr.nextElementSibling;
    const count = grid ? grid.querySelectorAll('.sws-gal-item').length : 0;
    const col = S.galSubCollapsed.has(subKey);
    const name = subKey.split(':').slice(1).join(':');
    hdr.innerHTML = `<span>${esc(name)}</span><span>${count} image${count > 1 ? 's' : ''} ${col ? '▸' : '▾'}</span>`;
    hdr.classList.toggle('collapsed', col);
  }

  function toggleGalGroup(key, hdr) {
    if (S.galCollapsed.has(key)) S.galCollapsed.delete(key);
    else S.galCollapsed.add(key);
    const grid = hdr.nextElementSibling;
    const count = grid ? grid.querySelectorAll('.sws-gal-item').length : 0;
    const col = S.galCollapsed.has(key);
    const label = hdr.querySelector('span')?.textContent || 'Tout';
    hdr.innerHTML = `<span>${esc(label)}</span><span>${count} image${count > 1 ? 's' : ''} ${col ? '▸' : '▾'}</span>`;
    hdr.classList.toggle('collapsed', col);
  }

  // ── Lightbox with arrow navigation ──────────────────────────────────────────
  let _lbItems = [];
  let _lbIndex = 0;

  function openLightbox(src, grid) {
    if (grid) {
      _lbItems = [...grid.querySelectorAll('.sws-gal-item img')].map(img => img.src);
      _lbIndex = _lbItems.indexOf(src);
      if (_lbIndex === -1) { _lbItems = [src]; _lbIndex = 0; }
    } else {
      _lbItems = [src]; _lbIndex = 0;
    }
    el('sws-lb-img').src = _lbItems[_lbIndex];
    el('sws-lb').classList.add('open');
    updateLbCounter();
  }

  function lbNavigate(dir) {
    if (!_lbItems.length) return;
    _lbIndex = (_lbIndex + dir + _lbItems.length) % _lbItems.length;
    el('sws-lb-img').src = _lbItems[_lbIndex];
    updateLbCounter();
  }

  function updateLbCounter() {
    const c = el('sws-lb-counter');
    if (!c) return;
    c.textContent = _lbItems.length > 1 ? `${_lbIndex + 1} / ${_lbItems.length}` : '';
  }

  // ── Gallery context menu ─────────────────────────────────────────────────────
  let _galCtxSrc  = null;
  let _galCtxGrid = null;

  function openGalCtx(src, grid, x, y) {
    _galCtxSrc  = src;
    _galCtxGrid = grid;
    const menu = el('sws-gal-ctx');
    menu.classList.add('open');
    const mw = menu.offsetWidth  || 170;
    const mh = menu.offsetHeight || 100;
    menu.style.left = Math.min(x, window.innerWidth  - mw - 8) + 'px';
    menu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  function closeGalCtx() {
    el('sws-gal-ctx').classList.remove('open');
  }

  // ── Tâches ──────────────────────────────────────────────────────────────────
  function makeTask(d) {
    return {
      id:      S.nextId++,
      name:    d.name     || `Tâche ${S.nextId}`,
      prompt:  d.prompt   || '',
      negative:d.negative || '',
      model:   d.model    || '',
      steps:   d.steps    || 20,
      cfg:     d.cfg      || 7,
      ratio:   d.ratio    || '1:1',
      width:   d.width    || 1024,
      height:  d.height   || 1024,
      seed:    d.seed     ?? -1,
      count:   d.count    || 4,
      sampler: d.sampler  || '',
      group:   d.group    || '',
      enabled: d.enabled  !== false,
      status:  'pending',
      errMsg:  '',
      doneImages: 0,
      thumb:      d.thumb || null,
      loras:      d.loras      || [],
      controlnet: d.controlnet || { enabled: false, model: '', type: 'none', strength: 1, start: 0, end: 1, image: null },
      hiresfix:   d.hiresfix   || { enabled: false, model: '', method: 'model-remacri_original.pth', scale: 1.5, pct: 0.2, steps: 10, cfg: 7 },
      type:    d.type    || 'txt2img',
      inpaint: d.inpaint || { image: null, mask: null, denoising: 0.75, maskMode: 'masked' },
      // Tâches « snapshot » (copie de Txt2Img / Edit)
      source:  d.source  || null,
      payload: d.payload || null,
      state:   d.state   || null,
    };
  }

  // Champs affichés (et modifiés par les variations) d'une tâche snapshot, lus depuis sa requête
  function mirrorFromPayload(p, state) {
    return {
      prompt: state?.positive ?? state?.prompt ?? p.prompt ?? '',
      negative: p.negativeprompt || '',
      model: p.model || '', steps: p.steps, cfg: p.cfgscale,
      width: p.width, height: p.height, seed: p.seed ?? -1,
      ratio: 'custom',
    };
  }

  async function addSnapshotTask({ source, name, payload, state, thumb = null, group = '' }) {
    await init();
    const task = makeTask({
      type: 'snapshot', source, name, group, thumb,
      payload: structuredClone(payload), state: structuredClone(state),
      count: +payload.images || 1,
      ...mirrorFromPayload(payload, state),
    });
    S.tasks.push(task);
    save(); render();
    return task;
  }

  async function updateSnapshotTask(id, { payload, state }) {
    await init();
    const t = S.tasks.find(x => x.id === id);
    if (!t) return false;
    Object.assign(t, mirrorFromPayload(payload, state), {
      payload: structuredClone(payload), state: structuredClone(state),
      count: +payload.images || t.count, status: 'pending', errMsg: '', doneImages: 0,
    });
    save(); render();
    return true;
  }

  function editTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    if (t.type !== 'snapshot') { openModal(id); return; }
    if (t.source === 'edit') Flux.editTask(t);
    else editTaskInTxt2Img(t);
  }

  async function deleteTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    if (!await uiConfirm({ title: `Supprimer « ${t.name} » ?`, okLabel: 'Supprimer', danger: true })) return;
    S.tasks = S.tasks.filter(x => x.id !== id);
    save(); render();
  }

  function dupTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    const copy = makeTask({ ...structuredClone(t), name: t.name + ' (copie)' });
    S.tasks.splice(S.tasks.indexOf(t) + 1, 0, copy);
    save(); render();
  }

  function resetStatus(id) {
    const t = S.tasks.find(x => x.id === id);
    if (t) { t.status = 'pending'; t.errMsg = ''; t.doneImages = 0; save(); render(); }
  }

  function resetAll() {
    S.tasks.forEach(t => {
      if (t.status === 'done' || t.status === 'error') { t.status = 'pending'; t.errMsg = ''; t.doneImages = 0; }
    });
    save(); render();
    toast('Toutes les tâches sont de nouveau en attente');
  }

  function toggleTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (t) { t.enabled = !t.enabled; save(); render(); }
  }

  function setTaskCount(id, v) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    t.count = Math.max(1, Math.min(200, parseInt(v, 10) || 1));
    if (t.doneImages >= t.count) t.doneImages = 0;
    save(); render();
  }

  function renameTask(id, nameEl) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    const input = document.createElement('input');
    input.className = 'q-rename';
    input.value = t.name;
    nameEl.replaceWith(input);
    input.focus(); input.select();
    const commit = () => { t.name = input.value.trim() || t.name; save(); render(); };
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); if (e.key === 'Escape') { input.value = t.name; input.blur(); } });
  }

  // Glisser-déposer : la tâche se place avant/après celle visée et rejoint son groupe
  function moveTaskTo(dragId, targetId, after) {
    const from = S.tasks.findIndex(t => t.id === dragId);
    if (from < 0 || dragId === targetId) return;
    const [task] = S.tasks.splice(from, 1);
    const to = S.tasks.findIndex(t => t.id === targetId);
    if (to < 0) { S.tasks.splice(from, 0, task); return; }
    task.group = S.tasks[to].group || '';
    S.tasks.splice(after ? to + 1 : to, 0, task);
    save(); render();
  }

  function moveTaskToGroupEnd(dragId, group) {
    const from = S.tasks.findIndex(t => t.id === dragId);
    if (from < 0) return;
    const [task] = S.tasks.splice(from, 1);
    task.group = group;
    let last = -1;
    S.tasks.forEach((t, i) => { if ((t.group || '') === group) last = i; });
    S.tasks.splice(last + 1, 0, task);
    save(); render();
  }

  // ── Variations ──────────────────────────────────────────────────────────────
  const parseList = str => [...new Set(String(str || '').split(/[,;\s]+/).map(Number).filter(n => Number.isFinite(n) && n > 0))];

  function taskModel(t) { return t.type === 'snapshot' ? t.payload?.model : t.model; }

  function openVariations(id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    S.varSource = t;
    el('q-var-src').textContent = t.name;
    el('q-var-prompts').value = '';
    el('q-var-seeds').value = '';
    el('q-var-cfg').value = '';
    el('q-var-steps').value = '';
    el('q-var-append').checked = true;
    // Modèles de la même famille que celui de la tâche (un LoRA ne marche qu'avec sa famille)
    const cur = taskModel(t);
    const all = (App.models || []);
    const curInfo = all.find(m => m.name === cur);
    const fam = curInfo?.compat_class;
    const list = fam ? all.filter(m => m.compat_class === fam) : all;
    el('q-var-model-hint').textContent = fam ? 'même famille que le modèle de la tâche' : '';
    el('q-var-models').innerHTML = list.length
      ? list.map(m => `<label class="check-row"><input type="checkbox" value="${esc(m.name)}"${m.name === cur ? ' disabled' : ''}> ${esc(shortModel(m.name))}${m.name === cur ? ' <small>(actuel)</small>' : ''}</label>`).join('')
      : '<div class="field-hint">Connecte-toi à SwarmUI pour lister les modèles.</div>';
    updateVarTotal();
    el('q-var-modal').classList.add('open');
    setTimeout(() => el('q-var-prompts').focus(), 50);
  }

  function closeVariations() {
    el('q-var-modal').classList.remove('open');
    S.varSource = null;
  }

  function varAxes() {
    const prompts = el('q-var-prompts').value.split('\n').map(s => s.trim()).filter(Boolean);
    const nSeeds  = Math.max(0, Math.min(50, parseInt(el('q-var-seeds').value, 10) || 0));
    const models  = [...el('q-var-models').querySelectorAll('input:checked')].map(i => i.value);
    return {
      prompts: prompts.length ? prompts : [null],
      seeds:   nSeeds > 1 ? Array.from({ length: nSeeds }, () => Math.floor(Math.random() * 2 ** 31)) : [null],
      models:  models.length ? models : [null],
      cfgs:    parseList(el('q-var-cfg').value).length ? parseList(el('q-var-cfg').value) : [null],
      steps:   parseList(el('q-var-steps').value).length ? parseList(el('q-var-steps').value).map(Math.round) : [null],
      mode:    el('q-var-replace').checked ? 'replace' : 'append',
    };
  }

  function varCount(a) {
    const n = a.prompts.length * a.seeds.length * a.models.length * a.cfgs.length * a.steps.length;
    const trivial = [a.prompts, a.seeds, a.models, a.cfgs, a.steps].every(x => x.length === 1 && x[0] === null);
    return trivial ? 0 : n;
  }

  function updateVarTotal() {
    const t = S.varSource;
    if (!t) return;
    const n = varCount(varAxes());
    const btn = el('q-var-create');
    if (n > 200) { el('q-var-total').textContent = `${n} tâches — 200 maximum`; btn.disabled = true; return; }
    el('q-var-total').textContent = n ? `→ ${n} tâche${n > 1 ? 's' : ''} · ${n * (+t.count || 1)} images` : '';
    btn.disabled = !n;
  }

  // Applique des valeurs à une copie de tâche (snapshot : dans la requête ; manuelle : dans ses champs)
  function applyOverrides(t, o) {
    if (t.type === 'snapshot') {
      const p = t.payload, st = t.state || (t.state = {});
      const promptKey = 'positive' in st ? 'positive' : 'prompt';
      if (o.prompt != null) {
        const base = String(st[promptKey] ?? '').trim();
        // La requête = prompt + balises LoRA / régions ajoutées par Txt2Img : on les garde
        const suffix = base && p.prompt.startsWith(base) ? p.prompt.slice(base.length) : '';
        const next = o.mode === 'replace' ? o.prompt : (base ? `${base}, ${o.prompt}` : o.prompt);
        p.prompt = next + suffix;
        st[promptKey] = next;
        t.prompt = next;
      }
      if (o.model != null) { p.model = o.model; st.model = o.model; t.model = o.model; }
      if (o.cfg   != null) { p.cfgscale = o.cfg; st.cfg = String(o.cfg); t.cfg = o.cfg; }
      if (o.steps != null) { p.steps = o.steps; st.steps = String(o.steps); t.steps = o.steps; }
      if (o.seed  != null) { p.seed = o.seed; st.seed = String(o.seed); t.seed = o.seed; }
    } else {
      if (o.prompt != null) t.prompt = o.mode === 'replace' ? o.prompt : (t.prompt ? `${t.prompt}, ${o.prompt}` : o.prompt);
      if (o.model != null) t.model = o.model;
      if (o.cfg   != null) t.cfg = o.cfg;
      if (o.steps != null) t.steps = o.steps;
      if (o.seed  != null) t.seed = o.seed;
    }
  }

  function createVariations() {
    const src = S.varSource;
    if (!src) return;
    const a = varAxes();
    if (!varCount(a)) return;
    const group = `Variations · ${src.name}`.slice(0, 60);
    const made = [];
    let seedIdx = 0;
    for (const prompt of a.prompts) for (const model of a.models) for (const cfg of a.cfgs) for (const steps of a.steps) {
      seedIdx = 0;
      for (const seed of a.seeds) {
        seedIdx++;
        const copy = structuredClone(src);
        applyOverrides(copy, { prompt, model, cfg, steps, seed, mode: a.mode });
        const label = [
          prompt != null ? `« ${prompt.slice(0, 22)}${prompt.length > 22 ? '…' : ''} »` : '',
          model != null ? shortModel(model).slice(0, 18) : '',
          cfg != null ? `CFG ${cfg}` : '',
          steps != null ? `${steps} steps` : '',
          seed != null ? `seed ${seedIdx}` : '',
        ].filter(Boolean).join(' · ');
        made.push(makeTask({ ...copy, name: label || src.name, group, thumb: src.source === 'edit' ? src.thumb : null }));
      }
    }
    S.tasks.splice(S.tasks.indexOf(src) + 1, 0, ...made);
    save(); render();
    closeVariations();
    toast(`${made.length} tâche${made.length > 1 ? 's' : ''} de variation ajoutée${made.length > 1 ? 's' : ''}`);
  }

  // ── Lancement programmé ─────────────────────────────────────────────────────
  function nextOccurrence(hhmm) {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date();
    d.setHours(h, m, 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.getTime();
  }

  function setSchedule(ts) {
    S.scheduledAt = ts;
    dbSet('scheduledAt', ts).catch(() => {});
    armSchedule();
    renderSchedule();
  }

  function clearSchedule() {
    S.scheduledAt = null;
    clearInterval(S.schedTimer);
    S.schedTimer = null;
    dbSet('scheduledAt', null).catch(() => {});
    renderSchedule();
  }

  function armSchedule() {
    clearInterval(S.schedTimer);
    if (!S.scheduledAt) return;
    S.schedTimer = setInterval(() => {
      if (Date.now() >= S.scheduledAt) { clearSchedule(); runQueue(); }
      else renderSchedule();
    }, 15000);
  }

  function renderSchedule() {
    const info = el('q-sched-info');
    if (!S.scheduledAt) { info.hidden = true; return; }
    const at = new Date(S.scheduledAt);
    const hh = at.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    info.hidden = false;
    el('q-sched-text').textContent = `⏰ Lancement programmé à ${hh} (dans ${formatDuration(S.scheduledAt - Date.now())})`;
  }

  // ── Affichage de la file ────────────────────────────────────────────────────
  const STATUS_LABEL = { pending: 'En attente', running: 'En cours', done: 'Terminée', error: 'Erreur' };

  function taskTags(t) {
    const p = t.type === 'snapshot' ? (t.payload || {}) : null;
    const tags = [];
    if (t.source === 'edit') tags.push('Edit');
    if (t.type === 'inpaint') tags.push(`Inpaint ×${t.inpaint?.denoising ?? 0.75}`);
    const nLoras = p ? (t.state?.loras?.length || 0) : (t.loras || []).filter(l => l.model).length;
    if (nLoras) tags.push(`${nLoras} LoRA${nLoras > 1 ? 's' : ''}`);
    if (p ? p.refinermethod : t.hiresfix?.enabled) tags.push(`Refiner ×${p ? p.refinerupscale : t.hiresfix.scale}`);
    if (p ? p.controlnetimageinput : t.controlnet?.enabled) tags.push('ControlNet');
    if (p?.promptimages && t.source !== 'edit') tags.push('Images réf.');
    if (p?.maskimage && t.source === 'edit') tags.push('Masque');
    const seed = p ? p.seed : t.seed;
    if (seed !== undefined && seed !== null && +seed !== -1) tags.push(`seed ${seed}`);
    return tags;
  }

  function taskCardHtml(t) {
    const p = t.type === 'snapshot' ? (t.payload || {}) : t;
    const w = p.width, h = p.height;
    const steps = t.type === 'snapshot' ? p.steps : t.steps;
    const cfg   = t.type === 'snapshot' ? p.cfgscale : t.cfg;
    const model = taskModel(t);
    const prog  = t.status === 'running' || (t.doneImages > 0 && t.status !== 'done');
    const pct   = Math.round(((t.doneImages || 0) / (+t.count || 1)) * 100);
    const thumb = t.thumb
      ? `<img src="${esc(t.thumb)}" alt="" loading="lazy">`
      : `<span class="q-thumb-ph">${ICON.img}</span>`;
    const canRetry = t.status === 'done' || t.status === 'error';
    return `
      <div class="q-task s-${t.status}${t.enabled ? '' : ' off'}" draggable="true" data-id="${t.id}">
        <div class="q-grip" title="Glisser pour réordonner">${ICON.grip}</div>
        <div class="q-thumb">${thumb}</div>
        <div class="q-main">
          <div class="q-row1">
            <span class="q-name" title="Double-clic pour renommer">${esc(t.name)}</span>
            <span class="q-status">${STATUS_LABEL[t.status] || 'En attente'}</span>
          </div>
          <div class="q-prompt" title="${esc(t.prompt)}">${esc(t.prompt) || '<i>(sans prompt)</i>'}</div>
          <div class="q-meta">
            <label class="q-imgs" title="Nombre d'images"><input type="number" class="q-count-inp" data-a="count" min="1" max="200" value="${+t.count || 1}"> images</label>
            ${w && h ? `<span>${w}×${h}</span>` : ''}
            ${steps ? `<span>${steps} steps</span>` : ''}
            ${cfg ? `<span>CFG ${cfg}</span>` : ''}
            ${model ? `<span class="q-model" title="${esc(model)}">${esc(shortModel(model))}</span>` : ''}
          </div>
          ${taskTags(t).length ? `<div class="q-tags">${taskTags(t).map(x => `<span>${esc(x)}</span>`).join('')}</div>` : ''}
          ${prog ? `<div class="q-tprog"><div style="width:${pct}%"></div></div><div class="q-tprog-txt">${t.doneImages || 0} / ${t.count} images</div>` : ''}
          ${t.status === 'error' ? `<div class="q-err" title="${esc(t.errMsg)}">${esc(t.errMsg)}</div>` : ''}
        </div>
        <div class="q-side">
          <label class="switch" title="${t.enabled ? 'Incluse dans la file' : 'Ignorée lors du lancement'}"><input type="checkbox" data-a="toggle" ${t.enabled ? 'checked' : ''}><span></span></label>
          <div class="q-actions">
            <button data-a="edit" title="${t.type === 'snapshot' ? `Modifier dans ${t.source === 'edit' ? 'Edit' : 'Txt2Img'}` : 'Modifier'}">${ICON.edit}</button>
            <button data-a="vary" title="Créer des variations">${ICON.vary}</button>
            <button data-a="dup" title="Dupliquer">${ICON.dup}</button>
            ${canRetry ? `<button data-a="retry" title="Remettre en attente">${ICON.retry}</button>` : ''}
            <button data-a="del" class="danger" title="Supprimer">${ICON.del}</button>
          </div>
        </div>
      </div>`;
  }

  function renderTaskProgress(t) {
    const card = document.querySelector(`#sws-list .q-task[data-id="${t.id}"]`);
    if (!card) return;
    const bar = card.querySelector('.q-tprog > div');
    const txt = card.querySelector('.q-tprog-txt');
    if (bar) bar.style.width = `${Math.round(((t.doneImages || 0) / (+t.count || 1)) * 100)}%`;
    if (txt) txt.textContent = `${t.doneImages || 0} / ${t.count} images`;
    const th = card.querySelector('.q-thumb');
    if (th && t.thumb) th.innerHTML = `<img src="${esc(t.thumb)}" alt="">`;
  }

  function render() {
    const list = el('sws-list');
    const enabled = S.tasks.filter(t => t.enabled);
    const imgs = enabled.filter(t => t.status !== 'done').reduce((n, t) => n + remainingOf(t), 0);
    el('sws-count').textContent = S.tasks.length
      ? `${S.tasks.length} tâche${S.tasks.length > 1 ? 's' : ''} · ${imgs} image${imgs > 1 ? 's' : ''} à faire`
      : '';

    if (!S.tasks.length) {
      list.innerHTML = `
        <div class="q-empty">
          <div class="q-empty-icon">${ICON.img}</div>
          <b>La file est vide</b>
          <span>Dans Txt2Img ou Edit, règle ta génération puis clique <b>＋ File</b> : tout est copié (extensions, ControlNet, LoRAs…).</span>
        </div>`;
      updateButtons();
      return;
    }

    const groups = [];
    const groupMap = {};
    for (const t of S.tasks) {
      const g = t.group || '';
      if (!Object.prototype.hasOwnProperty.call(groupMap, g)) { groupMap[g] = []; groups.push(g); }
      groupMap[g].push(t);
    }

    list.innerHTML = groups.map(g => {
      const tasks = groupMap[g];
      if (!g) return tasks.map(taskCardHtml).join('');
      const collapsed = S.collapsedGroups.has(g);
      const done = tasks.filter(t => t.status === 'done').length;
      return `
        <div class="q-group${collapsed ? ' collapsed' : ''}" data-group="${esc(g)}">
          <div class="q-group-hdr" data-a="group">
            <span class="q-chev">›</span>
            <span class="q-group-name">${esc(g)}</span>
            <span class="q-group-info">${tasks.length} tâche${tasks.length > 1 ? 's' : ''}${done ? ` · ${done} terminée${done > 1 ? 's' : ''}` : ''}</span>
            <div class="q-group-prog"><div style="width:${Math.round(done / tasks.length * 100)}%"></div></div>
          </div>
          ${collapsed ? '' : tasks.map(taskCardHtml).join('')}
        </div>`;
    }).join('');

    const dl = el('sws-group-list');
    if (dl) {
      const knownGroups = [...new Set(S.tasks.map(t => t.group).filter(Boolean))];
      dl.innerHTML = knownGroups.map(g => `<option value="${esc(g)}">`).join('');
    }
    updateButtons();
  }

  function updateButtons() {
    el('sws-btn-run').disabled   = S.running || !pendingTasks().length;
    el('sws-btn-pause').disabled = !S.running;
    el('sws-btn-stop').disabled  = !S.running;
  }

  // ── Persistance ─────────────────────────────────────────────────────────────
  let _saveT = null, _saveWarned = false;
  function save() {
    clearTimeout(_saveT);
    _saveT = setTimeout(async () => {
      try {
        await dbSet('tasks', S.tasks);
        await dbSet('nextId', S.nextId);
        // Ancien stockage : libère la place dans localStorage (partagé avec toute l'app)
        localStorage.removeItem('sws_tasks');
        localStorage.removeItem('sws_nextid');
        localStorage.removeItem('sws_task_presets');
      } catch (e) {
        if (!_saveWarned) { _saveWarned = true; toast('Impossible d\'enregistrer la file : ' + e.message, 'error'); }
      }
    }, 300);
  }

  async function loadStorage() {
    let tasks = null, nextId = null, presets = null;
    try {
      tasks   = await dbGet('tasks');
      nextId  = await dbGet('nextId');
      presets = await dbGet('taskPresets');
      S.runActive   = !!(await dbGet('runActive'));
      S.scheduledAt = (await dbGet('scheduledAt')) || null;
    } catch (e) { console.warn('[Scheduler] IndexedDB:', e); }
    // Migration depuis l'ancien stockage (localStorage) : recopiée tout de suite dans IndexedDB
    let migrated = false;
    if (!tasks) {
      try { tasks = JSON.parse(localStorage.getItem('sws_tasks') || 'null'); nextId = +localStorage.getItem('sws_nextid') || null; } catch {}
      migrated = !!tasks;
    }
    if (!presets) {
      try { presets = JSON.parse(localStorage.getItem('sws_task_presets') || 'null'); } catch {}
      if (presets) dbSet('taskPresets', presets).catch(() => {});
    }
    S.tasks = (tasks || []).map(t => ({
      doneImages: 0, thumb: null, source: null, payload: null, state: null,
      ...t, status: t.status === 'running' ? 'pending' : t.status, errMsg: t.errMsg || '',
    }));
    S.nextId = Math.max(nextId || 1, ...S.tasks.map(t => t.id + 1), 1);
    S.taskPresets = presets || [];
    if (migrated) save();
  }

  function exportQueue() {
    const blob = new Blob([JSON.stringify({version: 2, tasks: S.tasks.map(t => ({...t, status: 'pending', errMsg: '', doneImages: 0}))}, null, 2)], {type: 'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `swarm-file-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(a.href);
  }

  function importQueue(ev) {
    const file = ev.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = async e => {
      try {
        const d = JSON.parse(e.target.result);
        if (!d.tasks?.length) throw new Error('aucune tâche dans le fichier');
        if (S.tasks.length && !await uiConfirm({ title: 'Remplacer la file actuelle ?', okLabel: 'Remplacer' })) return;
        S.nextId = 1; S.tasks = d.tasks.map(t => makeTask(t));
        save(); render();
        toast(`${S.tasks.length} tâches importées`);
      } catch(err) { toast('Fichier invalide : ' + err.message, 'error'); }
    };
    r.readAsText(file);
    ev.target.value = '';
  }

  // ── Notifications ────────────────────────────────────────────────────────────
  async function requestNotifPermission() {
    if ('Notification' in window && Notification.permission === 'default') {
      try { await Notification.requestPermission(); } catch {}
    }
  }

  function playDoneSound() {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [523.25, 659.25, 783.99].forEach((freq, i) => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain); gain.connect(ctx.destination);
        osc.type = 'sine'; osc.frequency.value = freq;
        const t = ctx.currentTime + i * 0.18;
        gain.gain.setValueAtTime(0, t);
        gain.gain.linearRampToValueAtTime(0.25, t + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
        osc.start(t); osc.stop(t + 0.35);
      });
    } catch {}
  }

  function notify(title, body, tag) {
    if (tag === 'sws-queue-done') playDoneSound();
    if ('Notification' in window && Notification.permission === 'granted') {
      try {
        const n = new Notification(title, { body, tag: tag || 'sws-notif' });
        setTimeout(() => n.close(), 6000);
      } catch {}
    }
  }

  // ── Formulaire de tâche manuelle (ancien format) ────────────────────────────
  function openModal(id = null) {
    populateModels();
    populateCNModels();
    el('sws-edit-id').value = id || '';
    el('sws-modal-title').textContent = id ? 'Modifier la tâche' : 'Nouvelle tâche manuelle';
    if (id) {
      const t = S.tasks.find(x => x.id === id);
      if (!t) return;
      el('sws-f-group').value   = t.group || '';
      el('sws-f-name').value    = t.name;
      el('sws-f-prompt').value  = t.prompt;
      el('sws-f-neg').value     = t.negative;
      el('sws-f-model').value   = t.model;
      el('sws-f-steps').value   = t.steps;
      el('sws-f-cfg').value     = t.cfg;
      el('sws-f-ratio').value   = t.ratio;
      el('sws-f-count').value   = t.count;
      el('sws-f-seed').value    = t.seed;
      el('sws-f-sampler').value = t.sampler || '';
      const cn = t.controlnet || {};
      el('sws-f-cn-enabled').checked = !!cn.enabled;
      el('sws-f-cn-model').value     = cn.model    || '';
      el('sws-f-cn-type').value      = cn.type     || 'none';
      el('sws-f-cn-strength').value  = cn.strength ?? 1;
      el('sws-f-cn-start').value     = cn.start    ?? 0;
      el('sws-f-cn-end').value       = cn.end      ?? 1;
      el('sws-cn-body').classList.toggle('open', !!cn.enabled);
      el('sws-cn-arrow').textContent = cn.enabled ? '▼' : '▶';
      Scheduler._cnImage = cn.image || null;
      if (cn.image) {
        el('sws-cn-preview').src = cn.image;
        el('sws-cn-preview').classList.add('show');
        el('sws-cn-dropzone').classList.add('loaded');
        el('sws-cn-drop-label').textContent = 'Image chargée ✓';
        el('sws-cn-clear-btn').style.display = '';
      } else if (Scheduler._clearCnImage) {
        Scheduler._clearCnImage();
      }
      const hf = t.hiresfix || {};
      el('sws-f-hf-enabled').checked = !!hf.enabled;
      el('sws-f-hf-model').value     = hf.model  || '';
      el('sws-f-hf-method').value    = hf.method || 'model-remacri_original.pth';
      el('sws-f-hf-scale').value     = hf.scale  ?? 1.5;
      el('sws-f-hf-pct').value       = hf.pct    ?? 0.2;
      el('sws-f-hf-steps').value     = hf.steps  ?? 10;
      el('sws-f-hf-cfg').value       = hf.cfg    ?? 7;
      el('sws-hf-body').classList.toggle('open', !!hf.enabled);
      el('sws-hf-arrow').textContent = hf.enabled ? '▼' : '▶';
      el('sws-f-w').value = t.width;
      el('sws-f-h').value = t.height;
      loadLorasIntoEditor(t.loras || []);
    } else {
      el('sws-f-group').value   = '';
      el('sws-f-name').value    = `Tâche ${S.tasks.length + 1}`;
      el('sws-f-prompt').value  = '';
      el('sws-f-neg').value     = '';
      el('sws-f-model').value   = S.models[0]?.value || '';
      el('sws-f-steps').value   = 20;
      el('sws-f-cfg').value     = 7;
      el('sws-f-ratio').value   = '1:1';
      el('sws-f-count').value   = 4;
      el('sws-f-seed').value    = -1;
      el('sws-f-sampler').value = '';
      resetLoraEditor();
      el('sws-f-cn-enabled').checked = false;
      el('sws-f-cn-model').value     = '';
      el('sws-f-cn-type').value      = 'none';
      el('sws-f-cn-strength').value  = 1;
      el('sws-f-cn-start').value     = 0;
      el('sws-f-cn-end').value       = 1;
      el('sws-cn-body').classList.remove('open');
      el('sws-cn-arrow').textContent = '▶';
      if (Scheduler._clearCnImage) Scheduler._clearCnImage();
      el('sws-f-hf-enabled').checked = false;
      el('sws-f-hf-model').value     = '';
      el('sws-f-hf-method').value    = 'model-remacri_original.pth';
      el('sws-f-hf-scale').value     = 1.5;
      el('sws-f-hf-pct').value       = 0.2;
      el('sws-f-hf-steps').value     = 10;
      el('sws-f-hf-cfg').value       = 7;
      el('sws-hf-body').classList.remove('open');
      el('sws-hf-arrow').textContent = '▶';
      el('sws-f-w').value = 1024;
      el('sws-f-h').value = 1024;
    }
    onRatioChange();
    el('sws-right').classList.add('editing');
    setTimeout(() => el('sws-f-name').focus(), 50);
  }

  function closeModal() {
    if (_qpWS) { _qpWS.close(); _qpWS = null; }
    resetQpBtn();
    el('sws-right').classList.remove('editing');
  }

  // ── Aperçu rapide (formulaire manuel) ───────────────────────────────────────
  let _qpWS = null;

  function resetQpBtn() {
    const btn = el('sws-qp-btn');
    if (btn) { btn.disabled = false; btn.textContent = '🔍 Aperçu'; }
    const bw = el('sws-qp-bar-wrap');
    if (bw) bw.style.display = 'none';
  }

  function quickPreview() {
    if (!S.connected) { toast('Pas connecté à SwarmUI', 'error'); return; }
    if (_qpWS) { _qpWS.close(); _qpWS = null; }

    const btn    = el('sws-qp-btn');
    const barWrap= el('sws-qp-bar-wrap');
    const bar    = el('sws-qp-bar');
    const status = el('sws-qp-status');
    const img    = el('sws-qp-img');

    const r    = el('sws-f-ratio').value;
    const dims = r === 'custom'
      ? { w: +el('sws-f-w').value || 1024, h: +el('sws-f-h').value || 1024 }
      : (RATIOS[r] || { w: 1024, h: 1024 });

    const prompt = el('sws-f-prompt').value.trim();
    const model  = el('sws-f-model').value;
    if (!prompt) { toast('Prompt requis', 'error'); return; }
    if (!model)  { toast('Sélectionne un modèle', 'error'); return; }

    const payload = {
      session_id:     API.session,
      images:         1,
      prompt,
      negativeprompt: el('sws-f-neg').value.trim(),
      model,
      steps:          +el('sws-f-steps').value || 20,
      cfgscale:       +el('sws-f-cfg').value   || 7,
      width:          dims.w,
      height:         dims.h,
      seed:           -1,
    };

    if (el('sws-f-cn-enabled').checked && Scheduler._cnImage) {
      payload.controlnetimageinput = Scheduler._cnImage;
      payload.controlnetstrength   = +el('sws-f-cn-strength').value || 1;
      payload.controlnetstart      = +el('sws-f-cn-start').value    || 0;
      payload.controlnetend        = +el('sws-f-cn-end').value      || 1;
      const cnModel = el('sws-f-cn-model').value;
      const cnType  = el('sws-f-cn-type').value;
      if (cnModel) payload.controlnetmodel = cnModel;
      if (cnType && cnType !== 'none') payload.controlnetpreprocessor = cnType;
    }

    btn.disabled = true;
    btn.textContent = '⏳ Génération…';
    barWrap.style.display = 'block';
    bar.style.width = '0%';
    status.textContent = 'Démarrage…';
    img.style.display = 'none';

    _qpWS = new WebSocket(`${API.wsOrigin}/API/GenerateText2ImageWS`);
    _qpWS.onopen = () => _qpWS.send(JSON.stringify(payload));
    _qpWS.onmessage = evt => {
      let msg; try { msg = JSON.parse(evt.data); } catch { return; }
      if (msg.error) { status.textContent = '❌ ' + msg.error; resetQpBtn(); return; }
      if (msg.status) {
        const pct = msg.overall_percent ?? msg.cur_overall_percent ?? 0;
        bar.style.width = Math.round(pct * 100) + '%';
        status.textContent = msg.status;
      }
      if (msg.gen_progress) {
        const gp = msg.gen_progress;
        bar.style.width = Math.round((gp.overall_percent ?? gp.current_percent ?? 0) * 100) + '%';
        if (gp.preview) { img.src = gp.preview; img.style.display = 'block'; }
      }
      if (msg.image) {
        const raw = typeof msg.image === 'object' ? (msg.image.image || msg.image.url || '') : msg.image;
        const src = raw.startsWith('http') || raw.startsWith('data:')
          ? raw : `${API.origin}/${raw.replace(/^\//, '')}`;
        img.src = src;
        img.style.display = 'block';
        bar.style.width = '100%';
        status.textContent = '';
      }
      if (msg.done) { _qpWS = null; resetQpBtn(); }
    };
    _qpWS.onerror = () => { status.textContent = '❌ Erreur WebSocket'; resetQpBtn(); _qpWS = null; };
    _qpWS.onclose = () => { if (btn.disabled) resetQpBtn(); _qpWS = null; };
  }

  function onRatioChange() {
    const r = el('sws-f-ratio').value;
    const cd = el('sws-custom-dims');
    cd.className = 'sws-custom-dims' + (r === 'custom' ? ' on' : '');
    if (r !== 'custom' && RATIOS[r]) {
      el('sws-f-w').value = RATIOS[r].w;
      el('sws-f-h').value = RATIOS[r].h;
    }
  }

  function saveTask() {
    if (!el('sws-f-prompt').value.trim()) { toast('Le prompt est obligatoire', 'error'); return; }
    const r = el('sws-f-ratio').value;
    const dims = r === 'custom'
      ? {w: +el('sws-f-w').value || 1024, h: +el('sws-f-h').value || 1024}
      : (RATIOS[r] || {w:1024, h:1024});
    const seedVal = parseInt(el('sws-f-seed').value, 10);
    const data = {
      name:    el('sws-f-name').value.trim()    || 'Sans nom',
      prompt:  el('sws-f-prompt').value.trim(),
      negative:el('sws-f-neg').value.trim(),
      model:   el('sws-f-model').value,
      steps:   +el('sws-f-steps').value || 20,
      cfg:     +el('sws-f-cfg').value   || 7,
      ratio:   r, width: dims.w, height: dims.h,
      seed:    Number.isFinite(seedVal) ? seedVal : -1,
      count:   +el('sws-f-count').value || 1,
      sampler: el('sws-f-sampler').value.trim(),
      group:   el('sws-f-group').value.trim(),
      loras:   collectLoras(),
      controlnet: {
        enabled:  el('sws-f-cn-enabled').checked,
        model:    el('sws-f-cn-model').value,
        type:     el('sws-f-cn-type').value,
        strength: +el('sws-f-cn-strength').value || 1,
        start:    +el('sws-f-cn-start').value    || 0,
        end:      +el('sws-f-cn-end').value      || 1,
        image:    Scheduler._cnImage || null,
      },
      hiresfix: {
        enabled: el('sws-f-hf-enabled').checked,
        model:   el('sws-f-hf-model').value,
        method:  el('sws-f-hf-method').value,
        scale:   +el('sws-f-hf-scale').value || 1.5,
        pct:     +el('sws-f-hf-pct').value   || 0.2,
        steps:   +el('sws-f-hf-steps').value || 10,
        cfg:     +el('sws-f-hf-cfg').value   || 7,
      },
    };
    const eid = el('sws-edit-id').value;
    if (eid) {
      const i = S.tasks.findIndex(t => t.id === +eid);
      if (i !== -1) S.tasks[i] = {...S.tasks[i], ...data};
    } else {
      S.tasks.push(makeTask(data));
    }
    save(); render(); closeModal();
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function closeMenus(except) {
    document.querySelectorAll('#view-scheduler .q-menu.open').forEach(m => { if (m !== except) m.classList.remove('open'); });
  }

  function bindQueueList() {
    const list = el('sws-list');

    list.addEventListener('click', e => {
      const a = e.target.closest('[data-a]');
      if (!a) return;
      if (a.dataset.a === 'group') {
        const g = a.closest('.q-group').dataset.group;
        if (S.collapsedGroups.has(g)) S.collapsedGroups.delete(g); else S.collapsedGroups.add(g);
        render();
        return;
      }
      const id = +a.closest('.q-task')?.dataset.id;
      if (!id) return;
      switch (a.dataset.a) {
        case 'edit':  editTask(id); break;
        case 'vary':  openVariations(id); break;
        case 'dup':   dupTask(id); break;
        case 'retry': resetStatus(id); break;
        case 'del':   deleteTask(id); break;
      }
    });
    list.addEventListener('change', e => {
      const id = +e.target.closest('.q-task')?.dataset.id;
      if (!id) return;
      if (e.target.dataset.a === 'toggle') toggleTask(id);
      if (e.target.dataset.a === 'count')  setTaskCount(id, e.target.value);
    });
    list.addEventListener('keydown', e => { if (e.target.dataset.a === 'count' && e.key === 'Enter') e.target.blur(); });
    list.addEventListener('dblclick', e => {
      const n = e.target.closest('.q-name');
      if (n) renameTask(+n.closest('.q-task').dataset.id, n);
    });

    // Glisser-déposer pour réordonner
    list.addEventListener('dragstart', e => {
      const card = e.target.closest('.q-task');
      if (!card || e.target.closest('input, button')) { e.preventDefault(); return; }
      S.dragId = +card.dataset.id;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', String(S.dragId));
      requestAnimationFrame(() => card.classList.add('dragging'));
    });
    list.addEventListener('dragend', () => {
      S.dragId = null;
      list.querySelectorAll('.dragging, .drop-before, .drop-after, .drop-into').forEach(n => n.classList.remove('dragging', 'drop-before', 'drop-after', 'drop-into'));
    });
    list.addEventListener('dragover', e => {
      if (!S.dragId) return;
      e.preventDefault();
      list.querySelectorAll('.drop-before, .drop-after, .drop-into').forEach(n => n.classList.remove('drop-before', 'drop-after', 'drop-into'));
      const card = e.target.closest('.q-task');
      if (card && +card.dataset.id !== S.dragId) {
        const r = card.getBoundingClientRect();
        card.classList.add(e.clientY > r.top + r.height / 2 ? 'drop-after' : 'drop-before');
      } else {
        e.target.closest('.q-group-hdr')?.classList.add('drop-into');
      }
    });
    list.addEventListener('drop', e => {
      if (!S.dragId) return;
      e.preventDefault();
      const card = e.target.closest('.q-task');
      if (card && +card.dataset.id !== S.dragId) {
        const r = card.getBoundingClientRect();
        moveTaskTo(S.dragId, +card.dataset.id, e.clientY > r.top + r.height / 2);
      } else {
        const hdr = e.target.closest('.q-group-hdr');
        if (hdr) moveTaskToGroupEnd(S.dragId, hdr.closest('.q-group').dataset.group);
      }
    });
  }

  function init() {
    if (S.initialized) return S.ready;
    S.initialized = true;
    S.ready = (async () => {
      await loadStorage();
      render();
      if (S.runActive && pendingTasks().length) el('q-resume').hidden = false;
      if (S.scheduledAt && S.scheduledAt <= Date.now()) {
        const hh = new Date(S.scheduledAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        toast(`Le lancement programmé à ${hh} n'a pas eu lieu (app fermée)`, 'error');
        clearSchedule();
      } else { armSchedule(); renderSchedule(); }
    })();

    // En-tête : menus « Ajouter » et « ⋯ »
    el('sws-btn-add').addEventListener('click', e => { e.stopPropagation(); const m = el('q-add-menu'); closeMenus(m); m.classList.toggle('open'); });
    el('q-more-btn').addEventListener('click', e => { e.stopPropagation(); const m = el('q-more-menu'); closeMenus(m); m.classList.toggle('open'); });
    el('q-sched-btn').addEventListener('click', e => {
      e.stopPropagation();
      const m = el('q-sched-menu'); closeMenus(m); m.classList.toggle('open');
      if (!el('q-sched-time').value) el('q-sched-time').value = '02:00';
    });
    el('q-sched-menu').addEventListener('click', e => e.stopPropagation());
    document.addEventListener('click', () => closeMenus());
    el('q-add-menu').addEventListener('click', e => {
      const b = e.target.closest('[data-add]');
      if (!b) return;
      closeMenus();
      ({ txt2img: () => addTxt2ImgToQueue(), edit: () => Flux.addToQueue(), preset: openPresetPicker, manual: () => openModal() })[b.dataset.add]?.();
    });
    el('q-more-menu').addEventListener('click', () => closeMenus());

    el('sws-btn-run').addEventListener('click', runQueue);
    el('sws-btn-pause').addEventListener('click', togglePause);
    el('sws-btn-stop').addEventListener('click', stopQueue);
    el('sws-btn-reset').addEventListener('click', resetAll);
    el('sws-btn-cleardone').addEventListener('click', () => {
      S.tasks = S.tasks.filter(t => t.status !== 'done');
      save(); render();
    });
    el('sws-btn-task-presets').addEventListener('click', openTaskPresetsModal);
    el('sws-btn-save').addEventListener('click', exportQueue);
    el('sws-btn-load').addEventListener('click', () => el('sws-file').click());
    el('sws-file').addEventListener('change', importQueue);

    // Programmation
    el('q-sched-set').addEventListener('click', () => {
      const v = el('q-sched-time').value;
      if (!v) return;
      setSchedule(nextOccurrence(v));
      closeMenus();
    });
    el('q-sched-cancel').addEventListener('click', clearSchedule);

    // Reprise
    el('q-resume-go').addEventListener('click', runQueue);
    el('q-resume-skip').addEventListener('click', () => {
      el('q-resume').hidden = true;
      S.runActive = false;
      dbSet('runActive', false).catch(() => {});
    });

    bindQueueList();

    // Variations
    el('q-var-close').addEventListener('click', closeVariations);
    el('q-var-cancel').addEventListener('click', closeVariations);
    el('q-var-create').addEventListener('click', createVariations);
    el('q-var-modal').addEventListener('input', updateVarTotal);
    el('q-var-modal').addEventListener('change', updateVarTotal);
    el('q-var-modal').addEventListener('click', e => { if (e.target === el('q-var-modal')) closeVariations(); });

    // Galerie
    el('sws-gal-clear').addEventListener('click', () => {
      el('sws-gallery').innerHTML = '<div class="sws-gal-empty">Les images de la file apparaîtront ici</div>';
      S.galCollapsed.clear();
      S.galSubCollapsed.clear();
    });
    el('sws-gal-dl-all').addEventListener('click', () => {
      downloadImgs(el('sws-gallery').querySelectorAll('.sws-gal-item img'), 'swarmapp_file');
    });

    // Formulaire manuel : LoRAs
    el('sws-lora-toggle').addEventListener('click', () => {
      const body  = el('sws-lora-body');
      body.classList.toggle('open');
      el('sws-lora-arrow').textContent = body.classList.contains('open') ? '▼' : '▶';
    });
    el('sws-lora-add').addEventListener('click', () => {
      addLoraRow();
      el('sws-lora-body').classList.add('open');
      el('sws-lora-arrow').textContent = '▼';
    });

    // Menu contextuel de la galerie
    el('sws-ctx-inpaint').addEventListener('click', () => { if (_galCtxSrc) { closeGalCtx(); sendToInpaint(_galCtxSrc); } });
    el('sws-ctx-watermark').addEventListener('click', () => { if (_galCtxSrc) { closeGalCtx(); sendToWatermark(_galCtxSrc); } });
    el('sws-ctx-open').addEventListener('click', () => { if (_galCtxSrc) { closeGalCtx(); openLightbox(_galCtxSrc, _galCtxGrid); } });
    el('sws-ctx-copy').addEventListener('click', () => { if (_galCtxSrc) { closeGalCtx(); copyImageToClipboard(_galCtxSrc); } });
    el('sws-ctx-dl').addEventListener('click', () => {
      if (!_galCtxSrc) return;
      closeGalCtx();
      const a = document.createElement('a');
      a.href = _galCtxSrc;
      a.download = 'scheduler-' + Date.now() + '.png';
      a.click();
    });
    document.addEventListener('click', e => { if (!el('sws-gal-ctx').contains(e.target)) closeGalCtx(); });

    // Formulaire manuel
    el('sws-modal-close').addEventListener('click', closeModal);
    el('sws-modal-cancel').addEventListener('click', closeModal);
    el('sws-modal-save').addEventListener('click', saveTask);
    el('sws-qp-btn').addEventListener('click', quickPreview);
    el('sws-f-ratio').addEventListener('change', onRatioChange);

    el('sws-cn-toggle').addEventListener('click', e => {
      if (e.target === el('sws-f-cn-enabled')) return;
      const cb = el('sws-f-cn-enabled');
      cb.checked = !cb.checked;
      el('sws-cn-body').classList.toggle('open', cb.checked);
      el('sws-cn-arrow').textContent = cb.checked ? '▼' : '▶';
    });
    el('sws-f-cn-enabled').addEventListener('change', () => {
      const checked = el('sws-f-cn-enabled').checked;
      el('sws-cn-body').classList.toggle('open', checked);
      el('sws-cn-arrow').textContent = checked ? '▼' : '▶';
    });
    el('sws-hf-toggle').addEventListener('click', e => {
      if (e.target === el('sws-f-hf-enabled')) return;
      const cb = el('sws-f-hf-enabled');
      cb.checked = !cb.checked;
      el('sws-hf-body').classList.toggle('open', cb.checked);
      el('sws-hf-arrow').textContent = cb.checked ? '▼' : '▶';
    });
    el('sws-f-hf-enabled').addEventListener('change', () => {
      const checked = el('sws-f-hf-enabled').checked;
      el('sws-hf-body').classList.toggle('open', checked);
      el('sws-hf-arrow').textContent = checked ? '▼' : '▶';
    });

    // Image ControlNet du formulaire manuel — clic, glisser-déposer, ⌘V (pasteTargets.js)
    const cnDrop  = el('sws-cn-dropzone');
    const cnFile  = el('sws-f-cn-file');
    const cnPrev  = el('sws-cn-preview');
    const cnLabel = el('sws-cn-drop-label');
    const cnClear = el('sws-cn-clear-btn');

    function setCnImage(dataUrl, name) {
      Scheduler._cnImage = dataUrl;
      cnPrev.src  = dataUrl;
      cnPrev.classList.add('show');
      cnDrop.classList.add('loaded');
      cnLabel.textContent = name || 'Image chargée ✓';
      cnClear.style.display = '';
    }

    function clearCnImage() {
      Scheduler._cnImage = null;
      cnPrev.src = '';
      cnPrev.classList.remove('show');
      cnDrop.classList.remove('loaded');
      cnLabel.textContent = 'Clique, glisse ou colle (⌘V) une image';
      cnClear.style.display = 'none';
      cnFile.value = '';
    }

    cnDrop.addEventListener('click', e => {
      if (e.target === cnClear) return;
      cnFile.click();
    });
    cnClear.addEventListener('click', e => { e.stopPropagation(); clearCnImage(); });
    cnDrop.addEventListener('dragover',  e => { e.preventDefault(); cnDrop.classList.add('drag-over'); });
    cnDrop.addEventListener('dragleave', () => cnDrop.classList.remove('drag-over'));
    cnDrop.addEventListener('drop', e => {
      e.preventDefault();
      cnDrop.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const r = new FileReader();
      r.onload = ev => setCnImage(ev.target.result, file.name);
      r.readAsDataURL(file);
    });
    cnFile.addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const r = new FileReader();
      r.onload = ev => setCnImage(ev.target.result, file.name);
      r.readAsDataURL(file);
      e.target.value = '';
    });
    Scheduler._clearCnImage = clearCnImage;

    // Presets SwarmUI
    el('sws-preset-close').addEventListener('click', closePresetPicker);
    el('sws-preset-search').addEventListener('input', e => renderPresetList(e.target.value));
    el('sws-preset-modal').addEventListener('click', e => { if (e.target === el('sws-preset-modal')) closePresetPicker(); });

    // Files enregistrées
    el('sws-tp-close').addEventListener('click', closeTaskPresetsModal);
    el('sws-tp-save-btn').addEventListener('click', saveCurrentAsTaskPreset);
    el('sws-tp-name').addEventListener('keydown', e => { if (e.key === 'Enter') saveCurrentAsTaskPreset(); });
    el('sws-tp-modal').addEventListener('click', e => { if (e.target === el('sws-tp-modal')) closeTaskPresetsModal(); });

    // Plein écran
    el('sws-lb').addEventListener('click', () => el('sws-lb').classList.remove('open'));
    document.addEventListener('keydown', e => {
      const lb = el('sws-lb');
      if (lb.classList.contains('open')) {
        if (e.key === 'ArrowRight') { e.preventDefault(); lbNavigate(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); lbNavigate(-1); }
        else if (e.key === 'Escape') lb.classList.remove('open');
        return;
      }
      if (e.key === 'Escape') { closeGalCtx(); closeMenus(); }
    });
    el('sws-gallery').addEventListener('scroll', closeGalCtx);

    return S.ready;
  }

  function onShow() {
    if (!S.connected) connect();
  }

  // ── API publique ────────────────────────────────────────────────────────────
  function getLastPrompts() {
    const formPrompt = el('sws-f-prompt')?.value?.trim();
    if (formPrompt) return { prompt: formPrompt, negative: el('sws-f-neg')?.value || '' };
    const task = S.tasks.find(t => t.enabled) || S.tasks[0];
    return task ? { prompt: task.prompt || '', negative: task.negative || '' } : null;
  }

  return {
    init,
    onShow,
    getLastPrompts,
    addSnapshotTask,
    updateSnapshotTask,
    // Appelés depuis le HTML généré (listes des modales)
    _applyPreset:      idx => applyPreset(idx),
    _loadTaskPreset:   id  => loadTaskPreset(id),
    _deleteTaskPreset: id  => deleteTaskPreset(id),
    _filteredPresets:  null,
    _cnImage:          null,
    _clearCnImage:     null,
    async addInpaintTask(data) {
      // data: { name, prompt, negative, model, steps, cfg, seed, count, loras,
      //         inpaint: { image, mask, denoising, maskMode } }
      await init();
      const task = makeTask({ ...data, type: 'inpaint' });
      S.tasks.push(task);
      save(); render();
      document.querySelector('.tab[data-tab="scheduler"]')?.click();
      setSchedulerMode('gen');   // la tâche est dans la file SwarmUI, pas dans l'inpaint par lot
      return task;
    },
  };
})();
