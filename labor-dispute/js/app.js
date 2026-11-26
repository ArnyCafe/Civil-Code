import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, WIDTHS } from './ink.js';

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let D = null;              // 法規資料
const byId = new Map();    // aid -> article
const order = [];          // aid 順序
const notes = new Map();   // aid -> 使用者紀錄
const builtin = new Map(); // aid -> 內建註記 [{id,p,s,e,n,pos,b}]
const citedBy = new Map(); // aid -> [引用本條之條號]
let settings = { theme: 'system', size: 19, lh: 2, pn: true, chips: true, anno: true, builtin: true, refs: true, tap: true };
let current = null;
let detailTab = 'rulings';
let rulFilter = 'all';
let cmpMode = 'table';
let cmpSel = null;

const TYPE_LABEL = { P: '判決', F: '函釋', J: '判例', C: '大法官解釋', CJ: '憲法法庭', U: '我的' };
const USER_KINDS = ['判決', '函釋', '裁決決定', '決議', '其他'];
const KIND_LABEL = { orig: '制定', new: '增訂', amend: '修正', del: '刪除', old: '舊法' };
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const circ = (n) => CIRCLED[n - 1] || `(${n})`;

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function aidLabel(aid) {
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
  }
  return total + cur;
}
function parseAidInput(q) {
  q = q.trim().replace(/\s+/g, '');
  let m = q.match(/^(?:勞資爭議處理法|勞爭法)?第?(\d+)(?:條)?(?:[-之](\d+))?(?:條)?$/);
  if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
  m = q.match(/^(?:勞資爭議處理法)?第?([零〇一二三四五六七八九十百]+)條(?:之([一二三四五六七八九十]+))?$/);
  if (m) return m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1]));
  return null;
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2200);
}
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
const uid = () => Math.random().toString(36).slice(2, 9);
function headingPath(hidx) {
  const out = [];
  while (hidx >= 0) { out.unshift(D.headings[hidx].t); hidx = D.headings[hidx].p; }
  return out;
}
const isPenLike = (e) => e.pointerType === 'pen';

// ---------------------------------------------------------------------------
// 使用者紀錄
// ---------------------------------------------------------------------------
function getRec(aid, create) {
  let r = notes.get(aid);
  if (!r && create) { r = {}; notes.set(aid, r); }
  return r;
}
function isEmptyRec(r) {
  return !r || (!r.star && !r.note && !(r.tags && r.tags.length) && !(r.hl && r.hl.length) &&
    !(r.ink && r.ink.strokes && r.ink.strokes.length) && !(r.items && r.items.length) &&
    !(r.imp && Object.keys(r.imp).length) && !(r.rnote && Object.keys(r.rnote).length) &&
    !(r.vis && Object.keys(r.vis).length));
}
async function saveRec(aid) {
  const r = notes.get(aid);
  try {
    if (isEmptyRec(r)) { notes.delete(aid); await store.del('a:' + aid); }
    else { r.t = Date.now(); await store.put('a:' + aid, r); }
  } catch (e) {
    console.error(e);
    toast('無法儲存註記：' + (e.message || e));
  }
}
async function saveSettings() { try { await store.put('settings', settings); } catch {} }
function hasUserMarks(r) {
  return !!(r && (r.note || (r.hl && r.hl.length) || (r.ink && r.ink.strokes && r.ink.strokes.length)));
}

// ---------------------------------------------------------------------------
// 註記顯示狀態
// ---------------------------------------------------------------------------
function isVisible(aid, id, kind) {
  const r = notes.get(aid);
  if (r && r.vis && id in r.vis) return !!r.vis[id];
  return defaultVis(kind);
}
// 預設：紅字依「註記」開關；條文明文引用之他法依「相關法條」開關；「另見」類預設收合
function defaultVis(kind) { return kind === 'refx' ? false : kind === 'ref' ? settings.refs : settings.anno; }
function refKind(aid, id) { const r = (D.refs[aid] || [])[+String(id).slice(1)]; return r && r.extra ? 'refx' : 'ref'; }
function kindOfId(aid, id) { return /^r\d+$/.test(id) ? refKind(aid, id) : 'anno'; }
function setVisible(aid, id, on, kind) {
  const r = getRec(aid, true);
  r.vis = r.vis || {};
  const def = defaultVis(kind || kindOfId(aid, id));
  if (on === def) delete r.vis[id]; else r.vis[id] = on ? 1 : 0;
}
// 某條全部註記（使用者＋內建）
function annosOf(aid) {
  const out = [];
  const r = notes.get(aid);
  for (const h of (r && r.hl) || []) if (h.n) out.push({ id: h.id, p: h.p, s: h.s, e: h.e, n: h.n, pos: h.pos || 'below', b: false });
  if (settings.builtin) for (const b of builtin.get(aid) || []) out.push(b);
  return out;
}
function refsOf(aid) {
  return (D.refs[aid] || []).map((r, i) => ({ ...r, id: 'r' + i }));
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

// 本法條文內引用條號 → 連結（他法條號不連結）
const XREF_CN = /第([零〇一二三四五六七八九十百]+)條(?:之([一二三四五六七八九十]+))?/g;
const XREF_AR = /第\s*(\d+)\s*條(?:之\s*(\d+))?/g;
function xrefRanges(text, mode) {
  const out = [];
  const test = (re, conv) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 14), m.index);
      if (mode === 'law') {
        if (/[法則例]$/.test(before) && !/本法$/.test(before)) continue;
      } else if (!/(勞資爭議處理法|本法)$/.test(before)) continue;
      const aid = m[2] ? `${conv(m[1])}-${conv(m[2])}` : String(conv(m[1]));
      if (byId.has(aid)) out.push({ s: m.index, e: m.index + m[0].length, aid });
    }
  };
  test(XREF_CN, cnNum);
  if (mode !== 'law') test(XREF_AR, Number);
  return out.sort((a, b) => a.s - b.s);
}

// 估計紅字註記能否直接排在文字正上／下方（行間），否則改排在段落上／下方的註記列
function rubyFits(a) {
  const base = a.e - a.s;
  return base <= 16 && a.n.length * 0.5 <= base + 1.2;
}

function renderRich(text, { hls = [], annos = [], lrefs = [], mode = 'law' } = {}) {
  const L = text.length;
  const clamp = (x) => Math.max(0, Math.min(L, x));
  const xr = xrefRanges(text, mode);
  const rubies = [];
  for (const a of [...annos].sort((x, y) => x.s - y.s || y.e - x.e)) {
    if (a.mode === 'ruby' && !rubies.some((r) => r.s < a.e && a.s < r.e) &&
      !xr.some((x) => (x.s < a.s && x.e > a.s) || (x.s < a.e && x.e > a.e)) &&
      !lrefs.some((x) => (x.s < a.s && x.e > a.s) || (x.s < a.e && x.e > a.e))) rubies.push(a);
    else if (a.mode === 'ruby') a.mode = 'band';
  }
  const cuts = new Set([0, L]);
  const add = (r) => { cuts.add(clamp(r.s)); cuts.add(clamp(r.e)); };
  hls.forEach(add); annos.forEach(add); lrefs.forEach(add); xr.forEach(add);
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  let open = null;
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    if (!open) {
      open = rubies.find((r) => r.s === s) || null;
      if (open) html += `<ruby class="an an-${open.pos}${open.vis ? '' : ' off'}${open.b ? ' bi' : ''}" data-an="${open.id}">`;
    }
    let piece = esc(text.slice(s, e));
    const x = xr.find((r) => r.s <= s && r.e >= e);
    if (x) piece = `<a class="xref" href="#a-${x.aid}" data-goto="${x.aid}">${piece}</a>`;
    const lr = lrefs.find((r) => r.s <= s && r.e >= e);
    if (lr) piece = `<span class="lref${lr.vis ? '' : ' off'}" data-lr="${lr.id}">${piece}</span>`;
    const ba = annos.filter((a) => a.mode === 'band' && a.s <= s && a.e >= e);
    if (ba.length) {
      const top = ba[ba.length - 1];
      piece = `<span class="an-u${ba.some((a) => a.vis) ? '' : ' off'}${ba.every((a) => a.b) ? ' bi' : ''}" data-an="${top.id}">${piece}</span>`;
    }
    let h = null;
    for (const c of hls) if (c.s <= s && c.e >= e && c.c && c.c !== 'n') h = c;
    if (h) piece = `<mark class="hl hl-${h.c}" data-hl="${h.id}">${piece}</mark>`;
    html += piece;
    for (const a of annos) if (a.mode === 'band' && a.e === e) html += `<sup class="an-m${a.vis ? '' : ' off'}${a.b ? ' bi' : ''}" data-an="${a.id}">${circ(a.num)}</sup>`;
    if (open && open.e === e) {
      html += `<rt>${esc(open.n)}</rt></ruby>`;
      open = null;
    }
  }
  return html;
}

