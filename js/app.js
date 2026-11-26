import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, PRESETS } from './ink.js';
import { makeResolver, parseJump } from './xref.js';

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let LIB = [];                 // 書架（data/laws.json）
let DEFAULT_LAW = 'osh';
const LAWS = new Map();       // id -> { e, D, byId, order, R, X, refCache }
let cur = null;               // 目前法典代號
let L = null;                 // 目前法典
const notes = new Map();      // 'law/aid' -> 使用者紀錄
let XREF = {};                // 'law:aid' -> ['law:aid', ...] 被引用
let refsOf = () => [];
let settings = {
  theme: 'system', size: 18, lh: 1.9, pn: true, chips: true, cap: true,
  noteMode: 'gloss', glossPos: 'a', showMine: true, tapToggle: 'double', rel: 'text',
  scope: 'law', law: null, pen: { mm: 0.3, color: 'red', pressure: true },
};
let current = null;           // 詳細面板中的條號
let detailTab = 'jud';
let rulFilter = 'all';
let cmpMode = 'table';
let cmpSel = null;
let mineFilter = 'all';
const hiddenArts = new Set(); // 'law/aid'：以手觸暫時隱藏註記

const TYPE_LABEL = { CJ: '憲法法庭', C: '大法官解釋', J: '判例', U: '我的', JG: '判決', IN: '函釋' };
const USER_KINDS = ['判決', '函釋', '決議', '其他'];
const KIND_LABEL = { orig: '制定', new: '增訂', amend: '修正', del: '刪除', renum: '條次變更', base: '資料庫最早版本' };
const GROUPS = ['職業安全衛生', '勞動法', '基本法'];
const PALETTE = ['blue', 'green', 'teal', 'amber', 'violet', 'slate', 'rose', 'olive', 'cyan', 'brown'];

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
export function aidLabel(aid) {
  const [a, b] = String(aid).split('-');
  return b ? `第${a}條之${b}` : `第${a}條`;
}
const pill = (aid) => { const [a, b] = String(aid).split('-'); return b ? `第 ${a} 條之 ${b}` : `第 ${a} 條`; };
function roc(d, short) {
  if (!d) return '';
  const y = +d.slice(0, 4) - 1911, m = d.slice(4, 6), dd = d.slice(6, 8);
  return short ? `${y}.${m}.${dd}` : `民國${y}年${+m}月${+dd}日`;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2400);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Math.random().toString(36).slice(2, 9);
const entry = (id) => LIB.find((e) => e.id === id);
const shortName = (id) => (entry(id) || {}).short || id;
const key = (aid, law = cur) => `${law}/${aid}`;
function headingPath(o, hidx) {
  const out = [];
  while (hidx >= 0) { out.unshift(o.D.headings[hidx].t); hidx = o.D.headings[hidx].p; }
  return out;
}
function artColor(o, a) {
  const h = o.D.headings[a.h];
  return (h && h.c) || 'blue';
}

// ---------------------------------------------------------------------------
// 載入法典
// ---------------------------------------------------------------------------
async function loadLaw(id) {
  let o = LAWS.get(id);
  if (o && o.D) return o;
  if (o && o.p) return o.p;
  const e = entry(id);
  if (!e) throw new Error('書架上沒有這部法典：' + id);
  o = { e, D: null, byId: new Map(), order: [], R: null, X: null, refCache: new Map() };
  LAWS.set(id, o);
  o.p = fetch(e.file).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((D) => {
    o.D = D;
    for (const a of D.articles) { o.byId.set(a.id, a); o.order.push(a.id); }
    // 未指定章別顏色者（如民法）依第一層標題輪替
    let k = 0;
    for (const h of D.headings) {
      if (!h.c) h.c = h.lv === 0 || h.p < 0 ? PALETTE[k++ % PALETTE.length] : D.headings[h.p].c;
    }
    return o;
  });
  try { return await o.p; } catch (err) { LAWS.delete(id); throw err; }
}
function loadAux(o) {
  const j = (u) => fetch(u).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  if (o.e.rulings && !o.Rp) o.Rp = j(o.e.rulings).then((d) => { o.R = d; });
  if (o.e.extra && !o.Xp) o.Xp = j(o.e.extra).then((d) => { o.X = d; });
  return Promise.all([o.Rp, o.Xp]);
}
function paraRefs(o, a, i) {
  const k = a.id + ':' + i;
  if (!o.refCache.has(k)) o.refCache.set(k, refsOf(splitPara(a.p[i] || '').body, o.e.id, a.id, o.order));
  return o.refCache.get(k);
}
function textRefs(text, law) { return refsOf(text, law); }

// ---------------------------------------------------------------------------
// 使用者紀錄
// ---------------------------------------------------------------------------
function getRec(aid, create, law = cur) {
  const k = key(aid, law);
  let r = notes.get(k);
  if (!r && create) { r = {}; notes.set(k, r); }
  return r;
}
function isEmptyRec(r) {
  return !r || (!r.star && !r.note && !(r.tags && r.tags.length) && !(r.hl && r.hl.length) &&
    !(r.ink && r.ink.strokes && r.ink.strokes.length) && !(r.items && r.items.length) && !(r.st && r.st.length) &&
    !(r.imp && Object.keys(r.imp).length) && !(r.rnote && Object.keys(r.rnote).length));
}
async function saveRec(aid, law = cur) {
  const k = key(aid, law);
  const r = notes.get(k);
  try {
    if (isEmptyRec(r)) { notes.delete(k); await store.del('n:' + k); }
    else { r.t = Date.now(); await store.put('n:' + k, r); }
  } catch (e) {
    console.error(e);
    toast('無法儲存註記：' + (e.message || e));
  }
}
async function saveSettings() { try { await store.put('settings', settings); } catch {} }

// ---------------------------------------------------------------------------
// 條文呈現
// ---------------------------------------------------------------------------
const KUAN_RE = /^([一二三四五六七八九十]+、)/;
const SUB_RE = /^([（(][一二三四五六七八九十]+[）)])/;
const ROMAN = ['Ⅰ', 'Ⅱ', 'Ⅲ', 'Ⅳ', 'Ⅴ', 'Ⅵ', 'Ⅶ', 'Ⅷ', 'Ⅸ', 'Ⅹ', 'Ⅺ', 'Ⅻ'];
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const circ = (n) => CIRCLED[n - 1] || `(${n})`;

function splitPara(t) {
  let m = t.match(KUAN_RE);
  if (m) return { kind: 'kuan', mark: m[1], body: t.slice(m[1].length) };
  m = t.match(SUB_RE);
  if (m) return { kind: 'sub', mark: m[1], body: t.slice(m[1].length) };
  return { kind: 'xiang', mark: '', body: t };
}

function refLink(x, law, piece) {
  const k = `${x.law}/${x.aid}`;
  return x.law === law
    ? `<a class="xref" href="#${k}" data-goto="${k}">${piece}</a>`
    : `<a class="xref ext" href="#${k}" data-ref="${k}">${piece}</a>`;
}

// hls：劃線／註記；xr：條文引用；gloss：註記以小字顯示於文字上方或下方
function renderRich(text, hls, xr, { law, gloss, nums } = {}) {
  const clamp = (v) => Math.max(0, Math.min(text.length, v));
  const cuts = new Set([0, text.length]);
  for (const h of hls) { cuts.add(clamp(h.s)); cuts.add(clamp(h.e)); }
  for (const x of xr) { cuts.add(x.s); cuts.add(x.e); }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    let piece = esc(text.slice(s, e));
    const x = xr.find((r) => r.s <= s && r.e >= e);
    if (x) piece = refLink(x, law, piece);
    let h = null;
    for (const c of hls) if (c.s <= s && c.e >= e) h = c; // 後加者優先
    if (h) {
      const first = s === clamp(h.s);
      const last = e === clamp(h.e);
      let pre = '';
      if (h.n && first && gloss) pre = `<span class="gl gl-${h.pos === 'b' ? 'b' : 'a'}" data-gl="${h.id}"><span class="gl-t">${esc(h.n)}</span></span>`;
      const num = !gloss && h.n && last ? (nums && nums.get(h.id)) || '註' : '';
      piece = `<mark class="hl hl-${h.c || 'n'}${h.n ? ' has-n' : ''}" data-hl="${h.id}"${num ? ` data-n="${num}"` : ''}>${pre}${piece}</mark>`;
    }
    html += piece;
  }
  return html;
}

function noteNumbers(rec) {
  const m = new Map();
  ((rec && rec.hl) || []).filter((h) => h.n).sort((x, y) => x.p - y.p || x.s - y.s).forEach((h, i) => m.set(h.id, i + 1));
  return m;
}

function renderParas(o, a, rec, { side = false } = {}) {
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  const nums = noteNumbers(rec);
  const gloss = settings.noteMode === 'gloss';
  let xi = 0;
  return a.p.map((t, i) => {
    const sp = splitPara(t);
    const hls = ((rec && rec.hl) || []).filter((h) => h.p === i);
    const body = renderRich(sp.body, hls, paraRefs(o, a, i), { law: o.e.id, gloss, nums });
    let gcls = '';
    if (gloss) {
      if (hls.some((h) => h.n && h.pos !== 'b')) gcls += ' has-gla';
      if (hls.some((h) => h.n && h.pos === 'b')) gcls += ' has-glb';
    }
    let para;
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      para = `<p class="para${gcls}"><span class="pn">${pn}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    } else {
      para = `<p class="para ${sp.kind === 'kuan' ? 'kuan' : 'kuan sub'}${gcls}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    }
    if (!side || settings.noteMode !== 'margin') return para;
    let aside = '';
    if (i === 0 && rec && rec.note) aside += `<button class="sn note-side" data-open="${a.id}" data-tab="notes"><b>本條筆記</b>${esc(rec.note)}</button>`;
    for (const h of hls.filter((x) => x.n).sort((x, y) => x.s - y.s)) {
      aside += `<button class="sn" data-sn="${h.id}"><b>${circ(nums.get(h.id))}</b>${esc(h.n)}</button>`;
    }
    return `<div class="prow">${para}<aside class="pside">${aside}</aside></div>`;
  }).join('');
}

function stickiesHTML(rec) {
  return ((rec && rec.st) || []).map((s) => `<div class="sticky st-${s.c || 'y'}${s.min ? ' min' : ''}" data-st="${s.id}" style="left:${s.x}em;top:${s.y}em;width:${s.min ? 1.6 : (s.w || 9)}em"><div class="st-t">${s.min ? '' : (esc(s.t) || '<i>（空白便利貼）</i>')}</div>${s.min ? '' : '<span class="st-rs" aria-hidden="true"></span>'}</div>`).join('');
}

// ----- 計數 -----
function userItems(aid, law = cur) { const r = getRec(aid, false, law); return (r && r.items) || []; }
function rulingCount(o, aid) {
  return (o.R && o.R[aid] ? o.R[aid].length : 0) + (o.X && o.X.judg && o.X.judg[aid] ? o.X.judg[aid].length : 0) +
    (o.X && o.X.interp && o.X.interp[aid] ? o.X.interp[aid].length : 0) + userItems(aid, o.e.id).length;
}
function amendCount(o, aid) { const c = o.D.changes[aid]; return c ? c.length - 1 : 0; }
function hasReasons(o, aid) { return (o.D.changes[aid] || []).some((v) => v.r && v.r.length); }
function pendingNote(o, aid) {
  const p = o.D.meta.pending && o.D.meta.pending[aid];
  return p ? `${roc(p)}修正公布，尚未施行；施行前仍適用修正前條文，可於「新舊對照」查看。` : '';
}

