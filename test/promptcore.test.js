'use strict';
// Tests du cœur du constructeur de prompt : node test/promptcore.test.js
const assert = require('assert');
const P = require('../src/promptcore');
let n = 0, bad = 0;
const t = (name, fn) => { try { fn(); n++; console.log('ok  ', name); } catch (e) { bad++; console.log('FAIL', name, '-', e.message); } };
const withState = (mut) => { const s = P.defaultState(); mut(s); return s; };

t('normTag : minuscules, espaces, tirets bas', () => { assert.strictEqual(P.normTag('  Long_Hair '), 'long hair'); assert.strictEqual(P.normTag('Blue   Eyes'), 'blue eyes'); assert.strictEqual(P.normTag(''), null); assert.strictEqual(P.normTag(null), null); });
t('normTag : poids conservés et normalisés', () => { assert.strictEqual(P.normTag('(Glossy_Skin:1.1)'), '(glossy skin:1.1)'); assert.strictEqual(P.normTag('(big eyes:0.8)'), '(big eyes:0.8)'); });
t('normTag : <lora> intact (casse comprise)', () => { assert.strictEqual(P.normTag('<lora:MyStyle_v2:0.8>'), '<lora:MyStyle_v2:0.8>'); });
t('normTag : parenthèses de noms échappées, emphase laissée', () => { assert.strictEqual(P.normTag('link (zelda)'), 'link \\(zelda\\)'); assert.strictEqual(P.normTag('link \\(zelda\\)'), 'link \\(zelda\\)'); assert.strictEqual(P.normTag('(masterpiece)'), '(masterpiece)'); });
t('splitTags : respecte parenthèses, <> et retours à la ligne', () => { assert.deepStrictEqual(P.splitTags('a, (b, c:1.2), <lora:x,y:1>, d\ne'), ['a', '(b, c:1.2)', '<lora:x,y:1>', 'd', 'e']); });
t('dedupe : ignore la casse, les poids et les tirets bas', () => { assert.deepStrictEqual(P.dedupe(['long hair', 'Long_Hair', '(long hair:1.2)', 'blue eyes']), ['long hair', 'blue eyes']); });
t('categoryOf : liste puis motifs', () => { assert.strictEqual(P.categoryOf('from below'), 'framing'); assert.strictEqual(P.categoryOf('pink hair'), 'hair'); assert.strictEqual(P.categoryOf('latex gloves'), 'clothing'); assert.strictEqual(P.categoryOf('(warm lighting:1.1)'), 'lighting'); assert.strictEqual(P.categoryOf('qsdfgh'), null); assert.strictEqual(P.categoryOf('worst quality'), 'negQuality'); });
t('suggest : commence par, puis contient', () => { assert.strictEqual(P.suggest('framing', 'from')[0].startsWith('from'), true); assert.ok(P.suggest('clothing', 'gown').includes('evening gown')); });

t('sujet : 1 personnage = 1girl, solo', () => { const s = withState(x => x.chars.push(P.newChar(1))); assert.deepStrictEqual(P.subjectTags(s.chars, s.opts), ['1girl', 'solo']); });
t('sujet : fille + garçon', () => { const s = withState(x => { const a = P.newChar(1), b = P.newChar(2); b.gender = 'boy'; x.chars.push(a, b); }); assert.deepStrictEqual(P.subjectTags(s.chars, s.opts), ['1girl', '1boy']); });
t('sujet : 2 filles = 2girls, multiple girls', () => { const s = withState(x => x.chars.push(P.newChar(1), P.newChar(2))); assert.deepStrictEqual(P.subjectTags(s.chars, s.opts), ['2girls', 'multiple girls']); });
t('sujet : personnage désactivé ignoré, 6+ filles', () => { const a = P.newChar(1); a.on = false; assert.deepStrictEqual(P.subjectTags([a], {}), []); const six = Array.from({ length: 7 }, (_, i) => P.newChar(i)); assert.ok(P.subjectTags(six, {}).includes('6+girls')); });

