// ── Ordre des cartes des colonnes de réglages ─────────────────────────────────
// On attrape le titre d'une carte pour la déplacer ; l'ordre est mémorisé par colonne.
// Les cartes sont identifiées par une clé stable (data-section du titre, ou data-key).
const SidebarOrder = (() => {
  function readOrder(key) {
    try { return JSON.parse(localStorage.getItem(key) || 'null'); } catch { return null; }
  }
  function writeOrder(key, order) {
    try {
      if (order) localStorage.setItem(key, JSON.stringify(order));
      else localStorage.removeItem(key);
    } catch {}
  }

  function makeSortable({ container, itemSelector, handleSelector, keyOf, storageKey }) {
    if (!container) return;
    const items = () => [...container.querySelectorAll(`:scope > ${itemSelector}`)];
    const defaultOrder = items().map(keyOf);

    function applyOrder(order) {
      const byKey = new Map(items().map(el => [keyOf(el), el]));
      // Cartes connues dans l'ordre mémorisé, puis les nouvelles (ajoutées depuis) à leur place par défaut
      const keys = [...order.filter(k => byKey.has(k)), ...defaultOrder.filter(k => !order.includes(k))];
      const anchor = resetBtn.isConnected ? resetBtn : null;
      keys.forEach(k => container.insertBefore(byKey.get(k), anchor));
    }

    const resetBtn = document.createElement('button');
    resetBtn.type = 'button';
    resetBtn.className = 'sidebar-order-reset';
    resetBtn.textContent = "Remettre l'ordre par défaut";
    resetBtn.addEventListener('click', () => {
      writeOrder(storageKey, null);
      applyOrder(defaultOrder);
      resetBtn.hidden = true;
    });
    container.appendChild(resetBtn);

    const saved = readOrder(storageKey);
    if (Array.isArray(saved)) applyOrder(saved);
    resetBtn.hidden = !Array.isArray(saved);

    let dragged = null;
    items().forEach(el => {
      el.classList.add('sortable-item');
      const handle = el.querySelector(handleSelector);
      if (!handle) return;
      handle.draggable = true;
      handle.classList.add('sortable-handle');
      handle.addEventListener('dragstart', e => {
        dragged = el;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', keyOf(el));
        e.dataTransfer.setDragImage(el, 24, 16);
        requestAnimationFrame(() => el.classList.add('dragging'));
      });
      handle.addEventListener('dragend', () => {
        el.classList.remove('dragging');
        dragged = null;
        const order = items().map(keyOf);
        const isDefault = order.join() === defaultOrder.join();
        writeOrder(storageKey, isDefault ? null : order);
        resetBtn.hidden = isDefault;
      });
    });

    // Réordonne en direct pendant le glisser : la carte se place avant la première dont le milieu est sous le curseur
    container.addEventListener('dragover', e => {
      if (!dragged) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const target = items().find(el => el !== dragged && e.clientY < el.getBoundingClientRect().top + el.offsetHeight / 2);
      const ref = target || resetBtn;
      if (ref !== dragged.nextElementSibling) container.insertBefore(dragged, ref);
    });
    container.addEventListener('drop', e => { if (dragged) e.preventDefault(); });
  }

  function init() {
    const sectionKey = el => el.querySelector(':scope > .sidebar-section-hdr')?.dataset.section || '';
    makeSortable({
      container: document.getElementById('sidebar'),
      itemSelector: '.sidebar-section', handleSelector: ':scope > .sidebar-section-hdr',
      keyOf: sectionKey, storageKey: 'sidebar-order-txt2img',
    });
    makeSortable({
      container: document.getElementById('flux-sidebar'),
      itemSelector: '.sidebar-section', handleSelector: ':scope > .sidebar-section-hdr',
      keyOf: sectionKey, storageKey: 'sidebar-order-edit',
    });
    makeSortable({
      container: document.getElementById('mdl-left'),
      itemSelector: '.sidebar-section', handleSelector: ':scope > .sidebar-section-hdr',
      keyOf: sectionKey, storageKey: 'sidebar-order-models',
    });
    makeSortable({
      container: document.getElementById('comic-side'),
      itemSelector: '.sidebar-section', handleSelector: ':scope > .sidebar-section-hdr',
      keyOf: sectionKey, storageKey: 'sidebar-order-comic',
    });
    makeSortable({
      container: document.getElementById('ips-left'),
      itemSelector: '.sidebar-section', handleSelector: ':scope > .sidebar-section-hdr',
      keyOf: sectionKey, storageKey: 'sidebar-order-ips',
    });
    makeSortable({
      container: document.getElementById('tw-side'),
      itemSelector: '.sidebar-section', handleSelector: ':scope > .sidebar-section-hdr',
      keyOf: sectionKey, storageKey: 'sidebar-order-twitter',
    });
    makeSortable({
      container: document.getElementById('inp-side'),
      itemSelector: '.inp-card', handleSelector: ':scope > .inp-card-hdr',
      keyOf: el => el.dataset.key || '', storageKey: 'sidebar-order-inpaint',
    });
  }

  init();
  return { makeSortable };
})();
