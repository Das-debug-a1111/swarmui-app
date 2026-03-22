// ── Character Selector ────────────────────────────────────────────────────────

const CharSelector = (() => {
  const COLS   = 2;
  const CARD_H = 210;
  const GAP    = 6;
  const ROW_H  = CARD_H + GAP;
  const PAD    = 8;   // grid horizontal padding each side
  const BUFFER = 3;   // extra rows rendered above/below viewport

  // ── State ────────────────────────────────────────────────────────────────────
  let allChars     = [];   // [{name, series}]
  let tagAssist    = {};
  let favorites    = new Set(JSON.parse(localStorage.getItem('cs-favs')    || '[]'));
  let weights      = JSON.parse(localStorage.getItem('cs-weights')  || '{}');
  let recentlyUsed = JSON.parse(localStorage.getItem('cs-recent')   || '[]');
  let filtered     = [];
  let activeChars  = new Set();
  let panelOpen    = false;
  let globalWeight = parseFloat(localStorage.getItem('cs-gweight')  || '1.0');

  let searchQ        = '';
  let showFavOnly    = false;
  let showActiveOnly = false;
  let sortMode       = 'default';
  let seriesFilter   = '';

  const thumbCache = new Map();

  // ── DOM helpers ──────────────────────────────────────────────────────────────
  const $ = id => document.getElementById(id);
  const esc = s => String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const escRe = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  // ── Init ─────────────────────────────────────────────────────────────────────
  async function init() {
    if (!window.electronAPI?.charList) return;
    try {
      const [listResult, tags] = await Promise.all([
        window.electronAPI.charList(),
        window.electronAPI.charTags(),
      ]);

      // No data folder configured — show setup prompt inside the panel
      if (listResult?.error === 'no_data_path') {
        const inner = $('cs-inner');
        if (inner) inner.innerHTML = `
          <div style="padding:24px 16px;text-align:center;color:var(--muted);font-size:12px;line-height:1.6">
            <div style="font-size:22px;margin-bottom:10px">📂</div>
            <div style="margin-bottom:12px">Character data folder not configured.</div>
            <button id="cs-pick-folder" style="padding:6px 14px;background:var(--accent);color:#000;border:none;border-radius:5px;cursor:pointer;font-weight:600;font-size:12px">
              Choose folder…
            </button>
          </div>`;
        document.getElementById('cs-pick-folder')?.addEventListener('click', async () => {
          const res = await window.electronAPI.configPickDataFolder();
          if (res?.error) { alert(res.error); return; }
          if (res?.path) init(); // retry after folder set
        });
        return;
      }

      allChars  = Array.isArray(listResult) ? listResult : [];
      tagAssist = tags || null;

      // Populate series select
      const series = [...new Set(allChars.map(c => c.series).filter(Boolean))].sort();
      const sel = $('cs-series-sel');
      if (sel && series.length) {
        sel.innerHTML = '<option value="">🌐 All series</option>' +
          series.map(s => `<option value="${esc(s)}">${esc(s)}</option>`).join('');
      }

      syncFromPrompt();
      applyFilter();
    } catch (e) { console.error('[CharSelector] init:', e); }
  }

  // ── Active char sync ─────────────────────────────────────────────────────────
  function syncFromPrompt() {
    const prompt = ($('inp-positive')?.value || '').toLowerCase();
    activeChars = new Set(
      allChars
        .map(c => c.name)
        .filter(name => prompt.includes(name.toLowerCase()))
    );
    const el = $('cs-active-count');
    if (el) el.textContent = activeChars.size ? `${activeChars.size} active` : '';

    // Update already-rendered cards in-place (renderVirtual skips existing rows)
    document.querySelectorAll('.cs-card').forEach(card => {
      const name = card.dataset.name;
      if (name) card.classList.toggle('cs-active', activeChars.has(name));
    });

    // If "active only" filter is on, rebuild list immediately
    if (showActiveOnly) {
      const inner = $('cs-inner');
      if (inner) inner.innerHTML = '';
      applyFilter();
    }
  }

  function watchPrompt() {
    const ta = $('inp-positive');
    if (!ta) return;
    let t;
    ta.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => syncFromPrompt(), 200);
    });
  }

  // ── Filter & sort ─────────────────────────────────────────────────────────────
  function applyFilter() {
    const q = searchQ.toLowerCase().trim();
    filtered = allChars.filter(c => {
      if (showFavOnly    && !favorites.has(c.name))   return false;
      if (showActiveOnly && !activeChars.has(c.name)) return false;
      if (seriesFilter   && c.series !== seriesFilter) return false;
      if (q && !c.name.toLowerCase().includes(q))     return false;
      return true;
    });

    if (sortMode === 'alpha') {
      filtered.sort((a, b) => a.name.localeCompare(b.name));
    } else if (sortMode === 'recent') {
      filtered.sort((a, b) => {
        const ra = recentlyUsed.indexOf(a.name), rb = recentlyUsed.indexOf(b.name);
        if (ra === -1 && rb === -1) return a.name.localeCompare(b.name);
        if (ra === -1) return 1;
        if (rb === -1) return -1;
        return ra - rb;
      });
    } else {
      filtered.sort((a, b) => {
        const fa = favorites.has(a.name), fb = favorites.has(b.name);
        if (fa !== fb) return fa ? -1 : 1;
        const ra = recentlyUsed.indexOf(a.name), rb = recentlyUsed.indexOf(b.name);
        if (ra !== -1 || rb !== -1) {
          if (ra === -1) return 1;
          if (rb === -1) return -1;
          return ra - rb;
        }
        return a.name.localeCompare(b.name);
      });
    }

    const cnt = $('cs-counter');
    if (cnt) cnt.textContent = `${filtered.length} / ${allChars.length}`;

    // Clear all rendered rows so the new filter is applied immediately
    const inner = $('cs-inner');
    if (inner) inner.innerHTML = '';

    renderVirtual();
  }

  // ── Virtual scroll ────────────────────────────────────────────────────────────
  function renderVirtual() {
    const grid  = $('cs-grid');
    const inner = $('cs-inner');
    if (!grid || !inner) return;

    const numRows = Math.ceil(filtered.length / COLS);
    inner.style.height = (numRows * ROW_H) + 'px';

    const scrollTop = grid.scrollTop;
    const viewH     = grid.clientHeight;
    const firstRow  = Math.max(0, Math.floor(scrollTop / ROW_H) - BUFFER);
    const lastRow   = Math.min(numRows - 1, Math.ceil((scrollTop + viewH) / ROW_H) + BUFFER);

    // Remove rows outside range
    [...inner.children].forEach(el => {
      const r = parseInt(el.dataset.row);
      if (r < firstRow || r > lastRow) el.remove();
    });

    // Add missing rows
    const existing = new Set([...inner.children].map(el => parseInt(el.dataset.row)));
    for (let row = firstRow; row <= lastRow; row++) {
      if (existing.has(row)) continue;
      const rowEl = document.createElement('div');
      rowEl.dataset.row = row;
      rowEl.style.cssText = `position:absolute;top:${row * ROW_H}px;left:${PAD}px;right:${PAD}px;display:flex;gap:${GAP}px;`;
      for (let col = 0; col < COLS; col++) {
        const char = filtered[row * COLS + col];
        if (!char) break;
        rowEl.appendChild(createCard(char));
      }
      inner.appendChild(rowEl);
    }
  }

  // ── Card ──────────────────────────────────────────────────────────────────────
  function createCard(char) {
    const { name } = char;
    const isFav    = favorites.has(name);
    const isActive = activeChars.has(name);
    const w        = weights[name];

    const card = document.createElement('div');
    card.className = 'cs-card' + (isFav ? ' cs-fav' : '') + (isActive ? ' cs-active' : '');
    card.dataset.name = name;
    card.style.cssText = `flex:1;min-width:0;height:${CARD_H}px;`;

    card.innerHTML = `
      <div class="cs-thumb-wrap">
        <img class="cs-thumb" data-name="${esc(name)}" src="" alt="">
        <div class="cs-card-overlay">
          <div class="cs-name">${esc(name)}</div>
        </div>
        <div class="cs-weight-badge"${w ? ' style="border-color:#ff9800;opacity:1"' : ''}>${w ? w.toFixed(2) : ''}</div>
        <button class="cs-fav-btn${isFav ? ' active' : ''}" title="Favourite">★</button>
      </div>`;

    loadThumb(card.querySelector('.cs-thumb'), name);

    card.querySelector('.cs-fav-btn').addEventListener('click', e => {
      e.stopPropagation();
      toggleFav(name);
    });
    card.addEventListener('click', () => selectChar(name));
    card.addEventListener('contextmenu', e => { e.preventDefault(); showWeightPopup(name, card); });

    return card;
  }

  // ── Thumbnail loading ─────────────────────────────────────────────────────────
  async function loadThumb(img, name) {
    if (!img) return;
    if (thumbCache.has(name)) {
      const cached = thumbCache.get(name);
      if (cached) { img.src = cached; img.classList.add('loaded'); }
      else         { img.classList.add('missing'); }
      return;
    }
    try {
      const dataUrl = await window.electronAPI.charThumb(name);
      thumbCache.set(name, dataUrl);
      if (dataUrl) { img.src = dataUrl; img.classList.add('loaded'); }
      else          { img.classList.add('missing'); }
    } catch { img.classList.add('missing'); }
  }

  // ── Select / deselect ─────────────────────────────────────────────────────────
  function selectChar(name) {
    const target = (document.activeElement?.tagName === 'TEXTAREA' &&
                    document.activeElement.closest('#prompt-area'))
      ? document.activeElement
      : $('inp-positive');
    if (!target) return;

    if (activeChars.has(name)) {
      removeFromPrompt(name, target);
      return;
    }

    const w     = weights[name] ?? globalWeight;
    const extra = tagAssist[name] ? ', ' + tagAssist[name] : '';
    const tag   = Math.abs(w - 1.0) < 0.005 ? name : `(${name}:${w.toFixed(2)})`;
    const text  = tag + extra;

    const pos    = target.selectionEnd ?? target.value.length;
    const before = target.value.slice(0, pos).replace(/,\s*$/, '');
    const after  = target.value.slice(pos).replace(/^,?\s*/, '');
    target.value = before + (before ? ', ' : '') + text + (after ? ', ' + after : '');
    target.dispatchEvent(new Event('input', { bubbles: true }));
    target.focus();

    recentlyUsed = [name, ...recentlyUsed.filter(n => n !== name)].slice(0, 50);
    localStorage.setItem('cs-recent', JSON.stringify(recentlyUsed));

    syncFromPrompt();
    renderVirtual();
  }

  function removeFromPrompt(name, target) {
    const w = weights[name] ?? globalWeight;
    // Build patterns to match: "(name:w.ww)" or just "name"
    const patterns = [
      `\\(${escRe(name)}:[0-9.]+\\)`,
      escRe(name),
    ];
    let val = target.value;
    for (const pat of patterns) {
      val = val.replace(new RegExp(`(?:,\\s*)?${pat}(?:\\s*,)?`, 'gi'), m =>
        m.startsWith(',') && m.endsWith(',') ? ',' : ''
      );
    }
    target.value = val.replace(/^\s*,\s*|\s*,\s*$/g, '').replace(/,\s*,/g, ',').trim();
    target.dispatchEvent(new Event('input', { bubbles: true }));
    syncFromPrompt();
    renderVirtual();
  }

  function clearAll() {
    const target = $('inp-positive');
    if (!target) return;
    let val = target.value;
    for (const name of activeChars) {
      const patterns = [`\\(${escRe(name)}:[0-9.]+\\)`, escRe(name)];
      for (const pat of patterns) {
        val = val.replace(new RegExp(`(?:,\\s*)?${pat}(?:\\s*,)?`, 'gi'), m =>
          m.startsWith(',') && m.endsWith(',') ? ',' : ''
        );
      }
    }
    target.value = val.replace(/^\s*,\s*|\s*,\s*$/g, '').replace(/,\s*,/g, ',').trim();
    target.dispatchEvent(new Event('input', { bubbles: true }));
    syncFromPrompt();
    renderVirtual();
  }

  // ── Favourites ────────────────────────────────────────────────────────────────
  function toggleFav(name) {
    favorites.has(name) ? favorites.delete(name) : favorites.add(name);
    localStorage.setItem('cs-favs', JSON.stringify([...favorites]));
    if (sortMode === 'default' || showFavOnly) applyFilter();
    else renderVirtual();
  }

  // ── Weight popup ──────────────────────────────────────────────────────────────
  function showWeightPopup(name, anchor) {
    $('cs-weight-popup')?.remove();
    const w = weights[name] ?? globalWeight;

    const popup = document.createElement('div');
    popup.id = 'cs-weight-popup';
    popup.innerHTML = `
      <div style="font-size:11px;color:var(--muted);margin-bottom:8px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(name)}</div>
      <div style="display:flex;align-items:center;gap:8px;margin-bottom:8px">
        <input type="range" min="0.1" max="2.0" step="0.05" value="${w}" id="cs-w-sl"
               style="flex:1;accent-color:#b35c00;cursor:pointer">
        <input type="number" min="0.1" max="2.0" step="0.05" value="${w.toFixed(2)}" id="cs-w-num"
               style="width:52px;background:#111;border:1px solid #555;color:#fff;border-radius:3px;padding:3px 4px;font-size:12px">
      </div>
      <div style="display:flex;gap:6px">
        <button id="cs-w-reset"
                style="flex:1;padding:5px;background:#333;border:1px solid #555;color:#aaa;border-radius:3px;cursor:pointer;font-size:11px">
          Reset (${globalWeight.toFixed(2)})
        </button>
        <button id="cs-w-ok"
                style="flex:1;padding:5px;background:#b35c00;border:none;color:#fff;border-radius:3px;cursor:pointer;font-size:11px;font-weight:bold">
          ✓ OK
        </button>
      </div>`;

    document.body.appendChild(popup);

    const rect = anchor.getBoundingClientRect();
    const left = Math.min(rect.left, window.innerWidth  - 230);
    const top  = Math.min(rect.bottom + 4, window.innerHeight - 130);
    popup.style.cssText += `position:fixed;left:${left}px;top:${top}px;`;

    const sl  = popup.querySelector('#cs-w-sl');
    const num = popup.querySelector('#cs-w-num');
    sl.addEventListener('input',  () => { num.value = parseFloat(sl.value).toFixed(2); });
    num.addEventListener('input', () => { sl.value  = num.value; });

    popup.querySelector('#cs-w-ok').addEventListener('click', () => {
      weights[name] = parseFloat(num.value) || 1.0;
      localStorage.setItem('cs-weights', JSON.stringify(weights));
      popup.remove();
      renderVirtual();
    });
    popup.querySelector('#cs-w-reset').addEventListener('click', () => {
      delete weights[name];
      localStorage.setItem('cs-weights', JSON.stringify(weights));
      popup.remove();
      renderVirtual();
    });

    setTimeout(() => document.addEventListener('click', function close(e) {
      if (!popup.contains(e.target)) { popup.remove(); document.removeEventListener('click', close); }
    }), 10);
  }

  // ── Panel toggle ──────────────────────────────────────────────────────────────
  function toggle() {
    panelOpen = !panelOpen;
    $('cs-panel').classList.toggle('open', panelOpen);
    $('cs-toggle-btn')?.classList.toggle('active', panelOpen);
    if (panelOpen) {
      if (allChars.length === 0) init().then(() => renderVirtual());
      else setTimeout(() => renderVirtual(), 50);
    }
  }

  // ── Bind controls ─────────────────────────────────────────────────────────────
  function bindControls() {
    let debT;
    $('cs-search')?.addEventListener('input', e => {
      clearTimeout(debT);
      debT = setTimeout(() => { searchQ = e.target.value; applyFilter(); }, 150);
    });

    $('cs-fav-toggle')?.addEventListener('click', () => {
      showFavOnly = !showFavOnly;
      const btn = $('cs-fav-toggle');
      btn.style.background  = showFavOnly ? '#7a5a00' : '';
      btn.style.color       = showFavOnly ? '#ffd700' : '';
      btn.style.borderColor = showFavOnly ? '#ffd700' : '';
      applyFilter();
    });

    $('cs-active-toggle')?.addEventListener('click', () => {
      showActiveOnly = !showActiveOnly;
      const btn = $('cs-active-toggle');
      btn.style.background  = showActiveOnly ? '#003a00' : '';
      btn.style.color       = showActiveOnly ? '#00ff00' : '';
      btn.style.borderColor = showActiveOnly ? '#00cc00' : '';
      applyFilter();
    });

    $('cs-sort-sel')?.addEventListener('change', e => {
      sortMode = e.target.value;
      applyFilter();
    });

    $('cs-series-sel')?.addEventListener('change', e => {
      seriesFilter = e.target.value;
      applyFilter();
    });

    $('cs-gweight')?.addEventListener('input', e => {
      globalWeight = parseFloat(e.target.value);
      const val = $('cs-gweight-val');
      if (val) val.textContent = globalWeight.toFixed(2);
      localStorage.setItem('cs-gweight', globalWeight);
    });

    $('cs-clear-btn')?.addEventListener('click', clearAll);

    $('cs-folder-btn')?.addEventListener('click', async () => {
      const res = await window.electronAPI.configPickDataFolder();
      if (!res) return;
      if (res.error) { alert(res.error); return; }
      if (res.path) init();
    });

    $('cs-toggle-btn')?.addEventListener('click', toggle);
    $('cs-close-btn')?.addEventListener('click', () => {
      panelOpen = false;
      $('cs-panel').classList.remove('open');
      $('cs-toggle-btn')?.classList.remove('active');
    });

    $('cs-grid')?.addEventListener('scroll', renderVirtual, { passive: true });
    new ResizeObserver(() => { if (panelOpen) renderVirtual(); }).observe($('cs-panel'));

    watchPrompt();
  }

  return { init, bindControls };
})();
