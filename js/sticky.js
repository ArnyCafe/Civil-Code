// 便利貼：半透明、可拖曳、可縮放，貼在條文上。座標以 em 為單位、相對於條文（.art）。
import { esc, uid } from './util.js';

export const STK_COLORS = [['y', '黃'], ['p', '粉'], ['b', '藍'], ['g', '綠'], ['o', '橘'], ['w', '白']];

export function stickiesHTML(rec) {
  const list = (rec && rec.stk) || [];
  if (!list.length) return '';
  return `<div class="stk-layer">${list.map(stickyHTML).join('')}</div>`;
}

function stickyHTML(s) {
  const op = s.op ?? 0.35;
  return `<div class="sticky st-${s.c || 'y'}${s.min ? ' min' : ''}" data-stk="${s.id}" style="left:${s.x}em;top:${s.y}em;width:${s.min ? 'auto' : s.w + 'em'};${s.min ? '' : `height:${s.h}em;`}--op:${op}">
<div class="stk-bar"><span class="stk-grip" aria-hidden="true"></span>${s.min ? `<span class="stk-mini">${esc((s.t || '便利貼').slice(0, 8))}</span>` : ''}<button type="button" class="stk-b" data-sact="min" aria-label="${s.min ? '展開' : '收合'}">${s.min ? '＋' : '－'}</button><button type="button" class="stk-b" data-sact="menu" aria-label="便利貼選項">⋯</button></div>
${s.min ? '' : `<div class="stk-body" data-sact="edit">${s.t ? `<span class="tx">${esc(s.t)}</span>` : '<span class="tx ph">點此輸入…</span>'}</div><span class="stk-rs" aria-hidden="true"></span>`}</div>`;
}

export class Stickies {
  constructor({ root, getRec, saveRec, onChange, menu, toast }) {
    this.root = root;
    this.getRec = getRec;
    this.saveRec = saveRec;
    this.onChange = onChange;
    this.menu = menu;   // (rect, sticky, key) => void
    this.toast = toast;
    this.placing = false;
    this.drag = null;
    this.bind();
  }

  find(el) {
    const st = el.closest('.sticky');
    const art = st && st.closest('.art');
    if (!st || !art) return null;
    const key = art.dataset.key;
    const rec = this.getRec(key);
    const s = rec && (rec.stk || []).find((x) => x.id === st.dataset.stk);
    return s ? { st, art, key, rec, s } : null;
  }

  rerender(key) {
    const art = this.root.querySelector(`.art[data-key="${CSS.escape(key)}"]`);
    if (!art) return;
    const old = art.querySelector(':scope > .stk-layer');
    const html = stickiesHTML(this.getRec(key));
    if (old) old.outerHTML = html || '';
    else if (html) art.insertAdjacentHTML('beforeend', html);
  }

  setPlacing(on) {
    this.placing = on;
    document.body.classList.toggle('placing', on);
  }

  create(art, clientX, clientY) {
    const key = art.dataset.key;
    const em = parseFloat(getComputedStyle(art).fontSize) || 18;
    const r = art.getBoundingClientRect();
    const w = 11, h = 5.5;
    const maxX = Math.max(0, r.width / em - w);
    const s = {
      id: uid(), c: 'y', op: 0.35, t: '',
      x: Math.round(Math.min(maxX, Math.max(0, (clientX - r.left) / em - 1)) * 100) / 100,
      y: Math.round(Math.max(0, (clientY - r.top) / em - 0.6) * 100) / 100,
      w, h,
    };
    const rec = this.getRec(key, true);
    rec.stk = rec.stk || [];
    rec.stk.push(s);
    this.saveRec(key);
    this.rerender(key);
    this.onChange(key);
    const st = art.querySelector(`.sticky[data-stk="${s.id}"]`);
    if (st) this.edit(st);
  }

