// ── Listes de Forge (Inpaint) rangées comme dans Txt2Img : ordre de SwarmUI, familles, LoRA compatibles ──────
// Les valeurs des listes restent celles de Forge. La famille d'un LoRA vient d'abord de ce que Forge lit dans le
// fichier (SwarmUI peut être éteint), puis de SwarmUI, puis du nom. L'ordre est celui de SwarmUI quand il répond.
(function (root) {
  'use strict';

  const norm = s => String(s || '').replace(/\s*\[[0-9a-f]+\]\s*$/i, '').replace(/\\/g, '/')
    .replace(/\.(safetensors|ckpt|pt|gguf|sft)$/i, '').toLowerCase();
  const base = s => s.split('/').pop();

  // Fichier SwarmUI correspondant à un chemin Forge (relatif ou complet) : chemin d'abord, nom seul ensuite
  function findIndex(path, files) {
    const p = norm(path), names = files.map(f => norm(f.name));
    let i = names.indexOf(p);
    if (i < 0) i = names.findIndex(n => n.includes('/') && p.endsWith('/' + n));
    if (i < 0) i = names.findIndex(n => base(n) === base(p));
    return i;
  }

  // Famille déclarée par l'outil d'entraînement (métadonnées renvoyées par Forge) ; '' si rien de sûr
  function declared(meta) {
    const m = meta || {};
    const t = `${m['modelspec.architecture'] || ''} ${m.ss_base_model_version || ''}`.toLowerCase();
    if (/anima/.test(t)) return 'anima';
    if (/krea[-_ ]?2/.test(t)) return 'krea-2';
    if (/qwen[-_ ]?image/.test(t)) return 'qwen-image';
    if (/flux/.test(t)) return 'flux-1';
    if (/sdxl|stable-diffusion-xl/.test(t)) return 'stable-diffusion-xl-v1';
    return '';
  }

  // → [{ item, fam }] dans l'ordre de SwarmUI, les fichiers inconnus de SwarmUI ensuite par nom
  function arrange(items, pathOf, files, familyOf) {
    return items.map(item => {
      const path = pathOf(item), i = findIndex(path, files || []);
      const own = declared(item && item.metadata);
      const file = i < 0 ? { name: path } : files[i];
      return { item, i: i < 0 ? Infinity : i, path: norm(path), fam: familyOf(own ? { name: file.name, compat_class: own } : file) };
    }).sort((a, b) => (a.i === b.i ? a.path.localeCompare(b.path) : a.i - b.i));
  }

  const esc = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const swarm = key => (typeof App !== 'undefined' && App[key]) || [];
  const familyOf = f => (typeof modelFamily === 'function' ? modelFamily(f) : { id: '?', label: 'Inconnu' });

  // Liste de checkpoints Forge avec ses boutons de famille ; le modèle choisi reste toujours dans la liste
  function fillModels(sel, box, models, storeKey, keep) {
    if (!sel || !models.length) return;
    const list = arrange(models, m => m.title, swarm('models'), familyOf);
    const fams = new Map();
    list.forEach(({ fam }) => { const e = fams.get(fam.id) || { label: fam.label, n: 0 }; e.n++; fams.set(fam.id, e); });
    let active = localStorage.getItem(storeKey) || '';
    if (!fams.has(active) || fams.size < 2) active = '';
    const shown = list.filter(x => !active || x.fam.id === active || x.item.title === keep);
    sel.innerHTML = shown.map(x => `<option value="${esc(x.item.title)}">${esc(x.item.title)}</option>`).join('');
    if (keep && shown.some(x => x.item.title === keep)) sel.value = keep;
    if (!box) return;
    const chip = (id, label, n) => `<button type="button" class="family-chip${active === id ? ' active' : ''}" data-fam="${esc(id)}">${esc(label)}<span>${n}</span></button>`;
    box.style.display = fams.size < 2 ? 'none' : '';
    box.innerHTML = chip('', 'Tous', list.length) + [...fams].sort((a, b) => b[1].n - a[1].n).map(([id, e]) => chip(id, e.label, e.n)).join('');
    box.onclick = e => {
      const btn = e.target.closest('.family-chip'); if (!btn) return;
      localStorage.setItem(storeKey, btn.dataset.fam);
      // Une famille choisie à la main : on passe sur son premier modèle si le modèle actuel n'en fait pas partie
      const inFam = list.filter(x => !btn.dataset.fam || x.fam.id === btn.dataset.fam);
      const next = inFam.some(x => x.item.title === sel.value) ? sel.value : inFam[0]?.item.title;
      fillModels(sel, box, models, storeKey, next);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }

  // LoRA Forge de la famille du modèle choisi (+ ceux à garder) ; tous si la famille est inconnue ou si showAll
  function loraChoices(loras, modelTitle, showAll, keep) {
    const all = arrange(loras, l => l.path || l.name, swarm('loraModels'), familyOf);
    const fam = modelTitle ? arrange([modelTitle], t => t, swarm('models'), familyOf)[0].fam : null;
    const known = all.some(x => x.fam.id !== '?');   // aucun LoRA classé : filtrer viderait la liste, on montre tout
    const filtered = !showAll && known && fam && fam.id !== '?';
    const list = filtered ? all.filter(x => x.fam.id === fam.id || keep.has(x.item.name)) : all;
    const n = filtered ? all.filter(x => x.fam.id === fam.id).length : all.length;
    const hidden = filtered ? all.filter(x => x.fam.id === '?').length : 0;
    const hint = !all.length ? '' : filtered ? `${n} LoRA ${fam.label} sur ${all.length}` + (hidden ? ` · ${hidden} non classé${hidden > 1 ? 's' : ''} masqué${hidden > 1 ? 's' : ''}` : '')
      : showAll ? `${all.length} LoRA affichés (filtre désactivé)`
      : !known ? `Famille des LoRA non détectée : les ${all.length} sont affichés`
      : `Famille du modèle non détectée : les ${all.length} LoRA sont affichés`;
    return { list: list.map(x => x.item), hint };
  }

  const api = { norm, findIndex, declared, arrange, fillModels, loraChoices };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.ForgeSort = api;
})(typeof window !== 'undefined' ? window : globalThis);
