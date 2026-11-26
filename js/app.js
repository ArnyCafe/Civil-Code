import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, WIDTHS } from './ink.js';

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

let D = null;              // 民法資料
let R = null;              // 判解資料（延遲載入）
const byId = new Map();    // aid -> article
const order = [];          // aid 順序
const notes = new Map();   // aid -> 使用者紀錄
let settings = { theme: 'system', size: 18, lh: 1.9, pn: true, chips: true, side: 'margin' };
let current = null;        // 目前開啟的條文
let detailTab = 'rulings';
let rulFilter = 'all';
let cmpMode = 'table';
let cmpSel = null;         // {aid, a, b}

const TYPE_LABEL = { CJ: '憲法法庭', C: '大法官解釋', J: '判例', U: '我的' };
const USER_KINDS = ['判決', '函釋', '決議', '其他'];
const KIND_LABEL = { orig: '制定', new: '增訂', amend: '修正', del: '刪除' };

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
  q = q.trim().replace(/\s+/g, '');
  let m = q.match(/^(?:民法)?第?(\d+)(?:條)?(?:[-之](\d+))?(?:條)?$/);
  if (m) return m[2] ? `${m[1]}-${m[2]}` : m[1];
  m = q.match(/^(?:民法)?第?([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?$/);
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
    !(r.imp && Object.keys(r.imp).length) && !(r.rnote && Object.keys(r.rnote).length));
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

// 條文內引用條號 → 連結
const XREF_CN = /第([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?/g;
const XREF_AR = /第\s*(\d+)\s*條(?:之\s*(\d+))?/g;
function xrefRanges(text, mode) {
  const out = [];
  const test = (re, conv) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      const before = text.slice(Math.max(0, m.index - 12), m.index);
      if (mode === 'law') {
        // 其他法律（如「家事事件法第…條」）不連結；「本法」可連結
        if (/[法則例程]$/.test(before) && !/本法$|民法$/.test(before)) continue;
        if (/[^民本]法第?[一二三四五六七八九十百千\d]*條之?$/.test(before)) continue;
      } else if (!/民法$/.test(before)) continue;
      const aid = m[2] ? `${conv(m[1])}-${conv(m[2])}` : String(conv(m[1]));
      if (byId.has(aid)) out.push({ s: m.index, e: m.index + m[0].length, aid });
    }
  };
  test(XREF_CN, cnNum);
  if (mode !== 'law') test(XREF_AR, Number);
  return out.sort((a, b) => a.s - b.s);
}

function renderRich(text, hls, mode, nums) {
  const xr = xrefRanges(text, mode);
  const cuts = new Set([0, text.length]);
  for (const h of hls) { cuts.add(Math.max(0, Math.min(text.length, h.s))); cuts.add(Math.max(0, Math.min(text.length, h.e))); }
  for (const x of xr) { cuts.add(x.s); cuts.add(x.e); }
  const pts = [...cuts].sort((a, b) => a - b);
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    let piece = esc(text.slice(s, e));
    const x = xr.find((r) => r.s <= s && r.e >= e);
    if (x) piece = `<a class="xref" href="#a-${x.aid}" data-goto="${x.aid}">${piece}</a>`;
    let h = null;
    for (const c of hls) if (c.s <= s && c.e >= e) h = c; // 後加者優先
    if (h) {
      const last = !hls.some((c) => c.id === h.id && c.e > e);
      const num = h.n && last ? (nums && nums.get(h.id)) || '註' : '';
      piece = `<mark class="hl hl-${h.c}" data-hl="${h.id}"${num ? ` data-n="${num}"` : ''}>${piece}</mark>`;
    }
    html += piece;
  }
  return html;
}