t('compose : ordre qualité, style, sujet, perso, scène', () => {
  const s = withState(x => {
    x.pos.style = [{ t: 'My_Trigger', on: true }];
    const c = P.newChar(1); c.name = 'Princess_Zelda'; c.appearance = 'long blonde hair, Blue_Eyes'; c.outfits[0].tags = 'floral bra, sheer purple panties'; c.expression = 'smirk'; c.pose = 'standing';
    x.chars.push(c);
    x.pos.framing.find(f => f.t === 'from below').on = true;
  });
  const r = P.compose(s);
  assert.strictEqual(r.positive, 'masterpiece, best quality, amazing quality, very aesthetic, My_Trigger, 1girl, solo, princess zelda, long blonde hair, blue eyes, floral bra, sheer purple panties, smirk, standing, from below');
  assert.deepStrictEqual(r.lines.map(l => l.label), ['Qualité', 'Trigger words et style', 'Sujet', 'Perso 1 · princess zelda', 'Cadrage']);
});
t('compose : trigger words gardent casse et tirets bas', () => { const s = withState(x => { x.pos.style = [{ t: 'Zel_dA Style', on: true }]; }); assert.ok(P.compose(s).positive.includes('Zel_dA Style')); });
t('compose : plusieurs tenues, seule la tenue active est utilisée', () => {
  const s = withState(x => { const c = P.newChar(1); c.outfits = [{ label: 'A', tags: 'red dress' }, { label: 'B', tags: 'black bikini' }]; c.outfit = 1; x.chars.push(c); });
  const p = P.compose(s).positive; assert.ok(p.includes('black bikini') && !p.includes('red dress'));
});
t('compose : doublons entre sections supprimés', () => { const s = withState(x => { const c = P.newChar(1); c.appearance = 'long hair'; x.chars.push(c); x.pos.extra = [{ t: 'Long_Hair', on: true }]; }); assert.strictEqual((P.compose(s).positive.match(/long hair/g) || []).length, 1); });
t('compose : futanari ajouté, compté comme fille', () => { const s = withState(x => { const c = P.newChar(1); c.gender = 'futa'; x.chars.push(c); }); const p = P.compose(s).positive; assert.ok(p.includes('1girl') && p.includes('futanari')); });
t('compose : <break> entre personnages (option)', () => { const s = withState(x => { const a = P.newChar(1), b = P.newChar(2); a.name = 'a'; b.name = 'b'; x.chars.push(a, b); x.opts.useBreak = true; }); assert.ok(P.compose(s).positive.includes('<break>')); const s2 = withState(x => { x.chars.push(P.newChar(1), P.newChar(2)); }); assert.ok(!P.compose(s2).positive.includes('<break>')); });
t('compose : négatif par sections, tags désactivés ignorés', () => { const r = P.compose(P.defaultState()); assert.ok(r.negative.startsWith('worst quality, low quality')); assert.ok(r.negative.includes('bad anatomy') && !r.negative.includes('blurry')); });
t('compose : avertit des contradictions', () => { const s = withState(x => { x.pos.framing.find(f => f.t === 'from above').on = true; x.pos.framing.find(f => f.t === 'from below').on = true; }); assert.ok(P.compose(s).warnings.some(w => /contredisent/.test(w))); });
t('compose : avertit au-delà de 75 tokens', () => { const s = withState(x => { x.pos.extra = Array.from({ length: 40 }, (_, i) => ({ t: 'tag number ' + i, on: true })); }); const r = P.compose(s); assert.ok(r.tokens.pos > 75 && r.warnings.some(w => /75 tokens/.test(w))); });
t('compose : sans personnage, pas de tag de sujet', () => { const r = P.compose(P.defaultState()); assert.ok(!/girl|solo/.test(r.positive)); });
t('compose : ne plante pas sur un état abîmé', () => { assert.doesNotThrow(() => P.compose({ pos: {}, chars: [{ outfits: null }] })); assert.doesNotThrow(() => P.compose(null)); });

