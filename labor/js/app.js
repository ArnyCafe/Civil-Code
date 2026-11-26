import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, isMarker } from './ink.js';
import { layoutBlock } from './gloss.js';

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let D = null;              // 法規資料
let C = { cases: [] };     // 判決
const byId = new Map();
const order = [];
const notes = new Map();   // owner -> 使用者紀錄（owner：條號，或 C:判決id、Q:問答序號）
const openTab = new Map(); // aid -> 目前展開的分頁
const xrOpen = new Map();  // `${aid}|${law}|${a}` -> true/false（點選切換引用小字）
let settings = {
  theme: 'system', size: 19, lh: 2.05, pn: true,
  refs: 'show',        // show 顯示小字｜tap 點選才顯示｜off 不顯示
  self: true,          // 本法條文也顯示小字
  gsize: 'm',          // 註記字級
  ann: true,           // 顯示我的註記
  tap: 'toggle',       // 點註記：toggle 切換顯示｜menu 開啟選單
  defTab: '',          // 預設展開
  pen: { color: 'red', width: 0.5, mwidth: 14, pressure: true },
};

const USER_KINDS = ['判決', '函釋', '決議', '座談會', '其他'];
const HL_COLORS = { r: '紅線', y: '黃', g: '綠', b: '藍', p: '粉' };
const CN_DIGIT = '零一二三四五六七八九';

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
const aidLabel = (aid) => { const [a, b] = String(aid).split('-'); return b ? `第${a}條之${b}` : `第${a}條`; };
const roc = (d, short) => {
  if (!d || d.length < 8) return d || '';
  const y = +d.slice(0, 4) - 1911, m = d.slice(4, 6), dd = d.slice(6, 8);
  return short ? `${y}.${m}.${dd}` : `民國${y}年${+m}月${+dd}日`;
};
function cnNum(s) {
  const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
  }
  return total + cur;
}
const toInt = (s) => (/^\d+$/.test(s) ? +s : cnNum(s));
function parseAidInput(q) {
  q = q.trim().replace(/\s+/g, '');
  let m = q.match(/^(?:勞動事件法|勞事法)?第?(\d+)(?:條)?$/);
  if (m) return m[1];
  m = q.match(/^(?:勞動事件法|勞事法)?第?([零〇一二三四五六七八九十百]+)條$/);
  if (m) return String(cnNum(m[1]));
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
const lawUrl = (law, aid) => {
  const pc = law === '勞動事件法' ? D.meta.pcode : (D.ext[law] && D.ext[law].pcode) || (Object.values(D.rules).find((r) => r.name === law) ? Object.keys(D.rules).find((k) => D.rules[k].name === law) : '');
  if (!pc) return '';
  return aid ? `https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=${pc}&flno=${aid}` : `https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=${pc}`;
};

// ---------------------------------------------------------------------------
// 使用者紀錄
// ---------------------------------------------------------------------------
function getRec(owner, create) {
  let r = notes.get(owner);
  if (!r && create) { r = {}; notes.set(owner, r); }
  return r;
}
function isEmptyRec(r) {
  return !r || (!r.star && !r.note && !(r.tags && r.tags.length) && !(r.an && r.an.length) &&
    !(r.ink && r.ink.strokes && r.ink.strokes.length) && !(r.items && r.items.length) &&
    !(r.imp && Object.keys(r.imp).length) && !(r.cnote && Object.keys(r.cnote).length) && !r.off);
}
async function saveRec(owner) {
  const r = notes.get(owner);
  try {
    if (isEmptyRec(r)) { notes.delete(owner); await store.del('a:' + owner); }
    else { r.t = Date.now(); await store.put('a:' + owner, r); }
  } catch (e) {
    console.error(e);
    toast('無法儲存註記：' + (e.message || e));
  }
}
async function saveSettings() { try { await store.put('settings', settings); } catch {} }
const annsOf = (owner, k) => ((getRec(owner) || {}).an || []).filter((x) => x.k === k);
const annCount = (r) => ((r && r.an) || []).length + ((r && r.ink && r.ink.strokes && r.ink.strokes.length) ? 1 : 0);

// ---------------------------------------------------------------------------
// 文字呈現：引用法條連結＋我的註記（劃線、行間註記）
// ---------------------------------------------------------------------------
// refs: [{s,e,law,a,rel}]；anns: [{id,s,e,n,pos,c,hide}]
function richText(text, anns, refs) {
  const L = text.length;
  const cuts = new Set([0, L]);
  const clamp = (v) => Math.max(0, Math.min(L, v));
  for (const a of anns) { cuts.add(clamp(a.s)); cuts.add(clamp(a.e)); }
  for (const r of refs) { cuts.add(r.s); cuts.add(r.e); }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    const seg = text.slice(s, e);
    const starts = anns.filter((a) => clamp(a.s) === s && a.e > a.s);
    const ends = anns.filter((a) => clamp(a.e) === e && a.e > a.s);
    let piece;
    const strutS = starts.map((a) => `<i class="gs${a.n && a.hide ? ' col' : ''}" data-s="${a.id}"></i>`).join('');
    const strutE = ends.map((a) => `<i class="gs" data-e="${a.id}"></i>`).join('');
    if (seg.length === 1) piece = `<span class="gn">${strutS}${esc(seg)}${strutE}</span>`;
    else {
      const head = strutS ? `<span class="gn">${strutS}${esc(seg[0])}</span>` : esc(seg[0]);
      const mid = esc(seg.slice(1, -1));
      const tail = strutE ? `<span class="gn">${esc(seg[seg.length - 1])}${strutE}</span>` : esc(seg[seg.length - 1]);
      piece = head + mid + tail;
    }
    const rs = refs.filter((r) => r.s <= s && r.e >= e);
    if (rs.length) {
      const self = rs.every((r) => r.law === '勞動事件法' && !r.rel);
      const x = rs.map((r) => `${r.law}|${r.a}`).join(';');
      const cls = 'xref' + (self ? ' self' : '') + (rs.every((r) => r.rel) ? ' rel' : '') + (rs.some((r) => !r.a) ? ' bare' : '');
      piece = self && rs[0].a && byId.has(rs[0].a)
        ? `<a class="${cls}" href="#a-${rs[0].a}" data-goto="${rs[0].a}" data-x="${esc(x)}">${piece}</a>`
        : `<a class="${cls}" data-x="${esc(x)}">${piece}</a>`;
    }
    for (const a of anns) {
      if (clamp(a.s) <= s && clamp(a.e) >= e) {
        piece = `<span class="ga ga-${a.c || 'n'}${a.n ? ' has-n' : ''}" data-g="${a.id}">${piece}</span>`;
      }
    }
    html += piece;
  }
  return html;
}
function glossLayer(anns) {
  const gs = anns.filter((a) => a.n);
  return `<div class="gl-layer" aria-hidden="false">${gs.map((a) => `<div class="gl" data-g="${a.id}" data-pos="${a.pos === 'below' ? 'below' : 'above'}">${esc(a.n)}</div>`).join('')}</div>`;
}
// 可註記的一段文字（立法理由、判決、問答…）
function annBlock(owner, k, text, refs = [], tag = 'p', cls = '') {
  const anns = annsOf(owner, k);
  return `<div class="gblk ${cls}" data-owner="${esc(owner)}" data-k="${esc(k)}"><${tag} class="rt" data-k="${esc(k)}">${richText(text, anns, refs)}</${tag}>${glossLayer(anns)}</div>`;
}

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

// 條文 refs（build 產生）：[段, 起, 迄, 法規, 條號, 項款, 相關]
function refsOfPara(a, i, offset) {
  return (a.refs || []).filter((r) => r[0] === i).map((r) => ({ s: r[1] - offset, e: r[2] - offset, law: r[3], a: r[4], sub: r[5], rel: !!r[6] }))
    .filter((r) => r.s >= 0);
}
function refsOfText(list, i = 0) {
  return (list || []).filter((r) => r[0] === i).map((r) => ({ s: r[1], e: r[2], law: r[3], a: r[4], sub: r[5], rel: !!r[6] }));
}

