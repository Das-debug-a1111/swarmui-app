// ── Forge Neo : réseau ────────────────────────────────────────────────────────
// Quand le moteur choisi est Neo, les appels « SwarmUI » de l'app (API.post et le WebSocket de
// génération) sont servis ici avec l'API de Neo, dans les mêmes formes. Les onglets n'ont donc
// pas à savoir quel moteur travaille. Les traductions pures sont dans neoengine.js.
const NeoBackend = (() => {
  const N = NeoEngine;
  const ENGINE_KEY = 'swarm-engine', OVERRIDE_KEY = 'neo-family', CACHE_KEY = 'neo-family-cache';

  const engine = () => (localStorage.getItem(ENGINE_KEY) === 'neo' ? 'neo' : 'swarm');
  const setEngine = e => localStorage.setItem(ENGINE_KEY, e === 'neo' ? 'neo' : 'swarm');
  const active = () => engine() === 'neo';

  function url() {
    const saved = localStorage.getItem('forge-url');
    const field = document.getElementById('inp-forge-url')?.value;
    return (saved || field || '').trim().replace(/\/$/, '');
  }

  async function call(path, body, timeoutMs = 60000) {
    const base = url();
    if (!base) throw new Error('Adresse de Forge Neo manquante.');
    let r;
    try {
      r = await fetch(base + path, {
        ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }),
        ...(timeoutMs ? { signal: AbortSignal.timeout(timeoutMs) } : {}),
      });
    } catch (e) {
      throw new Error(`Forge Neo injoignable (connexion coupée) : ${e.message}`);
    }
    const data = await r.json().catch(() => null);
    if (!r.ok) {
      const detail = data?.errors || data?.message || (typeof data?.detail === 'string' ? data.detail : data?.error);
      throw new Error(`Neo : ${detail || 'HTTP ' + r.status}`);
    }
    return data;
  }

  // ── Familles de modèles ───────────────────────────────────────────────────
  const read = key => { try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); } catch {} };
  const famKey = (kind, name) => `${kind}:${N.stem(name).toLowerCase()}`;

  // Pendant que SwarmUI est le moteur, on retient ce qu'il dit des fichiers : Neo ne le dit pas
  function learn(subtype, files) {
    const cache = read(CACHE_KEY);
    const kind = subtype === 'LoRA' ? 'lora' : 'model';
    for (const f of files || []) {
      if (f.compat_class) cache[famKey(kind, f.name)] = { family: f.compat_class, architecture: f.architecture || '' };
    }
    write(CACHE_KEY, cache);
  }

  function familyInfo(kind, name, metadata) {
    const forced = kind === 'model' ? read(OVERRIDE_KEY)[N.stem(name).toLowerCase()] : null;
    const known = read(CACHE_KEY)[famKey(kind, name)];
    const family = forced || known?.family || N.guessFamily(name, metadata);
    const architecture = (!forced && known?.architecture) || N.guessArchitecture(name, family);
    return { family, architecture };
  }

  function setModelFamily(name, family) {
    const all = read(OVERRIDE_KEY), k = N.stem(name).toLowerCase();
    if (family) all[k] = family; else delete all[k];
    write(OVERRIDE_KEY, all);
  }

  // ── Listes ────────────────────────────────────────────────────────────────
  async function listModels({ subtype } = {}) {
    if (subtype === 'LoRA') {
      const loras = await call('/sdapi/v1/loras');
      return loras.map(l => {
        const name = N.relativeName(l.path, 'Lora', 'LyCORIS');
        const { family } = familyInfo('lora', name, l.metadata);
        return { name, title: N.stem(name), compat_class: family, hash: l.metadata?.sshs_model_hash || '', trigger_phrase: l.metadata?.['modelspec.trigger_phrase'] || '' };
      });
    }
    if (subtype === 'VAE') {
      const modules = await call('/sdapi/v1/sd-modules');
      return modules.filter(m => /[\\/]VAE[\\/]/i.test(m.filename))
        .map(m => { const name = N.relativeName(m.filename, 'VAE'); return { name, title: N.stem(name) }; });
    }
    if (subtype === 'ControlNet') {
      const d = await call('/controlnet/model_list');
      return (d.model_list || []).filter(n => n !== 'None').map(n => ({ name: n, title: n, compat_class: N.guessFamily(n) }));
    }
    if (subtype === 'Embedding') {
      const d = await call('/sdapi/v1/embeddings');
      return Object.keys(d.loaded || {}).map(n => ({ name: n, title: n }));
    }
    if (subtype && subtype !== 'Stable-Diffusion') return [];
    const models = await call('/sdapi/v1/sd-models');
    return models.map(m => {
      const name = N.relativeName(m.filename, 'StableDiffusion', 'Stable-diffusion', 'diffusion_models') === m.filename.split(/[\\/]/).pop()
        ? m.title.replace(/\s*\[[0-9a-f]+\]\s*$/i, '').replace(/\\/g, '/')
        : N.relativeName(m.filename, 'StableDiffusion', 'Stable-diffusion');
      const info = familyInfo('model', name);
      return { name, title: name.replace(/\.(safetensors|ckpt|gguf)$/i, ''), compat_class: info.family, architecture: info.architecture };
    });
  }

  async function listParams() {
    const [samplers, schedulers, upscalers, modules] = await Promise.all([
      call('/sdapi/v1/samplers'), call('/sdapi/v1/schedulers'), call('/sdapi/v1/upscalers'),
      call('/controlnet/module_list').catch(() => ({ module_list: ['None'] })),
    ]);
    const param = (id, values, def, names) => ({ id, name: id, values, default: def, neo_names: names });
    const ups = upscalers.map(u => u.name).filter(n => !/^(none|lanczos|nearest)$/i.test(n));
    const sched = schedulers.filter(s => s.name !== 'automatic');
    return {
      list: [
        param('sampler', samplers.map(N.samplerId), 'euler', samplers.map(s => s.name)),
        param('scheduler', sched.map(s => s.name), 'simple', sched.map(s => s.label || s.name)),
        param('refinerupscalemethod', ['pixel-lanczos', 'pixel-nearest-exact', ...ups.map(n => `model-${n}.pth`)], 'pixel-lanczos',
          ['Lanczos', 'Nearest', ...ups]),
        param('controlnetpreprocessor', modules.module_list || ['None'], 'None'),
      ],
      groups: [],
    };
  }

  // Réponses aux routes SwarmUI utilisées par l'app
  async function handle(endpoint, body = {}) {
    switch (endpoint) {
      case '/API/GetNewSession':
        await call('/sdapi/v1/samplers', undefined, 8000);   // Neo répond-il ?
        return { session_id: 'neo' };
      case '/API/ListModels': return { files: await listModels(body), folders: [] };
      case '/API/ListT2IParams': return listParams();
      case '/API/GetCurrentStatus':
        return { status: { live_gens: running.size, waiting_gens: 0 }, backend_status: { status: 'running', any_loading: false }, supported_features: [] };
      case '/API/TriggerRefresh':
        await Promise.all(['refresh-checkpoints', 'refresh-vae', 'refresh-loras'].map(r => call(`/sdapi/v1/${r}`, {}).catch(() => {})));
        return { success: true };
      case '/API/GetModelHeaders': {
        const hit = (await call('/sdapi/v1/loras')).find(l => l.name === N.stem(body.model));
        return { headers: { __metadata__: hit?.metadata || {} } };
      }
      case '/API/GetMyUserData': return { presets: [] };
      case '/API/InterruptAll': stopAll(); return { success: true };
      default: return { error: `Fonction non disponible avec Forge Neo (${endpoint}).` };
    }
  }

  // Pour l'Inpaint, qui construit lui-même sa requête : réglages à ajouter à override_settings
  async function moduleSettings(modelName) {
    const family = familyInfo('model', modelName).family;
    const modules = N.modulesFor(modelName, family, await call('/sdapi/v1/sd-modules'));
    return modules ? { forge_additional_modules: modules } : {};
  }

  // ── Mémoire vidéo : un seul moteur garde ses modèles chargés ──────────────
  // Avant une génération SwarmUI : Neo rend sa mémoire, sauf s'il est en train de travailler
  async function releaseMemory() {
    try {
      if (!url() || running.size) return;
      const pr = await call('/sdapi/v1/progress?skip_current_image=true', undefined, 1500);
      if (pr?.state?.job_count > 0) return;
      await call('/sdapi/v1/unload-checkpoint', {}, 20000);
    } catch { /* Neo éteint : rien à libérer */ }
  }

  // Avant une génération Neo : même chose côté SwarmUI, s'il tourne et ne fait rien
  async function freeSwarm() {
    try {
      const post = (path, body) => fetch(`${API.origin}${path}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(4000),
      }).then(r => r.json());
      const { session_id } = await post('/API/GetNewSession', {});
      const st = (await post('/API/GetCurrentStatus', { session_id }))?.status;
      if (st && (st.live_gens > 0 || st.waiting_gens > 0)) return;
      await post('/API/FreeBackendMemory', { session_id, system_ram: false, backend: 'all' });
    } catch { /* SwarmUI éteint */ }
  }

  // ── Images ────────────────────────────────────────────────────────────────
  const fromBase64 = b64 => Uint8Array.from(atob(b64), c => c.charCodeAt(0));

  function toDataUrl(bytes) {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/png;base64,${btoa(bin)}`;
  }

  // L'image est gardée sur ce Mac et désignée par une adresse courte : Production, la file et les
  // grilles ne peuvent pas ranger une image entière.
  async function keepImage(bytes) {
    if (window.electronAPI?.neoSaveImage) {
      const saved = await window.electronAPI.neoSaveImage(bytes);
      if (saved?.url) return saved.url;
      throw new Error(saved?.error || 'Image non enregistrée');
    }
    return toDataUrl(bytes);
  }

  // Images d'entrée : Neo ne sait pas lire les adresses de l'app, il faut lui envoyer les données
  async function asDataUrl(value) {
    if (!value || String(value).startsWith('data:')) return value;
    const blob = await (await fetch(value)).blob();
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error('Image d\'entrée illisible'));
      reader.readAsDataURL(blob);
    });
  }

  async function inlineImages(payload) {
    const p = { ...payload };
    const isRef = v => typeof v === 'string' && /^(neoimg|https?|blob|file):/.test(v);
    for (const k of ['initimage', 'maskimage', 'controlnetimageinput']) if (isRef(p[k])) p[k] = await asDataUrl(p[k]);
    if (p.promptimages) p.promptimages = (await Promise.all(String(p.promptimages).split('|').filter(Boolean).map(v => (isRef(v) ? asDataUrl(v) : v)))).join('|');
    return p;
  }

  // ── Génération ────────────────────────────────────────────────────────────
  const running = new Set();
  let queue = Promise.resolve();   // Neo traite une demande à la fois : l'app attend son tour

  async function context(payload) {
    const names = ['sd-models', 'sd-modules', 'samplers', 'schedulers', 'upscalers', 'loras'];
    const [models, modules, samplers, schedulers, upscalers, loras] = await Promise.all(names.map(n => call(`/sdapi/v1/${n}`)));
    const controlnets = payload.controlnetimageinput ? (await call('/controlnet/model_list')).model_list : [];
    return { family: familyInfo('model', payload.model || '').family, models, modules, samplers, schedulers, upscalers, loras, controlnets };
  }

  // Masque blanc sur le rectangle d'une zone, à la taille de l'image
  function zoneMask(width, height, zone) {
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    const g = c.getContext('2d');
    g.fillStyle = '#000';
    g.fillRect(0, 0, width, height);
    g.fillStyle = '#fff';
    g.fillRect(Math.round(zone.x * width), Math.round(zone.y * height), Math.round(zone.w * width), Math.round(zone.h * height));
    return c.toDataURL('image/png');
  }

  const pngSize = bytes => {
    const v = new DataView(bytes.buffer, bytes.byteOffset);
    return [v.getUint32(16), v.getUint32(20)];
  };

  // Une demande à Neo, avec l'avancement entre « from » et « from + span » de la barre
  async function send(job, req, seed, emit, label, from, span) {
    let busy = false;
    let poll = setInterval(async () => {
      if (busy || job.stopped) return;
      busy = true;
      try {
        const pr = await call('/sdapi/v1/progress', undefined, 5000);
        if (poll && !job.stopped && pr?.state?.job_count > 0) {
          emit({ gen_progress: {
            status: label,
            overall_percent: from + span * Math.min(1, pr.progress || 0),
            ...(pr.current_image ? { preview: `data:image/png;base64,${pr.current_image}` } : {}),
          } });
        }
      } catch { /* un sondage raté n'arrête pas la génération */ }
      busy = false;
    }, 700);
    try {
      const res = await call(`/sdapi/v1/${req.route}`, { ...req.body, seed }, 0);
      // Avec ControlNet, Neo peut ajouter l'image du préprocesseur après le résultat : on garde la première
      const b64 = res?.images?.[0];
      if (!b64 && !job.stopped) throw new Error('Neo n’a renvoyé aucune image (voir sa console).');
      let infotext = '';
      try { infotext = JSON.parse(res.info).infotexts?.[0] || ''; } catch {}
      return { b64, infotext };
    } finally {
      clearInterval(poll);
      poll = null;
    }
  }

  async function runGeneration(job, payload, emit) {
    emit({ status: 'Préparation de Neo…', overall_percent: 0 });
    const full = await inlineImages(payload);
    const { base, regions } = N.splitRegions(full.prompt);
    const ctx = await context(full);
    const req = N.buildRequest({ ...full, prompt: base, ...(regions.length ? { donotsave: true } : {}) }, ctx);
    if (req.ignored.length && typeof toast === 'function') toast(`Ignoré avec Neo : ${req.ignored.join(', ')}`, 6000);
    if (regions.length && typeof toast === 'function') toast('Zones : repeintes une par une après l’image (rendu différent de SwarmUI).', 6000);
    await freeSwarm();

    const passes = 1 + regions.length;
    for (let i = 0; i < req.count && !job.stopped; i++) {
      const label = req.count > 1 ? `Neo ${i + 1}/${req.count}` : 'Neo';
      const seed = req.seed + i;
      const span = 1 / (req.count * passes);
      emit({ gen_progress: { status: `${label} : chargement…`, overall_percent: i / req.count } });
      let result = await send(job, req, seed, emit, label, i / req.count, span);
      for (let z = 0; z < regions.length && !job.stopped; z++) {
        const zone = regions[z];
        const [width, height] = pngSize(fromBase64(result.b64));
        const { controlnetimageinput, refinerupscale, promptimages, ...rest } = full;
        const pass = N.buildRequest({
          ...rest,
          // les LoRA restent dans le prompt de base, repris à chaque passe
          prompt: `${zone.prompt}, ${base}`,
          width, height,
          images: 1,
          initimage: `data:image/png;base64,${result.b64}`,
          maskimage: zoneMask(width, height, zone),
          initimagecreativity: zone.denoise,
          maskblur: 16,
          donotsave: z < regions.length - 1 || !!full.donotsave,
        }, ctx);
        // Neo travaille sur la zone seule, agrandie : son contenu apparaît bien mieux qu'en repeignant toute l'image
        Object.assign(pass.body, { inpaint_full_res: true, inpaint_full_res_padding: 64 });
        result = await send(job, pass, seed, emit, `${label} : zone ${z + 1}/${regions.length}`, i / req.count + span * (z + 1), span);
      }
      if (job.stopped) return;
      const metadata = JSON.stringify(N.swarmMetadata(payload, seed, result.infotext));
      const image = await keepImage(N.setPngParameters(fromBase64(result.b64), metadata));
      emit({ image, metadata });
    }
  }

  function stopAll() {
    if (!running.size) return;
    running.forEach(job => job.stop());
  }

  // Se comporte comme le WebSocket GenerateText2ImageWS de SwarmUI
  function socket() {
    const job = { stopped: false, started: false };
    const ws = { readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null };
    let closed = false;
    const closeNow = () => {
      if (closed) return;
      closed = true;
      ws.readyState = 3;
      running.delete(job);
      setTimeout(() => ws.onclose?.({}), 0);
    };
    const emit = msg => { if (!closed && !job.stopped) ws.onmessage?.({ data: JSON.stringify(msg) }); };

    job.stop = () => {
      if (job.stopped) return;
      job.stopped = true;
      if (job.started) call('/sdapi/v1/interrupt', {}, 5000).catch(() => {});
      closeNow();
    };
    ws.close = () => { if (!closed) job.stop(); };
    ws.send = data => {
      const payload = JSON.parse(data);
      running.add(job);
      if (running.size > 1) emit({ status: 'En attente de Neo…', overall_percent: 0 });
      queue = queue.then(async () => {
        if (job.stopped) return;
        job.started = true;
        try {
          await runGeneration(job, payload, emit);
          job.started = false;
          emit({ done: true });
        } catch (e) {
          job.started = false;   // fermer le canal ne doit plus interrompre Neo
          emit({ error: e.message });
        } finally {
          closeNow();
        }
      });
    };
    setTimeout(() => { if (!closed) { ws.readyState = 1; ws.onopen?.({}); } }, 0);
    return ws;
  }

  return { engine, setEngine, active, url, call, handle, socket, learn, familyInfo, setModelFamily, moduleSettings, releaseMemory, freeSwarm, stopAll };
})();
