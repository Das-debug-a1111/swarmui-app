// ── SwarmUI App ───────────────────────────────────────────────────────────────

// ── State ─────────────────────────────────────────────────────────────────────
const App = {
  connected:  false,
  running:    false,
  seedLocked: false,
  models:     [],   // available checkpoint list (with architecture/compat_class)
  modelFamily: localStorage.getItem('swarm-model-family') || '',  // active family chip ('' = all)
  loraModels: [],   // available LoRA model list
  loraItems:  [],   // active LoRA rows [{id, model, weight}]
  loraIdSeq:  0,
  batchGroups: [],  // [{label, images:[{url, seed, prompt}]}]
};

// ── Txt2Img instances ─────────────────────────────────────────────────────────
const _t2iStates = [{}]; // one state object per instance (empty = use defaults)

function collectTxt2ImgState() {
  return {
    positive:       $('inp-positive')?.value         ?? '',
    negative:       $('inp-negative')?.value         ?? '',
    model:          $('sel-model')?.value            ?? '',
    vae:            $('sel-vae')?.value              ?? '',
    width:          $('inp-width')?.value            ?? '1024',
    height:         $('inp-height')?.value           ?? '1024',
    steps:          $('inp-steps')?.value            ?? '20',
    cfg:            $('inp-cfg')?.value              ?? '7',
    seed:           $('inp-seed')?.value             ?? '-1',
    sampler:        $('sel-sampler')?.value          ?? '',
    scheduler:      $('sel-scheduler')?.value        ?? '',
    count:          $('sel-count')?.value            ?? '1',
    // Refiner
    refinerEnabled: $('chk-refiner')?.checked        ?? false,
    refinerModel:   $('sel-refiner-model')?.value    ?? '',
    refinerMethod:  $('sel-refiner-method')?.value   ?? '',
    refinerScale:   $('inp-refiner-scale')?.value    ?? '1.5',
    refinerPct:     $('inp-refiner-pct')?.value      ?? '0.6',
    refinerSteps:   $('inp-refiner-steps')?.value    ?? '10',
    refinerCfg:     $('inp-refiner-cfg')?.value      ?? '7',
    // ControlNet
    cnEnabled:      $('chk-cn')?.checked             ?? false,
    cnModel:        $('sel-cn-model')?.value         ?? '',
    cnType:         $('sel-cn-type')?.value          ?? 'none',
    cnStrength:     $('inp-cn-strength')?.value      ?? '1',
    cnStart:        $('inp-cn-start')?.value         ?? '0',
    cnEnd:          $('inp-cn-end')?.value           ?? '1',
    cnImage:        _cnImageData                     ?? null,
    regionalPrompts: RegionalPrompt.regions.map(r => ({ ...r })),
    // LoRAs
    loras: App.loraItems.map(item => ({
      model:  item.model  || '',
      weight: item.weight ?? 1,
    })).filter(l => l.model),
  };
}

function applyTxt2ImgState(state) {
  const s  = state || {};
  const g  = (key, def) => s[key] !== undefined ? s[key] : def;

  const setSl = (slId, inpId, lblId, val, fmt) => {
    const sl = $(slId), inp = $(inpId), lbl = $(lblId);
    if (!sl || val === undefined || val === null) return;
    sl.value = val;
    if (inp) inp.value = val;
    if (lbl) lbl.textContent = fmt ? fmt(+val) : val;
  };
  const setV = (id, val) => { const el = $(id); if (el && val != null) el.value = val; };

  setV('inp-positive', g('positive', ''));
  setV('inp-negative', g('negative', ''));
  selectModel(g('model', ''));
  setV('sel-vae',      g('vae',      ''));
  setV('inp-width',    g('width',    '1024'));
  setV('inp-height',   g('height',   '1024'));
  setSl('sl-steps', 'inp-steps', 'lbl-steps', g('steps',  '20'));
  setSl('sl-cfg',   'inp-cfg',   'lbl-cfg',   g('cfg',    '7'));
  setV('inp-seed',     g('seed',    '-1'));
  setV('sel-sampler',  g('sampler',  ''));
  setV('sel-scheduler',g('scheduler',''));
  setCount(g('count', '1'));

  // Refiner
  const refEn = g('refinerEnabled', false);
  $('chk-refiner').checked            = refEn;
  $('refiner-fields').style.display   = refEn ? '' : 'none';
  setV('sel-refiner-model',   g('refinerModel',  ''));
  setV('sel-refiner-method',  g('refinerMethod', ''));
  setSl('sl-refiner-scale', 'inp-refiner-scale', 'lbl-refiner-scale', g('refinerScale','1.5'), v => v.toFixed(2)+'×');
  setSl('sl-refiner-pct',   'inp-refiner-pct',   'lbl-refiner-pct',   g('refinerPct',  '0.6'), v => Math.round(v*100)+'%');
  setSl('sl-refiner-steps', 'inp-refiner-steps', 'lbl-refiner-steps', g('refinerSteps','10'));
  setSl('sl-refiner-cfg',   'inp-refiner-cfg',   'lbl-refiner-cfg',   g('refinerCfg',  '7'));

  // ControlNet
  const cnEn = g('cnEnabled', false);
  $('chk-cn').checked              = cnEn;
  $('cn-fields').style.display     = cnEn ? '' : 'none';
  setV('sel-cn-model',    g('cnModel',   ''));
  setV('sel-cn-type',     g('cnType',    'none'));
  setSl('sl-cn-strength','inp-cn-strength','lbl-cn-strength', g('cnStrength','1'), v => v.toFixed(2));
  setSl('sl-cn-start',   'inp-cn-start',  'lbl-cn-start',    g('cnStart',  '0'), v => Math.round(v*100)+'%');
  setSl('sl-cn-end',     'inp-cn-end',    'lbl-cn-end',       g('cnEnd',    '1'), v => Math.round(v*100)+'%');
  const cnImg = g('cnImage', null);
  if (cnImg) setCNImage(cnImg); else clearCNImage();
  RegionalPrompt.regions = (g('regionalPrompts', []) || []).map(r => ({ ...r }));
  RegionalPrompt.selectedId = null;
  renderRegions();
  updateRegionsFieldVisibility();

  // LoRAs
  $('lora-list').innerHTML = '';
  App.loraItems = [];
  const loras = g('loras', []);
  loras.forEach(l => {
    if (!l.model) return;
    addLoRAItem();
    const item = App.loraItems[App.loraItems.length - 1];
    item.model  = l.model;
    item.weight = Number.isNaN(parseFloat(l.weight)) ? 1 : parseFloat(l.weight);
    const div   = $('lora-list').lastElementChild;
    if (div) {
      const sel = div.querySelector('.lora-sel');   if (sel) setLoraSelValue(sel, l.model);
      const sl  = div.querySelector('.lora-weight-sl');  if (sl)  sl.value  = item.weight;
      const inp = div.querySelector('.lora-weight-inp'); if (inp) inp.value = item.weight;
    }
  });
}

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
    loadLoRAs().catch(e => { console.warn('loadLoRAs:', e); App.loraModels = []; refreshLoraChoices(); }),
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
    updateCNUnionVisibility();
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
    App.models = d.files || [];
    renderFamilyChips();
    renderModelOptions(localStorage.getItem('swarm-model') || '');
    refreshLoraChoices();
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
  const d = await API.listLoRAs();
  App.loraModels = d.files || d.models || [];
  refreshLoraChoices();
  return App.loraModels.length;
}

async function loadParams() {
  try {
    const [d, status] = await Promise.all([API.listParams(), API.getStatus().catch(() => null)]);
    const params = d.list || [];
    App.supportedFeatures = Array.isArray(status?.supported_features) ? new Set(status.supported_features) : null;
    renderExtensionGroups(params, d.groups || []);

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
    const sel = $('sel-refiner-method');
    const upscaleVals = upscaleMethodParam?.values?.length ? upscaleMethodParam.values : [
      'pixel-lanczos','pixel-bicubic','pixel-bilinear','pixel-nearest',
      'model-remacri_original.pth','model-4x-UltraSharp.pth','model-ESRGAN_4x.pth',
    ];
    {
      const saved = localStorage.getItem('swarm-upscale-method') || 'model-remacri_original.pth';
      sel.innerHTML = upscaleVals.map(v =>
        `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(friendlyUpscaleName(v))}</option>`
      ).join('');
    }

    // Union ControlNets (controlnet++ promax…): SwarmUI param "ControlNet Union Type" → "controlnetuniontype"
    const unionParam = params.find(p => p.id === 'controlnetuniontype');
    App.cnUnionTypes = (unionParam?.values || []).filter(v => v !== 'auto');
    $('sel-cn-union').innerHTML = '<option value="">Auto (d\'après le préprocesseur)</option>' +
      App.cnUnionTypes.map(v => `<option value="${esc(v)}">${esc(v)}</option>`).join('');
    updateCNUnionVisibility();

    // CN preprocessors: SwarmUI param "ControlNet Preprocessor" → id "controlnetpreprocessor"
    const cnProcParam = params.find(p => p.id === 'controlnetpreprocessor');
    const cnSel  = $('sel-cn-type');
    const cnHint = $('cn-preproc-hint');
    if (cnProcParam?.values?.length) {
      const saved = localStorage.getItem('swarm-cn-preprocessor') || 'None';
      cnSel.innerHTML = cnProcParam.values.map(v =>
        `<option value="${esc(v)}"${v === saved ? ' selected' : ''}>${esc(friendlyProcName(v))}</option>`
      ).join('');
      cnSel.disabled = false;
      // Backend reports only "None": ComfyUI hasn't found any preprocessor node (fresh install, missing
      // comfyui_controlnet_aux extension, or backend still scanning) — not something this app can fix.
      cnHint.textContent = cnProcParam.values.length > 1
        ? ''
        : 'Seul "None" est disponible — le backend ComfyUI ne rapporte aucun nœud de préprocesseur (réinstallation récente ? extension comfyui_controlnet_aux manquante ?). Essaie ↻, sinon vérifie côté SwarmUI/ComfyUI.';
    } else {
      cnSel.innerHTML = '<option value="">— Non disponible —</option>';
      cnSel.disabled = true;
      cnHint.textContent = params.length
        ? 'Paramètre "ControlNet Preprocessor" absent de la réponse SwarmUI (permission manquante côté serveur ?).'
        : '';
      console.info('[loadParams] available param IDs:', params.map(p => p.id).join(', '));
    }
    // Loaded while ComfyUI was (re)starting: preprocessors/extension nodes aren't reported yet — retry until it's up
    scheduleParamsRetry(cnProcParam?.values?.length > 1 && status?.backend_status?.status === 'running');
  } catch (e) { console.warn('loadParams:', e); }
}

const _paramsRetry = { timer: null, tries: 0 };
function scheduleParamsRetry(ready) {
  clearTimeout(_paramsRetry.timer);
  if (ready) { _paramsRetry.tries = 0; return; }
  if (++_paramsRetry.tries > 36) return;   // give up after ~3 min, ↻ still works
  _paramsRetry.timer = setTimeout(loadParams, 5000);
}

function friendlyUpscaleName(v) {
  if (!v) return v;
  if (v.startsWith('pixel-')) {
    const method = v.slice(6);
    return 'Pixel — ' + method.charAt(0).toUpperCase() + method.slice(1);
  }
  if (v.startsWith('model-')) {
    const file = v.slice(6).replace(/\.[^.]+$/, ''); // strip extension
    return 'Model — ' + file;
  }
  return v;
}