const PROMPT = 'masterpiece, best quality, 1girl, solo, princess zelda, long blonde hair, blue eyes, floral bra, sheer purple panties, smirk, blush, standing, from below, throne room, warm lighting, <lora:Zelda_v1:0.8>, mystery tag';
t('parse : classe les tags dans les bonnes catégories', () => {
  const { state } = P.parse(PROMPT, 'worst quality, bad anatomy, custom neg', n => n === 'princess_zelda' ? 4 : 0);
  const on = (arr) => arr.filter(x => x.on).map(x => x.t);
  assert.deepStrictEqual(on(state.pos.quality), ['masterpiece', 'best quality']);
  assert.deepStrictEqual(on(state.pos.framing), ['from below']); assert.deepStrictEqual(on(state.pos.setting), ['throne room']); assert.deepStrictEqual(on(state.pos.lighting), ['warm lighting']);
  assert.deepStrictEqual(on(state.pos.style), ['<lora:Zelda_v1:0.8>']); assert.deepStrictEqual(on(state.pos.extra), ['mystery tag']);
  assert.strictEqual(state.chars.length, 1); const c = state.chars[0];
  assert.strictEqual(c.name, 'princess zelda'); assert.strictEqual(c.appearance, 'long blonde hair, blue eyes'); assert.strictEqual(c.outfits[0].tags, 'floral bra, sheer purple panties'); assert.strictEqual(c.expression, 'smirk, blush'); assert.strictEqual(c.pose, 'standing');
  assert.deepStrictEqual(on(state.neg.quality), ['worst quality']); assert.deepStrictEqual(on(state.neg.anatomy), ['bad anatomy']); assert.deepStrictEqual(on(state.neg.extra), ['custom neg']);
});
t('parse puis compose : le prompt reste équivalent (mêmes tags, ordre propre)', () => {
  const { state } = P.parse(PROMPT, '', n => n === 'princess_zelda' ? 4 : 0);
  const out = P.compose(state).positive;
  const norm = s => new Set(P.splitTags(s).map(P.tagKey));
  const a = norm(PROMPT), b = norm(out); [...a].forEach(k => assert.ok(b.has(k), 'tag perdu : ' + k)); assert.ok(out.startsWith('masterpiece, best quality'));
});
t('parse : plusieurs personnages et note d\'attribution', () => {
  const r = P.parse('2girls, 1boy, long hair, red dress', '', null);
  assert.strictEqual(r.state.chars.length, 3); assert.deepStrictEqual(r.state.chars.map(c => c.gender), ['girl', 'girl', 'boy']); assert.ok(r.notes.length === 1);
});
t('parse : vide et caractères étranges sans erreur', () => { assert.doesNotThrow(() => P.parse('', '', null)); assert.doesNotThrow(() => P.parse(',,, ((( ,<lora:x', 'a,,b', null)); });
t('parse : artiste (type 1) vers la catégorie Artiste', () => { const { state } = P.parse('some artist, 1girl', '', n => n === 'some_artist' ? 1 : 0); assert.deepStrictEqual(state.pos.artist.filter(x => x.on).map(x => x.t), ['some artist']); });

t('parse : personnage dont le tag contient des parenthèses (base de tags)', () => {
  const { state } = P.parse('1girl, zelda_(botw), long hair', '', n => n === 'zelda_(botw)' ? 4 : 0);
  assert.strictEqual(state.chars[0].name, 'zelda \\(botw\\)');
  assert.ok(P.compose(state).positive.includes('zelda \\(botw\\)'));
});