// 他法條文（指定項、款）
function refText(r) {
  const law = D.reflaws[r.pcode];
  if (!law) return { head: '', paras: [] };
  const list = r.flnos || [r.flno];
  const out = [];
  for (const no of list) {
    const paras = law.arts[no];
    if (!paras) continue;
    let sel = paras;
    if (r.x) {
      sel = [];
      let xi = 0;
      for (const t of paras) {
        const sp = splitPara(t);
        if (sp.kind === 'xiang') xi++;
        if (xi === r.x) {
          if (sp.kind !== 'xiang' && r.k) {
            const kn = cnNum(sp.mark.replace(/[、（）()]/g, ''));
            if (!r.k.includes(kn)) continue;
          }
          sel.push(t);
        }
      }
      if (!sel.length) sel = paras;
    }
    out.push({ no, paras: sel });
  }
  return { law, items: out };
}
function refLabel(r) {
  const law = D.reflaws[r.pcode];
  const name = law ? law.name : '';
  if (r.ch) return `${name}第${r.ch}章`;
  const [a, b] = String(r.flno).split('-');
  return `${name}第${a}條${b ? '之' + b : ''}${r.x ? `第${r.x}項` : ''}${r.k ? (r.k.length > 1 ? `第${r.k[0]}至${r.k[r.k.length - 1]}款` : `第${r.k[0]}款`) : ''}`;
}
function refBandItem(aid, r) {
  const vis = isVisible(aid, r.id, r.extra ? 'refx' : 'ref');
  const label = refLabel(r);
  if (!vis && (r.q || !settings.refs)) return '';
  if (!vis) return `<button class="rf off" data-rf="${r.id}">＋ ${r.extra ? '另見 ' : ''}${esc(label)}</button>`;
  const { items } = refText(r);
  const body = (items || []).map((it) => {
    const txt = it.paras.join(' ');
    const head = r.flnos ? `第${it.no}條　` : '';
    return `<span class="rf-t${txt.length > 110 ? ' clamp' : ''}">${esc(head)}${esc(txt)}</span>${txt.length > 110 ? '<button class="rf-more" data-rfx>展開</button>' : ''}`;
  }).join('');
  return `<div class="rf${r.extra ? ' extra' : ''}" data-rf="${r.id}"><span class="rf-h">${r.extra ? '另見　' : ''}${esc(label)}${r.why && r.extra ? `<i>（${esc(r.why)}）</i>` : ''}</span>${body}</div>`;
}

function renderParas(a, rec, opts = {}) {
  const { plain = false } = opts;
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  const annos = plain ? [] : annosOf(a.id).map((x) => ({ ...x, vis: isVisible(a.id, x.id), mode: rubyFits(x) ? 'ruby' : 'band' }));
  const refs = plain ? [] : refsOf(a.id);
  // 段落內位置
  const bodies = a.p.map((t) => splitPara(t));
  for (const r of refs) {
    if (!r.q) continue;
    const i = bodies[r.p] ? bodies[r.p].body.indexOf(r.q) : -1;
    if (i >= 0) { r.s = i; r.e = i + r.q.length; }
  }
  // 第一輪：決定每則註記排在行間（ruby）或段落上下方的註記列（重疊者改註記列）
  const out = bodies.map((sp, i) => {
    const hls = ((rec && rec.hl) || []).filter((h) => h.p === i);
    const pa = annos.filter((x) => x.p === i);
    const lr = refs.filter((r) => r.p === i && r.s != null).map((r) => ({ id: r.id, s: r.s, e: r.e, vis: isVisible(a.id, r.id, 'ref') }));
    renderRich(sp.body, { hls, annos: pa, lrefs: lr });
    return { sp, i, hls, pa, lr };
  });
  // 註記列依位置編號 ①②③
  let num = 0, xi = 0;
  for (const x of annos.filter((y) => y.mode === 'band').sort((x, y) => x.p - y.p || x.s - y.s)) x.num = ++num;
  return out.map(({ sp, i, hls, pa, lr }) => {
    const body = renderRich(sp.body, { hls, annos: pa, lrefs: lr });
    let para;
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      para = `<p class="para"><span class="pn">${pn}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    } else {
      para = `<p class="para ${sp.kind === 'kuan' ? 'kuan' : 'kuan sub'}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    }
    if (plain) return para;
    const band = (pos) => pa.filter((x) => x.mode === 'band' && x.pos === pos).sort((x, y) => x.s - y.s)
      .map((x) => `<span class="an-n${x.vis ? '' : ' off'}${x.b ? ' bi' : ''}" data-ann="${x.id}"><b>${circ(x.num)}</b>${esc(x.n)}</span>`).join('');
    const above = band('above'), below = band('below');
    const rf = refs.filter((r) => r.p === i).map((r) => refBandItem(a.id, r)).join('');
    const cls = sp.kind === 'xiang' ? '' : ' k';
    return `<div class="pw${cls}">${above ? `<div class="band above">${above}</div>` : ''}${para}${below ? `<div class="band below">${below}</div>` : ''}${rf ? `<div class="rfband">${rf}</div>` : ''}</div>`;
  }).join('');
}

function rulingList(aid) {
  const rec = notes.get(aid) || {};
  const imp = rec.imp || {};
  const list = ((D.rulings[aid]) || []).map((r, i) => ({ ...r, key: r.key || (r.ty + ':' + r.no), idx: i }));
  for (const it of rec.items || []) list.push({ ...it, ty: 'U', key: 'U:' + it.id, user: true });
  for (const r of list) r.mark = r.key in imp ? !!imp[r.key] : !!r.imp;
  return list;
}
function rulingCount(aid) { return rulingList(aid).length; }
function amendCount(aid) {
  const c = D.changes[aid];
  return c ? c.filter((h) => h.k !== 'old').length - 1 + (c.some((h) => h.k === 'old') ? 1 : 0) : 0;
}

function chipsHTML(aid) {
  const rec = notes.get(aid);
  const out = [];
  if (rec && rec.star) out.push('<span class="chip c-star" title="書籤">★</span>');
  const an = annosOf(aid);
  if (an.length) {
    const vis = an.filter((x) => isVisible(aid, x.id)).length;
    out.push(`<button class="chip c-anno${vis ? ' on' : ''}" data-art-toggle="${aid}" aria-pressed="${vis > 0}" title="點一下顯示／隱藏本條註記">註 ${an.length}${vis && vis < an.length ? `<i>・隱${an.length - vis}</i>` : ''}</button>`);
  }
  if (settings.chips) {
    const rc = rulingCount(aid);
    if (rc) out.push(`<button class="chip c-rul" data-open="${aid}" data-tab="rulings">判決函釋 ${rc}</button>`);
    const ac = amendCount(aid);
    if (ac) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">沿革 ${ac}</button>`);
    if ((D.refs[aid] || []).length) out.push(`<button class="chip c-ref" data-open="${aid}" data-tab="refs">相關法條 ${D.refs[aid].length}</button>`);
  }
  if (rec && (rec.note || (rec.ink && rec.ink.strokes && rec.ink.strokes.length))) {
    out.push(`<button class="chip c-note" data-open="${aid}" data-tab="notes">${rec.note ? '筆記' : '手寫'}</button>`);
  }
  return out.join('');
}

function articleInner(a) {
  const rec = notes.get(a.id);
  let html = `<div class="art-head"><button class="ano" data-open="${a.id}">${aidLabel(a.id)}</button><span class="chips">${chipsHTML(a.id)}</span></div>`;
  html += `<div class="atext">${renderParas(a, rec)}</div>`;
  if (rec && rec.note) html += `<div class="note-peek" data-open="${a.id}" data-tab="notes">${esc(rec.note)}</div>`;
  return html;
}

function renderReader() {
  const parts = [];
  const firstOf = new Map();
  D.headings.forEach((h, i) => {
    if (h.first) { if (!firstOf.has(h.first)) firstOf.set(h.first, []); firstOf.get(h.first).push(i); }
  });
  parts.push(`<header class="law-title"><h1>${esc(D.meta.name)}</h1><p>修正日期 ${roc(D.meta.modified)}・${D.articles.length} 條</p></header>`);
  for (const a of D.articles) {
    for (const hi of firstOf.get(a.id) || []) {
      const h = D.headings[hi];
      parts.push(`<h3 class="h-chap" id="h-${hi}">${esc(h.t)}</h3>`);
    }
    parts.push(`<article class="art${a.del ? ' deleted' : ''}" id="a-${a.id}" data-id="${a.id}">${articleInner(a)}</article>`);
  }
  const inner = $('#reader-inner');
  inner.innerHTML = parts.join('');
  inner.classList.toggle('no-pn', !settings.pn);
  $$('.art', inner).forEach((el) => ink.observe(el));
}
function refreshArticle(aid) {
  const el = document.getElementById('a-' + aid);
  if (el) {
    el.innerHTML = articleInner(byId.get(aid));
    ink.refresh(aid);
  }
  if (current === aid) renderDetailText();
}
function refreshChips(aid) {
  const el = document.querySelector(`#a-${CSS.escape(aid)} .chips`);
  if (el) el.innerHTML = chipsHTML(aid);
}