// A union ControlNet follows whatever its "type" says; SwarmUI only sets it when asked
// (SetUnionControlNetType), so derive it from the preprocessor unless the user picked one.
function isUnionCN(model) { return /union/i.test(model || ''); }
function updateCNUnionVisibility() {
  $('cn-union-field').style.display = isUnionCN($('sel-cn-model').value) && (App.cnUnionTypes || []).length ? '' : 'none';
}
$('sel-cn-model').addEventListener('change', updateCNUnionVisibility);
function guessUnionType(proc) {
  const n = (proc || '').toLowerCase();
  const pick = n === '' || n === 'none' ? ''
    : /pose|^dw/.test(n) ? 'openpose'
    : /normal/.test(n) ? 'normal'
    : /depth|zoe|midas|leres|metric3d/.test(n) ? 'depth'
    : /canny|lineart|line_art|mlsd/.test(n) ? 'canny/lineart/anime_lineart/mlsd'
    : /hed|pidi|scribble|teed|softedge/.test(n) ? 'hed/pidi/scribble/ted'
    : /seg|oneformer|uniformer/.test(n) ? 'segment'
    : /tile/.test(n) ? 'tile' : '';
  return (App.cnUnionTypes || []).includes(pick) ? pick : '';
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

// ── Reference images ("Prompt Images") ────────────────────────────────────────
// SwarmUI's `promptimages` param takes data URLs joined by "|". Edit modes such as KGW Ostris Edit /
// Krea2Edit read the reference from here; nothing is sent when the list is empty.
App.refImages = [];
const REF_IMAGES_MAX = 4;

function renderRefImages() {
  const list = $('refimg-list');
  list.innerHTML = '';
  App.refImages.forEach((url, i) => {
    const el = document.createElement('div');
    el.className = 'refimg-item';
    el.innerHTML = '<img alt=""><span class="refimg-n"></span><button type="button" class="refimg-del" title="Retirer">✕</button>';
    el.querySelector('img').src = url;
    el.querySelector('.refimg-n').textContent = String(i + 1);
    el.querySelector('.refimg-del').addEventListener('click', () => { App.refImages.splice(i, 1); renderRefImages(); });
    list.appendChild(el);
  });
}

function addRefImages(fileList) {
  const files = [...fileList].filter(f => f.type.startsWith('image/'));
  const room = REF_IMAGES_MAX - App.refImages.length;
  if (files.length > room) toast(`${REF_IMAGES_MAX} images de référence maximum`);
  files.slice(0, Math.max(0, room)).forEach(file => {
    const r = new FileReader();
    r.onload = ev => { App.refImages.push(ev.target.result); renderRefImages(); };
    r.readAsDataURL(file);
  });
}

$('refimg-add').addEventListener('click', () => $('refimg-file').click());
$('refimg-file').addEventListener('change', e => { addRefImages(e.target.files); e.target.value = ''; });
['dragover', 'dragenter'].forEach(ev => $('sec-refimg').addEventListener(ev, e => { e.preventDefault(); $('sec-refimg').classList.add('dragover'); }));
['dragleave', 'drop'].forEach(ev => $('sec-refimg').addEventListener(ev, () => $('sec-refimg').classList.remove('dragover')));
$('sec-refimg').addEventListener('drop', e => { e.preventDefault(); addRefImages(e.dataTransfer.files); });

// ── Extensions panel ──────────────────────────────────────────────────────────
// Generic renderer for any SwarmUI/ComfyUI-extension parameter group we don't already
// have dedicated UI for (Model, LoRAs, ControlNet, Refiner, Regional Prompting via tags, …).
// Reads param metadata straight from /API/ListT2IParams — never hardcodes a param name —
// so any extension the user installs (present or future) shows up automatically.
const EXT_BUILTIN_GROUP_IDS = new Set([
  'imageprompting', 'coreparameters', 'texttovideo', 'texttoaudio', 'variationseed',
  'resolution', 'sampling', 'initimage', 'refineupscale', 'refinerparamoverrides',
  'controlnet', 'controlnettwo', 'controlnetthree', 'imagetovideo', 'advancedvideo',
  'videoobscureoptions', 'videoextend', 'advancedmodeladdons', 'swarminternal',
  'segmentrefining', 'segmentparamoverrides', 'advancedsampling', 'alternateguidance',
  'freeu', 'otherfixes', 'starred', 'usergroupone', 'usergrouptwo', 'usergroupthree',
]);

// { [groupId]: { enabled, params: { [paramId]: { value, enabled } } } }
App.extGroups = {};

function extDefaultValue(p) {
  if (p.type === 'boolean') return p.default === 'true' || p.default === true;
  // A dropdown's default can be absent from its values (ReActor Face Mask Model: default
  // "face_yolov8m-seg_60.pt" but the server only lists "none"). The <select> then shows the
  // first value, so the stored value must match it — otherwise we'd send a model that isn't there.
  if (p.type === 'dropdown' && p.values?.length && !p.values.includes(p.default)) return p.values[0];
  return p.default ?? '';
}

function extGroupState(groupId) {
  return App.extGroups[groupId] || (App.extGroups[groupId] = { enabled: false, params: {} });
}

// Flags que SwarmUI a refusés à l'installation ("Unknown feature ID") : ce ne sont pas des nœuds ComfyUI
const nonInstallableFlags = new Set();

function extParamState(groupId, p) {
  const g = extGroupState(groupId);
  return g.params[p.id] || (g.params[p.id] = { value: extDefaultValue(p), enabled: false });
}

function extParamControlHtml(p, val) {
  const id = `ext-ctl-${p.id}`;
  if (p.type === 'boolean') {
    return `<input type="checkbox" id="${id}" ${val ? 'checked' : ''}>`;
  }
  if (p.type === 'integer' || p.type === 'decimal') {
    // view_min/view_max = the range SwarmUI's own slider shows; min/max can be huge (KGW Ref Boost: 0..1000, view 0..5).
    // SwarmUI sends view_min = view_max = 0 when a param doesn't set them (ReActor Face Restore Visibility):
    // that 0..0 range pinned the slider to 0 and sent visibility 0 → black image. Only use a real view range.
    const hasView = p.view_max != null && p.view_min != null && p.view_max > p.view_min;
    const min  = hasView ? p.view_min : (p.min ?? 0);
    const max  = hasView ? p.view_max : (p.max ?? (p.type === 'integer' ? 100 : 10));
    const step = p.step || (p.type === 'integer' ? 1 : 0.05);
    return `
      <div class="slider-row">
        <input type="range" class="slider" id="${id}-sl" min="${min}" max="${max}" step="${step}" value="${val}">
        <input type="text"  class="inp"    id="${id}"    value="${val}" style="width:70px;text-align:center">
      </div>`;
  }
  if (p.type === 'dropdown' && p.values?.length) {
    const names = p.value_names?.length === p.values.length ? p.value_names : p.values;
    return `<select class="inp" id="${id}">${p.values.map((v, i) =>
      `<option value="${esc(v)}"${v === val ? ' selected' : ''}>${esc(names[i] || v)}</option>`).join('')}</select>`;
  }
  if (p.type === 'image') {
    // Preview is filled in by the wiring code (no multi-MB data URL inside innerHTML)
    return `<div class="ext-img" id="${id}" title="Clique ou glisse une image">
      <img class="ext-img-prev" alt="" hidden>
      <span class="ext-img-ph">Clique, glisse ou colle (⌘V)</span>
      <button type="button" class="ext-img-clear" title="Retirer" hidden>✕</button>
      <input type="file" accept="image/*" hidden>
    </div>`;
  }
  // text, model, list, and anything else not worth bespoke UI: plain text input
  return `<input type="text" class="inp" id="${id}" value="${esc(val ?? '')}" placeholder="${esc(p.default ?? '')}">`;
}

function renderExtensionGroups(params, groups) {
  App._extLast = { params, groups };   // pour ré-afficher l'état des extensions d'une tâche rouverte
  const groupById = new Map(groups.map(g => [g.id, g]));
  // Extensions often nest their features under one parent group ("Krea Gone Wild" > "KGW Rebalance")
  const groupTitle = g => {
    const parent = g.parent && groupById.get(g.parent);
    return parent && !EXT_BUILTIN_GROUP_IDS.has(parent.id) ? `${parent.name} › ${g.name}` : g.name;
  };
  const box  = $('ext-groups');
  const hint = $('ext-hint');
  const byGroupId = new Map();
  params.forEach(p => {
    if (!p.group || EXT_BUILTIN_GROUP_IDS.has(p.group)) return;
    (byGroupId.get(p.group) || byGroupId.set(p.group, []).get(p.group)).push(p);
  });
  const relevantGroups = groups
    .filter(g => byGroupId.has(g.id))
    .sort((a, b) => a.priority - b.priority);

  if (!relevantGroups.length) {
    box.innerHTML = '';
    hint.textContent = params.length
      ? 'Aucune extension avec des paramètres de génération détectée sur ce SwarmUI.'
      : 'Connecte-toi puis ↻ pour détecter les extensions installées sur ton SwarmUI.';
    return;
  }
  hint.textContent = `${relevantGroups.length} groupe${relevantGroups.length > 1 ? 's' : ''} d'extension détecté${relevantGroups.length > 1 ? 's' : ''} : ${relevantGroups.map(groupTitle).join(', ')}`;

  box.innerHTML = relevantGroups.map(g => {
    const gState = extGroupState(g.id);
    const ps = byGroupId.get(g.id).sort((a, b) => a.priority - b.priority);
    // Feature flags SwarmUI says the backend doesn't have (e.g. a ComfyUI node pack that isn't installed).
    // Generating with such a param is refused by SwarmUI ("Request requires flag … not present on the backend").
    gState.missing = App.supportedFeatures
      ? [...new Set(ps.map(p => p.feature_flag).filter(f => f && !App.supportedFeatures.has(f)))]
      : [];
    const installable = gState.missing.filter(f => !nonInstallableFlags.has(f));
    const unavailable = gState.missing.filter(f => nonInstallableFlags.has(f));
    const rowHtml = p => {
      const pState = extParamState(g.id, p);
      const needsOwnToggle = p.toggleable && p.type !== 'boolean';
      return `
        <div class="ext-param-row" data-param="${esc(p.id)}">
          <div class="ext-param-row-top">
            ${needsOwnToggle ? `<input type="checkbox" class="ext-param-en" ${pState.enabled ? 'checked' : ''} title="Activer ce réglage">` : ''}
            <div class="field-label" title="${esc(p.description || '')}">${esc(p.name)}</div>
          </div>
          ${extParamControlHtml(p, pState.value)}
        </div>`;
    };
    // Advanced params (SwarmUI's own "advanced" flag) folded away so big groups like ReActor stay readable
    const adv = ps.filter(p => p.advanced);
    const rows = ps.filter(p => !p.advanced).map(rowHtml).join('') +
      (adv.length ? `<details class="ext-adv"><summary>Avancé (${adv.length})</summary>${adv.map(rowHtml).join('')}</details>` : '');
    return `
      <div class="ext-group" data-group="${esc(g.id)}">
        <div class="ext-group-hdr">
          ${g.toggles ? `<label><input type="checkbox" class="ext-group-en" ${gState.enabled ? 'checked' : ''}> ${esc(groupTitle(g))}</label>` : `<span>${esc(groupTitle(g))}</span>`}
          ${installable.length ? `<button type="button" class="comic-tbtn ext-install" title="Nœud ComfyUI manquant sur le backend : ${esc(installable.join(', '))}">⚠ Installer</button>` : ''}
        </div>
        ${installable.length ? `<div class="field-hint ext-missing-hint">⚠ Non installé sur ton SwarmUI (${esc(installable.join(', '))}) — ce groupe est ignoré à la génération tant que ce n'est pas installé.</div>` : ''}
        ${unavailable.length ? `<div class="field-hint ext-missing-hint">ℹ Réglage lié à un backend ou une extension SwarmUI absente (${esc(unavailable.join(', '))}) — ce n'est pas un nœud ComfyUI, rien à installer ici. Ce groupe est ignoré à la génération.</div>` : ''}
        <div class="ext-group-body${g.toggles && !gState.enabled ? ' hidden' : ''}">${rows}</div>
      </div>`;
  }).join('');

  // Wire events (delegated per group so re-renders don't leak listeners)
  relevantGroups.forEach(g => {
    const groupEl = box.querySelector(`.ext-group[data-group="${CSS.escape(g.id)}"]`);
    const body    = groupEl.querySelector('.ext-group-body');
    const enCk    = groupEl.querySelector('.ext-group-en');
    const instBtn = groupEl.querySelector('.ext-install');
    if (instBtn) instBtn.addEventListener('click', async () => {
      const missing = extGroupState(g.id).missing.filter(f => !nonInstallableFlags.has(f));
      if (!confirm(`Installer sur ton SwarmUI : ${missing.join(', ')} ?\n\nSwarmUI va télécharger le nœud ComfyUI depuis GitHub puis redémarrer ComfyUI.`)) return;
      instBtn.disabled = true; instBtn.textContent = 'Installation…';
      try {
        const r = await API.installComfyFeatures(missing.join(','));
        if (r?.error) throw new Error(r.error);
        toast('✅ Installation lancée — attends que ComfyUI redémarre, puis clique ↻');
      } catch (e) {
        if (/unknown feature id/i.test(e.message)) {
          missing.forEach(f => nonInstallableFlags.add(f));
          showErrorToast(`Rien à installer : ${missing.join(', ')} n'est pas un nœud ComfyUI (backend ou extension SwarmUI absente)`);
          if (App._extLast) renderExtensionGroups(App._extLast.params, App._extLast.groups);
          return;
        }
        showErrorToast(`Installation : ${e.message}`);
      } finally {
        instBtn.disabled = false; instBtn.textContent = '⚠ Installer';
      }
    });
    if (enCk) enCk.addEventListener('change', () => {
      extGroupState(g.id).enabled = enCk.checked;
      body.classList.toggle('hidden', !enCk.checked);
    });
    byGroupId.get(g.id).forEach(p => {
      const row    = groupEl.querySelector(`.ext-param-row[data-param="${CSS.escape(p.id)}"]`);
      const pState = extParamState(g.id, p);
      const ownEn  = row.querySelector('.ext-param-en');
      if (ownEn) ownEn.addEventListener('change', () => { pState.enabled = ownEn.checked; });
      const id = `ext-ctl-${p.id}`;
      if (p.type === 'boolean') {
        row.querySelector(`#${CSS.escape(id)}`).addEventListener('change', e => { pState.value = e.target.checked; });
      } else if (p.type === 'integer' || p.type === 'decimal') {
        const sl = row.querySelector(`#${CSS.escape(id)}-sl`), inp = row.querySelector(`#${CSS.escape(id)}`);
        const clamp = v => {
          let n = parseFloat(v);
          if (!Number.isFinite(n)) n = parseFloat(extDefaultValue(p)) || 0;
          if (p.max > p.min) n = Math.min(p.max, Math.max(p.min, n));
          return String(n);
        };
        sl.addEventListener('input', () => { pState.value = clamp(sl.value); inp.value = pState.value; });
        inp.addEventListener('change', () => { pState.value = clamp(inp.value); inp.value = pState.value; sl.value = pState.value; });
      } else if (p.type === 'image') {
        const box  = row.querySelector(`#${CSS.escape(id)}`);
        const prev = box.querySelector('.ext-img-prev'), ph = box.querySelector('.ext-img-ph');
        const clr  = box.querySelector('.ext-img-clear'), fi = box.querySelector('input[type=file]');
        const show = () => {
          const has = !!pState.value;
          prev.hidden = !has; ph.hidden = has; clr.hidden = !has;
          if (has) prev.src = pState.value; else prev.removeAttribute('src');
        };
        // Picking an image also ticks the param's own checkbox (ReActor "Face Image" is toggleable):
        // otherwise the image was chosen but silently never sent.
        const setFile = file => {
          if (!file || !file.type.startsWith('image/')) return;
          const r = new FileReader();
          r.onload = ev => {
            pState.value = ev.target.result;
            if (ownEn) { ownEn.checked = true; pState.enabled = true; }
            show();
          };
          r.readAsDataURL(file);
        };
        box.addEventListener('click', e => { if (e.target !== clr && e.target !== fi) fi.click(); });
        fi.addEventListener('change', e => { setFile(e.target.files[0]); e.target.value = ''; });
        box.addEventListener('dragover', e => e.preventDefault());
        box.addEventListener('drop', e => { e.preventDefault(); setFile(e.dataTransfer.files[0]); });
        clr.addEventListener('click', e => {
          e.stopPropagation();
          pState.value = '';
          if (ownEn) { ownEn.checked = false; pState.enabled = false; }
          show();
        });
        show();
      } else {
        row.querySelector(`#${CSS.escape(id)}`).addEventListener(p.type === 'dropdown' ? 'change' : 'input', e => { pState.value = e.target.value; });
      }
    });
  });
}

