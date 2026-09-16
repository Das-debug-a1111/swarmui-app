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
    { w: 1280, h: 720,  label: 'HD 720p (1280×720)' },
    { w: 3840, h: 2160, label: '4K (3840×2160)' },
    { w: 1080, h: 1920, label: 'Story/Reels (1080×1920)' },
    { w: 800,  h: 1200, label: 'Manga Page (800×1200)' },
    { w: 2480, h: 3508, label: 'A4 Portrait (2480×3508)' },
    { w: 3508, h: 2480, label: 'A4 Paysage (3508×2480)' },
    { w: 1600, h: 900,  label: 'Twitter Banner (1600×900)' },
    { w: 1200, h: 630,  label: 'Facebook Post (1200×630)' },
  ];

  const CORNERS = [
    { fx: 0, fy: 0, anchorFx: 1, anchorFy: 1 },
    { fx: 1, fy: 0, anchorFx: 0, anchorFy: 1 },
    { fx: 0, fy: 1, anchorFx: 1, anchorFy: 0 },
    { fx: 1, fy: 1, anchorFx: 0, anchorFy: 0 },
  ];

  // `S.project` always points at the active page (`S.pages[S.activePage]`) —
  // it's reassigned on every page switch, never captured once. Every function
  // below reads/writes `S.project.xxx` and keeps working unchanged whichever
  // page it happens to point to.
  const S = {
    initialized: false,
    tool: 'select',
    pages: [{ id: 'pg_1', canvasWidth: 1080, canvasHeight: 1080, background: '#ffffff', objects: [] }],
    activePage: 0,
    project: null,
    selectedId: null,
    histories: {}, // pageId -> { undo: [], redo: [] } — undo/redo is per-page
    autoPack: { queue: [], gallery: [], dispositions: [], selectedIndex: null }, // queue = ordered images to pack; gallery = browsable folder contents; dispositions = comparable auto-pack candidates
    _nextId: 1,
    _nextPageId: 2,
  };
  S.project = S.pages[S.activePage];
  let dragState = null;

  function genId() { return 'obj_' + (S._nextId++) + '_' + Math.random().toString(36).slice(2, 6); }
  function genPageId() { return 'pg_' + (S._nextPageId++); }
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
  // Ray-casting point-in-polygon — poly is an array of {x,y} in the same
  // local space as the test point.
  function pointInPolygon(poly, x, y) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
      const intersect = ((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
      if (intersect) inside = !inside;
    }
    return inside;
  }

  function hitTestObject(obj, px, py) {
    const lp = worldToLocal(obj, px, py);
    if (obj.type === 'panel') {
      const poly = panelVertexList(obj).map(v => ({ x: v.fx * obj.w, y: v.fy * obj.h }));
      return pointInPolygon(poly, lp.x, lp.y);
    }
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
  // Undo/redo is per-page: switching pages must not shift the history of the
  // page you're leaving, and it keeps each snapshot stack (which can embed
  // full base64 panel images) scoped to the page it belongs to.
  function currentHistory() {
    const pid = S.pages[S.activePage].id;
    if (!S.histories[pid]) S.histories[pid] = { undo: [], redo: [] };
    return S.histories[pid];
  }
  function pushUndo() {
    const h = currentHistory();
    h.undo.push(projectSnapshotJSON());
    if (h.undo.length > 50) h.undo.shift();
    h.redo = [];
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
    refreshSidePanels();
  }
  function undo() {
    const h = currentHistory();
    if (!h.undo.length) return;
    h.redo.push(projectSnapshotJSON());
    restoreFromSnapshot(h.undo.pop());
  }
  function redo() {
    const h = currentHistory();
    if (!h.redo.length) return;
    h.undo.push(projectSnapshotJSON());
    restoreFromSnapshot(h.redo.pop());
  }

  // Preloads panel images across ALL pages (not just the active one), so page
  // thumbnails render correctly even for pages the user hasn't switched to yet.
  function preloadImages() {
    S.pages.forEach(page => {
      page.objects.forEach(obj => {
        if (obj.type === 'panel' && obj.imageDataUrl && !obj._img) {
          const img = new Image();
          img.onload = () => { render(); refreshSidePanels(); };
          img.src = obj.imageDataUrl;
          obj._img = img;
        }
      });
    });
  }

  // ── Layout presets ────────────────────────────────────────────────────────
  function buildLayoutPanels(id, cw, ch) {
    const g = Math.round(Math.min(cw, ch) * 0.02);
    const mk = (x, y, w, h, rotation = 0) => ({
      id: genId(), type: 'panel', x, y, w, h, rotation,
      vertices: [{ fx: 0, fy: 0 }, { fx: 1, fy: 0 }, { fx: 1, fy: 1 }, { fx: 0, fy: 1 }],
      imageDataUrl: null, fit: 'contain', imgOffsetX: 0, imgOffsetY: 0, imgZoom: 1,
      borderWidth: null, borderColor: null,
    });
    switch (id) {
      // ── Solo / Full / Centered / Wide ──────────────────────────────────
      case 'solo':
        return [mk(g, g, cw - 2 * g, ch - 2 * g)];
      case 'full':
        return [mk(0, 0, cw, ch)];
      case 'centered': {
        const m = Math.min(cw, ch) * 0.1;
        return [mk(m, m, cw - 2 * m, ch - 2 * m)];
      }
      case 'wide': {
        const h = ch * 0.5;
        return [mk(g, (ch - h) / 2, cw - 2 * g, h)];
      }
      // ── 2 panels ────────────────────────────────────────────────────────
      case 'split': {
        const w = (cw - 3 * g) / 2;
        return [mk(g, g, w, ch - 2 * g), mk(g * 2 + w, g, w, ch - 2 * g)];
      }
      case 'wide-narrow': {
        const wideW = (cw - 3 * g) * 0.65, narrowW = (cw - 3 * g) * 0.35;
        return [mk(g, g, wideW, ch - 2 * g), mk(g * 2 + wideW, g, narrowW, ch - 2 * g)];
      }
      case 'stacked': {
        const h = (ch - 3 * g) / 2;
        return [mk(g, g, cw - 2 * g, h), mk(g, g * 2 + h, cw - 2 * g, h)];
      }
      // ── 3 panels ────────────────────────────────────────────────────────
      case 'three-equal': {
        const h = (ch - 4 * g) / 3;
        return [mk(g, g, cw - 2 * g, h), mk(g, g * 2 + h, cw - 2 * g, h), mk(g, g * 3 + 2 * h, cw - 2 * g, h)];
      }
      case 'big-plus-2': {
        const bigH = (ch - 3 * g) * 0.6, smallH = (ch - 3 * g) * 0.4, w = (cw - 3 * g) / 2;
        return [
          mk(g, g, cw - 2 * g, bigH),
          mk(g, g * 2 + bigH, w, smallH),
          mk(g * 2 + w, g * 2 + bigH, w, smallH),
        ];
      }
      case 'two-plus-big': {
        const smallH = (ch - 3 * g) * 0.4, bigH = (ch - 3 * g) * 0.6, w = (cw - 3 * g) / 2;
        return [
          mk(g, g, w, smallH),
          mk(g * 2 + w, g, w, smallH),
          mk(g, g * 2 + smallH, cw - 2 * g, bigH),
        ];
      }
      // ── 4 panels ────────────────────────────────────────────────────────
      case 'grid2x2': {
        const w = (cw - 3 * g) / 2, h = (ch - 3 * g) / 2;
        return [mk(g, g, w, h), mk(g * 2 + w, g, w, h), mk(g, g * 2 + h, w, h), mk(g * 2 + w, g * 2 + h, w, h)];
      }
      case 'big-plus-3': {
        const bigW = (cw - 3 * g) * 0.55, smallW = (cw - 3 * g) * 0.45;
        const smallH = (ch - 4 * g) / 3;
        const arr = [mk(g, g, bigW, ch - 2 * g)];
        for (let i = 0; i < 3; i++) arr.push(mk(g * 2 + bigW, g + i * (smallH + g), smallW, smallH));
        return arr;
      }
      case 'four-strips': {
        const n = 4, h = (ch - (n + 1) * g) / n;
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(mk(g, g + i * (h + g), cw - 2 * g, h));
        return arr;
      }
      // ── Manga / Webtoon ─────────────────────────────────────────────────
      case 'manga': {
        const topH = ch * 0.4, botH = ch - topH;
        const leftW = cw * 0.4, rightW = cw - leftW;
        return [
          mk(0, 0, cw, topH),
          mk(0, topH, leftW, botH),
          mk(leftW, topH, rightW, botH),
        ];
      }
      case 'webtoon':
      case 'manga-strip': {
        const n = 4, h = ch / n;
        const arr = [];
        for (let i = 0; i < n; i++) arr.push(mk(0, i * h, cw, h));
        return arr;
      }
      // ── 5+ panels ───────────────────────────────────────────────────────
      case 'grid3x2': {
        const w = (cw - 4 * g) / 3, h = (ch - 3 * g) / 2;
        const arr = [];
        for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
          arr.push(mk(g + col * (w + g), g + row * (h + g), w, h));
        }
        return arr;
      }
      case 'story': {
        const bigW = cw * 0.6 - 1.5 * g, bigH = ch * 0.55 - 1.5 * g;
        const rightW = cw - bigW - 3 * g;
        const rightH = (bigH - g) / 2;
        const botH = ch - bigH - 3 * g;
        const botW = (cw - 3 * g) / 2;
        return [
          mk(g, g, bigW, bigH),
          mk(g * 2 + bigW, g, rightW, rightH),
          mk(g * 2 + bigW, g * 2 + rightH, rightW, rightH),
          mk(g, g * 2 + bigH, botW, botH),
          mk(g * 2 + botW, g * 2 + bigH, botW, botH),
        ];
      }
      case 'dynamic': {
        const leftW = cw * 0.35 - 1.5 * g, rightW = cw - leftW - 3 * g;
        const h1 = (ch - 2 * g) * 0.3, h2 = (ch - 2 * g) * 0.4, h3 = (ch - 2 * g) * 0.3;
        return [
          mk(g, g, leftW, ch - 2 * g),
          mk(g * 2 + leftW, g, rightW, h1),
          mk(g * 2 + leftW, g * 2 + h1, rightW, h2),
          mk(g * 2 + leftW, g * 3 + h1 + h2, rightW, h3),
        ];
      }
      case 'action': {
        const w = (cw - 4 * g) / 3;
        const h = ch - 2 * g;
        return [
          mk(g, g, w, h, -3),
          mk(g * 2 + w, g, w, h, 0),
          mk(g * 3 + 2 * w, g, w, h, 3),
        ];
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
    refreshSidePanels();
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
    refreshSidePanels();
  }

  // ── Rendering ─────────────────────────────────────────────────────────────
  // With no args, renders the active page onto the main on-screen canvas
  // (plus selection handles). Pass an offscreen ctx + an explicit page object
  // to render any other page (thumbnails, full-res export) without touching
  // the main canvas or its selection state.
  function render(ctx, project) {
    const isMain = !ctx;
    project = project || S.project;
    if (isMain) ctx = q('comic-canvas').getContext('2d');
    ctx.clearRect(0, 0, project.canvasWidth, project.canvasHeight);
    ctx.fillStyle = project.background || '#ffffff';
    ctx.fillRect(0, 0, project.canvasWidth, project.canvasHeight);

    for (const obj of project.objects) {
      if (obj.type === 'panel')  drawPanel(ctx, obj);
      else if (obj.type === 'bubble') drawBubble(ctx, obj);
      else if (obj.type === 'sfx') drawSfx(ctx, obj);
      else if (obj.type === 'text') drawText(ctx, obj);
      else if (obj.type === 'stroke') drawStroke(ctx, obj);
    }

    if (isMain && S.selectedId) {
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

  function panelVertexList(obj) {
    return (obj.vertices && obj.vertices.length >= 3)
      ? obj.vertices
      : [{ fx: 0, fy: 0 }, { fx: 1, fy: 0 }, { fx: 1, fy: 1 }, { fx: 0, fy: 1 }];
  }

  // Traces the panel's polygon in its own LOCAL (unrotated, 0..w/0..h) space —
  // caller must already be inside the translate+rotate from withClipRotate.
  function tracePanelPolygon(ctx, obj) {
    const verts = panelVertexList(obj);
    ctx.beginPath();
    verts.forEach((v, i) => {
      const x = v.fx * obj.w, y = v.fy * obj.h;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.closePath();
  }

  function drawPanel(ctx, obj) {
    withClipRotate(ctx, obj, ctx => {
      tracePanelPolygon(ctx, obj);
      ctx.fillStyle = '#dcdcdc';
      ctx.fill();
      if (obj.imageDataUrl && obj._img && obj._img.complete && obj._img.naturalWidth) {
        ctx.save();
        tracePanelPolygon(ctx, obj);
        ctx.clip();
        const img = obj._img;
        const zoom = obj.imgZoom || 1;
        const baseScale = obj.fit === 'contain'
          ? Math.min(obj.w / img.naturalWidth, obj.h / img.naturalHeight)
          : Math.max(obj.w / img.naturalWidth, obj.h / img.naturalHeight);
        const scale = baseScale * zoom;
        const dw = img.naturalWidth * scale, dh = img.naturalHeight * scale;
        const dx = (obj.w - dw) / 2 + (obj.imgOffsetX || 0);
        const dy = (obj.h - dh) / 2 + (obj.imgOffsetY || 0);
        ctx.drawImage(img, dx, dy, dw, dh);
        ctx.restore();
      } else {
        ctx.fillStyle = '#888';
        ctx.font = `${Math.max(12, Math.min(obj.w, obj.h) * 0.06)}px sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText('Double-clic pour charger une image', obj.w / 2, obj.h / 2, obj.w * 0.9);
      }
      tracePanelPolygon(ctx, obj);
      ctx.lineWidth = obj.borderWidth != null ? obj.borderWidth : Math.max(2, Math.min(obj.w, obj.h) * 0.01);
      ctx.strokeStyle = obj.borderColor || '#000';
      ctx.stroke();
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

  // Tail direction/position is stored as a point (obj.tailFx, obj.tailFy) — a
  // fraction of the bubble's w/h, usually outside the [0,1] range so it sits
  // past the body's edge. Default (0.22, 1.22) reproduces the original
  // fixed bottom-left tail. hasTail() lists the styles whose path function
  // draws this movable tail (others keep a fixed/no tail).
  function hasTail(style) {
    // shout/jagged (starburst impact shapes), caption (narration box) and
    // no-tail are deliberately tail-less.
    return ['speech', 'angular', 'box', 'double', 'whisper', 'electric', 'think', 'cloud'].includes(style);
  }

  // Finds where the ray from the rect center through the tail tip exits the
  // w×h rectangle — that exit point is where the tail attaches to the body.
  function computeTailBase(w, h, tailFx, tailFy) {
    const tipX = tailFx * w, tipY = tailFy * h;
    const cx = w / 2, cy = h / 2;
    const dx = tipX - cx, dy = tipY - cy;
    if (dx === 0 && dy === 0) return null;
    let tMin = Infinity, edge = null;
    if (dx !== 0) {
      let t = (0 - cx) / dx;
      if (t > 0) { const y = cy + t * dy; if (y >= 0 && y <= h && t < tMin) { tMin = t; edge = 'left'; } }
      t = (w - cx) / dx;
      if (t > 0) { const y = cy + t * dy; if (y >= 0 && y <= h && t < tMin) { tMin = t; edge = 'right'; } }
    }
    if (dy !== 0) {
      let t = (0 - cy) / dy;
      if (t > 0) { const x = cx + t * dx; if (x >= 0 && x <= w && t < tMin) { tMin = t; edge = 'top'; } }
      t = (h - cy) / dy;
      if (t > 0) { const x = cx + t * dx; if (x >= 0 && x <= w && t < tMin) { tMin = t; edge = 'bottom'; } }
    }
    if (!edge || tMin > 1) return null; // tip is inside the body — no tail to draw
    return { edge, bx: cx + tMin * dx, by: cy + tMin * dy, tipX, tipY };
  }

  // Two points straddling the base point along the exit edge, ordered to
  // match the edge's traversal direction in traceRoundedWithTail().
  function tailBasePoints(edge, bx, by, tailW, w, h) {
    if (edge === 'top' || edge === 'bottom') {
      let xa = Math.max(0, Math.min(w, bx - tailW / 2));
      let xb = Math.max(0, Math.min(w, bx + tailW / 2));
      return edge === 'top' ? [{ x: xa, y: by }, { x: xb, y: by }] : [{ x: xb, y: by }, { x: xa, y: by }];
    }
    let ya = Math.max(0, Math.min(h, by - tailW / 2));
    let yb = Math.max(0, Math.min(h, by + tailW / 2));
    return edge === 'right' ? [{ x: bx, y: ya }, { x: bx, y: yb }] : [{ x: bx, y: yb }, { x: bx, y: ya }];
  }

  function tailGeometry(w, h, tailFx, tailFy) {
    const fx = tailFx != null ? tailFx : 0.22;
    const fy = tailFy != null ? tailFy : 1.22;
    const base = computeTailBase(w, h, fx, fy);
    if (!base) return null;
    const tailW = Math.min(w, h) * 0.16;
    const [p1, p2] = tailBasePoints(base.edge, base.bx, base.by, tailW, w, h);
    return { edge: base.edge, p1, p2, tip: { x: base.tipX, y: base.tipY } };
  }

  // Traces a rounded (or, with r=0, straight-cornered) rect, replacing the
  // straight run on tailInfo.edge with a detour out to the tail tip.
  function traceRoundedWithTail(ctx, w, h, r, tailInfo) {
    const onEdge = e => tailInfo && tailInfo.edge === e;
    const detour = () => { ctx.lineTo(tailInfo.p1.x, tailInfo.p1.y); ctx.lineTo(tailInfo.tip.x, tailInfo.tip.y); ctx.lineTo(tailInfo.p2.x, tailInfo.p2.y); };
    ctx.beginPath();
    ctx.moveTo(r, 0);
    if (onEdge('top')) detour();
    ctx.lineTo(w - r, 0);
    ctx.arcTo(w, 0, w, r, r);
    if (onEdge('right')) detour();
    ctx.lineTo(w, h - r);
    ctx.arcTo(w, h, w - r, h, r);
    if (onEdge('bottom')) detour();
    ctx.lineTo(r, h);
    ctx.arcTo(0, h, 0, h - r, r);
    if (onEdge('left')) detour();
    ctx.lineTo(0, r);
    ctx.arcTo(0, 0, r, 0, r);
    ctx.closePath();
  }

  function pathSpeech(ctx, w, h, obj) {
    const r = Math.min(w, h) * 0.15;
    traceRoundedWithTail(ctx, w, h, r, tailGeometry(w, h, obj && obj.tailFx, obj && obj.tailFy));
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

  function pathAngular(ctx, w, h, obj) {
    traceRoundedWithTail(ctx, w, h, 0, tailGeometry(w, h, obj && obj.tailFx, obj && obj.tailFy));
  }

  function pathBox(ctx, w, h, obj) {
    traceRoundedWithTail(ctx, w, h, 0, tailGeometry(w, h, obj && obj.tailFx, obj && obj.tailFy));
  }

  function pathJagged(ctx, w, h) {
    const cx = w / 2, cy = h / 2;
    const points = 16;
    ctx.beginPath();
    for (let i = 0; i < points; i++) {
      const angle = (Math.PI * 2 * i) / points;
      const rad = 0.85 + Math.sin(i * 2.7) * 0.15;
      const x = cx + Math.cos(angle) * (w / 2) * rad;
      const y = cy + Math.sin(angle) * (h / 2) * rad;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
  }

  function pathElectric(ctx, w, h, obj) {
    const r = Math.min(w, h) * 0.12;
    const points = 20;
    const cx = w / 2, cy = h / 2;
    const fx = obj && obj.tailFx != null ? obj.tailFx : 0.22;
    const fy = obj && obj.tailFy != null ? obj.tailFy : 1.22;
    const tipX = fx * w, tipY = fy * h;
    const targetAngle = (Math.atan2(tipY - cy, tipX - cx) + Math.PI * 2) % (Math.PI * 2);
    const tailW = Math.min(w, h) * 0.16;
    const loopPoint = (angle, jitter) => ({
      x: cx + Math.cos(angle) * (w / 2 - r) * jitter,
      y: cy + Math.sin(angle) * (h / 2 - r) * jitter,
    });

    ctx.beginPath();
    let inserted = false, prevAngle = 0;
    for (let i = 0; i <= points; i++) {
      const angle = (i / points) * Math.PI * 2;
      const jitter = 1 + (i % 3 === 0 ? 0.12 : -0.06);
      const pt = loopPoint(angle, jitter);
      if (i === 0) ctx.moveTo(pt.x, pt.y); else ctx.lineTo(pt.x, pt.y);
      if (!inserted && i > 0 && prevAngle <= targetAngle && angle > targetAngle) {
        const base = loopPoint(targetAngle, 1);
        const tangent = targetAngle + Math.PI / 2;
        const half = tailW / 2;
        ctx.lineTo(base.x - Math.cos(tangent) * half, base.y - Math.sin(tangent) * half);
        ctx.lineTo(tipX, tipY);
        ctx.lineTo(base.x + Math.cos(tangent) * half, base.y + Math.sin(tangent) * half);
        inserted = true;
      }
      prevAngle = angle;
    }
    ctx.closePath();
  }

  // ── Rich text helpers (bold/italic/underline/highlight, shared by
  // bubble/sfx/text objects) ─────────────────────────────────────────────────
  function fontString(obj, defaultFamily) {
    return `${obj.italic ? 'italic ' : ''}${obj.bold ? 'bold ' : ''}${obj.fontSize || 24}px ${obj.font || defaultFamily}`;
  }
  function wrapText(ctx, text, maxWidth) {
    const words = text.split(/\s+/);
    const lines = [];
    let cur = '';
    for (const word of words) {
      const test = cur ? cur + ' ' + word : word;
      if (ctx.measureText(test).width > maxWidth && cur) { lines.push(cur); cur = word; }
      else cur = test;
    }
    if (cur) lines.push(cur);
    return lines;
  }
  function drawHighlightBg(ctx, obj, lines, centerX, startY, lh, maxWidth) {
    if (!obj.highlight) return;
    ctx.save();
    ctx.fillStyle = obj.fillColor || '#ffff66';
    lines.forEach((l, i) => {
      const y = startY + i * lh;
      const lw = Math.min(ctx.measureText(l).width, maxWidth);
      ctx.fillRect(centerX - lw / 2 - lh * 0.12, y - lh / 2, lw + lh * 0.24, lh);
    });
    ctx.restore();
  }
  function drawStyledLines(ctx, obj, lines, centerX, startY, lh, maxWidth) {
    const fontSize = obj.fontSize || 24;
    lines.forEach((l, i) => {
      const y = startY + i * lh;
      ctx.fillText(l, centerX, y, maxWidth);
      if (obj.underline) {
        const lw = Math.min(ctx.measureText(l).width, maxWidth);
        ctx.save();
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = Math.max(1, fontSize * 0.06);
        ctx.beginPath();
        ctx.moveTo(centerX - lw / 2, y + fontSize * 0.38);
        ctx.lineTo(centerX + lw / 2, y + fontSize * 0.38);
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  function drawBubbleText(ctx, obj) {
    if (!obj.text) return;
    ctx.font = fontString(obj, 'Arial');
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const maxWidth = obj.w * 0.78;
    const lines = wrapText(ctx, obj.text, maxWidth);
    const lh = (obj.fontSize || 24) * 1.25;
    const startY = obj.h / 2 - ((lines.length - 1) * lh) / 2;
    drawHighlightBg(ctx, obj, lines, obj.w / 2, startY, lh, maxWidth);
    ctx.fillStyle = obj.textColor || '#000';
    drawStyledLines(ctx, obj, lines, obj.w / 2, startY, lh, maxWidth);
  }

  function tracePathForStyle(ctx, style, w, h, obj) {
    if (style === 'speech')       pathSpeech(ctx, w, h, obj);
    else if (style === 'shout')   pathShout(ctx, w, h);
    else if (style === 'cloud')   pathCloud(ctx, w, h);
    else if (style === 'caption') pathCaption(ctx, w, h);
    else if (style === 'angular') pathAngular(ctx, w, h, obj);
    else if (style === 'box')     pathBox(ctx, w, h, obj);
    else if (style === 'jagged')  pathJagged(ctx, w, h);
    else if (style === 'electric') pathElectric(ctx, w, h, obj);
    else if (style === 'double')  pathSpeech(ctx, w, h, obj);
    else if (style === 'no-tail') roundRectPath(ctx, 0, 0, w, h, Math.min(w, h) * 0.2);
    else if (style === 'whisper') traceRoundedWithTail(ctx, w, h, Math.min(w, h) * 0.35, tailGeometry(w, h, obj && obj.tailFx, obj && obj.tailFy));
    else /* think/cloud handled above; caption/no-tail have no tail */
                                  roundRectPath(ctx, 0, 0, w, h, Math.min(w, h) * 0.35);
  }

  // Think/cloud bubbles point with a shrinking chain of circles instead of a
  // triangular tail. Starts at the body's edge in the tail direction and
  // marches toward the tip — same obj.tailFx/tailFy as the other styles.
  function drawTrailingBubbles(ctx, obj) {
    const w = obj.w, h = obj.h;
    const fx = obj.tailFx != null ? obj.tailFx : 0.22;
    const fy = obj.tailFy != null ? obj.tailFy : 1.22;
    const tipX = fx * w, tipY = fy * h;
    const base = computeTailBase(w, h, fx, fy);
    const startX = base ? base.bx : w / 2, startY = base ? base.by : h / 2;
    const dx = tipX - startX, dy = tipY - startY;
    const d = Math.hypot(dx, dy) || 1;
    const ux = dx / d, uy = dy / d;
    let bx = startX, by = startY, r = Math.min(w, h) * 0.05;
    const step = Math.max(r * 1.6, d / 3.2);
    for (let i = 0; i < 3 && r > 2; i++) {
      ctx.beginPath();
      ctx.arc(bx, by, r, 0, Math.PI * 2);
      ctx.fillStyle = obj.fillColor || '#ffffff';
      ctx.fill();
      ctx.stroke();
      bx += ux * step; by += uy * step; r *= 0.65;
    }
  }

  function drawBubble(ctx, obj) {
    withClipRotate(ctx, obj, ctx => {
      const style = obj.style || 'speech';
      tracePathForStyle(ctx, style, obj.w, obj.h, obj);

      ctx.fillStyle = obj.fillColor || '#ffffff';
      ctx.fill();
      ctx.lineWidth = obj.borderWidth != null ? obj.borderWidth : Math.max(2, Math.min(obj.w, obj.h) * 0.015);
      ctx.strokeStyle = obj.borderColor || '#000000';
      if (style === 'whisper') ctx.setLineDash([ctx.lineWidth * 1.5, ctx.lineWidth * 1.5]);
      ctx.stroke();
      ctx.setLineDash([]);

      if (style === 'double') {
        const inset = Math.max(3, Math.min(obj.w, obj.h) * 0.05);
        ctx.save();
        ctx.translate(inset, inset);
        pathSpeech(ctx, obj.w - inset * 2, obj.h - inset * 2, obj);
        ctx.stroke();
        ctx.restore();
      }

      if (style === 'think' || style === 'cloud') drawTrailingBubbles(ctx, obj);

      drawBubbleText(ctx, obj);
    });
  }

  // ── SFX (sound effect: BOOM/POW-style stylized text) ───────────────────────
  function drawSfx(ctx, obj) {
    withClipRotate(ctx, obj, ctx => {
      if (obj.background && obj.background !== 'none') {
        tracePathForStyle(ctx, obj.background, obj.w, obj.h);
        ctx.fillStyle = obj.fillColor || '#ffeb3b';
        ctx.fill();
      }

      const fontSize = obj.fontSize || 48;
      const text = obj.text || '';
      const maxW = obj.w * 0.95;
      ctx.font = fontString(obj, 'Impact');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.lineJoin = 'round';
      const outline = obj.outlineWidth != null ? obj.outlineWidth : Math.max(2, fontSize * 0.12);
      if (outline > 0) {
        ctx.lineWidth = outline;
        ctx.strokeStyle = obj.outlineColor || '#000000';
        ctx.strokeText(text, obj.w / 2, obj.h / 2, maxW);
      }
      ctx.fillStyle = obj.textColor || '#ffffff';
      ctx.fillText(text, obj.w / 2, obj.h / 2, maxW);
      if (obj.underline && text) {
        const lw = Math.min(ctx.measureText(text).width, maxW);
        ctx.save();
        ctx.strokeStyle = ctx.fillStyle;
        ctx.lineWidth = Math.max(1, fontSize * 0.06);
        ctx.beginPath();
        ctx.moveTo(obj.w / 2 - lw / 2, obj.h / 2 + fontSize * 0.42);
        ctx.lineTo(obj.w / 2 + lw / 2, obj.h / 2 + fontSize * 0.42);
        ctx.stroke();
        ctx.restore();
      }
    });
  }

  // ── Free text (no shape, optional highlight background) ───────────────────
  function drawText(ctx, obj) {
    withClipRotate(ctx, obj, ctx => {
      if (!obj.text) return;
      ctx.font = fontString(obj, 'Arial');
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      const maxWidth = obj.w * 0.94;
      const lines = wrapText(ctx, obj.text, maxWidth);
      const lh = (obj.fontSize || 28) * 1.25;
      const startY = obj.h / 2 - ((lines.length - 1) * lh) / 2;
      drawHighlightBg(ctx, obj, lines, obj.w / 2, startY, lh, maxWidth);
      ctx.fillStyle = obj.textColor || '#000000';
      drawStyledLines(ctx, obj, lines, obj.w / 2, startY, lh, maxWidth);
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

    if (S.tool === 'vertex' && obj.type === 'panel') {
      ctx.fillStyle = '#ffb020';
      panelVertexList(obj).forEach(v => {
        const w = localToWorld(obj, v.fx * obj.w, v.fy * obj.h);
        ctx.beginPath();
        ctx.arc(w.x, w.y, r / 2, 0, Math.PI * 2);
        ctx.fill();
      });
      return;
    }

    ctx.fillStyle = '#4a9eff';
    for (const c of CORNERS) {
      const w = localToWorld(obj, c.fx * obj.w, c.fy * obj.h);
      ctx.fillRect(w.x - r / 2, w.y - r / 2, r, r);
    }
    const rot = localToWorld(obj, obj.w / 2, -rotateHandleOffset());
    ctx.beginPath();
    ctx.arc(rot.x, rot.y, r / 2, 0, Math.PI * 2);
    ctx.fill();

    if (obj.type === 'bubble' && hasTail(obj.style)) {
      const fx = obj.tailFx != null ? obj.tailFx : 0.22, fy = obj.tailFy != null ? obj.tailFy : 1.22;
      const tw = localToWorld(obj, fx * obj.w, fy * obj.h);
      ctx.fillStyle = '#ff6b35';
      ctx.beginPath();
      ctx.arc(tw.x, tw.y, r / 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  function resizeCanvasElement() {
    const canvas = q('comic-canvas');
    canvas.width = S.project.canvasWidth;
    canvas.height = S.project.canvasHeight;
    let scale;
    if (S.viewZoom) {
      scale = S.viewZoom;
    } else {
      const area = q('comic-canvas-area');
      const maxW = Math.max(100, area.clientWidth - 40);
      const maxH = Math.max(100, area.clientHeight - 40);
      scale = Math.min(maxW / canvas.width, maxH / canvas.height, 1);
    }
    canvas.style.width  = (canvas.width * scale) + 'px';
    canvas.style.height = (canvas.height * scale) + 'px';
    const label = q('comic-zoom-val');
    if (label) label.textContent = Math.round(scale * 100) + '%';
  }

  function setViewZoom(zoom) {
    S.viewZoom = zoom;
    resizeCanvasElement();
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

  // ── Multi-page export (PNG zip or PDF, user's choice) ──────────────────────
  function renderPageToDataURL(page) {
    const canvas = document.createElement('canvas');
    canvas.width = page.canvasWidth;
    canvas.height = page.canvasHeight;
    render(canvas.getContext('2d'), page);
    return canvas.toDataURL('image/png');
  }

  async function exportAllPagesZip() {
    const btn = q('comic-btn-export');
    const original = btn.textContent;
    btn.disabled = true;
    btn.textContent = '⏳ Compression…';
    try {
      const zip = new JSZip();
      S.pages.forEach((page, i) => {
        const base64 = renderPageToDataURL(page).split(',')[1];
        zip.file(`page-${String(i + 1).padStart(2, '0')}.png`, base64, { base64: true });
      });
      const blob = await zip.generateAsync({ type: 'blob' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `comic-${Date.now()}.zip`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 60000);
      toast(`✅ ${S.pages.length} pages exportées`);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  }

  function exportAllPagesPDF() {
    const orientation = p => (p.canvasWidth >= p.canvasHeight ? 'l' : 'p');
    const first = S.pages[0];
    const doc = new jspdf.jsPDF({ orientation: orientation(first), unit: 'px', format: [first.canvasWidth, first.canvasHeight] });
    S.pages.forEach((page, i) => {
      if (i > 0) doc.addPage([page.canvasWidth, page.canvasHeight], orientation(page));
      doc.addImage(renderPageToDataURL(page), 'PNG', 0, 0, page.canvasWidth, page.canvasHeight);
    });
    doc.save(`comic-${Date.now()}.pdf`);
    toast(`✅ PDF exporté (${S.pages.length} pages)`);
  }

  function exportProject() {
    if (S.pages.length <= 1) { exportPNG(); return; }
    if (q('comic-export-format').value === 'pdf') exportAllPagesPDF();
    else exportAllPagesZip();
  }

  // ── Save / load project ───────────────────────────────────────────────────
  // v2 format: { version: 2, activePageIndex, pages: [{id,canvasWidth,canvasHeight,background,objects}, ...] }.
  // v1 (legacy, single page): { version: 1, canvasWidth, canvasHeight, background, objects } — still loadable.
  function saveProject() {
    const data = {
      version: 2,
      activePageIndex: S.activePage,
      pages: S.pages.map(p => ({
        id: p.id,
        canvasWidth: p.canvasWidth,
        canvasHeight: p.canvasHeight,
        background: p.background,
        objects: p.objects.map(({ _img, ...rest }) => rest),
      })),
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
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
        let pages;
        if (Array.isArray(d.pages) && d.pages.length) {
          pages = d.pages.map(p => ({
            id: p.id || genPageId(),
            canvasWidth: p.canvasWidth || 1080,
            canvasHeight: p.canvasHeight || 1080,
            background: p.background || '#ffffff',
            objects: p.objects || [],
          }));
        } else if (d.objects) {
          pages = [{
            id: genPageId(),
            canvasWidth: d.canvasWidth || 1080,
            canvasHeight: d.canvasHeight || 1080,
            background: d.background || '#ffffff',
            objects: d.objects,
          }];
        } else {
          throw new Error('Fichier invalide');
        }
        if (S.pages.some(p => p.objects.length) && !confirm('Remplacer le projet actuel ?')) return;
        S.pages = pages;
        S.histories = {};
        S.activePage = -1; // force switchToPage below to actually apply page 0
        switchToPage(Math.min(d.activePageIndex || 0, pages.length - 1));
        preloadImages();
        toast('Projet chargé !');
      } catch (err) {
        toast('Fichier invalide: ' + err.message);
      }
    };
    r.readAsText(file);
  }

  function newProject() {
    if (S.pages.some(p => p.objects.length) && !confirm('Nouveau projet — le projet actuel non sauvegardé sera perdu. Continuer ?')) return;
    S.pages = [{ id: genPageId(), canvasWidth: S.project.canvasWidth, canvasHeight: S.project.canvasHeight, background: '#ffffff', objects: [] }];
    S.histories = {};
    S.activePage = -1;
    switchToPage(0);
  }

  function deleteSelected() {
    if (!S.selectedId) return;
    pushUndo();
    S.project.objects = S.project.objects.filter(o => o.id !== S.selectedId);
    S.selectedId = null;
    render();
    refreshSidePanels();
  }

  // ── Copy/paste (bubbles & SFX) ────────────────────────────────────────────
  // In-memory clipboard (not the system clipboard) — mirrors the app's
  // undo-stack pattern, just for a single object snapshot.
  let objectClipboard = null;

  function copySelected() {
    const sel = S.selectedId && findObject(S.selectedId);
    if (!sel || (sel.type !== 'bubble' && sel.type !== 'sfx' && sel.type !== 'text')) return;
    objectClipboard = JSON.parse(JSON.stringify(sel));
  }

  function pasteClipboard() {
    if (!objectClipboard) return;
    pushUndo();
    const copy = JSON.parse(JSON.stringify(objectClipboard));
    copy.id = genId();
    copy.x += 24;
    copy.y += 24;
    S.project.objects.push(copy);
    S.selectedId = copy.id;
    syncBubbleControls(copy);
    render();
    refreshSidePanels();
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
      refreshSidePanels();
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
    const font = q('comic-bubble-font').value;
    const textColor = q('comic-text-color').value;
    const fontSize = +q('comic-text-size').value;
    const w = S.project.canvasWidth * 0.3, h = S.project.canvasHeight * 0.15;
    const bubble = {
      id: genId(), type: 'bubble',
      x: (S.project.canvasWidth - w) / 2, y: (S.project.canvasHeight - h) / 2,
      w, h, rotation: 0, style,
      text: 'Texte…', font, fontSize,
      textColor, fillColor: '#ffffff', borderColor: '#000000', borderWidth: null,
      bold: false, italic: false, underline: false,
      tailFx: 0.22, tailFy: 1.22,
    };
    S.project.objects.push(bubble);
    S.selectedId = bubble.id;
    syncBubbleControls(bubble);
    render();
    refreshSidePanels();
  }

  function addText() {
    pushUndo();
    const font = q('comic-bubble-font').value;
    const textColor = q('comic-text-color').value;
    const fontSize = +q('comic-text-size').value;
    const w = S.project.canvasWidth * 0.4, h = S.project.canvasHeight * 0.12;
    const text = {
      id: genId(), type: 'text',
      x: (S.project.canvasWidth - w) / 2, y: (S.project.canvasHeight - h) / 2,
      w, h, rotation: 0,
      text: 'Texte…', font, fontSize, textColor,
      bold: false, italic: false, underline: false,
      highlight: false, fillColor: '#ffff66',
    };
    S.project.objects.push(text);
    S.selectedId = text.id;
    syncBubbleControls(text);
    render();
    refreshSidePanels();
  }

  function syncBubbleControls(obj) {
    if (!obj) return;
    const textLike = obj.type === 'bubble' || obj.type === 'sfx' || obj.type === 'text';
    if (textLike) {
      q('comic-bubble-font').value = obj.font || (obj.type === 'sfx' ? 'Impact' : 'Arial');
      q('comic-text-color').value = obj.textColor || (obj.type === 'sfx' ? '#ffffff' : '#000000');
      q('comic-text-size').value = Math.round(obj.fontSize || 32);
      q('comic-text-size-val').textContent = Math.round(obj.fontSize || 32) + 'px';
      q('comic-fill-color').value = obj.fillColor || '#ffffff';
      q('comic-toggle-bold').classList.toggle('active', !!obj.bold);
      q('comic-toggle-italic').classList.toggle('active', !!obj.italic);
      q('comic-toggle-underline').classList.toggle('active', !!obj.underline);
      q('comic-toggle-highlight').classList.toggle('active', !!obj.highlight);
    }
    if (obj.type === 'bubble') {
      q('comic-bubble-style').value = obj.style || 'speech';
      q('comic-border-color').value = obj.borderColor || '#000000';
      const bw = obj.borderWidth != null ? obj.borderWidth : 0;
      q('comic-border-width').value = bw;
      q('comic-border-width-val').textContent = bw + 'px';
    }
  }

  function addSfx() {
    pushUndo();
    const background = q('comic-sfx-bg').value;
    const font = q('comic-bubble-font').value;
    const textColor = q('comic-text-color').value;
    const fontSize = +q('comic-text-size').value;
    const text = q('comic-sfx-preset').value || 'BOOM!';
    const w = S.project.canvasWidth * 0.28, h = S.project.canvasHeight * 0.16;
    const sfx = {
      id: genId(), type: 'sfx',
      x: (S.project.canvasWidth - w) / 2, y: (S.project.canvasHeight - h) / 2,
      w, h, rotation: 0,
      text, font, fontSize,
      textColor, outlineColor: '#000000', outlineWidth: null,
      background, fillColor: '#ffeb3b',
      bold: true, italic: false, underline: false,
    };
    S.project.objects.push(sfx);
    S.selectedId = sfx.id;
    syncBubbleControls(sfx);
    render();
    refreshSidePanels();
  }

  // ── Tool / keyboard ───────────────────────────────────────────────────────
  function setTool(tool) {
    S.tool = tool;
    q('comic-tool-select').classList.toggle('active', tool === 'select');
    q('comic-tool-draw').classList.toggle('active', tool === 'draw');
    q('comic-tool-vertex').classList.toggle('active', tool === 'vertex');
    q('comic-tool-eraser').classList.toggle('active', tool === 'eraser');
    q('comic-draw-color').style.display = tool === 'draw' ? '' : 'none';
    q('comic-draw-width').style.display = tool === 'draw' ? '' : 'none';
    q('comic-add-vertex').style.display = tool === 'vertex' ? '' : 'none';
    render();
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
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); copySelected(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') { e.preventDefault(); pasteClipboard(); return; }
    if (e.ctrlKey || e.metaKey) return;
    if (e.key.toLowerCase() === 's' || e.key.toLowerCase() === 'v') { setTool('select'); return; }
    if (e.key.toLowerCase() === 'd') { setTool('draw'); return; }
    if (e.key.toLowerCase() === 'e') { setTool('eraser'); return; }
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
        refreshSidePanels();
        return;
      }

      if (S.tool === 'eraser') {
        pushUndo();
        dragState = { mode: 'erase' };
        eraseStrokesNear(pos);
        return;
      }

      if (S.tool === 'vertex' && S.selectedId) {
        const sel = findObject(S.selectedId);
        if (sel && sel.type === 'panel') {
          const r = handleRadius() * 1.6;
          const verts = panelVertexList(sel);
          for (let i = 0; i < verts.length; i++) {
            const w = localToWorld(sel, verts[i].fx * sel.w, verts[i].fy * sel.h);
            if (dist(pos, w) <= r) {
              pushUndo();
              S._lastVertexHit = { objId: sel.id, index: i };
              dragState = { mode: 'vertex', id: sel.id, vertexIndex: i };
              return;
            }
          }
        }
      } else if (S.selectedId) {
        const sel = findObject(S.selectedId);
        if (sel) {
          if (sel.type === 'bubble' && hasTail(sel.style)) {
            const fx = sel.tailFx != null ? sel.tailFx : 0.22, fy = sel.tailFy != null ? sel.tailFy : 1.22;
            const tw = localToWorld(sel, fx * sel.w, fy * sel.h);
            if (dist(pos, tw) <= handleRadius() * 1.6) {
              pushUndo();
              dragState = { mode: 'tail', id: sel.id };
              return;
            }
          }
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
        syncBubbleControls(hit);
        pushUndo();
        dragState = (e.ctrlKey && hit.type === 'panel')
          ? { mode: 'imgmove', id: hit.id, last: pos }
          : { mode: 'move', id: hit.id, last: pos };
      } else {
        S.selectedId = null;
      }
      render();
      refreshSidePanels();
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
      } else if (dragState.mode === 'vertex') {
        const lp = worldToLocal(obj, pos.x, pos.y);
        const verts = panelVertexList(obj);
        verts[dragState.vertexIndex] = {
          fx: Math.min(1.5, Math.max(-0.5, lp.x / obj.w)),
          fy: Math.min(1.5, Math.max(-0.5, lp.y / obj.h)),
        };
        obj.vertices = verts;
      } else if (dragState.mode === 'tail') {
        const lp = worldToLocal(obj, pos.x, pos.y);
        obj.tailFx = lp.x / obj.w;
        obj.tailFy = lp.y / obj.h;
      } else if (dragState.mode === 'imgmove') {
        obj.imgOffsetX = (obj.imgOffsetX || 0) + (pos.x - dragState.last.x);
        obj.imgOffsetY = (obj.imgOffsetY || 0) + (pos.y - dragState.last.y);
        dragState.last = pos;
      } else if (dragState.mode === 'erase') {
        eraseStrokesNear(pos);
      }
      render();
    });

    canvas.addEventListener('mouseup',    () => { dragState = null; refreshSidePanels(); });
    canvas.addEventListener('mouseleave', () => { dragState = null; });

    canvas.addEventListener('dblclick', e => {
      const pos = getCanvasPos(e);
      for (let i = S.project.objects.length - 1; i >= 0; i--) {
        const o = S.project.objects[i];
        if (o.type === 'stroke') continue;
        if (hitTestObject(o, pos.x, pos.y)) {
          if (o.type === 'panel') { S._pendingImagePanelId = o.id; q('comic-file-image').click(); }
          else if (o.type === 'bubble' || o.type === 'sfx' || o.type === 'text') { openBubbleEditor(o); }
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

    canvas.addEventListener('wheel', e => {
      const pos = getCanvasPos(e);
      const panel = [...S.project.objects].reverse().find(o => o.type === 'panel' && hitTestObject(o, pos.x, pos.y));
      if (!panel) return;
      e.preventDefault();
      const delta = e.deltaY < 0 ? 0.05 : -0.05;
      panel.imgZoom = Math.max(0.2, Math.min(5, (panel.imgZoom || 1) + delta));
      render();
    }, { passive: false });
  }

  // ── Eraser ────────────────────────────────────────────────────────────────
  function eraseStrokesNear(pos) {
    const r = handleRadius() * 2;
    const before = S.project.objects.length;
    S.project.objects = S.project.objects.filter(o => {
      if (o.type !== 'stroke') return true;
      return !o.points.some(p => dist(p, pos) <= r);
    });
    if (S.project.objects.length !== before) render();
  }

  function clearAllStrokes() {
    pushUndo();
    S.project.objects = S.project.objects.filter(o => o.type !== 'stroke');
    render();
    refreshSidePanels();
  }

  // ── Vertex tool ───────────────────────────────────────────────────────────
  function addVertexToSelected() {
    const sel = S.selectedId && findObject(S.selectedId);
    if (!sel || sel.type !== 'panel') { toast('Sélectionne un panel'); return; }
    pushUndo();
    const verts = panelVertexList(sel);
    // Insert a midpoint on the longest edge (in local px) — simple, always valid.
    let bestI = 0, bestLen = -1;
    for (let i = 0; i < verts.length; i++) {
      const a = verts[i], b = verts[(i + 1) % verts.length];
      const len = Math.hypot((b.fx - a.fx) * sel.w, (b.fy - a.fy) * sel.h);
      if (len > bestLen) { bestLen = len; bestI = i; }
    }
    const a = verts[bestI], b = verts[(bestI + 1) % verts.length];
    const mid = { fx: (a.fx + b.fx) / 2, fy: (a.fy + b.fy) / 2 };
    sel.vertices = [...verts.slice(0, bestI + 1), mid, ...verts.slice(bestI + 1)];
    render();
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
      r.onload = ev => { pushUndo(); panel.imageDataUrl = ev.target.result; delete panel._img; preloadImages(); refreshSidePanels(); };
      r.readAsDataURL(blob);
    });
  }

  // ── Side panels (layers + page thumbnails) ────────────────────────────────
  function refreshSidePanels() {
    renderLayersPanel();
    renderPageStrip();
  }

  // ── Pages (multi-page projects, each page free to have its own size) ─────
  function switchToPage(i) {
    if (i < 0 || i >= S.pages.length || i === S.activePage) return;
    S.activePage = i;
    S.project = S.pages[i];
    S.selectedId = null;
    resizeCanvasElement();
    render();
    refreshSidePanels();
  }

  function addPage() {
    const page = {
      id: genPageId(),
      canvasWidth: S.project.canvasWidth,
      canvasHeight: S.project.canvasHeight,
      background: '#ffffff',
      objects: [],
    };
    S.pages.push(page);
    switchToPage(S.pages.length - 1);
  }

  function deletePage(id) {
    if (S.pages.length <= 1) { toast('Impossible de supprimer la dernière page'); return; }
    const i = S.pages.findIndex(p => p.id === id);
    if (i < 0) return;
    if (S.pages[i].objects.length && !confirm('Supprimer cette page et son contenu ?')) return;
    delete S.histories[id];
    S.pages.splice(i, 1);
    const nextActive = Math.min(S.activePage, S.pages.length - 1);
    S.activePage = -1; // ensures switchToPage runs even if the numeric index is unchanged
    switchToPage(nextActive);
  }

  function reorderPage(draggedId, targetId) {
    const activeId = S.pages[S.activePage].id;
    const from = S.pages.findIndex(p => p.id === draggedId);
    if (from < 0) return;
    const [moved] = S.pages.splice(from, 1);
    const to = S.pages.findIndex(p => p.id === targetId);
    S.pages.splice(to < 0 ? S.pages.length : to, 0, moved);
    S.activePage = S.pages.findIndex(p => p.id === activeId);
    renderPageStrip();
  }

  function renderPageStrip() {
    const strip = q('comic-pages-strip');
    if (!strip) return;
    q('comic-export-format').style.display = S.pages.length > 1 ? '' : 'none';
    strip.innerHTML = '';
    const THUMB_MAX = 90; // fit-to-box on BOTH dimensions — a very tall/narrow
    // page must never blow out the strip's height (that's the bug being fixed).
    S.pages.forEach((page, i) => {
      const item = document.createElement('div');
      item.className = 'comic-page-thumb' + (i === S.activePage ? ' active' : '');
      item.draggable = true;
      const scale = Math.min(THUMB_MAX / page.canvasWidth, THUMB_MAX / page.canvasHeight);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(page.canvasWidth * scale));
      canvas.height = Math.max(1, Math.round(page.canvasHeight * scale));
      const tctx = canvas.getContext('2d');
      tctx.scale(scale, scale);
      render(tctx, page);
      const label = document.createElement('div');
      label.className = 'comic-page-thumb-label';
      label.textContent = String(i + 1);
      const del = document.createElement('button');
      del.type = 'button';
      del.className = 'comic-page-thumb-del';
      del.title = 'Supprimer la page';
      del.textContent = '✕';
      del.addEventListener('click', e => { e.stopPropagation(); deletePage(page.id); });
      item.append(canvas, label, del);
      item.addEventListener('click', () => switchToPage(i));
      item.addEventListener('dragstart', e => {
        item.classList.add('dragging');
        e.dataTransfer.setData('text/plain', page.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', e => e.preventDefault());
      item.addEventListener('drop', e => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== page.id) reorderPage(draggedId, page.id);
      });
      strip.appendChild(item);
    });
  }

  // ── Layers panel (z-order) ────────────────────────────────────────────────
  const LAYER_ICON = { panel: '🖼', bubble: '💬', sfx: '💥', text: '🔤', stroke: '✏' };

  function layerLabel(obj) {
    if (obj.type === 'panel') return obj.imageDataUrl ? 'Panel (image)' : 'Panel (vide)';
    if (obj.type === 'stroke') return 'Dessin libre';
    const t = (obj.text || '').trim();
    return t || (obj.type === 'sfx' ? 'SFX' : 'Texte');
  }

  // Panel lists topmost-first (reverse of the draw-order array) to match the
  // usual "top of the layer list = on top" mental model.
  function renderLayersPanel() {
    const list = q('comic-layers-list');
    if (!list) return;
    list.innerHTML = '';
    for (let i = S.project.objects.length - 1; i >= 0; i--) {
      const obj = S.project.objects[i];
      const row = document.createElement('div');
      row.className = 'comic-layer-row' + (obj.id === S.selectedId ? ' active' : '');
      row.draggable = true;
      row.innerHTML = `
        <span class="comic-layer-icon">${LAYER_ICON[obj.type] || '•'}</span>
        <span class="comic-layer-label">${esc(layerLabel(obj))}</span>
        <button type="button" class="comic-layer-btn" data-act="up" title="Monter">▲</button>
        <button type="button" class="comic-layer-btn" data-act="down" title="Descendre">▼</button>`;
      row.addEventListener('click', e => {
        if (e.target.closest('.comic-layer-btn') || obj.type === 'stroke') return;
        S.selectedId = obj.id;
        syncBubbleControls(obj);
        render();
        refreshSidePanels();
      });
      row.querySelector('[data-act="up"]').addEventListener('click', () => moveLayer(obj.id, 1));
      row.querySelector('[data-act="down"]').addEventListener('click', () => moveLayer(obj.id, -1));
      row.addEventListener('dragstart', e => {
        row.classList.add('dragging');
        e.dataTransfer.setData('text/plain', obj.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      row.addEventListener('dragend', () => row.classList.remove('dragging'));
      row.addEventListener('dragover', e => e.preventDefault());
      row.addEventListener('drop', e => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== obj.id) reorderLayer(draggedId, obj.id);
      });
      list.appendChild(row);
    }
  }

  // dir=+1 moves a layer up (later in the array, drawn on top); -1 moves it down.
  function moveLayer(id, dir) {
    const objs = S.project.objects;
    const i = objs.findIndex(o => o.id === id);
    const j = i + dir;
    if (i < 0 || j < 0 || j >= objs.length) return;
    pushUndo();
    [objs[i], objs[j]] = [objs[j], objs[i]];
    render();
    refreshSidePanels();
  }

  // Drops draggedId's object into targetId's current slot (targetId shifts down).
  function reorderLayer(draggedId, targetId) {
    const objs = S.project.objects;
    const from = objs.findIndex(o => o.id === draggedId);
    if (from < 0) return;
    pushUndo();
    const [moved] = objs.splice(from, 1);
    const to = objs.findIndex(o => o.id === targetId);
    objs.splice(to < 0 ? objs.length : to, 0, moved);
    render();
    refreshSidePanels();
  }

  // ── Auto-pack (justified row-packing, ratios preserved, ported from the
  // user's comic_board.py) ──────────────────────────────────────────────────
  function loadAutoPackImage(file) {
    return new Promise(resolve => {
      const reader = new FileReader();
      reader.onload = e => {
        const img = new Image();
        img.onload = () => {
          // Keep the already-decoded `img` around: buildAutoPackPages sets it
          // straight onto generated panels as `_img`, so both the live
          // preview and the real generate step draw instantly, no extra
          // decode / no waiting on preloadImages().
          resolve({ id: genId(), name: file.name, dataUrl: e.target.result, w: img.naturalWidth, h: img.naturalHeight, img });
        };
        img.src = e.target.result;
      };
      reader.readAsDataURL(file);
    });
  }

  // Batched via Promise.all (mirrors inpaintScheduler.js's addFiles) so a
  // multi-file import triggers one re-render, not one per file.
  const GALLERY_DND_TYPE = 'application/x-comic-ap-gallery-id';

  function addAutoPackFiles(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    Promise.all(files.map(loadAutoPackImage)).then(items => {
      S.autoPack.queue.push(...items);
      renderAutoPackQueue();
    });
  }

  // "Ouvrir un dossier" replaces the browsable gallery with that folder's
  // images — it does NOT add them to the queue directly. The user picks
  // individual images from the gallery (drag or click) into the queue,
  // choosing exactly which ones and in what order.
  function loadFolderGallery(fileList) {
    const files = [...fileList].filter(f => f.type.startsWith('image/'));
    if (!files.length) return;
    Promise.all(files.map(loadAutoPackImage)).then(items => {
      S.autoPack.gallery = items;
      renderAutoPackGallery();
    });
  }

  function addGalleryItemToQueue(galleryId) {
    const src = S.autoPack.gallery.find(x => x.id === galleryId);
    if (!src) return;
    S.autoPack.queue.push({ id: genId(), name: src.name, dataUrl: src.dataUrl, w: src.w, h: src.h, img: src.img });
    renderAutoPackQueue();
  }

  function removeAutoPackItem(id) {
    S.autoPack.queue = S.autoPack.queue.filter(x => x.id !== id);
    renderAutoPackQueue();
  }

  function clearAutoPackQueue() {
    S.autoPack.queue = [];
    renderAutoPackQueue();
  }

  function reorderAutoPackItem(draggedId, targetId) {
    const queue = S.autoPack.queue;
    const from = queue.findIndex(x => x.id === draggedId);
    if (from < 0) return;
    const [moved] = queue.splice(from, 1);
    const to = queue.findIndex(x => x.id === targetId);
    queue.splice(to < 0 ? queue.length : to, 0, moved);
    renderAutoPackQueue();
  }

  function renderAutoPackGallery() {
    const list = q('comic-ap-gallery');
    if (!list) return;
    list.innerHTML = '';
    if (!S.autoPack.gallery.length) {
      const empty = document.createElement('div');
      empty.className = 'comic-ap-empty';
      empty.textContent = 'Ouvre un dossier pour voir ses images ici.';
      list.appendChild(empty);
      return;
    }
    S.autoPack.gallery.forEach(item => {
      const el = document.createElement('div');
      el.className = 'comic-ap-gallery-item';
      el.draggable = true;
      el.title = item.name;
      el.innerHTML = `<img src="${item.dataUrl}" alt="">`;
      el.addEventListener('click', () => addGalleryItemToQueue(item.id));
      el.addEventListener('dragstart', e => {
        e.dataTransfer.setData(GALLERY_DND_TYPE, item.id);
        e.dataTransfer.effectAllowed = 'copy';
      });
      list.appendChild(el);
    });
  }

  function renderAutoPackQueue() {
    const list = q('comic-ap-queue');
    if (!list) return;
    list.innerHTML = '';
    if (!S.autoPack.queue.length) {
      const empty = document.createElement('div');
      empty.className = 'comic-ap-empty';
      empty.textContent = 'Aucune image dans la file — glisse-en depuis la galerie ci-dessus, ou ajoute des fichiers directement.';
      list.appendChild(empty);
      updateAutoPackDispositions();
      return;
    }
    S.autoPack.queue.forEach((item, i) => {
      const el = document.createElement('div');
      el.className = 'comic-ap-item';
      el.draggable = true;
      el.innerHTML = `
        <img src="${item.dataUrl}" alt="">
        <span class="comic-ap-item-order">${i + 1}</span>
        <button type="button" class="comic-ap-item-del" title="Retirer">✕</button>`;
      el.querySelector('.comic-ap-item-del').addEventListener('click', () => removeAutoPackItem(item.id));
      el.addEventListener('dragstart', e => {
        el.classList.add('dragging');
        e.dataTransfer.setData('text/plain', item.id);
        e.dataTransfer.effectAllowed = 'move';
      });
      el.addEventListener('dragend', () => el.classList.remove('dragging'));
      el.addEventListener('dragover', e => e.preventDefault());
      el.addEventListener('drop', e => {
        e.preventDefault();
        const draggedId = e.dataTransfer.getData('text/plain');
        if (draggedId && draggedId !== item.id) reorderAutoPackItem(draggedId, item.id);
      });
      list.appendChild(el);
    });
    updateAutoPackDispositions();
  }

  // Greedy bucketing by reference width at an internal target row height —
  // just decides which images share a row. The real row height (and thus the
  // exact scale of every image in it) is only fixed by layoutRowJustified,
  // which always produces edge-to-edge rows with each image uniformly
  // scaled — never cropped, never deformed, ratio always exact.
  function packImagesIntoRows(items, innerWidth, gutter, rowHeightTarget) {
    rowHeightTarget = Math.max(80, rowHeightTarget || innerWidth * 0.3);
    const rows = [];
    let current = [];
    let curW = 0;
    for (const item of items) {
      const refW = Math.max(1, Math.round(item.w * (rowHeightTarget / item.h)));
      const add = refW + (current.length ? gutter : 0);
      if (current.length && curW + add > innerWidth) {
        rows.push(current);
        current = [item];
        curW = refW;
      } else {
        current.push(item);
        curW += add;
      }
    }
    if (current.length) rows.push(current);
    return rows;
  }

  function layoutRowJustified(row, innerWidth, gutter) {
    const avail = innerWidth - gutter * (row.length - 1);
    const sumRatio = row.reduce((s, it) => s + it.w / it.h, 0);
    const rowH = sumRatio > 0 ? Math.max(1, Math.round(avail / sumRatio)) : 100;
    let x = 0;
    const placements = row.map(item => {
      const w = Math.max(1, Math.round(item.w * (rowH / item.h)));
      const p = { item, x, w, h: rowH };
      x += w + gutter;
      return p;
    });
    return { placements, rowHeight: rowH };
  }

  // Packs the whole queue into justified rows, then groups those rows into
  // one or more brand-new pages (existing pages are never touched/resized).
  // Each generated page's height always fits its own content exactly — when
  // paginating, maxHeight is only the threshold that decides where to start
  // the next page, never a fixed height with leftover empty space.
  function buildAutoPackPages(queue, { width, gutter, margin, bg, paginate, maxHeight, rowHeightTarget }) {
    const innerWidth = width - 2 * margin;
    const rows = packImagesIntoRows(queue, innerWidth, gutter, rowHeightTarget)
      .map(row => layoutRowJustified(row, innerWidth, gutter));

    const pageRowGroups = [];
    let current = [];
    let curH = 2 * margin;
    for (const row of rows) {
      const add = row.rowHeight + (current.length ? gutter : 0);
      if (paginate && current.length && curH + add > maxHeight) {
        pageRowGroups.push(current);
        current = [row];
        curH = 2 * margin + row.rowHeight;
      } else {
        current.push(row);
        curH += add;
      }
    }
    if (current.length) pageRowGroups.push(current);

    return pageRowGroups.map(group => {
      const contentH = group.reduce((s, r) => s + r.rowHeight, 0) + gutter * (group.length - 1);
      const objects = [];
      let y = margin;
      for (const row of group) {
        for (const p of row.placements) {
          objects.push({
            id: genId(), type: 'panel',
            x: margin + p.x, y, w: p.w, h: p.h, rotation: 0,
            vertices: [{ fx: 0, fy: 0 }, { fx: 1, fy: 0 }, { fx: 1, fy: 1 }, { fx: 0, fy: 1 }],
            imageDataUrl: p.item.dataUrl, fit: 'contain', imgOffsetX: 0, imgOffsetY: 0, imgZoom: 1,
            borderWidth: null, borderColor: null,
            _img: p.item.img, // already-decoded — draws instantly, no preloadImages() round-trip needed
          });
        }
        y += row.rowHeight + gutter;
      }
      return { id: genPageId(), canvasWidth: width, canvasHeight: contentH + 2 * margin, background: bg, objects };
    });
  }

  function readAutoPackOptions() {
    return {
      width:     Math.max(200, +q('comic-ap-width').value || S.project.canvasWidth),
      gutter:    Math.max(0, +q('comic-ap-gutter').value || 0),
      margin:    Math.max(0, +q('comic-ap-margin').value || 0),
      bg:        q('comic-ap-bg').value,
      paginate:  q('comic-ap-paginate').checked,
      maxHeight: Math.max(200, +q('comic-ap-maxheight').value || 2000),
    };
  }

  // Same justified-row math, 3 different bucketing targets — genuinely
  // different row groupings (fewer/more images per row) to compare and pick
  // from, not just one fixed automatic result.
  const AUTOPACK_DISPOSITIONS = [
    { label: 'Compact', hint: 'plus d’images par rangée', factor: 0.18 },
    { label: 'Équilibré', hint: 'par défaut', factor: 0.30 },
    { label: 'Large', hint: 'moins d’images par rangée, plus grandes', factor: 0.48 },
  ];

  function renderPageThumbInto(container, page, maxSize) {
    const scale = Math.min(maxSize / page.canvasWidth, maxSize / page.canvasHeight);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(page.canvasWidth * scale));
    canvas.height = Math.max(1, Math.round(page.canvasHeight * scale));
    const ctx = canvas.getContext('2d');
    ctx.scale(scale, scale);
    render(ctx, page);
    container.appendChild(canvas);
  }

  // Computes all 3 dispositions (cached on S.autoPack.dispositions) and
  // renders them as clickable cards — reuses buildAutoPackPages (pure, no
  // side effects) so what you see is exactly what "Générer" will produce.
  function updateAutoPackDispositions() {
    const list = q('comic-ap-dispositions');
    if (!list) return;
    list.innerHTML = '';
    if (!S.autoPack.queue.length) {
      S.autoPack.dispositions = [];
      const empty = document.createElement('div');
      empty.className = 'comic-ap-empty';
      empty.textContent = 'Ajoute des images à la file pour comparer des dispositions.';
      list.appendChild(empty);
      return;
    }
    const baseOpts = readAutoPackOptions();
    const innerWidth = baseOpts.width - 2 * baseOpts.margin;
    S.autoPack.dispositions = AUTOPACK_DISPOSITIONS.map(def => ({
      def,
      pages: buildAutoPackPages(S.autoPack.queue, { ...baseOpts, rowHeightTarget: innerWidth * def.factor }),
    }));
    if (S.autoPack.selectedIndex == null || S.autoPack.selectedIndex >= S.autoPack.dispositions.length) {
      S.autoPack.selectedIndex = 1; // Équilibré by default
    }
    S.autoPack.dispositions.forEach((d, i) => {
      const card = document.createElement('div');
      card.className = 'comic-ap-disposition-card' + (i === S.autoPack.selectedIndex ? ' selected' : '');
      const title = document.createElement('div');
      title.className = 'comic-ap-disposition-title';
      title.textContent = `${d.def.label} — ${d.pages.length} page${d.pages.length > 1 ? 's' : ''}`;
      const hint = document.createElement('div');
      hint.className = 'field-hint';
      hint.textContent = d.def.hint;
      const pagesRow = document.createElement('div');
      pagesRow.className = 'comic-ap-disposition-pages';
      d.pages.slice(0, 4).forEach(page => renderPageThumbInto(pagesRow, page, 90));
      if (d.pages.length > 4) {
        const more = document.createElement('div');
        more.className = 'comic-ap-disposition-more';
        more.textContent = `+${d.pages.length - 4}`;
        pagesRow.appendChild(more);
      }
      card.append(title, hint, pagesRow);
      card.addEventListener('click', () => {
        S.autoPack.selectedIndex = i;
        list.querySelectorAll('.comic-ap-disposition-card').forEach((c, ci) => c.classList.toggle('selected', ci === i));
      });
      list.appendChild(card);
    });
  }

  function openAutoPackModal() {
    q('comic-ap-width').value = S.project.canvasWidth;
    q('comic-ap-maxheight').value = S.project.canvasHeight;
    q('comic-autopack-overlay').classList.add('open');
    updateAutoPackDispositions();
  }

  function closeAutoPackModal() {
    q('comic-autopack-overlay').classList.remove('open');
  }

  function generateAutoPack() {
    if (!S.autoPack.queue.length) { toast('Ajoute au moins une image'); return; }
    const chosen = S.autoPack.dispositions[S.autoPack.selectedIndex];
    const newPages = chosen ? chosen.pages : buildAutoPackPages(S.autoPack.queue, readAutoPackOptions());
    S.pages.push(...newPages);
    preloadImages();
    S.activePage = -1; // force switchToPage to actually apply even if the index is unchanged
    switchToPage(S.pages.length - newPages.length);
    clearAutoPackQueue();
    closeAutoPackModal();
    toast(`✅ ${newPages.length} page${newPages.length > 1 ? 's' : ''} générée${newPages.length > 1 ? 's' : ''}`);
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
    q('comic-tool-vertex').addEventListener('click', () => setTool('vertex'));
    q('comic-tool-eraser').addEventListener('click', () => setTool('eraser'));
    q('comic-add-vertex').addEventListener('click', addVertexToSelected);
    q('comic-clear-strokes').addEventListener('click', clearAllStrokes);
    q('comic-add-bubble').addEventListener('click', addBubble);
    q('comic-add-sfx').addEventListener('click', addSfx);
    q('comic-sfx-preset').addEventListener('change', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && sel.type === 'sfx' && this.value) {
        pushUndo();
        sel.text = this.value;
        render();
      }
    });
    q('comic-bubble-font').addEventListener('change', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && (sel.type === 'bubble' || sel.type === 'sfx' || sel.type === 'text')) { sel.font = this.value; render(); }
    });
    q('comic-text-color').addEventListener('input', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && (sel.type === 'bubble' || sel.type === 'sfx' || sel.type === 'text')) { sel.textColor = this.value; render(); }
    });
    q('comic-text-size').addEventListener('input', function () {
      q('comic-text-size-val').textContent = this.value + 'px';
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && (sel.type === 'bubble' || sel.type === 'sfx' || sel.type === 'text')) { sel.fontSize = +this.value; render(); }
    });
    q('comic-fill-color').addEventListener('input', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && (sel.type === 'bubble' || sel.type === 'sfx' || sel.type === 'text')) { sel.fillColor = this.value; render(); }
    });
    q('comic-toggle-bold').addEventListener('click', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (!sel || (sel.type !== 'bubble' && sel.type !== 'sfx' && sel.type !== 'text')) return;
      pushUndo();
      sel.bold = !sel.bold;
      this.classList.toggle('active', sel.bold);
      render();
    });
    q('comic-toggle-italic').addEventListener('click', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (!sel || (sel.type !== 'bubble' && sel.type !== 'sfx' && sel.type !== 'text')) return;
      pushUndo();
      sel.italic = !sel.italic;
      this.classList.toggle('active', sel.italic);
      render();
    });
    q('comic-toggle-underline').addEventListener('click', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (!sel || (sel.type !== 'bubble' && sel.type !== 'sfx' && sel.type !== 'text')) return;
      pushUndo();
      sel.underline = !sel.underline;
      this.classList.toggle('active', sel.underline);
      render();
    });
    q('comic-toggle-highlight').addEventListener('click', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (!sel || sel.type !== 'text') return;
      pushUndo();
      sel.highlight = !sel.highlight;
      this.classList.toggle('active', sel.highlight);
      render();
    });
    q('comic-add-text').addEventListener('click', addText);
    q('comic-border-width').addEventListener('input', function () {
      q('comic-border-width-val').textContent = this.value + 'px';
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && (sel.type === 'panel' || sel.type === 'bubble')) { sel.borderWidth = +this.value; render(); }
    });
    q('comic-border-color').addEventListener('input', function () {
      const sel = S.selectedId && findObject(S.selectedId);
      if (sel && (sel.type === 'panel' || sel.type === 'bubble')) { sel.borderColor = this.value; render(); }
    });
    q('comic-zoom-in').addEventListener('click', () => setViewZoom((S.viewZoom || 1) + 0.1));
    q('comic-zoom-out').addEventListener('click', () => setViewZoom(Math.max(0.1, (S.viewZoom || 1) - 0.1)));
    q('comic-zoom-fit').addEventListener('click', () => setViewZoom(null));
    q('comic-btn-delete').addEventListener('click', deleteSelected);
    q('comic-obj-copy').addEventListener('click', copySelected);
    q('comic-obj-paste').addEventListener('click', pasteClipboard);
    q('comic-btn-undo').addEventListener('click', undo);
    q('comic-btn-redo').addEventListener('click', redo);
    q('comic-add-page').addEventListener('click', addPage);
    q('comic-btn-autopack').addEventListener('click', openAutoPackModal);
    q('comic-ap-close').addEventListener('click', closeAutoPackModal);
    q('comic-ap-cancel').addEventListener('click', closeAutoPackModal);
    q('comic-ap-generate').addEventListener('click', generateAutoPack);
    q('comic-ap-btn-folder').addEventListener('click', () => q('comic-ap-file-folder').click());
    q('comic-ap-btn-files').addEventListener('click', () => q('comic-ap-file-files').click());
    q('comic-ap-btn-clear').addEventListener('click', clearAutoPackQueue);
    q('comic-ap-file-folder').addEventListener('change', e => { loadFolderGallery(e.target.files); e.target.value = ''; });
    q('comic-ap-file-files').addEventListener('change', e => { addAutoPackFiles(e.target.files); e.target.value = ''; });
    // Accepts a drag coming from the folder gallery above (adds a copy at the
    // end of the queue) — separate from the queue's own internal reorder drag
    // (which uses 'text/plain' and is bound per-row in renderAutoPackQueue).
    q('comic-ap-queue').addEventListener('dragover', e => {
      if (e.dataTransfer.types.includes(GALLERY_DND_TYPE)) e.preventDefault();
    });
    q('comic-ap-queue').addEventListener('drop', e => {
      const galleryId = e.dataTransfer.getData(GALLERY_DND_TYPE);
      if (galleryId) { e.preventDefault(); addGalleryItemToQueue(galleryId); }
    });
    q('comic-ap-paginate').addEventListener('change', function () {
      q('comic-ap-maxheight').disabled = !this.checked;
      updateAutoPackDispositions();
    });
    ['comic-ap-width', 'comic-ap-gutter', 'comic-ap-margin', 'comic-ap-bg', 'comic-ap-maxheight']
      .forEach(id => q(id).addEventListener('input', updateAutoPackDispositions));
    q('comic-btn-new').addEventListener('click', newProject);
    q('comic-btn-save').addEventListener('click', saveProject);
    q('comic-btn-load').addEventListener('click', () => q('comic-file-project').click());
    q('comic-file-project').addEventListener('change', e => {
      if (e.target.files[0]) loadProjectFile(e.target.files[0]);
      e.target.value = '';
    });
    q('comic-btn-copy').addEventListener('click', copyImage);
    q('comic-btn-export').addEventListener('click', exportProject);
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

  async function loadSystemFonts() {
    const sel = q('comic-bubble-font');
    if (!sel || !('queryLocalFonts' in window)) return; // keep the built-in fallback list
    try {
      const fonts = await window.queryLocalFonts();
      const families = [...new Set(fonts.map(f => f.family))].sort((a, b) => a.localeCompare(b));
      if (!families.length) return;
      const current = sel.value;
      sel.innerHTML = '';
      families.forEach(f => {
        const opt = document.createElement('option');
        opt.value = f;
        opt.textContent = f;
        sel.appendChild(opt);
      });
      if (families.includes(current)) sel.value = current;
    } catch (e) {
      console.warn('[Comic] queryLocalFonts unavailable:', e.message);
    }
  }

  function init() {
    if (S.initialized) return;
    S.initialized = true;
    bindUI();
    resizeCanvasElement();
    render();
    refreshSidePanels();
    loadSystemFonts();
  }

  function onShow() {
    resizeCanvasElement();
    render();
    refreshSidePanels();
  }

  return { init, onShow, loadFromSrc };
})();
