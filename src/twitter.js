// ── Twitter challenge ─────────────────────────────────────────────────────────
// Tire 3 persos au sort + 1 preset (Bimbo/Futa) pour débloquer les idées de
// contenu Twitter : clique un des 3 → prompt/preset/Images:4 pré-remplis sur
// Txt2Img, prêt à Generate. Historique local pour éviter les répétitions et
// suivre ce qui a déjà été posté.
const Twitter = (() => {
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  const HIST_KEY           = 'twitter-challenge-history';
  const HIST_EXCLUDE_COUNT = 15;   // don't reroll these recently-used names
  const HIST_MAX           = 200;
  const PRESET_LABELS      = ['Bimbo', 'Futa'];

  const S = {
    loaded:    false,
    allChars:  [],   // [{name, series}]
    tagAssist: {},
    current:   null, // { label, chars: [{name,series}, ...] }
  };
  const thumbCache = new Map();
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
      S.loaded = true;
    } catch (e) { console.error('[Twitter] loadCharData:', e); }
  }

  async function loadThumb(img, name) {
    if (!img) return;
    if (thumbCache.has(name)) {
      const cached = thumbCache.get(name);
      if (cached) { img.src = cached; img.classList.add('loaded'); }
      return;
    }
    try {
      const dataUrl = await window.electronAPI.charThumb(name);
      thumbCache.set(name, dataUrl);
      if (dataUrl) { img.src = dataUrl; img.classList.add('loaded'); }
    } catch { /* thumb missing — leave placeholder */ }
  }

  // ── History (localStorage) ────────────────────────────────────────────────
  function getHistory() {
    try { return JSON.parse(localStorage.getItem(HIST_KEY) || '[]'); } catch { return []; }
  }
  function saveHistory(list) { localStorage.setItem(HIST_KEY, JSON.stringify(list)); }

  function addHistory(entry) {
    const list = getHistory();
    list.unshift({
      id: 'h' + Date.now() + Math.random().toString(36).slice(2, 6),
      date: new Date().toISOString(),
      posted: false,
      ...entry,
    });
    saveHistory(list.slice(0, HIST_MAX));
    renderHistory();
  }

  function togglePosted(id) {
    const list = getHistory();
    const e = list.find(x => x.id === id);
    if (!e) return;
    e.posted = !e.posted;
    saveHistory(list);
    renderHistory();
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

  function roll() {
    const label = PRESET_LABELS[Math.floor(Math.random() * PRESET_LABELS.length)];
    const chars = pickThree();
    if (!chars.length) return;
    S.current = { label, chars };
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
    const wrap = $('tw-cards');
    wrap.innerHTML = '';
    S.current.chars.forEach(c => wrap.appendChild(buildCard(c)));
  }

  function buildCard(char) {
    const card = document.createElement('div');
    card.className = 'tw-card';
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

  // ── Commit: apply preset + character, hand off to Txt2Img ─────────────────
  function selectCharacter(char) {
    const label = S.current.label;
    const entry = findPresetEntry(label);
    if (entry) applyPreset(entry);
    else toast(`⚠️ Preset "${label}" introuvable — sauvegarde-le dans Presets d'abord`);

    const posEl = $('inp-positive');
    if (posEl) {
      const extra = S.tagAssist[char.name] ? ', ' + S.tagAssist[char.name] : '';
      const base = posEl.value.trim();
      posEl.value = (base ? base + ', ' : '') + char.name + extra;
      posEl.dispatchEvent(new Event('input', { bubbles: true }));
    }

    const countEl = $('sel-count');
    if (countEl) { countEl.value = '4'; countEl.dispatchEvent(new Event('change', { bubbles: true })); }

    addHistory({ name: char.name, series: char.series, preset: label, presetFound: !!entry });

    switchTab('txt2img');
    toast(`🐦 Défi prêt : ${char.name} · ${label}`);
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
      row.innerHTML = `
        <img class="tw-hist-thumb" alt="">
        <span class="tw-hist-name">${esc(e.name)}</span>
        <span class="tw-preset-badge tw-preset-${esc((e.preset || '').toLowerCase())}" style="margin-left:0">${esc(e.preset || '')}</span>
        <span class="tw-hist-date">${dateStr}</span>
        <span class="tw-hist-posted${e.posted ? ' done' : ''}">${e.posted ? '✅ Posté' : '☐ Posté'}</span>`;
      loadThumb(row.querySelector('.tw-hist-thumb'), e.name);
      row.querySelector('.tw-hist-posted').addEventListener('click', () => togglePosted(e.id));
      wrap.appendChild(row);
    });
  }

  // ── Init ─────────────────────────────────────────────────────────────────
  function bindUI() {
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
  }

  async function onShow() {
    await loadCharData();
    if (!S.current && S.allChars.length) roll();
  }

  return { init, onShow };
})();
