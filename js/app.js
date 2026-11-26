import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, PEN_COLORS, WIDTH_PRESETS, sliderToWidth, widthToSlider } from './ink.js';
import { cnNum, findRefs } from './xref.js';

// ---------------------------------------------------------------------------
// 基本工具
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Math.random().toString(36).slice(2, 9);

export function aidLabel(aid) {
  const [a, b] = String(aid).split('-');
  return b ? `第${a}條之${b}` : `第${a}條`;
}
const shortLabel = (aid) => { const [a, b] = String(aid).split('-'); return b ? `§${a}-${b}` : `§${a}`; };
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
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}

// ---------------------------------------------------------------------------
// 法規
// ---------------------------------------------------------------------------
let REG = { laws: [], default: 'lpa' };
const LAW = new Map();     // id -> { cfg, D, R, byId, order, ready, rulingsReady }
let G = {};                // 條旨
let X = {};                // 其他法律之被引用條文
let NAMES = [];            // [[法規名稱, key]]，長者在前
let cur = null;            // 目前閱讀的法規
let D = null, R = null;    // 目前法規的資料、判解
let byId = new Map();
let order = [];
const refCache = new Map();

const notes = new Map();   // 註記；key：民法為條號（相容舊版），其他為「法規/條號」
let settings = {
  theme: 'system', size: 18, lh: 1.9, pn: true, chips: true, side: 'inline', xopen: false,
  tapToggle: true, hideMine: false, law: null, penColor: 'red', penWidth: 0.6,
};
let current = null;        // 詳細面板中的條號（屬於 cur）
let detailTab = 'rulings';
let rulFilter = 'all';
let cmpMode = 'table';
let cmpSel = null;
const flipped = new Set(); // 單條切換顯示／隱藏註記

const TYPE_LABEL = { CJ: '憲法法庭', C: '大法官解釋', J: '判例', U: '我的' };
const USER_KINDS = ['判決', '函釋', '決議', '其他'];
const KIND_LABEL = { orig: '制定', new: '增訂', amend: '修正', del: '刪除' };

const cfgOf = (id) => LAW.get(id)?.cfg;
const lawName = (key) => cfgOf(key)?.name || key;
const lawShort = (key) => cfgOf(key)?.short || key;

async function loadLaw(id) {
  const L = LAW.get(id);
  if (!L) throw new Error('未知的法規：' + id);
  if (L.ready) return L;
  if (!L.loading) {
    L.loading = fetch(L.cfg.file).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }).then((d) => {
      L.D = d;
      L.byId = new Map();
      L.order = [];
      const tops = d.headings.map((h, i) => (h.lv === 0 ? i : -1)).filter((i) => i >= 0);
      const topOf = (hi) => { while (hi >= 0 && d.headings[hi].p >= 0) hi = d.headings[hi].p; return hi; };
      for (const a of d.articles) {
        a.ch = Math.max(0, tops.indexOf(topOf(a.h))) % 12;
        L.byId.set(a.id, a);
        L.order.push(a.id);
      }
      L.ready = true;
      return L;
    });
  }
  return L.loading;
}
function loadRulings(id) {
  const L = LAW.get(id);
  if (!L || L.rulingsLoading) return L && L.rulingsLoading;
  L.rulingsLoading = fetch(L.cfg.rulings).then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((data) => {
    L.R = data || {};
    if (id === cur) {
      R = L.R;
      for (const aid of Object.keys(R)) refreshChips(aid);
      if (current) renderDetail();
    }
    return L.R;
  });
  return L.rulingsLoading;
}

// ---------------------------------------------------------------------------
// 使用者紀錄
// ---------------------------------------------------------------------------
const nk = (aid, law = cur) => (law === 'civil' ? aid : `${law}/${aid}`);
function splitKey(k) { const i = k.indexOf('/'); return i < 0 ? ['civil', k] : [k.slice(0, i), k.slice(i + 1)]; }
const recOf = (aid, law = cur) => notes.get(nk(aid, law));
function getRec(aid, create) {
  const k = nk(aid);
  let r = notes.get(k);
  if (!r && create) { r = {}; notes.set(k, r); }
  return r;
}
function isEmptyRec(r) {
  return !r || (!r.star && !r.note && !(r.tags && r.tags.length) && !(r.hl && r.hl.length) &&
    !(r.ink && r.ink.strokes && r.ink.strokes.length) && !(r.items && r.items.length) &&
    !(r.imp && Object.keys(r.imp).length) && !(r.rnote && Object.keys(r.rnote).length) && !(r.stk && r.stk.length));
}
const hasMine = (r) => !!(r && (r.note || (r.hl && r.hl.length) || (r.ink && r.ink.strokes && r.ink.strokes.length) || (r.stk && r.stk.length)));
async function saveRec(aid, law = cur) {
  const k = nk(aid, law);
  const r = notes.get(k);
  try {
    if (isEmptyRec(r)) { notes.delete(k); await store.del('a:' + k); }
    else { r.t = Date.now(); await store.put('a:' + k, r); }
  } catch (e) {
    console.error(e);
    toast('無法儲存註記：' + (e.message || e));
  }
}
async function saveSettings() { try { await store.put('settings', settings); } catch {} }

// ---------------------------------------------------------------------------
// 條文解析與呈現
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
function refCtx(law, aid) {
  const L = LAW.get(law);
  const i = L.order.indexOf(aid);
  return { self: law, names: NAMES, aliases: L.cfg.aliases || {}, prev: i > 0 ? L.order[i - 1] : null, last: null };
}
// 各段的引用位置與本條引用他法清單
function articleRefs(a, law = cur) {
  const ck = law + ':' + a.id;
  if (refCache.has(ck)) return refCache.get(ck);
  const ctx = refCtx(law, a.id);
  const L = LAW.get(law);
  const paras = a.p.map((t) => findRefs(splitPara(t).body, ctx).filter((r) => r.key !== law || L.byId.has(r.aid)));
  const seen = new Set();
  const ext = [];
  for (const rs of paras) for (const r of rs) {
    if (r.key === law) continue;
    const k = r.key + '|' + r.aid;
    if (!seen.has(k)) { seen.add(k); ext.push({ key: r.key, aid: r.aid }); }
  }
  const out = { paras, ext };
  refCache.set(ck, out);
  return out;
}
// 判解、理由等其他文字：只標出本法與他法引用
function textRefs(text, law = cur) {
  const ctx = { self: law, names: NAMES, aliases: {}, prev: null, last: null };
  return findRefs(text, ctx).filter((r) => r.key !== law || byId.has(r.aid));
}
function extText(key, aid) {
  if (LAW.has(key)) {
    const L = LAW.get(key);
    if (!L.ready) return null;
    const a = L.byId.get(aid);
    return a ? a.p : [];
  }
  return (X[key] && X[key].arts && X[key].arts[aid]) || [];
}
function extURL(key, aid) {
  const pcode = LAW.has(key) ? LAW.get(key).D?.meta.pcode : X[key]?.pcode;
  return pcode ? `https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=${pcode}&flno=${aid}` : '';
}

