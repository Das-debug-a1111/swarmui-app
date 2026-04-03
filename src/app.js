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
  TagComplete.clearModelCache();
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
    App.loraModels = d.files || d.models || [];
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
  $('inp-seed').value = -1;
  App.seedLocked = false;
  $('btn-lock-seed').classList.remove('active');
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
    onPreview(dataUrl) {
      let el = $('gen-live-preview');
      if (!el) {
        el = document.createElement('img');
        el.id = 'gen-live-preview';
      }
      el.src = dataUrl;
      el.style.display = 'block';
      $('gallery').prepend(el); // toujours épinglé en premier
      $('gallery-empty').style.display = 'none';
    },
    onImage(imgData) {
      // Hide live preview when final image arrives
      const prev = $('gen-live-preview');
      if (prev) prev.style.display = 'none';
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

function toast(msg) {
  let el = document.getElementById('swarm-toast');
  if (!el) {
    el = document.createElement('div');
    el.id = 'swarm-toast';
    el.style.cssText = 'position:fixed;bottom:24px;left:50%;transform:translateX(-50%);background:var(--bg3,#333);color:var(--text1,#fff);padding:7px 18px;border-radius:8px;font-size:13px;z-index:99999;pointer-events:none;transition:opacity .3s';
    document.body.appendChild(el);
  }
  el.textContent = msg;
  el.style.opacity = '1';
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.style.opacity = '0'; }, 1800);
}

function finishGeneration() {
  if (!App.running) return;
  App.running = false;
  $('btn-generate').textContent = 'Generate';
  $('btn-generate').classList.remove('running');
  const prev = $('gen-live-preview');
  if (prev) prev.style.display = 'none';
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
      <button class="gal-btn" data-action="seed">Seed</button>
      <button class="gal-btn" data-action="inpaint">Inpaint</button>
      <button class="gal-btn" data-action="schedule">Sched</button>
      <button class="gal-btn" data-action="info">Info</button>
      <button class="gal-btn" data-action="save">Save</button>
    </div>`;


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
  div.querySelector('[data-action="schedule"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToScheduler(img.seed);
  });
  div.querySelector('[data-action="info"]').addEventListener('click', e => {
    e.stopPropagation();
    showPngInfo(img.url);
  });
  div.querySelector('[data-action="save"]').addEventListener('click', e => {
    e.stopPropagation();
    downloadImage(img.url);
  });

  div.addEventListener('click', () => openLightbox(img.url));
  row.appendChild(div);
}

async function showPngInfo(url) {
  try {
    const res   = await fetch(url);
    const buf   = await res.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let rawJson = null;

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
            rawJson = new TextDecoder().decode(raw.slice(nul + 1)); break;
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
            const ifd0 = rd32(4);
            const n0   = rd16(ifd0);
            let exifIfdOff = 0;
            for (let i = 0; i < n0; i++) {
              const e = ifd0 + 2 + i * 12;
              if (rd16(e) === 0x8769) { exifIfdOff = rd32(e + 8); break; }
            }
            if (exifIfdOff) {
              const nE = rd16(exifIfdOff);
              for (let i = 0; i < nE; i++) {
                const e = exifIfdOff + 2 + i * 12;
                if (rd16(e) === 0x9286) {
                  const count  = rd32(e + 4);
                  const valOff = rd32(e + 8);
                  const rawFull = new Uint8Array(buf, exifBase + valOff, count);
                  const prefix  = new TextDecoder('ascii').decode(rawFull.slice(0, 8));
                  const skip    = prefix.trimEnd().replace(/\0/g, '').match(/^(ASCII|UNICODE|JIS)$/) ? 8 : 0;
                  rawJson = new TextDecoder().decode(rawFull.slice(skip)).replace(/\0/g, '').trim();
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

    _showPngInfoModal(_formatMetadata(rawJson));
  } catch (e) { console.error('[PNG Info]', e); _showPngInfoModal('Erreur de lecture.'); }
}

let _lastParsedMeta = null; // raw parsed sui_image_params for copy buttons

function _formatMetadata(rawJson) {
  _lastParsedMeta = null;
  if (!rawJson) return 'Aucune métadonnée trouvée.';
  try {
    const parsed = JSON.parse(rawJson);
    const params = parsed.sui_image_params || parsed;
    const extra  = parsed.sui_extra_data   || {};
    _lastParsedMeta = params;
    const lines = Object.entries(params).map(([k, v]) => `${k}: ${v}`);
    if (Object.keys(extra).length) lines.push('', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`));
    return lines.join('\n');
  } catch { return rawJson; }
}

