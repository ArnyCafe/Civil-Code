// 手寫註記：用 Apple Pencil 在條文上書寫。
// 每一筆以「最靠近起筆點的字」為錨點、以字級 em 為單位儲存，
// 字級、行距、欄寬改變而重新排版時，筆跡會跟著該字移動。
export const PEN_COLORS = [
  ['red', '紅'], ['ink', '藍黑'], ['black', '黑'], ['blue', '藍'], ['green', '綠'],
  ['mark', '螢光黃', 'marker'], ['markp', '螢光粉', 'marker'],
];
export const WIDTH_PRESETS = [0.1, 0.3, 0.6, 1, 2, 4];
export const W_MIN = 0.1, W_MAX = 8;
// 滑桿 0–100 ↔ 0.1–8 px（對數刻度，細筆可精細調整）
export const sliderToWidth = (v) => {
  const w = W_MIN * Math.pow(W_MAX / W_MIN, v / 100);
  return w < 1 ? Math.round(w * 20) / 20 : w < 3 ? Math.round(w * 10) / 10 : Math.round(w * 2) / 2;
};
export const widthToSlider = (w) => Math.round((100 * Math.log(Math.max(W_MIN, w) / W_MIN)) / Math.log(W_MAX / W_MIN));

const PAD = { x: 0.8, y: 1.6 }; // 畫布比條文區四周多出的範圍（em），可在首行上方、末行下方書寫

export class Ink {
  constructor({ getRec, saveRec, onChange }) {
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange || (() => {});
    this.active = false;
    this.finger = false;
    this.tool = 'pen';
    this.color = 'red';
    this.width = 0.6;    // CSS px（以目前字級換算為 em 儲存）
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
    const v = (n) => cs.getPropertyValue(n).trim();
    return { red: v('--pen-red'), ink: v('--pen-ink'), black: v('--pen-black'), blue: v('--pen-blue'), green: v('--pen-green'), mark: v('--pen-mark'), markp: v('--pen-markp') };
  }

  observe(artEl) { this.io.observe(artEl); }

  reset() {
    for (const aid of [...this.layers.keys()]) { const L = this.layers.get(aid); this.ro.unobserve(L.host); L.canvas.remove(); }
    this.layers.clear();
    this.io.disconnect();
    this.undo = [];
  }