// ---------------------------------------------------------------------------
// 目錄
// ---------------------------------------------------------------------------
function lastArticleOf(hi) {
  const h = D.headings[hi];
  let next = null;
  for (let j = hi + 1; j < D.headings.length; j++) if (D.headings[j].lv <= h.lv) { next = D.headings[j]; break; }
  if (!next) return order[order.length - 1];
  return order[order.indexOf(next.first) - 1];
}
function renderTOC() {
  let html = D.headings.map((h, i) => `<div class="toc-part"><button class="toc-btn lv0" data-h="${i}"><span class="caret"></span><span>${esc(h.t)}</span><span class="rng">${h.first}–${lastArticleOf(i)}</span></button>
    <div class="toc-arts">${order.filter((aid) => byId.get(aid).h === i).map((aid) => `<button class="toc-a" data-goto="${aid}" title="${esc(byId.get(aid).p[0].slice(0, 40))}">${aid}</button>`).join('')}</div></div>`).join('');
  html += `<div class="toc-part"><div class="res-group">相關法規全文</div>${Object.entries(D.reflaws).filter(([, l]) => l.full).map(([pc, l]) => `<button class="toc-btn" data-law="${pc}"><span class="caret"></span><span>${esc(l.name)}</span><span class="rng">${roc(l.modified, true)}</span></button>`).join('')}
    <button class="toc-btn" data-act="versions"><span class="caret"></span><span>歷次版本全文</span><span class="rng">${D.versions.length} 版</span></button></div>`;
  html += `<p class="side-note">資料來源：全國法規資料庫，修正日期 ${roc(D.meta.modified)}。紅色小字為註記；點註記文字可隱藏／顯示，或用工具列「圈選」以 Apple Pencil 圈選。</p>`;
  $('#side-toc').innerHTML = html;
}
const trackTOC = debounce(() => {
  const top = $('#reader').getBoundingClientRect().top + 80;
  let cur = -1;
  for (const el of $$('#reader-inner > h3')) {
    if (el.getBoundingClientRect().top < top) cur = +el.id.slice(2); else break;
  }
  $$('.toc-btn.cur').forEach((b) => b.classList.remove('cur'));
  if (cur >= 0) { const b = $(`.toc-btn[data-h="${cur}"]`); if (b) b.classList.add('cur'); }
}, 160);

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
}
function gotoArticle(aid, { open = true, flash = true } = {}) {
  if (!byId.has(aid)) { toast(`找不到${aidLabel(aid)}`); return; }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  setSide(false);
  hideXPop();
  if (open) openDetail(aid);
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
  try { history.replaceState(null, '', '#a-' + aid); } catch {}
  renderDetail();
}
function closeDetail() {
  if (current) document.getElementById('a-' + current)?.classList.remove('sel');
  current = null;
  $('#detail').hidden = true;
  try { history.replaceState(null, '', location.pathname + location.search); } catch {}
}
function renderDetailText() {
  const a = byId.get(current);
  const el = $('#d-text');
  el.dataset.id = current;
  el.innerHTML = `<div class="atext${settings.pn ? '' : ' no-pn'}">${renderParas(a, notes.get(current))}</div>`;
}
function renderDetail() {
  if (!current) return;
  const a = byId.get(current);
  const rec = notes.get(current);
  $('#d-no').textContent = aidLabel(current);
  $('#d-path').textContent = headingPath(a.h).join(' › ');
  $('#d-star').setAttribute('aria-pressed', rec && rec.star ? 'true' : 'false');
  renderDetailText();
  $('#t-rulings').textContent = rulingCount(current) || '';
  $('#t-history').textContent = amendCount(current) || '';
  $('#t-refs').textContent = ((D.refs[current] || []).length + (D.subs[current] || []).length + (citedBy.get(current) || []).length) || '';
  $('#t-notes').textContent = annosOf(current).length + (rec && rec.note ? 1 : 0) || '';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === detailTab ? 'true' : 'false'));
  const body = $('#d-body');
  if (detailTab === 'rulings') renderRulings(body);
  else if (detailTab === 'history') renderHistory(body);
  else if (detailTab === 'refs') renderRefs(body);
  else renderNotes(body);
  body.scrollTop = 0;
}