// 引用條文的項、款 → 要標示的段落
function subTargets(sub) {
  const out = [];
  if (!sub) return out;
  let xiang = 0;
  const re = /第([零〇一二三四五六七八九十百\d]+)([項款目])(?:至第([零〇一二三四五六七八九十百\d]+)\2)?/g;
  let m;
  while ((m = re.exec(sub))) {
    const a = toInt(m[1]), b = m[3] ? toInt(m[3]) : a;
    for (let k = a; k <= b; k++) {
      if (m[2] === '項') { xiang = k; out.push({ x: k, k: 0 }); }
      else if (m[2] === '款') {
        // 指明款次時，只標示該款（不標示整項）
        const i = out.findIndex((g) => g.x === (xiang || 1) && g.k === 0);
        if (i >= 0) out.splice(i, 1);
        out.push({ x: xiang || 1, k });
      }
    }
  }
  return out;
}
function extParasHTML(paras, sub, foldK) {
  const tg = subTargets(sub);
  let xi = 0, ki = 0;
  const nX = paras.filter((t) => !KUAN_RE.test(t) && !SUB_RE.test(t)).length;
  // 指明項款且條文較長時，只顯示該項款（其餘可點「全條」展開）；「相關」條文款次多時只顯示各項本文
  const nK = paras.filter((t) => KUAN_RE.test(t) || SUB_RE.test(t)).length;
  const foldKuan = !tg.length && foldK && nK > 3;
  const fold = (tg.length && paras.length > 3) || foldKuan;
  let dimmed = 0;
  const out = paras.map((t) => {
    const isK = KUAN_RE.test(t), isS = SUB_RE.test(t);
    if (!isK && !isS) { xi++; ki = 0; } else if (isK) ki++;
    const hit = tg.some((g) => g.x === xi && (g.k === 0 || (isK && g.k === ki)));
    const lead = !isK && !isS && tg.some((g) => g.x === xi && g.k > 0);
    const dim = foldKuan ? (isK || isS) : fold && !hit && !lead;
    if (dim) dimmed++;
    const pn = !isK && !isS && nX > 1 ? `<i>${ROMAN[xi - 1] || xi}</i>` : '';
    return `<span class="xp${isK || isS ? ' k' : ''}${hit ? ' hit' : ''}${dim ? ' dim' : ''}">${pn}${esc(t)}</span>`;
  }).join('');
  return out + (dimmed ? `<button class="xfull" data-xfull>全條</button>` : '');
}
function lawText(law, aid) {
  if (law === '勞動事件法') return byId.has(aid) ? byId.get(aid).p : null;
  const e = D.ext[law];
  return e && e.arts[aid] ? e.arts[aid] : null;
}
function refItemHTML(aid, r, extraCls = '') {
  const paras = r.a ? lawText(r.law, r.a) : null;
  const key = `${aid}|${r.law}|${r.a}`;
  const self = r.law === '勞動事件法';
  const head = `<b>${esc(self ? '本法' : r.law)}${r.a ? esc(aidLabel(r.a)) : ''}</b>${r.rel ? '<em>相關</em>' : ''}`;
  const link = lawUrl(r.law, r.a);
  if (!r.a) {
    return `<div class="xri bare ${extraCls}" data-x="${esc(r.law + '|')}">${head}<span class="xp">（全文見全國法規資料庫）</span>${link ? `<a class="xlink" href="${link}" target="_blank" rel="noopener">↗</a>` : ''}</div>`;
  }
  const open = xrOpen.has(key) ? xrOpen.get(key) : settings.refs === 'show';
  return `<div class="xri ${extraCls}${open ? '' : ' shut'}" data-x="${esc(r.law + '|' + r.a)}" data-key="${esc(key)}">${head}${paras ? extParasHTML(paras, r.sub, r.rel) : '<span class="xp">（未收錄）</span>'}${self ? `<button class="xlink" data-goto="${r.a}">跳至</button>` : link ? `<a class="xlink" href="${link}" target="_blank" rel="noopener">↗</a>` : ''}</div>`;
}

function renderParas(a) {
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  let xi = 0;
  return a.p.map((t, i) => {
    const sp = splitPara(t);
    const off = t.length - sp.body.length;
    const k = 'p' + i;
    const anns = annsOf(a.id, k);
    const refs = refsOfPara(a, i, off);
    const body = richText(sp.body, anns, refs);
    let para;
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      para = `<p class="para"><span class="pn">${pn}</span><span class="pt" data-k="${k}">${body}</span></p>`;
    } else {
      para = `<p class="para kuan${sp.kind === 'sub' ? ' sub' : ''}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-k="${k}">${body}</span></p>`;
    }
    let html = `<div class="pblk gblk" data-b="${k}" data-owner="${a.id}" data-k="${k}">${para}${glossLayer(anns)}</div>`;
    // 引用法條小字
    if (settings.refs !== 'off') {
      const seen = new Set();
      const items = [];
      for (const r of refs) {
        if (r.law === '勞動事件法' && (!settings.self || !r.a || r.a === a.id)) continue;
        if (!r.a && refs.some((x) => x.law === r.law && x.a)) continue;
        const key = r.law + '|' + r.a;
        if (seen.has(key)) continue;
        seen.add(key);
        items.push(refItemHTML(a.id, r));
      }
      if (items.length) html += `<div class="xr" data-b="x${i}">${items.join('')}</div>`;
    }
    return html;
  }).join('');
}

// ---------------------------------------------------------------------------
// 條文區塊
// ---------------------------------------------------------------------------
const casesOf = (aid) => C.cases.filter((c) => c.a.includes(aid));
const qaOf = (aid) => D.qa.map((q, i) => ({ ...q, i })).filter((q) => q.a.includes(aid));
const rulesOf = (aid) => D.ruleMap[aid] || [];
const userItems = (aid, kinds) => ((getRec(aid) || {}).items || []).filter((x) => !kinds || kinds.includes(x.kind));

function tabsOf(a) {
  const amended = a.v.length > 1;
  const nc = new Set(casesOf(a.id).map((c) => c.no)).size + userItems(a.id, ['判決', '決議', '座談會', '其他']).length;
  const nq = qaOf(a.id).length + userItems(a.id, ['函釋']).length;
  const nr = rulesOf(a.id).length;
  const rec = getRec(a.id);
  const nn = rec ? (rec.note ? 1 : 0) + ((rec.an || []).length) : 0;
  return [
    ['reason', amended ? '立法・修正理由' : '立法理由', ''],
    ...(amended ? [['amend', '新舊對照', '']] : []),
    ['cases', '判決', nc],
    ['interp', '函釋・見解', nq],
    ['rules', '審理細則', nr],
    ['notes', '筆記', nn || ''],
  ];
}

function headHTML(a) {
  const rec = getRec(a.id);
  const amended = a.v.length > 1;
  const nAnn = annCount(rec);
  return `<header class="art-head" data-b="h">
    <button class="ano" data-tab-toggle="${a.id}">${aidLabel(a.id)}</button>
    ${amended ? `<span class="chip c-amd" title="${esc(D.meta.leg['1121205'].doc)}">112年修正</span>` : ''}
    ${rec && rec.star ? '<span class="chip c-star">★</span>' : ''}
    <span class="head-sp"></span>
    ${nAnn ? `<button class="eye" data-art-eye="${a.id}" aria-pressed="${rec && rec.off ? 'false' : 'true'}" title="顯示／隱藏本條我的註記">${rec && rec.off ? '註記已隱藏' : '註記 ' + nAnn}</button>` : ''}
  </header>`;
}

function articleInner(a) {
  const tab = openTab.get(a.id) || '';
  const tabs = tabsOf(a);
  return `<div class="abody">${headHTML(a)}<div class="atext">${renderParas(a)}</div></div>
    <nav class="atabs" role="tablist">${tabs.map(([k, l, n]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}${n ? `<b>${n}</b>` : ''}</button>`).join('')}</nav>
    <div class="apanel" ${tab ? '' : 'hidden'}>${tab ? panelHTML(a, tab) : ''}</div>`;
}

function renderReader() {
  const parts = [];
  const firstOf = new Map();
  D.headings.forEach((h, i) => { if (h.first) firstOf.set(h.first, i); });
  const lg = D.meta.leg;
  parts.push(`<div class="title-block"><h1>${esc(D.meta.name)}</h1><p>${roc(lg['1071109'].pub)}制定公布全文53條，${roc(lg['1071109'].eff).replace('民國', '')}施行。<br>${roc(lg['1121205'].pub)}修正公布第2、16、25、32條，${roc(lg['1121205'].eff).replace('民國', '')}施行。</p></div>`);
  for (const a of D.articles) {
    if (firstOf.has(a.id)) { const hi = firstOf.get(a.id); parts.push(`<h2 class="h-chap" id="h-${hi}">${esc(D.headings[hi].t)}</h2>`); }
    const rec = getRec(a.id);
    parts.push(`<article class="art${rec && rec.off ? ' off' : ''}" id="a-${a.id}" data-id="${a.id}">${articleInner(a)}</article>`);
  }
  const inner = $('#reader-inner');
  ink.unobserveAll();
  inner.innerHTML = parts.join('');
  inner.classList.toggle('no-pn', !settings.pn);
  $$('.art', inner).forEach((el) => ink.observe(el));
  relayout();
}

function refreshArticle(aid, keepPanel = true) {
  const el = document.getElementById('a-' + aid);
  if (!el) return;
  const a = byId.get(aid);
  const rec = getRec(aid);
  el.classList.toggle('off', !!(rec && rec.off));
  const scrollEl = el.querySelector('.apanel');
  const st = scrollEl ? scrollEl.scrollTop : 0;
  el.innerHTML = articleInner(a);
  if (keepPanel && el.querySelector('.apanel')) el.querySelector('.apanel').scrollTop = st;
  layoutArticle(el);
  ink.refresh(aid);
}
// 只重畫某個擁有者（判決、問答）的註記：可能出現在多條的面板中
function refreshOwner(owner) {
  if (byId.has(owner)) return refreshArticle(owner);
  for (const blk of $$(`.gblk[data-owner="${CSS.escape(owner)}"]`)) {
    const art = blk.closest('.art');
    if (art) { refreshPanel(art.dataset.id); }
  }
  for (const blk of $$(`#modal .gblk[data-owner="${CSS.escape(owner)}"]`)) blk.replaceWith(htmlToEl(annBlock(owner, blk.dataset.k, blockText(owner, blk.dataset.k), blockRefs(owner, blk.dataset.k), 'p', blk.className.replace('gblk', '').trim())));
}
const htmlToEl = (h) => { const t = document.createElement('template'); t.innerHTML = h.trim(); return t.content.firstChild; };
function refreshPanel(aid) {
  const el = document.getElementById('a-' + aid);
  if (!el) return;
  const p = el.querySelector('.apanel');
  const tab = openTab.get(aid) || '';
  const st = p.scrollTop;
  p.hidden = !tab;
  p.innerHTML = tab ? panelHTML(byId.get(aid), tab) : '';
  p.scrollTop = st;
  $$('.atabs button', el).forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === tab ? 'true' : 'false'));
  layoutArticle(el);
}
function refreshTabs(aid) {
  const el = document.getElementById('a-' + aid);
  if (!el) return;
  const tab = openTab.get(aid) || '';
  el.querySelector('.atabs').innerHTML = tabsOf(byId.get(aid)).map(([k, l, n]) => `<button role="tab" data-tab="${k}" aria-selected="${tab === k}">${l}${n ? `<b>${n}</b>` : ''}</button>`).join('');
  el.querySelector('.art-head').outerHTML = headHTML(byId.get(aid));
}

