// ── Idée → prompt Krea 2 via un LLM local (Ollama) ────────────────────────────
const PromptAI = (() => {
  const DEFAULT_URL = 'http://localhost:11434';
  const DEFAULT_MODEL = 'eriktonon/qwen3.8-uncensored:9b';
  const DEFAULT_TEMP = 0.8;
  const DEFAULT_SYSTEM = "You are a prompt writer for Krea 2, a text-to-image model whose text encoder is a language model. Turn the user's short idea into one rich natural-language prompt, written as one or two flowing paragraphs, never as a list of keywords or tags. Cover, in this order and only as far as the idea allows: main subject, pose, action and expression; appearance, hair, clothing and fabrics; props and materials; shot type, camera angle and framing; environment and background; lighting, color palette and mood; overall medium and aesthetic. Start directly with the subject, never with 'In this image' or similar. Be concrete and visual: describe materials, textures and how light falls on them. If the idea names a known character, describe their appearance in detail instead of relying on the name. All characters are adults (18+). Always write in English, whatever language the idea is in. Do not add quality tags, watermarks, negative prompts, explanations or any text before or after the prompt. Output only the prompt.";
  const DEFAULT_CHAT_SYSTEM = "You are a prompt assistant for Krea 2, a text-to-image model whose text encoder is a language model. The user will give you image prompts and ask you to adapt, extend, shorten or rewrite them, or will describe an idea. Whenever you produce a prompt, write it as one or two flowing paragraphs of natural English prose (no keyword lists or tags), starting directly with the subject, concrete and visual (materials, textures, light, camera, composition, mood), and output ONLY the prompt: no markdown, no quotes, no title, no explanation before or after, so it can be pasted straight into the generator. Keep everything from the original prompt that the user did not ask to change. If the user asks a question or asks for advice instead of a prompt, answer briefly in the user's language. If the user asks for a specific output format (for example labeled lines), follow that format instead. All characters are adults (18+).";
  const EXAMPLES_INTRO = '\n\nExamples of the expected style (match their length, vocabulary and structure, do not copy their content):\n';
  const CHAT_HISTORY_SENT = 20;
  const CHAT_HISTORY_CHARS = 24000;
  const CHAT_NUM_CTX = 16384;
  const CHAT_MAX_INPUT = 4000;
  const CHAT_MAX_CONTENT = 8000;
  const IMG_MAX_SIDE = 1280;
  const IMG_MAX_BYTES = 20 * 1024 * 1024;
  const EXTRACT_PROMPT_MAX = 6000;
  const IMG_MAX_PIXELS = 64e6;
  const IMG_THUMB_SIDE = 256;
  const DESCRIBE_DEFAULT = 'Describe this image as a ready-to-use Krea 2 prompt.';
  const EXTRACT_ONLY = 'Look carefully at the attached image. Describe ONLY these elements: {LISTE}. Write each as a ready-to-use prompt fragment for Krea 2, in natural English prose, one line per element, each line starting with its label ("Outfit:", "Background:", "Pose:", "Lighting and mood:"). Be concrete: garments, cuts, fabrics, colors and accessories; place, architecture, objects and depth; body position, limbs, gaze, expression, camera angle and framing; light direction, palette and mood. Never describe the person\'s identity, face, hair, makeup, lips, eyewear or body. No markdown, no commentary.';
  const MERGE_TEXT = 'Here is my current image prompt:\n{PROMPT}\n\nHere are new descriptions for these elements ({LISTE}):\n{FRAGMENTS}\n\nRewrite my current prompt so that ONLY the parts describing {LISTE} are replaced by the new descriptions. Copy every other word of my prompt unchanged, especially everything about the character: hair, face, eyes, makeup, lips, skin, body, age and eyewear, with the same colors, lengths and styles. Do not use anything from the new descriptions that is not about {LISTE}. If my prompt has no part for one of these elements, add its new description where it fits naturally. Do not invent anything else. Keep my prompt\'s order, style and length. Output ONLY the full rewritten prompt, as flowing English prose, with nothing before or after it.';
  const TRANSLATE_SYSTEM = 'You are a literal translator for an image-generation prompt writer. Translate the user\'s text from French into natural, correct English, word for word in meaning. Do not add, remove, soften, exaggerate or comment on anything, including adult or explicit wording: keep every descriptive word, such as "massive" or "plump", at the same intensity. Copy people\'s names, nicknames, brands and character names exactly as written (for example "Eliott" stays "Eliott"). Never add quotation marks or judgments. If the text is already English, fix only spelling and grammar. Keep technical terms (camera, lighting, clothing) accurate. Output ONLY the English text, with no quotes, notes or explanations.';
  const EXTRACT_ITEMS = [
    ['outfit', 'outfit', 'tenue', '1'],
    ['bg', 'background', 'décor', '1'],
    ['pose', 'pose', 'pose', '1'],
    ['light', 'lighting and mood', 'lumière et ambiance', '0'],
  ];

  const $ = id => document.getElementById(id);
  const chatHistory = [];
  let llmBusy = false;
  let confirming = false;
  let attached = null;

  async function ask(title, html, okLabel, fallback) {
    if (confirming) return false;
    confirming = true;
    try {
      return typeof uiConfirm === 'function' ? await uiConfirm({ title, html, okLabel }) : confirm(fallback);
    } finally { confirming = false; }
  }

  function historyToSend() {
    const kept = [];
    let used = 0;
    let lastImg = -1;
    chatHistory.forEach((m, i) => { if (m.images) lastImg = i; });
    for (let i = chatHistory.length - 2; i >= 0 && kept.length < CHAT_HISTORY_SENT; i -= 2) {
      const pair = [i, i + 1].map(k => {
        const m = chatHistory[k];
        const o = { role: m.role, content: m.content.slice(0, CHAT_MAX_CONTENT) };
        if (k === lastImg) o.images = m.images;
        return o;
      });
      used += pair[0].content.length + pair[1].content.length;
      if (used > CHAT_HISTORY_CHARS && kept.length) break;
      kept.unshift(...pair);
    }
    return kept;
  }

  function load(key, def) {
    try { const v = localStorage.getItem('promptai-' + key); return v === null ? def : v; } catch { return def; }
  }
  function save(key, val) {
    try { localStorage.setItem('promptai-' + key, String(val)); } catch {}
  }

  function setStatus(msg, isError = false) {
    const el = $('pai-status');
    el.textContent = msg;
    el.classList.toggle('error', isError);
  }

  function readTemp() {
    const t = parseFloat($('pai-temp').value);
    return Number.isFinite(t) ? Math.min(2, Math.max(0, t)) : DEFAULT_TEMP;
  }

  // ── Aide à l'installation : Ollama absent / modèle pas téléchargé ───────────
  const SMALL_MODELS = [
    ['8 Go de VRAM ou plus', DEFAULT_MODEL + ' (celui par défaut : lit les images, sans filtre)'],
    ['6 à 8 Go', 'qwen3-vl:4b ou gemma3:4b (lisent aussi les images, plus légers, parfois filtrés)'],
    ['moins de 6 Go', 'qwen3:1.7b ou gemma3:1b (texte seulement, qualité limitée)'],
  ];

  function setupEl(tag, text, cls) {
    const e = document.createElement(tag);
    if (text) e.textContent = text;
    if (cls) e.className = cls;
    return e;
  }
  function setupLink(text, url) {
    const a = setupEl('a', text);
    a.href = url; a.target = '_blank'; a.rel = 'noopener';
    return a;
  }
  function setupCmd(cmd) {
    const row = setupEl('div', '', 'pai-setup-cmd');
    row.appendChild(setupEl('code', cmd));
    const b = setupEl('button', 'Copier', 'btn-secondary');
    b.type = 'button';
    b.addEventListener('click', () => {
      navigator.clipboard?.writeText(cmd).then(() => { b.textContent = 'Copié ✓'; setTimeout(() => { b.textContent = 'Copier'; }, 1500); }).catch(() => {});
    });
    row.appendChild(b);
    return row;
  }

  function showSetup(kind, model) {
    const box = $('pai-setup');
    if (!kind) { box.hidden = true; return; }
    const body = $('pai-setup-body');
    body.textContent = '';
    if (kind === 'ollama') {
      $('pai-setup-title').textContent = 'Ollama n\'est pas détecté';
      body.appendChild(setupEl('p', 'Le chat et « Idée → prompt » utilisent un modèle de langage qui tourne chez toi, via Ollama (gratuit, rien n\'est envoyé sur Internet).'));
      const ol = setupEl('ol');
      const l1 = setupEl('li'); l1.append('Installe Ollama : ', setupLink('ollama.com/download', 'https://ollama.com/download'));
      ol.appendChild(l1);
      ol.appendChild(setupEl('li', 'Lance-le (il tourne en arrière-plan, icône dans la barre des tâches / de menu).'));
      ol.appendChild(setupEl('li', 'Clique sur « Revérifier » : l\'app te dira s\'il manque le modèle.'));
      body.appendChild(ol);
      body.appendChild(setupEl('p', 'Ollama est sur un autre PC (ex. celui de SwarmUI) ? Change l\'URL dans Réglages, et lance-le avec la variable OLLAMA_HOST=0.0.0.0 pour qu\'il accepte le réseau local.', 'pai-setup-note'));
      $('pai-setup-title').dataset.kind = 'ollama';
    } else {
      $('pai-setup-title').textContent = 'Modèle « ' + model + ' » pas encore téléchargé';
      body.appendChild(setupEl('p', 'Ollama tourne bien, mais ce modèle n\'est pas installé. Ouvre un terminal et lance :'));
      body.appendChild(setupCmd('ollama pull ' + model));
      body.appendChild(setupEl('p', 'Le téléchargement fait plusieurs Go, une seule fois. Choisis selon ta carte graphique :'));
      const ul = setupEl('ul');
      SMALL_MODELS.forEach(([vram, name]) => ul.appendChild(setupEl('li', vram + ' : ' + name)));
      body.appendChild(ul);
      body.appendChild(setupEl('p', 'Un autre modèle que le défaut ? Écris son nom dans Réglages → Modèle. Catalogue : ollama.com/library', 'pai-setup-note'));
      $('pai-setup-title').dataset.kind = 'model';
    }
    box.hidden = false;
  }

  async function checkSetup() {
    try {
      const r = await window.electronAPI.llmModels($('pai-url').value.trim() || DEFAULT_URL);
      if (!r || r.error) { showSetup('ollama'); return; }
      const want = $('pai-model').value.trim() || DEFAULT_MODEL;
      const has = r.models.some(n => n === want || n === want + ':latest' || (!want.includes(':') && n.startsWith(want + ':')));
      showSetup(has ? null : 'model', want);
    } catch { showSetup('ollama'); }
  }

  async function detect() {
    const btn = $('pai-detect');
    btn.disabled = true;
    setStatus('Détection des modèles…');
    try {
      const r = await window.electronAPI.llmModels($('pai-url').value.trim() || DEFAULT_URL);
      if (!r || r.error) { setStatus(r?.error || 'Réponse invalide.', true); return; }
      const list = $('pai-models');
      list.innerHTML = '';
      r.models.forEach(name => {
        const o = document.createElement('option');
        o.value = name;
        list.appendChild(o);
      });
      setStatus(r.models.length ? `${r.models.length} modèle(s) installé(s).` : 'Aucun modèle installé dans Ollama.');
    } catch (e) {
      setStatus('Erreur : ' + (e?.message || e), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function generate() {
    if ($('pai-generate').disabled) return;
    if (llmBusy) { setStatus('Une autre génération est déjà en cours.', true); return; }
    const idea = $('pai-idea').value.trim();
    if (!idea) { setStatus('Écris d\'abord une idée.', true); return; }
    const examples = $('pai-examples').value.trim();
    const system = $('pai-system').value.trim() || DEFAULT_SYSTEM;
    const btn = $('pai-generate');
    btn.disabled = true;
    llmBusy = true;
    setStatus('Génération…');
    try {
      const r = await window.electronAPI.llmGenerate({
        url: $('pai-url').value.trim() || DEFAULT_URL,
        model: $('pai-model').value.trim() || DEFAULT_MODEL,
        system: examples ? system + EXAMPLES_INTRO + examples : system,
        prompt: idea,
        temperature: readTemp(),
        unload: $('pai-unload').checked,
      });
      if (!r || r.error) { setStatus(r?.error || 'Réponse invalide.', true); return; }
      const target = $('inp-positive');
      if (target.value.trim()) {
        const ok = await ask('Remplacer le prompt ?', 'Le prompt actuel sera remplacé par le prompt généré.', 'Remplacer', 'Remplacer le prompt actuel par le prompt généré ?');
        if (!ok) { setStatus('Remplacement annulé.'); return; }
      }
      target.value = r.text;
      target.dispatchEvent(new Event('input', { bubbles: true }));
      setStatus('Prompt généré.');
    } catch (e) {
      setStatus('Erreur : ' + (e?.message || e), true);
    } finally {
      btn.disabled = false;
      llmBusy = false;
    }
  }

  async function translateField(inputId, btnId) {
    const btn = $(btnId);
    const report = (m, isErr) => (inputId === 'pai-chat-input' ? (isErr && addChatError(m)) : setStatus(m, isErr));
    if (btn.disabled) return;
    if (llmBusy) { report('Une autre génération est déjà en cours.', true); return; }
    const field = $(inputId);
    const text = field.value.trim();
    if (!text) return;
    const label = btn.textContent;
    btn.disabled = true;
    llmBusy = true;
    btn.textContent = 'Traduction…';
    try {
      const r = await window.electronAPI.llmGenerate({
        url: $('pai-url').value.trim() || DEFAULT_URL,
        model: $('pai-translate-model').value.trim() || $('pai-model').value.trim() || DEFAULT_MODEL,
        system: TRANSLATE_SYSTEM,
        prompt: text,
        temperature: 0.2,
        unload: $('pai-unload').checked,
      });
      if (!r || r.error) { report(r?.error || 'Réponse invalide.', true); return; }
      if (field.value.trim() === text) {
        field.value = r.text;
        save(inputId.replace('pai-', ''), r.text);
        report('Traduit en anglais. Relis, puis envoie.', false);
      }
    } catch (e) {
      report('Erreur : ' + (e?.message || e), true);
    } finally {
      btn.disabled = false;
      btn.textContent = label;
      llmBusy = false;
    }
  }

  function setTab(tab) {
    const chat = tab === 'chat';
    $('pai-pane-idea').hidden = chat;
    $('pai-pane-chat').hidden = !chat;
    $('pai-tab-idea').classList.toggle('active', !chat);
    $('pai-tab-chat').classList.toggle('active', chat);
    save('tab', chat ? 'chat' : 'idea');
  }

  function focusActive() {
    $(load('tab', 'idea') === 'chat' ? 'pai-chat-input' : 'pai-idea').focus();
  }

  function scrollChat() {
    const list = $('pai-chat-list');
    list.scrollTop = list.scrollHeight;
  }

  async function useAsPrompt(text) {
    const target = $('inp-positive');
    if (target.value.trim()) {
      const ok = await ask('Remplacer le prompt ?', 'Le prompt actuel sera remplacé par ce texte.', 'Remplacer', 'Remplacer le prompt actuel par ce texte ?');
      if (!ok) return;
    }
    target.value = text;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function appendToPrompt(text) {
    const target = $('inp-positive');
    const clean = text.split('\n').map(l => l.replace(/^\s*(outfit|background|pose|lighting and mood)\s*:\s*/i, '').trim()).filter(Boolean).join(' ');
    target.value = (target.value.trim() ? target.value.trim() + ' ' : '') + clean;
    target.dispatchEvent(new Event('input', { bubbles: true }));
  }

  function addMessage(role, text, pending = false, thumb = null, fragment = false) {
    const msg = document.createElement('div');
    msg.className = 'pai-msg ' + role + (pending ? ' pending' : '');
    const bubble = document.createElement('div');
    bubble.className = 'pai-bubble';
    if (thumb) {
      const img = document.createElement('img');
      img.className = 'pai-thumb';
      img.alt = '';
      img.src = thumb;
      bubble.appendChild(img);
    }
    bubble.appendChild(document.createTextNode(text));
    msg.appendChild(bubble);
    if (role === 'assistant' && !pending) {
      const actions = document.createElement('div');
      actions.className = 'pai-msg-actions';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'pai-mini';
      use.textContent = fragment ? '↳ Ajouter au prompt' : '↳ Utiliser comme prompt';
      use.addEventListener('click', () => (fragment ? appendToPrompt(text) : useAsPrompt(text)));
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'pai-mini';
      copy.textContent = 'Copier';
      copy.addEventListener('click', async () => {
        try {
          await navigator.clipboard.writeText(text);
          copy.textContent = 'Copié';
        } catch {
          copy.textContent = 'Échec';
        }
        setTimeout(() => { copy.textContent = 'Copier'; }, 1500);
      });
      actions.append(use, copy);
      msg.appendChild(actions);
    }
    $('pai-chat-list').appendChild(msg);
    scrollChat();
    return msg;
  }

  function addChatError(text) {
    const el = document.createElement('div');
    el.className = 'pai-chat-error';
    el.textContent = text;
    $('pai-chat-list').appendChild(el);
    scrollChat();
  }

  function setAttach(obj) {
    attached = obj;
    const box = $('pai-chat-attach');
    box.textContent = '';
    if (obj) {
      const img = document.createElement('img');
      img.className = 'pai-attach-thumb';
      img.alt = '';
      img.src = obj.url;
      const rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'pai-mini';
      rm.title = 'Retirer l\'image';
      rm.textContent = '✕';
      rm.addEventListener('click', () => setAttach(null));
      box.append(img, rm);
    }
    box.hidden = !obj;
    $('pai-extract').hidden = !obj;
  }

  async function imageSize(file) {
    const b = new Uint8Array(await file.slice(0, 262144).arrayBuffer());
    const dv = new DataView(b.buffer);
    if (b.length > 24 && b[0] === 0x89 && b[1] === 0x50) return [dv.getUint32(16), dv.getUint32(20)];
    if (b.length > 4 && b[0] === 0xFF && b[1] === 0xD8) {
      for (let i = 2; i + 9 < b.length;) {
        if (b[i] !== 0xFF) { i++; continue; }
        const m = b[i + 1];
        if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) return [dv.getUint16(i + 7), dv.getUint16(i + 5)];
        i += 2 + dv.getUint16(i + 2);
      }
      return null;
    }
    if (b.length > 30 && b[0] === 0x52 && b[8] === 0x57) {
      const tag = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (tag === 'VP8X') return [1 + (b[24] | b[25] << 8 | b[26] << 16), 1 + (b[27] | b[28] << 8 | b[29] << 16)];
      if (tag === 'VP8 ') return [dv.getUint16(26, true) & 0x3fff, dv.getUint16(28, true) & 0x3fff];
      if (tag === 'VP8L') { const v = dv.getUint32(21, true); return [(v & 0x3fff) + 1, ((v >> 14) & 0x3fff) + 1]; }
    }
    return null;
  }

  async function attachFile(file) {
    if (!file || !file.type.startsWith('image/')) { addChatError('Ce fichier n\'est pas une image.'); return; }
    if (file.size > IMG_MAX_BYTES) { addChatError('Image trop lourde (max 20 Mo).'); return; }
    try {
      const dim = await imageSize(file).catch(() => null);
      if (dim && dim[0] * dim[1] > IMG_MAX_PIXELS) {
        addChatError(`Image trop grande (${Math.round(dim[0] * dim[1] / 1e6)} Mpx, max ${IMG_MAX_PIXELS / 1e6} Mpx) : réduis-la avant de la joindre.`);
        return;
      }
      const bmp = await createImageBitmap(file);
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
    } catch {
      addChatError('Impossible de lire cette image.');
    }
  }

  async function submit(shown, full, fromInput, fragment = false, mergeInto = null) {
    const btn = $('pai-chat-send');
    if (btn.disabled) return;
    if (llmBusy) { addChatError('Une autre génération est déjà en cours.'); return; }
    const input = $('pai-chat-input');
    const examples = $('pai-examples').value.trim();
    const system = $('pai-chat-system').value.trim() || DEFAULT_CHAT_SYSTEM;
    const img = attached;
    btn.disabled = true;
    $('pai-ex-run').disabled = true;
    llmBusy = true;
    if (fromInput) input.value = '';
    setAttach(null);
    const userMsg = addMessage('user', shown, false, img?.url);
    const pending = addMessage('assistant', '…', true);
    const fail = msg => {
      pending.remove();
      userMsg.remove();
      if (fromInput && !input.value) input.value = shown;
      if (img && !attached) setAttach(img);
      addChatError(msg);
    };
    try {
      if (mergeInto) {
        const base = {
          url: $('pai-url').value.trim() || DEFAULT_URL,
          model: $('pai-model').value.trim() || DEFAULT_MODEL,
          system: examples ? system + EXAMPLES_INTRO + examples : system,
          numCtx: CHAT_NUM_CTX,
          temperature: readTemp(),
        };
        const r1 = await window.electronAPI.llmGenerate({ ...base, prompt: full, images: [img.b64], unload: false });
        if (!r1 || r1.error) { fail(r1?.error || 'Réponse invalide.'); return; }
        const merged = MERGE_TEXT.replace(/\{LISTE\}/g, () => mergeInto.list).replace('{FRAGMENTS}', () => r1.text).replace('{PROMPT}', () => mergeInto.prompt);
        const r2 = await window.electronAPI.llmGenerate({ ...base, prompt: merged, unload: $('pai-unload').checked });
        if (!r2 || r2.error) { fail(r2?.error || 'Réponse invalide.'); return; }
        pending.remove();
        chatHistory.forEach(m => { delete m.images; });
        chatHistory.push({ role: 'user', content: shown, images: [img.b64] }, { role: 'assistant', content: r2.text });
        addMessage('assistant', r1.text, false, null, true);
        addMessage('assistant', r2.text, false, null, false);
        return;
      }
      const opts = {
        url: $('pai-url').value.trim() || DEFAULT_URL,
        model: $('pai-model').value.trim() || DEFAULT_MODEL,
        system: examples ? system + EXAMPLES_INTRO + examples : system,
        prompt: full,
        history: historyToSend().map(m => (img ? { role: m.role, content: m.content } : m)),
        numCtx: CHAT_NUM_CTX,
        temperature: readTemp(),
        unload: $('pai-unload').checked,
      };
      if (img) opts.images = [img.b64];
      const r = await window.electronAPI.llmGenerate(opts);
      if (!r || r.error) { fail(r?.error || 'Réponse invalide.'); return; }
      pending.remove();
      const entry = { role: 'user', content: full };
      if (img) {
        chatHistory.forEach(m => { delete m.images; });
        entry.images = [img.b64];
      }
      chatHistory.push(entry, { role: 'assistant', content: r.text });
      addMessage('assistant', r.text, false, null, fragment);
    } catch (e) {
      fail('Erreur : ' + (e?.message || e));
    } finally {
      btn.disabled = false;
      $('pai-ex-run').disabled = false;
      llmBusy = false;
    }
  }

  function sendChat() {
    if ($('pai-chat-send').disabled) return;
    let text = $('pai-chat-input').value.trim();
    if (!text && attached) text = DESCRIBE_DEFAULT;
    if (!text) return;
    $('pai-chat-list').querySelectorAll('.pai-chat-error').forEach(el => el.remove());
    if (text.length > CHAT_MAX_INPUT) { addChatError(`Message trop long (max ${CHAT_MAX_INPUT} caractères).`); return; }
    submit(text, text, true);
  }

  function extract() {
    if ($('pai-ex-run').disabled || !attached) return;
    $('pai-chat-list').querySelectorAll('.pai-chat-error').forEach(el => el.remove());
    const picked = EXTRACT_ITEMS.filter(([k]) => $('pai-ex-' + k).checked);
    if (!picked.length) { addChatError('Coche au moins un élément à extraire.'); return; }
    const current = $('inp-positive').value.trim();
    const merge = $('pai-ex-merge').checked && !!current;
    const list = picked.map(p => p[1]).join(', ');
    const full = EXTRACT_ONLY.replace('{LISTE}', () => list);
    const note = merge
      ? (current.length > EXTRACT_PROMPT_MAX ? ` — fusion dans mon prompt (tronqué à ${EXTRACT_PROMPT_MAX} caractères)` : ' — fusion dans mon prompt')
      : ($('pai-ex-merge').checked ? ' — pas de prompt actuel : extraction seule' : '');
    submit('Extraire : ' + picked.map(p => p[2]).join(', ') + note, full, false, !merge, merge ? { prompt: current.slice(0, EXTRACT_PROMPT_MAX), list } : null);
  }

  async function newChat() {
    if ($('pai-chat-send').disabled) return;
    if (chatHistory.length) {
      const ok = await ask('Nouvelle conversation ?', 'La conversation en cours sera effacée.', 'Effacer', 'Effacer la conversation en cours ?');
      if (!ok || $('pai-chat-send').disabled) return;
    }
    chatHistory.length = 0;
    setAttach(null);
    $('pai-chat-list').textContent = '';
  }

  function insertCurrent() {
    const current = $('inp-positive').value.trim();
    if (!current) return;
    const input = $('pai-chat-input');
    const sep = input.value && !input.value.endsWith('\n') ? '\n' : '';
    input.value += sep + 'Prompt actuel :\n' + current + '\n\n';
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  function init() {
    const toggle = $('pai-toggle-btn');
    if (!toggle || !$('pai-panel')) return;

    $('pai-url').value = load('url', DEFAULT_URL);
    $('pai-model').value = load('model', DEFAULT_MODEL);
    $('pai-translate-model').value = load('translate-model', '');
    $('pai-temp').value = load('temp', DEFAULT_TEMP);
    $('pai-system').value = load('system', DEFAULT_SYSTEM);
    $('pai-examples').value = load('examples', '');
    $('pai-unload').checked = load('unload', '1') === '1';
    $('pai-idea').value = load('idea', '');
    $('pai-chat-system').value = load('chat-system', DEFAULT_CHAT_SYSTEM);
    setTab(load('tab', 'idea') === 'chat' ? 'chat' : 'idea');

    toggle.addEventListener('click', () => {
      const panel = $('pai-panel');
      panel.hidden = !panel.hidden;
      toggle.classList.toggle('active', !panel.hidden);
      if (!panel.hidden) { focusActive(); checkSetup(); }
    });
    $('pai-setup-recheck').addEventListener('click', checkSetup);
    $('pai-model').addEventListener('change', () => { if (!$('pai-panel').hidden) checkSetup(); });

    ['url', 'model', 'translate-model', 'temp', 'system', 'examples', 'idea', 'chat-system'].forEach(k =>
      $('pai-' + k).addEventListener('input', e => save(k, e.target.value)));
    $('pai-tab-idea').addEventListener('click', () => { setTab('idea'); focusActive(); });
    $('pai-tab-chat').addEventListener('click', () => { setTab('chat'); focusActive(); });
    $('pai-chat-reset').addEventListener('click', () => {
      $('pai-chat-system').value = DEFAULT_CHAT_SYSTEM;
      save('chat-system', DEFAULT_CHAT_SYSTEM);
    });
    $('pai-chat-send').addEventListener('click', sendChat);
    $('pai-chat-translate').addEventListener('click', () => translateField('pai-chat-input', 'pai-chat-translate'));
    $('pai-translate').addEventListener('click', () => translateField('pai-idea', 'pai-translate'));
    $('pai-chat-insert').addEventListener('click', insertCurrent);
    $('pai-chat-new').addEventListener('click', newChat);
    $('pai-chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
    });
    $('pai-unload').addEventListener('change', e => save('unload', e.target.checked ? '1' : '0'));

    EXTRACT_ITEMS.forEach(([k, , , def]) => {
      const el = $('pai-ex-' + k);
      el.checked = load('ex-' + k, def) === '1';
      el.addEventListener('change', () => save('ex-' + k, el.checked ? '1' : '0'));
    });
    $('pai-ex-merge').checked = load('ex-merge', '1') === '1';
    $('pai-ex-merge').addEventListener('change', e => save('ex-merge', e.target.checked ? '1' : '0'));
    $('pai-ex-run').addEventListener('click', extract);
    setAttach(null);
    $('pai-chat-attach-btn').addEventListener('click', () => $('pai-chat-file').click());
    $('pai-chat-file').addEventListener('change', e => {
      const f = e.target.files[0];
      e.target.value = '';
      if (f) attachFile(f);
    });
    const pane = $('pai-pane-chat');
    pane.addEventListener('dragover', e => {
      if (e.dataTransfer && Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault();
    });
    pane.addEventListener('drop', e => {
      const f = e.dataTransfer?.files?.[0];
      if (!f) return;
      e.preventDefault();
      attachFile(f);
    });
    $('pai-chat-input').addEventListener('paste', e => {
      const item = Array.from(e.clipboardData?.items || []).find(i => i.kind === 'file' && i.type.startsWith('image/'));
      if (!item) return;
      e.preventDefault();
      e.stopPropagation();
      attachFile(item.getAsFile());
    });

    $('pai-reset').addEventListener('click', () => {
      $('pai-system').value = DEFAULT_SYSTEM;
      save('system', DEFAULT_SYSTEM);
    });
    $('pai-detect').addEventListener('click', detect);
    $('pai-generate').addEventListener('click', generate);
    $('pai-idea').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); generate(); }
    });
  }

  document.addEventListener('DOMContentLoaded', init);
  return {};
})();
