// 便利貼：半透明、貼在條文上，可拖曳、縮放、改色、調透明度、縮小成標籤。
// 位置與大小以條文本文（.atext）左上角為原點、字級 em 為單位。
const COLORS = ['y', 'p', 'b', 'g'];
const OPS = [0.1, 0.16, 0.22, 0.3, 0.4, 0.55];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const r2 = (v) => Math.round(v * 100) / 100;

export class Stickies {
  constructor({ getRec, saveRec, onChange, uid }) {
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange || (() => {});
    this.uid = uid;
    this.sel = null;       // {aid, id}
    this.lastColor = 'y';
    this.lastOp = 0.22;
    document.addEventListener('pointerdown', (e) => {
      if (this.sel && !e.target.closest('.sticky')) this.select(null);
    }, true);
  }

  list(aid) { const r = this.getRec(aid); return (r && r.st) || []; }

  render(aid) {
    const art = document.getElementById('a-' + aid);
    const host = art && art.querySelector('.atext');
    if (!host) return;
    let box = host.querySelector(':scope > .stickies');
    const items = this.list(aid);
    if (!items.length) { if (box) box.remove(); return; }
    if (!box) { box = document.createElement('div'); box.className = 'stickies'; host.appendChild(box); }
    box.innerHTML = items.map((s) => this.html(s)).join('');
    for (const el of box.children) this.bind(el, aid, host);
    if (this.sel && this.sel.aid === aid) {
      const el = box.querySelector(`[data-st="${this.sel.id}"]`);
      if (el) this.showTools(el, aid); else this.sel = null;
    }
  }

  html(s) {
    return `<div class="sticky c-${s.c || 'y'}${s.min ? ' min' : ''}" data-st="${s.id}" style="left:${s.x}em;top:${s.y}em;width:${s.w}em;height:${s.h}em;--op:${s.op ?? 0.22}" title="便利貼">
      <div class="st-bar" aria-label="拖曳移動"></div><div class="st-text">${esc(s.t)}</div><div class="st-rs" aria-label="拖曳縮放"></div></div>`;
  }

  find(aid, id) { return this.list(aid).find((s) => s.id === id); }

  create(aid, x, y, text = '') {
    const rec = this.getRec(aid, true);
    rec.st = rec.st || [];
    const s = { id: this.uid(), x: r2(x), y: r2(y), w: 9, h: 4.2, c: this.lastColor, op: this.lastOp, t: text };
    rec.st.push(s);
    this.saveRec(aid);
    this.sel = { aid, id: s.id };
    this.render(aid);
    this.onChange(aid);
    const el = document.querySelector(`#a-${CSS.escape(aid)} [data-st="${s.id}"]`);
    if (el) this.edit(el, aid);
    return s;
  }

  remove(aid, id) {
    const rec = this.getRec(aid, true);
    rec.st = (rec.st || []).filter((s) => s.id !== id);
    if (this.sel && this.sel.id === id) this.sel = null;
    this.saveRec(aid);
    this.render(aid);
    this.onChange(aid);
  }

  select(target, aid) {
    document.querySelectorAll('.sticky.on').forEach((el) => {
      el.classList.remove('on');
      el.querySelector('.st-tools')?.remove();
    });
    if (!target) { this.sel = null; return; }
    this.sel = { aid, id: target.dataset.st };
    this.showTools(target, aid);
  }

