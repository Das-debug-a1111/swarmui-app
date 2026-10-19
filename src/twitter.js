// ── Twitter : défi + génération + filigrane ───────────────────────────────────
// Tire 3 persos au sort + 1 preset (Bimbo/Futa) pour débloquer les idées de contenu.
// Choisir un perso remplit le prompt de CET onglet ; « Generate » génère ici via SwarmUI
// (un Txt2Img parallèle qui ne touche pas à l'onglet Txt2Img) et les images arrivent
// directement dans le filigrane (src/watermark.js) pour l'export.
// Historique local pour éviter les répétitions et suivre ce qui a déjà été posté.
const Twitter = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const HIST_KEY           = 'twitter-challenge-history';
  const HIST_EXCLUDE_COUNT = 15;   // don't reroll these recently-used names
  const HIST_MAX           = 200;
  const PRESET_LABELS      = ['Bimbo', 'Futa'];

  // Idées de scène = 1 tag lieu + 1 tag ambiance + 1 tag tenue (tags Danbooru, en anglais).
  // Seuls les candidats présents dans le CSV Danbooru chargé dans Txt2Img (Autocomplétion des tags) sont
  // gardés, sous leur nom exact dans le CSV, et les plus utilisés sur Danbooru sortent plus souvent.
  const CANDIDATES = {
    lieu: [
      'bedroom', 'bathroom', 'shower_(place)', 'kitchen', 'poolside', 'beach', 'locker_room', 'gym', 'office',
      'library', 'classroom', 'forest', 'alley', 'car_interior', 'hotel_room', 'rooftop', 'fitting_room',
      'onsen', 'garden', 'balcony', 'nightclub', 'cafe', 'elevator', 'hot_tub', 'living_room', 'bathtub',
      'train_interior', 'park', 'city', 'stage', 'dressing_room', 'infirmary', 'church', 'bar_(place)', 'jungle',
      'waterfall', 'cave', 'castle', 'shrine', 'convenience_store', 'gym_storeroom', 'sauna', 'tent', 'boat',
    ],
    ambiance: [
      'sunset', 'sunrise', 'night', 'rain', 'snow', 'fog', 'steam', 'sunlight', 'moonlight', 'backlighting',
      'light_rays', 'sunbeam', 'dim_lighting', 'neon_lights', 'candlelight', 'cherry_blossoms', 'autumn_leaves',
      'bokeh', 'lens_flare', 'night_sky', 'starry_sky', 'fireworks', 'wet', 'dusk', 'blue_sky', 'cloudy_sky',
      'cyberpunk', 'christmas', 'halloween', 'summer', 'winter',
    ],
    outfit: [
      'lingerie', 'lace-trimmed_panties', 'bikini', 'string_bikini', 'micro_bikini', 'one-piece_swimsuit',
      'competition_swimsuit', 'school_uniform', 'serafuku', 'maid', 'gym_uniform', 'sportswear', 'office_lady',
      'pencil_skirt', 'kimono', 'yukata', 'evening_gown', 'hoodie', 'naked_towel', 'bathrobe', 'latex',
      'bodysuit', 'sundress', 'playboy_bunny', 'crop_top', 'jeans', 'gothic_lolita', 'nightgown', 'babydoll',
      'see-through', 'cheerleader', 'nurse', 'police_uniform', 'china_dress', 'wedding_dress', 'leotard',
      'thighhighs', 'garter_belt', 'naked_shirt', 'oversized_shirt', 'apron', 'nun',
    ],
  };
  const KINDS = ['lieu', 'ambiance', 'outfit'];

  const S = {
    loaded:    false,
    allChars:  [],   // [{name, series}]
    tagAssist: {},
    current:   null, // { label, chars: [{name,series}, ...], ideas: [{lieu,ambiance,outfit}, ...] }
    chosen:    null, // { char, histId } — perso choisi pour la génération (l'idée utilisée = current.active)
    pools:     null, // { lieu: [{name,count}], … } — candidats retenus d'après le CSV
    fromCsv:   false,
    running:   false,
    count:     4,
    presetMissing: null, // label du preset du défi s'il est introuvable (bloque Generate)
  };
  const thumbCache = new Map();
  const THUMB_PARALLEL = 2;
  const thumbQueue = [];
  let thumbActive = 0;
  let imgSeq = 0;   // compteur persistant : noms d'images uniques entre générations
  let initialized = false;

  // ── Character data (same IPC as the Character panel) ─────────────────────
  async function loadCharData() {
    if (S.loaded || !window.electronAPI?.charList) return;
    try {
      const [list, tags] = await Promise.all([
        window.electronAPI.charList(),
        window.electronAPI.charTags(),
      ]);
      if (Array.isArray(list)) S.allChars = list;
      S.tagAssist = tags || {};
      if (Array.isArray(list)) S.loaded = true;
    } catch (e) { console.error('[Twitter] loadCharData:', e); }
  }

  async function loadThumb(img, name) {
    if (!img) return;
    if (thumbCache.has(name)) {
      const cached = thumbCache.get(name);
      if (cached) { img.src = cached; img.classList.add('loaded'); }
      return;
    }
    await new Promise(resolve => { thumbQueue.push(resolve); pumpThumbs(); });
    try {
      const dataUrl = await window.electronAPI.charThumb(name);
      if (dataUrl) { thumbCache.set(name, dataUrl); img.src = dataUrl; img.classList.add('loaded'); }
    } catch { /* thumb missing — leave placeholder */ }
    finally { thumbActive--; pumpThumbs(); }
  }

  function pumpThumbs() {
    while (thumbActive < THUMB_PARALLEL && thumbQueue.length) { thumbActive++; thumbQueue.shift()(); }
  }

  // ── History (localStorage) ────────────────────────────────────────────────
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
  }
  function saveHistory(list) {
    try { localStorage.setItem(HIST_KEY, JSON.stringify(list)); }
    catch (e) { console.warn('[Twitter] history not saved:', e); }
  }

  function addHistory(entry) {
    const list = getHistory();
    const id = 'h' + Date.now() + Math.random().toString(36).slice(2, 6);
    list.unshift({ id, date: new Date().toISOString(), posted: false, ...entry });
    saveHistory(list.slice(0, HIST_MAX));
    renderHistory();
    return id;
  }

  function togglePosted(id) {
    const list = getHistory();
    const e = list.find(x => x.id === id);
    if (!e) return;
    e.posted = !e.posted;
    saveHistory(list);
    renderHistory();
    updatePostedBtn();
  }

  // ── Preset lookup (reuses the sidebar Presets, saved by the user) ────────
  function findPresetEntry(label) {
    const data = getPresetsData(); // {title: param_map}
    const key = Object.keys(data).find(k => k.toLowerCase() === label.toLowerCase());
    return key ? { title: key, param_map: data[key] } : null;
  }

  // ── Roll ───────────────────────────────────────────────────────────────────
  function pickThree() {
    const recent = new Set(getHistory().slice(0, HIST_EXCLUDE_COUNT).map(h => h.name));
    let pool = S.allChars.filter(c => !recent.has(c.name));
    if (pool.length < 3) pool = S.allChars; // not enough left excluding recents — allow repeats
    const copy = [...pool], picks = [];
    while (picks.length < 3 && copy.length) {
      picks.push(copy.splice(Math.floor(Math.random() * copy.length), 1)[0]);
    }
    return picks;
  }

  // Candidats présents dans le CSV (sinon liste par défaut si le CSV n'est pas chargé)
  function buildPools() {
    const pools = {};
    let fromCsv = typeof TagComplete !== 'undefined' && TagComplete.hasDB();
    for (const k of KINDS) {
      const found = fromCsv ? CANDIDATES[k].map(n => TagComplete.tagInfo(n)).filter(Boolean) : [];
      const uniq = [...new Map(found.map(t => [t.name, t])).values()];
      pools[k] = uniq.length >= 3 ? uniq : CANDIDATES[k].map(name => ({ name, count: 1 }));
      if (uniq.length < 3) fromCsv = false;
    }
    S.pools = pools;
    S.fromCsv = fromCsv;
  }

  // Tirage pondéré par la popularité (racine carrée : les tags très courants ne monopolisent pas tout)
  function weightedPick(pool) {
    const w = pool.map(t => Math.sqrt(Math.max(1, t.count)));
    let r = Math.random() * w.reduce((a, b) => a + b, 0);
    for (let i = 0; i < pool.length; i++) { r -= w[i]; if (r <= 0) return pool[i].name; }
    return pool[pool.length - 1].name;
  }

  function rollOneIdea() {
    if (!S.pools) buildPools();
    return { lieu: weightedPick(S.pools.lieu), ambiance: weightedPick(S.pools.ambiance), outfit: weightedPick(S.pools.outfit) };
  }
  function ideaKey(idea) { return ideaText(idea); }
  // Texte de l'idée : les 3 tags, ou ce que tu as écrit à la main dans la ligne
  function ideaText(idea) { return idea.text ?? `${idea.lieu}, ${idea.ambiance}, ${idea.outfit}`; }
  const activeIdea = () => S.current?.ideas?.[S.current.active ?? 0] || null;

  function rollIdeas(n = 4) {
    const ideas = [], seen = new Set();
    let guard = 0;
    while (ideas.length < n && guard++ < 200) {
      const idea = rollOneIdea();
      const key = ideaKey(idea);
      if (seen.has(key)) continue;
      seen.add(key);
      ideas.push(idea);
    }
    return ideas;
  }

  function rerollIdea(i) {
    if (!S.current) return;
    const otherKeys = new Set(S.current.ideas.map((idea, idx) => idx === i ? null : ideaKey(idea)).filter(Boolean));
    let idea, guard = 0;
    do { idea = rollOneIdea(); } while (otherKeys.has(ideaKey(idea)) && guard++ < 50);
    S.current.ideas[i] = idea;
    renderIdeas();
    if (i === S.current.active) refreshPrompt();
  }

  // L'idée choisie est celle mise dans le prompt
  function selectIdea(i) {
    if (!S.current || S.current.active === i) return;
    S.current.active = i;
    $('tw-ideas').querySelectorAll('.tw-idea').forEach((r, k) => {
      r.classList.toggle('tw-idea-main', k === i);
      r.querySelector('.tw-idea-num').textContent = k === i ? '★' : k + 1;
    });
    refreshPrompt();
  }

  function refreshPrompt() {
    if (!S.chosen) return;
    $('tw-prompt').value = promptFor(S.chosen.char, activeIdea());
    $('tw-chosen-idea').textContent = activeIdea() ? ideaText(activeIdea()) : '';
  }

  function roll() {
    const label = PRESET_LABELS[Math.floor(Math.random() * PRESET_LABELS.length)];
    const chars = pickThree();
    if (!chars.length) return;
    buildPools();   // le CSV a pu être chargé depuis le dernier tirage
    S.current = { label, chars, ideas: rollIdeas(4), active: 0 };
    render();
  }

  // ── Render ───────────────────────────────────────────────────────────────
  function render() {
    if (!S.current) return;
    const entry = findPresetEntry(S.current.label);
    const badge = $('tw-preset-badge');
    badge.style.display = '';
    badge.textContent = entry ? '🎯 ' + S.current.label : '⚠️ ' + S.current.label + ' (preset introuvable)';
    badge.className = 'tw-preset-badge ' + (entry ? 'tw-preset-' + S.current.label.toLowerCase() : 'tw-preset-missing');

    $('tw-empty').style.display = 'none';
    S.presetMissing = entry ? null : S.current.label;
    if (entry) selectPreset(entry.title);
    else { $('tw-preset-sel').value = ''; $('tw-preset-info').textContent = ''; }
    const wrap = $('tw-cards');
    wrap.innerHTML = '';
    S.current.chars.forEach(c => wrap.appendChild(buildCard(c)));

    renderIdeas();
  }

  function renderIdeas() {
    const wrap = $('tw-ideas');
    if (!wrap || !S.current?.ideas) return;
    wrap.innerHTML = '';
    S.current.ideas.forEach((idea, i) => {
      const active = i === (S.current.active ?? 0);
      const row = document.createElement('div');
      row.className = 'tw-idea' + (active ? ' tw-idea-main' : '');
      row.innerHTML = `
        <button class="tw-idea-num" title="Utiliser cette idée">${active ? '★' : i + 1}</button>
        <input class="tw-idea-input" spellcheck="false" title="Clique pour utiliser cette idée ; tu peux aussi modifier les tags">
        <button class="tw-idea-reroll" title="Tirer une autre idée">🔀</button>`;
      const input = row.querySelector('.tw-idea-input');
      input.value = ideaText(idea);
      input.addEventListener('focus', () => selectIdea(i));
      input.addEventListener('input', () => {
        idea.text = input.value;
        if (i === S.current.active) refreshPrompt();
      });
      if (typeof TagComplete !== 'undefined') TagComplete.attach(input);
      row.querySelector('.tw-idea-num').addEventListener('click', () => selectIdea(i));
      row.querySelector('.tw-idea-reroll').addEventListener('click', () => rerollIdea(i));
      row.addEventListener('click', e => { if (e.target === row) selectIdea(i); });
      wrap.appendChild(row);
    });
    $('tw-ideas-hint').textContent = S.fromCsv
      ? 'Tags tirés de ton CSV Danbooru. ★ = idée mise dans le prompt : clique une autre ligne pour la choisir, ou modifie les tags.'
      : 'CSV Danbooru non chargé : tags par défaut. Charge-le dans Txt2Img → Autocomplétion des tags pour que les idées viennent de ton CSV.';
  }

  function buildCard(char) {
    const card = document.createElement('div');
    card.className = 'tw-card' + (S.chosen?.char.name === char.name ? ' chosen' : '');
    card.dataset.name = char.name;
    card.innerHTML = `
      <div class="cs-thumb-wrap" style="height:100%">
        <img class="cs-thumb" src="" alt="">
        <div class="cs-card-overlay">
          <div class="cs-name">${esc(char.name)}</div>
          <div class="tw-card-series">${esc(char.series || '')}</div>
        </div>
      </div>`;
    loadThumb(card.querySelector('.cs-thumb'), char.name);
    card.addEventListener('click', () => selectCharacter(char));
    return card;
  }

  // ── Choix d'un perso : prompt de l'onglet + historique ────────────────────
  function promptFor(char, idea) {
    const base  = String(currentPreset()?.prompt || '').trim().replace(/,\s*$/, '');
    const extra = S.tagAssist[char.name] ? ', ' + S.tagAssist[char.name] : '';
    const ideaT = idea ? ', ' + ideaText(idea) : '';
    return (base ? base + ', ' : '') + char.name + extra + ideaT;
  }

  function selectCharacter(char) {
    const label = S.current.label;
    const entry = findPresetEntry(label);
    if (!entry) toast(`⚠️ Preset "${label}" introuvable — sauvegarde-le dans les Presets de Txt2Img`);
    const idea = activeIdea();
    const histId = addHistory({
      name: char.name, series: char.series, preset: label, presetFound: !!entry,
      idea: idea ? ideaText(idea) : '',
      ideas: (S.current.ideas || []).map(ideaText),
    });
    S.chosen = { char, histId };
    $('tw-prompt').value = promptFor(char, idea);
    $('tw-chosen').hidden = false;
    $('tw-chosen-name').textContent = char.name + (char.series ? ` · ${char.series}` : '');
    $('tw-chosen-idea').textContent = idea ? ideaText(idea) : '';
    loadThumb($('tw-chosen-img'), char.name);
    document.querySelectorAll('#tw-cards .tw-card').forEach(c => c.classList.toggle('chosen', c.dataset.name === char.name));
    updatePostedBtn();
    toast(`🐦 ${char.name} · ${label} — prêt à générer`);
  }

  // ── Génération dans l'onglet (Txt2Img parallèle) ──────────────────────────
  function presetNames() { return Object.keys(getPresetsData()).sort((a, b) => a.localeCompare(b)); }
  function currentPreset() { return getPresetsData()[$('tw-preset-sel').value] || null; }

  function fillPresetSelect() {
    const sel = $('tw-preset-sel');
    const missing = S.presetMissing;
    const cur = missing ? '' : sel.value || localStorage.getItem('tw-preset') || '';
    sel.innerHTML = '<option value="">— Aucun —</option>' + presetNames().map(n => `<option value="${esc(n)}">${esc(n)}</option>`).join('');
    if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
    // Preset du défi enfin sauvegardé : on le sélectionne ; sinon le select reste sur « Aucun »
    const entry = missing && S.current ? findPresetEntry(S.current.label) : null;
    if (entry) { S.presetMissing = null; selectPreset(entry.title); }
  }

  function fillModelSelect() {
    const sel = $('tw-model');
    const cur = sel.value || currentPreset()?.model || '';
    const models = (App.models || []).map(m => m.name);
    if (cur && !models.includes(cur)) models.unshift(cur);
    sel.innerHTML = models.length
      ? models.map(m => `<option value="${esc(m)}">${esc(m.split('/').pop().replace(/\.(safetensors|gguf|ckpt)$/i, ''))}</option>`).join('')
      : '<option value="">— Connect first —</option>';
    if (cur) sel.value = cur;
  }

  // Applique un preset aux réglages de l'onglet (modèle, steps, CFG, taille) et reconstruit le prompt
  function selectPreset(name) {
    const sel = $('tw-preset-sel');
    if (name !== undefined) sel.value = name;
    localStorage.setItem('tw-preset', sel.value);
    const m = currentPreset() || {};
    if (m.model) { fillModelSelect(); $('tw-model').value = m.model; }
    if (m.steps)    $('tw-steps').value  = m.steps;
    if (m.cfgscale) $('tw-cfg').value    = m.cfgscale;
    if (m.width)    $('tw-width').value  = m.width;
    if (m.height)   $('tw-height').value = m.height;
    $('tw-neg').value = m.negativeprompt || $('tw-neg').value;
    const loras = m.loras ? String(m.loras).split(',').filter(Boolean) : [];
    $('tw-preset-info').textContent = [
      loras.length ? `LoRAs du preset : ${loras.map(l => l.replace(/\.safetensors$/i, '')).join(', ')}` : '',
      m.refinerupscale ? `Refiner ×${m.refinerupscale}` : '',
    ].filter(Boolean).join(' · ');
    if (S.chosen) $('tw-prompt').value = promptFor(S.chosen.char, activeIdea());
  }

  function setCount(v) {
    S.count = +v;
    document.querySelectorAll('#tw-seg-count button').forEach(b => b.classList.toggle('active', +b.dataset.v === S.count));
  }

  function buildPayload() {
    const prompt = $('tw-prompt').value.trim();
    if (!prompt) { showErrorToast('Choisis un perso du défi ou écris un prompt.'); return null; }
    const model = $('tw-model').value;
    if (!model) { showErrorToast('Choisis un modèle.'); return null; }
    const cfg = parseFloat($('tw-cfg').value);
    // Base = tout le preset (sampler, scheduler, LoRAs, refiner…), puis les réglages de l'onglet
    const payload = { ...(currentPreset() || {}) };
    delete payload.prompt;
    Object.assign(payload, {
      prompt,
      negativeprompt: $('tw-neg').value.trim(),
      model,
      steps:    parseInt($('tw-steps').value, 10)  || 20,
      cfgscale: Number.isFinite(cfg) ? cfg : 7,
      width:    parseInt($('tw-width').value, 10)  || 1024,
      height:   parseInt($('tw-height').value, 10) || 1024,
      images:   S.count,
      seed:     -1,
    });
    for (const k of ['refinerupscale', 'refinercontrolpercentage', 'refinersteps', 'refinercfgscale']) {
      if (payload[k] !== undefined) payload[k] = +payload[k];
    }
    Object.keys(payload).forEach(k => (payload[k] === '' || payload[k] === undefined) && delete payload[k]);
    return payload;
  }

  function setProgress(pct, label) {
    $('tw-progress-bar').style.width = `${Math.round(Math.min(1, Math.max(0, pct)) * 100)}%`;
    $('tw-progress-pct').textContent = `${Math.round(pct * 100)}%`;
    if (label !== undefined) $('tw-progress-label').textContent = label;
  }

  function finish() {
    S.running = false;
    $('tw-generate').textContent = 'Generate';
    $('tw-generate').classList.remove('running');
    setTimeout(() => $('tw-progress').classList.add('hidden'), 1200);
  }

  function generate() {
    if (S.running) { API.interrupt?.().catch(() => {}); finish(); return; }
    if (!App.connected) { showErrorToast('Non connecté à SwarmUI'); return; }
    if (S.presetMissing) { showErrorToast(`Preset "${S.presetMissing}" introuvable — sauvegarde-le dans les Presets de Txt2Img ou choisis-en un autre`); return; }
    const payload = buildPayload();
    if (!payload) return;
    S.running = true;
    $('tw-generate').textContent = 'Stop';
    $('tw-generate').classList.add('running');
    $('tw-progress').classList.remove('hidden');
    setProgress(0, 'Démarrage…');
    let n = 0;
    const baseName = (S.chosen?.char.name || 'twitter').replace(/[^\w-]+/g, '_');
    API.generate(payload, {
      onProgress(status, pct) {
        const label = typeof status === 'string' ? status : (status?.title || status?.stage || 'Génération…');
        setProgress(pct > 0 ? pct : 0, `Image ${n + 1} sur ${payload.images} — ${label}`);
      },
      onPreview() {},
      onImage(imgData) {
        const src = typeof imgData === 'string' && (imgData.startsWith('data:') || imgData.startsWith('http'))
          ? imgData : `${API.origin}/${imgData}`;
        n++;
        Watermark.loadFromSrc(src, { name: `${baseName}_${++imgSeq}`, select: n === 1 });
      },
      onDone() { setProgress(1, `${n} image${n > 1 ? 's' : ''} prête${n > 1 ? 's' : ''}`); finish(); },
      onError(err) { finish(); showErrorToast(`Génération : ${err}`); },
    });
  }

  // Ouvre le prompt + le preset dans l'onglet Txt2Img (ancien comportement)
  function openInTxt2Img() {
    const name = $('tw-preset-sel').value;
    const m = currentPreset();
    if (m) applyPreset({ title: name, param_map: m });
    $('inp-positive').value = $('tw-prompt').value;
    $('inp-negative').value = $('tw-neg').value;
    window.setCount(String(S.count));   // celui de Txt2Img (app.js), pas setCount() de cet onglet
    switchTab('txt2img');
  }

  // ── « Posté » pour le défi en cours ──────────────────────────────────────
  function updatePostedBtn() {
    const btn = $('tw-posted');
    const e = S.chosen && getHistory().find(x => x.id === S.chosen.histId);
    btn.hidden = !e;
    if (e) { btn.textContent = e.posted ? '✅ Posté' : '☐ Marquer comme posté'; btn.classList.toggle('done', !!e.posted); }
  }

  // ── History list UI ─────────────────────────────────────────────────────
  function renderHistory() {
    const list = getHistory();
    $('tw-hist-count').textContent = list.length ? String(list.length) : '';
    const wrap = $('tw-hist-list');
    wrap.innerHTML = '';
    if (!list.length) {
      wrap.innerHTML = '<div style="color:var(--muted);font-size:12px;padding:8px 0">Aucun défi pour l\'instant.</div>';
      return;
    }
    list.slice(0, 60).forEach(e => {
      const row = document.createElement('div');
      row.className = 'tw-hist-row';
      const dateStr = new Date(e.date).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit' });
      const otherIdeas = (e.ideas || []).slice(1);
      if (otherIdeas.length) row.title = '3 autres idées :\n' + otherIdeas.join('\n');
      row.innerHTML = `
        <img class="tw-hist-thumb" alt="">
        <span class="tw-hist-name">${esc(e.name)}</span>
        ${e.idea ? `<span class="tw-hist-idea">${esc(e.idea)}</span>` : ''}
        <span class="tw-preset-badge sm tw-preset-${esc((e.preset || '').toLowerCase())}">${esc(e.preset || '')}</span>
        <span class="tw-hist-date">${dateStr}</span>
        <span class="tw-hist-posted${e.posted ? ' done' : ''}" title="Marquer comme posté">${e.posted ? '✅' : '☐'}</span>`;
      loadThumb(row.querySelector('.tw-hist-thumb'), e.name);
      row.querySelector('.tw-hist-posted').addEventListener('click', () => togglePosted(e.id));
      wrap.appendChild(row);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function bindUI() {
    $('tw-generate').addEventListener('click', generate);
    $('tw-to-txt2img').addEventListener('click', openInTxt2Img);
    $('tw-preset-sel').addEventListener('change', () => { S.presetMissing = null; selectPreset(); });
    document.querySelectorAll('#tw-seg-count button').forEach(b => b.addEventListener('click', () => setCount(b.dataset.v)));
    $('tw-posted').addEventListener('click', () => S.chosen && togglePosted(S.chosen.histId));
    $('tw-prompt').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); generate(); } });
    $('tw-roll-btn').addEventListener('click', async () => {
      await loadCharData();
      if (!S.allChars.length) { toast('⚠️ Aucun personnage chargé — configure le dossier de données dans l\'onglet Character'); return; }
      roll();
    });
  }

  function init() {
    if (initialized) return;
    initialized = true;
    bindUI();
    renderHistory();
    fillPresetSelect();
    selectPreset();
  }

  async function onShow() {
    fillPresetSelect();
    fillModelSelect();
    await loadCharData();
    if (!S.current && S.allChars.length) roll();
    Watermark.relayout?.();
  }

  return { init, onShow };
})();