function chipsHTML(o, aid) {
  const rec = getRec(aid, false, o.e.id);
  const out = [];
  if (rec && rec.star) out.push('<span class="chip c-star" title="書籤">★</span>');
  if (o.D.meta.pending && o.D.meta.pending[aid]) out.push('<span class="chip c-pend">尚未施行</span>');
  if (settings.chips) {
    const rc = rulingCount(o, aid);
    if (rc) out.push(`<button class="chip c-rul" data-open="${aid}" data-tab="jud">${o.X ? '判決・函釋' : '判解'} ${rc}</button>`);
    if (hasReasons(o, aid)) out.push(`<button class="chip c-rsn" data-open="${aid}" data-tab="reason">立法理由</button>`);
    const ac = amendCount(o, aid);
    if (ac) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">修正 ${ac}</button>`);
    const sub = o.X && o.X.sub && o.X.sub[aid];
    if (sub) out.push(`<button class="chip c-sub" data-open="${aid}" data-tab="rel">子法 ${sub.length}</button>`);
  }
  if (rec && (rec.note || (rec.hl && rec.hl.length) || (rec.st && rec.st.length) || (rec.ink && rec.ink.strokes && rec.ink.strokes.length))) {
    out.push(`<button class="chip c-note" data-open="${aid}" data-tab="notes">註記</button>`);
  }
  return out.join('');
}

// ----- 相關法條 -----
function relItems(o, aid) {
  const out = [];
  const seen = new Set([`${o.e.id}/${aid}`]);
  const add = (law, a2, note, kind) => {
    const k = `${law}/${a2}`;
    if (seen.has(k) || !entry(law)) return;
    seen.add(k);
    out.push({ law, aid: a2, note, kind });
  };
  for (const [law, a2, note] of (o.X && o.X.rel && o.X.rel[aid]) || []) add(law, a2, note, 'cur');
  const a = o.byId.get(aid);
  if (a) a.p.forEach((t, i) => { for (const x of paraRefs(o, a, i)) if (x.law !== o.e.id) add(x.law, x.aid, '', 'txt'); });
  for (const k of XREF[`${o.e.id}:${aid}`] || []) { const [law, a2] = k.split(':'); add(law, a2, '', 'in'); }
  return out;
}
function lawArticle(law, aid) {
  const o = LAWS.get(law);
  return o && o.D ? o.byId.get(aid) : undefined;
}
function relHTML(o, a) {
  if (settings.rel === 'off') return '';
  const items = relItems(o, a.id);
  if (!items.length) return '';
  const main = items.filter((x) => x.kind !== 'in');
  const inc = items.filter((x) => x.kind === 'in');
  let html = '';
  for (const it of main) {
    const t = lawArticle(it.law, it.aid);
    const txt = t ? t.p.join('') : (LAWS.has(it.law) ? '（找不到此條）' : '載入中…');
    html += `<div class="rel-it"><button class="rel-h" data-ref="${it.law}/${it.aid}"><b>${esc(shortName(it.law))}</b> ${aidLabel(it.aid)}</button>${it.note ? `<span class="rel-n">${esc(it.note)}</span>` : ''}${settings.rel === 'text' ? `<div class="rel-t">${esc(txt)}</div>` : ''}</div>`;
  }
  if (inc.length) {
    const by = new Map();
    for (const it of inc) { if (!by.has(it.law)) by.set(it.law, []); by.get(it.law).push(it.aid); }
    for (const [law, aids] of by) {
      html += `<div class="rel-in"><span class="rel-src">${esc(shortName(law))}引用本條</span>${aids.map((x) => `<button class="chip c-ref" data-ref="${law}/${x}">§${x}</button>`).join('')}</div>`;
    }
  }
  return `<div class="arel"><div class="rel-lbl">相關法條</div>${html}</div>`;
}

function articleInner(o, a) {
  const rec = getRec(a.id, false, o.e.id);
  let html = `<div class="art-head"><button class="ano" data-open="${a.id}" title="開啟${aidLabel(a.id)}之判決、理由與註記">${pill(a.id)}</button><span class="chips">${chipsHTML(o, a.id)}</span><button class="mine-ind" data-act="mine-on">已隱藏我的註記 · 顯示</button></div>`;
  if (settings.cap && a.cap) html += `<div class="acap">（${esc(a.cap)}）</div>`;
  html += `<div class="atext">${renderParas(o, a, rec, { side: true })}${stickiesHTML(rec)}</div>`;
  const pn = pendingNote(o, a.id);
  if (pn) html += `<div class="pend-note">${esc(pn)}</div>`;
  html += relHTML(o, a);
  if (rec && rec.note) html += `<div class="note-peek">${esc(rec.note)}</div>`;
  return html;
}

function renderReader() {
  const o = L;
  const parts = [`<header class="law-title"><h1>${esc(o.D.meta.name)}</h1><p>${esc(o.D.meta.kind || '')}　修正日期 ${roc(o.D.meta.modified)}　共 ${o.D.articles.length} 條</p></header>`];
  const hlevelClass = ['h-part', 'h-chap', 'h-sec', 'h-sub', 'h-sub'];
  const firstOf = new Map();
  o.D.headings.forEach((h, i) => {
    if (h.first) { if (!firstOf.has(h.first)) firstOf.set(h.first, []); firstOf.get(h.first).push(i); }
  });
  for (const a of o.D.articles) {
    for (const hi of firstOf.get(a.id) || []) {
      const h = o.D.headings[hi];
      const tag = h.lv === 0 ? 'h2' : h.lv === 1 ? 'h3' : 'h4';
      parts.push(`<${tag} class="${hlevelClass[h.lv]}" id="h-${hi}" style="--ac:var(--c-${h.c})">${esc(h.t)}</${tag}>`);
    }
    const hid = hiddenArts.has(key(a.id)) ? ' mine-off' : '';
    parts.push(`<article class="art${a.del ? ' deleted' : ''}${hid}" id="a-${a.id}" data-id="${a.id}" style="--ac:var(--c-${artColor(o, a)})">${articleInner(o, a)}</article>`);
  }
  const inner = $('#reader-inner');
  inner.innerHTML = parts.join('');
  inner.classList.toggle('no-pn', !settings.pn);
  $$('.art', inner).forEach((el) => ink.observe(el));
  requestAnimationFrame(() => fitGlosses(inner));
}

function refreshArticle(aid) {
  const el = document.getElementById('a-' + aid);
  if (el) {
    el.innerHTML = articleInner(L, L.byId.get(aid));
    ink.refresh(aid);
    requestAnimationFrame(() => fitGlosses(el));
  }
  if (current === aid) renderDetailText();
}
function refreshChips(aid) {
  const el = document.querySelector(`#a-${CSS.escape(aid)} .chips`);
  if (el) el.innerHTML = chipsHTML(L, aid);
}
function refreshAllRel() {
  for (const el of $$('#reader .art')) {
    const a = L.byId.get(el.dataset.id);
    if (!a) continue;
    const old = $('.arel', el);
    const html = relHTML(L, a);
    if (old) old.outerHTML = html || '';
    else if (html) {
      const after = $('.pend-note', el) || $('.atext', el);
      after.insertAdjacentHTML('afterend', html);
    }
  }
}

// 註記小字避免重疊：同一行的註記依位置截短，點選可看全文
function fitGlosses(root) {
  const els = $$('.gl-t', root || document);
  if (!els.length) return;
  for (const el of els) { el.style.maxWidth = ''; el.style.left = ''; }
  const groups = new Map();
  for (const el of els) {
    const host = el.closest('.atext');
    if (!host || !el.offsetParent) continue;
    if (!groups.has(host)) groups.set(host, []);
    groups.get(host).push({ el, r: el.getBoundingClientRect(), b: el.parentElement.classList.contains('gl-b') });
  }
  for (const [host, arr] of groups) {
    const hr = host.getBoundingClientRect();
    for (const g of arr) {
      let limit = hr.right - g.r.left - 2;
      for (const h of arr) {
        if (h === g || h.b !== g.b) continue;
        if (Math.abs(h.r.top - g.r.top) < g.r.height * 0.8 && h.r.left > g.r.left + 1) limit = Math.min(limit, h.r.left - g.r.left - 6);
      }
      if (limit < 40) { g.el.style.left = (limit - 40) + 'px'; limit = 40; }
      g.el.style.maxWidth = Math.floor(limit) + 'px';
    }
  }
}

// ---------------------------------------------------------------------------
// 目錄與書架
// ---------------------------------------------------------------------------
function lastArticleOf(hi) {
  const hs = L.D.headings;
  const h = hs[hi];
  let next = null;
  for (let j = hi + 1; j < hs.length; j++) if (hs[j].lv <= h.lv) { next = hs[j]; break; }
  if (!next) return L.order[L.order.length - 1];
  const idx = L.order.indexOf(next.first);
  return L.order[idx - 1];
}
function renderTOC() {
  const hs = L.D.headings;
  const kids = new Map();
  hs.forEach((h, i) => { if (!kids.has(h.p)) kids.set(h.p, []); kids.get(h.p).push(i); });
  const build = (pi) => (kids.get(pi) || []).map((i) => {
    const h = hs[i];
    const sub = kids.get(i);
    const rng = h.first ? `${h.first}–${lastArticleOf(i)}` : '';
    return `<div class="toc-part"><button class="toc-btn lv${h.lv}" data-h="${i}">${sub ? `<span class="caret" data-toggle="${i}">›</span>` : '<span class="caret"></span>'}${h.lv === 0 ? `<i class="cdot" style="background:var(--c-${h.c})"></i>` : ''}<span>${esc(h.t)}</span><span class="rng">${rng}</span></button>${sub ? `<div class="toc-kids" id="tk-${i}" hidden>${build(i)}</div>` : ''}</div>`;
  }).join('');
  const m = L.D.meta;
  const parent = m.parent && entry(m.parent);
  $('#side-toc').innerHTML = `<div class="toc-law"><div><b>${esc(m.name)}</b><small>${esc(m.kind || '')}・${L.D.articles.length} 條${parent ? `・母法 <a href="#${parent.id}" data-law="${parent.id}">${esc(parent.short)}</a>` : ''}</small></div><button class="btn small" data-act="shelf">切換法典</button></div>` +
    (hs.length ? build(-1) : '<p class="side-note">本法規未分章節。</p>') +
    `<p class="side-note">條號顏色依章別區分。資料來源：全國法規資料庫${m.reasons ? '、立法院法律系統（立法理由）' : ''}；修正日期 ${roc(m.modified)}。</p>`;
}
function tocExpandTo(hi) {
  let x = hi;
  while (x >= 0) {
    const k = document.getElementById('tk-' + x);
    if (k) { k.hidden = false; const c = $(`[data-toggle="${x}"]`); if (c) c.classList.add('open'); }
    x = L.D.headings[x].p;
  }
}
const trackTOC = debounce(() => {
  const top = $('#reader').getBoundingClientRect().top + 80;
  let c = -1;
  for (const el of $$('#reader-inner > h2, #reader-inner > h3, #reader-inner > h4')) {
    if (el.getBoundingClientRect().top < top) c = +el.id.slice(2); else break;
  }
  $$('.toc-btn.cur').forEach((b) => b.classList.remove('cur'));
  if (c >= 0) { const b = $(`.toc-btn[data-h="${c}"]`); if (b) b.classList.add('cur'); }
}, 160);