function renderRich(text, hls, refs, nums, opts = {}) {
  const cuts = new Set([0, text.length]);
  for (const h of hls) { cuts.add(Math.max(0, Math.min(text.length, h.s))); cuts.add(Math.max(0, Math.min(text.length, h.e))); }
  for (const x of refs) { cuts.add(x.s); cuts.add(x.e); }
  const pts = [...cuts].sort((a, b) => a - b);
  const inline = opts.inline;
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    if (inline) {
      for (const h of hls) if (h.n && h.s === s) {
        const line = h.n.split('\n')[0];
        html += `<span class="iln-a mine" data-hl="${h.id}" data-pos="${h.pos === 'down' ? 'down' : 'up'}" data-note="${esc(line)}"></span>`;
      }
    }
    let piece = esc(text.slice(s, e));
    const x = refs.find((r) => r.s <= s && r.e >= e);
    if (x) {
      piece = x.key === (opts.law || cur)
        ? `<a class="xref" href="#${opts.law || cur}/a-${x.aid}" data-goto="${x.aid}">${piece}</a>`
        : `<a class="xref xl" href="#" data-xl="${esc(x.key)}" data-xa="${x.aid}">${piece}</a>`;
    }
    let h = null;
    for (const c of hls) if (c.s <= s && c.e >= e) h = c; // 後加者優先
    if (h) {
      const last = !hls.some((c) => c.id === h.id && c.e > e);
      const num = h.n && last && !inline ? (nums && nums.get(h.id)) || '註' : '';
      piece = `<mark class="hl hl-${h.c}${h.n ? ' has-n' : ''}" data-hl="${h.id}"${num ? ` data-n="${num}"` : ''}>${piece}</mark>`;
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
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const circ = (n) => CIRCLED[n - 1] || `(${n})`;

function renderParas(a, rec, side = false) {
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  const nums = noteNumbers(rec);
  const refs = articleRefs(a);
  const inline = settings.side === 'inline';
  let xi = 0;
  return a.p.map((t, i) => {
    const sp = splitPara(t);
    const hls = ((rec && rec.hl) || []).filter((h) => h.p === i);
    const body = renderRich(sp.body, hls, refs.paras[i] || [], nums, { inline });
    let para;
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      para = `<p class="para"><span class="pn">${pn}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    } else {
      para = `<p class="para ${sp.kind === 'kuan' ? 'kuan' : 'kuan sub'}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    }
    if (!side || settings.side !== 'margin') return para;
    let aside = '';
    if (i === 0 && rec && rec.note) aside += `<button class="sn note-side mine" data-open="${a.id}" data-tab="notes"><b>本條筆記</b>${esc(rec.note)}</button>`;
    for (const h of hls.filter((x) => x.n).sort((x, y) => x.s - y.s)) {
      aside += `<button class="sn mine" data-sn="${h.id}"><b>${circ(nums.get(h.id))}</b>${esc(h.n)}</button>`;
    }
    return `<div class="prow">${para}<aside class="pside mine">${aside}</aside></div>`;
  }).join('');
}

function rulingCount(aid) {
  const n = R && R[aid] ? R[aid].length : 0;
  const rec = recOf(aid);
  return n + (rec && rec.items ? rec.items.length : 0);
}
function amendCount(aid) {
  const c = D.changes[aid];
  return c ? c.length - 1 : 0;
}
function hasReasons(aid) { return (D.changes[aid] || []).some((h) => h.r && h.r.length); }
function pendingNote(aid) {
  const p = D.meta.pending && D.meta.pending[aid];
  if (!p) return '';
  return `${roc(p)}修正公布，尚未施行（自公布六個月後施行）；施行前仍適用修正前條文，可於「沿革・理由」查看。`;
}
function chipsHTML(aid) {
  const rec = recOf(aid);
  const out = [];
  if (rec && rec.star) out.push('<span class="chip c-star" title="書籤">★</span>');
  if (D.meta.pending && D.meta.pending[aid]) out.push('<span class="chip c-pend">尚未施行</span>');
  if (settings.chips) {
    const rc = rulingCount(aid);
    if (rc) out.push(`<button class="chip c-rul" data-open="${aid}" data-tab="rulings">判解 ${rc}</button>`);
    const ac = amendCount(aid);
    if (ac) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">修正 ${ac}</button>`);
    else if (hasReasons(aid)) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">理由</button>`);
  }
  if (hasMine(rec)) out.push(`<button class="chip c-note" data-open="${aid}" data-tab="notes">註記</button>`);
  return out.join('');
}
const gistOf = (aid, law = cur) => (G[law] && G[law][aid]) || '';

function xrefBlock(a) {
  const { ext } = articleRefs(a);
  if (!ext.length) return '';
  const groups = new Map();
  for (const r of ext) { if (!groups.has(r.key)) groups.set(r.key, []); groups.get(r.key).push(r.aid); }
  const sum = [...groups].map(([k, ids]) => `${lawShort(k)} ${ids.map(shortLabel).join('、')}`).join('；');
  return `<details class="xrefs" data-aid="${a.id}"${settings.xopen ? ' open' : ''}><summary><span class="xr-lbl">引用條文</span><span class="xr-sum">${esc(sum)}</span></summary><div class="xr-body">${xrefBody(ext)}</div></details>`;
}
function xrefBody(ext) {
  return ext.map(({ key, aid }) => {
    const p = extText(key, aid);
    const txt = p === null ? '<span class="xr-wait">載入中…</span>' : p.length ? p.map((t) => `<span class="xr-p">${esc(t)}</span>`).join('') : '<span class="xr-wait">（找不到條文）</span>';
    const ab = X[key] && X[key].abandon ? `<span class="tpill tp-void">${esc(X[key].abandon.slice(0, 20))}</span>` : '';
    return `<div class="xr"><a class="xr-h" href="#" data-xl="${esc(key)}" data-xa="${aid}">${esc(lawName(key))} ${aidLabel(aid)}</a>${ab}<div class="xr-t">${txt}</div></div>`;
  }).join('');
}
function refreshXrefBlocks() {
  for (const el of $$('#reader-inner details.xrefs')) {
    const a = byId.get(el.dataset.aid);
    if (a) $('.xr-body', el).innerHTML = xrefBody(articleRefs(a).ext);
  }
}

function stickiesHTML(aid, rec) {
  if (!rec || !rec.stk || !rec.stk.length) return '';
  return rec.stk.map((s) => `<div class="stk mine stk-${s.c || 'y'}${s.min ? ' min' : ''}" data-stk="${s.id}" style="left:${s.x}em;top:${s.y}em;width:${s.min ? 2.2 : s.w || 11}em">
    <div class="stk-grip" data-grip="${s.id}" aria-label="拖曳移動"><span>⋯</span><button class="stk-min" data-stkmin="${s.id}" aria-label="${s.min ? '展開' : '縮小'}">${s.min ? '＋' : '－'}</button></div>
    <div class="stk-body">${esc(s.text || '（空白便利貼，點一下編輯）')}</div></div>`).join('');
}
function stkMinHeight(rec) {
  if (!rec || !rec.stk || !rec.stk.length) return 0;
  return Math.max(...rec.stk.map((s) => s.y + (s.min ? 2 : (s.h || 5))));
}
const hasIln = (rec) => settings.side === 'inline' && rec && rec.hl && rec.hl.some((h) => h.n);

function articleInner(a) {
  const rec = recOf(a.id);
  const gist = gistOf(a.id);
  let html = `<div class="art-head"><button class="ano" data-open="${a.id}">${aidLabel(a.id)}</button><span class="chips">${chipsHTML(a.id)}</span></div>`;
  if (gist) html += `<div class="gist">（${esc(gist)}）</div>`;
  html += `<div class="atext${hasIln(rec) ? ' has-iln' : ''}">${renderParas(a, rec, true)}</div>`;
  html += xrefBlock(a);
  const pn = pendingNote(a.id);
  if (pn) html += `<div class="pend-note">${esc(pn)}</div>`;
  if (rec && rec.note) html += `<div class="note-peek mine" data-open="${a.id}" data-tab="notes">${esc(rec.note)}</div>`;
  html += stickiesHTML(a.id, rec);
  return html;
}
function artClass(a) {
  const rec = recOf(a.id);
  const off = settings.hideMine !== flipped.has(nk(a.id));
  return `art ch-${a.ch}${a.del ? ' deleted' : ''}${rec && rec.ink && rec.ink.strokes && rec.ink.strokes.length ? ' has-ink' : ''}${off ? ' off' : ''}`;
}
function artStyle(a) {
  const h = stkMinHeight(recOf(a.id));
  return h ? ` style="min-height:${(h + 1).toFixed(2)}em"` : '';
}

function renderReader() {
  const parts = [];
  const hlevelClass = ['h-part', 'h-chap', 'h-sec', 'h-sub', 'h-sub'];
  const firstOf = new Map();
  D.headings.forEach((h, i) => {
    if (h.first) { if (!firstOf.has(h.first)) firstOf.set(h.first, []); firstOf.get(h.first).push(i); }
  });
  const tops = D.headings.map((h, i) => (h.lv === 0 ? i : -1)).filter((i) => i >= 0);
  parts.push(`<header class="law-title"><h1>${esc(D.meta.name)}</h1><p>${D.meta.modified ? `${D.meta.kind === 'order' ? '修正發布' : '修正公布'}：${roc(D.meta.modified)}　` : ''}共 ${D.articles.length} 條</p></header>`);
  for (const a of D.articles) {
    for (const hi of firstOf.get(a.id) || []) {
      const h = D.headings[hi];
      const tag = h.lv === 0 ? 'h2' : h.lv === 1 ? 'h3' : 'h4';
      const ch = h.lv === 0 ? ` ch-${Math.max(0, tops.indexOf(hi)) % 12}` : '';
      parts.push(`<${tag} class="${hlevelClass[Math.min(h.lv, 4)]}${ch}" id="h-${hi}">${esc(h.t)}</${tag}>`);
    }
    parts.push(`<article class="${artClass(a)}" id="a-${a.id}" data-id="${a.id}"${artStyle(a)}>${articleInner(a)}</article>`);
  }
  const inner = $('#reader-inner');
  inner.innerHTML = parts.join('');
  inner.classList.toggle('no-pn', !settings.pn);
  ink.reset();
  $$('.art', inner).forEach((el) => ink.observe(el));
}
function refreshArticle(aid) {
  const el = document.getElementById('a-' + aid);
  const a = byId.get(aid);
  if (el && a) {
    el.className = artClass(a) + (current === aid ? ' sel' : '');
    el.style.minHeight = (stkMinHeight(recOf(aid)) ? (stkMinHeight(recOf(aid)) + 1).toFixed(2) + 'em' : '');
    el.innerHTML = articleInner(a);
    ink.refresh(aid);
  }
  if (current === aid) renderDetailText();
}
function refreshChips(aid) {
  const el = document.querySelector(`#a-${CSS.escape(aid)} .chips`);
  if (el) el.innerHTML = chipsHTML(aid);
}

// ---------------------------------------------------------------------------
// 顯示／隱藏自己的註記
// ---------------------------------------------------------------------------
function applyVisibility(aid) {
  const els = aid ? [document.getElementById('a-' + aid)].filter(Boolean) : $$('#reader-inner .art');
  for (const el of els) el.classList.toggle('off', settings.hideMine !== flipped.has(nk(el.dataset.id)));
  if (current && (!aid || aid === current)) $('#d-text').classList.toggle('off', settings.hideMine !== flipped.has(nk(current)));
  $('#btn-eye').setAttribute('aria-pressed', settings.hideMine ? 'true' : 'false');
  $('#btn-eye').title = settings.hideMine ? '顯示我的註記' : '隱藏我的註記';
}
function setHideMine(v, quiet) {
  settings.hideMine = v;
  flipped.clear();
  saveSettings();
  applyVisibility();
  if (!quiet) toast(v ? '已隱藏全部註記（點條文可單條顯示）' : '已顯示全部註記');
}
function flipArticle(aid) {
  const k = nk(aid);
  if (flipped.has(k)) flipped.delete(k); else flipped.add(k);
  applyVisibility(aid);
  const off = settings.hideMine !== flipped.has(k);
  toast(off ? `已隱藏${aidLabel(aid)}的註記` : `已顯示${aidLabel(aid)}的註記`);
}

// ---------------------------------------------------------------------------
// 目錄與法規切換
// ---------------------------------------------------------------------------
function lastArticleOf(hi) {
  const h = D.headings[hi];
  let next = null;
  for (let j = hi + 1; j < D.headings.length; j++) if (D.headings[j].lv <= h.lv) { next = D.headings[j]; break; }
  if (!next) return order[order.length - 1];
  const idx = order.indexOf(next.first);
  return order[idx - 1];
}
function renderLawTabs() {
  $('#law-tabs').innerHTML = REG.laws.map((c) => `<button class="law-tab" data-law="${c.id}" aria-pressed="${c.id === cur}"><span class="lt-mark lm-${c.id}">${esc(c.mark)}</span>${esc(c.short)}</button>`).join('');
}
function renderTOC() {
  const kids = new Map();
  D.headings.forEach((h, i) => { if (!kids.has(h.p)) kids.set(h.p, []); kids.get(h.p).push(i); });
  const tops = D.headings.map((h, i) => (h.lv === 0 ? i : -1)).filter((i) => i >= 0);
  const build = (pi) => (kids.get(pi) || []).map((i) => {
    const h = D.headings[i];
    const sub = kids.get(i);
    const rng = h.first ? `${h.first}–${lastArticleOf(i)}` : '';
    const dot = h.lv === 0 ? `<i class="ch-dot ch-${Math.max(0, tops.indexOf(i)) % 12}"></i>` : '';
    return `<div class="toc-part"><button class="toc-btn lv${h.lv}" data-h="${i}">${sub ? `<span class="caret" data-toggle="${i}">›</span>` : '<span class="caret"></span>'}${dot}<span>${esc(h.t)}</span><span class="rng">${rng}</span></button>${sub ? `<div class="toc-kids" id="tk-${i}" hidden>${build(i)}</div>` : ''}</div>`;
  }).join('');
  const m = D.meta;
  $('#side-toc').innerHTML = build(-1) + `<p class="side-note">${esc(m.name)}：${m.kind === 'order' ? '修正發布' : '修正日期'} ${roc(m.modified)}。資料來源：${esc(m.source)}。</p>`;
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
  const reader = $('#reader');
  const top = reader.getBoundingClientRect().top + 80;
  let c = -1;
  for (const el of $$('#reader-inner > h2, #reader-inner > h3, #reader-inner > h4')) {
    if (el.getBoundingClientRect().top < top) c = +el.id.slice(2); else break;
  }
  $$('.toc-btn.cur').forEach((b) => b.classList.remove('cur'));
  if (c >= 0) { const b = $(`.toc-btn[data-h="${c}"]`); if (b) b.classList.add('cur'); }
}, 160);

async function switchLaw(id, { aid, tab, keepDetail } = {}) {
  if (!LAW.has(id)) return;
  if (id !== cur) {
    if (ink.active) setInk(false);
    if (!keepDetail) closeDetail();
    $('#reader-inner').innerHTML = '<div class="loading">載入條文中…</div>';
    const L = await loadLaw(id);
    cur = id;
    D = L.D; R = L.R || null; byId = L.byId; order = L.order;
    settings.law = id; saveSettings();
    document.documentElement.dataset.law = id;
    $('#brand-mark').textContent = L.cfg.mark;
    $('#brand-name').textContent = L.cfg.short;
    document.title = `${L.cfg.short}・法典註記本`;
    renderLawTabs();
    renderTOC();
    renderReader();
    applyVisibility();
    $('#q').placeholder = `搜尋各法條文、判解、註記，或輸入「${L.cfg.jump[L.cfg.jump.length - 1]} 14」`;
    if (!L.rulingsLoading) loadRulings(id); else L.rulingsLoading.then(() => { if (cur === id) { R = L.R; for (const k of Object.keys(R)) refreshChips(k); } });
    if (!aid) { $('#reader').scrollTop = 0; if (!isNarrow() && D.headings.length) tocExpandTo(0); }
  }
  if (aid) gotoArticle(aid, { open: true, tab });
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
function gotoArticle(aid, { open = true, flash = true, tab } = {}) {
  if (!byId.has(aid)) { toast(`${lawShort(cur)}找不到${aidLabel(aid)}`); return; }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  tocExpandTo(byId.get(aid).h);
  setSide(false);
  if (open) openDetail(aid, tab);
}
function gotoHeading(hi) {
  scrollToEl(document.getElementById('h-' + hi));
  setSide(false);
}
function setHash(aid) {
  try { history.replaceState(null, '', aid ? `#${cur}/a-${aid}` : location.pathname + location.search); } catch {}
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
  setHash(aid);
  renderDetail();
}
function closeDetail() {
  if (current) document.getElementById('a-' + current)?.classList.remove('sel');
  current = null;
  $('#detail').hidden = true;
  setHash(null);
}
function renderDetailText() {
  const a = byId.get(current);
  const rec = recOf(current);
  const el = $('#d-text');
  el.dataset.id = current;
  el.className = `d-text ch-${a.ch}${settings.hideMine !== flipped.has(nk(current)) ? ' off' : ''}`;
  el.innerHTML = `<div class="atext${settings.pn ? '' : ' no-pn'}${hasIln(rec) ? ' has-iln' : ''}">${renderParas(a, rec)}</div>` +
    (pendingNote(current) ? `<div class="pend-note">${esc(pendingNote(current))}</div>` : '');
}
function renderDetail() {
  if (!current) return;
  const a = byId.get(current);
  const rec = recOf(current);
  $('#d-no').textContent = aidLabel(current);
  $('#d-no').className = `d-badge ch-${a.ch}`;
  const gist = gistOf(current);
  $('#d-path').textContent = (gist ? `（${gist}）` : '') + (gist ? ' ' : '') + `${lawShort(cur)}・` + headingPath(a.h).join(' › ');
  $('#d-star').setAttribute('aria-pressed', rec && rec.star ? 'true' : 'false');
  renderDetailText();
  const rc = rulingCount(current), ac = amendCount(current);
  $('#t-rulings').textContent = rc || '';
  $('#t-history').textContent = ac || '';
  const nc = rec ? ((rec.note ? 1 : 0) + (rec.hl ? rec.hl.length : 0) + (rec.stk ? rec.stk.length : 0) + (rec.ink && rec.ink.strokes && rec.ink.strokes.length ? 1 : 0)) : 0;
  $('#t-notes').textContent = nc || '';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === detailTab ? 'true' : 'false'));
  const body = $('#d-body');
  if (detailTab === 'rulings') renderRulings(body);
  else if (detailTab === 'history') renderHistory(body);
  else renderNotes(body);
  body.scrollTop = 0;
}
function headingPath(hidx) {
  const out = [];
  while (hidx >= 0) { out.unshift(D.headings[hidx].t); hidx = D.headings[hidx].p; }
  return out;
}

