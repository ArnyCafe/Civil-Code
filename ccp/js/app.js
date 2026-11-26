import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, paint, widthToSlider, sliderToWidth } from './ink.js';
import { Stickies } from './sticky.js';
import { Cloud } from './cloud.js';

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let D = null;              // 條文資料（law.json）
let H = null;              // 沿革與理由（hist.json，延遲載入）
let R = null;              // 判解（rulings.json，延遲載入）
const byId = new Map();
const order = [];
const orderIdx = new Map();
const notes = new Map();   // aid -> 使用者紀錄
const tombs = new Map();   // aid -> 刪除時間（同步用墓碑）
const known = new Set();   // 本機曾儲存過的條號
const cloud = new Cloud();
let dlApi = null;          // Artifact 的 downloads 能力
const DEFAULTS = {
  theme: 'system', size: 18, lh: 2.3, pn: true, chips: true, gist: true, measure: 'fixed', pcolor: true,
  tap: 'one', master: true, show: { ink: true, notes: true, hl: true, st: true, imp: true, xlaw: true },
  hidden: [], pen: { px: 0.5, color: 'red', pressure: true },
};
let settings = structuredClone(DEFAULTS);
let hiddenArts = new Set();
let current = null;
let detailTab = 'rulings';
let rulFilter = 'all';
let cmpMode = 'table';
let cmpSel = null;
const xlawOpen = new Set();
const backStack = [];

const TYPE_LABEL = { CJ: '憲法法庭', C: '大法官解釋', J: '判例', U: '我的' };
const USER_KINDS = ['判決', '函釋', '決議', '大法庭裁定', '其他'];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
export function aidLabel(aid) {
  const [a, b] = aid.split('-');
  return b ? `第${a}條之${b}` : `第${a}條`;
}
function roc(d, short) {
  if (!d) return '';
  const y = +d.slice(0, 4) - 1911, m = d.slice(4, 6), dd = d.slice(6, 8);
  return short ? `${y}.${m}.${dd}` : `民國${y}年${+m}月${+dd}日`;
}
const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
function cnNum(s) {
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '千') { total += (cur || 1) * 1000; cur = 0; }
  }
  return total + cur;
}
function parseAidInput(q) {
  q = q.trim().replace(/\s+/g, '').replace(/^(?:民事訴訟法|民訴法?|本法)/, '');
  let m = q.match(/^第?(\d+)(?:條)?(?:[-之](\d+))?(?:條)?$/);
  if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
  m = q.match(/^第?([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?$/);
  if (m) return m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1]));
  return null;
}
function toast(msg, ms = 2400) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, ms);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Math.random().toString(36).slice(2, 9);
function headingPath(hidx) {
  const out = [];
  while (hidx >= 0) { out.unshift(D.headings[hidx].t); hidx = D.headings[hidx].p; }
  return out;
}
let partOrder = new Map(); // heading idx of 編 -> 0..9
const pcVar = (a) => `var(--p${partOrder.get(a.part) ?? 0})`;

// ---------------------------------------------------------------------------
// 使用者紀錄
// ---------------------------------------------------------------------------
function getRec(aid, create) {
  let r = notes.get(aid);
  if (!r && create) { r = {}; notes.set(aid, r); }
  return r;
}
const nInk = (r) => (r && r.ink && r.ink.strokes ? r.ink.strokes.length : 0);
function hasAnno(r) {
  return !!(r && (r.note || (r.hl && r.hl.length) || nInk(r) || (r.st && r.st.length) || (r.imp && Object.keys(r.imp).length) || (r.items && r.items.length)));
}
function isEmptyRec(r) {
  return !r || (!r.star && !(r.tags && r.tags.length) && !hasAnno(r) && !(r.rnote && Object.keys(r.rnote).length));
}
async function saveRec(aid) {
  const r = notes.get(aid);
  const t = Date.now();
  try {
    if (isEmptyRec(r)) {
      notes.delete(aid);
      if (!known.has(aid)) return;
      tombs.set(aid, t);
      await store.put('a:' + aid, { del: 1, t });
      cloud.push('a:' + aid, { del: 1, t });
    } else {
      r.t = t;
      known.add(aid);
      tombs.delete(aid);
      await store.put('a:' + aid, r);
      cloud.push('a:' + aid, r);
    }
  } catch (e) {
    console.error(e);
    toast('無法儲存註記：' + (e.message || e));
  }
}
// 雲端傳來的紀錄：較新者覆蓋本機（不再回寫雲端）
function onRemoteDoc(id, data) {
  if (!id.startsWith('a:')) return;
  const aid = id.slice(2);
  if (!byId.has(aid)) return;
  const local = notes.get(aid);
  const lt = (local && local.t) || tombs.get(aid) || 0;
  const rt = data.t || 0;
  if (rt > lt) {
    known.add(aid);
    if (data.del) { notes.delete(aid); tombs.set(aid, rt); store.put('a:' + aid, { del: 1, t: rt }).catch(() => {}); }
    else { tombs.delete(aid); notes.set(aid, data); store.put('a:' + aid, data).catch(() => {}); }
    refreshArticle(aid);
    refreshChips(aid);
    if (current === aid) renderDetail();
  } else if (rt < lt) {
    cloud.push(id, local || { del: 1, t: lt });
  }
}
function onFirstSync(remoteIds) {
  let n = 0;
  notes.forEach((r, aid) => { if (!remoteIds.has('a:' + aid)) { cloud.push('a:' + aid, r); n++; } });
  if (n) console.info('上傳本機註記到雲端：', n);
}
async function saveSettings() {
  settings.hidden = [...hiddenArts];
  try { await store.put('settings', settings); } catch {}
}

// ---------------------------------------------------------------------------
// 條文呈現
// ---------------------------------------------------------------------------
const KUAN_RE = /^([一二三四五六七八九十]+、)/;
const SUB_RE = /^([（(][一二三四五六七八九十]+[）)])/;
const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ'];

function splitPara(t) {
  let m = t.match(KUAN_RE);
  if (m) return { kind: 'kuan', mark: m[1], body: t.slice(m[1].length) };
  m = t.match(SUB_RE);
  if (m) return { kind: 'sub', mark: m[1], body: t.slice(m[1].length) };
  return { kind: 'xiang', mark: '', body: t };
}

// 引用條號：同法 → 點選跳轉；他法 → 小字顯示該條文字
const XREF_CN = /第([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?/g;
const XREF_AR = /第\s*(\d+)\s*條(?:之\s*(\d+))?/g;
const PREV_RE = /前([二三四五六七八九]?)條/g;
const OTHER_LAW_END = /[一-鿿]{1,15}(?:法|條例|通則)$/;
function xrefRanges(text, mode, aid) {
  const out = [];
  if (mode === 'law') {
    // 他法（D.xlaw 中有原文引用者）
    for (const it of (D.xlaw[aid] || [])) {
      if (!it.q) continue;
      let i = -1;
      while ((i = text.indexOf(it.q, i + 1)) >= 0) out.push({ s: i, e: i + it.q.length, xlaw: `${it.law}|${it.a}` });
    }
    let m;
    XREF_CN.lastIndex = 0;
    let prevEnd = -1, prevOther = false;
    while ((m = XREF_CN.exec(text))) {
      const s = m.index, e = s + m[0].length;
      if (out.some((r) => r.s <= s && r.e >= e)) { prevEnd = e; prevOther = true; continue; }
      const before = text.slice(Math.max(0, s - 16), s);
      const gap = prevEnd >= 0 ? text.slice(prevEnd, s) : null;
      let other = OTHER_LAW_END.test(before) && !/本法$/.test(before);
      if (!other && prevOther && gap !== null && /^(?:第[一二三四五六七八九十]+[項款])?[、及或至與和]$/.test(gap)) other = true;
      prevEnd = e; prevOther = other;
      if (other) continue;
      const t = m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1]));
      if (byId.has(t) && t !== aid) out.push({ s, e, aid: t });
    }
    PREV_RE.lastIndex = 0;
    const idx = orderIdx.get(aid);
    while ((m = PREV_RE.exec(text))) {
      if (text[m.index - 1] === '第') continue;
      const n = m[1] ? cnNum(m[1]) : 1;
      const t = order[idx - n];
      if (t) out.push({ s: m.index, e: m.index + m[0].length, aid: t, prev: n });
    }
  } else {
    const test = (re, conv) => {
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        const before = text.slice(Math.max(0, m.index - 8), m.index);
        if (!/(?:民事訴訟法|民訴法|本法)$/.test(before)) continue;
        const t = m[2] ? `${conv(m[1])}-${conv(m[2])}` : String(conv(m[1]));
        if (byId.has(t)) out.push({ s: m.index, e: m.index + m[0].length, aid: t });
      }
    };
    test(XREF_CN, cnNum);
    test(XREF_AR, Number);
  }
  return out.sort((a, b) => a.s - b.s);
}

function anchorHTML(h) {
  return `<span class="anc ${h.pos === 'dn' ? 'dn' : 'up'}"><span class="anote" data-sn="${h.id}">${esc(h.n)}</span></span>`;
}

function renderRich(text, hls, mode, aid) {
  const xr = xrefRanges(text, mode, aid);
  const cuts = new Set([0, text.length]);
  for (const h of hls) { cuts.add(Math.max(0, Math.min(text.length, h.s))); cuts.add(Math.max(0, Math.min(text.length, h.e))); }
  for (const x of xr) { cuts.add(x.s); cuts.add(x.e); }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    let h = null;
    for (const c of hls) if (c.s <= s && c.e >= e) h = c; // 後加者優先
    const first = h && h.n && !hls.some((c) => c.id === h.id && c.s < s);
    const raw = text.slice(s, e);
    let piece = first ? `<span class="nb" style="white-space:nowrap">${anchorHTML(h)}${esc(raw[0])}</span>${esc(raw.slice(1))}` : esc(raw);
    const x = xr.find((r) => r.s <= s && r.e >= e);
    if (x && x.xlaw) piece = `<a class="xlaw" href="#" data-xlaw="${esc(x.xlaw)}">${piece}</a>`;
    else if (x) piece = `<a class="xref" href="#a-${x.aid}" data-goto="${x.aid}"${x.prev ? ` title="${aidLabel(x.aid)}"` : ''}>${piece}</a>`;
    if (h) piece = `<mark class="hl hl-${h.c}" data-hl="${h.id}">${piece}</mark>`;
    html += piece;
  }
  return html;
}

function renderParas(a, rec, mode = 'law') {
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  let xi = 0;
  return a.p.map((t, i) => {
    const sp = splitPara(t);
    const hls = ((rec && rec.hl) || []).filter((h) => h.p === i);
    const body = renderRich(sp.body, hls, mode, a.id);
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      return `<p class="para"><span class="pn">${pn}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    }
    return `<p class="para ${sp.kind === 'kuan' ? 'kuan' : 'kuan sub'}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-p="${i}">${body}</span></p>`;
  }).join('');
}

function rulingCount(aid) {
  const n = (R && R[aid] ? R[aid].length : 0);
  const rec = notes.get(aid);
  return n + (rec && rec.items ? rec.items.length : 0);
}
function amendCount(aid) { return byId.get(aid)?.am || 0; }
function versionsOf(aid) { return H && H.arts[aid] ? H.arts[aid].map((v, i) => ({ ...v, i })) : []; }
function reasonCount(aid) { return versionsOf(aid).filter((v) => !v.old && v.r).length; }

