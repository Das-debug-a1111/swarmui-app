// ── SwarmUI Scheduler (native tab) ────────────────────────────────────────────
const Scheduler = (() => {
  'use strict';

  // ── Ratios ──────────────────────────────────────────────────────────────────
  const RATIOS = {
    '1:1':  {w:1024,h:1024}, '4:3': {w:1152,h:896},  '3:2': {w:1216,h:832},
    '16:9': {w:1344,h:768},  '21:9':{w:1536,h:640},
    '3:4':  {w:896,h:1152},  '2:3': {w:832,h:1216},  '9:16':{w:768,h:1344},
  };

  // ── State ───────────────────────────────────────────────────────────────────
  const S = {
    models:     [],
    cnModels:   [],
    presets:    [],
    tasks:      [],
    connected:  false,
    running:    false,
    paused:     false,
    stopReq:    false,
    currentWS:  null,
    nextId:     1,
    collapsedGroups: new Set(),
    galCollapsed:    new Set(),
    initialized: false,
  };

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const esc   = s => String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const $     = id => document.getElementById('sws-' + id);

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
    const sel = document.getElementById('sws-f-cn-model');
    if (!sel) return;
    sel.innerHTML = '<option value="">— Select CN model —</option>' +
      S.cnModels.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
  }

  async function fetchPresets() {
    S.presets = await API.listPresets();
  }

  async function connect() {
    if (S.running) return;
    setStatus('Connecting…');
    try {
      if (!API.session) await API.getSession();
      setStatus('Loading models…');
      S.models = await fetchModels();
      await fetchCNModels();
      await fetchPresets();
      S.connected = true;
      setStatus(`${S.models.length} models · ${S.presets.length} presets`);
      populateModels();
      updateButtons();
      toast('Connected!', 'success');
      requestNotifPermission();
    } catch(e) {
      S.connected = false;
      setStatus('Connection failed');
      toast('Connection failed: ' + e.message, 'error');
    }
  }

  function setStatus(txt) {
    const el = document.getElementById('sws-prog-status');
    if (el) el.textContent = txt;
  }

  function populateModels() {
    const opts = S.models.length
      ? '<option value="">— Select Model —</option>' +
        S.models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('')
      : '<option value="">— No models found —</option>';
    const mainSel = document.getElementById('sws-f-model');
    if (mainSel) { const cur = mainSel.value; mainSel.innerHTML = opts; if (cur) mainSel.value = cur; }
    const hfSel = document.getElementById('sws-f-hf-model');
    if (hfSel) {
      const cur = hfSel.value;
      hfSel.innerHTML = '<option value="">— Same as main —</option>' +
        S.models.map(m => `<option value="${esc(m.value)}">${esc(m.label)}</option>`).join('');
      if (cur) hfSel.value = cur;
    }
  }

  // ── Preset picker ──────────────────────────────────────────────────────────
  function openPresetPicker() {
    renderPresetList('');
    document.getElementById('sws-preset-search').value = '';
    document.getElementById('sws-preset-modal').classList.add('open');
    setTimeout(() => document.getElementById('sws-preset-search').focus(), 50);
  }

  function closePresetPicker() {
    document.getElementById('sws-preset-modal').classList.remove('open');
  }

  function renderPresetList(filter) {
    const list = document.getElementById('sws-preset-list');
    const q = filter.toLowerCase().trim();
    const filtered = q
      ? S.presets.filter(p => p.title.toLowerCase().includes(q) || (p.description||'').toLowerCase().includes(q))
      : S.presets;

    if (!filtered.length) {
      list.innerHTML = `<div class="sws-preset-empty">${q ? 'No presets match.' : 'No presets found.'}</div>`;
      return;
    }

    list.innerHTML = filtered.map((p, i) => {
      const pm = p.param_map || {};
      const model = pm.model ? pm.model.split('/').pop().slice(0, 24) : '';
      const steps = pm.steps || '';
      const cfg   = pm.cfgscale || '';
      const meta  = [model, steps ? `${steps}steps` : '', cfg ? `${cfg}cfg` : ''].filter(Boolean).join(' · ');
      const hasThumb = p.preview_image && !p.preview_image.includes('placeholder');
      const thumb = hasThumb
        ? `<img class="sws-preset-thumb" src="${esc(p.preview_image)}" alt="" onerror="this.style.display='none'">`
        : `<div class="sws-preset-thumb" style="display:flex;align-items:center;justify-content:center;font-size:18px">🖼</div>`;
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

    document.getElementById('sws-edit-id').value    = '';
    document.getElementById('sws-modal-title').textContent = `Add Task — from "${p.title}"`;
    document.getElementById('sws-f-name').value     = p.title;
    document.getElementById('sws-f-prompt').value   = pm.prompt         || '';
    document.getElementById('sws-f-neg').value      = pm.negativeprompt || '';
    document.getElementById('sws-f-steps').value    = pm.steps          || 20;
    document.getElementById('sws-f-cfg').value      = pm.cfgscale       || 7;
    document.getElementById('sws-f-count').value    = 4;
    document.getElementById('sws-f-seed').value     = pm.seed           ?? -1;
    document.getElementById('sws-f-sampler').value  = pm.sampler        || '';
    document.getElementById('sws-f-w').value        = w;
    document.getElementById('sws-f-h').value        = h;
    document.getElementById('sws-f-ratio').value    = ratio;
    onRatioChange();

    populateModels();
    if (pm.model) document.getElementById('sws-f-model').value = pm.model;

    document.getElementById('sws-modal').classList.add('open');
    setTimeout(() => document.getElementById('sws-f-name').focus(), 50);
    toast(`Preset "${p.title}" loaded`, 'info');
  }

  // ── Generation (WebSocket) ──────────────────────────────────────────────────
  function generateWS(task) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${API.wsOrigin}/API/GenerateText2ImageWS`);
      S.currentWS = ws;
      let gotDone = false, gotImage = false;

      ws.onopen = () => {
        const payload = {
          session_id:     API.session,
          images:         +task.count || 1,
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
        const cn = task.controlnet;
        if (cn && cn.enabled && cn.image) {
          payload.controlnetimage     = cn.image;
          payload.controlnetstrength  = cn.strength ?? 1;
          payload.controlnetstartpct  = cn.start    ?? 0;
          payload.controlnetendpct    = cn.end      ?? 1;
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
        ws.send(JSON.stringify(payload));
      };

      ws.onmessage = evt => {
        let msg; try { msg = JSON.parse(evt.data); } catch { return; }
        if (msg.error) { reject(new Error(msg.error)); ws.close(); return; }
        if (msg.status !== undefined) {
          const s = String(msg.status);
          if (s.toLowerCase().startsWith('error')) { reject(new Error(s)); ws.close(); return; }
          const pct = msg.overall_percent ?? msg.cur_overall_percent ?? 0;
          setProgress(pct, s);
        }
        if (msg.gen_progress) {
          const p = msg.gen_progress;
          const pct = p.overall_percent ?? p.current_percent ?? 0;
          setProgress(pct, `Image ${(p.batch_index||0)+1}/${task.count}`);
          if (p.preview) showLivePreview(p.preview);
        }
        if (msg.image) {
          hideLivePreview();
          const imgObj  = typeof msg.image === 'object' ? msg.image : null;
          const rawPath = imgObj ? (imgObj.image || imgObj.url || '') : msg.image;
          const src = rawPath.startsWith('http') || rawPath.startsWith('data:')
            ? rawPath
            : `${API.origin}/${rawPath.replace(/^\//, '')}`;
          if (src) { gotImage = true; addToGallery(src, task.name, task.group || ''); }
        }
        if (msg.done) { gotDone = true; ws.close(); }
      };

      ws.onclose = () => {
        S.currentWS = null;
        if (S.stopReq) reject(new Error('stopped'));
        else if (!gotDone && !gotImage) reject(new Error('Generation failed — server closed unexpectedly'));
        else resolve();
      };
      ws.onerror = () => { S.currentWS = null; reject(new Error('WebSocket error')); };
    });
  }

  // ── Queue runner ────────────────────────────────────────────────────────────
  async function runQueue() {
    if (!S.connected) { toast('Not connected', 'error'); return; }
    if (S.running) return;
    if (!API.session) { try { await API.getSession(); } catch(e) { toast('Session error: ' + e.message, 'error'); return; } }
    const pending = S.tasks.filter(t => t.enabled && t.status !== 'done');
    if (!pending.length) { toast('No pending tasks', 'error'); return; }

    S.running = true; S.paused = false; S.stopReq = false;
    updateButtons();

    let done = 0;
    const total = pending.length;

    for (let i = 0; i < S.tasks.length; i++) {
      if (S.stopReq) break;
      const task = S.tasks[i];
      if (!task.enabled || task.status === 'done') continue;

      while (S.paused && !S.stopReq) await sleep(400);
      if (S.stopReq) break;

      task.status = 'running';
      render();
      document.getElementById('sws-prog-name').textContent = task.name;
      document.getElementById('sws-prog-name').style.color = '';
      document.getElementById('sws-qcounter').textContent = `${done+1} / ${total}`;
      setProgress(0, 'Starting…');

      try {
        await generateWS(task);
        task.status = 'done'; done++;
        notify(`✅ ${task.name}`, `${task.count} image${task.count>1?'s':''} generated (${done}/${total})`, 'sws-task-done');
      } catch(e) {
        task.status = 'error'; task.errMsg = e.message;
        toast(`"${task.name}" failed: ${e.message}`, 'error');
        if (typeof showErrorToast === 'function') showErrorToast(`"${task.name}" failed: ${e.message}`);
      }
      save(); render();
    }

    S.running = false; S.paused = false;
    updateButtons();
    document.getElementById('sws-qcounter').textContent = '';

    if (!S.stopReq) {
      const failed = total - done;
      if (done > 0) {
        document.getElementById('sws-prog-name').textContent = `Done — ${done}/${total} tasks`;
        document.getElementById('sws-prog-name').style.color = failed > 0 ? 'var(--yellow, #fa0)' : 'var(--green)';
        setProgress(1, '');
        toast(`Queue done — ${done}/${total} tasks succeeded`, failed > 0 ? 'info' : 'success');
        notify('✅ SwarmUI Scheduler', `${done}/${total} task${done>1?'s':''} completed${failed>0?' ('+failed+' failed)':''}`, 'sws-queue-done');
      } else {
        document.getElementById('sws-prog-name').textContent = `Failed — 0/${total} tasks`;
        document.getElementById('sws-prog-name').style.color = 'var(--red)';
        setProgress(0, '');
        toast(`All ${total} task${total>1?'s':''} failed`, 'error');
        notify('❌ SwarmUI Scheduler', `Queue failed — ${total} task${total>1?'s':''} errored`, 'sws-queue-done');
      }
    } else {
      document.getElementById('sws-prog-name').textContent = 'Stopped';
      document.getElementById('sws-prog-name').style.color = 'var(--red)';
      setProgress(0, '');
    }
  }

  function togglePause() {
    S.paused = !S.paused;
    document.getElementById('sws-btn-pause').textContent = S.paused ? '▶ Resume' : '⏸ Pause';
    toast(S.paused ? 'Paused' : 'Resumed', 'info');
  }

  function stopQueue() {
    S.stopReq = true; S.paused = false;
    if (S.currentWS) { S.currentWS.close(); S.currentWS = null; }
    S.running = false;
    updateButtons();
    document.getElementById('sws-btn-pause').textContent = '⏸ Pause';
    toast('Stopped', 'error');
  }

  // ── Progress UI ─────────────────────────────────────────────────────────────
  function setProgress(pct, status) {
    const p = Math.min(1, Math.max(0, pct));
    document.getElementById('sws-prog-bar').style.width = `${p * 100}%`;
    document.getElementById('sws-prog-pct').textContent  = `${Math.round(p * 100)}%`;
    if (status !== undefined) document.getElementById('sws-prog-status').textContent = status || '';
  }

  // ── Gallery ─────────────────────────────────────────────────────────────────
  function showLivePreview(dataUrl) {
    const gallery = document.getElementById('sws-gallery');
    if (!gallery) return;
    let el = document.getElementById('sws-live-preview');
    if (!el) {
      el = document.createElement('img');
      el.id = 'sws-live-preview';
      el.style.cssText = 'width:100%;max-width:400px;border-radius:8px;opacity:0.8;border:2px dashed var(--accent);margin-bottom:8px;display:block;';
      gallery.prepend(el);
    }
    el.src = dataUrl;
  }

  function hideLivePreview() {
    const el = document.getElementById('sws-live-preview');
    if (el) el.remove();
  }

  function addToGallery(src, name, group) {
    const gallery = document.getElementById('sws-gallery');
    const empty = gallery.querySelector('.sws-gal-empty');
    if (empty) empty.remove();

    const groupKey = group || '';
    const sectionId = 'sws-gal-sect-' + groupKey.replace(/\W+/g, '_');
    let sect = document.getElementById(sectionId);
    if (!sect) {
      sect = document.createElement('div');
      sect.className = 'sws-gal-sect';
      sect.id = sectionId;

      const hdr = document.createElement('div');
      hdr.className = 'sws-gal-sect-hdr';
      hdr.dataset.group = groupKey;
      hdr.addEventListener('click', () => toggleGalGroup(groupKey, hdr));

      const grid = document.createElement('div');
      grid.className = 'sws-gal-sect-grid';

      sect.appendChild(hdr);
      sect.appendChild(grid);
      gallery.insertBefore(sect, gallery.firstChild);
    }

    const grid = sect.querySelector('.sws-gal-sect-grid');
    const hdr  = sect.querySelector('.sws-gal-sect-hdr');

    // Add image
    const item = document.createElement('div');
    item.className = 'sws-gal-item';
    item.title = name;
    item.onclick = () => openLightbox(src, grid);
    item.addEventListener('contextmenu', e => { e.preventDefault(); openGalCtx(src, grid, e.clientX, e.clientY); });
    const img = document.createElement('img');
    img.src = src; img.alt = name; img.loading = 'lazy';
    item.appendChild(img);
    grid.insertBefore(item, grid.firstChild);

    // Update header label + count
    const count = grid.querySelectorAll('.sws-gal-item').length;
    const collapsed = S.galCollapsed.has(groupKey);
    hdr.innerHTML = `<span>${groupKey ? '📁 ' + groupKey : '📷 All'}</span><span style="font-weight:400">${count} img${count > 1 ? 's' : ''} ${collapsed ? '▶' : '▼'}</span>`;
    if (collapsed) hdr.classList.add('collapsed');
  }

  function toggleGalGroup(groupKey, hdr) {
    if (S.galCollapsed.has(groupKey)) {
      S.galCollapsed.delete(groupKey);
      hdr.classList.remove('collapsed');
    } else {
      S.galCollapsed.add(groupKey);
      hdr.classList.add('collapsed');
    }
    // Update arrow in header
    const grid = hdr.nextElementSibling;
    const count = grid ? grid.querySelectorAll('.sws-gal-item').length : 0;
    const collapsed = S.galCollapsed.has(groupKey);
    hdr.innerHTML = `<span>${groupKey ? '📁 ' + groupKey : '📷 All'}</span><span style="font-weight:400">${count} img${count > 1 ? 's' : ''} ${collapsed ? '▶' : '▼'}</span>`;
    if (collapsed) hdr.classList.add('collapsed');
  }

  // ── Lightbox with arrow navigation ──────────────────────────────────────────
  let _lbItems = [];   // array of src strings for current group
  let _lbIndex = 0;

  function openLightbox(src, grid) {
    if (grid) {
      // Build ordered list from the grid (items are inserted at front, so reverse to get chronological order)
      _lbItems = [...grid.querySelectorAll('.sws-gal-item img')].map(img => img.src).reverse();
      _lbIndex = _lbItems.indexOf(src);
      if (_lbIndex === -1) { _lbItems = [src]; _lbIndex = 0; }
    } else {
      _lbItems = [src]; _lbIndex = 0;
    }
    document.getElementById('sws-lb-img').src = _lbItems[_lbIndex];
    document.getElementById('sws-lb').classList.add('open');
    updateLbCounter();
  }

  function lbNavigate(dir) {
    if (!_lbItems.length) return;
    _lbIndex = (_lbIndex + dir + _lbItems.length) % _lbItems.length;
    document.getElementById('sws-lb-img').src = _lbItems[_lbIndex];
    updateLbCounter();
  }

  function updateLbCounter() {
    const el = document.getElementById('sws-lb-counter');
    if (!el) return;
    el.textContent = _lbItems.length > 1 ? `${_lbIndex + 1} / ${_lbItems.length}` : '';
  }

  // ── Gallery context menu ─────────────────────────────────────────────────────
  let _galCtxSrc  = null;
  let _galCtxGrid = null;

  function openGalCtx(src, grid, x, y) {
    _galCtxSrc  = src;
    _galCtxGrid = grid;
    const menu = document.getElementById('sws-gal-ctx');
    menu.classList.add('open');
    const mw = menu.offsetWidth  || 170;
    const mh = menu.offsetHeight || 100;
    menu.style.left = Math.min(x, window.innerWidth  - mw - 8) + 'px';
    menu.style.top  = Math.min(y, window.innerHeight - mh - 8) + 'px';
  }

  function closeGalCtx() {
    document.getElementById('sws-gal-ctx').classList.remove('open');
  }

  // ── Task CRUD ───────────────────────────────────────────────────────────────
  function makeTask(d) {
    return {
      id:      S.nextId++,
      name:    d.name     || `Task ${S.nextId}`,
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
      controlnet: d.controlnet || { enabled: false, model: '', type: 'none', strength: 1, start: 0, end: 1, image: null },
      hiresfix:   d.hiresfix   || { enabled: false, model: '', method: 'model-remacri_original.pth', scale: 1.5, pct: 0.2, steps: 10, cfg: 7 },
    };
  }

  function openModal(id = null) {
    populateModels();
    populateCNModels();
    document.getElementById('sws-edit-id').value = id || '';
    document.getElementById('sws-modal-title').textContent = id ? 'Edit Task' : 'Add Task';
    if (id) {
      const t = S.tasks.find(x => x.id === id);
      if (!t) return;
      document.getElementById('sws-f-group').value   = t.group || '';
      document.getElementById('sws-f-name').value    = t.name;
      document.getElementById('sws-f-prompt').value  = t.prompt;
      document.getElementById('sws-f-neg').value     = t.negative;
      document.getElementById('sws-f-model').value   = t.model;
      document.getElementById('sws-f-steps').value   = t.steps;
      document.getElementById('sws-f-cfg').value     = t.cfg;
      document.getElementById('sws-f-ratio').value   = t.ratio;
      document.getElementById('sws-f-count').value   = t.count;
      document.getElementById('sws-f-seed').value    = t.seed;
      document.getElementById('sws-f-sampler').value = t.sampler || '';
      const cn = t.controlnet || {};
      document.getElementById('sws-f-cn-enabled').checked = !!cn.enabled;
      document.getElementById('sws-f-cn-model').value     = cn.model    || '';
      document.getElementById('sws-f-cn-type').value      = cn.type     || 'none';
      document.getElementById('sws-f-cn-strength').value  = cn.strength ?? 1;
      document.getElementById('sws-f-cn-start').value     = cn.start    ?? 0;
      document.getElementById('sws-f-cn-end').value       = cn.end      ?? 1;
      document.getElementById('sws-f-cn-imgurl').value    = cn.image ? '(image loaded)' : '';
      document.getElementById('sws-cn-preview').src       = cn.image || '';
      document.getElementById('sws-cn-preview').classList.toggle('show', !!cn.image);
      document.getElementById('sws-cn-body').classList.toggle('open', !!cn.enabled);
      document.getElementById('sws-cn-arrow').textContent = cn.enabled ? '▼' : '▶';
      Scheduler._cnImage = cn.image || null;
      const hf = t.hiresfix || {};
      document.getElementById('sws-f-hf-enabled').checked = !!hf.enabled;
      document.getElementById('sws-f-hf-model').value     = hf.model  || '';
      document.getElementById('sws-f-hf-method').value    = hf.method || 'model-remacri_original.pth';
      document.getElementById('sws-f-hf-scale').value     = hf.scale  ?? 1.5;
      document.getElementById('sws-f-hf-pct').value       = hf.pct    ?? 0.2;
      document.getElementById('sws-f-hf-steps').value     = hf.steps  ?? 10;
      document.getElementById('sws-f-hf-cfg').value       = hf.cfg    ?? 7;
      document.getElementById('sws-hf-body').classList.toggle('open', !!hf.enabled);
      document.getElementById('sws-hf-arrow').textContent = hf.enabled ? '▼' : '▶';
      document.getElementById('sws-f-w').value = t.width;
      document.getElementById('sws-f-h').value = t.height;
    } else {
      document.getElementById('sws-f-group').value   = '';
      document.getElementById('sws-f-name').value    = `Task ${S.tasks.length + 1}`;
      document.getElementById('sws-f-prompt').value  = '';
      document.getElementById('sws-f-neg').value     = '';
      document.getElementById('sws-f-model').value   = S.models[0]?.value || '';
      document.getElementById('sws-f-steps').value   = 20;
      document.getElementById('sws-f-cfg').value     = 7;
      document.getElementById('sws-f-ratio').value   = '1:1';
      document.getElementById('sws-f-count').value   = 4;
      document.getElementById('sws-f-seed').value    = -1;
      document.getElementById('sws-f-sampler').value = '';
      document.getElementById('sws-f-cn-enabled').checked = false;
      document.getElementById('sws-f-cn-model').value     = '';
      document.getElementById('sws-f-cn-type').value      = 'none';
      document.getElementById('sws-f-cn-strength').value  = 1;
      document.getElementById('sws-f-cn-start').value     = 0;
      document.getElementById('sws-f-cn-end').value       = 1;
      document.getElementById('sws-f-cn-imgurl').value    = '';
      document.getElementById('sws-cn-preview').src       = '';
      document.getElementById('sws-cn-preview').classList.remove('show');
      document.getElementById('sws-cn-body').classList.remove('open');
      document.getElementById('sws-cn-arrow').textContent = '▶';
      Scheduler._cnImage = null;
      document.getElementById('sws-f-hf-enabled').checked = false;
      document.getElementById('sws-f-hf-model').value     = '';
      document.getElementById('sws-f-hf-method').value    = 'model-remacri_original.pth';
      document.getElementById('sws-f-hf-scale').value     = 1.5;
      document.getElementById('sws-f-hf-pct').value       = 0.2;
      document.getElementById('sws-f-hf-steps').value     = 10;
      document.getElementById('sws-f-hf-cfg').value       = 7;
      document.getElementById('sws-hf-body').classList.remove('open');
      document.getElementById('sws-hf-arrow').textContent = '▶';
      document.getElementById('sws-f-w').value = 1024;
      document.getElementById('sws-f-h').value = 1024;
    }
    onRatioChange();
    document.getElementById('sws-modal').classList.add('open');
    setTimeout(() => document.getElementById('sws-f-name').focus(), 50);
  }

  function closeModal() { document.getElementById('sws-modal').classList.remove('open'); }

  function onRatioChange() {
    const r = document.getElementById('sws-f-ratio').value;
    const cd = document.getElementById('sws-custom-dims');
    cd.className = 'sws-custom-dims' + (r === 'custom' ? ' on' : '');
    if (r !== 'custom' && RATIOS[r]) {
      document.getElementById('sws-f-w').value = RATIOS[r].w;
      document.getElementById('sws-f-h').value = RATIOS[r].h;
    }
  }

  function saveTask() {
    if (!document.getElementById('sws-f-prompt').value.trim()) { toast('Prompt is required', 'error'); return; }
    const r = document.getElementById('sws-f-ratio').value;
    const dims = r === 'custom'
      ? {w: +document.getElementById('sws-f-w').value || 1024, h: +document.getElementById('sws-f-h').value || 1024}
      : (RATIOS[r] || {w:1024, h:1024});
    const data = {
      name:    document.getElementById('sws-f-name').value.trim()    || 'Unnamed',
      prompt:  document.getElementById('sws-f-prompt').value.trim(),
      negative:document.getElementById('sws-f-neg').value.trim(),
      model:   document.getElementById('sws-f-model').value,
      steps:   +document.getElementById('sws-f-steps').value || 20,
      cfg:     +document.getElementById('sws-f-cfg').value   || 7,
      ratio:   r, width: dims.w, height: dims.h,
      seed:    +document.getElementById('sws-f-seed').value ?? -1,
      count:   +document.getElementById('sws-f-count').value || 1,
      sampler: document.getElementById('sws-f-sampler').value.trim(),
      group:   document.getElementById('sws-f-group').value.trim(),
      controlnet: {
        enabled:  document.getElementById('sws-f-cn-enabled').checked,
        model:    document.getElementById('sws-f-cn-model').value,
        type:     document.getElementById('sws-f-cn-type').value,
        strength: +document.getElementById('sws-f-cn-strength').value || 1,
        start:    +document.getElementById('sws-f-cn-start').value    || 0,
        end:      +document.getElementById('sws-f-cn-end').value      || 1,
        image:    Scheduler._cnImage || null,
      },
      hiresfix: {
        enabled: document.getElementById('sws-f-hf-enabled').checked,
        model:   document.getElementById('sws-f-hf-model').value,
        method:  document.getElementById('sws-f-hf-method').value,
        scale:   +document.getElementById('sws-f-hf-scale').value || 1.5,
        pct:     +document.getElementById('sws-f-hf-pct').value   || 0.2,
        steps:   +document.getElementById('sws-f-hf-steps').value || 10,
        cfg:     +document.getElementById('sws-f-hf-cfg').value   || 7,
      },
    };
    const eid = document.getElementById('sws-edit-id').value;
    if (eid) {
      const i = S.tasks.findIndex(t => t.id === +eid);
      if (i !== -1) S.tasks[i] = {...S.tasks[i], ...data};
    } else {
      S.tasks.push(makeTask(data));
    }
    save(); render(); closeModal();
    toast('Task saved!', 'success');
  }

  function deleteTask(id) {
    if (!confirm('Delete this task?')) return;
    S.tasks = S.tasks.filter(t => t.id !== id);
    save(); render();
  }

  function moveTask(id, dir) {
    const i = S.tasks.findIndex(t => t.id === id);
    if (i < 0) return;
    const j = i + dir;
    if (j < 0 || j >= S.tasks.length) return;
    [S.tasks[i], S.tasks[j]] = [S.tasks[j], S.tasks[i]];
    save(); render();
  }

  function dupTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (!t) return;
    const copy = makeTask({...t, name: t.name + ' (copy)'});
    const i = S.tasks.findIndex(x => x.id === id);
    S.tasks.splice(i + 1, 0, copy);
    save(); render();
    toast('Duplicated!', 'success');
  }

  function resetStatus(id) {
    const t = S.tasks.find(x => x.id === id);
    if (t) { t.status = 'pending'; t.errMsg = ''; save(); render(); }
  }

  function resetAll() {
    S.tasks.forEach(t => {
      if (t.status === 'done' || t.status === 'error') { t.status = 'pending'; t.errMsg = ''; }
    });
    save(); render();
    toast('All tasks reset to pending', 'info');
  }

  function toggleTask(id) {
    const t = S.tasks.find(x => x.id === id);
    if (t) { t.enabled = !t.enabled; save(); render(); }
  }

  // ── Render ──────────────────────────────────────────────────────────────────
  function render() {
    const list = document.getElementById('sws-list');
    const enabled = S.tasks.filter(t => t.enabled).length;
    document.getElementById('sws-count').textContent = `${S.tasks.length} · ${enabled} enabled`;

    if (!S.tasks.length) {
      list.innerHTML = '<div class="sws-empty">No tasks — click + Add to start.</div>';
      const dl = document.getElementById('sws-group-list');
      if (dl) dl.innerHTML = '';
      return;
    }

    const badges = {pending:'bp', running:'br', done:'bd', error:'be'};
    const labels  = {pending:'Pending', running:'Running…', done:'Done', error:'Error'};
    const dimLabel = t => t.ratio === 'custom' ? `${t.width}×${t.height}` : `${t.ratio}`;

    const groups = [];
    const groupMap = {};
    for (const t of S.tasks) {
      const g = t.group || '';
      if (!groupMap.hasOwnProperty(g)) { groupMap[g] = []; groups.push(g); }
      groupMap[g].push(t);
    }

    let html = '';
    for (const g of groups) {
      const tasks = groupMap[g];
      const collapsed = S.collapsedGroups.has(g);
      if (g) {
        const doneCount = tasks.filter(t => t.status === 'done').length;
        const allDone   = doneCount === tasks.length;
        html += `<div class="sws-group-hdr" onclick='Scheduler._toggleGroup(${JSON.stringify(g)})'>
          <span>${collapsed ? '▶' : '▼'} 📁 ${esc(g)}</span>
          <span class="sws-group-count">${tasks.length} task${tasks.length>1?'s':''}${doneCount ? ` · ${doneCount} done` : ''}${allDone?' ✓':''}</span>
        </div>`;
      }
      if (!collapsed) {
        for (const t of tasks) {
          const i = S.tasks.indexOf(t);
          html += `
            <div class="sws-task ${t.status}${g ? ' in-group' : ''}">
              <input type="checkbox" class="sws-task-check" ${t.enabled ? 'checked' : ''}
                onchange="Scheduler._toggleTask(${t.id})">
              <div class="sws-task-body">
                <div class="sws-task-name-row">
                  <span class="sws-task-name">${esc(t.name)}</span>
                  <span class="sws-badge ${badges[t.status] || 'bp'}">${labels[t.status] || 'Pending'}</span>
                  ${t.status === 'error' ? `<span style="font-size:10px;color:var(--red)" title="${esc(t.errMsg)}">⚠ ${esc(t.errMsg.slice(0,40))}</span>` : ''}
                  ${t.group ? `<span class="sws-badge" style="background:rgba(139,148,158,.15);color:var(--muted);border:1px solid var(--border)">📁 ${esc(t.group)}</span>` : ''}
                </div>
                <div class="sws-task-prompt" title="${esc(t.prompt)}">${esc(t.prompt)}</div>
                <div class="sws-task-meta">
                  <span class="sws-chip">🖼 ${t.count}</span>
                  <span class="sws-chip">📐 ${dimLabel(t)}</span>
                  <span class="sws-chip">🔢 ${t.steps}steps</span>
                  <span class="sws-chip">⚖ ${t.cfg}cfg</span>
                  ${t.model ? `<span class="sws-chip" title="${esc(t.model)}">🤖 ${esc(t.model.split('/').pop().slice(0,20))}</span>` : ''}
                  ${t.controlnet?.enabled ? `<span class="sws-chip" style="color:var(--purple)">🎛 CN</span>` : ''}
                  ${t.hiresfix?.enabled   ? `<span class="sws-chip" style="color:var(--green)">⬆ HF×${t.hiresfix.scale}</span>` : ''}
                </div>
              </div>
              <div class="sws-task-actions">
                <button class="sws-icon-btn" onclick="Scheduler._openModal(${t.id})" title="Edit">✏</button>
                <button class="sws-icon-btn" onclick="Scheduler._dup(${t.id})" title="Duplicate">⧉</button>
                <button class="sws-icon-btn" onclick="Scheduler._move(${t.id},-1)" title="Up" ${i === 0 ? 'disabled' : ''}>↑</button>
                <button class="sws-icon-btn" onclick="Scheduler._move(${t.id},1)" title="Down" ${i === S.tasks.length - 1 ? 'disabled' : ''}>↓</button>
                <button class="sws-icon-btn" onclick="Scheduler._reset(${t.id})" title="Reset" ${t.status === 'running' ? 'disabled' : ''}>↺</button>
                <button class="sws-icon-btn del" onclick="Scheduler._delete(${t.id})" title="Delete">✕</button>
              </div>
            </div>`;
        }
      }
    }
    list.innerHTML = html;

    const dl = document.getElementById('sws-group-list');
    if (dl) {
      const knownGroups = [...new Set(S.tasks.map(t => t.group).filter(Boolean))];
      dl.innerHTML = knownGroups.map(g => `<option value="${esc(g)}">`).join('');
    }
  }

  function updateButtons() {
    document.getElementById('sws-btn-run').disabled     = !S.connected || S.running;
    document.getElementById('sws-btn-pause').disabled   = !S.running;
    document.getElementById('sws-btn-stop').disabled    = !S.running;
    document.getElementById('sws-btn-presets').disabled = !S.connected;
  }

  // ── Persistence ─────────────────────────────────────────────────────────────
  function save() {
    try {
      localStorage.setItem('sws_tasks',  JSON.stringify(S.tasks));
      localStorage.setItem('sws_nextid', S.nextId);
    } catch {}
  }

  function loadStorage() {
    try {
      const tasks  = localStorage.getItem('sws_tasks');
      const nextid = localStorage.getItem('sws_nextid');
      if (tasks) {
        S.tasks = JSON.parse(tasks).map(t => ({
          ...t, status: t.status === 'running' ? 'pending' : t.status, errMsg: t.errMsg || '',
        }));
      }
      if (nextid) S.nextId = +nextid || 1;
      if (S.tasks.length) S.nextId = Math.max(S.nextId, ...S.tasks.map(t => t.id)) + 1;
    } catch {}
  }

  function exportQueue() {
    const blob = new Blob([JSON.stringify({version:1, tasks: S.tasks.map(t=>({...t,status:'pending',errMsg:''}))}, null, 2)], {type:'application/json'});
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `swarm-queue-${Date.now()}.json`;
    a.click(); URL.revokeObjectURL(a.href);
    toast('Queue saved!', 'success');
  }

  function importQueue(ev) {
    const file = ev.target.files[0]; if (!file) return;
    const r = new FileReader();
    r.onload = e => {
      try {
        const d = JSON.parse(e.target.result);
        if (!d.tasks?.length) throw new Error('No tasks found');
        if (S.tasks.length && !confirm('Replace current queue?')) return;
        S.nextId = 1; S.tasks = d.tasks.map(t => makeTask(t));
        save(); render();
        toast(`Loaded ${S.tasks.length} tasks`, 'success');
      } catch(err) { toast('Invalid file: ' + err.message, 'error'); }
    };
    r.readAsText(file);
    ev.target.value = '';
  }

  // ── Toast ────────────────────────────────────────────────────────────────────
  let _toastT;
  function toast(msg, type = 'success') {
    const el = document.getElementById('sws-toast');
    el.textContent = msg;
    el.className = `sws-toast show ${type}`;
    clearTimeout(_toastT);
    _toastT = setTimeout(() => el.classList.remove('show'), 3000);
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

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    if (S.initialized) return;
    S.initialized = true;

    loadStorage();
    render();
    updateButtons();

    // Toolbar buttons
    document.getElementById('sws-btn-add').addEventListener('click', () => openModal());
    document.getElementById('sws-btn-presets').addEventListener('click', openPresetPicker);
    document.getElementById('sws-btn-run').addEventListener('click', runQueue);
    document.getElementById('sws-btn-pause').addEventListener('click', togglePause);
    document.getElementById('sws-btn-stop').addEventListener('click', stopQueue);
    document.getElementById('sws-btn-connect').addEventListener('click', connect);
    document.getElementById('sws-btn-reset').addEventListener('click', resetAll);
    document.getElementById('sws-btn-cleardone').addEventListener('click', () => {
      S.tasks = S.tasks.filter(t => t.status !== 'done' && t.status !== 'error');
      save(); render();
      toast('Done tasks cleared', 'info');
    });
    document.getElementById('sws-btn-save').addEventListener('click', exportQueue);
    document.getElementById('sws-btn-load').addEventListener('click', () => document.getElementById('sws-file').click());
    document.getElementById('sws-file').addEventListener('change', importQueue);
    document.getElementById('sws-gal-clear').addEventListener('click', () => {
      document.getElementById('sws-gallery').innerHTML = '<div class="sws-gal-empty">Images will appear here</div>';
      S.galCollapsed.clear();
    });

    // Gallery context menu
    document.getElementById('sws-ctx-inpaint').addEventListener('click', () => {
      if (_galCtxSrc) { closeGalCtx(); sendToInpaint(_galCtxSrc); }
    });
    document.getElementById('sws-ctx-open').addEventListener('click', () => {
      if (_galCtxSrc) { closeGalCtx(); openLightbox(_galCtxSrc, _galCtxGrid); }
    });
    document.getElementById('sws-ctx-dl').addEventListener('click', () => {
      if (_galCtxSrc) {
        closeGalCtx();
        const a = document.createElement('a');
        a.href = _galCtxSrc;
        a.download = 'scheduler-' + Date.now() + '.png';
        a.click();
      }
    });
    document.addEventListener('click', e => {
      if (!document.getElementById('sws-gal-ctx').contains(e.target)) closeGalCtx();
    });

    // Modal
    document.getElementById('sws-modal-close').addEventListener('click', closeModal);
    document.getElementById('sws-modal-cancel').addEventListener('click', closeModal);
    document.getElementById('sws-modal-save').addEventListener('click', saveTask);
    document.getElementById('sws-f-ratio').addEventListener('change', onRatioChange);

    // ControlNet toggle
    document.getElementById('sws-cn-toggle').addEventListener('click', e => {
      if (e.target === document.getElementById('sws-f-cn-enabled')) return;
      const cb = document.getElementById('sws-f-cn-enabled');
      cb.checked = !cb.checked;
      document.getElementById('sws-cn-body').classList.toggle('open', cb.checked);
      document.getElementById('sws-cn-arrow').textContent = cb.checked ? '▼' : '▶';
    });
    document.getElementById('sws-f-cn-enabled').addEventListener('change', () => {
      const checked = document.getElementById('sws-f-cn-enabled').checked;
      document.getElementById('sws-cn-body').classList.toggle('open', checked);
      document.getElementById('sws-cn-arrow').textContent = checked ? '▼' : '▶';
    });

    // Hires Fix toggle
    document.getElementById('sws-hf-toggle').addEventListener('click', e => {
      if (e.target === document.getElementById('sws-f-hf-enabled')) return;
      const cb = document.getElementById('sws-f-hf-enabled');
      cb.checked = !cb.checked;
      document.getElementById('sws-hf-body').classList.toggle('open', cb.checked);
      document.getElementById('sws-hf-arrow').textContent = cb.checked ? '▼' : '▶';
    });
    document.getElementById('sws-f-hf-enabled').addEventListener('change', () => {
      const checked = document.getElementById('sws-f-hf-enabled').checked;
      document.getElementById('sws-hf-body').classList.toggle('open', checked);
      document.getElementById('sws-hf-arrow').textContent = checked ? '▼' : '▶';
    });

    // ControlNet image
    document.getElementById('sws-f-cn-file').addEventListener('change', e => {
      const file = e.target.files[0]; if (!file) return;
      const reader = new FileReader();
      reader.onload = ev => {
        Scheduler._cnImage = ev.target.result;
        document.getElementById('sws-f-cn-imgurl').value = file.name;
        document.getElementById('sws-cn-preview').src = ev.target.result;
        document.getElementById('sws-cn-preview').classList.add('show');
      };
      reader.readAsDataURL(file);
    });

    // Preset modal
    document.getElementById('sws-preset-close').addEventListener('click', closePresetPicker);
    document.getElementById('sws-preset-search').addEventListener('input', e => renderPresetList(e.target.value));

    // Lightbox
    document.getElementById('sws-lb').addEventListener('click', () => {
      document.getElementById('sws-lb').classList.remove('open');
    });

    // Keyboard: Escape closes ctx menu / lightbox, arrows navigate lightbox
    document.addEventListener('keydown', e => {
      const lb = document.getElementById('sws-lb');
      if (lb.classList.contains('open')) {
        if (e.key === 'ArrowRight') { e.preventDefault(); lbNavigate(1); }
        else if (e.key === 'ArrowLeft') { e.preventDefault(); lbNavigate(-1); }
        else if (e.key === 'Escape') lb.classList.remove('open');
        return;
      }
      if (e.key === 'Escape') closeGalCtx();
    });
    document.getElementById('sws-gallery').addEventListener('scroll', closeGalCtx);

    // Close modals on overlay click
    document.getElementById('sws-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('sws-modal')) closeModal();
    });
    document.getElementById('sws-preset-modal').addEventListener('click', e => {
      if (e.target === document.getElementById('sws-preset-modal')) closePresetPicker();
    });
  }

  function onShow() {
    if (!S.connected && API.session) {
      // Main app already has a session — load models if not done
      connect();
    } else if (!S.connected) {
      // Will connect when user clicks the connect button
    }
  }

  // ── Public API (exposed on window.Scheduler) ─────────────────────────────────
  function getLastPrompts() {
    // Return prompts from the modal if open, else from first enabled task
    const formPrompt = document.getElementById('sws-f-prompt')?.value?.trim();
    if (formPrompt) return {
      prompt:   formPrompt,
      negative: document.getElementById('sws-f-neg')?.value || ''
    };
    const task = S.tasks.find(t => t.enabled) || S.tasks[0];
    return task ? { prompt: task.prompt || '', negative: task.negative || '' } : null;
  }

  function openModalWith(data) {
    populateModels();
    populateCNModels();
    document.getElementById('sws-edit-id').value = '';
    document.getElementById('sws-modal-title').textContent = 'Add Task';
    document.getElementById('sws-f-group').value   = data.group   || '';
    document.getElementById('sws-f-name').value    = data.name    || `Task ${S.tasks.length + 1}`;
    document.getElementById('sws-f-prompt').value  = data.prompt  || '';
    document.getElementById('sws-f-neg').value     = data.negative|| '';
    document.getElementById('sws-f-steps').value   = data.steps   || 20;
    document.getElementById('sws-f-cfg').value     = data.cfg     || 7;
    document.getElementById('sws-f-count').value   = data.count   || 4;
    document.getElementById('sws-f-seed').value    = data.seed    ?? -1;
    document.getElementById('sws-f-sampler').value = data.sampler || '';
    document.getElementById('sws-f-w').value       = data.width   || 1024;
    document.getElementById('sws-f-h').value       = data.height  || 1024;
    if (data.model) setTimeout(() => { document.getElementById('sws-f-model').value = data.model; }, 100);
    if (data.ratio) document.getElementById('sws-f-ratio').value = data.ratio;
    // Reset CN to defaults
    document.getElementById('sws-f-cn-enabled').checked = false;
    document.getElementById('sws-cn-body').classList.remove('open');
    document.getElementById('sws-cn-arrow').textContent = '▶';
    Scheduler._cnImage = null;
    // Apply HiresFix from data (or reset to defaults)
    const hf = data.hiresfix || {};
    document.getElementById('sws-f-hf-enabled').checked = !!hf.enabled;
    document.getElementById('sws-hf-body').classList.toggle('open', !!hf.enabled);
    document.getElementById('sws-hf-arrow').textContent = hf.enabled ? '▼' : '▶';
    if (hf.method) document.getElementById('sws-f-hf-method').value = hf.method;
    if (hf.scale)  document.getElementById('sws-f-hf-scale').value  = hf.scale;
    if (hf.pct)    document.getElementById('sws-f-hf-pct').value    = hf.pct;
    if (hf.steps)  document.getElementById('sws-f-hf-steps').value  = hf.steps;
    if (hf.cfg)    document.getElementById('sws-f-hf-cfg').value    = hf.cfg;
    onRatioChange();
    document.getElementById('sws-modal').classList.add('open');
    setTimeout(() => document.getElementById('sws-f-name').focus(), 50);
  }

  return {
    init,
    onShow,
    getLastPrompts,
    openModalWith,
    // Called from inline onclick handlers in rendered HTML
    _openModal:    id => openModal(id),
    _dup:          id => dupTask(id),
    _move:         (id, dir) => moveTask(id, dir),
    _reset:        id => resetStatus(id),
    _delete:       id => deleteTask(id),
    _toggleTask:   id => toggleTask(id),
    _toggleGroup:  g  => {
      if (S.collapsedGroups.has(g)) S.collapsedGroups.delete(g);
      else S.collapsedGroups.add(g);
      render();
    },
    _applyPreset:  idx => applyPreset(idx),
    _filteredPresets: null,
    _cnImage: null,
  };
})();
