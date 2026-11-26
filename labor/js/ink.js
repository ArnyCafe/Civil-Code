// Apple Pencil 手寫註記
// - 每條條文一個 <canvas>，覆蓋條文區（含行間與右側留白）
// - 每一筆畫綁定在它起筆所在的段落區塊 [data-b]，座標以「該區塊左上角」為原點、以字級 em 為單位，
//   因此字級改變、其他段落加入註記或引用小字而位移時，筆跡仍跟著自己的段落走
// - 筆寬以 CSS 像素設定，最細 0.1（iPad 螢幕 1 個實體像素約 0.5，低於此值時線條會變淡而非更細）

export const PEN_COLORS = {
  red: '--pen-red', blue: '--pen-blue', black: '--pen-black', green: '--pen-green',
  hly: '--pen-hly', hlp: '--pen-hlp', hlg: '--pen-hlg',
};
export const isMarker = (c) => c.startsWith('hl');

export class Ink {
  constructor({ getRec, saveRec, onChange, onTap }) {
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange || (() => {});
    this.onTap = onTap || (() => {});
    this.active = false;
    this.finger = false;
    this.tool = 'pen';     // pen | eraser
    this.color = 'red';
    this.width = 0.5;      // CSS px
    this.mwidth = 14;      // 螢光筆寬（px）
    this.pressure = true;
    this.undo = [];
    this.redo = [];
    this.layers = new Map(); // aid -> {canvas, host}
    this.ro = new ResizeObserver((ents) => {
      for (const e of ents) { const aid = e.target.closest('.art')?.dataset.id; if (aid) this.draw(aid); }
    });
    this.io = new IntersectionObserver((ents) => {
      for (const e of ents) { const aid = e.target.dataset.id; if (e.isIntersecting) this.attach(aid); else this.detach(aid); }
    }, { rootMargin: '800px 0px' });
  }

  colors() {
    const cs = getComputedStyle(document.documentElement);
    const out = {};
    for (const [k, v] of Object.entries(PEN_COLORS)) out[k] = cs.getPropertyValue(v).trim() || '#c00';
    return out;
  }

  observe(artEl) { this.io.observe(artEl); }
  unobserveAll() { this.io.disconnect(); for (const aid of [...this.layers.keys()]) this.detach(aid, true); }

  setActive(on) {
    this.active = on;
    document.body.classList.toggle('inking', on);
    if (on) document.querySelectorAll('.art').forEach((el) => {
      const r = el.getBoundingClientRect();
      if (r.bottom > -800 && r.top < innerHeight + 800) this.attach(el.dataset.id);
    });
  }

  strokes(aid) {
    const rec = this.getRec(aid);
    return (rec && rec.ink && rec.ink.strokes) || [];
  }

  attach(aid) {
    if (!this.strokes(aid).length && !this.active) return;
    if (this.layers.has(aid)) { this.draw(aid); return; }
    const host = document.querySelector(`#a-${CSS.escape(aid)} .abody`);
    if (!host) return;
    const canvas = document.createElement('canvas');
    canvas.className = 'ink-layer';
    host.appendChild(canvas);
    this.bind(canvas, aid, host);
    this.layers.set(aid, { canvas, host });
    this.ro.observe(host);
    this.draw(aid);
  }