function _normalizeEmbeds(text) {
  // Convert A1111 format "embedding:name.safetensors" → SwarmUI "<embed:name>"
  return text.replace(/\bembedding:([\w\-]+)(?:\.safetensors|\.pt|\.bin)?\b/g, '<embed:$1>');
}

let _sendWithSeed = false;

function _sendToTxt2img(params) {
  if (!params) return;
  const p = params;
  if (p.prompt)         $('inp-positive').value = _normalizeEmbeds(p.prompt);
  if (p.negativeprompt) $('inp-negative').value = _normalizeEmbeds(p.negativeprompt);
  if (p.steps)    { $('inp-steps').value = p.steps;    $('sl-steps').value = p.steps;    $('lbl-steps').textContent = p.steps; }
  if (p.cfgscale) { $('inp-cfg').value   = p.cfgscale; $('sl-cfg').value   = p.cfgscale; $('lbl-cfg').textContent   = p.cfgscale; }
  if (_sendWithSeed && p.seed) $('inp-seed').value = p.seed;
  if (p.width)          $('inp-width').value    = p.width;
  if (p.height)         $('inp-height').value   = p.height;
  // Model/VAE/Sampler/Scheduler: set select value if the option exists
  if (p.model) {
    const sel = $('sel-model');
    const opt = [...sel.options].find(o => o.value === p.model || o.text === p.model);
    if (opt) sel.value = opt.value;
  }
  if (p.vae) {
    const sel = $('sel-vae');
    const opt = [...sel.options].find(o => o.value === p.vae || o.text === p.vae);
    if (opt) sel.value = opt.value;
  }
  if (p.sampler) {
    const sel = $('sel-sampler');
    const opt = [...sel.options].find(o => o.value.toLowerCase() === p.sampler.toLowerCase() || o.text.toLowerCase() === p.sampler.toLowerCase());
    if (opt) sel.value = opt.value;
  }
  if (p.scheduler) {
    const sel = $('sel-scheduler');
    const opt = [...sel.options].find(o => o.value.toLowerCase() === p.scheduler.toLowerCase() || o.text.toLowerCase() === p.scheduler.toLowerCase());
    if (opt) sel.value = opt.value;
  }
  // Refiner / Hires Fix
  if (p.refinerupscale !== undefined || p.refinermethod === 'PostApply') {
    $('chk-refiner').checked = true;
    $('refiner-fields').style.display = '';
    if (p.refinermodel)             { const sel = $('sel-refiner-model'); const opt = [...sel.options].find(o => o.value === p.refinermodel); if (opt) sel.value = opt.value; }
    if (p.refinerupscalemethod)     $('sel-refiner-method').value = p.refinerupscalemethod;
    if (p.refinerupscale)           { $('inp-refiner-scale').value = p.refinerupscale; $('sl-refiner-scale').value = p.refinerupscale; $('lbl-refiner-scale').textContent = parseFloat(p.refinerupscale).toFixed(2) + '×'; }
    if (p.refinercontrolpercentage) { $('inp-refiner-pct').value   = p.refinercontrolpercentage; $('sl-refiner-pct').value = p.refinercontrolpercentage; $('lbl-refiner-pct').textContent = Math.round(p.refinercontrolpercentage * 100) + '%'; }
    if (p.refinersteps)             { $('inp-refiner-steps').value = p.refinersteps; $('sl-refiner-steps').value = p.refinersteps; $('lbl-refiner-steps').textContent = p.refinersteps; }
    if (p.refinercfgscale)          { $('inp-refiner-cfg').value   = p.refinercfgscale; $('sl-refiner-cfg').value = p.refinercfgscale; $('lbl-refiner-cfg').textContent = p.refinercfgscale; }
  } else {
    $('chk-refiner').checked = false;
    $('refiner-fields').style.display = 'none';
  }
  // Switch to txt2img tab
  document.querySelector('.tab[data-tab="txt2img"]')?.click();
  toast('Envoyé vers txt2img !');
}

