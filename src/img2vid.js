// ── Img2Vid (ComfyUI / UmeAiRT WAN 2.2 I2V) ──────────────────────────────────

const Img2Vid = (() => {
  const $ = id => document.getElementById(id);

  let initImageData   = null;   // base64 data URL
  let generating      = false;
  let currentVideoUrl = null;
  let _inited         = false;
  let _setupOk        = false;  // true once models are verified

  // HuggingFace base URL for UmeAiRT model assets
  const HF_BASE = 'https://huggingface.co/UmeAiRT/ComfyUI-Auto-Installer-Assets/resolve/main/models';

  // Required WAN 2.2 I2V models — hfPath = path in the HF repo & dest relative to models folder
  const REQUIRED_MODELS = [
    {
      type: 'diffusion_models',
      file: 'WAN/Wan2.2-I2V-HighNoise-14B-Q4_K_S.gguf',
      label: 'WAN I2V High-Noise 14B (GGUF Q4)',
      size: '~8.7 GB',
    },
    {
      type: 'diffusion_models',
      file: 'WAN/Wan2.2-I2V-LowNoise-14B-Q4_K_S.gguf',
      label: 'WAN I2V Low-Noise 14B (GGUF Q4)',
      size: '~8.7 GB',
    },
    {
      type: 'text_encoders',
      file: 'umt5-xxl-encoder-Q4_K_S.gguf',
      label: 'UMT5 XXL Text Encoder (GGUF Q4)',
      size: '~2.8 GB',
    },
    {
      type: 'vae',
      file: 'wan_2.1_vae.safetensors',
      label: 'WAN 2.1 VAE',
      size: '~433 MB',
    },
    {
      type: 'clip_vision',
      file: 'open-clip-xlm-roberta-large-vit-huge-14_visual_fp16.safetensors',
      label: 'OpenCLIP ViT-H-14 (clip_vision)',
      size: '~1.9 GB',
    },
  ];

  // True only when ComfyUI is on the same machine as this Electron app
  function isLocalServer() {
    const host = (API.host || '').split(':')[0];
    return host === 'localhost' || host === '127.0.0.1' || host === '::1';
  }

  // Can we write directly to the filesystem? (Electron + local server)
  const hasElectronDownload = typeof window.electronAPI?.downloadModel === 'function';
  function canDownload() { return hasElectronDownload && isLocalServer(); }

  // Persisted settings
  let modelsPath   = localStorage.getItem('i2v-models-path') || '';
  let remoteWinPath = localStorage.getItem('i2v-remote-models-path') || 'C:\\path\\to\\ComfyUI\\models';

  // Track active downloads { destPath → { pct, done, error } }
  let _downloads   = {};
  let _downloading = false;

  // ── Init ──────────────────────────────────────────────────────────────────────
  function init() {
    if (_inited) return;
    _inited = true;
    bindDropZone();
    bindSliders();
    bindControls();
  }

  // ── Called when tab becomes active ────────────────────────────────────────────
  async function onShow() {
    init();
    await checkSetup();
  }

  // ── ComfyUI helpers ───────────────────────────────────────────────────────────
  function comfyOrigin() { return `http://${API.host}`; }
  function comfyWs()     { return `ws://${API.host}`; }

  async function comfyGet(path) {
    const r = await fetch(`${comfyOrigin()}/ComfyBackendDirect${path}`);
    if (!r.ok) throw new Error(`ComfyUI GET ${path} → ${r.status}`);
    return r.json();
  }

  async function comfyPost(path, body) {
    const r = await fetch(`${comfyOrigin()}/ComfyBackendDirect${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => '');
      throw new Error(`ComfyUI POST ${path} → ${r.status}: ${txt}`);
    }
    return r.json();
  }

  // ── Setup check ───────────────────────────────────────────────────────────────
  async function checkSetup() {
    const panel = $('i2v-setup-panel');
    const main  = $('i2v-main');
    if (!panel || !main) return;

    // Show a transient "checking…" state
    if ($('i2v-setup-body')) $('i2v-setup-body').innerHTML = '⏳ Checking models…';
    panel.style.display = 'flex';
    main.style.display  = 'none';

    try {
      // Probe ComfyUI models endpoint — skip object_info (SwarmUI blocks it)
      // Collect missing models by checking each type folder
      const missing = [];
      let comfyReachable = false;

      for (const m of REQUIRED_MODELS) {
        try {
          const list = await comfyGet(`/models/${m.type}`);
          comfyReachable = true;
          const found = Array.isArray(list) && list.some(f => {
            const name = (typeof f === 'string' ? f : (f.name || String(f)));
            return name.replace(/\\/g, '/').toLowerCase()
                       .endsWith(m.file.replace(/\\/g, '/').toLowerCase());
          });
          if (!found) missing.push(m);
        } catch {
          // If the endpoint itself throws, mark model as missing
          missing.push(m);
        }
      }

      if (!comfyReachable) {
        throw new Error('Cannot reach ComfyUI via /ComfyBackendDirect/. Make sure SwarmUI is connected and ComfyUI is running.');
      }

      if (missing.length > 0) {
        _setupOk = false;
        showSetupPanel(missing);
      } else {
        _setupOk = true;
        panel.style.display = 'none';
        main.style.display  = 'flex';
        $('i2v-gen-btn').disabled = !initImageData;
      }
    } catch (err) {
      _setupOk = false;
      showSetupPanel(null, err.message);
    }
  }

  function showSetupPanel(missingModels, errorMsg) {
    const panel = $('i2v-setup-panel');
    const main  = $('i2v-main');
    if (!panel) return;

    panel.style.display = 'flex';
    if (main) main.style.display = 'none';

    const body = $('i2v-setup-body');
    if (!body) return;

    if (errorMsg) {
      body.innerHTML = `
        <div class="i2v-setup-error">
          <span>❌</span><p>${errorMsg}</p>
          <p style="margin-top:6px;font-size:11px;color:var(--muted)">
            Make sure SwarmUI is connected and ComfyUI is running.
          </p>
        </div>`;
      return;
    }

    const missing = missingModels || [];
    const local   = canDownload();

    if (local) {
      renderLocalPanel(missing, body);
    } else {
      renderRemotePanel(missing, body);
    }
  }

  // ── Local panel (same machine) ────────────────────────────────────────────────
  function renderLocalPanel(missing, body) {
    const allDone = missing.length > 0 && missing.every(m => _downloads[destPathFor(m)]?.done);

    const rows = missing.map(m => {
      const key    = rowKey(m);
      const dlInfo = _downloads[destPathFor(m)] || {};
      const btnLbl = dlInfo.done ? '✓ Done' : dlInfo.error ? '⚠ Retry'
                   : dlInfo.pct !== undefined ? `${dlInfo.pct}%` : '⬇ Download';
      return `
        <div class="i2v-model-row" id="i2v-row-${key}">
          <div class="i2v-model-info">
            <span class="i2v-model-missing">${dlInfo.done ? '✓' : '✗'}</span>
            <span class="i2v-model-label">${m.label}</span>
            <span class="i2v-model-size">${m.size}</span>
          </div>
          <div class="i2v-model-actions">
            <button class="btn-secondary i2v-dl-btn" data-type="${m.type}" data-file="${m.file}"
              id="i2v-btn-${key}" ${!modelsPath || _downloading || dlInfo.done ? 'disabled' : ''}>${btnLbl}</button>
          </div>
          <div class="i2v-dl-progress" id="i2v-prog-${key}"
               style="display:${dlInfo.pct !== undefined && !dlInfo.done ? 'flex' : 'none'}">
            <div class="i2v-dl-bar-track">
              <div class="i2v-dl-bar" id="i2v-bar-${key}" style="width:${dlInfo.pct||0}%"></div>
            </div>
            <span class="i2v-dl-pct" id="i2v-pct-${key}">${dlInfo.pct != null ? dlInfo.pct+'%' : ''}</span>
          </div>
        </div>`;
    }).join('');

    const totalSize = formatBytes(missing.reduce((s, m) => s + estBytes(m.size), 0));

    body.innerHTML = `
      <div class="i2v-folder-row">
        <span class="i2v-folder-label">📁 ComfyUI models folder</span>
        <div class="i2v-folder-input-wrap">
          <input type="text" id="i2v-folder-input" class="i2v-folder-input"
            value="${modelsPath}" placeholder="Select your ComfyUI/models folder…" readonly>
          <button id="i2v-folder-browse" class="btn-secondary" style="flex-shrink:0">Browse…</button>
        </div>
      </div>
      <p style="margin:8px 0;font-size:12px;color:var(--text2)">
        Models required for WAN 2.2 I2V:
      </p>
      <div class="i2v-model-list">${rows}</div>
      ${modelsPath && missing.length > 0 && !allDone ? `
        <div style="margin-top:10px;display:flex;justify-content:flex-end">
          <button class="btn-secondary" id="i2v-dl-all-btn" ${_downloading ? 'disabled' : ''}>
            ⬇ Download all (${totalSize})
          </button>
        </div>` : ''}
      ${allDone ? `<p style="margin-top:10px;color:var(--green);font-size:12px">
        ✅ All downloaded — click Re-check to continue.</p>` : ''}
    `;

    $('i2v-folder-browse')?.addEventListener('click', async () => {
      const chosen = await window.electronAPI.pickModelsFolder();
      if (!chosen) return;
      modelsPath = chosen;
      localStorage.setItem('i2v-models-path', chosen);
      showSetupPanel(missing);
    });

    body.querySelectorAll('.i2v-dl-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const m = missing.find(x => x.type === btn.dataset.type && x.file === btn.dataset.file);
        if (m) startDownload(m, missing);
      });
    });

    $('i2v-dl-all-btn')?.addEventListener('click', () => downloadAll(missing));
  }

  // ── Remote panel (server on another machine) ──────────────────────────────────
  function renderRemotePanel(missing, body) {
    const host = API.host.split(':')[0];

    // Build PowerShell script lines
    const psLines = [
      `# WAN 2.2 I2V — Download script for ComfyUI on ${host}`,
      `# Run this in PowerShell on the machine where ComfyUI is installed`,
      ``,
      `$base = "${remoteWinPath}"`,
      `$hf   = "${HF_BASE}"`,
      ``,
      ...missing.flatMap(m => {
        const fname  = m.file.split('/').pop();
        const subdir = m.file.includes('/') ? m.file.split('/').slice(0, -1).join('\\') : '';
        const dir    = subdir ? `$base\\${m.type}\\${subdir}` : `$base\\${m.type}`;
        return [
          `# ${m.label} (${m.size})`,
          `New-Item -ItemType Directory -Force "${dir}"`,
          `curl.exe -L --progress-bar -o "${dir}\\${fname}" "$hf/${m.type}/${fname}"`,
          ``,
        ];
      }),
    ].join('\n');

    const rows = missing.map(m => `
      <div class="i2v-model-row">
        <div class="i2v-model-info">
          <span class="i2v-model-missing">✗</span>
          <span class="i2v-model-label">${m.label}</span>
          <span class="i2v-model-size">${m.size}</span>
        </div>
      </div>`).join('');

    body.innerHTML = `
      <div class="i2v-remote-notice">
        🖥 <strong>Remote server detected</strong> (${host})<br>
        <span style="color:var(--muted);font-size:11px">
          Models must be downloaded directly on the server machine.
        </span>
      </div>

      <p style="margin:10px 0 6px;font-size:12px;color:var(--text2)">Models required:</p>
      <div class="i2v-model-list">${rows}</div>

      <div class="i2v-folder-row" style="margin-top:12px">
        <span class="i2v-folder-label">📁 ComfyUI models path on the server</span>
        <div class="i2v-folder-input-wrap">
          <input type="text" id="i2v-remote-path" class="i2v-folder-input"
            value="${remoteWinPath}" placeholder="C:\\path\\to\\ComfyUI\\models" style="cursor:text">
          <button id="i2v-remote-update" class="btn-secondary" style="flex-shrink:0">Update</button>
        </div>
      </div>

      <div style="margin-top:10px">
        <div style="font-size:11px;color:var(--muted);margin-bottom:4px;display:flex;justify-content:space-between;align-items:center">
          <span>📋 PowerShell script — paste &amp; run on the server</span>
          <button id="i2v-copy-script" class="btn-secondary" style="font-size:11px;padding:2px 8px">Copy</button>
        </div>
        <textarea id="i2v-ps-script" class="i2v-script-box" readonly>${psLines}</textarea>
      </div>
    `;

    // Update path button
    $('i2v-remote-update')?.addEventListener('click', () => {
      const val = $('i2v-remote-path')?.value.trim();
      if (!val) return;
      remoteWinPath = val;
      localStorage.setItem('i2v-remote-models-path', val);
      showSetupPanel(missing); // re-render script
    });

    // Allow direct edit + enter
    $('i2v-remote-path')?.addEventListener('keydown', e => {
      if (e.key === 'Enter') $('i2v-remote-update')?.click();
    });
    $('i2v-remote-path') && ($('i2v-remote-path').style.cursor = 'text');
    $('i2v-remote-path')?.removeAttribute('readonly');

    // Copy script
    $('i2v-copy-script')?.addEventListener('click', () => {
      navigator.clipboard.writeText(psLines).then(() => {
        const btn = $('i2v-copy-script');
        if (btn) { btn.textContent = '✓ Copied!'; setTimeout(() => btn.textContent = 'Copy', 2000); }
      });
    });
  }

  // ── Download helpers ──────────────────────────────────────────────────────────
  function rowKey(m) {
    return (m.type + '_' + m.file).replace(/[^a-z0-9]/gi, '_');
  }

  function destPathFor(m) {
    if (!modelsPath) return '';
    const sep = window.electronAPI?.platform === 'win32' ? '\\' : '/';
    const parts = m.file.split('/');
    return [modelsPath, m.type, ...parts].join(sep);
  }

  function formatBytes(bytes) {
    if (bytes >= 1e9) return (bytes / 1e9).toFixed(1) + ' GB';
    if (bytes >= 1e6) return (bytes / 1e6).toFixed(0) + ' MB';
    return bytes + ' B';
  }

  function estBytes(sizeStr) {
    const m = sizeStr.match(/([\d.]+)\s*(GB|MB|KB)/i);
    if (!m) return 0;
    const v = parseFloat(m[1]);
    const u = m[2].toUpperCase();
    return u === 'GB' ? v * 1e9 : u === 'MB' ? v * 1e6 : v * 1e3;
  }

  async function startDownload(model, allMissing) {
    if (_downloading || !modelsPath) return;
    _downloading = true;

    const dest = destPathFor(model);
    const url  = `${HF_BASE}/${model.type}/${model.file.split('/').pop()}`;

    window.electronAPI.removeModelProgress();
    window.electronAPI.onModelProgress(({ destPath, pct, totalBytes, downloadedBytes }) => {
      const entry = _downloads[destPath];
      if (!entry) return;
      entry.pct = pct >= 0 ? pct : Math.round((downloadedBytes / totalBytes) * 100);
      refreshModelRowLocal(destPath);
    });

    _downloads[dest] = { pct: 0, done: false };
    showSetupPanel(allMissing);

    try {
      await window.electronAPI.downloadModel(url, dest);
      _downloads[dest].done = true;
      _downloads[dest].pct  = 100;
    } catch (err) {
      _downloads[dest].error = true;
      _downloads[dest].pct   = undefined;
      console.error('[Img2Vid] Download failed:', err);
    } finally {
      _downloading = false;
      showSetupPanel(allMissing);
      window.electronAPI.removeModelProgress();
    }
  }

  async function downloadAll(allMissing) {
    for (const m of allMissing) {
      if (_downloads[destPathFor(m)]?.done) continue;
      await startDownload(m, allMissing);
    }
    const allDone = allMissing.every(m => _downloads[destPathFor(m)]?.done);
    if (allDone) setTimeout(() => checkSetup(), 600);
  }

  function refreshModelRowLocal(destPath) {
    const model = REQUIRED_MODELS.find(m => destPathFor(m) === destPath);
    if (!model) return;
    const key    = rowKey(model);
    const dlInfo = _downloads[destPath] || {};
    const btn    = $(`i2v-btn-${key}`);
    const prog   = $(`i2v-prog-${key}`);
    const bar    = $(`i2v-bar-${key}`);
    const pct    = $(`i2v-pct-${key}`);
    if (btn)  btn.textContent = dlInfo.done ? '✓ Done' : dlInfo.error ? '⚠ Retry' : `${dlInfo.pct ?? 0}%`;
    if (prog) prog.style.display = dlInfo.pct != null && !dlInfo.done ? 'flex' : 'none';
    if (bar)  bar.style.width = (dlInfo.pct || 0) + '%';
    if (pct)  pct.textContent = dlInfo.pct != null ? dlInfo.pct + '%' : '';
  }

  function refreshModelRow(destPath) {
    refreshModelRowLocal(destPath);  // alias kept for compatibility

    const dlId  = 'i2v-dl-' + model.type.replace(/_/g, '') + '-' + model.file.replace(/[^a-z0-9]/gi, '');
    const btn   = $(dlId + '-btn');
    const wrap  = $('i2v-bar-' + dlId.slice(6) + '-wrap');
    const bar   = $('i2v-bar-' + dlId.slice(6));
    const pctEl = $('i2v-pct-' + dlId.slice(6));

    if (btn) btn.textContent = dlInfo.done ? '✓ Done' : dlInfo.error ? '⚠ Retry' : `${dlInfo.pct ?? 0}%`;
    if (wrap) wrap.style.display = dlInfo.pct !== undefined && !dlInfo.done ? 'flex' : 'none';
    if (bar)  bar.style.width = (dlInfo.pct || 0) + '%';
    if (pctEl) pctEl.textContent = dlInfo.pct !== undefined ? dlInfo.pct + '%' : '';
  }

  // ── Drop zone ─────────────────────────────────────────────────────────────────
  function bindDropZone() {
    const dropZone  = $('i2v-drop-zone');
    const fileInput = $('i2v-file-input');
    const dropBtn   = $('i2v-drop-btn');
    const clearBtn  = $('i2v-clear-btn');
    const view      = $('view-img2vid');

    dropBtn?.addEventListener('click', () => fileInput?.click());
    fileInput?.addEventListener('change', e => {
      if (e.target.files[0]) loadFile(e.target.files[0]);
    });
    clearBtn?.addEventListener('click', clearImage);

    dropZone?.addEventListener('dragover', e => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });
    dropZone?.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone?.addEventListener('drop', e => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      const file = e.dataTransfer.files[0];
      if (file && file.type.startsWith('image/')) loadFile(file);
    });

    view?.addEventListener('paste', e => {
      const item = [...(e.clipboardData?.items || [])].find(i => i.type.startsWith('image/'));
      if (item) loadFile(item.getAsFile());
    });
  }

  function loadFile(file) {
    const reader = new FileReader();
    reader.onload = e => setImage(e.target.result);
    reader.readAsDataURL(file);
  }

  function setImage(dataUrl) {
    initImageData = dataUrl;
    const img = $('i2v-preview-img');
    if (img) img.src = dataUrl;
    $('i2v-thumb-sec')?.style && ($('i2v-thumb-sec').style.display = '');
    $('i2v-drop-zone')?.style && ($('i2v-drop-zone').style.display = 'none');
    updateGenBtn();
  }

  function clearImage() {
    initImageData = null;
    const img = $('i2v-preview-img');
    if (img) img.src = '';
    if ($('i2v-thumb-sec')) $('i2v-thumb-sec').style.display = 'none';
    if ($('i2v-drop-zone')) $('i2v-drop-zone').style.display = 'flex';
    if ($('i2v-file-input')) $('i2v-file-input').value = '';
    updateGenBtn();
  }

  function updateGenBtn() {
    const btn = $('i2v-gen-btn');
    if (btn) btn.disabled = !initImageData || generating || !_setupOk;
  }

  // ── Sliders ───────────────────────────────────────────────────────────────────
  function bindSliders() {
    [
      ['i2v-steps', 'i2v-steps-val'],
      ['i2v-cfg',   'i2v-cfg-val'  ],
      ['i2v-dur',   'i2v-dur-val'  ],
    ].forEach(([slId, lblId]) => {
      const sl = $(slId), lbl = $(lblId);
      if (sl && lbl) {
        lbl.textContent = sl.value;
        sl.addEventListener('input', () => lbl.textContent = sl.value);
      }
    });
  }

  // ── Speed mode toggle ─────────────────────────────────────────────────────────
  function bindControls() {
    // Seed reset
    $('i2v-seed-reset')?.addEventListener('click', () => {
      if ($('i2v-seed')) $('i2v-seed').value = -1;
    });

    // Speed mode toggle
    $('i2v-speed-toggle')?.addEventListener('change', e => {
      const stepsGroup = $('i2v-steps-group');
      if (stepsGroup) stepsGroup.style.opacity = e.target.checked ? '0.4' : '1';
    });

    // Generate
    $('i2v-gen-btn')?.addEventListener('click', generate);

    // Download
    $('i2v-download-btn')?.addEventListener('click', () => {
      if (!currentVideoUrl) return;
      const a = document.createElement('a');
      a.href = currentVideoUrl;
      a.download = `wan_i2v_${Date.now()}.mp4`;
      a.click();
    });

    // Retry setup check
    $('i2v-setup-retry')?.addEventListener('click', checkSetup);
  }

  // ── Image upload to ComfyUI ───────────────────────────────────────────────────
  async function uploadImage(dataUrl) {
    // Convert base64 dataUrl to Blob
    const res  = await fetch(dataUrl);
    const blob = await res.blob();
    const ext  = blob.type.split('/')[1] || 'jpg';
    const fname = `swarmapp_${Date.now()}.${ext}`;

    const form = new FormData();
    form.append('image', blob, fname);
    form.append('type', 'input');
    form.append('overwrite', 'true');

    const r = await fetch(`${comfyOrigin()}/ComfyBackendDirect/upload/image`, {
      method: 'POST',
      body: form,
    });
    if (!r.ok) throw new Error(`Image upload failed: ${r.status}`);
    const data = await r.json();
    return data.name || fname;
  }

  // ── Build ComfyUI prompt ──────────────────────────────────────────────────────
  function buildPrompt(params) {
    const { positive, negative, width, height, duration, steps, cfg, fps,
            sampler, scheduler, seed, imageFilename, speedMode } = params;

    const nodes = {};

    // 1 — BundleLoader
    nodes['1'] = {
      class_type: 'UmeAiRT_BundleLoader',
      inputs: { model_type: 'WAN_2.2/I2V', quant_type: 'GGUF_Q4' },
    };

    let bundleSource = '1';

    if (speedMode) {
      // 2 — LightningAccelerator
      nodes['2'] = {
        class_type: 'UmeAiRT_VideoLightningAccelerator',
        inputs: {
          model_bundle:       ['1', 0],
          acceleration_steps: '4 Steps',
          guidance_scale:     1,
          sampler_name:       'euler',
          scheduler:          'sgm_uniform',
        },
      };
      bundleSource = '2';
    }

    // 3 — VideoOptimization
    nodes['3'] = {
      class_type: 'UmeAiRT_VideoOptimization',
      inputs: {
        model_bundle:       [bundleSource, 0],
        cfg_correction:     0,
        enable_optimization: true,
      },
    };

    // 4 — Positive prompt
    nodes['4'] = {
      class_type: 'UmeAiRT_Positive_Input',
      inputs: { text: positive || 'Slow and small movements.' },
    };

    // 5 — Negative prompt
    nodes['5'] = {
      class_type: 'UmeAiRT_Negative_Input',
      inputs: {
        text: negative ||
          'fast movements, blurry, static, low quality, worst quality, watermark, text',
      },
    };

    // 6 — VideoSettings
    const actualSteps = speedMode ? 4 : steps;
    nodes['6'] = {
      class_type: 'UmeAiRT_VideoSettings',
      inputs: {
        width,
        height,
        duration,
        steps:                   actualSteps,
        cfg,
        fps,
        sampler_name:            sampler,
        scheduler,
        seed,
        control_after_generate: seed === -1 ? 'randomize' : 'fixed',
      },
    };

    // 7 — LoadImage
    nodes['7'] = {
      class_type: 'LoadImage',
      inputs: { image: imageFilename, upload: 'image' },
    };

    // 8 — VideoGenerator
    nodes['8'] = {
      class_type: 'UmeAiRT_VideoGenerator',
      inputs: {
        model_bundle:  ['3', 0],
        positive:      ['4', 0],
        video_settings:['6', 0],
        negative:      ['5', 0],
        source_image:  ['7', 0],
      },
    };

    // 9 — VideoOutput
    nodes['9'] = {
      class_type: 'UmeAiRT_VideoOutput',
      inputs: {
        video_pipe:       ['8', 0],
        filename_prefix:  'SwarmApp/WAN_%seed',
        format:           'mp4',
        quality:          'Visually Lossless',
        save_preview:     true,
        merge_with_audio: false,
      },
    };

    return nodes;
  }

  // ── Generate ──────────────────────────────────────────────────────────────────
  async function generate() {
    if (generating || !initImageData) return;
    generating = true;

    const btn    = $('i2v-gen-btn');
    const status = $('i2v-status');
    const pbar   = $('i2v-pbar');

    btn.disabled    = true;
    btn.textContent = '⏳ Generating…';
    setStatus('Uploading image…', 0);

    try {
      // 1. Upload image to ComfyUI
      const imageFilename = await uploadImage(initImageData);
      setStatus('Queuing…', 2);

      // 2. Gather params
      const [w, h]   = ($('i2v-resolution')?.value || '832x480').split('x').map(Number);
      const duration = parseInt($('i2v-dur')?.value)   || 3;
      const steps    = parseInt($('i2v-steps')?.value) || 20;
      const cfg      = parseFloat($('i2v-cfg')?.value) || 6;
      const fps      = parseInt($('i2v-fps')?.value)   || 6;
      const sampler  = $('i2v-sampler')?.value         || 'euler';
      const sched    = $('i2v-scheduler')?.value       || 'simple';
      const seed     = parseInt($('i2v-seed')?.value)  || -1;
      const speedMode= $('i2v-speed-toggle')?.checked  || false;
      const positive = $('i2v-prompt')?.value.trim()   || '';
      const negative = $('i2v-neg')?.value.trim()      || '';

      const prompt = buildPrompt({
        positive, negative,
        width: w, height: h,
        duration, steps, cfg, fps,
        sampler, scheduler: sched,
        seed, imageFilename, speedMode,
      });

      // 3. Generate client ID and submit prompt
      const clientId = crypto.randomUUID();
      const res = await comfyPost('/prompt', { prompt, client_id: clientId });
      const promptId = res.prompt_id;
      if (!promptId) throw new Error('No prompt_id returned from ComfyUI');

      setStatus('Queued…', 3);

      // 4. Monitor via WebSocket
      await monitorExecution(clientId, promptId, (pct, msg) => {
        setStatus(msg, pct);
      });

      // 5. Get output video URL from history
      const videoUrl = await getVideoFromHistory(promptId);
      if (videoUrl) {
        showOutput(videoUrl);
        setStatus('✅ Done!', 100);
      } else {
        setStatus('⚠ Done, but no video found in output.', 100);
      }

    } catch (err) {
      console.error('[Img2Vid] generate error:', err);
      setStatus('❌ ' + err.message, 0);
    } finally {
      generating = false;
      if (btn) {
        btn.disabled    = false;
        btn.textContent = '▶ Generate';
      }
    }
  }

  // ── Monitor ComfyUI WebSocket ─────────────────────────────────────────────────
  function monitorExecution(clientId, promptId, onProgress) {
    return new Promise((resolve, reject) => {
      const wsUrl = `${comfyWs()}/ComfyBackendDirect/ws?clientId=${clientId}`;
      const ws = new WebSocket(wsUrl);
      let settled = false;

      const done = (fn) => {
        if (settled) return;
        settled = true;
        ws.close();
        fn();
      };

      // Timeout after 20 minutes
      const timeout = setTimeout(() => done(() => reject(new Error('Timeout after 20min'))), 20 * 60 * 1000);

      ws.onmessage = e => {
        let msg;
        try { msg = JSON.parse(e.data); } catch { return; }

        const { type, data } = msg;
        if (!data || data.prompt_id !== promptId) return;

        if (type === 'progress') {
          const pct = data.max ? Math.round((data.value / data.max) * 95) + 3 : 50;
          onProgress(pct, `Step ${data.value} / ${data.max}`);
        }

        if (type === 'executing') {
          if (data.node === null) {
            // null node = execution complete
            clearTimeout(timeout);
            done(resolve);
          } else {
            onProgress(null, `Running node ${data.node}…`);
          }
        }

        if (type === 'execution_success') {
          clearTimeout(timeout);
          done(resolve);
        }

        if (type === 'execution_error') {
          clearTimeout(timeout);
          done(() => reject(new Error(data.exception_message || 'Execution error')));
        }
      };

      ws.onerror = () => {
        clearTimeout(timeout);
        done(() => reject(new Error('WebSocket connection error')));
      };

      ws.onclose = () => {
        clearTimeout(timeout);
        done(resolve); // treat close as done if not already settled
      };
    });
  }

  // ── Get video URL from ComfyUI history ────────────────────────────────────────
  async function getVideoFromHistory(promptId) {
    try {
      const history = await comfyGet(`/history/${promptId}`);
      const entry = history[promptId];
      if (!entry?.outputs) return null;

      // Look through all node outputs for video files
      for (const nodeOutputs of Object.values(entry.outputs)) {
        // Check gifs (ComfyUI uses this key for videos too)
        const vids = nodeOutputs.gifs || nodeOutputs.videos || [];
        for (const v of vids) {
          if (v.filename) {
            const subfolder = v.subfolder ? encodeURIComponent(v.subfolder) + '/' : '';
            return `${comfyOrigin()}/ComfyBackendDirect/view?filename=${encodeURIComponent(v.filename)}&subfolder=${encodeURIComponent(v.subfolder || '')}&type=output`;
          }
        }
        // Fallback: check images list for mp4 type
        const imgs = nodeOutputs.images || [];
        for (const im of imgs) {
          if (im.filename?.endsWith('.mp4')) {
            return `${comfyOrigin()}/ComfyBackendDirect/view?filename=${encodeURIComponent(im.filename)}&subfolder=${encodeURIComponent(im.subfolder || '')}&type=output`;
          }
        }
      }
    } catch (err) {
      console.warn('[Img2Vid] history fetch failed:', err);
    }
    return null;
  }

  // ── Show output video ─────────────────────────────────────────────────────────
  function showOutput(url) {
    currentVideoUrl = url;
    const video = $('i2v-output-video');
    const placeholder = $('i2v-output-placeholder');
    const actions = $('i2v-video-actions');

    if (video) {
      video.src = url;
      video.style.display = '';
      video.load();
      video.play().catch(() => {});
    }
    if (placeholder) placeholder.style.display = 'none';
    if (actions) actions.style.display = 'flex';
  }

  // ── Status helper ─────────────────────────────────────────────────────────────
  function setStatus(msg, pct) {
    const status = $('i2v-status');
    const pbar   = $('i2v-pbar');
    if (status && msg !== null) status.textContent = msg;
    if (pbar   && pct !== null) pbar.style.width = Math.max(0, Math.min(100, pct)) + '%';
  }

  // ── Public: receive image from other tabs ─────────────────────────────────────
  function receiveImage(dataUrl) {
    init();
    setImage(dataUrl);
  }

  // onConnect called by app.js loadAll — nothing to load from SwarmUI for Img2Vid
  function onConnect() {}

  return { init, onShow, onConnect, receiveImage };
})();