// ----- 判決・函釋 -----
function renderRulings(body) {
  const all = rulingList(current);
  const cnt = (f) => all.filter(f).length;
  const filters = [
    ['all', '全部', all.length],
    ['imp', '★ 重要', cnt((r) => r.mark)],
    ['P', '判決', cnt((r) => r.ty === 'P')],
    ['F', '函釋', cnt((r) => r.ty === 'F')],
    ['J', '判例', cnt((r) => r.ty === 'J')],
    ['C', '大法官解釋', cnt((r) => r.ty === 'C')],
    ['U', '我的', cnt((r) => r.ty === 'U')],
  ].filter(([k, , n]) => k === 'all' || k === 'U' || n);
  if (!filters.some(([k]) => k === rulFilter)) rulFilter = 'all';
  const list = all.filter((r) => rulFilter === 'all' || (rulFilter === 'imp' ? r.mark : r.ty === rulFilter));
  const tyOrder = { U: 0, P: 1, F: 2, C: 3, J: 4 };
  list.sort((a, b) => (b.mark - a.mark) || ((a.no || '').startsWith('廢') - (b.no || '').startsWith('廢')) || (tyOrder[a.ty] - tyOrder[b.ty]) || ((a.idx ?? 0) - (b.idx ?? 0)));
  const rec = notes.get(current) || {};
  let html = `<div class="filters">${filters.map(([k, l, n]) => `<button class="fchip" data-rf="${k}" aria-pressed="${rulFilter === k}">${l}<i>${n}</i></button>`).join('')}</div>`;
  html += `<div class="row-actions" style="margin-bottom:12px"><button class="btn small primary" data-act="add-item">＋ 新增判決／函釋</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/default.aspx" target="_blank" rel="noopener">司法院裁判書</a>
    <a class="btn small" href="https://laws.mol.gov.tw/" target="_blank" rel="noopener">勞動部法令查詢</a>
    <a class="btn small" href="https://www.mol.gov.tw/1607/1632/1640/" target="_blank" rel="noopener">不當勞動行為裁決</a></div>`;
  if (!list.length) html += `<p class="empty">${rulFilter === 'U' ? '尚無自建資料。可新增法院判決、勞動部函釋、不當勞動行為裁決決定等，並寫下要旨與個人筆記。' : '本條尚未收錄判決或函釋。可自行新增。'}</p>`;
  for (const r of list) html += rulingCard(r, rec);
  html += '<p class="callout">內建判決摘錄自司法院裁判書全文；函釋若為轉引，已註明出處。正式引用請以原文為準。判例制度已於民國108年7月4日廢止，字號前標「廢」者為不再援用。</p>';
  body.innerHTML = html;
}
function rulingCard(r, rec) {
  const isVoid = (r.no || '').startsWith('廢');
  const typeLabel = r.ty === 'U' ? (r.kind || '其他') : TYPE_LABEL[r.ty] || r.kind;
  const parts = r.user ? (r.text ? [['要旨', r.text]] : []) : r.parts ? r.parts : (r.text ? [['原文摘錄', r.text]] : []);
  const rnote = rec.rnote && rec.rnote[r.key];
  const partsHTML = parts.map(([lbl, txt]) => `<div class="rpart${txt.length > 200 ? ' clamp' : ''}"><span class="lbl">${esc(lbl)}</span>${renderRich(txt, { mode: 'ruling' })}</div>`).join('');
  return `<article class="rcard${r.mark ? ' imp' : ''}${isVoid ? ' void' : ''}" data-key="${esc(r.key)}">
    <div class="rhead"><span class="tpill tp-${r.ty}">${esc(typeLabel)}</span>${isVoid ? '<span class="tpill tp-void">不再援用</span>' : ''}
      <span class="rno">${esc(isVoid ? r.no.slice(1) : r.no)}</span><span class="rdate">${esc(r.date || '')}</span>
      <button class="rstar" data-act="imp" aria-pressed="${r.mark}" aria-label="標記重要"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"/></svg></button></div>
    ${r.point ? `<div class="rpoint">${esc(r.point)}</div>` : ''}
    ${partsHTML}
    ${r.src ? `<div class="rsrc">${esc(r.src)}</div>` : ''}
    ${rnote ? `<div class="rnote">${esc(rnote)}</div>` : ''}
    <div class="rfoot">
      ${parts.some(([, t]) => t.length > 200) ? '<button class="linkish" data-act="expand">展開全文</button>' : ''}
      ${r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener">原文</a>` : ''}
      ${r.user ? '<button class="linkish" data-act="edit-item">編輯</button>' : `<button class="linkish" data-act="rnote">${rnote ? '編輯筆記' : '加筆記'}</button>`}
      <button class="linkish" data-act="to-anno">做成紅字註記</button>
    </div></article>`;
}

// ----- 新舊對照 -----
function versionsOf(aid) { return (D.changes[aid] || []).map((h, i) => ({ ...h, i })); }
function histItemFor(d) { return D.histories.find((h) => h.dates.includes(d)); }
function vLabel(v) { return v.k === 'old' ? `舊法第${v.old}條` : KIND_LABEL[v.k]; }
function renderHistory(body) {
  const a = byId.get(current);
  const vs = versionsOf(current);
  let html = '';
  if (vs.length < 2) {
    html += `<p class="empty">${aidLabel(current)}${a.since ? `於${roc(a.since)}${a.since === '20090701' ? '全文修正時' : ''}${a.oldNo ? '修正' : '增訂'}` : ''}，此後未曾修正。</p>`;
  } else {
    if (!cmpSel || cmpSel.aid !== current) cmpSel = { aid: current, a: vs.length - 2, b: vs.length - 1 };
    const opt = (sel) => vs.map((v) => `<option value="${v.i}"${v.i === sel ? ' selected' : ''}>${roc(v.d, true)} ${vLabel(v)}</option>`).join('');
    html += '<ol class="timeline">';
    for (const v of [...vs].reverse()) {
      const it = histItemFor(v.d);
      html += `<li class="tl k-${v.k}"><span class="dot"></span><div><b>${roc(v.d)}</b><small>${vLabel(v)}${v.k === 'old' && v.d < '19880627' ? '（依文字比對）' : ''}${it ? `・沿革第 ${it.n} 點` : ''}</small></div>
        ${v.i > 0 ? `<button class="linkish kind" data-cmp="${v.i}">與前版比較</button>` : '<span class="kind">最早版本</span>'}</li>`;
    }
    html += '</ol>';
    html += `<div class="cmp-ctl"><label for="cmp-b">新</label><select id="cmp-b">${opt(cmpSel.b)}</select>
      <label for="cmp-a">舊</label><select id="cmp-a">${opt(cmpSel.a)}</select>
      <span class="segs" role="group" aria-label="顯示方式"><button type="button" data-cm="table" aria-pressed="${cmpMode === 'table'}">對照表</button><button type="button" data-cm="inline" aria-pressed="${cmpMode === 'inline'}">標示差異</button></span></div>`;
    const A = vs[cmpSel.a], B = vs[cmpSel.b];
    const older = A.p2 && cmpSel.a < cmpSel.b ? A.p2 : A.p;
    const dd = diffParas(older, B.p);
    const lbl = (v) => `${roc(v.d, true)}${v.k === 'old' ? `・舊第${v.old}條` : ''}`;
    if (cmpMode === 'table') {
      html += `<div class="cmp-wrap"><table class="cmp"><thead><tr><th>${cmpSel.b > cmpSel.a ? '修正條文' : '條文'}（${lbl(B)}）</th><th>${cmpSel.b > cmpSel.a ? '修正前條文' : '條文'}（${lbl(A)}）</th></tr></thead>
        <tbody><tr><td>${dd.new}</td><td>${dd.old}</td></tr></tbody></table></div>`;
    } else html += `<div class="inline-diff">${dd.inline}</div>`;
    html += `<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>`;
    const it = histItemFor(B.d);
    if (it) html += `<div class="hist-item"><b>沿革第 ${it.n} 點</b><br>${esc(it.t)}</div>`;
  }
  html += `<p class="callout" style="margin-top:12px">民國98年7月1日全文修正（100年5月1日施行）後條號重編；修正前條號依人工對照，民國77年以前版本依文字相似度對應，僅供參考。
    <br><button class="linkish" data-act="versions">檢視歷次版本全文</button>・<a href="https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=${D.meta.pcode}" target="_blank" rel="noopener">全國法規資料庫沿革</a></p>`;
  body.innerHTML = html;
}
function openVersions(sel) {
  const vs = D.versions;
  let idx = sel ?? vs.length - 2;
  const draw = () => {
    const v = vs[idx];
    return `<div class="cmp-ctl"><select id="ver-sel">${vs.map((x, i) => `<option value="${i}"${i === idx ? ' selected' : ''}>${esc(x.label || roc(x.d))}${i === vs.length - 1 ? '（現行）' : ''}・${x.arts.length} 條</option>`).join('')}</select></div>
      <div class="ver-text">${v.arts.map(([no, p]) => `<div class="ver-art"><b>第${esc(no.replace('-', '條之'))}${no.includes('-') ? '' : '條'}</b>${p.map((t) => `<p>${esc(t)}</p>`).join('')}</div>`).join('')}</div>`;
  };
  modal({
    title: '勞資爭議處理法・歷次版本全文',
    body: draw(),
    buttons: [{ label: '關閉', cls: 'primary' }],
    onOpen: (b) => { b.onchange = (e) => { if (e.target.id === 'ver-sel') { idx = +e.target.value; b.innerHTML = draw(); } }; },
  });
}
function openLaw(pc, flno) {
  const L = D.reflaws[pc];
  if (!L) return;
  let lastCh = '';
  const html = Object.entries(L.arts).map(([no, p]) => {
    const ch = L.chap[no] && L.chap[no] !== lastCh ? `<h4 class="ver-ch">${esc(L.chap[no])}</h4>` : '';
    lastCh = L.chap[no] || lastCh;
    return `${ch}<div class="ver-art" id="law-${no}"><b>第${esc(no.replace('-', '條之'))}${no.includes('-') ? '' : '條'}</b>${p.map((t) => `<p>${esc(t)}</p>`).join('')}</div>`;
  }).join('');
  modal({
    title: `${L.name}（${roc(L.modified, true)}）`,
    body: `<div class="ver-text">${html}</div><p class="callout"><a href="${esc(L.url)}" target="_blank" rel="noopener">全國法規資料庫原文</a></p>`,
    buttons: [{ label: '關閉', cls: 'primary' }],
    onOpen: (b) => { if (flno) { const el = $('#law-' + CSS.escape(flno), b); if (el) { el.classList.add('flash'); el.scrollIntoView({ block: 'center' }); } } },
  });
}

// ----- 相關法條 -----
function renderRefs(body) {
  const refs = refsOf(current);
  let html = '';
  if (refs.length) {
    html += `<div class="field"><span class="lbl">本條引用或相關之其他法律（${refs.length}）</span>`;
    for (const r of refs) {
      const { law, items } = refText({ ...r, x: null, k: null });
      const vis = isVisible(current, r.id, r.extra ? 'refx' : 'ref');
      html += `<div class="refcard"><div class="rhead"><span class="tpill tp-L">${r.extra ? '另見' : '引用'}</span><b class="rno">${esc(refLabel(r))}</b>
        <button class="linkish" data-act="ref-vis" data-id="${r.id}" style="margin-left:auto">${vis ? '條文中隱藏小字' : '條文中顯示小字'}</button></div>
        ${r.why ? `<div class="rsrc">${esc(r.why)}</div>` : ''}
        ${(items || []).map((it) => `<div class="rpart"><span class="lbl">第${esc(it.no)}條</span>${it.paras.map(esc).join('<br>')}</div>`).join('')}
        ${law ? `<div class="rfoot">${law.full ? `<button class="linkish" data-act="open-law" data-pc="${r.pcode}" data-no="${esc(r.flno || (r.flnos || [])[0] || '')}">開啟${esc(law.name)}全文</button>` : `<a href="https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=${r.pcode}&amp;flno=${esc(r.flno || (r.flnos || [])[0] || '')}" target="_blank" rel="noopener">全國法規資料庫</a>`}<span class="rdate">${esc(law.name)} 修正 ${roc(law.modified, true)}</span></div>` : ''}</div>`;
    }
    html += '</div>';
  }
  const cb = citedBy.get(current) || [];
  if (cb.length) html += `<div class="field"><span class="lbl">本法中引用本條之條文（${cb.length}）</span><div class="tags">${cb.map((aid) => `<button class="tag" data-goto="${aid}">${aidLabel(aid)}</button>`).join('')}</div></div>`;
  const subs = D.subs[current] || [];
  if (subs.length) html += `<div class="field"><span class="lbl">授權子法</span>${subs.map((s) => `<a class="res" href="${esc(s.url)}" target="_blank" rel="noopener"><b>${esc(s.name)}</b><span>${esc(s.date || '')}　全國法規資料庫</span></a>`).join('')}</div>`;
  if (!html) html = '<p class="empty">本條沒有引用其他法律。</p>';
  body.innerHTML = html;
}

// ----- 我的註記 -----
function allTags() {
  const s = new Set();
  notes.forEach((r) => (r.tags || []).forEach((t) => s.add(t)));
  return [...s].sort();
}
function quoteOf(aid, h) { const sp = splitPara(byId.get(aid).p[h.p] || ''); return sp.body.slice(h.s, h.e); }
function renderNotes(body) {
  const rec = notes.get(current) || {};
  const hls = rec.hl || [];
  const strokes = rec.ink && rec.ink.strokes ? rec.ink.strokes.length : 0;
  const bi = builtin.get(current) || [];
  const row = (h, isB) => {
    const vis = isVisible(current, h.id);
    return `<li><div><span class="q">${isB ? esc(h.q) : `<mark class="hl hl-${h.c && h.c !== 'n' ? h.c : 'none'}">${esc(quoteOf(current, h))}</mark>`}</span>${h.n ? `<span class="n red">${h.pos === 'above' ? '▲上註　' : '▼下註　'}${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions">${h.n ? `<button class="linkish" data-act="an-vis" data-id="${h.id}">${vis ? '隱藏' : '顯示'}</button>` : ''}${isB ? '' : `<button class="linkish" data-act="hl-note" data-id="${h.id}">${h.n ? '編輯' : '加註'}</button><button class="linkish" data-act="hl-del" data-id="${h.id}" style="color:var(--seal)">刪除</button>`}</div></li>`;
  };
  let html = `<div class="field"><span class="lbl">我的劃線與紅字註記（${hls.length}）</span>`;
  html += hls.length ? `<ul class="hl-list">${hls.map((h) => row(h, false)).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">在條文上選取文字 → 按「上註」或「下註」，即可加上紅色小字註記；也可只劃螢光線。</p>';
  html += '</div>';
  if (bi.length) {
    html += `<div class="field"><span class="lbl">內建編者註（${bi.length}）${settings.builtin ? '' : '・已在設定中關閉'}</span><ul class="hl-list">${bi.map((h) => row(h, true)).join('')}</ul></div>`;
  }
  html += `<div class="field"><label for="note-text">本條筆記</label>
    <textarea class="note" id="note-text" placeholder="寫下要件、實務見解、考點、案例…">${esc(rec.note || '')}</textarea>
    <span class="saved" id="note-saved">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div>`;
  html += `<div class="field"><label for="tag-input">標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" id="tag-input" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點" enterkeyhint="done">
    <datalist id="tag-list">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>`;
  html += `<div class="field"><span class="lbl">手寫（${strokes} 筆）</span>
    <div class="row-actions"><button class="btn small" data-act="ink-on">在條文上手寫</button>${strokes ? '<button class="btn small danger" data-act="ink-clear">清除本條手寫</button>' : ''}</div>
    ${ink.layoutShifted(current) ? '<p class="ink-warn">版面寬度與書寫時不同，手寫位置可能略有偏移。</p>' : ''}
    <p class="ink-warn">手寫位置依書寫當時的版面；顯示／隱藏註記後若位置偏移，恢復原顯示狀態即可對齊。</p></div>`;
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
// 選取 → 劃線／紅字註記
// ---------------------------------------------------------------------------
let pendingSel = null; // {aid, parts:[{p,s,e}]}
let activeHl = null;   // {aid, id}

function textOffset(pt, node, off) {
  // 計算 (node, off) 在 .pt 本文中的位置（略過紅字註記 rt 與編號等非本文元素）
  const at = document.createRange();
  at.setStart(node, off); at.collapse(true);
  let n = 0;
  const walk = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement.closest('rt, .an-m') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  let t;
  while ((t = walk.nextNode())) {
    if (t === node) return n + off;
    if (at.comparePoint(t, 0) >= 0) return n;
    n += t.length;
  }
  return n;
}
function plainLen(pt) {
  let n = 0;
  const walk = document.createTreeWalker(pt, NodeFilter.SHOW_TEXT, {
    acceptNode: (t) => (t.parentElement.closest('rt, .an-m') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  while (walk.nextNode()) n += walk.currentNode.length;
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
    if (pt.contains(range.startContainer)) s = textOffset(pt, range.startContainer, range.startOffset);
    if (pt.contains(range.endContainer)) e = textOffset(pt, range.endContainer, range.endOffset);
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
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, x)) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
}
function showPop(rect, mode, noteText) {
  const pop = $('#hl-pop');
  pop.hidden = false;
  $('#pop-new').hidden = mode !== 'new';
  $('#pop-edit').hidden = mode !== 'edit';
  $('#pop-color').hidden = mode !== 'color';
  const pn = $('#pop-note');
  pn.hidden = !noteText;
  pn.textContent = noteText || '';
  if (mode === 'edit' && activeHl) {
    const r = getRec(activeHl.aid);
    const h = r && (r.hl || []).find((x) => x.id === activeHl.id);
    $('#pop-vis').hidden = !(h && h.n);
    $('#pop-flip').hidden = !(h && h.n);
    $('#pop-vis').textContent = isVisible(activeHl.aid, activeHl.id) ? '隱藏註記' : '顯示註記';
    $('#pop-flip').textContent = h && h.pos === 'above' ? '改到下方' : '改到上方';
    $('[data-hl="edit"]', pop).textContent = h && h.n ? '編輯註記' : '加註記';
  }
  placePop(pop, rect);
}
function hidePop() { $('#hl-pop').hidden = true; pendingSel = null; activeHl = null; }

const onSelChange = debounce(() => {
  if (ink.active || lasso.active) return;
  const c = captureSelection();
  if (c) { pendingSel = c; activeHl = null; showPop(c.rect, 'new', ''); }
  else if (!activeHl && !$('#hl-pop').matches(':hover')) $('#hl-pop').hidden = true;
}, 280);

function afterChange(aid) {
  saveRec(aid); refreshArticle(aid);
  if (current === aid) renderDetail();
}
function popAction(v) {
  if (activeHl) {
    const { aid, id } = activeHl;
    const r = getRec(aid, true);
    const h = (r.hl || []).find((x) => x.id === id);
    if (!h) return hidePop();
    if (v === 'del') { r.hl = r.hl.filter((x) => x.id !== id); if (r.vis) delete r.vis[id]; }
    else if (v === 'edit') { hidePop(); return editHlNote(aid, id); }
    else if (v === 'vis') setVisible(aid, id, !isVisible(aid, id));
    else if (v === 'flip') h.pos = h.pos === 'above' ? 'below' : 'above';
    else if (v === 'color') { showPop($(`[data-hl="${id}"], [data-an="${id}"]`)?.getBoundingClientRect() || { left: 100, top: 100, bottom: 120, width: 0 }, 'color', h.n); return; }
    else if (v === 'c-n') h.c = 'n';
    else h.c = v;
    afterChange(aid);
    return hidePop();
  }
  if (!pendingSel) return;
  const { aid, parts } = pendingSel;
  const r = getRec(aid, true);
  r.hl = r.hl || [];
  const isNote = v.startsWith('n-');
  const last = parts[parts.length - 1];
  const created = [];
  for (const pt of (isNote ? [last] : parts)) {
    const h = { id: uid(), p: pt.p, s: pt.s, e: pt.e, c: isNote ? 'n' : v };
    if (isNote) h.pos = v === 'n-above' ? 'above' : 'below';
    r.hl.push(h);
    created.push(h);
  }
  window.getSelection()?.removeAllRanges();
  hidePop();
  if (isNote) editHlNote(aid, created[0].id, true);
  else afterChange(aid);
}

// ---------------------------------------------------------------------------
// 點選註記：切換顯示
// ---------------------------------------------------------------------------
function toggleIds(aid, ids, mode) {
  // mode: toggle | hide | show
  const ann = annosOf(aid), refs = refsOf(aid);
  const kindOf = (id) => (refs.some((r) => r.id === id) ? refKind(aid, id) : 'anno');
  ids = ids.filter((id) => ann.some((a) => a.id === id) || refs.some((r) => r.id === id));
  if (!ids.length) return 0;
  let on;
  if (mode === 'hide') on = false;
  else if (mode === 'show') on = true;
  else on = !ids.some((id) => isVisible(aid, id, kindOf(id)));
  for (const id of ids) setVisible(aid, id, on, kindOf(id));
  saveRec(aid);
  refreshArticle(aid);
  refreshChips(aid);
  if (current === aid && detailTab !== 'notes') renderDetailText();
  else if (current === aid) renderDetail();
  return on ? ids.length : -ids.length;
}
function toggleArticle(aid) {
  const ids = annosOf(aid).map((a) => a.id);
  const anyVis = ids.some((id) => isVisible(aid, id));
  toggleIds(aid, ids, anyVis ? 'hide' : 'show');
  toast(anyVis ? `已隱藏${aidLabel(aid)}的註記` : `已顯示${aidLabel(aid)}的註記`);
}
function setAllAnno(on) {
  settings.anno = on;
  saveSettings();
  notes.forEach((r, aid) => {
    if (!r.vis) return;
    let changed = false;
    for (const k of Object.keys(r.vis)) if (!k.startsWith('r')) { delete r.vis[k]; changed = true; }
    if (changed) saveRec(aid);
  });
  $('#btn-anno').setAttribute('aria-pressed', on ? 'true' : 'false');
  renderReader();
  if (current) renderDetail();
  toast(on ? '已顯示全部註記' : '已隱藏全部註記（點文字下的紅點線可個別顯示）');
}

// 長按紅字 → 選單
let press = null;
function bindLongPress(root) {
  root.addEventListener('pointerdown', (e) => {
    const n = e.target.closest('rt, .an-n');
    if (!n || ink.active || lasso.active) return;
    const host = n.closest('[data-id]');
    const id = n.closest('[data-an]')?.dataset.an || n.dataset.ann;
    press = { x: e.clientX, y: e.clientY, fired: false, t: setTimeout(() => {
      press.fired = true;
      openNoteMenu(host.dataset.id, id, n.getBoundingClientRect());
    }, 480) };
  });
  const cancel = (e) => { if (press && (!e || e.type !== 'pointermove' || Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8)) clearTimeout(press.t); };
  root.addEventListener('pointermove', cancel);
  root.addEventListener('pointerup', () => press && clearTimeout(press.t));
  root.addEventListener('pointercancel', () => press && clearTimeout(press.t));
  root.addEventListener('contextmenu', (e) => { if (e.target.closest('rt, .an-n')) e.preventDefault(); });
}
function openNoteMenu(aid, id, rect) {
  const r = getRec(aid);
  const h = r && (r.hl || []).find((x) => x.id === id);
  if (h) { activeHl = { aid, id }; pendingSel = null; showPop(rect, 'edit', h.n); return; }
  const b = (builtin.get(aid) || []).find((x) => x.id === id);
  if (b) {
    modal({
      title: `${aidLabel(aid)}・編者註`,
      body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(b.q)}」</p><p class="red-note">${esc(b.n)}</p>`,
      buttons: [
        { label: isVisible(aid, id) ? '隱藏此註' : '顯示此註', onClick: () => { toggleIds(aid, [id], 'toggle'); } },
        { label: '複製成我的註記', onClick: () => {
          const rr = getRec(aid, true); rr.hl = rr.hl || [];
          rr.hl.push({ id: uid(), p: b.p, s: b.s, e: b.e, c: 'n', pos: b.pos, n: b.n });
          setVisible(aid, id, false);
          afterChange(aid); toast('已複製，可自行修改');
        } },
        { label: '完成', cls: 'primary' },
      ],
    });
  }
}

