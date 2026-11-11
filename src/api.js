// ── SwarmUI API wrapper ───────────────────────────────────────────────────────
const API = {
  host:    'localhost:7801',
  session: null,

  get origin()   { return `http://${this.host}`; },
  get wsOrigin() { return `ws://${this.host}`; },

  // ── Session ─────────────────────────────────────────────────────────────────
  async getSession() {
    const d = await this.post('/API/GetNewSession', { session_id: '' });
    this.session = d.session_id;
    return this.session;
  },

  // ── HTTP helper ──────────────────────────────────────────────────────────────
  async post(endpoint, body) {
    const r = await fetch(`${this.origin}${endpoint}`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!r.ok) throw new Error(`${endpoint} → HTTP ${r.status}`);
    return r.json();
  },

  // ── Models ───────────────────────────────────────────────────────────────────
  async listModels(opts = {}) {
    return this.post('/API/ListModels', {
      session_id: this.session, path: '', depth: 5,
      sortBy: 'Name', allowRemote: false, sortReverse: false, dataImages: false,
      ...opts,
    });
  },

  // ── Famille d'un LoRA lue dans l'en-tête du fichier (quand SwarmUI ne le classe pas) ──
  async getModelHeaders(name, subtype = 'LoRA') {
    return this.post('/API/GetModelHeaders', { session_id: this.session, model: name, subtype });
  },

  // Renvoie l'id de famille (compat_class SwarmUI) déduit de l'en-tête safetensors, ou '' si indéterminé
  classifyLoraHeader(h) {
    if (!h || typeof h !== 'object') return '';
    const meta = h.__metadata__ || {};
    const keys = Object.keys(h).filter(k => k !== '__metadata__');
    // 1) métadonnées déclarées par l'outil d'entraînement
    const declared = `${meta['modelspec.architecture'] || ''} ${meta.ss_base_model_version || ''} ${meta.base || ''} ${meta.ss_network_module || ''}`.toLowerCase();
    if (/anima/.test(declared)) return 'anima';
    if (/krea[-_ ]?2/.test(declared)) return 'krea-2';
    // 2) noms de couches (DiT Cosmos d'Anima : blocks.N.adaln_modulation / cross_attn / self_attn)
    if (keys.some(k => /blocks[._]\d+[._](adaln_modulation|cross_attn|self_attn)/.test(k))) return 'anima';
    if (keys.some(k => /transformer[._]transformer_blocks[._]\d+[._]attn[._]to_gate/.test(k))) return 'krea-2';
    if (keys.some(k => /^blocks\.\d+\.attn\.(gate|wk)\./.test(k))) return 'krea-2';
    if (keys.some(k => /(up|down)_blocks[._]\d+[._]attentions/.test(k))) return 'stable-diffusion-xl-v1';
    return '';
  },

  // Complète compat_class des LoRA que SwarmUI n'a pas classés (ou a classés SD 1.5 par erreur).
  // Résultat mis en cache par hash du fichier : un LoRA n'est lu qu'une fois.
  async inferLoraFamilies(files) {
    const KEY = 'swarm-lora-family';
    let cache = {};
    try { cache = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch {}
    const todo = [];
    for (const f of files) {
      if (f.compat_class && f.compat_class !== 'stable-diffusion-v1') continue;
      const id = f.hash_sha256 || f.hash || f.name;
      if (id in cache) { if (cache[id]) { f.compat_class = cache[id]; f.family_from_header = true; } continue; }
      todo.push([f, id]);
    }
    let i = 0, dirty = false;
    const worker = async () => {
      while (i < todo.length) {
        const [f, id] = todo[i++];
        try {
          const r = await this.getModelHeaders(f.name);
          if (r && r.headers) {
            const fam = this.classifyLoraHeader(r.headers);
            cache[id] = fam; dirty = true;
            if (fam) { f.compat_class = fam; f.family_from_header = true; }
          }
        } catch (e) { /* droit manquant ou fichier illisible : on garde la classe d'origine */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (dirty) { try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch {} }
    return files;
  },

  async listVAEs()       { return this.listModels({ subtype: 'VAE',        depth: 5 }); },
  async listLoRAs()      { return this.listModels({ subtype: 'LoRA',        depth: 5 }); },
  async listEmbeddings() { return this.listModels({ subtype: 'Embedding',   depth: 5 }); },
  async listControlNets(){ return this.listModels({ subtype: 'ControlNet',  depth: 5 }); },

  // ── T2I params (samplers, etc.) ───────────────────────────────────────────────
  async listParams() {
    return this.post('/API/ListT2IParams', { session_id: this.session });
  },

  // ── Server status (supported feature flags) / ComfyUI node-pack install ──────
  async getStatus() {
    return this.post('/API/GetCurrentStatus', { session_id: this.session });
  },
  async installComfyFeatures(features) {
    return this.post('/API/ComfyInstallFeatures', { session_id: this.session, features });
  },

  // ── Refresh model cache on disk ───────────────────────────────────────────────
  async triggerRefresh(strong = true) {
    return this.post('/API/TriggerRefresh', { session_id: this.session, strong });
  },

  // ── Libérer la VRAM/RAM des backends SwarmUI (utile avant de générer sur Forge) ─
  async freeBackendMemory(systemRam = false) {
    if (!this.session) return null;
    return this.post('/API/FreeBackendMemory', { session_id: this.session, system_ram: systemRam, backend: 'all' });
  },

  // ── Generate via WebSocket ────────────────────────────────────────────────────
  // Each call gets its own socket: Txt2Img and Flux can generate at the same time. Closing the
  // previous socket here (old behaviour) made its onclose report a bogus "server closed
  // unexpectedly" error to the OTHER tab and reset that tab's state mid-generation.
  _sockets: new Set(),

  generate(payload, { onProgress, onPreview, onImage, onDone, onError } = {}) {
    const ws = new WebSocket(`${this.wsOrigin}/API/GenerateText2ImageWS`);
    this._sockets.add(ws);

    // Exactly one terminal callback per generation (done could fire from msg.done AND onclose)
    let finished = false;
    const finish = (err) => {
      if (finished) return;
      finished = true;
      if (err !== undefined) onError?.(err); else onDone?.();
    };

    ws.onopen = () => {
      ws.send(JSON.stringify({ session_id: this.session, ...payload }));
    };
    let gotImage = false;
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.error) {
        finish(msg.error); ws.close(); return;
      }
      if (msg.status !== undefined) {
        const s = String(msg.status);
        if (s.toLowerCase().startsWith('error')) {
          finish(s); ws.close(); return;
        }
        const pct = msg.overall_percent ?? msg.cur_overall_percent ?? 0;
        onProgress?.(s, pct);
      }
      if (msg.gen_progress) {
        const gp = msg.gen_progress;
        const pct = gp.overall_percent ?? gp.current_percent ?? 0;
        onProgress?.(gp.status || 'Generating…', pct);
        if (gp.preview) onPreview?.(gp.preview);
      }
      // msg.metadata = the image's SwarmUI metadata (JSON string): carries the real seed used
      if (msg.image)  { gotImage = true; onImage?.(msg.image, msg.metadata); }
      if (msg.images) {
        gotImage = true;
        const imgs = Array.isArray(msg.images) ? msg.images : Object.values(msg.images);
        imgs.forEach(i => onImage?.(i));
      }
      if (msg.done) finish();
    };
    ws.onerror = () => finish('WebSocket error');
    ws.onclose = () => {
      this._sockets.delete(ws);
      // Stopped (by this tab or another one — InterruptAll stops everything): end quietly, no error
      if (ws._interrupted) { finish(); return; }
      // SwarmUI ferme le socket après msg.image sans forcément envoyer msg.done
      if (gotImage) finish();
      else finish('Generation failed — server closed unexpectedly');
    };
    return ws;
  },

  interrupt() {
    this._sockets.forEach(ws => { ws._interrupted = true; try { ws.close(); } catch {} });
    this._sockets.clear();
    return this.post('/API/InterruptAll', { session_id: this.session });
  },

  // ── Presets ───────────────────────────────────────────────────────────────────
  async listPresets() {
    const d = await this.post('/API/GetMyUserData', { session_id: this.session });
    return d.presets || [];
  },

  async savePreset(title, paramMap, isEdit = false, editingTitle = null) {
    return this.post('/API/AddNewPreset', {
      session_id: this.session,
      title,
      description: '',
      param_map: paramMap,
      is_edit: isEdit,
      ...(isEdit && editingTitle ? { editing: editingTitle } : {}),
    });
  },

  async deletePreset(title) {
    return this.post('/API/DeletePreset', { session_id: this.session, preset: title });
  },
};