  edit(st) {
    const f = this.find(st);
    if (!f || f.s.min) return;
    const body = st.querySelector('.stk-body');
    if (!body || body.querySelector('textarea')) return;
    st.classList.add('editing');
    body.innerHTML = `<textarea class="stk-ta" aria-label="便利貼內容">${esc(f.s.t || '')}</textarea>`;
    const ta = body.querySelector('textarea');
    ta.focus();
    const save = () => {
      f.s.t = ta.value.trim();
      st.classList.remove('editing');
      this.saveRec(f.key);
      this.rerender(f.key);
      this.onChange(f.key);
    };
    ta.addEventListener('blur', save, { once: true });
    ta.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); ta.blur(); } });
  }

  update(key, id, patch) {
    const rec = this.getRec(key, true);
    const s = (rec.stk || []).find((x) => x.id === id);
    if (!s) return;
    if (patch === null) rec.stk = rec.stk.filter((x) => x !== s);
    else Object.assign(s, patch);
    this.saveRec(key);
    this.rerender(key);
    this.onChange(key);
  }

  bind() {
    const root = this.root;
    root.addEventListener('pointerdown', (e) => {
      const grip = e.target.closest('.stk-bar');
      const rs = e.target.closest('.stk-rs');
      if ((!grip && !rs) || e.target.closest('button')) return;
      const f = this.find(e.target);
      if (!f) return;
      e.preventDefault();
      e.stopPropagation();
      const em = parseFloat(getComputedStyle(f.art).fontSize) || 18;
      this.drag = { ...f, em, id: e.pointerId, x0: e.clientX, y0: e.clientY, sx: f.s.x, sy: f.s.y, sw: f.s.w, sh: f.s.h, resize: !!rs, moved: false };
      try { f.st.setPointerCapture(e.pointerId); } catch {}
      f.st.classList.add('dragging');
    }, { capture: true });
    root.addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      e.preventDefault();
      const dx = (e.clientX - d.x0) / d.em, dy = (e.clientY - d.y0) / d.em;
      if (Math.abs(dx) + Math.abs(dy) > 0.1) d.moved = true;
      const r = d.art.getBoundingClientRect();
      if (d.resize) {
        d.s.w = Math.round(Math.max(5, d.sw + dx) * 100) / 100;
        d.s.h = Math.round(Math.max(2.4, d.sh + dy) * 100) / 100;
        d.st.style.width = d.s.w + 'em';
        d.st.style.height = d.s.h + 'em';
      } else {
        const w = d.st.offsetWidth / d.em;
        d.s.x = Math.round(Math.min(Math.max(0, r.width / d.em - w), Math.max(-0.5, d.sx + dx)) * 100) / 100;
        d.s.y = Math.round(Math.max(-0.5, d.sy + dy) * 100) / 100;
        d.st.style.left = d.s.x + 'em';
        d.st.style.top = d.s.y + 'em';
      }
    }, { capture: true });
    const end = (e) => {
      const d = this.drag;
      if (!d || e.pointerId !== d.id) return;
      this.drag = null;
      d.st.classList.remove('dragging');
      if (d.moved) { this.saveRec(d.key); this.onChange(d.key); }
    };
    root.addEventListener('pointerup', end, { capture: true });
    root.addEventListener('pointercancel', end, { capture: true });

    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-sact]');
      if (b && b.closest('.sticky')) {
        e.stopPropagation();
        e.preventDefault();
        const f = this.find(b);
        if (!f) return;
        const act = b.dataset.sact;
        if (act === 'min') this.update(f.key, f.s.id, { min: !f.s.min });
        else if (act === 'menu') this.menu(b.getBoundingClientRect(), f.s, f.key);
        else if (act === 'edit') this.edit(f.st);
        return;
      }
      if (e.target.closest('.sticky')) { e.stopPropagation(); return; }
      if (this.placing) {
        const art = e.target.closest('.art');
        if (!art) return;
        e.stopPropagation();
        e.preventDefault();
        this.setPlacing(false);
        this.create(art, e.clientX, e.clientY);
      }
    }, { capture: true });
  }
}