  setActive(on) {
    this.active = on;
    document.body.classList.toggle('inking', on);
    if (on) document.querySelectorAll('#reader-inner .art').forEach((el) => {
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
    canvas.className = 'ink-layer mine';
    canvas.style.cssText = `left:-${PAD.x}em;top:-${PAD.y}em;width:calc(100% + ${2 * PAD.x}em);height:calc(100% + ${2 * PAD.y}em)`;
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

  // ---- 錨點 ----
  textNodes(pt) {
    const w = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT);
    const out = [];
    let n, pos = 0;
    while ((n = w.nextNode())) { out.push([n, pos]); pos += n.data.length; }
    return out;
  }
  charRect(host, p, o) {
    const pt = host.querySelector(`.pt[data-p="${p}"]`);
    if (!pt) return null;
    const nodes = this.textNodes(pt);
    if (!nodes.length) return null;
    const total = nodes[nodes.length - 1][1] + nodes[nodes.length - 1][0].data.length;
    o = Math.max(0, Math.min(total - 1, o));
    for (const [n, pos] of nodes) {
      if (o < pos + n.data.length) {
        const r = document.createRange();
        r.setStart(n, o - pos); r.setEnd(n, o - pos + 1);
        const rs = r.getClientRects();
        return rs[0] || r.getBoundingClientRect();
      }
    }
    return null;
  }
  // 找出距離 (x, y)（螢幕座標）最近的字
  nearestChar(host, x, y) {
    let best = null, bd = Infinity;
    for (const pt of host.querySelectorAll('.pt[data-p]')) {
      const p = +pt.dataset.p;
      const pr = pt.getBoundingClientRect();
      if (pr.height && (y < pr.top - 200 || y > pr.bottom + 200) && best) continue;
      for (const [n, pos] of this.textNodes(pt)) {
        const r = document.createRange();
        for (let k = 0; k < n.data.length; k++) {
          r.setStart(n, k); r.setEnd(n, k + 1);
          const c = r.getClientRects()[0];
          if (!c || !c.width) continue;
          const dx = x < c.left ? c.left - x : x > c.right ? x - c.right : 0;
          const dy = y < c.top ? c.top - y : y > c.bottom ? y - c.bottom : 0;
          const d = dx * dx + 4 * dy * dy;
          if (d < bd) { bd = d; best = { p, o: pos + k, rect: c }; }
        }
      }
    }
    return best;
  }
  // 筆畫在畫布上的原點（px）
  origin(s, host, canvas, em, cache) {
    const cr = cache.canvas || (cache.canvas = canvas.getBoundingClientRect());
    if (s.a) {
      const k = s.a.p + ':' + s.a.o;
      let r = cache[k];
      if (r === undefined) r = cache[k] = this.charRect(host, s.a.p, s.a.o);
      if (r) return [r.left - cr.left, r.top - cr.top];
    }
    const hr = cache.host || (cache.host = host.getBoundingClientRect());
    return [hr.left - cr.left, hr.top - cr.top];
  }

  draw(aid, live) {
    const L = this.layers.get(aid);
    if (!L) return;
    const { canvas, host } = L;
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
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
    const cache = {};
    const all = live ? strokes.concat([live]) : strokes;
    for (const s of all) this.paint(ctx, s, em, col, this.origin(s, host, canvas, em, cache));
  }

  paint(ctx, s, em, col, [ox, oy]) {
    const p = s.pts;
    if (p.length < 3) return;
    const X = (i) => ox + p[i] * em, Y = (i) => oy + p[i + 1] * em;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
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
    if (p.length === 3) {
      ctx.fillStyle = ctx.strokeStyle;
      ctx.beginPath(); ctx.arc(X(0), Y(0), Math.max(0.05, s.w * em * 0.5), 0, 7); ctx.fill();
      return;
    }
    for (let i = 3; i < p.length; i += 3) {
      const pr = (p[i + 2] + p[i - 1]) / 2;
      ctx.lineWidth = Math.max(0.05, s.w * em * (0.55 + 0.9 * pr));
      ctx.beginPath();
      ctx.moveTo(X(i - 3), Y(i - 3));
      ctx.lineTo(X(i), Y(i));
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

    let cur = null, em = 18, org = [0, 0], cr = null;
    const pt = (e) => {
      const x = (e.clientX - cr.left - org[0]) / em, y = (e.clientY - cr.top - org[1]) / em;
      const pr = e.pointerType === 'pen' ? (e.pressure || 0.5) : 0.5;
      return [Math.round(x * 1000) / 1000, Math.round(y * 1000) / 1000, Math.round(pr * 100) / 100];
    };
    canvas.addEventListener('pointerdown', (e) => {
      if (!allowed(e)) return;
      e.preventDefault();
      canvas.setPointerCapture(e.pointerId);
      cr = canvas.getBoundingClientRect();
      em = this.em(host);
      this.drawing = aid;
      if (this.tool === 'eraser') { cur = { eraser: true }; this.erase(aid, e.clientX, e.clientY); return; }
      const near = this.nearestChar(host, e.clientX, e.clientY);
      const a = near ? { p: near.p, o: near.o } : null;
      org = near ? [near.rect.left - cr.left, near.rect.top - cr.top] : (() => { const hr = host.getBoundingClientRect(); return [hr.left - cr.left, hr.top - cr.top]; })();
      const isMarker = this.tool === 'marker';
      cur = { t: isMarker ? 'marker' : 'pen', c: this.color, w: isMarker ? 0.95 : Math.round((this.width / em) * 10000) / 10000, a, pts: pt(e) };
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!cur) return;
      e.preventDefault();
      const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
      for (const ev of evs.length ? evs : [e]) {
        if (cur.eraser) { this.erase(aid, ev.clientX, ev.clientY); continue; }
        const q = pt(ev);
        const n = cur.pts.length;
        const dx = q[0] - cur.pts[n - 3], dy = q[1] - cur.pts[n - 2];
        if (dx * dx + dy * dy < 0.00003) continue;
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
      rec.ink.v = 2;
      rec.ink.strokes.push(done);
      this.undo.push({ aid, kind: 'add', stroke: done });
      this.saveRec(aid);
      this.draw(aid);
      this.onChange(aid);
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }

  erase(aid, cx, cy) {
    const rec = this.getRec(aid);
    const L = this.layers.get(aid);
    if (!rec || !rec.ink || !L) return;
    const em = this.em(L.host);
    const cr = L.canvas.getBoundingClientRect();
    const x = cx - cr.left, y = cy - cr.top;
    const r2 = Math.pow(0.5 * em, 2);
    const cache = {};
    const keep = [];
    let removed = false;
    for (const s of rec.ink.strokes) {
      const [ox, oy] = this.origin(s, L.host, L.canvas, em, cache);
      let hit = false;
      for (let i = 0; i < s.pts.length; i += 3) {
        const dx = ox + s.pts[i] * em - x, dy = oy + s.pts[i + 1] * em - y;
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
}
