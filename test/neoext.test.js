const assert = require('assert');
global.localStorage = { getItem: () => null, setItem: () => {} };
const X = require('../src/neoext.js');
let n = 0;
const test = (name, fn) => { fn(); n++; };
const scripts = [
  { name: 'spectrum integrated', is_alwayson: true, is_img2img: false, args: [{ label: 'Spectrum Integrated', value: false }, { label: 'Prediction Weighting', value: 0.25 }, { label: 'Timestep Range', value: [0.15, 0.85] }] },
  { name: 'never oom integrated', is_alwayson: true, is_img2img: false, args: [{ label: 'Enabled for UNet', value: false }, { label: 'Enabled for VAE', value: false }] },
  { name: 'controlnet', is_alwayson: true, is_img2img: false, args: [{ label: '', value: {} }] },
  { name: 'x/y/z plot', is_alwayson: false, is_img2img: false, args: [{ label: 'X', value: 0 }] },
];
test('scripts : seuls les activés partent, valeurs dans l’ordre de Neo', () => {
  assert.strictEqual(X.buildScripts(scripts, {}), undefined);
  assert.deepStrictEqual(X.buildScripts(scripts, {
    'spectrum integrated': { on: true, values: { 'Prediction Weighting': 0.5 } },
    'never oom integrated': { on: true, values: { 'Enabled for VAE': true } },
    controlnet: { on: true },
  }), {
    'spectrum integrated': { args: [true, 0.5, [0.15, 0.85]] },
    'never oom integrated': { args: [false, true] },
  });
});
test('réglages sans nom et cases multiples (Regional Prompter)', () => {
  const rp = [{ name: 'regional prompter', is_alwayson: true, is_img2img: false, args: [
    { label: 'Regional Prompter', value: false }, { label: '', value: false }, { label: '', value: 'Matrix' }, { label: 'Divide Ratio', value: '1,1' },
    { label: 'Options', value: [false], choices: ['A', 'B'] }, { label: '', value: null }] }];
  assert.deepStrictEqual(X.buildScripts(rp, { 'regional prompter': { on: true } })['regional prompter'].args, [true, false, 'Matrix', '1,1', [], null]);
  assert.deepStrictEqual(X.buildScripts(rp, { 'regional prompter': { on: true, values: { '#2': 'Mask', Options: ['B'], '#5': 'data:m' } } })['regional prompter'].args,
    [true, false, 'Mask', '1,1', ['B'], 'data:m']);
});
test('catalogue : recherche, filtre Neo, tri', () => {
  const list = [
    { name: 'Regional Prompter', url: 'u', tags: ['forge-neo'], stars: 5, description: 'zones', commit_time: '2026-09-04' },
    { name: 'Old one', url: 'u', tags: [], stars: 50, description: 'regional too', commit_time: '2024-01-01' },
    { name: 'ADetailer', url: 'u', tags: ['forge-neo'], stars: 9, description: 'faces', commit_time: '2026-10-01' },
  ];
  assert.deepStrictEqual(X.filterCatalogue(list, { query: 'regional' }).map(x => x.name), ['Regional Prompter']);
  assert.deepStrictEqual(X.filterCatalogue(list, { query: 'regional', neoOnly: false }).map(x => x.name), ['Old one', 'Regional Prompter']);
  assert.deepStrictEqual(X.filterCatalogue(list, { sort: 'date' }).map(x => x.name), ['ADetailer', 'Regional Prompter']);
});
test('installation : commande seulement pour une adresse GitHub simple', () => {
  const dir = 'C:\\Forge Neo';
  assert.strictEqual(X.installCommand('https://github.com/hako-mikan/sd-webui-regional-prompter', dir),
    'git clone https://github.com/hako-mikan/sd-webui-regional-prompter "C:\\Forge Neo\\extensions\\sd-webui-regional-prompter"');
  for (const bad of ['https://github.com/a/b" & del x', 'https://github.com/a/b&calc', 'https://evil.example/a/b', 'http://github.com/a/b', 'https://github.com/a/..']) {
    assert.strictEqual(X.installCommand(bad, dir), '', bad);
  }
  assert.strictEqual(X.installCommand('https://github.com/a/b', ''), '');
});
console.log(`neoext : ${n} tests OK`);
