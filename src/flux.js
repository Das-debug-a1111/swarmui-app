// ── Flux tab ───────────────────────────────────────────────────────────────────
// Génération Flux.1 (Dev/Schnell) avec les réglages corrects par défaut :
// CFG=1, Flux Guidance Scale dédié (Dev uniquement), Steps adaptés à la variante.
// Réutilise le même flux WebSocket que Txt2Img (API.generate) — voir src/api.js.
const Flux = (() => {
  const q = id => document.getElementById(id);

  const S = {
    initialized: false,
    running:     false,
    models:      [], // [{name, title, architecture}] — filtré Flux.1 uniquement
  };

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Détection de variante ───────────────────────────────────────────────────
  function variantOf(architecture) {
    const a = (architecture || '').toLowerCase();
    if (a.includes('schnell')) return 'schnell';
    if (a.startsWith('flux.1')) return 'dev'; // dev + tools (depth/canny/inpaint/kontext) suivent le même réglage que dev
    return null;
  }

  function currentModel() {
    const name = q('flux-sel-model').value;
    return S.models.find(f => f.name === name) || null;
  }

  function applyVariantDefaults() {
    const model   = currentModel();
    const variant = model ? variantOf(model.architecture) : null;
    const badge   = q('flux-variant-badge');

    if (variant === 'schnell') {
      badge.style.display = '';
      badge.textContent   = '⚡ Schnell';
      setSliderValue('flux-sl-steps', 'flux-inp-steps', 'flux-lbl-steps', 4, 0);
      setSliderValue('flux-sl-cfg',   'flux-inp-cfg',   'flux-lbl-cfg',   1, 1);
      q('flux-guidance-field').style.display = 'none';
    } else if (variant === 'dev') {
      badge.style.display = '';
      badge.textContent   = '🎨 Dev';
      setSliderValue('flux-sl-steps', 'flux-inp-steps', 'flux-lbl-steps', 20, 0);
      setSliderValue('flux-sl-cfg',   'flux-inp-cfg',   'flux-lbl-cfg',   1, 1);
      q('flux-guidance-field').style.display = '';
    } else {
      badge.style.display = 'none';
    }
  }

  // ── Modèles ────────────────────────────────────────────────────────────────
  async function loadModels() {
    const sel = q('flux-sel-model');
    try {
      const d = await API.listModels();
      const files = (d.files || []).filter(f => (f.architecture || '').toLowerCase().startsWith('flux.1'));
      S.models = files;
      if (!files.length) {
        sel.innerHTML = '<option value="">— Aucun modèle Flux.1 trouvé —</option>';
        return;
      }
      const saved = localStorage.getItem('flux-model');
      sel.innerHTML = files.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
      if (saved && files.some(f => f.name === saved)) sel.value = saved;
      applyVariantDefaults();
    } catch (e) {
      sel.innerHTML = '<option value="">— Connect first —</option>';
      console.warn('[Flux] loadModels:', e);
    }
  }

  async function loadSamplers() {
    try {
      const d = await API.listParams();
      const params = d.list || [];
      const samplerParam   = params.find(p => p.id === 'samplername' || p.id === 'sampler');
      const schedulerParam = params.find(p => p.id === 'scheduler');
      if (samplerParam?.values) {
        const sel = q('flux-sel-sampler');
        sel.innerHTML = samplerParam.values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        if ([...sel.options].some(o => o.value === 'euler')) sel.value = 'euler';
      }
      if (schedulerParam?.values) {
        const sel = q('flux-sel-scheduler');
        sel.innerHTML = schedulerParam.values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        if ([...sel.options].some(o => o.value === 'simple')) sel.value = 'simple';
      }
    } catch (e) { console.warn('[Flux] loadSamplers:', e); }
  }

  // ── Sliders liés (range + champ texte) ──────────────────────────────────────
  function syncSlider(slId, inpId, lblId, dec) {
    const sl = q(slId), inp = q(inpId), lbl = lblId ? q(lblId) : null;
    function update(v) {
      sl.value  = v;
      inp.value = (+v).toFixed(dec);
      if (lbl) lbl.textContent = (+v).toFixed(dec);
    }
    sl.addEventListener('input', () => update(sl.value));
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) update(Math.min(Math.max(v, +sl.min), +sl.max));
    });
  }

  function setSliderValue(slId, inpId, lblId, val, dec) {
    q(slId).value  = val;
    q(inpId).value = (+val).toFixed(dec);
    if (lblId) q(lblId).textContent = (+val).toFixed(dec);
  }

  // ── Génération ─────────────────────────────────────────────────────────────
  function setProgress(pct, label) {
    const p = Math.round(pct * 100);
    q('flux-progress-bar').style.width = p + '%';
    q('flux-progress-pct').textContent = p + '%';
    if (label !== undefined) q('flux-progress-label').textContent = label;
  }

  function finishGeneration() {
    if (!S.running) return;
    S.running = false;
    q('flux-btn-generate').textContent = 'Generate';
    q('flux-btn-generate').classList.remove('running');
    setTimeout(() => {
      q('flux-progress-wrap').classList.add('hidden');
      setProgress(0, '');
    }, 1200);
  }

  function startGeneration() {
    if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
    if (S.running) { API.interrupt?.().catch(() => {}); finishGeneration(); return; }

    const prompt = q('flux-inp-positive').value.trim();
    if (!prompt) { alert('Enter a positive prompt first.'); return; }
    const model = currentModel();
    if (!model) { showErrorToast('Sélectionne un modèle Flux.1 d\'abord'); return; }

    localStorage.setItem('flux-model', model.name);

    S.running = true;
    q('flux-btn-generate').textContent = 'Stop';
    q('flux-btn-generate').classList.add('running');
    q('flux-progress-wrap').classList.remove('hidden');
    setProgress(0, 'Starting…');

    const variant = variantOf(model.architecture);
    const payload = {
      prompt,
      negativeprompt: q('flux-inp-negative').value.trim(),
      images:         parseInt(q('flux-sel-count').value) || 1,
      model:          model.name,
      width:          parseInt(q('flux-inp-width').value)  || 1024,
      height:         parseInt(q('flux-inp-height').value) || 1024,
      steps:          parseInt(q('flux-inp-steps').value)  || (variant === 'schnell' ? 4 : 20),
      cfgscale:       parseFloat(q('flux-inp-cfg').value)  || 1,
      sampler:        q('flux-sel-sampler').value   || undefined,
      scheduler:      q('flux-sel-scheduler').value || undefined,
      seed:           -1,
    };
    if (variant === 'dev') {
      payload.fluxguidancescale = parseFloat(q('flux-inp-guidance').value) || 3.5;
    }

    const batchImages = [];
    const groupLabel  = new Date().toLocaleTimeString();

    API.generate(payload, {
      onProgress(status, pct) {
        const label = typeof status === 'string' ? status : (status?.title || status?.stage || 'Generating…');
        const displayPct = pct > 0 ? pct : (status?.cur_step && status?.total_steps
          ? status.cur_step / status.total_steps : null);
        if (displayPct !== null) setProgress(displayPct, label);
        else q('flux-progress-label').textContent = label;
      },
      onPreview() { /* pas d'aperçu live dans cette version simplifiée */ },
      onImage(imgData) {
        let src;
        if (typeof imgData === 'string' && imgData.startsWith('data:'))      src = imgData;
        else if (typeof imgData === 'string' && imgData.startsWith('http')) src = imgData;
        else src = `${API.origin}/${imgData}`;
        const img = { url: src, seed: payload.seed, prompt: payload.prompt };
        batchImages.push(img);
        addToGallery(img, groupLabel, batchImages.length === 1);
      },
      onDone() {
        finishGeneration();
      },
      onError(err) {
        console.error('[Flux] Generation error:', err);
        finishGeneration();
        showErrorToast(err);
      },
    });
  }

  // ── Galerie ────────────────────────────────────────────────────────────────
  function addToGallery(img, groupLabel) {
    const gallery = q('flux-gallery');
    const empty = q('flux-gallery-empty');
    if (empty) empty.remove();

    let row = gallery.querySelector(`.gallery-row[data-group="${CSS.escape(groupLabel)}"]`);
    if (!row) {
      const wrapper = document.createElement('div');
      const lbl = document.createElement('div');
      lbl.className = 'gallery-group-label';
      lbl.textContent = groupLabel;
      row = document.createElement('div');
      row.className = 'gallery-row';
      row.dataset.group = groupLabel;
      wrapper.appendChild(lbl);
      wrapper.appendChild(row);
      gallery.prepend(wrapper);
    }

    const div = document.createElement('div');
    div.className = 'gallery-img';
    div.innerHTML = `
      <img src="${esc(img.url)}" alt="Generated image" loading="lazy">
      <div class="gallery-img-actions">
        <button class="gal-btn" data-action="inpaint"   title="Inpaint">🖌</button>
        <button class="gal-btn" data-action="watermark" title="Send to Watermark">💧</button>
        <button class="gal-btn" data-action="comic"     title="Send to Comic">🎬</button>
        <button class="gal-btn" data-action="schedule"  title="Send to Scheduler">📅</button>
        <button class="gal-btn" data-action="info"      title="Image info">ℹ</button>
        <button class="gal-btn" data-action="copy"      title="Copy image (Discord, etc.)">📋</button>
        <button class="gal-btn" data-action="save"      title="Save image">💾</button>
      </div>`;

    div.querySelector('[data-action="inpaint"]').addEventListener('click', e => { e.stopPropagation(); sendToInpaint(img.url); });
    div.querySelector('[data-action="watermark"]').addEventListener('click', e => { e.stopPropagation(); sendToWatermark(img.url); });
    div.querySelector('[data-action="comic"]').addEventListener('click', e => { e.stopPropagation(); sendToComic(img.url); });
    div.querySelector('[data-action="schedule"]').addEventListener('click', e => { e.stopPropagation(); sendToScheduler(img.seed); });
    div.querySelector('[data-action="info"]').addEventListener('click', e => { e.stopPropagation(); showPngInfo(img.url); });
    div.querySelector('[data-action="copy"]').addEventListener('click', e => { e.stopPropagation(); copyImageToClipboard(img.url); });
    div.querySelector('[data-action="save"]').addEventListener('click', e => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = img.url;
      a.download = `flux-${Date.now()}.png`;
      a.click();
    });

    row.appendChild(div);
  }

  // ── UI binding ─────────────────────────────────────────────────────────────
  function bindUI() {
    q('flux-sel-model').addEventListener('change', applyVariantDefaults);
    q('flux-btn-generate').addEventListener('click', startGeneration);

    syncSlider('flux-sl-steps',    'flux-inp-steps',    'flux-lbl-steps',    0);
    syncSlider('flux-sl-cfg',      'flux-inp-cfg',      'flux-lbl-cfg',      1);
    syncSlider('flux-sl-guidance', 'flux-inp-guidance', 'flux-lbl-guidance', 1);

    document.querySelectorAll('#sec-flux-resolution .ratio-btn[data-w]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sec-flux-resolution .ratio-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        q('flux-inp-width').value  = btn.dataset.w;
        q('flux-inp-height').value = btn.dataset.h;
      });
    });

    document.querySelectorAll('#view-flux .sidebar-section-hdr').forEach(hdr => {
      hdr.addEventListener('click', () => {
        const key  = hdr.dataset.section;
        const body = q('sec-' + key);
        if (!body) return;
        const collapsed = body.classList.toggle('hidden');
        hdr.classList.toggle('collapsed', collapsed);
      });
    });
  }

  function init() {
    if (S.initialized) return;
    S.initialized = true;
    bindUI();
  }

  function onShow() {
    q('flux-btn-generate').disabled = !App.connected;
    if (App.connected) {
      loadModels();
      loadSamplers();
    }
  }

  return { init, onShow };
})();