function renderBrand() {
  const e = entry(cur);
  $('#brand-mark').textContent = (e.short || e.name)[0];
  $('#brand-mark').style.background = `var(--c-${e.group === '職業安全衛生' ? 'green' : e.group === '勞動法' ? 'teal' : 'blue'})`;
  $('#brand-name').textContent = e.name;
  document.title = `${e.short}・法典註記本`;
  $('#q').placeholder = `搜尋${e.short}或全部法典；輸入 6、勞基法59 直接跳轉`;
}
function openShelf() {
  const cnt = new Map();
  notes.forEach((r, k) => { if (!isEmptyRec(r)) { const l = k.split('/')[0]; cnt.set(l, (cnt.get(l) || 0) + 1); } });
  let html = '';
  for (const g of GROUPS) {
    const ls = LIB.filter((e) => e.group === g);
    if (!ls.length) continue;
    html += `<div class="set-h">${esc(g)}</div><div class="shelf">`;
    html += ls.map((e) => `<button class="shelf-it${e.id === cur ? ' cur' : ''}${e.parent ? ' child' : ''}" data-law="${e.id}"><b>${esc(e.name)}</b><small>${esc(e.kind)}・${e.n} 條・${roc(e.modified, true)}${cnt.get(e.id) ? `・<em>${cnt.get(e.id)} 條有註記</em>` : ''}</small></button>`).join('');
    html += '</div>';
  }
  html += '<p class="callout" style="margin-top:12px">搜尋時可選「全部法典」跨法查詢。條文中引用其他法典（如「勞動基準法第59條」）會以虛線標示，點選即以小字顯示該條。</p>';
  modal({
    title: '法典書架', body: html, buttons: [{ label: '關閉' }],
    onOpen: (body) => {
      body.onclick = (ev) => {
        const b = ev.target.closest('[data-law]');
        if (!b) return;
        $('#modal').close();
        openLaw(b.dataset.law);
      };
    },
  });
}

// ---------------------------------------------------------------------------
// 導覽
// ---------------------------------------------------------------------------
function isNarrow() { return matchMedia('(max-width: 1100px)').matches; }
function setSide(open) {
  if (!isNarrow()) return;
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}
function scrollToEl(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })));
  setTimeout(() => el.scrollIntoView({ block: 'start' }), 180);
}

async function openLaw(id, { aid, tab } = {}) {
  let o;
  try { o = await loadLaw(id); } catch (e) { toast('無法載入：' + e.message); return; }
  if (cur !== id) {
    closeDetail();
    hidePop(); hideRefPop();
    ink.reset();
    cur = id; L = o;
    settings.law = id; saveSettings();
    renderBrand(); renderTOC(); renderReader();
    $('#reader').scrollTop = 0;
    if (!isNarrow() && o.D.headings.length) tocExpandTo(0);
    if (!aid) try { history.replaceState(null, '', '#' + id); } catch {}
    if ($('#side-search').hidden === false && $('#q').value.trim()) doSearch($('#q').value);
    loadAux(o).then(() => {
      if (cur !== id) return;
      if (o.X) refreshAllRel();
      for (const a of o.D.articles) if (rulingCount(o, a.id) || (o.X && o.X.sub && o.X.sub[a.id])) refreshChips(a.id);
      if (current) renderDetail();
      // 載入相關法條所需之其他法典
      const need = new Set();
      for (const a of o.D.articles) for (const it of relItems(o, a.id)) if (it.kind !== 'in' && !LAWS.has(it.law)) need.add(it.law);
      if (need.size) Promise.all([...need].map((x) => loadLaw(x).catch(() => null))).then(() => { if (cur === id) { refreshAllRel(); if (current && detailTab === 'rel') renderDetail(); } });
    });
  }
  if (aid) gotoArticle(id, aid, { tab });
}

async function gotoArticle(law, aid, { open = true, flash = true, tab } = {}) {
  if (law !== cur) { await openLaw(law); }
  if (!L.byId.has(aid)) { toast(`${shortName(law)}沒有${aidLabel(aid)}`); return; }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  tocExpandTo(L.byId.get(aid).h);
  setSide(false);
  if (open) openDetail(aid, tab);
}
function gotoHeading(hi) {
  scrollToEl(document.getElementById('h-' + hi));
  setSide(false);
}
function goRef(ref, opts) { const [law, aid] = ref.split('/'); return gotoArticle(law, aid, opts); }

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
  try { history.replaceState(null, '', `#${cur}/${aid}`); } catch {}
  renderDetail();
}
function closeDetail() {
  if (current) document.getElementById('a-' + current)?.classList.remove('sel');
  current = null;
  $('#detail').hidden = true;
  try { if (cur) history.replaceState(null, '', '#' + cur); } catch {}
}
function renderDetailText() {
  const a = L.byId.get(current);
  const rec = getRec(current);
  const el = $('#d-text');
  el.dataset.id = current;
  el.style.setProperty('--ac', `var(--c-${artColor(L, a)})`);
  el.innerHTML = (settings.cap && a.cap ? `<div class="acap">（${esc(a.cap)}）</div>` : '') +
    `<div class="atext${settings.pn ? '' : ' no-pn'}">${renderParas(L, a, rec)}</div>` +
    (pendingNote(L, current) ? `<div class="pend-note">${esc(pendingNote(L, current))}</div>` : '');
  el.classList.toggle('mine-off', hiddenArts.has(key(current)));
  requestAnimationFrame(() => fitGlosses(el));
}
function relCount(aid) { return relItems(L, aid).length + ((L.X && L.X.sub && L.X.sub[aid]) || []).length; }
function renderDetail() {
  if (!current) return;
  const a = L.byId.get(current);
  if (!a) { closeDetail(); return; }
  const rec = getRec(current);
  $('#d-no').textContent = `${shortName(cur)} ${aidLabel(current)}`;
  $('#d-no').style.setProperty('--ac', `var(--c-${artColor(L, a)})`);
  $('#d-path').textContent = headingPath(L, a.h).join(' › ') || L.D.meta.name;
  $('#d-star').setAttribute('aria-pressed', rec && rec.star ? 'true' : 'false');
  renderDetailText();
  const nc = rec ? ((rec.note ? 1 : 0) + (rec.hl ? rec.hl.length : 0) + (rec.st ? rec.st.length : 0) + (rec.ink && rec.ink.strokes && rec.ink.strokes.length ? 1 : 0)) : 0;
  const tabs = [
    ['jud', L.X ? '判決・函釋' : '判解・函釋', rulingCount(L, current)],
    ...(hasReasons(L, current) ? [['reason', '立法理由', '']] : []),
    ['history', '新舊對照', amendCount(L, current)],
    ['rel', '相關法條', relCount(current)],
    ['notes', '我的註記', nc],
  ];
  if (!tabs.some(([k]) => k === detailTab)) detailTab = 'jud';
  $('#d-tabs').innerHTML = tabs.map(([k, l, n]) => `<button role="tab" data-tab="${k}" aria-selected="${k === detailTab}">${l}${n ? ` <b>${n}</b>` : ''}</button>`).join('');
  const body = $('#d-body');
  if (detailTab === 'jud') renderRulings(body);
  else if (detailTab === 'reason') renderReasons(body);
  else if (detailTab === 'history') renderHistory(body);
  else if (detailTab === 'rel') renderRelTab(body);
  else renderNotes(body);
  body.scrollTop = 0;
}

