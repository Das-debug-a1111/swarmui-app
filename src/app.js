// ── SwarmUI App ───────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
const App = {
  connected:  false,
  running:    false,
  seedLocked: false,
  loraModels: [],   // available LoRA model list
  loraItems:  [],   // active LoRA rows [{id, model, weight}]
  loraIdSeq:  0,
  batchGroups: [],  // [{label, images:[{url, seed, prompt}]}]
};

// ── DOM refs ──────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Status ────────────────────────────────────────────────────────────────────
function setStatus(state, text) {
  const dot  = $('status-dot');
  const span = $('status-text');
  dot.className  = 'status-dot ' + (state || '');
  span.textContent = text;
}

// ── Connect ───────────────────────────────────────────────────────────────────
async function connect() {
  const host = $('host-input').value.trim();
  if (!host) return;
  API.host = host;

  setStatus('connecting', 'Connecting…');
  $('btn-connect').disabled = true;

  try {
    await API.getSession();
    App.connected = true;
    setStatus('connected', 'Connected');
    $('btn-generate').disabled = false;
    await loadAll();
  } catch (e) {
    setStatus('error', 'Error: ' + e.message);
    console.error(e);
  } finally {
    $('btn-connect').disabled = false;
  }
}

// ── Load all resources ────────────────────────────────────────────────────────
async function loadAll() {
  await Promise.all([
    loadModels(),
    loadVAEs(),
    loadLoRAs(),
    loadParams(),
    loadRefinerModels(),
    loadCNModels(),
  ]);
}

async function loadCNModels() {
  try {
    const d = await API.listControlNets();
    const files = d.files || [];
    const sel = $('sel-cn-model');
    sel.innerHTML = '<option value="">— Select CN model —</option>' +
      files.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
    const saved = localStorage.getItem('swarm-cn-model');
    if (saved) sel.value = saved;
  } catch (e) { console.warn('loadCNModels:', e); }
}

async function loadRefinerModels() {
  try {
    const d = await API.listModels();
    const files = d.files || [];
    const sel = $('sel-refiner-model');
    sel.innerHTML = '<option value="">— Same as main —</option>' +
      files.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
    const saved = localStorage.getItem('swarm-refiner-model');
    if (saved) sel.value = saved;
  } catch (e) { console.warn('loadRefinerModels:', e); }
}

async function loadModels() {
  try {
    const d = await API.listModels();
    const files = d.files || [];
    const sel = $('sel-model');
    sel.innerHTML = '<option value="">— Select model —</option>' +
      files.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
    // restore last used
    const saved = localStorage.getItem('swarm-model');
    if (saved) sel.value = saved;
  } catch (e) { console.warn('loadModels:', e); }
}

async function loadVAEs() {
  try {
    const d = await API.listVAEs();
    const files = d.files || [];
    const sel = $('sel-vae');
    sel.innerHTML = '<option value="">Auto</option>' +
      files.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
    const saved = localStorage.getItem('swarm-vae');
    if (saved) sel.value = saved;
  } catch (e) { console.warn('loadVAEs:', e); }
}

async function loadLoRAs() {
  try {
    const d = await API.listLoRAs();
    App.loraModels = d.files || [];
    // refresh all lora selects
    document.querySelectorAll('.lora-sel').forEach(sel => populateLoRASelect(sel));
  } catch (e) { console.warn('loadLoRAs:', e); }
}

async function loadParams() {
  try {
    const d = await API.listParams();
    const params = d.list || [];

    const samplerParam   = params.find(p => p.id === 'samplername' || p.id === 'sampler');
    const schedulerParam = params.find(p => p.id === 'scheduler');

    if (samplerParam?.values) {
      const sel = $('sel-sampler');
      const saved = localStorage.getItem('swarm-sampler') || samplerParam.default || '';
      sel.innerHTML = samplerParam.values.map(v =>
        `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(v)}</option>`
      ).join('');
    }
    if (schedulerParam?.values) {
      const sel = $('sel-scheduler');
      const saved = localStorage.getItem('swarm-scheduler') || schedulerParam.default || '';
      sel.innerHTML = schedulerParam.values.map(v =>
        `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(v)}</option>`
      ).join('');
    }

    const upscaleMethodParam = params.find(p => p.id === 'refinerupscalemethod');
    if (upscaleMethodParam?.values) {
      const sel = $('sel-refiner-method');
      const saved = localStorage.getItem('swarm-upscale-method') || 'model-remacri_original.pth';
      sel.innerHTML = upscaleMethodParam.values.map(v =>
        `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(v)}</option>`
      ).join('');
    }
  } catch (e) { console.warn('loadParams:', e); }
}