// Merges every enabled extension param into the generation payload, keyed by its real SwarmUI param id
function buildExtensionParamsPayload() {
  const out = {};
  const skipped = [];
  for (const [groupId, g] of Object.entries(App.extGroups)) {
    const groupInfo = document.querySelector(`.ext-group[data-group="${CSS.escape(groupId)}"]`);
    const groupTogglesOn = groupInfo ? !!groupInfo.querySelector('.ext-group-en') : false;
    if (groupTogglesOn && !g.enabled) continue;
    if (g.missing?.length && groupInfo) {
      skipped.push(groupInfo.querySelector('.ext-group-hdr').textContent.replace('⚠ Installer', '').trim());
      continue;
    }
    for (const [paramId, pState] of Object.entries(g.params)) {
      const row = groupInfo?.querySelector(`.ext-param-row[data-param="${CSS.escape(paramId)}"]`);
      const needsOwnToggle = row?.querySelector('.ext-param-en');
      if (needsOwnToggle && !pState.enabled) continue;
      // Empty = "use SwarmUI's default"; an empty image value would even be rejected as invalid base64
      if (pState.value === '' || pState.value == null) continue;
      out[paramId] = pState.value;
    }
  }
  if (skipped.length) toast(`⚠ Ignoré (nœud ComfyUI non installé) : ${skipped.join(', ')}`);
  return out;
}

$('btn-reload-ext').addEventListener('click', async () => {
  if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
  const btn = $('btn-reload-ext');
  btn.style.opacity = '0.4';
  btn.style.pointerEvents = 'none';
  try {
    await API.triggerRefresh(true);
    await loadParams();
    toast('✅ Extensions rechargées');
  } catch (e) {
    showErrorToast(`Reload extensions: ${e.message}`);
  } finally {
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
  }
});

// ── Nombre d'images : boutons 1/2/4/8 + champ « autre », qui pilotent le <select> caché ──
// Une valeur hors 1/2/4/8 est ajoutée au <select> comme option « custom », pour que la génération,
// les presets et les instances la lisent comme n'importe quelle autre.

function setCount(v) {
  const n = String(Math.max(1, Math.min(100, parseInt(v, 10) || 1)));
  const sel = $('sel-count');
  if (!['1', '2', '4', '8'].includes(n)) {
    let opt = sel.querySelector('option[data-custom]');
    if (!opt) { opt = document.createElement('option'); opt.dataset.custom = '1'; sel.appendChild(opt); }
    opt.value = opt.textContent = n;
  }
  sel.value = n;
  syncCountSeg();
}

function syncCountSeg() {
  const v = $('sel-count').value;
  const custom = !['1', '2', '4', '8'].includes(v);
  document.querySelectorAll('#seg-count button').forEach(b => b.classList.toggle('active', b.dataset.v === v));
  const ci = $('inp-count-custom');
  ci.classList.toggle('active', custom);
  if (custom) ci.value = v;
  else if (document.activeElement !== ci) ci.value = '';
}

document.querySelectorAll('#seg-count button').forEach(b => b.addEventListener('click', () => {
  $('inp-count-custom').value = '';
  setCount(b.dataset.v);
}));
$('inp-count-custom').addEventListener('input', e => { if (parseInt(e.target.value, 10) > 0) setCount(e.target.value); });
$('inp-count-custom').addEventListener('change', e => { if (e.target.value !== '') setCount(e.target.value); });
$('inp-count-custom').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });
$('sel-count').addEventListener('change', syncCountSeg);   // ex. l'onglet Twitter qui règle 4 images
syncCountSeg();

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
// Interrupteur dans l'en-tête d'un module (Refiner, ControlNet) : l'activer ouvre sa section
[['chk-refiner', 'refiner'], ['chk-cn', 'cn']].forEach(([chk, key]) => {
  $(chk).addEventListener('change', () => {
    if (!$(chk).checked) return;
    $('sec-' + key).classList.remove('hidden');
    document.querySelector(`.sidebar-section-hdr[data-section="${key}"]`)?.classList.remove('collapsed');
  });
});

$('chk-refiner').addEventListener('change', () => {
  $('refiner-fields').style.display = $('chk-refiner').checked ? '' : 'none';
});

// ── ControlNet image ──────────────────────────────────────────────────────────
$('chk-cn').addEventListener('change', () => {
  $('cn-fields').style.display = $('chk-cn').checked ? '' : 'none';
  updateRegionsFieldVisibility();
});

let _cnImageData = null;
let _stallTimer   = null;

function setCNImage(dataUrl) {
  _cnImageData = dataUrl;
  $('cn-img-preview').src = dataUrl;
  $('cn-img-preview-wrap').style.display = '';
  $('cn-img-drop').textContent = 'Image loaded ✓';
  $('cn-img-drop').style.borderColor = 'var(--green)';
  $('cn-img-clear').style.display = '';
  updateRegionsFieldVisibility();
}

function clearCNImage() {
  _cnImageData = null;
  $('cn-img-preview-wrap').style.display = 'none';
  $('cn-img-preview').src = '';
  $('cn-img-drop').textContent = 'Click or drop an image';
  $('cn-img-drop').style.borderColor = '';
  $('cn-img-clear').style.display = 'none';
  RegionalPrompt.regions = [];
  RegionalPrompt.selectedId = null;
  renderRegions();
  updateRegionsFieldVisibility();
}

// ── Regional Prompting (draw prompt-per-zone rectangles on the CN image) ──────
// SwarmUI reads these as native prompt tags — no extra API param, just text
// prepended to the prompt string (see docs/Features/Prompt Syntax.md):
//   <region:x,y,w,h,strength> prompt      — alternate prompt for a zone
//   <object:x,y,w,h,strength,strength2>   — same, plus an automatic inpaint pass
const REGION_COLORS = ['#58a6ff', '#f85149', '#3fb950', '#d29922', '#bc8cff', '#ff7b72', '#39c5cf', '#ffa657'];
const RegionalPrompt = { regions: [], selectedId: null, _nextId: 1 };
let _regionDrag = null;

function rpFindRegion(id) { return RegionalPrompt.regions.find(r => r.id === id); }
function rpColorFor(i) { return REGION_COLORS[i % REGION_COLORS.length]; }

function updateRegionsFieldVisibility() {
  $('cn-regions-field').style.display = ($('chk-cn').checked && _cnImageData) ? '' : 'none';
}

function addRegion() {
  const region = { id: 'rg_' + (RegionalPrompt._nextId++), x: 0.25, y: 0.25, w: 0.5, h: 0.5, mode: 'region', prompt: '', strength: 0.7, strength2: 0.5 };
  RegionalPrompt.regions.push(region);
  RegionalPrompt.selectedId = region.id;
  renderRegions();
}

function removeRegion(id) {
  RegionalPrompt.regions = RegionalPrompt.regions.filter(r => r.id !== id);
  if (RegionalPrompt.selectedId === id) RegionalPrompt.selectedId = null;
  renderRegions();
}

function selectRegion(id) {
  RegionalPrompt.selectedId = id;
  renderRegions();
}