// ---------------------------------------------------------------------------
// 圈選模式（Apple Pencil）
// ---------------------------------------------------------------------------
const lasso = { active: false, finger: false, mode: 'toggle', pts: null };
function setLasso(on) {
  if (on && ink.active) setInk(false);
  lasso.active = on;
  document.body.classList.toggle('lassoing', on);
  $('#btn-lasso').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#lassobar').hidden = !on;
  $('#lasso-layer').hidden = !on;
  if (on) { hidePop(); window.getSelection()?.removeAllRanges(); sizeLasso(); toast('圈選模式：用 Apple Pencil 圈起或劃過註記'); }
}
function sizeLasso() {
  const c = $('#lasso-layer');
  const dpr = devicePixelRatio || 1;
  c.width = innerWidth * dpr; c.height = innerHeight * dpr;
  c.getContext('2d').setTransform(dpr, 0, 0, dpr, 0, 0);
}
function drawLasso() {
  const c = $('#lasso-layer');
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, innerWidth, innerHeight);
  const p = lasso.pts;
  if (!p || p.length < 2) return;
  ctx.strokeStyle = getComputedStyle(document.documentElement).getPropertyValue('--anno').trim() || '#c62828';
  ctx.lineWidth = 2;
  ctx.setLineDash([6, 5]);
  ctx.beginPath();
  ctx.moveTo(p[0][0], p[0][1]);
  for (const q of p) ctx.lineTo(q[0], q[1]);
  ctx.stroke();
  ctx.fillStyle = 'rgba(198, 40, 40, .06)';
  ctx.fill();
}
function inPoly(x, y, poly) {
  let ins = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) ins = !ins;
  }
  return ins;
}
function lassoHits(pts) {
  const hits = new Map(); // aid -> Set(ids)
  const closed = pts.length > 8 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 120;
  const sel = '[data-an], [data-ann], [data-lr], [data-rf]';
  for (const el of $$(sel, $('#app'))) {
    const host = el.closest('[data-id]');
    if (!host) continue;
    const id = el.dataset.an || el.dataset.ann || el.dataset.lr || el.dataset.rf;
    let hit = false;
    for (const r of el.getClientRects()) {
      if (r.bottom < 0 || r.top > innerHeight || !r.width) continue;
      if (closed && inPoly(r.left + r.width / 2, r.top + r.height / 2, pts)) { hit = true; break; }
      if (pts.some(([x, y]) => x >= r.left - 4 && x <= r.right + 4 && y >= r.top - 4 && y <= r.bottom + 4)) { hit = true; break; }
    }
    if (hit) {
      const aid = host.dataset.id;
      if (!hits.has(aid)) hits.set(aid, new Set());
      hits.get(aid).add(id);
    }
  }
  return hits;
}
function finishLasso() {
  const pts = lasso.pts;
  lasso.pts = null;
  drawLasso();
  if (!pts || pts.length < 2) return;
  const hits = lassoHits(pts);
  if (!hits.size) { toast('沒有圈到註記'); return; }
  // 切換：只要圈到的有任一顯示中，就全部隱藏；否則全部顯示
  let mode = lasso.mode;
  if (mode === 'toggle') {
    let anyVis = false;
    hits.forEach((ids, aid) => { ids.forEach((id) => { if (isVisible(aid, id, kindOfId(aid, id))) anyVis = true; }); });
    mode = anyVis ? 'hide' : 'show';
  }
  let n = 0;
  hits.forEach((ids, aid) => { n += Math.abs(toggleIds(aid, [...ids], mode)); });
  toast(`已${mode === 'hide' ? '隱藏' : '顯示'} ${n} 則註記`);
}
function bindLasso() {
  const reader = $('#app');
  const allowed = (e) => lasso.active && (e.pointerType === 'pen' || e.pointerType === 'mouse' || lasso.finger);
  const block = (e) => {
    if (!lasso.active) return;
    for (const t of e.touches) if (t.touchType === 'stylus' || lasso.finger) { e.preventDefault(); return; }
  };
  reader.addEventListener('touchstart', block, { passive: false });
  reader.addEventListener('touchmove', block, { passive: false });
  reader.addEventListener('pointerdown', (e) => {
    if (!allowed(e) || e.target.closest('.topbar, .detail-head, .tabs, .lassobar, .sidebar, .d-body')) return;
    e.preventDefault();
    lasso.pts = [[e.clientX, e.clientY]];
    lasso.pid = e.pointerId;
    try { reader.setPointerCapture(e.pointerId); } catch {}
  }, true);
  reader.addEventListener('pointermove', (e) => {
    if (!lasso.pts || e.pointerId !== lasso.pid) return;
    e.preventDefault();
    const evs = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    for (const ev of evs.length ? evs : [e]) lasso.pts.push([ev.clientX, ev.clientY]);
    drawLasso();
  }, true);
  const end = (e) => { if (lasso.pts && e.pointerId === lasso.pid) { e.preventDefault(); finishLasso(); } };
  reader.addEventListener('pointerup', end, true);
  reader.addEventListener('pointercancel', () => { lasso.pts = null; drawLasso(); }, true);
  reader.addEventListener('click', (e) => { if (lasso.active && e.target.closest('.reader, .d-text') && (e.pointerType === 'pen' || e.pointerType === 'mouse' || !e.pointerType)) { e.preventDefault(); e.stopPropagation(); } }, true);
  addEventListener('resize', () => lasso.active && sizeLasso());
  $('#lassobar').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.lm) {
      lasso.mode = b.dataset.lm;
      $$('[data-lm]').forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    } else if (b.dataset.act === 'finger') {
      lasso.finger = !lasso.finger;
      b.setAttribute('aria-pressed', lasso.finger ? 'true' : 'false');
      document.body.classList.toggle('lasso-finger', lasso.finger);
      toast(lasso.finger ? '手指也可圈選（捲動請用兩指）' : '只有 Apple Pencil 可圈選');
    } else if (b.dataset.act === 'done') setLasso(false);
  });
}