// ── Sidebar: collapsible sections ─────────────────────────────────────────────
document.querySelectorAll('.sidebar-section-hdr').forEach(hdr => {
  hdr.addEventListener('click', () => {
    const key  = hdr.dataset.section;
    const body = $('sec-' + key);
    if (!body) return;
    const collapsed = body.classList.toggle('hidden');
    hdr.classList.toggle('collapsed', collapsed);
  });
});

// ── Sidebar: sliders ──────────────────────────────────────────────────────────
function syncSlider(slId, inpId, lblId) {
  const sl  = $(slId);
  const inp = $(inpId);
  const lbl = lblId ? $(lblId) : null;

  function update(v) {
    sl.value  = v;
    inp.value = v;
    if (lbl) lbl.textContent = v;
  }

  sl.addEventListener('input', () => update(sl.value));
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) update(Math.min(Math.max(v, +sl.min), +sl.max));
  });
}

syncSlider('sl-steps', 'inp-steps', 'lbl-steps');
syncSlider('sl-cfg',   'inp-cfg',   'lbl-cfg');

// ── Refiner sliders ───────────────────────────────────────────────────────────
syncSlider('sl-refiner-steps', 'inp-refiner-steps', 'lbl-refiner-steps');
syncSlider('sl-refiner-cfg',   'inp-refiner-cfg',   'lbl-refiner-cfg');

// ── ControlNet sliders ────────────────────────────────────────────────────────
{
  const mkSlider = (slId, inpId, lblId, fmt) => {
    const sl = $(slId), inp = $(inpId), lbl = $(lblId);
    const upd = v => { sl.value = v; inp.value = v; lbl.textContent = fmt(v); };
    sl.addEventListener('input', () => upd(sl.value));
    inp.addEventListener('change', () => upd(inp.value));
  };
  mkSlider('sl-cn-strength', 'inp-cn-strength', 'lbl-cn-strength', v => parseFloat(v).toFixed(2));
  mkSlider('sl-cn-start',    'inp-cn-start',    'lbl-cn-start',    v => Math.round(v * 100) + '%');
  mkSlider('sl-cn-end',      'inp-cn-end',      'lbl-cn-end',      v => Math.round(v * 100) + '%');
}

// Upscale slider (display with ×)
{
  const sl = $('sl-refiner-scale'), inp = $('inp-refiner-scale'), lbl = $('lbl-refiner-scale');
  const upd = v => { sl.value = v; inp.value = v; lbl.textContent = parseFloat(v).toFixed(2) + '×'; };
  sl.addEventListener('input', () => upd(sl.value));
  inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!isNaN(v)) upd(Math.min(Math.max(v,1),4)); });
}

// Switch-at % slider (display as %)
{
  const sl = $('sl-refiner-pct'), inp = $('inp-refiner-pct'), lbl = $('lbl-refiner-pct');
  const upd = v => { sl.value = v; inp.value = v; lbl.textContent = Math.round(v*100) + '%'; };
  sl.addEventListener('input', () => upd(sl.value));
  inp.addEventListener('change', () => { const v = parseFloat(inp.value); if (!isNaN(v)) upd(Math.min(Math.max(v,0),1)); });
}

// Enable/disable refiner fields
$('chk-refiner').addEventListener('change', () => {
  $('refiner-fields').style.display = $('chk-refiner').checked ? '' : 'none';
});

// ── ControlNet image ──────────────────────────────────────────────────────────
$('chk-cn').addEventListener('change', () => {
  $('cn-fields').style.display = $('chk-cn').checked ? '' : 'none';
});

let _cnImageData = null;

function setCNImage(dataUrl) {
  _cnImageData = dataUrl;
  $('cn-img-preview').src = dataUrl;
  $('cn-img-preview').style.display = '';
  $('cn-img-drop').textContent = 'Image loaded ✓';
  $('cn-img-drop').style.borderColor = 'var(--green)';
  $('cn-img-clear').style.display = '';
}

