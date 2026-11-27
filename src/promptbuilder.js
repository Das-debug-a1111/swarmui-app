// ── Constructeur de prompt (onglet Txt2Img) ──────────────────────────────────────────────────────
// Catégories de tags (qualité, trigger words, angle, contexte…), personnages avec apparence, tenues et expression,
// assemblage par PromptCore dans un ordre fixe, aperçu relisable, puis envoi dans la boîte de prompt et dans SwarmUI.
const PromptBuilder = (() => {
  const KEY = 'pb-state-v1';
  const FILTER_KEY = 'tc-filter';
  const $ = id => document.getElementById(id);
  const PC = () => PromptCore;
  const anima = () => PC().isAnima(S);
  let S = load();
  let saveTimer = null;
  let inited = false;

  // ── État ────────────────────────────────────────────────────────────────────
  function mergeDefaults(v) {
    const migrate = !PC().PROFILES[v.profile];                 // ancien état sans profil : Anima (Aesthetic) par défaut, qualité et négatif remis aux valeurs du profil
    const d = PC().defaultState(migrate ? 'anima-aesthetic' : v.profile);
    const out = { version: 1, profile: d.profile, opts: { ...d.opts, ...(v.opts || {}) }, pos: {}, neg: {}, chars: [], text: { scene: '', interaction: '', env: '' } };
    ['scene', 'interaction', 'env'].forEach(k => { out.text[k] = v.text && typeof v.text[k] === 'string' ? v.text[k].slice(0, 600) : ''; });
    for (const k of Object.keys(d.pos)) out.pos[k] = migrate && k === 'quality' ? d.pos[k] : Array.isArray(v.pos && v.pos[k]) ? v.pos[k].filter(x => x && typeof x.t === 'string').map(x => ({ t: x.t.slice(0, 200), on: x.on !== false })).slice(0, 80) : d.pos[k];
    for (const k of Object.keys(d.neg)) out.neg[k] = migrate && k !== 'extra' ? d.neg[k] : Array.isArray(v.neg && v.neg[k]) ? v.neg[k].filter(x => x && typeof x.t === 'string').map(x => ({ t: x.t.slice(0, 200), on: x.on !== false })).slice(0, 80) : d.neg[k];
    (Array.isArray(v.chars) ? v.chars : []).slice(0, 6).forEach((c, i) => {
      if (!c || typeof c !== 'object') return;
      const n = PC().newChar(i + 1);
      const str = (x, max) => (typeof x === 'string' ? x.slice(0, max) : '');
      n.id = typeof c.id === 'string' ? c.id.slice(0, 20) : n.id; n.on = c.on !== false; n.gender = PC().GENDERS.includes(c.gender) ? c.gender : 'girl';
      n.position = str(c.position, 80); n.size = PC().SIZES.includes(c.size) ? c.size : ''; n.name = str(c.name, 200); n.series = str(c.series, 200); n.appearance = str(c.appearance, 600); n.expression = str(c.expression, 300); n.pose = str(c.pose, 300); n.details = str(c.details, 600);
      n.outfits = (Array.isArray(c.outfits) ? c.outfits : []).slice(0, 8).map((o, j) => ({ label: str(o && o.label, 40) || `Tenue ${j + 1}`, tags: str(o && o.tags, 800) }));
      if (!n.outfits.length) n.outfits = [{ label: 'Tenue 1', tags: '' }];
      n.outfit = Math.min(Math.max(parseInt(c.outfit, 10) || 0, 0), n.outfits.length - 1);
      out.chars.push(n);
    });
    return out;
  }
  function load() {
    try { const v = JSON.parse(localStorage.getItem(KEY) || 'null'); if (v && v.version === 1 && v.pos && v.neg) return mergeDefaults(v); } catch { /* état abîmé : on repart des défauts */ }
    return mergeDefaults({ version: 1, pos: {}, neg: {}, chars: [] });
  }
  function save() { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { localStorage.setItem(KEY, JSON.stringify(S)); } catch { /* quota */ } }, 250); }
  const say = (m, bad) => { if (bad && typeof showErrorToast === 'function') showErrorToast(m); else if (typeof toast === 'function') toast(m); };

  // ── Petits outils d'interface ───────────────────────────────────────────────
  function h(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined && text !== null) e.textContent = text; return e; }
  function btn(label, fn, cls = 'btn-secondary', title) { const b = h('button', cls, label); b.type = 'button'; if (title) b.title = title; b.addEventListener('click', e => fn(b, e)); return b; }
  function attachTags(input, filter) { if (typeof TagComplete !== 'undefined') TagComplete.attachFiltered(input, filter); }
  const focusSel = sel => { const e = document.querySelector(`#pb-panel [data-sec="${sel}"]`); if (e) e.focus(); };

  // ── Sections à pastilles ────────────────────────────────────────────────────
  function sectionCard(title, group, key, cat, opts = {}) {
    const list = S[group][key];
    const card = h('div', 'pb-card');
    const head = h('div', 'pb-card-head'); head.appendChild(h('span', 'pb-card-title', title));
    if (opts.note) head.appendChild(h('span', 'pb-note', opts.note));
    card.appendChild(head);
    const row = h('div', 'pb-chips');
    list.forEach((c, i) => {
      const w = h('span', 'pb-chip' + (c.on ? ' on' : ''));
      const label = h('button', 'pb-chip-t', c.t); label.type = 'button'; label.title = c.on ? 'Actif : clic pour désactiver' : 'Inactif : clic pour activer';
      label.addEventListener('click', () => { c.on = !c.on; save(); w.classList.toggle('on', c.on); label.title = c.on ? 'Actif : clic pour désactiver' : 'Inactif : clic pour activer'; renderPreview(); });
      const x = h('button', 'pb-chip-x', '×'); x.type = 'button'; x.title = 'Retirer';
      x.addEventListener('click', () => { list.splice(i, 1); save(); render(`${group}.${key}`); });
      w.append(label, x); row.appendChild(w);
    });
    const input = h('input', 'inp pb-add'); input.type = 'text'; input.placeholder = '+ ajouter'; input.dataset.sec = `${group}.${key}`; input.spellcheck = false;
    const commit = () => {
      const tags = PC().splitTags(input.value);
      if (!tags.length) { input.value = ''; return; }
      tags.forEach(raw => {
        const t = opts.raw ? PC().normRaw(raw) : PC().normTag(raw);
        if (!t) return;
        const k = PC().tagKey(t); const ex = list.find(x => PC().tagKey(x.t) === k);
        if (ex) ex.on = true; else list.push({ t, on: true });
      });
      save(); render(`${group}.${key}`);
    };
    attachTags(input, cat ? { cats: [cat] } : null);        // l'auto-complétion écoute en premier : une suggestion choisie avec Entrée ou Tab est déjà traitée
    input.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.defaultPrevented) { e.preventDefault(); commit(); } });
    input.addEventListener('input', () => { if (/,\s*$/.test(input.value)) commit(); });   // une virgule (ou une suggestion insérée) valide les tags saisis
    input.addEventListener('change', () => { if (input.value.trim()) commit(); });
    row.appendChild(input);
    card.appendChild(row);
    return card;
  }

  // ── Personnages ─────────────────────────────────────────────────────────────
  const GENDER_LABEL = { girl: 'Fille', boy: 'Garçon', futa: 'Futa', other: 'Autre' };
  function field(c, key, label, filter, placeholder) {
    const w = h('div', 'pb-field'); w.appendChild(h('label', 'pb-flabel', label));
    const i = h('input', 'inp'); i.type = 'text'; i.value = c[key] || ''; i.placeholder = placeholder || ''; i.spellcheck = false;
    i.addEventListener('input', () => { c[key] = i.value; save(); renderPreview(); });
    attachTags(i, filter);
    w.appendChild(i); return w;
  }
  function charCard(c, idx) {
    const card = h('div', 'pb-card pb-char' + (c.on ? '' : ' off'));
    const head = h('div', 'pb-card-head');
    const on = h('input'); on.type = 'checkbox'; on.checked = c.on; on.title = 'Inclure ce personnage';
    on.addEventListener('change', () => { c.on = on.checked; card.classList.toggle('off', !c.on); save(); renderPreview(); });
    const gender = h('select', 'inp pb-gender');
    PC().GENDERS.forEach(g => { const o = h('option', '', GENDER_LABEL[g]); o.value = g; gender.appendChild(o); });
    gender.value = c.gender; gender.addEventListener('change', () => { c.gender = gender.value; save(); renderPreview(); });
    head.append(on, h('span', 'pb-card-title', `Personnage ${idx + 1}`), gender);
    const tools = h('span', 'pb-tools');
    tools.append(
      btn('↑', () => { if (idx > 0) { S.chars.splice(idx - 1, 0, S.chars.splice(idx, 1)[0]); save(); render(); } }, 'pb-mini', 'Monter'),
      btn('↓', () => { if (idx < S.chars.length - 1) { S.chars.splice(idx + 1, 0, S.chars.splice(idx, 1)[0]); save(); render(); } }, 'pb-mini', 'Descendre'),
      btn('Dupliquer', () => { const n = JSON.parse(JSON.stringify(c)); n.id = PC().newChar(0).id; if (S.chars.length < 6) { S.chars.splice(idx + 1, 0, n); save(); render(); } }, 'pb-mini'),
      btn('×', () => { S.chars.splice(idx, 1); save(); render(); }, 'pb-mini', 'Supprimer le personnage'));
    head.appendChild(tools);
    card.appendChild(head);
    const grid = h('div', 'pb-fields');
    grid.append(
      field(c, 'name', 'Nom', { types: [4] }, 'tag du personnage (ex. princess zelda)'),
      field(c, 'series', 'Série', { types: [3] }, 'ex. the legend of zelda'));
    if (anima()) grid.appendChild(field(c, 'position', 'Position', null, 'on the left, in the foreground… (indispensable à plusieurs)'));
    grid.appendChild(field(c, 'appearance', 'Apparence', { cats: ['hair', 'eyes', 'body'] }, 'cheveux, yeux, peau… (une seule couleur de cheveux, différente des autres personnages)'));
    const sw = h('div', 'pb-field'); sw.appendChild(h('label', 'pb-flabel', 'Poitrine'));
    const ssel = h('select', 'inp'); const o0 = h('option', '', '— non précisé —'); o0.value = ''; ssel.appendChild(o0);
    PC().SIZES.forEach(z => { const o = h('option', '', z); o.value = z; ssel.appendChild(o); });
    ssel.value = c.size || ''; ssel.title = 'Un seul tag de taille par personnage ; il reste dans le bloc de ce personnage';
    ssel.addEventListener('change', () => { c.size = ssel.value; save(); renderPreview(); });
    sw.appendChild(ssel); grid.appendChild(sw);
    // tenues : une seule, ou plusieurs que l'on change d'une image à l'autre
    const o = c.outfits[c.outfit];
    const ow = h('div', 'pb-field pb-outfit'); ow.appendChild(h('label', 'pb-flabel', 'Tenue'));
    const orow = h('div', 'pb-orow');
    const osel = h('select', 'inp');
    c.outfits.forEach((x, j) => { const op = h('option', '', x.label || `Tenue ${j + 1}`); op.value = String(j); osel.appendChild(op); });
    osel.value = String(c.outfit); osel.addEventListener('change', () => { c.outfit = parseInt(osel.value, 10) || 0; save(); render(); });
    const olabel = h('input', 'inp pb-olabel'); olabel.type = 'text'; olabel.value = o.label; olabel.maxLength = 40; olabel.title = 'Nom de la tenue';
    olabel.addEventListener('input', () => { o.label = olabel.value; const op = osel.options[c.outfit]; if (op) op.textContent = o.label || `Tenue ${c.outfit + 1}`; save(); });
    orow.append(osel, olabel,
      btn('+ tenue', () => { if (c.outfits.length < 8) { c.outfits.push({ label: `Tenue ${c.outfits.length + 1}`, tags: '' }); c.outfit = c.outfits.length - 1; save(); render(); } }, 'pb-mini', 'Ajouter une autre tenue pour ce personnage'),
      btn('× tenue', () => { if (c.outfits.length > 1) { c.outfits.splice(c.outfit, 1); c.outfit = Math.max(0, c.outfit - 1); save(); render(); } }, 'pb-mini', 'Supprimer cette tenue'));
    ow.appendChild(orow);
    const oi = h('input', 'inp'); oi.type = 'text'; oi.value = o.tags; oi.placeholder = 'vêtements, accessoires… (seule la tenue choisie est utilisée)'; oi.spellcheck = false;
    oi.addEventListener('input', () => { o.tags = oi.value; save(); renderPreview(); });
    attachTags(oi, { cats: ['clothing'] });
    ow.appendChild(oi);
    grid.appendChild(ow);
    grid.append(
      field(c, 'expression', 'Expression', { cats: ['expression'] }, 'smile, blush…'),
      field(c, 'pose', 'Pose', { cats: ['pose'] }, 'standing, looking back…'),
      field(c, 'details', 'Détails', null, 'autres tags propres à ce personnage'));
    card.appendChild(grid);
    return card;
  }

  // ── Phrases (Anima) ─────────────────────────────────────────────────────────
  function textCard() {
    const card = h('div', 'pb-card');
    const head = h('div', 'pb-card-head'); head.appendChild(h('span', 'pb-card-title', 'Phrases de la scène'));
    head.appendChild(h('span', 'pb-note', 'en anglais, concret ; chaque personnage a sa propre phrase (cartes ci-dessous)'));
    card.appendChild(head);
    [['scene', 'Scène', 'Une phrase : qui, où, ambiance.'], ['interaction', 'Interaction', 'Reprends les descripteurs des personnages (ex. the blonde-haired woman…).'], ['env', 'Décor et lumière', 'Une phrase : lieu et éclairage.']].forEach(([k, label, ph]) => {
      const w = h('div', 'pb-field'); w.appendChild(h('label', 'pb-flabel', label));
      const ta = h('textarea', 'inp pb-ta'); ta.rows = 2; ta.value = S.text[k] || ''; ta.placeholder = ph; ta.spellcheck = false;
      ta.addEventListener('input', () => { S.text[k] = ta.value; save(); renderPreview(); });
      w.appendChild(ta); card.appendChild(w);
    });
    return card;
  }
  function setProfile(id) {
    if (!PC().PROFILES[id] || id === S.profile) return;
    PC().applyProfile(S, id);
    save(); render();
    say(`Profil : ${PC().PROFILES[id].label}. Qualité et négatif remis aux valeurs du profil.`);
  }
  // Profil déduit du checkpoint sélectionné (nom du fichier) : seulement pour passer d'Anima à autre chose ou entre variantes Anima
  function profileFromModel(name) {
    const n = String(name || '').toLowerCase();
    if (!n) return null;
    if (/anima/.test(n)) return /turbo/.test(n) ? 'anima-turbo' : /base/.test(n) ? 'anima-base' : 'anima-aesthetic';
    return null;
  }

  // ── Aperçu ────────────────────────────────────────────────────────────────────
  function renderPreview() {
    const box = $('pb-preview'); if (!box) return;
    const r = PC().compose(S);
    box.textContent = '';
    const head = h('div', 'pb-card-head'); head.appendChild(h('span', 'pb-card-title', 'Aperçu relisable'));
    if (r.anima) head.appendChild(h('span', 'pb-note', 'pas de limite de 75 tokens'));
    else { const tk = h('span', 'pb-note' + (r.tokens.pos > 75 ? ' warn' : ''), `≈ ${r.tokens.pos} tokens`); tk.title = 'Estimation : un bloc CLIP contient 75 tokens'; head.appendChild(tk); }
    box.appendChild(head);
    if (!r.lines.length) box.appendChild(h('div', 'pb-empty', 'Rien d\'actif : active des pastilles ou ajoute un personnage.'));
    r.lines.forEach(l => { const row = h('div', 'pb-line'); row.append(h('span', 'pb-line-l', l.label), h('span', 'pb-line-t', l.text)); box.appendChild(row); });
    r.warnings.forEach(w => box.appendChild(h('div', 'pb-warn', w)));
    box.appendChild(h('div', 'pb-final-l', 'Prompt'));
    const fin = h('div', 'pb-final', r.positive || '—'); fin.style.whiteSpace = 'pre-wrap'; fin.id = 'pb-final-pos'; box.appendChild(fin);
    box.appendChild(h('div', 'pb-final-l', r.anima ? 'Négatif' : `Négatif · ≈ ${r.tokens.neg} tokens`));
    if (r.negIgnored) box.appendChild(h('div', 'pb-warn', 'Turbo tourne à CFG 1 : le négatif n\'a aucun effet et n\'est pas envoyé.'));
    const neg = h('div', 'pb-final', r.negative || '—'); neg.id = 'pb-final-neg'; box.appendChild(neg);
  }

  // ── Actions ───────────────────────────────────────────────────────────────────
  function setVal(id, v) { const el = $(id); if (!el) return; el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); }
  function apply() {
    const r = PC().compose(S);
    if (!r.positive) { say('Le constructeur est vide : rien à appliquer.', true); return null; }
    setVal('inp-positive', r.positive);
    setVal('inp-negative', r.negative);
    return r;
  }
  function applyAndGenerate() {
    const r = apply(); if (!r) return;
    const g = $('btn-generate');
    if (g && !g.disabled) { g.click(); say('Génération lancée avec le prompt du constructeur.'); }
    else say('Prompt appliqué. Connecte-toi à SwarmUI pour lancer la génération.', true);
  }
  async function importCurrent() {
    const pos = ($('inp-positive') || {}).value || '', neg = ($('inp-negative') || {}).value || '';
    if (!pos.trim() && !neg.trim()) { say('Les boîtes de prompt sont vides.', true); return; }
    if (typeof uiConfirm === 'function' && !await uiConfirm({ title: 'Importer le prompt actuel ?', html: '<p>Le contenu du constructeur (pastilles et personnages) sera remplacé par le découpage de ton prompt et de ton négatif.</p>', okLabel: 'Importer' })) return;
    const lookup = n => { try { const i = typeof TagComplete !== 'undefined' ? TagComplete.tagInfo(n) : null; return i ? i.type : null; } catch { return null; } };
    const r = PC().parse(pos, neg, lookup, S.profile);
    S = mergeDefaults(r.state); save(); render();
    say(r.notes.length ? 'Prompt importé. ' + r.notes.join(' ') : 'Prompt importé dans le constructeur.');
  }
  async function reset() {
    if (typeof uiConfirm === 'function' && !await uiConfirm({ title: 'Réinitialiser le constructeur ?', html: '<p>Les pastilles et les personnages reviennent aux valeurs par défaut.</p>', okLabel: 'Réinitialiser', danger: true })) return;
    S = PC().defaultState(S.profile); save(); render();
  }
  function copy(b) {
    const r = PC().compose(S);
    (navigator.clipboard ? navigator.clipboard.writeText(r.positive) : Promise.reject()).then(() => { b.textContent = 'Copié ✓'; setTimeout(() => { b.textContent = 'Copier'; }, 1400); }).catch(() => say('Copie impossible.', true));
  }

  // ── Rendu de la structure ───────────────────────────────────────────────────
  function render(focus) {
    const panel = $('pb-panel'); if (!panel) return;
    panel.textContent = '';
    const bar = h('div', 'pb-bar');
    const prof = h('select', 'inp pb-profile'); prof.title = 'Modèle visé : change la façon d\'assembler le prompt';
    Object.values(PC().PROFILES).forEach(p => { const o = h('option', '', p.label); o.value = p.id; prof.appendChild(o); });
    prof.value = S.profile;
    prof.addEventListener('change', () => { setProfile(prof.value); });
    bar.append(h('b', '', 'Constructeur de prompt'), prof,
      btn('Valeurs du profil', () => { PC().applyProfile(S, S.profile); save(); render(); say('Qualité et négatif remis aux valeurs du profil.'); }, 'btn-secondary', 'Remet les pastilles de qualité et le négatif aux valeurs recommandées pour ce profil'),
      btn('↥ Importer le prompt actuel', importCurrent, 'btn-secondary', 'Découpe le prompt et le négatif de la boîte principale dans les catégories'),
      btn('Réinitialiser', reset),
      btn('Fermer', () => setOpen(false)));
    const opt = (key, label, title) => { const l = h('label', 'pai-check'); const c = h('input'); c.type = 'checkbox'; c.checked = S.opts[key] !== false && S.opts[key] !== undefined ? !!S.opts[key] : false; c.addEventListener('change', () => { S.opts[key] = c.checked; save(); renderPreview(); }); l.append(c, document.createTextNode(' ' + label)); l.title = title; return l; };
    bar.append(opt('autoSolo', 'solo auto', 'Ajoute « solo » quand il n\'y a qu\'un personnage'), opt('autoMultiple', 'multiple girls/boys auto', 'Ajoute « multiple girls » ou « multiple boys » à partir de 2'));
    if (anima()) {
      const cs = h('select', 'pb-profile'); cs.title = 'Comment décrire chaque personnage : en phrase, ou en une ligne de tags ancrée à sa position (la scène reste en phrases)';
      [['sentence', 'Personnages : phrases'], ['tags', 'Personnages : tags ancrés']].forEach(([v, l]) => { const o = h('option', '', l); o.value = v; cs.appendChild(o); });
      cs.value = S.opts.charStyle === 'tags' ? 'tags' : 'sentence';
      cs.addEventListener('change', () => { S.opts.charStyle = cs.value; save(); renderPreview(); });
      bar.appendChild(cs);
    }
    if (anima()) bar.appendChild(opt('adultAnchor', 'ancrage adulte', 'Ajoute « adult woman » / « adult man » dans la phrase de chaque personnage (sauf si déjà présent)'));
    else bar.appendChild(opt('useBreak', 'séparer les personnages (<break>)', 'Insère <break> entre les blocs de personnages pour limiter le mélange des détails'));
    panel.appendChild(bar);
    const ph = PC().profileOf(S.profile).hint;
    if (ph) panel.appendChild(h('div', 'pb-hint', ph));
    const grid = h('div', 'pb-grid');
    const left = h('div', 'pb-col');
    left.append(
      sectionCard('Qualité', 'pos', 'quality', 'quality'),
      sectionCard('Sécurité', 'pos', 'meta', 'meta', { note: anima() ? 'un seul : safe, sensitive, nsfw ou explicit' : '' }),
      sectionCard('Artiste', 'pos', 'artist', null, { note: anima() ? '@ ajouté automatiquement' : '' }),
      sectionCard('Trigger words et style', 'pos', 'style', 'style', { raw: true, note: 'casse et tirets bas conservés' }));
    const chars = h('div', 'pb-card pb-chars');
    const ch = h('div', 'pb-card-head'); ch.appendChild(h('span', 'pb-card-title', 'Personnages'));
    ch.appendChild(btn('+ Personnage', () => { if (S.chars.length >= 6) { say('6 personnages au maximum.', true); return; } S.chars.push(PC().newChar(S.chars.length + 1)); save(); render(); }, 'pb-mini'));
    chars.appendChild(ch);
    if (!S.chars.length) chars.appendChild(h('div', 'pb-empty', 'Aucun personnage : le prompt ne contiendra pas de tag de sujet (1girl, solo…).'));
    S.chars.forEach((c, i) => chars.appendChild(charCard(c, i)));
    left.appendChild(chars);
    if (anima()) left.appendChild(textCard());
    left.append(
      sectionCard('Action et pose (scène)', 'pos', 'action', 'pose'),
      sectionCard('Angle et cadrage', 'pos', 'framing', 'framing'),
      sectionCard('Contexte et décor', 'pos', 'setting', 'setting'),
      sectionCard('Lumière', 'pos', 'lighting', 'lighting'),
      sectionCard('Libre', 'pos', 'extra', null));
    const neg = h('details', 'pb-neg'); neg.open = S.neg.extra.length > 0 || false;
    neg.appendChild(h('summary', '', 'Prompt négatif'));
    neg.append(sectionCard('Qualité (négatif)', 'neg', 'quality', 'negQuality'), sectionCard('Anatomie (négatif)', 'neg', 'anatomy', 'negAnatomy'), sectionCard('Libre (négatif)', 'neg', 'extra', null));
    left.appendChild(neg);
    const right = h('div', 'pb-col pb-right');
    const prev = h('div', 'pb-card'); prev.id = 'pb-preview';
    const acts = h('div', 'pb-actions');
    acts.append(btn('Appliquer au prompt', apply, 'btn-secondary'), btn('Appliquer et générer', applyAndGenerate, 'btn-primary-sm'), btn('Copier', copy));
    right.append(prev, acts);
    grid.append(left, right);
    panel.appendChild(grid);
    renderPreview();
    if (focus) focusSel(focus);
  }

  function setOpen(v) {
    const panel = $('pb-panel'); if (!panel) return;
    panel.hidden = !v;
    const b = $('pb-toggle-btn'); if (b) b.classList.toggle('active', v);
    try { localStorage.setItem('pb-open', v ? '1' : '0'); } catch { /* ignoré */ }
    if (v) render();
  }

  function init() {
    if (inited) return; inited = true;
    const b = $('pb-toggle-btn');
    if (b) b.addEventListener('click', () => setOpen($('pb-panel').hidden));
    // Filtre de l'auto-complétion sur les boîtes de prompt principales
    const sel = $('tc-filter-sel');
    if (sel && typeof TagComplete !== 'undefined' && TagComplete.FILTERS) {
      TagComplete.FILTERS.forEach(([v, l]) => { const o = document.createElement('option'); o.value = v; o.textContent = l; sel.appendChild(o); });
      let saved = ''; try { saved = localStorage.getItem(FILTER_KEY) || ''; } catch { /* ignoré */ }
      sel.value = TagComplete.FILTERS.some(f => f[0] === saved) ? saved : '';
      TagComplete.setGlobalFilter(sel.value);
      sel.addEventListener('change', () => { TagComplete.setGlobalFilter(sel.value); try { localStorage.setItem(FILTER_KEY, sel.value); } catch { /* ignoré */ } sel.classList.toggle('on', !!sel.value); });
      sel.classList.toggle('on', !!sel.value);
    }
    const ms = $('sel-model');
    if (ms) ms.addEventListener('change', () => { const p = profileFromModel(ms.value); if (p && p !== S.profile) { setProfile(p); } });
    let open = false; try { open = localStorage.getItem('pb-open') === '1'; } catch { /* ignoré */ }
    setOpen(open);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();

  return { setProfile, isAnima: () => anima(), init, render, compose: () => PC().compose(S), _state: () => S, _setState: v => { S = mergeDefaults(v); save(); render(); } };
})();