function renderRegions() {
  const overlay = $('cn-regions-overlay');
  const list    = $('cn-regions-list');
  if (!overlay || !list) return;
  overlay.innerHTML = '';
  list.innerHTML = '';

  RegionalPrompt.regions.forEach((r, i) => {
    const color = rpColorFor(i);

    const box = document.createElement('div');
    box.className = 'cn-region-box' + (r.id === RegionalPrompt.selectedId ? ' selected' : '');
    box.dataset.regionId = r.id;
    box.style.setProperty('--region-color', color);
    box.style.left   = (r.x * 100) + '%';
    box.style.top    = (r.y * 100) + '%';
    box.style.width  = (r.w * 100) + '%';
    box.style.height = (r.h * 100) + '%';
    box.innerHTML = `<span class="cn-region-badge">${i + 1}</span>`;
    ['nw', 'ne', 'sw', 'se'].forEach(corner => {
      const h = document.createElement('div');
      h.className = 'cn-region-handle';
      h.dataset.corner = corner;
      h.addEventListener('mousedown', e => { e.stopPropagation(); startRegionDrag(e, r.id, 'resize', corner); });
      box.appendChild(h);
    });
    box.addEventListener('mousedown', e => {
      if (e.target.classList.contains('cn-region-handle')) return;
      startRegionDrag(e, r.id, 'move');
    });
    overlay.appendChild(box);

    const row = document.createElement('div');
    row.className = 'cn-region-row' + (r.id === RegionalPrompt.selectedId ? ' selected' : '');
    row.innerHTML = `
      <div class="cn-region-row-hdr">
        <span class="cn-region-badge" style="position:static;background:${color}">${i + 1}</span>
        <textarea placeholder="Prompt de la zone…">${esc(r.prompt)}</textarea>
      </div>
      <div class="cn-region-row-controls">
        <select class="inp cn-region-mode">
          <option value="region"${r.mode === 'region' ? ' selected' : ''}>Region</option>
          <option value="object"${r.mode === 'object' ? ' selected' : ''}>Object (+ inpaint)</option>
        </select>
        <label>Strength <input type="range" min="0" max="2" step="0.05" value="${r.strength}" class="cn-region-strength"></label>
        <label class="cn-region-strength2-wrap" style="display:${r.mode === 'object' ? '' : 'none'}">Strength2 <input type="range" min="0" max="1" step="0.05" value="${r.strength2}" class="cn-region-strength2"></label>
        <button class="btn-sm cn-region-del" title="Supprimer">✕</button>
      </div>`;
    row.addEventListener('click', e => {
      if (e.target.closest('textarea, select, input, button')) return;
      selectRegion(r.id);
    });
    row.querySelector('textarea').addEventListener('input', function () { r.prompt = this.value; });
    row.querySelector('.cn-region-mode').addEventListener('change', function () {
      r.mode = this.value;
      row.querySelector('.cn-region-strength2-wrap').style.display = r.mode === 'object' ? '' : 'none';
    });
    row.querySelector('.cn-region-strength').addEventListener('input', function () { r.strength = +this.value; });
    row.querySelector('.cn-region-strength2')?.addEventListener('input', function () { r.strength2 = +this.value; });
    row.querySelector('.cn-region-del').addEventListener('click', () => removeRegion(r.id));
    list.appendChild(row);
  });
}

function startRegionDrag(e, id, mode, corner) {
  e.preventDefault();
  const region = rpFindRegion(id);
  if (!region) return;
  selectRegion(id); // re-renders once at drag start (selection highlight + handles)
  const rect = $('cn-img-preview-wrap').getBoundingClientRect();
  const boxEl = $('cn-regions-overlay').querySelector(`.cn-region-box[data-region-id="${id}"]`);
  _regionDrag = {
    mode, corner, region, boxEl,
    startX: e.clientX, startY: e.clientY, rectW: rect.width, rectH: rect.height,
    orig: { x: region.x, y: region.y, w: region.w, h: region.h },
  };
}

document.addEventListener('mousemove', e => {
  const d = _regionDrag;
  if (!d) return;
  const dxFrac = (e.clientX - d.startX) / d.rectW;
  const dyFrac = (e.clientY - d.startY) / d.rectH;
  const MIN = 0.03;
  let { x, y, w, h } = d.orig;
  if (d.mode === 'move') {
    x = Math.min(1 - w, Math.max(0, d.orig.x + dxFrac));
    y = Math.min(1 - h, Math.max(0, d.orig.y + dyFrac));
  } else {
    if (d.corner.includes('e')) w = Math.max(MIN, Math.min(1 - x, d.orig.w + dxFrac));
    if (d.corner.includes('s')) h = Math.max(MIN, Math.min(1 - y, d.orig.h + dyFrac));
    if (d.corner.includes('w')) {
      const newX = Math.max(0, Math.min(d.orig.x + d.orig.w - MIN, d.orig.x + dxFrac));
      w = d.orig.x + d.orig.w - newX; x = newX;
    }
    if (d.corner.includes('n')) {
      const newY = Math.max(0, Math.min(d.orig.y + d.orig.h - MIN, d.orig.y + dyFrac));
      h = d.orig.y + d.orig.h - newY; y = newY;
    }
  }
  d.region.x = x; d.region.y = y; d.region.w = w; d.region.h = h;
  if (d.boxEl) {
    d.boxEl.style.left   = (x * 100) + '%';
    d.boxEl.style.top    = (y * 100) + '%';
    d.boxEl.style.width  = (w * 100) + '%';
    d.boxEl.style.height = (h * 100) + '%';
  }
});
document.addEventListener('mouseup', () => { _regionDrag = null; });

$('cn-regions-overlay').addEventListener('mousedown', e => {
  if (e.target === $('cn-regions-overlay')) { RegionalPrompt.selectedId = null; renderRegions(); }
});
$('cn-regions-add').addEventListener('click', addRegion);

function buildRegionalPromptSuffix() {
  if (!$('chk-cn').checked || !_cnImageData || !RegionalPrompt.regions.length) return '';
  const tagged = RegionalPrompt.regions.filter(r => r.prompt.trim()).map(r => {
    const tag = r.mode === 'object' ? 'object' : 'region';
    const nums = r.mode === 'object'
      ? [r.x, r.y, r.w, r.h, r.strength, r.strength2]
      : [r.x, r.y, r.w, r.h, r.strength];
    return `<${tag}:${nums.map(n => +n.toFixed(3)).join(',')}> ${r.prompt.trim()}`;
  });
  return tagged.length ? ' ' + tagged.join(' ') : '';
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

// Coller une image (⌘V) : géré pour toutes les zones par src/pasteTargets.js

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
// Seulement les formats de Txt2Img : l'onglet Edit a ses propres boutons .ratio-btn
document.querySelectorAll('#ratio-grid .ratio-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#ratio-grid .ratio-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    $('inp-width').value  = btn.dataset.w;
    $('inp-height').value = btn.dataset.h;
  });
});