// ----- 判決・函釋 -----
function rulingList(aid) {
  const rec = getRec(aid) || {};
  const imp = rec.imp || {};
  const list = [];
  ((L.X && L.X.judg && L.X.judg[aid]) || []).forEach((r, i) => list.push({ ...r, ty: 'JG', key: 'JG:' + r.no, idx: i }));
  ((L.X && L.X.interp && L.X.interp[aid]) || []).forEach((r, i) => list.push({ ...r, ty: 'IN', key: 'IN:' + r.no, idx: i }));
  ((L.R && L.R[aid]) || []).forEach((r, i) => list.push({ ...r, key: r.ty + ':' + r.no, idx: i }));
  for (const it of rec.items || []) list.push({ ...it, ty: 'U', key: 'U:' + it.id, user: true });
  for (const r of list) r.imp = !!imp[r.key];
  return list;
}
function renderRulings(body) {
  const all = rulingList(current);
  const cnt = (f) => all.filter(f).length;
  const isInterp = (r) => r.ty === 'IN' || (r.ty === 'U' && r.kind === '函釋');
  const filters = [
    ['all', '全部', all.length],
    ['imp', '★ 重要', cnt((r) => r.imp)],
    ['JG', '判決', cnt((r) => r.ty === 'JG' || (r.ty === 'U' && r.kind === '判決'))],
    ['IN', '函釋', cnt(isInterp)],
    ['CJ', '憲法法庭', cnt((r) => r.ty === 'CJ')],
    ['C', '大法官解釋', cnt((r) => r.ty === 'C')],
    ['J', '判例', cnt((r) => r.ty === 'J')],
    ['U', '我的', cnt((r) => r.ty === 'U')],
  ].filter(([k, , n]) => k === 'all' || k === 'U' || n);
  if (!filters.some(([k]) => k === rulFilter)) rulFilter = 'all';
  const pass = (r) => rulFilter === 'all' || (rulFilter === 'imp' ? r.imp : rulFilter === 'IN' ? isInterp(r) : rulFilter === 'JG' ? (r.ty === 'JG' || (r.ty === 'U' && r.kind === '判決')) : r.ty === rulFilter);
  const list = all.filter(pass);
  const tyOrder = { U: 0, JG: 1, IN: 2, CJ: 3, C: 4, J: 5 };
  list.sort((a, b) => (b.imp - a.imp) || ((a.no || '').startsWith('廢') - (b.no || '').startsWith('廢')) || (tyOrder[a.ty] - tyOrder[b.ty]) || ((a.idx ?? 0) - (b.idx ?? 0)));
  const rec = getRec(current) || {};
  let html = `<div class="filters">${filters.map(([k, l, n]) => `<button class="fchip" data-rf="${k}" aria-pressed="${rulFilter === k}">${l}<i>${n}</i></button>`).join('')}</div>`;
  html += `<div class="row-actions" style="margin-bottom:12px"><button class="btn small primary" data-act="add-item">＋ 新增判決／函釋</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/default.aspx" target="_blank" rel="noopener">司法院裁判書查詢</a>
    <a class="btn small" href="https://laws.mol.gov.tw/" target="_blank" rel="noopener">勞動部函釋查詢</a></div>`;
  if (L.X && L.X.note && (all.some((r) => r.ty === 'JG') || all.some((r) => r.ty === 'IN'))) {
    html += `<p class="callout">${esc(L.X.note.judg)}${all.some((r) => r.ty === 'IN') ? '<br>' + esc(L.X.note.interp) : ''}</p>`;
  }
  if (!list.length) html += `<p class="empty">${rulFilter === 'U' ? '尚無自建資料。可新增實務判決、勞動部函釋、決議等，並寫下要旨與個人筆記。' : rulFilter === 'imp' ? '尚未標記重要判決。點卡片右上角的星號即可標記。' : '本條目前沒有收錄的判決或函釋。可按「新增判決／函釋」自行加入。'}</p>`;
  if (all.some((r) => r.ty === 'J')) html += `<p class="callout">判例制度已於民國108年7月4日廢止。依法院組織法第57條之1，未經停止適用之判例，其效力與未經選編為判例之最高法院裁判相同。</p>`;
  for (const r of list) html += rulingCard(r, rec);
  body.innerHTML = html;
}
function rulingCard(r, rec) {
  const isVoid = (r.no || '').startsWith('廢');
  const rnote = rec.rnote && rec.rnote[r.key];
  const rich = (t) => renderRich(t, [], textRefs(t, cur), { law: cur });
  let typeLabel = r.ty === 'U' ? (r.kind || '其他') : TYPE_LABEL[r.ty];
  let parts = r.user ? (r.text ? [['要旨', r.text]] : []) : (r.parts || []);
  let extra = '';
  if (r.ty === 'JG') {
    typeLabel = `${r.court}${r.sys ? r.sys : ''}`;
    parts = [['判決摘錄', r.text]];
    if (r.old) extra += '<span class="tpill tp-old">舊法：勞工安全衛生法</span>';
    if (r.nsame) extra += `<span class="tpill tp-same">同旨 ${r.nsame} 則</span>`;
  } else if (r.ty === 'IN') {
    parts = [['判決所述', r.text]];
  }
  const partsHTML = parts.map(([lbl, txt]) => `<div class="rpart${txt.length > 260 ? ' clamp' : ''}"><span class="lbl">${esc(lbl)}</span>${rich(txt)}</div>`).join('');
  let more = '';
  if (r.ty === 'JG' && r.same && r.same.length) more = `<details class="rsame"><summary>同旨判決 ${r.nsame} 則</summary>${r.same.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.no)}</a>`).join('')}${r.nsame > r.same.length ? '<span>…</span>' : ''}</details>`;
  if (r.ty === 'IN' && r.from && r.from.length) more = `<details class="rsame"><summary>引用此函釋之判決 ${r.n} 則</summary>${r.from.map((s) => `<a href="https://judgment.judicial.gov.tw/FJUD/data.aspx?ty=JD&id=${encodeURIComponent(s.id)}" target="_blank" rel="noopener">${esc(s.no)}</a>`).join('')}</details>`;
  return `<article class="rcard${r.imp ? ' imp' : ''}${isVoid ? ' void' : ''}" data-key="${esc(r.key)}">
    <div class="rhead"><span class="tpill tp-${r.ty}">${esc(typeLabel)}</span>${isVoid ? '<span class="tpill tp-void">不再援用</span>' : ''}${extra}
      <span class="rno">${esc(isVoid ? r.no.slice(1) : r.no)}</span><span class="rdate">${esc(r.date || '')}${r.cause ? '・' + esc(r.cause) : ''}</span>
      <button class="rstar" data-act="imp" aria-pressed="${r.imp}" aria-label="標記重要"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"/></svg></button></div>
    ${partsHTML}${more}
    ${rnote ? `<div class="rnote">${esc(rnote)}</div>` : ''}
    <div class="rfoot">
      ${parts.some(([, t]) => t.length > 260) ? '<button class="linkish" data-act="expand">展開全文</button>' : ''}
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">原文</a>` : ''}
      ${r.user ? '<button class="linkish" data-act="edit-item">編輯</button>' : `<button class="linkish" data-act="rnote">${rnote ? '編輯筆記' : '加筆記'}</button>`}
    </div></article>`;
}

// ----- 立法理由 -----
function renderReasons(body) {
  const vs = (L.D.changes[current] || []).map((v, i) => ({ ...v, i })).filter((v) => v.r && v.r.length).reverse();
  if (!vs.length) { body.innerHTML = '<p class="empty">本條沒有收錄立法理由。</p>'; return; }
  let html = `<p class="callout">立法理由與歷次修正理由取自立法院法律系統（三讀通過時之條文及說明）。${L.D.meta.name === '職業安全衛生法' ? '民國102年全文修正前之名稱為「勞工安全衛生法」，條次多有變動，「原條次」為當時之條號。' : ''}</p>`;
  for (const v of vs) {
    html += `<section class="rsn k-${v.k}"><header><b>${roc(v.d)}${v.k === 'orig' ? '制定' : v.k === 'new' ? '增訂' : v.k === 'renum' ? '條次變更' : '修正'}公布</b><small>${v.pass ? `三讀通過 ${roc(v.pass, true)}` : ''}${v.no ? `・原條次${aidLabel(v.no)}` : ''}</small></header>
      <details><summary>當時條文</summary><div class="rsn-p">${v.p.map((p) => `<p>${esc(p)}</p>`).join('')}</div></details>
      <div class="rsn-r">${v.r.map((p) => `<p>${renderRich(p, [], textRefs(p, cur), { law: cur })}</p>`).join('')}</div></section>`;
  }
  body.innerHTML = html;
}

// ----- 新舊對照 -----
function histItemFor(d) { return (L.D.histories || []).find((h) => h.dates.includes(d)); }
function renderHistory(body) {
  const a = L.byId.get(current);
  const vs = (L.D.changes[current] || []).map((h, i) => ({ ...h, i }));
  if (vs.length < 2) {
    body.innerHTML = `<p class="empty">${aidLabel(current)}${vs.length ? `自${roc(vs[0].d)}${KIND_LABEL[vs[0].k] || ''}以來，` : ''}未曾修正${vs.length ? '' : '（或資料庫無歷次版本）'}。</p>
      <p class="callout">新舊對照依立法院法律系統或全國法規資料庫之歷次條文逐條比對產生；僅標點或個別字之資料庫勘誤不列為修正。</p>`;
    return;
  }
  const pend = L.D.meta.pending || {};
  if (!cmpSel || cmpSel.aid !== current) cmpSel = { aid: current, a: vs.length - 2, b: vs.length - 1 };
  const lbl = (v) => `${roc(v.d, true)} ${KIND_LABEL[v.k] || ''}${v.no ? `（原${aidLabel(v.no)}）` : ''}${pend[current] === v.d ? '（未施行）' : ''}`;
  const opt = (sel) => vs.map((v) => `<option value="${v.i}"${v.i === sel ? ' selected' : ''}>${lbl(v)}</option>`).join('');
  let html = '<ol class="timeline">';
  for (const v of [...vs].reverse()) {
    const it = histItemFor(v.d);
    html += `<li class="tl k-${v.k}${pend[current] === v.d ? ' pend' : ''}"><span class="dot"></span><div><b>${roc(v.d)}</b><small>${KIND_LABEL[v.k] || ''}${v.no ? `・當時為${aidLabel(v.no)}` : ''}${pend[current] === v.d ? '・尚未施行' : ''}${it ? `・沿革第 ${it.n} 點` : ''}</small></div>
      ${v.i > 0 ? `<button class="linkish kind" data-cmp="${v.i}">與前版比較</button>` : '<span class="kind">最早條文</span>'}</li>`;
  }
  html += '</ol>';
  html += `<div class="cmp-ctl"><label for="cmp-b">新</label><select id="cmp-b">${opt(cmpSel.b)}</select>
    <label for="cmp-a">舊</label><select id="cmp-a">${opt(cmpSel.a)}</select>
    <span class="segs" role="group" aria-label="顯示方式"><button type="button" data-cm="table" aria-pressed="${cmpMode === 'table'}">對照表</button><button type="button" data-cm="inline" aria-pressed="${cmpMode === 'inline'}">標示差異</button></span></div>`;
  const A = vs[cmpSel.a], B = vs[cmpSel.b];
  const older = A.p2 && cmpSel.a < cmpSel.b ? A.p2 : A.p;
  const dd = diffParas(older, B.p);
  const nm = (v) => v.no ? `・原${aidLabel(v.no)}` : '';
  if (cmpMode === 'table') {
    html += `<div class="cmp-wrap"><table class="cmp"><thead><tr><th>${cmpSel.b > cmpSel.a ? '修正條文' : '條文'}（${roc(B.d, true)}${nm(B)}）</th><th>${cmpSel.b > cmpSel.a ? '修正前條文' : '條文'}（${roc(A.d, true)}${nm(A)}）</th></tr></thead>
      <tbody><tr><td>${dd.new}</td><td>${dd.old}</td></tr></tbody></table></div>`;
  } else html += `<div class="inline-diff">${dd.inline}</div>`;
  html += `<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>`;
  if (B.r && B.r.length) html += `<div class="hist-item"><b>${roc(B.d, true)} ${KIND_LABEL[B.k] === '制定' ? '立法' : '修正'}理由</b>${B.r.map((p) => `<p>${esc(p)}</p>`).join('')}</div>`;
  const it = histItemFor(B.d);
  if (it) html += `<div class="hist-item"><b>沿革第 ${it.n} 點</b><br>${esc(it.t)}${it.cmp || it.desc ? `<div class="row-actions" style="margin-top:6px">${it.cmp ? `<a class="btn small" href="${esc(it.cmp)}" target="_blank" rel="noopener">條文對照表（PDF）</a>` : ''}${it.desc ? `<a class="btn small" href="${esc(it.desc)}" target="_blank" rel="noopener">修正總說明</a>` : ''}</div>` : ''}</div>`;
  html += `<p class="callout" style="margin-top:12px">完整沿革：<a href="https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=${esc(L.D.meta.pcode)}" target="_blank" rel="noopener">全國法規資料庫</a>${L.D.meta.reasons ? '、<a href="https://lis.ly.gov.tw/lglawc/lglawkm" target="_blank" rel="noopener">立法院法律系統</a>' : ''}。</p>`;
  body.innerHTML = html;
}

// ----- 相關法條 -----
function renderRelTab(body) {
  const items = relItems(L, current);
  const sub = (L.X && L.X.sub && L.X.sub[current]) || [];
  let html = '';
  const missing = [...new Set(items.map((x) => x.law).filter((l) => !LAWS.has(l) || !LAWS.get(l).D))];
  if (missing.length) {
    html += '<p class="empty">載入相關法典中…</p>';
    Promise.all(missing.map((l) => loadLaw(l).catch(() => null))).then(() => { if (detailTab === 'rel') renderDetail(); });
  }
  const sec = (title, list) => {
    if (!list.length) return '';
    return `<div class="set-h">${title}</div>` + list.map((it) => {
      const t = lawArticle(it.law, it.aid);
      return `<div class="relc"><div class="relc-h"><button class="linkish" data-goto="${it.law}/${it.aid}"><b>${esc(shortName(it.law))} ${aidLabel(it.aid)}</b></button>${t && t.cap ? `<small>（${esc(t.cap)}）</small>` : ''}${it.note ? `<small>${esc(it.note)}</small>` : ''}</div>
        <div class="relc-t">${t ? t.p.map((p) => `<p>${esc(p)}</p>`).join('') : '…'}</div></div>`;
    }).join('');
  };
  html += sec('相關條文', items.filter((x) => x.kind === 'cur'));
  html += sec('本條引用之其他法典', items.filter((x) => x.kind === 'txt'));
  html += sec('引用本條之子法／其他法典', items.filter((x) => x.kind === 'in'));
  if (sub.length) {
    html += '<div class="set-h">依本條授權訂定之子法（全國法規資料庫）</div><ul class="sub-list">' + sub.map((s) => `<li>${s.law ? `<button class="linkish" data-law="${s.law}">${esc(s.name)}</button>` : `<a href="https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=${esc(s.pcode)}" target="_blank" rel="noopener">${esc(s.name)}</a>`}<small>${esc(s.date)}</small></li>`).join('') + '</ul>';
  }
  if (!html) html = '<p class="empty">本條沒有收錄相關法條。條文中若引用書架上的其他法典，會自動列在這裡。</p>';
  body.innerHTML = html;
}

// ----- 我的註記 -----
function allTags() {
  const s = new Set();
  notes.forEach((r) => (r.tags || []).forEach((t) => s.add(t)));
  return [...s].sort();
}
function renderNotes(body) {
  const rec = getRec(current) || {};
  const hls = rec.hl || [];
  const sts = rec.st || [];
  const strokes = rec.ink && rec.ink.strokes ? rec.ink.strokes.length : 0;
  const a = L.byId.get(current);
  const qText = (h) => splitPara(a.p[h.p] || '').body.slice(h.s, h.e);
  let html = `<div class="field"><label for="note-text">文字筆記</label>
    <textarea class="note" id="note-text" placeholder="寫下要件、爭點、實務見解、考點…">${esc(rec.note || '')}</textarea>
    <span class="saved" id="note-saved">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div>`;
  html += `<div class="field"><label for="tag-input">標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" id="tag-input" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點、實務見解" enterkeyhint="done">
    <datalist id="tag-list">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>`;
  html += `<div class="field"><span class="lbl">劃線與小字註記（${hls.length}）</span>`;
  html += hls.length ? `<ul class="hl-list">${hls.map((h) => `<li><div><span class="q"><mark class="hl hl-${h.c || 'n'}">${esc(qText(h))}</mark></span>${h.n ? `<span class="n"><b class="pos">${h.pos === 'b' ? '下' : '上'}</b>${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions"><button class="linkish" data-act="hl-note" data-id="${h.id}">${h.n ? '改註' : '加註'}</button><button class="linkish" data-act="hl-del" data-id="${h.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">在條文上選取文字，即可劃線，或在文字上方／下方加紅色小字註記。</p>';
  html += '</div>';
  html += `<div class="field"><span class="lbl">便利貼（${sts.length}）</span>
    ${sts.length ? `<ul class="hl-list">${sts.map((s) => `<li><div><span class="q st-sw st-${s.c || 'y'}"></span>${esc(s.t || '（空白）')}</div><div class="row-actions"><button class="linkish" data-act="st-edit" data-id="${s.id}">編輯</button></div></li>`).join('')}</ul>` : ''}
    <div class="row-actions"><button class="btn small" data-act="st-add">＋ 新增便利貼</button></div></div>`;
  html += `<div class="field"><span class="lbl">手寫（${strokes} 筆）</span>
    <div class="row-actions"><button class="btn small" data-act="ink-on">在條文上手寫</button>${strokes ? '<button class="btn small danger" data-act="ink-clear">清除本條手寫</button>' : ''}</div>
    ${ink.layoutShifted(current) ? '<p class="ink-warn">版面寬度與書寫時不同，手寫位置可能略有偏移。</p>' : ''}</div>`;
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
// 劃線、小字註記
// ---------------------------------------------------------------------------
let pendingSel = null; // {aid, parts:[{p,s,e}], rect}
let activeHl = null;   // {aid, id}

// 選取位置換算成條文字元位置（略過註記小字）
function offsetIn(pt, node, off) {
  const r = document.createRange();
  r.selectNodeContents(pt);
  try { r.setEnd(node, off); } catch { return null; }
  let n = 0;
  const w = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT);
  let x;
  while ((x = w.nextNode())) {
    if (x.parentElement.closest('.gl')) continue;
    if (x === r.endContainer) { n += r.endOffset; break; }
    if (!r.intersectsNode(x)) break;
    n += x.length;
  }
  return n;
}
function textLen(pt) {
  let n = 0;
  const w = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT);
  let x;
  while ((x = w.nextNode())) if (!x.parentElement.closest('.gl')) n += x.length;
  return n;
}
function captureSelection() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return null;
  const range = sel.getRangeAt(0);
  const c = range.commonAncestorContainer;
  const host = (c.nodeType === 1 ? c : c.parentElement)?.closest('[data-id]');
  if (!host || !(host.classList.contains('art') || host.id === 'd-text')) return null;
  const aid = host.dataset.id;
  const parts = [];
  for (const pt of $$('.pt', host)) {
    if (!range.intersectsNode(pt)) continue;
    const len = textLen(pt);
    let s = 0, e = len;
    if (pt.contains(range.startContainer)) s = offsetIn(pt, range.startContainer, range.startOffset) ?? 0;
    if (pt.contains(range.endContainer)) e = offsetIn(pt, range.endContainer, range.endOffset) ?? len;
    if (e > s) parts.push({ p: +pt.dataset.p, s, e });
  }
  if (!parts.length) return null;
  return { aid, parts, rect: range.getBoundingClientRect(), host };
}
function placePop(pop, rect) {
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.bottom + 10;
  if (y + ph > innerHeight - 70) y = rect.top - ph - 10;
  x = Math.max(8, Math.min(innerWidth - pw - 8, x));
  y = Math.max(8, Math.min(innerHeight - ph - 8, y));
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}
function showPop(rect, h, num) {
  const pop = $('#hl-pop');
  pop.hidden = false;
  const existing = !!h;
  $$('[data-hl="del"], [data-hl="flip"], [data-hl="note"]', pop).forEach((b) => { b.hidden = !existing; });
  $$('[data-hl="gla"], [data-hl="glb"], [data-hl="sticky"]', pop).forEach((b) => { b.hidden = existing; });
  $('[data-hl="flip"]', pop).hidden = !existing || !h.n;
  $('[data-hl="flip"]', pop).textContent = h && h.pos === 'b' ? '移到上方' : '移到下方';
  const pn = $('#pop-note');
  pn.hidden = !(h && h.n);
  pn.innerHTML = h && h.n ? `${num ? `<b>${circ(num)}</b>` : ''}${esc(h.n)}` : '';
  $('[data-hl="note"]', pop).textContent = h && h.n ? '改註' : '加註';
  placePop(pop, rect);
}
function hidePop() { $('#hl-pop').hidden = true; pendingSel = null; activeHl = null; }

const onSelChange = debounce(() => {
  if (ink.active) return;
  const c = captureSelection();
  if (c) { pendingSel = c; activeHl = null; showPop(c.rect, null, 0); }
  else if (!activeHl && !$('#hl-pop').matches(':hover')) $('#hl-pop').hidden = true;
}, 280);

function afterNoteChange(aid) {
  saveRec(aid); refreshArticle(aid); refreshChips(aid);
  if (current === aid) renderDetail();
}
function applyHighlight(act) {
  if (activeHl) {
    const { aid, id } = activeHl;
    const r = getRec(aid, true);
    const h = (r.hl || []).find((x) => x.id === id);
    if (!h) return hidePop();
    hidePop();
    if (act === 'del') r.hl = r.hl.filter((x) => x.id !== h.id);
    else if (act === 'note') return editHlNote(aid, id);
    else if (act === 'flip') h.pos = h.pos === 'b' ? 'a' : 'b';
    else h.c = act;
    return afterNoteChange(aid);
  }
  if (!pendingSel) return;
  const { aid, parts, rect, host } = pendingSel;
  if (act === 'sticky') {
    const at = (host.classList.contains('art') ? $('.atext', host) : document.querySelector(`#a-${CSS.escape(aid)} .atext`));
    window.getSelection()?.removeAllRanges();
    hidePop();
    let x = 1, y = 0;
    if (at && host.classList.contains('art')) {
      const ar = at.getBoundingClientRect(), em = parseFloat(getComputedStyle(at).fontSize) || 18;
      x = Math.max(0, (rect.left - ar.left) / em);
      y = Math.max(0, (rect.bottom - ar.top) / em + 0.15);
    }
    return addSticky(aid, x, y);
  }
  const r = getRec(aid, true);
  r.hl = r.hl || [];
  const ids = [];
  const gloss = act === 'gla' || act === 'glb';
  for (const pt of parts) {
    const h = { id: uid(), p: pt.p, s: pt.s, e: pt.e, c: gloss ? 'n' : act };
    if (gloss) h.pos = act === 'glb' ? 'b' : 'a';
    r.hl.push(h);
    ids.push(h.id);
  }
  window.getSelection()?.removeAllRanges();
  hidePop();
  afterNoteChange(aid);
  if (gloss) editHlNote(aid, ids[0], true);
}

// ---------------------------------------------------------------------------
// 參照條文（其他法典）小字彈出
// ---------------------------------------------------------------------------
async function showRefPop(ref, rect) {
  const [law, aid] = ref.split('/');
  const pop = $('#ref-pop');
  pop.hidden = false;
  $('#ref-body').innerHTML = '<p class="ref-t">載入中…</p>';
  placePop(pop, rect);
  let o;
  try { o = await loadLaw(law); } catch (e) { $('#ref-body').innerHTML = `<p class="ref-t">無法載入：${esc(e.message)}</p>`; return; }
  const a = o.byId.get(aid);
  pop.dataset.ref = ref;
  $('#ref-body').innerHTML = `<div class="ref-h" style="--ac:var(--c-${a ? artColor(o, a) : 'blue'})"><span class="ano sm">${esc(o.e.short)} ${a ? pill(aid) : aidLabel(aid)}</span>${a && a.cap ? `<small>（${esc(a.cap)}）</small>` : ''}</div>` +
    (a ? `<div class="ref-t">${a.p.map((p) => `<p>${esc(p)}</p>`).join('')}</div>` : `<p class="ref-t">${esc(o.e.name)}沒有${aidLabel(aid)}。</p>`);
  placePop(pop, rect);
}
function hideRefPop() { $('#ref-pop').hidden = true; }

// ---------------------------------------------------------------------------
// 便利貼
// ---------------------------------------------------------------------------
function addSticky(aid, x, y) {
  const r = getRec(aid, true);
  r.st = r.st || [];
  const s = { id: uid(), x: Math.round(x * 100) / 100, y: Math.round(y * 100) / 100, w: 9, c: 'y', t: '' };
  r.st.push(s);
  afterNoteChange(aid);
  editSticky(aid, s.id, true);
}
function editSticky(aid, id, isNew) {
  const r = getRec(aid, true);
  const s = (r.st || []).find((x) => x.id === id);
  if (!s) return;
  const colors = [['y', '黃'], ['p', '粉'], ['b', '藍'], ['g', '綠'], ['c', '透明']];
  const widths = [[6, '窄'], [9, '中'], [13, '寬'], [18, '特寬']];
  let col = s.c || 'y', wid = s.w || 9;
  modal({
    title: `${aidLabel(aid)}・便利貼`,
    body: `<textarea class="note" id="m-st" placeholder="寫在便利貼上的內容（顯示為半透明，不遮住條文）">${esc(s.t || '')}</textarea>
      <div class="set-row"><span class="l">顏色</span><span class="segs" id="m-stc">${colors.map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${k === col}"><i class="st-sw st-${k}"></i>${l}</button>`).join('')}</span></div>
      <div class="set-row"><span class="l">寬度</span><span class="segs" id="m-stw">${widths.map(([k, l]) => `<button type="button" data-v="${k}" aria-pressed="${k === wid}">${l}</button>`).join('')}</span></div>
      <p class="callout">在條文上可直接拖曳便利貼移動位置，拖曳右下角可調整寬度。</p>`,
    buttons: [
      { label: '刪除', cls: 'danger', onClick: () => { r.st = r.st.filter((x) => x.id !== id); afterNoteChange(aid); toast('已刪除便利貼'); } },
      { label: s.min ? '展開' : '縮小', onClick: () => { s.min = !s.min; afterNoteChange(aid); } },
      { label: '儲存', cls: 'primary', onClick: () => { s.t = $('#m-st').value.trim(); s.c = col; s.w = wid; afterNoteChange(aid); } },
    ],
    onOpen: (body) => {
      $('#m-stc', body).onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; col = b.dataset.v; $$('#m-stc button').forEach((x) => x.setAttribute('aria-pressed', x === b)); };
      $('#m-stw', body).onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; wid = +b.dataset.v; $$('#m-stw button').forEach((x) => x.setAttribute('aria-pressed', x === b)); };
      if (isNew) setTimeout(() => $('#m-st')?.focus(), 50);
    },
  });
}
function bindStickies() {
  let drag = null;
  const reader = $('#reader');
  reader.addEventListener('pointerdown', (e) => {
    const el = e.target.closest('.sticky');
    if (!el || ink.active) return;
    const art = el.closest('.art');
    const at = el.closest('.atext');
    const em = parseFloat(getComputedStyle(at).fontSize) || 18;
    const rec = getRec(art.dataset.id);
    const s = rec && (rec.st || []).find((x) => x.id === el.dataset.st);
    if (!s) return;
    drag = { el, s, aid: art.dataset.id, em, x0: e.clientX, y0: e.clientY, sx: s.x, sy: s.y, sw: s.w || 9, resize: !!e.target.closest('.st-rs'), moved: false, id: e.pointerId };
    el.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  reader.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = (e.clientX - drag.x0) / drag.em, dy = (e.clientY - drag.y0) / drag.em;
    if (!drag.moved && Math.hypot(e.clientX - drag.x0, e.clientY - drag.y0) < 6) return;
    drag.moved = true;
    drag.el.classList.add('dragging');
    if (drag.resize) { drag.s.w = Math.max(4, Math.round((drag.sw + dx) * 10) / 10); drag.el.style.width = drag.s.w + 'em'; }
    else {
      drag.s.x = Math.max(-1, Math.round((drag.sx + dx) * 100) / 100);
      drag.s.y = Math.max(-1, Math.round((drag.sy + dy) * 100) / 100);
      drag.el.style.left = drag.s.x + 'em';
      drag.el.style.top = drag.s.y + 'em';
    }
  });
  const end = (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const d = drag;
    drag = null;
    d.el.classList.remove('dragging');
    if (d.moved) saveRec(d.aid);
    else if (e.type === 'pointerup') {
      if (d.s.min) { d.s.min = false; afterNoteChange(d.aid); } else editSticky(d.aid, d.s.id);
    }
  };
  reader.addEventListener('pointerup', end);
  reader.addEventListener('pointercancel', end);
}

// ---------------------------------------------------------------------------
// 我的註記：顯示／隱藏（全域按鈕，或以手指點兩下單條切換）
// ---------------------------------------------------------------------------
function setShowMine(on) {
  settings.showMine = on;
  saveSettings();
  document.body.classList.toggle('mine-off', !on);
  $('#btn-eye').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#btn-eye').title = on ? '隱藏我的註記' : '顯示我的註記';
  if (on) requestAnimationFrame(() => fitGlosses());
}
function toggleArtMine(art, force) {
  const aid = art.dataset.id;
  const k = key(aid);
  const off = force !== undefined ? !force : !hiddenArts.has(k);
  if (off) hiddenArts.add(k); else hiddenArts.delete(k);
  art.classList.toggle('mine-off', off);
  if (current === aid) $('#d-text').classList.toggle('mine-off', off);
  if (!off) requestAnimationFrame(() => fitGlosses(art));
  const rec = getRec(aid);
  if (!isEmptyRec(rec)) toast(off ? `已隱藏${aidLabel(aid)}的註記（再點兩下顯示）` : `顯示${aidLabel(aid)}的註記`);
}
function bindTapToggle() {
  let last = null;
  const handler = (e) => {
    if (e.pointerType !== 'touch' || ink.active || settings.tapToggle === 'off') return;
    if (e.target.closest('a, button, input, textarea, select, .sticky, .hl, .rel-t, summary')) return;
    const art = e.target.closest('.art');
    if (!art || !e.target.closest('.atext, .acap')) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const now = performance.now();
    if (settings.tapToggle === 'single') { toggleArtMine(art); return; }
    if (last && last.art === art && now - last.t < 380 && Math.hypot(e.clientX - last.x, e.clientY - last.y) < 40) {
      last = null;
      toggleArtMine(art);
      e.preventDefault();
      return;
    }
    last = { t: now, x: e.clientX, y: e.clientY, art };
  };
  $('#reader').addEventListener('pointerup', handler);
}

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------
function modal({ title, body, buttons, onOpen }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-body').onclick = null;
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
  if (!dlg.open) dlg.showModal();
  onOpen && onOpen($('#modal-body'));
}
function editHlNote(aid, id, isNew) {
  const r = getRec(aid, true);
  const h = (r.hl || []).find((x) => x.id === id);
  if (!h) return;
  const sp = splitPara(L.byId.get(aid).p[h.p] || '');
  let pos = h.pos || settings.glossPos;
  modal({
    title: `${aidLabel(aid)}・小字註記`,
    body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(sp.body.slice(h.s, h.e))}」</p>
      <textarea class="note" id="m-hlnote" placeholder="註記以紅色小字顯示在這段文字的上方或下方">${esc(h.n || '')}</textarea>
      <div class="set-row"><span class="l">位置</span><span class="segs" id="m-pos"><button type="button" data-v="a" aria-pressed="${pos !== 'b'}">文字上方</button><button type="button" data-v="b" aria-pressed="${pos === 'b'}">文字下方</button></span></div>`,
    buttons: [
      { label: '取消', onClick: () => { if (isNew && !h.n && h.c === 'n') { r.hl = r.hl.filter((x) => x.id !== id); afterNoteChange(aid); } } },
      { label: '儲存', cls: 'primary', onClick: () => { h.n = $('#m-hlnote').value.trim(); h.pos = pos; if (!h.n && h.c === 'n') r.hl = r.hl.filter((x) => x.id !== id); afterNoteChange(aid); toast('已儲存註記'); } },
    ],
    onOpen: (body) => {
      $('#m-pos', body).onclick = (e) => { const b = e.target.closest('[data-v]'); if (!b) return; pos = b.dataset.v; $$('#m-pos button').forEach((x) => x.setAttribute('aria-pressed', x === b)); };
      setTimeout(() => $('#m-hlnote')?.focus(), 50);
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
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院112年度台上字第1234號判決／勞動部○年○月○日勞職授字第○號函"></div>
      <div class="field full"><label for="m-text">要旨</label><textarea class="note" id="m-text" placeholder="判決要旨或函釋內容">${esc(item.text)}</textarea></div>
      <div class="field full"><label for="m-url">原文連結（選填）</label><input class="inp" id="m-url" type="url" value="${esc(item.url)}" placeholder="https://"></div></div>`,
    buttons: [
      ...(isNew ? [] : [{ label: '刪除', cls: 'danger', onClick: () => {
        const r = getRec(aid, true);
        r.items = (r.items || []).filter((x) => x.id !== item.id);
        saveRec(aid); refreshChips(aid); renderDetail(); toast('已刪除');
      } }]),
      { label: '取消' },
      { label: '儲存', cls: 'primary', onClick: () => {
        const no = $('#m-no').value.trim();
        if (!no) { toast('請填寫字號'); return true; }
        Object.assign(item, { kind: $('#m-kind').value, no, date: $('#m-date').value.trim(), text: $('#m-text').value.trim(), url: $('#m-url').value.trim() });
        const r = getRec(aid, true);
        r.items = r.items || [];
        if (isNew) r.items.push(item);
        saveRec(aid); refreshChips(aid);
        rulFilter = isNew ? 'U' : rulFilter;
        renderDetail(); toast('已儲存');
      } },
    ],
    onOpen: () => $('#m-no').focus(),
  });
}
function editRulingNote(aid, k) {
  const r = getRec(aid, true);
  r.rnote = r.rnote || {};
  modal({
    title: `${k.split(':').slice(1).join(':')}・筆記`,
    body: `<textarea class="note" id="m-rnote" placeholder="這則判決／函釋的重點、與本條的關係…">${esc(r.rnote[k] || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => {
      const v = $('#m-rnote').value.trim();
      if (v) r.rnote[k] = v; else delete r.rnote[k];
      saveRec(aid); renderDetail();
    } }],
    onOpen: () => $('#m-rnote').focus(),
  });
}

