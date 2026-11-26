// 手寫註記：在條文上以 Apple Pencil 書寫。
// 座標以「字級 em」為單位儲存（相對於該條 .atext 左上角），字級改變時仍可對齊。
// 筆寬以公釐（CSS mm）設定，最細 0.05 mm；儲存時換算成 em。
const PX_PER_MM = 96 / 25.4;
export const PRESETS = [0.05, 0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2];
export const COLORS = ['red', 'blue', 'black', 'green', 'mark', 'markp'];

export class Ink {
  constructor({ getRec, saveRec, onChange, onSticky }) {
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange || (() => {});
    this.onSticky = onSticky || (() => {});
    this.active = false;
    this.finger = false;
    this.tool = 'pen';        // pen | marker | eraser | sticky
    this.color = 'red';
    this.mm = 0.3;            // 筆寬（公釐）
    this.pressure = true;     // 筆壓
    this.undo = [];
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
    const v = (k) => cs.getPropertyValue(k).trim();
    return { red: v('--pen-red'), blue: v('--pen-ink'), ink: v('--pen-ink'), black: v('--pen-black'), green: v('--pen-green'), mark: v('--pen-mark'), markp: v('--pen-markp') };
  }

  observe(artEl) { this.io.observe(artEl); }

  // 切換法典時清除
  reset() {
    this.io.disconnect();
    this.ro.disconnect();
    for (const L of this.layers.values()) L.canvas.remove();
    this.layers.clear();
    this.undo = [];
  }

  setActive(on) {
    this.active = on;
    document.body.classList.toggle('inking', on);
    document.body.dataset.tool = this.tool;
    if (on) document.querySelectorAll('#reader .art').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > -600 && r.top < innerHeight + 600) this.attach(el.dataset.id);
    });
  }

  setTool(t) { this.tool = t; document.body.dataset.tool = t; }

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
    if (L) { this.ro.unobserve(L.host); L.canvas.remove(); this.layers.delete(aid); }
    this.attach(aid);
  }

  redrawAll() { for (const aid of this.layers.keys()) this.draw(aid); }

  em(host) { return parseFloat(getComputedStyle(host).fontSize) || 18; }

  draw(aid, live) {
    const L = this.layers.get(aid);
    if (!L) return;
    const { canvas, host } = L;
    const dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth, h = host.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    const rec = this.getRec(aid);
    const strokes = (rec && rec.ink && rec.ink.strokes) || [];
    const em = this.em(host);
    const col = this.colors();
    for (const s of live ? strokes.concat([live]) : strokes) this.paint(ctx, s, em, col);
  }

  paint(ctx, s, em, col) {
    const p = s.pts;
    if (p.length < 3) return;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const X = (i) => p[i] * em, Y = (i) => p[i + 1] * em;
    if (s.t === 'marker') {
      ctx.save();
      ctx.globalCompositeOperation = 'multiply';
      ctx.strokeStyle = col[s.c] || col.mark;
      ctx.lineWidth = (s.w || 0.95) * em;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      for (let i = 3; i < p.length; i += 3) ctx.lineTo(X(i), Y(i));
      ctx.stroke();
      ctx.restore();
      return;
    }
    ctx.strokeStyle = col[s.c] || col.red;
    ctx.fillStyle = ctx.strokeStyle;
    const base = s.w * em;
    const width = (pr) => Math.max(0.2, s.np ? base : base * (0.55 + 0.9 * pr));
    if (p.length === 3) {
      ctx.beginPath(); ctx.arc(X(0), Y(0), width(p[2]) / 2, 0, 7); ctx.fill();
      return;
    }
    // 以中點二次曲線平滑；每段依筆壓調整粗細
    let px = X(0), py = Y(0);
    for (let i = 3; i < p.length; i += 3) {
      const last = i + 3 >= p.length;
      const mx = last ? X(i) : (X(i) + X(i + 3)) / 2;
      const my = last ? Y(i) : (Y(i) + Y(i + 3)) / 2;
      ctx.lineWidth = width((p[i + 2] + p[i - 1]) / 2);
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.quadraticCurveTo(X(i), Y(i), mx, my);
      ctx.stroke();
      px = mx; py = my;
    }
  }

  bind(canvas, aid, host) {
    const allowed = (e) => this.active && (e.pointerType === 'pen' || e.pointerType === 'mouse' || this.finger);
    // iPad Safari：Apple Pencil 書寫時不捲動；書寫中也忽略手掌觸碰
    const block = (e) => {
      if (!this.active) return;
      if (this.drawing) { e.preventDefault(); return; }
      for (const t of e.touches) if (t.touchType === 'stylus' || this.finger) { e.preventDefault(); return; }
    };
    canvas.addEventListener('touchstart', block, { passive: false });
    canvas.addEventListener('touchmove', block, { passive: false });

    let cur = null, em = 18, rect = null;
    const pt = (e) => {
      const x = (e.clientX - rect.left) / em, y = (e.clientY - rect.top) / em;
      const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(pr * 100) / 100];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!allowed(e)) return;
      e.preventDefault();
      rect = host.getBoundingClientRect();
      em = this.em(host);
      if (this.tool === 'sticky') { const q = pt(e); this.onSticky(aid, q[0], q[1]); return; }
      canvas.setPointerCapture(e.pointerId);
      this.drawing = aid;
      if (this.tool === 'eraser') { cur = { eraser: true }; this.erase(aid, pt(e)); return; }
      const marker = this.tool === 'marker';
      cur = marker
        ? { t: 'marker', c: this.color.startsWith('mark') ? this.color : 'mark', w: 0.95, pts: pt(e) }
        : { t: 'pen', c: this.color.startsWith('mark') ? 'red' : this.color, w: Math.round((this.mm * PX_PER_MM / em) * 10000) / 10000, mm: this.mm, pts: pt(e) };
      if (!marker && !this.pressure) cur.np = 1;
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
        if (dx * dx + dy * dy < 0.0002) continue;
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
      rec.ink.strokes = keep;
      this.saveRec(aid);
      this.draw(aid);
      this.onChange(aid);
    }
  }

  undoLast() {
    const u = this.undo.pop();
    if (!u) return false;
    const rec = this.getRec(u.aid, true);
    rec.ink = rec.ink || { strokes: [] };
    if (u.kind === 'add') rec.ink.strokes = rec.ink.strokes.filter((s) => s !== u.stroke);
    else rec.ink.strokes.push(u.stroke);
    this.saveRec(u.aid);
    this.attach(u.aid);
    this.draw(u.aid);
    this.onChange(u.aid);
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