function clearCNImage() {
  _cnImageData = null;
  $('cn-img-preview').style.display = 'none';
  $('cn-img-preview').src = '';
  $('cn-img-drop').textContent = 'Click or drop an image';
  $('cn-img-drop').style.borderColor = '';
  $('cn-img-clear').style.display = 'none';
}

$('cn-img-drop').addEventListener('click', () => $('cn-img-file').click());
$('cn-img-file').addEventListener('change', e => {
  const file = e.target.files[0]; if (!file) return;
  const r = new FileReader();
  r.onload = ev => setCNImage(ev.target.result);
  r.readAsDataURL(file);
  e.target.value = '';
});
$('cn-img-drop').addEventListener('dragover', e => { e.preventDefault(); $('cn-img-drop').style.borderColor = 'var(--accent)'; });
$('cn-img-drop').addEventListener('dragleave', () => { $('cn-img-drop').style.borderColor = _cnImageData ? 'var(--green)' : ''; });
$('cn-img-drop').addEventListener('drop', e => {
  e.preventDefault();
  const file = e.dataTransfer.files[0]; if (!file || !file.type.startsWith('image/')) return;
  const r = new FileReader();
  r.onload = ev => setCNImage(ev.target.result);
  r.readAsDataURL(file);
});
$('cn-img-clear').addEventListener('click', clearCNImage);

// ── Sidebar: seed ─────────────────────────────────────────────────────────────
$('btn-rand-seed').addEventListener('click', () => {
  $('inp-seed').value = Math.floor(Math.random() * 2 ** 32);
});

$('btn-lock-seed').addEventListener('click', () => {
  App.seedLocked = !App.seedLocked;
  $('btn-lock-seed').classList.toggle('active', App.seedLocked);
});

// ── Sidebar: resolution ───────────────────────────────────────────────────────
document.querySelectorAll('.ratio-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('inp-width').value  = btn.dataset.w;
    $('inp-height').value = btn.dataset.h;
  });
});

// set default active
(function () {
  const first = document.querySelector('.ratio-btn[data-w="1152"][data-h="768"]');
  if (first) {
    first.classList.add('active');
    $('inp-width').value  = '1152';
    $('inp-height').value = '768';
  }
})();

$('btn-swap-dims').addEventListener('click', () => {
  const w = $('inp-width').value;
  $('inp-width').value  = $('inp-height').value;
  $('inp-height').value = w;
});

// ── LoRA items ────────────────────────────────────────────────────────────────
function populateLoRASelect(sel) {
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select LoRA —</option>' +
    App.loraModels.map(f => `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`).join('');
  if (cur) sel.value = cur;
}

function addLoRAItem() {
  const id   = ++App.loraIdSeq;
  const item = { id, model: '', weight: 1 };
  App.loraItems.push(item);
  renderLoRA(item);
}

function renderLoRA(item) {
  const list = $('lora-list');
  const div  = document.createElement('div');
  div.className  = 'lora-item';
  div.dataset.id = item.id;
  div.innerHTML = `
    <div class="lora-item-top">
      <select class="inp lora-sel"></select>
      <button class="btn-remove" title="Remove">✕</button>
    </div>
    <div class="slider-row">
      <input type="range" class="slider lora-weight-sl" min="0" max="2" step="0.05" value="1">
      <input type="text"  class="inp lora-weight-inp" value="1" style="width:55px;text-align:center">
    </div>`;
  list.appendChild(div);

  const sel = div.querySelector('.lora-sel');
  populateLoRASelect(sel);
  sel.value = item.model;
  sel.addEventListener('change', () => { item.model = sel.value; });

  const sl  = div.querySelector('.lora-weight-sl');
  const inp = div.querySelector('.lora-weight-inp');
  sl.addEventListener('input', () => { inp.value = sl.value; item.weight = +sl.value; });
  inp.addEventListener('change', () => {
    const v = parseFloat(inp.value);
    if (!isNaN(v)) { sl.value = v; item.weight = v; }
  });

  div.querySelector('.btn-remove').addEventListener('click', () => {
    App.loraItems = App.loraItems.filter(x => x.id !== item.id);
    div.remove();
  });
}

$('btn-add-lora').addEventListener('click', addLoRAItem);

