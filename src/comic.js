// ── Comic ──────────────────────────────────────────────────────────────────
// Éditeur de page BD : panels (image, drag/resize/rotate) + bulles de dialogue,
// sur un unique <canvas> (immediate-mode rendering, pas de DOM overlay comme
// Watermark — cf. plan). Export PNG, save/load projet en JSON.
const Comic = (() => {
  const q = id => document.getElementById(id);
  const MIN_SIZE = 20;

  const CANVAS_PRESETS = [
    { w: 1080, h: 1080, label: 'Instagram (1080×1080)' },
    { w: 1920, h: 1080, label: 'HD (1920×1080)' },
    { w: 800,  h: 1200, label: 'Manga Page (800×1200)' },
    { w: 2480, h: 3508, label: 'A4 Portrait (2480×3508)' },
  ];

  const CORNERS = [
    { fx: 0, fy: 0, anchorFx: 1, anchorFy: 1 },
    { fx: 1, fy: 0, anchorFx: 0, anchorFy: 1 },
    { fx: 0, fy: 1, anchorFx: 1, anchorFy: 0 },
    { fx: 1, fy: 1, anchorFx: 0, anchorFy: 0 },
  ];

  const S = {
    initialized: false,
    tool: 'select',
    project: { canvasWidth: 1080, canvasHeight: 1080, background: '#ffffff', objects: [] },
    selectedId: null,
    undoStack: [],
    redoStack: [],
    _nextId: 1,
  };
  let dragState = null;

  function genId() { return 'obj_' + (S._nextId++) + '_' + Math.random().toString(36).slice(2, 6); }
  function findObject(id) { return S.project.objects.find(o => o.id === id); }
  function rotDeg(o) { return (o.rotation || 0) * Math.PI / 180; }

  // ── Coordinate math (rotation-aware) ─────────────────────────────────────
  function localToWorld(obj, lx, ly) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    const rad = rotDeg(obj);
    const dx = lx - obj.w / 2, dy = ly - obj.h / 2;
    return {
      x: cx + dx * Math.cos(rad) - dy * Math.sin(rad),
      y: cy + dx * Math.sin(rad) + dy * Math.cos(rad),
    };
  }
  function worldToLocal(obj, px, py) {
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    const rad = -rotDeg(obj);
    const dx = px - cx, dy = py - cy;
    return {
      x: dx * Math.cos(rad) - dy * Math.sin(rad) + obj.w / 2,
      y: dx * Math.sin(rad) + dy * Math.cos(rad) + obj.h / 2,
    };
  }
  function hitTestObject(obj, px, py) {
    const lp = worldToLocal(obj, px, py);
    return lp.x >= 0 && lp.x <= obj.w && lp.y >= 0 && lp.y <= obj.h;
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function handleRadius() { return Math.max(8, Math.min(S.project.canvasWidth, S.project.canvasHeight) * 0.012); }
  function rotateHandleOffset() { return Math.min(S.project.canvasWidth, S.project.canvasHeight) * 0.06; }

  function hitTestHandle(obj, pos) {
    const r = handleRadius() * 1.6;
    for (const c of CORNERS) {
      const w = localToWorld(obj, c.fx * obj.w, c.fy * obj.h);
      if (dist(pos, w) <= r) return { type: 'resize', corner: c };
    }
    const rot = localToWorld(obj, obj.w / 2, -rotateHandleOffset());
    if (dist(pos, rot) <= r) return { type: 'rotate' };
    return null;
  }

  function getCanvasPos(e) {
    const canvas = q('comic-canvas');
    const rect = canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (canvas.width / rect.width),
      y: (e.clientY - rect.top) * (canvas.height / rect.height),
    };
  }

  // ── Undo/redo ─────────────────────────────────────────────────────────────
  function projectSnapshotJSON() {
    return JSON.stringify({
      canvasWidth:  S.project.canvasWidth,
      canvasHeight: S.project.canvasHeight,
      background:   S.project.background,
      objects:      S.project.objects.map(({ _img, ...rest }) => rest),
    });
  }
  function pushUndo() {
    S.undoStack.push(projectSnapshotJSON());
    if (S.undoStack.length > 50) S.undoStack.shift();
    S.redoStack = [];
  }
  function restoreFromSnapshot(json) {
    const d = JSON.parse(json);
    S.project.canvasWidth  = d.canvasWidth;
    S.project.canvasHeight = d.canvasHeight;
    S.project.background   = d.background;
    S.project.objects      = d.objects;
    S.selectedId = null;
    preloadImages();
    resizeCanvasElement();
    render();
  }
  function undo() {
    if (!S.undoStack.length) return;
    S.redoStack.push(projectSnapshotJSON());
    restoreFromSnapshot(S.undoStack.pop());
  }
  function redo() {
    if (!S.redoStack.length) return;
    S.undoStack.push(projectSnapshotJSON());
    restoreFromSnapshot(S.redoStack.pop());
  }

  function preloadImages() {
    S.project.objects.forEach(obj => {
      if (obj.type === 'panel' && obj.imageDataUrl && !obj._img) {
        const img = new Image();
        img.onload = () => render();
        img.src = obj.imageDataUrl;
        obj._img = img;
      }
    });
  }

  // ── Layout presets ────────────────────────────────────────────────────────
  function buildLayoutPanels(id, cw, ch) {
    const g = Math.round(Math.min(cw, ch) * 0.02);
    const mk = (x, y, w, h) => ({ id: genId(), type: 'panel', x, y, w, h, rotation: 0, imageDataUrl: null, fit: 'contain' });
    switch (id) {
      case 'solo':
        return [mk(g, g, cw - 2 * g, ch - 2 * g)];
      case 'split': {
        const w = (cw - 3 * g) / 2;
        return [mk(g, g, w, ch - 2 * g), mk(g * 2 + w, g, w, ch - 2 * g)];
      }
      case 'three-equal': {
        const h = (ch - 4 * g) / 3;
        return [mk(g, g, cw - 2 * g, h), mk(g, g * 2 + h, cw - 2 * g, h), mk(g, g * 3 + 2 * h, cw - 2 * g, h)];
      }
      case 'grid2x2': {
        const w = (cw - 3 * g) / 2, h = (ch - 3 * g) / 2;
        return [mk(g, g, w, h), mk(g * 2 + w, g, w, h), mk(g, g * 2 + h, w, h), mk(g * 2 + w, g * 2 + h, w, h)];
      }
      case 'manga-strip': {
        const n = 4, h = ch / n;
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(mk(0, i * h, cw, h));
        return arr;
      }
      default:
        return [];
    }
  }

  function applyCanvasPreset(w, h) {
    if (S.project.objects.length && !confirm('Changer la taille du canvas va réinitialiser le projet. Continuer ?')) return;
    pushUndo();
    S.project.canvasWidth = w;
    S.project.canvasHeight = h;
    S.project.objects = [];
    S.selectedId = null;
    resizeCanvasElement();
    render();
  }

  function applyLayout(layoutId) {
    if (!layoutId) return;
    const panels = buildLayoutPanels(layoutId, S.project.canvasWidth, S.project.canvasHeight);
    const hasImages = S.project.objects.some(o => o.type === 'panel' && o.imageDataUrl);
    if (hasImages && !confirm('Changer de disposition va retirer les images des panels actuels. Continuer ?')) return;
    pushUndo();
    const nonPanels = S.project.objects.filter(o => o.type !== 'panel');
    S.project.objects = [...panels, ...nonPanels];
    S.selectedId = null;
    render();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  function render() {
    const canvas = q('comic-canvas');
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = S.project.background || '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    for (const obj of S.project.objects) {
      if (obj.type === 'panel')  drawPanel(ctx, obj);
      else if (obj.type === 'bubble') drawBubble(ctx, obj);
      else if (obj.type === 'stroke') drawStroke(ctx, obj);
    }

    if (S.selectedId) {
      const sel = findObject(S.selectedId);
      if (sel && sel.type !== 'stroke') drawSelectionHandles(ctx, sel);
    }
  }

  function withClipRotate(ctx, obj, drawFn) {
    ctx.save();
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotDeg(obj));
    ctx.translate(-obj.w / 2, -obj.h / 2);
    drawFn(ctx);
    ctx.restore();
  }

  function drawPanel(ctx, obj) {
    withClipRotate(ctx, obj, ctx => {
      ctx.fillStyle = '#dcdcdc';
      ctx.fillRect(0, 0, obj.w, obj.h);
      if (obj.imageDataUrl && obj._img && obj._img.complete && obj._img.naturalWidth) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(0, 0, obj.w, obj.h);
        ctx.clip();
        const img = obj._img;
        const scale = obj.fit === 'cover'
          ? Math.max(obj.w / img.naturalWidth, obj.h / img.naturalHeight)
          : Math.min(obj.w / img.naturalWidth, obj.h / img.naturalHeight);
        const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
        ctx.drawImage(img, (obj.w - dw) / 2, (obj.h - dh) / 2, dw, dh);
        ctx.restore();
      } else {
        ctx.fillStyle = '#888';
        ctx.font = `${Math.max(12, Math.min(obj.w, obj.h) * 0.06)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Double-clic pour charger une image', obj.w / 2, obj.h / 2, obj.w * 0.9);
      }
      ctx.lineWidth = Math.max(2, Math.min(obj.w, obj.h) * 0.01);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(0, 0, obj.w, obj.h);
    });
  }

  function drawStroke(ctx, obj) {
    if (!obj.points || obj.points.length < 2) return;
    ctx.save();
    ctx.strokeStyle = obj.color || '#000';
    ctx.lineWidth = obj.width || 4;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(obj.points[0].x, obj.points[0].y);
    for (let i = 1; i < obj.points.length; i++) ctx.lineTo(obj.points[i].x, obj.points[i].y);
    ctx.stroke();
    ctx.restore();
  }

  // ── Bubble shapes ─────────────────────────────────────────────────────────
  function roundRectPath(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function pathSpeech(ctx, w, h) {
    const r = Math.min(w, h) * 0.15;
    const tailW = w * 0.14, tailH = h * 0.22, tailX = w * 0.22;
    ctx.beginPath();
    ctx.moveTo(r, 0);
    ctx.lineTo(w - r, 0);
    ctx.arcTo(w, 0, w, r, r);
    ctx.lineTo(w, h - r);
    ctx.arcTo(w, h, w - r, h, r);
    ctx.lineTo(tailX + tailW, h);
    ctx.lineTo(tailX, h + tailH);
    ctx.lineTo(tailX - tailW * 0.4, h);
    ctx.lineTo(r, h);
    ctx.arcTo(0, h, 0, h - r, r);
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
  }

  function pathCaption(ctx, w, h) {
    roundRectPath(ctx, 0, 0, w, h, Math.min(w, h) * 0.08);
  }

  function pathCloud(ctx, w, h) {
    const bumps = 9, cx = w / 2, cy = h / 2, rx = w / 2, ry = h / 2;
    ctx.beginPath();
    for (let i = 0; i <= bumps; i++) {
      const a0 = (Math.PI * 2 * i) / bumps, a1 = (Math.PI * 2 * (i + 1)) / bumps;
      const x0 = cx + Math.cos(a0) * rx, y0 = cy + Math.sin(a0) * ry;
      const xm = cx + Math.cos((a0 + a1) / 2) * rx * 1.15, ym = cy + Math.sin((a0 + a1) / 2) * ry * 1.15;
      const x1 = cx + Math.cos(a1) * rx, y1 = cy + Math.sin(a1) * ry;
      if (i === 0) ctx.moveTo(x0, y0);
      ctx.quadraticCurveTo(xm, ym, x1, y1);
    }
    ctx.closePath();
  }

  function pathShout(ctx, w, h) {
    const cx = w / 2, cy = h / 2, spikes = 11;
    ctx.beginPath();
    for (let i = 0; i < spikes * 2; i++) {
      const angle = (Math.PI * 2 * i) / (spikes * 2);
      const rad = i % 2 === 0 ? 1 : 0.72;
      const x = cx + Math.cos(angle) * (w / 2) * rad;
      const y = cy + Math.sin(angle) * (h / 2) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function drawBubbleText(ctx, obj) {
    if (!obj.text) return;
    ctx.fillStyle = obj.textColor || '#000';
    ctx.font = `${obj.fontSize || 24}px ${obj.font || 'Arial'}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxWidth = obj.w * 0.78;
    const words = obj.text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    const lh = (obj.fontSize || 24) * 1.25;
    const startY = obj.h / 2 - ((lines.length - 1) * lh) / 2;
    lines.forEach((l, i) => ctx.fillText(l, obj.w / 2, startY + i * lh, maxWidth));
  }

  function drawBubble(ctx, obj) {
    withClipRotate(ctx, obj, ctx => {
      const style = obj.style || 'speech';
      if (style === 'speech')      pathSpeech(ctx, obj.w, obj.h);
      else if (style === 'shout')  pathShout(ctx, obj.w, obj.h);
      else if (style === 'cloud')  pathCloud(ctx, obj.w, obj.h);
      else if (style === 'caption') pathCaption(ctx, obj.w, obj.h);
      else /* think */             roundRectPath(ctx, 0, 0, obj.w, obj.h, Math.min(obj.w, obj.h) * 0.35);

      ctx.fillStyle = obj.fillColor || '#ffffff';
      ctx.fill();
      ctx.lineWidth = Math.max(2, Math.min(obj.w, obj.h) * 0.015);
      ctx.strokeStyle = obj.borderColor || '#000000';
      ctx.stroke();

      if (style === 'think') {
        let bx = obj.w * 0.18, by = obj.h + 6, r = Math.min(obj.w, obj.h) * 0.05;
        for (let i = 0; i < 3 && r > 2; i++) {
          ctx.beginPath();
          ctx.arc(bx, by, r, 0, Math.PI * 2);
          ctx.fillStyle = obj.fillColor || '#ffffff';
          ctx.fill();
          ctx.stroke();
          bx -= r * 1.6; by += r * 1.6; r *= 0.65;
        }
      }

      drawBubbleText(ctx, obj);
    });
  }

  function drawSelectionHandles(ctx, obj) {
    ctx.save();
    const cx = obj.x + obj.w / 2, cy = obj.y + obj.h / 2;
    ctx.translate(cx, cy);
    ctx.rotate(rotDeg(obj));
    ctx.strokeStyle = '#4a9eff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(-obj.w / 2, -obj.h / 2, obj.w, obj.h);
    ctx.setLineDash([]);
    ctx.restore();

    const r = handleRadius();
    ctx.fillStyle = '#4a9eff';
    for (const c of CORNERS) {
      const w = localToWorld(obj, c.fx * obj.w, c.fy * obj.h);
      ctx.fillRect(w.x - r / 2, w.y - r / 2, r, r);
    }
    const rot = localToWorld(obj, obj.w / 2, -rotateHandleOffset());
    ctx.beginPath();
    ctx.arc(rot.x, rot.y, r / 2, 0, Math.PI * 2);
    ctx.fill();
  }

  function resizeCanvasElement() {
    const canvas = q('comic-canvas');
    canvas.width = S.project.canvasWidth;
    canvas.height = S.project.canvasHeight;
    const area = q('comic-canvas-area');
    const maxW = Math.max(100, area.clientWidth - 40);
    const maxH = Math.max(100, area.clientHeight - 40);
    const scale = Math.min(maxW / canvas.width, maxH / canvas.height, 1);
    canvas.style.width  = (canvas.width * scale) + 'px';
    canvas.style.height = (canvas.height * scale) + 'px';
  }

  // ── Export / copy ─────────────────────────────────────────────────────────
  function withCleanRender(fn) {
    const prevSel = S.selectedId;
    S.selectedId = null;
    render();
    fn();
    S.selectedId = prevSel;
    render();
  }

  function exportPNG() {
    withCleanRender(() => {
      const a = document.createElement('a');
      a.download = `comic-${Date.now()}.png`;
      a.href = q('comic-canvas').toDataURL('image/png');
      a.click();
    });
  }

  async function copyImage() {
    try {
      let blob;
      await new Promise(resolve => {
        withCleanRender(() => {
          q('comic-canvas').toBlob(b => { blob = b; resolve(); }, 'image/png');
        });
      });
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('✅ Image copiée !');
    } catch (e) {
      toast('❌ Copie impossible: ' + e.message);
    }
  }

  // ── Save / load project ───────────────────────────────────────────────────
  function saveProject() {
    const blob = new Blob([JSON.stringify({ version: 1, ...JSON.parse(projectSnapshotJSON()) }, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `comic-project-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
    toast('Projet sauvegardé !');
  }

  function loadProjectFile(file) {
    const r = new FileReader();
    r.onload = e => {
      try {
        const d = JSON.parse(e.target.result);
        if (!d.objects) throw new Error('Fichier invalide');
        if (S.project.objects.length && !confirm('Remplacer le projet actuel ?')) return;
        pushUndo();
        S.project = {
          canvasWidth:  d.canvasWidth  || 1080,
          canvasHeight: d.canvasHeight || 1080,
          background:   d.background   || '#ffffff',
          objects:      d.objects,
        };
        S.selectedId = null;
        preloadImages();
        resizeCanvasElement();
        render();
        toast('Projet chargé !');
      } catch (err) {
        toast('Fichier invalide: ' + err.message);
      }
    };
    r.readAsText(file);
  }

  function newProject() {
    if (S.project.objects.length && !confirm('Nouveau projet — le projet actuel non sauvegardé sera perdu. Continuer ?')) return;
    pushUndo();
    S.project = { canvasWidth: S.project.canvasWidth, canvasHeight: S.project.canvasHeight, background: '#ffffff', objects: [] };
    S.selectedId = null;
    render();
  }

  function deleteSelected() {
    if (!S.selectedId) return;
    pushUndo();
    S.project.objects = S.project.objects.filter(o => o.id !== S.selectedId);
    S.selectedId = null;
    render();
  }

  // ── Bubble text editor (floating textarea) ───────────────────────────────
  function openBubbleEditor(bubble) {
    pushUndo();
    const canvas = q('comic-canvas');
    const scale = canvas.getBoundingClientRect().width / canvas.width;
    const ta = document.createElement('textarea');
    ta.className = 'comic-bubble-editor';
    ta.value = bubble.text || '';
    ta.style.left   = (bubble.x * scale) + 'px';
    ta.style.top    = (bubble.y * scale) + 'px';
    ta.style.width  = (bubble.w * scale) + 'px';
    ta.style.height = (bubble.h * scale) + 'px';
    q('comic-canvas-wrap').appendChild(ta);
    ta.focus();
    ta.select();

    const commit = () => {
      bubble.text = ta.value;
      ta.remove();
      render();
    };
    ta.addEventListener('blur', commit);
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ta.blur(); }
      if (e.key === 'Escape') { ta.value = bubble.text || ''; ta.blur(); }
      e.stopPropagation();
    });
  }

  function addBubble() {
    pushUndo();
    const style = q('comic-bubble-style').value;
    const w = S.project.canvasWidth * 0.3, h = S.project.canvasHeight * 0.15;
    const bubble = {
      id: genId(), type: 'bubble',
      x: (S.project.canvasWidth - w) / 2, y: (S.project.canvasHeight - h) / 2,
      w, h, rotation: 0, style,
      text: 'Texte…', font: 'Arial', fontSize: Math.max(16, Math.min(w, h) * 0.18),
      textColor: '#000000', fillColor: '#ffffff', borderColor: '#000000',
    };
    S.project.objects.push(bubble);
    S.selectedId = bubble.id;
    render();
  }

  // ── Tool / keyboard ───────────────────────────────────────────────────────
  function setTool(tool) {
    S.tool = tool;
    q('comic-tool-select').classList.toggle('active', tool === 'select');
    q('comic-tool-draw').classList.toggle('active', tool === 'draw');
    q('comic-draw-color').style.display = tool === 'draw' ? '' : 'none';
    q('comic-draw-width').style.display = tool === 'draw' ? '' : 'none';
  }

  function isViewActive() {
    return q('view-comic')?.classList.contains('active');
  }

  document.addEventListener('keydown', e => {
    if (!isViewActive()) return;
    const tag = document.activeElement?.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || document.activeElement?.isContentEditable) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (e.key.toLowerCase() === 's') { setTool('select'); return; }
    if (e.key.toLowerCase() === 'd') { setTool('draw'); return; }
  });

  // ── Mouse interaction ─────────────────────────────────────────────────────
  function bindCanvasEvents() {
    const canvas = q('comic-canvas');

    canvas.addEventListener('mousedown', e => {
      const pos = getCanvasPos(e);

      if (S.tool === 'draw') {
        pushUndo();
        const stroke = { id: genId(), type: 'stroke', points: [pos], color: q('comic-draw-color').value, width: +q('comic-draw-width').value };
        S.project.objects.push(stroke);
        dragState = { mode: 'draw', stroke };
        render();
        return;
      }

      if (S.selectedId) {
        const sel = findObject(S.selectedId);
        if (sel) {
          const handle = hitTestHandle(sel, pos);
          if (handle) {
            pushUndo();
            if (handle.type === 'rotate') {
              dragState = { mode: 'rotate', id: sel.id, center: { x: sel.x + sel.w / 2, y: sel.y + sel.h / 2 } };
            } else {
              dragState = {
                mode: 'resize', id: sel.id, corner: handle.corner,
                anchorWorld: localToWorld(sel, handle.corner.anchorFx * sel.w, handle.corner.anchorFy * sel.h),
              };
            }
            return;
          }
        }
      }

      let hit = null;
      for (let i = S.project.objects.length - 1; i >= 0; i--) {
        const o = S.project.objects[i];
        if (o.type === 'stroke') continue;
        if (hitTestObject(o, pos.x, pos.y)) { hit = o; break; }
      }
      if (hit) {
        S.selectedId = hit.id;
        pushUndo();
        dragState = { mode: 'move', id: hit.id, last: pos };
      } else {
        S.selectedId = null;
      }
      render();
    });

    canvas.addEventListener('mousemove', e => {
      if (!dragState) return;
      const pos = getCanvasPos(e);

      if (dragState.mode === 'draw') {
        dragState.stroke.points.push(pos);
        render();
        return;
      }

      const obj = findObject(dragState.id);
      if (!obj) return;

      if (dragState.mode === 'move') {
        obj.x += pos.x - dragState.last.x;
        obj.y += pos.y - dragState.last.y;
        dragState.last = pos;
      } else if (dragState.mode === 'rotate') {
        const dx = pos.x - dragState.center.x, dy = pos.y - dragState.center.y;
        obj.rotation = Math.atan2(dy, dx) * 180 / Math.PI + 90;
      } else if (dragState.mode === 'resize') {
        const rad = -rotDeg(obj);
        const dx = pos.x - dragState.anchorWorld.x, dy = pos.y - dragState.anchorWorld.y;
        const lx = dx * Math.cos(rad) - dy * Math.sin(rad);
        const ly = dx * Math.sin(rad) + dy * Math.cos(rad);
        const w = Math.max(MIN_SIZE, Math.abs(lx));
        const h = Math.max(MIN_SIZE, Math.abs(ly));
        const ax = dragState.corner.anchorFx, ay = dragState.corner.anchorFy;
        const rad2 = rotDeg(obj);
        const relX = (ax - 0.5) * w, relY = (ay - 0.5) * h;
        const centerX = dragState.anchorWorld.x - (relX * Math.cos(rad2) - relY * Math.sin(rad2));
        const centerY = dragState.anchorWorld.y - (relX * Math.sin(rad2) + relY * Math.cos(rad2));
        obj.w = w; obj.h = h; obj.x = centerX - w / 2; obj.y = centerY - h / 2;
      }
      render();
    });

    canvas.addEventListener('mouseup',    () => { dragState = null; });
    canvas.addEventListener('mouseleave', () => { dragState = null; });

    canvas.addEventListener('dblclick', e => {
      const pos = getCanvasPos(e);
      for (let i = S.project.objects.length - 1; i >= 0; i--) {
        const o = S.project.objects[i];
        if (o.type === 'stroke') continue;
        if (hitTestObject(o, pos.x, pos.y)) {
          if (o.type === 'panel') { S._pendingImagePanelId = o.id; q('comic-file-image').click(); }
          else if (o.type === 'bubble') { openBubbleEditor(o); }
          break;
        }
      }
    });

    canvas.addEventListener('dragover', e => e.preventDefault());
    canvas.addEventListener('drop', e => {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (!file || !file.type.startsWith('image/')) return;
      const pos = getCanvasPos(e);
      const panel = [...S.project.objects].reverse().find(o => o.type === 'panel' && hitTestObject(o, pos.x, pos.y));
      if (!panel) { toast('Dépose l\'image sur un panel'); return; }
      const r = new FileReader();
      r.onload = ev => { pushUndo(); panel.imageDataUrl = ev.target.result; delete panel._img; preloadImages(); };
      r.readAsDataURL(file);
    });
  }

  // ── Send an image in from the gallery ────────────────────────────────────
  function loadFromSrc(url) {
    if (!S.project.objects.some(o => o.type === 'panel')) applyLayout('solo');
    let panel = S.selectedId && findObject(S.selectedId);
    if (!panel || panel.type !== 'panel' || panel.imageDataUrl) {
      panel = S.project.objects.find(o => o.type === 'panel' && !o.imageDataUrl);
    }
    if (!panel) { toast('Tous les panels sont déjà remplis'); return; }
    fetch(url).then(r => r.blob()).then(blob => {
      const r = new FileReader();
      r.onload = ev => { pushUndo(); panel.imageDataUrl = ev.target.result; delete panel._img; preloadImages(); };
      r.readAsDataURL(blob);
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────
  function bindUI() {
    q('comic-canvas-preset').addEventListener('change', e => {
      const [w, h] = e.target.value.split(',').map(Number);
      applyCanvasPreset(w, h);
    });
    q('comic-custom-apply').addEventListener('click', () => {
      const w = +q('comic-custom-w').value, h = +q('comic-custom-h').value;
      if (w > 0 && h > 0) applyCanvasPreset(w, h);
    });
    q('comic-layout-preset').addEventListener('change', e => { applyLayout(e.target.value); e.target.value = ''; });
    q('comic-tool-select').addEventListener('click', () => setTool('select'));
    q('comic-tool-draw').addEventListener('click',   () => setTool('draw'));
    q('comic-add-bubble').addEventListener('click', addBubble);
    q('comic-btn-delete').addEventListener('click', deleteSelected);
    q('comic-btn-undo').addEventListener('click', undo);
    q('comic-btn-redo').addEventListener('click', redo);
    q('comic-btn-new').addEventListener('click', newProject);
    q('comic-btn-save').addEventListener('click', saveProject);
    q('comic-btn-load').addEventListener('click', () => q('comic-file-project').click());
    q('comic-file-project').addEventListener('change', e => {
      if (e.target.files[0]) loadProjectFile(e.target.files[0]);
      e.target.value = '';
    });
    q('comic-btn-copy').addEventListener('click', copyImage);
    q('comic-btn-export').addEventListener('click', exportPNG);
    q('comic-file-image').addEventListener('change', e => {
      const file = e.target.files[0];
      const panel = findObject(S._pendingImagePanelId);
      if (file && panel) {
        const r = new FileReader();
        r.onload = ev => { pushUndo(); panel.imageDataUrl = ev.target.result; delete panel._img; preloadImages(); };
        r.readAsDataURL(file);
      }
      e.target.value = '';
    });

    bindCanvasEvents();
  }

  function init() {
    if (S.initialized) return;
    S.initialized = true;
    bindUI();
    resizeCanvasElement();
    render();
  }

  function onShow() {
    resizeCanvasElement();
    render();
  }

  return { init, onShow, loadFromSrc };
})();