// ---------------------------------------------------------------------------
// 行間註記排版
// ---------------------------------------------------------------------------
function isHidden(blk, id) {
  if (!settings.ann) return true;
  const art = blk.closest('.art');
  if (art && art.classList.contains('off')) return true;
  const owner = blk.dataset.owner;
  const a = ((getRec(owner) || {}).an || []).find((x) => x.id === id);
  return !a || !!a.hide;
}
function layoutArticle(el) {
  for (const blk of el.querySelectorAll('.gblk')) layoutBlock(blk, (id) => isHidden(blk, id));
  ink.draw(el.dataset.id);
}
function relayout() {
  const root = $('#reader-inner');
  for (const blk of root.querySelectorAll('.gblk')) layoutBlock(blk, (id) => isHidden(blk, id));
  for (const blk of $$('#modal .gblk')) layoutBlock(blk, (id) => isHidden(blk, id));
  ink.redrawAll();
}
const relayoutSoon = debounce(relayout, 120);

// ---------------------------------------------------------------------------
// 分頁內容
// ---------------------------------------------------------------------------
function panelHTML(a, tab) {
  if (tab === 'reason') return reasonHTML(a);
  if (tab === 'amend') return amendHTML(a);
  if (tab === 'cases') return casesHTML(a);
  if (tab === 'interp') return interpHTML(a);
  if (tab === 'rules') return rulesHTML(a);
  return notesHTML(a);
}
function legLine(v) {
  return `${v.k === 'orig' ? '制定' : '修正'}｜${roc(v.pass, true)} 三讀・${roc(v.pub, true)} 公布・${roc(v.eff, true)} 施行`;
}
function reasonHTML(a) {
  let html = '';
  a.v.forEach((v, vi) => {
    const label = v.k === 'orig' ? '立法理由' : '修正理由';
    html += `<section class="pv"><div class="pv-h"><span class="tpill ${v.k === 'orig' ? 'tp-orig' : 'tp-amd'}">${label}</span><span>${esc(legLine(v))}</span></div>`;
    if (a.v.length > 1) html += `<div class="pv-text"><span class="lbl">${v.k === 'orig' ? '制定條文' : '修正條文'}</span>${v.p.map((t) => `<p>${esc(t)}</p>`).join('')}</div>`;
    html += v.r.map((t, i) => annBlock(a.id, `r${vi}-${i}`, t, refsOfText(v.rrefs, i), 'p', 'rsn')).join('');
    html += '</section>';
  });
  // 立法理由所引法條
  const seen = new Set(), items = [];
  a.v.forEach((v) => (v.rrefs || []).forEach((r) => {
    const law = r[3], aid = r[4];
    if (!aid || (law === '勞動事件法')) return;
    const key = law + '|' + aid;
    if (seen.has(key)) return;
    seen.add(key);
    items.push(refItemHTML(a.id, { law, a: aid, sub: '' }, 'in-panel'));
  }));
  if (items.length) html += `<details class="cited"><summary>理由所引法條（${items.length}）・現行條文</summary><div class="xr">${items.join('')}</div></details>`;
  html += `<p class="src">來源：立法院法律系統「法條沿革」。理由中所引之法律名稱與條次為立法當時之規定。</p>`;
  return html;
}
let cmpMode = 'table';
function amendHTML(a) {
  if (a.v.length < 2) return '<p class="empty">本條自制定施行以來未曾修正。</p>';
  const A = a.v[a.v.length - 2], B = a.v[a.v.length - 1];
  const dd = diffParas(A.p, B.p);
  let html = `<div class="cmp-ctl"><span class="segs" role="group"><button type="button" data-cm="table" aria-pressed="${cmpMode === 'table'}">對照表</button><button type="button" data-cm="inline" aria-pressed="${cmpMode === 'inline'}">標示差異</button></span></div>`;
  if (cmpMode === 'table') {
    html += `<div class="cmp-wrap"><table class="cmp"><thead><tr><th>修正條文<small>${roc(B.pub, true)} 公布・${roc(B.eff, true)} 施行</small></th><th>修正前條文<small>${roc(A.pub, true)} 公布</small></th></tr></thead>
      <tbody><tr><td>${dd.new}</td><td>${dd.old}</td></tr></tbody></table></div>`;
  } else html += `<div class="inline-diff">${dd.inline}</div>`;
  html += `<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>`;
  html += `<section class="pv"><div class="pv-h"><span class="tpill tp-amd">修正理由</span></div>${B.r.map((t, i) => annBlock(a.id, `r${a.v.length - 1}-${i}`, t, refsOfText(B.rrefs, i), 'p', 'rsn')).join('')}</section>`;
  html += `<p class="src">${esc(D.meta.leg['1121205'].doc)}。</p>`;
  return html;
}
function starBtn(owner, key, on) {
  return `<button class="rstar" data-act="imp" data-owner="${esc(owner)}" data-key="${esc(key)}" aria-pressed="${on}" aria-label="標記重要"><svg viewBox="0 0 24 24"><path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.5 9.7l5.9-.8z"/></svg></button>`;
}
// 同一裁判有多段摘錄時合併為一張卡片；星號與筆記記在第一段摘錄
function caseCard(list, aid) {
  const c = list[0];
  const owner = 'C:' + c.id;
  const rec = getRec(owner) || {};
  const short = c.no.replace('最高法院', '').replace('民事', '');
  const nsame = Math.max(...list.map((x) => x.nsame));
  const same = [...new Set(list.flatMap((x) => x.same))];
  const also = [...new Set(list.flatMap((x) => x.a))].filter((x) => x !== aid);
  return `<article class="rcard${rec.star ? ' imp' : ''}" data-owner="${esc(owner)}">
    <div class="rhead"><span class="tpill tp-tps">最高法院</span><span class="rno">${esc(short)}</span><span class="rdate">${esc(c.date)}</span>${starBtn(owner, '', !!rec.star)}</div>
    ${list.map((x) => `<div class="rsum">${esc(x.note)}</div>${annBlock('C:' + x.id, 't', x.text, [], 'p', 'ctext')}`).join('')}
    ${rec.note ? `<div class="rnote">${esc(rec.note)}</div>` : ''}
    <div class="rfoot">
      <a href="${esc(c.url)}" target="_blank" rel="noopener">裁判全文</a>
      <button class="linkish" data-act="cnote" data-owner="${esc(owner)}">${rec.note ? '編輯筆記' : '加筆記'}</button>
      ${nsame ? `<details class="same"><summary>同旨 ${nsame} 則</summary>${same.map((s) => `<span>${esc(s)}</span>`).join('')}</details>` : ''}
      ${also.length ? `<span class="also">亦見：${also.map((x) => `<button class="linkish" data-goto="${x}">${aidLabel(x)}</button>`).join('')}</span>` : ''}
    </div></article>`;
}
function userItemCard(aid, it) {
  return `<article class="rcard user" data-item="${it.id}">
    <div class="rhead"><span class="tpill tp-U">${esc(it.kind)}</span><span class="rno">${esc(it.no)}</span><span class="rdate">${esc(it.date || '')}</span></div>
    ${it.text ? annBlock(aid, 'u' + it.id, it.text, [], 'p', 'ctext') : ''}
    <div class="rfoot">${it.url ? `<a href="${esc(it.url)}" target="_blank" rel="noopener">原文</a>` : ''}<button class="linkish" data-act="edit-item" data-id="${it.id}">編輯</button></div></article>`;
}
function casesHTML(a) {
  const groups = new Map();
  for (const c of casesOf(a.id)) { if (!groups.has(c.no)) groups.set(c.no, []); groups.get(c.no).push(c); }
  const cs = [...groups.values()].sort((x, y) => (getRec('C:' + y[0].id)?.star ? 1 : 0) - (getRec('C:' + x[0].id)?.star ? 1 : 0) || y[0].d.localeCompare(x[0].d));
  const mine = userItems(a.id, ['判決', '決議', '座談會', '其他']);
  let html = `<div class="row-actions top"><button class="btn small primary" data-act="add-item" data-kind="判決">＋ 新增判決</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/Default_AD.aspx" target="_blank" rel="noopener">裁判書查詢</a></div>`;
  html += mine.map((it) => userItemCard(a.id, it)).join('');
  if (!cs.length && !mine.length) html += `<p class="empty">尚未收錄本條之最高法院重要裁判。可自行新增實務判決、決議或法律座談會見解。</p>`;
  html += cs.map((c) => caseCard(c, a.id)).join('');
  if (cs.length) html += `<p class="src">摘錄自司法院裁判書查詢系統之最高法院民事裁判，為原文逐字擷取；「同旨」為使用相同文字之其他最高法院裁判。</p>`;
  return html;
}
function interpHTML(a) {
  const qs = qaOf(a.id);
  const mine = userItems(a.id, ['函釋']);
  let html = `<div class="row-actions top"><button class="btn small primary" data-act="add-item" data-kind="函釋">＋ 新增函釋</button>
    <a class="btn small" href="https://laws.mol.gov.tw/" target="_blank" rel="noopener">勞動部法令查詢</a>
    <a class="btn small" href="https://lawsearch.judicial.gov.tw/" target="_blank" rel="noopener">司法院法學資料檢索</a></div>`;
  html += mine.map((it) => userItemCard(a.id, it)).join('');
  for (const q of qs) {
    const owner = 'Q:' + q.i;
    const rec = getRec(owner) || {};
    html += `<article class="rcard qa${rec.star ? ' imp' : ''}" data-owner="${esc(owner)}">
      <div class="rhead"><span class="tpill tp-jy">司法院問答</span><span class="rdate">${esc(q.d)}</span>${starBtn(owner, '', !!rec.star)}</div>
      <div class="qt">${esc(q.t)}</div>
      ${annBlock(owner, 'b', q.b, refsOfText(q.refs, 0), 'p', 'ctext qa-b')}
      <div class="rfoot"><a href="${esc(q.url)}" target="_blank" rel="noopener">司法院網站</a>${q.a.length > 1 ? `<span class="also">亦見：${q.a.filter((x) => x !== a.id).map((x) => `<button class="linkish" data-goto="${x}">${aidLabel(x)}</button>`).join('')}</span>` : ''}</div></article>`;
  }
  if (!qs.length && !mine.length) html += '<p class="empty">尚無本條之函釋或司法院問答。可自行新增勞動部、司法院函釋。</p>';
  html += '<p class="src">「司法院問答」為司法院民事廳發布之勞動事件常見問答。勞動部函釋可至勞動法令查詢系統查詢後新增於此。</p>';
  return html;
}
function rulesHTML(a) {
  const list = rulesOf(a.id);
  if (!list.length) return '<p class="empty">勞動事件審理細則、施行細則中沒有直接引用本條之條文。</p>';
  let html = '';
  for (const [pc, rid] of list) {
    const R = D.rules[pc];
    const ra = R.articles.find((x) => x.id === rid);
    if (!ra) continue;
    html += `<article class="rcard rule"><div class="rhead"><span class="tpill tp-rule">${esc(R.short)}</span><span class="rno">${esc(R.name)}${esc(aidLabel(rid))}</span>
      <a class="xlink" href="https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=${pc}&flno=${rid}" target="_blank" rel="noopener">↗</a></div>
      ${ra.p.map((t, i) => annBlock('R:' + pc + ':' + rid, 'p' + i, t, refsOfText(ra.refs, i), 'p', 'ctext rule-p')).join('')}</article>`;
  }
  html += `<p class="src">${esc(D.rules.B0010069.name)}（${roc(D.rules.B0010069.modified, true)} 修正）等子法中，明文引用本條之條文。</p>`;
  return html;
}
function allTags() {
  const s = new Set();
  notes.forEach((r) => (r.tags || []).forEach((t) => s.add(t)));
  return [...s].sort();
}
function blockText(owner, k) {
  if (byId.has(owner)) {
    const a = byId.get(owner);
    if (k[0] === 'p') { const t = a.p[+k.slice(1)] || ''; return splitPara(t).body; }
    if (k[0] === 'r') { const [vi, i] = k.slice(1).split('-').map(Number); return (a.v[vi] && a.v[vi].r[i]) || ''; }
    if (k[0] === 'u') { const it = (getRec(owner)?.items || []).find((x) => x.id === k.slice(1)); return it ? it.text : ''; }
  }
  if (owner.startsWith('C:')) { const c = C.cases.find((x) => x.id === owner.slice(2)); return c ? c.text : ''; }
  if (owner.startsWith('Q:')) { const q = D.qa[+owner.slice(2)]; return q ? q.b : ''; }
  if (owner.startsWith('R:')) { const [, pc, rid] = owner.split(':'); const ra = D.rules[pc]?.articles.find((x) => x.id === rid); return ra ? ra.p[+k.slice(1)] || '' : ''; }
  return '';
}
function blockRefs(owner, k) {
  if (owner.startsWith('Q:')) return refsOfText(D.qa[+owner.slice(2)].refs, 0);
  return [];
}
function ownerLabel(owner) {
  if (byId.has(owner)) return aidLabel(owner);
  if (owner.startsWith('C:')) { const c = C.cases.find((x) => x.id === owner.slice(2)); return c ? c.no.replace('民事', '') : '判決'; }
  if (owner.startsWith('Q:')) { const q = D.qa[+owner.slice(2)]; return q ? '司法院問答：' + q.t.slice(0, 18) + '…' : '問答'; }
  if (owner.startsWith('R:')) { const [, pc, rid] = owner.split(':'); return (D.rules[pc]?.short || '細則') + aidLabel(rid); }
  return owner;
}
function kLabel(owner, k) {
  if (!byId.has(owner)) return '';
  if (k[0] === 'p') return '條文';
  if (k[0] === 'r') return '理由';
  return '筆記';
}
function notesHTML(a) {
  const rec = getRec(a.id) || {};
  const anns = rec.an || [];
  const strokes = rec.ink && rec.ink.strokes ? rec.ink.strokes.length : 0;
  let html = `<div class="field"><label for="note-${a.id}">文字筆記</label>
    <textarea class="note" id="note-${a.id}" data-note="${a.id}" placeholder="要件、爭點、考點、實務見解…（可用 Apple Pencil 直接手寫轉文字）">${esc(rec.note || '')}</textarea>
    <span class="saved" data-saved="${a.id}">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div>`;
  html += `<div class="field"><label>標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" data-tags="${a.id}" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點" enterkeyhint="done"></div>`;
  html += `<div class="field"><span class="lbl">我的註記（${anns.length}）</span>`;
  html += anns.length ? `<ul class="hl-list">${anns.map((h) => `<li><div><small>${kLabel(a.id, h.k)}</small> <span class="q"><mark class="mk mk-${h.c || 'n'}">${esc(blockText(a.id, h.k).slice(h.s, h.e))}</mark></span>${h.n ? `<span class="n">${h.pos === 'below' ? '下' : '上'}：${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions"><button class="linkish" data-act="ann-edit" data-owner="${a.id}" data-id="${h.id}">編輯</button>${h.n ? `<button class="linkish" data-act="ann-hide" data-owner="${a.id}" data-id="${h.id}">${h.hide ? '顯示' : '隱藏'}</button>` : ''}<button class="linkish danger" data-act="ann-del" data-owner="${a.id}" data-id="${h.id}">刪除</button></div></li>`).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">選取條文或理由中的文字，即可加上紅色小字註記（放在文字上方或下方）或螢光筆。</p>';
  html += '</div>';
  html += `<div class="field"><span class="lbl">手寫（${strokes} 筆）</span>
    <div class="row-actions"><button class="btn small" data-act="ink-on">在條文上手寫</button>${strokes ? '<button class="btn small danger" data-act="ink-clear">清除本條手寫</button>' : ''}
    <button class="btn small" data-act="art-off">${rec.off ? '顯示本條註記' : '隱藏本條註記'}</button></div></div>`;
  return html;
}

