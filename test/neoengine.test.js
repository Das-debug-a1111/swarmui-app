const assert = require('assert');
const N = require('../src/neoengine.js');
let n = 0;
const test = (name, fn) => { fn(); n++; };
const ctx = {
  family: 'anima',
  models: [{ title: 'Hoseki.safetensors [db7f60860a]' }, { title: 'sub\\second.safetensors' }, { title: 'Turbo-AIO_V5.safetensors' }],
  modules: [{ model_name: 'qwen_image_vae.safetensors' }, { model_name: 'qwen_3_06b_base.safetensors' }, { model_name: 'qwen3vl_4b.safetensors' }, { model_name: 'sdxlVAE.safetensors' }],
  samplers: [{ name: 'ER SDE', aliases: ['er_sde'] }, { name: 'Euler', aliases: ['k_euler'] }, { name: 'Euler a', aliases: ['k_euler_a', 'k_euler_ancestral'] }],
  schedulers: [{ name: 'simple', label: 'Simple' }, { name: 'sgm_uniform', label: 'SGM Uniform', aliases: ['SGMUniform'] }],
  upscalers: [{ name: 'Lanczos' }, { name: 'remacri_original' }],
  loras: [{ name: 'Mon style', alias: 'Mon style' }, { name: 'detail', alias: 'detail' }],
  controlnets: ['None', 'anima-lllite-lineart-1'],
};
const base = { prompt: 'a house <lora:Mon style.safetensors:0.8> <lora:sub/detail:0.25>', negativeprompt: 'blurry', images: 2, model: 'Hoseki.safetensors',
  width: 1152, height: 768, steps: 40, cfgscale: 4.5, sampler: 'er_sde', scheduler: 'simple', seed: 7 };
const build = (extra, c = {}) => N.buildRequest({ ...base, ...extra }, { ...ctx, ...c });

