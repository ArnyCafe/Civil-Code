// 手寫註記：在條文上以 Apple Pencil 書寫。
// 座標以條文本文（.atext）左上角為原點、以「字級 em」為單位儲存，字級改變時仍可對齊；
// 畫布向外延伸少許留白（左右 0.8em、上 1em、下 0.8em），可寫在條文邊上。
// 筆寬以「點」（CSS px，等於 iPad 的 point）指定，最細 0.1。
const MX = 0.8, MY = 1.0;
export const W_MIN = 0.1, W_MAX = 10;

export function widthToSlider(w) { return Math.round(1000 * Math.log(w / W_MIN) / Math.log(W_MAX / W_MIN)); }
export function sliderToWidth(v) {
  const w = W_MIN * Math.pow(W_MAX / W_MIN, v / 1000);
  return w < 1 ? Math.round(w * 100) / 100 : Math.round(w * 10) / 10;
}

export class Ink {
  constructor({ getRec, saveRec, onChange }) {
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.finger = false;
    this.pressure = true;
    this.tool = 'pen';
    this.color = 'red';
    this.px = 0.5;            // 筆寬（點）
    this.undo = [];
    this.redo = [];
    this.layers = new Map();  // aid -> {canvas, host}
    this.ro = new ResizeObserver((ents) => {
      for (const e of ents) {
        const aid = e.target.closest('.art')?.dataset.id;
        if (aid) this.draw(aid);
      }
    });
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) {
        const aid = e.target.dataset.id;
        if (e.isIntersecting) this.attach(aid); else this.detach(aid);
      }
    }, { rootMargin: '600px 0px' });
  }

  colors() {
    const cs = getComputedStyle(document.documentElement);
    const g = (k) => cs.getPropertyValue(k).trim();
    return { red: g('--pen-red'), ink: g('--pen-ink'), black: g('--pen-black'), green: g('--pen-green'), mark: g('--pen-mark') };
  }

  observe(artEl) { this.io.observe(artEl); }

  setActive(on) {
    this.active = on;
    document.body.classList.toggle('inking', on);
    if (on) document.querySelectorAll('.art').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > -600 && r.top < innerHeight + 600) this.attach(el.dataset.id);
    });
  }

  attach(aid) {
    const rec = this.getRec(aid);
    const has = rec && rec.ink && rec.ink.strokes && rec.ink.strokes.length;
    if (!has && !this.active) return;
    if (this.layers.has(aid)) { this.draw(aid); return; }
    const art = document.getElementById('a-' + aid);
    const host = art && art.querySelector('.atext');
    if (!host) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'ink-layer';
    host.appendChild(canvas);
    this.bind(canvas, aid, host);
    this.layers.set(aid, { canvas, host });
    this.ro.observe(host);
    this.draw(aid);
  }

  detach(aid) {
    const L = this.layers.get(aid);
    if (!L || this.drawing === aid) return;
    this.ro.unobserve(L.host);
    L.canvas.remove();
    this.layers.delete(aid);
  }

  refresh(aid) {
    const L = this.layers.get(aid);
    if (L) { this.ro.unobserve(L.host); this.layers.delete(aid); }
    this.attach(aid);
  }

  redrawAll() { for (const aid of this.layers.keys()) this.draw(aid); }

  em(host) { return parseFloat(getComputedStyle(host).fontSize) || 18; }

  draw(aid, live) {
    const L = this.layers.get(aid);
    if (!L) return;
    const { canvas, host } = L;
    const dpr = window.devicePixelRatio || 1;
    const em = this.em(host);
    const w = host.clientWidth + 2 * MX * em, h = host.clientHeight + (MY + 0.8) * em;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    ctx.translate(MX * em, MY * em);
    const rec = this.getRec(aid);
    const strokes = (rec && rec.ink && rec.ink.strokes) || [];
    const col = this.colors();
    const all = live ? strokes.concat([live]) : strokes;
    for (const s of all) paint(ctx, s, em, col);
  }

  bind(canvas, aid, host) {
    const allowed = (e) => this.active && (e.pointerType === 'pen' || e.pointerType === 'mouse' || this.finger);
    // iPad Safari：阻止 Apple Pencil 觸發捲動，但手指仍可捲動
    const blockStylus = (e) => {
      if (!this.active) return;
      for (const t of e.touches) {
        if (t.touchType === 'stylus' || this.finger) { e.preventDefault(); return; }
      }
    };
    canvas.addEventListener('touchstart', blockStylus, { passive: false });
    canvas.addEventListener('touchmove', blockStylus, { passive: false });

    let cur = null, em = 18, rect = null;
    const pt = (e) => {
      const x = (e.clientX - rect.left) / em, y = (e.clientY - rect.top) / em;
      const pr = e.pointerType === 'pen' && this.pressure ? (e.pressure || 0.5) : 0.5;
      return [Math.round(x * 2000) / 2000, Math.round(y * 2000) / 2000, Math.round(pr * 100) / 100];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!allowed(e)) return;
      e.preventDefault();
      e.stopPropagation();
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      rect = host.getBoundingClientRect();
      em = this.em(host);
      this.drawing = aid;
      if (this.tool === 'eraser') { cur = { eraser: true }; this.erase(aid, pt(e)); return; }
      const marker = this.tool === 'marker';
      cur = { t: marker ? 'marker' : 'pen', c: marker ? 'mark' : this.color, w: Math.round((this.px / em) * 100000) / 100000, pts: pt(e) };
      if (!this.pressure) cur.np = 1;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        const q = pt(ev);
        if (cur.eraser) { this.erase(aid, q); continue; }
        const n = cur.pts.length;
        const dx = q[0] - cur.pts[n - 3], dy = q[1] - cur.pts[n - 2];
        if (dx * dx + dy * dy < 0.00006) continue;
        cur.pts.push(...q);
      }
      if (!cur.eraser) this.draw(aid, cur);
    });
    const end = () => {
      if (!cur) return;
      const done = cur;
      cur = null;
      this.drawing = null;
      if (done.eraser) return;
      const rec = this.getRec(aid, true);
      rec.ink = rec.ink || { strokes: [] };
      rec.ink.wem = Math.round((host.clientWidth / em) * 100) / 100;
      rec.ink.strokes.push(done);
      this.undo.push({ aid, kind: 'add', stroke: done });
      this.redo.length = 0;
      this.saveRec(aid);
      this.draw(aid);
      this.onChange(aid);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  erase(aid, [x, y]) {
    const rec = this.getRec(aid);
    if (!rec || !rec.ink) return;
    const r2 = 0.45 * 0.45;
    const keep = [];
    let removed = false;
    for (const s of rec.ink.strokes) {
      let hit = false;
      for (let i = 0; i < s.pts.length; i += 3) {
        const dx = s.pts[i] - x, dy = s.pts[i + 1] - y;
        if (dx * dx + dy * dy < r2) { hit = true; break; }
      }
      if (hit) { removed = true; this.undo.push({ aid, kind: 'del', stroke: s }); } else keep.push(s);
    }
    if (removed) {
      this.redo.length = 0;
      rec.ink.strokes = keep;
      this.saveRec(aid);
      this.draw(aid);
      this.onChange(aid);
    }
  }

  apply(u, reverse) {
    const rec = this.getRec(u.aid, true);
    rec.ink = rec.ink || { strokes: [] };
    const add = (u.kind === 'add') !== reverse;
    if (add) rec.ink.strokes.push(u.stroke);
    else rec.ink.strokes = rec.ink.strokes.filter((s) => s !== u.stroke);
    this.saveRec(u.aid);
    this.attach(u.aid);
    this.draw(u.aid);
    this.onChange(u.aid);
  }
  undoLast() {
    const u = this.undo.pop();
    if (!u) return false;
    this.apply(u, true);
    this.redo.push(u);
    return true;
  }
  redoLast() {
    const u = this.redo.pop();
    if (!u) return false;
    this.apply(u, false);
    this.undo.push(u);
    return true;
  }

  clear(aid) {
    const rec = this.getRec(aid);
    if (!rec || !rec.ink) return;
    for (const s of rec.ink.strokes) this.undo.push({ aid, kind: 'del', stroke: s });
    rec.ink.strokes = [];
    this.saveRec(aid);
    this.draw(aid);
    this.onChange(aid);
  }

  layoutShifted(aid) {
    const rec = this.getRec(aid);
    const L = this.layers.get(aid);
    if (!rec || !rec.ink || !rec.ink.wem || !L) return false;
    const now = L.host.clientWidth / this.em(L.host);
    return Math.abs(now - rec.ink.wem) / rec.ink.wem > 0.03;
  }
}