function chipsHTML(aid) {
  const rec = notes.get(aid);
  const out = [];
  if (rec && rec.star) out.push('<span class="chip c-star" title="書籤">★</span>');
  if (settings.chips) {
    const rc = rulingCount(aid);
    if (rc) out.push(`<button class="chip c-rul" data-open="${aid}" data-tab="rulings">判解 ${rc}</button>`);
    const ac = amendCount(aid);
    if (ac) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">修正 ${ac}</button>`);
  }
  if (rec && (rec.note || (rec.hl && rec.hl.length) || nInk(rec) || (rec.st && rec.st.length))) {
    out.push(`<button class="chip c-note" data-open="${aid}" data-tab="notes">註記</button>`);
  }
  return out.join('');
}

function xlawHTML(aid) {
  const items = D.xlaw[aid];
  if (!items || !items.length) return '';
  const open = xlawOpen.has(aid) || items.length <= 2;
  const shown = open ? items : items.slice(0, 2);
  const row = (it) => `<div class="xlaw-item"><b>${esc(it.law)}第${esc(it.a.replace('-', '條之'))}${it.a.includes('-') ? '' : '條'}</b><span>${esc(it.p.join(''))}</span></div>`;
  return `<div class="xlaw-box">${shown.map(row).join('')}${open ? '' : `<button class="xlaw-more" data-xmore="${aid}">顯示其餘 ${items.length - 2} 條相關法條 ▾</button>`}</div>`;
}

function impList(aid) {
  const rec = notes.get(aid);
  if (!rec) return [];
  const out = [];
  const imp = rec.imp || {};
  for (const r of (R && R[aid]) || []) if (imp[r.ty + ':' + r.no]) out.push({ ty: r.ty, no: r.no, t: (rec.rnote && rec.rnote[r.ty + ':' + r.no]) || ((r.parts || [])[0] || [])[1] || '' });
  for (const it of rec.items || []) out.push({ ty: 'U', no: it.no, kind: it.kind, t: (rec.rnote && rec.rnote['U:' + it.id]) || it.text || '' });
  return out;
}
function impHTML(aid) {
  const list = impList(aid);
  if (!list.length) return '';
  return `<div class="imp-box">${list.map((r) => `<button class="imp-item" data-open="${aid}" data-tab="rulings"><b>${esc(r.ty === 'U' ? r.kind || '判決' : TYPE_LABEL[r.ty])}</b>${esc(r.no.replace(/^廢/, ''))}${r.t ? `：${esc(r.t.length > 80 ? r.t.slice(0, 80) + '…' : r.t)}` : ''}</button>`).join('')}</div>`;
}

function articleInner(a) {
  const rec = notes.get(a.id);
  const off = hiddenArts.has(a.id) && hasAnno(rec);
  let html = `<div class="art-head"><button class="ano" data-open="${a.id}">${aidLabel(a.id)}</button>`;
  if (off) html += `<button class="anno-flag" data-unhide="${a.id}" title="點一下顯示本條註記">註記已隱藏</button>`;
  html += `<span class="chips">${chipsHTML(a.id)}</span></div>`;
  if (settings.gist && a.g) html += `<div class="gist">（${esc(a.g)}）</div>`;
  const noteBtn = (pos) => (rec && rec.note && (rec.notePos || 'dn') === pos ? `<button class="art-note ${pos}" data-open="${a.id}" data-tab="notes">${esc(rec.note)}</button>` : '');
  html += noteBtn('up');
  html += `<div class="atext">${renderParas(a, rec, 'law')}</div>`;
  html += noteBtn('dn');
  html += xlawHTML(a.id);
  html += impHTML(a.id);
  return html;
}

function renderReader() {
  const parts = [];
  const hlevelClass = ['h-part', 'h-chap', 'h-sec', 'h-sub', 'h-sub'];
  const firstOf = new Map();
  D.headings.forEach((h, i) => {
    if (h.first) { if (!firstOf.has(h.first)) firstOf.set(h.first, []); firstOf.get(h.first).push(i); }
  });
  for (const a of D.articles) {
    for (const hi of firstOf.get(a.id) || []) {
      const h = D.headings[hi];
      const tag = h.lv === 0 ? 'h2' : h.lv === 1 ? 'h3' : 'h4';
      const pc = h.lv === 0 ? ` style="--pc:var(--p${partOrder.get(hi) ?? 0})"` : '';
      parts.push(`<${tag} class="${hlevelClass[h.lv]}" id="h-${hi}"${pc}>${esc(h.t)}</${tag}>`);
    }
    const off = hiddenArts.has(a.id) && hasAnno(notes.get(a.id));
    parts.push(`<article class="art${a.del ? ' deleted' : ''}${off ? ' anno-off' : ''}" id="a-${a.id}" data-id="${a.id}" style="--pc:${pcVar(a)}">${articleInner(a)}</article>`);
  }
  const inner = $('#reader-inner');
  inner.innerHTML = parts.join('');
  inner.classList.toggle('no-pn', !settings.pn);
  inner.classList.toggle('fluid', settings.measure === 'fluid');
  for (const el of $$('.art', inner)) { ink.observe(el); fitIO.observe(el); }
  notes.forEach((r, aid) => { if (r.st && r.st.length) stickies.render(aid); });
}

function refreshArticle(aid) {
  const el = document.getElementById('a-' + aid);
  if (el) {
    el.innerHTML = articleInner(byId.get(aid));
    el.classList.toggle('anno-off', hiddenArts.has(aid) && hasAnno(notes.get(aid)));
    ink.refresh(aid);
    stickies.render(aid);
    requestAnimationFrame(() => fitNotes(el));
  }
  if (current === aid) renderDetailText();
}
function refreshChips(aid) {
  const el = document.querySelector(`#a-${CSS.escape(aid)} .chips`);
  if (el) el.innerHTML = chipsHTML(aid);
}

// 行間紅字註記：避免超出條文右緣；過長者換行（最多兩行）
function fitNotes(scope) {
  const list = scope.querySelectorAll ? scope.querySelectorAll('.anote') : [];
  for (const n of list) {
    const at = n.closest('.atext, .d-text');
    if (!at) continue;
    const ar = at.getBoundingClientRect();
    if (!ar.width) continue;
    n.classList.remove('wrap');
    n.style.left = '0px';
    n.style.width = '';
    const anc = n.parentElement.getBoundingClientRect();
    const w = n.offsetWidth;
    const left0 = anc.left - ar.left;
    if (w <= ar.width) n.style.left = Math.min(0, ar.width - (left0 + w)) + 'px';
    else { n.classList.add('wrap'); n.style.width = ar.width + 'px'; n.style.left = (-left0) + 'px'; }
  }
}
const fitIO = new IntersectionObserver((ents) => {
  for (const e of ents) if (e.isIntersecting && e.target.querySelector('.anote')) fitNotes(e.target);
});
const refitAll = debounce(() => {
  const reader = $('#reader').getBoundingClientRect();
  for (const el of $$('#reader-inner .art')) {
    const r = el.getBoundingClientRect();
    if (r.bottom > reader.top - 200 && r.top < reader.bottom + 200 && el.querySelector('.anote')) fitNotes(el);
  }
  if (current) fitNotes($('#d-text'));
}, 120);

// ---------------------------------------------------------------------------
// 顯示／隱藏我的註記
// ---------------------------------------------------------------------------
function applyVisibility() {
  const b = document.body;
  const on = (k) => settings.master && settings.show[k];
  b.classList.toggle('anno-hidden', !settings.master);
  b.classList.toggle('hide-ink', !on('ink'));
  b.classList.toggle('hide-notes', !on('notes'));
  b.classList.toggle('hide-hl', !on('hl'));
  b.classList.toggle('hide-st', !on('st'));
  b.classList.toggle('hide-imp', !on('imp'));
  b.classList.toggle('hide-xlaw', !settings.show.xlaw);
  $('#btn-eye').setAttribute('aria-pressed', 'false');
  $('#btn-eye').title = settings.master ? '隱藏我的註記（長按可細部設定）' : '顯示我的註記（長按可細部設定）';
}
function toggleMaster() {
  settings.master = !settings.master;
  applyVisibility();
  saveSettings();
  toast(settings.master ? '已顯示我的註記' : '已隱藏我的註記（手寫、紅字註記、螢光、便利貼）');
  if (!$('#eye-pop').hidden) renderEyePop();
}
function toggleArtAnno(aid) {
  const rec = notes.get(aid);
  if (!hasAnno(rec)) return false;
  if (hiddenArts.has(aid)) hiddenArts.delete(aid); else hiddenArts.add(aid);
  saveSettings();
  refreshArticle(aid);
  const hid = hiddenArts.has(aid);
  if (!toggleArtAnno._told) { toast(hid ? `已隱藏${aidLabel(aid)}的註記，再點一下即顯示` : `已顯示${aidLabel(aid)}的註記`); toggleArtAnno._told = true; }
  return true;
}
function renderEyePop() {
  const pop = $('#eye-pop');
  const sw = (k, label, sub) => `<div class="set-row"><span class="l">${label}${sub ? `<small>${sub}</small>` : ''}</span><button class="switch" role="switch" data-show="${k}" aria-checked="${k === 'master' ? settings.master : settings.show[k]}" aria-label="${label}"></button></div>`;
  pop.innerHTML = `<h5>我的註記</h5>
    ${sw('master', '顯示我的註記', '總開關')}
    ${sw('ink', '手寫（Apple Pencil）')}
    ${sw('notes', '紅字註記', '行間小字及本條筆記')}
    ${sw('hl', '螢光筆劃線')}
    ${sw('st', '便利貼')}
    ${sw('imp', '重要判解小字')}
    <h5 style="margin-top:8px">其他</h5>
    ${sw('xlaw', '他法相關條文小字')}
    <div class="set-row"><span class="l">手指點條文切換<small>點條文空白處，顯示／隱藏該條註記</small></span>
      <span class="segs">${[['one', '單擊'], ['two', '雙擊'], ['off', '關']].map(([v, l]) => `<button data-tap="${v}" aria-pressed="${settings.tap === v}">${l}</button>`).join('')}</span></div>
    ${hiddenArts.size ? `<div class="row-actions" style="margin-top:6px"><button class="btn small" data-act="unhide-all">恢復顯示逐條隱藏的 ${hiddenArts.size} 條</button></div>` : ''}`;
}
function openEyePop() {
  const pop = $('#eye-pop');
  renderEyePop();
  pop.hidden = false;
  const r = $('#btn-eye').getBoundingClientRect();
  pop.style.top = (r.bottom + 8) + 'px';
  pop.style.left = Math.max(8, Math.min(innerWidth - pop.offsetWidth - 8, r.right - pop.offsetWidth)) + 'px';
}