// set default active
(function () {
  const first = document.querySelector('#ratio-grid .ratio-btn[data-w="1152"][data-h="768"]');
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
// Family = SwarmUI's compat_class (same for a checkpoint and its LoRAs: 'flux-1', 'krea-2', …)
const FAMILY_LABELS = {
  'stable-diffusion-xl-v1': 'SDXL / Illustrious',
  'stable-diffusion-xl-v1-refiner': 'SDXL Refiner',
  'stable-diffusion-v1': 'SD 1.5',
  'stable-diffusion-v2': 'SD 2',
  'stable-diffusion-v3-medium': 'SD3 Medium',
  'stable-diffusion-v3.5-large': 'SD 3.5 Large',
  'stable-diffusion-v3.5-medium': 'SD 3.5 Medium',
  'flux-1': 'Flux.1',
  'flux-2': 'Flux.2',
  'krea-2': 'Krea 2',
  'qwen-image': 'Qwen Image',
  'qwen-image-2.1': 'Qwen Image 2.1',
};
const UNKNOWN_FAMILY = '?';

// Fallback when SwarmUI couldn't classify the file (e.g. LoRAs without recognisable keys): read the name/title
const FAMILY_GUESSES = [
  [/krea/i, 'krea-2'],
  [/flux/i, 'flux-1'],
  [/illustrious|noob|pony|sdxl|\bxl\b/i, 'stable-diffusion-xl-v1'],
];

function modelFamily(f) {
  let id = f.compat_class || '';
  let guessed = false;
  if (!id) {
    const text = `${f.name} ${f.title || ''} ${f.description || ''}`;
    const hit = FAMILY_GUESSES.find(([re]) => re.test(text));
    if (hit) { id = hit[1]; guessed = true; }
  }
  if (!id) return { id: UNKNOWN_FAMILY, label: 'Inconnu', guessed };
  return { id, label: FAMILY_LABELS[id] || id.replace(/[-_]+/g, ' '), guessed };
}

function modelOptionHtml(f) {
  return `<option value="${esc(f.name)}">${esc(f.title || f.name)}</option>`;
}

function renderFamilyChips() {
  const box = $('model-family-chips');
  const fams = new Map();
  App.models.forEach(f => {
    const fam = modelFamily(f);
    const e = fams.get(fam.id) || { label: fam.label, n: 0 };
    e.n++; fams.set(fam.id, e);
  });
  if (App.modelFamily && !fams.has(App.modelFamily)) App.modelFamily = '';
  if (fams.size < 2) { box.style.display = 'none'; App.modelFamily = ''; return; }
  const chip = (id, label, n) =>
    `<button type="button" class="family-chip${App.modelFamily === id ? ' active' : ''}" data-fam="${esc(id)}">${esc(label)}<span>${n}</span></button>`;
  box.innerHTML = chip('', 'Tous', App.models.length) +
    [...fams.entries()].sort((a, b) => b[1].n - a[1].n).map(([id, e]) => chip(id, e.label, e.n)).join('');
  box.style.display = '';
}

// The selected checkpoint is always kept in the list, even when the chip would hide it
function renderModelOptions(keep = $('sel-model').value) {
  const sel = $('sel-model');
  const shown = App.modelFamily ? App.models.filter(f => modelFamily(f).id === App.modelFamily) : App.models;
  const extra = keep && !shown.some(f => f.name === keep) ? App.models.filter(f => f.name === keep) : [];
  sel.innerHTML = '<option value="">— Select model —</option>' + shown.concat(extra).map(modelOptionHtml).join('');
  if (keep) sel.value = keep;
}

function selectModel(name) {
  const sel = $('sel-model');
  if (name && ![...sel.options].some(o => o.value === name)) {
    const f = App.models.find(m => m.name === name);
    if (f) sel.insertAdjacentHTML('beforeend', modelOptionHtml(f));
  }
  sel.value = name || '';
  refreshLoraChoices();
}

function currentModelFamily() {
  const f = App.models.find(m => m.name === $('sel-model').value);
  return f ? modelFamily(f) : null;
}

// LoRAs of the selected checkpoint's family, plus any already in use
function loraChoices(keep) {
  const fam = currentModelFamily();
  if ($('chk-all-loras').checked || !fam || fam.id === UNKNOWN_FAMILY) return App.loraModels;
  return App.loraModels.filter(f => modelFamily(f).id === fam.id || keep.has(f.name));
}

function updateLoraFilterHint() {
  const hint = $('lora-filter-hint');
  const all = App.loraModels;
  const fam = currentModelFamily();
  if (!all.length) { hint.textContent = ''; return; }
  if ($('chk-all-loras').checked) { hint.textContent = `${all.length} LoRA affichés (filtre désactivé)`; return; }
  if (!fam) { hint.textContent = 'Choisis un modèle pour ne voir que ses LoRA compatibles'; return; }
  if (fam.id === UNKNOWN_FAMILY) { hint.textContent = 'Famille du modèle non détectée — tous les LoRA affichés'; return; }
  const fams = all.map(modelFamily);
  const n = fams.filter(x => x.id === fam.id).length;
  const guessed = fams.filter(x => x.id === fam.id && x.guessed).length;
  const hidden = fams.filter(x => x.id === UNKNOWN_FAMILY).length;
  hint.textContent = `${n} LoRA ${fam.label} sur ${all.length}` +
    (guessed ? ` (dont ${guessed} déduit${guessed > 1 ? 's' : ''} du nom)` : '') +
    (hidden ? ` · ${hidden} non classé${hidden > 1 ? 's' : ''} masqué${hidden > 1 ? 's' : ''}` : '');
}

function refreshLoraChoices() {
  updateLoraFilterHint();
  document.querySelectorAll('.lora-sel').forEach(populateLoRASelect);
}

function populateLoRASelect(sel) {
  const cur = sel.value;
  const keep = new Set(App.loraItems.map(i => i.model).filter(Boolean));
  if (cur) keep.add(cur);
  sel.innerHTML = '<option value="">— Select LoRA —</option>' +
    loraChoices(keep).map(f => {
      const label = f.title && f.title !== f.name ? `${f.name} — ${f.title}` : f.name;
      return `<option value="${esc(f.name)}">${esc(label)}</option>`;
    }).join('');
  if (cur) sel.value = cur;
}

// Restoring a saved LoRA must work even when the filter would hide it
function setLoraSelValue(sel, name) {
  if (name && ![...sel.options].some(o => o.value === name)) {
    sel.insertAdjacentHTML('beforeend', `<option value="${esc(name)}">${esc(name)}</option>`);
  }
  sel.value = name;
}

$('model-family-chips').addEventListener('click', e => {
  const btn = e.target.closest('.family-chip'); if (!btn) return;
  App.modelFamily = btn.dataset.fam;
  localStorage.setItem('swarm-model-family', App.modelFamily);
  renderFamilyChips();
  renderModelOptions();
});
$('sel-model').addEventListener('change', refreshLoraChoices);
$('chk-all-loras').addEventListener('change', refreshLoraChoices);

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
$('btn-reload-loras').addEventListener('click', async () => {
  if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
  const btn = $('btn-reload-loras');
  btn.style.opacity = '0.4';
  btn.style.pointerEvents = 'none';
  try {
    if (typeof TagComplete !== 'undefined') TagComplete.clearModelCache();
    await API.triggerRefresh(true);   // force SwarmUI to rescan disk first
    const count = await loadLoRAs();
    toast(`✅ ${count} LoRA${count !== 1 ? 's' : ''} chargé${count !== 1 ? 's' : ''}`);
  } catch (e) {
    showErrorToast(`Reload LoRAs: ${e.message}`);
  } finally {
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
  }
});

$('btn-reload-cn-preproc').addEventListener('click', async () => {
  if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
  const btn = $('btn-reload-cn-preproc');
  btn.style.opacity = '0.4';
  btn.style.pointerEvents = 'none';
  try {
    await API.triggerRefresh(true);   // rescans the ComfyUI backend's nodes, incl. preprocessors
    await loadParams();
    const n = $('sel-cn-type').options.length;
    toast(`✅ ${n} préprocesseur${n !== 1 ? 's' : ''} chargé${n !== 1 ? 's' : ''}`);
  } catch (e) {
    showErrorToast(`Reload preprocessors: ${e.message}`);
  } finally {
    btn.style.opacity = '';
    btn.style.pointerEvents = '';
  }
});

$('btn-free-forge-vram').addEventListener('click', async () => {
  const forgeUrl = (localStorage.getItem('forge-url') || '').replace(/\/$/, '');
  if (!forgeUrl) { showErrorToast('Aucune URL Forge enregistrée (configure-la dans Inpaint)'); return; }
  const btn = $('btn-free-forge-vram');
  btn.disabled = true;
  try {
    const resp = await fetch(`${forgeUrl}/sdapi/v1/unload-checkpoint`, { method: 'POST' });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    toast('✅ VRAM Forge libérée');
  } catch (e) {
    showErrorToast(`Forge injoignable: ${e.message}`);
  } finally {
    btn.disabled = false;
  }
});

// ── Generate ──────────────────────────────────────────────────────────────────
$('btn-queue-add').addEventListener('click', addTxt2ImgToQueue);
$('t2i-task-save').addEventListener('click', saveEditedTask);
$('t2i-task-cancel').addEventListener('click', () => { App.editingTask = null; updateTaskBanner(); });

$('btn-generate').addEventListener('click', () => {
  if (!App.connected) return;
  if (App.running) { stopGeneration(); return; }
  startGeneration();
});

// ── Requête complète de Txt2Img ──────────────────────────────────────────────
// Utilisée par Generate et par la file du Scheduler (« Ajouter à la file ») : une tâche envoie
// exactement ce que Txt2Img aurait envoyé. Renvoie null (avec un message) si les réglages sont incomplets.
function buildTxt2ImgPayload() {
  const prompt = $('inp-positive').value.trim();
  if (!prompt) { showErrorToast('Écris un prompt d\'abord.'); return null; }
  if ($('chk-cn').checked && !_cnImageData) {
    showErrorToast('ControlNet est activé mais aucune image n\'est chargée. Ajoute une image de contrôle ou désactive ControlNet.');
    return null;
  }

  // Build LoRA prompt suffix
  const loraSuffix = App.loraItems
    .filter(l => l.model)
    .map(l => `<lora:${l.model}:${l.weight}>`)
    .join(' ');

  const seedVal = parseInt($('inp-seed').value, 10);
  const seed = Number.isFinite(seedVal) ? seedVal : -1; // 0 is a valid seed (|| -1 used to turn it into random)

  const payload = {
    prompt:         prompt + (loraSuffix ? ' ' + loraSuffix : '') + buildRegionalPromptSuffix(),
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
    payload.refinercontrolpercentage  = Number.isNaN(parseFloat($('inp-refiner-pct').value)) ? 0.2 : parseFloat($('inp-refiner-pct').value);
    payload.refinerupscalemethod      = $('sel-refiner-method').value || 'pixel-lanczos';
    payload.refinersteps              = parseInt($('inp-refiner-steps').value)   || 10;
    payload.refinercfgscale           = parseFloat($('inp-refiner-cfg').value)   || 7;
    localStorage.setItem('swarm-refiner-model',   $('sel-refiner-model').value);
    localStorage.setItem('swarm-upscale-method',  $('sel-refiner-method').value);
  }

  // ControlNet params
  if ($('chk-cn').checked && _cnImageData) {
    payload.controlnetimageinput = _cnImageData;
    payload.controlnetstrength   = Number.isNaN(parseFloat($('inp-cn-strength').value)) ? 1 : parseFloat($('inp-cn-strength').value);
    payload.controlnetstart      = parseFloat($('inp-cn-start').value)    || 0;
    payload.controlnetend        = Number.isNaN(parseFloat($('inp-cn-end').value)) ? 1 : parseFloat($('inp-cn-end').value);
    const cnModel = $('sel-cn-model').value;
    if (cnModel) payload.controlnetmodel = cnModel;
    const cnType = $('sel-cn-type').value;
    if (cnType && cnType !== 'None') payload.controlnetpreprocessor = cnType;
    if (isUnionCN(cnModel)) {
      const unionType = $('sel-cn-union').value || guessUnionType(cnType);
      if (unionType) payload.controlnetuniontype = unionType;
    }
    localStorage.setItem('swarm-cn-model', cnModel);
    localStorage.setItem('swarm-cn-preprocessor', cnType);
  }

  if (App.refImages.length) payload.promptimages = App.refImages.join('|');

  // Extension params (SkimmedCFG, APG, KohyaDeepShrink, FaceTools, SeedVR2, …)
  Object.assign(payload, buildExtensionParamsPayload());

  // Remove undefined keys
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);

  // Save prefs
  localStorage.setItem('swarm-model',     $('sel-model').value);
  localStorage.setItem('swarm-vae',       $('sel-vae').value);
  localStorage.setItem('swarm-sampler',   $('sel-sampler').value);
  localStorage.setItem('swarm-scheduler', $('sel-scheduler').value);

  return payload;
}

// ── File du Scheduler : capturer / rouvrir les réglages complets de Txt2Img ─────
// state = de quoi tout remettre dans l'interface ; payload = la requête exacte à envoyer.
function captureTxt2ImgTask() {
  const payload = buildTxt2ImgPayload();
  if (!payload) return null;
  return {
    payload,
    state: {
      ...collectTxt2ImgState(),
      refImages: App.refImages.slice(),
      extGroups: structuredClone(App.extGroups),
      cnUnion:   $('sel-cn-union').value,
    },
  };
}

function restoreTxt2ImgState(state) {
  applyTxt2ImgState(state);
  App.refImages = (state.refImages || []).slice();
  renderRefImages();
  if (state.extGroups) {
    App.extGroups = structuredClone(state.extGroups);
    if (App._extLast) renderExtensionGroups(App._extLast.params, App._extLast.groups);
  }
  if (state.cnUnion !== undefined) $('sel-cn-union').value = state.cnUnion;
  updateCNUnionVisibility();
}

// Nom lisible pour une tâche : début du prompt, sans les balises <lora:…>
function taskNameFromPrompt(prompt) {
  const clean = String(prompt || '').replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  return clean.length > 42 ? clean.slice(0, 40).trimEnd() + '…' : (clean || 'Tâche');
}

async function addTxt2ImgToQueue() {
  const cap = captureTxt2ImgTask();
  if (!cap) return;
  const task = await Scheduler.addSnapshotTask({
    source: 'txt2img', name: taskNameFromPrompt(cap.state.positive), payload: cap.payload, state: cap.state,
  });
  if (task) toast(`📅 Ajouté à la file : ${task.name}`);
}

// Ouvre une tâche de la file dans une nouvelle instance de Txt2Img, pour la modifier
function editTaskInTxt2Img(task) {
  switchTab('txt2img');
  const idx = App.t2iBar.addInstance(`✏️ ${task.name}`.slice(0, 28));
  if (idx === -1) { showErrorToast('Trop d\'instances ouvertes : ferme-en une pour modifier la tâche.'); return; }
  restoreTxt2ImgState(task.state || {});
  App.editingTask = { id: task.id, name: task.name, instIdx: idx };
  updateTaskBanner(idx);
}

function updateTaskBanner(idx = App.t2iBar?.activeIdx) {
  const on = !!App.editingTask && App.editingTask.instIdx === idx;
  $('t2i-task-banner').hidden = !on;
  if (on) $('t2i-task-banner-name').textContent = App.editingTask.name;
}

async function saveEditedTask() {
  if (!App.editingTask) return;
  const cap = captureTxt2ImgTask();
  if (!cap) return;
  const ok = await Scheduler.updateSnapshotTask(App.editingTask.id, cap);
  if (!ok) { showErrorToast('Cette tâche n\'existe plus dans la file.'); }
  else toast(`✅ Tâche « ${App.editingTask.name} » mise à jour`);
  App.editingTask = null;
  updateTaskBanner();
}

function startGeneration() {
  const payload = buildTxt2ImgPayload();
  if (!payload) return;
  const seed = payload.seed;

  App.running = true;
  $('btn-generate').textContent = 'Stop';
  $('btn-generate').classList.add('running');
  $('progress-wrap').classList.remove('hidden');
  setProgress(0, 'Starting…');
  // Effacer l'erreur précédente
  $('gen-error-toast')?.classList.remove('visible');

  // Si aucun message de progression n'arrive après 15s (chargement du modèle
  // ControlNet par ex.), rassurer l'utilisateur plutôt que de laisser "Starting…"
  // figé — évite qu'il interrompe une génération qui tourne encore normalement.
  clearTimeout(_stallTimer);
  _stallTimer = setTimeout(() => {
    if (App.running) {
      $('progress-label').textContent = 'Toujours en cours… (le chargement d\'un modèle ControlNet peut prendre 30-90s la 1ère fois)';
    }
  }, 15000);

  const batchImages = [];
  const groupLabel  = new Date().toLocaleTimeString();

  API.generate(payload, {
    onProgress(status, pct) {
      clearTimeout(_stallTimer);
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
      const emptyEl = $('gallery-empty');
      if (emptyEl) emptyEl.style.display = 'none';
    },
    onImage(imgData, metadata) {
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
      // With a random seed (-1) the gallery's 🎲 "use this seed" used to copy -1: take the real one
      const img = { url: src, seed: seedFromMetadata(metadata, seed), prompt: payload.prompt };
      batchImages.push(img);
      addImageToGallery(img, groupLabel, batchImages.length === 1);

      // Update seed display with the used seed (SwarmUI may send it)
      if (!App.seedLocked) $('inp-seed').value = seed;
    },
    onDone() {
      finishGeneration();
    },
    onError(err) {
      clearTimeout(_stallTimer);
      console.error('Generation error:', err);
      App.running = false;
      $('btn-generate').textContent = 'Generate';
      $('btn-generate').classList.remove('running');
      $('progress-wrap').classList.add('hidden');
      showErrorToast(err);
      // Session peut être périmée après un crash — tenter une reconnexion silencieuse
      tryReconnect();
    },
  });
}

// SwarmUI sends each image's metadata as a JSON string: { sui_image_params: { seed, … }, … }
function seedFromMetadata(metadata, fallback) {
  try {
    const m = typeof metadata === 'string' ? JSON.parse(metadata) : metadata;
    const s = m?.sui_image_params?.seed;
    return Number.isFinite(+s) && s !== null && s !== '' ? +s : fallback;
  } catch { return fallback; }
}

function stopGeneration() {
  API.interrupt().catch(() => {});
  finishGeneration();
}

// ── Auto-reconnect after crash ─────────────────────────────────────────────────
let _reconnecting = false;
async function tryReconnect() {
  if (_reconnecting) return;
  _reconnecting = true;
  setStatus('connecting', 'Reconnexion…');
  try {
    await API.getSession();
    App.connected = true;
    setStatus('connected', 'Connected');
    toast('✅ Session restaurée — tu peux générer à nouveau');
  } catch {
    App.connected = false;
    setStatus('error', 'Session perdue — relance SwarmUI');
  } finally {
    _reconnecting = false;
  }
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
  // Reste visible jusqu'à la prochaine génération réussie (pas d'auto-hide)
  toast._timer = null;
}

// ── Fenêtre de confirmation (remplace confirm() du système) ───────────────────
// uiConfirm({ title, html, okLabel, danger }) → Promise<boolean>. html est inséré tel quel : échapper le contenu variable.
function uiConfirm({ title, html = '', okLabel = 'Confirmer', danger = false }) {
  let ov = $('ui-confirm');
  if (!ov) {
    ov = document.createElement('div');
    ov.id = 'ui-confirm';
    ov.className = 'sws-overlay';
    ov.innerHTML = `<div class="sws-modal ui-confirm-modal">
      <div class="sws-modal-head"><span class="ui-confirm-title"></span></div>
      <div class="sws-modal-body ui-confirm-body"></div>
      <div class="sws-modal-foot">
        <button class="sws-btn" data-a="cancel">Annuler</button>
        <button class="sws-btn primary" data-a="ok"></button>
      </div></div>`;
    document.body.appendChild(ov);
  }
  ov.querySelector('.ui-confirm-title').textContent = title;
  ov.querySelector('.ui-confirm-body').innerHTML = html;
  const okBtn = ov.querySelector('[data-a="ok"]');
  okBtn.textContent = okLabel;
  okBtn.classList.toggle('danger', danger);
  ov.classList.add('open');
  okBtn.focus();
  return new Promise(resolve => {
    const done = val => {
      ov.classList.remove('open');
      ov.removeEventListener('click', onClick);
      document.removeEventListener('keydown', onKey, true);
      resolve(val);
    };
    const onClick = e => {
      const a = e.target.closest('[data-a]')?.dataset.a;
      if (a) done(a === 'ok');
      else if (e.target === ov) done(false);
    };
    const onKey = e => {
      if (e.key === 'Escape') { e.preventDefault(); done(false); }
      else if (e.key === 'Enter') { e.preventDefault(); done(true); }
    };
    ov.addEventListener('click', onClick);
    document.addEventListener('keydown', onKey, true);
  });
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
  clearTimeout(_stallTimer);
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
    <img src="${esc(img.url)}" alt="Generated image" loading="lazy">
    <div class="gallery-img-actions">
      <button class="gal-btn" data-action="seed"      title="Use this seed">🎲</button>
      <button class="gal-btn" data-action="edit"      title="Éditer (onglet Edit)">✏️</button>
      <button class="gal-btn" data-action="inpaint"   title="Inpaint">🖌</button>
      <button class="gal-btn" data-action="schedule"  title="Send to Scheduler">📅</button>
      <button class="gal-btn" data-action="watermark" title="Send to Watermark">💧</button>
      <button class="gal-btn" data-action="comic"     title="Send to Comic">🎬</button>
      <button class="gal-btn" data-action="info"      title="Image info">ℹ</button>
      <button class="gal-btn" data-action="copy"      title="Copy image (Discord, etc.)">📋</button>
      <button class="gal-btn" data-action="save"      title="Save image">💾</button>
    </div>`;


  div.querySelector('[data-action="seed"]').addEventListener('click', e => {
    e.stopPropagation();
    $('inp-seed').value = img.seed;
    App.seedLocked = true;
    $('btn-lock-seed').classList.add('active');
  });
  div.querySelector('[data-action="edit"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToEdit(img.url);
  });
  div.querySelector('[data-action="inpaint"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToInpaint(img.url);
  });
  div.querySelector('[data-action="schedule"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToScheduler(img.seed);
  });
  div.querySelector('[data-action="watermark"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToWatermark(img.url);
  });
  div.querySelector('[data-action="comic"]').addEventListener('click', e => {
    e.stopPropagation();
    sendToComic(img.url);
  });
  div.querySelector('[data-action="info"]').addEventListener('click', e => {
    e.stopPropagation();
    showPngInfo(img.url);
  });
  div.querySelector('[data-action="copy"]').addEventListener('click', e => {
    e.stopPropagation();
    copyImageToClipboard(img.url);
  });
  div.querySelector('[data-action="save"]').addEventListener('click', e => {
    e.stopPropagation();
    downloadImage(img.url);
  });

  div.addEventListener('click', () => openLightbox(img.url));
  row.appendChild(div);
  updateGalleryToolbar();
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
    const mdl = App.models.find(f => f.name === p.model || f.title === p.model);
    if (mdl) selectModel(mdl.name);
    else {
      const sel = $('sel-model');
      const opt = [...sel.options].find(o => o.value === p.model || o.text === p.model);
      if (opt) { sel.value = opt.value; refreshLoraChoices(); }
    }
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
      const tabChk = document.getElementById('pnginfo-seed-lock');
      if (tabChk) tabChk.checked = _sendWithSeed;
    });
  }
  modal.querySelector('#png-info-text').value = text;
  document.body.appendChild(modal);
}

// ClipboardItem only accepts image/png — re-encode via canvas since SwarmUI can serve jpg/webp too
function toPngBlob(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width  = img.naturalWidth;
      canvas.height = img.naturalHeight;
      canvas.getContext('2d').drawImage(img, 0, 0);
      canvas.toBlob(b => b ? resolve(b) : reject(new Error('toBlob failed')), 'image/png');
      URL.revokeObjectURL(img.src);
    };
    img.onerror = () => reject(new Error('image decode failed'));
    img.src = URL.createObjectURL(blob);
  });
}

async function copyImageToClipboard(url) {
  try {
    const res     = await fetch(url);
    const blob    = await res.blob();
    const pngBlob = blob.type === 'image/png' ? blob : await toPngBlob(blob);
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
    toast('✅ Image copiée !');
  } catch (e) {
    toast('❌ Copie impossible: ' + e.message);
  }
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
// ── Gallery download ──────────────────────────────────────────────────────────
function updateGalleryToolbar() {
  const imgs  = document.querySelectorAll('#gallery .gallery-img img');
  const count = imgs.length;
  const countEl = $('gallery-count');
  const dlBtn   = $('btn-dl-gallery');
  if (countEl) countEl.textContent = count > 0 ? `${count} image${count > 1 ? 's' : ''}` : '';
  if (dlBtn)   dlBtn.style.display = count > 0 ? '' : 'none';
}

async function downloadGallery() {
  const imgs = [...document.querySelectorAll('#gallery .gallery-img img')];
  if (!imgs.length) return;

  const btn = $('btn-dl-gallery');
  if (btn) { btn.disabled = true; btn.textContent = '⏳ Compression…'; }

  try {
    const zip  = new JSZip();
    const date = new Date().toISOString().slice(0, 10);
    let idx = 1;
    for (const img of imgs) {
      try {
        const res  = await fetch(img.src);
        const blob = await res.blob();
        const ext  = blob.type.includes('png') ? 'png' : 'jpg';
        zip.file(`swarm_${date}_${String(idx).padStart(3, '0')}.${ext}`, blob);
        idx++;
      } catch { /* skip unreachable images */ }
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const a    = document.createElement('a');
    a.href     = URL.createObjectURL(blob);
    a.download = `swarm_${date}.zip`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  } catch (e) {
    showErrorToast(`Download: ${e.message}`);
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '⬇ Télécharger la galerie'; }
  }
}

$('btn-dl-gallery').addEventListener('click', downloadGallery);

let _lbImgs = [];
let _lbIdx  = 0;

function openLightbox(url, galleryId = 'gallery', imgSelector = '.gallery-img img') {
  // Browse every image currently in this gallery (all generation batches), not just the clicked one's batch
  // getAttribute, not .src: the property returns the normalised URL ("%20" for spaces in SwarmUI file
  // names), which never equals the raw url we're given — indexOf failed and the lightbox fell back to 1 image
  const srcs = [...document.querySelectorAll(`#${galleryId} ${imgSelector}`)].map(i => i.getAttribute('src'));
  _lbImgs = srcs.length ? srcs : [url];
  _lbIdx  = _lbImgs.indexOf(url);
  if (_lbIdx === -1) { _lbImgs = [url]; _lbIdx = 0; }
  $('lightbox-img').src = _lbImgs[_lbIdx];
  $('lightbox').classList.remove('hidden');
  _lbUpdateCounter();
}

function closeLightbox() {
  $('lightbox').classList.add('hidden');
  $('lightbox-img').src = '';
  _lbImgs = []; _lbIdx = 0;
  _lbUpdateCounter();
}

function _lbGo(dir) {
  if (_lbImgs.length <= 1) return;
  _lbIdx = (_lbIdx + dir + _lbImgs.length) % _lbImgs.length;
  $('lightbox-img').src = _lbImgs[_lbIdx];
  _lbUpdateCounter();
}

function _lbUpdateCounter() {
  const el = $('lightbox-counter');
  if (el) el.textContent = _lbImgs.length > 1 ? `${_lbIdx + 1} / ${_lbImgs.length}` : '';
}

$('lightbox-close').addEventListener('click', closeLightbox);
$('lightbox-backdrop').addEventListener('click', closeLightbox);
document.addEventListener('keydown', e => {
  if (!$('lightbox').classList.contains('hidden')) {
    if (e.key === 'Escape')      { closeLightbox(); return; }
    if (e.key === 'ArrowRight')  { e.preventDefault(); _lbGo(1);  return; }
    if (e.key === 'ArrowLeft')   { e.preventDefault(); _lbGo(-1); return; }
    // Ctrl+C (Win/Linux) or Cmd+C (Mac)
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') {
      e.preventDefault();
      copyImageToClipboard(_lbImgs[_lbIdx]);
      return;
    }
  }
});