// ---------------------------------------------------------------------------
// 目錄、導覽
// ---------------------------------------------------------------------------
function renderTOC() {
  let html = '';
  D.headings.forEach((h, i) => {
    const next = D.headings[i + 1];
    const from = order.indexOf(h.first), to = next ? order.indexOf(next.first) : order.length;
    const ids = order.slice(from, to);
    html += `<div class="toc-part"><button class="toc-btn" data-h="${i}"><span>${esc(h.t)}</span><span class="rng">${ids[0]}–${ids[ids.length - 1]}</span></button>
      <div class="toc-grid">${ids.map((id) => {
        const rec = getRec(id);
        const mark = rec && !isEmptyRec(rec) ? ' has' : '';
        return `<button class="tg${mark}${byId.get(id).v.length > 1 ? ' amd' : ''}" data-goto="${id}">${id}</button>`;
      }).join('')}</div></div>`;
  });
  html += `<p class="side-note">● 有我的註記　<span class="amd-dot"></span> 112年修正<br>資料來源：全國法規資料庫（${roc(D.meta.modified, true)} 修正）、立法院法律系統、司法院。</p>`;
  $('#side-toc').innerHTML = html;
}
function isNarrow() { return matchMedia('(max-width: 1100px)').matches; }
function setSide(open) {
  if (!isNarrow()) return;
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}
function scrollToEl(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  requestAnimationFrame(() => el.scrollIntoView({ block: 'start' }));
}
function gotoArticle(aid, { tab, flash = true } = {}) {
  if (!byId.has(aid)) { toast(`找不到${aidLabel(aid)}`); return; }
  if (tab) { openTab.set(aid, tab); refreshPanel(aid); }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  setSide(false);
  try { history.replaceState(null, '', '#a-' + aid); } catch {}
}
const trackTOC = debounce(() => {
  const top = $('#reader').getBoundingClientRect().top + 60;
  let cur = null;
  for (const el of $$('#reader-inner > .art')) { if (el.getBoundingClientRect().top < top) cur = el.dataset.id; else break; }
  $$('.tg.cur').forEach((b) => b.classList.remove('cur'));
  if (cur) $(`.tg[data-goto="${cur}"]`)?.classList.add('cur');
}, 150);