function _buildParamsCopy(params) {
  if (!params) return '';
  const p = params;
  const parts = [];
  if (p.prompt)         parts.push(`Prompt: ${p.prompt}`);
  if (p.negativeprompt) parts.push(`Negative: ${p.negativeprompt}`);
  parts.push('---');
  if (p.model)     parts.push(`Model: ${p.model}`);
  if (p.vae)       parts.push(`VAE: ${p.vae}`);
  if (p.steps)     parts.push(`Steps: ${p.steps}`);
  if (p.cfgscale)  parts.push(`CFG: ${p.cfgscale}`);
  if (p.sampler)   parts.push(`Sampler: ${p.sampler}`);
  if (p.scheduler) parts.push(`Scheduler: ${p.scheduler}`);
  if (p.seed)      parts.push(`Seed: ${p.seed}`);
  if (p.width && p.height) parts.push(`Size: ${p.width}x${p.height}`);
  if (p.refinermethod === 'PostApply' || p.refinerupscale !== undefined) {
    parts.push('--- Hires Fix ---');
    if (p.refinerupscalemethod)     parts.push(`HF Method: ${p.refinerupscalemethod}`);
    if (p.refinerupscale)           parts.push(`HF Scale: ${p.refinerupscale}`);
    if (p.refinercontrolpercentage) parts.push(`HF Switch at: ${Math.round(p.refinercontrolpercentage * 100)}%`);
    if (p.refinersteps)             parts.push(`HF Steps: ${p.refinersteps}`);
    if (p.refinercfgscale)          parts.push(`HF CFG: ${p.refinercfgscale}`);
    if (p.refinermodel)             parts.push(`HF Model: ${p.refinermodel}`);
  }
  return parts.join('\n');
}

function _showPngInfoModal(text) {
  let modal = document.getElementById('png-info-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'png-info-modal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:9999;display:flex;align-items:center;justify-content:center';
    modal.innerHTML = `
      <div style="background:var(--bg2);border:1px solid var(--border);border-radius:10px;padding:20px;max-width:700px;width:90%;height:70vh;display:flex;flex-direction:column;gap:12px">
        <div style="display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap">
          <span style="font-weight:600;color:var(--text1)">PNG Info</span>
          <div style="display:flex;gap:6px;margin-left:auto;flex-wrap:wrap">
            <button id="png-info-send-txt2img" class="btn-primary"   style="font-size:11px;padding:3px 10px">→ txt2img</button>
            <button id="png-info-seed-lock"   class="btn-secondary" style="font-size:11px;padding:3px 7px" title="Copier la seed">🎲</button>
            <button id="png-info-copy-prompt" class="btn-secondary" style="font-size:11px;padding:3px 8px">Prompt</button>
            <button id="png-info-copy-params" class="btn-secondary" style="font-size:11px;padding:3px 8px">Paramètres</button>
            <button id="png-info-copy-all"    class="btn-secondary" style="font-size:11px;padding:3px 8px">Tout</button>
            <button id="png-info-close" style="background:none;border:none;color:var(--text2);font-size:18px;cursor:pointer">✕</button>
          </div>
        </div>
        <textarea id="png-info-text" readonly style="overflow:auto;font-size:11px;color:var(--text2);white-space:pre-wrap;flex:1;margin:0;background:transparent;border:none;resize:none;outline:none;cursor:text;font-family:inherit"></textarea>
      </div>`;
    document.body.appendChild(modal);
    modal.addEventListener('click', e => { if (e.target === modal) modal.remove(); });
    modal.querySelector('#png-info-close').addEventListener('click', () => modal.remove());
    modal.querySelector('#png-info-copy-all').addEventListener('click', () => {
      navigator.clipboard.writeText(modal.querySelector('#png-info-text').value);
      toast('Copié !', 'info');
    });
    modal.querySelector('#png-info-copy-prompt').addEventListener('click', () => {
      const prompt = _lastParsedMeta?.prompt
        || modal.querySelector('#png-info-text').value.match(/^prompt:\s*([\s\S]+?)(?=\n\w+:|$)/m)?.[1]?.trim()
        || '';
      navigator.clipboard.writeText(prompt);
      toast('Prompt copié !', 'info');
    });
    modal.querySelector('#png-info-copy-params').addEventListener('click', () => {
      navigator.clipboard.writeText(_buildParamsCopy(_lastParsedMeta));
      toast('Paramètres copiés !', 'info');
    });
    modal.querySelector('#png-info-send-txt2img').addEventListener('click', () => {
      _sendToTxt2img(_lastParsedMeta);
      modal.remove();
    });
    modal.querySelector('#png-info-seed-lock').addEventListener('click', function() {
      _sendWithSeed = !_sendWithSeed;
      this.textContent = _sendWithSeed ? '🔒' : '🎲';
      this.style.color = _sendWithSeed ? 'var(--accent)' : '';
    });
  }
  modal.querySelector('#png-info-text').value = text;
  document.body.appendChild(modal);
}