// ── Profils Anima ──
const anima = (mut, prof = 'anima-aesthetic') => { const s = P.defaultState(prof); mut(s); return s; };
t('score_N garde son tiret bas, quel que soit le profil', () => { assert.strictEqual(P.normTag('score_7'), 'score_7'); assert.strictEqual(P.normTag('Score 8 up'), 'score_8_up'); assert.strictEqual(P.categoryOf('score_7'), 'quality'); assert.strictEqual(P.categoryOf('score_1'), 'negQuality'); });
t('profils : Base a score_7, Aesthetic non, Turbo sans négatif', () => {
  const b = P.compose(P.defaultState('anima-base')), a = P.compose(P.defaultState('anima-aesthetic')), tu = P.compose(P.defaultState('anima-turbo'));
  assert.ok(b.positive.includes('score_7') && b.negative.includes('score_1'));
  assert.ok(!a.positive.includes('score_7') && !a.negative.includes('score_1') && a.negative.includes('chromatic aberration'));
  assert.strictEqual(tu.negative, ''); assert.strictEqual(tu.negIgnored, true);
});
t('Anima : pas de compteur de tokens, <break> ignoré', () => {
  const s = anima(x => { x.opts.useBreak = true; x.chars.push(P.newChar(1), P.newChar(2)); });
  const r = P.compose(s); assert.strictEqual(r.tokens.pos, null); assert.ok(!/break/.test(r.positive));
});
t('Anima : une phrase par personnage, position et descripteur', () => {
  const s = anima(x => {
    const a = P.newChar(1), b = P.newChar(2);
    a.position = 'on the left'; a.appearance = 'long blonde hair, blue eyes'; a.size = 'gigantic breasts'; a.outfits[0].tags = 'red dress';
    b.position = 'on the right'; b.appearance = 'short black hair'; b.size = 'flat chest'; b.outfits[0].tags = 'white shirt';
    x.chars.push(a, b); x.text.scene = 'Two friends talk in a cafe'; x.text.interaction = 'The blonde-haired woman laughs at the black-haired woman';
  });
  const r = P.compose(s);
  assert.ok(r.positive.includes('On the left, the blonde-haired woman: adult woman, long blonde hair, blue eyes, gigantic breasts, red dress.'), r.positive);
  assert.ok(r.positive.includes('On the right, the black-haired woman: adult woman, short black hair, flat chest, white shirt.'));
  assert.ok(r.positive.startsWith('masterpiece, best quality, 2girls, multiple girls'));
  assert.ok(r.positive.indexOf('Two friends') < r.positive.indexOf('On the left') && r.positive.indexOf('On the right') < r.positive.indexOf('The blonde-haired woman laughs'));
  assert.strictEqual(r.warnings.length, 0, r.warnings.join(' | '));
});
t('Anima : nom en tag puis descripteur ; série ; artiste avec @', () => {
  const s = anima(x => { const c = P.newChar(1); c.name = 'Princess_Zelda'; c.series = 'the legend of zelda'; c.appearance = 'blonde hair'; x.chars.push(c); x.pos.artist = [{ t: 'some_artist', on: true }, { t: '@other', on: true }]; });
  const r = P.compose(s); const first = r.positive.split('\n')[0];
  assert.ok(first.includes('1girl, solo, princess zelda, the legend of zelda, @some artist, @other'), first);
  assert.ok(r.positive.includes('Princess zelda: adult woman, blonde hair.'));
});
t('Anima : avertissements (deux tailles, même couleur, position, sécurité, interaction)', () => {
  const s = anima(x => { const a = P.newChar(1), b = P.newChar(2); a.appearance = 'blonde hair, large breasts'; a.size = 'huge breasts'; b.appearance = 'blonde hair'; x.chars.push(a, b); x.pos.meta.forEach(m => { if (m.t === 'safe' || m.t === 'nsfw') m.on = true; }); });
  const w = P.compose(s).warnings.join(' | ');
  ['plusieurs tailles de poitrine', 'même couleur de cheveux', 'position', 'sécurité', 'interaction'].forEach(k => assert.ok(w.includes(k), k + ' absent : ' + w));
});
t('Anima : un terme désignant un enfant est signalé', () => {
  const s = anima(x => { const a = P.newChar(1); a.details = 'child'; x.chars.push(a); });
  const w = P.compose(s).warnings.join(' | ');
  assert.ok(w.includes('enfance'), w);
});
t('Anima : personnages en tags ancrés (une ligne par personnage, scène en phrases)', () => {
  const a = P.newChar(1), b = P.newChar(2); a.position = 'on the left'; a.name = 'asuka_langley_soryu'; a.appearance = 'red hair, blue eyes'; b.position = 'on the right'; b.appearance = 'black hair, brown eyes'; b.size = 'small breasts';
  const s = anima(x => { x.opts.charStyle = 'tags'; x.text.scene = 'Two women talk at a cafe'; x.text.interaction = 'They laugh together'; x.chars.push(a, b); });
  const r = P.compose(s);
  assert.ok(/on the left: asuka langley soryu, adult woman, red hair, blue eyes/.test(r.positive), r.positive);
  assert.ok(/on the right: adult woman, black hair, brown eyes, small breasts/.test(r.positive), r.positive);
  assert.ok(!/On the left, /.test(r.positive) && /Two women talk at a cafe\./.test(r.positive) && /They laugh together\./.test(r.positive));
  assert.ok(r.positive.split('\n').length >= 4);
  const d = P.compose(anima(x => { x.chars.push(a); }));   // par défaut : phrases
  assert.ok(/On the left, asuka langley soryu:/.test(d.positive), d.positive);
});
t('Anima : ancrage adulte non doublé et désactivable', () => {
  const a = P.newChar(1); a.appearance = 'mature female, long hair';
  assert.ok(!P.compose(anima(x => x.chars.push(a))).positive.includes('adult woman'));
  const b = P.newChar(1); b.appearance = 'long hair';
  assert.ok(!P.compose(anima(x => { x.opts.adultAnchor = false; x.chars.push(b); })).positive.includes('adult woman'));
});
t('Illustrious inchangé : taille et artiste', () => {
  const r = P.compose(withState(x => { const c = P.newChar(1); c.appearance = 'long hair'; c.size = 'large breasts'; x.chars.push(c); x.pos.artist = [{ t: 'someone', on: true }]; }));
  assert.ok(/long hair, large breasts/.test(r.positive) && /someone/.test(r.positive) && !r.anima && r.tokens.pos > 0);
});
t('applyProfile : change qualité et négatif, garde le reste', () => {
  const s = P.defaultState('illustrious'); s.pos.extra.push({ t: 'keep me', on: true });
  P.applyProfile(s, 'anima-base');
  assert.strictEqual(s.profile, 'anima-base'); assert.ok(s.pos.quality.some(x => x.t === 'score_7' && x.on)); assert.ok(s.pos.extra.some(x => x.t === 'keep me'));
  assert.ok(!s.neg.anatomy.some(x => x.on));
});
t('parse : @artiste, sécurité, score et taille', () => {
  const { state } = P.parse('masterpiece, score_7, safe, 1girl, @some artist, large breasts, long hair', 'worst quality, score_1', null, 'anima-base');
  assert.deepStrictEqual(state.pos.artist.filter(x => x.on).map(x => x.t), ['@some artist']);
  assert.ok(state.pos.meta.find(x => x.t === 'safe').on); assert.ok(state.pos.quality.find(x => x.t === 'score_7').on);
  assert.strictEqual(state.chars[0].size, 'large breasts'); assert.strictEqual(state.profile, 'anima-base');
  assert.ok(state.neg.quality.find(x => x.t === 'score_1').on);
});

console.log(`\n${n} ok, ${bad} échec(s)`); process.exit(bad ? 1 : 0);
