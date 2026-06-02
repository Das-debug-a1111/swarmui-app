// ── Instance Bar ───────────────────────────────────────────────────────────────
// Lightweight helper that creates a tab bar for multiple independent instances.
//
// Usage:
//   const bar = createInstanceBar(containerEl, {
//     onSave : (idx) => { states[idx] = collectState(); },
//     onLoad : (idx) => { applyState(states[idx]);      },
//     onNew  : (idx) => { states[idx] = defaultState(); },
//   });
//
// The container becomes the tab bar (className 'inst-bar' is set by the helper).
// Double-click a tab name to rename it inline.
// × removes an instance (min 1 always kept).
// + adds a new one (max maxInstances, default 8).

function createInstanceBar(container, {
  onSave,
  onLoad,
  onNew,
  onRemove,
  maxInstances = 8,
} = {}) {
  const names   = ['Instance 1'];
  let activeIdx = 0;

  // ── Render ────────────────────────────────────────────────────────────────
  function render() {
    container.innerHTML = '';
    container.className = 'inst-bar';

    names.forEach((name, i) => {
      const tab = document.createElement('button');
      tab.className = 'inst-tab' + (i === activeIdx ? ' active' : '');

      // ── Name (double-click to rename) ──────────────────────────────────
      const nameEl = document.createElement('span');
      nameEl.className = 'inst-name';
      nameEl.textContent = name;
      nameEl.title = 'Double-clic pour renommer';

      nameEl.addEventListener('dblclick', e => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.type      = 'text';
        input.className = 'inst-rename-inp';
        input.value     = names[i];
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const commit = () => {
          names[i] = input.value.trim() || names[i];
          render();
        };
        input.addEventListener('blur',    commit);
        input.addEventListener('click',   e => e.stopPropagation());
        input.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === 'Escape') input.blur();
        });
      });

      // ── Click to switch ────────────────────────────────────────────────
      tab.addEventListener('click', () => {
        if (i === activeIdx) return;
        onSave?.(activeIdx);
        activeIdx = i;
        onLoad?.(activeIdx);
        render();
      });

      tab.appendChild(nameEl);

      // ── × remove ──────────────────────────────────────────────────────
      if (names.length > 1) {
        const x = document.createElement('span');
        x.className   = 'inst-x';
        x.textContent = '×';
        x.title       = 'Remove instance';
        x.addEventListener('click', e => {
          e.stopPropagation();
          if (names.length <= 1) return;
          const removing  = i;
          const wasActive = removing === activeIdx;
          // Let parent clean up its state array BEFORE we shift indices
          onRemove?.(removing);
          names.splice(removing, 1);
          if (wasActive) {
            activeIdx = Math.min(activeIdx, names.length - 1);
            onLoad?.(activeIdx);
          } else if (activeIdx > removing) {
            activeIdx--;
          }
          render();
        });
        tab.appendChild(x);
      }

      container.appendChild(tab);
    });

    // ── + add ──────────────────────────────────────────────────────────
    if (names.length < maxInstances) {
      const addBtn = document.createElement('button');
      addBtn.className   = 'inst-add';
      addBtn.textContent = '+';
      addBtn.title       = 'New instance';
      addBtn.addEventListener('click', () => {
        onSave?.(activeIdx);
        const newIdx = names.length;
        names.push(`Instance ${newIdx + 1}`);
        activeIdx = newIdx;
        onNew?.(newIdx);
        onLoad?.(newIdx);
        render();
      });
      container.appendChild(addBtn);
    }
  }

  render();

  return {
    get activeIdx() { return activeIdx; },
    get count()     { return names.length; },
  };
}
