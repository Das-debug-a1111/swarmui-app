// ── Grille X/Y/Z (Txt2Img) ───────────────────────────────────────────────────
// Compare des modèles, prompts, LoRA, steps, CFG… : une image par combinaison, assemblées dans une grille
// légendée (une grille par valeur de Z). Réutilise buildTxt2ImgPayload() : tout le reste des réglages
// (taille, ControlNet, extensions…) est celui de Txt2Img. Les images sont générées une par une.
const XYZGrid = (() => {
  const $ = id => document.getElementById(id);
  const MAX_CELLS = 200;
  const CONFIRM_ABOVE = 30;

  const optValues = id => [...($(id)?.options || [])].map(o => o.value).filter(Boolean);
  const AXES = [
    { id: 'none', label: '— Aucun —' },
    { id: 'model', label: 'Modèle', list: () => App.models.map(m => m.name) },
    { id: 'lora', label: 'LoRA (choix)', list: () => App.loraModels.map(m => m.name), withNone: true },
    { id: 'loraw', label: 'LoRA (poids)', hint: 'ex : 0.4, 0.7, 1 — appliqué à tous les LoRA du prompt' },
    { id: 'prompt', label: 'Prompt S/R', hint: 'séparées par | — la 1ʳᵉ est le texte à chercher dans ton prompt, les autres le remplacent (ex : red dress | blue dress | black dress)' },
    { id: 'neg', label: 'Negative S/R', hint: 'séparées par | — la 1ʳᵉ est le texte à chercher dans le negative' },
    { id: 'steps', label: 'Steps', hint: 'ex : 10, 20, 30' },
    { id: 'cfg', label: 'CFG', hint: 'ex : 4, 6, 8' },
    { id: 'seed', label: 'Seed', hint: 'ex : 1, 2, 3' },
    { id: 'sampler', label: 'Sampler', list: () => optValues('sel-sampler') },
    { id: 'scheduler', label: 'Scheduler', list: () => optValues('sel-scheduler') },
    { id: 'vae', label: 'VAE', list: () => optValues('sel-vae') },
    { id: 'size', label: 'Taille', hint: 'LxH séparées par des virgules — ex : 1024x1024, 1024x1344' },
    { id: 'refiner', label: 'Hires : bascule', hint: 'off = sans hires ; sinon la force (0 à 1) — ex : off, 0.35, 0.4, 0.5' },
    { id: 'refscale', label: 'Hires : agrandissement', hint: 'ex : 1.25, 1.5, 2' },
    { id: 'refmethod', label: 'Hires : upscaler', list: () => optValues('sel-refiner-method') },
    { id: 'refmodel', label: 'Hires : modèle', list: () => optValues('sel-refiner-model') },
  ];
  const axisDef = id => AXES.find(a => a.id === id) || AXES[0];
  const LORA_TAG = /<lora:[^>]*>/gi;

  // ── Lecture des axes ────────────────────────────────────────────────────────
  function readAxis(n) {
    const type = $(`xyz-type-${n}`).value;
    const def = axisDef(type);
    if (type === 'none') return null;
    let values;
    if (def.list) {
      values = [...document.querySelectorAll(`#xyz-pick-${n} input:checked`)].map(i => i.value);
    } else {
      const sep = (type === 'prompt' || type === 'neg') ? '|' : ',';
      values = $(`xyz-vals-${n}`).value.split(sep).map(s => s.trim());
      if (type !== 'prompt' && type !== 'neg') values = values.filter(Boolean);
      else values = values.filter((s, i) => s || i > 0); // le texte cherché ne peut pas être vide
    }
    return { type, label: def.label, values };
  }

  function updateCount() {
    const axes = [1, 2, 3].map(readAxis);
    const dims = axes.map(a => a ? a.values.length : 1);
    const total = dims.reduce((a, b) => a * b, 1);
    const any = axes.some(Boolean);
    $('xyz-count').textContent = any ? `${total} image${total > 1 ? 's' : ''}` : '';
    $('xyz-run').disabled = !any || total < 1 || total > MAX_CELLS;
  }

  function renderAxisInput(n) {
    const type = $(`xyz-type-${n}`).value;
    const def = axisDef(type);
    const txt = $(`xyz-vals-${n}`), pick = $(`xyz-pick-${n}`);
    txt.hidden = true; pick.hidden = true; pick.innerHTML = '';
    $(`xyz-hint-${n}`).textContent = '';
    if (type === 'none') { updateCount(); return; }
    if (def.list) {
      pick.hidden = false;
      const names = def.list();
      const items = def.withNone ? [''].concat(names) : names;
      if (!items.length) pick.innerHTML = '<div class="xyz-empty">Aucune valeur disponible (connecte-toi à SwarmUI)</div>';
      items.forEach(v => {
        const l = document.createElement('label');
        l.className = 'xyz-opt';
        const cb = document.createElement('input');
        cb.type = 'checkbox'; cb.value = v;
        cb.addEventListener('change', updateCount);
        l.appendChild(cb);
        l.appendChild(document.createTextNode(' ' + (v === '' ? '(aucun LoRA)' : v)));
        pick.appendChild(l);
      });
    } else {
      txt.hidden = false;
      txt.placeholder = def.hint || '';
      $(`xyz-hint-${n}`).textContent = def.hint || '';
    }
    updateCount();
  }

  // ── Application d'une valeur sur la requête ─────────────────────────────────
  function shortName(v) { return String(v).split(/[\\/]/).pop().replace(/\.(safetensors|ckpt|gguf|pt)$/i, ''); }

  // Active le hires (refiner) avec les réglages courants de l'interface si la requête de base n'en a pas
  function ensureRefiner(payload) {
    if ('refinercontrolpercentage' in payload) return;
    const num = (id, def) => { const v = parseFloat($(id)?.value); return Number.isNaN(v) ? def : v; };
    payload.refinermethod = 'PostApply';
    payload.refinerupscale = num('inp-refiner-scale', 1.5) || 1.5;
    payload.refinercontrolpercentage = num('inp-refiner-pct', 0.4);
    payload.refinerupscalemethod = $('sel-refiner-method')?.value || 'pixel-lanczos';
    payload.refinersteps = parseInt($('inp-refiner-steps')?.value, 10) || 15;
    payload.refinercfgscale = num('inp-refiner-cfg', payload.cfgscale || 7);
    const rm = $('sel-refiner-model')?.value;
    if (rm) payload.refinermodel = rm;
  }

  function applyValue(payload, base, axis, value) {
    switch (axis.type) {
      case 'size': {
        const m = String(value).match(/^\s*(\d+)\s*[x×]\s*(\d+)\s*$/i);
        if (m) { payload.width = parseInt(m[1], 10); payload.height = parseInt(m[2], 10); }
        break;
      }
      case 'refiner':
        if (/^(off|non|sans|0)$/i.test(String(value).trim())) {
          Object.keys(payload).filter(k => k.startsWith('refiner')).forEach(k => delete payload[k]);
        } else {
          ensureRefiner(payload);
          const v = parseFloat(value);
          if (Number.isFinite(v)) payload.refinercontrolpercentage = Math.min(1, Math.max(0, v));
        }
        break;
      case 'refscale': {
        ensureRefiner(payload);
        const v = parseFloat(value);
        if (Number.isFinite(v) && v > 0) payload.refinerupscale = v;
        break;
      }
      case 'refmethod': ensureRefiner(payload); payload.refinerupscalemethod = value; break;
      case 'refmodel':  ensureRefiner(payload); payload.refinermodel = value; break;
      case 'model':     payload.model = value; break;
      case 'vae':       payload.vae = value; break;
      case 'sampler':   payload.sampler = value; break;
      case 'scheduler': payload.scheduler = value; break;
      case 'steps':     payload.steps = parseInt(value, 10) || payload.steps; break;
      case 'cfg':       payload.cfgscale = parseFloat(value) || payload.cfgscale; break;
      case 'seed':      payload.seed = parseInt(value, 10); break;
      case 'loraw': {
        const w = parseFloat(value);
        payload.prompt = payload.prompt.replace(/<lora:([^:>]+):[^>]*>/gi, (_, name) => `<lora:${name}:${w}>`);
        break;
      }
      case 'lora': {
        const w = (App.loraItems.find(l => l.model) || {}).weight ?? 1;
        payload.prompt = payload.prompt.replace(LORA_TAG, '').replace(/\s{2,}/g, ' ').trim()
          + (value ? ` <lora:${value}:${w}>` : '');
        break;
      }
      case 'prompt': payload.prompt = payload.prompt.split(axis.values[0]).join(value); break;
      case 'neg':    payload.negativeprompt = (payload.negativeprompt || '').split(axis.values[0]).join(value); break;
    }
  }

  function cellLabel(axis, value) {
    if (axis.type === 'model' || axis.type === 'lora' || axis.type === 'refmodel') return value ? shortName(value) : '(aucun)';
    if (axis.type === 'refmethod') return shortName(value).replace(/^model-/, '');
    if (axis.type === 'refiner') return /^(off|non|sans|0)$/i.test(String(value).trim()) ? 'sans hires' : `hires ${value}`;
    if (axis.type === 'refscale') return `×${value}`;
    if (axis.type === 'prompt' || axis.type === 'neg') return value || '(vide)';
    return String(value);
  }

  // ── Génération d'une image ──────────────────────────────────────────────────
  function toSrc(imgData) {
    if (typeof imgData === 'string' && (imgData.startsWith('data:') || imgData.startsWith('http'))) return imgData;
    return `${API.origin}/${imgData}`;
  }

  function generateOne(payload, onPct) {
    return new Promise((resolve, reject) => {
      let src = null;
      API.generate(payload, {
        onProgress(status, pct) {
          const p = pct > 0 ? pct : (status?.cur_step && status?.total_steps ? status.cur_step / status.total_steps : 0);
          onPct(p);
        },
        onImage(imgData) { if (!src) src = toSrc(imgData); },
        onDone() { resolve(src); },
        onError(err) { reject(new Error(typeof err === 'string' ? err : 'Échec de la génération')); },
      });
    });
  }

  async function loadBitmap(url) {
    const blob = await (await fetch(url)).blob();
    return createImageBitmap(blob);
  }

  // ── Assemblage d'une grille (une valeur de Z) ───────────────────────────────
  function fit(ctx, text, maxW) {
    if (ctx.measureText(text).width <= maxW) return text;
    let t = text;
    while (t.length > 1 && ctx.measureText(t + '…').width > maxW) t = t.slice(0, -1);
    return t + '…';
  }

  function drawGrid(cells, nx, ny, xAxis, yAxis, title, showLabels) {
    const first = cells.find(Boolean);
    const cw = Math.max(64, Math.min(512, first.width, Math.floor(7600 / nx)));
    const ch = Math.round(cw * first.height / first.width);
    const gap = 6, fontPx = Math.max(13, Math.min(22, Math.round(cw / 20)));
    const hasX = !!xAxis && showLabels, hasY = !!yAxis && showLabels;
    const topH = (title && showLabels ? fontPx + 18 : 0) + (hasX ? fontPx * 2 + 14 : 0);
    const leftW = hasY ? Math.round(Math.min(220, Math.max(110, cw * 0.45))) : 0;
    const W = leftW + nx * cw + (nx + 1) * gap, H = topH + ny * ch + (ny + 1) * gap;
    const cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0, 0, W, H);
    ctx.font = `600 ${fontPx}px -apple-system, "Segoe UI", sans-serif`;
    ctx.fillStyle = '#e6edf3'; ctx.textBaseline = 'middle';
    let y0 = 0;
    if (title && showLabels) {
      ctx.textAlign = 'left';
      ctx.fillText(fit(ctx, title, W - 20), 10, (fontPx + 18) / 2);
      y0 = fontPx + 18;
    }
    if (hasX) {
      ctx.textAlign = 'center';
      xAxis.values.forEach((v, i) => {
        const cx = leftW + gap + i * (cw + gap) + cw / 2;
        const words = cellLabel(xAxis, v);
        ctx.fillText(fit(ctx, words, cw - 6), cx, y0 + (fontPx * 2 + 14) / 2);
      });
    }
    ctx.textAlign = 'right';
    for (let j = 0; j < ny; j++) {
      const ty = topH + gap + j * (ch + gap);
      if (hasY) ctx.fillText(fit(ctx, cellLabel(yAxis, yAxis.values[j]), leftW - 16), leftW - 8, ty + ch / 2);
      for (let i = 0; i < nx; i++) {
        const bmp = cells[j * nx + i];
        const tx = leftW + gap + i * (cw + gap);
        if (bmp) ctx.drawImage(bmp, tx, ty, cw, ch);
        else { ctx.strokeStyle = '#30363d'; ctx.strokeRect(tx + 0.5, ty + 0.5, cw - 1, ch - 1); }
      }
    }
    return cv;
  }

  const canvasToBlob = cv => new Promise(res => cv.toBlob(res, 'image/png'));

  // ── Lancement ───────────────────────────────────────────────────────────────
  async function run() {
    if (App.running) return;
    const base = buildTxt2ImgPayload();
    if (!base) return;
    const [ax, ay, az] = [1, 2, 3].map(readAxis);
    const used = [ax, ay, az].filter(Boolean);
    if (!used.length) { showErrorToast('Choisis au moins un axe pour la grille.'); return; }
    const types = used.map(a => a.type);
    if (new Set(types).size !== types.length) { showErrorToast('Deux axes ont le même type : choisis des axes différents.'); return; }
    for (const a of used) {
      if (!a.values.length) { showErrorToast(`L'axe « ${a.label} » n'a aucune valeur.`); return; }
      if ((a.type === 'prompt' && !base.prompt.includes(a.values[0])) ||
          (a.type === 'neg' && !(base.negativeprompt || '').includes(a.values[0]))) {
        showErrorToast(`« ${a.values[0]} » n'apparaît pas dans ${a.type === 'neg' ? 'le negative prompt' : 'ton prompt'} : rien à remplacer.`);
        return;
      }
      if (a.type === 'prompt' && a.values.length < 2) { showErrorToast('Prompt S/R : donne au moins un texte de remplacement après le texte cherché.'); return; }
    }
    const nx = ax ? ax.values.length : 1, ny = ay ? ay.values.length : 1, nz = az ? az.values.length : 1;
    const total = nx * ny * nz;
    if (total > MAX_CELLS) { showErrorToast(`Trop d'images (${total}, max ${MAX_CELLS}).`); return; }
    if (total > CONFIRM_ABOVE && !confirm(`Cette grille va générer ${total} images, ça peut prendre longtemps. Continuer ?`)) return;

    // Graine figée pour toute la grille : sinon chaque case change aussi de seed et la comparaison ne vaut rien
    if (!(base.seed >= 0) && !used.some(a => a.type === 'seed')) base.seed = Math.floor(Math.random() * 2147483647);
    base.images = 1;

    const keepSingles = $('xyz-singles').checked;
    const showLabels = $('xyz-labels').checked;
    const groupLabel = `Grille X/Y/Z · ${new Date().toLocaleTimeString()}`;

    App.running = true;
    $('btn-generate').textContent = 'Stop';
    $('btn-generate').classList.add('running');
    $('xyz-run').disabled = true;
    $('progress-wrap').classList.remove('hidden');
    $('gen-error-toast')?.classList.remove('visible');

    const results = new Array(total).fill(null);   // index = z * ny * nx + y * nx + x
    let done = 0, failed = null;
    try {
      outer:
      for (let k = 0; k < nz; k++) for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
        if (!App.running) break outer;
        const payload = { ...base };
        if (ax) applyValue(payload, base, ax, ax.values[i]);
        if (ay) applyValue(payload, base, ay, ay.values[j]);
        if (az) applyValue(payload, base, az, az.values[k]);
        const n = done + 1;
        setProgress(done / total, `Grille ${n}/${total}`);
        const src = await generateOne(payload, p => {
          if (App.running) setProgress((done + p) / total, `Grille ${n}/${total}`);
        });
        if (!App.running) break outer;
        if (!src) continue;
        results[(k * ny + j) * nx + i] = src;
        done++;
        if (keepSingles) addImageToGallery({ url: src, seed: payload.seed, prompt: payload.prompt }, groupLabel, false);
      }
    } catch (e) {
      failed = e.message || String(e);
    }
    const stopped = !App.running;
    finishGeneration();

    if (!results.some(Boolean)) {
      if (failed) showErrorToast(failed);
      else if (!stopped) showErrorToast('Aucune image reçue.');
      updateCount();
      return;
    }

    // Une grille par valeur de Z
    setProgress(1, 'Assemblage de la grille…');
    $('progress-wrap').classList.remove('hidden');
    try {
      for (let k = 0; k < nz; k++) {
        const slice = results.slice(k * ny * nx, (k + 1) * ny * nx);
        if (!slice.some(Boolean)) continue;
        const bitmaps = await Promise.all(slice.map(s => s ? loadBitmap(s).catch(() => null) : null));
        const parts = [];
        if (ax) parts.push(`X : ${ax.label}`);
        if (ay) parts.push(`Y : ${ay.label}`);
        if (az) parts.push(`Z : ${az.label} = ${cellLabel(az, az.values[k])}`);
        const cv = drawGrid(bitmaps, nx, ny, ax, ay, parts.join('   ·   '), showLabels);
        bitmaps.forEach(b => b && b.close && b.close());
        const blob = await canvasToBlob(cv);
        if (!blob) throw new Error('Grille trop grande pour être assemblée : réduis le nombre de valeurs.');
        const url = URL.createObjectURL(blob);
        addImageToGallery({ url, seed: base.seed, prompt: base.prompt }, groupLabel, k === 0);
      }
    } catch (e) {
      showErrorToast(`Assemblage impossible : ${e.message || e}`);
    }
    setTimeout(() => { $('progress-wrap').classList.add('hidden'); setProgress(0, ''); }, 600);
    if (failed) showErrorToast(`Grille incomplète : ${failed}`);
    else if (stopped) toast(`⏹ Grille arrêtée (${done}/${total} images)`);
    updateCount();
  }

  function init() {
    if (!$('xyz-box')) return;
    [1, 2, 3].forEach(n => {
      const sel = $(`xyz-type-${n}`);
      sel.innerHTML = AXES.map(a => `<option value="${a.id}">${a.label}</option>`).join('');
      sel.addEventListener('change', () => renderAxisInput(n));
      $(`xyz-vals-${n}`).addEventListener('input', updateCount);
      renderAxisInput(n);
    });
    // Les listes (modèles, LoRA…) arrivent après la connexion : on les relit à l'ouverture du panneau
    $('xyz-box').addEventListener('toggle', () => {
      if (!$('xyz-box').open) return;
      [1, 2, 3].forEach(n => {
        const checked = new Set([...document.querySelectorAll(`#xyz-pick-${n} input:checked`)].map(i => i.value));
        if (axisDef($(`xyz-type-${n}`).value).list) {
          renderAxisInput(n);
          document.querySelectorAll(`#xyz-pick-${n} input`).forEach(i => { i.checked = checked.has(i.value); });
        }
      });
      updateCount();
    });
    $('xyz-run').addEventListener('click', run);
    updateCount();
  }

  return { init };
})();

XYZGrid.init();
