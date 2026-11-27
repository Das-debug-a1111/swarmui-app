// ── Forge Neo : traductions (logique pure, testée par test/neoengine.test.js) ──
// L'app construit toujours ses requêtes au format SwarmUI ; ce module les traduit pour
// l'API de Neo, devine la famille des modèles et réécrit les métadonnées des images.
// Le réseau est dans neobackend.js.
const NeoEngine = (() => {
  // Fichiers à charger à côté du modèle, selon sa famille (compat_class de SwarmUI)
  const FAMILY_MODULES = {
    'anima':                  ['qwen_image_vae', 'qwen_3_06b_base'],
    'krea-2':                 ['qwen_image_vae', 'qwen3vl_4b'],
    'qwen-image':             ['qwen_image_vae', ['qwen_2.5_vl_7b', 'qwen_2.5_vl_7b_fp8_scaled']],
    'flux-1':                 ['ae', 'clip_l', ['t5xxl_fp16', 't5xxl_fp8_e4m3fn', 't5xxl']],
    'flux-2':                 [['flux2-vae', 'full_encoder_small_decoder'], ['qwen_3_4b', 'qwen_3_8b']],
    'stable-diffusion-xl-v1': [],
    'stable-diffusion-v1':    [],
  };
  const FAMILIES = Object.keys(FAMILY_MODULES);

  // Réglages SwarmUI traduits ; tout autre réglage de la requête est signalé comme ignoré
  const KNOWN = new Set([
    'session_id', 'prompt', 'negativeprompt', 'images', 'model', 'vae', 'width', 'height', 'steps', 'cfgscale',
    'sampler', 'scheduler', 'seed', 'sigmashift', 'fluxguidancescale', 'loras', 'loraweights',
    'refinermodel', 'refinermethod', 'refinerupscale', 'refinercontrolpercentage',
    'refinerupscalemethod', 'refinersteps', 'refinercfgscale', 'hiresmode', 'hiressampler', 'hiresscheduler', 'neoscripts',
    'controlnetimageinput', 'controlnetstrength', 'controlnetstart', 'controlnetend', 'controlnetmodel', 'controlnetpreprocessor', 'controlnetuniontype',
    'initimage', 'maskimage', 'initimagecreativity', 'maskgrowamount', 'maskblur', 'promptimages', 'donotsave',
  ]);
  // Valeurs par défaut internes à SwarmUI, toujours présentes : sans effet ici, pas d'avertissement
  const SILENT = new Set(['debugregionalprompting', 'regionalobjectcleanupfactor', 'maskcompositeunthresholded', 'gligenmodel']);

  const stem = s => String(s || '').replace(/\s*\[[0-9a-f]+\]\s*$/i, '').replace(/\\/g, '/')
    .split('/').pop().replace(/\.(safetensors|ckpt|pt|pth|gguf)$/i, '');
  const norm = s => String(s || '').toLowerCase().replace(/^(k_|sample_)/, '').replace(/[^a-z0-9+]/g, '');
  const same = (a, b) => stem(a).toLowerCase() === stem(b).toLowerCase();

  // Nom de fichier relatif au dossier des modèles, comme SwarmUI les nomme
  function relativeName(path, ...roots) {
    const p = String(path || '').replace(/\\/g, '/');
    for (const root of roots) {
      const m = p.match(new RegExp(`/${root}/(.*)$`, 'i'));
      if (m) return m[1];
    }
    return p.split('/').pop();
  }

  // Famille d'un modèle quand SwarmUI ne l'a pas dite : métadonnées du fichier, puis son nom
  function guessFamily(name, metadata) {
    const meta = `${metadata?.['modelspec.architecture'] || ''} ${metadata?.ss_base_model_version || ''}`.toLowerCase();
    // « ss_base_model_version » prime : certains LoRA Anima s'annoncent « stable-diffusion-v1 »
    if (/anima/.test(meta)) return 'anima';
    if (/krea/.test(meta)) return 'krea-2';
    if (/qwen/.test(meta)) return 'qwen-image';
    if (/flux[-_.]?2/.test(meta)) return 'flux-2';
    if (/flux/.test(meta)) return 'flux-1';
    if (/sdxl|stable-diffusion-xl/.test(meta)) return 'stable-diffusion-xl-v1';
    if (/stable-diffusion-v1|sd_v1/.test(meta)) return 'stable-diffusion-v1';
    const n = stem(name);
    if (/anima/i.test(n)) return 'anima';
    if (/krea/i.test(n)) return 'krea-2';
    if (/qwen/i.test(n)) return 'qwen-image';
    if (/flux[-_. ]?2|klein/i.test(n)) return 'flux-2';
    if (/flux|kontext/i.test(n)) return 'flux-1';
    if (/illustrious|illust|noob|pony|sdxl|xl(?![a-z])/i.test(n)) return 'stable-diffusion-xl-v1';
    return '';
  }

  // Architecture telle que l'onglet Edit la lit pour reconnaître les modèles d'édition
  function guessArchitecture(name, family) {
    const n = stem(name).toLowerCase();
    if (family === 'qwen-image' && /edit/.test(n)) return 'qwen-image-edit-plus';
    if (family === 'flux-1' && /kontext/.test(n)) return 'flux.1-kontext';
    if (family === 'flux-2') return /klein/.test(n) ? 'flux.2-klein' : 'flux.2';
    return family;
  }

  // Noms de samplers de SwarmUI (ceux des presets) pour les noms affichés par Neo
  const SAMPLER_IDS = {
    'Euler': 'euler', 'Euler a': 'euler_ancestral', 'ER SDE': 'er_sde', 'DPM++ 2M': 'dpmpp_2m', 'DPM++ SDE': 'dpmpp_sde',
    'DPM++ 2M SDE': 'dpmpp_2m_sde', 'DPM++ 3M SDE': 'dpmpp_3m_sde', 'DPM++ 2s a RF': 'dpmpp_2s_ancestral', 'LCM': 'lcm',
    'LMS': 'lms', 'Heun': 'heun', 'DPM2': 'dpm_2', 'Res Multistep': 'res_multistep', 'UniPC': 'uni_pc', 'DDIM': 'ddim',
    'DPM++ 2M CFG++': 'dpmpp_2m_cfg_pp', 'Euler a CFG++': 'euler_ancestral_cfg_pp', 'Euler CFG++': 'euler_cfg_pp',
  };
  const samplerId = s => SAMPLER_IDS[s.name] || String((s.aliases || [])[0] || s.name).replace(/^k_/, '');

  function findSampler(list, wanted) {
    const w = norm(wanted);
    return list.find(s => [s.name, samplerId(s), ...(s.aliases || [])].some(v => norm(v) === w));
  }
  const findScheduler = (list, wanted) => list.find(s => [s.name, s.label, ...(s.aliases || [])].some(v => v && norm(v) === norm(wanted)));

  function findModule(modules, wanted) {
    const names = [].concat(wanted);
    for (const n of names) {
      const hit = modules.find(m => same(m.model_name, n));
      if (hit) return hit.model_name;
    }
    throw new Error(`Neo ne trouve pas le fichier « ${stem(names[0])} » (VAE ou encodeur de texte). Place-le dans le dossier VAE ou text_encoder de Forge Neo.`);
  }

  // VAE et encodeur à charger avec un modèle ; null si sa famille est inconnue
  function modulesFor(modelName, family, modules, vae) {
    const list = FAMILY_MODULES[family];
    if (!list) return null;
    // Même les modèles nommés « AIO » en ont besoin : Neo refuse Anima Turbo AIO sans VAE
    let wanted = list;
    if (vae && !/^(none|automatic)$/i.test(vae)) wanted = [vae, ...wanted.filter(n => !/vae|^ae$/i.test([].concat(n)[0]))];
    return wanted.map(n => findModule(modules, n));
  }

  // Étapes réellement exécutées par le hires de SwarmUI (« 12 étapes, 60 % » = 7), puis le réglage
  // Neo qui donne le même nombre : dans Neo, hr_second_pass_steps compte les étapes exécutées.
  function hiresSteps(steps, control) {
    const done = Math.max(1, steps - Math.round(steps * (1 - control)));
    // légère marge sous le ratio exact : Neo tronque (étapes / force) à l'entier inférieur
    const denoise = Math.min(0.999, Math.max(0.001, done / steps - 1e-6));
    return { done, denoise };
  }

  // Hires. fix : l'app peut tenir les valeurs de SwarmUI (étapes totales + « bascule ») ou celles de
  // Neo (Hires steps réellement exécutées, 0 = comme Sampling Steps, + Denoising strength).
  function toNeoHires(steps, control) {
    const { done } = hiresSteps(steps, control);
    return { steps: done, denoise: Math.floor(Math.min(1, done / steps) * 1000) / 1000 };
  }

  function toSwarmHires(steps, denoise, baseSteps) {
    const done = steps || baseSteps;
    const control = Math.min(1, Math.max(0.05, denoise));
    return { steps: Math.max(1, Math.round(done / control)), control };
  }

  // Requête faite avec les réglages de Neo, envoyée à SwarmUI : mêmes étapes exécutées
  function toSwarmPayload(payload) {
    if (payload.hiresmode !== 'neo' && payload.neoscripts === undefined) return payload;
    const { hiresmode, hiressampler, hiresscheduler, neoscripts, ...p } = payload;
    if (hiresmode !== 'neo') return p;
    if (p.refinerupscale !== undefined) {
      const hf = toSwarmHires(+p.refinersteps || 0, +p.refinercontrolpercentage, +p.steps || 20);
      p.refinersteps = hf.steps;
      p.refinercontrolpercentage = hf.control;
    }
    return p;
  }

  function upscalerName(method, upscalers) {
    const m = String(method || 'pixel-lanczos');
    let wanted = null;
    if (m.startsWith('model-')) wanted = stem(m.slice(6));
    else if (m === 'pixel-lanczos') wanted = 'Lanczos';
    else if (m.startsWith('pixel-nearest')) wanted = 'Nearest';
    else if (m.startsWith('pixel-')) wanted = 'Lanczos';   // bicubique et bilinéaire n'existent pas dans Neo
    const hit = wanted && upscalers.find(u => norm(u.name) === norm(wanted));
    if (!hit) throw new Error(`Upscaler « ${m} » non disponible avec Neo (choisis un modèle ESRGAN ou Lanczos).`);
    return hit.name;
  }

  const num = (v, def) => (v === '' || v == null || !Number.isFinite(+v) ? def : +v);

  // Prompt au format Neo : LoRA par nom de fichier, <break> et <embed:> traduits, autre syntaxe SwarmUI refusée
  function translatePrompt(text, loras, missing) {
    return String(text || '')
      .replace(/<lora:([^>:]+)(:[^>]*)?>/gi, (_, name, rest) => {
        const s = stem(name);
        if (loras && !loras.some(l => l.name === s || l.alias === s)) missing.push(s);
        return `<lora:${s}${rest || ':1'}>`;
      })
      .replace(/\s*,?\s*<break>\s*,?\s*/gi, ' BREAK ')
      .replace(/<embed:([^>]+)>/gi, (_, name) => stem(name));
  }

  // Zones de l'app (<region:x,y,l,h,force> texte, <object:x,y,l,h,force,créativité> texte).
  // Neo n'a pas cette syntaxe : l'app génère l'image sans elles, puis repasse en inpaint sur chaque zone.
  function splitRegions(prompt) {
    const parts = String(prompt || '').split(/(?=<(?:region|object):)/i);
    const regions = [];
    let base = '';
    for (const part of parts) {
      const m = part.match(/^<(region|object):([^>]*)>\s*([\s\S]*)$/i);
      if (!m) { base += part; continue; }
      const [x, y, w, h, strength, creativity] = m[2].split(',').map(Number);
      if (![x, y, w, h].every(Number.isFinite) || !m[3].trim()) continue;
      const raw = m[1].toLowerCase() === 'object' ? creativity : strength;
      const denoise = Math.min(0.9, Math.max(0.3, Number.isFinite(raw) ? raw : 0.6));
      regions.push({ x, y, w, h, denoise, prompt: m[3].trim().replace(/,\s*$/, '') });
    }
    return { base: base.trim(), regions };
  }

  // payload : requête au format SwarmUI ; ctx : { family, models, modules, samplers, schedulers, upscalers, loras, controlnets }
  // Renvoie { route, body, count, seed, ignored } ou lève une erreur lisible.
  function buildRequest(payload, ctx) {
    const p = payload;
    const syntax = `${p.prompt} ${p.negativeprompt || ''}`.match(/<(?!lora:|break>|embed:)[a-z]+[:\[>,]/gi);
    if (syntax) {
      const tags = [...new Set(syntax.map(s => s.slice(0, -1) + '>'))].join(' ');
      throw new Error(`Syntaxe SwarmUI non prise en charge par Neo : ${tags}. Retire-la ou repasse sur SwarmUI.`);
    }

    if (!p.model) throw new Error('Choisis un modèle.');
    const model = ctx.models.find(m => same(m.title, p.model));
    if (!model) throw new Error(`Neo ne voit pas le modèle « ${stem(p.model)} ».`);

    const modules = modulesFor(p.model, ctx.family, ctx.modules, p.vae);
    if (!modules) throw new Error(`Famille du modèle « ${stem(p.model)} » inconnue : choisis-la dans la carte Modèle (« Famille Neo »).`);

    const missing = [];
    let prompt = translatePrompt(p.prompt, ctx.loras, missing);
    // Tâches du Scheduler : les LoRA sont dans des champs à part
    if (p.loras) {
      const names = Array.isArray(p.loras) ? p.loras : String(p.loras).split(',');
      const weights = Array.isArray(p.loraweights) ? p.loraweights : String(p.loraweights ?? '').split(',');
      const tags = names.map(n => String(n).trim()).filter(Boolean).map((n, i) => `<lora:${n}:${num(weights[i], 1)}>`).join(' ');
      if (tags) prompt += ' ' + translatePrompt(tags, ctx.loras, missing);
    }
    const negative = translatePrompt(p.negativeprompt, null, missing);
    if (missing.length) throw new Error(`Neo ne trouve pas ces LoRA : ${missing.join(', ')}`);

    const sampler = findSampler(ctx.samplers, p.sampler || 'euler');
    if (!sampler) throw new Error(`Sampler « ${p.sampler} » absent de Neo.`);
    const scheduler = findScheduler(ctx.schedulers, p.scheduler || 'simple');
    if (!scheduler) throw new Error(`Scheduler « ${p.scheduler} » absent de Neo.`);

    // Neo range le « shift » et la « guidance » distillée dans le même champ
    const shift = /^flux/.test(ctx.family) ? num(p.fluxguidancescale, 3.5) : num(p.sigmashift, 3);
    const seed = num(p.seed, -1) >= 0 ? +p.seed : Math.floor(Math.random() * 2 ** 32);
    const body = {
      prompt,
      negative_prompt: negative,
      width: p.width,
      height: p.height,
      steps: p.steps,
      cfg_scale: p.cfgscale,
      distilled_cfg_scale: shift,
      sampler_name: sampler.name,
      scheduler: scheduler.label || scheduler.name,
      seed,
      batch_size: 1,
      n_iter: 1,
      save_images: !p.donotsave,    // comme SwarmUI : l'image reste dans les sorties du PC
      send_images: true,
      override_settings: { sd_model_checkpoint: model.title, forge_additional_modules: modules, return_grid: false },
      override_settings_restore_afterwards: false,
    };
    const scripts = {};
    let route = 'txt2img';
    const refs = String(p.promptimages || '').split('|').filter(Boolean);

    if (p.initimage) {
      route = 'img2img';
      Object.assign(body, {
        init_images: [p.initimage],
        denoising_strength: num(p.initimagecreativity, 0.75),
        resize_mode: 0,
      });
      if (p.maskimage) {
        Object.assign(body, {
          mask: p.maskimage,
          inpainting_fill: 1,
          inpaint_full_res: false,
          mask_blur: num(p.maskblur, 4),
          inpainting_mask_invert: num(p.maskgrowamount, 0) < 0 ? 1 : 0,
        });
      }
      const others = refs.filter(r => r !== p.initimage);
      if (others.length) scripts['ImageStitch Integrated'] = { args: [true, others] };
    } else if (refs.length) {
      // Modèles d'édition et images de référence : texte vers image + références
      scripts['ImageStitch Integrated'] = { args: [true, refs] };
    }

    if (p.controlnetimageinput) {
      const list = ctx.controlnets || [];
      const cn = list.find(c => same(c, p.controlnetmodel || '')) || (!p.controlnetmodel && list.find(c => c !== 'None'));
      if (!cn) throw new Error(`Neo ne trouve pas le modèle ControlNet « ${stem(p.controlnetmodel) || '(aucun)'} ».`);
      const preprocessor = p.controlnetpreprocessor && !/^none$/i.test(p.controlnetpreprocessor) ? p.controlnetpreprocessor : 'None';
      scripts.controlnet = { args: [{
        enabled: true,
        image: p.controlnetimageinput,
        module: preprocessor,
        model: cn,
        weight: num(p.controlnetstrength, 1),
        guidance_start: num(p.controlnetstart, 0),
        guidance_end: num(p.controlnetend, 1),
        pixel_perfect: true,
        save_detected_map: false,
      }] };
    }

    if (p.refinerupscale !== undefined && route === 'txt2img') {
      // réglages de Neo : tels quels ; réglages de SwarmUI : convertis en étapes réellement exécutées
      const hr = p.hiresmode === 'neo'
        ? { done: num(p.refinersteps, 0), denoise: num(p.refinercontrolpercentage, 0.6) }
        : hiresSteps(p.refinersteps || p.steps, p.refinercontrolpercentage ?? 0.2);
      if (p.hiressampler) {
        const s = findSampler(ctx.samplers, p.hiressampler);
        if (!s) throw new Error(`Hires Sampling Method « ${p.hiressampler} » absent de Neo.`);
        body.hr_sampler_name = s.name;
      }
      if (p.hiresscheduler) {
        const s = findScheduler(ctx.schedulers, p.hiresscheduler);
        if (!s) throw new Error(`Hires Schedule Type « ${p.hiresscheduler} » absent de Neo.`);
        body.hr_scheduler = s.label || s.name;
      }
      Object.assign(body, {
        enable_hr: true,
        hr_scale: p.refinerupscale,
        hr_upscaler: upscalerName(p.refinerupscalemethod, ctx.upscalers),
        hr_second_pass_steps: hr.done,
        denoising_strength: hr.denoise,
        hr_cfg: p.refinercfgscale || p.cfgscale,
        hr_distilled_cfg: shift,
        hr_additional_modules: ['Use same choices'],
      });
      if (p.refinermodel && !same(p.refinermodel, p.model)) {
        const second = ctx.models.find(m => same(m.title, p.refinermodel));
        if (!second) throw new Error(`Neo ne voit pas le modèle du refiner « ${stem(p.refinermodel)} ».`);
        body.hr_checkpoint_name = second.title;
      }
    }
    // Scripts réglés dans le panneau « Extensions Neo »
    Object.assign(scripts, p.neoscripts || {});
    if (Object.keys(scripts).length) body.alwayson_scripts = scripts;

    const ignored = Object.keys(p).filter(k => !KNOWN.has(k) && !SILENT.has(k));
    return { route, body, count: Math.max(1, num(p.images, 1)), seed, ignored };
  }

  // Métadonnées au format SwarmUI, pour que PNG Info, « envoyer vers Txt2Img » et l'Inpaint les relisent
  function swarmMetadata(payload, seed, infotext) {
    const p = payload;
    const loras = [], weights = [];
    const prompt = String(p.prompt || '').replace(/\s*<lora:([^>:]+)(?::([^>]*))?>/gi, (_, n, w) => { loras.push(n); weights.push(w ?? '1'); return ''; }).trim();
    if (p.loras) {
      loras.push(...[].concat(Array.isArray(p.loras) ? p.loras : String(p.loras).split(',')).filter(Boolean));
      weights.push(...[].concat(Array.isArray(p.loraweights) ? p.loraweights : String(p.loraweights ?? '').split(',')));
    }
    const params = { prompt, negativeprompt: p.negativeprompt || '', model: p.model, seed };
    for (const k of ['width', 'height', 'steps', 'cfgscale', 'sampler', 'scheduler', 'vae', 'refinermethod', 'refinerupscale',
      'refinercontrolpercentage', 'refinerupscalemethod', 'refinersteps', 'refinercfgscale', 'refinermodel', 'sigmashift',
      'hiresmode', 'hiressampler', 'hiresscheduler']) {
      if (p[k] !== undefined && p[k] !== '') params[k] = p[k];
    }
    if (loras.length) { params.loras = loras; params.loraweights = weights.map(String); }
    return { sui_image_params: params, sui_extra_data: { engine: 'Forge Neo', ...(infotext ? { neo_infotext: infotext } : {}) } };
  }

  // ── Bloc de texte « parameters » d'un PNG ─────────────────────────────────
  const CRC = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
    return bytes => { let c = 0xFFFFFFFF; for (const b of bytes) c = t[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  })();

  // Remplace le texte « parameters » d'un PNG ; renvoie les octets d'origine si ce n'est pas un PNG
  function setPngParameters(bytes, text) {
    if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) return bytes;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const enc = new TextEncoder();
    const parts = [bytes.subarray(0, 8)];
    let off = 8, added = false;
    const chunk = (() => {
      const data = enc.encode('tEXtparameters\0' + text);
      const out = new Uint8Array(data.length + 8);
      const dv = new DataView(out.buffer);
      dv.setUint32(0, data.length - 4);
      out.set(data, 4);
      dv.setUint32(data.length + 4, CRC(data));
      return out;
    })();
    while (off + 12 <= bytes.length) {
      const len = view.getUint32(off);
      const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
      const whole = bytes.subarray(off, off + 12 + len);
      const isParams = (type === 'tEXt' || type === 'iTXt') && String.fromCharCode(...bytes.subarray(off + 8, off + 19)) === 'parameters\0';
      if (!added && (type === 'IDAT' || type === 'IEND')) { parts.push(chunk); added = true; }
      if (!isParams) parts.push(whole);
      off += 12 + len;
    }
    const out = new Uint8Array(parts.reduce((n, x) => n + x.length, 0));
    let at = 0;
    for (const x of parts) { out.set(x, at); at += x.length; }
    return out;
  }

  const api = { FAMILIES, stem, relativeName, guessFamily, guessArchitecture, samplerId, findSampler, hiresSteps, toNeoHires, toSwarmHires, toSwarmPayload, modulesFor, splitRegions, buildRequest, swarmMetadata, setPngParameters };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  return api;
})();