  detach(aid, force) {
    const L = this.layers.get(aid);
    if (!L || (this.drawing === aid && !force)) return;
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

  // 各區塊相對於 host 的位置（px）
  blocks(host) {
    const hr = host.getBoundingClientRect();
    const m = new Map();
    for (const el of host.querySelectorAll('[data-b]')) {
      if (!el.offsetParent) continue; // 隱藏中
      const r = el.getBoundingClientRect();
      if (!r.height) continue;
      m.set(el.dataset.b, { x: r.left - hr.left, y: r.top - hr.top, h: r.height, el });
    }
    return m;
  }

  blockAt(host, y) {
    const bs = this.blocks(host);
    let best = null;
    for (const [k, v] of bs) {
      if (y >= v.y - 2 && y <= v.y + v.h + 2) return [k, v];
      if (v.y <= y && (!best || v.y > best[1].y)) best = [k, v];
    }
    return best || [...bs.entries()][0] || ['h', { x: 0, y: 0 }];
  }

  size(L) {
    const { canvas, host } = L;
    const dpr = window.devicePixelRatio || 1;
    const w = host.clientWidth, h = host.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      canvas.style.width = w + 'px';
      canvas.style.height = h + 'px';
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  draw(aid) {
    const L = this.layers.get(aid);
    if (!L) return;
    const { ctx, w, h } = this.size(L);
    ctx.clearRect(0, 0, w, h);
    const em = this.em(L.host);
    const col = this.colors();
    const bs = this.blocks(L.host);
    for (const s of this.strokes(aid)) {
      const o = bs.get(s.b);
      if (!o) continue;
      this.paint(ctx, s, em, col, o.x, o.y);
    }
  }

  // 平滑筆畫：以中點二次曲線連接取樣點
  paint(ctx, s, em, col, ox, oy, from = 0) {
    const p = s.pts;
    const n = p.length / 3;
    if (!n) return;
    const X = (i) => ox + p[i * 3] * em, Y = (i) => oy + p[i * 3 + 1] * em;
    const base = s.w * em;
    ctx.save();
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = col[s.c] || col.red;
    ctx.fillStyle = ctx.strokeStyle;
    if (isMarker(s.c)) { ctx.globalCompositeOperation = 'multiply'; ctx.lineCap = 'butt'; }
    if (n === 1) {
      ctx.beginPath(); ctx.arc(X(0), Y(0), Math.max(base, 0.1) / 2, 0, 7); ctx.fill(); ctx.restore(); return;
    }
    if (!s.pr || isMarker(s.c)) {
      ctx.lineWidth = base;
      ctx.beginPath();
      ctx.moveTo(X(0), Y(0));
      for (let i = 1; i < n - 1; i++) ctx.quadraticCurveTo(X(i), Y(i), (X(i) + X(i + 1)) / 2, (Y(i) + Y(i + 1)) / 2);
      ctx.lineTo(X(n - 1), Y(n - 1));
      ctx.stroke();
    } else {
      // 壓力感應：逐段改變粗細
      for (let i = Math.max(1, from); i < n; i++) {
        const pr = (p[i * 3 + 2] + p[i * 3 - 1]) / 2;
        ctx.lineWidth = base * (0.35 + 1.3 * pr);
        const sx = i === 1 ? X(0) : (X(i - 1) + X(i)) / 2, sy = i === 1 ? Y(0) : (Y(i - 1) + Y(i)) / 2;
        const ex = i < n - 1 ? (X(i) + X(i + 1)) / 2 : X(i), ey = i < n - 1 ? (Y(i) + Y(i + 1)) / 2 : Y(i);
        ctx.beginPath();
        ctx.moveTo(sx, sy);
        ctx.quadraticCurveTo(X(i), Y(i), ex, ey);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  bind(canvas, aid, host) {
    const penLike = (e) => e.pointerType === 'pen' || e.pointerType === 'mouse';
    const allowed = (e) => this.active && (penLike(e) || this.finger);
    // iPad Safari：Apple Pencil 不觸發捲動；手指仍可捲動
    const blockStylus = (e) => {
      if (!this.active) return;
      for (const t of e.touches) if (t.touchType === 'stylus' || this.finger) { e.preventDefault(); return; }
    };
    canvas.addEventListener('touchstart', blockStylus, { passive: false });
    canvas.addEventListener('touchmove', blockStylus, { passive: false });

    let cur = null, em = 18, rect = null, org = null, tap = null;
    const pt = (e) => {
      const x = (e.clientX - rect.left - org.x) / em, y = (e.clientY - rect.top - org.y) / em;
      const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round(x * 2000) / 2000, Math.round(y * 2000) / 2000, Math.round(pr * 100) / 100];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!allowed(e)) {
        // 手寫模式下以手指點一下：交給底下的元素（例如切換註記顯示）
        if (this.active && e.pointerType === 'touch') tap = { x: e.clientX, y: e.clientY, t: Date.now() };
        return;
      }
      e.preventDefault();
      try { canvas.setPointerCapture(e.pointerId); } catch {}
      rect = host.getBoundingClientRect();
      em = this.em(host);
      this.drawing = aid;
      if (this.tool === 'eraser') {
        cur = { eraser: true };
        org = { x: 0, y: 0 };
        this.erase(aid, e.clientX - rect.left, e.clientY - rect.top, em);
        return;
      }
      const [b, o] = this.blockAt(host, e.clientY - rect.top);
      org = o;
      const marker = isMarker(this.color);
      cur = { c: this.color, w: Math.round(((marker ? this.mwidth : this.width) / em) * 100000) / 100000, pr: marker ? 0 : (this.pressure ? 1 : 0), b, pts: pt(e) };
      this.lastDrawn = 0;
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        if (cur.eraser) { this.erase(aid, ev.clientX - rect.left, ev.clientY - rect.top, em); continue; }
        const q = pt(ev);
        const n = cur.pts.length;
        const dx = q[0] - cur.pts[n - 3], dy = q[1] - cur.pts[n - 2];
        if (dx * dx + dy * dy < 0.00001) continue;
        cur.pts.push(...q);
      }
      if (!cur.eraser) this.live(aid, cur, em, org);
    });
    const end = (e) => {
      if (tap && e && e.pointerType === 'touch') {
        const t = tap; tap = null;
        if (Math.abs(e.clientX - t.x) < 10 && Math.abs(e.clientY - t.y) < 10 && Date.now() - t.t < 400) this.passTap(canvas, e.clientX, e.clientY);
        return;
      }
      if (!cur) return;
      const done = cur;
      cur = null;
      this.drawing = null;
      if (done.eraser) return;
      const rec = this.getRec(aid, true);
      rec.ink = rec.ink || { strokes: [] };
      rec.ink.strokes.push(done);
      this.undo.push({ aid, kind: 'add', stroke: done });
      this.redo = [];
      this.saveRec(aid);
      this.draw(aid);
      this.onChange(aid);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', () => { tap = null; end(); });
  }

  passTap(canvas, x, y) {
    canvas.style.pointerEvents = 'none';
    const el = document.elementFromPoint(x, y);
    canvas.style.pointerEvents = '';
    if (el) this.onTap(el);
  }

  // 繪製進行中的筆畫（只畫新增部分，降低延遲）
  live(aid, s, em, org) {
    const L = this.layers.get(aid);
    if (!L) return;
    const { ctx } = this.size(L);
    const col = this.colors();
    const n = s.pts.length / 3;
    if (!s.pr || isMarker(s.c)) {
      // 定寬筆：重畫整條比較平滑（筆畫點數有限，成本低）
      this.draw(aid);
      this.paint(this.size(L).ctx, s, em, col, org.x, org.y);
    } else {
      this.paint(ctx, s, em, col, org.x, org.y, Math.max(1, (this.lastDrawn || 1) - 1));
    }
    this.lastDrawn = n;
  }

  erase(aid, x, y, em) {
    const rec = this.getRec(aid);
    const L = this.layers.get(aid);
    if (!rec || !rec.ink || !L) return;
    const bs = this.blocks(L.host);
    const r = 9; // px
    const keep = [];
    let removed = false;
    for (const s of rec.ink.strokes) {
      const o = bs.get(s.b);
      let hit = false;
      if (o) {
        const lim = r + (s.w * em) / 2;
        for (let i = 0; i < s.pts.length; i += 3) {
          const dx = o.x + s.pts[i] * em - x, dy = o.y + s.pts[i + 1] * em - y;
          if (dx * dx + dy * dy < lim * lim) { hit = true; break; }
        }
      }
      if (hit) { removed = true; this.undo.push({ aid, kind: 'del', stroke: s }); } else keep.push(s);
    }
    if (removed) {
      rec.ink.strokes = keep;
      this.redo = [];
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
  undoLast() { const u = this.undo.pop(); if (!u) return false; this.apply(u, true); this.redo.push(u); return true; }
  redoLast() { const u = this.redo.pop(); if (!u) return false; this.apply(u, false); this.undo.push(u); return true; }

  clear(aid) {
    const rec = this.getRec(aid);
    if (!rec || !rec.ink) return;
    for (const s of rec.ink.strokes) this.undo.push({ aid, kind: 'del', stroke: s });
    rec.ink.strokes = [];
    this.saveRec(aid);
    this.draw(aid);
    this.onChange(aid);
  }
}