// ── Generate ──────────────────────────────────────────────────────────────────
$('btn-generate').addEventListener('click', () => {
  if (!App.connected) return;
  if (App.running) { stopGeneration(); return; }
  startGeneration();
});

function startGeneration() {
  const prompt = $('inp-positive').value.trim();
  if (!prompt) { alert('Enter a positive prompt first.'); return; }

  App.running = true;
  $('btn-generate').textContent = 'Stop';
  $('btn-generate').classList.add('running');
  $('progress-wrap').classList.remove('hidden');
  setProgress(0, 'Starting…');

  // Build LoRA prompt suffix
  const loraSuffix = App.loraItems
    .filter(l => l.model)
    .map(l => `<lora:${l.model}:${l.weight}>`)
    .join(' ');

  const seed = App.seedLocked
    ? parseInt($('inp-seed').value) || -1
    : ($('inp-seed').value === '-1' ? -1 : parseInt($('inp-seed').value) || -1);

  const payload = {
    prompt:         prompt + (loraSuffix ? ' ' + loraSuffix : ''),
    negativeprompt: $('inp-negative').value.trim(),
    images:         parseInt($('sel-count').value) || 1,
    model:          $('sel-model').value,
    vae:            $('sel-vae').value || undefined,
    width:          parseInt($('inp-width').value)  || 1024,
    height:         parseInt($('inp-height').value) || 1024,
    steps:          parseInt($('inp-steps').value)  || 20,
    cfgscale:       parseFloat($('inp-cfg').value)  || 7,
    sampler:        $('sel-sampler').value   || undefined,
    scheduler:      $('sel-scheduler').value || undefined,
    seed,
  };

  // Refiner / Hires Fix params
  if ($('chk-refiner').checked) {
    const refModel = $('sel-refiner-model').value;
    if (refModel) payload.refinermodel = refModel;
    payload.refinermethod             = 'PostApply';
    payload.refinerupscale            = parseFloat($('inp-refiner-scale').value) || 1.5;
    payload.refinercontrolpercentage  = parseFloat($('inp-refiner-pct').value)   || 0.2;
    payload.refinerupscalemethod      = $('sel-refiner-method').value || 'pixel-lanczos';
    payload.refinersteps              = parseInt($('inp-refiner-steps').value)   || 10;
    payload.refinercfgscale           = parseFloat($('inp-refiner-cfg').value)   || 7;
    localStorage.setItem('swarm-refiner-model',   $('sel-refiner-model').value);
    localStorage.setItem('swarm-upscale-method',  $('sel-refiner-method').value);
  }

  // ControlNet params
  if ($('chk-cn').checked && _cnImageData) {
    payload.controlnetimage      = _cnImageData;
    payload.controlnetstrength   = parseFloat($('inp-cn-strength').value) || 1;
    payload.controlnetstartpct   = parseFloat($('inp-cn-start').value)    || 0;
    payload.controlnetendpct     = parseFloat($('inp-cn-end').value)      || 1;
    const cnModel = $('sel-cn-model').value;
    if (cnModel) payload.controlnetmodel = cnModel;
    const cnType = $('sel-cn-type').value;
    if (cnType && cnType !== 'none') payload.controlnetpreprocessor = cnType;
    localStorage.setItem('swarm-cn-model', cnModel);
  }

  // Remove undefined keys
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  // Save prefs
  localStorage.setItem('swarm-model',     $('sel-model').value);
  localStorage.setItem('swarm-vae',       $('sel-vae').value);
  localStorage.setItem('swarm-sampler',   $('sel-sampler').value);
  localStorage.setItem('swarm-scheduler', $('sel-scheduler').value);

  const batchImages = [];
  const groupLabel  = new Date().toLocaleTimeString();

  API.generate(payload, {
    onProgress(status, pct) {
      const label = typeof status === 'string' ? status : (status?.title || status?.stage || 'Generating…');
      // overall_percent can stay 0 with ComfyUI backend — use step-based progress if available
      const displayPct = pct > 0 ? pct : (status?.cur_step && status?.total_steps
        ? status.cur_step / status.total_steps : null);
      if (displayPct !== null) setProgress(displayPct, label);
      else $('progress-label').textContent = label;
    },
    onImage(imgData) {
      // SwarmUI sends a relative path like "Output/image.png", a full URL, or base64
      let src;
      if (typeof imgData === 'string' && imgData.startsWith('data:')) {
        src = imgData;
      } else if (typeof imgData === 'string' && imgData.startsWith('http')) {
        src = imgData;
      } else {
        // relative path → prepend server origin
        src = `${API.origin}/${imgData}`;
      }
      const img = { url: src, seed, prompt: payload.prompt };
      batchImages.push(img);
      addImageToGallery(img, groupLabel, batchImages.length === 1);

      // Update seed display with the used seed (SwarmUI may send it)
      if (!App.seedLocked) $('inp-seed').value = seed;
    },
    onDone() {
      finishGeneration();
    },
    onError(err) {
      console.error('Generation error:', err);
      App.running = false;
      $('btn-generate').textContent = 'Generate';
      $('btn-generate').classList.remove('running');
      $('progress-wrap').classList.add('hidden');
      showErrorToast(err);
    },
  });
}

