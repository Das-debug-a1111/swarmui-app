const assert = require('assert');
const F = require('../src/forgesort.js');
let n = 0;
const test = (name, fn) => { fn(); n++; };
const files = [{ name: 'anima/b.safetensors', compat_class: 'anima' }, { name: 'xl/a.safetensors', compat_class: 'stable-diffusion-xl-v1' }];
const fam = f => ({ id: f.compat_class || '?', label: f.compat_class || 'Inconnu' });

test('correspondance des noms Forge', () => {
  assert.strictEqual(F.findIndex('xl\\a.safetensors [0f1e2d3c]', files), 1);
  assert.strictEqual(F.findIndex('/data/Models/Lora/anima/b.safetensors', files), 0);
  assert.strictEqual(F.findIndex('b', files), 0);
  assert.strictEqual(F.findIndex('absent', files), -1);
});
test('ordre de SwarmUI, inconnus à la fin par nom', () => {
  const out = F.arrange(['z', 'xl/a', 'c', 'anima/b'], x => x, files, fam);
  assert.deepStrictEqual(out.map(x => x.item), ['anima/b', 'xl/a', 'c', 'z']);
  assert.deepStrictEqual(out.map(x => x.fam.id), ['anima', 'stable-diffusion-xl-v1', '?', '?']);
});
test('LoRA : seulement ceux de la famille, sauf ceux à garder', () => {
  global.App = { models: files, loraModels: [{ name: 'l1', compat_class: 'anima' }, { name: 'l2', compat_class: 'stable-diffusion-xl-v1' }] };
  global.modelFamily = fam;
  const loras = [{ name: 'l2' }, { name: 'l1' }];
  const names = (...a) => F.loraChoices(loras, ...a).list.map(l => l.name);
  assert.deepStrictEqual(names('anima/b.safetensors [abc123]', false, new Set()), ['l1']);
  assert.deepStrictEqual(names('anima/b.safetensors', false, new Set(['l2'])), ['l1', 'l2']);
  assert.deepStrictEqual(names('anima/b.safetensors', true, new Set()), ['l1', 'l2']);
  assert.deepStrictEqual(names('inconnu', false, new Set()), ['l1', 'l2']);
  global.App.loraModels = [];   // SwarmUI éteint et LoRA sans indice : rien à filtrer
  assert.deepStrictEqual(names('anima/b.safetensors', false, new Set()), ['l1', 'l2']);
});

test('SwarmUI éteint : la famille vient des métadonnées de Forge', () => {
  assert.strictEqual(F.declared({ 'modelspec.architecture': 'stable-diffusion-v1/lora', ss_base_model_version: 'anima' }), 'anima');
  assert.strictEqual(F.declared({ ss_base_model_version: 'sdxl_base_v1-0' }), 'stable-diffusion-xl-v1');
  assert.strictEqual(F.declared({ 'modelspec.architecture': 'Krea-2/lora' }), 'krea-2');
  assert.strictEqual(F.declared(undefined), '');
  global.App = { models: [], loraModels: [] };
  const loras = [{ name: 'k', metadata: { ss_base_model_version: 'krea2' } }, { name: 'a', metadata: { ss_base_model_version: 'anima' } }, { name: 'rien' }];
  global.modelFamily = f => fam(f.compat_class ? f : { compat_class: /anima/.test(f.name) ? 'anima' : '' });
  const out = F.loraChoices(loras, 'anima/x.safetensors', false, new Set());
  assert.deepStrictEqual(out.list.map(l => l.name), ['a']);
  assert(out.hint.includes('1 non classé masqué'), out.hint);
});

console.log(`forgesort : ${n} tests OK`);
