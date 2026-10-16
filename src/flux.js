// ── Edit tab (module « Flux ») ─────────────────────────────────────────────────
// Édition d'image uniquement : Flux.2 Klein / Flux.2 Dev, Flux.1 Kontext, Qwen Image Edit.
// Les images partent en `promptimages` (data URLs jointes par « | ») : SwarmUI construit lui-même
// le workflow d'édition (VAEEncode → ReferenceLatent par image, encodage texte+image pour Qwen).
// Réutilise le même flux WebSocket que Txt2Img (API.generate) — voir src/api.js.
const Flux = (() => {
  const q = id => document.getElementById(id);

  const S = {
    initialized: false,
    running:     false,
    models:      [], // [{name, title, architecture, compat_class}] — modèles d'édition uniquement
    lastModel:   null, // réglages par défaut réappliqués seulement quand le modèle change
    loras:       [], // [{id, model, weight}] — LoRA actifs de cet onglet
    loraSeq:     0,
    editImages:  [], // [{url, w, h}] — image 1 = à éditer, suivantes = références
    mask:        null, // canvas à la taille de l'image 1 : traits rouges = zone à modifier
  };
  const EDIT_IMAGES_MAX = 4;

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  // ── Familles de modèles d'édition ───────────────────────────────────────────
  // Architectures SwarmUI : flux.2-klein-4b/9b, flux.2-dev, Flux.1-dev/kontext, qwen-image-edit(-plus)
  // Réglages : docs/Model Support.md de SwarmUI + workflow Flux.2 Klein Image Edit (Civitai).
  const VARIANTS = {
    klein:        { badge: '✏️ Flux.2 Klein (distillé)', steps: 4,  cfg: 1, guidance: null, scheduler: 'flux2',
                    hint: 'Rapide : 4 à 8 steps, CFG 1.' },
    'klein-base': { badge: '✏️ Flux.2 Klein Base',       steps: 30, cfg: 5, guidance: null, scheduler: 'flux2',
                    hint: 'Version non distillée : beaucoup de steps et un vrai CFG (le negative prompt marche).' },
    flux2:        { badge: '✏️ Flux.2 Dev',              steps: 20, cfg: 1, guidance: 4,    scheduler: 'flux2',
                    hint: "Jusqu'à 6 images de référence chez SwarmUI, mais ça consomme beaucoup de mémoire." },
    kontext:      { badge: '✏️ Flux.1 Kontext',          steps: 20, cfg: 1, guidance: 2.5,  scheduler: 'simple',
                    hint: 'Garde le même ratio entre ton image et la sortie. Plusieurs images marchent, mais en qualité limitée.' },
    qwen:         { badge: '✏️ Qwen Image Edit',         steps: 20, cfg: 1, guidance: null, scheduler: null, shift: 3,
                    hint: 'CFG 1 obligatoire. 3 images max conseillées. Dans le prompt : « the woman in Picture 1 », « the outfit from Picture 2 ». Avec un LoRA Lightning : 8 steps (ou 4).' },
  };

  function variantOf(model) {
    const a = (model?.architecture || '').toLowerCase();
    // Klein « base » (non distillé) a la même architecture que le distillé : seul le nom les distingue
    if (a.startsWith('flux.2-klein')) return /base/i.test(model.name) ? 'klein-base' : 'klein';
    if (a.startsWith('flux.2')) return 'flux2';
    if (a.includes('kontext')) return 'kontext';
    if (a.startsWith('qwen-image-edit')) return 'qwen';
    return null;
  }

  function setSchedulerIfAvailable(name) {
    const sel = q('flux-sel-scheduler');
    if (name && [...sel.options].some(o => o.value === name)) sel.value = name;
  }

  function currentModel() {
    const name = q('flux-sel-model').value;
    return S.models.find(f => f.name === name) || null;
  }

  function currentVariant() {
    return VARIANTS[variantOf(currentModel())] || null;
  }

  function applyVariantDefaults() {
    const model = currentModel();
    const v     = currentVariant();
    const badge = q('flux-variant-badge');
    q('flux-variant-hint').textContent = v?.hint || '';
    if (!v) { badge.style.display = 'none'; return; }
    badge.style.display = '';
    badge.textContent   = v.badge;
    q('flux-guidance-field').style.display = v.guidance ? '' : 'none';
    q('flux-shift-field').style.display    = v.shift ? '' : 'none';
    // Ne pas écraser les réglages de l'utilisateur à chaque retour sur l'onglet
    if (model.name === S.lastModel) return;
    S.lastModel = model.name;
    setSliderValue('flux-sl-steps', 'flux-inp-steps', 'flux-lbl-steps', v.steps, 0);
    setSliderValue('flux-sl-cfg',   'flux-inp-cfg',   'flux-lbl-cfg',   v.cfg, 1);
    if (v.guidance) setSliderValue('flux-sl-guidance', 'flux-inp-guidance', 'flux-lbl-guidance', v.guidance, 1);
    if (v.shift)    setSliderValue('flux-sl-shift',    'flux-inp-shift',    'flux-lbl-shift',    v.shift, 2);
    setSchedulerIfAvailable(v.scheduler || 'simple');
  }

  // ── Modèles ────────────────────────────────────────────────────────────────
  async function loadModels() {
    const sel = q('flux-sel-model');
    try {
      const d = await API.listModels();
      const files = (d.files || []).filter(f => variantOf(f));
      S.models = files;
      if (!files.length) {
        sel.innerHTML = '<option value="">— Aucun modèle d\'édition trouvé (voir « Modèles à installer ») —</option>';
        applyVariantDefaults();
        return;
      }
      const cur = sel.value || localStorage.getItem('flux-model');
      sel.innerHTML = files.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
      if (cur && files.some(f => f.name === cur)) sel.value = cur;
      applyVariantDefaults();
      refreshFluxLoraSelects();
    } catch (e) {
      sel.innerHTML = '<option value="">— Connect first —</option>';
      console.warn('[Edit] loadModels:', e);
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
        const cur = sel.value || 'euler';
        sel.innerHTML = samplerParam.values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
      }
      if (schedulerParam?.values) {
        const sel = q('flux-sel-scheduler');
        const cur = sel.value;
        sel.innerHTML = schedulerParam.values.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
        // Peut arriver après loadModels() : garder le choix courant, sinon celui de la variante
        if (cur && [...sel.options].some(o => o.value === cur)) sel.value = cur;
        else setSchedulerIfAvailable(currentVariant()?.scheduler || 'simple');
      }
    } catch (e) { console.warn('[Edit] loadSamplers:', e); }
  }

  // ── LoRAs ──────────────────────────────────────────────────────────────────
  // Liste globale App.loraModels (chargée à la connexion par app.js). Classes
  // flux-lora-* distinctes de .lora-sel : app.js repeuple toute .lora-sel avec la
  // liste non filtrée, ce qui écraserait le filtre d'ici.
  // Un LoRA n'est compatible qu'avec sa famille (SwarmUI compat_class : flux-2-klein-4b, qwen-image, …)
  function isCompatLora(f) {
    const cls = currentModel()?.compat_class;
    return !!cls && f.compat_class === cls;
  }

  function loraChoices() {
    const all = App.loraModels || [];
    return q('flux-chk-all-loras').checked ? all : all.filter(isCompatLora);
  }

  function updateLoraHint() {
    const all = App.loraModels || [];
    const n = all.filter(isCompatLora).length;
    q('flux-lora-hint').textContent = all.length
      ? `${n} LoRA compatible${n > 1 ? 's' : ''} avec ce modèle sur ${all.length}`
      : 'Aucun LoRA chargé (connecte-toi puis ↻)';
  }

  function populateLoraSelect(sel) {
    const cur = sel.value;
    const choices = loraChoices();
    sel.innerHTML = (choices.length
      ? '<option value="">— Select LoRA —</option>'
      : '<option value="">— Aucun LoRA compatible détecté (coche « Montrer tous ») —</option>') +
      choices.map(f => {
        const label = f.title && f.title !== f.name ? `${f.name} — ${f.title}` : f.name;
        return `<option value="${esc(f.name)}">${esc(label)}</option>`;
      }).join('');
    if (cur) sel.value = cur;
  }

  function refreshFluxLoraSelects() {
    updateLoraHint();
    document.querySelectorAll('#flux-lora-list .flux-lora-sel').forEach(populateLoraSelect);
  }

  // LoRA « Lightning » (ex. Qwen-Image-Edit-2511-Lightning-8steps) : passe les steps au nombre prévu
  function applyLightningSteps(name) {
    if (!/lightning|turbo|hyper/i.test(name)) return;
    const m = name.match(/(\d+)\s*-?\s*steps?/i);
    if (!m) return;
    setSliderValue('flux-sl-steps', 'flux-inp-steps', 'flux-lbl-steps', +m[1], 0);
    setSliderValue('flux-sl-cfg',   'flux-inp-cfg',   'flux-lbl-cfg',   1, 1);
    toast(`⚡ LoRA ${m[1]} steps : Steps = ${m[1]}, CFG = 1`);
  }

  function addFluxLora() {
    const item = { id: ++S.loraSeq, model: '', weight: 1 };
    S.loras.push(item);
    const div = document.createElement('div');
    div.className = 'lora-item';
    div.innerHTML = `
      <div class="lora-item-top">
        <select class="inp flux-lora-sel"></select>
        <button class="btn-remove" title="Remove">✕</button>
      </div>
      <div class="slider-row">
        <input type="range" class="slider flux-lora-w-sl" min="0" max="2" step="0.05" value="1">
        <input type="text" class="inp flux-lora-w-inp" value="1" style="width:55px;text-align:center">
      </div>`;
    q('flux-lora-list').appendChild(div);

    const sel = div.querySelector('.flux-lora-sel');
    populateLoraSelect(sel);
    sel.addEventListener('change', () => { item.model = sel.value; applyLightningSteps(sel.value); });

    const sl  = div.querySelector('.flux-lora-w-sl');
    const inp = div.querySelector('.flux-lora-w-inp');
    sl.addEventListener('input', () => { inp.value = sl.value; item.weight = +sl.value; });
    inp.addEventListener('change', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v)) { sl.value = v; item.weight = v; }
    });
    div.querySelector('.btn-remove').addEventListener('click', () => {
      S.loras = S.loras.filter(x => x.id !== item.id);
      div.remove();
    });
  }

  async function reloadFluxLoras() {
    if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
    const btn = q('flux-btn-reload-loras');
    btn.style.opacity = '0.4';
    btn.style.pointerEvents = 'none';
    try {
      await API.triggerRefresh(true);
      const count = await loadLoRAs();
      refreshFluxLoraSelects();
      await loadModels();
      toast(`✅ ${count} LoRA${count !== 1 ? 's' : ''} chargé${count !== 1 ? 's' : ''}`);
    } catch (e) {
      showErrorToast(`Reload LoRAs: ${e.message}`);
    } finally {
      btn.style.opacity = '';
      btn.style.pointerEvents = '';
    }
  }

  // ── Images à éditer ─────────────────────────────────────────────────────────
  function renderEditImages() {
    const list = q('flux-editimg-list');
    list.innerHTML = '';
    S.editImages.forEach((img, i) => {
      const el = document.createElement('div');
      el.className = 'refimg-item';
      el.innerHTML = '<img alt=""><span class="refimg-n"></span><button type="button" class="refimg-del" title="Retirer">✕</button>';
      el.querySelector('img').src = img.url;
      el.querySelector('.refimg-n').textContent = i === 0 ? (S.mask ? '1 · masque' : '1 · à éditer') : `${i + 1} · réf.`;
      el.querySelector('.refimg-del').addEventListener('click', () => {
        if (i === 0) S.mask = null;
        S.editImages.splice(i, 1);
        renderEditImages();
        applyEditImageSize();
      });
      if (i === 0) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'refimg-mask' + (S.mask ? ' active' : '');
        btn.title = 'Dessiner un masque : seule la zone peinte sera modifiée';
        btn.textContent = '🎭';
        btn.addEventListener('click', openMaskEditor);
        el.appendChild(btn);
      }
      list.appendChild(el);
    });
    q('flux-editimg-empty').style.display = S.editImages.length ? 'none' : '';
    q('flux-mask-opts').style.display = S.mask ? '' : 'none';
  }

  // Même règle que le workflow Klein Edit (ImageScaleToTotalPixels 1 MP) : ratio de l'image 1, ~1024², multiple de 16
  function editImageSize() {
    const img = S.editImages[0];
    if (!img || !q('flux-chk-editimg-size').checked) return null;
    const scale = Math.sqrt((1024 * 1024) / (img.w * img.h));
    return { w: Math.round(img.w * scale / 16) * 16, h: Math.round(img.h * scale / 16) * 16 };
  }

  function applyEditImageSize() {
    const size = editImageSize();
    if (!size) return;
    q('flux-inp-width').value  = size.w;
    q('flux-inp-height').value = size.h;
    document.querySelectorAll('#sec-flux-resolution .ratio-btn').forEach(b => b.classList.remove('active'));
  }

  function imageFromDataUrl(url) {
    return new Promise(resolve => {
      const im = new Image();
      im.onload  = () => resolve({ url, w: im.naturalWidth, h: im.naturalHeight });
      im.onerror = () => resolve(null);
      im.src = url;
    });
  }

  function blobToDataUrl(blob) {
    return new Promise(resolve => {
      const r = new FileReader();
      r.onload  = () => resolve(r.result);
      r.onerror = () => resolve(null);
      r.readAsDataURL(blob);
    });
  }

  async function readEditImage(blob) {
    const url = await blobToDataUrl(blob);
    return url ? imageFromDataUrl(url) : null;
  }

  async function addEditImages(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    const room = EDIT_IMAGES_MAX - S.editImages.length;
    if (files.length > room) toast(`${EDIT_IMAGES_MAX} images maximum`);
    const loaded = (await Promise.all(files.slice(0, Math.max(0, room)).map(readEditImage))).filter(Boolean);
    S.editImages.push(...loaded);
    renderEditImages();
    applyEditImageSize();
  }

  // Depuis une galerie (Txt2Img, résultat d'édition…) : devient l'image à éditer, les références restent
  async function loadFromSrc(src) {
    try {
      const url = src.startsWith('data:') ? src : await blobToDataUrl(await (await fetch(src)).blob());
      const img = url && await imageFromDataUrl(url);
      if (!img) throw new Error('image illisible');
      if (S.editImages.length) S.editImages[0] = img;
      else S.editImages.push(img);
      S.mask = null;   // le masque appartenait à l'ancienne image
      renderEditImages();
      applyEditImageSize();
    } catch (e) {
      showErrorToast(`Impossible de charger l'image : ${e.message}`);
    }
  }

  // ── Masque (zone à modifier) ────────────────────────────────────────────────
  // Envoyé à SwarmUI comme Init Image (= image 1) + Mask Image : seule la zone blanche est régénérée,
  // et « Init Image Recomposite Mask » (actif par défaut) recolle le reste de l'original au pixel près.
  // Le modèle voit toujours l'image entière via les promptimages.
  const M = { img: null, layer: null, undo: [], erase: false, drawing: false, last: null };
  const MASK_UNDO_MAX = 10;

  function openMaskEditor() {
    const src = S.editImages[0];
    if (!src) return;
    const img = new Image();
    img.onload = () => {
      M.img = img;
      M.layer = document.createElement('canvas');
      M.layer.width = img.naturalWidth;
      M.layer.height = img.naturalHeight;
      if (S.mask) M.layer.getContext('2d').drawImage(S.mask, 0, 0);
      M.undo = [];
      q('flux-mask-modal').classList.add('open');
      fitMaskCanvas();
    };
    img.src = src.url;
  }

  function closeMaskEditor() {
    q('flux-mask-modal').classList.remove('open');
    M.img = M.layer = null;
    M.undo = [];
  }

  // Le canvas affiché tient dans la fenêtre ; le calque du masque reste à la taille réelle de l'image
  function fitMaskCanvas() {
    const cv = q('flux-mask-canvas');
    const stage = q('flux-mask-stage');
    const maxW = stage.clientWidth || 800, maxH = window.innerHeight * 0.68;
    const scale = Math.min(maxW / M.img.naturalWidth, maxH / M.img.naturalHeight, 1);
    cv.width  = Math.round(M.img.naturalWidth * scale);
    cv.height = Math.round(M.img.naturalHeight * scale);
    drawMaskCanvas();
  }

  function drawMaskCanvas() {
    const cv = q('flux-mask-canvas');
    const ctx = cv.getContext('2d');
    ctx.globalAlpha = 1;
    ctx.drawImage(M.img, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 0.5;
    ctx.drawImage(M.layer, 0, 0, cv.width, cv.height);
    ctx.globalAlpha = 1;
  }

  function maskPoint(e) {
    const cv = q('flux-mask-canvas');
    const r = cv.getBoundingClientRect();
    return { x: (e.clientX - r.left) * M.layer.width / r.width, y: (e.clientY - r.top) * M.layer.height / r.height };
  }

  function maskStroke(from, to) {
    const ctx = M.layer.getContext('2d');
    const cv = q('flux-mask-canvas');
    ctx.globalCompositeOperation = M.erase ? 'destination-out' : 'source-over';
    ctx.strokeStyle = '#ff3b3b';
    ctx.lineWidth = +q('flux-mask-size').value * M.layer.width / cv.width;
    ctx.lineCap = ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
    ctx.globalCompositeOperation = 'source-over';
    drawMaskCanvas();
  }

  function maskIsEmpty(layer) {
    const d = layer.getContext('2d').getImageData(0, 0, layer.width, layer.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }

  // SwarmUI : blanc = modifié, noir = gardé
  function maskDataUrl() {
    const out = document.createElement('canvas');
    out.width = S.mask.width;
    out.height = S.mask.height;
    const ctx = out.getContext('2d');
    ctx.drawImage(S.mask, 0, 0);
    ctx.globalCompositeOperation = 'source-in';
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.globalCompositeOperation = 'destination-over';
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }

  function setMaskTool(erase) {
    M.erase = erase;
    q('flux-mask-brush').classList.toggle('active', !erase);
    q('flux-mask-eraser').classList.toggle('active', erase);
  }

  function bindMaskEditor() {
    const cv = q('flux-mask-canvas');
    cv.addEventListener('pointerdown', e => {
      if (!M.layer) return;
      cv.setPointerCapture(e.pointerId);
      M.undo.push(M.layer.getContext('2d').getImageData(0, 0, M.layer.width, M.layer.height));
      if (M.undo.length > MASK_UNDO_MAX) M.undo.shift();
      M.drawing = true;
      M.last = maskPoint(e);
      maskStroke(M.last, M.last);
    });
    cv.addEventListener('pointermove', e => {
      if (!M.drawing) return;
      const p = maskPoint(e);
      maskStroke(M.last, p);
      M.last = p;
    });
    ['pointerup', 'pointercancel'].forEach(ev => cv.addEventListener(ev, () => { M.drawing = false; }));

    q('flux-mask-brush').addEventListener('click', () => setMaskTool(false));
    q('flux-mask-eraser').addEventListener('click', () => setMaskTool(true));
    q('flux-mask-size').addEventListener('input', () => { q('flux-mask-size-val').textContent = q('flux-mask-size').value; });
    q('flux-mask-undo').addEventListener('click', () => {
      const prev = M.undo.pop();
      if (prev) { M.layer.getContext('2d').putImageData(prev, 0, 0); drawMaskCanvas(); }
    });
    q('flux-mask-clear').addEventListener('click', () => {
      M.undo.push(M.layer.getContext('2d').getImageData(0, 0, M.layer.width, M.layer.height));
      M.layer.getContext('2d').clearRect(0, 0, M.layer.width, M.layer.height);
      drawMaskCanvas();
    });
    q('flux-mask-ok').addEventListener('click', () => {
      S.mask = maskIsEmpty(M.layer) ? null : M.layer;
      closeMaskEditor();
      renderEditImages();
    });
    q('flux-mask-remove').addEventListener('click', () => {
      S.mask = null;
      closeMaskEditor();
      renderEditImages();
    });
    q('flux-mask-close').addEventListener('click', closeMaskEditor);
    window.addEventListener('resize', () => { if (M.img) fitMaskCanvas(); });
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
    q('flux-btn-generate').textContent = 'Edit';
    q('flux-btn-generate').classList.remove('running');
    setTimeout(() => {
      q('flux-progress-wrap').classList.add('hidden');
      setProgress(0, '');
    }, 1200);
  }

  // Requête complète d'édition (utilisée par Edit et par la file du Scheduler) ; null si incomplet
  function buildPayload() {
    const model = currentModel();
    const v = currentVariant();
    if (!model || !v) { showErrorToast('Sélectionne un modèle d\'édition d\'abord'); return null; }
    if (!S.editImages.length) { showErrorToast('Ajoute d\'abord l\'image à éditer'); return null; }
    const prompt = q('flux-inp-positive').value.trim();
    if (!prompt) { showErrorToast('Décris la modification à faire'); return null; }
    localStorage.setItem('flux-model', model.name);

    const size = editImageSize();
    const loraSuffix = S.loras
      .filter(l => l.model)
      .map(l => `<lora:${l.model}:${l.weight}>`)
      .join(' ');
    const payload = {
      prompt: prompt + (loraSuffix ? ' ' + loraSuffix : ''),
      negativeprompt: q('flux-inp-negative').value.trim(),
      images:         parseInt(q('flux-sel-count').value) || 1,
      model:          model.name,
      width:          size?.w || parseInt(q('flux-inp-width').value)  || 1024,
      height:         size?.h || parseInt(q('flux-inp-height').value) || 1024,
      steps:          parseInt(q('flux-inp-steps').value)  || v.steps,
      cfgscale:       parseFloat(q('flux-inp-cfg').value)  || v.cfg,
      sampler:        q('flux-sel-sampler').value   || undefined,
      scheduler:      q('flux-sel-scheduler').value || undefined,
      seed:           -1,
      promptimages:   S.editImages.map(i => i.url).join('|'),
    };
    if (v.guidance) payload.fluxguidancescale = parseFloat(q('flux-inp-guidance').value) || v.guidance;
    if (v.shift)    payload.sigmashift        = parseFloat(q('flux-inp-shift').value)    || v.shift;
    if (S.mask) {
      payload.initimage           = S.editImages[0].url;
      payload.maskimage           = maskDataUrl();
      payload.initimagecreativity = parseFloat(q('flux-inp-maskcreat').value) || 1;
    }
    return payload;
  }

  // ── File du Scheduler : capturer / rouvrir les réglages complets d'Edit ─────
  function capture() {
    const payload = buildPayload();
    if (!payload) return null;
    return {
      payload,
      state: {
        model: q('flux-sel-model').value,
        prompt: q('flux-inp-positive').value, negative: q('flux-inp-negative').value,
        images: S.editImages.map(i => ({ ...i })),
        maskLayer: S.mask ? S.mask.toDataURL('image/png') : null,
        maskCreat: q('flux-inp-maskcreat').value,
        steps: q('flux-inp-steps').value, cfg: q('flux-inp-cfg').value,
        guidance: q('flux-inp-guidance').value, shift: q('flux-inp-shift').value,
        sampler: q('flux-sel-sampler').value, scheduler: q('flux-sel-scheduler').value,
        count: q('flux-sel-count').value,
        autoSize: q('flux-chk-editimg-size').checked,
        width: q('flux-inp-width').value, height: q('flux-inp-height').value,
        loras: S.loras.filter(l => l.model).map(l => ({ model: l.model, weight: l.weight })),
      },
    };
  }

  async function restore(st) {
    init();
    // La liste des modèles n'est chargée qu'à la 1re ouverture de l'onglet : sans elle, le modèle de la tâche serait perdu
    if (!S.models.length && App.connected) await loadModels();
    if ([...q('flux-sel-model').options].some(o => o.value === st.model)) {
      q('flux-sel-model').value = st.model;
      S.lastModel = st.model;              // ne pas écraser les réglages de la tâche par les défauts du modèle
      applyVariantDefaults();
    }
    q('flux-inp-positive').value = st.prompt || '';
    q('flux-inp-negative').value = st.negative || '';
    S.editImages = (st.images || []).map(i => ({ ...i }));
    S.mask = null;
    if (st.maskLayer) {
      const tmp = new Image();
      await new Promise(r => { tmp.onload = r; tmp.onerror = r; tmp.src = st.maskLayer; });
      if (tmp.naturalWidth) {
        const c = document.createElement('canvas');
        c.width = tmp.naturalWidth; c.height = tmp.naturalHeight;
        c.getContext('2d').drawImage(tmp, 0, 0);
        S.mask = c;
      }
    }
    setSliderValue('flux-sl-maskcreat', 'flux-inp-maskcreat', 'flux-lbl-maskcreat', st.maskCreat ?? 1, 2);
    setSliderValue('flux-sl-steps', 'flux-inp-steps', 'flux-lbl-steps', st.steps ?? 4, 0);
    setSliderValue('flux-sl-cfg', 'flux-inp-cfg', 'flux-lbl-cfg', st.cfg ?? 1, 1);
    setSliderValue('flux-sl-guidance', 'flux-inp-guidance', 'flux-lbl-guidance', st.guidance ?? 2.5, 1);
    setSliderValue('flux-sl-shift', 'flux-inp-shift', 'flux-lbl-shift', st.shift ?? 3, 2);
    if (st.sampler)   q('flux-sel-sampler').value   = st.sampler;
    if (st.scheduler) q('flux-sel-scheduler').value = st.scheduler;
    q('flux-chk-editimg-size').checked = st.autoSize !== false;
    q('flux-inp-width').value  = st.width  || 1024;
    q('flux-inp-height').value = st.height || 1024;
    q('flux-lora-list').innerHTML = '';
    S.loras = [];
    (st.loras || []).forEach(l => {
      addFluxLora();
      const item = S.loras[S.loras.length - 1];
      const row  = q('flux-lora-list').lastElementChild;
      item.model = l.model; item.weight = +l.weight || 1;
      const sel = row.querySelector('.flux-lora-sel');
      if (![...sel.options].some(o => o.value === l.model)) sel.insertAdjacentHTML('beforeend', `<option value="${esc(l.model)}">${esc(l.model)}</option>`);
      sel.value = l.model;
      row.querySelector('.flux-lora-w-sl').value  = item.weight;
      row.querySelector('.flux-lora-w-inp').value = item.weight;
    });
    renderEditImages();
    if (st.count) { q('flux-sel-count').value = st.count; q('flux-sel-count').dispatchEvent(new Event('sync')); }
  }

  // Rouvre une tâche de la file dans Edit pour la modifier (bandeau « Mettre à jour la tâche »)
  async function editTask(task) {
    switchTab('flux');
    if (S.editImages.length && !await uiConfirm({
      title: 'Remplacer le contenu d\'Edit ?',
      html: '<p>Les images et réglages actuels d\'Edit seront remplacés par ceux de la tâche.</p>',
      okLabel: 'Ouvrir la tâche',
    })) return;
    await restore(task.state || {});
    S.editingTask = { id: task.id, name: task.name };
    q('flux-task-banner-name').textContent = task.name;
    q('flux-task-banner').hidden = false;
  }

  async function saveEditedTask() {
    if (!S.editingTask) return;
    const cap = capture();
    if (!cap) return;
    const ok = await Scheduler.updateSnapshotTask(S.editingTask.id, cap);
    if (!ok) showErrorToast('Cette tâche n\'existe plus dans la file.');
    else toast(`✅ Tâche « ${S.editingTask.name} » mise à jour`);
    S.editingTask = null;
    q('flux-task-banner').hidden = true;
  }

  async function addToQueue() {
    const cap = capture();
    if (!cap) return;
    const name = 'Edit · ' + taskNameFromPrompt(cap.state.prompt);
    const task = await Scheduler.addSnapshotTask({
      source: 'edit', name, payload: cap.payload, state: cap.state, thumb: cap.state.images[0]?.url || null,
    });
    if (task) toast(`📅 Ajouté à la file : ${task.name}`);
  }

  function startGeneration() {
    if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
    if (S.running) { API.interrupt?.().catch(() => {}); finishGeneration(); return; }
    const payload = buildPayload();
    if (!payload) return;
    const prompt = q('flux-inp-positive').value.trim();

    S.running = true;
    q('flux-btn-generate').textContent = 'Stop';
    q('flux-btn-generate').classList.add('running');
    q('flux-progress-wrap').classList.remove('hidden');
    setProgress(0, 'Starting…');

    const groupLabel = new Date().toLocaleTimeString();

    API.generate(payload, {
      onProgress(status, pct) {
        const label = typeof status === 'string' ? status : (status?.title || status?.stage || 'Editing…');
        const displayPct = pct > 0 ? pct : (status?.cur_step && status?.total_steps
          ? status.cur_step / status.total_steps : null);
        if (displayPct !== null) setProgress(displayPct, label);
        else q('flux-progress-label').textContent = label;
      },
      onPreview() { /* pas d'aperçu live dans cette version simplifiée */ },
      onImage(imgData, metadata) {
        let src;
        if (typeof imgData === 'string' && imgData.startsWith('data:'))      src = imgData;
        else if (typeof imgData === 'string' && imgData.startsWith('http')) src = imgData;
        else src = `${API.origin}/${imgData}`;
        addToGallery({ url: src, seed: seedFromMetadata(metadata, payload.seed), prompt }, groupLabel);
      },
      onDone() {
        finishGeneration();
      },
      onError(err) {
        console.error('[Edit] Generation error:', err);
        finishGeneration();
        const needsGguf = /does not have that model/i.test(String(err)) && /\.gguf/i.test(String(err));
        showErrorToast(needsGguf
          ? `${err}\n\nSupport GGUF pas installé côté SwarmUI : lance une génération avec ce modèle depuis l'interface web de SwarmUI, accepte le popup "GGUF" (installe ComfyUI-GGUF et redémarre le backend), puis réessaie ici.`
          : err);
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
      lbl.textContent = `${groupLabel} — ${img.prompt}`;
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
      <img src="${esc(img.url)}" alt="Edited image" loading="lazy">
      <div class="gallery-img-actions">
        <button class="gal-btn" data-action="reedit"    title="Continuer à éditer cette image (devient l'image 1)">✏️</button>
        <button class="gal-btn" data-action="inpaint"   title="Inpaint">🖌</button>
        <button class="gal-btn" data-action="watermark" title="Send to Watermark">💧</button>
        <button class="gal-btn" data-action="comic"     title="Send to Comic">🎬</button>
        <button class="gal-btn" data-action="info"      title="Image info">ℹ</button>
        <button class="gal-btn" data-action="copy"      title="Copy image (Discord, etc.)">📋</button>
        <button class="gal-btn" data-action="save"      title="Save image">💾</button>
      </div>`;

    div.querySelector('[data-action="reedit"]').addEventListener('click', e => { e.stopPropagation(); loadFromSrc(img.url); toast('✏️ Image 1 remplacée par ce résultat'); });
    div.querySelector('[data-action="inpaint"]').addEventListener('click', e => { e.stopPropagation(); sendToInpaint(img.url); });
    div.querySelector('[data-action="watermark"]').addEventListener('click', e => { e.stopPropagation(); sendToWatermark(img.url); });
    div.querySelector('[data-action="comic"]').addEventListener('click', e => { e.stopPropagation(); sendToComic(img.url); });
    div.querySelector('[data-action="info"]').addEventListener('click', e => { e.stopPropagation(); showPngInfo(img.url); });
    div.querySelector('[data-action="copy"]').addEventListener('click', e => { e.stopPropagation(); copyImageToClipboard(img.url); });
    div.querySelector('[data-action="save"]').addEventListener('click', e => {
      e.stopPropagation();
      const a = document.createElement('a');
      a.href = img.url;
      a.download = `edit-${Date.now()}.png`;
      a.click();
    });

    div.addEventListener('click', () => openLightbox(img.url, 'flux-gallery'));
    row.appendChild(div);
  }

  // ── UI binding ─────────────────────────────────────────────────────────────
  function bindUI() {
    q('flux-sel-model').addEventListener('change', () => { applyVariantDefaults(); refreshFluxLoraSelects(); });
    q('flux-btn-generate').addEventListener('click', startGeneration);
    q('flux-btn-queue-add').addEventListener('click', addToQueue);
    q('flux-task-save').addEventListener('click', saveEditedTask);
    q('flux-task-cancel').addEventListener('click', () => { S.editingTask = null; q('flux-task-banner').hidden = true; });
    q('flux-btn-add-lora').addEventListener('click', addFluxLora);
    q('flux-btn-reload-loras').addEventListener('click', reloadFluxLoras);
    q('flux-chk-all-loras').addEventListener('change', refreshFluxLoraSelects);

    q('flux-editimg-add').addEventListener('click', () => q('flux-editimg-file').click());
    q('flux-editimg-empty').addEventListener('click', () => q('flux-editimg-file').click());

    // Variantes : boutons 1/2/4 + champ « autre », qui pilotent le <select> caché (comme Txt2Img)
    const countSel = q('flux-sel-count'), countCustom = q('flux-inp-count-custom');
    const syncCount = () => {
      const v = countSel.value, custom = !['1', '2', '4'].includes(v);
      document.querySelectorAll('#flux-seg-count button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
      countCustom.classList.toggle('active', custom);
      if (custom) countCustom.value = v;
      else if (document.activeElement !== countCustom) countCustom.value = '';
    };
    const setCount = v => {
      const n = String(Math.max(1, Math.min(16, parseInt(v, 10) || 1)));
      if (!['1', '2', '4'].includes(n)) {
        let opt = countSel.querySelector('option[data-custom]');
        if (!opt) { opt = document.createElement('option'); opt.dataset.custom = '1'; countSel.appendChild(opt); }
        opt.value = opt.textContent = n;
      }
      countSel.value = n;
      syncCount();
    };
    document.querySelectorAll('#flux-seg-count button').forEach(b => b.addEventListener('click', () => { countCustom.value = ''; setCount(b.dataset.v); }));
    countCustom.addEventListener('input', e => { if (parseInt(e.target.value, 10) > 0) setCount(e.target.value); });
    countCustom.addEventListener('change', e => { if (e.target.value !== '') setCount(e.target.value); });
    countCustom.addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
    countSel.addEventListener('sync', () => setCount(countSel.value));   // valeur posée par restore()
    syncCount();
    q('flux-editimg-file').addEventListener('change', e => { addEditImages(e.target.files); e.target.value = ''; });
    q('flux-chk-editimg-size').addEventListener('change', applyEditImageSize);
    ['flux-inp-width', 'flux-inp-height'].forEach(id => q(id).addEventListener('input', () => {
      q('flux-chk-editimg-size').checked = false;   // taille tapée à la main
    }));
    const editBox = q('sec-flux-editimg');
    ['dragover', 'dragenter'].forEach(ev => editBox.addEventListener(ev, e => { e.preventDefault(); editBox.classList.add('dragover'); }));
    ['dragleave', 'drop'].forEach(ev => editBox.addEventListener(ev, () => editBox.classList.remove('dragover')));
    editBox.addEventListener('drop', e => { e.preventDefault(); addEditImages(e.dataTransfer.files); });
    // Ctrl/Cmd+Enter dans le prompt = lancer l'édition
    q('flux-inp-positive').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); startGeneration(); }
    });

    syncSlider('flux-sl-steps',    'flux-inp-steps',    'flux-lbl-steps',    0);
    syncSlider('flux-sl-cfg',      'flux-inp-cfg',      'flux-lbl-cfg',      1);
    syncSlider('flux-sl-guidance', 'flux-inp-guidance', 'flux-lbl-guidance', 1);
    syncSlider('flux-sl-shift',    'flux-inp-shift',    'flux-lbl-shift',    2);
    syncSlider('flux-sl-maskcreat', 'flux-inp-maskcreat', 'flux-lbl-maskcreat', 2);
    bindMaskEditor();

    document.querySelectorAll('#sec-flux-resolution .ratio-btn[data-w]').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('#sec-flux-resolution .ratio-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        q('flux-chk-editimg-size').checked = false;   // taille choisie à la main
        q('flux-inp-width').value  = btn.dataset.w;
        q('flux-inp-height').value = btn.dataset.h;
      });
    });

    // Ouvrir / fermer les cartes : géré pour toutes les colonnes par app.js (.sidebar-section-hdr)
  }

  function init() {
    if (S.initialized) return;
    S.initialized = true;
    bindUI();
    renderEditImages();
  }

  function onShow() {
    if (App.connected) {
      loadModels();
      loadSamplers();
      refreshFluxLoraSelects();
    }
  }

  return { init, onShow, loadFromSrc, capture, restore, addToQueue, editTask };
})();
