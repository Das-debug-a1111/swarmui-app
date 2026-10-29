// ── Idée → prompt Krea 2 via un LLM local (Ollama) ────────────────────────────
const PromptAI = (() => {
  const DEFAULT_URL = 'http://localhost:11434';
  const DEFAULT_MODEL = 'eriktonon/qwen3.8-uncensored:9b';
  const DEFAULT_TEMP = 0.8;
  const DEFAULT_SYSTEM = "You are a prompt writer for Krea 2, a text-to-image model whose text encoder is a language model. Turn the user's short idea into one rich natural-language prompt, written as one or two flowing paragraphs, never as a list of keywords or tags. Cover, in this order and only as far as the idea allows: main subject, pose, action and expression; appearance, hair, clothing and fabrics; props and materials; shot type, camera angle and framing; environment and background; lighting, color palette and mood; overall medium and aesthetic. Start directly with the subject, never with 'In this image' or similar. Be concrete and visual: describe materials, textures and how light falls on them. If the idea names a known character, describe their appearance in detail instead of relying on the name. All characters are adults (18+). Always write in English, whatever language the idea is in. Do not add quality tags, watermarks, negative prompts, explanations or any text before or after the prompt. Output only the prompt.";
  const DEFAULT_CHAT_SYSTEM = "You are a prompt assistant for Krea 2, a text-to-image model whose text encoder is a language model. The user will give you image prompts and ask you to adapt, extend, shorten or rewrite them, or will describe an idea. Whenever you produce a prompt, write it as one or two flowing paragraphs of natural English prose (no keyword lists or tags), starting directly with the subject, concrete and visual (materials, textures, light, camera, composition, mood), and output ONLY the prompt: no markdown, no quotes, no title, no explanation before or after, so it can be pasted straight into the generator. Keep everything from the original prompt that the user did not ask to change. If the user asks a question or asks for advice instead of a prompt, answer briefly in the user's language. All characters are adults (18+).";
  const EXAMPLES_INTRO = '\n\nExamples of the expected style (match their length, vocabulary and structure, do not copy their content):\n';
  const CHAT_HISTORY_SENT = 20;
  const CHAT_HISTORY_CHARS = 24000;
  const CHAT_NUM_CTX = 8192;
  const CHAT_MAX_INPUT = 4000;
  const CHAT_MAX_CONTENT = 8000;

  const $ = id => document.getElementById(id);
  const chatHistory = [];
  let llmBusy = false;
  let confirming = false;

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
    for (let i = chatHistory.length - 2; i >= 0 && kept.length < CHAT_HISTORY_SENT; i -= 2) {
      const pair = [chatHistory[i], chatHistory[i + 1]].map(m => ({ role: m.role, content: m.content.slice(0, CHAT_MAX_CONTENT) }));
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

  function addMessage(role, text, pending = false) {
    const msg = document.createElement('div');
    msg.className = 'pai-msg ' + role + (pending ? ' pending' : '');
    const bubble = document.createElement('div');
    bubble.className = 'pai-bubble';
    bubble.textContent = text;
    msg.appendChild(bubble);
    if (role === 'assistant' && !pending) {
      const actions = document.createElement('div');
      actions.className = 'pai-msg-actions';
      const use = document.createElement('button');
      use.type = 'button';
      use.className = 'pai-mini';
      use.textContent = '↳ Utiliser comme prompt';
      use.addEventListener('click', () => useAsPrompt(text));
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

  async function sendChat() {
    const btn = $('pai-chat-send');
    if (btn.disabled) return;
    if (llmBusy) { addChatError('Une autre génération est déjà en cours.'); return; }
    const input = $('pai-chat-input');
    const text = input.value.trim();
    if (!text) return;
    const list = $('pai-chat-list');
    list.querySelectorAll('.pai-chat-error').forEach(el => el.remove());
    if (text.length > CHAT_MAX_INPUT) { addChatError(`Message trop long (max ${CHAT_MAX_INPUT} caractères).`); return; }
    const examples = $('pai-examples').value.trim();
    const system = $('pai-chat-system').value.trim() || DEFAULT_CHAT_SYSTEM;
    btn.disabled = true;
    llmBusy = true;
    input.value = '';
    const userMsg = addMessage('user', text);
    const pending = addMessage('assistant', '…', true);
    try {
      const r = await window.electronAPI.llmGenerate({
        url: $('pai-url').value.trim() || DEFAULT_URL,
        model: $('pai-model').value.trim() || DEFAULT_MODEL,
        system: examples ? system + EXAMPLES_INTRO + examples : system,
        prompt: text,
        history: historyToSend(),
        numCtx: CHAT_NUM_CTX,
        temperature: readTemp(),
        unload: $('pai-unload').checked,
      });
      pending.remove();
      if (!r || r.error) {
        userMsg.remove();
        input.value = text;
        addChatError(r?.error || 'Réponse invalide.');
        return;
      }
      chatHistory.push({ role: 'user', content: text }, { role: 'assistant', content: r.text });
      addMessage('assistant', r.text);
    } catch (e) {
      pending.remove();
      userMsg.remove();
      input.value = text;
      addChatError('Erreur : ' + (e?.message || e));
    } finally {
      btn.disabled = false;
      llmBusy = false;
    }
  }

  async function newChat() {
    if ($('pai-chat-send').disabled) return;
    if (chatHistory.length) {
      const ok = await ask('Nouvelle conversation ?', 'La conversation en cours sera effacée.', 'Effacer', 'Effacer la conversation en cours ?');
      if (!ok || $('pai-chat-send').disabled) return;
    }
    chatHistory.length = 0;
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
      if (!panel.hidden) focusActive();
    });

    ['url', 'model', 'temp', 'system', 'examples', 'idea', 'chat-system'].forEach(k =>
      $('pai-' + k).addEventListener('input', e => save(k, e.target.value)));
    $('pai-tab-idea').addEventListener('click', () => { setTab('idea'); focusActive(); });
    $('pai-tab-chat').addEventListener('click', () => { setTab('chat'); focusActive(); });
    $('pai-chat-reset').addEventListener('click', () => {
      $('pai-chat-system').value = DEFAULT_CHAT_SYSTEM;
      save('chat-system', DEFAULT_CHAT_SYSTEM);
    });
    $('pai-chat-send').addEventListener('click', sendChat);
    $('pai-chat-insert').addEventListener('click', insertCurrent);
    $('pai-chat-new').addEventListener('click', newChat);
    $('pai-chat-input').addEventListener('keydown', e => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendChat(); }
    });
    $('pai-unload').addEventListener('change', e => save('unload', e.target.checked ? '1' : '0'));

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