// 劃線註記依位置編號 ①②③
function noteNumbers(rec) {
  const m = new Map();
  ((rec && rec.hl) || []).filter((h) => h.n).sort((x, y) => x.p - y.p || x.s - y.s)
    .forEach((h, i) => m.set(h.id, i + 1));
  return m;
}
const CIRCLED = '①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮⑯⑰⑱⑲⑳';
const circ = (n) => CIRCLED[n - 1] || `(${n})`;

function renderParas(a, rec, mode = 'law', side = false) {
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  const nums = noteNumbers(rec);
  let xi = 0;
  return a.p.map((t, i) => {
    const sp = splitPara(t);
    const hls = ((rec && rec.hl) || []).filter((h) => h.p === i);
    const body = renderRich(sp.body, hls, mode, nums);
    let para;
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      para = `<p class="para"><span class="pn">${pn}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    } else {
      para = `<p class="para ${sp.kind === 'kuan' ? 'kuan' : 'kuan sub'}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    }
    if (!side) return para;
    // 旁註欄：本條筆記放在第一段旁，劃線註記放在所屬段落旁
    let aside = '';
    if (i === 0 && rec && rec.note) aside += `<button class="sn note-side" data-open="${a.id}" data-tab="notes"><b>本條筆記</b>${esc(rec.note)}</button>`;
    for (const h of hls.filter((x) => x.n).sort((x, y) => x.s - y.s)) {
      aside += `<button class="sn" data-sn="${h.id}"><b>${circ(nums.get(h.id))}</b>${esc(h.n)}</button>`;
    }
    return `<div class="prow">${para}<aside class="pside">${aside}</aside></div>`;
  }).join('');
}

function rulingCount(aid) {
  const n = (R && R[aid] ? R[aid].length : 0);
  const rec = notes.get(aid);
  return n + (rec && rec.items ? rec.items.length : 0);
}
function amendCount(aid) {
  const c = D.changes[aid];
  return c ? c.length - 1 : 0;
}
function pendingNote(aid) {
  const p = D.meta.pending && D.meta.pending[aid];
  if (!p) return '';
  return `${roc(p)}修正公布，尚未施行（自公布六個月後施行）；施行前仍適用修正前條文，可於「新舊對照」查看。`;
}

function chipsHTML(aid) {
  const rec = notes.get(aid);
  const out = [];
  if (rec && rec.star) out.push('<span class="chip c-star" title="書籤">★</span>');
  if (D.meta.pending && D.meta.pending[aid]) out.push('<span class="chip c-pend">尚未施行</span>');
  if (settings.chips) {
    const rc = rulingCount(aid);
    if (rc) out.push(`<button class="chip c-rul" data-open="${aid}" data-tab="rulings">判解 ${rc}</button>`);
    const ac = amendCount(aid);
    if (ac) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">修正 ${ac}</button>`);
  }
  if (rec && (rec.note || (rec.hl && rec.hl.length) || (rec.ink && rec.ink.strokes && rec.ink.strokes.length))) {
    out.push(`<button class="chip c-note" data-open="${aid}" data-tab="notes">註記</button>`);
  }
  return out.join('');
}

function articleInner(a) {
  const rec = notes.get(a.id);
  let html = `<div class="art-head"><button class="ano" data-open="${a.id}">${aidLabel(a.id)}</button><span class="chips">${chipsHTML(a.id)}</span></div>`;
  html += `<div class="atext">${renderParas(a, rec, 'law', true)}</div>`;
  const pn = pendingNote(a.id);
  if (pn) html += `<div class="pend-note">${esc(pn)}</div>`;
  if (rec && rec.note) html += `<div class="note-peek">${esc(rec.note)}</div>`;
  return html;
}

