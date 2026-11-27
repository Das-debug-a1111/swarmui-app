// ── Extensions de Forge Neo ───────────────────────────────────────────────────
// 1) Panneau construit à partir de /sdapi/v1/script-info : les réglages des scripts qui agissent
//    sur la génération, avec les noms de Neo. Les valeurs partent dans `alwayson_scripts`.
// 2) Recherche dans le catalogue que Neo charge par défaut. L'installation reste faite dans
//    l'interface web de Neo (son API ne le permet pas).
const NeoExt = (() => {
  const INDEX_URL = 'https://raw.githubusercontent.com/eduardoabreu81/forge-neo-extensions/main/index.json';
  const STORE = 'neo-scripts';
  // Déjà présents ailleurs dans l'app (ControlNet, Hires. fix, sampler, seed…) ou sans réglage
  const HIDDEN = new Set(['controlnet', 'imagestitch integrated', 'refiner', 'sampler', 'seed', 'extra options']);

  const el = id => document.getElementById(id);
  const h = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const title = name => name.replace(/\b\w/g, c => c.toUpperCase());

  // ── Réglages des scripts (logique pure) ───────────────────────────────────
  // Les « … Integrated » de Neo ont pour premier réglage leur propre interrupteur
  const switchIndex = s => {
    const a = s.args[0];
    return a && typeof a.value === 'boolean' && String(a.label).toLowerCase() === s.name.toLowerCase() ? 0 : -1;
  };
  const usable = s => s.is_alwayson && !s.is_img2img && !HIDDEN.has(s.name) && s.args.length > 0;
  // Un réglage sans nom (onglet choisi, image) est rangé sous son rang
  const keyOf = (a, i) => a.label || `#${i}`;
  const isChoiceList = a => Array.isArray(a.value) && !!a.choices?.length;   // cases à cocher multiples
  const valueOf = (a, i, st) => {
    const saved = st.values?.[keyOf(a, i)];
    if (saved !== undefined) return saved;
    return isChoiceList(a) ? a.value.filter(v => typeof v === 'string') : a.value ?? null;
  };

  // Valeurs à envoyer pour les scripts activés : { nom: { args: [...] } }, ou undefined
  function buildScripts(scripts, state) {
    const out = {};
    for (const s of scripts.filter(usable)) {
      const st = state[s.name];
      if (!st?.on) continue;
      const sw = switchIndex(s);
      // Neo attend les valeurs dans l'ordre de ses réglages
      out[s.name] = { args: s.args.map((a, i) => (i === sw ? true : valueOf(a, i, st))) };
    }
    return Object.keys(out).length ? out : undefined;
  }

  let scripts = [];
  let state = {};
  try { state = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch {}
  const save = () => { try { localStorage.setItem(STORE, JSON.stringify(state)); } catch {} };

  // En attendant la liste des scripts (démarrage), les valeurs d'un preset restent telles quelles
  let pending = null;
  const payload = () => buildScripts(scripts, state) ?? pending ?? undefined;
  const snapshot = () => JSON.parse(JSON.stringify(state));

  function restore(saved) {
    if (!saved || typeof saved !== 'object') return;
    state = JSON.parse(JSON.stringify(saved));
    save();
    render();
  }

  // Valeurs venant d'un preset (format envoyé à Neo)
  function apply(map) {
    if (!map || typeof map !== 'object') return;
    if (!scripts.length) { pending = map; return; }
    for (const s of scripts.filter(usable)) {
      const args = map[s.name]?.args;
      const st = (state[s.name] ||= { on: false, values: {} });
      st.on = !!args;
      st.values ||= {};
      if (args) s.args.forEach((a, i) => { if (i !== switchIndex(s) && i < args.length) st.values[keyOf(a, i)] = args[i]; });
    }
    save();
    render();
  }

  // ── Panneau ───────────────────────────────────────────────────────────────
  function control(a, value, key) {
    const attr = `data-key="${h(key)}"`;
    if (isChoiceList(a)) {
      return `<div class="field-label">${h(a.label)}</div>${a.choices.map(c =>
        `<label class="check-row"><input type="checkbox" ${attr} data-choice="${h(c)}"${(value || []).includes(c) ? ' checked' : ''}> ${h(c)}</label>`).join('')}`;
    }
    if (typeof a.value === 'boolean') return `<label class="check-row"><input type="checkbox" ${attr}${value ? ' checked' : ''}> ${h(a.label)}</label>`;
    const head = `<div class="field-label">${h(a.label)}</div>`;
    if (a.choices?.length) {
      return `${head}<select class="inp" ${attr}>${a.choices.map(c => `<option value="${h(c)}"${c === value ? ' selected' : ''}>${h(c)}</option>`).join('')}</select>`;
    }
    const num = ['minimum', 'maximum', 'step'].map(k => (a[k] !== undefined ? ` ${k === 'minimum' ? 'min' : k === 'maximum' ? 'max' : 'step'}="${+a[k]}"` : '')).join('');
    if (Array.isArray(a.value)) {
      return `${head}<div class="field-pair">${[0, 1].map(i => `<input type="number" class="inp" ${attr} data-part="${i}"${num} value="${h(value?.[i])}">`).join('')}</div>`;
    }
    if (typeof a.value === 'number') {
      return a.minimum !== undefined && a.maximum !== undefined
        ? `${head}<div class="slider-row"><input type="range" class="slider" ${attr}${num} value="${h(value)}"><input type="text" class="inp" ${attr} value="${h(value)}"></div>`
        : `${head}<input type="number" class="inp" ${attr}${num} value="${h(value)}">`;
    }
    return `${head}<input type="text" class="inp" ${attr} value="${h(value)}">`;
  }

  // Boutons, galeries et champs sans valeur : rien à montrer, la valeur d'origine est envoyée
  const shown = a => a.label && (isChoiceList(a) || ['boolean', 'number', 'string'].includes(typeof a.value)
    || (Array.isArray(a.value) && a.value.length === 2 && a.value.every(v => typeof v === 'number')));

  const fieldHtml = (a, i, st) => `<div class="field">${control(a, valueOf(a, i, st), keyOf(a, i))}</div>`;
  const genericRows = (s, st) => s.args.map((a, i) => (i !== switchIndex(s) && shown(a) ? fieldHtml(a, i, st) : '')).join('');

  // ── Regional Prompter : mêmes onglets Matrix / Mask / Prompt que sur le web ──
  const RP = 'regional prompter';
  const RP_TABS = {
    Matrix: { own: ['Main Splitting', 'Divide Ratio'], help: 'Sépare les zones par BREAK dans le prompt (ou ADDCOL / ADDROW). Divide Ratio règle leur taille.' },
    Mask: { own: ['Mask mode'], help: 'Peins chaque zone d’une couleur. Dans le prompt, les parties séparées par BREAK suivent l’ordre des couleurs 1, 2, 3, 4.' },
    Prompt: { own: ['Prompt mode', 'threshold'], help: 'Les zones sont déduites des mots du prompt : « … red hair BREAK blue shirt BREAK », puis le mot visé par chaque partie.' },
  };
  const RP_BEFORE = ['Generation Mode', 'Base Ratio', 'Use base prompt', 'Use common prompt', 'Use common negative prompt'];
  // Couleurs reconnues par l'extension : teintes 0, 180, 90, 270 à 50 % de saturation et de valeur
  const RP_COLOURS = ['#7f3f3f', '#3f7f7f', '#5f7f3f', '#5f3f7f'];

  function regionalRows(s, st) {
    const index = label => s.args.findIndex(a => a.label === label);
    const pick = labels => labels.map(index).filter(i => i >= 0).map(i => fieldHtml(s.args[i], i, st)).join('');
    const tabAt = s.args.findIndex((a, i) => i > 0 && !a.label && Object.keys(RP_TABS).includes(a.value));
    const maskAt = s.args.findIndex((a, i) => i > 0 && !a.label && a.value === null);
    const tab = valueOf(s.args[tabAt], tabAt, st) || 'Matrix';
    const used = new Set([...RP_BEFORE, ...Object.values(RP_TABS).flatMap(t => t.own)]);
    const after = s.args.map((a, i) => (i > 0 && a.label && !used.has(a.label) && shown(a) ? fieldHtml(a, i, st) : '')).join('');
    const painter = tab !== 'Mask' || maskAt < 0 ? '' : `<div class="rp-paint" data-key="#${maskAt}">
      <div class="rp-colours">${RP_COLOURS.map((c, i) => `<button type="button" class="rp-colour${i ? '' : ' active'}" data-colour="${c}" style="background:${c}">${i + 1}</button>`).join('')}
        <button type="button" class="btn-sm rp-clear">Effacer</button></div>
      <input type="range" class="slider rp-size" min="4" max="120" value="40" title="Taille du pinceau">
      <canvas class="rp-canvas"></canvas>
      <label class="btn-sm rp-import">Importer un masque<input type="file" accept="image/*" hidden></label>
    </div>`;
    return pick(RP_BEFORE) +
      `<div class="rp-tabs">${Object.keys(RP_TABS).map(n => `<button type="button" class="family-chip${n === tab ? ' active' : ''}" data-rptab="${n}" data-key="#${tabAt}">${n}</button>`).join('')}</div>` +
      `<div class="field-hint">${h(RP_TABS[tab].help)} Sans BREAK ni ADD… dans le prompt, l’extension ne fait rien.</div>` +
      pick(RP_TABS[tab].own) + painter + after;
  }

  // Dessin du masque : fond blanc (libre), une couleur par zone, au format de l'image à générer
  function setupPainter(box, st) {
    const wrap = box.querySelector('.rp-paint');
    if (!wrap) return;
    const canvas = wrap.querySelector('canvas');
    const w = parseInt(el('inp-width').value, 10) || 1024, h2 = parseInt(el('inp-height').value, 10) || 1024;
    const k = 512 / Math.max(w, h2);
    canvas.width = Math.round(w * k);
    canvas.height = Math.round(h2 * k);
    const g = canvas.getContext('2d');
    const key = wrap.dataset.key;
    const white = () => { g.fillStyle = '#fff'; g.fillRect(0, 0, canvas.width, canvas.height); };
    const draw = src => { const img = new Image(); img.onload = () => { white(); g.drawImage(img, 0, 0, canvas.width, canvas.height); }; img.src = src; };
    const keep = value => { st.values ||= {}; st.values[key] = value; save(); };
    white();
    if (st.values?.[key]) draw(st.values[key]);
    let colour = RP_COLOURS[0], last = null;
    const point = e => {
      const r = canvas.getBoundingClientRect();
      return [(e.clientX - r.left) * canvas.width / r.width, (e.clientY - r.top) * canvas.height / r.height];
    };
    const stroke = (from, to) => {
      g.strokeStyle = colour;
      g.lineCap = g.lineJoin = 'round';
      g.lineWidth = +wrap.querySelector('.rp-size').value;
      g.beginPath();
      g.moveTo(...from);
      g.lineTo(...to);
      g.stroke();
    };
    canvas.addEventListener('pointerdown', e => { canvas.setPointerCapture(e.pointerId); last = point(e); stroke(last, last); });
    canvas.addEventListener('pointermove', e => { if (!last) return; const p = point(e); stroke(last, p); last = p; });
    canvas.addEventListener('pointerup', () => { if (!last) return; last = null; keep(canvas.toDataURL('image/png')); });
    wrap.querySelectorAll('.rp-colour').forEach(b => b.addEventListener('click', () => {
      colour = b.dataset.colour;
      wrap.querySelectorAll('.rp-colour').forEach(x => x.classList.toggle('active', x === b));
    }));
    wrap.querySelector('.rp-clear').addEventListener('click', () => { white(); keep(null); });
    wrap.querySelector('input[type=file]').addEventListener('change', e => {
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => { keep(reader.result); draw(reader.result); };
      reader.readAsDataURL(file);
    });
  }

  function render() {
    const box = el('neo-scripts');
    if (!box) return;
    const list = scripts.filter(usable);
    el('neo-scripts-hint').textContent = list.length
      ? `${list.length} scripts de Neo. Coche pour activer.`
      : 'Aucun script avec des réglages : connecte-toi à Neo puis ↻.';
    box.innerHTML = list.map((s, n) => {
      const st = state[s.name] || {};
      const rows = s.name === RP ? regionalRows(s, st) : genericRows(s, st);
      return `<div class="ext-group" data-script="${n}">
        <div class="ext-group-hdr"><label><input type="checkbox" class="neo-script-on"${st.on ? ' checked' : ''}> ${h(title(s.name))}</label></div>
        <div class="neo-script-body"${st.on ? '' : ' hidden'}>${rows}</div>
      </div>`;
    }).join('');
    box.__scripts = list;
    box.querySelectorAll('.ext-group').forEach(g => {
      const s = list[+g.dataset.script];
      if (s.name === RP) setupPainter(g, (state[s.name] ||= { on: false, values: {} }));
    });
  }

  function onEdit(e) {
    const group = e.target.closest('.ext-group');
    if (!group) return;
    const s = el('neo-scripts').__scripts[+group.dataset.script];
    const st = (state[s.name] ||= { on: false, values: {} });
    st.values ||= {};
    pending = null;
    if (e.target.classList.contains('neo-script-on')) {
      st.on = e.target.checked;
      group.querySelector('.neo-script-body').hidden = !st.on;
    } else {
      const key = e.target.dataset.key;
      const a = s.args.find((x, i) => keyOf(x, i) === key);
      if (!a || e.target.closest('.rp-paint')) return;
      const inputs = [...group.querySelectorAll('[data-key]')].filter(x => x.dataset.key === key);
      if (isChoiceList(a)) st.values[key] = inputs.filter(x => x.checked).map(x => x.dataset.choice);
      else if (typeof a.value === 'boolean') st.values[key] = e.target.checked;
      else if (Array.isArray(a.value)) st.values[key] = inputs.map((x, i) => (x.value === '' ? a.value[i] : +x.value));
      else if (typeof a.value === 'number') {
        const v = parseFloat(e.target.value);
        if (!Number.isFinite(v)) return;
        st.values[key] = v;
        inputs.forEach(x => { if (x !== e.target) x.value = v; });
      } else st.values[key] = e.target.value;
    }
    save();
  }

  async function load() {
    try {
      scripts = await NeoBackend.call('/sdapi/v1/script-info');
    } catch (e) {
      scripts = [];
      console.warn('[Extensions Neo]', e.message);
    }
    if (pending) { const map = pending; pending = null; apply(map); }
    render();
  }

  // Neo ouvert sur le réseau refuse d'installer depuis son interface (protection voulue) : on donne
  // la commande à lancer sur le PC. Le catalogue n'est pas sûr : seule une adresse GitHub simple
  // peut entrer dans une commande.
  function installCommand(url, neoDir) {
    const m = String(url || '').match(/^https:\/\/github\.com\/[\w.-]+\/([\w.-]+?)(?:\.git)?\/?$/i);
    if (!m || !neoDir || /["&|<>^%!]/.test(neoDir) || /^\.+$/.test(m[1])) return '';
    return `git clone ${String(url).replace(/\/$/, '')} "${neoDir}\\extensions\\${m[1]}"`;
  }

  // Dossier de Neo sur le PC, déduit de l'emplacement de ses fichiers
  async function neoFolder() {
    const modules = await NeoBackend.call('/sdapi/v1/sd-modules');
    for (const mod of modules) {
      const hit = String(mod.filename).match(/^(.*?)[\\/]models[\\/](?:VAE|text_encoder)[\\/]/i);
      if (hit) return hit[1];
    }
    return '';
  }

  // ── Catalogue ─────────────────────────────────────────────────────────────
  let catalogue = null;
  let installed = [];
  const repoKey = url => String(url || '').toLowerCase().replace(/\.git$/, '').replace(/\/$/, '');
  const isInstalled = x => installed.some(i => repoKey(i.remote) === repoKey(x.url) || String(i.name).toLowerCase() === repoKey(x.url).split('/').pop());
  const forNeo = x => (x.tags || []).includes('forge-neo');

  function filterCatalogue(list, { query = '', neoOnly = true, sort = 'stars' } = {}) {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    const date = x => String(x.commit_time || x.added || '');
    return list
      .filter(x => !neoOnly || forNeo(x))
      .filter(x => {
        const text = `${x.name} ${x.description || ''} ${x.github_description || ''} ${x.full_name || ''}`.toLowerCase();
        return words.every(w => text.includes(w));
      })
      .sort((a, b) => sort === 'date' ? date(b).localeCompare(date(a))
        : sort === 'name' ? String(a.name).localeCompare(String(b.name))
          : (b.stars || 0) - (a.stars || 0));
  }

  function renderCatalogue() {
    if (!catalogue) return;
    const list = filterCatalogue(catalogue, { query: el('neo-cat-search').value, neoOnly: el('neo-cat-neo').checked, sort: el('neo-cat-sort').value });
    el('neo-cat-count').textContent = `${list.length} extension${list.length > 1 ? 's' : ''} sur ${catalogue.length}` + (list.length > 150 ? ' (150 affichées)' : '');
    el('neo-cat-list').innerHTML = list.slice(0, 150).map(x => {
      const url = /^https:\/\//i.test(x.url) ? x.url : '';
      return `<div class="neo-cat-item" data-url="${h(url)}">
        <div class="neo-cat-head"><b>${h(String(x.name).replace(/^🟢\s*/, ''))}</b>
          ${forNeo(x) ? '<span class="neo-cat-tag">Neo</span>' : ''}${isInstalled(x) ? '<span class="neo-cat-tag on">Installée</span>' : ''}
          <span class="neo-cat-meta">★ ${+x.stars || 0} · ${h(String(x.commit_time || '').slice(0, 10))}</span></div>
        <div class="neo-cat-desc">${h(x.description || x.github_description || '')}</div>
        <div class="neo-cat-actions">${url ? `<button type="button" class="btn-sm" data-act="see">Voir sur GitHub</button>
          <button type="button" class="btn-sm" data-act="install">Copier la commande d’installation</button>` : ''}</div>
      </div>`;
    }).join('') || '<div class="field-hint">Aucune extension ne correspond.</div>';
  }

  async function openCatalogue() {
    el('neo-cat').hidden = false;
    el('neo-cat-search').focus();
    try { installed = await NeoBackend.call('/sdapi/v1/extensions'); } catch { installed = []; }
    if (!catalogue) {
      el('neo-cat-count').textContent = 'Chargement du catalogue…';
      try {
        const r = await fetch(INDEX_URL, { signal: AbortSignal.timeout(20000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const data = await r.json();
        catalogue = (Array.isArray(data) ? data : data.extensions || []).filter(x => x && x.name && x.url);
      } catch (e) {
        el('neo-cat-count').textContent = `Catalogue inaccessible : ${e.message}`;
        return;
      }
    }
    renderCatalogue();
  }

  async function onCatalogueClick(e) {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const url = btn.closest('.neo-cat-item').dataset.url;
    if (btn.dataset.act === 'see') { window.open(url); return; }
    // Installation : la commande est copiée, à lancer sur le PC
    const command = installCommand(url, await neoFolder().catch(() => ''));
    await navigator.clipboard.writeText(command || url);
    toast(command
      ? 'Commande copiée. Lance-la sur le PC (invite de commandes), redémarre Neo, puis ↻ ici.'
      : 'Adresse copiée : installe-la à la main dans le dossier « extensions » de Neo, puis redémarre-le.', 9000);
  }

  // Changement d'onglet de Regional Prompter
  function onTab(e) {
    const btn = e.target.closest('[data-rptab]');
    if (!btn) return;
    const s = el('neo-scripts').__scripts[+btn.closest('.ext-group').dataset.script];
    const st = (state[s.name] ||= { on: false, values: {} });
    st.values ||= {};
    st.values[btn.dataset.key] = btn.dataset.rptab;
    save();
    render();
  }

  function init() {
    el('neo-scripts').addEventListener('click', onTab);
    el('neo-scripts').addEventListener('input', onEdit);
    el('neo-scripts').addEventListener('change', onEdit);
    el('btn-reload-neo-scripts').addEventListener('click', e => { e.stopPropagation(); load(); });
    el('btn-neo-catalogue').addEventListener('click', openCatalogue);
    el('neo-cat-close').addEventListener('click', () => { el('neo-cat').hidden = true; });
    el('neo-cat').addEventListener('click', e => { if (e.target === el('neo-cat')) el('neo-cat').hidden = true; });
    el('neo-cat-search').addEventListener('input', renderCatalogue);
    el('neo-cat-neo').addEventListener('change', renderCatalogue);
    el('neo-cat-sort').addEventListener('change', renderCatalogue);
    el('neo-cat-list').addEventListener('click', onCatalogueClick);
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !el('neo-cat').hidden) el('neo-cat').hidden = true; });
  }

  const api = { init, load, payload, apply, snapshot, restore, buildScripts, filterCatalogue, installCommand };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