// ---------------------------------------------------------------------------
// 目錄
// ---------------------------------------------------------------------------
function lastArticleOf(hi) {
  const h = D.headings[hi];
  let next = null;
  for (let j = hi + 1; j < D.headings.length; j++) if (D.headings[j].lv <= h.lv) { next = D.headings[j]; break; }
  if (!next) return order[order.length - 1];
  return order[orderIdx.get(next.first) - 1];
}
function renderTOC() {
  const kids = new Map();
  D.headings.forEach((h, i) => { if (!kids.has(h.p)) kids.set(h.p, []); kids.get(h.p).push(i); });
  const build = (pi) => (kids.get(pi) || []).map((i) => {
    const h = D.headings[i];
    const sub = kids.get(i);
    const fmt = (x) => x.replace('-', '之');
    const rng = h.first ? `${fmt(h.first)}–${fmt(lastArticleOf(i))}` : '';
    const pc = h.lv === 0 ? ` style="--pc:var(--p${partOrder.get(i) ?? 0})"` : '';
    return `<div class="toc-part"><button class="toc-btn lv${h.lv}" data-h="${i}"${pc}>${sub ? `<span class="caret" data-toggle="${i}">›</span>` : '<span class="caret"></span>'}${h.lv === 0 ? '<span class="pdot"></span>' : ''}<span>${esc(h.t)}</span><span class="rng">${rng}</span></button>${sub ? `<div class="toc-kids" id="tk-${i}" hidden>${build(i)}</div>` : ''}</div>`;
  }).join('');
  $('#side-toc').innerHTML = build(-1) + `<p class="side-note">資料來源：全國法規資料庫（現行條文，修正日期 ${roc(D.meta.modified)}）、立法院法律系統（沿革與立法理由）。</p>`;
}
function tocExpandTo(hi) {
  let x = hi;
  while (x >= 0) {
    const k = document.getElementById('tk-' + x);
    if (k) { k.hidden = false; const c = $(`[data-toggle="${x}"]`); if (c) c.classList.add('open'); }
    x = D.headings[x].p;
  }
}
const trackTOC = debounce(() => {
  const top = $('#reader').getBoundingClientRect().top + 80;
  let cur = -1;
  for (const el of $$('#reader-inner > h2, #reader-inner > h3, #reader-inner > h4')) {
    if (el.getBoundingClientRect().top < top) cur = +el.id.slice(2); else break;
  }
  $$('.toc-btn.cur').forEach((b) => b.classList.remove('cur'));
  if (cur >= 0) { const b = $(`.toc-btn[data-h="${cur}"]`); if (b) b.classList.add('cur'); }
}, 160);

// ---------------------------------------------------------------------------
// 導覽
// ---------------------------------------------------------------------------
function isNarrow() { return matchMedia('(max-width: 1100px)').matches; }
function sideIsDrawer() { return isNarrow() || document.body.classList.contains('side-collapsed'); }
function setSide(open) {
  if (!sideIsDrawer()) return;
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}
function scrollToEl(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })));
  setTimeout(() => el.scrollIntoView({ block: 'start' }), 180);
}
function gotoArticle(aid, { open = true, flash = true, from = null } = {}) {
  if (!byId.has(aid)) { toast(`找不到${aidLabel(aid)}`); return; }
  if (from && from !== aid) {
    backStack.push({ aid: from, top: $('#reader').scrollTop });
    if (backStack.length > 30) backStack.shift();
    updateBackChip();
  }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  tocExpandTo(byId.get(aid).h);
  setSide(false);
  if (open) openDetail(aid);
}
function updateBackChip() {
  const c = $('#backchip');
  const last = backStack[backStack.length - 1];
  c.hidden = !last;
  if (last) c.textContent = `← 返回${aidLabel(last.aid)}`;
}
function goBack() {
  const last = backStack.pop();
  updateBackChip();
  if (!last) return;
  const reader = $('#reader');
  reader.scrollTop = last.top;
  requestAnimationFrame(() => { reader.scrollTop = last.top; });
  const el = document.getElementById('a-' + last.aid);
  if (el) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  if (current) openDetail(last.aid);
}
function gotoHeading(hi) {
  scrollToEl(document.getElementById('h-' + hi));
  setSide(false);
}

// ---------------------------------------------------------------------------
// 他法條文彈出視窗
// ---------------------------------------------------------------------------
function showRefPop(anchor, key) {
  const [law, a] = key.split('|');
  const aid = anchor.closest('[data-id]')?.dataset.id;
  const it = (D.xlaw[aid] || []).find((x) => x.law === law && x.a === a);
  if (!it) return;
  const pop = $('#ref-pop');
  const no = a.includes('-') ? `第${a.replace('-', '條之')}` : `第${a}條`;
  pop.innerHTML = `<h5>${esc(law)}${no}<a href="https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=${esc(it.pc)}&flno=${esc(a)}" target="_blank" rel="noopener">全國法規資料庫 ↗</a></h5>${it.p.map((t) => `<p>${esc(t)}</p>`).join('')}`;
  pop.hidden = false;
  placePop(pop, anchor.getBoundingClientRect());
}
function placePop(pop, rect) {
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.bottom + 10;
  if (y + ph > innerHeight - 70) y = rect.top - ph - 10;
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, x)) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
}

// ---------------------------------------------------------------------------
// 詳細面板
// ---------------------------------------------------------------------------
function openDetail(aid, tab) {
  if (current && current !== aid) document.getElementById('a-' + current)?.classList.remove('sel');
  current = aid;
  if (tab) detailTab = tab;
  cmpSel = null;
  document.getElementById('a-' + aid)?.classList.add('sel');
  $('#detail').hidden = false;
  layoutDetail();
  try { history.replaceState(null, '', '#a-' + aid); } catch {}
  if ((detailTab === 'history' || detailTab === 'reasons') && !H) loadHist();
  renderDetail();
}
function closeDetail() {
  if (current) document.getElementById('a-' + current)?.classList.remove('sel');
  current = null;
  $('#detail').hidden = true;
  layoutDetail();
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
}
// 寬螢幕：若條文欄（固定寬度）旁還放得下詳細面板，就停靠在右側，不遮住條文、也不改變條文寬度
function layoutDetail() {
  const b = document.body;
  const was = b.classList.contains('side-collapsed');
  b.classList.remove('detail-docked', 'side-collapsed');
  document.documentElement.style.removeProperty('--detail-w');
  if (current && settings.measure === 'fixed' && innerWidth >= 900) {
    const colOuter = 36 * settings.size + 44;
    const sideW = isNarrow() ? 0 : $('#sidebar').offsetWidth;
    const dock = (w) => { b.classList.add('detail-docked'); document.documentElement.style.setProperty('--detail-w', Math.round(w) + 'px'); };
    let room = innerWidth - sideW - colOuter;
    if (room >= 380) dock(Math.min(520, room));
    else if ((room = innerWidth - colOuter) >= 360) { if (!isNarrow()) b.classList.add('side-collapsed'); dock(Math.min(520, room)); }
  }
  if (was !== b.classList.contains('side-collapsed')) { $('#sidebar').classList.remove('open'); $('#scrim').hidden = true; }
}
function renderDetailText() {
  const a = byId.get(current);
  const rec = notes.get(current);
  const el = $('#d-text');
  el.dataset.id = current;
  const note = rec && rec.note ? `<button class="art-note" data-tab="notes" data-open="${current}" style="margin-left:0;width:100%">${esc(rec.note)}</button>` : '';
  el.innerHTML = `<div class="atext${settings.pn ? '' : ' no-pn'}">${renderParas(a, rec)}</div>${note}`;
  el.classList.toggle('anno-off', hiddenArts.has(current));
  requestAnimationFrame(() => fitNotes(el));
}
function renderDetail() {
  if (!current) return;
  const a = byId.get(current);
  const rec = notes.get(current);
  $('#d-no').innerHTML = `<span class="ano" style="--pc:${pcVar(a)}">${aidLabel(current)}</span>${a.g ? `<span class="gist">（${esc(a.g)}）</span>` : ''}`;
  $('#d-path').textContent = headingPath(a.h).join(' › ');
  $('#d-star').setAttribute('aria-pressed', rec && rec.star ? 'true' : 'false');
  renderDetailText();
  const rc = rulingCount(current), ac = amendCount(current), rn = reasonCount(current);
  $('#t-rulings').textContent = rc || '';
  $('#t-history').textContent = ac || '';
  $('#t-reasons').textContent = rn || '';
  const nc = rec ? ((rec.note ? 1 : 0) + (rec.hl ? rec.hl.length : 0) + (nInk(rec) ? 1 : 0) + (rec.st ? rec.st.length : 0)) : 0;
  $('#t-notes').textContent = nc || '';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === detailTab ? 'true' : 'false'));
  const body = $('#d-body');
  if (detailTab === 'rulings') renderRulings(body);
  else if (detailTab === 'history') renderHistory(body);
  else if (detailTab === 'reasons') renderReasons(body);
  else renderNotes(body);
  body.scrollTop = 0;
}