// ── Presets (localStorage) ────────────────────────────────────────────────────
const PRESETS_KEY = 'swarmapp-presets';

function getPresetsData() {
  try { return JSON.parse(localStorage.getItem(PRESETS_KEY) || '{}'); } catch { return {}; }
}
function savePresetsData(obj) {
  // localStorage is ~5 MB: an uncaught QuotaExceededError used to drop the save silently
  try { localStorage.setItem(PRESETS_KEY, JSON.stringify(obj)); return true; }
  catch (e) { showErrorToast(`Preset non sauvegardé (stockage plein) : ${e.message}`); return false; }
}

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
  if (m.model) { selectModel(m.model); localStorage.setItem('swarm-model', m.model); }
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
    const loraWeights  = m.loraweights ? String(m.loraweights).split(',').map(s => parseFloat(s.trim())).map(w => Number.isNaN(w) ? 1 : w) : [];
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
        if (sel) setLoraSelValue(sel, name);
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

// Différences entre un preset enregistré et les réglages actuels, pour la confirmation d'écrasement
const PRESET_FIELD_LABELS = {
  model: 'Modèle', prompt: 'Prompt', negativeprompt: 'Negative prompt', vae: 'VAE', steps: 'Steps',
  cfgscale: 'CFG', sampler: 'Sampler', scheduler: 'Scheduler', seed: 'Seed', width: 'Largeur', height: 'Hauteur',
};
function presetDiff(oldP, newP) {
  const keys = [...new Set([...Object.keys(oldP || {}), ...Object.keys(newP || {})])];
  const norm = v => (v === undefined || v === null ? '' : String(v));
  const changed = keys.filter(k => norm(oldP?.[k]) !== norm(newP?.[k]));
  const lines = changed.filter(k => PRESET_FIELD_LABELS[k]).map(k => {
    const label = PRESET_FIELD_LABELS[k];
    if (k === 'prompt' || k === 'negativeprompt') return `<li><b>${label}</b> modifié</li>`;
    return `<li><b>${label}</b> <span class="cf-old">${esc(norm(oldP?.[k]) || '—')}</span> → <span class="cf-new">${esc(norm(newP?.[k]) || '—')}</span></li>`;
  });
  const others = changed.length - lines.length;
  if (others > 0) lines.push(`<li>+ ${others} autre${others > 1 ? 's' : ''} réglage${others > 1 ? 's' : ''} (refiner, ControlNet, extensions…)</li>`);
  return lines;
}

async function doSavePreset() {
  // Use typed name first, fall back to selected preset
  const title = $('inp-preset-name').value.trim() || $('sel-preset').value;
  if (!title) return;
  const presets = getPresetsData();
  const next = collectParamMap();
  if (presets[title]) {
    const diff = presetDiff(presets[title], next);
    if (!diff.length) { toast(`Preset « ${title} » déjà à jour`); return; }
    const ok = await uiConfirm({
      title: `Remplacer « ${title} » ?`,
      html: `<p>Ce preset contient déjà des réglages. Si tu l'enregistres, ceci va changer :</p><ul class="cf-diff">${diff.join('')}</ul>`,
      okLabel: 'Remplacer',
    });
    if (!ok) return;
  }
  presets[title] = next;
  if (!savePresetsData(presets)) return;
  loadPresets();
  TagComplete.clearModelCache();
  $('sel-preset').value      = title;
  $('inp-preset-name').value = '';
}

