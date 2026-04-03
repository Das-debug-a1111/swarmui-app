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
    try {
      DB = JSON.parse(localStorage.getItem('tc-extra') || '[]');
    } catch { DB = []; }
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
    try { localStorage.setItem('tc-extra', JSON.stringify(DB)); } catch {}
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
    const after  = text.slice(tagEnd).replace(/^[ \t]*,?[ \t]*/, '');
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
    } else if (e.key === 'Tab') {
      // Tab always picks from autocomplete if dropdown is open (first item if none selected)
      e.preventDefault();
      const idx = activeIdx >= 0 ? activeIdx : 0;
      rows[idx].dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    } else if (e.key === 'Enter' && activeIdx >= 0) {
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

    const DATASET_URLS = {
      danbooru:             'https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru.csv',
      e621:                 'https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/e621.csv',
      danbooru_e621_merged: 'https://raw.githubusercontent.com/DominikDoom/a1111-sd-webui-tagcomplete/main/tags/danbooru_e621_merged.csv',
    };

    document.getElementById('tc-download-db')?.addEventListener('click', async () => {
      const sel = document.getElementById('tc-dataset-sel')?.value || 'danbooru';
      const url = DATASET_URLS[sel];
      showMsg('Téléchargement…');
      try {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        const text = await resp.text();
        const tags = parseCSV(text);
        mergeExtra(tags);
        showMsg(`✓ ${tags.length.toLocaleString()} tags chargés. Total: ${DB.length.toLocaleString()}`);
      } catch (e) {
        showMsg(`❌ Erreur: ${e.message}`);
      }
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