// ----- 判解・函釋 -----
function rulingList(aid) {
  const rec = notes.get(aid) || {};
  const imp = rec.imp || {};
  const list = (R && R[aid] ? R[aid] : []).map((r, i) => ({ ...r, key: r.ty + ':' + r.no, idx: i }));
  for (const it of rec.items || []) list.push({ ...it, ty: 'U', key: 'U:' + it.id, user: true });
  for (const r of list) r.imp = !!imp[r.key];
  return list;
}
function renderRulings(body) {
  const all = rulingList(current);
  const cnt = (f) => all.filter(f).length;
  const filters = [
    ['all', '全部', all.length],
    ['imp', '★ 重要', cnt((r) => r.imp)],
    ['CJ', '憲法法庭', cnt((r) => r.ty === 'CJ')],
    ['C', '大法官解釋', cnt((r) => r.ty === 'C')],
    ['J', '判例', cnt((r) => r.ty === 'J')],
    ['U', '我的判決・函釋', cnt((r) => r.ty === 'U')],
  ].filter(([k, , n]) => k === 'all' || k === 'U' || n);
  if (!filters.some(([k]) => k === rulFilter)) rulFilter = 'all';
  const list = all.filter((r) => rulFilter === 'all' || (rulFilter === 'imp' ? r.imp : r.ty === rulFilter));
  const tyOrder = { U: 0, CJ: 1, C: 2, J: 3 };
  list.sort((a, b) => (b.imp - a.imp) || ((a.no || '').startsWith('廢') - (b.no || '').startsWith('廢')) || (tyOrder[a.ty] - tyOrder[b.ty]) || ((a.idx ?? 0) - (b.idx ?? 0)));
  const rec = notes.get(current) || {};
  let html = `<div class="filters">${filters.map(([k, l, n]) => `<button class="fchip" data-rf="${k}" aria-pressed="${rulFilter === k}">${l}<i>${n}</i></button>`).join('')}</div>`;
  html += `<div class="row-actions" style="margin-bottom:12px"><button class="btn small primary" data-act="add-item">＋ 新增判決／函釋</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/default.aspx" target="_blank" rel="noopener">司法院裁判書查詢</a>
    <a class="btn small" href="https://mojlaw.moj.gov.tw/" target="_blank" rel="noopener">法務部函釋查詢</a></div>`;
  html += `<p class="callout">標記 ★ 的判解與自建的判決、函釋，會以小字顯示在條文下方（可在眼睛圖示中隱藏）。</p>`;
  if (!R && !(rec.items && rec.items.length)) html += `<p class="empty">判解資料載入中…</p>`;
  else if (!list.length) html += `<p class="empty">${rulFilter === 'U' ? '尚無自建資料。可新增最高法院判決、大法庭裁定、司法院函釋、民事庭會議決議等，並寫下要旨。' : rulFilter === 'imp' ? '尚未標記重要判解。點判解卡右上角的星號即可標記。' : '本條在全國法規資料庫中沒有相關的解釋或判例。可自行新增實務判決或函釋。'}</p>`;
  if (all.some((r) => r.ty === 'J')) html += `<p class="callout">判例制度已於民國108年7月4日廢止。依法院組織法第57條之1，未經停止適用之判例，其效力與未經選編為判例之最高法院裁判相同。字號前標「廢」者為已不再援用。</p>`;
  for (const r of list) html += rulingCard(r, rec);
  body.innerHTML = html;
}
function rulingCard(r, rec) {
  const isVoid = (r.no || '').startsWith('廢');
  const typeLabel = r.ty === 'U' ? (r.kind || '其他') : TYPE_LABEL[r.ty];
  const parts = r.user ? (r.text ? [['要旨', r.text]] : []) : (r.parts || []);
  const rnote = rec.rnote && rec.rnote[r.key];
  const partsHTML = parts.map(([lbl, txt]) => `<div class="rpart${txt.length > 220 ? ' clamp' : ''}"><span class="lbl">${esc(lbl)}</span>${renderRich(txt, [], 'ruling')}</div>`).join('');
  return `<article class="rcard${r.imp ? ' imp' : ''}${isVoid ? ' void' : ''}" data-key="${esc(r.key)}">
    <div class="rhead"><span class="tpill tp-${r.ty}">${esc(typeLabel)}</span>${isVoid ? '<span class="tpill tp-void">不再援用</span>' : ''}
      <span class="rno">${esc(isVoid ? r.no.slice(1) : r.no)}</span><span class="rdate">${esc(r.date || '')}</span>
      <button class="rstar" data-act="imp" aria-pressed="${r.imp}" aria-label="標記重要"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"/></svg></button></div>
    ${partsHTML}
    ${rnote ? `<div class="rnote">${esc(rnote)}</div>` : ''}
    <div class="rfoot">
      ${parts.some(([, t]) => t.length > 220) ? '<button class="linkish" data-act="expand">展開全文</button>' : ''}
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">原文</a>` : ''}
      ${r.user ? '<button class="linkish" data-act="edit-item">編輯</button>' : ''}
      <button class="linkish" data-act="rnote">${rnote ? '編輯筆記' : '加筆記'}</button>
    </div></article>`;
}

// ----- 新舊對照 -----
let histLoading = null;
function loadHist() {
  if (H || histLoading) return histLoading;
  histLoading = fetch('data/hist.json').then((r) => (r.ok ? r.json() : null)).then((data) => {
    if (!data) return;
    H = data;
    if (current && (detailTab === 'history' || detailTab === 'reasons')) renderDetail();
    else if (current) renderDetail();
  }).catch(() => { histLoading = null; });
  return histLoading;
}
function histItemFor(pub) {
  return pub ? D.histories.find((h) => (h.dates || []).includes(pub)) : null;
}
function dateInfo(d) { return (H && H.dates[d]) || {}; }
function verLabel(v, short) {
  const di = dateInfo(v.d);
  return short ? `${roc(v.d, true)} ${v.k}${v.old ? '（舊法）' : ''}` : `${roc(v.d)} ${v.k}`;
}
function renderHistory(body) {
  if (!H) { body.innerHTML = '<p class="empty">載入沿革資料中…</p>'; loadHist(); return; }
  const all = versionsOf(current);
  const vs = all.filter((v) => !v.old);
  const olds = all.filter((v) => v.old);
  const a = byId.get(current);
  if (!all.length) { body.innerHTML = '<p class="empty">查無本條沿革資料。</p>'; return; }
  let html = '';
  if (vs.length < 2) {
    html += `<p class="empty">${aidLabel(current)}自${vs[0] ? roc(vs[0].d) + vs[0].k : '制定'}以來，未曾修正。</p>`;
  }
  html += '<ol class="timeline">';
  for (const v of [...vs].reverse()) {
    const di = dateInfo(v.d);
    const prev = vs[vs.indexOf(v) - 1];
    html += `<li class="tl k-${v.k}"><span class="dot"></span><div><b>${roc(v.d)}</b><small>${v.k}（三讀）${di.pub ? `・${roc(di.pub, true)} 公布` : ''}${di.eff ? `・${roc(di.eff, true)} 施行` : ''}${v.r ? '・有理由' : ''}</small></div>
      ${prev ? `<button class="linkish kind" data-cmp="${v.i}" data-cmp-a="${prev.i}">與前版比較</button>` : `<span class="kind">${v.k === '增訂' ? '增訂條文' : '最早條文'}</span>`}</li>`;
  }
  html += '</ol>';
  if (olds.length) {
    html += `<details class="callout"><summary>民國19／20年舊民事訴訟法同條號條文（${olds.length}）</summary><p style="margin:.5em 0 0">舊法條次與民國24年施行之新法不同，同一條號內容多不相同，僅供參考；可於下方比較選單選取。</p></details>`;
  }
  if (all.length >= 2) {
    if (!cmpSel || cmpSel.aid !== current) {
      cmpSel = vs.length >= 2 ? { aid: current, a: vs[vs.length - 2].i, b: vs[vs.length - 1].i } : { aid: current, a: all[0].i, b: all[all.length - 1].i };
    }
    const opt = (sel) => all.map((v) => `<option value="${v.i}"${v.i === sel ? ' selected' : ''}>${verLabel(v, true)}</option>`).join('');
    html += `<div class="cmp-ctl"><label for="cmp-b">新</label><select id="cmp-b">${opt(cmpSel.b)}</select>
      <label for="cmp-a">舊</label><select id="cmp-a">${opt(cmpSel.a)}</select>
      <span class="segs" role="group" aria-label="顯示方式"><button type="button" data-cm="table" aria-pressed="${cmpMode === 'table'}">對照表</button><button type="button" data-cm="inline" aria-pressed="${cmpMode === 'inline'}">標示差異</button></span></div>`;
    const A = all[cmpSel.a], B = all[cmpSel.b];
    const dd = diffParas(A.p, B.p);
    const newer = cmpSel.b > cmpSel.a ? B : A;
    if (cmpMode === 'table') {
      html += `<div class="cmp-wrap"><table class="cmp"><thead><tr><th>${cmpSel.b > cmpSel.a ? '修正條文' : '條文'}（${roc(B.d, true)}）</th><th>${cmpSel.b > cmpSel.a ? '修正前條文' : '條文'}（${roc(A.d, true)}）</th></tr></thead>
        <tbody><tr><td>${dd.new}</td><td>${dd.old}</td></tr>
        ${newer.r ? `<tr class="reason"><td colspan="2"><b>說明（${roc(newer.d, true)} ${newer.k}理由）</b><br>${newer.r.map(esc).join('<br>')}</td></tr>` : ''}</tbody></table></div>`;
    } else {
      html += `<div class="inline-diff">${dd.inline}</div>`;
      if (newer.r) html += `<div class="hist-item"><b>${roc(newer.d, true)} ${newer.k}理由</b><br>${newer.r.map(esc).join('<br>')}</div>`;
    }
    html += `<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>`;
    const it = histItemFor(dateInfo(newer.d).pub);
    if (it) html += `<div class="hist-item"><b>法規沿革第 ${it.n} 點</b><br>${esc(it.t)}</div>`;
  }
  html += `<p class="callout" style="margin-top:12px">歷次條文與理由取自立法院法律系統「法條沿革」；日期為立法院三讀通過日，並附總統公布日。現行條文以全國法規資料庫為準。<a href="https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=B0010001" target="_blank" rel="noopener">全國法規資料庫沿革 ↗</a></p>`;
  body.innerHTML = html;
}

// ----- 立法理由 -----
function renderReasons(body) {
  if (!H) { body.innerHTML = '<p class="empty">載入立法理由中…</p>'; loadHist(); return; }
  const all = versionsOf(current).filter((v) => !v.old);
  if (!all.length) { body.innerHTML = '<p class="empty">查無本條資料。</p>'; return; }
  let html = '';
  const withR = all.filter((v) => v.r);
  if (!withR.length) html += `<p class="empty">立法院法律系統未收錄本條歷次條文之理由（民國24年制定及57年全文修正時多未逐條附理由）。</p>`;
  for (const v of [...all].reverse()) {
    const di = dateInfo(v.d);
    if (!v.r) continue;
    html += `<section class="reason-card"><h4>${roc(v.d)} ${esc(v.k)}<small>${di.pub ? roc(di.pub, true) + ' 公布' : ''}${di.eff ? '・' + roc(di.eff, true) + ' 施行' : ''}</small></h4>
      ${v.r.map((t) => `<p>${esc(t)}</p>`).join('')}
      <details><summary>該次條文</summary><div class="vtext">${v.p.map((t) => `<p>${esc(t)}</p>`).join('')}</div></details></section>`;
  }
  const noR = all.filter((v) => !v.r);
  if (noR.length && withR.length) html += `<p class="callout">未附理由之版本：${noR.map((v) => `${roc(v.d, true)} ${v.k}`).join('、')}</p>`;
  html += `<p class="callout">資料來源：立法院法律系統（lis.ly.gov.tw）法條沿革。</p>`;
  body.innerHTML = html;
}

// ----- 我的註記 -----
function allTags() {
  const s = new Set();
  notes.forEach((r) => (r.tags || []).forEach((t) => s.add(t)));
  return [...s].sort();
}
function renderNotes(body) {
  const rec = notes.get(current) || {};
  const hls = rec.hl || [];
  const sts = rec.st || [];
  const strokes = nInk(rec);
  const a = byId.get(current);
  const qText = (h) => { const sp = splitPara(a.p[h.p] || ''); return sp.body.slice(h.s, h.e); };
  const pos = rec.notePos || 'dn';
  let html = `<div class="field"><label for="note-text">本條筆記（以紅色小字顯示於條文${pos === 'up' ? '上方' : '下方'}）
      <span class="segs" style="margin-left:auto"><button type="button" data-npos="up" aria-pressed="${pos === 'up'}">上方</button><button type="button" data-npos="dn" aria-pressed="${pos === 'dn'}">下方</button></span></label>
    <textarea class="note" id="note-text" placeholder="寫下要件、學說爭議、考點、案例…">${esc(rec.note || '')}</textarea>
    <span class="saved" id="note-saved">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div>`;
  html += `<div class="field"><label for="tag-input">標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" id="tag-input" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點、實務見解" enterkeyhint="done">
    <datalist id="tag-list">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>`;
  html += `<div class="field"><span class="lbl">劃線與行間註記（${hls.length}）</span>`;
  html += hls.length ? `<ul class="hl-list">${hls.map((h) => `<li><div><span class="q"><mark class="hl hl-${h.c}">${esc(qText(h))}</mark></span>${h.n ? `<span class="n">${h.pos === 'dn' ? '↓' : '↑'} ${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions"><button class="linkish" data-act="hl-note" data-id="${h.id}">${h.n ? '改註' : '加註'}</button><button class="linkish" data-act="hl-del" data-id="${h.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">在條文上長按選取文字，即可劃線，或以「上註」「下註」在文字上方或下方加紅色小字註記。</p>';
  html += '</div>';
  html += `<div class="field"><span class="lbl">便利貼（${sts.length}）</span>`;
  html += sts.length ? `<ul class="hl-list">${sts.map((s) => `<li><div><span class="q">${esc(s.t || '（空白）')}</span></div>
      <div class="row-actions"><button class="linkish" data-act="st-go" data-id="${s.id}">定位</button><button class="linkish" data-act="st-del" data-id="${s.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>` : '';
  html += `<div class="row-actions"><button class="btn small" data-act="st-add">＋ 在本條貼便利貼</button></div></div>`;
  html += `<div class="field"><span class="lbl">手寫（${strokes} 筆）</span>
    <div class="row-actions"><button class="btn small" data-act="ink-on">在條文上手寫</button>${strokes ? '<button class="btn small danger" data-act="ink-clear">清除本條手寫</button>' : ''}</div>
    ${ink.layoutShifted(current) ? '<p class="ink-warn">版面寬度與書寫時不同，手寫位置可能略有偏移（設定 → 版面寬度「固定」可避免）。</p>' : ''}</div>`;
  if (hasAnno(rec)) html += `<div class="field"><span class="lbl">本條註記</span><div class="row-actions"><button class="btn small" data-act="toggle-art">${hiddenArts.has(current) ? '顯示本條註記' : '隱藏本條註記'}</button></div></div>`;
  body.innerHTML = html;
  const ta = $('#note-text');
  const save = debounce(() => {
    const r = getRec(current, true);
    r.note = ta.value;
    saveRec(current).then(() => { $('#note-saved') && ($('#note-saved').textContent = '已儲存'); });
    refreshArticle(current);
  }, 500);
  ta.addEventListener('input', () => { $('#note-saved').textContent = '儲存中…'; save(); });
  const ti = $('#tag-input');
  ti.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = ti.value.trim().replace(/^#/, '');
      if (!v) return;
      const r = getRec(current, true);
      r.tags = Array.from(new Set([...(r.tags || []), ...v.split(/[,，、\s]+/).filter(Boolean)]));
      saveRec(current);
      renderNotes(body);
      $('#tag-input').focus();
    }
  });
}

// ---------------------------------------------------------------------------
// 劃線與行間註記
// ---------------------------------------------------------------------------
let pendingSel = null; // {aid, parts:[{p,s,e}], rect, host}
let activeHl = null;   // {aid, id}

// 計算選取位置在段落中的字元位移（略過行間註記文字）
function plainOffset(pt, node, off) {
  const w = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT);
  let n = 0, t;
  const inNote = (x) => x.parentElement && x.parentElement.closest('.anc');
  if (node.nodeType !== 3) {
    // 元素節點：轉為其第 off 個子節點之前
    const r = document.createRange();
    r.setStart(pt, 0);
    try { r.setEnd(node, off); } catch { return null; }
    while ((t = w.nextNode())) {
      if (!r.intersectsNode(t)) break;
      const rr = document.createRange(); rr.selectNodeContents(t);
      if (r.compareBoundaryPoints(Range.END_TO_END, rr) < 0) break;
      if (!inNote(t)) n += t.length;
    }
    return n;
  }
  while ((t = w.nextNode())) {
    if (t === node) return n + (inNote(t) ? 0 : off);
    if (!inNote(t)) n += t.length;
  }
  return null;
}
function plainLen(pt) {
  const w = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT);
  let n = 0, t;
  while ((t = w.nextNode())) if (!(t.parentElement && t.parentElement.closest('.anc'))) n += t.length;
  return n;
}
function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const host = (range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement)?.closest('[data-id]');
  if (!host || !(host.classList.contains('art') || host.id === 'd-text')) return null;
  const aid = host.dataset.id;
  const parts = [];
  for (const pt of $$('.pt', host)) {
    if (!range.intersectsNode(pt)) continue;
    const len = plainLen(pt);
    let s = 0, e = len;
    if (pt.contains(range.startContainer)) s = plainOffset(pt, range.startContainer, range.startOffset) ?? 0;
    if (pt.contains(range.endContainer)) e = plainOffset(pt, range.endContainer, range.endOffset) ?? len;
    if (e > s) parts.push({ p: +pt.dataset.p, s, e });
  }
  if (!parts.length) return null;
  return { aid, parts, rect: range.getBoundingClientRect(), inReader: host.classList.contains('art') };
}
function showPop(rect, forExisting, noteText) {
  const pop = $('#hl-pop');
  pop.hidden = false;
  $('[data-hl="del"]', pop).hidden = !forExisting;
  const pn = $('#pop-note');
  pn.hidden = !noteText;
  pn.textContent = noteText || '';
  placePop(pop, rect);
}
function hidePop() { $('#hl-pop').hidden = true; pendingSel = null; activeHl = null; }

