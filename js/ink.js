// 手寫註記：Apple Pencil 直接寫在條文上。
// 座標以「字級 em」為單位、相對於整條條文（.art）儲存，字級改變時仍可對齊。
// 舊版（v1）筆畫相對於條文本文（.atext），繪製時自動位移。
export const PX_PER_MM = 5.2; // iPad（264 ppi、2 倍）約 1 CSS px ≈ 0.19 mm
export const PEN_COLORS = [
  ['k', '黑'], ['ink', '藍黑'], ['red', '紅'], ['blue', '藍'], ['green', '綠'], ['purple', '紫'], ['orange', '橘'],
];
export const MARK_COLORS = [['mark', '黃'], ['mg', '綠'], ['mp', '粉'], ['mb', '藍']];
export const PEN_PRESETS = [0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2];

const MAX_CANVAS_PX = 16_000_000;

export class Ink {
  constructor({ root, getRec, saveRec, onChange, onStart, opts }) {
    this.root = root;
    this.getRec = getRec;   // (key, create) => rec
    this.saveRec = saveRec; // (key) => void
    this.onChange = onChange || (() => {});
    this.onStart = onStart || (() => {});
    this.opts = opts;       // 共用設定物件：tool, color, markColor, mm, markMM, pressure, pencil, finger
    this.active = false;
    this.undoStack = [];
    this.redoStack = [];
    this.layers = new Map(); // key -> { canvas, art }
    this.cur = null;
    this.ro = new ResizeObserver((ents) => {
      for (const e of ents) { const k = e.target.dataset.key; if (k) this.draw(k); }
    });
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        const k = e.target.dataset.key;
        if (e.isIntersecting) this.attach(k); else this.detach(k);
      }
    }, { root, rootMargin: '600px 0px' });
    this.bindRoot();
  }

  get tool() { return this.opts.tool; }

  colors() {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const [k] of PEN_COLORS.concat(MARK_COLORS)) out[k] = cs.getPropertyValue('--pen-' + k).trim();
    return out;
  }

  observe(art) { this.io.observe(art); }
  reset() {
    for (const k of [...this.layers.keys()]) this.detach(k, true);
    this.io.disconnect();
  }

  setActive(on) {
    this.active = on;
    document.body.classList.toggle('inking', on);
    if (on) this.root.querySelectorAll('.art').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > -600 && r.top < innerHeight + 600) this.attach(el.dataset.key);
    });
  }

  strokes(key) {
    const rec = this.getRec(key);
    return (rec && rec.ink && rec.ink.strokes) || [];
  }

  attach(key, force) {
    if (!key) return null;
    if (this.layers.has(key)) { this.draw(key); return this.layers.get(key); }
    if (!force && !this.strokes(key).length && !this.active) return null;
    const art = this.root.querySelector(`.art[data-key="${CSS.escape(key)}"]`);
    if (!art) return null;
    const canvas = document.createElement('canvas');
    canvas.className = 'ink-layer';
    art.appendChild(canvas);
    const L = { canvas, art };
    this.layers.set(key, L);
    this.ro.observe(art);
    this.draw(key);
    return L;
  }

  detach(key, force) {
    const L = this.layers.get(key);
    if (!L || (!force && this.cur && this.cur.key === key)) return;
    this.ro.unobserve(L.art);
    L.canvas.remove();
    this.layers.delete(key);
  }

  refresh(key) {
    const L = this.layers.get(key);
    if (L) { this.ro.unobserve(L.art); L.canvas.remove(); this.layers.delete(key); }
    this.attach(key);
  }

  redrawAll() { for (const k of this.layers.keys()) this.draw(k); }

  em(art) { return parseFloat(getComputedStyle(art).fontSize) || 18; }

  // v1 筆畫的原點（.atext 左上角）相對於 .art 的位移（em）
  legacyOffset(art, em) {
    const t = art.querySelector('.atext');
    return t ? [t.offsetLeft / em, t.offsetTop / em] : [0, 0];
  }

  setupCanvas(L) {
    const { canvas, art } = L;
    const w = art.clientWidth, h = art.clientHeight;
    let s = window.devicePixelRatio || 1;
    if (w * h * s * s > MAX_CANVAS_PX) s = Math.sqrt(MAX_CANVAS_PX / (w * h));
    const W = Math.max(1, Math.round(w * s)), H = Math.max(1, Math.round(h * s));
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(s, 0, 0, s, 0, 0);
    L.scale = s;
    return { ctx, w, h };
  }

  draw(key) {
    const L = this.layers.get(key);
    if (!L) return;
    const { ctx, w, h } = this.setupCanvas(L);
    ctx.clearRect(0, 0, w, h);
    const em = this.em(L.art);
    const col = this.colors();
    const off = this.legacyOffset(L.art, em);
    for (const s of this.strokes(key)) this.paint(ctx, s, em, col, s.v === 2 ? [0, 0] : off, L.scale);
    if (this.cur && this.cur.key === key && this.cur.stroke && this.cur.stroke.t === 'marker') {
      this.paint(ctx, this.cur.stroke, em, col, [0, 0], L.scale);
    }
  }

  widthAt(s, em, pr, scale) {
    const base = s.w * em;
    const w = s.v !== 2 ? base * (0.45 + 0.9 * pr) : s.pr ? base * (0.35 + 1.3 * pr) : base;
    return Math.max(0.5 / scale, w);
  }

  paint(ctx, s, em, col, [ox, oy], scale) {
    const p = s.pts;
    const n = Math.floor(p.length / 3);
    if (!n) return;
    const X = (i) => (p[i * 3] + ox) * em, Y = (i) => (p[i * 3 + 1] + oy) * em, P = (i) => p[i * 3 + 2];
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    if (s.t === 'marker') {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = col[s.c] || col.mark;
      ctx.lineWidth = s.w * em;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      for (let i = 1; i < n; i++) ctx.lineTo(X(i), Y(i));
      if (n === 1) ctx.lineTo(X(0) + 0.5, Y(0));
      ctx.stroke();
      ctx.restore();
      return;
    }
    const color = col[s.c] || col.ink;
    if (n === 1) {
      ctx.fillStyle = color;
      ctx.beginPath(); ctx.arc(X(0), Y(0), this.widthAt(s, em, P(0), scale) / 2, 0, 7); ctx.fill();
      return;
    }
    ctx.strokeStyle = color;
    // 以相鄰點中點為端點、點本身為控制點的二次曲線，線條較平滑
    let px = X(0), py = Y(0);
    for (let i = 1; i < n; i++) {
      const last = i === n - 1;
      const mx = last ? X(i) : (X(i) + X(i + 1)) / 2;
      const my = last ? Y(i) : (Y(i) + Y(i + 1)) / 2;
      ctx.lineWidth = this.widthAt(s, em, (P(i - 1) + P(i)) / 2, scale);
      ctx.beginPath();
      ctx.moveTo(px, py);
      if (last) ctx.lineTo(mx, my);
      else ctx.quadraticCurveTo(X(i), Y(i), mx, my);
      ctx.stroke();
      px = mx; py = my;
    }
  }

  // ---------- 輸入 ----------
  wants(e) {
    if (this.active) return e.pointerType === 'pen' || e.pointerType === 'mouse' || (this.opts.finger && e.pointerType === 'touch');
    return this.opts.pencil && e.pointerType === 'pen';
  }

  bindRoot() {
    const root = this.root;
    const blockTouch = (e) => {
      if (!this.active && !this.opts.pencil) return;
      for (const t of e.touches) {
        if (t.touchType === 'stylus') {
          if (e.target.closest && e.target.closest('.sticky, .pad-ctl')) return;
          e.preventDefault(); return;
        }
      }
      if (this.active && this.opts.finger && e.touches.length === 1 && !(e.target.closest && e.target.closest('.sticky, .pad-ctl'))) e.preventDefault();
    };
    root.addEventListener('touchstart', blockTouch, { passive: false });
    root.addEventListener('touchmove', blockTouch, { passive: false });

    root.addEventListener('pointerdown', (e) => {
      if (this.cur || !this.wants(e) || e.button > 0) return;
      const art = e.target.closest && e.target.closest('.art');
      if (!art || e.target.closest('.sticky, .pad-ctl, .popover')) return;
      const key = art.dataset.key;
      this.onStart(key);
      const L = this.attach(key, true);
      if (!L) return;
      e.preventDefault();
      try { root.setPointerCapture(e.pointerId); } catch {}
      const rect = art.getBoundingClientRect();
      const em = this.em(art);
      const o = this.opts;
      const cur = { key, id: e.pointerId, rect, em, t0: performance.now(), x0: e.clientX, y0: e.clientY, dist: 0, L, tentative: !this.active };
      if (o.tool === 'eraser') { cur.eraser = true; this.cur = cur; this.erase(key, this.pt(e, cur)); return; }
      const marker = o.tool === 'marker';
      cur.stroke = {
        v: 2, t: marker ? 'marker' : 'pen', c: marker ? o.markColor : o.color,
        w: Math.round(((marker ? o.markMM : o.mm) * PX_PER_MM / em) * 10000) / 10000,
        pr: !marker && o.pressure && e.pointerType === 'pen' ? 1 : 0,
        pts: this.pt(e, cur),
      };
      this.cur = cur;
    }, { capture: true });

    root.addEventListener('pointermove', (e) => {
      const cur = this.cur;
      if (!cur || e.pointerId !== cur.id) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
      for (const ev of evs.length ? evs : [e]) {
        const q = this.pt(ev, cur);
        cur.dist = Math.max(cur.dist, Math.hypot(ev.clientX - cur.x0, ev.clientY - cur.y0));
        if (cur.eraser) { this.erase(cur.key, q); continue; }
        const p = cur.stroke.pts, n = p.length;
        const dx = q[0] - p[n - 3], dy = q[1] - p[n - 2];
        if (dx * dx + dy * dy < 0.0002) continue;
        p.push(...q);
        if (cur.stroke.t !== 'marker') this.paintTail(cur);
      }
      if (!cur.eraser && cur.stroke.t === 'marker') this.draw(cur.key);
    }, { capture: true });

    const end = (e) => {
      const cur = this.cur;
      if (!cur || e.pointerId !== cur.id) return;
      this.cur = null;
      if (cur.eraser) return;
      // Apple Pencil 點一下（非手寫模式）：當作一般點選
      if (cur.tentative && performance.now() - cur.t0 < 280 && cur.dist < 6) {
        this.draw(cur.key);
        const el = document.elementFromPoint(e.clientX, e.clientY);
        if (el && e.type === 'pointerup') { this.syntheticClick = performance.now(); el.click(); }
        return;
      }
      const rec = this.getRec(cur.key, true);
      rec.ink = rec.ink || { strokes: [] };
      rec.ink.wem = Math.round((cur.L.art.clientWidth / cur.em) * 100) / 100;
      rec.ink.strokes.push(cur.stroke);
      this.undoStack.push({ key: cur.key, kind: 'add', stroke: cur.stroke });
      this.redoStack = [];
      this.saveRec(cur.key);
      this.draw(cur.key);
      this.onChange(cur.key);
    };
    root.addEventListener('pointerup', end, { capture: true });
    root.addEventListener('pointercancel', end, { capture: true });
    // 合成點選後，略過瀏覽器可能補發的原生點選
    root.addEventListener('click', (e) => {
      if (e.isTrusted && this.syntheticClick && performance.now() - this.syntheticClick < 500) { e.stopPropagation(); e.preventDefault(); this.syntheticClick = 0; }
    }, { capture: true });
  }

  pt(e, cur) {
    const x = (e.clientX - cur.rect.left) / cur.em, y = (e.clientY - cur.rect.top) / cur.em;
    const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
    return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(pr * 100) / 100];
  }

  // 書寫中只畫最新一段，避免每次重繪全部筆畫
  paintTail(cur) {
    const L = cur.L;
    if (!L.scale) this.setupCanvas(L);
    const ctx = L.canvas.getContext('2d');
    const s = cur.stroke, p = s.pts, n = p.length / 3;
    if (n < 2) return;
    const em = cur.em;
    const col = this.colors();
    ctx.lineCap = 'round';
    ctx.strokeStyle = col[s.c] || col.ink;
    const X = (i) => p[i * 3] * em, Y = (i) => p[i * 3 + 1] * em;
    const i = n - 1;
    const ax = n > 2 ? (X(i - 2) + X(i - 1)) / 2 : X(0), ay = n > 2 ? (Y(i - 2) + Y(i - 1)) / 2 : Y(0);
    const bx = (X(i - 1) + X(i)) / 2, by = (Y(i - 1) + Y(i)) / 2;
    ctx.lineWidth = this.widthAt(s, em, (p[(i - 1) * 3 + 2] + p[i * 3 + 2]) / 2, L.scale);
    ctx.beginPath();
    ctx.moveTo(ax, ay);
    ctx.quadraticCurveTo(X(i - 1), Y(i - 1), bx, by);
    ctx.stroke();
  }

  erase(key, [x, y]) {
    const rec = this.getRec(key);
    if (!rec || !rec.ink) return;
    const L = this.layers.get(key);
    const em = L ? this.em(L.art) : 18;
    const off = L ? this.legacyOffset(L.art, em) : [0, 0];
    const r2 = 0.45 * 0.45;
    const keep = [];
    let removed = false;
    for (const s of rec.ink.strokes) {
      const [ox, oy] = s.v === 2 ? [0, 0] : off;
      let hit = false;
      for (let i = 0; i < s.pts.length; i += 3) {
        const dx = s.pts[i] + ox - x, dy = s.pts[i + 1] + oy - y;
        if (dx * dx + dy * dy < r2) { hit = true; break; }
      }
      if (hit) { removed = true; this.undoStack.push({ key, kind: 'del', stroke: s }); } else keep.push(s);
    }
    if (removed) {
      rec.ink.strokes = keep;
      this.redoStack = [];
      this.saveRec(key);
      this.draw(key);
      this.onChange(key);
    }
  }

  apply(u, reverse) {
    const rec = this.getRec(u.key, true);
    rec.ink = rec.ink || { strokes: [] };
    const add = (u.kind === 'add') !== reverse;
    if (add) rec.ink.strokes.push(u.stroke);
    else rec.ink.strokes = rec.ink.strokes.filter((s) => s !== u.stroke);
    this.saveRec(u.key);
    this.attach(u.key, true);
    this.draw(u.key);
    this.onChange(u.key);
  }
  undo() { const u = this.undoStack.pop(); if (!u) return false; this.apply(u, true); this.redoStack.push(u); return true; }
  redo() { const u = this.redoStack.pop(); if (!u) return false; this.apply(u, false); this.undoStack.push(u); return true; }

  clear(key) {
    const rec = this.getRec(key);
    if (!rec || !rec.ink) return;
    for (const s of rec.ink.strokes) this.undoStack.push({ key, kind: 'del', stroke: s });
    rec.ink.strokes = [];
    this.saveRec(key);
    this.draw(key);
    this.onChange(key);
  }

  layoutShifted(key) {
    const rec = this.getRec(key);
    const L = this.layers.get(key);
    if (!rec || !rec.ink || !rec.ink.wem || !L) return false;
    const now = L.art.clientWidth / this.em(L.art);
    return Math.abs(now - rec.ink.wem) / rec.ink.wem > 0.03;
  }
}
