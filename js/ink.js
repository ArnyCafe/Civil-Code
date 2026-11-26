// 手寫註記：在條文上以 Apple Pencil 書寫。座標以「字級 em」為單位儲存，字級改變時仍可對齊。
const PEN_W = { 細: 0.07, 中: 0.11, 粗: 0.17 };

export class Ink {
  constructor({ getRec, saveRec, onChange }) {
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.finger = false;
    this.tool = 'pen';
    this.color = 'ink';
    this.width = '中';
    this.undo = [];
    this.layers = new Map(); // aid -> {canvas, host}
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
    return {
      ink: cs.getPropertyValue('--pen-ink').trim(),
      red: cs.getPropertyValue('--pen-red').trim(),
      green: cs.getPropertyValue('--pen-green').trim(),
      mark: cs.getPropertyValue('--pen-mark').trim(),
    };
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
    // 條文重新繪製後呼叫
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
    const all = live ? strokes.concat([live]) : strokes;
    for (const s of all) this.paint(ctx, s, em, col);
  }

  paint(ctx, s, em, col) {
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
    ctx.strokeStyle = col[s.c] || col.ink;
    if (p.length === 3) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(p[0] * em, p[1] * em, s.w * em * 0.5, 0, 7); ctx.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) {
      const pr = (p[i + 2] + p[i - 1]) / 2;
      ctx.lineWidth = Math.max(0.6, s.w * em * (0.45 + 0.9 * pr));
      ctx.beginPath();
      ctx.moveTo(p[i - 3] * em, p[i - 2] * em);
      ctx.lineTo(p[i] * em, p[i + 1] * em);
      ctx.stroke();
    }
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
      const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(pr * 100) / 100];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!allowed(e)) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      rect = host.getBoundingClientRect();
      em = this.em(host);
      this.drawing = aid;
      if (this.tool === 'eraser') { cur = { eraser: true }; this.erase(aid, pt(e)); return; }
      cur = { t: this.tool === 'marker' ? 'marker' : 'pen', c: this.color, w: PEN_W[this.width], pts: pt(e) };
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
        if (dx * dx + dy * dy < 0.0004) continue;
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
    const r2 = 0.5 * 0.5;
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

export const WIDTHS = Object.keys(PEN_W);