// ---------------------------------------------------------------------------
// 條文預覽（點本法條號）
// ---------------------------------------------------------------------------
let xTarget = null;
function showXPop(aid, rect) {
  xTarget = aid;
  const a = byId.get(aid);
  $('#x-body').innerHTML = `<b>${aidLabel(aid)}</b><div class="atext">${renderParas(a, null, { plain: true })}</div>`;
  const pop = $('#x-pop');
  pop.hidden = false;
  placePop(pop, rect);
}
function hideXPop() { $('#x-pop').hidden = true; xTarget = null; }

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------
function modal({ title, body, buttons, onOpen }) {
  const dlg = $('#modal');
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  $('#modal-body').onchange = null; $('#modal-body').onclick = null;
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
  const posSeg = (p) => `<span class="segs" role="group"><button type="button" data-pos="above" aria-pressed="${p === 'above'}">放在文字上方</button><button type="button" data-pos="below" aria-pressed="${p !== 'above'}">放在文字下方</button></span>`;
  let pos = h.pos || 'below';
  modal({
    title: `${aidLabel(aid)}・紅字註記`,
    body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(quoteOf(aid, h))}」</p>
      <textarea class="note red" id="m-hlnote" placeholder="以紅色小字顯示在這段文字的上方或下方。例如：要件、判決字號、函釋要旨">${esc(h.n || '')}</textarea>
      <div class="set-row"><span class="l">位置<small>短註記會直接排在文字正上／正下方；較長者排在該段落上／下方並以①②編號對應</small></span>${posSeg(pos)}</div>`,
    buttons: [
      { label: '取消', onClick: () => { if (isNew && !h.n) { r.hl = r.hl.filter((x) => x !== h); saveRec(aid); } } },
      { label: '儲存', cls: 'primary', onClick: () => {
        h.n = $('#m-hlnote').value.trim();
        h.pos = pos;
        if (!h.n && h.c === 'n') r.hl = r.hl.filter((x) => x !== h);
        else setVisible(aid, h.id, true);
        afterChange(aid); toast('已儲存註記');
      } },
    ],
    onOpen: (b) => {
      $('#m-hlnote').focus();
      b.onclick = (e) => { const x = e.target.closest('[data-pos]'); if (x) { pos = x.dataset.pos; $$('[data-pos]', b).forEach((y) => y.setAttribute('aria-pressed', y === x ? 'true' : 'false')); } };
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
      <div class="field"><label for="m-date">日期</label><input class="inp" id="m-date" value="${esc(item.date)}" placeholder="例：113.12.26"></div>
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院113年度台上字第2146號民事判決／勞動部○年○月○日勞動關○字第○號函"></div>
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
        if (isNew) rulFilter = 'U';
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
    title: '判決・函釋筆記',
    body: `<textarea class="note" id="m-rnote" placeholder="這則判決／函釋的重點、與本條的關係…">${esc(r.rnote[key] || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => {
      const v = $('#m-rnote').value.trim();
      if (v) r.rnote[key] = v; else delete r.rnote[key];
      saveRec(aid); renderDetail();
    } }],
    onOpen: () => $('#m-rnote').focus(),
  });
}
// 判決 → 紅字註記：選擇要掛在哪段文字
function rulingToAnno(aid, key) {
  const it = rulingList(aid).find((r) => r.key === key);
  if (!it) return;
  const a = byId.get(aid);
  const short = (it.no || '').replace(/最高行政法院/, '最高行').replace(/最高法院/, '最高').replace(/(\d+)年度/, '$1').replace(/字第/, '').replace(/號.*$/, '');
  const text = `${short}：${it.point || it.text || ''}`.slice(0, 120);
  modal({
    title: '做成紅字註記',
    body: `<div class="field"><label for="m-ra-t">註記文字</label><textarea class="note red" id="m-ra-t">${esc(text)}</textarea></div>
      <div class="field"><label for="m-ra-p">掛在哪一段（項／款）</label><select class="inp" id="m-ra-p">${a.p.map((t, i) => `<option value="${i}">${esc(t.slice(0, 30))}…</option>`).join('')}</select></div>
      <div class="field"><label for="m-ra-q">對應文字（須與條文相同，留空則為整段開頭）</label><input class="inp" id="m-ra-q" placeholder="例如：因該勞資爭議事件"></div>
      <div class="set-row"><span class="l">位置</span><span class="segs"><button type="button" data-pos="above" aria-pressed="false">上方</button><button type="button" data-pos="below" aria-pressed="true">下方</button></span></div>`,
    buttons: [{ label: '取消' }, { label: '加入', cls: 'primary', onClick: () => {
      const p = +$('#m-ra-p').value;
      const body = splitPara(a.p[p]).body;
      const q = $('#m-ra-q').value.trim();
      let s = q ? body.indexOf(q) : 0;
      if (q && s < 0) { toast('找不到該段文字，請確認與條文相同'); return true; }
      const e = q ? s + q.length : Math.min(body.length, 6);
      const r = getRec(aid, true); r.hl = r.hl || [];
      const pos = $('[data-pos][aria-pressed="true"]', $('#modal-body')).dataset.pos;
      const h = { id: uid(), p, s, e, c: 'n', pos, n: $('#m-ra-t').value.trim() };
      if (!h.n) return true;
      r.hl.push(h); setVisible(aid, h.id, true);
      afterChange(aid); toast('已加入紅字註記');
    } }],
    onOpen: (b) => { b.onclick = (e) => { const x = e.target.closest('[data-pos]'); if (x) $$('[data-pos]', b).forEach((y) => y.setAttribute('aria-pressed', y === x ? 'true' : 'false')); }; },
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
  if (!q) { box.innerHTML = '<p class="side-note">輸入關鍵字搜尋條文、註記、判決函釋；輸入條號（例如 8、47-1、第五十四條）可直接跳到該條。</p>'; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  let html = '';
  const arts = D.articles.filter((a) => has(a.p.join(''))).map((a) => [a.id, a.p.join('')]);
  const mine = [];
  notes.forEach((r, aid) => {
    const t = [r.note || '', ...(r.tags || []), ...(r.hl || []).map((h) => h.n || ''), ...(r.items || []).map((i) => i.no + i.text), ...Object.values(r.rnote || {})].join(' ');
    if (has(t)) mine.push([aid, t]);
  });
  const bis = [];
  builtin.forEach((lst, aid) => lst.forEach((b) => { if (has(b.q + b.n)) bis.push([aid, b.q + '：' + b.n]); }));
  const ruls = [];
  for (const aid in D.rulings) for (const r of D.rulings[aid]) {
    const t = r.no + ' ' + (r.point || '') + ' ' + (r.text || '') + (r.parts || []).map((p) => p[1]).join(' ');
    if (has(t)) ruls.push([aid, r, t]);
  }
  const jump = parseAidInput(q);
  if (jump && byId.has(jump)) html += `<button class="res" data-goto="${jump}"><b>跳到${aidLabel(jump)}</b><span>${esc(byId.get(jump).p.join('').slice(0, 60))}…</span></button>`;
  html += `<div class="res-group">條文 ${arts.length}</div>`;
  html += arts.map(([aid, t]) => `<button class="res" data-goto="${aid}"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  if (bis.length) {
    html += `<div class="res-group">編者註 ${bis.length}</div>`;
    html += bis.map(([aid, t]) => `<button class="res" data-goto="${aid}"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  if (mine.length) {
    html += `<div class="res-group">我的註記 ${mine.length}</div>`;
    html += mine.map(([aid, t]) => `<button class="res" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  html += `<div class="res-group">判決・函釋 ${ruls.length}</div>`;
  html += ruls.map(([aid, r, t]) => `<button class="res" data-goto="${aid}" data-tab="rulings"><b>${esc(r.no)}・${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  box.innerHTML = html;
}
let mineFilter = 'all';
function renderMine() {
  const rows = [];
  for (const aid of order) {
    const r = notes.get(aid);
    if (!r || isEmptyRec(r)) continue;
    const f = {
      star: !!r.star, note: !!r.note, hl: !!(r.hl && r.hl.length), ink: !!(r.ink && r.ink.strokes && r.ink.strokes.length),
      item: !!(r.items && r.items.length) || !!(r.imp && Object.keys(r.imp).length),
    };
    if (!Object.values(f).some(Boolean) && !(r.tags && r.tags.length)) continue;
    rows.push({ aid, r, f });
  }
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★ 書籤'], ['hl', '紅字・劃線'], ['note', '筆記'], ['ink', '手寫'], ['item', '判決函釋']];
  const list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([k, l]) => `<button class="fchip" data-mf="${k}" aria-pressed="${mineFilter === k}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。在條文上選取文字，按「上註」或「下註」即可加上紅色小字註記；也可開啟手寫模式用 Apple Pencil 書寫。'}</p>`;
  html += list.map(({ aid, r, f }) => {
    const bits = [f.star && '★', f.hl && `紅字・劃線 ${r.hl.length}`, f.note && '筆記', f.ink && '手寫', r.items && r.items.length && `自建 ${r.items.length}`].filter(Boolean).join('・');
    const first = (r.hl || []).find((h) => h.n);
    return `<button class="res" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b> <small style="color:var(--faint)">${bits}</small><span>${esc(r.note || (first && first.n) || (r.tags || []).map((t) => '#' + t).join(' ') || byId.get(aid).p.join('').slice(0, 60))}</span></button>`;
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
  $('#reader-inner').classList.toggle('no-pn', !settings.pn);
  $('#btn-anno').setAttribute('aria-pressed', settings.anno ? 'true' : 'false');
  requestAnimationFrame(() => ink.redrawAll());
}
function exportData() {
  return JSON.stringify({ app: 'labor-dispute-notes', version: 1, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) });
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || data.app !== 'labor-dispute-notes' || !data.notes) throw new Error('不是勞資爭議處理法註記本的備份檔');
  if (replace) { await store.clearAll(); notes.clear(); }
  for (const [aid, rec] of Object.entries(data.notes)) {
    if (!byId.has(aid)) continue;
    if (!replace && notes.has(aid)) {
      const cur = notes.get(aid);
      const merged = { ...rec, ...cur };
      merged.note = [cur.note, rec.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
      merged.tags = Array.from(new Set([...(cur.tags || []), ...(rec.tags || [])]));
      const mergeById = (a = [], b = []) => { const m = new Map(); [...b, ...a].forEach((x) => m.set(x.id, x)); return [...m.values()]; };
      merged.hl = mergeById(cur.hl, rec.hl);
      merged.items = mergeById(cur.items, rec.items);
      merged.imp = { ...(rec.imp || {}), ...(cur.imp || {}) };
      merged.rnote = { ...(rec.rnote || {}), ...(cur.rnote || {}) };
      merged.vis = { ...(rec.vis || {}), ...(cur.vis || {}) };
      if (rec.ink && cur.ink) merged.ink = { ...cur.ink, strokes: [...(cur.ink.strokes || []), ...(rec.ink.strokes || [])] };
      merged.star = cur.star || rec.star;
      notes.set(aid, merged);
    } else notes.set(aid, rec);
    await saveRec(aid);
  }
  if (data.settings && replace) { settings = { ...settings, ...data.settings }; await saveSettings(); applySettings(); }
  renderReader();
  if (current) renderDetail();
}
function openSettings() {
  const seg = (key, opts) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(settings[key]) === String(v)}">${l}</button>`).join('')}</span>`;
  const n = [...notes.values()].filter((r) => !isEmptyRec(r)).length;
  const nr = Object.values(D.rulings).reduce((s, v) => s + v.length, 0);
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">註記</div>
      <div class="set-row"><span class="l">紅字註記<small>全部顯示或隱藏（會清除個別的顯示設定）</small></span>${seg('anno', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">內建編者註<small>本工具附的要點、判決、函釋註記</small></span>${seg('builtin', [['true', '開啟'], ['false', '關閉']])}</div>
      <div class="set-row"><span class="l">相關法條小字<small>條文引用工會法、團體協約法等時，在該段下方顯示被引用條文</small></span>${seg('refs', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">點一下切換<small>用手指或 Apple Pencil 點紅字或其下方的紅點線，即可隱藏／顯示該則註記</small></span>${seg('tap', [['true', '開啟'], ['false', '關閉']])}</div>
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距</span>${seg('lh', [['1.8', '緊'], ['2', '中'], ['2.3', '鬆']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示同條各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">判決／沿革標記</span>${seg('chips', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">目前共有 ${n} 條有註記<small>儲存方式：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>可選檔案或貼上 JSON</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料</div>
      <div class="meta-list">條文：${esc(D.meta.source)}，修正日期 ${roc(D.meta.modified)}，資料庫更新 ${esc(D.meta.sourceUpdate)}。<br>
        新舊對照：全國法規資料庫歷次版本（${D.versions.length} 個版本，民國19年至今）。<br>
        判決・函釋：內建 ${nr} 則（司法院裁判書原文摘錄、主管機關函釋、全國法規資料庫判例）。<br>
        相關法條：${Object.values(D.reflaws).map((l) => esc(l.name)).join('、')}。<br>
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
          $$(`[data-set="${k}"]`, body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          if (k === 'anno') { setAllAnno(v === 'true'); return; }
          settings[k] = k === 'theme' ? v : k === 'lh' ? +v : v === 'true';
          saveSettings(); applySettings();
          if (['chips', 'pn', 'builtin', 'refs'].includes(k)) { renderReader(); if (current) renderDetail(); }
        } else if (b.dataset.size) {
          settings.size = Math.max(14, Math.min(30, settings.size + +b.dataset.size));
          $('#size-val').textContent = settings.size + 'px';
          saveSettings(); applySettings();
        } else if (b.dataset.act === 'export') {
          const blob = new Blob([exportData()], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `勞資爭議處理法註記備份-${new Date().toISOString().slice(0, 10)}.json`;
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
  onChange: (aid) => { refreshChips(aid); if (current === aid && detailTab === 'notes') renderDetail(); },
});
ink.color = 'red';
ink.width = '細';
function setInk(on) {
  if (on && lasso.active) setLasso(false);
  ink.setActive(on);
  $('#btn-ink').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#inkbar').hidden = !on;
  if (on) { hidePop(); window.getSelection()?.removeAllRanges(); toast('手寫模式：用 Apple Pencil 在條文上書寫'); }
}
function bindInkbar() {
  const bar = $('#inkbar');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) {
      ink.tool = b.dataset.tool;
      if (b.dataset.color) ink.color = b.dataset.color;
      $$('[data-tool]', bar).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
    } else if (b.dataset.act === 'width') {
      ink.width = WIDTHS[(WIDTHS.indexOf(ink.width) + 1) % WIDTHS.length];
      b.textContent = ink.width;
    } else if (b.dataset.act === 'undo') {
      if (!ink.undoLast()) toast('沒有可復原的筆畫');
    } else if (b.dataset.act === 'finger') {
      ink.finger = !ink.finger;
      b.setAttribute('aria-pressed', ink.finger ? 'true' : 'false');
      document.body.classList.toggle('finger', ink.finger);
      toast(ink.finger ? '手指也可書寫（捲動請用兩指）' : '只有 Apple Pencil 可書寫');
    } else if (b.dataset.act === 'done') setInk(false);
  });
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
function bind() {
  $('#btn-nav').onclick = () => setSide(!$('#sidebar').classList.contains('open'));
  $('#scrim').onclick = () => setSide(false);
  $('#btn-settings').onclick = openSettings;
  $('#btn-ink').onclick = () => setInk(!ink.active);
  $('#btn-lasso').onclick = () => setLasso(!lasso.active);
  $('#btn-anno').onclick = () => setAllAnno(!settings.anno);
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

  const q = $('#q');
  const run = debounce(() => { showSide('search'); doSearch(q.value); }, 220);
  q.addEventListener('input', () => { if (q.value.trim()) run(); });
  q.addEventListener('focus', () => { if (q.value.trim()) { showSide('search'); setSide(true); } });
  $('#search-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const jump = parseAidInput(q.value);
    if (jump && byId.has(jump)) { gotoArticle(jump); q.blur(); return; }
    showSide('search'); doSearch(q.value); setSide(true); q.blur();
  });

  $('#side-toc').addEventListener('click', (e) => {
    const g = e.target.closest('[data-goto]');
    if (g) { gotoArticle(g.dataset.goto); return; }
    const lw = e.target.closest('[data-law]');
    if (lw) { openLaw(lw.dataset.law); return; }
    if (e.target.closest('[data-act="versions"]')) { openVersions(); return; }
    const btn = e.target.closest('.toc-btn[data-h]');
    if (btn) { scrollToEl(document.getElementById('h-' + btn.dataset.h)); setSide(false); }
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

  const reader = $('#reader');
  reader.addEventListener('scroll', () => { trackTOC(); if (!$('#hl-pop').hidden && !pendingSel) hidePop(); hideXPop(); }, { passive: true });
  const clickArticle = (e) => {
    if (ink.active || lasso.active) return;
    if (press && press.fired) { press = null; return; }
    const host = e.target.closest('[data-id]');
    const sel = window.getSelection();
    const selecting = sel && !sel.isCollapsed;
    // 1) 紅字註記：點一下切換
    const an = e.target.closest('[data-an], [data-ann]');
    if (an && host && !selecting) {
      const id = an.dataset.an || an.dataset.ann;
      const r = getRec(host.dataset.id);
      const h = r && (r.hl || []).find((x) => x.id === id);
      if (settings.tap) toggleIds(host.dataset.id, [id], 'toggle');
      else if (h || an.matches('rt, .an-n, ruby')) openNoteMenu(host.dataset.id, id, an.getBoundingClientRect());
      return;
    }
    // 2) 相關法條小字（「展開」只展開，不隱藏）
    const more = e.target.closest('[data-rfx]');
    if (more) { more.previousElementSibling?.classList.remove('clamp'); more.remove(); return; }
    const lr = e.target.closest('[data-lr], [data-rf]');
    if (lr && host && !selecting) {
      if (e.target.closest('.rf .rf-h') && !e.target.closest('[data-lr]')) {
        const r = refsOf(host.dataset.id).find((x) => x.id === lr.dataset.rf);
        if (r && e.detail === 2) { openLaw(r.pcode, r.flno); return; }
      }
      toggleIds(host.dataset.id, [lr.dataset.lr || lr.dataset.rf], 'toggle');
      return;
    }
    // 3) 本法條號 → 預覽
    const x = e.target.closest('a.xref');
    if (x) { e.preventDefault(); showXPop(x.dataset.goto, x.getBoundingClientRect()); return; }
    const art = e.target.closest('[data-art-toggle]');
    if (art) { toggleArticle(art.dataset.artToggle); return; }
    const op = e.target.closest('[data-open]');
    if (op) { openDetail(op.dataset.open, op.dataset.tab); return; }
    // 4) 螢光線
    const hl = e.target.closest('.hl[data-hl]');
    if (hl && host && !selecting) {
      activeHl = { aid: host.dataset.id, id: hl.dataset.hl };
      pendingSel = null;
      const r = getRec(activeHl.aid);
      const h = r && (r.hl || []).find((y) => y.id === activeHl.id);
      showPop(hl.getBoundingClientRect(), 'edit', h && h.n);
    }
  };
  reader.addEventListener('click', clickArticle);
  $('#d-text').addEventListener('click', clickArticle);
  bindLongPress(reader);
  bindLongPress($('#d-text'));
  document.addEventListener('selectionchange', onSelChange);
  $('#hl-pop').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (b) popAction(b.dataset.hl);
  });
  $('#x-go').onclick = () => { const t = xTarget; hideXPop(); if (t) gotoArticle(t); };
  $('#x-close').onclick = hideXPop;
  document.addEventListener('pointerdown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop') && !e.target.closest('.hl')) {
      setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hidePop(); }, 10);
    }
    if (!$('#x-pop').hidden && !e.target.closest('#x-pop') && !e.target.closest('a.xref')) hideXPop();
  });

  $('#d-body').addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-goto]');
    if (!b) return;
    if (b.dataset.goto) { e.preventDefault(); gotoArticle(b.dataset.goto); return; }
    if (b.dataset.rf) { rulFilter = b.dataset.rf; renderDetail(); return; }
    if (b.dataset.cm) { cmpMode = b.dataset.cm; renderHistory($('#d-body')); return; }
    if (b.dataset.cmp) { const i = +b.dataset.cmp; cmpSel = { aid: current, a: i - 1, b: i }; renderHistory($('#d-body')); return; }
    const card = b.closest('.rcard');
    const act = b.dataset.act;
    if (act === 'add-item') editItem(current);
    else if (act === 'versions') openVersions();
    else if (act === 'open-law') openLaw(b.dataset.pc, b.dataset.no);
    else if (act === 'ref-vis') { toggleIds(current, [b.dataset.id], 'toggle'); renderRefs($('#d-body')); }
    else if (act === 'an-vis') { toggleIds(current, [b.dataset.id], 'toggle'); }
    else if (act === 'imp' && card) {
      const r = getRec(current, true);
      r.imp = r.imp || {};
      const k = card.dataset.key;
      const it = rulingList(current).find((x) => x.key === k);
      r.imp[k] = it && it.mark ? 0 : 1;
      if (it && !!it.imp === !!r.imp[k]) delete r.imp[k];
      saveRec(current); renderDetail();
    } else if (act === 'expand' && card) {
      $$('.rpart.clamp', card).forEach((p) => p.classList.remove('clamp'));
      b.remove();
    } else if (act === 'rnote' && card) editRulingNote(current, card.dataset.key);
    else if (act === 'to-anno' && card) rulingToAnno(current, card.dataset.key);
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
      afterChange(current);
    } else if (act === 'ink-on') {
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
    const m = location.hash.match(/^#a-(\d+(?:-\d+)?)$/);
    if (m && m[1] !== current) gotoArticle(m[1]);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#hl-pop').hidden) hidePop(); else if (!$('#x-pop').hidden) hideXPop();
      else if (lasso.active) setLasso(false); else if (ink.active) setInk(false); else if (current) closeDetail();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => ink.redrawAll());
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
function prepare() {
  for (const a of D.articles) { byId.set(a.id, a); order.push(a.id); }
  for (const [aid, lst] of Object.entries(D.notes || {})) {
    const a = byId.get(aid);
    const out = [];
    for (const n of lst) {
      const body = splitPara(a.p[n.p] || '').body;
      const s = body.indexOf(n.q);
      if (s < 0) continue;
      out.push({ id: n.id, p: n.p, s, e: s + n.q.length, q: n.q, n: n.n, pos: n.pos, b: true });
    }
    builtin.set(aid, out);
  }
  for (const a of D.articles) {
    const seen = new Set();
    for (const t of a.p) for (const x of xrefRanges(t, 'law')) if (x.aid !== a.id && !seen.has(x.aid)) {
      seen.add(x.aid);
      if (!citedBy.has(x.aid)) citedBy.set(x.aid, []);
      citedBy.get(x.aid).push(a.id);
    }
  }
}
async function boot() {
  try {
    const [law, saved] = await Promise.all([
      fetch('data/law.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      store.getAll().catch(() => ({})),
    ]);
    D = law;
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('a:')) notes.set(k.slice(2), v);
      else if (k === 'settings') settings = { ...settings, ...v };
    }
    prepare();
  } catch (e) {
    $('#loading').textContent = '無法載入條文資料：' + e.message;
    return;
  }
  applySettings();
  renderTOC();
  renderReader();
  bind();
  bindInkbar();
  bindLasso();
  doSearch('');
  const m = location.hash.match(/^#a-(\d+(?:-\d+)?)$/);
  if (m && byId.has(m[1])) gotoArticle(m[1]);
  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