  showTools(el, aid) {
    el.classList.add('on');
    if (el.querySelector('.st-tools')) return;
    const s = this.find(aid, el.dataset.st);
    if (!s) return;
    const t = document.createElement('div');
    t.className = 'st-tools';
    t.innerHTML = `${COLORS.map((c) => `<button class="stc" data-c="${c}" aria-label="顏色"></button>`).join('')}
      <button data-a="op-" title="更透明">淡</button><button data-a="op+" title="較不透明">濃</button>
      <button data-a="edit">編輯</button><button data-a="min">${s.min ? '展開' : '縮小'}</button><button data-a="del" class="danger">刪除</button>`;
    el.appendChild(t);
    // 工具列超出條文上緣時改放下方
    requestAnimationFrame(() => {
      const r = t.getBoundingClientRect();
      if (r.top < 70) { t.style.bottom = 'auto'; t.style.top = 'calc(100% + 6px)'; }
      const rr = t.getBoundingClientRect();
      if (rr.right > innerWidth - 8) t.style.left = (innerWidth - 8 - rr.right) + 'px';
    });
    t.addEventListener('pointerdown', (e) => e.stopPropagation());
    t.addEventListener('click', (e) => {
      e.stopPropagation();
      const b = e.target.closest('button');
      if (!b) return;
      const cur = this.find(aid, el.dataset.st);
      if (!cur) return;
      if (b.dataset.c) { cur.c = b.dataset.c; this.lastColor = cur.c; }
      else if (b.dataset.a === 'op-' || b.dataset.a === 'op+') {
        const i = OPS.findIndex((o) => o >= (cur.op ?? 0.22) - 0.001);
        const ni = Math.max(0, Math.min(OPS.length - 1, (i < 0 ? 2 : i) + (b.dataset.a === 'op+' ? 1 : -1)));
        cur.op = OPS[ni]; this.lastOp = cur.op;
      } else if (b.dataset.a === 'min') cur.min = !cur.min || undefined;
      else if (b.dataset.a === 'del') { this.remove(aid, cur.id); return; }
      else if (b.dataset.a === 'edit') { this.edit(el, aid); return; }
      this.saveRec(aid);
      this.render(aid);
    });
  }

  edit(el, aid) {
    const s = this.find(aid, el.dataset.st);
    if (!s) return;
    if (s.min) { s.min = undefined; this.saveRec(aid); this.render(aid); el = document.querySelector(`#a-${CSS.escape(aid)} [data-st="${s.id}"]`); }
    const txt = el.querySelector('.st-text');
    if (!txt) return;
    const ta = document.createElement('textarea');
    ta.className = 'st-edit';
    ta.value = s.t || '';
    ta.placeholder = '輸入便利貼內容';
    txt.replaceWith(ta);
    ta.addEventListener('pointerdown', (e) => e.stopPropagation());
    ta.addEventListener('click', (e) => e.stopPropagation());
    ta.addEventListener('blur', () => {
      s.t = ta.value;
      this.saveRec(aid);
      this.render(aid);
      this.onChange(aid);
    });
    setTimeout(() => ta.focus(), 30);
  }

  bind(el, aid, host) {
    const id = el.dataset.st;
    let lastTap = 0;
    const drag = (handle, kind) => {
      handle.addEventListener('pointerdown', (e) => {
        if (document.body.classList.contains('inking')) return;
        e.preventDefault();
        e.stopPropagation();
        const s = this.find(aid, id);
        if (!s) return;
        this.select(el, aid);
        try { handle.setPointerCapture(e.pointerId); } catch {}
        const em = parseFloat(getComputedStyle(host).fontSize) || 18;
        const x0 = e.clientX, y0 = e.clientY;
        const sx = s.x, sy = s.y, sw = s.w, sh = s.h;
        const W = host.clientWidth / em;
        const move = (ev) => {
          const dx = (ev.clientX - x0) / em, dy = (ev.clientY - y0) / em;
          if (kind === 'move') {
            s.x = r2(Math.max(-0.6, Math.min(W - 1.5, sx + dx)));
            s.y = r2(Math.max(-1.2, sy + dy));
            el.style.left = s.x + 'em'; el.style.top = s.y + 'em';
          } else {
            s.w = r2(Math.max(3.2, Math.min(W + 0.6 - s.x, sw + dx)));
            s.h = r2(Math.max(2.4, sh + dy));
            el.style.width = s.w + 'em'; el.style.height = s.h + 'em';
          }
        };
        const up = () => {
          handle.removeEventListener('pointermove', move);
          handle.removeEventListener('pointerup', up);
          handle.removeEventListener('pointercancel', up);
          this.saveRec(aid);
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', up);
        handle.addEventListener('pointercancel', up);
      });
    };
    drag(el.querySelector('.st-bar'), 'move');
    drag(el.querySelector('.st-rs'), 'size');
    el.addEventListener('pointerdown', (e) => e.stopPropagation());
    el.addEventListener('click', (e) => {
      e.stopPropagation();
      if (e.target.closest('.st-tools') || e.target.closest('textarea')) return;
      const s = this.find(aid, id);
      if (!s) return;
      if (s.min) { s.min = undefined; this.saveRec(aid); this.render(aid); return; }
      const now = Date.now();
      if (now - lastTap < 380 || !el.classList.contains('on') && !s.t) { lastTap = 0; this.select(el, aid); this.edit(el, aid); return; }
      lastTap = now;
      this.select(el, aid);
    });
  }
}