const onSelChange = debounce(() => {
  if (ink.active) return;
  const c = captureSelection();
  if (c) { pendingSel = c; activeHl = null; showPop(c.rect, false, ''); }
  else if (!activeHl && !$('#hl-pop').matches(':hover')) $('#hl-pop').hidden = true;
}, 280);

function stickyAtRect(aid, rect) {
  const host = document.querySelector(`#a-${CSS.escape(aid)} .atext`);
  if (!host) return;
  const hr = host.getBoundingClientRect();
  const em = parseFloat(getComputedStyle(host).fontSize) || 18;
  const x = rect ? Math.max(0, Math.min(hr.width / em - 9, (rect.left - hr.left) / em)) : 0;
  const y = rect ? (rect.bottom - hr.top) / em + 0.15 : 0;
  stickies.create(aid, x, y);
}

function applyHighlight(action) {
  if (activeHl) {
    const { aid, id } = activeHl;
    const r = getRec(aid, true);
    const h = (r.hl || []).find((x) => x.id === id);
    if (!h) return hidePop();
    if (action === 'del') r.hl = r.hl.filter((x) => x.id !== h.id);
    else if (action === 'up' || action === 'dn') { hidePop(); return editHlNote(aid, id, action); }
    else if (action === 'st') {
      const rect = document.querySelector(`#a-${CSS.escape(aid)} [data-hl="${id}"]`)?.getBoundingClientRect();
      hidePop(); return stickyAtRect(aid, rect);
    } else h.c = action;
    saveRec(aid); refreshArticle(aid); refreshChips(aid);
    if (current === aid && detailTab === 'notes') renderDetail();
    return hidePop();
  }
  if (!pendingSel) return;
  const { aid, parts, rect, inReader } = pendingSel;
  if (action === 'st') {
    window.getSelection()?.removeAllRanges();
    hidePop();
    if (!inReader) gotoArticle(aid, { open: false, flash: false });
    return stickyAtRect(aid, inReader ? rect : null);
  }
  const r = getRec(aid, true);
  r.hl = r.hl || [];
  const ids = [];
  for (const pt of parts) {
    const h = { id: uid(), p: pt.p, s: pt.s, e: pt.e, c: (action === 'up' || action === 'dn') ? 'n' : action };
    r.hl.push(h);
    ids.push(h.id);
  }
  window.getSelection()?.removeAllRanges();
  saveRec(aid); refreshArticle(aid); refreshChips(aid);
  if (current === aid) renderDetail();
  hidePop();
  if (action === 'up' || action === 'dn') editHlNote(aid, ids[0], action, true);
}

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------
function modal({ title, body, buttons, onOpen }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const foot = $('#modal-foot');
  foot.innerHTML = '';
  for (const b of buttons || []) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + (b.cls || '');
    el.textContent = b.label;
    el.addEventListener('click', async () => {
      const keep = b.onClick ? await b.onClick() : false;
      if (keep !== true) dlg.close();
    });
    foot.appendChild(el);
  }
  dlg.onclose = null;
  if (!dlg.open) dlg.showModal();
  onOpen && onOpen($('#modal-body'));
}
function editHlNote(aid, id, pos, fresh) {
  const r = getRec(aid, true);
  const h = (r.hl || []).find((x) => x.id === id);
  if (!h) return;
  const sp = splitPara(byId.get(aid).p[h.p] || '');
  let p = pos || h.pos || 'up';
  modal({
    title: `${aidLabel(aid)}・紅字註記`,
    body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(sp.body.slice(h.s, h.e))}」</p>
      <div class="set-row" style="border:0;padding-top:0"><span class="l">顯示位置</span><span class="segs" id="m-pos"><button type="button" data-p="up" aria-pressed="${p === 'up'}">文字上方</button><button type="button" data-p="dn" aria-pressed="${p === 'dn'}">文字下方</button></span></div>
      <textarea class="note" id="m-hlnote" placeholder="以紅色小字顯示在這段文字的上方或下方">${esc(h.n || '')}</textarea>`,
    buttons: [
      { label: '取消', onClick: () => { if (fresh && !h.n) { r.hl = r.hl.filter((x) => x.id !== id); saveRec(aid); refreshArticle(aid); refreshChips(aid); } } },
      { label: '儲存', cls: 'primary', onClick: () => {
        h.n = $('#m-hlnote').value.trim();
        h.pos = p;
        if (!h.n && h.c === 'n') r.hl = r.hl.filter((x) => x.id !== id);
        saveRec(aid); refreshArticle(aid); refreshChips(aid);
        if (current === aid) renderDetail();
        if (hiddenArts.has(aid) || !settings.master || !settings.show.notes) toast('已儲存；目前註記為隱藏狀態');
      } },
    ],
    onOpen: (b) => {
      $('#m-pos', b).onclick = (e) => {
        const x = e.target.closest('[data-p]');
        if (!x) return;
        p = x.dataset.p;
        $$('[data-p]', b).forEach((y) => y.setAttribute('aria-pressed', y === x ? 'true' : 'false'));
      };
      $('#m-hlnote').focus();
    },
  });
}
function editItem(aid, item) {
  const isNew = !item;
  item = item || { id: uid(), kind: '判決', no: '', date: '', text: '', url: '' };
  modal({
    title: isNew ? `${aidLabel(aid)}・新增判決／函釋` : '編輯判決／函釋',
    body: `<div class="form-grid">
      <div class="field"><label for="m-kind">類型</label><select class="inp" id="m-kind">${USER_KINDS.map((k) => `<option${k === item.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label for="m-date">日期</label><input class="inp" id="m-date" value="${esc(item.date)}" placeholder="例：112年03月24日"></div>
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院112年度台上字第1234號判決／最高法院108年度台抗大字第897號裁定"></div>
      <div class="field full"><label for="m-text">要旨</label><textarea class="note" id="m-text" placeholder="判決要旨或函釋內容">${esc(item.text)}</textarea></div>
      <div class="field full"><label for="m-url">原文連結（選填）</label><input class="inp" id="m-url" type="url" value="${esc(item.url)}" placeholder="https://"></div></div>
      <p class="callout" style="margin:0">自建的判決、函釋會以小字顯示在條文下方。</p>`,
    buttons: [
      ...(isNew ? [] : [{ label: '刪除', cls: 'danger', onClick: () => {
        const r = getRec(aid, true);
        r.items = (r.items || []).filter((x) => x.id !== item.id);
        saveRec(aid); refreshArticle(aid); renderDetail(); toast('已刪除');
      } }]),
      { label: '取消' },
      { label: '儲存', cls: 'primary', onClick: () => {
        const no = $('#m-no').value.trim();
        if (!no) { toast('請填寫字號'); return true; }
        Object.assign(item, { kind: $('#m-kind').value, no, date: $('#m-date').value.trim(), text: $('#m-text').value.trim(), url: $('#m-url').value.trim() });
        const r = getRec(aid, true);
        r.items = r.items || [];
        if (isNew) r.items.push(item);
        saveRec(aid); refreshArticle(aid);
        rulFilter = isNew ? 'U' : rulFilter;
        renderDetail(); toast('已儲存');
      } },
    ],
    onOpen: () => $('#m-no').focus(),
  });
}
function editRulingNote(aid, key) {
  const r = getRec(aid, true);
  r.rnote = r.rnote || {};
  modal({
    title: `${key.split(':').slice(1).join(':')}・筆記`,
    body: `<textarea class="note" id="m-rnote" placeholder="這則判解的重點、與本條的關係…">${esc(r.rnote[key] || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => {
      const v = $('#m-rnote').value.trim();
      if (v) r.rnote[key] = v; else delete r.rnote[key];
      saveRec(aid); refreshArticle(aid); renderDetail();
    } }],
    onOpen: () => $('#m-rnote').focus(),
  });
}

// ---------------------------------------------------------------------------
// 搜尋與我的註記
// ---------------------------------------------------------------------------
function showSide(which) {
  $$('.seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.side === which ? 'true' : 'false'));
  ['toc', 'search', 'mine'].forEach((k) => { $('#side-' + k).hidden = k !== which; });
  if (which === 'mine') renderMine();
}
function snippet(text, terms, len = 70) {
  const i = Math.max(0, text.indexOf(terms[0]));
  const s = Math.max(0, i - 20);
  let out = esc((s > 0 ? '…' : '') + text.slice(s, s + len) + (s + len < text.length ? '…' : ''));
  for (const t of terms) out = out.split(esc(t)).join(`<mark class="q">${esc(t)}</mark>`);
  return out;
}
function doSearch(q) {
  q = q.trim();
  const box = $('#side-search');
  if (!q) { box.innerHTML = '<p class="side-note">輸入關鍵字搜尋條文、條旨、判解、立法理由與你的註記；輸入條號（例如 249、44-1、第二百四十九條）可直接跳到該條。</p>'; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  let html = '';
  const arts = [];
  for (const a of D.articles) { const t = (a.g ? `（${a.g}）` : '') + a.p.join(''); if (has(t)) arts.push([a.id, t]); }
  const mine = [];
  notes.forEach((r, aid) => {
    const t = [r.note || '', ...(r.tags || []), ...(r.hl || []).map((h) => h.n || ''), ...(r.st || []).map((s) => s.t || ''), ...(r.items || []).map((i) => i.no + i.text), ...Object.values(r.rnote || {})].join(' ');
    if (has(t)) mine.push([aid, t]);
  });
  const ruls = [];
  if (R) for (const aid in R) for (const r of R[aid]) {
    const t = r.no + ' ' + (r.parts || []).map((p) => p[1]).join(' ');
    if (has(t)) ruls.push([aid, r, t]);
  }
  const reas = [];
  if (H) for (const aid in H.arts) for (const v of H.arts[aid]) {
    if (v.old || !v.r) continue;
    const t = v.r.join('');
    if (has(t)) { reas.push([aid, v, t]); }
  }
  const jump = parseAidInput(q);
  if (jump && byId.has(jump)) html += `<button class="res" data-goto="${jump}"><b>跳到${aidLabel(jump)}</b><em>${esc(byId.get(jump).g || '')}</em><span>${esc(byId.get(jump).p.join('').slice(0, 60))}…</span></button>`;
  html += `<div class="res-group">條文 ${arts.length}</div>`;
  html += arts.slice(0, 150).map(([aid, t]) => `<button class="res" data-goto="${aid}"><b>${aidLabel(aid)}</b><em>${esc(byId.get(aid).g || '')}</em><span>${snippet(t, terms)}</span></button>`).join('');
  if (mine.length) {
    html += `<div class="res-group">我的註記 ${mine.length}</div>`;
    html += mine.map(([aid, t]) => `<button class="res" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  if (R) {
    html += `<div class="res-group">判解 ${ruls.length}</div>`;
    html += ruls.slice(0, 120).map(([aid, r, t]) => `<button class="res" data-goto="${aid}" data-tab="rulings"><b>${esc(r.no)}・${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  if (H) {
    html += `<div class="res-group">立法理由 ${reas.length}</div>`;
    html += reas.slice(0, 100).map(([aid, v, t]) => `<button class="res" data-goto="${aid}" data-tab="reasons"><b>${aidLabel(aid)}・${roc(v.d, true)} ${esc(v.k)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  } else html += `<p class="side-note">立法理由資料載入後即可一併搜尋。</p>`;
  box.innerHTML = html;
}
let mineFilter = 'all';
function renderMine() {
  const rows = [];
  for (const aid of order) {
    const r = notes.get(aid);
    if (!r || isEmptyRec(r)) continue;
    const f = {
      star: !!r.star, note: !!r.note || !!(r.hl && r.hl.some((h) => h.n)), hl: !!(r.hl && r.hl.length), ink: !!nInk(r), st: !!(r.st && r.st.length),
      item: !!(r.items && r.items.length) || !!(r.imp && Object.keys(r.imp).length),
    };
    rows.push({ aid, r, f });
  }
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★ 書籤'], ['note', '紅字註記'], ['hl', '劃線'], ['ink', '手寫'], ['st', '便利貼'], ['item', '判解']];
  const list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([k, l]) => `<button class="fchip" data-mf="${k}" aria-pressed="${mineFilter === k}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。長按選取條文文字可劃線或加紅字註記；右上角可放便利貼、開啟手寫模式用 Apple Pencil 書寫。'}</p>`;
  html += list.map(({ aid, r, f }) => {
    const bits = [f.star && '★', r.note && '筆記', f.hl && `劃線 ${r.hl.length}`, f.ink && '手寫', f.st && `便利貼 ${r.st.length}`, r.items && r.items.length && `自建 ${r.items.length}`, r.imp && Object.keys(r.imp).length && `重要判解 ${Object.keys(r.imp).length}`].filter(Boolean).join('・');
    const peek = r.note || (r.hl || []).map((h) => h.n).filter(Boolean).join('／') || (r.st || []).map((s) => s.t).filter(Boolean).join('／') || (r.tags || []).map((t) => '#' + t).join(' ') || byId.get(aid).p.join('').slice(0, 60);
    return `<button class="res" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b><em>${esc(byId.get(aid).g || '')}</em> <small style="color:var(--faint)">${bits}</small><span>${esc(peek)}</span></button>`;
  }).join('');
  $('#side-mine').innerHTML = html;
}

// ---------------------------------------------------------------------------
// 設定、備份
// ---------------------------------------------------------------------------
function applySettings() {
  const root = document.documentElement;
  if (settings.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', settings.theme);
  root.style.setProperty('--law-size', settings.size + 'px');
  root.style.setProperty('--law-lh', settings.lh);
  const inner = $('#reader-inner');
  inner.classList.toggle('no-pn', !settings.pn);
  inner.classList.toggle('fluid', settings.measure === 'fluid');
  document.body.classList.toggle('mono-no', !settings.pcolor);
  applyVisibility();
  requestAnimationFrame(() => { ink.redrawAll(); refitAll(); });
}
function exportData() {
  const data = { app: 'ccp-notes', version: 1, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) };
  return JSON.stringify(data);
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || data.app !== 'ccp-notes' || !data.notes) throw new Error('不是民事訴訟法註記本的備份檔');
  if (replace) {
    for (const aid of [...notes.keys()]) if (!data.notes[aid]) { notes.set(aid, {}); await saveRec(aid); }
    notes.clear();
  }
  const byIdMerge = (a = [], b = []) => { const m = new Map(); [...b, ...a].forEach((x) => m.set(x.id, x)); return [...m.values()]; };
  for (const [aid, rec] of Object.entries(data.notes)) {
    if (!byId.has(aid)) continue;
    if (!replace && notes.has(aid)) {
      const cur = notes.get(aid);
      const merged = { ...rec, ...cur };
      merged.note = [cur.note, rec.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
      merged.tags = Array.from(new Set([...(cur.tags || []), ...(rec.tags || [])]));
      merged.hl = byIdMerge(cur.hl, rec.hl);
      merged.st = byIdMerge(cur.st, rec.st);
      merged.items = byIdMerge(cur.items, rec.items);
      merged.imp = { ...(rec.imp || {}), ...(cur.imp || {}) };
      merged.rnote = { ...(rec.rnote || {}), ...(cur.rnote || {}) };
      if (rec.ink && cur.ink) merged.ink = { ...cur.ink, strokes: [...(cur.ink.strokes || []), ...(rec.ink.strokes || [])] };
      merged.star = cur.star || rec.star;
      notes.set(aid, merged);
    } else notes.set(aid, rec);
    await saveRec(aid);
  }
  if (data.settings && replace) { settings = mergeSettings(data.settings); hiddenArts = new Set(settings.hidden || []); await saveSettings(); applySettings(); }
  renderReader();
  if (current) renderDetail();
}
function cloudLabel() {
  return { on: '已啟用（跨裝置同步，個人私有）', connecting: '連線中…', error: cloud.msg || '中斷', off: '未啟用（僅在 claude.ai 開啟時可用）' }[cloud.state] || '未啟用';
}
function mergeSettings(v) {
  const s = { ...structuredClone(DEFAULTS), ...v };
  s.show = { ...DEFAULTS.show, ...(v.show || {}) };
  s.pen = { ...DEFAULTS.pen, ...(v.pen || {}) };
  return s;
}
function openSettings() {
  const seg = (key, opts) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(settings[key]) === String(v)}">${l}</button>`).join('')}</span>`;
  const n = [...notes.values()].filter((r) => !isEmptyRec(r)).length;
  const parts = D.headings.map((h, i) => [h, i]).filter(([h]) => h.lv === 0);
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距<small>行距較大時，行間紅字註記較不擁擠</small></span>${seg('lh', [['2', '緊'], ['2.3', '中'], ['2.6', '鬆']])}</div>
      <div class="set-row"><span class="l">版面寬度<small>固定：直向、橫向的換行位置相同，手寫不會偏移</small></span>${seg('measure', [['fixed', '固定'], ['fluid', '填滿']])}</div>
      <div class="set-row"><span class="l">條號顏色<small>依編別以不同顏色反白</small></span>${seg('pcolor', [['true', '依編別'], ['false', '單色']])}</div>
      <div class="palette">${parts.map(([h, i]) => `<span style="--pc:var(--p${partOrder.get(i)})"><i></i>${esc(h.t.replace(/\s.*/, ''))}</span>`).join('')}</div>
      <div class="set-row"><span class="l">條旨<small>條號下以括號顯示本條要旨</small></span>${seg('gist', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示同條各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">判解／修正標記</span>${seg('chips', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">手指點條文<small>顯示／隱藏該條我的註記</small></span>${seg('tap', [['one', '單擊'], ['two', '雙擊'], ['off', '關閉']])}</div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">目前共有 ${n} 條有註記<small>本機：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}；雲端同步：${cloudLabel()}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>可選檔案或貼上 JSON</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料</div>
      <div class="meta-list">條文：${esc(D.meta.source)}，法規修正日期 ${roc(D.meta.modified)}，資料庫更新 ${esc(D.meta.sourceUpdate)}。<br>
        新舊對照與立法理由：${esc(D.meta.histSource)}。<br>
        判解：全國法規資料庫各條「憲法法庭裁判」「大法官解釋」「判例」${R ? `，共 ${Object.values(R).reduce((s, v) => s + v.length, 0)} 筆` : '（未載入）'}。<br>
        條旨為本工具自行撰寫，供閱讀參考。正式引用請以官方公布之法規與裁判全文為準。<br>
        <a href="${esc(document.querySelector('meta[name="civil-link"]')?.content || '../')}" target="_top" rel="noopener" style="color:var(--accent)">開啟民法註記本 ↗</a></div>
      <div class="set-h">危險區域</div>
      <div class="row-actions"><input class="inp" id="wipe-confirm" placeholder="輸入「清除」以刪除全部註記" style="max-width:260px"><button type="button" class="btn small danger" data-act="wipe">刪除全部註記</button></div>`,
    buttons: [{ label: '完成', cls: 'primary' }],
    onOpen: (body) => {
      body.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.set) {
          const k = b.dataset.set, v = b.dataset.val;
          settings[k] = (k === 'theme' || k === 'measure' || k === 'tap') ? v : k === 'lh' ? +v : v === 'true';
          $$(`[data-set="${k}"]`, body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          saveSettings(); applySettings(); layoutDetail();
          if (k === 'chips' || k === 'pn' || k === 'gist') { renderReader(); if (current) renderDetail(); }
        } else if (b.dataset.size) {
          settings.size = Math.max(14, Math.min(28, settings.size + +b.dataset.size));
          $('#size-val').textContent = settings.size + 'px';
          saveSettings(); applySettings(); layoutDetail();
        } else if (b.dataset.act === 'export') {
          const fname = `民事訴訟法註記備份-${new Date().toISOString().slice(0, 10)}.json`;
          if (dlApi) {
            dlApi.save({ filename: fname, data: exportData() }).then(() => toast('已匯出備份檔')).catch((err) => {
              if (err && err.code === 'declined') return;
              toast('無法存檔，請改用「複製」');
            });
            return;
          }
          const blob = new Blob([exportData()], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = fname;
          document.body.appendChild(a); a.click(); a.remove();
          setTimeout(() => URL.revokeObjectURL(a.href), 4000);
          toast('已匯出備份檔；若沒有下載，請改用「複製」');
        } else if (b.dataset.act === 'copy-export') {
          const txt = exportData();
          try { await navigator.clipboard.writeText(txt); toast('已複製備份 JSON'); }
          catch { const t = $('#imp-text'); t.value = txt; t.select(); toast('請手動複製下方文字'); }
        } else if (b.dataset.act === 'imp-merge' || b.dataset.act === 'imp-replace') {
          const txt = $('#imp-text').value.trim();
          if (!txt) { toast('請先選擇檔案或貼上 JSON'); return; }
          try { await importData(txt, b.dataset.act === 'imp-replace'); toast('匯入完成'); $('#modal').close(); }
          catch (err) { toast('匯入失敗：' + err.message); }
        } else if (b.dataset.act === 'wipe') {
          if ($('#wipe-confirm').value.trim() !== '清除') { toast('請先輸入「清除」'); return; }
          for (const aid of [...notes.keys()]) { notes.set(aid, {}); await saveRec(aid); }
          hiddenArts.clear(); await saveSettings();
          renderReader(); if (current) renderDetail(); toast('已刪除全部註記'); $('#modal').close();
        }
      };
      $('#imp-file').onchange = async (e) => {
        const f = e.target.files[0];
        if (f) { $('#imp-text').value = await f.text(); toast('已讀取檔案，請選擇合併或取代'); }
      };
    },
  });
}

// ---------------------------------------------------------------------------
// 手寫與便利貼
// ---------------------------------------------------------------------------
const ink = new Ink({
  getRec,
  saveRec,
  onChange: (aid) => {
    refreshChips(aid);
    const el = document.getElementById('a-' + aid);
    if (el) el.classList.toggle('anno-off', hiddenArts.has(aid) && hasAnno(notes.get(aid)));
    if (current === aid && detailTab === 'notes') renderDetail();
  },
});
const stickies = new Stickies({
  getRec,
  saveRec,
  uid,
  onChange: (aid) => { refreshChips(aid); if (current === aid && detailTab === 'notes') renderDetail(); },
});
function setInk(on) {
  if (on) setPlacing(false);
  ink.setActive(on);
  $('#btn-ink').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#inkbar').hidden = !on;
  if (on) {
    hidePop(); stickies.select(null); window.getSelection()?.removeAllRanges();
    if (!settings.master || !settings.show.ink) toast('手寫模式：目前手寫註記設為隱藏，書寫時暫時顯示');
    else toast('手寫模式：用 Apple Pencil 在條文上書寫，手指可捲動');
    drawWidthPreview();
  }
}
function setPlacing(on) {
  document.body.classList.toggle('placing', on);
  $('#btn-sticky').setAttribute('aria-pressed', on ? 'true' : 'false');
  if (on) { if (ink.active) setInk(false); toast('點一下條文要貼便利貼的位置'); }
}
function setPenWidth(px, fromSlider) {
  ink.px = px;
  settings.pen.px = px;
  $('#w-val').textContent = px < 1 ? px.toFixed(px < 0.2 ? 2 : 1).replace(/0$/, '') : String(px);
  if (!fromSlider) $('#w-range').value = widthToSlider(px);
  $$('.wpresets button').forEach((b) => b.setAttribute('aria-pressed', Math.abs(+b.dataset.w - px) < 0.001 ? 'true' : 'false'));
  drawWidthPreview();
  saveSettingsSoon();
}
const saveSettingsSoon = debounce(saveSettings, 400);
function drawWidthPreview() {
  const c = $('#w-prev');
  if (!c) return;
  const dpr = window.devicePixelRatio || 1;
  const W = 64, Hh = 28;
  c.width = W * dpr; c.height = Hh * dpr;
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, Hh);
  const em = 10;
  const pts = [];
  for (let i = 0; i <= 24; i++) { const x = 0.6 + i * 0.22; pts.push(x, 1.4 + Math.sin(i / 24 * Math.PI * 2) * 0.6, 0.5); }
  const cols = ink.colors();
  paint(ctx, { t: ink.tool === 'marker' ? 'marker' : 'pen', c: ink.tool === 'marker' ? 'mark' : ink.color, w: ink.px / em, pts, np: 1 }, em, cols);
}
function bindInkbar() {
  const bar = $('#inkbar');
  const range = $('#w-range');
  range.addEventListener('input', () => setPenWidth(sliderToWidth(+range.value), true));
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) {
      ink.tool = b.dataset.tool;
      if (b.dataset.tool === 'pen') { ink.color = b.dataset.color; settings.pen.color = ink.color; saveSettingsSoon(); }
      $$('[data-tool]', bar).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
      drawWidthPreview();
    } else if (b.dataset.w) setPenWidth(+b.dataset.w);
    else if (b.dataset.act === 'pressure') {
      ink.pressure = !ink.pressure;
      settings.pen.pressure = ink.pressure; saveSettingsSoon();
      b.setAttribute('aria-pressed', ink.pressure ? 'true' : 'false');
      toast(ink.pressure ? '筆壓：依 Apple Pencil 壓力改變粗細' : '筆壓關閉：固定筆寬');
    } else if (b.dataset.act === 'undo') { if (!ink.undoLast()) toast('沒有可復原的筆畫'); }
    else if (b.dataset.act === 'redo') { if (!ink.redoLast()) toast('沒有可重做的筆畫'); }
    else if (b.dataset.act === 'finger') {
      ink.finger = !ink.finger;
      b.setAttribute('aria-pressed', ink.finger ? 'true' : 'false');
      document.body.classList.toggle('finger', ink.finger);
      toast(ink.finger ? '手指也可書寫（捲動請用兩指）' : '只有 Apple Pencil 可書寫');
    } else if (b.dataset.act === 'done') setInk(false);
  });
  // 套用上次的筆設定
  ink.color = settings.pen.color || 'red';
  ink.pressure = settings.pen.pressure !== false;
  $$('[data-tool="pen"]', bar).forEach((x) => x.setAttribute('aria-pressed', x.dataset.color === ink.color ? 'true' : 'false'));
  $('[data-act="pressure"]', bar).setAttribute('aria-pressed', ink.pressure ? 'true' : 'false');
  setPenWidth(settings.pen.px || 0.5);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
let lastPointer = 'mouse';
let busyAtDown = false;   // 按下時有選取文字或彈出視窗：這次點觸只用來關閉，不切換註記
let lastTapAt = 0, lastTapAid = null;
function bind() {
  $('#btn-nav').onclick = () => setSide(!$('#sidebar').classList.contains('open'));
  $('#scrim').onclick = () => setSide(false);
  $('#btn-settings').onclick = openSettings;
  $('#btn-ink').onclick = () => setInk(!ink.active);
  $('#btn-sticky').onclick = () => setPlacing(!document.body.classList.contains('placing'));
  $('#backchip').onclick = goBack;
  // 眼睛：點一下切換、長按開啟細部設定
  const eye = $('#btn-eye');
  let pressT = null, longFired = false;
  eye.addEventListener('pointerdown', () => { longFired = false; pressT = setTimeout(() => { longFired = true; openEyePop(); }, 450); });
  const cancelPress = () => clearTimeout(pressT);
  eye.addEventListener('pointerup', cancelPress);
  eye.addEventListener('pointerleave', cancelPress);
  eye.addEventListener('contextmenu', (e) => { e.preventDefault(); openEyePop(); longFired = true; });
  eye.addEventListener('click', () => { if (longFired) { longFired = false; return; } toggleMaster(); });
  $('#eye-pop').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.show) {
      const k = b.dataset.show;
      if (k === 'master') settings.master = !settings.master;
      else { settings.show[k] = !settings.show[k]; if (settings.show[k] && k !== 'xlaw') settings.master = true; }
      applyVisibility(); saveSettings(); renderEyePop();
    } else if (b.dataset.tap) {
      settings.tap = b.dataset.tap; saveSettings(); renderEyePop();
    } else if (b.dataset.act === 'unhide-all') {
      const ids = [...hiddenArts]; hiddenArts.clear(); saveSettings();
      ids.forEach(refreshArticle); renderEyePop(); toast('已恢復顯示');
    }
  });

  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => { const i = orderIdx.get(current); if (i > 0) gotoArticle(order[i - 1], { flash: false }); };
  $('#d-next').onclick = () => { const i = orderIdx.get(current); if (i < order.length - 1) gotoArticle(order[i + 1], { flash: false }); };
  $('#d-star').onclick = () => {
    const r = getRec(current, true);
    r.star = !r.star;
    saveRec(current); refreshChips(current);
    $('#d-star').setAttribute('aria-pressed', r.star ? 'true' : 'false');
    toast(r.star ? '已加入書籤' : '已移除書籤');
  };
  $$('.seg button').forEach((b) => { b.onclick = () => showSide(b.dataset.side); });
  $$('.tabs button').forEach((b) => { b.onclick = () => { detailTab = b.dataset.tab; if ((detailTab === 'history' || detailTab === 'reasons') && !H) loadHist(); renderDetail(); }; });

  // 搜尋
  const q = $('#q');
  const run = debounce(() => { showSide('search'); doSearch(q.value); }, 220);
  q.addEventListener('input', () => { if (q.value.trim()) run(); });
  q.addEventListener('focus', () => { if (!H) loadHist(); if (q.value.trim()) { showSide('search'); setSide(true); } });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const jump = parseAidInput(q.value);
    if (jump && byId.has(jump)) { gotoArticle(jump); q.blur(); return; }
    showSide('search'); doSearch(q.value); setSide(true); q.blur();
  });

  // 目錄
  $('#side-toc').addEventListener('click', (e) => {
    const tg = e.target.closest('[data-toggle]');
    const btn = e.target.closest('.toc-btn');
    if (!btn) return;
    const hi = +btn.dataset.h;
    const kids = document.getElementById('tk-' + hi);
    if (tg || (kids && kids.hidden && D.headings[hi].lv === 0)) {
      if (kids) { kids.hidden = !kids.hidden; $(`[data-toggle="${hi}"]`)?.classList.toggle('open', !kids.hidden); }
      if (tg) return;
    }
    gotoHeading(hi);
  });

  for (const id of ['#side-search', '#side-mine']) {
    $(id).addEventListener('click', (e) => {
      const mf = e.target.closest('[data-mf]');
      if (mf) { mineFilter = mf.dataset.mf; renderMine(); return; }
      const b = e.target.closest('[data-goto]');
      if (!b) return;
      if (b.dataset.tab) detailTab = b.dataset.tab;
      gotoArticle(b.dataset.goto);
    });
  }

  // 閱讀區
  const reader = $('#reader');
  // window 擷取階段：早於便利貼取消選取等處理，先記下按下時的狀態
  window.addEventListener('pointerdown', (e) => {
    lastPointer = e.pointerType;
    const s = window.getSelection();
    busyAtDown = !!(s && !s.isCollapsed) || !$('#hl-pop').hidden || !$('#ref-pop').hidden || !$('#eye-pop').hidden || !!stickies.sel;
  }, true);
  reader.addEventListener('scroll', () => {
    trackTOC();
    if (!$('#hl-pop').hidden && !pendingSel) hidePop();
    $('#ref-pop').hidden = true;
  }, { passive: true });
  const clickArticle = (e) => {
    const inDetail = !!e.target.closest('#d-text');
    if (e.target.closest('.sticky')) return;
    // 放置便利貼
    if (document.body.classList.contains('placing') && !inDetail) {
      const art = e.target.closest('.art');
      if (!art) return;
      e.preventDefault();
      const host = art.querySelector('.atext');
      const hr = host.getBoundingClientRect();
      const em = parseFloat(getComputedStyle(host).fontSize) || 18;
      const x = Math.max(-0.4, Math.min(hr.width / em - 9, (e.clientX - hr.left) / em - 0.4));
      const y = (e.clientY - hr.top) / em - 0.4;
      setPlacing(false);
      if (hiddenArts.has(art.dataset.id)) { hiddenArts.delete(art.dataset.id); saveSettings(); refreshArticle(art.dataset.id); }
      stickies.create(art.dataset.id, x, y);
      return;
    }
    if (ink.active && !inDetail) {
      // 手寫模式下，手指點一下仍可切換本條註記
      if (lastPointer === 'touch') maybeToggle(e);
      return;
    }
    const xl = e.target.closest('[data-xlaw]');
    if (xl) { e.preventDefault(); showRefPop(xl, xl.dataset.xlaw); return; }
    const go = e.target.closest('[data-goto]');
    if (go) {
      e.preventDefault();
      const from = e.target.closest('[data-id]')?.dataset.id;
      gotoArticle(go.dataset.goto, { from, open: !!current || inDetail });
      if (!current && !inDetail) toast(`已跳到${aidLabel(go.dataset.goto)}，左下角可返回`);
      return;
    }
    const un = e.target.closest('[data-unhide]');
    if (un) { toggleArtAnno(un.dataset.unhide); return; }
    const xm = e.target.closest('[data-xmore]');
    if (xm) { xlawOpen.add(xm.dataset.xmore); refreshArticle(xm.dataset.xmore); return; }
    const op = e.target.closest('[data-open]');
    if (op) { openDetail(op.dataset.open, op.dataset.tab); return; }
    const sn = e.target.closest('.anote[data-sn]');
    if (sn) { const host = sn.closest('[data-id]'); editHlNote(host.dataset.id, sn.dataset.sn); return; }
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const artEl = e.target.closest('[data-id]');
    const hl = e.target.closest('.hl[data-hl]');
    const annoShown = artEl && !artEl.classList.contains('anno-off') && settings.master && settings.show.hl;
    if (hl && annoShown) {
      activeHl = { aid: artEl.dataset.id, id: hl.dataset.hl };
      pendingSel = null;
      const rec = getRec(activeHl.aid);
      const h = rec && (rec.hl || []).find((x) => x.id === activeHl.id);
      showPop(hl.getBoundingClientRect(), true, h && h.n);
      return;
    }
    if (!inDetail) maybeToggle(e);
  };
  function maybeToggle(e) {
    if (settings.tap === 'off' || busyAtDown) return;
    const art = e.target.closest('.art');
    if (!art || !e.target.closest('.atext, .gist, .art-head')) return;
    if (e.target.closest('button, a')) return;
    const aid = art.dataset.id;
    if (!hasAnno(notes.get(aid))) return;
    if (settings.tap === 'two') {
      const now = Date.now();
      if (lastTapAid === aid && now - lastTapAt < 400) { lastTapAt = 0; toggleArtAnno(aid); }
      else { lastTapAt = now; lastTapAid = aid; }
      return;
    }
    toggleArtAnno(aid);
  }
  reader.addEventListener('click', clickArticle);
  $('#d-text').addEventListener('click', clickArticle);
  document.addEventListener('selectionchange', onSelChange);
  $('#hl-pop').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (b) applyHighlight(b.dataset.hl);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop') && !e.target.closest('.hl')) {
      setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hidePop(); }, 10);
    }
    if (!$('#ref-pop').hidden && !e.target.closest('#ref-pop') && !e.target.closest('[data-xlaw]')) $('#ref-pop').hidden = true;
    if (!$('#eye-pop').hidden && !e.target.closest('#eye-pop') && !e.target.closest('#btn-eye')) $('#eye-pop').hidden = true;
  });

  // 詳細面板內容
  $('#d-body').addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-goto]');
    if (!b) return;
    if (b.dataset.goto) { e.preventDefault(); gotoArticle(b.dataset.goto, { from: current }); return; }
    if (b.dataset.rf) { rulFilter = b.dataset.rf; renderDetail(); return; }
    if (b.dataset.cm) { cmpMode = b.dataset.cm; renderHistory($('#d-body')); return; }
    if (b.dataset.cmp) { cmpSel = { aid: current, a: +b.dataset.cmpA, b: +b.dataset.cmp }; renderHistory($('#d-body')); return; }
    if (b.dataset.npos) {
      const r = getRec(current, true);
      r.notePos = b.dataset.npos;
      saveRec(current); refreshArticle(current); renderNotes($('#d-body'));
      return;
    }
    const card = b.closest('.rcard');
    const act = b.dataset.act;
    if (act === 'add-item') editItem(current);
    else if (act === 'imp' && card) {
      const r = getRec(current, true);
      r.imp = r.imp || {};
      const k = card.dataset.key;
      if (r.imp[k]) delete r.imp[k]; else r.imp[k] = 1;
      saveRec(current); refreshArticle(current); renderDetail();
    } else if (act === 'expand' && card) {
      $$('.rpart.clamp', card).forEach((p) => p.classList.remove('clamp'));
      b.remove();
    } else if (act === 'rnote' && card) editRulingNote(current, card.dataset.key);
    else if (act === 'edit-item' && card) {
      const id = card.dataset.key.slice(2);
      editItem(current, (getRec(current).items || []).find((x) => x.id === id));
    } else if (act === 'rm-tag') {
      const r = getRec(current, true);
      r.tags = (r.tags || []).filter((t) => t !== b.dataset.tag);
      saveRec(current); renderDetail();
    } else if (act === 'hl-note') editHlNote(current, b.dataset.id);
    else if (act === 'hl-del') {
      const r = getRec(current, true);
      r.hl = (r.hl || []).filter((h) => h.id !== b.dataset.id);
      saveRec(current); refreshArticle(current); renderDetail();
    } else if (act === 'st-add') {
      const aid = current;
      if (isNarrow()) closeDetail();
      gotoArticle(aid, { open: false, flash: false });
      setTimeout(() => stickyAtRect(aid, null), 250);
    } else if (act === 'st-del') stickies.remove(current, b.dataset.id);
    else if (act === 'st-go') {
      const aid = current;
      if (matchMedia('(max-width: 760px)').matches) closeDetail();
      gotoArticle(aid, { open: false, flash: false });
      setTimeout(() => { const el = document.querySelector(`#a-${CSS.escape(aid)} [data-st="${b.dataset.id}"]`); if (el) stickies.select(el, aid); }, 260);
    } else if (act === 'toggle-art') { toggleArtAnno(current); renderDetail(); }
    else if (act === 'ink-on') {
      const aid = current;
      setInk(true);
      if (matchMedia('(max-width: 760px)').matches) closeDetail();
      gotoArticle(aid, { open: false });
    } else if (act === 'ink-clear') { ink.clear(current); toast('已清除，可按「復原」還原'); }
  });
  $('#d-body').addEventListener('change', (e) => {
    if (e.target.id === 'cmp-a' || e.target.id === 'cmp-b') {
      cmpSel[e.target.id === 'cmp-a' ? 'a' : 'b'] = +e.target.value;
      renderHistory($('#d-body'));
    }
  });

  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#a-(\d+(?:-\d+)?)$/);
    if (m && m[1] !== current) gotoArticle(m[1]);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#hl-pop').hidden) hidePop();
      else if (!$('#ref-pop').hidden) $('#ref-pop').hidden = true;
      else if (!$('#eye-pop').hidden) $('#eye-pop').hidden = true;
      else if (document.body.classList.contains('placing')) setPlacing(false);
      else if (ink.active) setInk(false);
      else if (current) closeDetail();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => { ink.redrawAll(); drawWidthPreview(); });
  new ResizeObserver(refitAll).observe($('#reader-inner'));
  window.addEventListener('resize', debounce(layoutDetail, 150));
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(refitAll);
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const [law, saved] = await Promise.all([
      fetch('data/law.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      store.getAll().catch(() => ({})),
    ]);
    D = law;
    D.articles.forEach((a, i) => { byId.set(a.id, a); order.push(a.id); orderIdx.set(a.id, i); });
    D.headings.forEach((h, i) => { if (h.lv === 0) partOrder.set(i, partOrder.size); });
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('a:')) {
        const aid = k.slice(2);
        known.add(aid);
        if (v && v.del) tombs.set(aid, v.t || 0); else notes.set(aid, v);
      } else if (k === 'settings') settings = mergeSettings(v);
    }
    hiddenArts = new Set(settings.hidden || []);
  } catch (e) {
    $('#loading').textContent = '無法載入條文資料：' + e.message;
    return;
  }
  applySettings();
  renderTOC();
  renderReader();
  bind();
  bindInkbar();
  doSearch('');
  const m = location.hash.match(/^#a-(\d+(?:-\d+)?)$/);
  if (m && byId.has(m[1])) gotoArticle(m[1]);
  else if (!isNarrow() && D.headings.length) tocExpandTo(0);

  fetch('data/rulings.json').then((r) => (r.ok ? r.json() : null)).then((data) => {
    if (!data) return;
    R = data;
    for (const aid of Object.keys(R)) refreshChips(aid);
    notes.forEach((r, aid) => { if (r.imp && Object.keys(r.imp).length) refreshArticle(aid); });
    if (current) renderDetail();
  }).catch(() => {});
  setTimeout(loadHist, 1500);

  store.persist();
  // claude.ai Artifact：個人雲端同步與匯出檔案
  cloud.onState = (s, msg) => { if ((s === 'warn' || s === 'error') && msg) toast(msg, 3600); };
  cloud.init(onRemoteDoc, onFirstSync);
  if (window.claude && typeof window.claude.use === 'function') window.claude.use('downloads').then((d) => { dlApi = d; }).catch(() => {});
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
