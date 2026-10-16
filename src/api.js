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