// 繪製單一筆畫（中點二次曲線平滑；可依筆壓改變粗細）
export function paint(ctx, s, em, col) {
  const p = s.pts;
  if (p.length < 3) return;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  if (s.t === 'marker') {
    ctx.save();
    ctx.globalCompositeOperation = 'multiply';
    ctx.strokeStyle = col.mark;
    ctx.lineWidth = 0.95 * em;
    ctx.lineCap = 'butt';
    ctx.beginPath();
    ctx.moveTo(p[0] * em, p[1] * em);
    for (let i = 3; i < p.length; i += 3) ctx.lineTo(p[i] * em, p[i + 1] * em);
    ctx.stroke();
    ctx.restore();
    return;
  }
  const color = col[s.c] || col.red;
  const base = s.w * em;              // CSS px
  const wAt = (i) => (s.np ? base : base * (0.5 + 1.0 * p[i + 2]));
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  const n = p.length / 3;
  if (n === 1) {
    ctx.beginPath(); ctx.arc(p[0] * em, p[1] * em, Math.max(base, 0.05) * 0.5, 0, 7); ctx.fill();
    return;
  }
  if (s.np) {
    ctx.lineWidth = base;
    ctx.beginPath();
    ctx.moveTo(p[0] * em, p[1] * em);
    for (let k = 1; k < n - 1; k++) {
      const i = k * 3, j = i + 3;
      ctx.quadraticCurveTo(p[i] * em, p[i + 1] * em, (p[i] + p[j]) / 2 * em, (p[i + 1] + p[j + 1]) / 2 * em);
    }
    ctx.lineTo(p[(n - 1) * 3] * em, p[(n - 1) * 3 + 1] * em);
    ctx.stroke();
    return;
  }
  // 依筆壓：逐段繪製
  let px = p[0] * em, py = p[1] * em;
  for (let k = 1; k < n; k++) {
    const i = k * 3;
    const last = k === n - 1;
    const mx = last ? p[i] * em : (p[i] + p[i + 3]) / 2 * em;
    const my = last ? p[i + 1] * em : (p[i + 1] + p[i + 4]) / 2 * em;
    ctx.lineWidth = Math.max(0.05, (wAt(i - 3) + wAt(i)) / 2);
    ctx.beginPath();
    ctx.moveTo(px, py);
    ctx.quadraticCurveTo(p[i] * em, p[i + 1] * em, mx, my);
    ctx.stroke();
    px = mx; py = my;
  }
}