// ---------------------------------------------------------------------------
// 選取文字 → 註記
// ---------------------------------------------------------------------------
let pendingSel = null; // {owner, parts:[{k,s,e}], rect}
let activeAnn = null;  // {owner, id}

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
  const anc = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  if (!anc || !anc.closest('#reader-inner, #modal')) return null;
  // 找出選取範圍內所有可註記文字
  const scope = anc.closest('.atext, .apanel, .gblk, #modal-body') || anc;
  const parts = [];
  let owner = null;
  for (const pt of $$('.pt[data-k], .rt[data-k]', scope.matches('.pt, .rt') ? scope.parentElement : scope)) {
    if (!range.intersectsNode(pt)) continue;
    const blk = pt.closest('.gblk');
    if (!blk) continue;
    const o = blk.dataset.owner;
    if (owner && o !== owner) continue;
    owner = o;
    const len = pt.textContent.length;
    let s = 0, e = len;
    if (pt.contains(range.startContainer)) s = offsetIn(pt, range.startContainer, range.startOffset) ?? 0;
    if (pt.contains(range.endContainer)) e = offsetIn(pt, range.endContainer, range.endOffset) ?? len;
    if (e > s) parts.push({ k: pt.dataset.k, s, e });
  }
  if (!parts.length) return null;
  return { owner, parts, rect: range.getBoundingClientRect() };
}
function placePop(pop, rect) {
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.bottom + 10;
  if (y + ph > innerHeight - 80) y = rect.top - ph - 10;
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, x)) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
}
function showSelPop(rect) {
  const pop = $('#sel-pop');
  $('#ann-pop').hidden = true;
  placePop(pop, rect);
}
function hidePops() { $('#sel-pop').hidden = true; $('#ann-pop').hidden = true; pendingSel = null; activeAnn = null; }

const onSelChange = debounce(() => {
  if (ink.active) return;
  const c = captureSelection();
  if (c) { pendingSel = c; activeAnn = null; showSelPop(c.rect); }
  else if (!activeAnn) $('#sel-pop').hidden = true;
}, 260);

function findAnn(owner, id) { return ((getRec(owner) || {}).an || []).find((x) => x.id === id); }
function afterAnnChange(owner) {
  saveRec(owner);
  refreshOwner(owner);
  if (byId.has(owner)) refreshTabs(owner);
  renderTOC();
}
function createAnn(kind) {
  if (!pendingSel) return;
  const { owner, parts } = pendingSel;
  const r = getRec(owner, true);
  r.an = r.an || [];
  const made = [];
  for (const p of parts) {
    const a = { id: uid(), k: p.k, s: p.s, e: p.e, n: '', pos: kind === 'below' ? 'below' : 'above', c: kind === 'above' || kind === 'below' ? 'r' : kind, t: Date.now() };
    r.an.push(a);
    made.push(a);
  }
  window.getSelection()?.removeAllRanges();
  hidePops();
  if (kind === 'above' || kind === 'below') {
    // 多段選取時，註記放在最後一段
    const target = made[made.length - 1];
    for (const m of made.slice(0, -1)) m.c = 'r';
    editAnn(owner, target.id, true, made.slice(0, -1).map((m) => m.id));
  } else afterAnnChange(owner);
}

function showAnnPop(owner, id, rect) {
  const a = findAnn(owner, id);
  if (!a) return;
  activeAnn = { owner, id };
  pendingSel = null;
  const pop = $('#ann-pop');
  $('#sel-pop').hidden = true;
  $('#ann-note').hidden = !a.n;
  $('#ann-note').textContent = a.n || '';
  $('[data-av="hide"]', pop).hidden = !a.n;
  $('[data-av="hide"]', pop).textContent = a.hide ? '顯示' : '隱藏';
  $('[data-av="pos"]', pop).hidden = !a.n;
  $('[data-av="pos"]', pop).textContent = a.pos === 'below' ? '移到上方' : '移到下方';
  $('[data-av="edit"]', pop).textContent = a.n ? '編輯' : '加註記';
  placePop(pop, rect);
}
function toggleAnnHide(owner, id) {
  const a = findAnn(owner, id);
  if (!a || !a.n) return;
  a.hide = !a.hide;
  saveRec(owner);
  // 不重畫整條：只切換狀態後重新排版該區塊
  for (const blk of $$(`.gblk[data-owner="${CSS.escape(owner)}"]`)) {
    const st = blk.querySelector(`.gs[data-s="${id}"]`);
    if (!st) continue;
    st.classList.toggle('col', !!a.hide);
    layoutBlock(blk, (gid) => isHidden(blk, gid));
    const art = blk.closest('.art');
    if (art) ink.draw(art.dataset.id);
  }
  if (byId.has(owner) && openTab.get(owner) === 'notes') refreshPanel(owner);
}