function renderReader() {
  const parts = [];
  const hlevelClass = ['h-part', 'h-chap', 'h-sec', 'h-sub', 'h-sub'];
  const firstOf = new Map(); // aid -> [heading idx]
  D.headings.forEach((h, i) => {
    if (h.first) { if (!firstOf.has(h.first)) firstOf.set(h.first, []); firstOf.get(h.first).push(i); }
  });
  for (const a of D.articles) {
    for (const hi of firstOf.get(a.id) || []) {
      const h = D.headings[hi];
      const tag = h.lv === 0 ? 'h2' : h.lv === 1 ? 'h3' : 'h4';
      parts.push(`<${tag} class="${hlevelClass[h.lv]}" id="h-${hi}">${esc(h.t)}</${tag}>`);
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
  // 子樹內最後一條：下一個同層或更高層標題之前的最後一條
  const h = D.headings[hi];
  let next = null;
  for (let j = hi + 1; j < D.headings.length; j++) if (D.headings[j].lv <= h.lv) { next = D.headings[j]; break; }
  if (!next) return order[order.length - 1];
  const idx = order.indexOf(next.first);
  return order[idx - 1];
}
function renderTOC() {
  const kids = new Map();
  D.headings.forEach((h, i) => { if (!kids.has(h.p)) kids.set(h.p, []); kids.get(h.p).push(i); });
  const build = (pi) => (kids.get(pi) || []).map((i) => {
    const h = D.headings[i];
    const sub = kids.get(i);
    const rng = h.first ? `${h.first}–${lastArticleOf(i)}` : '';
    return `<div class="toc-part"><button class="toc-btn lv${h.lv}" data-h="${i}">${sub ? `<span class="caret" data-toggle="${i}">›</span>` : '<span class="caret"></span>'}<span>${esc(h.t)}</span><span class="rng">${rng}</span></button>${sub ? `<div class="toc-kids" id="tk-${i}" hidden>${build(i)}</div>` : ''}</div>`;
  }).join('');
  $('#side-toc').innerHTML = build(-1) + `<p class="side-note">資料來源：全國法規資料庫，修正日期 ${roc(D.meta.modified)}。</p>`;
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
function setSide(open) {
  if (!isNarrow()) return;
  $('#sidebar').classList.toggle('open', open);
  $('#scrim').hidden = !open;
}
function scrollToEl(el) {
  if (!el) return;
  el.scrollIntoView({ block: 'start' });
  // content-visibility 讓遠處元素高度為估計值，渲染後再校正一次
  requestAnimationFrame(() => requestAnimationFrame(() => el.scrollIntoView({ block: 'start' })));
  setTimeout(() => el.scrollIntoView({ block: 'start' }), 180);
}
function gotoArticle(aid, { open = true, flash = true } = {}) {
  if (!byId.has(aid)) { toast(`找不到${aidLabel(aid)}`); return; }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  const a = byId.get(aid);
  tocExpandTo(a.h);
  setSide(false);
  if (open) openDetail(aid);
}
function gotoHeading(hi) {
  scrollToEl(document.getElementById('h-' + hi));
  setSide(false);
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
  const rec = notes.get(current);
  const el = $('#d-text');
  el.dataset.id = current;
  el.innerHTML = `<div class="atext${settings.pn ? '' : ' no-pn'}">${renderParas(a, rec)}</div>` +
    (pendingNote(current) ? `<div class="pend-note">${esc(pendingNote(current))}</div>` : '');
}
function renderDetail() {
  if (!current) return;
  const a = byId.get(current);
  const rec = notes.get(current);
  $('#d-no').textContent = aidLabel(current);
  $('#d-path').textContent = headingPath(a.h).join(' › ');
  $('#d-star').setAttribute('aria-pressed', rec && rec.star ? 'true' : 'false');
  renderDetailText();
  const rc = rulingCount(current), ac = amendCount(current);
  $('#t-rulings').textContent = rc || '';
  $('#t-history').textContent = ac || '';
  const nc = rec ? ((rec.note ? 1 : 0) + (rec.hl ? rec.hl.length : 0) + (rec.ink && rec.ink.strokes && rec.ink.strokes.length ? 1 : 0)) : 0;
  $('#t-notes').textContent = nc || '';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === detailTab ? 'true' : 'false'));
  const body = $('#d-body');
  if (detailTab === 'rulings') renderRulings(body);
  else if (detailTab === 'history') renderHistory(body);
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
  let list = all.filter((r) => rulFilter === 'all' || (rulFilter === 'imp' ? r.imp : r.ty === rulFilter));
  const tyOrder = { U: 0, CJ: 1, C: 2, J: 3 };
  list.sort((a, b) => (b.imp - a.imp) || ((a.no || '').startsWith('廢') - (b.no || '').startsWith('廢')) || (tyOrder[a.ty] - tyOrder[b.ty]) || ((a.idx ?? 0) - (b.idx ?? 0)));
  const rec = notes.get(current) || {};
  let html = `<div class="filters">${filters.map(([k, l, n]) => `<button class="fchip" data-rf="${k}" aria-pressed="${rulFilter === k}">${l}<i>${n}</i></button>`).join('')}</div>`;
  html += `<div class="row-actions" style="margin-bottom:12px"><button class="btn small primary" data-act="add-item">＋ 新增判決／函釋</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/default.aspx" target="_blank" rel="noopener">司法院裁判書查詢</a>
    <a class="btn small" href="https://mojlaw.moj.gov.tw/" target="_blank" rel="noopener">法務部函釋查詢</a></div>`;
  if (!R && !(rec.items && rec.items.length)) html += `<p class="empty">判解資料載入中，或尚未建立（執行 tools/fetch_rulings.py）。</p>`;
  else if (!list.length) html += `<p class="empty">${rulFilter === 'U' ? '尚無自建資料。可新增實務判決、法務部函釋、民事庭會議決議等，並寫下要旨與個人筆記。' : rulFilter === 'imp' ? '尚未標記重要判解。點判解卡右上角的星號即可標記。' : '本條在全國法規資料庫中沒有相關的解釋或判例。可自行新增實務判決或函釋。'}</p>`;
  if (all.some((r) => r.ty === 'J')) html += `<p class="callout">判例制度已於民國108年7月4日廢止。依法院組織法第57條之1，未經停止適用之判例，其效力與未經選編為判例之最高法院裁判相同。字號前標「廢」者為已不再援用。</p>`;
  for (const r of list) html += rulingCard(r, rec);
  body.innerHTML = html;
}
function rulingCard(r, rec) {
  const isVoid = (r.no || '').startsWith('廢');
  const typeLabel = r.ty === 'U' ? (r.kind || '其他') : TYPE_LABEL[r.ty];
  const parts = r.user
    ? (r.text ? [['要旨', r.text]] : [])
    : (r.parts || []);
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
      ${r.user ? '<button class="linkish" data-act="edit-item">編輯</button>' : `<button class="linkish" data-act="rnote">${rnote ? '編輯筆記' : '加筆記'}</button>`}
    </div></article>`;
}

// ----- 新舊對照 -----
function versionsOf(aid) {
  return (D.changes[aid] || []).map((h, i) => ({ ...h, i }));
}
function histItemFor(d) {
  return D.histories.find((h) => h.dates.includes(d));
}
function renderHistory(body) {
  const a = byId.get(current);
  const vs = versionsOf(current);
  if (vs.length < 2) {
    body.innerHTML = `<p class="empty">${aidLabel(current)}自${a.since ? roc(a.since) : '制定'}${a.since && a.since <= '19310505' ? '制定' : '增訂'}以來，未曾修正。</p>
      <p class="callout">新舊對照以全國法規資料庫的歷次版本逐條比對產生；僅標點或個別字的資料庫勘誤不列為修正。</p>`;
    return;
  }
  const pend = D.meta.pending || {};
  if (!cmpSel || cmpSel.aid !== current) cmpSel = { aid: current, a: vs.length - 2, b: vs.length - 1 };
  const opt = (sel) => vs.map((v) => `<option value="${v.i}"${v.i === sel ? ' selected' : ''}>${roc(v.d, true)} ${KIND_LABEL[v.k]}${pend[current] === v.d ? '（未施行）' : ''}</option>`).join('');
  let html = '<ol class="timeline">';
  for (const v of [...vs].reverse()) {
    const it = histItemFor(v.d);
    html += `<li class="tl k-${v.k}${pend[current] === v.d ? ' pend' : ''}"><span class="dot"></span><div><b>${roc(v.d)}</b><small>${KIND_LABEL[v.k]}${pend[current] === v.d ? '・尚未施行' : ''}${it ? `・沿革第 ${it.n} 點` : ''}</small></div>
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
      <tbody><tr><td>${dd.new}</td><td>${dd.old}</td></tr></tbody></table></div>`;
  } else {
    html += `<div class="inline-diff">${dd.inline}</div>`;
  }
  html += `<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>`;
  const it = histItemFor(B.d);
  if (it) html += `<div class="hist-item"><b>沿革第 ${it.n} 點</b><br>${esc(it.t)}</div>`;
  html += `<p class="callout" style="margin-top:12px">修正理由請見<a href="https://lis.ly.gov.tw/lglawc/lglawkm" target="_blank" rel="noopener">立法院法律系統</a>或<a href="https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=B0000001" target="_blank" rel="noopener">全國法規資料庫沿革</a>。</p>`;
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
  const strokes = rec.ink && rec.ink.strokes ? rec.ink.strokes.length : 0;
  const a = byId.get(current);
  const qText = (h) => { const sp = splitPara(a.p[h.p] || ''); return sp.body.slice(h.s, h.e); };
  let html = `<div class="field"><label for="note-text">文字筆記</label>
    <textarea class="note" id="note-text" placeholder="寫下要件、學說爭議、考點、案例…">${esc(rec.note || '')}</textarea>
    <span class="saved" id="note-saved">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div>`;
  html += `<div class="field"><label for="tag-input">標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" id="tag-input" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點、實務見解" enterkeyhint="done">
    <datalist id="tag-list">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>`;
  html += `<div class="field"><span class="lbl">劃線（${hls.length}）</span>`;
  html += hls.length ? `<ul class="hl-list">${hls.map((h) => `<li><div><span class="q"><mark class="hl hl-${h.c}">${esc(qText(h))}</mark></span>${h.n ? `<span class="n">${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions"><button class="linkish" data-act="hl-note" data-id="${h.id}">${h.n ? '改註' : '加註'}</button><button class="linkish" data-act="hl-del" data-id="${h.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">在條文上選取文字，即可用螢光筆劃線或加註。</p>';
  html += '</div>';
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
let pendingSel = null; // {aid, parts:[{p,s,e}]}
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
function showPop(rect, forExisting, noteText, num) {
  const pop = $('#hl-pop');
  pop.hidden = false;
  $('[data-hl="del"]', pop).hidden = !forExisting;
  const pn = $('#pop-note');
  pn.hidden = !noteText;
  pn.innerHTML = noteText ? `${num ? `<b>${circ(num)}</b>` : ''}${esc(noteText)}` : '';
  $('[data-hl="note"]', pop).textContent = noteText ? '改註' : '加註';
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.bottom + 10;
  if (y + ph > innerHeight - 70) y = rect.top - ph - 10;
  x = Math.max(8, Math.min(innerWidth - pw - 8, x));
  y = Math.max(8, y);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
}
function hidePop() { $('#hl-pop').hidden = true; pendingSel = null; activeHl = null; }

const onSelChange = debounce(() => {
  if (ink.active) return;
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
  const { aid, parts } = pendingSel;
  const r = getRec(aid, true);
  r.hl = r.hl || [];
  const ids = [];
  for (const pt of parts) {
    const h = { id: uid(), p: pt.p, s: pt.s, e: pt.e, c: color === 'note' ? 'y' : color };
    r.hl.push(h);
    ids.push(h.id);
  }
  window.getSelection()?.removeAllRanges();
  saveRec(aid); refreshArticle(aid); refreshChips(aid);
  if (current === aid) renderDetail();
  hidePop();
  if (withNote) editHlNote(aid, ids[ids.length - 1]);
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
  if (!dlg.open) dlg.showModal();
  onOpen && onOpen($('#modal-body'));
}
function editHlNote(aid, id) {
  const r = getRec(aid, true);
  const h = (r.hl || []).find((x) => x.id === id);
  if (!h) return;
  const sp = splitPara(byId.get(aid).p[h.p] || '');
  modal({
    title: `${aidLabel(aid)}・劃線註記`,
    body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(sp.body.slice(h.s, h.e))}」</p>
      <textarea class="note" id="m-hlnote" placeholder="這段文字的說明、要件或爭點">${esc(h.n || '')}</textarea>`,
    buttons: [
      { label: '取消' },
      { label: '儲存', cls: 'primary', onClick: () => { h.n = $('#m-hlnote').value.trim(); saveRec(aid); refreshArticle(aid); if (current === aid) renderDetail(); toast('已儲存註記'); } },
    ],
    onOpen: () => $('#m-hlnote').focus(),
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
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院112年度台上字第1234號判決／法務部○年○月○日法律字第○號函"></div>
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
// 搜尋與我的註記
// ---------------------------------------------------------------------------
function showSide(which) {
  $$('.seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.side === which ? 'true' : 'false'));
  ['toc', 'search', 'mine'].forEach((k) => { $('#side-' + k).hidden = k !== which; });
  if (which === 'mine') renderMine();
}
function snippet(text, terms, len = 70) {
  const i = text.indexOf(terms[0]);
  const s = Math.max(0, i - 20);
  let out = esc((s > 0 ? '…' : '') + text.slice(s, s + len) + (s + len < text.length ? '…' : ''));
  for (const t of terms) out = out.split(esc(t)).join(`<mark class="q">${esc(t)}</mark>`);
  return out;
}
function doSearch(q) {
  q = q.trim();
  const box = $('#side-search');
  if (!q) { box.innerHTML = '<p class="side-note">輸入關鍵字搜尋條文、判解與你的註記；輸入條號（例如 184、184-1、第一百八十四條）可直接跳到該條。</p>'; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  let html = '';
  const arts = [];
  for (const a of D.articles) { const t = a.p.join(''); if (has(t)) arts.push([a.id, t]); }
  const mine = [];
  notes.forEach((r, aid) => {
    const t = [r.note || '', ...(r.tags || []), ...(r.hl || []).map((h) => h.n || ''), ...(r.items || []).map((i) => i.no + i.text), ...Object.values(r.rnote || {})].join(' ');
    if (has(t)) mine.push([aid, t]);
  });
  const ruls = [];
  if (R) for (const aid in R) for (const r of R[aid]) {
    const t = r.no + ' ' + (r.parts || []).map((p) => p[1]).join(' ');
    if (has(t)) ruls.push([aid, r, t]);
  }
  const jump = parseAidInput(q);
  if (jump && byId.has(jump)) html += `<button class="res" data-goto="${jump}"><b>跳到${aidLabel(jump)}</b><span>${esc(byId.get(jump).p.join('').slice(0, 60))}…</span></button>`;
  html += `<div class="res-group">條文 ${arts.length}</div>`;
  html += arts.slice(0, 150).map(([aid, t]) => `<button class="res" data-goto="${aid}"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  if (mine.length) {
    html += `<div class="res-group">我的註記 ${mine.length}</div>`;
    html += mine.map(([aid, t]) => `<button class="res" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
  if (R) {
    html += `<div class="res-group">判解 ${ruls.length}</div>`;
    html += ruls.slice(0, 120).map(([aid, r, t]) => `<button class="res" data-goto="${aid}" data-tab="rulings"><b>${esc(r.no)}・${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
  }
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
    rows.push({ aid, r, f });
  }
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★ 書籤'], ['note', '筆記'], ['hl', '劃線'], ['ink', '手寫'], ['item', '判解']];
  let list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([k, l]) => `<button class="fchip" data-mf="${k}" aria-pressed="${mineFilter === k}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。點條號開啟條文，即可加書籤、寫筆記、劃線，或開啟手寫模式用 Apple Pencil 直接在條文上書寫。'}</p>`;
  html += list.map(({ aid, r, f }) => {
    const bits = [f.star && '★', f.note && '筆記', f.hl && `劃線 ${r.hl.length}`, f.ink && '手寫', r.items && r.items.length && `自建 ${r.items.length}`, r.imp && Object.keys(r.imp).length && `重要判解 ${Object.keys(r.imp).length}`].filter(Boolean).join('・');
    return `<button class="res" data-goto="${aid}" data-tab="notes"><b>${aidLabel(aid)}</b> <small style="color:var(--faint)">${bits}</small><span>${esc(r.note || (r.tags || []).map((t) => '#' + t).join(' ') || byId.get(aid).p.join('').slice(0, 60))}</span></button>`;
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
  document.body.classList.toggle('side-tap', settings.side === 'tap');
  requestAnimationFrame(() => ink.redrawAll());
}
function exportData() {
  const data = { app: 'civil-code-notes', version: 1, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) };
  return JSON.stringify(data);
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || data.app !== 'civil-code-notes' || !data.notes) throw new Error('不是民法註記本的備份檔');
  if (replace) { await store.clearAll(); notes.clear(); }
  for (const [aid, rec] of Object.entries(data.notes)) {
    if (!byId.has(aid)) continue;
    if (!replace && notes.has(aid)) {
      const cur = notes.get(aid);
      const merged = { ...rec, ...cur };
      merged.note = [cur.note, rec.note].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join('\n\n');
      merged.tags = Array.from(new Set([...(cur.tags || []), ...(rec.tags || [])]));
      const byIdMerge = (a = [], b = []) => { const m = new Map(); [...b, ...a].forEach((x) => m.set(x.id, x)); return [...m.values()]; };
      merged.hl = byIdMerge(cur.hl, rec.hl);
      merged.items = byIdMerge(cur.items, rec.items);
      merged.imp = { ...(rec.imp || {}), ...(cur.imp || {}) };
      merged.rnote = { ...(rec.rnote || {}), ...(cur.rnote || {}) };
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
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距</span>${seg('lh', [['1.7', '緊'], ['1.9', '中'], ['2.2', '鬆']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示同條各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">註記顯示<small>旁註：顯示在條文旁（螢幕窄時顯示在該段下方）；點選：點螢光文字才顯示</small></span>${seg('side', [['margin', '旁註'], ['tap', '點選']])}</div>
      <div class="set-row"><span class="l">判解／修正標記</span>${seg('chips', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">目前共有 ${n} 條有註記<small id="persist-state">儲存方式：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>可選檔案或貼上 JSON</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料</div>
      <div class="meta-list">民法條文：${esc(D.meta.source)}，法規修正日期 ${roc(D.meta.modified)}，資料庫更新 ${esc(D.meta.sourceUpdate)}。<br>
        新舊對照：比對全國法規資料庫歷次版本（${D.versions.length} 個版本）。<br>
        判解：全國法規資料庫各條「憲法法庭裁判」「大法官解釋」「判例」${R ? `，共 ${Object.values(R).reduce((s, v) => s + v.length, 0)} 筆` : '（未載入）'}。<br>
        ${esc(D.meta.effectiveNote)}<br>
        本工具供學習參考，正式引用請以官方公布之法規與裁判全文為準。<br>
        <a href="ccp/" style="color:var(--accent)">開啟民事訴訟法註記本 ↗</a></div>
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
          if (k === 'chips' || k === 'pn' || k === 'side') { renderReader(); if (current) renderDetail(); }
        } else if (b.dataset.size) {
          settings.size = Math.max(14, Math.min(28, settings.size + +b.dataset.size));
          $('#size-val').textContent = settings.size + 'px';
          saveSettings(); applySettings();
        } else if (b.dataset.act === 'export') {
          const blob = new Blob([exportData()], { type: 'application/json' });
          const a = document.createElement('a');
          a.href = URL.createObjectURL(blob);
          a.download = `民法註記備份-${new Date().toISOString().slice(0, 10)}.json`;
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
function setInk(on) {
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

  // 搜尋
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
      const b = e.target.closest('[data-goto]');
      if (!b) return;
      if (b.dataset.tab) detailTab = b.dataset.tab;
      gotoArticle(b.dataset.goto);
    });
  }

  // 閱讀區
  const reader = $('#reader');
  reader.addEventListener('scroll', () => { trackTOC(); if (!$('#hl-pop').hidden && !pendingSel) hidePop(); }, { passive: true });
  const clickArticle = (e) => {
    if (ink.active) return;
    const go = e.target.closest('[data-goto]');
    if (go) { e.preventDefault(); gotoArticle(go.dataset.goto); return; }
    const op = e.target.closest('[data-open]');
    if (op) { openDetail(op.dataset.open, op.dataset.tab); return; }
    const hl = e.target.closest('.hl[data-hl]');
    const sel = window.getSelection();
    if (hl && (!sel || sel.isCollapsed)) {
      const host = hl.closest('[data-id]');
      activeHl = { aid: host.dataset.id, id: hl.dataset.hl };
      pendingSel = null;
      const rec = getRec(activeHl.aid);
      const h = rec && (rec.hl || []).find((x) => x.id === activeHl.id);
      showPop(hl.getBoundingClientRect(), true, h && h.n, h && h.n ? noteNumbers(rec).get(h.id) : 0);
      return;
    }
    const sn = e.target.closest('[data-sn]');
    if (sn) {
      const host = sn.closest('[data-id]');
      editHlNote(host.dataset.id, sn.dataset.sn);
    }
  };
  reader.addEventListener('click', clickArticle);
  $('#d-text').addEventListener('click', clickArticle);
  document.addEventListener('selectionchange', onSelChange);
  $('#hl-pop').addEventListener('pointerdown', (e) => e.preventDefault()); // 保留選取
  $('#hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (!b) return;
    const v = b.dataset.hl;
    if (v === 'note') applyHighlight('note', true);
    else applyHighlight(v, false);
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop') && !e.target.closest('.hl')) {
      setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hidePop(); }, 10);
    }
  });

  // 詳細面板內容
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
      saveRec(current); refreshArticle(current); refreshChips(current); renderDetail();
    } else if (act === 'ink-on') {
      setInk(true);
      if (isNarrow() && matchMedia('(max-width: 760px)').matches) closeDetail();
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
    if (e.key === 'Escape') { if (!$('#hl-pop').hidden) hidePop(); else if (ink.active) setInk(false); else if (current) closeDetail(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => ink.redrawAll());
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  try {
    const [civ, saved] = await Promise.all([
      fetch('data/civil.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      store.getAll().catch(() => ({})),
    ]);
    D = civ;
    for (const a of D.articles) { byId.set(a.id, a); order.push(a.id); }
    for (const [k, v] of Object.entries(saved)) {
      if (k.startsWith('a:')) notes.set(k.slice(2), v);
      else if (k === 'settings') settings = { ...settings, ...v };
    }
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

  // 判解資料延遲載入
  fetch('data/rulings.json').then((r) => (r.ok ? r.json() : null)).then((data) => {
    if (!data) return;
    R = data;
    for (const aid of Object.keys(R)) refreshChips(aid);
    if (current) renderDetail();
  }).catch(() => {});

  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