$('btn-preset-save').addEventListener('click', doSavePreset);
$('btn-preset-new').addEventListener('click',  doSavePreset);

$('btn-preset-delete').addEventListener('click', async () => {
  const title = $('sel-preset').value;
  if (!title) return;
  if (!await uiConfirm({ title: `Supprimer « ${title} » ?`, html: '<p>Le preset sera définitivement supprimé.</p>', okLabel: 'Supprimer', danger: true })) return;
  const presets = getPresetsData();
  delete presets[title];
  savePresetsData(presets);
  loadPresets();
});

// ── Tab switching ─────────────────────────────────────────────────────────────
function switchTab(tab) {
  document.querySelectorAll('.tab').forEach(el => el.classList.toggle('active', el.dataset.tab === tab));

  const isTxt   = tab === 'txt2img';
  const isFlux  = tab === 'flux';
  const isInp   = tab === 'inpaint';
  const isSch   = tab === 'scheduler';
  const isPng   = tab === 'pnginfo';
  const isComic = tab === 'comic';
  const isTw    = tab === 'twitter';
  const isMdl   = tab === 'models';

  $('view-txt2img').style.display = isTxt ? 'contents' : 'none';
  $('view-flux').classList.toggle('active', isFlux);
  $('view-inpaint').classList.toggle('active', isInp);
  $('view-scheduler').classList.toggle('active', isSch);
  $('view-pnginfo').classList.toggle('active', isPng);
  $('view-comic').classList.toggle('active', isComic);
  $('view-twitter').classList.toggle('active', isTw);
  $('view-models').classList.toggle('active', isMdl);

  if (isFlux)  { Flux.init(); Flux.onShow(); }
  if (isInp)   { Inpaint.init(); Inpaint.onShow(); }
  if (isSch)   { Scheduler.init(); Scheduler.onShow(); setSchedulerMode(localStorage.getItem('sch-mode') || 'gen'); }
  if (isComic) { Comic.init(); Comic.onShow(); }
  if (isTw)    { Watermark.init(); Twitter.init(); Twitter.onShow(); }   // le filigrane vit dans l'onglet Twitter
  if (isMdl)   { ModelDL.onShow(); }
}

document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => switchTab(tab.dataset.tab));
});

// ── Scheduler : deux modes dans le même onglet ────────────────────────────────
// « Génération » = file SwarmUI (scheduler.js) ; « Inpaint par lot » = Forge (inpaintScheduler.js)
function setSchedulerMode(mode) {
  const ips = mode === 'inpaint';
  $('sch-pane-gen').hidden = ips;
  $('sch-pane-ips').hidden = !ips;
  document.querySelectorAll('#sch-mode button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
  localStorage.setItem('sch-mode', mode);
  if (ips) { InpaintScheduler.init(); InpaintScheduler.onShow(); }
}
document.querySelectorAll('#sch-mode button').forEach(b => b.addEventListener('click', () => setSchedulerMode(b.dataset.mode)));

// ── Send to Inpaint (from gallery) ───────────────────────────────────────────
function sendToInpaint(url) {
  switchTab('inpaint');
  Inpaint.loadFromSrc(url);
}

// ── Send to Edit (from gallery) ──────────────────────────────────────────────
function sendToEdit(url) {
  switchTab('flux');
  Flux.loadFromSrc(url);
}

// ── Send to Watermark (from gallery) ─────────────────────────────────────────
// 💧 depuis une galerie : l'image rejoint l'onglet Twitter, où se trouve le filigrane
function sendToWatermark(url) {
  switchTab('twitter');
  Watermark.loadFromSrc(url);
}

// ── Send to Comic (from gallery) ─────────────────────────────────────────────
function sendToComic(url) {
  switchTab('comic');
  Comic.loadFromSrc(url);
}

// ── Send to Scheduler (from gallery) ─────────────────────────────────────────
// 📅 sur une image : ajoute les réglages actuels de Txt2Img à la file, avec la seed de cette image
async function sendToScheduler(seed) {
  const cap = captureTxt2ImgTask();
  if (!cap) return;
  const s = parseInt(seed, 10);
  if (Number.isFinite(s) && s !== -1) { cap.payload.seed = s; cap.state.seed = String(s); }
  const task = await Scheduler.addSnapshotTask({
    source: 'txt2img',
    name: taskNameFromPrompt(cap.state.positive) + (Number.isFinite(s) && s !== -1 ? ` · seed ${s}` : ''),
    payload: cap.payload, state: cap.state,
  });
  if (task) toast(`📅 Ajouté à la file : ${task.name}`);
}

// ── PNG Info tab ─────────────────────────────────────────────────────────────
(function initPngInfo() {
  const drop      = document.getElementById('pnginfo-drop');
  const fileInput = document.getElementById('pnginfo-file-input');
  const result    = document.getElementById('pnginfo-result');
  const preview   = document.getElementById('pnginfo-preview');
  const metaText  = document.getElementById('pnginfo-meta-text');
  let currentUrl  = null;   // object URL de l'image affichée (pour Inpaint / Edit)

  // ── Lecture des blocs de texte de l'image ──────────────────────────────────
  // PNG : tEXt / iTXt (non compressé). JPEG : commentaire COM ou EXIF UserComment (format SwarmUI).
  function readTextChunks(buf, file) {
    const bytes = new Uint8Array(buf);
    const chunks = {};
    if (bytes[0] === 0x89 && bytes[1] === 0x50) {
      const view = new DataView(buf);
      let off = 8;
      while (off < buf.byteLength - 12) {
        const len  = view.getUint32(off); off += 4;
        const type = String.fromCharCode(bytes[off], bytes[off+1], bytes[off+2], bytes[off+3]); off += 4;
        if (type === 'tEXt' || type === 'iTXt') {
          const raw = bytes.slice(off, off + len);
          const nul = raw.indexOf(0);
          const key = new TextDecoder('latin1').decode(raw.slice(0, nul));
          if (type === 'tEXt') {
            chunks[key] = new TextDecoder().decode(raw.slice(nul + 1));
          } else if (raw[nul + 1] === 0) {      // iTXt non compressé : mot-clé\0 flag méthode langue\0 traduction\0 texte
            let p = nul + 3;
            p = raw.indexOf(0, p) + 1;           // langue
            p = raw.indexOf(0, p) + 1;           // mot-clé traduit
            chunks[key] = new TextDecoder().decode(raw.slice(p));
          }
        }
        if (type === 'IEND') break;
        off += len + 4;
      }
      return { chunks, format: 'PNG' };
    }
    if (bytes[0] === 0xFF && bytes[1] === 0xD8) {
      let off = 2;
      while (off < bytes.length - 4) {
        if (bytes[off] !== 0xFF) break;
        const marker = bytes[off + 1];
        const segLen = (bytes[off + 2] << 8) | bytes[off + 3];
        if (marker === 0xFE) {
          const com = new TextDecoder().decode(bytes.slice(off + 4, off + 2 + segLen)).trim();
          if (com) chunks.parameters ??= com;
        }
        if (marker === 0xE1 && new TextDecoder('ascii').decode(bytes.slice(off + 4, off + 10)).startsWith('Exif\0')) {
          const exifBase = off + 10;
          const tiff = new DataView(buf, exifBase);
          const le   = tiff.getUint16(0) === 0x4949;
          const rd16 = o => tiff.getUint16(o, le);
          const rd32 = o => tiff.getUint32(o, le);
          const ifd0 = rd32(4);
          let exifIfdOff = 0;
          for (let i = 0; i < rd16(ifd0); i++) {
            const e = ifd0 + 2 + i * 12;
            if (rd16(e) === 0x8769) { exifIfdOff = rd32(e + 8); break; }
          }
          if (exifIfdOff) {
            for (let i = 0; i < rd16(exifIfdOff); i++) {
              const e = exifIfdOff + 2 + i * 12;
              if (rd16(e) !== 0x9286) continue;
              const rawFull = new Uint8Array(buf, exifBase + rd32(e + 8), rd32(e + 4));
              const prefix  = new TextDecoder('ascii').decode(rawFull.slice(0, 8));
              const skip    = prefix.replace(/\0/g, '').trim().match(/^(ASCII|UNICODE|JIS)$/) ? 8 : 0;
              chunks.parameters = new TextDecoder().decode(rawFull.slice(skip)).replace(/\0/g, '').trim();
              break;
            }
          }
        }
        if (marker === 0xDA) break;
        off += 2 + segLen;
      }
      return { chunks, format: 'JPEG' };
    }
    return { chunks, format: (file.type.split('/')[1] || 'image').toUpperCase() };
  }

  // Format Forge / A1111 : « prompt \n Negative prompt: … \n Steps: 20, Sampler: …, Size: 832x1216, … »
  function parseA1111(text) {
    const lines = text.split('\n');
    let pIdx = -1;
    for (let i = lines.length - 1; i >= 0; i--) if (/^Steps: \d+/.test(lines[i])) { pIdx = i; break; }
    const body  = pIdx >= 0 ? lines.slice(0, pIdx) : lines;
    const nIdx  = body.findIndex(l => l.startsWith('Negative prompt:'));
    const out   = {
      prompt: (nIdx >= 0 ? body.slice(0, nIdx) : body).join('\n').trim(),
      negativeprompt: nIdx >= 0 ? body.slice(nIdx).join('\n').replace(/^Negative prompt:\s*/, '').trim() : '',
    };
    if (pIdx >= 0) {
      const map = { 'Steps': 'steps', 'Sampler': 'sampler', 'Schedule type': 'scheduler', 'CFG scale': 'cfgscale', 'Seed': 'seed',
                    'Model': 'model', 'VAE': 'vae', 'Denoising strength': 'denoising', 'Hires upscale': 'refinerupscale',
                    'Hires steps': 'refinersteps', 'Hires upscaler': 'refinerupscalemethod' };
      const params = lines.slice(pIdx).join(', ');
      for (const m of params.matchAll(/([A-Za-z][\w ./-]*?):\s*("(?:[^"\\]|\\.)*"|[^,]*)(?:,|$)/g)) {
        const key = m[1].trim(), val = m[2].trim().replace(/^"|"$/g, '');
        if (key === 'Size') { const [w, h] = val.split('x').map(Number); out.width = w; out.height = h; }
        else if (map[key]) out[map[key]] = /^-?\d+(\.\d+)?$/.test(val) ? +val : val;
      }
    }
    return out;
  }

  // Interprète les blocs : SwarmUI (JSON sui_image_params), Forge / A1111 (texte), ComfyUI (graphe JSON)
  function interpret(chunks) {
    const raw = chunks.parameters;
    if (raw) {
      try {
        const parsed = JSON.parse(raw);
        return { source: 'SwarmUI', params: parsed.sui_image_params || parsed, extra: parsed.sui_extra_data || {}, raw };
      } catch {
        return { source: 'Forge / A1111', params: parseA1111(raw), extra: {}, raw };
      }
    }
    if (chunks.prompt || chunks.workflow) {
      return { source: 'ComfyUI (workflow — réglages non lisibles directement)', params: null, extra: {}, raw: chunks.prompt || chunks.workflow };
    }
    return { source: '', params: null, extra: {}, raw: '' };
  }

  const fmtBytes = n => n > 1048576 ? `${(n / 1048576).toFixed(1)} Mo` : `${Math.round(n / 1024)} Ko`;
  const stripLoras = p => String(p || '').replace(/<lora:[^>]+>/gi, '').replace(/\s{2,}/g, ' ').trim();

  function lorasOf(p) {
    const list = [];
    for (const m of String(p.prompt || '').matchAll(/<lora:([^:>]+)(?::([\d.]+))?>/gi)) list.push({ name: m[1], weight: m[2] ?? '1' });
    const names = Array.isArray(p.loras) ? p.loras : (p.loras ? String(p.loras).split(',') : []);
    const weights = Array.isArray(p.loraweights) ? p.loraweights : (p.loraweights ? String(p.loraweights).split(',') : []);
    names.forEach((n, i) => { if (n && !list.some(l => l.name === n)) list.push({ name: n, weight: weights[i] ?? '1' }); });
    return list;
  }

  function render({ source, params, extra, raw }, file, dims, format) {
    const p = params || {};
    document.getElementById('pi-file').textContent =
      [file.name, dims ? `${dims.w}×${dims.h}` : '', fmtBytes(file.size), format].filter(Boolean).join(' · ');
    document.getElementById('pi-source').textContent = source ? `Créée avec ${source}` : '';

    const has = !!params;
    const empty = document.getElementById('pi-empty');
    empty.hidden = has;
    empty.innerHTML = raw && !has
      ? 'Cette image vient de ComfyUI : elle contient son graphe de nœuds, mais pas de réglages lisibles. Le contenu brut est dans « Toutes les métadonnées ».'
      : 'Aucune métadonnée trouvée dans cette image.<br><small>SwarmUI ne les enregistre que si « Save Metadata » est activé. Les images passées par un réseau social ou une capture d\'écran les perdent.</small>';
    document.getElementById('pnginfo-send-txt2img').disabled = !has;

    const promptTxt = stripLoras(p.prompt);
    document.getElementById('pi-prompt-card').hidden = !promptTxt;
    document.getElementById('pi-prompt').textContent = promptTxt;
    document.getElementById('pi-neg-card').hidden = !p.negativeprompt;
    document.getElementById('pi-neg').textContent = p.negativeprompt || '';

    const cells = [
      ['Modèle', p.model ? String(p.model).split('/').pop().replace(/\.(safetensors|gguf|ckpt)$/i, '') : ''],
      ['Taille', p.width && p.height ? `${p.width}×${p.height}` : ''],
      ['Steps', p.steps], ['CFG', p.cfgscale],
      ['Sampler', p.sampler], ['Scheduler', p.scheduler],
      ['Seed', p.seed], ['VAE', p.vae],
      ['Denoising', p.denoising ?? p.initimagecreativity],
      ['Refiner', p.refinerupscale ? `×${p.refinerupscale}${p.refinersteps ? ` · ${p.refinersteps} steps` : ''}` : ''],
    ].filter(([, v]) => v !== undefined && v !== null && v !== '');
    document.getElementById('pi-params-card').hidden = !cells.length;
    document.getElementById('pi-grid').innerHTML = cells.map(([k, v]) =>
      `<div class="pi-cell${k === 'Seed' ? ' copyable' : ''}" ${k === 'Seed' ? `title="Cliquer pour copier la seed" data-seed="${esc(v)}"` : ''}><span>${esc(k)}</span><b>${esc(v)}</b></div>`).join('');

    const loras = lorasOf(p);
    document.getElementById('pi-loras').innerHTML = loras.length
      ? `<span class="pi-loras-lbl">LoRAs</span>${loras.map(l => `<span class="pi-lora">${esc(l.name)} <i>${esc(l.weight)}</i></span>`).join('')}`
      : '';

    const lines = params ? Object.entries(params).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`) : [raw || ''];
    if (Object.keys(extra).length) lines.push('', ...Object.entries(extra).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`));
    metaText.value = lines.join('\n');
    document.getElementById('pi-raw').open = !has && !!raw;
  }

  async function processFile(file) {
    if (!file || !file.type.startsWith('image/')) return;
    if (currentUrl) URL.revokeObjectURL(currentUrl);
    currentUrl = URL.createObjectURL(file);
    preview.src = currentUrl;
    result.style.display = '';
    drop.style.display = 'none';
    const dims = await new Promise(r => { const im = new Image(); im.onload = () => r({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => r(null); im.src = currentUrl; });
    try {
      const { chunks, format } = readTextChunks(await file.arrayBuffer(), file);
      const info = interpret(chunks);
      _lastParsedMeta = info.params;
      render(info, file, dims, format);
    } catch (e) {
      console.error('[PNG Info]', e);
      _lastParsedMeta = null;
      render({ source: '', params: null, extra: {}, raw: '' }, file, dims, '');
    }
  }

  const copy = (text, label) => navigator.clipboard.writeText(text || '').then(() => toast(`📋 ${label} copié`));

  document.getElementById('pnginfo-browse').addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => { if (fileInput.files[0]) processFile(fileInput.files[0]); fileInput.value = ''; });
  drop.addEventListener('click', e => { if (e.target === drop || e.target.closest('.pnginfo-drop-inner') && !e.target.closest('button')) fileInput.click(); });

  // Glisser une image n'importe où sur l'onglet (y compris par-dessus une image déjà affichée)
  const view = document.getElementById('view-pnginfo');
  view.addEventListener('dragover', e => { e.preventDefault(); view.classList.add('drag-over'); });
  view.addEventListener('dragleave', e => { if (!view.contains(e.relatedTarget)) view.classList.remove('drag-over'); });
  view.addEventListener('drop', e => {
    e.preventDefault();
    view.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) processFile(file);
  });

  document.getElementById('pnginfo-clear').addEventListener('click', () => {
    result.style.display = 'none';
    drop.style.display = '';
    preview.removeAttribute('src');
    metaText.value = '';
    _lastParsedMeta = null;
    if (currentUrl) { URL.revokeObjectURL(currentUrl); currentUrl = null; }
  });
  document.getElementById('pi-to-inpaint').addEventListener('click', () => currentUrl && sendToInpaint(currentUrl));
  document.getElementById('pi-to-edit').addEventListener('click', () => currentUrl && sendToEdit(currentUrl));

  document.getElementById('pnginfo-copy').addEventListener('click', e => { e.preventDefault(); copy(metaText.value, 'Tout'); });
  document.getElementById('pnginfo-copy-prompt').addEventListener('click', () => copy(_lastParsedMeta?.prompt, 'Prompt'));
  document.getElementById('pi-copy-neg').addEventListener('click', () => copy(_lastParsedMeta?.negativeprompt, 'Negative prompt'));
  document.getElementById('pnginfo-copy-params').addEventListener('click', () => copy(_buildParamsCopy(_lastParsedMeta), 'Réglages'));
  document.getElementById('pi-grid').addEventListener('click', e => {
    const cell = e.target.closest('[data-seed]');
    if (cell) copy(cell.dataset.seed, 'Seed');
  });
  document.getElementById('pnginfo-send-txt2img').addEventListener('click', () => _sendToTxt2img(_lastParsedMeta));
  document.getElementById('pnginfo-seed-lock').addEventListener('change', function () {
    _sendWithSeed = this.checked;
    const modalBtn = document.getElementById('png-info-seed-lock');
    if (modalBtn) { modalBtn.textContent = _sendWithSeed ? '🔒' : '🎲'; modalBtn.style.color = _sendWithSeed ? 'var(--accent)' : ''; }
  });
})();

