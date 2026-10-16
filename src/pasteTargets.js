// ── Coller une image (⌘V) dans n'importe quelle zone d'image ───────────────────
// Chaque zone a déjà son <input type="file"> caché : on y place l'image collée et on déclenche
// « change », donc chaque module la traite exactement comme un fichier choisi à la main.
// Cible : la zone sous la souris, sinon la dernière zone cliquée (si encore visible),
// sinon la zone par défaut de l'onglet ouvert.
const PasteTargets = (() => {
  const $1 = sel => document.querySelector(sel);

  const TARGETS = [
    // Fenêtre de tâche du Scheduler : prioritaire quand elle est ouverte
    { zone: '#sws-cn-dropzone', input: '#sws-f-cn-file', label: 'Image ControlNet de la tâche', isDefault: true },
    { zone: '#cn-img-drop, #cn-img-preview-wrap', input: '#cn-img-file', label: 'ControlNet',
      isDefault: () => $1('#chk-cn')?.checked },
    { zone: '#sec-refimg', input: '#refimg-file', label: 'Images de référence' },
    { zone: '.ext-img', input: el => el.querySelector('input[type=file]'), label: 'Extension' },
    { zone: '#sec-flux-editimg', input: '#flux-editimg-file', label: 'Images à éditer', isDefault: true },
    { zone: '#inp-canvas-wrap', input: '#inp-file-input', label: 'Inpaint', isDefault: true },
    { zone: '#pnginfo-drop, #pnginfo-result', input: '#pnginfo-file-input', label: 'PNG Info', isDefault: true },
    { zone: '#wm-drop-zone, #wm-canvas-area', input: '#wm-file-input', label: 'Twitter (filigrane)', isDefault: true },
    { zone: '#ips-main, #ips-left', input: '#ips-file-input', label: 'Inpaint Scheduler', isDefault: true },
    { zone: '#comic-canvas-area', label: 'Comic', isDefault: true,
      handler: file => Comic.loadFromSrc(URL.createObjectURL(file)) },
  ];

  // Visible = affichée à l'écran (une vue ou section masquée n'a aucune boîte)
  const visible = el => !!el && el.getClientRects().length > 0;

  function matchTarget(el) {
    if (!el) return null;
    for (const t of TARGETS) {
      const zoneEl = el.closest(t.zone);
      if (zoneEl) return { t, zoneEl };
    }
    return null;
  }

  let pointer = { x: -1, y: -1 };
  let lastClicked = null;   // { t, zoneEl }
  document.addEventListener('pointermove', e => { pointer = { x: e.clientX, y: e.clientY }; }, { passive: true });
  document.addEventListener('pointerdown', e => {
    const m = matchTarget(e.target);
    if (m) lastClicked = m;
  }, true);

  function resolveTarget() {
    const hovered = matchTarget(document.elementFromPoint(pointer.x, pointer.y));
    if (hovered && visible(hovered.zoneEl)) return hovered;
    if (lastClicked && visible(lastClicked.zoneEl)) return lastClicked;
    for (const t of TARGETS) {
      if (!t.isDefault || (typeof t.isDefault === 'function' && !t.isDefault())) continue;
      const zoneEl = [...document.querySelectorAll(t.zone)].find(visible);
      if (zoneEl) return { t, zoneEl };
    }
    return null;
  }

  function anyZoneVisible() {
    return TARGETS.some(t => [...document.querySelectorAll(t.zone)].some(visible));
  }

  function imageFromClipboard(e) {
    for (const item of e.clipboardData?.items || []) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const blob = item.getAsFile();
        if (!blob) continue;
        const ext = (item.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
        return new File([blob], `image-collee.${ext}`, { type: item.type });
      }
    }
    return null;
  }

  function deliver({ t, zoneEl }, file) {
    if (t.handler) {
      t.handler(file);
    } else {
      const input = typeof t.input === 'function' ? t.input(zoneEl) : $1(t.input);
      if (!input) return false;
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }
    zoneEl.classList.remove('paste-flash');
    void zoneEl.offsetWidth;   // relance l'animation
    zoneEl.classList.add('paste-flash');
    setTimeout(() => zoneEl.classList.remove('paste-flash'), 700);
    toast(`📋 Image collée — ${t.label}`);
    return true;
  }

  document.addEventListener('paste', e => {
    // Coller du texte dans un champ reste un collage de texte normal
    const a = document.activeElement;
    const typing = a && (a.tagName === 'TEXTAREA' || (a.tagName === 'INPUT' && !['file', 'range', 'checkbox', 'radio'].includes(a.type)) || a.isContentEditable);
    if (typing && e.clipboardData?.types.includes('text/plain')) return;

    const file = imageFromClipboard(e);
    if (!file) return;
    const target = resolveTarget();
    if (!target) {
      if (anyZoneVisible()) toast('Survole la zone où mettre l\'image, puis ⌘V');
      return;
    }
    e.preventDefault();
    deliver(target, file);
  });

  return { resolveTarget };
})();