test('modèle, modules, LoRA, sampler, seed', () => {
  const r = build({});
  assert.strictEqual(r.route, 'txt2img');
  assert.strictEqual(r.body.prompt, 'a house <lora:Mon style:0.8> <lora:detail:0.25>');
  assert.strictEqual(r.body.override_settings.sd_model_checkpoint, 'Hoseki.safetensors [db7f60860a]');
  assert.deepStrictEqual(r.body.override_settings.forge_additional_modules, ['qwen_image_vae.safetensors', 'qwen_3_06b_base.safetensors']);
  assert.deepStrictEqual([r.body.sampler_name, r.body.scheduler, r.body.distilled_cfg_scale, r.count, r.seed, r.body.save_images], ['ER SDE', 'Simple', 3, 2, 7, true]);
  assert.strictEqual(r.body.enable_hr, undefined);
  assert.strictEqual(r.body.alwayson_scripts, undefined);
  assert.deepStrictEqual(r.ignored, []);
  assert.strictEqual(build({ sampler: 'euler_ancestral', scheduler: 'sgm_uniform' }).body.sampler_name, 'Euler a');
  assert.ok(build({ seed: -1 }).seed >= 0);
  assert.strictEqual(build({ donotsave: true }).body.save_images, false);
});
test('hires : mêmes étapes réelles que SwarmUI, y compris après la troncature de Neo', () => {
  const r = build({ refinerupscale: 1.5, refinercontrolpercentage: 0.6, refinersteps: 12, refinercfgscale: 4.5, refinerupscalemethod: 'model-remacri_original.pth', refinermethod: 'PostApply' });
  assert.deepStrictEqual([r.body.hr_second_pass_steps, r.body.hr_upscaler, r.body.hr_scale], [7, 'remacri_original', 1.5]);
  assert.strictEqual(Math.trunc(7 / r.body.denoising_strength), 12);
  for (let steps = 2; steps <= 60; steps++) {
    for (let pct = 0.05; pct < 1; pct += 0.05) {
      const h = N.hiresSteps(steps, pct);
      assert.ok(h.done === steps || Math.trunc(h.done / h.denoise) === steps, `${steps} ${pct}`);
    }
  }
  assert.strictEqual(build({ refinerupscale: 1.5, refinerupscalemethod: 'pixel-bicubic' }).body.hr_upscaler, 'Lanczos');
  assert.strictEqual(build({ refinerupscale: 1.5, refinermodel: 'second.safetensors' }).body.hr_checkpoint_name, 'sub\\second.safetensors');
});
test('Hires. fix avec les réglages de Neo : tels quels, et traduits sans perte pour SwarmUI', () => {
  const neo = { hiresmode: 'neo', refinerupscale: 1.5, refinersteps: 7, refinercontrolpercentage: 0.583, refinerupscalemethod: 'pixel-lanczos', hiressampler: 'euler', hiresscheduler: 'simple' };
  const b = build(neo).body;
  assert.deepStrictEqual([b.hr_second_pass_steps, b.denoising_strength, b.hr_sampler_name, b.hr_scheduler], [7, 0.583, 'Euler', 'Simple']);
  assert.strictEqual(build({ ...neo, refinersteps: 0 }).body.hr_second_pass_steps, 0);
  assert.deepStrictEqual(N.toNeoHires(12, 0.6), { steps: 7, denoise: 0.583 });
  assert.deepStrictEqual(N.toSwarmHires(7, 0.583, 40), { steps: 12, control: 0.583 });
  const back = N.toSwarmPayload({ ...base, ...neo });
  assert.deepStrictEqual([back.refinersteps, back.refinercontrolpercentage, back.hiresmode, back.hiressampler], [12, 0.583, undefined, undefined]);
  assert.strictEqual(N.hiresSteps(back.refinersteps, back.refinercontrolpercentage).done, 7);
  assert.strictEqual(N.toSwarmPayload(base), base);
});
test('VAE à la main, SDXL, modèle nommé AIO, Krea 2', () => {
  assert.deepStrictEqual(build({ vae: 'x/sdxlVAE.safetensors' }).body.override_settings.forge_additional_modules, ['sdxlVAE.safetensors', 'qwen_3_06b_base.safetensors']);
  assert.deepStrictEqual(build({}, { family: 'stable-diffusion-xl-v1' }).body.override_settings.forge_additional_modules, []);
  assert.deepStrictEqual(build({ model: 'Turbo-AIO_V5.safetensors' }).body.override_settings.forge_additional_modules, ['qwen_image_vae.safetensors', 'qwen_3_06b_base.safetensors']);
  assert.deepStrictEqual(build({}, { family: 'krea-2' }).body.override_settings.forge_additional_modules, ['qwen_image_vae.safetensors', 'qwen3vl_4b.safetensors']);
});
test('LoRA de la file (champs à part), <break> et <embed:>', () => {
  const r = build({ prompt: 'a, <break>, b <embed:foo.safetensors>', loras: 'Mon style.safetensors,detail', loraweights: '0.5,2' });
  assert.strictEqual(r.body.prompt, 'a BREAK b foo <lora:Mon style:0.5> <lora:detail:2>');
});
test('inpaint, images de référence, ControlNet', () => {
  const inp = build({ initimage: 'data:i', maskimage: 'data:m', initimagecreativity: 0.6, maskgrowamount: -1, refinerupscale: 1.5, refinerupscalemethod: 'pixel-lanczos' });
  assert.deepStrictEqual([inp.route, inp.body.init_images[0], inp.body.mask, inp.body.denoising_strength, inp.body.inpainting_mask_invert, inp.body.enable_hr], ['img2img', 'data:i', 'data:m', 0.6, 1, undefined]);
  const ref = build({ promptimages: 'data:a|data:b' });
  assert.deepStrictEqual([ref.route, ref.body.alwayson_scripts['ImageStitch Integrated'].args], ['txt2img', [true, ['data:a', 'data:b']]]);
  const edit = build({ initimage: 'data:a', maskimage: 'data:m', promptimages: 'data:a|data:b' });
  assert.deepStrictEqual(edit.body.alwayson_scripts['ImageStitch Integrated'].args, [true, ['data:b']]);
  const cn = build({ controlnetimageinput: 'data:c', controlnetmodel: 'anima-lllite-lineart-1.safetensors', controlnetpreprocessor: 'canny', controlnetstrength: 0.7, controlnetend: 0.8 }).body.alwayson_scripts.controlnet.args[0];
  assert.deepStrictEqual([cn.model, cn.module, cn.weight, cn.guidance_start, cn.guidance_end], ['anima-lllite-lineart-1', 'canny', 0.7, 0, 0.8]);
});
test('ce que Neo ne sait pas faire est refusé, jamais ignoré en silence', () => {
  assert.throws(() => build({ prompt: 'x <segment:face> y' }), /segment/);
  assert.throws(() => build({ prompt: 'x <random:a,b>' }), /random/);
  assert.throws(() => build({ prompt: 'x <lora:absent:1>' }), /absent/);
  assert.throws(() => build({ model: 'autre.safetensors' }), /ne voit pas/);
  assert.throws(() => build({}, { family: '' }), /Famille/);
  assert.throws(() => build({}, { family: 'qwen-image' }), /qwen_2\.5_vl_7b/);
  assert.throws(() => build({ refinerupscale: 1.5, refinerupscalemethod: 'latent-bislerp' }), /Upscaler/);
  assert.throws(() => build({ controlnetimageinput: 'data:c', controlnetmodel: 'inconnu' }), /ControlNet/);
  assert.deepStrictEqual(build({ skimmedcfg: 2, gligenmodel: 'None' }).ignored, ['skimmedcfg']);
});
test('zones de l’app : prompt de base et rectangles à repeindre', () => {
  const r = N.splitRegions('a park <lora:detail:1> <region:0,0,0.5,1,0.7> a fountain, <object:0.5,0.25,0.5,0.5,0.8,0.55> a bench <region:0,0,1,1,0.5>  ');
  assert.strictEqual(r.base, 'a park <lora:detail:1>');
  assert.deepStrictEqual(r.regions, [
    { x: 0, y: 0, w: 0.5, h: 1, denoise: 0.7, prompt: 'a fountain' },
    { x: 0.5, y: 0.25, w: 0.5, h: 0.5, denoise: 0.55, prompt: 'a bench' },
  ]);
  assert.deepStrictEqual(N.splitRegions('sans zone'), { base: 'sans zone', regions: [] });
});
test('familles devinées', () => {
  assert.strictEqual(N.guessFamily('x', { ss_base_model_version: 'anima', 'modelspec.architecture': 'stable-diffusion-v1/lora' }), 'anima');
  assert.strictEqual(N.guessFamily('x', { 'modelspec.architecture': 'Krea-2/lora' }), 'krea-2');
  assert.strictEqual(N.guessFamily('waiIllustriousSDXL_v170.safetensors'), 'stable-diffusion-xl-v1');
  assert.strictEqual(N.guessFamily('Hoseki_animaBaseV1.safetensors'), 'anima');
  assert.strictEqual(N.guessFamily('inconnu'), '');
  assert.strictEqual(N.guessArchitecture('split/qwen_image_edit_2511.safetensors', 'qwen-image'), 'qwen-image-edit-plus');
  assert.strictEqual(N.relativeName('C:\\Models\\Lora\\sub\\a.safetensors', 'Lora'), 'sub/a.safetensors');
});
test('métadonnées relues comme celles de SwarmUI, dans le PNG', () => {
  const meta = N.swarmMetadata({ ...base, refinerupscale: 1.5 }, 12, 'texte Neo');
  assert.strictEqual(meta.sui_image_params.prompt, 'a house');
  assert.deepStrictEqual(meta.sui_image_params.loras, ['Mon style.safetensors', 'sub/detail']);
  assert.deepStrictEqual([meta.sui_image_params.seed, meta.sui_image_params.refinerupscale, meta.sui_extra_data.engine], [12, 1.5, 'Forge Neo']);
  const zlib = require('zlib');
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type), data]);
    const out = Buffer.alloc(data.length + 12);
    out.writeUInt32BE(data.length, 0); body.copy(out, 4); out.writeUInt32BE(zlib.crc32(body), data.length + 8);
    return out;
  };
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 13, 10, 26, 10]);
  const png = Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('parameters\0ancien')), chunk('IDAT', Buffer.from([1, 2])), chunk('IEND', Buffer.alloc(0))]);
  const out = Buffer.from(N.setPngParameters(new Uint8Array(png), '{"é":1}'));
  const expected = Buffer.concat([sig, chunk('IHDR', Buffer.alloc(13)), chunk('tEXt', Buffer.from('parameters\0{"é":1}')), chunk('IDAT', Buffer.from([1, 2])), chunk('IEND', Buffer.alloc(0))]);
  assert.deepStrictEqual(out, expected);
});
console.log(`neoengine : ${n} tests OK`);