async function downloadImage(url) {
  try {
    const res  = await fetch(url);
    const blob = await res.blob();
    const ext  = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `swarmui-${Date.now()}.${ext}`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch {
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `swarmui-${Date.now()}.jpg`;
    a.click();
  }
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
  TagComplete.clearModelCache();
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
  const isPng  = tab === 'pnginfo';

  $('view-txt2img').style.display = isTxt ? 'contents' : 'none';
  $('view-inpaint').classList.toggle('active', isInp);
  $('view-scheduler').classList.toggle('active', isSch);
  $('view-pnginfo').classList.toggle('active', isPng);

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

// ── Send to Scheduler (from gallery) ─────────────────────────────────────────
function sendToScheduler(seed) {
  switchTab('scheduler');
  Scheduler.init();
  const hfEnabled = $('chk-refiner')?.checked || false;
  Scheduler.openModalWith({
    prompt:   $('inp-positive').value  || '',
    negative: $('inp-negative').value  || '',
    model:    $('sel-model').value     || '',
    steps:    parseInt($('inp-steps').value)    || 20,
    cfg:      parseFloat($('inp-cfg').value)    || 7,
    sampler:  $('sel-sampler').value   || '',
    seed:     seed ?? parseInt($('inp-seed').value) ?? -1,
    width:    parseInt($('inp-width').value)    || 1024,
    height:   parseInt($('inp-height').value)   || 1024,
    hiresfix: {
      enabled: hfEnabled,
      model:   $('sel-refiner-model')?.value  || '',
      method:  $('sel-refiner-method')?.value || '',
      scale:   parseFloat($('inp-refiner-scale')?.value) || 1.5,
      pct:     parseFloat($('inp-refiner-pct')?.value)   || 0.6,
      steps:   parseInt($('inp-refiner-steps')?.value)   || 10,
      cfg:     parseFloat($('inp-refiner-cfg')?.value)   || 7,
    },
  });
}

// ── PNG Info tab ─────────────────────────────────────────────────────────────
(function initPngInfo() {
  const drop      = document.getElementById('pnginfo-drop');
  const fileInput = document.getElementById('pnginfo-file-input');
  const browse    = document.getElementById('pnginfo-browse');
  const result    = document.getElementById('pnginfo-result');
  const preview   = document.getElementById('pnginfo-preview');
  const metaText  = document.getElementById('pnginfo-meta-text');
  const copyBtn         = document.getElementById('pnginfo-copy');
  const copyPromptBtn   = document.getElementById('pnginfo-copy-prompt');
  const copyParamsBtn   = document.getElementById('pnginfo-copy-params');
  const sendTxt2imgBtn  = document.getElementById('pnginfo-send-txt2img');
  const seedLockBtn     = document.getElementById('pnginfo-seed-lock');
  const clearBtn        = document.getElementById('pnginfo-clear');
  const dropInner = document.getElementById('pnginfo-drop-inner');

  async function processFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    const objectUrl = URL.createObjectURL(file);
    preview.src = objectUrl;
    metaText.value = 'Lecture des métadonnées…';
    result.style.display = 'flex';
    drop.style.display = 'none';

    const buf   = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let rawJson = null;

    const isPNG = bytes[0] === 0x89 && bytes[1] === 0x50;
    const isJPG = bytes[0] === 0xFF && bytes[1] === 0xD8;
    console.log('[PNGInfo] type:', isPNG ? 'PNG' : isJPG ? 'JPG' : 'unknown', 'size:', buf.byteLength);

    if (isPNG) {
      const view = new DataView(buf);
      let off = 8;
      while (off < buf.byteLength - 12) {
        const len  = view.getUint32(off); off += 4;
        const type = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]); off += 4;
        console.log('[PNGInfo] chunk:', type, 'len:', len);
        if (type === 'tEXt') {
          const raw = bytes.slice(off, off + len);
          const nul = raw.indexOf(0);
          const key = new TextDecoder().decode(raw.slice(0, nul));
          console.log('[PNGInfo] tEXt key:', key);
          if (key === 'parameters') {
            rawJson = new TextDecoder().decode(raw.slice(nul + 1)); break;
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
        console.log('[PNGInfo] JPEG marker:', '0x' + marker.toString(16), 'segLen:', segLen);
        if (marker === 0xFE) { // COM segment — also try this
          const com = new TextDecoder().decode(bytes.slice(off + 4, off + 2 + segLen)).trim();
          console.log('[PNGInfo] COM:', com.slice(0, 100));
          if (com.startsWith('{')) { rawJson = com; break; }
        }
        if (marker === 0xE1) {
          const hdr = new TextDecoder('ascii').decode(bytes.slice(off + 4, off + 10));
          console.log('[PNGInfo] APP1 hdr:', JSON.stringify(hdr));
          if (hdr.startsWith('Exif\0')) {
            const exifBase = off + 10;
            const tiff = new DataView(buf, exifBase);
            const le   = tiff.getUint16(0) === 0x4949;
            console.log('[PNGInfo] EXIF byte order:', le ? 'LE' : 'BE');
            const rd16 = o => tiff.getUint16(o, le);
            const rd32 = o => tiff.getUint32(o, le);
            const ifd0 = rd32(4);
            const n0   = rd16(ifd0);
            console.log('[PNGInfo] IFD0 offset:', ifd0, 'entries:', n0);
            let exifIfdOff = 0;
            for (let i = 0; i < n0; i++) {
              const e = ifd0 + 2 + i * 12;
              const tag = rd16(e);
              console.log('[PNGInfo] IFD0 tag:', '0x' + tag.toString(16));
              if (tag === 0x8769) { exifIfdOff = rd32(e + 8); break; }
            }
            console.log('[PNGInfo] ExifIFD offset:', exifIfdOff);
            if (exifIfdOff) {
              const nE = rd16(exifIfdOff);
              for (let i = 0; i < nE; i++) {
                const e = exifIfdOff + 2 + i * 12;
                const tag = rd16(e);
                console.log('[PNGInfo] ExifIFD tag:', '0x' + tag.toString(16));
                if (tag === 0x9286) {
                  const count  = rd32(e + 4);
                  const valOff = rd32(e + 8);
                  console.log('[PNGInfo] UserComment count:', count, 'valOff:', valOff);
                  // Try without prefix first (some encoders skip the 8-byte charset prefix)
                  const rawFull = new Uint8Array(buf, exifBase + valOff, count);
                  const prefix  = new TextDecoder('ascii').decode(rawFull.slice(0, 8));
                  console.log('[PNGInfo] UserComment prefix:', JSON.stringify(prefix));
                  const skip = prefix.trimEnd().replace(/\0/g, '').match(/^(ASCII|UNICODE|JIS)$/) ? 8 : 0;
                  rawJson = new TextDecoder().decode(rawFull.slice(skip)).replace(/\0/g, '').trim();
                  console.log('[PNGInfo] UserComment value start:', rawJson.slice(0, 80));
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

    _lastParsedMeta = null;
    let display = 'Aucune métadonnée trouvée.\n\nNote : SwarmUI n\'embarque les métadonnées que si "Save Metadata" est activé dans ses paramètres.';
    if (rawJson) {
      try {
        const parsed = JSON.parse(rawJson);
        const params = parsed.sui_image_params || parsed;
        const extra  = parsed.sui_extra_data   || {};
        _lastParsedMeta = params;
        const lines  = Object.entries(params).map(([k, v]) => `${k}: ${v}`);
        if (Object.keys(extra).length) lines.push('', ...Object.entries(extra).map(([k, v]) => `${k}: ${v}`));
        display = lines.join('\n');
      } catch { display = rawJson; }
    }
    metaText.value = display;
  }

  browse.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) processFile(fileInput.files[0]); });

  drop.addEventListener('dragover', e => { e.preventDefault(); drop.classList.add('drag-over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('drag-over'));
  drop.addEventListener('drop', e => {
    e.preventDefault();
    drop.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });

  clearBtn.addEventListener('click', () => {
    result.style.display = 'none';
    drop.style.display = 'flex';
    preview.src = '';
    metaText.value = '';
    fileInput.value = '';
  });

  copyBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(metaText.value).then(() => toast('Copié !', 'info'));
  });
  copyPromptBtn.addEventListener('click', () => {
    const prompt = _lastParsedMeta?.prompt
      || metaText.value.match(/^prompt:\s*([\s\S]+?)(?=\n\w+:|$)/m)?.[1]?.trim()
      || '';
    navigator.clipboard.writeText(prompt).then(() => toast('Prompt copié !', 'info'));
  });
  copyParamsBtn.addEventListener('click', () => {
    navigator.clipboard.writeText(_buildParamsCopy(_lastParsedMeta)).then(() => toast('Paramètres copiés !', 'info'));
  });
  sendTxt2imgBtn.addEventListener('click', () => {
    _sendToTxt2img(_lastParsedMeta);
  });
  seedLockBtn.addEventListener('click', function() {
    _sendWithSeed = !_sendWithSeed;
    this.textContent = _sendWithSeed ? '🔒' : '🎲';
    this.style.color = _sendWithSeed ? 'var(--accent)' : '';
    // Sync modal button if open
    const modalBtn = document.getElementById('png-info-seed-lock');
    if (modalBtn) { modalBtn.textContent = this.textContent; modalBtn.style.color = this.style.color; }
  });
})();

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
