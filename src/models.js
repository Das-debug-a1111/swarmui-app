// ── CivitAI Model Downloader ──────────────────────────────────────────────────
const ModelDL = (() => {

  const DOMAINS = {
    sfw:  'https://civitai.com',
    nsfw: 'https://civitai.red',
  };
  let _domain = 'sfw'; // 'sfw' | 'nsfw'

  function civitaiBase() { return `${DOMAINS[_domain]}/api/v1`; }
  function civitaiHost() { return _domain === 'sfw' ? 'civitai.com' : 'civitai.red'; }
  function apiKeyStorageKey() { return `civitai-api-key-${civitaiHost()}`; }

  // CivitAI model type → ComfyUI/SwarmUI subfolder
  const TYPE_FOLDER = {
    'Checkpoint':        'checkpoints',
    'LORA':              'loras',
    'LoCon':             'loras',
    'DoRA':              'loras',
    'Lycoris':           'loras',
    'TextualInversion':  'embeddings',
    'Embedding':         'embeddings',
    'VAE':               'vae',
    'ControlNet':        'controlnet',
    'Upscaler':          'upscale_models',
    'Hypernetwork':      'hypernetworks',
    'AestheticGradient': 'embeddings',
    'Poses':             'poses',
    'Wildcards':         'wildcards',
    'Other':             'other',
  };

  // ── State ────────────────────────────────────────────────────────────────────
  let _model        = null;   // current full model object
  let _version      = null;   // current selected version
  let _searching    = false;
  let _searchPage   = 1;      // used when no query (page-based)
  let _searchCursor = null;   // used when query present (cursor-based)
  let _inited       = false;

  const q = id => document.getElementById(id);

  // ── Config helpers ───────────────────────────────────────────────────────────
  function getApiKey()   { return q('mdl-api-key')?.value.trim() || ''; }
  function getBasePath() { return q('mdl-base-path')?.value.trim() || ''; }

  function isLocal() {
    if (typeof API === 'undefined') return true;
    const h = (API.host || '').split(':')[0];
    return h === 'localhost' || h === '127.0.0.1' || h === '::1';
  }

  function setStatus(msg, type = '') {
    const el = q('mdl-status');
    if (!el) return;
    el.textContent = msg;
    el.className = 'mdl-status' + (type ? ` mdl-status-${type}` : '');
  }

  // ── URL / ID parsing ─────────────────────────────────────────────────────────
  function parseCivitaiUrl(raw) {
    const url = raw.trim();
    // Direct model-version download URL (either domain)
    const dlMatch = url.match(/civitai\.(?:com|red)\/api\/download\/models\/(\d+)/);
    if (dlMatch) return { modelVersionId: dlMatch[1], modelId: null };
    // Model page: civitai.com/models/12345 or civitai.red/models/12345
    const modelMatch = url.match(/civitai\.(?:com|red)\/models\/(\d+)/);
    if (!modelMatch) return null;
    const versionMatch = url.match(/[?&]modelVersionId=(\d+)/);
    return { modelId: modelMatch[1], modelVersionId: versionMatch?.[1] || null };
  }

  // ── CivitAI API ──────────────────────────────────────────────────────────────
  function authHeaders() {
    const k = getApiKey();
    return k ? { 'Authorization': `Bearer ${k}` } : {};
  }

  async function apiGet(path) {
    const url  = `${civitaiBase()}${path}`;
    const resp = await fetch(url, { headers: authHeaders() });
    if (!resp.ok) {
      let detail = '';
      try { const b = await resp.json(); detail = b.message || b.error || JSON.stringify(b); } catch {}
      console.error(`[CivitAI] ${resp.status} on ${url}\n`, detail);
      if (resp.status === 400 || resp.status === 401 || resp.status === 403) {
        const key = getApiKey();
        const hint = detail ? ` (${detail})` : '';
        throw new Error(
          key
            ? `CivitAI ${resp.status} — clé API invalide ou expirée${hint}`
            : `CivitAI ${resp.status} — entre ta clé API CivitAI${hint}`
        );
      }
      throw new Error(`CivitAI ${resp.status}: ${resp.statusText}`);
    }
    return resp.json();
  }

  async function fetchModelById(modelId) {
    return apiGet(`/models/${modelId}`);
  }

  async function fetchVersionById(versionId) {
    return apiGet(`/model-versions/${versionId}`);
  }

  async function searchModels(query, type, bases, sort, page, cursor) {
    const enc   = encodeURIComponent;
    const parts = [`limit=20`];
    if (sort) parts.push(`sort=${enc(sort)}`);

    if (query) {
      parts.push(`query=${enc(query)}`);
      if (cursor) parts.push(`cursor=${enc(cursor)}`);
    } else {
      if (cursor) parts.push(`cursor=${enc(cursor)}`);
      else        parts.push(`page=${page}`);
    }

    if (type && type !== 'all') parts.push(`types=${enc(type)}`);
    (bases || []).forEach(b => parts.push(`baseModels=${enc(b)}`));
    return apiGet(`/models?${parts.join('&')}`);
  }

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function fmtSize(kb) {
    if (!kb) return '?';
    const gb = kb / 1024 / 1024;
    return gb >= 1 ? gb.toFixed(2) + ' GB' : (kb / 1024).toFixed(0) + ' MB';
  }

  function fmtNum(n) {
    if (!n) return '0';
    return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n);
  }

  function esc(s) {
    return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function subfolder(type) {
    return TYPE_FOLDER[type] || 'other';
  }

  function destPath(file, type) {
    const base = getBasePath();
    const sep  = window.electronAPI?.platform === 'win32' ? '\\' : '/';
    const sub  = subfolder(type);
    return [base, sub, file.name].join(sep);
  }

  // ── Model card ───────────────────────────────────────────────────────────────
  function renderCard(model, version) {
    _model   = model;
    _version = version;

    const card = q('mdl-card');
    if (!card) return;

    const sub     = subfolder(model.type);
    const primary = version.files?.find(f => f.primary) ?? version.files?.[0];

    // Preview images (max 5, blur nsfw)
    const previews = (version.images || []).slice(0, 5).map(img =>
      `<img src="${img.url}" class="mdl-prev-img${img.nsfwLevel > 1 ? ' mdl-blur' : ''}"
            loading="lazy" alt="">`
    ).join('');

    // Version dropdown
    const versionOpts = (model.modelVersions || []).map(v =>
      `<option value="${v.id}"${v.id === version.id ? ' selected' : ''}>${esc(v.name)}</option>`
    ).join('');

    // Files list
    const filesHtml = (version.files || []).map(f =>
      `<div class="mdl-file-row${f.primary ? ' primary' : ''}">
        <span class="mdl-file-name">${esc(f.name)}</span>
        <span class="mdl-file-size">${fmtSize(f.sizeKB)}</span>
        <span class="mdl-file-meta">${f.metadata?.fp || ''} ${f.metadata?.size || ''}</span>
        <button class="mdl-file-dl-btn" data-file-id="${f.id}">⬇</button>
      </div>`
    ).join('');

    // Actions
    const dlBtns = isLocal()
      ? `<button class="btn-primary mdl-btn-dl" id="mdl-btn-dl" ${!primary ? 'disabled' : ''}>
           ⬇ Download${primary ? ' — ' + fmtSize(primary.sizeKB) : ''}
         </button>`
      : `<button class="btn-secondary mdl-btn-script" id="mdl-btn-script">📋 Copy PowerShell</button>`;

    card.innerHTML = `
      <div class="mdl-card-previews">${previews || '<div class="mdl-no-preview">🖼 No preview</div>'}</div>

      <div class="mdl-card-body">
        <div class="mdl-card-title">${esc(model.name)}</div>
        <div class="mdl-card-meta">
          <span class="mdl-type-badge">${esc(model.type)}</span>
          <span class="mdl-creator">by ${esc(model.creator?.username || '?')}</span>
          <span class="mdl-card-stats">⬇ ${fmtNum(model.stats?.downloadCount)} &nbsp;♥ ${fmtNum(model.stats?.favoriteCount)}</span>
        </div>
        <div class="mdl-tags">${(model.tags || []).slice(0, 8).map(t => `<span class="mdl-tag">${esc(t)}</span>`).join('')}</div>

        <div class="mdl-version-row">
          <label class="mdl-lbl">Version</label>
          <select id="mdl-ver-sel" class="mdl-sel">${versionOpts}</select>
        </div>

        <div class="mdl-dest-info">
          <span class="mdl-lbl">Dossier auto-détecté</span>
          <code class="mdl-dest-code">${esc(sub)}/</code>
        </div>

        <div class="mdl-files-list">${filesHtml}</div>

        <div class="mdl-card-actions">${dlBtns}</div>

        <div id="mdl-prog-wrap" class="mdl-prog-wrap" style="display:none">
          <div class="mdl-prog-track"><div class="mdl-prog-bar" id="mdl-prog-bar"></div></div>
          <span id="mdl-prog-label">0%</span>
        </div>
      </div>`;

    card.style.display = '';

    // Version switch
    q('mdl-ver-sel')?.addEventListener('change', e => {
      const vid = +e.target.value;
      const v = (model.modelVersions || []).find(x => x.id === vid);
      if (v) renderCard(model, v);
    });

    // Per-file download
    card.querySelectorAll('.mdl-file-dl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const fid  = +btn.dataset.fileId;
        const file = version.files.find(f => f.id === fid);
        if (file) isLocal() ? downloadFile(file, model.type) : copyScript(file, model);
      });
    });

    // Main action
    q('mdl-btn-dl')?.addEventListener('click', () => {
      if (primary) downloadFile(primary, model.type);
    });
    q('mdl-btn-script')?.addEventListener('click', () => {
      if (primary) copyScript(primary, model);
    });
  }

  // ── Download (local Electron) ─────────────────────────────────────────────────
  async function downloadFile(file, modelType) {
    const base = getBasePath();
    if (!base) { setStatus('⚠ Configure le dossier models en haut', 'error'); return; }

    const apiKey = getApiKey();
    const url    = `${file.downloadUrl}${apiKey ? '?token=' + encodeURIComponent(apiKey) : ''}`;
    const dest   = destPath(file, modelType);

    const progWrap = q('mdl-prog-wrap');
    const bar      = q('mdl-prog-bar');
    const lbl      = q('mdl-prog-label');
    if (progWrap) progWrap.style.display = '';
    if (bar) bar.style.width = '0%';
    if (lbl) lbl.textContent = '0%';

    setStatus(`Downloading ${file.name}…`);
    q('mdl-btn-dl') && (q('mdl-btn-dl').disabled = true);

    try {
      window.electronAPI.onModelProgress(d => {
        if (d.destPath !== dest) return;
        const p = d.pct >= 0 ? d.pct : 50;
        if (bar) bar.style.width = p + '%';
        if (lbl) lbl.textContent = d.pct >= 0
          ? d.pct + '%'
          : Math.round(d.downloadedBytes / 1024 / 1024) + ' MB';
      });

      await window.electronAPI.downloadModel(url, dest);
      if (bar) bar.style.width = '100%';
      if (lbl) lbl.textContent = '100%';
      setStatus(`✅ ${file.name} téléchargé dans ${subfolder(modelType)}/`, 'success');
    } catch (e) {
      if (e.message?.includes('aborted') || e.name === 'AbortError') {
        setStatus('⛔ Annulé', '');
      } else {
        setStatus(`❌ ${e.message}`, 'error');
      }
    } finally {
      window.electronAPI.removeModelProgress();
      q('mdl-btn-dl') && (q('mdl-btn-dl').disabled = false);
    }
  }

  // ── PowerShell script (remote) ────────────────────────────────────────────────
  function copyScript(file, model) {
    const apiKey  = getApiKey();
    const base    = getBasePath() || 'D:\\path\\to\\ComfyUI\\models';
    const sub     = subfolder(model.type);
    const winBase = base.replace(/\//g, '\\');
    const url     = `${file.downloadUrl}${apiKey ? '?token=' + apiKey : ''}`;

    const script = [
      `# ${model.name} — ${_version?.name || ''}`,
      `# Type: ${model.type}  →  ${sub}\\`,
      `$base = "${winBase}"`,
      `$dest = "$base\\${sub}\\${file.name}"`,
      `New-Item -ItemType Directory -Force (Split-Path $dest) | Out-Null`,
      `curl.exe -L --progress-bar -o $dest "${url}"`,
    ].join('\n');

    navigator.clipboard.writeText(script).then(() => {
      setStatus('📋 Script copié — colle-le dans PowerShell sur le serveur', 'success');
    }).catch(() => {
      // Fallback: show in a textarea
      const ta = document.createElement('textarea');
      ta.value = script;
      ta.style.cssText = 'position:fixed;top:20px;left:50%;transform:translateX(-50%);width:600px;height:200px;z-index:9999;font-family:monospace;font-size:11px';
      document.body.appendChild(ta);
      ta.select();
      setTimeout(() => ta.remove(), 15000);
    });
  }

  // ── Fetch by URL ─────────────────────────────────────────────────────────────
  async function fetchByUrl() {
    const raw = q('mdl-url-input')?.value.trim();
    if (!raw) return;

    const parsed = parseCivitaiUrl(raw);
    if (!parsed) { setStatus('⚠ URL CivitAI invalide', 'error'); return; }

    const card = q('mdl-card');
    if (card) card.style.display = 'none';
    setStatus('Fetching…');

    try {
      let model, version;

      if (parsed.modelVersionId && !parsed.modelId) {
        // Direct version URL — fetch version first, then model
        version = await fetchVersionById(parsed.modelVersionId);
        model   = await fetchModelById(version.modelId);
        version = model.modelVersions.find(v => v.id === +parsed.modelVersionId) || model.modelVersions[0];
      } else {
        model   = await fetchModelById(parsed.modelId);
        version = parsed.modelVersionId
          ? (model.modelVersions.find(v => v.id === +parsed.modelVersionId) || model.modelVersions[0])
          : model.modelVersions[0];
      }

      setStatus('');
      renderCard(model, version);
    } catch (e) {
      setStatus(`❌ ${e.message}`, 'error');
    }
  }

  // ── Search ───────────────────────────────────────────────────────────────────
  function getSearchType() {
    return document.querySelector('.mdl-type-pill.active')?.dataset.type || 'all';
  }

  function getSelectedBases() {
    return [...document.querySelectorAll('.mdl-base-pill.active')].map(b => b.dataset.base);
  }

  async function doSearch(append = false) {
    if (_searching) return;
    _searching = true;

    const query = q('mdl-search-input')?.value.trim() || '';
    const type  = getSearchType();
    const bases = getSelectedBases();
    const sort  = q('mdl-search-sort')?.value  || 'Most Downloaded';

    if (!append) {
      _searchPage   = 1;
      _searchCursor = null;
      q('mdl-results').innerHTML = '';
      q('mdl-card').style.display = 'none';
    }

    setStatus('Searching…');
    try {
      const data  = await searchModels(query, type, bases, sort, _searchPage, _searchCursor);
      const items = data.items || [];
      const meta  = data.metadata || {};

      // Update pagination state for "load more"
      _searchCursor = meta.nextCursor ?? null;
      if (_searchCursor) {
        // cursor received — use it regardless of whether query is set
      } else if (!query) {
        _searchPage++;
      }

      const hasMore = _searchCursor != null || (!query && items.length >= 20);
      renderResults(items, append, meta.totalCount, hasMore);
      setStatus(items.length ? '' : 'No results');
    } catch (e) {
      setStatus(`❌ ${e.message}`, 'error');
    } finally {
      _searching = false;
    }
  }

  function renderResults(items, append, total, hasMore) {
    const grid = q('mdl-results');
    if (!append) grid.innerHTML = '';

    // Remove old "load more"
    grid.querySelector('.mdl-load-more')?.remove();

    items.forEach(model => {
      const ver = model.modelVersions?.[0];
      const img = ver?.images?.[0];
      const sub = subfolder(model.type);

      const card = document.createElement('div');
      card.className = 'mdl-result-card';
      card.innerHTML = `
        ${img
          ? `<img src="${img.url}" class="mdl-result-img${img.nsfwLevel > 1 ? ' mdl-blur' : ''}" loading="lazy">`
          : '<div class="mdl-result-no-img">📦</div>'}
        <div class="mdl-result-name">${esc(model.name)}</div>
        <div class="mdl-result-foot">
          <span class="mdl-type-badge mdl-type-sm">${esc(model.type)}</span>
          <span class="mdl-result-dl">⬇ ${fmtNum(model.stats?.downloadCount)}</span>
        </div>`;

      card.addEventListener('click', () => {
        document.querySelectorAll('.mdl-result-card').forEach(c => c.classList.remove('selected'));
        card.classList.add('selected');
        if (ver) renderCard(model, ver);
      });

      grid.appendChild(card);
    });

    // Load more — show if there are more results (cursor or full page)
    const showLoadMore = hasMore !== undefined ? hasMore : items.length >= 20;
    if (showLoadMore) {
      const btn = document.createElement('button');
      btn.className   = 'mdl-load-more btn-secondary';
      btn.textContent = `Load more${total ? ` (${fmtNum(total)} total)` : ''}`;
      btn.addEventListener('click', () => doSearch(true));
      grid.appendChild(btn);
    }
  }

  // ── Subtab switching ─────────────────────────────────────────────────────────
  function showSubtab(name) {
    ['url', 'search'].forEach(t => {
      q(`mdl-${t}-pane`).style.display = t === name ? '' : 'none';
      q(`mdl-sub-${t}`)?.classList.toggle('active', t === name);
    });
    if (name === 'search' && !q('mdl-results').children.length) doSearch();
  }

  // ── Init ─────────────────────────────────────────────────────────────────────
  function init() {
    if (_inited) return;
    _inited = true;

    // Restore saved config
    const savedPath = localStorage.getItem('mdl-base-path');
    if (savedPath && q('mdl-base-path')) q('mdl-base-path').value = savedPath;

    function loadDomainKey() {
      const saved = localStorage.getItem(apiKeyStorageKey()) || '';
      if (q('mdl-api-key')) q('mdl-api-key').value = saved;
    }
    loadDomainKey();

    // Persist key on change (per-domain)
    q('mdl-api-key')?.addEventListener('change', () =>
      localStorage.setItem(apiKeyStorageKey(), getApiKey()));

    // Domain toggle
    const domainBtn = q('mdl-domain-toggle');
    if (domainBtn) {
      domainBtn.addEventListener('click', () => {
        _domain = _domain === 'sfw' ? 'nsfw' : 'sfw';
        domainBtn.textContent = civitaiHost();
        domainBtn.classList.toggle('mdl-domain-nsfw', _domain === 'nsfw');
        loadDomainKey();
        // Reset search state and re-run if search pane is active
        _searchPage   = 1;
        _searchCursor = null;
        if (q('mdl-results')) q('mdl-results').innerHTML = '';
        if (q('mdl-card'))    q('mdl-card').style.display = 'none';
        if (q('mdl-search-pane')?.style.display !== 'none') doSearch();
      });
    }
    q('mdl-base-path')?.addEventListener('change', () =>
      localStorage.setItem('mdl-base-path', getBasePath()));

    // Browse folder (local only)
    q('mdl-browse-btn')?.addEventListener('click', async () => {
      const path = await window.electronAPI?.pickModelsFolder?.();
      if (path) {
        q('mdl-base-path').value = path;
        localStorage.setItem('mdl-base-path', path);
      }
    });
    // Hide browse button if remote
    if (!isLocal() && q('mdl-browse-btn')) q('mdl-browse-btn').style.display = 'none';

    // Fetch by URL
    q('mdl-fetch-btn')?.addEventListener('click', fetchByUrl);
    q('mdl-url-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') fetchByUrl(); });
    // Auto-fetch on paste
    q('mdl-url-input')?.addEventListener('paste', () => setTimeout(fetchByUrl, 60));

    // Search
    q('mdl-search-btn')?.addEventListener('click',  () => doSearch());
    q('mdl-search-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });
    q('mdl-search-sort')?.addEventListener('change',  () => doSearch());

    // Type pills (single-select)
    document.querySelectorAll('.mdl-type-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.mdl-type-pill').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        doSearch();
      });
    });

    // Base model pills (multi-select — toggle)
    document.querySelectorAll('.mdl-base-pill').forEach(btn => {
      btn.addEventListener('click', () => {
        btn.classList.toggle('active');
        doSearch();
      });
    });

    // Subtabs
    q('mdl-sub-url')?.addEventListener('click',    () => showSubtab('url'));
    q('mdl-sub-search')?.addEventListener('click', () => showSubtab('search'));
  }

  function onShow() {
    init();
  }

  return { init, onShow };
})();