// ---------------------------------------------------------------------------
// 對話框
// ---------------------------------------------------------------------------
function modal({ title, body, buttons, onOpen, wide }) {
  const dlg = $('#modal');
  dlg.classList.toggle('wide', !!wide);
  $('#modal-title').textContent = title;
  $('#modal-body').innerHTML = body;
  const foot = $('#modal-foot');
  foot.innerHTML = '';
  for (const b of buttons || []) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'btn ' + (b.cls || '');
    el.textContent = b.label;
    el.addEventListener('click', async () => { const keep = b.onClick ? await b.onClick() : false; if (keep !== true) dlg.close(); });
    foot.appendChild(el);
  }
  if (!dlg.open) dlg.showModal();
  onOpen && onOpen($('#modal-body'));
}
function editAnn(owner, id, isNew, siblings = []) {
  const a = findAnn(owner, id);
  if (!a) return;
  const quote = blockText(owner, a.k).slice(a.s, a.e);
  const seg = (name, opts, val) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-${name}="${v}" aria-pressed="${val === v}">${l}</button>`).join('')}</span>`;
  let pos = a.pos || 'above', col = a.c || 'r';
  modal({
    title: `${ownerLabel(owner)}・註記`,
    body: `<p class="quote">「${esc(quote)}」</p>
      <textarea class="note gnote" id="m-gl" placeholder="註記內容（以紅色小字顯示在文字${pos === 'below' ? '下' : '上'}方）">${esc(a.n || '')}</textarea>
      <div class="set-row"><span class="l">位置</span>${seg('pos', [['above', '文字上方'], ['below', '文字下方']], pos)}</div>
      <div class="set-row"><span class="l">標示</span>${seg('col', [['r', '紅線'], ['n', '無'], ['y', '黃'], ['g', '綠'], ['b', '藍'], ['p', '粉']], col)}</div>
      <p class="hint">在 iPad 上可用 Apple Pencil 直接在輸入框中手寫，系統會轉成文字（隨手寫）。</p>`,
    buttons: [
      { label: '刪除', cls: 'danger', onClick: () => { const r = getRec(owner, true); const del = new Set([id, ...(isNew ? siblings : [])]); r.an = (r.an || []).filter((x) => !del.has(x.id)); afterAnnChange(owner); toast('已刪除註記'); } },
      { label: '取消', onClick: () => { if (isNew && !$('#m-gl').value.trim()) { /* 保留為紅線劃記 */ } afterAnnChange(owner); } },
      { label: '儲存', cls: 'primary', onClick: () => { a.n = $('#m-gl').value.trim(); a.pos = pos; a.c = col; a.hide = false; afterAnnChange(owner); toast(a.n ? '已儲存註記' : '已儲存劃記'); } },
    ],
    onOpen: (body) => {
      body.addEventListener('click', (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.pos) { pos = b.dataset.pos; $$('[data-pos]', body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); $('#m-gl').placeholder = `註記內容（以紅色小字顯示在文字${pos === 'below' ? '下' : '上'}方）`; }
        if (b.dataset.col) { col = b.dataset.col; $$('[data-col]', body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false')); }
      });
      setTimeout(() => $('#m-gl').focus(), 50);
    },
  });
}
function editItem(aid, item, kind) {
  const isNew = !item;
  item = item || { id: uid(), kind: kind || '判決', no: '', date: '', text: '', url: '' };
  modal({
    title: isNew ? `${aidLabel(aid)}・新增${item.kind}` : `編輯${item.kind}`,
    body: `<div class="form-grid">
      <div class="field"><label for="m-kind">類型</label><select class="inp" id="m-kind">${USER_KINDS.map((k) => `<option${k === item.kind ? ' selected' : ''}>${k}</option>`).join('')}</select></div>
      <div class="field"><label for="m-date">日期</label><input class="inp" id="m-date" value="${esc(item.date)}" placeholder="例：113.05.20"></div>
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院113年度台上字第○號判決／勞動部○年○月○日勞動關○字第○號函"></div>
      <div class="field full"><label for="m-text">要旨／內容</label><textarea class="note" id="m-text" placeholder="判決要旨或函釋內容">${esc(item.text)}</textarea></div>
      <div class="field full"><label for="m-url">原文連結（選填）</label><input class="inp" id="m-url" type="url" value="${esc(item.url)}" placeholder="https://"></div></div>`,
    buttons: [
      ...(isNew ? [] : [{ label: '刪除', cls: 'danger', onClick: () => { const r = getRec(aid, true); r.items = (r.items || []).filter((x) => x.id !== item.id); saveRec(aid); refreshArticle(aid); toast('已刪除'); } }]),
      { label: '取消' },
      { label: '儲存', cls: 'primary', onClick: () => {
        const no = $('#m-no').value.trim();
        if (!no) { toast('請填寫字號'); return true; }
        Object.assign(item, { kind: $('#m-kind').value, no, date: $('#m-date').value.trim(), text: $('#m-text').value.trim(), url: $('#m-url').value.trim() });
        const r = getRec(aid, true);
        r.items = r.items || [];
        if (isNew) r.items.push(item);
        saveRec(aid);
        openTab.set(aid, item.kind === '函釋' ? 'interp' : 'cases');
        refreshArticle(aid);
        toast('已儲存');
      } },
    ],
    onOpen: () => $('#m-no').focus(),
  });
}
function editOwnerNote(owner) {
  const r = getRec(owner, true);
  modal({
    title: `${ownerLabel(owner)}・筆記`,
    body: `<textarea class="note" id="m-cn" placeholder="這則見解的重點、與條文的關係…">${esc(r.note || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => { r.note = $('#m-cn').value.trim(); saveRec(owner); refreshOwner(owner); } }],
    onOpen: () => $('#m-cn').focus(),
  });
}
function showRefPopup(x) {
  const items = x.split(';').map((s) => { const [law, a] = s.split('|'); return { law, a, sub: '' }; });
  modal({
    title: items.map((r) => (r.law === '勞動事件法' ? '本法' : r.law) + (r.a ? aidLabel(r.a) : '')).join('、'),
    body: `<div class="xr in-modal">${items.map((r) => refItemHTML('', r).replace(' shut', '')).join('')}</div>`,
    buttons: [{ label: '關閉', cls: 'primary' }],
  });
}

// ---------------------------------------------------------------------------
// 搜尋、我的註記
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
  if (!q) { box.innerHTML = '<p class="side-note">搜尋條文、立法理由、判決、司法院問答、審理細則與你的註記；輸入條號（例如 37、第三十七條）可直接跳到該條。</p>'; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  const groups = { 條文: [], 立法理由: [], 判決: [], 司法院問答: [], 審理細則: [], 我的註記: [] };
  for (const a of D.articles) {
    const t = a.p.join('');
    if (has(t)) groups.條文.push([a.id, aidLabel(a.id), t, '']);
    const r = a.v.map((v) => v.r.join('')).join('');
    if (has(r)) groups.立法理由.push([a.id, aidLabel(a.id), r, 'reason']);
  }
  for (const c of C.cases) if (has(c.text + c.note + c.no)) groups.判決.push([c.a[0], c.no.replace('民事', ''), c.text, 'cases']);
  D.qa.forEach((qq) => { if (qq.a.length && has(qq.t + qq.b)) groups.司法院問答.push([qq.a[0], qq.t, qq.b, 'interp']); });
  for (const [aid, list] of Object.entries(D.ruleMap)) for (const [pc, rid] of list) {
    const ra = D.rules[pc].articles.find((x) => x.id === rid);
    if (ra && has(ra.p.join(''))) groups.審理細則.push([aid, D.rules[pc].short + aidLabel(rid) + '（' + aidLabel(aid) + '）', ra.p.join(''), 'rules']);
  }
  notes.forEach((r, owner) => {
    const t = [r.note || '', ...(r.tags || []), ...(r.an || []).map((h) => h.n || ''), ...(r.items || []).map((i) => i.no + i.text)].join(' ');
    if (!has(t)) return;
    const aid = byId.has(owner) ? owner : owner.startsWith('C:') ? (C.cases.find((c) => c.id === owner.slice(2))?.a[0]) : owner.startsWith('Q:') ? D.qa[+owner.slice(2)]?.a[0] : null;
    if (aid) groups.我的註記.push([aid, ownerLabel(owner), t, byId.has(owner) ? 'notes' : owner.startsWith('C:') ? 'cases' : 'interp']);
  });
  let html = '';
  const jump = parseAidInput(q);
  if (jump && byId.has(jump)) html += `<button class="res" data-goto="${jump}"><b>跳到${aidLabel(jump)}</b><span>${esc(byId.get(jump).p.join('').slice(0, 60))}…</span></button>`;
  const seenG = new Set();
  for (const [g, list] of Object.entries(groups)) {
    if (!list.length) continue;
    html += `<div class="res-group">${g} ${list.length}</div>`;
    html += list.slice(0, 80).map(([aid, label, t, tab]) => {
      const k = g + aid + label;
      if (seenG.has(k)) return '';
      seenG.add(k);
      return `<button class="res" data-goto="${aid}" data-tab="${tab}"><b>${esc(label)}</b><span>${snippet(t, terms)}</span></button>`;
    }).join('');
  }
  if (!html) html = '<p class="side-note">沒有符合的結果。</p>';
  box.innerHTML = html;
}
let mineFilter = 'all';
function renderMine() {
  const rows = [];
  for (const [owner, r] of notes) {
    if (!r || isEmptyRec(r)) continue;
    const aid = byId.has(owner) ? owner : owner.startsWith('C:') ? C.cases.find((c) => c.id === owner.slice(2))?.a[0] : owner.startsWith('Q:') ? D.qa[+owner.slice(2)]?.a[0] : owner.startsWith('R:') ? null : null;
    if (!aid) continue;
    const f = { star: !!r.star, note: !!r.note, an: !!(r.an && r.an.length), ink: !!(r.ink && r.ink.strokes && r.ink.strokes.length), item: !!(r.items && r.items.length) };
    rows.push({ owner, aid, r, f });
  }
  rows.sort((x, y) => order.indexOf(x.aid) - order.indexOf(y.aid));
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★'], ['an', '註記'], ['ink', '手寫'], ['note', '筆記'], ['item', '自建']];
  const list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([k, l]) => `<button class="fchip" data-mf="${k}" aria-pressed="${mineFilter === k}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。選取文字即可加紅色小字註記；按右上角筆形按鈕可用 Apple Pencil 手寫。'}</p>`;
  html += list.map(({ owner, aid, r, f }) => {
    const bits = [f.star && '★', f.an && `註記 ${r.an.length}`, f.ink && '手寫', f.note && '筆記', f.item && `自建 ${r.items.length}`].filter(Boolean).join('・');
    const tab = byId.has(owner) ? 'notes' : owner.startsWith('C:') ? 'cases' : 'interp';
    const sample = r.note || (r.an || []).map((h) => h.n).filter(Boolean).join('／') || (r.tags || []).map((t) => '#' + t).join(' ');
    return `<button class="res" data-goto="${aid}" data-tab="${tab}"><b>${esc(ownerLabel(owner))}</b> <small>${bits}</small><span>${esc(sample || '')}</span></button>`;
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
  root.style.setProperty('--gloss-size', { s: '.52em', m: '.6em', l: '.7em' }[settings.gsize] || '.6em');
  document.body.classList.toggle('ann-off', !settings.ann);
  document.body.classList.toggle('refs-tap', settings.refs === 'tap');
  $('#reader-inner')?.classList.toggle('no-pn', !settings.pn);
  $('#btn-ann').setAttribute('aria-pressed', settings.ann ? 'true' : 'false');
  $('#btn-ann').title = settings.ann ? '隱藏我的註記' : '顯示我的註記';
}
function exportData() {
  return JSON.stringify({ app: 'labor-code-notes', version: 1, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) });
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || data.app !== 'labor-code-notes' || !data.notes) throw new Error('不是勞動事件法註記本的備份檔');
  if (replace) { await store.clearAll(); notes.clear(); }
  for (const [owner, rec] of Object.entries(data.notes)) {
    if (!replace && notes.has(owner)) {
      const cur = notes.get(owner);
      const byIdMerge = (a = [], b = []) => { const m = new Map(); [...b, ...a].forEach((x) => m.set(x.id, x)); return [...m.values()]; };
      const merged = { ...rec, ...cur };
      merged.note = [cur.note, rec.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
      merged.tags = Array.from(new Set([...(cur.tags || []), ...(rec.tags || [])]));
      merged.an = byIdMerge(cur.an, rec.an);
      merged.items = byIdMerge(cur.items, rec.items);
      if (rec.ink && cur.ink) merged.ink = { strokes: [...(cur.ink.strokes || []), ...(rec.ink.strokes || [])] };
      merged.star = cur.star || rec.star;
      notes.set(owner, merged);
    } else notes.set(owner, rec);
    await saveRec(owner);
  }
  if (data.settings && replace) { settings = { ...settings, ...data.settings }; await saveSettings(); applySettings(); }
  renderReader();
  renderTOC();
}
function openSettings() {
  const seg = (key, opts) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(settings[key]) === String(v)}">${l}</button>`).join('')}</span>`;
  const n = [...notes.values()].filter((r) => !isEmptyRec(r)).length;
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距</span>${seg('lh', [['1.8', '緊'], ['2.05', '中'], ['2.4', '鬆']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">引用法條</div>
      <div class="set-row"><span class="l">他法條文小字<small>條文中引用民事訴訟法、工會法、勞動基準法等條文時，於該項下方以小字顯示</small></span>${seg('refs', [['show', '顯示'], ['tap', '點選才顯示'], ['off', '不顯示']])}</div>
      <div class="set-row"><span class="l">本法條文小字<small>如「第六條第二項」準用規定</small></span>${seg('self', [['true', '顯示'], ['false', '不顯示']])}</div>
      <div class="set-h">我的註記</div>
      <div class="set-row"><span class="l">顯示我的註記<small>紅色小字註記、螢光筆與手寫；也可按上方眼睛按鈕切換</small></span>${seg('ann', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">註記字級</span>${seg('gsize', [['s', '小'], ['m', '中'], ['l', '大']])}</div>
      <div class="set-row"><span class="l">手指點註記<small>切換：點紅字即隱藏、點被註記文字即顯示（長按紅字開啟選單）</small></span>${seg('tap', [['toggle', '切換顯示'], ['menu', '開啟選單']])}</div>
      <div class="set-row"><span class="l">預設展開</span>${seg('defTab', [['', '不展開'], ['reason', '立法理由'], ['cases', '判決']])}</div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">共有 ${n} 筆註記資料<small>儲存方式：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>選擇檔案或貼上 JSON</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料</div>
      <div class="meta-list">條文：全國法規資料庫，${esc(D.meta.name)}修正日期 ${roc(D.meta.modified)}，資料庫更新 ${esc(D.meta.sourceUpdate)}。<br>
        立法理由、修正理由：立法院法律系統「法條沿革」。<br>
        判決：司法院裁判書查詢系統，最高法院民事裁判 ${C.cases.length} 則（原文逐字摘錄）。<br>
        函釋・見解：司法院民事廳「勞動事件常見問答」${D.qa.length} 則；勞動部函釋請自行新增。<br>
        子法：${Object.values(D.rules).map((r) => r.name).join('、')}。<br>
        資料建置日：${esc(D.meta.built)}。本工具供學習參考，正式引用請以官方公布之法規與裁判全文為準。</div>
      <div class="set-h">危險區域</div>
      <div class="row-actions"><input class="inp" id="wipe-confirm" placeholder="輸入「清除」以刪除全部註記" style="max-width:260px"><button type="button" class="btn small danger" data-act="wipe">刪除全部註記</button></div>`,
    buttons: [{ label: '完成', cls: 'primary' }],
    onOpen: (body) => {
      body.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.set) {
          const k = b.dataset.set, v = b.dataset.val;
          settings[k] = ['theme', 'refs', 'gsize', 'tap', 'defTab'].includes(k) ? v : k === 'lh' ? +v : v === 'true';
          $$(`[data-set="${k}"]`, body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          saveSettings(); applySettings();
          if (['refs', 'self', 'pn'].includes(k)) renderReader();
          else requestAnimationFrame(relayout);
        } else if (b.dataset.size) {
          settings.size = Math.max(14, Math.min(28, settings.size + +b.dataset.size));
          $('#size-val').textContent = settings.size + 'px';
          saveSettings(); applySettings(); requestAnimationFrame(relayout);
        } else if (b.dataset.act === 'export') {
          const blob = new Blob([exportData()], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `勞動事件法註記備份-${new Date().toISOString().slice(0, 10)}.json`;
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
          renderReader(); renderTOC(); toast('已刪除全部註記'); $('#modal').close();
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
  getRec, saveRec,
  onChange: (aid) => { refreshTabs(aid); renderTOC(); if (openTab.get(aid) === 'notes') refreshPanel(aid); },
  onTap: (el) => handleTap(el, null),
});
const PRESETS = [0.1, 0.2, 0.3, 0.5, 0.8, 1.2, 2, 3];
function syncInkbar() {
  const bar = $('#inkbar');
  const p = settings.pen;
  ink.color = p.color; ink.width = p.width; ink.mwidth = p.mwidth; ink.pressure = p.pressure;
  $$('[data-color]', bar).forEach((x) => x.setAttribute('aria-pressed', ink.tool === 'pen' && x.dataset.color === p.color ? 'true' : 'false'));
  $('[data-tool="eraser"]', bar).setAttribute('aria-pressed', ink.tool === 'eraser' ? 'true' : 'false');
  const marker = isMarker(p.color);
  const w = marker ? p.mwidth : p.width;
  const sl = $('#pen-w');
  sl.min = marker ? 4 : 0.1; sl.max = marker ? 30 : 6; sl.step = marker ? 1 : 0.05;
  sl.value = w;
  $('#pen-wv').textContent = marker ? `${w}` : (w < 1 ? w.toFixed(2).replace(/0$/, '') : w.toFixed(1));
  $('#pen-presets').hidden = marker;
  $$('#pen-presets button').forEach((b) => b.setAttribute('aria-pressed', Math.abs(+b.dataset.w - w) < 0.001 ? 'true' : 'false'));
  $('[data-act="pressure"]', bar).setAttribute('aria-pressed', p.pressure ? 'true' : 'false');
  $('[data-act="pressure"]', bar).hidden = marker;
  drawPreview();
}
function drawPreview() {
  const cv = $('#pen-prev');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth || 120, h = cv.clientHeight || 28;
  cv.width = w * dpr; cv.height = h * dpr;
  const ctx = cv.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const em = 18;
  const pts = [];
  for (let i = 0; i <= 24; i++) { const x = 6 + (i / 24) * (w - 12); pts.push(x / em, (h / 2 + Math.sin(i / 3.2) * (h * 0.28)) / em, 0.35 + 0.5 * Math.sin((i / 24) * Math.PI)); }
  const marker = isMarker(settings.pen.color);
  ink.paint(ctx, { c: settings.pen.color, w: (marker ? settings.pen.mwidth : settings.pen.width) / em, pr: marker ? 0 : (settings.pen.pressure ? 1 : 0), pts }, em, ink.colors(), 0, 0);
}
function setInk(on) {
  ink.setActive(on);
  $('#btn-ink').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#inkbar').hidden = !on;
  if (on) {
    if (!settings.ann) { settings.ann = true; saveSettings(); applySettings(); relayout(); }
    hidePops(); window.getSelection()?.removeAllRanges(); syncInkbar();
    toast('手寫模式：Apple Pencil 書寫，手指捲動／點註記');
  }
}
function bindInkbar() {
  const bar = $('#inkbar');
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    const p = settings.pen;
    if (b.dataset.color) { ink.tool = 'pen'; p.color = b.dataset.color; }
    else if (b.dataset.tool === 'eraser') ink.tool = ink.tool === 'eraser' ? 'pen' : 'eraser';
    else if (b.dataset.w) { p.width = +b.dataset.w; ink.tool = 'pen'; }
    else if (b.dataset.act === 'thinner' || b.dataset.act === 'thicker') {
      const marker = isMarker(p.color);
      const d = b.dataset.act === 'thicker' ? 1 : -1;
      if (marker) p.mwidth = Math.max(4, Math.min(30, p.mwidth + d * 2));
      else p.width = Math.max(0.1, Math.min(6, Math.round((p.width + d * (p.width < 1 ? 0.05 : 0.2)) * 100) / 100));
    } else if (b.dataset.act === 'pressure') p.pressure = !p.pressure;
    else if (b.dataset.act === 'undo') { if (!ink.undoLast()) toast('沒有可復原的筆畫'); return; }
    else if (b.dataset.act === 'redo') { if (!ink.redoLast()) toast('沒有可重做的筆畫'); return; }
    else if (b.dataset.act === 'finger') {
      ink.finger = !ink.finger;
      b.setAttribute('aria-pressed', ink.finger ? 'true' : 'false');
      document.body.classList.toggle('finger', ink.finger);
      toast(ink.finger ? '手指也可書寫（捲動請用兩指）' : '只有 Apple Pencil 可書寫');
      return;
    } else if (b.dataset.act === 'done') { setInk(false); return; }
    saveSettings(); syncInkbar();
  });
  $('#pen-w').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (isMarker(settings.pen.color)) settings.pen.mwidth = v; else settings.pen.width = Math.round(v * 100) / 100;
    ink.tool = 'pen';
    syncInkbar();
  });
  $('#pen-w').addEventListener('change', saveSettings);
  $('#pen-presets').innerHTML = PRESETS.map((w) => `<button type="button" data-w="${w}">${w}</button>`).join('');
}

// ---------------------------------------------------------------------------
// 點選處理
// ---------------------------------------------------------------------------
let longPressed = false;
function handleTap(target, e) {
  if (longPressed) { longPressed = false; return true; }
  const go = target.closest('[data-goto]');
  if (go && !target.closest('.gl')) { e && e.preventDefault(); gotoArticle(go.dataset.goto, { tab: go.dataset.tab }); return true; }
  const gl = target.closest('.gl');
  if (gl && settings.ann) {
    const blk = gl.closest('.gblk');
    if (settings.tap === 'menu') showAnnPop(blk.dataset.owner, gl.dataset.g, gl.getBoundingClientRect());
    else toggleAnnHide(blk.dataset.owner, gl.dataset.g);
    return true;
  }
  const ga = target.closest('.ga');
  const sel = window.getSelection();
  if (ga && settings.ann && (!sel || sel.isCollapsed) && !ga.closest('.art.off')) {
    const blk = ga.closest('.gblk');
    // 被巢狀註記時，取最內層
    const id = ga.dataset.g;
    const a = findAnn(blk.dataset.owner, id);
    if (a && a.n && settings.tap === 'toggle') toggleAnnHide(blk.dataset.owner, id);
    else showAnnPop(blk.dataset.owner, id, ga.getBoundingClientRect());
    return true;
  }
  const xr = target.closest('a.xref');
  if (xr) {
    e && e.preventDefault();
    const blk = xr.closest('.pblk');
    const art = xr.closest('.art');
    if (blk && art && settings.refs !== 'off') {
      // 切換該項下方的引用小字
      const box = blk.nextElementSibling && blk.nextElementSibling.classList.contains('xr') ? blk.nextElementSibling : null;
      const keys = xr.dataset.x.split(';');
      const els = box ? keys.map((x) => box.querySelector(`.xri[data-x="${CSS.escape(x)}"]`)).filter(Boolean) : [];
      if (els.length) {
        const open = els.some((el) => el.classList.contains('shut'));
        for (const el of els) { el.classList.toggle('shut', !open); xrOpen.set(el.dataset.key, open); }
        layoutArticle(art);
        return true;
      }
    }
    showRefPopup(xr.dataset.x);
    return true;
  }
  const xf = target.closest('[data-xfull]');
  if (xf) { const it = xf.closest('.xri'); it.classList.toggle('full'); xf.textContent = it.classList.contains('full') ? '收合' : '全條'; const art = it.closest('.art'); if (art) layoutArticle(art); return true; }
  const xri = target.closest('.xri');
  if (xri && xri.classList.contains('shut')) { xri.classList.remove('shut'); xrOpen.set(xri.dataset.key, true); const art = xri.closest('.art'); if (art) layoutArticle(art); return true; }
  return false;
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------
function bind() {
  $('#btn-nav').onclick = () => setSide(!$('#sidebar').classList.contains('open'));
  $('#scrim').onclick = () => setSide(false);
  $('#btn-settings').onclick = openSettings;
  $('#btn-ink').onclick = () => setInk(!ink.active);
  $('#btn-ann').onclick = () => {
    settings.ann = !settings.ann;
    saveSettings(); applySettings(); relayout();
    toast(settings.ann ? '顯示我的註記' : '已隱藏我的註記');
  };
  $$('.seg button').forEach((b) => { b.onclick = () => showSide(b.dataset.side); });

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

  $('#sidebar').addEventListener('click', (e) => {
    const mf = e.target.closest('[data-mf]');
    if (mf) { mineFilter = mf.dataset.mf; renderMine(); return; }
    const h = e.target.closest('[data-h]');
    if (h) { scrollToEl(document.getElementById('h-' + h.dataset.h)); setSide(false); return; }
    const b = e.target.closest('[data-goto]');
    if (b) gotoArticle(b.dataset.goto, { tab: b.dataset.tab || undefined });
  });

  const reader = $('#reader');
  reader.addEventListener('scroll', () => { trackTOC(); if (!$('#sel-pop').hidden && !pendingSel) hidePops(); if (!$('#ann-pop').hidden) $('#ann-pop').hidden = true; }, { passive: true });

  // 長按紅字註記 → 選單
  let lpTimer = null, lpStart = null;
  const lpTargets = '#reader, #modal';
  document.addEventListener('pointerdown', (e) => {
    const gl = e.target.closest('.gl');
    if (!gl || !e.target.closest(lpTargets)) return;
    lpStart = { x: e.clientX, y: e.clientY };
    clearTimeout(lpTimer);
    lpTimer = setTimeout(() => {
      longPressed = true;
      const blk = gl.closest('.gblk');
      showAnnPop(blk.dataset.owner, gl.dataset.g, gl.getBoundingClientRect());
    }, 480);
  });
  document.addEventListener('pointermove', (e) => { if (lpStart && (Math.abs(e.clientX - lpStart.x) > 8 || Math.abs(e.clientY - lpStart.y) > 8)) { clearTimeout(lpTimer); lpStart = null; } });
  document.addEventListener('pointerup', () => { clearTimeout(lpTimer); lpStart = null; setTimeout(() => { longPressed = false; }, 400); });
  document.addEventListener('contextmenu', (e) => { if (e.target.closest('.gl')) e.preventDefault(); });

  reader.addEventListener('click', (e) => {
    if (ink.active && e.target.closest('.ink-layer')) return;
    if (handleTap(e.target, e)) return;
    const art = e.target.closest('.art');
    if (!art) return;
    const aid = art.dataset.id;
    const t = e.target.closest('[data-tab]');
    if (t && t.closest('.atabs')) {
      const cur = openTab.get(aid);
      openTab.set(aid, cur === t.dataset.tab ? '' : t.dataset.tab);
      refreshPanel(aid);
      return;
    }
    const tt = e.target.closest('[data-tab-toggle]');
    if (tt) { const cur = openTab.get(aid); openTab.set(aid, cur ? '' : 'reason'); refreshPanel(aid); return; }
    const eye = e.target.closest('[data-art-eye]');
    if (eye) { toggleArtOff(aid); return; }
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.cm) { cmpMode = b.dataset.cm; refreshPanel(aid); return; }
    const act = b.dataset.act;
    if (act === 'add-item') editItem(aid, null, b.dataset.kind);
    else if (act === 'edit-item') editItem(aid, (getRec(aid)?.items || []).find((x) => x.id === b.dataset.id));
    else if (act === 'imp') { const r = getRec(b.dataset.owner, true); r.star = !r.star; saveRec(b.dataset.owner); refreshPanel(aid); }
    else if (act === 'cnote') editOwnerNote(b.dataset.owner);
    else if (act === 'rm-tag') { const r = getRec(aid, true); r.tags = (r.tags || []).filter((x) => x !== b.dataset.tag); saveRec(aid); refreshPanel(aid); }
    else if (act === 'ann-edit') editAnn(b.dataset.owner, b.dataset.id);
    else if (act === 'ann-hide') toggleAnnHide(b.dataset.owner, b.dataset.id);
    else if (act === 'ann-del') { const r = getRec(b.dataset.owner, true); r.an = (r.an || []).filter((x) => x.id !== b.dataset.id); afterAnnChange(b.dataset.owner); }
    else if (act === 'ink-on') { setInk(true); gotoArticle(aid, { flash: false }); }
    else if (act === 'ink-clear') { ink.clear(aid); toast('已清除，可按「復原」還原'); }
    else if (act === 'art-off') toggleArtOff(aid);
  });
  reader.addEventListener('input', (e) => {
    const ta = e.target.closest('[data-note]');
    if (!ta) return;
    const aid = ta.dataset.note;
    const saved = $(`[data-saved="${aid}"]`);
    if (saved) saved.textContent = '儲存中…';
    clearTimeout(ta._t);
    ta._t = setTimeout(() => {
      const r = getRec(aid, true);
      r.note = ta.value;
      saveRec(aid).then(() => { if (saved) saved.textContent = '已儲存'; });
      refreshTabs(aid); renderTOC();
    }, 500);
  });
  reader.addEventListener('keydown', (e) => {
    const ti = e.target.closest('[data-tags]');
    if (!ti || e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const v = ti.value.trim().replace(/^#/, '');
    if (!v) return;
    const aid = ti.dataset.tags;
    const r = getRec(aid, true);
    r.tags = Array.from(new Set([...(r.tags || []), ...v.split(/[,，、\s]+/).filter(Boolean)]));
    saveRec(aid); refreshPanel(aid);
    document.querySelector(`[data-tags="${aid}"]`)?.focus();
  });
  $('#modal-body').addEventListener('click', (e) => { handleTap(e.target, e); });

  document.addEventListener('selectionchange', onSelChange);
  for (const id of ['#sel-pop', '#ann-pop']) $(id).addEventListener('pointerdown', (e) => e.preventDefault());
  $('#sel-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-mk]');
    if (b) createAnn(b.dataset.mk);
  });
  $('#ann-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-av]');
    if (!b || !activeAnn) return;
    const { owner, id } = activeAnn;
    const a = findAnn(owner, id);
    hidePops();
    if (!a) return;
    if (b.dataset.av === 'edit') editAnn(owner, id);
    else if (b.dataset.av === 'hide') toggleAnnHide(owner, id);
    else if (b.dataset.av === 'pos') { a.pos = a.pos === 'below' ? 'above' : 'below'; afterAnnChange(owner); }
    else if (b.dataset.av === 'del') { const r = getRec(owner, true); r.an = (r.an || []).filter((x) => x.id !== id); afterAnnChange(owner); toast('已刪除註記'); }
    else if (HL_COLORS[b.dataset.av]) { a.c = b.dataset.av; afterAnnChange(owner); }
  });
  document.addEventListener('pointerdown', (e) => {
    if (e.target.closest('#sel-pop, #ann-pop, .gl, .ga')) return;
    if (!$('#ann-pop').hidden) $('#ann-pop').hidden = true;
    if (!$('#sel-pop').hidden) setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) { $('#sel-pop').hidden = true; pendingSel = null; } }, 10);
  });

  window.addEventListener('hashchange', () => {
    const m = location.hash.match(/^#a-(\d+)$/);
    if (m) gotoArticle(m[1]);
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { if (!$('#sel-pop').hidden || !$('#ann-pop').hidden) hidePops(); else if (ink.active) setInk(false); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && ink.active) { e.preventDefault(); e.shiftKey ? ink.redoLast() : ink.undoLast(); }
  });
  // 版面寬度改變時重新排版行間註記
  let lastW = 0;
  new ResizeObserver((ents) => {
    const w = Math.round(ents[0].contentRect.width);
    if (w !== lastW) { lastW = w; relayoutSoon(); }
  }).observe($('#reader-inner'));
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => ink.redrawAll());
}
function toggleArtOff(aid) {
  const r = getRec(aid, true);
  r.off = !r.off;
  saveRec(aid);
  const el = document.getElementById('a-' + aid);
  el.classList.toggle('off', r.off);
  refreshTabs(aid);
  layoutArticle(el);
  if (openTab.get(aid) === 'notes') refreshPanel(aid);
  toast(r.off ? `已隱藏${aidLabel(aid)}的註記` : `顯示${aidLabel(aid)}的註記`);
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const [law, cases, saved] = await Promise.all([
      fetch('data/labor.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch('data/cases.json').then((r) => (r.ok ? r.json() : { cases: [] })).catch(() => ({ cases: [] })),
      store.getAll().catch(() => ({})),
    ]);
    D = law; C = cases;
    for (const a of D.articles) { byId.set(a.id, a); order.push(a.id); }
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('a:')) notes.set(k.slice(2), v);
      else if (k === 'settings') settings = { ...settings, ...v, pen: { ...settings.pen, ...(v.pen || {}) } };
    }
  } catch (e) {
    $('#loading').textContent = '無法載入條文資料：' + e.message;
    return;
  }
  if (settings.defTab) for (const a of D.articles) openTab.set(a.id, settings.defTab);
  applySettings();
  renderTOC();
  renderReader();
  bind();
  bindInkbar();
  doSearch('');
  document.fonts && document.fonts.ready.then(() => relayout());
  const m = location.hash.match(/^#a-(\d+)$/);
  if (m && byId.has(m[1])) setTimeout(() => gotoArticle(m[1]), 60);
  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
  window.__labor = { relayout, settings, notes, ink }; // 偵錯用
}
boot();