// ── Connect button ────────────────────────────────────────────────────────────
$('btn-connect').addEventListener('click', connect);
$('host-input').addEventListener('keydown', e => { if (e.key === 'Enter') connect(); });

// ── Launch SwarmUI locally (Windows only) ──────────────────────────────────────
async function waitForSwarmPort(host, maxAttempts, intervalMs) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const r = await fetch(`http://${host}/API/GetNewSession`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ session_id: '' }),
      });
      if (r.ok) return true;
    } catch {}
    await new Promise(res => setTimeout(res, intervalMs));
  }
  return false;
}

async function launchSwarmUI() {
  const btn = $('btn-launch-swarm');
  const originalText = btn.textContent;
  btn.disabled = true;
  try {
    const pickScript = () => window.electronAPI.pickLaunchScript(
      'swarmLaunchScript',
      'Sélectionne le script de lancement de SwarmUI',
      'Choisis launch-windows.bat (ou ton propre .bat) dans le dossier SwarmUI',
    );

    const cfg = await window.electronAPI.configGet();
    if (!cfg?.swarmLaunchScript) {
      const picked = await pickScript();
      if (!picked) return;
    }

    const host = $('host-input').value.trim() || 'localhost:7801';
    $('host-input').value = host;
    const [swarmIp, swarmPort] = host.split(':');
    // Pin host/port explicitly — SwarmUI otherwise falls back to its last-saved settings
    const launchArgs = swarmIp && swarmPort ? ['--host', swarmIp, '--port', swarmPort] : [];

    btn.textContent = '⏳ Démarrage…';
    let res = await window.electronAPI.launchProcess('swarmLaunchScript', launchArgs);

    // Script moved/deleted since it was configured — ask again instead of failing forever
    if (res?.error === 'script_not_found' || res?.error === 'no_script_configured') {
      const picked = await pickScript();
      if (!picked) return;
      res = await window.electronAPI.launchProcess('swarmLaunchScript', launchArgs);
    }

    if (res?.error) {
      setStatus('error', 'Erreur lancement SwarmUI: ' + res.error);
      return;
    }

    setStatus('connecting', 'Démarrage de SwarmUI…');
    const ready = await waitForSwarmPort(host, 40, 1500);
    if (!ready) {
      setStatus('error', 'SwarmUI ne répond pas (timeout)');
      return;
    }

    localStorage.setItem('swarm-host', host);
    await connect();
  } finally {
    btn.disabled = false;
    btn.textContent = originalText;
  }
}

$('btn-launch-swarm').addEventListener('click', launchSwarmUI);

// ── Helpers ───────────────────────────────────────────────────────────────────
function esc(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// ── Auto-connect on load ──────────────────────────────────────────────────────
window.addEventListener('DOMContentLoaded', () => {
  // Restore saved host if any
  const savedHost = localStorage.getItem('swarm-host');
  if (savedHost) $('host-input').value = savedHost;

  // Launch-SwarmUI button only makes sense on the machine running SwarmUI itself
  if (window.electronAPI?.platform === 'win32') {
    $('btn-launch-swarm').style.display = '';
  }

  // Init tag autocomplete
  TagComplete.init();

  // Init character selector
  CharSelector.bindControls();

  // Init inpaint (binds events only, no API calls yet)
  Inpaint.init();

  // ── Txt2Img instance bar ──────────────────────────────────────────────────
  App.t2iBar = createInstanceBar(document.getElementById('txt2img-inst-bar'), {
    onSave:   (idx) => { _t2iStates[idx] = collectTxt2ImgState(); },
    onLoad:   (idx) => { applyTxt2ImgState(_t2iStates[idx]); updateTaskBanner(idx); },
    onNew:    (idx) => { _t2iStates[idx] = {}; },
    onRemove: (idx) => {
      _t2iStates.splice(idx, 1);
      if (App.editingTask) {
        if (App.editingTask.instIdx === idx) App.editingTask = null;
        else if (App.editingTask.instIdx > idx) App.editingTask.instIdx--;
      }
    },
  });

  // Load local presets (no server needed)
  loadPresets();

  // Auto-connect
  connect();

  // Update notifications — auto-download in the background, prompt to
  // restart+install once ready; falls back to a manual download link if the
  // auto-update pipeline errors out (e.g. dev build, network issue).
  if (window.electronAPI?.onUpdateAvailable) {
    const banner      = document.getElementById('update-banner');
    const msg         = document.getElementById('update-msg');
    const installBtn  = document.getElementById('update-install-btn');
    const link        = document.getElementById('update-link');

    const showBanner = () => banner.style.display = 'flex';
    document.getElementById('update-close').onclick = () => banner.style.display = 'none';

    window.electronAPI.onUpdateAvailable((version) => {
      msg.textContent = `Téléchargement de la mise à jour v${version}…`;
      installBtn.style.display = 'none';
      link.style.display = 'none';
      showBanner();
    });
    window.electronAPI.onUpdateProgress?.((pct) => {
      msg.textContent = `Téléchargement de la mise à jour… ${pct}%`;
      showBanner();
    });
    window.electronAPI.onUpdateDownloaded?.((version) => {
      msg.textContent = `Mise à jour v${version} prête —`;
      installBtn.style.display = '';
      link.style.display = 'none';
      showBanner();
    });
    window.electronAPI.onUpdateError?.(() => {
      msg.textContent = `Mise à jour disponible —`;
      installBtn.style.display = 'none';
      link.style.display = '';
      showBanner();
    });
    installBtn.onclick = () => window.electronAPI.installUpdate();
  }
});

$('host-input').addEventListener('change', () => {
  localStorage.setItem('swarm-host', $('host-input').value);
});
