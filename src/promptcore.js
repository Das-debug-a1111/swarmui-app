// ── Constructeur de prompt : logique pure (aucun accès à la page) ─────────────────────────────────
// Normalisation des tags, assemblage dans un ordre fixe, relecture d'un prompt existant, catégories de tags.
// Utilisable dans l'app (PromptCore global) et dans Node (tests : test/promptcore.test.js).
(function (root) {
  'use strict';

  // ── Vocabulaire : tags courants par catégorie (sert aux pastilles proposées, au filtre de l'auto-complétion et à la relecture d'un prompt) ──
  const V = {
    quality: ['masterpiece', 'best quality', 'amazing quality', 'very aesthetic', 'absurdres', 'highres', 'newest', 'ultra detailed', 'high score', 'great score', 'score_9', 'score_8_up', 'score_7', 'score_6', 'score_5'],
    negQuality: ['worst quality', 'low quality', 'bad quality', 'normal quality', 'lowres', 'jpeg artifacts', 'blurry', 'signature', 'watermark', 'artist name', 'username', 'text', 'logo', 'sketch', 'ugly', 'displeasing', 'bad aesthetic', 'old', 'early', 'score_1', 'score_2', 'score_3', 'chromatic aberration'],
    meta: ['safe', 'sensitive', 'nsfw', 'explicit'],
    negAnatomy: ['bad anatomy', 'bad hands', 'extra digits', 'fewer digits', 'extra fingers', 'missing fingers', 'fused fingers', 'mutated hands', 'deformed', 'disfigured', 'extra limbs', 'extra arms', 'extra legs', 'malformed limbs', 'bad proportions', 'bad feet', 'long neck', 'cropped', 'asymmetrical eyes', 'poorly drawn hands', 'poorly drawn face', 'missing arms'],
    framing: ['from above', 'from below', 'from side', 'from behind', 'front view', 'side view', 'back view', 'dutch angle', 'pov', 'close-up', 'extreme close-up', 'portrait', 'upper body', 'cowboy shot', 'full body', 'wide shot', 'medium shot', 'face focus', 'looking at viewer', 'looking away', 'looking back', 'looking down', 'looking up', 'looking to the side', 'depth of field', 'blurry background', 'fisheye', 'head out of frame', 'straight-on'],
    lighting: ['soft lighting', 'warm lighting', 'cinematic lighting', 'dramatic lighting', 'rim lighting', 'backlighting', 'sunlight', 'golden hour', 'moonlight', 'neon lights', 'volumetric lighting', 'ambient light', 'studio lighting', 'dim lighting', 'candlelight', 'sunset', 'night', 'daylight', 'lens flare', 'bloom', 'light rays', 'dappled sunlight', 'shadow'],
    setting: ['indoors', 'outdoors', 'bedroom', 'bathroom', 'kitchen', 'living room', 'office', 'library', 'cafe', 'restaurant', 'bar', 'hotel room', 'balcony', 'throne room', 'castle', 'beach', 'forest', 'mountain', 'city', 'street', 'rooftop', 'garden', 'pool', 'onsen', 'spa', 'ocean', 'desert', 'snow', 'rain', 'night sky', 'sky', 'simple background', 'white background', 'gradient background', 'scenery', 'window', 'bed', 'couch', 'chair', 'table', 'curtains', 'bathtub', 'luxury'],
    expression: ['smile', 'light smile', 'smirk', 'grin', 'blush', 'light blush', 'embarrassed', 'surprised', 'open mouth', 'closed mouth', 'closed eyes', 'half-closed eyes', 'seductive smile', 'parted lips', 'tongue out', 'wink', 'laughing', 'angry', 'serious', 'sad', 'crying', 'pout', 'heavy breathing', 'sweat', 'drooling', 'naughty face', ':o', ':d', ';)'],
    pose: ['standing', 'sitting', 'kneeling', 'lying', 'on back', 'on stomach', 'on side', 'crossed legs', 'arms up', 'arms behind back', 'arms behind head', 'hand on hip', 'hands on hips', 'leaning forward', 'bent over', 'squatting', 'all fours', 'spread legs', 'crossed arms', 'walking', 'running', 'jumping', 'stretching', 'hand on own chest', 'hand in own hair', 'hands on own face', 'looking back', 'head tilt'],
    hair: ['long hair', 'very long hair', 'medium hair', 'short hair', 'bob cut', 'ponytail', 'high ponytail', 'twintails', 'braid', 'side ponytail', 'hair bun', 'ahoge', 'bangs', 'blunt bangs', 'swept bangs', 'hair over one eye', 'curly hair', 'wavy hair', 'straight hair', 'messy hair', 'blonde hair', 'brown hair', 'black hair', 'white hair', 'silver hair', 'grey hair', 'red hair', 'blue hair', 'pink hair', 'purple hair', 'green hair', 'orange hair', 'multicolored hair', 'gradient hair', 'streaked hair', 'hair between eyes', 'sidelocks'],
    eyes: ['blue eyes', 'red eyes', 'green eyes', 'brown eyes', 'purple eyes', 'yellow eyes', 'golden eyes', 'pink eyes', 'orange eyes', 'black eyes', 'aqua eyes', 'grey eyes', 'heterochromia', 'glowing eyes', 'slit pupils', 'long eyelashes', 'eyeshadow', 'eyeliner', 'makeup', 'lipstick', 'red lips'],
    body: ['large breasts', 'medium breasts', 'small breasts', 'huge breasts', 'curvy', 'wide hips', 'thick thighs', 'slim', 'muscular', 'toned', 'tall', 'tan', 'tanned', 'dark skin', 'pale skin', 'abs', 'narrow waist', 'mature female', 'glossy skin', 'shiny skin', 'freckles', 'mole', 'tattoo', 'scar', 'futanari', 'pointy ears', 'elf', 'fang', 'horns', 'tail'],
    clothing: ['dress', 'short dress', 'long dress', 'evening gown', 'bikini', 'swimsuit', 'one-piece swimsuit', 'lingerie', 'bra', 'panties', 'thong', 'garter belt', 'garter straps', 'stockings', 'thighhighs', 'pantyhose', 'fishnets', 'bodysuit', 'leotard', 'shirt', 'white shirt', 'crop top', 'tank top', 't-shirt', 'jacket', 'coat', 'cardigan', 'sweater', 'hoodie', 'skirt', 'miniskirt', 'pleated skirt', 'shorts', 'pants', 'jeans', 'leggings', 'kimono', 'yukata', 'apron', 'maid', 'bunny suit', 'nightgown', 'negligee', 'robe', 'bathrobe', 'towel', 'armor', 'cape', 'gloves', 'elbow gloves', 'boots', 'high heels', 'sandals', 'sneakers', 'barefoot', 'socks', 'hat', 'glasses', 'choker', 'necklace', 'earrings', 'jewelry', 'ribbon', 'hair ribbon', 'hairband', 'hair ornament', 'tiara', 'crown', 'scarf', 'belt', 'collar', 'see-through', 'sheer', 'lace', 'silk', 'latex', 'leather', 'floral print', 'topless', 'nude', 'naked', 'cleavage', 'bare shoulders', 'off shoulder', 'sleeveless', 'strapless', 'backless', 'detached sleeves', 'navel', 'midriff', 'underwear'],
    style: ['anime coloring', 'flat color', 'sketch', 'painterly', 'watercolor (medium)', 'realistic', 'photorealistic', 'cel shading', 'soft shading', 'lineart', 'monochrome', 'greyscale', 'retro artstyle', '1990s (style)', '2000s (style)'],
  };
  const CAT_LABEL = {
    quality: 'Qualité', negQuality: 'Qualité (négatif)', negAnatomy: 'Anatomie (négatif)', framing: 'Angle et cadrage', lighting: 'Lumière', setting: 'Contexte et décor',
    expression: 'Expression', pose: 'Pose', hair: 'Cheveux', eyes: 'Yeux et maquillage', body: 'Corps', clothing: 'Vêtements', style: 'Style',
    character: 'Personnage', copyright: 'Série', artist: 'Artiste', meta: 'Sécurité et méta',
  };

  // Règles par motifs pour les tags absents des listes ci-dessus
  const PATTERNS = [
    ['meta', /^(safe|sensitive|nsfw|explicit|year \d{4})$/],
    ['quality', /^(masterpiece|best quality|amazing quality|score[ _]\d.*|highres|absurdres|newest|very aesthetic|ultra[- ]detailed)$/],
    ['hair', /(^|\s)hair$|^hair |bangs$|ponytail|twintails|braids?$|ahoge$/],
    ['eyes', /(^|\s)eyes?$|eyeshadow|eyeliner|eyelashes|pupils$/],
    ['framing', /^(from |looking |view$)|(^|\s)(view|shot|focus|angle|close-up|portrait|pov)$|upper body|full body|cowboy shot|out of frame|depth of field/],
    ['lighting', /lighting$|light$|lights$|sunlight|moonlight|shadow|glow$|bloom|lens flare|light rays|sunset|sunrise|golden hour/],
    ['expression', /smile|blush|grin|smirk|frown|crying|tears|pout|wink|tongue|angry|surprised|embarrassed|expression|laughing|open mouth|closed mouth|closed eyes|parted lips/],
    ['clothing', /dress|shirt|skirt|pants|shorts|bra$|panties|bikini|swimsuit|gloves?$|boots?$|thighhighs|stockings|socks|jacket|coat$|hat$|choker|necklace|earrings|ribbon|uniform|armor|cape$|robe$|kimono|lingerie|leotard|bodysuit|apron|collar|heels|shoes|sleeves|belt$|scarf|sweater|hoodie|thong|nightgown|negligee|towel|jewelry|crown|tiara|glasses|underwear|swimsuit|garter|fishnets|pantyhose|leggings|jeans|cardigan|maid|bunny/],
    ['pose', /(^|\s)(sitting|standing|kneeling|lying|squatting|leaning|walking|running|jumping|stretching)(\s|$)|bent over|all fours|spread legs|crossed (legs|arms)|arms (up|behind)|hands? on|on (back|stomach|side)|head tilt/],
    ['setting', /background|indoors|outdoors|(^|\s)room$|bedroom|bathroom|kitchen|street|city|forest|beach|(^|\s)sky$|window|castle|garden|table|couch|(^|\s)bed$|curtains|pool|onsen|scenery|rooftop|balcony|bathtub/],
    ['body', /breasts|hips|thighs|(^|\s)skin$|muscular|toned|curvy|slim|(^|\s)tall$|tanned?$|freckles|mole$|tattoo|scar$|futanari|abs$|waist|pointy ears|horns$|(^|\s)tail$/],
  ];
  const MAP = new Map();
  const mk = t => t.replace(/_/g, ' ');
  Object.keys(V).forEach(cat => V[cat].forEach(t => { if (!MAP.has(mk(t))) MAP.set(mk(t), cat); }));
  ['negQuality', 'negAnatomy', 'meta'].forEach(c => V[c].forEach(t => MAP.set(mk(t), c)));
  const COUNT_RE = /^(\d+\+?(girls?|boys?|others?)|solo|multiple (girls|boys|others)|no humans)$/;

  // ── Normalisation ───────────────────────────────────────────────────────────
  const escParens = s => s.replace(/(?<!\\)\(/g, '\\(').replace(/(?<!\\)\)/g, '\\)');
  const balanced = s => { let d = 0; for (let i = 0; i < s.length; i++) { const c = s[i]; if (c === '\\') { i++; continue; } if (c === '(') d++; else if (c === ')') { d--; if (d < 0) return false; } } return d === 0; };
  function normBare(t) {
    t = t.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    if (!t) return null;
    const sc = /^score (\d{1,2})(?: (up))?$/.exec(t); if (sc) return 'score_' + sc[1] + (sc[2] ? '_up' : '');   // Anima / Pony : les tags de score gardent leur tiret bas
    if (t[0] === '(' && t[t.length - 1] === ')' && balanced(t)) return t;       // emphase « (tag) » : laissée telle quelle
    return escParens(t);
  }
  // Tag normalisé : minuscules, espaces au lieu des tirets bas, parenthèses de noms échappées, poids conservés ; <lora:…> intacts.
  function normTag(raw) {
    let t = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim();
    if (!t) return null;
    if (/^<[^>]*>$/.test(t)) return t;
    const w = /^\((.+):(-?\d*\.?\d+)\)$/.exec(t);
    if (w) { const inner = normBare(w[1]); return inner ? `(${inner}:${w[2]})` : null; }
    return normBare(t);
  }
  // Trigger words : seule la forme est nettoyée (espaces), la casse et les tirets bas sont conservés
  function normRaw(raw) { const t = String(raw === undefined || raw === null ? '' : raw).replace(/\s+/g, ' ').trim(); return t || null; }

  // Découpe au niveau supérieur : virgules et retours à la ligne, en respectant (), [], <>
  function splitTags(text) {
    const out = []; let cur = ''; let depth = 0; let angle = 0;
    const s = String(text || '');
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length) { cur += c + s[i + 1]; i++; continue; }
      if (c === '<') angle++; else if (c === '>') angle = Math.max(0, angle - 1);
      else if (c === '(' || c === '[') depth++; else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
      if ((c === ',' || c === '\n') && depth === 0 && angle === 0) { if (cur.trim()) out.push(cur.trim()); cur = ''; } else cur += c;
    }
    if (cur.trim()) out.push(cur.trim());
    return out;
  }
  // Clé de comparaison : le tag sans son poids ni son emphase
  function tagKey(t) {
    let k = String(t).trim();
    const w = /^\((.+):(-?\d*\.?\d+)\)$/.exec(k); if (w) k = w[1];
    while (k.length > 2 && ((k[0] === '(' && k[k.length - 1] === ')' && balanced(k)) || (k[0] === '[' && k[k.length - 1] === ']'))) k = k.slice(1, -1);
    return k.replace(/_/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }
  function dedupe(list, seen = new Set()) {
    const out = [];
    list.forEach(t => { const k = tagKey(t); if (!k || seen.has(k)) return; seen.add(k); out.push(t); });
    return out;
  }
  const cleanList = (text, raw) => (Array.isArray(text) ? text : splitTags(text)).map(raw ? normRaw : normTag).filter(Boolean);

  // Catégorie d'un tag (null si inconnue). Les poids sont ignorés.
  function categoryOf(tag) {
    const k = tagKey(tag);
    if (!k) return null;
    if (MAP.has(k)) return MAP.get(k);
    for (const [cat, re] of PATTERNS) if (re.test(k)) return cat;
    return null;
  }
  // Tags du vocabulaire d'une catégorie qui commencent par (ou contiennent) la saisie
  function suggest(cat, q, max = 12) {
    const n = String(q || '').toLowerCase().replace(/_/g, ' ').trim();
    const list = V[cat] || [];
    const starts = list.filter(t => t.startsWith(n)), has = list.filter(t => !t.startsWith(n) && t.includes(n));
    return [...starts, ...has].slice(0, max);
  }

  // ── Personnages et comptage ───────────────────────────────────────────────────
  const GENDERS = ['girl', 'boy', 'futa', 'other'];
  function countTag(n, kind) {
    if (n <= 0) return null;
    if (n >= 6) return `6+${kind}s`;
    return `${n}${kind}${n > 1 ? 's' : ''}`;
  }
  function subjectTags(chars, opts) {
    const on = chars.filter(c => c.on !== false);
    const n = { girl: 0, boy: 0, other: 0 };
    on.forEach(c => { if (c.gender === 'boy') n.boy++; else if (c.gender === 'other') n.other++; else n.girl++; });
    const tags = [];
    ['girl', 'boy', 'other'].forEach(k => { const t = countTag(n[k], k); if (t) tags.push(t); });
    if (opts.autoMultiple !== false) { if (n.girl > 1) tags.push('multiple girls'); if (n.boy > 1) tags.push('multiple boys'); }
    if (opts.autoSolo !== false && on.length === 1) tags.push('solo');
    return tags;
  }

  // ── Profils de modèle ─────────────────────────────────────────────────────────
  // « anima » = modèle à encodeur Qwen3 : tags en minuscules + phrases, pas de blocs CLIP de 75 tokens, pas de BREAK.
  const SIZES = ['flat chest', 'small breasts', 'medium breasts', 'large breasts', 'huge breasts', 'gigantic breasts'];
  const NEG_ANIMA = ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'artist name', 'blurry', 'jpeg artifacts', 'chromatic aberration', 'watermark', 'signature', 'text'];
  const PROFILES = {
    illustrious: { id: 'illustrious', label: 'Illustrious / SDXL', anima: false, hint: '', sampler: null },
    'anima-base': {
      id: 'anima-base', label: 'Anima Base', anima: true, negative: true,
      quality: ['masterpiece', 'best quality', 'score_7', 'score_6', 'score_5', 'amazing quality', 'very aesthetic'], qualityOn: ['masterpiece', 'best quality', 'score_7'],
      negOn: ['worst quality', 'low quality', 'score_1', 'score_2', 'score_3', 'artist name', 'blurry', 'jpeg artifacts', 'chromatic aberration'],
      hint: 'Anima Base : 30–50 steps, CFG 4–5, er_sde, scheduler simple, ≈ 1024 px. Les tags score_N sont utiles.',
    },
    'anima-aesthetic': {
      id: 'anima-aesthetic', label: 'Anima Aesthetic', anima: true, negative: true,
      quality: ['masterpiece', 'best quality', 'amazing quality', 'very aesthetic', 'newest'], qualityOn: ['masterpiece', 'best quality'],
      negOn: ['worst quality', 'low quality', 'artist name', 'blurry', 'jpeg artifacts', 'chromatic aberration'],
      hint: 'Anima Aesthetic : 30–40 steps, CFG 4 (guides : jusqu\'à ~3), er_sde, scheduler simple, ≈ 1024 px. Pas de tags score_N.',
    },
    'anima-turbo': {
      id: 'anima-turbo', label: 'Anima Turbo', anima: true, negative: false,
      quality: ['masterpiece', 'best quality', 'amazing quality', 'very aesthetic'], qualityOn: ['masterpiece', 'best quality'],
      negOn: [],
      hint: 'Anima Turbo : 8–12 steps, CFG 1, scheduler simple, ≈ 1024 px. À CFG 1 le négatif n\'a aucun effet : il n\'est pas envoyé.',
    },
  };
  const profileOf = id => PROFILES[id] || PROFILES.illustrious;
  const isAnima = st => !!profileOf(st && st.profile).anima;

  // ── État par défaut ───────────────────────────────────────────────────────────
  const chip = (t, on) => ({ t, on: !!on });
  const chips = (list, onList = []) => list.map(t => chip(t, onList.includes(t)));
  function qualityChips(profile) {
    const p = profileOf(profile);
    if (!p.anima) return {
      q: chips(V.quality.slice(0, 6), ['masterpiece', 'best quality', 'amazing quality', 'very aesthetic']),
      nq: chips(V.negQuality.slice(0, 12), ['worst quality', 'low quality', 'bad quality', 'lowres', 'jpeg artifacts', 'signature', 'watermark', 'text']),
      na: chips(V.negAnatomy.slice(0, 12), ['bad anatomy', 'bad hands', 'extra digits', 'fewer digits']),
    };
    return { q: chips(p.quality, p.qualityOn), nq: chips(NEG_ANIMA, p.negOn), na: chips(V.negAnatomy.slice(0, 12), []) };   // Anima : négatif court, on ajoute seulement ce qu'on constate
  }
  function defaultState(profile) {
    const pr = profileOf(profile).id, qc = qualityChips(pr);
    return {
      version: 1,
      profile: pr,
      opts: { autoSolo: true, autoMultiple: true, useBreak: false, adultAnchor: true, charStyle: 'sentence' },
      pos: {
        quality: qc.q,
        meta: chips(V.meta),
        style: [],
        artist: [],
        action: chips(V.pose.slice(0, 8)),
        framing: chips(V.framing.slice(0, 12)),
        setting: chips(V.setting.slice(0, 12)),
        lighting: chips(V.lighting.slice(0, 10)),
        extra: [],
      },
      neg: { quality: qc.nq, anatomy: qc.na, extra: [] },
      text: { scene: '', interaction: '', env: '' },
      chars: [],
    };
  }
  // Change de profil : remet les pastilles de qualité et le négatif aux valeurs du profil (le reste est gardé)
  function applyProfile(st, profile) {
    const pr = profileOf(profile).id, qc = qualityChips(pr);
    st.profile = pr;
    st.pos.quality = qc.q; st.neg.quality = qc.nq; st.neg.anatomy = qc.na;
    return st;
  }
  function newChar(n) {
    return { id: 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), on: true, gender: 'girl', name: '', series: '', position: '', size: '', appearance: '', outfits: [{ label: 'Tenue 1', tags: '' }], outfit: 0, expression: '', pose: '', details: '', _n: n };
  }

  // ── Assemblage ────────────────────────────────────────────────────────────────
  const POS_ORDER = [['quality', 'Qualité', false], ['meta', 'Sécurité', false], ['style', 'Trigger words et style', true]];
  const SCENE_ORDER = [['action', 'Action'], ['framing', 'Cadrage'], ['setting', 'Décor'], ['lighting', 'Lumière'], ['extra', 'Libre']];
  const CONFLICTS = [
    ['from above', 'from below', 'from side', 'from behind'],
    ['standing', 'sitting', 'kneeling', 'lying', 'squatting', 'all fours'],
    ['looking at viewer', 'looking away', 'looking back'],
    ['indoors', 'outdoors'],
    ['close-up', 'full body', 'upper body', 'cowboy shot', 'portrait'],
    ['long hair', 'short hair', 'medium hair', 'very long hair'],
  ];
  function estimateTokens(text) {
    const parts = String(text || '').match(/[A-Za-z0-9']+|[^\s A-Za-z0-9']/g) || [];
    return parts.reduce((a, p) => a + (/^[A-Za-z0-9']+$/.test(p) && p.length > 8 ? 2 : 1), 0);
  }
  function activeTags(list, raw) {
    return cleanList((list || []).filter(x => x && x.on !== false && x.t).map(x => x.t), raw);
  }

  function compose(state) {
    const st = state || defaultState();
    if (isAnima(st)) return composeAnima(st);
    const opts = st.opts || {};
    const seen = new Set();
    const lines = []; const warnings = [];
    const push = (label, tags) => { const d = dedupe(tags, seen); if (d.length) lines.push({ label, text: d.join(', '), tags: d }); return d; };
    POS_ORDER.forEach(([k, label, raw]) => push(label, activeTags(st.pos[k], raw)));
    const chars = (st.chars || []).filter(c => c.on !== false);
    push('Sujet', subjectTags(st.chars || [], opts));
    chars.forEach((c, i) => {
      const outfit = (c.outfits || [])[c.outfit || 0] || { tags: '' };
      const tags = [
        ...cleanList(c.name), ...cleanList(c.series), ...(c.gender === 'futa' ? ['futanari'] : []),
        ...cleanList(c.appearance), ...cleanList(c.size), ...cleanList(outfit.tags), ...cleanList(c.expression), ...cleanList(c.pose), ...cleanList(c.details),
      ];
      const label = chars.length > 1 || (c.name && c.name.trim()) ? `Perso ${i + 1}${c.name && c.name.trim() ? ' · ' + normTag(c.name) : ''}` : 'Perso';
      push(label, tags);
    });
    push('Artiste', activeTags(st.pos.artist));
    SCENE_ORDER.forEach(([k, label]) => push(label, activeTags(st.pos[k])));
    // séparation éventuelle des personnages (<break>) : insérée entre les blocs de personnages
    let positive;
    if (opts.useBreak && chars.length > 1) {
      const charLines = lines.filter(l => /^Perso/.test(l.label));
      const first = lines.indexOf(charLines[0]);
      const before = lines.slice(0, first).map(l => l.text);
      const mid = charLines.map(l => l.text);
      const after = lines.slice(first + charLines.length).map(l => l.text);
      positive = [...before, mid.join(', <break>, '), ...after].join(', ');
    } else positive = lines.map(l => l.text).join(', ');
    // conflits
    const all = new Set(lines.flatMap(l => l.tags.map(tagKey)));
    CONFLICTS.forEach(g => { const hit = g.filter(t => all.has(t)); if (hit.length > 1) warnings.push(`Tags qui se contredisent : ${hit.join(' / ')}`); });
    const girls = chars.filter(c => c.gender !== 'boy' && c.gender !== 'other').length;
    if (/(^|, )(\d+\+?girls?)(,|$)/.test(positive) && girls && !subjectTags(st.chars || [], opts).length) warnings.push('Nombre de personnages incohérent');
    // négatif
    const nseen = new Set(); const nlines = [];
    [['quality', 'Qualité'], ['anatomy', 'Anatomie'], ['extra', 'Libre']].forEach(([k, label]) => { const d = dedupe(activeTags((st.neg || {})[k]), nseen); if (d.length) nlines.push({ label, text: d.join(', '), tags: d }); });
    const negative = nlines.map(l => l.text).join(', ');
    const tokens = { pos: estimateTokens(positive), neg: estimateTokens(negative) };
    if (tokens.pos > 75) warnings.push(`Le prompt dépasse 75 tokens (≈ ${tokens.pos}) : SwarmUI le découpe en plusieurs blocs, les derniers pèsent moins.`);
    return { positive, negative, lines, negLines: nlines, tokens, warnings };
  }

  // ── Assemblage Anima : tags d'abord, puis une phrase par personnage ────────────
  const CHILD_RE = /(^|\s)(child|children|kid|kids|loli|lolicon|shota|toddler|infant|little girl|little boy|young girl|young boy|elementary school|preschool|baby)(\s|$)/;
  const HAIR_COLOR_RE = /(?:^|\s)(blonde|brown|black|white|silver|grey|gray|red|blue|pink|purple|green|orange|aqua|teal|lavender|multicolored)\s+hair/;
  const cap = t => t ? t[0].toUpperCase() + t.slice(1) : t;
  function descriptor(c) {
    const name = cleanList(c.name)[0];
    if (name) return name;
    const m = HAIR_COLOR_RE.exec(cleanList(c.appearance).join(', ') + ', ' + cleanList(c.details).join(', '));
    const noun = c.gender === 'boy' ? 'man' : c.gender === 'other' ? 'character' : 'woman';
    return 'the ' + (m ? m[1] + '-haired ' : '') + noun;
  }
  function charTags(c) {
    const outfit = (c.outfits || [])[c.outfit || 0] || { tags: '' };
    return [...cleanList(c.appearance), ...cleanList(c.size), ...cleanList(outfit.tags), ...cleanList(c.expression), ...cleanList(c.pose), ...cleanList(c.details)];
  }
  function composeAnima(st) {
    const opts = st.opts || {}, prof = profileOf(st.profile);
    const seen = new Set(); const lines = []; const warnings = [];
    const push = (label, tags) => { const d = dedupe(tags, seen); if (d.length) lines.push({ label, text: d.join(', '), tags: d, kind: 'tags' }); return d; };
    const sentence = (label, text) => { const t = String(text || '').replace(/\s+/g, ' ').trim(); if (!t) return; lines.push({ label, text: /[.!?]$/.test(t) ? t : t + '.', tags: [], kind: 'sentence' }); };
    const chars = (st.chars || []).filter(c => c.on !== false);
    push('Qualité', activeTags(st.pos.quality));
    push('Sécurité', activeTags(st.pos.meta));
    push('Sujet', subjectTags(st.chars || [], opts));
    const ids = [];
    chars.forEach(c => { ids.push(...cleanList(c.name)); if (c.gender === 'futa') ids.push('futanari'); });
    push('Personnages', ids);
    push('Séries', chars.flatMap(c => cleanList(c.series)));
    push('Artiste', activeTags(st.pos.artist).map(t => (t[0] === '@' || /^[(<]/.test(t) ? t : '@' + t)));
    push('Style et trigger words', activeTags(st.pos.style, true));
    ['framing', 'action', 'setting', 'lighting', 'extra'].forEach(k => push({ framing: 'Cadrage', action: 'Action', setting: 'Décor', lighting: 'Lumière', extra: 'Libre' }[k], activeTags(st.pos[k])));
    const tagLines = lines.length;
    // phrases
    const text = st.text || {};
    sentence('Scène', text.scene);
    const descs = [];
    chars.forEach((c, i) => {
      const d = descriptor(c); descs.push(d);
      const tags = charTags(c);
      const anchor = opts.adultAnchor !== false && !tags.some(t => /\b(adult|mature|woman|man)\b/.test(tagKey(t))) ? [c.gender === 'boy' ? 'adult man' : 'adult woman'] : [];
      const pos = cleanList(c.position)[0];
      const body = [...anchor, ...tags].join(', ');
      if (!body && !pos) return;
      if (opts.charStyle === 'tags') {
        // tags ancrés : « on the left: nom, adult woman, tags… » (une ligne de tags par personnage, sans phrase)
        const name = cleanList(c.name)[0];
        const head = pos || (name ? '' : d);
        const items = dedupe([...(name ? [name] : []), ...anchor, ...tags], new Set());
        if (items.length || head) lines.push({ label: `Perso ${i + 1} · ${d}`, text: (head ? head + ': ' : '') + items.join(', '), tags: items, kind: 'chartags' });
      } else {
        const lead = (pos ? cap(pos) + ', ' + d : cap(d)) + ':';
        sentence(`Perso ${i + 1} · ${d}`, `${lead} ${body}`);
      }
      // avertissements par personnage
      const sizes = tags.filter(t => SIZES.includes(tagKey(t)));
      if (new Set(sizes.map(tagKey)).size > 1) warnings.push(`Personnage ${i + 1} : plusieurs tailles de poitrine (${sizes.join(' / ')}). Garde un seul tag par personnage.`);
    });
    sentence('Interaction', text.interaction);
    sentence('Décor et lumière', text.env);
    // positive : ligne de tags, puis les phrases
    const tagPart = lines.slice(0, tagLines).map(l => l.text).join(', ');
    const sentPart = lines.slice(tagLines).map(l => l.text).join(opts.charStyle === 'tags' ? '\n' : ' ');
    const positive = [tagPart, sentPart].filter(Boolean).join('\n');
    // avertissements généraux
    const all = new Set([...lines.flatMap(l => l.tags.map(tagKey)), ...chars.flatMap(c => charTags(c).map(tagKey))]);
    CONFLICTS.forEach(g => { const hit = g.filter(t => all.has(t)); if (hit.length > 1) warnings.push(`Tags qui se contredisent : ${hit.join(' / ')}`); });
    const safety = ['safe', 'sensitive', 'nsfw', 'explicit'].filter(t => all.has(t));
    if (safety.length > 1) warnings.push(`Plusieurs tags de sécurité actifs : ${safety.join(' / ')}`);
    const kids = [...all].filter(t => CHILD_RE.test(t));
    if (kids.length) warnings.push(`Tag évoquant l'enfance : « ${kids[0]} ». Les personnages doivent rester adultes : retire-le.`);
    const nSent = lines.filter(l => l.kind === 'sentence').length;
    if (positive && nSent < 2) warnings.push('Anima donne de meilleurs résultats avec au moins deux phrases concrètes (scène, personnage, interaction, décor).');
    if (chars.length > 1) {
      if (chars.some(c => !cleanList(c.position).length)) warnings.push('Plusieurs personnages : donne une position à chacun (à gauche, au premier plan…) pour limiter le mélange des détails.');
      const hair = chars.map(c => { const m = HAIR_COLOR_RE.exec(cleanList(c.appearance).join(', ')); return m ? m[1] : null; }).filter(Boolean);
      if (new Set(hair).size < hair.length) warnings.push('Deux personnages ont la même couleur de cheveux : des couleurs différentes réduisent le mélange des détails.');
      if (!(text.interaction || '').trim()) warnings.push('Plusieurs personnages : une phrase d\'interaction qui reprend leurs descripteurs aide le modèle.');
    }
    // négatif
    const nseen = new Set(); const nlines = [];
    if (prof.negative) [['quality', 'Qualité'], ['anatomy', 'Anatomie'], ['extra', 'Libre']].forEach(([k, label]) => { const d = dedupe(activeTags((st.neg || {})[k]), nseen); if (d.length) nlines.push({ label, text: d.join(', '), tags: d }); });
    const negative = nlines.map(l => l.text).join(', ');
    return { positive, negative, lines, negLines: nlines, tokens: { pos: null, neg: null }, warnings, descriptors: descs, anima: true, negIgnored: !prof.negative };
  }


  // ── Relecture d'un prompt existant ────────────────────────────────────────────
  // lookup(tag) peut renvoyer le type Danbooru du tag (0 général, 1 artiste, 3 série, 4 personnage, 5 méta) si la base est chargée.
  function parse(positiveText, negativeText, lookup, profile) {
    const st = defaultState(profile);
    Object.keys(st.pos).forEach(k => { st.pos[k] = st.pos[k].map(x => ({ ...x, on: false })); });
    Object.keys(st.neg).forEach(k => { st.neg[k] = st.neg[k].map(x => ({ ...x, on: false })); });
    const typeOf = t => { try { const v = lookup ? lookup(t.replace(/\\([()])/g, '$1')) : null; return typeof v === 'number' ? v : null; } catch { return null; } };
    const turnOn = (list, tag) => { const k = tagKey(tag); const f = list.find(x => tagKey(x.t) === k); if (f) f.on = true; else list.push({ t: tag, on: true }); };
    const counts = { girl: 0, boy: 0, other: 0 }; let futa = 0;
    const person = { size: '', names: [], series: [], appearance: [], outfit: [], expression: [], pose: [], details: [] };
    const notes = [];
    dedupe(splitTags(positiveText).map(t => /^<[^>]*>$/.test(t.trim()) ? t.trim() : normTag(t)).filter(Boolean)).forEach(t => {
      const k = tagKey(t);
      if (/^<[^>]*>$/.test(t)) { turnOn(st.pos.style, t); return; }
      const cm = /^(\d+)\+?(girl|boy|other)s?$/.exec(k);
      if (cm) { counts[cm[2]] += cm[1] === '6' && /\+/.test(k) ? 6 : parseInt(cm[1], 10); return; }
      if (COUNT_RE.test(k)) return;
      if (k === 'futanari') { futa++; return; }
      if (t[0] === '@') { turnOn(st.pos.artist, t); return; }
      if (SIZES.includes(k) && !person.size) { person.size = t; return; }
      const type = typeOf(k.replace(/ /g, '_'));
      if (type === 4) { person.names.push(t); return; }
      if (type === 3) { person.series.push(t); return; }
      if (type === 1) { turnOn(st.pos.artist, t); return; }
      const cat = categoryOf(t);
      switch (cat) {
        case 'quality': turnOn(st.pos.quality, t); break;
        case 'meta': turnOn(st.pos.meta, t); break;
        case 'style': turnOn(st.pos.style, t); break;
        case 'hair': case 'eyes': case 'body': person.appearance.push(t); break;
        case 'clothing': person.outfit.push(t); break;
        case 'expression': person.expression.push(t); break;
        case 'pose': person.pose.push(t); break;
        case 'framing': turnOn(st.pos.framing, t); break;
        case 'lighting': turnOn(st.pos.lighting, t); break;
        case 'setting': turnOn(st.pos.setting, t); break;
        default: turnOn(st.pos.extra, t);
      }
    });
    const total = counts.girl + counts.boy + counts.other;
    const n = Math.max(total, person.names.length, (person.appearance.length + person.outfit.length + person.expression.length + person.pose.length + (person.size ? 1 : 0)) ? 1 : 0);
    const kinds = [];
    for (let i = 0; i < counts.girl; i++) kinds.push('girl');
    for (let i = 0; i < counts.boy; i++) kinds.push('boy');
    for (let i = 0; i < counts.other; i++) kinds.push('other');
    while (kinds.length < n) kinds.push('girl');
    for (let i = 0; i < Math.min(n, 6); i++) {
      const c = newChar(i + 1);
      c.gender = kinds[i] === 'girl' && futa > i && futa ? 'futa' : kinds[i];
      c.name = person.names[i] || '';
      if (i === 0) {
        c.series = person.series.join(', '); c.size = person.size; c.appearance = person.appearance.join(', '); c.outfits[0].tags = person.outfit.join(', ');
        c.expression = person.expression.join(', '); c.pose = person.pose.join(', ');
      }
      st.chars.push(c);
    }
    if (n > 1 && (person.appearance.length + person.outfit.length + person.expression.length + person.pose.length)) notes.push('Les détails (cheveux, tenue, expression, pose) sont attribués au personnage 1 : vérifie-les.');
    // négatif
    dedupe(splitTags(negativeText).map(normTag).filter(Boolean)).forEach(t => {
      const cat = MAP.get(tagKey(t));
      if (cat === 'negAnatomy') turnOn(st.neg.anatomy, t);
      else if (cat === 'negQuality') turnOn(st.neg.quality, t);
      else turnOn(st.neg.extra, t);
    });
    return { state: st, notes };
  }

  const api = { PROFILES, profileOf, isAnima, applyProfile, SIZES, V, CAT_LABEL, normTag, normRaw, splitTags, tagKey, dedupe, categoryOf, suggest, subjectTags, defaultState, newChar, compose, parse, estimateTokens, GENDERS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.PromptCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
