// ── Production (BD + small sets) ─────────────────────────────────────────────────────────────────
// Prépare une BD (~15 pages) ou un small set (SFW + NSFW) : idée par chat avec un LLM local (Ollama), découpage
// page par page, prompts Illustrious ou Anima par case, analyse d'image, et calcul
// du quota d'images par jour pour tout finir avant la date de gel (ex. vendredi).
// Tout est stocké dans localStorage (clé « bd-project »).
const BD = (() => {
  const $ = id => document.getElementById(id);
  const KEY = 'bd-project';           // ancien format (un seul projet), migré vers PROJ_KEY
  const PROJ_KEY = 'bd-projects';
  const CHAT_KEY = 'bd-chat';
  const DEFAULT_URL = 'http://localhost:11434';
  const DEFAULT_MODEL = 'hf.co/mradermacher/Qwen3.5-9B-heretic-v2-GGUF:Q4_K_M';
  const NUM_CTX = 16384;
  const HIST_MSGS = 16;
  const HIST_CHARS = 24000;
  const MAX_CONTENT = 8000;
  const MAX_INPUT = 4000;
  const BATCH_PAGES = 5;
  const IMG_MAX_SIDE = 1280;
  const IMG_MAX_BYTES = 20 * 1024 * 1024;
  const IMG_MAX_PIXELS = 64e6;
  const IMG_THUMB_SIDE = 256;
  const DAYS_FR = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
  const STATES = [['todo', 'à tirer'], ['kept', 'gardée'], ['inpaint', 'à inpaint'], ['done', 'finie']];

  // ── Règles de prompt par modèle (tirées du rapport docs/prompting) ─────────
  const RULES = {
    illustrious: "Target model: Illustrious / WAI-Illustrious (SDXL, CLIP text encoder). Format: Danbooru tags in English, lowercase, separated by commas, spaces instead of underscores, about 25 to 60 tags, the most important first. Order: person count (1girl, 2girls, 1boy, 1girl 1boy), appearance, expression, outfit, pose and action, props, setting, framing and angle (close-up, portrait, upper body, cowboy shot, full body, from above, from below, from side, dutch angle), lighting. Never use Pony tags (score_9, source_anime, rating_safe). Do not write quality tags (they are added automatically). Use weights like (tag:1.2) only for one or two critical tags. Two characters: put 2girls (or 1girl, 1boy) first, keep each character's tags together, and prefer simple, clearly separated poses: overlapping bodies get mixed up by the model.",
    krea: "Target model: Krea 2 (photorealistic model whose text encoder is a language model). Write the prompt as one or two flowing paragraphs of natural English prose, never as a list of tags or keywords. Start directly with the subject. Be concrete and visual: pose, expression, clothing and fabrics, setting, props, camera framing and angle, light direction, colour palette, mood. Describe real-photo qualities when relevant (lens, depth of field, natural light). No quality tags, no rating tags, no negative prompt, no text or watermark in the image.",
    anima: "Target model: Anima (2B anime model, Qwen3 text encoder, no CLIP). Format: booru-style tags and/or natural language, in any order, lowercase tags with spaces (no underscores). Best results mix tags with one or two short natural sentences. When several characters appear, name each character first and then describe their look, otherwise attributes get mixed. Prefer Gelbooru tag names. Artist names need an @ prefix. No BREAK keyword. Do not write quality, score or rating tags (they are added automatically). Keep prompts compact: very long prompts and repeated tags make results worse. Weights work but need stronger values than SDXL.",
  };
  const MODE_RULES = {
    safe: 'Content level: not explicit. Characters are clothed or in non-sexual situations; no nudity and no sexual acts. Romance, flirting, tension and suggestive humour are fine.',
    explicit: 'Content level: explicit adult content is allowed. Use direct, standard booru tags for nudity, anatomy and sexual acts (for example nsfw, and explicit when graphic), without euphemism and without moralizing. All characters are clearly adult: use mature-looking descriptors and never any tag or wording that suggests youth. Practical tips: describe positions with clear tags, keep at most 2 characters, prefer one act per panel.',
  };
  // Niveau « dialogue explicite » du lettrage : MODE_RULES.explicit parle de tags d'images et laissait les modèles très sages sur les répliques.
  const LETTER_EXPLICIT = 'Content level: explicit adult dialogue is allowed. Characters speak plainly and graphically in their own voice during sex: dirty talk, begging, praise, vulgar words, exact vocabulary, without euphemism, without softening and without moralizing. Keep each character\'s voice extreme and recognisable (a "total slut" is vulgar and shameless, a submissive begs and stammers, a dominant commands and degrades playfully, a soft character is tender and hesitant). All characters are consenting adults.';
  const BASE_SYSTEM = "You are the co-writer and prompt engineer of a small adult (18+) comic of about 15 pages made with AI image generation. You help the user (a) find and develop the story idea by conversation, (b) break it into pages and panels, (c) write image prompts for panels, (d) explain how to prompt an image they show you. All characters are adults (18+); never write minors or age-ambiguous characters.\n"
    + "Language: talk with the user in French. Every image prompt, tag list and negative prompt is written in English.\n"
    + "Story talk: be concrete and short. Offer 2 or 3 options instead of long essays and ask at most two questions at a time. Comic constraints you must respect: a panel shows at most 2 characters (multi-character panels are costly and unreliable for the image model); every page ends on a hook or a punchline; leave empty space in the frame for speech bubbles; never put text, speech bubbles or sound effects in an image prompt."
    + "Whenever you write an image prompt, put it on one line starting with \"Prompt:\" and, if useful, a second line starting with \"Negative:\". Do not put prompts in quotes or code blocks.";
  // BD : le modèle local n'était pas fiable pour découper en cases et écrire les prompts (consignes ignorées, personnages et tenues qui changent d'une page à l'autre).
  // Pour une BD, il ne sert donc plus qu'à brainstormer l'histoire ; les prompts se font à la main ou avec « Idée → prompt » dans Txt2Img.
  const BASE_BRAINSTORM = "You are the story co-writer of a small adult (18+) comic of about 15 pages. You help the user find, develop and tighten the story idea by conversation: premise, characters and their dynamic, tone, pacing and page rhythm, twists, hooks, endings, variations of the same idea. All characters are adults (18+); never write minors or age-ambiguous characters.\n"
    + "Language: talk with the user in French. Be concrete and short: offer 2 or 3 options instead of long essays and ask at most two questions at a time. Respect every constraint the user has already given (number of pages, who appears where, what stays off-screen, outfits) and never contradict or silently drop one; if you are unsure, ask.\n"
    + "Do not write image prompts, tag lists, negative prompts or a panel-by-panel breakdown, and do not write dialogue: the user handles them. If asked, point to the Txt2Img tab (✨ Idée → prompt).";
  const BASE_SOCIAL = "You are the content strategist and prompt engineer for an AI-generated adult (18+) lifestyle persona who posts on Instagram, strictly SFW, 3 times a week. The persona is already set up in the image generator (character LoRA, model and settings are ready): you only write what changes from one post to the next. You help the user (a) find themes and ideas for posts and carousels by conversation, (b) write image prompts for the Krea 2 model, (c) write captions and hashtags, (d) explain how to prompt an image they show you. The persona is an adult (18+).\n"
    + "Language: talk with the user in French. Every image prompt is written in English prose. Captions are written in {LANG}.\n"
    + "Be concrete and short. Offer 2 or 3 options instead of essays and ask at most two questions at a time. Vary locations, outfits, light and framings across posts so the feed does not look repetitive, while the persona's look stays consistent. Never put text, logos or watermarks in an image prompt.\n"
    + "Whenever you write an image prompt, put it on one line starting with \"Prompt:\" (one flowing paragraph, no Negative line). Whenever you write a caption, put it after a line \"Caption:\".";
  const SOCIAL_LEVEL = 'Content level: strictly SFW and Instagram-safe: fully and tastefully dressed, no nudity, no lingerie shots, no sexual content or poses. Glamour, fashion, fitness, travel, cafes, golden-hour and lifestyle photography are all fine.';
  const SOCIAL_SYSTEM = "You plan Instagram posts for an AI-generated adult (18+) lifestyle persona. Output ONLY a JSON array, with no text before or after and no code fence. Each element is one image: {\"page\":1,\"case\":1,\"shot\":\"medium shot\",\"desc\":\"short English visual description: outfit, location, pose, expression, light\"} where page is the post number and case is the image number inside the post. Rules: exactly the number of posts and images per post asked; the images of a carousel show the same moment and outfit with different framings and poses; different locations and outfits from one post to the next; one person only; strictly Instagram-safe (SFW); no text in the image.\n{LEVEL}";
  const KREA_SCENE_SYSTEM = "You write the SCENE part of one image prompt for the Krea 2 model.\n{RULES}\n{LEVEL}\nThe user message describes the image. Output exactly one line: SCENE: <one flowing paragraph of 2 to 4 sentences in English>. Describe pose, expression, clothing, setting, props, camera framing and angle, light and mood. Do not describe the person's face, hair, skin or body type: a fixed description that introduces her is added automatically before your text, so refer to her only as \"she\" or \"her\" and never write any name. One person only. No tags, no quality words, no negative prompt, no text. Output only that line.";
  const CHAR_SYSTEM_KREA = "You write the fixed appearance paragraph of one adult (18+) persona, to be pasted at the start of every image prompt for consistency.\n{RULES}\nThe user message describes the persona (in any language). Output ONE paragraph of 2 to 3 sentences in English. Start with the subject, like \"A woman in her late twenties with ...\" (never with \"She\"), then give the face, eyes, hair colour and style, skin, body type and distinctive marks. No clothing, no pose, no setting, no name. Output only the paragraph.";
  const CAPTION_SYSTEM = "You write the Instagram caption for one post of an AI-generated adult (18+) lifestyle persona. Write the whole caption in {LANG} only, even if the voice description is written in another language. Write in the persona's voice (given in the user message when available). Format: 1 to 3 short lines with a hook, at most 3 emojis, a light question or call to action; then a blank line; then ALWAYS 6 to 10 relevant hashtags on one line (the caption is incomplete without them). No quotation marks around the caption. Strictly SFW. Never mention the image prompt or the generator. Output only the caption.";
  const BASE_SET = "You are the art director and prompt engineer of a small adult (18+) illustration set of about 20 images made with AI image generation: some SFW images shared on Twitter and some NSFW images exclusive to Patreon, all with one coherent theme and the same characters. You help the user (a) find and develop the set's theme and shot list by conversation, (b) write image prompts, (c) explain how to prompt an image they show you. All characters are adults (18+); never write minors or age-ambiguous characters.\n"
    + "Language: talk with the user in French. Every image prompt, tag list and negative prompt is written in English.\n"
    + "Be concrete and short. Offer 2 or 3 options instead of long essays and ask at most two questions at a time. Each image stands alone (no panels, no text, no speech bubbles in the image). Vary poses, angles, framings, locations and outfit states while keeping the same characters and the same look. At most 2 characters per image.\n"
    + "Whenever you write an image prompt, put it on one line starting with \"Prompt:\" and, if useful, a second line starting with \"Negative:\". Do not put prompts in quotes or code blocks. Always say whether a prompt is for the SFW or the NSFW tier.";
  const SET_SYSTEM = "You are an art director for adult (18+) illustration sets. Output ONLY a JSON array, with no text before or after and no code fence. Each element describes one image: {\"case\":1,\"chars\":[\"Name\"],\"shot\":\"cowboy shot\",\"desc\":\"short English visual description: pose, expression, outfit state, location, camera angle\"}. Rules: exactly the number of images asked; at most 2 characters per image (use the exact character names given); same theme and same characters across the set; vary poses, angles, framings, locations and outfit states, no near-duplicates; no text of any kind in the image; all characters are adults.\n{LEVEL}";
  const NO_LETTER = 'Lettering is off: never write dialogue, captions, narration or sound-effect text and do not propose any, the user handles it.';
  const LETTER_CHAT = 'Lettering is on: you also help with the text of the comic (dialogue, thoughts, narration, sound effects), which the user hands to a letterer. Write it in {LANG}. Ask how each character speaks when it matters (for example submissive or a total slut and how she moans; a soft and cuddly futanari or a dominant, dirty-talking one) and keep each character\'s voice consistent. Format lettering as one element per line, grouped under "Page N" (or "Page N_1", "Page N_2" when a page has several panels): "Name: spoken line", "Name thinking: thought", "Box: narration", "SFX: onomatopoeia words". Keep bubbles short. The explicitness of the lines follows the content level above.';
  const LETTER_SYSTEM = "You write the lettering (dialogue, thoughts, narration, sound effects) for ONE comic panel, to be handed to a letterer. Language: {LANG}.\n{LEVEL}\nStay strictly in each character's voice as given in the user message (personality, how they talk, how they moan). Output one element per line, nothing else: \"Name: spoken line\" (use the character's name or short name), \"Name thinking: thought\", \"Box: narration\", and at most one line \"SFX: onomatopoeia words\" (e.g. \"SFX: Rip Stretch Wobble Booiing\", with stretched spellings for long sounds). Sounds and moans inside a line are written like *Moan* or \"Mmmm~\", with a trailing ~ for teasing or pleasure. At most 3 bubbles per panel, each short (about 12 words), natural for a speech bubble. No quotation marks around the lines, no stage directions. A \"Box:\" line is only for a time or place caption or a narrator comment that adds information the picture does not show; never describe what the image already shows, and skip the Box line when there is nothing to add. Respect who does what in the panel description: the character who receives speaks as the one receiving and the one who acts speaks as the one acting; never invent anatomy or acts the description does not state. Only the characters listed for this panel may speak or think; never use any other character, even if the project has more. If nobody is speaking in the panel (empty or establishing shot, or no action between characters), output exactly: (silence) and nothing else. HARD LIMIT: at most 3 bubble lines (Name: or Name thinking:) per panel, plus at most one SFX line. Count them before answering.";
  const IMAGE_TASK = "Look carefully at the attached image. {NOTE}1) Write the prompt that would reproduce its composition for the target model, in the exact format of the rules: a line \"Prompt:\" then a line \"Negative:\". Describe appearance generically (never identify a real person). 2) Then a line \"Conseils:\" followed by 3 to 5 short bullet points in French on how to prompt it: which elements matter most, what the model will probably get wrong (hands, overlapping bodies, text), and how to simplify it (shot, number of characters) to make it work as a comic panel. {LEVEL}";
  const SCENE_SYSTEM = "You write the SCENE part of one image prompt for one comic panel.\n{RULES}\n{LEVEL}\nThe user message describes the panel (characters, shot, description). Output exactly two lines:\nCOUNT: <person-count tags, e.g. 1girl / 2girls / 1girl, 1boy / 1boy>\nSCENE: <expression, pose and action, props, setting, framing and camera, lighting>\nDo not describe the characters' hair, eyes, body or usual outfit (their fixed description is added automatically); only mention clothing if it changes in this panel. No quality tags, no rating tags, no negative prompt, no text, no speech bubbles. At most 2 characters. Output only these two lines.";
  const CHAR_SYSTEM = "You write a fixed appearance block for one comic character, to be pasted in every image prompt for consistency.\n{RULES}\nThe user message describes the character (in any language). Output ONE line only: the appearance tags in English (hair colour and style, eye colour, skin, body type, distinctive marks, usual outfit and accessories), 10 to 25 tags, comma separated. No person-count tag, no pose, no setting, no quality tags, no name. The character is an adult. Output only the line.";
  const STORY_SYSTEM = "You are a comic storyboard writer for a small adult (18+) comic. Output ONLY a JSON array, with no text before or after and no code fence. Each element describes one panel: {\"page\":1,\"case\":1,\"chars\":[\"Name\"],\"shot\":\"close-up\",\"desc\":\"short English visual description of the action, expression and setting\"}. Rules: at most 2 characters per panel (use the exact character names given); vary the shots (close-up, medium shot, wide shot, from above...); every page ends on a hook or a punchline; leave room for speech bubbles; never write dialogue, captions or text of any kind, only what is seen in the panel; all characters are adults.\n{LEVEL}";

  const DEFAULT_FMT = {
    illustrious: { pre: '', post: 'masterpiece, best quality, absurdres, newest', neg: 'lowres, worst quality, bad quality, bad anatomy, bad hands, jpeg artifacts, signature, watermark, artist name, text, old, oldest' },
    krea: { pre: '', post: '', neg: '' },
    anima: { pre: 'masterpiece, best quality, score_7,', post: '', neg: 'worst quality, low quality, score_1, score_2, score_3, artist name, blurry, jpeg artifacts, chromatic aberration, text' },
  };

  // ── Dates et planning (fonctions pures, testées hors interface) ───────────
  const pad = n => String(n).padStart(2, '0');
  const iso = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  function parseISO(s) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
    if (!m) return null;
    const d = new Date(+m[1], +m[2] - 1, +m[3]);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  function nextFriday(d) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    x.setDate(x.getDate() + ((5 - x.getDay() + 7) % 7));
    return x;
  }
  function weekdaysBetween(a, b) {
    const out = [];
    if (!a || !b) return out;
    for (let d = new Date(a.getFullYear(), a.getMonth(), a.getDate()); d <= b; d.setDate(d.getDate() + 1)) {
      if (d.getDay() !== 0 && d.getDay() !== 6) out.push(new Date(d));
    }
    return out;
  }
  function splitEven(total, slots) {
    const out = slots.map(() => 0);
    if (!slots.length) return out;
    const base = Math.floor(total / slots.length);
    let rest = total - base * slots.length;
    slots.forEach((_, i) => { out[i] = base; });
    for (let i = out.length - 1; rest > 0; i = (i - 1 + out.length) % out.length, rest--) out[i]++;
    return out;
  }

  // Calcule le total d'images et leur répartition par jour de prod.
  function plan(p, today) {
    const cases = Math.max(1, Math.round((p.kind === 'set' ? p.setSfw + p.setNsfw : p.kind === 'social' ? p.socialPosts * p.perPost : p.pages * p.cpp) + p.spare));
    const f = 1 + p.margin / 100;
    const genTotal = Math.ceil(cases * p.T * f);
    const inpTotal = Math.ceil(cases * p.I * f);
    const total = genTotal + inpTotal;
    const start = parseISO(p.start);
    const end = parseISO(p.deadline);
    const days = weekdaysBetween(start, end);
    const n = days.length;
    const rows = days.map(d => ({ date: iso(d), label: `${DAYS_FR[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, gen: 0, inp: 0, note: '' }));
    if (n) {
      const pilot = n >= 2 ? Math.min(60, Math.round(total * 0.1)) : 0;
      let genDays;
      let inpDays;
      if (n === 1) { genDays = [0]; inpDays = [0]; }
      else if (n === 2) { genDays = [0, 1]; inpDays = [1]; }
      else if (n === 3) { genDays = [1]; inpDays = [1, 2]; }
      else { genDays = []; for (let i = 1; i <= n - 2; i++) genDays.push(i); inpDays = []; for (let i = 1; i < n; i++) inpDays.push(i); }
      if (n >= 2) rows[0].gen += pilot;
      splitEven(Math.max(0, genTotal - pilot), genDays).forEach((v, i) => { rows[genDays[i]].gen += v; });
      splitEven(inpTotal, inpDays).forEach((v, i) => { rows[inpDays[i]].inp += v; });
      if (n >= 2) rows[0].note = p.kind === 'social' ? 'Thèmes des posts, 2-3 tests de prompt avec le preset' : p.kind === 'set' ? 'Thème, personnages, 2-3 tests de prompt' : 'Pré-prod : scénario, découpage, fiches perso, pilote de 8-10 cases';
      if (n >= 2) rows[n - 1].note = p.kind === 'social' ? 'Dernier jour : tri, inpaints, légendes, gel des images à 18 h' : p.kind === 'set' ? 'Dernier jour : inpaints et tri, gel des images à 18 h' : 'Dernier jour : inpaints + cases à refaire, gel des images à 18 h';
    }
    const weekdaysLeft = weekdaysBetween(today && today > start ? today : start, end).length;
    return { cases, genTotal, inpTotal, total, rows, n, weekdaysLeft };
  }

  function measured(p) {
    const kept = p.cases.filter(c => c.state !== 'todo');
    const done = p.cases.filter(c => c.state === 'done');
    const T = kept.length ? kept.reduce((a, c) => a + (c.draws || 0), 0) / kept.length : null;
    const I = done.length ? done.reduce((a, c) => a + (c.inpaints || 0), 0) / done.length : null;
    return { T, I, nKept: kept.length, nDone: done.length };
  }

  // Dates de publication : une seule pour BD / set ; pour une persona, une par post (jours choisis, à partir de la 1re date).
  function postDates(p) {
    if (p.kind !== 'social') return p.post ? [p.post] : [];
    const start = parseISO(p.post);
    if (!start || !(p.postDays || []).length) return [];
    const out = [];
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate());
    for (let guard = 0; out.length < p.socialPosts && guard < 400; guard++, d.setDate(d.getDate() + 1)) {
      if (p.postDays.includes(d.getDay())) out.push(iso(d));
    }
    return out;
  }
  // Vue d'aujourd'hui + 7 jours : quota d'images de chaque projet + publications prévues.
  function weekView(list, today) {
    const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const plans = list.map(p => plan(p, today));
    const rows = [];
    for (let i = 0; i < 8; i++) {
      const d = new Date(base.getFullYear(), base.getMonth(), base.getDate() + i);
      const key = iso(d);
      const per = plans.map(pl => { const r = pl.rows.find(x => x.date === key); return r ? r.gen + r.inp : 0; });
      const posts = list.filter(p => postDates(p).includes(key)).map(p => ({ id: p.id, title: p.title || 'Sans titre', kind: p.kind }));
      rows.push({ date: key, label: `${DAYS_FR[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}`, per, total: per.reduce((a, b) => a + b, 0), posts });
    }
    return { rows, posts: rows.reduce((a, r) => a + r.posts.length, 0) };
  }
  // Niveau de contenu d'une case : un small set a une moitié SFW (groupe 1) et une moitié NSFW (groupe 2).
  const modeOf = (p, c) => (p.kind === 'set' ? (c.page === 2 ? 'explicit' : 'safe') : p.kind === 'social' ? 'safe' : p.mode);

  // ── Analyse des réponses du LLM (fonctions pures) ─────────────────────────
  function parseJsonArray(text) {
    const t = String(text || '').replace(/```[a-z]*/gi, '').trim();
    const a = t.indexOf('[');
    const b = t.lastIndexOf(']');
    if (a >= 0 && b > a) {
      try { const v = JSON.parse(t.slice(a, b + 1)); if (Array.isArray(v)) return v; } catch { /* repli ci-dessous */ }
    }
    const out = [];
    const re = /\{[^{}]*\}/g;
    let m;
    while ((m = re.exec(t))) { try { out.push(JSON.parse(m[0])); } catch { /* objet cassé ignoré */ } }
    return out;
  }
  function normCase(o, fallbackPage, idx) {
    if (!o || typeof o !== 'object') return null;
    const page = parseInt(o.page, 10) || fallbackPage;
    const n = parseInt(o.case ?? o.panel, 10) || idx + 1;
    let chars = o.chars ?? o.characters ?? [];
    if (typeof chars === 'string') chars = chars.split(/[,;&]/);
    chars = (Array.isArray(chars) ? chars : []).map(s => String(s).trim()).filter(Boolean).slice(0, 2);
    const desc = String(o.desc ?? o.description ?? '').trim();
    if (!desc) return null;
    return { page, n, chars, shot: String(o.shot ?? '').trim(), desc };
  }
  function parseScene(text) {
    const t = String(text || '');
    const c = /^\s*COUNT\s*:\s*(.+)$/im.exec(t);
    const s = /^\s*SCENE\s*:\s*([\s\S]+)$/im.exec(t);
    if (!s) return null;
    return { count: (c ? c[1] : '').trim().replace(/[.\s]+$/, ''), scene: s[1].trim().replace(/\s*\n+\s*/g, ' ') };
  }
  function parseReplyPrompts(text) {
    const p = /^\s*Prompt\s*:\s*(.+)$/im.exec(text || '');
    const n = /^\s*Negative\s*:\s*(.+)$/im.exec(text || '');
    return { prompt: p ? p[1].trim() : '', negative: n ? n[1].trim() : '' };
  }
  // Assemble des blocs de tags ; un tag déjà présent (ex. « 1girl » dans le comptage ET dans la fiche perso) n'est gardé qu'une fois.
  function joinTags(parts) {
    const seen = new Set();
    const out = [];
    parts.map(s => String(s || '').trim().replace(/^[,\s]+|[,\s]+$/g, '')).filter(Boolean).forEach(block => {
      const kept = block.split(/\s*,\s*/).filter(tag => { const k = tag.toLowerCase(); if (!k || seen.has(k)) return false; seen.add(k); return true; });
      if (kept.length) out.push(kept.join(', '));
    });
    return out.join(', ');
  }
  function buildPrompt(p, c, count, scene) {
    const f = p.fmt[p.target];
    const blocks = (c.chars || [])
      .map(n => p.chars.find(x => x.name.trim().toLowerCase() === n.trim().toLowerCase()))
      .filter(Boolean).map(x => x.tags);
    if (p.target === 'krea') return [f.pre, ...blocks, scene, f.post].map(x => String(x || '').trim()).filter(Boolean).join(' ');
    const rating = modeOf(p, c) === 'explicit' ? 'nsfw' : (p.target === 'anima' ? 'safe' : 'general');
    return p.target === 'anima'
      ? joinTags([f.pre, rating, count, ...blocks, scene, f.post])
      : joinTags([f.pre, count, ...blocks, scene, rating, f.post]);
  }
  function buildNegative(p, mode = p.mode) {
    const f = p.fmt[p.target];
    if (p.target === 'krea') return String(f.neg || '').trim();
    return joinTags([f.neg, mode === 'safe' ? 'nsfw, explicit' : '']);
  }

  // ── État du projet ─────────────────────────────────────────────────────────
  const newId = () => 'p' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  function nextWeekday(d, wd, strict) {
    const x = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    let add = (wd - x.getDay() + 7) % 7;
    if (strict && add === 0) add = 7;
    x.setDate(x.getDate() + add);
    return x;
  }
  function defaultProject(kind = 'comic') {
    const today = new Date();
    const set = kind === 'set';
    const social = kind === 'social';
    const post = social ? nextWeekday(today, 1, true) : set ? nextWeekday(today, 3, true) : nextWeekday(today, 0, false);   // persona : lundi ; set : mercredi ; BD : dimanche
    let deadline = social ? new Date(post.getFullYear(), post.getMonth(), post.getDate() - 1) : set ? new Date(post.getFullYear(), post.getMonth(), post.getDate() - 1) : nextFriday(today);
    while (deadline.getDay() === 0 || deadline.getDay() === 6) deadline = new Date(deadline.getFullYear(), deadline.getMonth(), deadline.getDate() - 1);
    return {
      id: newId(), kind: social ? 'social' : set ? 'set' : 'comic',
      preset: '', usePresetPrompt: false, socialPosts: 3, perPost: 1, postDays: [1, 3, 5], captions: {},
      title: '', pitch: '', rules: '', letterExample: '', lettering: false, textLang: 'en', pages: 15, cpp: 1, spare: set ? 0 : social ? 1 : 2, setSfw: 9, setNsfw: 11,
      target: social ? 'krea' : 'illustrious', mode: 'safe',
      start: iso(today), deadline: iso(deadline), post: iso(post),
      T: social ? 3 : set ? 4 : 5, I: social ? 1 : 2, margin: 15, secPerImg: social ? 60 : 20, letterMin: 45,
      fmt: JSON.parse(JSON.stringify(DEFAULT_FMT)),
      chars: [], cases: [], nextId: 1,
    };
  }
  function sanitize(raw) {
    const d = defaultProject(raw && (raw.kind === 'set' || raw.kind === 'social') ? raw.kind : 'comic');
    if (!raw || typeof raw !== 'object') return d;
    const num = (v, def, min, max) => { const x = Number(v); return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def; };
    const str = (v, def, max) => (typeof v === 'string' ? v.slice(0, max) : def);
    const out = {
      id: typeof raw.id === 'string' && /^[\w-]{1,40}$/.test(raw.id) ? raw.id : d.id, kind: d.kind,
      preset: str(raw.preset, '', 200), usePresetPrompt: raw.usePresetPrompt === true,
      socialPosts: Math.round(num(raw.socialPosts, d.socialPosts, 1, 30)), perPost: Math.round(num(raw.perPost, d.perPost, 1, 10)),
      postDays: (() => { const a = (Array.isArray(raw.postDays) ? raw.postDays : []).map(Number).filter(x => Number.isInteger(x) && x >= 0 && x <= 6); const u = [...new Set(a)]; return u.length ? u : d.postDays.slice(); })(),
      captions: (() => { const o = {}; if (raw.captions && typeof raw.captions === 'object') Object.keys(raw.captions).slice(0, 60).forEach(k => { if (/^\d{1,2}$/.test(k) && typeof raw.captions[k] === 'string') o[k] = raw.captions[k].slice(0, 3000); }); return o; })(),
      setSfw: Math.round(num(raw.setSfw, d.setSfw, 0, 60)), setNsfw: Math.round(num(raw.setNsfw, d.setNsfw, 0, 60)),
      post: raw.post === '' ? '' : (parseISO(raw.post) ? raw.post : d.post),
      title: str(raw.title, '', 200), pitch: str(raw.pitch, '', 6000), rules: str(raw.rules, '', 3000), letterExample: str(raw.letterExample, '', 4000), lettering: raw.lettering === true, textLang: raw.textLang === 'fr' ? 'fr' : 'en',
      pages: Math.round(num(raw.pages, d.pages, 1, 60)), cpp: Math.round(num(raw.cpp, d.cpp, 1, 12)), spare: Math.round(num(raw.spare, d.spare, 0, 60)),
      target: d.kind === 'social' ? 'krea' : (raw.target === 'anima' ? 'anima' : 'illustrious'), mode: raw.mode === 'explicit' ? 'explicit' : 'safe',
      start: parseISO(raw.start) ? raw.start : d.start, deadline: parseISO(raw.deadline) ? raw.deadline : d.deadline,
      T: num(raw.T, d.T, 1, 40), I: num(raw.I, d.I, 0, 20), margin: num(raw.margin, d.margin, 0, 100),
      secPerImg: num(raw.secPerImg, d.secPerImg, 1, 3600), letterMin: num(raw.letterMin, d.letterMin, 5, 600),
      fmt: JSON.parse(JSON.stringify(DEFAULT_FMT)), chars: [], cases: [], nextId: 1,
    };
    for (const t of ['illustrious', 'anima', 'krea']) {
      const r = raw.fmt && raw.fmt[t];
      if (r) for (const k of ['pre', 'post', 'neg']) if (typeof r[k] === 'string') out.fmt[t][k] = r[k].slice(0, 2000);
    }
    let id = 1;
    (Array.isArray(raw.chars) ? raw.chars : []).slice(0, 12).forEach(c => {
      if (!c || typeof c !== 'object') return;
      out.chars.push({ id: id++, name: str(c.name, '', 60), desc: str(c.desc, '', 1500), tags: str(c.tags, '', 2000), voice: str(c.voice, '', 1000) });
    });
    let cid = 1;
    (Array.isArray(raw.cases) ? raw.cases : []).slice(0, 400).forEach(c => {
      if (!c || typeof c !== 'object') return;
      out.cases.push({
        id: cid++, page: Math.round(num(c.page, 1, 1, 60)), n: Math.round(num(c.n, 1, 1, 30)),
        chars: (Array.isArray(c.chars) ? c.chars : []).map(s => String(s).slice(0, 60)).slice(0, 2),
        shot: str(c.shot, '', 80), desc: str(c.desc, '', 1500), text: str(c.text, '', 3000),
        prompt: str(c.prompt, '', 4000), neg: str(c.neg, '', 2000),
        state: STATES.some(s => s[0] === c.state) ? c.state : 'todo',
        draws: Math.round(num(c.draws, 0, 0, 999)), inpaints: Math.round(num(c.inpaints, 0, 0, 999)),
        images: (Array.isArray(c.images) ? c.images : []).filter(u => typeof u === 'string' && u.length <= 500).slice(0, 60),
        pick: str(c.pick, '', 500), queued: c.queued === true,
      });
    });
    out.nextId = cid;
    return out;
  }
  let projects = [];
  let P = defaultProject();
  let migratedLegacy = false;
  function uniqueIds(list) {
    const seen = new Set();
    list.forEach(p => { while (seen.has(p.id)) p.id = newId(); seen.add(p.id); });
  }
  let loaded = false;
  function ensureLoaded() { if (!loaded) { loaded = true; loadAll(); } }
  function loadAll() {
    try {
      const v = JSON.parse(localStorage.getItem(PROJ_KEY) || 'null');
      if (v && Array.isArray(v.items) && v.items.length) {
        projects = v.items.slice(0, 30).map(sanitize);
        uniqueIds(projects);
        P = projects.find(x => x.id === v.active) || projects[0];
        return;
      }
    } catch { /* migration ci-dessous */ }
    let first = null;
    try { const old = localStorage.getItem(KEY); if (old) { first = sanitize(JSON.parse(old)); migratedLegacy = true; } } catch { /* ignoré */ }
    P = first || defaultProject('comic');
    projects = [P];
  }
  let saveTimer = null;
  function save() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(saveNow, 300);
  }
  function saveNow() {
    clearTimeout(saveTimer);
    try { localStorage.setItem(PROJ_KEY, JSON.stringify({ active: P.id, items: projects })); } catch { /* quota */ }
  }

  // ── LLM ────────────────────────────────────────────────────────────────────
  function ls(key, def) { try { const v = localStorage.getItem(key); return v === null || v === '' ? def : v; } catch { return def; } }
  let busy = false;
  let cancelFlag = false;
  async function llm(o) {
    const temp = parseFloat(ls('promptai-temp', '0.8'));
    return window.electronAPI.llmGenerate({
      url: ls('promptai-url', DEFAULT_URL),
      model: ls('promptai-model', DEFAULT_MODEL),
      numCtx: NUM_CTX,
      temperature: o.temperature ?? (Number.isFinite(temp) ? temp : 0.8),
      unload: o.unload ?? ls('bd-unload', '1') === '1',
      ...o,
    });
  }
  const levelRules = () => (P.kind === 'social' ? SOCIAL_LEVEL : P.kind === 'set'
    ? 'Content levels depend on the tier of each image. SFW tier (shared on Twitter): ' + MODE_RULES.safe + ' NSFW tier (exclusive to Patreon): ' + MODE_RULES.explicit
    : MODE_RULES[P.mode]);
  const isComic = () => P.kind !== 'set' && P.kind !== 'social';
  const lettOn = () => !isComic() && P.kind !== 'set' && P.lettering;
  // ── Lettrage des cases SFW : mesuré sur 100 tirages, le prompt seul laissait fuiter du sexuel dans ~40 % des cases quand la voix du personnage est sexuelle
  //    (« salope totale », dominante…). Prompt renforcé (~7 %) + détection et nouvelle tentative (~1 %).
  const LETTER_SAFE = 'Content level: SFW. This panel is shown to a general audience: flirting, teasing, banter, warmth and romantic tension only. Absolutely no sexual vocabulary, no body-arousal talk, no sex acts, no moaning, even if a character\'s personality is sexual: translate that personality into playful, confident, clean lines.';
  const LETTER_SAFE_VOICE = ' (in this SFW panel keep this personality but speak with clean, non-sexual wording)';
  const LETTER_SAFE_REMIND = '\nReminder: this panel is NOT sexual. Keep every line clean (flirting or teasing at most).';
  const LETTER_SAFE_SELFCHECK = '\nSelf-check before answering: if any line contains sexual words, body-arousal talk or sexual innuendo, rewrite it clean.';
  const LETTER_DETECT = "Classify the text. Answer with one word.\nEXPLICIT: sexual acts, genitals, fluids, arousal of the body, begging for sex, innuendo about bodies or touching (e.g. 'feel my warmth between your legs', 'dripping', 'use me', 'I'm so hot').\nOK: flirting, teasing, compliments, blushing, pet names, normal everyday talk.\nWhen in doubt, answer EXPLICIT.";
  const LETTER_EXPLICIT_RE = /\b(fuck\w*|cock|pussy|cum(ming)?|slut|whore|dick|wet|dripping|throbbing|breed|horny|aroused|orgasm|naked|inside me|fill me|use me|ruin me|baise\w*|encul\w*|chatte|foutre|sperme|salope|pute|jouir|jouis\w*|orgasme|bite|branl\w+)\b/i;
  const letterLevel = c => (modeOf(P, c) === 'explicit' ? LETTER_EXPLICIT : LETTER_SAFE);
  const langName = () => (P.textLang === 'fr' ? 'French' : 'English');
  function contextBlock() {
    const lines = [];
    if (P.kind === 'social') lines.push(`Project: ${P.title || '(untitled)'}. Instagram persona (SFW): ${P.socialPosts} posts of ${P.perPost} image(s), published ${postDates(P).join(', ') || 'on dates to be set'}.`);
    else if (P.kind === 'set') lines.push(`Project: ${P.title || '(untitled)'}. Small illustration set: ${P.setSfw} SFW images (shared on Twitter) + ${P.setNsfw} NSFW images (exclusive to Patreon), one coherent theme.`);
    else lines.push(`Project: ${P.title || '(untitled)'}. ${P.pages} pages, ${P.cpp === 1 ? 'one image per page' : P.cpp + ' panels per page'}.`);
    if (P.pitch.trim()) lines.push('Pitch / story so far: ' + P.pitch.trim().slice(0, 3000));
    if ((P.rules || '').trim()) lines.push('Continuity rules, to respect in every panel: ' + P.rules.trim().slice(0, 2000));
    const cs = P.chars.filter(c => c.name.trim());
    if (cs.length) lines.push('Characters:\n' + cs.map(c => `- ${c.name.trim()}: ${(c.tags || c.desc || '').trim().slice(0, 400)}${lettOn() && c.voice && c.voice.trim() ? ' | voice: ' + c.voice.trim().slice(0, 400) : ''}`).join('\n'));
    return lines.join('\n');
  }
  function exampleBlock() {
    const e = (P.letterExample || '').trim();
    return e ? '\n\nExamples of this author\'s lettering (match the tone, spelling and format, do not copy the content):\n' + e.slice(0, 4000) : '';
  }
  function chatSystem() {
    if (P.kind === 'social') return [BASE_SOCIAL.replace('{LANG}', langName()), RULES.krea, levelRules(), contextBlock()].join('\n\n');
    if (P.kind === 'set') return [BASE_SET, RULES[P.target], levelRules(), contextBlock()].join('\n\n');
    return [BASE_BRAINSTORM, contextBlock()].join('\n\n');
  }

  // ── Chat ───────────────────────────────────────────────────────────────────
  let chat = [];          // { role, content, images? }
  let attached = null;    // { url, b64 }
  const chatKey = () => CHAT_KEY + '-' + P.id;
  function loadChat() {
    try {
      const v = JSON.parse(localStorage.getItem(chatKey()) || (migratedLegacy && projects.length === 1 ? localStorage.getItem(CHAT_KEY) : null) || '[]');
      chat = (Array.isArray(v) ? v : []).filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
        .map(m => ({ role: m.role, content: m.content.slice(0, MAX_CONTENT), shown: typeof m.shown === 'string' ? m.shown.slice(0, MAX_CONTENT) : undefined })).slice(-40);
    } catch { chat = []; }
  }
  function saveChat() {
    try { localStorage.setItem(chatKey(), JSON.stringify(chat.slice(-40).map(m => ({ role: m.role, content: m.content, shown: m.shown })))); } catch { /* quota */ }
  }
  function historyToSend() {
    const past = chat;
    const out = [];
    let used = 0;
    let lastImg = -1;
    past.forEach((m, i) => { if (m.images) lastImg = i; });
    for (let i = past.length - 1; i >= 0 && out.length < HIST_MSGS; i--) {
      const m = past[i];
      used += m.content.length;
      if (used > HIST_CHARS && out.length) break;
      const e = { role: m.role, content: m.content.slice(0, MAX_CONTENT) };
      if (i === lastImg && m.images) e.images = m.images;
      out.unshift(e);
    }
    return out;
  }
  function scrollChat() { const l = $('bd-chat-list'); l.scrollTop = l.scrollHeight; }
  function chatError(text) {
    const el = document.createElement('div');
    el.className = 'pai-chat-error';
    el.textContent = text;
    $('bd-chat-list').appendChild(el);
    scrollChat();
  }
  function setStatus(msg, isErr = false) {
    const el = $('bd-status');
    el.textContent = msg || '';
    el.classList.toggle('error', !!isErr);
  }
  function miniBtn(label, fn) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'pai-mini';
    b.textContent = label;
    b.addEventListener('click', () => fn(b));
    return b;
  }
  async function copyText(btn, text) {
    const old = btn.textContent;
    try { await navigator.clipboard.writeText(text); btn.textContent = 'Copié'; } catch { btn.textContent = 'Échec'; }
    setTimeout(() => { btn.textContent = old; }, 1500);
  }
  function sendToTxt2Img(prompt, negative) {
    const pos = $('inp-positive');
    if (!pos) return;
    pos.value = prompt;
    pos.dispatchEvent(new Event('input', { bubbles: true }));
    if (negative) {
      const neg = $('inp-negative');
      if (neg) { neg.value = negative; neg.dispatchEvent(new Event('input', { bubbles: true })); }
    }
    if (typeof switchTab === 'function') switchTab('txt2img');
  }
  function addMessage(role, text, opts = {}) {
    const msg = document.createElement('div');
    msg.className = 'pai-msg ' + role + (opts.pending ? ' pending' : '');
    const bubble = document.createElement('div');
    bubble.className = 'pai-bubble bd-bubble';
    if (opts.thumb) {
      const img = document.createElement('img');
      img.className = 'pai-thumb';
      img.alt = '';
      img.src = opts.thumb;
      bubble.appendChild(img);
    }
    bubble.appendChild(document.createTextNode(text));
    msg.appendChild(bubble);
    if (role === 'assistant' && !opts.pending) {
      const actions = document.createElement('div');
      actions.className = 'pai-msg-actions';
      const pr = parseReplyPrompts(text);
      if (pr.prompt) {
        actions.appendChild(miniBtn('→ Txt2Img', () => sendToTxt2Img(pr.prompt, pr.negative || buildNegative(P))));
        actions.appendChild(miniBtn('Copier le prompt', b => copyText(b, pr.prompt)));
      }
      actions.appendChild(miniBtn('↳ Ajouter au pitch', () => {
        P.pitch = (P.pitch.trim() ? P.pitch.trim() + '\n\n' : '') + text;
        $('bd-pitch').value = P.pitch;
        save();
        setStatus('Ajouté au pitch du projet.');
      }));
      actions.appendChild(miniBtn('Copier', b => copyText(b, text)));
      msg.appendChild(actions);
    }
    $('bd-chat-list').appendChild(msg);
    scrollChat();
    return msg;
  }
  function renderChat() {
    $('bd-chat-list').textContent = '';
    chat.forEach(m => addMessage(m.role, m.shown ?? m.content));
  }
  function setBusy(b, label) {
    busy = b;
    ['bd-send', 'bd-img-task', 'bd-gen-cases', 'bd-gen-prompts', 'bd-gen-text', 'bd-gen-captions'].forEach(id => { const el = $(id); if (el) el.disabled = b; });
    $('bd-cancel').hidden = !b || !label;
    if (label) setStatus(label);
  }

  async function sendChat(shown, full, withImage) {
    if (busy) { chatError('Une autre génération est déjà en cours.'); return; }
    const input = $('bd-input');
    const img = withImage ? attached : null;
    setBusy(true);
    input.value = '';
    if (img) { setAttach(null); chat.forEach(m => { delete m.images; }); }
    chat.push({ role: 'user', content: full, shown, ...(img ? { images: [img.b64] } : {}) });
    const userMsg = addMessage('user', shown, { thumb: img?.url });
    const pending = addMessage('assistant', '…', { pending: true });
    const history = historyToSend().slice(0, -1);
    try {
      const r = await llm({ system: chatSystem(), prompt: full, history, ...(img ? { images: [img.b64] } : {}) });
      if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
      pending.remove();
      chat.push({ role: 'assistant', content: r.text });
      addMessage('assistant', r.text);
      saveChat();
      setStatus('');
    } catch (e) {
      pending.remove();
      userMsg.remove();
      chat.pop();
      if (!input.value) input.value = shown === full ? full : shown;
      if (img && !attached) setAttach(img);
      chatError(e.message || String(e));
    } finally {
      setBusy(false);
    }
  }
  function onSend() {
    if (busy) return;
    const text = $('bd-input').value.trim();
    if (!text && !attached) return;
    $('bd-chat-list').querySelectorAll('.pai-chat-error').forEach(el => el.remove());
    if (text.length > MAX_INPUT) { chatError(`Message trop long (max ${MAX_INPUT} caractères).`); return; }
    if (attached) { imageTask(text); return; }
    sendChat(text, text, false);
  }
  function imageTask(note) {
    if (busy || !attached) return;
    $('bd-chat-list').querySelectorAll('.pai-chat-error').forEach(el => el.remove());
    let full = IMAGE_TASK.replace('{NOTE}', note ? `The user adds: ${note}\n` : '').replace('{LEVEL}', levelRules());
    if (P.target === 'krea') full = full.replace(' then a line "Negative:"', ' (one flowing paragraph of prose, no tags; Krea 2 has no negative prompt, so write no Negative line)');
    const tname = P.target === 'anima' ? 'Anima' : 'Illustrious';
    sendChat(`Comment prompter cette image (${tname}, ${P.mode === 'explicit' ? 'explicite' : 'non explicite'}) ?` + (note ? '\n' + note : ''), full, true);
  }

  // ── Image jointe (même traitement que le chat « Idée → prompt ») ───────────
  function setAttach(obj) {
    attached = obj;
    const box = $('bd-attach');
    box.textContent = '';
    if (obj) {
      const img = document.createElement('img');
      img.className = 'pai-attach-thumb';
      img.alt = '';
      img.src = obj.url;
      box.append(img, miniBtn('✕', () => setAttach(null)));
    }
    box.hidden = !obj;
    $('bd-img-task').hidden = !obj;
  }
  async function attachFile(file) {
    if (!file || !file.type.startsWith('image/')) { chatError('Ce fichier n\'est pas une image.'); return; }
    if (file.size > IMG_MAX_BYTES) { chatError('Image trop lourde (max 20 Mo).'); return; }
    try {
      const bmp = await createImageBitmap(file);
      if (bmp.width * bmp.height > IMG_MAX_PIXELS) { bmp.close(); chatError('Image trop grande : réduis-la avant de la joindre.'); return; }
      const scale = Math.min(1, IMG_MAX_SIDE / Math.max(bmp.width, bmp.height));
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bmp.width * scale));
      canvas.height = Math.max(1, Math.round(bmp.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close();
      const full = canvas.toDataURL('image/jpeg', 0.85);
      const ts = Math.min(1, IMG_THUMB_SIDE / Math.max(canvas.width, canvas.height));
      const small = document.createElement('canvas');
      small.width = Math.max(1, Math.round(canvas.width * ts));
      small.height = Math.max(1, Math.round(canvas.height * ts));
      small.getContext('2d').drawImage(canvas, 0, 0, small.width, small.height);
      setAttach({ url: small.toDataURL('image/jpeg', 0.8), b64: full.slice(full.indexOf(',') + 1) });
    } catch { chatError('Impossible de lire cette image.'); }
  }

  // ── Personnages ────────────────────────────────────────────────────────────
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }
  function renderChars() {
    const box = $('bd-chars');
    box.textContent = '';
    P.chars.forEach(c => {
      const row = el('div', 'bd-char');
      const name = el('input', 'inp');
      name.type = 'text'; name.placeholder = 'Nom (ex. Mia)'; name.value = c.name; name.maxLength = 60;
      name.addEventListener('input', () => { c.name = name.value; save(); });
      const desc = el('textarea', 'prompt');
      desc.rows = 2; desc.placeholder = 'Description libre (français ok) : « blonde musclée, tatouage au bras… »'; desc.value = c.desc;
      desc.addEventListener('input', () => { c.desc = desc.value; save(); });
      const tags = el('textarea', 'prompt');
      tags.rows = 2; tags.placeholder = 'Bloc de tags figé, collé dans chaque prompt'; tags.value = c.tags;
      tags.addEventListener('input', () => { c.tags = tags.value; save(); });
      const voice = el('textarea', 'prompt bd-voice');
      voice.rows = 2; voice.maxLength = 1000; voice.value = c.voice || '';
      voice.placeholder = P.kind === 'social' ? 'Ton des légendes : complice, drôle, élégante, tutoie ses abonnés…' : 'Voix pour le lettrage : soumise ou totale salope, comment elle gémit… / futa douce et câline, ou dominante et dirty talk…';
      voice.addEventListener('input', () => { c.voice = voice.value; save(); });
      voice.hidden = !(lettOn() || P.kind === 'social');
      tags.id = 'bd-char-tags-' + c.id;   // le sélecteur de personnages (onglet Txt2Img) écrit dans un champ repéré par son id
      const actions = el('div', 'bd-char-actions');
      actions.append(
        ...(P.target === 'krea' || typeof CharSelector === 'undefined' ? [] : [
          miniBtn('👤 Choisir dans Personnages', () => { CharSelector.toggleFor(tags.id); }),
        ]),
        miniBtn('✨ Tags depuis la description', async b => {
          if (busy) return;
          const text = (c.desc || '').trim() || (c.name || '').trim();
          if (!text) { setStatus('Décris le personnage d\'abord.', true); return; }
          setBusy(true, 'Génération des tags…');
          b.disabled = true;
          try {
            const r = await llm({ system: (P.target === 'krea' ? CHAR_SYSTEM_KREA : CHAR_SYSTEM).replace('{RULES}', RULES[P.target]), prompt: text, temperature: 0.5 });
            if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
            c.tags = r.text.replace(/\n+/g, ' ').trim();
            tags.value = c.tags;
            save();
            setStatus('Tags générés : relis-les.');
          } catch (e) { setStatus(e.message || String(e), true); }
          finally { b.disabled = false; setBusy(false); }
        }),
        miniBtn('Supprimer', () => { P.chars = P.chars.filter(x => x !== c); save(); renderChars(); }),
      );
      row.append(name, desc, tags, voice, actions);
      box.appendChild(row);
    });
  }

  // ── Découpage ──────────────────────────────────────────────────────────────
  function sortCases() { P.cases.sort((a, b) => a.page - b.page || a.n - b.n); }
  async function confirmBox(title, html, okLabel) {
    if (typeof uiConfirm === 'function') return uiConfirm({ title, html, okLabel });
    return confirm(title);
  }
  async function genSet() {
    if (busy) return;
    if (!P.pitch.trim() && !chat.length) { setStatus('Discute d\'abord du thème du set (chat) ou écris-le dans le pitch.', true); return; }
    if (P.cases.length && !await confirmBox('Remplacer la liste ?', '<p>Les images actuelles (prompts, états, compteurs) seront remplacées.</p>', 'Remplacer')) return;
    cancelFlag = false;
    setBusy(true, 'Liste d\'images…');
    const out = [];
    try {
      const history = historyToSend();
      const tiers = [[1, P.setSfw], [2, P.setNsfw]].filter(t => t[1] > 0);
      for (let k = 0; k < tiers.length && !cancelFlag; k++) {
        const [tier, count] = tiers[k];
        const label = tier === 1 ? 'SFW' : 'NSFW';
        setStatus(`Idées ${label} (${count})…`);
        const prev = out.length ? '\nImages already planned (same theme and outfits, but these new ones must be different poses and framings):\n' + out.map(c => '- ' + c.desc).join('\n') : '';
        const what = tier === 1 ? 'SFW tier (shared on Twitter: teasing and attractive but not explicit, no nudity)' : 'NSFW tier (exclusive to Patreon: explicit adult content)';
        const prompt = `${contextBlock()}\n\nWrite exactly ${count} image ideas for the ${what} of this set. Follow the theme agreed in the conversation.${prev}`;
        const r = await llm({ system: SET_SYSTEM.replace('{LEVEL}', MODE_RULES[tier === 1 ? 'safe' : 'explicit']), prompt, history, temperature: 0.7, unload: k === tiers.length - 1 && ls('bd-unload', '1') === '1' });
        if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
        const items = parseJsonArray(r.text).map((o, i) => normCase(o, tier, i)).filter(Boolean).slice(0, count);
        if (!items.length) throw new Error(`Réponse inexploitable pour la partie ${label} (JSON invalide). Réessaie.`);
        items.forEach((c, i) => out.push({ ...c, page: tier, n: i + 1 }));
      }
      if (cancelFlag) { setStatus('Annulé : rien n\'a été remplacé.'); return; }
      P.cases = out.map((c, i) => ({ id: i + 1, ...c, text: '', prompt: '', neg: '', state: 'todo', draws: 0, inpaints: 0, images: [], pick: '', queued: false }));
      P.nextId = P.cases.length + 1;
      sortCases();
      saveNow();
      renderBoard();
      renderPlan();
      setStatus(`${P.cases.length} images prévues. Vérifie-les, puis génère les prompts.`);
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }
  async function genPosts() {
    if (busy) return;
    if (!P.pitch.trim() && !chat.length) { setStatus('Discute d\'abord des thèmes (chat) ou écris-les dans le pitch.', true); return; }
    if (P.cases.length && !await confirmBox('Remplacer les posts ?', '<p>Les images actuelles (prompts, états, compteurs) seront remplacées ; les légendes sont conservées.</p>', 'Remplacer')) return;
    cancelFlag = false;
    setBusy(true, 'Planning des posts…');
    const out = [];
    try {
      const history = historyToSend();
      const who = (P.chars.find(c => c.name.trim()) || {}).name || '';
      for (let a = 1; a <= P.socialPosts && !cancelFlag; a += 6) {
        const b = Math.min(P.socialPosts, a + 5);
        setStatus(`Posts ${a} à ${b} sur ${P.socialPosts}…`);
        const prev = out.length ? '\nPosts already planned (use different locations and outfits):\n' + out.slice(-12).map(c => `post ${c.page}: ${c.desc}`).join('\n') : '';
        const prompt = `${contextBlock()}\n\nPlan posts ${a} to ${b} (of ${P.socialPosts}), exactly ${P.perPost} image${P.perPost > 1 ? 's' : ''} per post. Follow the themes agreed in the conversation.${prev}`;
        const r = await llm({ system: SOCIAL_SYSTEM.replace('{LEVEL}', SOCIAL_LEVEL), prompt, history, temperature: 0.7, unload: b === P.socialPosts && ls('bd-unload', '1') === '1' });
        if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
        const items = parseJsonArray(r.text).map((o, i) => normCase(o, a, i)).filter(Boolean).filter(c => c.page >= a && c.page <= b);
        if (!items.length) throw new Error(`Réponse inexploitable pour les posts ${a}-${b} (JSON invalide). Réessaie.`);
        const per = {};
        items.forEach(c => { (per[c.page] = per[c.page] || []).push(c); });
        Object.values(per).forEach(list => list.slice(0, P.perPost).forEach((c, i) => out.push({ ...c, n: i + 1, chars: who ? [who] : [] })));
      }
      if (cancelFlag) { setStatus('Annulé : rien n\'a été remplacé.'); return; }
      P.cases = out.map((c, i) => ({ id: i + 1, ...c, text: '', prompt: '', neg: '', state: 'todo', draws: 0, inpaints: 0, images: [], pick: '', queued: false }));
      P.nextId = P.cases.length + 1;
      sortCases();
      saveNow();
      renderBoard();
      renderPlan();
      setStatus(`${P.cases.length} images prévues pour ${P.socialPosts} posts. Vérifie-les, puis génère les prompts.`);
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }
  async function genCaption(pg, unloadAfter = true) {
    const imgs = P.cases.filter(c => c.page === pg).sort((a, b) => a.n - b.n);
    if (!imgs.length) throw new Error(`Le post ${pg} n'a pas d'image.`);
    const who = P.chars.find(c => c.name.trim());
    const persona = who ? `Persona: ${who.name.trim()}. ${(who.desc || who.tags || '').trim().slice(0, 300)}\nVoice: ${(who.voice || '(natural, warm)').trim().slice(0, 300)}\n` : '';
    const theme = P.pitch.trim() ? `Overall theme / account positioning: ${P.pitch.trim().slice(0, 600)}\n` : '';
    const prompt = `${persona}${theme}Post ${pg} (${imgs.length} image${imgs.length > 1 ? 's' : ''}):\n${imgs.map(c => '- ' + c.desc).join('\n')}\n\nWrite the caption.`;
    const r = await llm({ system: CAPTION_SYSTEM.replace('{LANG}', langName()), prompt, temperature: 0.8, unload: unloadAfter && ls('bd-unload', '1') === '1' });
    if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
    P.captions[String(pg)] = r.text.trim();
  }
  async function genCaptions(onlyMissing = true) {
    if (busy) return;
    const posts = [...new Set(P.cases.map(c => c.page))].sort((a, b) => a - b).filter(pg => !onlyMissing || !(P.captions[String(pg)] || '').trim());
    if (!posts.length) { setStatus('Toutes les légendes sont déjà écrites (ou il n\'y a pas de post).'); return; }
    cancelFlag = false;
    setBusy(true, 'Légendes…');
    let n = 0;
    try {
      for (const pg of posts) {
        if (cancelFlag) break;
        setStatus(`Légende ${++n}/${posts.length} (post ${pg})…`);
        await genCaption(pg, n === posts.length);
        saveNow();
        renderBoard();
      }
      setStatus(cancelFlag ? `Annulé après ${n - 1} légende(s).` : `${posts.length} légende(s) écrites.`);
    } catch (e) { setStatus(e.message || String(e), true); renderBoard(); }
    finally { setBusy(false); }
  }
  async function genCases() {
    if (P.kind === 'social') return genPosts();
    if (P.kind === 'set') return genSet();
    if (busy) return;
    if (!P.pitch.trim() && !chat.length) { setStatus('Écris ou discute d\'abord l\'idée (pitch ou chat).', true); return; }
    if (P.cases.length && !await confirmBox('Remplacer le découpage ?', '<p>Les cases actuelles (prompts, états, compteurs) seront remplacées.</p>', 'Remplacer')) return;
    cancelFlag = false;
    setBusy(true, 'Découpage…');
    const out = [];
    try {
      const history = historyToSend();
      for (let a = 1; a <= P.pages && !cancelFlag; a += BATCH_PAGES) {
        const b = Math.min(P.pages, a + BATCH_PAGES - 1);
        setStatus(`Découpage des pages ${a} à ${b} sur ${P.pages}…`);
        const prev = out.length ? '\nPanels already written (keep continuity):\n' + out.slice(-12).map(c => `p${c.page}c${c.n}: ${c.desc}`).join('\n') : '';
        const prompt = `${contextBlock()}\n\nWrite the panels for pages ${a} to ${b} (of ${P.pages} pages in total), ${P.cpp === 1 ? 'exactly one single full-page image (one panel)' : 'exactly ' + P.cpp + ' panels'} per page${a === 1 ? ', starting the story' : ''}${b === P.pages ? ', ending the story on the last page' : ''}. Follow the story agreed in the conversation.${prev}`;
        const r = await llm({ system: STORY_SYSTEM.replace('{LEVEL}', levelRules()), prompt, history, temperature: 0.5, unload: b === P.pages && ls('bd-unload', '1') === '1' });
        if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
        const items = parseJsonArray(r.text).map((o, i) => normCase(o, a, i)).filter(Boolean).filter(c => c.page >= a && c.page <= b);
        if (!items.length) throw new Error(`Réponse inexploitable pour les pages ${a}-${b} (JSON invalide). Réessaie.`);
        const perPage = {};
        items.forEach(c => { (perPage[c.page] = perPage[c.page] || []).push(c); });
        Object.values(perPage).forEach(list => list.slice(0, P.cpp).forEach((c, i) => out.push({ ...c, n: i + 1 })));
      }
      if (cancelFlag) { setStatus('Découpage annulé : rien n\'a été remplacé.'); return; }
      P.cases = out.map((c, i) => ({ id: i + 1, ...c, text: '', prompt: '', neg: '', state: 'todo', draws: 0, inpaints: 0, images: [], pick: '', queued: false }));
      P.nextId = P.cases.length + 1;
      sortCases();
      saveNow();
      renderBoard();
      renderPlan();
      setStatus(`${P.cases.length} cases créées. Vérifie-les, puis génère les prompts.`);
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }
  async function genPrompt(c, unloadAfter = true) {
    const names = c.chars.length ? c.chars.join(' + ') : '(no named character)';
    let panel = c.desc;
    if (P.target === 'krea') {   // Krea 2 ne connaît pas le prénom de la persona : on le retire de la description
      P.chars.map(x => x.name.trim()).filter(Boolean).forEach(n => { panel = panel.replace(new RegExp(n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + "('s)?", 'gi'), (m, poss) => (poss ? "the woman's" : 'the woman')); });
    }
    const prompt = P.target === 'krea' ? `Shot: ${c.shot || 'free choice'}\nImage: ${panel}` : `Characters: ${names}\nShot: ${c.shot || 'free choice'}\nPanel: ${panel}`;
    const level = P.kind === 'social' ? SOCIAL_LEVEL : MODE_RULES[modeOf(P, c)];
    const r = await llm({ system: (P.target === 'krea' ? KREA_SCENE_SYSTEM : SCENE_SYSTEM).replace('{RULES}', RULES[P.target]).replace('{LEVEL}', level), prompt, temperature: 0.6, unload: unloadAfter && ls('bd-unload', '1') === '1' });
    if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
    const s = parseScene(r.text);
    if (!s) throw new Error('Format de réponse inattendu pour la case p' + c.page + 'c' + c.n + '.');
    c.prompt = buildPrompt(P, c, s.count, s.scene);
    c.neg = buildNegative(P, modeOf(P, c));
  }
  async function genPrompts(onlyMissing = true) {
    if (busy) return;
    const todo = P.cases.filter(c => !onlyMissing || !c.prompt.trim());
    if (!todo.length) { setStatus('Toutes les cases ont déjà un prompt.'); return; }
    cancelFlag = false;
    setBusy(true, 'Prompts…');
    let n = 0;
    try {
      for (const c of todo) {
        if (cancelFlag) break;
        setStatus(`Prompt ${++n}/${todo.length} (page ${c.page}, case ${c.n})…`);
        await genPrompt(c, n === todo.length);
        saveNow();
        renderBoard();
      }
      setStatus(cancelFlag ? `Annulé après ${n - 1} prompt(s).` : `${todo.length} prompt(s) générés.`);
    } catch (e) { setStatus(e.message || String(e), true); renderBoard(); }
    finally { setBusy(false); }
  }
  // Rappel de langue en fin de message : sans lui, les consignes anglaises du niveau SFW faisaient répondre en anglais (0 réponse française sur 40 mesurée).
  const letterLangTail = () => (P.textLang === 'fr'
    ? '\nWrite every line in French (the voice notes may be in English, but the characters speak French).'
    : '\nWrite every line in English.');
  // Case explicitement muette (« personne ne parle », « sans dialogue »…) : pas la peine d'appeler le modèle, qui ne répond « (silence) » que 7 fois sur 10.
  const isSilentPanel = d => /\b(silent|wordless|no dialogue|no dialog|no one (is )?(speak|talk)|nobody (is )?(speak|talk)|sans dialogue|silencieu\w*|muet\w*|personne ne (parle|dit))/i.test(String(d || ''));
  // Retire les répliques de personnages absents de la case (les modèles inventent parfois un interlocuteur du projet). Les noms courts sont acceptés.
  function keepPresent(text, chars) {
    const names = (chars || []).map(n => String(n).trim().toLowerCase()).filter(Boolean);
    if (!names.length) return text;
    const first = n => n.split(/\s+/)[0];
    const kept = String(text).split('\n').filter(l => {
      const m = l.match(/^\s*([^:\n]{1,40}?)(?:\s+thinking)?\s*:/i);
      if (!m) return true;
      const who = m[1].trim().toLowerCase();
      if (who === 'box' || who === 'sfx') return true;
      return names.some(n => n === who || first(n) === first(who));
    });
    return kept.some(l => l.trim()) ? kept.join('\n') : text;
  }
  async function genText(c, unloadAfter = true) {
    if (isSilentPanel(c.desc)) { c.text = '(silence)'; return; }
    const idx = P.cases.indexOf(c);
    const safe = modeOf(P, c) !== 'explicit';
    const voice = n => { const x = P.chars.find(k => k.name.trim().toLowerCase() === n.trim().toLowerCase()); return (x && x.voice && x.voice.trim() ? x.voice.trim().slice(0, 400) : '(no voice given: keep it natural)') + (safe ? LETTER_SAFE_VOICE : ''); };
    const voices = c.chars.length ? c.chars.map(n => `- ${n}: ${voice(n)}`).join('\n') : '(no named character)';
    const prev = P.cases.slice(Math.max(0, idx - 3), idx).filter(x => x.text && x.text.trim()).map(x => `p${x.page}c${x.n}: ${x.text.trim().replace(/\n+/g, ' / ')}`).join('\n');
    const prompt = `${contextBlock()}\n\nPanel (page ${c.page}, case ${c.n}, shot: ${c.shot || 'free'}): ${c.desc}\nCharacters in the panel and their voices:\n${voices}${prev ? '\nPrevious lettering, for continuity:\n' + prev : ''}\n\nWrite the lettering for this panel.${safe ? LETTER_SAFE_REMIND : ''}${letterLangTail()}`;
    const unload = unloadAfter && ls('bd-unload', '1') === '1';
    const system = LETTER_SYSTEM.replace('{LANG}', langName()).replace('{LEVEL}', letterLevel(c)) + exampleBlock() + (safe ? LETTER_SAFE_SELFCHECK : '');
    // Garde-fou SFW : on détecte (lexique + petit appel de classification) et on refait, 3 essais au plus. Un faux positif ne coûte qu'une régénération.
    const flagged = async t => {
      if (LETTER_EXPLICIT_RE.test(t)) return true;
      const d = await llm({ system: LETTER_DETECT, prompt: 'Text:\n' + t, temperature: 0, unload: false });
      return !!(d && !d.error && /EXPLICIT/i.test(String(d.text || '').slice(0, 14)));
    };
    let r = null;
    for (let tries = 1; tries <= 3; tries++) {
      const last = tries === 3;
      r = await llm({ system, prompt, temperature: tries === 1 ? 0.8 : 0.7, unload: unload && (!safe || last) });
      if (!r || r.error || !safe || last) break;
      if (!(await flagged(r.text || ''))) {
        if (unload) await llm({ system: LETTER_DETECT, prompt: 'Text:\nok', temperature: 0, unload: true });   // décharge le modèle une fois fini
        break;
      }
    }
    if (!r || r.error) throw new Error(r?.error || 'Réponse invalide.');
    c.text = keepPresent(r.text.trim(), c.chars).trim();
  }
  async function genTexts(onlyMissing = true) {
    if (busy) return;
    const todo = P.cases.filter(c => c.desc.trim() && (!onlyMissing || !(c.text || '').trim()));
    if (!todo.length) { setStatus('Aucune case à lettrer (toutes ont déjà un texte, ou pas de description).'); return; }
    cancelFlag = false;
    setBusy(true, 'Lettrage…');
    let n = 0;
    try {
      for (const c of todo) {
        if (cancelFlag) break;
        setStatus(`Lettrage ${++n}/${todo.length} (page ${c.page}, case ${c.n})…`);
        await genText(c, n === todo.length);
        saveNow();
        renderBoard();
      }
      setStatus(cancelFlag ? `Annulé après ${n - 1} case(s).` : `${todo.length} case(s) lettrées.`);
    } catch (e) { setStatus(e.message || String(e), true); renderBoard(); }
    finally { setBusy(false); }
  }
  function letteringSheet() {
    sortCases();
    const L = [`# Feuille de lettrage${P.title ? ' — ' + P.title : ''}`, ''];
    [...new Set(P.cases.map(c => c.page))].forEach(pg => {
      const cs = P.cases.filter(c => c.page === pg);
      cs.forEach((c, i) => {
        const beat = (c.desc || '').replace(/\s+/g, ' ').trim();
        L.push(`**Page ${pg}${cs.length > 1 ? '_' + (i + 1) : ''}** — ${beat.length > 110 ? beat.slice(0, 107) + '…' : beat}`);
        const t = (c.text || '').trim();
        L.push(t ? t.split('\n').map(l => '- ' + l.trim()).filter(l => l !== '-').join('\n') : '- _(pas de texte)_', '');
      });
    });
    return L.join('\n');
  }
  function renderBoard() {
    const box = $('bd-board');
    box.textContent = '';
    const set = P.kind === 'set';
    if (!P.cases.length && !set && !social) {
      box.appendChild(el('div', 'bd-empty', 'Aucune case. Discute de ton idée dans « Idée & chat », puis clique sur « Générer le découpage » (ou ajoute des cases à la main).'));
      return;
    }
    if (!P.cases.length && set) box.appendChild(el('div', 'bd-empty', 'Aucune image. Discute du thème dans « Idée & chat », puis clique sur « Générer la liste d\'images » (ou ajoute des images à la main).'));
    sortCases();
    const social = P.kind === 'social';
    const pages = set ? [1, 2] : social ? Array.from({ length: P.socialPosts }, (_, i) => i + 1) : [...new Set(P.cases.map(c => c.page))];
    pages.forEach(pg => {
      const sec = el('div', 'bd-page');
      const head = el('div', 'bd-page-head');
      const nIn = P.cases.filter(c => c.page === pg).length;
      const pdate = social ? postDates(P)[pg - 1] : '';
      head.append(el('b', '', set ? (pg === 1 ? `SFW — Twitter (${nIn}/${P.setSfw})` : `NSFW — Patreon (${nIn}/${P.setNsfw})`) : social ? `Post ${pg}${pdate ? ' — ' + dateLabel(pdate) : ''} (${nIn}/${P.perPost})` : `Page ${pg}`), miniBtn('+ case', () => {
        const same = P.cases.filter(c => c.page === pg);
        P.cases.push({ id: P.nextId++, page: pg, n: Math.max(0, ...same.map(c => c.n)) + 1, chars: [], shot: '', desc: '', text: '', prompt: '', neg: '', state: 'todo', draws: 0, inpaints: 0, images: [], pick: '', queued: false });
        save(); renderBoard(); renderPlan();
      }));
      sec.appendChild(head);
      if (social) {
        const cap = el('textarea', 'prompt bd-caption');
        cap.rows = 3; cap.maxLength = 3000; cap.placeholder = 'Légende Instagram + hashtags (générée, modifiable)';
        cap.value = P.captions[String(pg)] || '';
        cap.addEventListener('input', () => { P.captions[String(pg)] = cap.value; save(); });
        const capBtn = miniBtn('✍️ Légende', async b => {
          if (busy) return;
          setBusy(true, `Légende du post ${pg}…`);
          b.disabled = true;
          try { await genCaption(pg); saveNow(); renderBoard(); setStatus('Légende générée.'); }
          catch (e) { setStatus(e.message || String(e), true); b.disabled = false; }
          finally { setBusy(false); }
        });
        const capRow = el('div', 'bd-caption-row');
        capRow.append(cap, capBtn);
        sec.appendChild(capRow);
      }
      P.cases.filter(c => c.page === pg).forEach(c => sec.appendChild(caseRow(c)));
      box.appendChild(sec);
    });
  }
  function caseRow(c) {
    const row = el('div', 'bd-case state-' + c.state);
    const top = el('div', 'bd-case-top');
    const label = el('span', 'bd-case-n', `${P.kind === 'set' || P.kind === 'social' ? 'Image' : 'Case'} ${c.n}`);
    const chars = el('input', 'inp bd-chars-in');
    chars.type = 'text'; chars.placeholder = 'Persos (noms, virgule)'; chars.value = c.chars.join(', ');
    chars.addEventListener('input', () => { c.chars = chars.value.split(',').map(s => s.trim()).filter(Boolean).slice(0, 2); save(); });
    const shot = el('input', 'inp bd-shot-in');
    shot.type = 'text'; shot.placeholder = 'Plan'; shot.value = c.shot;
    shot.addEventListener('input', () => { c.shot = shot.value; save(); });
    const state = el('select', 'inp bd-state');
    STATES.forEach(([v, l]) => { const o = el('option', '', l); o.value = v; state.appendChild(o); });
    state.value = c.state;
    state.addEventListener('change', () => { c.state = state.value; row.className = 'bd-case state-' + c.state; save(); renderPlan(); });
    const num = (key, title) => {
      const w = el('label', 'bd-num');
      w.title = title;
      const i = el('input', 'inp');
      i.type = 'number'; i.min = '0'; i.max = '999'; i.value = String(c[key]);
      i.addEventListener('input', () => { c[key] = Math.max(0, Math.min(999, parseInt(i.value, 10) || 0)); save(); renderPlan(); });
      w.append(el('span', '', key === 'draws' ? 'tirages' : 'inpaints'), i);
      return w;
    };
    top.append(label, chars, shot, state, num('draws', 'Images tirées pour cette case'), num('inpaints', 'Passes d\'inpaint faites'));
    const desc = el('textarea', 'prompt');
    desc.rows = 2; desc.placeholder = 'Description visuelle de la case (anglais de préférence)'; desc.value = c.desc;
    desc.addEventListener('input', () => { c.desc = desc.value; save(); });
    const text = el('textarea', 'prompt bd-text');
    text.rows = 3; text.placeholder = 'Lettrage (dialogues, pensées, SFX) pour le lettreur';
    text.value = c.text || '';
    text.addEventListener('input', () => { c.text = text.value; save(); });
    text.hidden = !lettOn();
    const prompt = el('textarea', 'prompt');
    prompt.rows = 3; prompt.placeholder = 'Prompt final (généré, modifiable)'; prompt.value = c.prompt;
    prompt.addEventListener('input', () => { c.prompt = prompt.value; save(); });
    const acts = el('div', 'bd-case-actions');
    acts.append(
      miniBtn('✨ Prompt', async b => {
        if (busy) return;
        setBusy(true, `Prompt page ${c.page}, case ${c.n}…`);
        b.disabled = true;
        try { await genPrompt(c); saveNow(); renderBoard(); setStatus('Prompt généré.'); }
        catch (e) { setStatus(e.message || String(e), true); b.disabled = false; }
        finally { setBusy(false); }
      }),
      ...(lettOn() ? [miniBtn('✍️ Lettrage', async b => {
        if (busy) return;
        setBusy(true, `Lettrage page ${c.page}, case ${c.n}…`);
        b.disabled = true;
        try { await genText(c); saveNow(); renderBoard(); setStatus('Lettrage généré.'); }
        catch (e) { setStatus(e.message || String(e), true); b.disabled = false; }
        finally { setBusy(false); }
      })] : []),
      miniBtn('→ Txt2Img', () => {
        if (!c.prompt.trim()) { setStatus('Cette case n\'a pas encore de prompt.', true); return; }
        sendToTxt2Img(c.prompt, c.neg || buildNegative(P, modeOf(P, c)));
      }),
      miniBtn('Copier', b => copyText(b, c.prompt)),
      miniBtn('Supprimer', () => { P.cases = P.cases.filter(x => x !== c); save(); renderBoard(); renderPlan(); }),
    );
    const parts = [top, desc, text, prompt];
    if (c.queued || (c.images && c.images.length)) {
      const info = el('div', 'bd-queued');
      const nImg = (c.images || []).length;
      info.appendChild(el('span', '', nImg ? `${nImg} image(s) reçue(s) — clique pour choisir la meilleure` : 'en file, en attente de génération'));
      if (!nImg) info.appendChild(miniBtn('↺ Retirer le marqueur', () => { c.queued = false; save(); renderBoard(); }));
      parts.push(info);
      if (nImg) parts.push(imageStrip(c));
    }
    row.append(...parts, acts);
    return row;
  }

  // ── File d'attente, images reçues, tri et packs ───────────────────────────
  const esc = v => String(v == null ? '' : v).replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]));
  const slug = v => String(v || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'projet';
  const relOf = src => (typeof API !== 'undefined' && API.origin && src.startsWith(API.origin) ? src.slice(API.origin.length) : src);
  const urlOf = rel => (typeof API !== 'undefined' && rel.startsWith('/') ? API.origin + rel : rel);
  const dateLabel = k => { const d = parseISO(k); return d ? `${DAYS_FR[d.getDay()]} ${pad(d.getDate())}/${pad(d.getMonth() + 1)}` : k; };
  const caseLabel = c => (P.kind === 'social' ? `Post ${pad(c.page)}.${c.n}` : P.kind === 'set' ? `${c.page === 1 ? 'SFW' : 'NSFW'} ${pad(c.n)}` : `Page ${pad(c.page)}${P.cases.filter(x => x.page === c.page).length > 1 ? '_' + c.n : ''}`);
  const groupLabel = c => (P.kind === 'social' ? `${P.title || 'Persona'} — Instagram` : P.kind === 'set' ? `${P.title || 'Set'} — ${c.page === 1 ? 'SFW (Twitter)' : 'NSFW (Patreon)'}` : (P.title || 'BD'));

  let repaint = 0;
  function onSchedulerImage(e) {
    const d = e.detail || {};
    const ref = d.bdRef;
    if (!ref || !d.src) return;
    ensureLoaded();
    const proj = projects.find(x => x.id === ref.pid);
    const c = proj && proj.cases.find(x => x.id === ref.cid);
    if (!c) return;
    c.draws = Math.min(999, (c.draws || 0) + 1);
    c.queued = true;
    if (!String(d.src).startsWith('data:') && c.images.length < 60) c.images.push(relOf(String(d.src)));
    save();
    if (proj === P && inited && $('bd-pane-board') && !$('bd-pane-board').hidden) {
      cancelAnimationFrame(repaint);
      repaint = requestAnimationFrame(() => { if (!document.activeElement || !document.activeElement.closest || !document.activeElement.closest('#bd-board')) renderBoard(); });
    }
  }
  document.addEventListener('scheduler:image', onSchedulerImage);

  async function queueCases(scope) {
    if (busy) return;
    const presetMap = P.preset && typeof getPresetsData === 'function' ? getPresetsData()[P.preset] : null;
    if (typeof Scheduler === 'undefined' || (!presetMap && typeof captureTxt2ImgTask !== 'function')) { setStatus('Le Scheduler n\'est pas disponible.', true); return; }
    if (P.kind === 'social' && !P.preset) { setStatus('Choisis le preset de génération (ex. Diana) dans « Projet ».', true); return; }
    if (P.preset && !presetMap) { setStatus(`Le preset « ${P.preset} » n'existe plus dans Txt2Img : choisis-en un autre.`, true); return; }
    const cand = P.cases.filter(c => c.prompt.trim() && !c.queued && !(c.images && c.images.length) && c.state === 'todo');
    if (!cand.length) { setStatus('Rien à mettre en file : il faut des cases à tirer, avec un prompt, pas déjà en file.', true); return; }
    const count = Math.max(1, Math.round(P.T));
    let list = cand;
    if (scope === 'day') {
      const now = new Date();
      const row = plan(P, now).rows.find(r => r.date === iso(now));
      if (row) {
        const need = Math.max(count, row.gen);
        list = [];
        let sum = 0;
        for (const c of cand) { if (sum >= need) break; list.push(c); sum += count; }
      }
    }
    const model = presetMap ? (presetMap.model || '(modèle du preset)') : (document.getElementById('sel-model') || {}).value || '(modèle de Txt2Img)';
    const ok = await confirmBox('Mettre dans la file du Scheduler ?',
      `<p>${list.length} tâche(s) × ${count} images = <b>${list.length * count} images</b>.</p><p>Réglages de génération : ${presetMap ? `ceux du preset <b>${esc(P.preset)}</b>` : "ceux d'<b>Txt2Img</b> en ce moment"} (modèle <code>${esc(model)}</code>, LoRA, taille, steps, sampler). Seul le prompt change.</p><p>Tu lances ensuite la file dans l'onglet Scheduler ; les images reviennent ici, dans chaque case.</p>`, 'Ajouter à la file');
    if (!ok) return;
    const pos = document.getElementById('inp-positive');
    const old = pos ? pos.value : '';
    const tmp = !!pos && !old.trim();
    let cap = null;
    if (presetMap) {
      const base = { ...presetMap };
      delete base.prompt;
      for (const k of ['refinerupscale', 'refinercontrolpercentage', 'refinersteps', 'refinercfgscale']) if (base[k] !== undefined) base[k] = +base[k];
      Object.keys(base).forEach(k => (base[k] === '' || base[k] === undefined) && delete base[k]);
      cap = { payload: base, state: { model: base.model || '', width: String(base.width || ''), height: String(base.height || ''), steps: String(base.steps || ''), cfg: String(base.cfgscale || '') } };
    } else {
      try { if (tmp) pos.value = 'x'; cap = captureTxt2ImgTask(); } finally { if (tmp) pos.value = old; }
    }
    if (!cap) { setStatus('Impossible de lire les réglages de Txt2Img (connecte-toi à SwarmUI et choisis un modèle).', true); return; }
    const basePrompt = (tmp ? 'x' : old.trim());
    const suffix = presetMap ? '' : (String(cap.payload.prompt || '').startsWith(basePrompt) ? cap.payload.prompt.slice(basePrompt.length) : '');
    const pp = presetMap && P.usePresetPrompt ? String(presetMap.prompt || '').trim() : '';
    const presetPrefix = pp ? pp + (/[.,;:!?]$/.test(pp) ? ' ' : ', ') : '';
    setBusy(true, 'Ajout à la file…');
    try {
      for (const c of list) {
        const neg = presetMap
          ? (P.kind === 'social' ? String(cap.payload.negativeprompt || '') : joinTags([cap.payload.negativeprompt, modeOf(P, c) === 'safe' ? 'nsfw, explicit' : '']))
          : (c.neg || buildNegative(P, modeOf(P, c)));
        const payload = structuredClone(cap.payload);
        payload.prompt = presetPrefix + c.prompt.trim() + suffix;
        payload.negativeprompt = neg;
        payload.images = count;
        payload.seed = -1;
        const state = structuredClone(cap.state);
        Object.assign(state, { positive: presetPrefix + c.prompt.trim(), negative: neg, seed: '-1', count: String(count) });
        const task = await Scheduler.addSnapshotTask({ source: 'txt2img', name: caseLabel(c), payload, state, group: groupLabel(c), bdRef: { pid: P.id, cid: c.id } });
        if (task) c.queued = true;
      }
      saveNow();
      renderBoard();
      setStatus(`${list.length} tâche(s) ajoutées à la file. Lance-la dans l'onglet Scheduler.`);
      if (typeof toast === 'function') toast(`📅 ${list.length} tâche(s) ajoutées à la file du Scheduler`);
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }

  function pickImage(c, rel) {
    c.pick = c.pick === rel ? '' : rel;
    if (c.pick && c.state === 'todo') c.state = 'kept';
    save();
  }
  function openLightbox(c, start) {
    let idx = start;
    const ov = el('div', 'bd-lb');
    const img = document.createElement('img');
    const cap = el('div', 'bd-lb-cap');
    const show = () => {
      img.src = urlOf(c.images[idx]);
      cap.textContent = `${idx + 1} / ${c.images.length}${c.pick === c.images[idx] ? ' · ✔ choisie' : ''} — ←/→ naviguer · Entrée choisir · Échap fermer`;
    };
    let changed = false;
    const close = () => { document.removeEventListener('keydown', onKey, true); ov.remove(); if (changed) { renderBoard(); renderPlan(); } };
    const onKey = e => {
      if (e.key === 'Escape') close();
      else if (e.key === 'ArrowRight') { idx = (idx + 1) % c.images.length; show(); }
      else if (e.key === 'ArrowLeft') { idx = (idx - 1 + c.images.length) % c.images.length; show(); }
      else if (e.key === 'Enter') { pickImage(c, c.images[idx]); changed = true; show(); }
      else return;
      e.preventDefault(); e.stopPropagation();
    };
    ov.addEventListener('click', e => { if (e.target === ov) close(); });
    ov.append(img, cap);
    document.body.appendChild(ov);
    document.addEventListener('keydown', onKey, true);
    show();
  }
  function imageStrip(c) {
    const wrap = el('div', 'bd-strip');
    c.images.forEach((rel, i) => {
      const t = el('div', 'bd-thumb' + (c.pick === rel ? ' picked' : ''));
      t.title = 'Clic : choisir cette image · double-clic ou clic droit : agrandir';
      const im = document.createElement('img');
      im.src = urlOf(rel); im.loading = 'lazy'; im.alt = '';
      t.appendChild(im);
      t.addEventListener('click', () => { pickImage(c, rel); renderBoard(); renderPlan(); });
      t.addEventListener('dblclick', () => openLightbox(c, i));
      t.addEventListener('contextmenu', e => { e.preventDefault(); openLightbox(c, i); });
      wrap.appendChild(t);
    });
    return wrap;
  }

  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60000);
  }
  async function pickedFor(tier) {
    const all = P.cases.filter(c => c.page === tier);
    const items = all.filter(c => c.pick).sort((a, b) => a.n - b.n);
    const label = tier === 1 ? 'SFW' : 'NSFW';
    if (!items.length) { setStatus(`Aucune image ${label} choisie : clique une miniature dans chaque case pour la choisir.`, true); return null; }
    if (items.length < all.length && !await confirmBox('Pack incomplet', `<p>${items.length} image(s) choisie(s) sur ${all.length} (${label}). Exporter quand même ?</p>`, 'Exporter')) return null;
    return items;
  }
  async function packPatreon() {
    if (busy) return;
    const items = await pickedFor(2);
    if (!items) return;
    setBusy(true, 'Pack Patreon…');
    try {
      const zip = new JSZip();
      const used = new Set();
      let n = 0;
      let failed = 0;
      for (const c of items) {
        try {
          const res = await fetch(urlOf(c.pick));
          if (!res.ok) throw new Error('HTTP ' + res.status);
          const blob = await res.blob();
          const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
          let name = `${slug(P.title)}_patreon_${pad(c.n)}.${ext}`;
          for (let k = 2; used.has(name); k++) name = `${slug(P.title)}_patreon_${pad(c.n)}-${k}.${ext}`;
          used.add(name);
          zip.file(name, blob);
          n++;
        } catch (e) { failed++; }
      }
      if (!n) throw new Error('Aucune image récupérée (SwarmUI est-il allumé ?).');
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${slug(P.title)}_patreon_nsfw.zip`);
      setStatus(`Pack Patreon : ${n} image(s)${failed ? ` — ${failed} en échec` : ''}.`, failed > 0);
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }
  async function packInstagram() {
    if (busy) return;
    const posts = [...new Set(P.cases.map(c => c.page))].sort((a, b) => a - b);
    const ready = posts.filter(pg => P.cases.some(c => c.page === pg && c.pick));
    if (!ready.length) { setStatus('Aucune image choisie : clique une miniature dans chaque post pour la choisir.', true); return; }
    if (ready.length < P.socialPosts && !await confirmBox('Pack incomplet', `<p>${ready.length} post(s) prêt(s) sur ${P.socialPosts}. Exporter quand même ?</p>`, 'Exporter')) return;
    setBusy(true, 'Pack Instagram…');
    try {
      const zip = new JSZip();
      const dates = postDates(P);
      let n = 0;
      let failed = 0;
      for (const pg of ready) {
        const folder = zip.folder(`post-${pad(pg)}${dates[pg - 1] ? '_' + dates[pg - 1] : ''}`);
        const imgs = P.cases.filter(c => c.page === pg && c.pick).sort((a, b) => a.n - b.n);
        for (const c of imgs) {
          try {
            const res = await fetch(urlOf(c.pick));
            if (!res.ok) throw new Error('HTTP ' + res.status);
            const blob = await res.blob();
            const ext = blob.type.includes('png') ? 'png' : blob.type.includes('webp') ? 'webp' : 'jpg';
            folder.file(`${c.n}.${ext}`, blob);
            n++;
          } catch (e) { failed++; }
        }
        const cap = (P.captions[String(pg)] || '').trim();
        if (cap) folder.file('legende.txt', cap + '\n');
      }
      if (!n) throw new Error('Aucune image récupérée (SwarmUI est-il allumé ?).');
      downloadBlob(await zip.generateAsync({ type: 'blob' }), `${slug(P.title)}_instagram.zip`);
      setStatus(`Pack Instagram : ${n} image(s) dans ${ready.length} post(s)${failed ? ` — ${failed} en échec` : ''}.`, failed > 0);
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }
  async function packTwitter() {
    if (busy) return;
    if (typeof Watermark === 'undefined') { setStatus('Le module filigrane est indisponible.', true); return; }
    const items = await pickedFor(1);
    if (!items) return;
    setBusy(true, 'Pack Twitter…');
    try {
      if (Watermark.isConfigured()) {
        const entries = [];
        for (const c of items) entries.push(await Watermark.entryFromSrc(urlOf(c.pick), { name: `${slug(P.title)}_twitter_${pad(c.n)}` }));
        await Watermark.exportEntries(entries, `${slug(P.title)}_twitter_sfw`);
        setStatus(`Pack Twitter : ${entries.length} image(s) avec filigrane.`);
      } else {
        Watermark.init();
        for (const c of items) await Watermark.loadFromSrc(urlOf(c.pick), { name: `${slug(P.title)}_twitter_${pad(c.n)}`, select: false });
        if (typeof switchTab === 'function') switchTab('twitter');
        if (typeof toast === 'function') toast(`💧 ${items.length} images SFW envoyées au filigrane : règle-le puis « Tout exporter »`);
      }
    } catch (e) { setStatus(e.message || String(e), true); }
    finally { setBusy(false); }
  }

  // ── Planning ───────────────────────────────────────────────────────────────
  function fmtDur(sec) {
    const m = Math.round(sec / 60);
    return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${pad(m % 60)}`;
  }
  function planMarkdown(pl) {
    const L = [`# Planning ${P.kind === 'set' ? 'small set' : 'BD'}${P.title ? ' — ' + P.title : ''}`, '', `${pl.cases} ${P.kind === 'set' ? 'images' : 'cases'}, ${pl.total} images (≈ ${pl.genTotal} tirages + ${pl.inpTotal} inpaints, marge ${P.margin} %).`, '', '| Jour | Tirages | Inpaints | Total | Note |', '|---|---|---|---|---|'];
    pl.rows.forEach(r => L.push(`| ${r.label} | ${r.gen} | ${r.inp} | ${r.gen + r.inp} | ${r.note} |`));
    L.push('', P.kind === 'set' ? `Publication : ${P.post || 'à fixer'} (${P.setSfw} SFW sur Twitter, ${P.setNsfw} NSFW sur Patreon).` : `Week-end : lettrage ${P.pages} pages (${P.letterMin} min/page ≈ ${fmtDur(P.pages * P.letterMin * 60)}), puis mise en page et export.`);
    return L.join('\n');
  }
  function renderWeek(box, today) {
    const wv = weekView(projects, today);
    const wrap = el('div', 'bd-weekview');
    wrap.appendChild(el('b', '', 'Semaine (aujourd\'hui + 7 jours, tous projets)'));
    const hasComic = projects.some(p => p.kind === 'comic' && wv.rows.some(r => r.posts.some(x => x.id === p.id)));
    wrap.appendChild(el('div', wv.posts ? 'bd-note' : 'bd-warn', wv.posts
      ? `${wv.posts} publication(s) prévue(s) cette semaine${wv.posts >= 2 || hasComic ? '.' : ' (objectif : au moins 1, 2 avec la BD).'}`
      : 'Aucune publication prévue dans les 8 prochains jours : fixe une date de publication dans « Délai ».'));
    const tbl = el('table', 'bd-table');
    const head = el('tr');
    ['Jour', ...projects.map(p => (p.kind === 'social' ? '📸 ' : p.kind === 'set' ? '🖼 ' : '📖 ') + (p.title || 'Sans titre')), 'Total', 'Publication'].forEach(h => head.appendChild(el('th', '', h)));
    tbl.appendChild(head);
    wv.rows.forEach(r => {
      const tr = el('tr', r.date === iso(today) ? 'today' : '');
      [r.label, ...r.per.map(v => (v ? String(v) : '·')), String(r.total), r.posts.map(x => (x.kind === 'social' ? '📸 ' : x.kind === 'set' ? '🖼 ' : '📖 ') + x.title).join(', ')].forEach((v, i) => tr.appendChild(el('td', i === r.per.length + 2 ? 'bd-note' : '', v)));
      tbl.appendChild(tr);
    });
    wrap.appendChild(tbl);
    box.appendChild(wrap);
  }
  function renderPlan() {
    const box = $('bd-plan');
    if (!box) return;
    box.textContent = '';
    const today = new Date();
    renderWeek(box, today);
    const pl = plan(P, today);
    const made = P.cases.reduce((a, c) => a + (c.draws || 0) + (c.inpaints || 0), 0);
    const left = Math.max(0, pl.total - made);
    const doneCases = P.cases.filter(c => c.state === 'done').length;
    const perDay = pl.weekdaysLeft ? Math.ceil(left / pl.weekdaysLeft) : null;
    const cards = el('div', 'bd-cards');
    const card = (v, l, warn) => { const c = el('div', 'bd-card' + (warn ? ' warn' : '')); c.append(el('b', '', v), el('span', '', l)); cards.appendChild(c); };
    card(String(pl.cases), P.kind === 'set' ? 'images à produire' : 'cases à produire');
    card(String(pl.total), 'images au total');
    card(`${made} / ${pl.total}`, 'images faites');
    card(perDay === null ? '—' : String(perDay), pl.weekdaysLeft ? `images par jour restant (${pl.weekdaysLeft} j)` : 'aucun jour de prod restant', perDay === null);
    card(`${doneCases} / ${P.cases.length || pl.cases}`, P.kind === 'set' ? 'images finies' : 'cases finies');
    card(fmtDur(left * P.secPerImg), `temps GPU restant (${P.secPerImg} s/image)`);
    box.appendChild(cards);

    if (!pl.n) {
      box.appendChild(el('div', 'bd-warn', 'La date de début est après la date de gel, ou ne contient aucun jour ouvré. Corrige les dates dans « Projet ».'));
    } else if (pl.n < 4) {
      box.appendChild(el('div', 'bd-warn', `Seulement ${pl.n} jour(s) de prod : le plan est très serré. Réduis le nombre de pages ou de personnages par case, ou recule la date de gel.`));
    }
    const tbl = el('table', 'bd-table');
    const thead = el('tr');
    ['Jour', 'Tirages', 'Inpaints', 'Total', 'Note'].forEach(h => thead.appendChild(el('th', '', h)));
    tbl.appendChild(thead);
    pl.rows.forEach(r => {
      const tr = el('tr', r.date === iso(today) ? 'today' : '');
      [r.label, r.gen, r.inp, r.gen + r.inp, r.note].forEach((v, i) => tr.appendChild(el('td', i === 4 ? 'bd-note' : '', String(v))));
      tbl.appendChild(tr);
    });
    box.appendChild(tbl);

    const end = parseISO(P.deadline);
    const sat = end ? new Date(end.getFullYear(), end.getMonth(), end.getDate() + 1) : null;
    const half = Math.ceil(P.pages / 2);
    const wk = el('div', 'bd-weekend');
    if (P.kind === 'social') {
      wk.append(el('b', '', 'Publications Instagram'));
      const ds = postDates(P);
      wk.appendChild(el('div', '', ds.length ? ds.map((k, i) => `Post ${i + 1} : ${dateLabel(k)}`).join(' · ') : 'Fixe la première date de publication et les jours dans « Projet ».'));
      wk.appendChild(el('div', 'bd-note', 'Instagram demande de signaler les contenus réalistes générés par IA : pense à activer l\'étiquette lors de la publication.'));
      box.appendChild(wk);
    } else if (P.kind === 'set') {
      wk.append(el('b', '', 'Publication'));
      wk.appendChild(el('div', '', `${P.post ? 'Le ' + P.post : 'Date à fixer'} : ${P.setSfw} images SFW sur Twitter (avec filigrane : onglet Twitter), ${P.setNsfw} NSFW en exclusivité Patreon. Aucune génération le jour de la publication.`));
      box.appendChild(wk);
    } else {
    wk.append(el('b', '', 'Week-end (lettrage + mise en page)'));
    wk.appendChild(el('div', '', `${P.pages} pages × ${P.letterMin} min ≈ ${fmtDur(P.pages * P.letterMin * 60)} de lettrage${P.lettering ? ' (texte déjà prérédigé avec le LLM : exporte la feuille de lettrage pour ton lettreur)' : ''}. Samedi : pages 1 à ${half}. Dimanche : pages ${half + 1} à ${P.pages}, mise en page finale et export (onglet Comic). Aucune génération ce week-end.`));
    if (end && end.getDay() !== 5) wk.appendChild(el('div', 'bd-note', 'Ta date de gel n\'est pas un vendredi.'));
    if (sat) wk.dataset.sat = iso(sat);
    box.appendChild(wk);
    }

    const m = measured(P);
    const adv = el('div', 'bd-advice');
    adv.appendChild(el('b', '', 'Chiffres mesurés'));
    if (m.T === null) adv.appendChild(el('div', '', 'Passe des cases en « gardée » et note les tirages : ici apparaîtra ton vrai nombre de tirages par case.'));
    else {
      adv.appendChild(el('div', '', `Tirages par case gardée : ${m.T.toFixed(1)} (hypothèse du plan : ${P.T}) sur ${m.nKept} case(s).`));
      if (m.I !== null) adv.appendChild(el('div', '', `Inpaints par case finie : ${m.I.toFixed(1)} (hypothèse : ${P.I}) sur ${m.nDone} case(s).`));
      const b = miniBtn('Utiliser ces chiffres dans le plan', () => {
        P.T = Math.max(1, +m.T.toFixed(1));
        if (m.I !== null) P.I = +m.I.toFixed(1);
        save(); syncForm(); renderPlan();
      });
      adv.appendChild(b);
      if (m.T > 8) adv.appendChild(el('div', 'bd-note', 'Plus de 8 tirages par case : simplifie les cases (1 perso, plan plus serré) plutôt que d\'augmenter le quota.'));
    }
    box.appendChild(adv);
    const exp = el('div', 'bd-row');
    exp.appendChild(miniBtn('Copier le planning (Markdown)', b => copyText(b, planMarkdown(pl))));
    box.appendChild(exp);
  }

  // ── Formulaire projet ──────────────────────────────────────────────────────
  const FIELDS = [
    ['title', 'text'], ['pitch', 'text'], ['rules', 'text'], ['letterExample', 'text'], ['pages', 'int'], ['cpp', 'int'], ['spare', 'int0'], ['setSfw', 'int0'], ['setNsfw', 'int0'], ['socialPosts', 'int'], ['perPost', 'int'],
    ['start', 'text'], ['deadline', 'text'], ['post', 'text'], ['T', 'num'], ['I', 'num'], ['margin', 'num'], ['secPerImg', 'num'], ['letterMin', 'num'],
  ];
  function applyLettering() {
    const on = lettOn();
    ['bd-gen-text', 'bd-regen-text', 'bd-copy-sheet'].forEach(id => { $(id).hidden = !on; });
    $('bd-letterExample-row').hidden = !on;
    document.querySelectorAll('.bd-voice').forEach(e => { e.hidden = !(on || P.kind === 'social'); });
    $('bd-textLang-row').hidden = !(on || P.kind === 'social');
  }
  function fillPresetSelect() {
    const sel = $('bd-preset');
    let names = [];
    try { names = Object.keys(typeof getPresetsData === 'function' ? getPresetsData() : {}).sort((a, b) => a.localeCompare(b)); } catch { names = []; }
    sel.textContent = '';
    const none = document.createElement('option');
    none.value = ''; none.textContent = P.kind === 'social' ? '— Choisir un preset —' : '— Réglages d\'Txt2Img en ce moment —';
    sel.appendChild(none);
    names.forEach(n => { const o = document.createElement('option'); o.value = n; o.textContent = n; sel.appendChild(o); });
    if (P.preset && !names.includes(P.preset)) { const o = document.createElement('option'); o.value = P.preset; o.textContent = P.preset + ' (introuvable)'; sel.appendChild(o); }
    sel.value = P.preset || '';
    const m = (typeof getPresetsData === 'function' ? getPresetsData()[P.preset] : null) || null;
    const loras = m && m.loras ? String(m.loras).split(',').filter(Boolean).map(l => l.replace(/\.safetensors$/i, '')) : [];
    $('bd-preset-info').textContent = m
      ? [m.model ? 'Modèle : ' + String(m.model).split('/').pop() : '', m.width && m.height ? `${m.width}×${m.height}` : '', m.steps ? m.steps + ' steps' : '', loras.length ? 'LoRA : ' + loras.join(', ') : '', String(m.prompt || '').trim() ? 'Prompt du preset : « ' + String(m.prompt).trim().slice(0, 90) + (String(m.prompt).trim().length > 90 ? '…' : '') + ' »' : ''].filter(Boolean).join(' · ')
      : (P.preset ? 'Ce preset n\'existe plus dans Txt2Img.' : '');
  }
  function applyKind() {
    const set = P.kind === 'set';
    const social = P.kind === 'social';
    const comic = !set && !social;
    document.querySelectorAll('.bd-k-comic').forEach(e => { e.hidden = !comic; });
    document.querySelectorAll('.bd-k-set').forEach(e => { e.hidden = !set; });
    document.querySelectorAll('.bd-k-social').forEach(e => { e.hidden = !social; });
    document.querySelectorAll('.bd-k-nosocial').forEach(e => { e.hidden = social; });
    ['bd-pack-sfw', 'bd-pack-nsfw'].forEach(id => { $(id).hidden = !set; });
    $('bd-pack-ig').hidden = !social;
    $('bd-gen-captions').hidden = !social;
    $('bd-gen-cases').textContent = social ? '🧩 Générer les posts' : set ? '🧩 Générer la liste d\'images' : '🧩 Générer le découpage';
    $('bd-wm').hidden = !set;
    // BD : plus de découpage ni de prompts générés (voir BASE_BRAINSTORM), donc pas d'onglet « Découpage & prompts » ni d'aide au lettrage
    $('bd-tab-board').hidden = comic;
    $('bd-lettering').closest('label').hidden = comic;
    if (comic && !$('bd-pane-board').hidden) setPane('chat');
    $('bd-post-lbl').textContent = social ? 'Première publication' : 'Publication';
    fillPresetSelect();
  }
  function renderProjSelect() {
    const sel = $('bd-proj');
    sel.textContent = '';
    projects.forEach(x => {
      const o = document.createElement('option');
      o.value = x.id;
      o.textContent = (x.kind === 'social' ? '📸 ' : x.kind === 'set' ? '🖼 ' : '📖 ') + (x.title || 'Sans titre');
      sel.appendChild(o);
    });
    sel.value = P.id;
  }
  function refreshAll() {
    loadChat();
    setAttach(null);
    syncForm();
    renderProjSelect();
    renderChat();
    renderChars();
    renderBoard();
    renderPlan();
  }
  function switchProject(id) {
    const next = projects.find(x => x.id === id);
    if (!next || next === P) return;
    if (busy) { setStatus('Attends la fin de la génération avant de changer de projet.', true); $('bd-proj').value = P.id; return; }
    saveNow(); saveChat();
    P = next;
    saveNow();
    setStatus('');
    refreshAll();
  }
  function newProject(kind) {
    if (busy) { setStatus('Attends la fin de la génération.', true); return; }
    if (projects.length >= 30) { setStatus('30 projets maximum.', true); return; }
    saveNow(); saveChat();
    P = defaultProject(kind);
    projects.push(P);
    saveNow();
    setStatus('');
    refreshAll();
  }
  async function deleteProject() {
    if (busy) return;
    if (!await confirmBox('Supprimer ce projet ?', `<p>« ${(P.title || 'Sans titre').replace(/[&<>]/g, '')} » (pitch, personnages, cases, conversation) sera supprimé. Définitif : pense à « Exporter » avant.</p>`, 'Supprimer')) return;
    try { localStorage.removeItem(chatKey()); } catch { /* ignoré */ }
    const i = projects.indexOf(P);
    projects.splice(i, 1);
    if (!projects.length) projects.push(defaultProject('comic'));
    P = projects[Math.min(i, projects.length - 1)];
    saveNow();
    refreshAll();
  }
  function syncForm() {
    applyKind();
    $('bd-usePresetPrompt').checked = P.usePresetPrompt;
    document.querySelectorAll('#bd-postDays input').forEach(cb => { cb.checked = P.postDays.includes(+cb.value); });
    $('bd-lettering').checked = P.lettering;
    $('bd-textLang').value = P.textLang;
    applyLettering();
    FIELDS.forEach(([k]) => { $('bd-' + k).value = P[k]; });
    $('bd-target').value = P.target;
    $('bd-mode').value = P.mode;
    $('bd-mode-lbl').textContent = P.kind === 'set' ? 'Contenu (chat, analyse d\'image)' : 'Contenu';
    $('bd-unload').checked = ls('bd-unload', '1') === '1';
    ['pre', 'post', 'neg'].forEach(k => { $('bd-fmt-' + k).value = P.fmt[P.target][k]; });
    $('bd-model-info').textContent = `Modèle : ${ls('promptai-model', DEFAULT_MODEL)} — ${ls('promptai-url', DEFAULT_URL)} (réglable dans Txt2Img → ✨ Idée → prompt → Réglages)`;
  }
  function setPane(name) {
    if (name === 'board' && isComic()) name = 'chat';
    ['chat', 'board', 'plan'].forEach(p => {
      $('bd-pane-' + p).hidden = p !== name;
      $('bd-tab-' + p).classList.toggle('active', p === name);
    });
    try { localStorage.setItem('bd-pane', name); } catch { /* ignoré */ }
    if (name === 'plan') renderPlan();
    if (name === 'board') renderBoard();
  }
  function exportProject() {
    saveNow();
    const blob = new Blob([JSON.stringify(P, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (P.title || 'bd').replace(/[^\w\-]+/g, '_') + '.bd.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }
  async function importProject(file) {
    if (!file) return;
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error('trop gros');
      const next = sanitize(JSON.parse(await file.text()));
      if (busy) { setStatus('Attends la fin de la génération.', true); return; }
      if (projects.length >= 30) throw new Error('trop de projets');
      saveNow(); saveChat();
      next.id = newId();
      projects.push(next);
      P = next;
      saveNow();
      refreshAll();
      setStatus('Projet importé (ajouté à la liste).');
    } catch { setStatus('Fichier de projet invalide.', true); }
  }

  let inited = false;
  function init() {
    if (inited || !$('view-bd')) return;
    inited = true;
    ensureLoaded();
    loadChat();
    syncForm();
    renderProjSelect();
    FIELDS.forEach(([k, type]) => {
      $('bd-' + k).addEventListener('input', e => {
        const v = e.target.value;
        if (type === 'text') P[k] = v;
        else {
          const x = parseFloat(v);
          if (!Number.isFinite(x)) return;
          P[k] = type === 'int' ? Math.max(1, Math.round(x)) : type === 'int0' ? Math.max(0, Math.round(x)) : Math.max(0, x);
          if (k === 'cpp' || k === 'pages' || k === 'setSfw' || k === 'setNsfw' || k === 'spare' || k === 'socialPosts' || k === 'perPost') P[k] = Math.min(P[k], k === 'cpp' ? 12 : k === 'perPost' ? 10 : k === 'socialPosts' ? 30 : 60);
        }
        if (k === 'title') renderProjSelect();
        if (k === 'setSfw' || k === 'setNsfw' || k === 'socialPosts') renderBoard();
        save();
        if (!$('bd-pane-plan').hidden) renderPlan();
      });
    });
    $('bd-lettering').addEventListener('change', e => { P.lettering = e.target.checked; save(); applyLettering(); renderChars(); renderBoard(); });
    $('bd-textLang').addEventListener('change', e => { P.textLang = e.target.value === 'fr' ? 'fr' : 'en'; save(); });
    $('bd-gen-text').addEventListener('click', () => genTexts(true));
    $('bd-regen-text').addEventListener('click', async () => {
      if (busy || !P.cases.length) return;
      if (!await confirmBox('Régénérer tout le lettrage ?', '<p>Les textes existants (même modifiés à la main) seront remplacés.</p>', 'Régénérer')) return;
      genTexts(false);
    });
    $('bd-copy-sheet').addEventListener('click', b => copyText(b.currentTarget, letteringSheet()));
    $('bd-target').addEventListener('change', e => { P.target = e.target.value === 'anima' ? 'anima' : 'illustrious'; save(); syncForm(); });
    $('bd-mode').addEventListener('change', e => { P.mode = e.target.value === 'explicit' ? 'explicit' : 'safe'; save(); });
    $('bd-unload').addEventListener('change', e => { try { localStorage.setItem('bd-unload', e.target.checked ? '1' : '0'); } catch { /* ignoré */ } });
    ['pre', 'post', 'neg'].forEach(k => $('bd-fmt-' + k).addEventListener('input', e => { P.fmt[P.target][k] = e.target.value; save(); }));
    $('bd-fmt-reset').addEventListener('click', () => { P.fmt[P.target] = { ...DEFAULT_FMT[P.target] }; save(); syncForm(); });
    $('bd-char-add').addEventListener('click', () => {
      if (P.chars.length >= 12) return;
      P.chars.push({ id: Date.now(), name: '', desc: '', tags: '', voice: '' });
      save(); renderChars();
    });
    ['chat', 'board', 'plan'].forEach(p => $('bd-tab-' + p).addEventListener('click', () => setPane(p)));
    $('bd-send').addEventListener('click', onSend);
    $('bd-input').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onSend(); } });
    $('bd-img-task').addEventListener('click', () => imageTask($('bd-input').value.trim()));
    $('bd-attach-btn').addEventListener('click', () => $('bd-file').click());
    $('bd-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) attachFile(f); });
    const pane = $('bd-pane-chat');
    pane.addEventListener('dragover', e => { if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault(); });
    pane.addEventListener('drop', e => { const f = e.dataTransfer?.files?.[0]; if (!f) return; e.preventDefault(); attachFile(f); });
    $('bd-input').addEventListener('paste', e => {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault(); e.stopPropagation();
      attachFile(item.getAsFile());
    });
    $('bd-new-chat').addEventListener('click', async () => {
      if (busy) return;
      if (chat.length && !await confirmBox('Nouvelle conversation ?', '<p>La conversation en cours sera effacée (le pitch et les cases sont conservés).</p>', 'Effacer')) return;
      chat = []; saveChat(); renderChat(); setAttach(null);
    });
    $('bd-gen-cases').addEventListener('click', genCases);
    $('bd-queue-day').addEventListener('click', () => queueCases('day'));
    $('bd-queue-all').addEventListener('click', () => queueCases('all'));
    $('bd-pack-sfw').addEventListener('click', packTwitter);
    $('bd-pack-nsfw').addEventListener('click', packPatreon);
    $('bd-gen-prompts').addEventListener('click', () => genPrompts(true));
    $('bd-regen-prompts').addEventListener('click', async () => {
      if (busy || !P.cases.length) return;
      if (!await confirmBox('Régénérer tous les prompts ?', '<p>Les prompts existants (même modifiés à la main) seront remplacés.</p>', 'Régénérer')) return;
      genPrompts(false);
    });
    $('bd-cancel').addEventListener('click', () => { cancelFlag = true; setStatus('Annulation après la réponse en cours…'); });
    $('bd-export').addEventListener('click', exportProject);
    $('bd-import').addEventListener('click', () => $('bd-import-file').click());
    $('bd-import-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; importProject(f); });
    $('bd-preset').addEventListener('change', e => { P.preset = e.target.value; save(); fillPresetSelect(); });
    $('bd-usePresetPrompt').addEventListener('change', e => { P.usePresetPrompt = e.target.checked; save(); });
    document.querySelectorAll('#bd-postDays input').forEach(cb => cb.addEventListener('change', () => {
      const days = [...document.querySelectorAll('#bd-postDays input')].filter(x => x.checked).map(x => +x.value);
      if (!days.length) { cb.checked = true; return; }
      P.postDays = days; save(); renderBoard(); if (!$('bd-pane-plan').hidden) renderPlan();
    }));
    $('bd-new-social').addEventListener('click', () => newProject('social'));
    $('bd-gen-captions').addEventListener('click', () => genCaptions(true));
    $('bd-pack-ig').addEventListener('click', packInstagram);
    $('bd-proj').addEventListener('change', e => switchProject(e.target.value));
    $('bd-new-comic').addEventListener('click', () => newProject('comic'));
    $('bd-new-set').addEventListener('click', () => newProject('set'));
    $('bd-del-proj').addEventListener('click', deleteProject);
    $('bd-wm').addEventListener('click', () => { if (typeof switchTab === 'function') switchTab('twitter'); });
    renderChat();
    renderChars();
    setAttach(null);
    setPane(['chat', 'board', 'plan'].includes(ls('bd-pane', 'chat')) ? ls('bd-pane', 'chat') : 'chat');
    window.addEventListener('beforeunload', saveNow);
  }
  function onShow() { init(); renderPlan(); scrollChat(); }

  return { init, onShow, _t: { keepPresent, isSilentPanel, letteringSheet: () => letteringSheet(), postDates, weekView, modeOf, nextWeekday, plan, parseJsonArray, normCase, parseScene, parseReplyPrompts, buildPrompt, buildNegative, sanitize, defaultProject, nextFriday, weekdaysBetween, splitEven, measured, iso, parseISO } };
})();
