// ── SwarmUI API wrapper ───────────────────────────────────────────────────────
const API = {
  host:    'localhost:7801',
  session: null,
  _ws:     null,

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

  // ── Generate via WebSocket ────────────────────────────────────────────────────
  generate(payload, { onProgress, onPreview, onImage, onDone, onError } = {}) {
    if (this._ws) { try { this._ws.close(); } catch {} }
    const ws = new WebSocket(`${this.wsOrigin}/API/GenerateText2ImageWS`);
    this._ws = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ session_id: this.session, ...payload }));
    };
    let gotError = false;
    let gotDone  = false;
    let gotImage = false;
    ws.onmessage = e => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.error) {
        gotError = true; onError?.(msg.error); ws.close(); return;
      }
      if (msg.status !== undefined) {
        const s = String(msg.status);
        if (s.toLowerCase().startsWith('error')) {
          gotError = true; onError?.(s); ws.close(); return;
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
      if (msg.image)  { gotImage = true; onImage?.(msg.image); }
      if (msg.images) {
        gotImage = true;
        const imgs = Array.isArray(msg.images) ? msg.images : Object.values(msg.images);
        imgs.forEach(i => onImage?.(i));
      }
      if (msg.done) { gotDone = true; onDone?.(); }
    };
    ws.onerror = () => { gotError = true; onError?.('WebSocket error'); };
    ws.onclose = () => {
      this._ws = null;
      if (gotError) return;
      // SwarmUI ferme le socket après msg.image sans forcément envoyer msg.done
      if (gotDone || gotImage) onDone?.();
      else onError?.('Generation failed — server closed unexpectedly');
    };
    return ws;
  },

  interrupt() {
    if (this._ws) { this._ws.close(); this._ws = null; }
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