function stopGeneration() {
  API.interrupt().catch(() => {});
  finishGeneration();
}

function showErrorToast(msg) {
  let toast = $('gen-error-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'gen-error-toast';
    document.body.appendChild(toast);
  }
  toast.textContent = '⚠ ' + msg;
  toast.classList.add('visible');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => toast.classList.remove('visible'), 8000);
}

function finishGeneration() {
  if (!App.running) return;
  App.running = false;
  $('btn-generate').textContent = 'Generate';
  $('btn-generate').classList.remove('running');
  setTimeout(() => {
    $('progress-wrap').classList.add('hidden');
    setProgress(0, '');
  }, 1200);
}

function setProgress(pct, label) {
  const p = Math.round(pct * 100);
  $('progress-bar').style.width = p + '%';
  $('progress-pct').textContent = p + '%';
  $('progress-label').textContent = label || 'Generating…';
}

// ── Gallery ───────────────────────────────────────────────────────────────────
function addImageToGallery(img, groupLabel, isFirst) {
  const gallery = $('gallery');

  // Remove empty state
  const empty = $('gallery-empty');
  if (empty) empty.remove();

  // Find or create group row
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
    <img src="${img.url}" alt="Generated image" loading="lazy">
    <div class="gallery-img-actions">
      <button class="gal-btn" data-action="view">View</button>
      <button class="gal-btn" data-action="seed">Seed</button>
      <button class="gal-btn" data-action="inpaint">Inpaint</button>
      <button class="gal-btn" data-action="save">Save</button>
    </div>`;

  div.querySelector('[data-action="view"]').addEventListener('click', e => {
    e.stopPropagation();
    openLightbox(img.url);
  });
  div.querySelector('[data-action="seed"]').addEventListener('click', e => {
    e.stopPropagation();
    $('inp-seed').value = img.seed;
    App.seedLocked = true;
    $('btn-lock-seed').classList.add('active');
  });
  div.querySelector('[data-action="inpaint"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToInpaint(img.url);
  });
  div.querySelector('[data-action="save"]').addEventListener('click', e => {
    e.stopPropagation();
    downloadImage(img.url);
  });

  div.addEventListener('click', () => openLightbox(img.url));
  row.appendChild(div);
}

function downloadImage(url) {
  const a = document.createElement('a');
  a.href = url;
  a.download = `swarmui-${Date.now()}.png`;
  a.click();
}

// ── Lightbox ──────────────────────────────────────────────────────────────────
function openLightbox(url) {
  $('lightbox-img').src = url;
  $('lightbox').classList.remove('hidden');
}
function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightbox-img').src = '';
}

$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-backdrop').addEventListener('click', closeLightbox);
document.addEventListener('keydown', e => { if (e.key === 'Escape') closeLightbox(); });

// ── Presets (localStorage) ────────────────────────────────────────────────────
const PRESETS_KEY = 'swarmapp-presets';

function getPresetsData() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); } catch { return {}; }
}
function savePresetsData(obj) { localStorage.setItem(PRESETS_KEY, JSON.stringify(obj)); }

function loadPresets() {
  const presets = getPresetsData();
  App.presets = Object.entries(presets).map(([title, param_map]) => ({ title, param_map }));
  renderPresetList();
  ['btn-preset-load','btn-preset-save','btn-preset-delete','btn-preset-new']
    .forEach(id => $(id).disabled = false);
}

function renderPresetList() {
  const sel = $('sel-preset');
  const cur = sel.value;
  sel.innerHTML = '<option value="">— Select preset —</option>' +
    App.presets.map(p => `<option value="${esc(p.title)}">${esc(p.title)}</option>`).join('');
  if (cur) sel.value = cur;
}

function applyPreset(preset) {
  const m = preset.param_map || {};
  const set = (id, val) => { const el = $(id); if (el && val !== undefined) el.value = val; };

  // Prompts
  if (m.prompt)         $('inp-positive').value = m.prompt;
  if (m.negativeprompt) $('inp-negative').value = m.negativeprompt;

  // Model / VAE
  if (m.model) { $('sel-model').value = m.model; localStorage.setItem('swarm-model', m.model); }
  if (m.vae)   { $('sel-vae').value   = m.vae;   localStorage.setItem('swarm-vae', m.vae); }

  // Generation
  if (m.steps)       { set('inp-steps', m.steps);   $('sl-steps').value = m.steps;   $('lbl-steps').textContent = m.steps; }
  if (m.cfgscale)    { set('inp-cfg',   m.cfgscale); $('sl-cfg').value   = m.cfgscale; $('lbl-cfg').textContent   = m.cfgscale; }
  if (m.sampler)     { $('sel-sampler').value   = m.sampler; }
  if (m.samplername) { $('sel-sampler').value   = m.samplername; } // compat anciens presets
  if (m.scheduler)   { $('sel-scheduler').value = m.scheduler; }
  if (m.seed !== undefined) set('inp-seed', m.seed);

  // Resolution
  if (m.width)  set('inp-width',  m.width);
  if (m.height) set('inp-height', m.height);

  // Refiner
  if (m.refinerupscale !== undefined) {
    $('chk-refiner').checked = true;
    $('refiner-fields').style.display = '';
    if (m.refinermodel)            $('sel-refiner-model').value = m.refinermodel;
    if (m.refinerupscale)          { $('inp-refiner-scale').value = m.refinerupscale; $('sl-refiner-scale').value = m.refinerupscale; $('lbl-refiner-scale').textContent = parseFloat(m.refinerupscale).toFixed(2) + '×'; }
    if (m.refinercontrolpercentage){ $('inp-refiner-pct').value  = m.refinercontrolpercentage; $('sl-refiner-pct').value = m.refinercontrolpercentage; $('lbl-refiner-pct').textContent = Math.round(m.refinercontrolpercentage*100) + '%'; }
    if (m.refinerupscalemethod)    $('sel-refiner-method').value  = m.refinerupscalemethod;
    if (m.refinersteps)            { $('inp-refiner-steps').value = m.refinersteps; $('sl-refiner-steps').value = m.refinersteps; $('lbl-refiner-steps').textContent = m.refinersteps; }
    if (m.refinercfgscale)         { $('inp-refiner-cfg').value   = m.refinercfgscale; $('sl-refiner-cfg').value = m.refinercfgscale; $('lbl-refiner-cfg').textContent = m.refinercfgscale; }
  }

  // LoRAs: SwarmUI stores as comma-separated "model1,model2" / "w1,w2"
  if (m.loras) {
    const loraNames    = String(m.loras).split(',').map(s => s.trim()).filter(Boolean);
    const loraWeights  = m.loraweights ? String(m.loraweights).split(',').map(s => parseFloat(s.trim()) || 1) : [];
    // Clear existing
    $('lora-list').innerHTML = '';
    App.loraItems = [];
    loraNames.forEach((name, i) => {
      addLoRAItem();
      const item = App.loraItems[App.loraItems.length - 1];
      item.model  = name;
      item.weight = loraWeights[i] ?? 1;
      const div   = $('lora-list').lastElementChild;
      if (div) {
        const sel = div.querySelector('.lora-sel');
        if (sel) sel.value = name;
        const sl  = div.querySelector('.lora-weight-sl');
        const inp = div.querySelector('.lora-weight-inp');
        if (sl)  sl.value  = item.weight;
        if (inp) inp.value = item.weight;
      }
    });
  }
}

function collectParamMap() {
  const m = {};
  const g = id => $(id)?.value ?? '';

  m.prompt         = g('inp-positive');
  m.negativeprompt = g('inp-negative');
  m.model          = g('sel-model');
  m.vae            = g('sel-vae') || undefined;
  m.steps          = g('inp-steps');
  m.cfgscale       = g('inp-cfg');
  m.sampler        = g('sel-sampler');
  m.scheduler      = g('sel-scheduler');
  m.seed           = g('inp-seed');
  m.width          = g('inp-width');
  m.height         = g('inp-height');

  if ($('chk-refiner')?.checked) {
    m.refinermethod            = 'PostApply';
    m.refinerupscale           = g('inp-refiner-scale');
    m.refinercontrolpercentage = g('inp-refiner-pct');
    m.refinerupscalemethod     = g('sel-refiner-method');
    m.refinersteps             = g('inp-refiner-steps');
    m.refinercfgscale          = g('inp-refiner-cfg');
    const rm = g('sel-refiner-model');
    if (rm) m.refinermodel     = rm;
  }

  if (App.loraItems.length) {
    m.loras       = App.loraItems.filter(l => l.model).map(l => l.model).join(',');
    m.loraweights = App.loraItems.filter(l => l.model).map(l => l.weight).join(',');
  }

  // remove undefined/empty
  Object.keys(m).forEach(k => { if (m[k] === undefined || m[k] === '') delete m[k]; });
  return m;
}

$('btn-preset-load').addEventListener('click', () => {
  const title = $('sel-preset').value;
  if (!title) return;
  const preset = App.presets.find(p => p.title === title);
  if (preset) applyPreset(preset);
});

$('sel-preset').addEventListener('change', () => {
  const hasVal = !!$('sel-preset').value;
  $('btn-preset-load').disabled   = !hasVal;
  $('btn-preset-delete').disabled = !hasVal;
  $('inp-preset-name').value      = $('sel-preset').value;
});

function doSavePreset() {
  // Use typed name first, fall back to selected preset
  const title = $('inp-preset-name').value.trim() || $('sel-preset').value;
  if (!title) return;
  const presets = getPresetsData();
  presets[title] = collectParamMap();
  savePresetsData(presets);
  loadPresets();
  $('sel-preset').value      = title;
  $('inp-preset-name').value = '';
}

$('btn-preset-save').addEventListener('click', doSavePreset);
$('btn-preset-new').addEventListener('click',  doSavePreset);

$('btn-preset-delete').addEventListener('click', () => {
  const title = $('sel-preset').value;
  if (!title) return;
  const presets = getPresetsData();
  delete presets[title];
  savePresetsData(presets);
  loadPresets();
});

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));

  const isTxt  = tab === 'txt2img';
  const isInp  = tab === 'inpaint';
  const isSch  = tab === 'scheduler';

  $('view-txt2img').style.display = isTxt ? 'contents' : 'none';
  $('view-inpaint').classList.toggle('active', isInp);
  $('view-scheduler').classList.toggle('active', isSch);

  if (isInp) { Inpaint.init(); Inpaint.onShow(); }
  if (isSch) { Scheduler.init(); Scheduler.onShow(); }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── Send to Inpaint (from gallery) ───────────────────────────────────────────
function sendToInpaint(url) {
  switchTab('inpaint');
  Inpaint.loadFromSrc(url);
}

// ── Connect button ────────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', connect);
$('host-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Auto-connect on load ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Restore saved host if any
  const savedHost = localStorage.getItem('swarm-host');
  if (savedHost) $('host-input').value = savedHost;

  // Init tag autocomplete
  TagComplete.init();

  // Init character selector
  CharSelector.bindControls();

  // Init inpaint (binds events only, no API calls yet)
  Inpaint.init();

  // Load local presets (no server needed)
  loadPresets();

  // Auto-connect
  connect();

  // Update notifications
  if (window.electronAPI?.onUpdateAvailable) {
    window.electronAPI.onUpdateAvailable((version) => {
      const banner = document.getElementById('update-banner');
      document.getElementById('update-msg').textContent = `Nouvelle version v${version} disponible — `;
      banner.style.display = 'flex';
      document.getElementById('update-close').onclick = () => banner.style.display = 'none';
    });
  }
});

$('host-input').addEventListener('change', () => {
  localStorage.setItem('swarm-host', $('host-input').value);
});
