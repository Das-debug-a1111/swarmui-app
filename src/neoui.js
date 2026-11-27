// ── Affichage « Forge Neo » ───────────────────────────────────────────────────
// Avec le moteur Neo, l'app emploie les noms, l'ordre et le sens des réglages de l'interface web
// de Neo (Hires. fix surtout), pour ne pas avoir à traduire entre les deux. Avec SwarmUI, elle
// garde son affichage d'origine.
const NeoUI = (() => {
  const el = id => document.getElementById(id);
  const on = () => typeof NeoBackend !== 'undefined' && NeoBackend.active();

  // Familles de l'app = « UI Preset » de Neo
  const PRESETS = { 'anima': 'anima', 'krea-2': 'krea', 'qwen-image': 'qwen', 'flux-1': 'flux', 'flux-2': 'klein', 'stable-diffusion-xl-v1': 'xl', 'stable-diffusion-v1': 'sd' };
  const presetName = family => PRESETS[family] || family;

  // Change le texte d'un libellé sans toucher à ses boutons ni à sa valeur ; retient l'original
  function setText(node, neoText) {
    if (!node) return;
    let target = [...node.childNodes].find(c => c.nodeType === 3 && c.textContent.trim());
    if (!target) target = [...node.children].find(c => c.tagName === 'SPAN' && c.textContent.trim() && !c.id)?.firstChild;
    if (!target) return;
    if (target.__swarm === undefined) target.__swarm = target.textContent;
    target.textContent = on() ? target.__swarm.replace(target.__swarm.trim(), neoText) : target.__swarm;
  }
  const field = (controlId, text) => setText(el(controlId)?.closest('.field')?.querySelector('.field-label'), text);
  const row = (controlId, text) => setText(el(controlId)?.closest('.inp-bcol-row')?.querySelector('.inp-bcol-lrow span'), text);
  const before = (controlId, text) => setText(el(controlId)?.previousElementSibling, text);
  const choice = (inputId, text) => setText(document.querySelector(`label[for="${inputId}"]`), text);

  function labels() {
    // Txt2Img
    setText(el('sel-vae')?.previousElementSibling, 'VAE / TE');
    setText(el('sel-neo-family')?.previousElementSibling, 'UI Preset');
    setText(document.querySelector('[data-section="gen"] > span'), 'Generation');
    field('inp-steps', 'Sampling Steps');
    field('sel-sampler', 'Sampling Method');
    field('sel-scheduler', 'Schedule Type');
    setText(document.querySelector('.images-count-wrap > span, .images-count-wrap > label'), 'Batch Count');
    // Hires. fix
    const head = document.querySelector('[data-section="refiner"] > span');
    if (head) {
      if (head.__swarm === undefined) head.__swarm = head.innerHTML;
      head.innerHTML = on() ? 'Hires. fix' : head.__swarm;
    }
    field('sel-refiner-model', 'Hires Checkpoint');
    field('sel-refiner-method', 'Upscaler');
    field('inp-refiner-scale', 'Upscale by');
    field('inp-refiner-pct', 'Denoising strength');
    field('inp-refiner-steps', 'Hires steps');
    field('inp-refiner-cfg', 'Hires CFG Scale');
    const same = el('sel-refiner-model')?.options[0];
    if (same && !same.value) same.textContent = on() ? 'Use same checkpoint' : '— Same as main —';
    setText(document.querySelector('[data-section="refimg"] > span'), 'ImageStitch Integrated');
    // ControlNet
    field('sel-cn-model', 'Model');
    field('sel-cn-type', 'Preprocessor');
    field('inp-cn-strength', 'Control Weight');
    field('inp-cn-start', 'Starting Control Step');
    field('inp-cn-end', 'Ending Control Step');
    // Edit
    field('flux-inp-steps', 'Sampling Steps');
    field('flux-sel-sampler', 'Sampling Method');
    field('flux-sel-scheduler', 'Schedule Type');
    field('flux-inp-shift', 'Shift');
    // Inpaint (il travaille toujours avec Neo : mêmes noms que son onglet img2img)
    row('inp-denoise', 'Denoising strength');
    row('inp-mblur', 'Mask blur');
    row('inpp-steps', 'Sampling Steps');
    row('inp-pad', 'Only masked padding');
    setText(el('inp-area-masked')?.parentElement?.previousElementSibling, 'Inpaint area');
    choice('inp-area-masked', 'Only masked');
    choice('inp-area-whole', 'Whole picture');
    before('inp-sampler', 'Sampling Method');
    before('inp-scheduler', 'Schedule Type');
    before('inp-fill-mode', 'Masked content');
    // File du Scheduler (formulaire d'une tâche)
    const q = (id, text) => setText(el(id)?.closest('div')?.querySelector('.sws-lbl'), text);
    q('sws-f-hf-model', 'Hires Checkpoint');
    q('sws-f-hf-method', 'Upscaler');
    q('sws-f-hf-scale', 'Upscale by');
    q('sws-f-hf-pct', 'Denoising strength');
    q('sws-f-hf-steps', 'Hires steps');
    q('sws-f-hf-cfg', 'Hires CFG Scale');
    q('sws-f-sampler', 'Sampling Method');
  }

  // « Upscaled resolution », comme sur Neo
  function resolution() {
    const out = el('neo-hr-res');
    if (!out) return;
    const w = parseInt(el('inp-width').value, 10) || 0, h = parseInt(el('inp-height').value, 10) || 0;
    const k = parseFloat(el('inp-refiner-scale').value) || 1;
    const round = v => Math.round(v * k / 8) * 8;
    out.textContent = `from ${w}×${h} to ${round(w)}×${round(h)}`;
  }

  // Écrit les deux champs dont le sens change d'un moteur à l'autre
  function writeHires(steps, pct) {
    const set = (name, value, label) => {
      el(`sl-refiner-${name}`).value = value;
      el(`inp-refiner-${name}`).value = value;
      el(`lbl-refiner-${name}`).textContent = label;
    };
    set('steps', steps, steps);
    set('pct', pct, on() ? pct : `${Math.round(pct * 100)}%`);
  }

  // Les champs viennent d'être remplis avec des valeurs prévues pour « from » (swarm ou neo) : les convertir
  function adaptHires(from) {
    const to = on() ? 'neo' : 'swarm';
    let steps = parseInt(el('inp-refiner-steps').value, 10);
    let pct = parseFloat(el('inp-refiner-pct').value);
    if (!Number.isFinite(steps) || !Number.isFinite(pct)) return;
    if ((from || 'swarm') !== to) {
      if (to === 'neo') {
        const hf = NeoEngine.toNeoHires(steps || 1, pct);
        steps = hf.steps;
        pct = hf.denoise;
      } else {
        const hf = NeoEngine.toSwarmHires(steps, pct, parseInt(el('inp-steps').value, 10) || 20);
        steps = hf.steps;
        pct = hf.control;
      }
    }
    writeHires(steps, pct);
    resolution();
  }

  // Champs propres à Neo à ajouter à la requête de Txt2Img (et aux presets)
  function addTo(params) {
    if (!on()) return params;
    const scripts = NeoExt.payload();
    if (scripts) params.neoscripts = scripts;
    const shift = parseFloat(el('inp-neo-shift').value);
    const family = el('sel-neo-family').value;
    if (Number.isFinite(shift) && !/^stable-diffusion/.test(family)) {
      params[/^flux/.test(family) ? 'fluxguidancescale' : 'sigmashift'] = shift;
    }
    if (el('chk-refiner').checked) {
      params.hiresmode = 'neo';
      const steps = parseInt(el('inp-refiner-steps').value, 10);
      params.refinersteps = Number.isFinite(steps) ? steps : 0;
      if (el('sel-hr-sampler').value) params.hiressampler = el('sel-hr-sampler').value;
      if (el('sel-hr-scheduler').value) params.hiresscheduler = el('sel-hr-scheduler').value;
    }
    return params;
  }

  // Valeurs venant d'un preset, d'une métadonnée ou d'une tâche
  function readFrom(params) {
    if (!params) return;
    NeoExt.apply(params.neoscripts);
    const shift = params.sigmashift ?? params.fluxguidancescale;
    if (shift !== undefined && shift !== '') setShift(shift);
    if (el('sel-hr-sampler')) el('sel-hr-sampler').value = params.hiressampler || '';
    if (el('sel-hr-scheduler')) el('sel-hr-scheduler').value = params.hiresscheduler || '';
    if (params.refinersteps !== undefined || params.refinercontrolpercentage !== undefined) {
      if (params.refinersteps !== undefined) { el('inp-refiner-steps').value = params.refinersteps; el('sl-refiner-steps').value = params.refinersteps; }
      adaptHires(params.hiresmode || 'swarm');
    }
    resolution();
  }

  function setShift(v) {
    el('inp-neo-shift').value = v;
    el('sl-neo-shift').value = v;
    el('lbl-neo-shift').textContent = v;
  }

  // « Shift » (ou « Distilled CFG Scale » pour Flux) n'existe que pour certaines familles
  function family(name) {
    const fieldEl = el('neo-shift-field');
    if (!fieldEl) return;
    fieldEl.hidden = !name || /^stable-diffusion/.test(name);
    fieldEl.querySelector('.field-label').firstChild.textContent = /^flux/.test(name) ? 'Distilled CFG Scale ' : 'Shift ';
  }

  function fillHiresLists(samplers, schedulers) {
    const fill = (id, first, p) => {
      const sel = el(id);
      if (!sel || !p?.values) return;
      const cur = sel.value;
      sel.innerHTML = `<option value="">${first}</option>` +
        p.values.map((v, i) => `<option value="${esc(v)}">${esc(p.neo_names?.[i] || v)}</option>`).join('');
      sel.value = cur;
      if (sel.selectedIndex < 0) sel.value = '';
    };
    fill('sel-hr-sampler', 'Use same sampler', samplers);
    fill('sel-hr-scheduler', 'Use same scheduler', schedulers);
  }

  let engineShown = null;

  // À appeler au démarrage et à chaque changement de moteur
  function apply() {
    const now = on() ? 'neo' : 'swarm';
    document.body.classList.toggle('engine-neo', now === 'neo');
    // les libellés des curseurs : Neo les compte autrement
    el('sl-refiner-steps').min = el('inp-refiner-steps').min = now === 'neo' ? 0 : 1;
    el('sl-refiner-pct').step = now === 'neo' ? 0.001 : 0.01;
    labels();
    if (engineShown && engineShown !== now) adaptHires(engineShown);
    else if (!engineShown && now === 'neo') adaptHires('swarm');   // valeurs de départ de la page
    engineShown = now;
    resolution();
  }

  function init() {
    const slider = el('sl-neo-shift'), input = el('inp-neo-shift');
    slider.addEventListener('input', () => setShift(slider.value));
    input.addEventListener('change', () => { const v = parseFloat(input.value); if (Number.isFinite(v)) setShift(v); });
    ['inp-width', 'inp-height', 'inp-refiner-scale', 'sl-refiner-scale'].forEach(id => el(id).addEventListener('input', resolution));
    document.getElementById('ratio-grid')?.addEventListener('click', () => setTimeout(resolution, 0));
    el('sl-refiner-pct').addEventListener('input', () => { if (on()) el('lbl-refiner-pct').textContent = el('sl-refiner-pct').value; });
    el('inp-refiner-pct').addEventListener('change', () => { if (on()) el('lbl-refiner-pct').textContent = el('inp-refiner-pct').value; });
    apply();
  }

  return { init, apply, labels, adaptHires, addTo, readFrom, family, fillHiresLists, resolution, presetName };
})();