// ---------------------------------------------------------------------------
// 搜尋（本法或全部法典）與我的註記
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
let searchSeq = 0;
async function doSearch(q) {
  q = q.trim();
  const box = $('#side-search');
  const scopeBar = `<div class="scope"><span class="segs" role="group" aria-label="搜尋範圍"><button type="button" data-scope="law" aria-pressed="${settings.scope === 'law'}">${esc(shortName(cur))}</button><button type="button" data-scope="all" aria-pressed="${settings.scope === 'all'}">全部法典</button></span></div>`;
  if (!q) {
    box.innerHTML = scopeBar + '<p class="side-note">輸入關鍵字搜尋條文、條旨、判決、立法理由與你的註記。輸入條號（6、15-1、第十五條之一）跳到本法該條；輸入「勞基法59」「民法184」可跨法跳轉。</p>';
    return;
  }
  const seq = ++searchSeq;
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  let ids = settings.scope === 'all' ? LIB.map((e) => e.id) : [cur];
  if (settings.scope === 'all' && ids.some((id) => !LAWS.has(id) || !LAWS.get(id).D)) {
    box.innerHTML = scopeBar + '<p class="side-note">載入全部法典中…</p>';
  }
  const laws = (await Promise.all(ids.map((id) => loadLaw(id).then(async (o) => { await loadAux(o); return o; }).catch(() => null)))).filter(Boolean);
  if (seq !== searchSeq) return;
  let html = scopeBar;
  const jump = parseJump(q, LIB);
  if (jump && jump.aid) {
    const jl = jump.law || cur;
    const jo = LAWS.get(jl);
    const a = jo && jo.D && jo.byId.get(jump.aid);
    if (a) html += `<button class="res" data-goto="${jl}/${jump.aid}"><b>跳到${esc(shortName(jl))}${aidLabel(jump.aid)}</b><span>${esc(a.p.join('').slice(0, 60))}…</span></button>`;
    else if (!jo) html += `<button class="res" data-goto="${jl}/${jump.aid}"><b>跳到${esc(shortName(jl))}${aidLabel(jump.aid)}</b></button>`;
  } else if (jump && jump.law) {
    html += `<button class="res" data-law="${jump.law}"><b>開啟${esc(entry(jump.law).name)}</b></button>`;
  }
  let total = 0;
  for (const o of laws) {
    const lid = o.e.id;
    const arts = [];
    for (const a of o.D.articles) { const t = (a.cap ? a.cap + '｜' : '') + a.p.join(''); if (has(t)) arts.push([a.id, t]); }
    const ruls = [];
    if (o.X) {
      for (const aid in o.X.judg || {}) for (const r of o.X.judg[aid]) { const t = r.no + ' ' + r.text; if (has(t)) ruls.push([aid, r.no, t, 'jud']); }
      for (const aid in o.X.interp || {}) for (const r of o.X.interp[aid]) { const t = r.no + ' ' + r.text; if (has(t)) ruls.push([aid, r.no, t, 'jud']); }
    }
    if (o.R) for (const aid in o.R) for (const r of o.R[aid]) { const t = r.no + ' ' + (r.parts || []).map((p) => p[1]).join(' '); if (has(t)) ruls.push([aid, r.no, t, 'jud']); }
    const rsn = [];
    for (const aid in o.D.changes) for (const v of o.D.changes[aid]) { if (v.r && v.r.length) { const t = v.r.join(''); if (has(t)) { rsn.push([aid, v, t]); break; } } }
    const mine = [];
    notes.forEach((r, k) => {
      const [l, aid] = k.split('/');
      if (l !== lid) return;
      const t = [r.note || '', ...(r.tags || []), ...(r.hl || []).map((h) => h.n || ''), ...(r.st || []).map((s) => s.t || ''), ...(r.items || []).map((i) => i.no + i.text), ...Object.values(r.rnote || {})].join(' ');
      if (has(t)) mine.push([aid, t]);
    });
    const n = arts.length + ruls.length + rsn.length + mine.length;
    if (!n) continue;
    total += n;
    if (laws.length > 1) html += `<div class="res-law">${esc(o.e.name)}<i>${n}</i></div>`;
    if (mine.length) html += `<div class="res-group">我的註記 ${mine.length}</div>` + mine.map(([aid, t]) => `<button class="res" data-goto="${lid}/${aid}" data-tab="notes"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
    if (arts.length) html += `<div class="res-group">條文 ${arts.length}</div>` + arts.slice(0, 120).map(([aid, t]) => `<button class="res" data-goto="${lid}/${aid}"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
    if (ruls.length) html += `<div class="res-group">判決・函釋 ${ruls.length}</div>` + ruls.slice(0, 80).map(([aid, no, t]) => `<button class="res" data-goto="${lid}/${aid}" data-tab="jud"><b>${esc(no)}・${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
    if (rsn.length) html += `<div class="res-group">立法理由 ${rsn.length}</div>` + rsn.slice(0, 60).map(([aid, v, t]) => `<button class="res" data-goto="${lid}/${aid}" data-tab="reason"><b>${aidLabel(aid)}・${roc(v.d, true)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  if (!total && !jump) html += `<p class="side-note">沒有找到「${esc(q)}」。${settings.scope === 'law' ? '可改選「全部法典」跨法搜尋。' : ''}</p>`;
  box.innerHTML = html;
}
function renderMine() {
  const rows = [];
  notes.forEach((r, k) => {
    if (!r || isEmptyRec(r)) return;
    const [law, aid] = k.split('/');
    if (!entry(law)) return;
    const f = {
      star: !!r.star, note: !!r.note, hl: !!(r.hl && r.hl.length), st: !!(r.st && r.st.length),
      ink: !!(r.ink && r.ink.strokes && r.ink.strokes.length), item: !!(r.items && r.items.length) || !!(r.imp && Object.keys(r.imp).length),
    };
    rows.push({ law, aid, r, f });
  });
  const lawIdx = new Map(LIB.map((e, i) => [e.id, i]));
  const num = (aid) => { const [a, b] = aid.split('-'); return +a * 1000 + (+b || 0); };
  rows.sort((x, y) => (lawIdx.get(x.law) - lawIdx.get(y.law)) || (num(x.aid) - num(y.aid)));
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★ 書籤'], ['note', '筆記'], ['hl', '註記'], ['st', '便利貼'], ['ink', '手寫'], ['item', '判解']];
  const list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([k, l]) => `<button class="fchip" data-mf="${k}" aria-pressed="${mineFilter === k}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。選取條文文字可加紅色小字註記或劃線；按右上角筆形按鈕可用 Apple Pencil 書寫或貼便利貼。'}</p>`;
  let lastLaw = null;
  for (const { law, aid, r, f } of list) {
    if (law !== lastLaw) { html += `<div class="res-law">${esc(entry(law).name)}</div>`; lastLaw = law; }
    const bits = [f.star && '★', f.note && '筆記', f.hl && `註記 ${r.hl.length}`, f.st && `便利貼 ${r.st.length}`, f.ink && '手寫', r.items && r.items.length && `自建 ${r.items.length}`, r.imp && Object.keys(r.imp).length && `重要 ${Object.keys(r.imp).length}`].filter(Boolean).join('・');
    const a = lawArticle(law, aid);
    const peek = r.note || (r.hl || []).map((h) => h.n).filter(Boolean).join('／') || (r.tags || []).map((t) => '#' + t).join(' ') || (a ? a.p.join('').slice(0, 60) : '');
    html += `<button class="res" data-goto="${law}/${aid}" data-tab="notes"><b>${aidLabel(aid)}</b> <small style="color:var(--faint)">${bits}</small><span>${esc(peek)}</span></button>`;
  }
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
  $('#reader-inner').classList.toggle('no-pn', !settings.pn);
  document.body.classList.toggle('side-tap', settings.noteMode === 'tap');
  document.body.classList.toggle('mine-off', !settings.showMine);
  $('#btn-eye').setAttribute('aria-pressed', settings.showMine ? 'true' : 'false');
  requestAnimationFrame(() => { ink.redrawAll(); fitGlosses(); });
}
function exportData() {
  return JSON.stringify({ app: 'law-notes', version: 2, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) });
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || !data.notes) throw new Error('不是註記備份檔');
  let incoming;
  if (data.app === 'civil-code-notes') incoming = Object.entries(data.notes).map(([aid, r]) => ['civil/' + aid, r]);
  else if (data.app === 'law-notes') incoming = Object.entries(data.notes);
  else throw new Error('不是法典註記本的備份檔');
  if (replace) { await store.clearAll(); notes.clear(); }
  for (const [k, rec] of incoming) {
    const [law, aid] = k.split('/');
    if (!entry(law) || !aid) continue;
    if (!replace && notes.has(k)) {
      const c = notes.get(k);
      const merged = { ...rec, ...c };
      merged.note = [c.note, rec.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
      merged.tags = Array.from(new Set([...(c.tags || []), ...(rec.tags || [])]));
      const byIdMerge = (a = [], b = []) => { const m = new Map(); [...b, ...a].forEach((x) => m.set(x.id, x)); return [...m.values()]; };
      merged.hl = byIdMerge(c.hl, rec.hl);
      merged.st = byIdMerge(c.st, rec.st);
      merged.items = byIdMerge(c.items, rec.items);
      merged.imp = { ...(rec.imp || {}), ...(c.imp || {}) };
      merged.rnote = { ...(rec.rnote || {}), ...(c.rnote || {}) };
      if (rec.ink && c.ink) merged.ink = { ...c.ink, strokes: [...(c.ink.strokes || []), ...(rec.ink.strokes || [])] };
      merged.star = c.star || rec.star;
      notes.set(k, merged);
    } else notes.set(k, rec);
    await saveRec(aid, law);
  }
  if (data.settings && replace && data.app === 'law-notes') { settings = { ...settings, ...data.settings }; await saveSettings(); applySettings(); }
  renderReader();
  if (current) renderDetail();
}
function openSettings() {
  const seg = (k, opts) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${k}" data-val="${v}" aria-pressed="${String(settings[k]) === String(v)}">${l}</button>`).join('')}</span>`;
  const n = [...notes.values()].filter((r) => !isEmptyRec(r)).length;
  const m = L.D.meta;
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距</span>${seg('lh', [['1.7', '緊'], ['1.9', '中'], ['2.2', '鬆']])}</div>
      <div class="set-row"><span class="l">條旨<small>條號下以括號顯示本條要旨</small></span>${seg('cap', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示同條各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">判決／理由／修正標記</span>${seg('chips', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">相關法條<small>條文引用其他法律時，於條文下以小字顯示</small></span>${seg('rel', [['text', '小字全文'], ['chips', '僅條號'], ['off', '隱藏']])}</div>
      <div class="set-h">我的註記</div>
      <div class="set-row"><span class="l">註記顯示方式<small>小字：紅色小字在文字上方或下方；旁註：在條文右側；點選：點劃線處才顯示</small></span>${seg('noteMode', [['gloss', '小字'], ['margin', '旁註'], ['tap', '點選']])}</div>
      <div class="set-row"><span class="l">預設註記位置</span>${seg('glossPos', [['a', '文字上方'], ['b', '文字下方']])}</div>
      <div class="set-row"><span class="l">手指點條文<small>切換該條我的註記（小字、手寫、便利貼、劃線）顯示或隱藏</small></span>${seg('tapToggle', [['double', '點兩下'], ['single', '點一下'], ['off', '關閉']])}</div>
      <div class="set-row"><span class="l">我的註記</span>${seg('showMine', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">目前共有 ${n} 條有註記<small>儲存方式：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>可選檔案或貼上 JSON（也可匯入舊版民法註記本備份）</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料（${esc(m.name)}）</div>
      <div class="meta-list">條文：${esc(m.source)}，修正日期 ${roc(m.modified)}${m.sourceUpdate ? `，資料庫更新 ${esc(m.sourceUpdate)}` : ''}。<br>
        ${m.reasons ? `立法理由與歷次條文：${esc(m.reasons)}。<br>` : ''}
        ${L.X ? `判決、函釋：司法院裁判書系統之最高法院、最高行政法院判決（自動擷取引用本法之段落）。<br>` : ''}
        ${m.effectiveNote ? esc(m.effectiveNote) + '<br>' : ''}
        本工具供學習參考，正式引用請以官方公布之法規與裁判全文為準。</div>
      <div class="set-h">危險區域</div>
      <div class="row-actions"><input class="inp" id="wipe-confirm" placeholder="輸入「清除」以刪除全部註記" style="max-width:260px"><button type="button" class="btn small danger" data-act="wipe">刪除全部註記</button></div>`,
    buttons: [{ label: '完成', cls: 'primary' }],
    onOpen: (body) => {
      body.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.set) {
          const k = b.dataset.set, v = b.dataset.val;
          settings[k] = ['theme', 'noteMode', 'glossPos', 'tapToggle', 'rel'].includes(k) ? v : k === 'lh' ? +v : v === 'true';
          $$(`[data-set="${k}"]`, body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          saveSettings(); applySettings();
          if (k === 'showMine') setShowMine(settings.showMine);
          if (['chips', 'pn', 'noteMode', 'cap', 'rel'].includes(k)) { renderReader(); if (current) renderDetail(); }
        } else if (b.dataset.size) {
          settings.size = Math.max(14, Math.min(30, settings.size + +b.dataset.size));
          $('#size-val').textContent = settings.size + 'px';
          saveSettings(); applySettings();
        } else if (b.dataset.act === 'export') {
          const blob = new Blob([exportData()], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `法典註記備份-${new Date().toISOString().slice(0, 10)}.json`;
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
          await store.clearAll(); notes.clear(); await saveSettings();
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
// 手寫
// ---------------------------------------------------------------------------
const ink = new Ink({
  getRec: (aid, c) => getRec(aid, c),
  saveRec: (aid) => saveRec(aid),
  onChange: (aid) => { refreshChips(aid); if (current === aid && detailTab === 'notes') renderDetail(); },
  onSticky: (aid, x, y) => { addSticky(aid, x, y); },
});
function setInk(on) {
  if (on && !settings.showMine) setShowMine(true);
  ink.setActive(on);
  $('#btn-ink').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#inkbar').hidden = !on;
  if (on) {
    hidePop(); window.getSelection()?.removeAllRanges();
    toast('手寫模式：用 Apple Pencil 在條文上書寫');
    hiddenArts.clear(); $$('.art.mine-off').forEach((a) => a.classList.remove('mine-off'));
  }
}
function syncInkbar() {
  const bar = $('#inkbar');
  const p = settings.pen;
  ink.color = p.color; ink.mm = p.mm; ink.pressure = p.pressure;
  const isMark = p.color.startsWith('mark');
  if (ink.tool !== 'eraser' && ink.tool !== 'sticky') ink.setTool(isMark ? 'marker' : 'pen');
  $$('[data-color]', bar).forEach((x) => x.setAttribute('aria-pressed', ink.tool !== 'eraser' && ink.tool !== 'sticky' && x.dataset.color === p.color ? 'true' : 'false'));
  $$('[data-tool]', bar).forEach((x) => x.setAttribute('aria-pressed', x.dataset.tool === ink.tool ? 'true' : 'false'));
  $('#ink-w').value = p.mm;
  $('#ink-wv').textContent = p.mm < 0.1 ? p.mm.toFixed(2) : p.mm < 1 ? p.mm.toFixed(2).replace(/0$/, '') : p.mm.toFixed(1);
  $$('[data-mm]', bar).forEach((x) => x.setAttribute('aria-pressed', Math.abs(+x.dataset.mm - p.mm) < 0.001 ? 'true' : 'false'));
  $('[data-act="pressure"]', bar).setAttribute('aria-pressed', p.pressure ? 'true' : 'false');
  const dot = $('#ink-dot');
  dot.style.height = Math.max(0.3, p.mm * 96 / 25.4) + 'px';
  dot.style.background = `var(--pen-${p.color === 'blue' ? 'ink' : p.color})`;
  bar.classList.toggle('w-off', isMark);
}
function bindInkbar() {
  const bar = $('#inkbar');
  $('#ink-pre').innerHTML = PRESETS.map((v) => `<button type="button" class="wpre" data-mm="${v}" title="${v} mm">${v}</button>`).join('');
  bar.addEventListener('input', (e) => {
    if (e.target.id === 'ink-w') { settings.pen.mm = Math.round(+e.target.value * 100) / 100; syncInkbar(); saveSettings(); }
  });
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.color) { settings.pen.color = b.dataset.color; ink.setTool(b.dataset.color.startsWith('mark') ? 'marker' : 'pen'); }
    else if (b.dataset.tool) ink.setTool(ink.tool === b.dataset.tool ? (settings.pen.color.startsWith('mark') ? 'marker' : 'pen') : b.dataset.tool);
    else if (b.dataset.mm) settings.pen.mm = +b.dataset.mm;
    else if (b.dataset.act === 'pressure') settings.pen.pressure = !settings.pen.pressure;
    else if (b.dataset.act === 'undo') { if (!ink.undoLast()) toast('沒有可復原的筆畫'); return; }
    else if (b.dataset.act === 'finger') {
      ink.finger = !ink.finger;
      b.setAttribute('aria-pressed', ink.finger ? 'true' : 'false');
      document.body.classList.toggle('finger', ink.finger);
      toast(ink.finger ? '手指也可書寫（捲動請用兩指）' : '只有 Apple Pencil 可書寫');
      return;
    } else if (b.dataset.act === 'done') { setInk(false); return; }
    if (ink.tool === 'sticky') toast('點條文上要放便利貼的位置');
    syncInkbar(); saveSettings();
  });
  syncInkbar();
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
function bind() {
  $('#btn-nav').onclick = () => setSide(!$('#sidebar').classList.contains('open'));
  $('#scrim').onclick = () => setSide(false);
  $('#btn-settings').onclick = openSettings;
  $('#btn-law').onclick = openShelf;
  $('#btn-ink').onclick = () => setInk(!ink.active);
  $('#btn-eye').onclick = () => { setShowMine(!settings.showMine); toast(settings.showMine ? '顯示我的註記' : '已隱藏我的註記'); };
  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => { const i = L.order.indexOf(current); if (i > 0) gotoArticle(cur, L.order[i - 1], { flash: false }); };
  $('#d-next').onclick = () => { const i = L.order.indexOf(current); if (i < L.order.length - 1) gotoArticle(cur, L.order[i + 1], { flash: false }); };
  $('#d-star').onclick = () => {
    const r = getRec(current, true);
    r.star = !r.star;
    saveRec(current); refreshChips(current);
    $('#d-star').setAttribute('aria-pressed', r.star ? 'true' : 'false');
    toast(r.star ? '已加入書籤' : '已移除書籤');
  };
  $$('.seg button').forEach((b) => { b.onclick = () => showSide(b.dataset.side); });
  $('#d-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-tab]'); if (b) { detailTab = b.dataset.tab; renderDetail(); } });

  // 搜尋
  const q = $('#q');
  const run = debounce(() => { showSide('search'); doSearch(q.value); }, 240);
  q.addEventListener('input', () => { if (q.value.trim()) run(); });
  q.addEventListener('focus', () => { if (q.value.trim()) { showSide('search'); setSide(true); } });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const j = parseJump(q.value, LIB);
    if (j && j.aid) { gotoArticle(j.law || cur, j.aid); q.blur(); return; }
    if (j && j.law && !q.value.trim().match(/\s/)) { openLaw(j.law); q.blur(); return; }
    showSide('search'); doSearch(q.value); setSide(true); q.blur();
  });

  // 目錄
  $('#side-toc').addEventListener('click', (e) => {
    if (e.target.closest('[data-act="shelf"]')) { openShelf(); return; }
    const lw = e.target.closest('[data-law]');
    if (lw) { e.preventDefault(); openLaw(lw.dataset.law); return; }
    const tg = e.target.closest('[data-toggle]');
    const btn = e.target.closest('.toc-btn');
    if (!btn) return;
    const hi = +btn.dataset.h;
    const kids = document.getElementById('tk-' + hi);
    if (tg || (kids && kids.hidden && L.D.headings[hi].lv === 0)) {
      if (kids) { kids.hidden = !kids.hidden; $(`[data-toggle="${hi}"]`)?.classList.toggle('open', !kids.hidden); }
      if (tg) return;
    }
    gotoHeading(hi);
  });

  // 結果清單
  for (const id of ['#side-search', '#side-mine']) {
    $(id).addEventListener('click', (e) => {
      const sc = e.target.closest('[data-scope]');
      if (sc) { settings.scope = sc.dataset.scope; saveSettings(); doSearch($('#q').value); return; }
      const mf = e.target.closest('[data-mf]');
      if (mf) { mineFilter = mf.dataset.mf; renderMine(); return; }
      const lw = e.target.closest('[data-law]');
      if (lw) { openLaw(lw.dataset.law); setSide(false); return; }
      const b = e.target.closest('[data-goto]');
      if (!b) return;
      goRef(b.dataset.goto, { tab: b.dataset.tab });
    });
  }

  // 閱讀區
  const reader = $('#reader');
  reader.addEventListener('scroll', () => { trackTOC(); if (!$('#hl-pop').hidden && !pendingSel) hidePop(); hideRefPop(); }, { passive: true });
  const clickArticle = (e) => {
    if (ink.active) return;
    const t = e.target;
    if (t.closest('.sticky')) return;
    const go = t.closest('[data-goto]');
    if (go) { e.preventDefault(); hideRefPop(); goRef(go.dataset.goto); return; }
    const rf = t.closest('[data-ref]');
    if (rf) { e.preventDefault(); showRefPop(rf.dataset.ref, rf.getBoundingClientRect()); return; }
    const op = t.closest('[data-open]');
    if (op) { openDetail(op.dataset.open, op.dataset.tab); return; }
    if (t.closest('[data-act="mine-on"]')) { toggleArtMine(t.closest('.art'), true); return; }
    const rt = t.closest('.rel-t');
    if (rt) { rt.classList.toggle('open'); return; }
    const hl = t.closest('.hl[data-hl]');
    const sel = window.getSelection();
    if (hl && (!sel || sel.isCollapsed)) {
      const host = hl.closest('[data-id]');
      if (host.classList.contains('mine-off') || document.body.classList.contains('mine-off')) return;
      activeHl = { aid: host.dataset.id, id: hl.dataset.hl };
      pendingSel = null;
      const rec = getRec(activeHl.aid);
      const h = rec && (rec.hl || []).find((x) => x.id === activeHl.id);
      showPop(hl.getBoundingClientRect(), h, h && h.n && settings.noteMode !== 'gloss' ? noteNumbers(rec).get(h.id) : 0);
      return;
    }
    const sn = t.closest('[data-sn]');
    if (sn) editHlNote(sn.closest('[data-id]').dataset.id, sn.dataset.sn);
  };
  reader.addEventListener('click', clickArticle);
  $('#d-text').addEventListener('click', clickArticle);
  document.addEventListener('selectionchange', onSelChange);
  $('#hl-pop').addEventListener('pointerdown', (e) => e.preventDefault()); // 保留選取
  $('#hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (b) applyHighlight(b.dataset.hl);
  });
  $('#ref-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const ref = $('#ref-pop').dataset.ref;
    hideRefPop();
    if (b.dataset.act === 'ref-go' && ref) goRef(ref);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop') && !e.target.closest('.hl')) {
      setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hidePop(); }, 10);
    }
    if (!$('#ref-pop').hidden && !e.target.closest('#ref-pop') && !e.target.closest('[data-ref]')) hideRefPop();
  });

  // 詳細面板內容
  $('#d-body').addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-goto]');
    if (!b) return;
    if (b.dataset.goto) { e.preventDefault(); goRef(b.dataset.goto); return; }
    if (b.dataset.law) { openLaw(b.dataset.law); return; }
    if (b.dataset.rf) { rulFilter = b.dataset.rf; renderDetail(); return; }
    if (b.dataset.cm) { cmpMode = b.dataset.cm; renderHistory($('#d-body')); return; }
    if (b.dataset.cmp) { const i = +b.dataset.cmp; cmpSel = { aid: current, a: i - 1, b: i }; renderHistory($('#d-body')); return; }
    const card = b.closest('.rcard');
    const act = b.dataset.act;
    if (act === 'add-item') editItem(current);
    else if (act === 'imp' && card) {
      const r = getRec(current, true);
      r.imp = r.imp || {};
      const k = card.dataset.key;
      if (r.imp[k]) delete r.imp[k]; else r.imp[k] = 1;
      saveRec(current); renderDetail();
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
      afterNoteChange(current);
    } else if (act === 'st-add') { addSticky(current, 1, 0.2); }
    else if (act === 'st-edit') editSticky(current, b.dataset.id);
    else if (act === 'ink-on') {
      setInk(true);
      if (matchMedia('(max-width: 760px)').matches) closeDetail();
      gotoArticle(cur, current, { open: false });
    } else if (act === 'ink-clear') { ink.clear(current); toast('已清除，可按「復原」還原'); }
  });
  $('#d-body').addEventListener('change', (e) => {
    if (e.target.id === 'cmp-a' || e.target.id === 'cmp-b') {
      cmpSel[e.target.id === 'cmp-a' ? 'a' : 'b'] = +e.target.value;
      renderHistory($('#d-body'));
    }
  });

  window.addEventListener('hashchange', () => routeHash(false));
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#ref-pop').hidden) hideRefPop(); else if (!$('#hl-pop').hidden) hidePop(); else if (ink.active) setInk(false); else if (current) closeDetail(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
  });
  window.addEventListener('resize', debounce(() => fitGlosses(), 200));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => ink.redrawAll());
  bindStickies();
  bindTapToggle();
}

function routeHash(initial) {
  const h = decodeURIComponent(location.hash.slice(1));
  let m = h.match(/^a-(\d+(?:-\d+)?)$/);           // 舊版民法網址
  if (m) { gotoArticle('civil', m[1]); return true; }
  m = h.match(/^([a-z-]+)(?:\/(\d+(?:-\d+)?))?$/);
  if (m && entry(m[1])) {
    if (m[2]) { if (!(m[1] === cur && m[2] === current)) gotoArticle(m[1], m[2]); }
    else if (m[1] !== cur) openLaw(m[1]);
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  let saved = {};
  try {
    const [lib, s, xr] = await Promise.all([
      fetch('data/laws.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      store.getAll().catch(() => ({})),
      fetch('data/xref.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    LIB = lib.laws; DEFAULT_LAW = lib.default || LIB[0].id; XREF = xr; saved = s;
  } catch (e) {
    $('#loading').textContent = '無法載入法典資料：' + e.message;
    return;
  }
  refsOf = makeResolver(LIB);
  // 舊版「民法註記本」之註記（a:條號）移轉為 n:civil/條號
  for (const [k, v] of Object.entries(saved)) {
    if (k.startsWith('n:')) notes.set(k.slice(2), v);
    else if (k.startsWith('a:')) {
      const nk = 'civil/' + k.slice(2);
      if (!notes.has(nk)) notes.set(nk, v);
      store.put('n:' + nk, v).then(() => store.del(k)).catch(() => {});
    } else if (k === 'settings') {
      settings = { ...settings, ...v, pen: { ...settings.pen, ...(v.pen || {}) } };
      if (v.side && !v.noteMode) settings.noteMode = v.side === 'tap' ? 'tap' : 'gloss';
    }
  }
  applySettings();
  bind();
  bindInkbar();
  const h = decodeURIComponent(location.hash.slice(1));
  let m = h.match(/^a-(\d+(?:-\d+)?)$/);
  let first = entry(settings.law) ? settings.law : DEFAULT_LAW, aid;
  if (m) { first = 'civil'; aid = m[1]; }
  else if ((m = h.match(/^([a-z-]+)(?:\/(\d+(?:-\d+)?))?$/)) && entry(m[1])) { first = m[1]; aid = m[2]; }
  await openLaw(first, { aid });
  doSearch('');
  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
