// ── Tag Autocomplete ──────────────────────────────────────────────────────────
// Danbooru/SD tag autocomplete for SwarmUI Electron app
// Adapted from swarmui-tagcomplete.user.js — improved for native Electron integration

const TagComplete = (() => {
  'use strict';

  const CFG = { maxResults: 15, minChars: 2, debounce: 60 };

  const TYPE_COLOR = {
    0: '#b5bd68', // general
    1: '#cc6666', // artist
    3: '#b294bb', // copyright
    4: '#81a2be', // character
    5: '#8abeb7', // meta
    6: '#de935f', // quality
  };

  const TYPE_LABEL = {
    0: 'general', 1: 'artist', 3: 'copyright',
    4: 'character', 5: 'meta', 6: 'quality',
  };

  // ── Built-in tag list [name, type, count, aliases] ─────────────────────────
  const BUILTIN = [
    ['masterpiece',6,6e6,''],['best quality',6,5e6,''],['high quality',6,4e6,''],
    ['ultra detailed',6,3e6,''],['highly detailed',6,2.5e6,''],['detailed',6,2e6,''],
    ['absurdres',5,2e6,''],['highres',5,1.5e6,''],['8k',6,1.5e6,''],['4k',6,1e6,''],
    ['sharp focus',6,1e6,''],['intricate detail',6,8e5,''],
    ['worst quality',5,4e6,''],['low quality',5,3.5e6,''],['lowres',5,3e6,''],
    ['bad anatomy',5,3e6,''],['bad hands',5,2.5e6,''],['extra limbs',5,1.5e6,''],
    ['missing limbs',5,1.2e6,''],['deformed',5,2e6,''],['mutated hands',5,1e6,''],
    ['blurry',5,3e6,''],['ugly',5,2e6,''],['nsfw',5,3e6,''],
    ['watermark',5,2e6,''],['signature',5,1.5e6,''],['text',5,3e6,''],
    ['jpeg artifacts',5,2e6,''],['cropped',5,2e6,''],
    ['anime',0,5e6,''],['manga',0,3e6,''],['realistic',0,4e6,''],
    ['photorealistic',0,3.5e6,''],['illustration',0,3e6,''],['digital art',0,2.5e6,''],
    ['concept art',0,2e6,''],['cinematic',0,1.8e6,''],['oil painting',0,1.5e6,''],
    ['watercolor',0,1.2e6,''],['sketch',0,1.5e6,''],['lineart',0,1.3e6,''],
    ['cel shading',0,8e5,''],['flat color',0,1e6,''],['pixel art',0,1.2e6,''],
    ['1girl',0,1e7,''],['1boy',0,5e6,''],['2girls',0,3e6,''],['2boys',0,1.5e6,''],
    ['solo',0,8e6,''],['multiple girls',0,2e6,''],['couple',0,1.5e6,''],
    ['blonde hair',0,3e6,''],['black hair',0,3.5e6,''],['brown hair',0,2.5e6,''],
    ['white hair',0,2e6,''],['silver hair',0,1.5e6,''],['blue hair',0,1.5e6,''],
    ['pink hair',0,1.2e6,''],['red hair',0,1.8e6,''],['green hair',0,8e5,''],
    ['purple hair',0,1e6,''],['orange hair',0,9e5,''],['grey hair',0,8e5,'gray hair'],
    ['multicolored hair',0,1e6,''],['gradient hair',0,7e5,''],['streaked hair',0,6e5,''],
    ['long hair',0,5e6,''],['short hair',0,4e6,''],['medium hair',0,2e6,''],
    ['very long hair',0,2e6,''],['twin tails',0,2e6,'twintails'],['ponytail',0,2.5e6,''],
    ['braid',0,1.5e6,''],['braided hair',0,1e6,''],['bangs',0,3e6,''],
    ['ahoge',0,8e5,''],['curly hair',0,1.2e6,''],['wavy hair',0,1.5e6,''],
    ['straight hair',0,1e6,''],['bob cut',0,8e5,''],['side ponytail',0,1e6,''],
    ['drill hair',0,6e5,''],['hair bun',0,1e6,''],
    ['blue eyes',0,4e6,''],['red eyes',0,3e6,''],['green eyes',0,2.5e6,''],
    ['brown eyes',0,2e6,''],['purple eyes',0,1.5e6,''],['golden eyes',0,1e6,''],
    ['amber eyes',0,8e5,''],['aqua eyes',0,9e5,''],['heterochromia',0,6e5,''],
    ['large breasts',0,3e6,''],['medium breasts',0,2e6,''],['small breasts',0,1.5e6,''],
    ['flat chest',0,1e6,''],['tall',0,1e6,''],['petite',0,8e5,''],
    ['school uniform',0,3e6,''],['serafuku',0,1.5e6,''],['dress',0,3.5e6,''],
    ['kimono',0,1.5e6,''],['yukata',0,8e5,''],['maid',0,2e6,'maid outfit|maid uniform'],
    ['swimsuit',0,2.5e6,''],['bikini',0,2e6,''],['white shirt',0,2e6,''],
    ['black dress',0,1.8e6,''],['jacket',0,2.5e6,''],['hoodie',0,1.5e6,''],
    ['coat',0,2e6,''],['suit',0,1.5e6,''],['armor',0,2e6,''],
    ['crop top',0,1.2e6,''],['tank top',0,1.5e6,''],['blouse',0,1.2e6,''],
    ['skirt',0,3e6,''],['miniskirt',0,2e6,''],['pleated skirt',0,1.5e6,''],
    ['thigh highs',0,2.5e6,'thighhighs'],['stockings',0,1.5e6,''],['pantyhose',0,1e6,''],
    ['shorts',0,2e6,''],['jeans',0,1e6,''],['pants',0,1.5e6,''],
    ['naked',0,2e6,'nude'],['nude',0,2.5e6,'naked'],['topless',0,1e6,''],
    ['shirt',0,3e6,''],['t-shirt',0,1.5e6,''],['sweater',0,1.5e6,''],
    ['gloves',0,1.5e6,''],['hat',0,2e6,''],['ribbon',0,2e6,''],
    ['bow',0,2e6,''],['hair ribbon',0,1.5e6,''],['hair bow',0,1e6,''],
    ['sitting',0,4e6,''],['standing',0,5e6,''],['lying',0,2e6,''],
    ['kneeling',0,1e6,''],['jumping',0,8e5,''],['running',0,8e5,''],
    ['walking',0,1.5e6,''],['leaning forward',0,1e6,''],
    ['looking at viewer',0,6e6,''],['smile',0,5e6,''],['blush',0,4e6,''],
    ['crying',0,1.5e6,''],['closed eyes',0,2e6,''],['open mouth',0,4e6,''],
    ['grin',0,1.5e6,''],['expressionless',0,1e6,''],['embarrassed',0,1e6,''],
    ['surprised',0,1e6,''],['angry',0,1e6,''],['sad',0,8e5,''],
    ['seductive smile',0,7e5,''],['nervous',0,7e5,''],
    ['arms up',0,1.5e6,''],['hand on hip',0,1.2e6,''],['hands on hips',0,1e6,''],
    ['outstretched arms',0,6e5,''],['v',0,2e6,'peace sign'],
    ['simple background',0,4e6,''],['white background',0,3e6,''],
    ['outdoors',0,2e6,'outdoor'],['indoors',0,2.5e6,''],['night',0,2.5e6,''],
    ['day',0,2e6,''],['sunset',0,1.5e6,''],['sky',0,3e6,''],
    ['forest',0,1.5e6,''],['city',0,2e6,''],['classroom',0,1e6,''],
    ['bedroom',0,1.2e6,''],['kitchen',0,8e5,''],['beach',0,1.5e6,''],
    ['cafe',0,8e5,''],['park',0,1e6,''],['street',0,1.2e6,''],
    ['snow',0,1.5e6,''],['rain',0,1e6,''],['cherry blossoms',0,1.2e6,'sakura'],
    ['soft lighting',0,1.5e6,''],['dramatic lighting',0,1.2e6,''],
    ['backlighting',0,1e6,''],['rim lighting',0,8e5,''],['neon lights',0,1.2e6,''],
    ['sunlight',0,2e6,''],['moonlight',0,1e6,''],['candlelight',0,6e5,''],
    ['volumetric lighting',0,8e5,''],['bokeh',0,1.2e6,''],
    ['close-up',0,2.5e6,'closeup'],['portrait',0,3e6,''],['full body',0,3e6,''],
    ['upper body',0,3.5e6,''],['bust shot',0,2e6,''],['cowboy shot',0,2e6,''],
    ['side view',0,2e6,''],['from above',0,1.5e6,''],['from below',0,8e5,''],
    ['wide shot',0,1.5e6,''],['dutch angle',0,6e5,''],['fisheye',0,4e5,''],
    ['vibrant colors',0,1e6,''],['muted colors',0,6e5,''],['monochrome',0,2e6,''],
    ['greyscale',0,1.5e6,'grayscale'],['depth of field',0,1.5e6,''],
    ['motion blur',0,6e5,''],['lens flare',0,8e5,''],['film grain',0,6e5,''],
    ['dark skin',0,1e6,''],['tan',0,8e5,''],['pale skin',0,7e5,''],
    ['gyaru',0,5e5,''],['gyaru-o',0,2e5,''],
  ];

  // ── DB ─────────────────────────────────────────────────────────────────────
  let DB = [];
  let recentlyUsed = [];  // array of tag names, most recent first

  function loadRecent() {
    try { recentlyUsed = JSON.parse(localStorage.getItem('tc-recent') || '[]'); } catch { recentlyUsed = []; }
  }

  function trackRecent(name) {
    recentlyUsed = [name, ...recentlyUsed.filter(n => n !== name)].slice(0, 30);
    try { localStorage.setItem('tc-recent', JSON.stringify(recentlyUsed)); } catch {}
  }

  function buildDB() {
    DB = BUILTIN.map(([name, type, count, aliases]) => ({
      name, type, count,
      aliases: aliases ? aliases.split('|').filter(Boolean) : [],
      lower: name.toLowerCase(),
    }));
    try {
      const extra = JSON.parse(localStorage.getItem('tc-extra') || '[]');
      const seen = new Set(DB.map(t => t.lower));
      extra.forEach(t => { if (!seen.has(t.lower)) { DB.push(t); seen.add(t.lower); } });
    } catch {}
    DB.sort((a, b) => b.count - a.count);
  }

  function recentScore(name) {
    const i = recentlyUsed.indexOf(name);
    return i === -1 ? 0 : (30 - i);
  }

  function query(q) {
    if (!q || q.length < CFG.minChars) return [];
    const nq = q.toLowerCase().replace(/ /g, '_');
    const exact = [], starts = [], has = [];
    for (const t of DB) {
      const tl = t.lower.replace(/ /g, '_');
      if (tl === nq)          { exact.push(t);  continue; }
      if (tl.startsWith(nq)) { starts.push(t); continue; }
      if (t.aliases.some(a => { const al = a.toLowerCase().replace(/ /g,'_'); return al===nq||al.startsWith(nq); })) { starts.push(t); continue; }
      if (tl.includes(nq))   { has.push(t);    continue; }
    }
    // Within each group, sort by recency bonus then count
    const sort = arr => arr.sort((a,b) => (recentScore(b.name)-recentScore(a.name)) || (b.count-a.count));
    return [...sort(exact), ...sort(starts), ...sort(has)].slice(0, CFG.maxResults);
  }

  // ── CSV parser (a1111-tagcomplete format) ──────────────────────────────────
  function parseCSV(text) {
    const out = [];
    for (const line of text.split('\n')) {
      const l = line.trim();
      if (!l || l[0]==='#') continue;
      const parts = l.split(',');
      const name = parts[0]?.replace(/^"|"$/g,'').trim();
      if (!name) continue;
      const type    = parseInt(parts[1]) || 0;
      const count   = parseInt(parts[2]) || 0;
      const aliases = parts[3] ? parts[3].replace(/^"|"$/g,'').split('|').filter(Boolean) : [];
      out.push({ name, type, count, aliases, lower: name.toLowerCase() });
    }
    return out;
  }

  function mergeExtra(tags) {
    const seen = new Set(DB.map(t => t.lower));
    tags.forEach(t => { if (!seen.has(t.lower)) { DB.push(t); seen.add(t.lower); } });
    DB.sort((a,b) => b.count - a.count);
    const builtinSet = new Set(BUILTIN.map(([n]) => n.toLowerCase()));
    const extras = DB.filter(t => !builtinSet.has(t.lower));
    try { localStorage.setItem('tc-extra', JSON.stringify(extras)); } catch {}
    updateStats();
  }

  // ── Dropdown ───────────────────────────────────────────────────────────────
  let dropdown = null;
  let activeIdx = -1;
  let currentEl = null;
  let tagStart = 0;
  let tagEnd   = 0;

  function getDropdown() {
    if (dropdown) return dropdown;
    dropdown = document.createElement('div');
    dropdown.id = 'tc-dropdown';
    dropdown.style.cssText = `
      position:fixed; z-index:99999;
      background:#13171f; border:1px solid #2d3748;
      border-radius:8px; box-shadow:0 8px 32px rgba(0,0,0,.8);
      max-height:320px; overflow-y:auto;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
      font-size:12px; display:none; min-width:220px; max-width:420px;
      scrollbar-width:thin; scrollbar-color:#2d3748 transparent;
    `;
    document.body.appendChild(dropdown);
    return dropdown;
  }

  function fmtCount(n) {
    if (n >= 1e6) return `${(n/1e6).toFixed(1)}M`;
    if (n >= 1e3) return `${Math.round(n/1e3)}k`;
    return String(n);
  }

  function renderDropdown(items, el) {
    const dd = getDropdown();
    if (!items.length) { dd.style.display='none'; return; }

    dd.innerHTML = items.map((t, i) => {
      const color   = TYPE_COLOR[t.type] || TYPE_COLOR[0];
      const isRecent = recentlyUsed.includes(t.name);
      return `<div class="tc-row" data-i="${i}" style="
        padding:7px 12px; cursor:pointer; display:flex; align-items:center; gap:10px;
        border-bottom:1px solid #1a1f2b;
        ${i === activeIdx ? 'background:#1e2d45;' : ''}
        transition:background .1s;
      ">
        <span style="color:${color};font-weight:600;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.name)}</span>
        <span style="display:flex;align-items:center;gap:6px;flex-shrink:0">
          ${isRecent ? '<span style="color:#5a8a6a;font-size:10px">↺</span>' : ''}
          <span style="color:#4a5568;font-size:10px">${fmtCount(t.count)}</span>
        </span>
      </div>`;
    }).join('');

    dd.querySelectorAll('.tc-row').forEach((row, i) => {
      row.addEventListener('mousedown', e => { e.preventDefault(); insert(items[i]); });
      row.addEventListener('mouseenter', () => setActive(i));
    });

    dd.style.visibility = 'hidden';
    dd.style.display    = 'block';
    positionDD(el);
    dd.style.visibility = '';
  }

  function positionDD(el) {
    const dd  = getDropdown();
    const r   = el.getBoundingClientRect();
    const ddH = dd.offsetHeight || 44;
    let top  = r.bottom + 4;
    let left = r.left;
    if (top + ddH > window.innerHeight) top = r.top - ddH - 4;
    if (top < 0) top = 0;
    if (left + 420 > window.innerWidth) left = window.innerWidth - 424;
    if (left < 0) left = 0;
    dd.style.top  = top + 'px';
    dd.style.left = left + 'px';
  }

  function hideDD() {
    if (dropdown) dropdown.style.display = 'none';
    activeIdx = -1;
  }

  function setActive(i) {
    const rows = dropdown?.querySelectorAll('.tc-row');
    if (!rows) return;
    rows.forEach((r, j) => r.style.background = j === i ? '#1e2d45' : '');
    if (rows[i]) rows[i].scrollIntoView({ block: 'nearest' });
    activeIdx = i;
  }

  function insert(tag) {
    if (!currentEl) return;
    const text   = currentEl.value;
    const before = text.slice(0, tagStart);
    const after  = text.slice(tagEnd).replace(/^\s*,?\s*/, '');
    currentEl.value = before + tag.name + (after ? ', ' + after : ', ');
    const cur = tagStart + tag.name.length + 2;
    currentEl.setSelectionRange(cur, cur);
    hideDD();
    trackRecent(tag.name);
    currentEl.dispatchEvent(new Event('input', { bubbles: true }));
    currentEl.focus();
  }

  // ── SwarmUI syntax detection ───────────────────────────────────────────────
  // Don't autocomplete inside <embed:...> or <lora:...> blocks
  function isInsideSpecialSyntax(text, pos) {
    const before = text.slice(0, pos);
    const lastOpen = before.lastIndexOf('<');
    if (lastOpen === -1) return false;
    const lastClose = before.lastIndexOf('>');
    return lastClose < lastOpen;
  }

  function getCurrentTag(el) {
    const text = el.value;
    const pos  = el.selectionStart;
    if (isInsideSpecialSyntax(text, pos)) return { tag: '', start: pos, end: pos };
    let start = 0;
    for (let i = pos - 1; i >= 0; i--) {
      if (text[i] === ',' || text[i] === '\n') { start = i + 1; break; }
    }
    while (start < pos && (text[start] === ' ' || text[start] === '\n')) start++;
    return { tag: text.slice(start, pos), start, end: pos };
  }

  // ── SwarmUI <tag> syntax autocomplete ─────────────────────────────────────
  const SWARM_TAGS = [
    // Randomization
    { name: 'random',           desc: 'Select one random option from a list',                         insert: '<random:',         hint: 'Comma-separated: <random:cat,dog,elephant>\nUse || instead of , to include commas\nNumeric range: <random:0.8-1.2>' },
    { name: 'random[2-4]',      desc: 'Select N random options from a list',                          insert: '<random[2-4]:',    hint: 'Comma-separated: <random[2-4]:cat,dog,elephant>\nN can be a range: [1-3]' },
    { name: 'alternate',        desc: 'Alternate between options each step (blend concepts)',          insert: '<alternate:',      hint: 'Pipe-separated: <alternate:cat|dog|elephant>\nAlias: <alt:...>' },
    { name: 'fromto[0.5]',      desc: 'Switch prompt from one value to another at a timestep',        insert: '<fromto[0.5]:',    hint: '<fromto[0.5]:before,after>\n0.5 = halfway through steps (decimal) or use integer step index' },
    { name: 'wildcard',         desc: 'Pick a random line from a wildcard .txt file',                 insert: '<wildcard:',       hint: '<wildcard:filename> — file in Data/Wildcards/\nCount: <wildcard[2]:name>\nExclude: <wildcard:name,not=word1,word2>\nAlias: <wc:...>' },
    { name: 'wildcard[2]',      desc: 'Pick N random lines from a wildcard file',                     insert: '<wildcard[2]:',    hint: '<wildcard[2]:filename> — picks 2 random lines' },
    { name: 'repeat[3]',        desc: 'Repeat text N times',                                          insert: '<repeat[3]:',      hint: '<repeat[3]:word> — N can be a range: [1-3]' },
    // Model / Asset
    { name: 'lora',             desc: 'Apply a LoRA model (with optional weight)',                    insert: '<lora:',           hint: null, modelType: 'lora' },
    { name: 'embed',            desc: 'Use a CLIP textual inversion embedding',                       insert: '<embed:',          hint: null, modelType: 'embed' },
    { name: 'embedding',        desc: 'Use a CLIP textual inversion embedding (alias)',                insert: '<embedding:',      hint: null, modelType: 'embed' },
    { name: 'preset',           desc: 'Apply a saved preset configuration',                           insert: '<preset:',         hint: null, modelType: 'preset' },
    { name: 'param[name]',      desc: 'Set any generation parameter directly',                        insert: '<param[',          hint: '<param[steps]:30> or <param[cfgscale]:7>\nSupports nested tags: <param[cfgscale]:<random:5,7,9>>' },
    { name: 'trigger',          desc: 'Insert trigger phrases from current model and LoRAs',           insert: '<trigger>',        hint: 'No arguments needed — inserts trigger words automatically' },
    // Variables / Macros
    { name: 'setvar[name]',     desc: 'Store a variable for reuse',                                   insert: '<setvar[',         hint: '<setvar[myvar]:value> — retrieve with <var:myvar>\nAdd ,false to store silently: <setvar[name,false]:value>' },
    { name: 'var',              desc: 'Retrieve a stored variable',                                   insert: '<var:',            hint: '<var:myvar> — returns value stored with <setvar[myvar]:...>' },
    { name: 'setmacro[name]',   desc: 'Store a macro (re-evaluated each use)',                        insert: '<setmacro[',       hint: '<setmacro[mymacro]:definition> — call with <macro:mymacro>' },
    { name: 'macro',            desc: 'Expand a stored macro',                                        insert: '<macro:',          hint: '<macro:mymacro> — expands macro stored with <setmacro[...]>' },
    // Section routing
    { name: 'base',             desc: 'Route following prompt to base model only',                    insert: '<base>',           hint: 'No arguments — content after tag goes to base model only (not refiner)' },
    { name: 'refiner',          desc: 'Route following prompt to refiner/upscale model only',         insert: '<refiner>',        hint: 'No arguments — content after tag goes to refiner stage only' },
    { name: 'video',            desc: 'Route following prompt to video generation stage',             insert: '<video>',          hint: 'No arguments — content after tag goes to video stage' },
    { name: 'break',            desc: 'Manual CLIP token split for long prompts',                     insert: '<break>',          hint: 'No arguments — splits prompt at CLIP 75-token boundary' },
    // Spatial / Regional
    { name: 'region',           desc: 'Apply alternate prompt to a rectangular region',               insert: '<region:',         hint: 'x,y,width,height (0.0–1.0): <region:0.25,0.25,0.5,0.5>\nWith strength: <region:0,0,0.5,1,0.8>\n"background" for background region\n"end" to return to global prompt' },
    { name: 'object',           desc: 'Regional prompt + automatic inpainting of the area',           insert: '<object:',         hint: 'x,y,width,height (0.0–1.0): <object:0.25,0.25,0.5,0.5>\nWith strength: <object:0,0,0.5,1,0.8>' },
    { name: 'segment',          desc: 'Segmentation mask-based regional prompt',                      insert: '<segment:',        hint: '<segment:face|hair> or YOLO: <segment:yolo-modelname-0,creativity,threshold>\nMultiple: <segment:face|hair>' },
    { name: 'clear',            desc: 'Clear/make transparent the matched region (PNG only)',         insert: '<clear:',          hint: 'Same format as <segment:...>\n<clear:face> — makes the face area transparent' },
    // Utility
    { name: 'comment',          desc: 'Add a comment (entirely ignored during generation)',           insert: '<comment:',        hint: '<comment:my note here> — completely discarded, use for documentation' },
  ];

  // Cache for LoRA/Embedding lists (cleared on reconnect via TagComplete.clearModelCache)
  const _modelCache = {};
  async function fetchModelList(type) {
    if (_modelCache[type]) return _modelCache[type];
    try {
      if (type === 'preset') {
        const raw = localStorage.getItem('swarmapp-presets');
        const presets = raw ? JSON.parse(raw) : {};
        const names = Object.keys(presets);
        _modelCache[type] = names;
        return names;
      }
      const fn = type === 'lora' ? 'listLoRAs' : 'listEmbeddings';
      const res = await API[fn]();
      const files = res?.files || res?.models || [];
      const names = files.map(f => typeof f === 'string' ? f : (f.name || f.title || '')).filter(Boolean);
      _modelCache[type] = names;
      return names;
    } catch { return []; }
  }

  function getSwarmPrefix(el) {
    const text   = el.value;
    const pos    = el.selectionStart;
    const before = text.slice(0, pos);
    const lastLt = before.lastIndexOf('<');
    if (lastLt === -1) return null;
    const afterLt = before.slice(lastLt + 1);
    if (afterLt.includes('>')) return null;
    // Check if we're after the colon of a known tag (e.g. <lora:xxx, <random:xxx)
    const colonIdx = afterLt.indexOf(':');
    if (colonIdx !== -1) {
      const tagPart = afterLt.slice(0, colonIdx).toLowerCase().replace(/\[.*?\]/, '');
      const query   = afterLt.slice(colonIdx + 1);
      const tagDef  = SWARM_TAGS.find(t => t.name.toLowerCase().replace(/\[.*?\]/, '') === tagPart);
      if (tagDef) return { ltPos: lastLt, afterColon: true, tagDef, modelQuery: query };
    }
    return { prefix: afterLt.toLowerCase(), ltPos: lastLt, afterColon: false };
  }

  function renderSwarmDropdown(prefix, el) {
    const matches = SWARM_TAGS.filter(t => t.name.toLowerCase().startsWith(prefix));
    if (!matches.length) { hideDD(); return; }
    dropdown.innerHTML = matches.map((t, i) => `
      <div class="tc-row" data-si="${i}" style="padding:6px 10px;cursor:pointer;display:flex;gap:8px;align-items:baseline">
        <span style="color:#a78bfa;font-weight:600;white-space:nowrap">${esc(t.name)}</span>
        <span style="color:#6b7280;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.desc)}</span>
      </div>`).join('');
    dropdown.querySelectorAll('.tc-row').forEach((row, i) => {
      row.addEventListener('mousedown', e => { e.preventDefault(); insertSwarmTag(matches[i], el); });
    });
    positionDD(el);
    dropdown.style.display = 'block';
  }

  function insertSwarmTag(tag, el) {
    const { ltPos } = getSwarmPrefix(el);
    const text = el.value;
    const pos  = el.selectionStart;
    el.value = text.slice(0, ltPos) + tag.insert + text.slice(pos);
    const cur = ltPos + tag.insert.length;
    el.setSelectionRange(cur, cur);
    hideDD();
    el.dispatchEvent(new Event('input'));
  }

  // ── Input handler ──────────────────────────────────────────────────────────
  let _debT;
  function onInput(e) {
    clearTimeout(_debT);
    _debT = setTimeout(() => {
      const el = e.target;
      // Check for SwarmUI <tag> syntax first
      const swarm = getSwarmPrefix(el);
      if (swarm !== null) {
        currentEl = el;
        if (swarm.afterColon) {
          const { tagDef, modelQuery } = swarm;
          if (tagDef.modelType) {
            // Show model list (lora/embed)
            fetchModelList(tagDef.modelType).then(names => {
              const q = modelQuery.toLowerCase();
              const matches = names.filter(n => n.toLowerCase().includes(q)).slice(0, 20);
              if (!matches.length) { hideDD(); return; }
              dropdown.innerHTML = matches.map((n, i) => `
                <div class="tc-row" data-mi="${i}" style="padding:6px 10px;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">
                  <span style="color:#a78bfa;font-weight:600">${esc(n)}</span>
                </div>`).join('');
              dropdown.querySelectorAll('.tc-row').forEach((row, i) => {
                row.addEventListener('mousedown', e => {
                  e.preventDefault();
                  const text = el.value, pos = el.selectionStart;
                  const colonPos = text.lastIndexOf(':', pos);
                  el.value = text.slice(0, colonPos + 1) + matches[i] + '>' + text.slice(pos);
                  const cur = colonPos + 1 + matches[i].length + 1;
                  el.setSelectionRange(cur, cur);
                  hideDD();
                });
              });
              positionDD(el);
              dropdown.style.display = 'block';
            });
          } else if (tagDef.hint) {
            // Show syntax hint
            dropdown.innerHTML = `<div style="padding:8px 12px;color:#9ca3af;font-size:12px;line-height:1.6;white-space:pre-line">${esc(tagDef.hint)}</div>`;
            positionDD(el);
            dropdown.style.display = 'block';
          } else {
            hideDD();
          }
          return;
        }
        renderSwarmDropdown(swarm.prefix, el);
        return;
      }
      const { tag, start, end } = getCurrentTag(el);
      currentEl = el; tagStart = start; tagEnd = end;
      if (tag.length >= CFG.minChars) {
        renderDropdown(query(tag), el);
      } else {
        hideDD();
      }
    }, CFG.debounce);
  }

  function onKeydown(e) {
    const dd = getDropdown();
    if (!dd || dd.style.display === 'none') return;
    const rows = dd.querySelectorAll('.tc-row');

    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive(Math.min(activeIdx + 1, rows.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive(Math.max(activeIdx - 1, -1));
    } else if ((e.key === 'Enter' || e.key === 'Tab') && activeIdx >= 0) {
      e.preventDefault();
      rows[activeIdx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } else if (e.key === 'Escape') {
      hideDD();
    }
  }

  // ── Attach ─────────────────────────────────────────────────────────────────
  function attach(el) {
    if (el.dataset.tc) return;
    el.dataset.tc = '1';
    el.addEventListener('input',   onInput);
    el.addEventListener('keydown', onKeydown);
    el.addEventListener('blur',    () => setTimeout(hideDD, 180));
    el.addEventListener('scroll',  () => {
      if (dropdown && dropdown.style.display !== 'none' && currentEl === el) positionDD(el);
    });
  }

  // ── Stats label ────────────────────────────────────────────────────────────
  function updateStats() {
    const el = document.getElementById('tc-stats');
    if (el) el.textContent = `${DB.length.toLocaleString()} tags loaded`;
  }

  // ── Settings sidebar section ───────────────────────────────────────────────
  function initSettingsUI() {
    const statsEl = document.getElementById('tc-stats');
    if (statsEl) statsEl.textContent = `${DB.length.toLocaleString()} tags loaded`;

    document.getElementById('tc-load-csv')?.addEventListener('click', () => {
      const input = document.createElement('input');
      input.type   = 'file';
      input.accept = '.csv,.txt';
      input.onchange = e => {
        const file = e.target.files[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = ev => {
          const tags = parseCSV(ev.target.result);
          mergeExtra(tags);
          showMsg(`✓ ${tags.length} tags ajoutés. Total: ${DB.length}`);
        };
        reader.readAsText(file);
      };
      input.click();
    });

    document.getElementById('tc-clear-extra')?.addEventListener('click', () => {
      localStorage.removeItem('tc-extra');
      buildDB();
      updateStats();
      showMsg(`Extra tags supprimés. Built-in: ${DB.length}`);
    });

    document.getElementById('tc-clear-recent')?.addEventListener('click', () => {
      recentlyUsed = [];
      localStorage.removeItem('tc-recent');
      showMsg('Historique effacé.');
    });
  }

  function showMsg(text) {
    const el = document.getElementById('tc-msg');
    if (!el) return;
    el.textContent = text;
    setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 3000);
  }

  // ── Init ───────────────────────────────────────────────────────────────────
  function init() {
    loadRecent();
    buildDB();

    // Attach to all prompt textareas (Txt2Img, Inpaint, Scheduler)
    ['inp-positive', 'inp-negative', 'inp-prompt', 'inp-neg', 'sws-f-prompt', 'sws-f-neg'].forEach(id => {
      const el = document.getElementById(id);
      if (el) attach(el);
    });

    initSettingsUI();

    window.addEventListener('resize', () => {
      if (currentEl && dropdown && dropdown.style.display !== 'none') positionDD(currentEl);
    }, { passive: true });
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  return { init, mergeExtra, parseCSV, clearModelCache: () => { delete _modelCache.lora; delete _modelCache.embed; delete _modelCache.preset; } };
})();