// ----- 判解・函釋 -----
function rulingList(aid) {
  const rec = recOf(aid) || {};
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
  const rec = recOf(current) || {};
  const qstr = `${D.meta.name}第${current.replace('-', '條之').replace(/^(\d+)$/, '$1')}${current.includes('-') ? '' : '條'}`;
  let html = `<div class="filters">${filters.map(([k, l, n]) => `<button class="fchip" data-rf="${k}" aria-pressed="${rulFilter === k}">${l}<i>${n}</i></button>`).join('')}</div>`;
  html += `<div class="row-actions" style="margin-bottom:12px"><button class="btn small primary" data-act="add-item">＋ 新增判決／函釋</button>
    <button class="btn small" data-act="copy-q" data-q="${esc(qstr)}">複製「${esc(qstr)}」</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/default.aspx" target="_blank" rel="noopener">司法院裁判書查詢</a>
    ${LAW.get(cur).cfg.labor ? '<a class="btn small" href="https://laws.mol.gov.tw/" target="_blank" rel="noopener">勞動部法令查詢（函釋）</a>' : '<a class="btn small" href="https://mojlaw.moj.gov.tw/" target="_blank" rel="noopener">法務部函釋查詢</a>'}</div>`;
  if (!R && !(rec.items && rec.items.length)) html += '<p class="empty">判解資料載入中…</p>';
  else if (!list.length) html += `<p class="empty">${rulFilter === 'U' ? '尚無自建資料。可新增法院判決、勞動部函釋、決議等，寫下字號、要旨與連結。' : rulFilter === 'imp' ? '尚未標記重要判解。點判解卡右上角的星號即可標記。' : '本條在全國法規資料庫沒有相關的大法官解釋或憲法法庭裁判。可自行新增法院判決或函釋：先按「複製」再到裁判書查詢貼上搜尋。'}</p>`;
  if (all.some((r) => r.ty === 'J')) html += '<p class="callout">判例制度已於民國108年7月4日廢止。依法院組織法第57條之1，未經停止適用之判例，其效力與未經選編為判例之最高法院裁判相同。字號前標「廢」者為已不再援用。</p>';
  for (const r of list) html += rulingCard(r, rec);
  body.innerHTML = html;
}
function rulingCard(r, rec) {
  const isVoid = (r.no || '').startsWith('廢');
  const typeLabel = r.ty === 'U' ? (r.kind || '其他') : TYPE_LABEL[r.ty];
  const parts = r.user ? (r.text ? [['要旨', r.text]] : []) : (r.parts || []);
  const rnote = rec.rnote && rec.rnote[r.key];
  const partsHTML = parts.map(([lbl, txt]) => `<div class="rpart${txt.length > 220 ? ' clamp' : ''}"><span class="lbl">${esc(lbl)}</span>${renderRich(txt, [], textRefs(txt))}</div>`).join('');
  return `<article class="rcard${r.imp ? ' imp' : ''}${isVoid ? ' void' : ''}" data-key="${esc(r.key)}">
    <div class="rhead"><span class="tpill tp-${r.ty}">${esc(typeLabel)}</span>${isVoid ? '<span class="tpill tp-void">不再援用</span>' : ''}
      <span class="rno">${esc(isVoid ? r.no.slice(1) : r.no)}</span><span class="rdate">${esc(r.date || '')}</span>
      <button class="rstar" data-act="imp" aria-pressed="${r.imp}" aria-label="標記重要"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"/></svg></button></div>
    ${partsHTML}
    ${rnote ? `<div class="rnote">${esc(rnote)}</div>` : ''}
    <div class="rfoot">
      ${parts.some(([, t]) => t.length > 220) ? '<button class="linkish" data-act="expand">展開全文</button>' : ''}
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">原文</a>` : ''}
      ${r.user ? '<button class="linkish" data-act="edit-item">編輯</button>' : `<button class="linkish" data-act="rnote">${rnote ? '編輯筆記' : '加筆記'}</button>`}
    </div></article>`;
}

// ----- 沿革・理由 -----
const versionsOf = (aid) => (D.changes[aid] || []).map((h, i) => ({ ...h, i }));
const histItemFor = (d) => D.histories.find((h) => h.dates.includes(d));
function reasonHTML(v, open) {
  if (!v.r || !v.r.length) return '';
  const lbl = v.k === 'orig' ? '立法理由' : v.k === 'new' ? '增訂理由' : v.k === 'del' ? '刪除理由' : '修正理由';
  return `<details class="reason"${open ? ' open' : ''}><summary>${lbl}</summary>${v.r.map((t) => `<p>${renderRich(t, [], textRefs(t))}</p>`).join('')}</details>`;
}
function verFiles(d) {
  const f = D.meta.files && D.meta.files[d];
  if (!f) return '';
  return `<span class="vfiles">${f.cmp ? `<a href="${esc(f.cmp)}" target="_blank" rel="noopener">條文對照表（含理由）</a>` : ''}${f.desc ? `<a href="${esc(f.desc)}" target="_blank" rel="noopener">修正總說明</a>` : ''}</span>`;
}
function renderHistory(body) {
  const a = byId.get(current);
  const vs = versionsOf(current);
  const lyLink = D.meta.ly ? `<a href="https://www.ly.gov.tw/Pages/ashx/LawRedirect.ashx?CODE=${D.meta.ly}" target="_blank" rel="noopener">立法院法律系統</a>` : '<a href="https://lis.ly.gov.tw/lglawc/lglawkm" target="_blank" rel="noopener">立法院法律系統</a>';
  const srcNote = `<p class="callout" style="margin-top:12px">${D.meta.ly ? '歷次條文與立法、修正理由取自立法院法律系統「法條沿革」；日期為總統公布日（括號內為立法院三讀日）。' : D.meta.kind === 'order' ? '歷次條文取自全國法規資料庫「歷史條文」；修正理由請見各次「條文對照表」。' : '新舊對照以全國法規資料庫的歷次版本逐條比對產生；僅標點或個別字的資料庫勘誤不列為修正。'}
    另見${lyLink}或<a href="https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=${D.meta.pcode}" target="_blank" rel="noopener">全國法規資料庫沿革</a>。</p>`;
  if (vs.length < 2) {
    const v = vs[0];
    body.innerHTML = `<p class="empty" style="padding-bottom:6px">${aidLabel(current)}自${a.since ? roc(a.since) : '制定'}${v ? KIND_LABEL[v.k] : ''}以來，未曾修正。</p>` +
      (v ? reasonHTML(v, true) + (verFiles(v.d) ? `<p>${verFiles(v.d)}</p>` : '') : '') + srcNote;
    return;
  }
  const pend = D.meta.pending || {};
  if (!cmpSel || cmpSel.aid !== current) cmpSel = { aid: current, a: vs.length - 2, b: vs.length - 1 };
  const opt = (sel) => vs.map((v) => `<option value="${v.i}"${v.i === sel ? ' selected' : ''}>${roc(v.d, true)} ${KIND_LABEL[v.k]}${pend[current] === v.d ? '（未施行）' : ''}</option>`).join('');
  let html = '<ol class="timeline">';
  for (const v of [...vs].reverse()) {
    const it = histItemFor(v.d);
    html += `<li class="tl k-${v.k}${pend[current] === v.d ? ' pend' : ''}"><span class="dot"></span><div><b>${roc(v.d)}</b><small>${KIND_LABEL[v.k]}${v.pass && v.pass !== v.d ? `（三讀 ${roc(v.pass, true)}）` : ''}${pend[current] === v.d ? '・尚未施行' : ''}${it ? `・沿革第 ${it.n} 點` : ''}</small>${verFiles(v.d)}${reasonHTML(v, false)}</div>
      ${v.i > 0 ? `<button class="linkish kind" data-cmp="${v.i}">與前版比較</button>` : '<span class="kind">原始條文</span>'}</li>`;
  }
  html += '</ol>';
  html += `<div class="cmp-ctl"><label for="cmp-b">新</label><select id="cmp-b">${opt(cmpSel.b)}</select>
    <label for="cmp-a">舊</label><select id="cmp-a">${opt(cmpSel.a)}</select>
    <span class="segs" role="group" aria-label="顯示方式"><button type="button" data-cm="table" aria-pressed="${cmpMode === 'table'}">對照表</button><button type="button" data-cm="inline" aria-pressed="${cmpMode === 'inline'}">標示差異</button></span></div>`;
  const A = vs[cmpSel.a], B = vs[cmpSel.b];
  const older = A.p2 && cmpSel.a < cmpSel.b ? A.p2 : A.p;
  const dd = diffParas(older, B.p);
  if (cmpMode === 'table') {
    html += `<div class="cmp-wrap"><table class="cmp"><thead><tr><th>${cmpSel.b > cmpSel.a ? '修正條文' : '條文'}（${roc(B.d, true)}）</th><th>${cmpSel.b > cmpSel.a ? '修正前條文' : '條文'}（${roc(A.d, true)}）</th></tr></thead>
      <tbody><tr><td>${dd.new}</td><td>${dd.old}</td></tr>${B.r && B.r.length ? `<tr><td colspan="2" class="cmp-r"><b>說明（${roc(B.d, true)}）</b>${B.r.map((t) => `<p>${esc(t)}</p>`).join('')}</td></tr>` : ''}</tbody></table></div>`;
  } else {
    html += `<div class="inline-diff">${dd.inline}</div>`;
    if (B.r && B.r.length) html += reasonHTML(B, true);
  }
  html += '<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>';
  const it = histItemFor(B.d);
  if (it) html += `<div class="hist-item"><b>沿革第 ${it.n} 點</b><br>${esc(it.t)}</div>`;
  html += srcNote;
  body.innerHTML = html;
}

// ----- 我的註記 -----
function allTags() {
  const s = new Set();
  notes.forEach((r) => (r.tags || []).forEach((t) => s.add(t)));
  return [...s].sort();
}
function renderNotes(body) {
  const rec = recOf(current) || {};
  const hls = rec.hl || [];
  const stks = rec.stk || [];
  const strokes = rec.ink && rec.ink.strokes ? rec.ink.strokes.length : 0;
  const a = byId.get(current);
  const qText = (h) => splitPara(a.p[h.p] || '').body.slice(h.s, h.e);
  let html = `<div class="field"><label for="note-text">文字筆記<small>（以紅色小字顯示在條文下方）</small></label>
    <textarea class="note" id="note-text" placeholder="寫下要件、爭點、考點、實務見解…">${esc(rec.note || '')}</textarea>
    <span class="saved" id="note-saved">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div>`;
  html += `<div class="field"><label for="tag-input">標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" id="tag-input" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點、實務見解" enterkeyhint="done">
    <datalist id="tag-list">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>`;
  html += `<div class="field"><span class="lbl">劃線與行間註記（${hls.length}）</span>`;
  html += hls.length ? `<ul class="hl-list">${hls.map((h) => `<li><div><span class="q"><mark class="hl hl-${h.c}">${esc(qText(h))}</mark></span>${h.n ? `<span class="n">${h.pos === 'down' ? '⤓' : '⤒'} ${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions"><button class="linkish" data-act="hl-note" data-id="${h.id}">${h.n ? '改註' : '加註'}</button><button class="linkish" data-act="hl-del" data-id="${h.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">在條文上選取文字，即可用螢光筆劃線，或「加註」以紅色小字寫在該段文字的上方或下方。</p>';
  html += '</div>';
  html += `<div class="field"><span class="lbl">便利貼（${stks.length}）</span>
    ${stks.length ? `<ul class="hl-list">${stks.map((s) => `<li><div><span class="stk-dot stk-${s.c || 'y'}"></span>${esc(s.text || '（空白）')}</div><div class="row-actions"><button class="linkish" data-act="stk-edit" data-id="${s.id}">編輯</button></div></li>`).join('')}</ul>` : ''}
    <div class="row-actions"><button class="btn small" data-act="stk-add">＋ 貼一張便利貼</button></div></div>`;
  html += `<div class="field"><span class="lbl">手寫（${strokes} 筆）</span>
    <div class="row-actions"><button class="btn small" data-act="ink-on">用 Apple Pencil 在條文上手寫</button>${strokes ? '<button class="btn small danger" data-act="ink-clear">清除本條手寫</button>' : ''}</div></div>`;
  body.innerHTML = html;
  const ta = $('#note-text');
  const save = debounce(() => {
    const r = getRec(current, true);
    r.note = ta.value;
    saveRec(current).then(() => { $('#note-saved') && ($('#note-saved').textContent = '已儲存'); });
    refreshArticle(current);
    refreshChips(current);
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
// 劃線
// ---------------------------------------------------------------------------
let pendingSel = null; // {aid, parts:[{p,s,e}], rect}
let activeHl = null;   // {aid, id}

function offsetIn(pt, node, off) {
  const r = document.createRange();
  r.selectNodeContents(pt);
  try { r.setEnd(node, off); } catch { return null; }
  return r.toString().length;
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
    const len = pt.textContent.length;
    let s = 0, e = len;
    if (pt.contains(range.startContainer)) s = offsetIn(pt, range.startContainer, range.startOffset) ?? 0;
    if (pt.contains(range.endContainer)) e = offsetIn(pt, range.endContainer, range.endOffset) ?? len;
    if (e > s) parts.push({ p: +pt.dataset.p, s, e });
  }
  if (!parts.length) return null;
  return { aid, parts, rect: range.getBoundingClientRect() };
}
function placePop(pop, rect) {
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.bottom + 10;
  if (y + ph > innerHeight - 70) y = rect.top - ph - 10;
  x = Math.max(8, Math.min(innerWidth - pw - 8, x));
  y = Math.max(8, y);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}
function showPop(rect, forExisting, noteText, num) {
  const pop = $('#hl-pop');
  hideXPop();
  pop.hidden = false;
  $('[data-hl="del"]', pop).hidden = !forExisting;
  $('[data-hl="stk"]', pop).hidden = forExisting;
  const pn = $('#pop-note');
  pn.hidden = !noteText;
  pn.innerHTML = noteText ? `${num ? `<b>${circ(num)}</b>` : ''}${esc(noteText)}` : '';
  $('[data-hl="note"]', pop).textContent = noteText ? '改註' : '加註';
  placePop(pop, rect);
}
function hidePop() { $('#hl-pop').hidden = true; pendingSel = null; activeHl = null; }

const onSelChange = debounce(() => {
  if (ink.active || stkDrag) return;
  const c = captureSelection();
  if (c) { pendingSel = c; activeHl = null; showPop(c.rect, false, '', 0); }
  else if (!activeHl && !$('#hl-pop').matches(':hover')) $('#hl-pop').hidden = true;
}, 280);

function applyHighlight(color, withNote) {
  if (activeHl) {
    const r = getRec(activeHl.aid, true);
    const h = (r.hl || []).find((x) => x.id === activeHl.id);
    if (!h) return hidePop();
    if (color === 'del') r.hl = r.hl.filter((x) => x.id !== h.id);
    else if (color === 'note') { const { aid, id } = activeHl; hidePop(); return editHlNote(aid, id); }
    else h.c = color;
    const aid = activeHl.aid;
    saveRec(aid); refreshArticle(aid); refreshChips(aid);
    if (current === aid && detailTab === 'notes') renderDetail();
    return hidePop();
  }
  if (!pendingSel) return;
  const { aid, parts, rect } = pendingSel;
  if (color === 'stk') {
    window.getSelection()?.removeAllRanges();
    hidePop();
    return addSticky(aid, rect);
  }
  const r = getRec(aid, true);
  r.hl = r.hl || [];
  const ids = [];
  for (const pt of parts) {
    const h = { id: uid(), p: pt.p, s: pt.s, e: pt.e, c: color === 'note' ? 'n' : color };
    r.hl.push(h);
    ids.push(h.id);
  }
  window.getSelection()?.removeAllRanges();
  saveRec(aid); refreshArticle(aid); refreshChips(aid);
  if (current === aid) renderDetail();
  hidePop();
  if (withNote) editHlNote(aid, ids[0]);
}

// ---------------------------------------------------------------------------
// 他法引用彈出視窗
// ---------------------------------------------------------------------------
async function showXPop(key, aid, rect) {
  hidePop();
  const pop = $('#x-pop');
  const app = LAW.has(key);
  if (app && !LAW.get(key).ready) { try { await loadLaw(key); } catch {} }
  const p = extText(key, aid) || [];
  const gist = app ? gistOf(aid, key) : '';
  const url = extURL(key, aid);
  pop.innerHTML = `<div class="xp-h"><b>${esc(lawName(key))} ${aidLabel(aid)}</b>${gist ? `<small>（${esc(gist)}）</small>` : ''}</div>
    <div class="xp-t">${p.length ? p.map((t) => `<p>${esc(t)}</p>`).join('') : '（未收錄條文內容）'}</div>
    <div class="pop-row">${app ? `<button class="pop-txt primary" data-xgo="${esc(key)}" data-xa="${aid}">前往${esc(lawShort(key))}${shortLabel(aid)}</button>` : ''}${url ? `<a class="pop-txt" href="${esc(url)}" target="_blank" rel="noopener">全國法規資料庫</a>` : ''}<button class="pop-txt" data-xclose="1">關閉</button></div>`;
  pop.hidden = false;
  placePop(pop, rect);
}
function hideXPop() { $('#x-pop').hidden = true; }

// ---------------------------------------------------------------------------
// 便利貼
// ---------------------------------------------------------------------------
let stkDrag = null;
const STK_COLORS = [['y', '黃'], ['g', '綠'], ['b', '藍'], ['p', '粉'], ['c', '無色']];
function emOf(el) { return parseFloat(getComputedStyle(el).fontSize) || 18; }
function addSticky(aid, rect, at) {
  const el = document.getElementById('a-' + aid);
  if (!el) return;
  const er = el.getBoundingClientRect();
  const em = emOf(el);
  let x, y;
  if (at) { x = (at.x - er.left) / em; y = (at.y - er.top) / em; }
  else if (rect && rect.width) { x = (rect.left - er.left) / em; y = (rect.bottom - er.top) / em + 0.3; }
  else { x = Math.max(0, er.width / em - 13); y = 0.4; }
  x = Math.max(0, Math.min(er.width / em - 6, x));
  y = Math.max(0, y);
  const r = getRec(aid, true);
  r.stk = r.stk || [];
  const s = { id: uid(), x: +x.toFixed(2), y: +y.toFixed(2), w: 11, c: settings.stkColor || 'y', text: '' };
  r.stk.push(s);
  if (settings.hideMine !== flipped.has(nk(aid))) flipArticle(aid);
  saveRec(aid); refreshArticle(aid); refreshChips(aid);
  editSticky(aid, s.id, true);
}
function measureSticky(aid, id) {
  const el = document.querySelector(`#a-${CSS.escape(aid)} .stk[data-stk="${id}"]`);
  const r = getRec(aid);
  const s = r && r.stk && r.stk.find((x) => x.id === id);
  if (el && s && !s.min) {
    const h = +(el.offsetHeight / emOf(el.parentElement)).toFixed(2);
    if (Math.abs((s.h || 0) - h) > 0.1) { s.h = h; saveRec(aid); const art = el.parentElement; art.style.minHeight = (stkMinHeight(r) + 1).toFixed(2) + 'em'; }
  }
}
function editSticky(aid, id, isNew) {
  const r = getRec(aid, true);
  const s = (r.stk || []).find((x) => x.id === id);
  if (!s) return;
  modal({
    title: `${aidLabel(aid)}・便利貼`,
    body: `<textarea class="note" id="m-stk" placeholder="寫在便利貼上的內容（透明貼紙，不會遮住條文）">${esc(s.text || '')}</textarea>
      <div class="set-row"><span class="l">顏色</span><span class="segs" id="m-stkc">${STK_COLORS.map(([c, l]) => `<button type="button" data-c="${c}" aria-pressed="${(s.c || 'y') === c}"><span class="stk-dot stk-${c}"></span>${l}</button>`).join('')}</span></div>
      <div class="set-row"><span class="l">寬度</span><span class="segs" id="m-stkw">${[[8, '窄'], [11, '中'], [16, '寬'], [22, '特寬']].map(([w, l]) => `<button type="button" data-w="${w}" aria-pressed="${(s.w || 11) === w}">${l}</button>`).join('')}</span></div>
      <p class="callout">拖曳便利貼上方的「⋯」可移動位置；按「－」可縮成小標籤。</p>`,
    buttons: [
      { label: '刪除', cls: 'danger', onClick: () => { r.stk = r.stk.filter((x) => x.id !== id); saveRec(aid); refreshArticle(aid); refreshChips(aid); if (current === aid) renderDetail(); toast('已刪除便利貼'); } },
      { label: isNew ? '完成' : '取消', onClick: () => { if (isNew) save(); } },
      { label: '儲存', cls: 'primary', onClick: () => save() },
    ],
    onOpen: (body) => {
      $('#m-stk').focus();
      body.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.c) { s.c = b.dataset.c; settings.stkColor = s.c; saveSettings(); $$('#m-stkc button').forEach((x) => x.setAttribute('aria-pressed', x === b)); }
        if (b.dataset.w) { s.w = +b.dataset.w; $$('#m-stkw button').forEach((x) => x.setAttribute('aria-pressed', x === b)); }
      };
    },
  });
  function save() {
    s.text = $('#m-stk').value.trim();
    s.min = false;
    saveRec(aid); refreshArticle(aid); refreshChips(aid);
    if (current === aid) renderDetail();
    requestAnimationFrame(() => measureSticky(aid, id));
  }
}
function bindStickyDrag(root) {
  root.addEventListener('pointerdown', (e) => {
    const grip = e.target.closest('[data-grip]');
    if (!grip || e.target.closest('[data-stkmin]') || ink.active) return;
    const el = grip.closest('.stk');
    const art = el.closest('.art');
    if (!art) return;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const em = emOf(art);
    stkDrag = { el, art, aid: art.dataset.id, id: el.dataset.stk, em, sx: e.clientX, sy: e.clientY, x0: parseFloat(el.style.left), y0: parseFloat(el.style.top), moved: false };
    el.classList.add('drag');
  });
  root.addEventListener('pointermove', (e) => {
    if (!stkDrag) return;
    const d = stkDrag;
    const dx = (e.clientX - d.sx) / d.em, dy = (e.clientY - d.sy) / d.em;
    if (Math.abs(dx) + Math.abs(dy) > 0.15) d.moved = true;
    const maxX = d.art.clientWidth / d.em - 2;
    d.el.style.left = Math.max(-0.5, Math.min(maxX, d.x0 + dx)).toFixed(2) + 'em';
    d.el.style.top = Math.max(0, d.y0 + dy).toFixed(2) + 'em';
  });
  const end = () => {
    if (!stkDrag) return;
    const d = stkDrag;
    stkDrag = null;
    d.el.classList.remove('drag');
    if (!d.moved) { editSticky(d.aid, d.id); return; }
    const r = getRec(d.aid, true);
    const s = (r.stk || []).find((x) => x.id === d.id);
    if (s) { s.x = parseFloat(d.el.style.left); s.y = parseFloat(d.el.style.top); saveRec(d.aid); d.art.style.minHeight = (stkMinHeight(r) + 1).toFixed(2) + 'em'; }
  };
  root.addEventListener('pointerup', end);
  root.addEventListener('pointercancel', end);
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
function editHlNote(aid, id) {
  const r = getRec(aid, true);
  const h = (r.hl || []).find((x) => x.id === id);
  if (!h) return;
  const sp = splitPara(byId.get(aid).p[h.p] || '');
  let pos = h.pos === 'down' ? 'down' : 'up';
  modal({
    title: `${aidLabel(aid)}・註記`,
    body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(sp.body.slice(h.s, h.e))}」</p>
      <textarea class="note" id="m-hlnote" placeholder="這段文字的說明、要件或爭點（以紅色小字顯示）">${esc(h.n || '')}</textarea>
      <div class="set-row"><span class="l">位置<small>紅字註記放在這段文字的上方或下方</small></span><span class="segs" id="m-pos"><button type="button" data-pos="up" aria-pressed="${pos === 'up'}">上方</button><button type="button" data-pos="down" aria-pressed="${pos === 'down'}">下方</button></span></div>
      <div class="set-row"><span class="l">標示</span><span class="segs" id="m-hlc">${[['n', '無底色'], ['y', '黃'], ['g', '綠'], ['b', '藍'], ['p', '粉'], ['u', '底線']].map(([c, l]) => `<button type="button" data-c="${c}" aria-pressed="${h.c === c}">${l}</button>`).join('')}</span></div>`,
    buttons: [
      { label: '刪除劃線', cls: 'danger', onClick: () => { r.hl = r.hl.filter((x) => x.id !== id); saveRec(aid); refreshArticle(aid); refreshChips(aid); if (current === aid) renderDetail(); } },
      { label: '取消' },
      { label: '儲存', cls: 'primary', onClick: () => { h.n = $('#m-hlnote').value.trim(); h.pos = pos; saveRec(aid); refreshArticle(aid); refreshChips(aid); if (current === aid) renderDetail(); toast('已儲存註記'); } },
    ],
    onOpen: (body) => {
      $('#m-hlnote').focus();
      body.onclick = (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.pos) { pos = b.dataset.pos; $$('#m-pos button').forEach((x) => x.setAttribute('aria-pressed', x === b)); }
        if (b.dataset.c) { h.c = b.dataset.c; $$('#m-hlc button').forEach((x) => x.setAttribute('aria-pressed', x === b)); }
      };
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
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院○年度台上字第○號判決／勞動部○年○月○日勞動福3字第○號函"></div>
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
function editRulingNote(aid, key) {
  const r = getRec(aid, true);
  r.rnote = r.rnote || {};
  modal({
    title: `${key.split(':').slice(1).join(':')}・筆記`,
    body: `<textarea class="note" id="m-rnote" placeholder="這則判解的重點、與本條的關係…">${esc(r.rnote[key] || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => {
      const v = $('#m-rnote').value.trim();
      if (v) r.rnote[key] = v; else delete r.rnote[key];
      saveRec(aid); renderDetail();
    } }],
    onOpen: () => $('#m-rnote').focus(),
  });
}

// ---------------------------------------------------------------------------
// 搜尋（跨法規）與我的註記
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
// 「勞基法 55」「勞退14-1」「民法第一百八十四條」「184」
function parseJump(q) {
  q = q.trim().replace(/\s+/g, '');
  let law = null;
  const cands = [];
  for (const c of REG.laws) for (const j of c.jump) cands.push([j, c.id]);
  cands.sort((a, b) => b[0].length - a[0].length);
  for (const [j, id] of cands) if (q.startsWith(j)) { law = id; q = q.slice(j.length); break; }
  let m = q.match(/^(?:§|第)?(\d+)(?:條)?(?:[-之](\d+))?(?:條)?$/);
  if (m) return { law, aid: m[2] ? `${m[1]}-${m[2]}` : m[1] };
  m = q.match(/^第?([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?$/);
  if (m) return { law, aid: m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1])) };
  return null;
}
let searchLaw = 'all';
function doSearch(q) {
  q = q.trim();
  const box = $('#side-search');
  if (!q) { box.innerHTML = '<p class="side-note">輸入關鍵字，可同時搜尋勞退條例、勞退細則、勞基法、民法的條文、判解與你的註記。輸入「勞基法 55」「勞退 14」或在目前法規輸入條號（例如 24-2）可直接跳到該條。</p>'; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  const laws = REG.laws.map((c) => c.id).filter((id) => LAW.get(id).ready);
  const res = new Map();
  for (const id of laws) {
    const L = LAW.get(id);
    const arts = [];
    for (const a of L.D.articles) { const t = a.p.join(''); const g = gistOf(a.id, id); if (has(t) || (g && has(g))) arts.push([a.id, t, g]); }
    const ruls = [];
    if (L.R) for (const aid in L.R) for (const r of L.R[aid]) {
      const t = r.no + ' ' + (r.parts || []).map((p) => p[1]).join(' ');
      if (has(t)) ruls.push([aid, r, t]);
    }
    const rsn = [];
    for (const [aid, hs] of Object.entries(L.D.changes || {})) for (const h of hs) {
      if (h.r && h.r.length) { const t = h.r.join(''); if (has(t)) { rsn.push([aid, h, t]); } }
    }
    res.set(id, { arts, ruls, rsn });
  }
  const mine = [];
  notes.forEach((r, k) => {
    const [law, aid] = splitKey(k);
    if (!LAW.has(law)) return;
    const t = [r.note || '', ...(r.tags || []), ...(r.hl || []).map((h) => h.n || ''), ...(r.items || []).map((i) => i.no + i.text), ...Object.values(r.rnote || {}), ...(r.stk || []).map((s) => s.text || '')].join(' ');
    if (has(t)) mine.push([law, aid, t]);
  });
  const count = (id) => { const x = res.get(id); return x ? x.arts.length + x.ruls.length + x.rsn.length : 0; };
  const total = laws.reduce((s, id) => s + count(id), 0) + mine.length;
  let html = '';
  const j = parseJump(q);
  if (j) {
    const law = j.law || cur;
    const L = LAW.get(law);
    if (L.ready && L.byId.has(j.aid)) html += `<button class="res jump" data-law="${law}" data-goto="${j.aid}"><b>跳到 ${esc(L.cfg.short)} ${aidLabel(j.aid)}</b><span>${esc(gistOf(j.aid, law) ? `（${gistOf(j.aid, law)}）` : '')}${esc(L.byId.get(j.aid).p.join('').slice(0, 60))}…</span></button>`;
  }
  html += `<div class="filters side-f">${[['all', '全部', total], ...laws.map((id) => [id, lawShort(id), count(id)]), ['mine', '我的註記', mine.length]].map(([k, l, n]) => `<button class="fchip" data-sl="${k}" aria-pressed="${searchLaw === k}">${esc(l)}<i>${n}</i></button>`).join('')}</div>`;
  const show = (id) => searchLaw === 'all' || searchLaw === id;
  for (const id of laws) {
    if (!show(id)) continue;
    const { arts, ruls, rsn } = res.get(id);
    if (!arts.length && !ruls.length && !rsn.length) continue;
    html += `<div class="res-law"><span class="lt-mark lm-${id}">${esc(cfgOf(id).mark)}</span>${esc(lawName(id))}</div>`;
    if (arts.length) {
      html += `<div class="res-group">條文 ${arts.length}</div>`;
      html += arts.slice(0, 120).map(([aid, t, g]) => `<button class="res" data-law="${id}" data-goto="${aid}"><b>${aidLabel(aid)}</b>${g ? `<small class="res-g">（${esc(g)}）</small>` : ''}<span>${snippet(has(t) ? t : g, terms)}</span></button>`).join('');
    }
    if (rsn.length) {
      html += `<div class="res-group">立法・修正理由 ${rsn.length}</div>`;
      html += rsn.slice(0, 60).map(([aid, h, t]) => `<button class="res" data-law="${id}" data-goto="${aid}" data-tab="history"><b>${aidLabel(aid)}・${roc(h.d, true)}${KIND_LABEL[h.k]}</b><span>${snippet(t, terms)}</span></button>`).join('');
    }
    if (ruls.length) {
      html += `<div class="res-group">判解 ${ruls.length}</div>`;
      html += ruls.slice(0, 80).map(([aid, r, t]) => `<button class="res" data-law="${id}" data-goto="${aid}" data-tab="rulings"><b>${esc(r.no)}・${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
    }
  }
  if (mine.length && (searchLaw === 'all' || searchLaw === 'mine')) {
    html += '<div class="res-law">我的註記</div>';
    html += mine.map(([law, aid, t]) => `<button class="res" data-law="${law}" data-goto="${aid}" data-tab="notes"><b>${esc(lawShort(law))} ${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  if (!total) html += '<p class="side-note">找不到符合的結果。</p>';
  if (laws.length < REG.laws.length) html += '<p class="side-note">其他法規載入中，稍後會一併搜尋。</p>';
  box.innerHTML = html;
}
let mineFilter = 'all';
function renderMine() {
  const rows = [];
  const lawIdx = (id) => REG.laws.findIndex((c) => c.id === id);
  notes.forEach((r, k) => {
    if (!r || isEmptyRec(r)) return;
    const [law, aid] = splitKey(k);
    if (!LAW.has(law)) return;
    const f = {
      star: !!r.star, note: !!r.note, hl: !!(r.hl && r.hl.length), ink: !!(r.ink && r.ink.strokes && r.ink.strokes.length),
      stk: !!(r.stk && r.stk.length), item: !!(r.items && r.items.length) || !!(r.imp && Object.keys(r.imp).length),
    };
    rows.push({ law, aid, r, f });
  });
  const key = (aid) => aid.split('-').map(Number);
  rows.sort((a, b) => lawIdx(a.law) - lawIdx(b.law) || key(a.aid)[0] - key(b.aid)[0] || (key(a.aid)[1] || 0) - (key(b.aid)[1] || 0));
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★ 書籤'], ['note', '筆記'], ['hl', '劃線'], ['ink', '手寫'], ['stk', '便利貼'], ['item', '判解']];
  const list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([k, l]) => `<button class="fchip" data-mf="${k}" aria-pressed="${mineFilter === k}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。點條號開啟條文，即可加書籤、寫筆記、劃線、貼便利貼，或開啟手寫模式用 Apple Pencil 直接在條文上書寫。'}</p>`;
  let lastLaw = null;
  for (const { law, aid, r, f } of list) {
    if (law !== lastLaw) { html += `<div class="res-law"><span class="lt-mark lm-${law}">${esc(cfgOf(law).mark)}</span>${esc(lawName(law))}</div>`; lastLaw = law; }
    const bits = [f.star && '★', f.note && '筆記', f.hl && `劃線 ${r.hl.length}`, f.ink && '手寫', f.stk && `便利貼 ${r.stk.length}`, r.items && r.items.length && `自建 ${r.items.length}`, r.imp && Object.keys(r.imp).length && `重要判解 ${Object.keys(r.imp).length}`].filter(Boolean).join('・');
    const L = LAW.get(law);
    const fallback = L.ready && L.byId.get(aid) ? L.byId.get(aid).p.join('').slice(0, 60) : '';
    html += `<button class="res" data-law="${law}" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b> <small style="color:var(--faint)">${bits}</small><span>${esc(r.note || (r.tags || []).map((t) => '#' + t).join(' ') || (r.stk && r.stk[0] && r.stk[0].text) || fallback)}</span></button>`;
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
  document.body.classList.toggle('side-tap', settings.side === 'tap');
  document.body.classList.toggle('side-inline', settings.side === 'inline');
  requestAnimationFrame(() => ink.redrawAll());
}
function exportData() {
  return JSON.stringify({ app: 'law-notes', version: 2, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) });
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || !['law-notes', 'civil-code-notes'].includes(data.app) || !data.notes) throw new Error('不是法典註記本的備份檔');
  if (replace) { await store.clearAll(); notes.clear(); }
  for (const [k, rec] of Object.entries(data.notes)) {
    const [law] = splitKey(k);
    if (!LAW.has(law)) continue;
    if (!replace && notes.has(k)) {
      const c = notes.get(k);
      const merged = { ...rec, ...c };
      merged.note = [c.note, rec.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
      merged.tags = Array.from(new Set([...(c.tags || []), ...(rec.tags || [])]));
      const byIdMerge = (a = [], b = []) => { const m = new Map(); [...b, ...a].forEach((x) => m.set(x.id, x)); return [...m.values()]; };
      merged.hl = byIdMerge(c.hl, rec.hl);
      merged.items = byIdMerge(c.items, rec.items);
      merged.stk = byIdMerge(c.stk, rec.stk);
      merged.imp = { ...(rec.imp || {}), ...(c.imp || {}) };
      merged.rnote = { ...(rec.rnote || {}), ...(c.rnote || {}) };
      if (rec.ink && c.ink) merged.ink = { ...c.ink, strokes: [...(c.ink.strokes || []), ...(rec.ink.strokes || [])] };
      merged.star = c.star || rec.star;
      notes.set(k, merged);
    } else notes.set(k, rec);
    const [l2, a2] = splitKey(k);
    await saveRec(a2, l2);
  }
  if (data.settings && replace) { settings = { ...settings, ...data.settings }; await saveSettings(); applySettings(); }
  renderReader();
  if (current) renderDetail();
}
function openSettings() {
  const seg = (k, opts) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${k}" data-val="${v}" aria-pressed="${String(settings[k]) === String(v)}">${l}</button>`).join('')}</span>`;
  const n = [...notes.values()].filter((r) => !isEmptyRec(r)).length;
  const lawsInfo = REG.laws.map((c) => {
    const L = LAW.get(c.id);
    if (!L.ready) return `${esc(c.name)}：尚未載入`;
    const m = L.D.meta;
    const nr = L.R ? Object.values(L.R).reduce((s, v) => s + v.length, 0) : 0;
    return `${esc(c.name)}：${m.kind === 'order' ? '修正發布' : '修正'} ${roc(m.modified)}，${L.D.articles.length} 條${L.R ? `，判解 ${nr} 筆` : ''}${m.effectiveNote ? `。${esc(m.effectiveNote)}` : ''}`;
  }).join('<br>');
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距<small>「手寫」「特寬」在行與行之間留出書寫空間</small></span>${seg('lh', [['1.7', '緊'], ['1.9', '中'], ['2.2', '鬆'], ['2.7', '手寫'], ['3.3', '特寬']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示同條各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">註記</div>
      <div class="set-row"><span class="l">文字註記顯示<small>行間：紅色小字寫在文字上方或下方；旁註：顯示在條文旁；點選：點螢光文字才顯示</small></span>${seg('side', [['inline', '行間'], ['margin', '旁註'], ['tap', '點選']])}</div>
      <div class="set-row"><span class="l">點條文切換註記<small>用手指點一下條文，即可顯示／隱藏該條自己的註記；兩指點一下切換全部</small></span>${seg('tapToggle', [['true', '開'], ['false', '關']])}</div>
      <div class="set-row"><span class="l">引用條文<small>條文引用他法（如勞基法）時，在下方以小字列出被引用條文</small></span>${seg('xopen', [['false', '收合'], ['true', '展開']])}</div>
      <div class="set-row"><span class="l">判解／修正標記</span>${seg('chips', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">目前共有 ${n} 條有註記<small>儲存方式：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>可選檔案或貼上 JSON（也可匯入舊版「民法註記本」備份）</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料</div>
      <div class="meta-list">${lawsInfo}<br>
        條文：全國法規資料庫（法務部）；勞退條例、勞基法之歷次條文與立法／修正理由：立法院法律系統；判解：全國法規資料庫各條「憲法法庭裁判」「大法官解釋」「判例」。條號下括號內之條旨為編者整理。<br>
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
          settings[k] = (k === 'theme' || k === 'side') ? v : k === 'lh' ? +v : v === 'true';
          $$(`[data-set="${k}"]`, body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          saveSettings(); applySettings();
          if (['chips', 'pn', 'side', 'xopen'].includes(k)) { renderReader(); applyVisibility(); if (current) renderDetail(); }
        } else if (b.dataset.size) {
          settings.size = Math.max(14, Math.min(28, settings.size + +b.dataset.size));
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
  getRec,
  saveRec,
  onChange: (aid) => {
    refreshChips(aid);
    const el = document.getElementById('a-' + aid);
    const r = recOf(aid);
    if (el) el.classList.toggle('has-ink', !!(r && r.ink && r.ink.strokes && r.ink.strokes.length));
    if (current === aid && detailTab === 'notes') renderDetail();
  },
});
let stkTool = false;
function setInk(on) {
  if (on && settings.hideMine) setHideMine(false, true);
  if (on) { flipped.clear(); applyVisibility(); }
  ink.setActive(on);
  stkTool = false;
  $('#btn-ink').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#inkbar').hidden = !on;
  syncInkbar();
  if (on) { hidePop(); hideXPop(); window.getSelection()?.removeAllRanges(); toast('手寫模式：用 Apple Pencil 在條文上書寫，手指可捲動'); }
}
function syncInkbar() {
  const bar = $('#inkbar');
  $$('[data-pen]', bar).forEach((x) => x.setAttribute('aria-pressed', String(!stkTool && ink.tool !== 'eraser' && x.dataset.pen === ink.color)));
  $('[data-tool="eraser"]', bar).setAttribute('aria-pressed', String(!stkTool && ink.tool === 'eraser'));
  $('[data-tool="stk"]', bar).setAttribute('aria-pressed', String(stkTool));
  $('#w-range').value = widthToSlider(ink.width);
  $('#w-val').textContent = ink.width < 1 ? ink.width.toFixed(ink.width < 0.15 ? 1 : 2).replace(/0$/, '') : String(ink.width);
  $$('[data-w]', bar).forEach((x) => x.setAttribute('aria-pressed', String(+x.dataset.w === ink.width)));
  $('#w-prev').style.height = Math.max(0.5, ink.width) + 'px';
  $('#w-prev').style.opacity = ink.width < 0.5 ? 0.35 + ink.width : 1;
  $('#w-prev').style.background = `var(--pen-${ink.color})`;
  bar.classList.toggle('marker', ink.tool === 'marker');
}
function buildInkbar() {
  const bar = $('#inkbar');
  $('#ink-colors').innerHTML = PEN_COLORS.map(([c, l, t]) => `<button class="sw sw-${c}" data-pen="${c}" data-t="${t || 'pen'}" title="${l}" aria-label="${l}"></button>`).join('');
  $('#w-presets').innerHTML = WIDTH_PRESETS.map((w) => `<button class="tool-txt wp" data-w="${w}">${w}</button>`).join('');
  ink.color = settings.penColor || 'red';
  ink.width = settings.penWidth || 0.6;
  ink.tool = PEN_COLORS.find((x) => x[0] === ink.color)?.[2] === 'marker' ? 'marker' : 'pen';
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.pen) {
      ink.color = b.dataset.pen; ink.tool = b.dataset.t === 'marker' ? 'marker' : 'pen'; stkTool = false;
      settings.penColor = ink.color; saveSettings();
    } else if (b.dataset.tool === 'eraser') { ink.tool = 'eraser'; stkTool = false; }
    else if (b.dataset.tool === 'stk') { stkTool = !stkTool; if (stkTool) toast('點一下條文，在該處貼上便利貼'); }
    else if (b.dataset.w) { ink.width = +b.dataset.w; settings.penWidth = ink.width; saveSettings(); if (ink.tool === 'eraser') ink.tool = 'pen'; }
    else if (b.dataset.act === 'undo') { if (!ink.undoLast()) toast('沒有可復原的筆畫'); }
    else if (b.dataset.act === 'finger') {
      ink.finger = !ink.finger;
      b.setAttribute('aria-pressed', ink.finger ? 'true' : 'false');
      document.body.classList.toggle('finger', ink.finger);
      toast(ink.finger ? '手指也可書寫（捲動請用兩指）' : '只有 Apple Pencil 可書寫');
    } else if (b.dataset.act === 'done') { setInk(false); return; }
    syncInkbar();
  });
  $('#w-range').addEventListener('input', (e) => {
    ink.width = sliderToWidth(+e.target.value);
    if (ink.tool === 'eraser') ink.tool = 'pen';
    settings.penWidth = ink.width;
    syncInkbar();
  });
  $('#w-range').addEventListener('change', saveSettings);
  syncInkbar();
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
let lastPointer = 'mouse';
function bind() {
  $('#btn-nav').onclick = () => setSide(!$('#sidebar').classList.contains('open'));
  $('#brand').onclick = () => { if (isNarrow()) setSide(true); showSide('toc'); };
  $('#scrim').onclick = () => setSide(false);
  $('#btn-settings').onclick = openSettings;
  $('#btn-ink').onclick = () => setInk(!ink.active);
  $('#btn-eye').onclick = () => setHideMine(!settings.hideMine);
  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => { const i = order.indexOf(current); if (i > 0) gotoArticle(order[i - 1], { flash: false }); };
  $('#d-next').onclick = () => { const i = order.indexOf(current); if (i < order.length - 1) gotoArticle(order[i + 1], { flash: false }); };
  $('#d-star').onclick = () => {
    const r = getRec(current, true);
    r.star = !r.star;
    saveRec(current); refreshChips(current);
    $('#d-star').setAttribute('aria-pressed', r.star ? 'true' : 'false');
    toast(r.star ? '已加入書籤' : '已移除書籤');
  };
  $$('.seg button').forEach((b) => { b.onclick = () => showSide(b.dataset.side); });
  $$('.tabs button').forEach((b) => { b.onclick = () => { detailTab = b.dataset.tab; renderDetail(); }; });
  $('#law-tabs').addEventListener('click', (e) => {
    const b = e.target.closest('[data-law]');
    if (b) { switchLaw(b.dataset.law); showSide('toc'); }
  });

  // 搜尋
  const q = $('#q');
  const run = debounce(() => { showSide('search'); doSearch(q.value); }, 220);
  q.addEventListener('input', () => { if (q.value.trim()) run(); });
  q.addEventListener('focus', () => { if (q.value.trim()) { showSide('search'); setSide(true); } });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const j = parseJump(q.value);
    if (j) {
      const law = j.law || cur;
      const L = LAW.get(law);
      if (L.ready && L.byId.has(j.aid)) { switchLaw(law, { aid: j.aid }); q.blur(); return; }
    }
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

  // 結果清單
  for (const id of ['#side-search', '#side-mine']) {
    $(id).addEventListener('click', (e) => {
      const mf = e.target.closest('[data-mf]');
      if (mf) { mineFilter = mf.dataset.mf; renderMine(); return; }
      const sl = e.target.closest('[data-sl]');
      if (sl) { searchLaw = sl.dataset.sl; doSearch($('#q').value); return; }
      const b = e.target.closest('[data-goto]');
      if (!b) return;
      if (b.dataset.tab) detailTab = b.dataset.tab;
      switchLaw(b.dataset.law || cur, { aid: b.dataset.goto, tab: b.dataset.tab });
    });
  }

  // 閱讀區
  const reader = $('#reader');
  reader.addEventListener('scroll', () => { trackTOC(); if (!$('#hl-pop').hidden && !pendingSel) hidePop(); hideXPop(); }, { passive: true });
  document.addEventListener('pointerdown', (e) => { lastPointer = e.pointerType || 'mouse'; }, true);
  const clickArticle = (e) => {
    if (stkTool && ink.active) {
      const art = e.target.closest('.art');
      if (art) { addSticky(art.dataset.id, null, { x: e.clientX, y: e.clientY }); stkTool = false; syncInkbar(); }
      return;
    }
    if (ink.active) return;
    const xl = e.target.closest('[data-xl]');
    if (xl) { e.preventDefault(); showXPop(xl.dataset.xl, xl.dataset.xa, xl.getBoundingClientRect()); return; }
    const go = e.target.closest('[data-goto]');
    if (go) { e.preventDefault(); gotoArticle(go.dataset.goto); return; }
    if (e.target.closest('.stk')) {
      const mn = e.target.closest('[data-stkmin]');
      if (mn) {
        const aid = mn.closest('[data-id]').dataset.id;
        const r = getRec(aid, true);
        const s = (r.stk || []).find((x) => x.id === mn.dataset.stkmin);
        if (s) { s.min = !s.min; saveRec(aid); refreshArticle(aid); if (!s.min) requestAnimationFrame(() => measureSticky(aid, s.id)); }
      } else if (!e.target.closest('[data-grip]')) {
        const st = e.target.closest('.stk');
        editSticky(st.closest('[data-id]').dataset.id, st.dataset.stk);
      }
      return;
    }
    const op = e.target.closest('[data-open]');
    if (op) { openDetail(op.dataset.open, op.dataset.tab); return; }
    const sel = window.getSelection();
    const hl = e.target.closest('.hl[data-hl], .iln-a[data-hl]');
    if (hl && (!sel || sel.isCollapsed)) {
      const host = hl.closest('[data-id]');
      activeHl = { aid: host.dataset.id, id: hl.dataset.hl };
      pendingSel = null;
      const rec = getRec(activeHl.aid);
      const h = rec && (rec.hl || []).find((x) => x.id === activeHl.id);
      showPop(hl.getBoundingClientRect(), true, h && h.n, h && h.n && settings.side !== 'inline' ? noteNumbers(rec).get(h.id) : 0);
      return;
    }
    const sn = e.target.closest('[data-sn]');
    if (sn) { editHlNote(sn.closest('[data-id]').dataset.id, sn.dataset.sn); return; }
    // 手指點一下條文：切換本條自己的註記
    const art = e.target.closest('.art');
    if (art && settings.tapToggle && lastPointer === 'touch' && (!sel || sel.isCollapsed) && e.target.closest('.atext')
      && !e.target.closest('a, button, summary, details') && hasMine(recOf(art.dataset.id))) {
      flipArticle(art.dataset.id);
    }
  };
  reader.addEventListener('click', clickArticle);
  $('#d-text').addEventListener('click', clickArticle);
  bindStickyDrag(reader);

  // 兩指點一下：全部註記顯示／隱藏
  let two = null;
  reader.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2 && !ink.active) two = { t: Date.now(), x: e.touches[0].clientX + e.touches[1].clientX, y: e.touches[0].clientY + e.touches[1].clientY, moved: false };
    else if (e.touches.length > 2) two = null;
  }, { passive: true });
  reader.addEventListener('touchmove', (e) => {
    if (!two || e.touches.length < 2) return;
    const x = e.touches[0].clientX + e.touches[1].clientX, y = e.touches[0].clientY + e.touches[1].clientY;
    if (Math.abs(x - two.x) + Math.abs(y - two.y) > 30) two.moved = true;
  }, { passive: true });
  reader.addEventListener('touchend', (e) => {
    if (two && e.touches.length === 0) {
      if (!two.moved && Date.now() - two.t < 350 && settings.tapToggle) setHideMine(!settings.hideMine);
      two = null;
    }
  }, { passive: true });

  document.addEventListener('selectionchange', onSelChange);
  $('#hl-pop').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (!b) return;
    const v = b.dataset.hl;
    if (v === 'note') applyHighlight('note', true);
    else applyHighlight(v, false);
  });
  $('#x-pop').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.xgo) { hideXPop(); switchLaw(b.dataset.xgo, { aid: b.dataset.xa }); }
    else if (b.dataset.xclose) hideXPop();
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop') && !e.target.closest('.hl, .iln-a')) {
      setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hidePop(); }, 10);
    }
    if (!$('#x-pop').hidden && !e.target.closest('#x-pop') && !e.target.closest('[data-xl]')) hideXPop();
  });

  // 詳細面板內容
  $('#d-body').addEventListener('click', async (e) => {
    const xl = e.target.closest('[data-xl]');
    if (xl) { e.preventDefault(); showXPop(xl.dataset.xl, xl.dataset.xa, xl.getBoundingClientRect()); return; }
    const b = e.target.closest('button, [data-goto]');
    if (!b) return;
    if (b.dataset.goto) { e.preventDefault(); gotoArticle(b.dataset.goto); return; }
    if (b.dataset.rf) { rulFilter = b.dataset.rf; renderDetail(); return; }
    if (b.dataset.cm) { cmpMode = b.dataset.cm; renderHistory($('#d-body')); return; }
    if (b.dataset.cmp) { const i = +b.dataset.cmp; cmpSel = { aid: current, a: i - 1, b: i }; renderHistory($('#d-body')); return; }
    const card = b.closest('.rcard');
    const act = b.dataset.act;
    if (act === 'add-item') editItem(current);
    else if (act === 'copy-q') {
      try { await navigator.clipboard.writeText(b.dataset.q); toast('已複製，可到裁判書查詢貼上'); } catch { toast(b.dataset.q); }
    } else if (act === 'imp' && card) {
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
      saveRec(current); refreshArticle(current); refreshChips(current); renderDetail();
    } else if (act === 'stk-add') { gotoArticle(current, { open: false }); setTimeout(() => addSticky(current), 220); }
    else if (act === 'stk-edit') editSticky(current, b.dataset.id);
    else if (act === 'ink-on') {
      setInk(true);
      if (matchMedia('(max-width: 760px)').matches) closeDetail();
      gotoArticle(current, { open: false });
    } else if (act === 'ink-clear') { ink.clear(current); toast('已清除，可按「復原」還原'); }
  });
  $('#d-body').addEventListener('change', (e) => {
    if (e.target.id === 'cmp-a' || e.target.id === 'cmp-b') {
      cmpSel[e.target.id === 'cmp-a' ? 'a' : 'b'] = +e.target.value;
      renderHistory($('#d-body'));
    }
  });

  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h && (h.law !== cur || h.aid !== current)) switchLaw(h.law, { aid: h.aid });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#x-pop').hidden) hideXPop();
      else if (!$('#hl-pop').hidden) hidePop();
      else if (ink.active) setInk(false);
      else if (current) closeDetail();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => ink.redrawAll());
}
function parseHash() {
  let m = location.hash.match(/^#([a-z]+)\/a-(\d+(?:-\d+)?)$/);
  if (m && LAW.has(m[1])) return { law: m[1], aid: m[2] };
  m = location.hash.match(/^#a-(\d+(?:-\d+)?)$/);
  if (m) return { law: cur || settings.law || REG.default, aid: m[1] };
  m = location.hash.match(/^#([a-z]+)$/);
  if (m && LAW.has(m[1])) return { law: m[1] };
  return null;
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const [reg, saved, gists, refs] = await Promise.all([
      fetch('data/laws.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      store.getAll().catch(() => ({})),
      fetch('data/gists.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch('data/refs.json').then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
    ]);
    REG = reg; G = gists; X = refs;
    for (const c of REG.laws) LAW.set(c.id, { cfg: c });
    NAMES = [...REG.laws.map((c) => [c.name, c.id]), ...Object.keys(X).map((n) => [n, n])].sort((a, b) => b[0].length - a[0].length);
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('a:')) notes.set(k.slice(2), v);
      else if (k === 'settings') settings = { ...settings, ...v };
    }
  } catch (e) {
    $('#loading').textContent = '無法載入資料：' + e.message;
    return;
  }
  applySettings();
  bind();
  buildInkbar();
  const h = parseHash();
  const first = (h && h.law) || (LAW.has(settings.law) ? settings.law : REG.default);
  try { await switchLaw(first, { aid: h && h.aid }); }
  catch (e) { $('#reader-inner').innerHTML = `<div class="loading">無法載入條文資料：${esc(e.message)}</div>`; return; }
  doSearch('');
  // 背景載入其他法規（跨法規搜尋、引用條文）
  Promise.all(REG.laws.map((c) => loadLaw(c.id).catch(() => null))).then(() => {
    refreshXrefBlocks();
    REG.laws.forEach((c) => loadRulings(c.id));
    if ($('#q').value.trim()) doSearch($('#q').value);
  });
  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
