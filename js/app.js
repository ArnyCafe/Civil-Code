import * as store from './store.js';
import { diffParas } from './diff.js';
import { Ink, PEN_COLORS, MARK_COLORS, PEN_PRESETS, PX_PER_MM } from './ink.js';
import { RefFinder } from './refs.js';
import { layoutAnnotations, needsLayout, resetLayout, clearMetrics } from './annot.js';
import { Stickies, stickiesHTML, STK_COLORS } from './sticky.js';
import { $, $$, esc, debounce, uid, aidLabel, roc, cnNum, aidKey } from './util.js';

// ---------------------------------------------------------------------------
// 狀態
// ---------------------------------------------------------------------------
let REG = null;                 // data/laws.json
let XR = { names: {}, laws: {}, arts: {}, ed: {} };
const LAWS = new Map();         // pcode -> 法律資料
let cur = null;                 // 目前閱讀的法律 pcode
let L = null;                   // 目前法律資料
let finder = null;              // 條號引用辨識
const notes = new Map();        // 'pcode:aid' -> 使用者紀錄
const override = new Map();     // 'pcode:aid' -> true（顯示）／false（隱藏）：單條切換
let current = null;             // 目前開啟詳細面板的條號
let detailTab = 'rulings';
let rulFilter = 'all';
let cmpMode = 'table';
let cmpSel = null;
let searchLaw = 'all';
let mineFilter = 'all';

const DEFAULTS = {
  theme: 'system', size: 18, lh: 1.9, pn: true, chips: true,
  side: 'inter',          // inter：行間紅字（上／下）；side：旁註；tap：點選才顯示
  showMine: true,         // 顯示我的註記
  hideInk: true, hideNote: true, hideStk: true, hideHl: true, // 「隱藏註記」時要隱藏的種類
  tapReveal: true,        // 隱藏時，點一下條文即顯示該條註記
  refs: 'all',            // 相關法條小字：all／chips／off
  rulUnder: true,         // 條文下顯示標為重要的判解
  badge: 'group',         // 條號顏色：group（依章節）／mono
  notePos: 'up',          // 新增紅字註記的預設位置
  pen: { tool: 'pen', color: 'red', markColor: 'mark', mm: 0.3, markMM: 3, pressure: true, pencil: true, finger: false },
  lastLaw: null,
  pos: {},
  seenHelp: false,
};
let settings = structuredClone(DEFAULTS);

const TYPE_LABEL = { CJ: '憲法法庭', C: '大法官解釋', J: '判例', U: '我的' };
const USER_KINDS = ['判決', '函釋', '決議', '法律座談會', '其他'];
const KIND_LABEL = { orig: '制定', new: '增訂', amend: '修正', del: '刪除' };
const ABBR = {
  民事訴訟法: '民訴', 刑事訴訟法: '刑訴', 中華民國刑法: '刑法', 強制執行法: '強執', 非訟事件法: '非訟',
  家事事件法: '家事', 消費者債務清理條例: '消債', 行政執行法: '行執', 鄉鎮市調解條例: '鄉鎮市調解',
  民法: '民法', 土地法: '土地法', 海商法: '海商法', 公證法: '公證法', 票據法: '票據法', 仲裁法: '仲裁法',
};
const GROUP_COLORS = 12;
const HL_LABEL = { r: '紅線', y: '黃', g: '綠', b: '藍', p: '粉', u: '紅底線' };

const keyOf = (pc, aid) => pc + ':' + aid;
const lawName = (pc) => (LAWS.get(pc) && LAWS.get(pc).meta.name) || (REG && REG.laws.find((l) => l.pcode === pc)?.name) || XR.laws[pc] || pc;
const lawAbbr = (pc) => { const r = REG.laws.find((l) => l.pcode === pc); if (r) return r.short; const n = lawName(pc); return ABBR[n] || n; };
const isBundled = (pc) => REG.laws.some((l) => l.pcode === pc);

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => { t.hidden = true; }, 2400);
}
function headingPath(LD, hidx) {
  const out = [];
  while (hidx >= 0) { out.unshift(LD.headings[hidx].t); hidx = LD.headings[hidx].p; }
  return out;
}
function parseJump(q) {
  q = q.trim().replace(/\s+/g, '');
  let pc = null;
  const names = Object.keys(XR.names).concat(REG.laws.flatMap((l) => [l.name, l.short, ...(l.aliases || [])]))
    .filter((n) => isBundled(XR.names[n] || REG.laws.find((l) => l.name === n || l.short === n || (l.aliases || []).includes(n))?.pcode))
    .sort((a, b) => b.length - a.length);
  for (const n of names) {
    if (q.startsWith(n)) {
      pc = XR.names[n] || REG.laws.find((l) => l.name === n || l.short === n || (l.aliases || []).includes(n)).pcode;
      q = q.slice(n.length);
      break;
    }
  }
  let m = q.match(/^第?(\d+)(?:條)?(?:[-之](\d+))?(?:條)?$/);
  let aid = null;
  if (m) aid = m[2] ? `${m[1]}-${m[2]}` : m[1];
  else {
    m = q.match(/^第?([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?$/);
    if (m) aid = m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1]));
  }
  if (!aid) return null;
  return { pc: pc || cur, aid };
}

// ---------------------------------------------------------------------------
// 資料
// ---------------------------------------------------------------------------
const loading = new Map();
function loadLaw(pc) {
  if (LAWS.has(pc)) return Promise.resolve(LAWS.get(pc));
  if (loading.has(pc)) return loading.get(pc);
  const reg = REG.laws.find((l) => l.pcode === pc);
  const p = Promise.all([
    fetch(`data/${pc}.json`).then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
    fetch(`data/${pc}.rel.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
  ]).then(([d, rel]) => {
    const LD = { ...d, reg, pc, rel, byId: new Map(), order: [], R: null, gOf: new Map(), hG: new Map() };
    for (const a of d.articles) { LD.byId.set(a.id, a); LD.order.push(a.id); }
    computeGroups(LD);
    LAWS.set(pc, LD);
    loading.delete(pc);
    return LD;
  });
  loading.set(pc, p);
  return p;
}
function loadRulings(pc) {
  const LD = LAWS.get(pc);
  if (!LD) return Promise.resolve(null);
  if (LD.R) return Promise.resolve(LD.R);
  if (LD.rp) return LD.rp;
  LD.rp = fetch(`data/${pc}.rulings.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})).then((R) => { LD.R = R; return R; });
  return LD.rp;
}
// 章節顏色：每條依所屬「章節群組」配色
function computeGroups(LD) {
  const depth = (LD.reg && LD.reg.colorDepth) || 1;
  const idx = new Map();
  const pick = (hi) => {
    while (hi >= 0) { if (LD.headings[hi].lv < depth) return hi; hi = LD.headings[hi].p; }
    return -1;
  };
  for (const a of LD.articles) {
    const g = pick(a.h);
    if (!idx.has(g)) idx.set(g, idx.size);
    LD.gOf.set(a.id, idx.get(g));
  }
  LD.headings.forEach((h, i) => { const g = pick(i); if (g === i && idx.has(g)) LD.hG.set(i, idx.get(g)); });
}
function artText(pc, aid) {
  const LD = LAWS.get(pc);
  if (LD) { const a = LD.byId.get(aid); return a ? a.p : null; }
  return (XR.arts[pc] && XR.arts[pc][aid]) || null;
}
function artCaption(pc, aid) {
  const rec = notes.get(keyOf(pc, aid));
  if (rec && rec.cap) return rec.cap;
  const LD = LAWS.get(pc);
  const a = LD && LD.byId.get(aid);
  return (a && !a.del && a.c) || '';
}

// ---------------------------------------------------------------------------
// 使用者紀錄
// ---------------------------------------------------------------------------
function getRec(k, create) {
  let r = notes.get(k);
  if (!r && create) { r = {}; notes.set(k, r); }
  return r;
}
const hasInk = (r) => !!(r && r.ink && r.ink.strokes && r.ink.strokes.length);
const hasMine = (r) => !!(r && (r.note || (r.hl && r.hl.length) || hasInk(r) || (r.stk && r.stk.length)));
function isEmptyRec(r) {
  return !r || (!r.star && !r.note && !(r.tags && r.tags.length) && !(r.hl && r.hl.length) && !hasInk(r) &&
    !(r.items && r.items.length) && !(r.imp && Object.keys(r.imp).length) && !(r.rnote && Object.keys(r.rnote).length) &&
    !(r.stk && r.stk.length) && !r.cap && !r.color && !r.pad && !(r.why && Object.keys(r.why).length));
}
async function saveRec(k) {
  const r = notes.get(k);
  try {
    if (isEmptyRec(r)) { notes.delete(k); await store.del('n:' + k); }
    else { r.t = Date.now(); await store.put('n:' + k, r); }
  } catch (e) {
    console.error(e);
    toast('無法儲存註記：' + (e.message || e));
  }
}
const saveSettings = debounce(() => { store.put('settings', settings).catch(() => {}); }, 300);

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
const notePos = (h) => (h.pos === 'down' ? 'down' : 'up');
const interMode = () => settings.side === 'inter';

function sliceHTML(t, ups, downs) {
  if (!ups.length && !downs.length) return esc(t);
  const ch = Array.from(t);
  const slot = (h, pos) => `<i class="slot" data-ann="${h.id}" data-pos="${pos}"></i>`;
  const U = ups.map((h) => slot(h, 'up')).join(''), D = downs.map((h) => slot(h, 'down')).join('');
  if (ch.length === 1) return `<span class="nw">${U}${esc(ch[0])}${D}</span>`;
  const first = U ? `<span class="nw">${U}${esc(ch[0])}</span>` : esc(ch[0]);
  const last = D ? `<span class="nw">${esc(ch[ch.length - 1])}${D}</span>` : esc(ch[ch.length - 1]);
  return first + esc(ch.slice(1, -1).join('')) + last;
}

// ctx: { mode, pc, aid, nums, inter, order }
function renderRich(text, hls, ctx) {
  const refs = finder ? finder.find(text, ctx.mode, ctx) : [];
  const cuts = new Set([0, text.length]);
  const cl = (v) => Math.max(0, Math.min(text.length, v));
  for (const h of hls) { cuts.add(cl(h.s)); cuts.add(cl(h.e)); }
  for (const r of refs) { cuts.add(r.s); cuts.add(r.e); }
  const pts = [...cuts].sort((a, b) => a - b);
  const noteH = ctx.inter ? hls.filter((h) => h.n) : [];
  let html = '';
  for (let i = 0; i < pts.length - 1; i++) {
    const s = pts[i], e = pts[i + 1];
    if (s >= e) continue;
    const ups = noteH.filter((h) => notePos(h) === 'up' && cl(h.s) === s);
    const downs = noteH.filter((h) => notePos(h) === 'down' && cl(h.e) === e);
    let piece = sliceHTML(text.slice(s, e), ups, downs);
    const x = refs.find((r) => r.s <= s && r.e >= e);
    if (x) piece = `<a class="xref${x.pc !== ctx.pc ? ' ext' : ''}" href="#${x.pc}/${x.aid}" data-ref="${x.pc}|${x.aid}">${piece}</a>`;
    let h = null;
    for (const c of hls) if (c.s <= s && c.e >= e) h = c; // 後加者優先
    if (h) {
      const last = !hls.some((c) => c.id === h.id && c.e > e);
      const num = !ctx.inter && h.n && last ? (ctx.nums && ctx.nums.get(h.id)) || '註' : '';
      piece = `<mark class="hl hl-${h.c}" data-hl="${h.id}"${num ? ` data-n="${num}"` : ''}>${piece}</mark>`;
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

// 回傳 { html, anns }；side=true 時附旁註欄
function renderParas(LD, a, rec, { side = false, inter = interMode() } = {}) {
  const xiangCount = a.p.filter((t) => splitPara(t).kind === 'xiang').length;
  const nums = noteNumbers(rec);
  const ctx = { mode: 'law', pc: LD.pc, aid: a.id, order: LD.order, nums, inter };
  let xi = 0;
  const anns = [];
  const html = a.p.map((t, i) => {
    const sp = splitPara(t);
    const hls = ((rec && rec.hl) || []).filter((h) => h.p === i);
    if (inter) for (const h of hls) if (h.n) anns.push(h);
    const body = renderRich(sp.body, hls, ctx);
    let para;
    if (sp.kind === 'xiang') {
      const pn = xiangCount > 1 ? (ROMAN[xi] || xi + 1) : '';
      xi++;
      para = `<p class="para"><span class="pn">${pn}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    } else {
      para = `<p class="para ${sp.kind === 'kuan' ? 'kuan' : 'kuan sub'}"><span class="pn"></span><span class="kn">${esc(sp.mark)}</span><span class="pt" data-p="${i}">${body}</span></p>`;
    }
    if (!side) return para;
    let aside = '';
    for (const h of hls.filter((x) => x.n).sort((x, y) => x.s - y.s)) {
      aside += `<button class="sn" data-sn="${h.id}"><b>${circ(nums.get(h.id))}</b>${esc(h.n)}</button>`;
    }
    return `<div class="prow">${para}<aside class="pside">${aside}</aside></div>`;
  }).join('');
  const layer = anns.length ? `<div class="ann-layer">${anns.map((h) => `<div class="ann" data-ann="${h.id}" data-pos="${notePos(h)}">${esc(h.n)}</div>`).join('')}</div>` : '';
  return html + layer;
}

function rulingCount(LD, aid) {
  const n = LD.R && LD.R[aid] ? LD.R[aid].length : 0;
  const rec = notes.get(keyOf(LD.pc, aid));
  return n + (rec && rec.items ? rec.items.length : 0);
}
function amendCount(LD, aid) { const c = LD.changes[aid]; return c ? c.length - 1 : 0; }
function pendingNote(LD, aid) {
  const p = LD.meta.pending && LD.meta.pending[aid];
  if (!p) return '';
  return `${roc(p)}修正公布，尚未施行；施行前仍適用修正前條文，可於「新舊對照」查看。`;
}

const EYE = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/></svg>';
const EYE_OFF = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a17 17 0 0 1-3 3.8M6.3 6.9C3.9 8.6 2.5 12 2.5 12S6 18.5 12 18.5c1.6 0 3-.4 4.2-1"/><path d="M9.9 9.9a2.8 2.8 0 0 0 4 4"/></svg>';

function chipsHTML(LD, aid) {
  const k = keyOf(LD.pc, aid);
  const rec = notes.get(k);
  const out = [];
  if (rec && rec.star) out.push('<span class="chip c-star" title="書籤">★</span>');
  if (LD.meta.pending && LD.meta.pending[aid]) out.push('<span class="chip c-pend">尚未施行</span>');
  if (settings.chips) {
    const rc = rulingCount(LD, aid);
    if (rc) out.push(`<button class="chip c-rul" data-open="${aid}" data-tab="rulings">判解 ${rc}</button>`);
    const ac = amendCount(LD, aid);
    if (ac) out.push(`<button class="chip c-his" data-open="${aid}" data-tab="history">修正 ${ac}</button>`);
  }
  if (hasMine(rec)) {
    const hid = isHidden(k);
    out.push(`<button class="chip c-eye" data-eye="${aid}" aria-pressed="${!hid}" title="${hid ? '顯示' : '隱藏'}本條我的註記">${hid ? EYE_OFF : EYE}<span>註記</span></button>`);
  }
  return out.join('');
}

function badgeStyle(LD, aid) {
  const rec = notes.get(keyOf(LD.pc, aid));
  if (rec && rec.color) return ` style="--gc:${esc(rec.color)}"`;
  if (settings.badge !== 'group') return '';
  return ` style="--gc:var(--g${(LD.gOf.get(aid) || 0) % GROUP_COLORS})"`;
}

// 引用他法條文（小字）、相關法條、參照、重要判解
function refsHTML(LD, a) {
  if (settings.refs === 'off' && !settings.rulUnder) return '';
  const pc = LD.pc;
  let html = '';
  if (settings.refs !== 'off') {
    const seen = new Set();
    const ext = [];
    a.p.forEach((t) => {
      for (const r of finder.find(t, 'law', { pc, aid: a.id, order: LD.order })) {
        if (r.pc === pc) continue;
        const k = r.pc + '|' + r.aid;
        if (seen.has(k)) continue;
        seen.add(k);
        ext.push(r);
      }
    });
    if (settings.refs === 'all') {
      for (const r of ext) {
        const p = artText(r.pc, r.aid);
        const lbl = `${lawName(r.pc)}${aidLabel(r.aid)}`;
        if (!p) {
          if (!LAWS.has(r.pc) && isBundled(r.pc)) html += `<div class="ref-x pending" data-ref="${r.pc}|${r.aid}"><b>${esc(lbl)}</b>載入中…</div>`;
          continue;
        }
        const cap = artCaption(r.pc, r.aid);
        html += `<div class="ref-x" data-ref="${r.pc}|${r.aid}" role="button" tabindex="0"><b>${esc(lbl)}</b>${cap ? `<i>（${esc(cap)}）</i>` : ''}${esc(p.join('／'))}</div>`;
      }
    }
    const rel = (LD.rel && LD.rel[a.id]) || [];
    const ed = (XR.ed[pc] && XR.ed[pc][a.id]) || [];
    const chipRow = (label, list) => {
      const groups = new Map();
      for (const [tpc, taid] of list) {
        if (tpc === pc && taid === a.id) continue;
        if (seen.has(tpc + '|' + taid) && settings.refs === 'all') continue;
        if (!groups.has(tpc)) groups.set(tpc, []);
        if (!groups.get(tpc).includes(taid)) groups.get(tpc).push(taid);
      }
      if (!groups.size) return '';
      let row = '';
      for (const [tpc, aids] of groups) {
        for (const run of runs(tpc, aids)) {
          const name = tpc === pc ? '' : lawAbbr(tpc);
          const txt = run.length > 2 ? `§${run[0]}–${run[run.length - 1]}` : run.map((x) => '§' + x).join('、');
          row += `<button class="rchip${tpc === pc ? ' same' : ''}" data-refs="${tpc}|${run.join(',')}">${esc(name)}${txt}</button>`;
        }
      }
      return `<div class="ref-rel"><span class="lbl">${label}</span>${row}</div>`;
    };
    html += chipRow('相關', rel.map((r) => [r.p, r.a]));
    html += chipRow('參照', ed);
  }
  if (settings.rulUnder) {
    const rec = notes.get(keyOf(pc, a.id));
    if (rec && (rec.imp || rec.items)) {
      const list = [];
      for (const it of rec.items || []) if (rec.imp && rec.imp['U:' + it.id]) list.push({ no: it.no, t: it.text, kind: it.kind });
      if (LD.R && LD.R[a.id]) for (const r of LD.R[a.id]) if (rec.imp && rec.imp[r.ty + ':' + r.no]) list.push({ no: r.no.replace(/^廢/, ''), t: (r.parts || []).map((x) => x[1]).join(' '), kind: TYPE_LABEL[r.ty] });
      for (const r of list) html += `<div class="ref-rul" data-open="${a.id}" data-tab="rulings" role="button" tabindex="0"><b>★ ${esc(r.no)}</b>${esc(r.t || '')}</div>`;
    }
  }
  return html ? `<div class="refs">${html}</div>` : '';
}
// 連續條號合併成區間
function runs(pc, aids) {
  const LD = LAWS.get(pc);
  const sorted = [...aids].sort((x, y) => aidKey(x) - aidKey(y));
  const out = [];
  for (const id of sorted) {
    const last = out[out.length - 1];
    const prev = last && last[last.length - 1];
    let next = false;
    if (prev) {
      if (LD) next = LD.order[LD.order.indexOf(prev) + 1] === id;
      else next = !id.includes('-') && !prev.includes('-') && +id === +prev + 1;
    }
    if (next) last.push(id); else out.push([id]);
  }
  return out;
}

function articleInner(LD, a) {
  const k = keyOf(LD.pc, a.id);
  const rec = notes.get(k);
  const cap = artCaption(LD.pc, a.id);
  const inter = interMode();
  let html = `<div class="art-head"><button class="ano" data-open="${a.id}"${badgeStyle(LD, a.id)}>${aidLabel(a.id)}</button><span class="chips">${chipsHTML(LD, a.id)}</span></div>`;
  if (cap) html += `<div class="acap">（${esc(cap)}）</div>`;
  const nt = rec && rec.note && settings.side !== 'tap' ? `<div class="art-note" data-note-pos="${rec.notePos === 'up' ? 'up' : 'down'}" data-open="${a.id}" data-tab="notes">${esc(rec.note)}</div>` : '';
  if (nt && rec.notePos === 'up') html += nt;
  html += `<div class="atext">${renderParas(LD, a, rec, { side: settings.side === 'side', inter })}</div>`;
  if (nt && rec.notePos !== 'up') html += nt;
  html += refsHTML(LD, a);
  const pn = pendingNote(LD, a.id);
  if (pn) html += `<div class="pend-note">${esc(pn)}</div>`;
  if (rec && rec.pad) html += `<div class="ink-pad" style="height:${rec.pad}em"></div>`;
  html += `<div class="pad-ctl"><button type="button" data-pad="1" data-aid="${a.id}">＋ 書寫空白</button>${rec && rec.pad ? `<button type="button" data-pad="-1" data-aid="${a.id}">－</button>` : ''}</div>`;
  html += stickiesHTML(rec);
  return html;
}
function artClass(LD, a) {
  const k = keyOf(LD.pc, a.id);
  return `art${a.del ? ' deleted' : ''}${hasMine(notes.get(k)) && isHidden(k) ? ' mine-hidden' : ''}`;
}

function renderReader() {
  ink.reset();
  annObserved.clear();
  annIO.disconnect();
  const LD = L;
  const parts = [];
  const hlevelClass = ['h-part', 'h-chap', 'h-sec', 'h-sub', 'h-sub'];
  const firstOf = new Map();
  LD.headings.forEach((h, i) => { if (h.first) { if (!firstOf.has(h.first)) firstOf.set(h.first, []); firstOf.get(h.first).push(i); } });
  parts.push(`<header class="law-head"><h1>${esc(LD.meta.name)}</h1><p>修正日期 ${roc(LD.meta.modified)}・${LD.articles.filter((a) => !a.del).length} 條${LD.meta.eng ? `・<i>${esc(LD.meta.eng)}</i>` : ''}</p></header>`);
  for (const a of LD.articles) {
    for (const hi of firstOf.get(a.id) || []) {
      const h = LD.headings[hi];
      const tag = h.lv === 0 ? 'h2' : h.lv === 1 ? 'h3' : 'h4';
      const g = LD.hG.get(hi);
      parts.push(`<${tag} class="${hlevelClass[h.lv] || 'h-sub'}${g !== undefined && settings.badge === 'group' ? ' gh' : ''}" id="h-${hi}"${g !== undefined ? ` style="--gc:var(--g${g % GROUP_COLORS})"` : ''}>${esc(h.t)}</${tag}>`);
    }
    parts.push(`<article class="${artClass(LD, a)}" id="a-${a.id}" data-id="${a.id}" data-key="${keyOf(LD.pc, a.id)}">${articleInner(LD, a)}</article>`);
  }
  const inner = $('#reader-inner');
  inner.innerHTML = parts.join('');
  inner.classList.toggle('no-pn', !settings.pn);
  for (const el of $$('.art', inner)) {
    ink.observe(el);
    if (el.querySelector('.ann-layer')) observeAnn(el);
  }
}

function refreshArticle(aid) {
  const el = document.getElementById('a-' + aid);
  const a = L.byId.get(aid);
  if (el && a) {
    el.className = artClass(L, a) + (current === aid ? ' sel' : '');
    el.innerHTML = articleInner(L, a);
    ink.refresh(keyOf(L.pc, aid));
    if (el.querySelector('.ann-layer')) { observeAnn(el); layoutArt(el); }
  }
  if (current === aid) renderDetailText();
}
function refreshChips(aid) {
  const el = document.querySelector(`#a-${CSS.escape(aid)} .chips`);
  if (el) el.innerHTML = chipsHTML(L, aid);
}
// 他法載入完成後，更新各條下方的引用小字
function refreshRefs() {
  if (!L) return;
  for (const el of $$('#reader-inner .art')) {
    const a = L.byId.get(el.dataset.id);
    const old = el.querySelector(':scope > .refs');
    const html = refsHTML(L, a);
    if (old) { if (old.outerHTML !== html) old.outerHTML = html || ''; }
    else if (html) {
      const anchor = el.querySelector(':scope > .pend-note, :scope > .ink-pad, :scope > .pad-ctl');
      anchor.insertAdjacentHTML('beforebegin', html);
    }
  }
}

// ---------------------------------------------------------------------------
// 行間註記排版
// ---------------------------------------------------------------------------
const annObserved = new Set();
const annIO = new IntersectionObserver((ents) => {
  for (const e of ents) if (e.isIntersecting) layoutArt(e.target);
}, { root: $('#reader'), rootMargin: '600px 0px' });
function observeAnn(el) { if (!annObserved.has(el)) { annObserved.add(el); annIO.observe(el); } }
function layoutArt(el) {
  const t = el.querySelector(':scope > .atext');
  if (t && needsLayout(t)) layoutAnnotations(t);
}
function relayoutVisible(force) {
  clearMetrics();
  const top = -400, bottom = innerHeight + 400;
  for (const el of annObserved) {
    if (!el.isConnected) { annObserved.delete(el); continue; }
    const r = el.getBoundingClientRect();
    const t = el.querySelector(':scope > .atext');
    if (!t) continue;
    if (force) resetLayout(t);
    if (r.bottom > top && r.top < bottom) layoutAnnotations(t);
  }
  const dt = $('#d-text .atext');
  if (dt && !$('#detail').hidden) layoutAnnotations(dt);
}

// ---------------------------------------------------------------------------
// 顯示／隱藏我的註記
// ---------------------------------------------------------------------------
function isHidden(k) {
  const o = override.get(k);
  return o === undefined ? !settings.showMine : !o;
}
function applyHideFlags() {
  const b = document.body.classList;
  b.toggle('hw-ink', settings.hideInk);
  b.toggle('hw-note', settings.hideNote);
  b.toggle('hw-stk', settings.hideStk);
  b.toggle('hw-hl', settings.hideHl);
  $('#btn-eye').setAttribute('aria-pressed', settings.showMine ? 'false' : 'true');
  $('#btn-eye').innerHTML = settings.showMine ? EYE : EYE_OFF;
  $('#btn-eye').title = settings.showMine ? '隱藏我的註記' : '顯示我的註記';
}
function updateHidden(aid) {
  const k = keyOf(cur, aid);
  const hid = hasMine(notes.get(k)) && isHidden(k);
  for (const el of [document.getElementById('a-' + aid), current === aid ? $('#d-text') : null]) {
    if (!el) continue;
    el.classList.toggle('mine-hidden', hid);
    if (!hid) { const t = el.querySelector('.atext'); if (t && t.querySelector('.ann-layer')) layoutAnnotations(t); }
  }
  refreshChips(aid);
}
function toggleArticleMine(aid, show) {
  const k = keyOf(cur, aid);
  if (!hasMine(notes.get(k))) return;
  const want = show === undefined ? isHidden(k) : show;
  if (want === settings.showMine) override.delete(k); else override.set(k, want);
  updateHidden(aid);
}
function setShowMine(on) {
  settings.showMine = on;
  override.clear();
  saveSettings();
  applyHideFlags();
  for (const el of $$('#reader-inner .art')) {
    const k = el.dataset.key;
    el.classList.toggle('mine-hidden', hasMine(notes.get(k)) && !on);
    const c = el.querySelector('.chips');
    if (c && hasMine(notes.get(k))) c.innerHTML = chipsHTML(L, el.dataset.id);
  }
  if (current) $('#d-text').classList.toggle('mine-hidden', hasMine(notes.get(keyOf(cur, current))) && !on);
  if (on) requestAnimationFrame(() => relayoutVisible());
  toast(on ? '顯示我的註記' : '已隱藏我的註記；點一下條文或雙指輕點可單獨顯示');
}

// ---------------------------------------------------------------------------
// 目錄與法律切換
// ---------------------------------------------------------------------------
function lastArticleOf(LD, hi) {
  const h = LD.headings[hi];
  let next = null;
  for (let j = hi + 1; j < LD.headings.length; j++) if (LD.headings[j].lv <= h.lv) { next = LD.headings[j]; break; }
  if (!next) return LD.order[LD.order.length - 1];
  return LD.order[LD.order.indexOf(next.first) - 1];
}
function renderTOC() {
  const LD = L;
  const kids = new Map();
  LD.headings.forEach((h, i) => { if (!kids.has(h.p)) kids.set(h.p, []); kids.get(h.p).push(i); });
  const build = (pi) => (kids.get(pi) || []).map((i) => {
    const h = LD.headings[i];
    const sub = kids.get(i);
    const rng = h.first ? `${h.first}–${lastArticleOf(LD, i)}` : '';
    const g = LD.hG.get(i);
    const dot = g !== undefined && settings.badge === 'group' ? `<i class="gdot" style="--gc:var(--g${g % GROUP_COLORS})"></i>` : '';
    return `<div class="toc-part"><button class="toc-btn lv${h.lv}" data-h="${i}">${sub ? `<span class="caret" data-toggle="${i}">›</span>` : '<span class="caret"></span>'}${dot}<span>${esc(h.t)}</span><span class="rng">${rng}</span></button>${sub ? `<div class="toc-kids" id="tk-${i}" hidden>${build(i)}</div>` : ''}</div>`;
  }).join('');
  $('#side-toc').innerHTML = `<div class="toc-law">${esc(LD.meta.name)}</div>` + build(-1) +
    `<p class="side-note">資料來源：全國法規資料庫，修正日期 ${roc(LD.meta.modified)}。條號下括號內為條旨${LD.articles.some((a) => a.c) ? '（編者整理）' : '（可自行填寫）'}。</p>`;
}
function tocExpandTo(hi) {
  let x = hi;
  while (x >= 0) {
    const k = document.getElementById('tk-' + x);
    if (k) { k.hidden = false; const c = $(`[data-toggle="${x}"]`); if (c) c.classList.add('open'); }
    x = L.headings[x].p;
  }
}
const trackScroll = debounce(() => {
  if (!L) return;
  const reader = $('#reader');
  const top = reader.getBoundingClientRect().top + 80;
  let curH = -1;
  for (const el of $$('#reader-inner > h2, #reader-inner > h3, #reader-inner > h4')) {
    if (el.getBoundingClientRect().top < top) curH = +el.id.slice(2); else break;
  }
  $$('.toc-btn.cur').forEach((b) => b.classList.remove('cur'));
  if (curH >= 0) { const b = $(`.toc-btn[data-h="${curH}"]`); if (b) b.classList.add('cur'); }
  // 記住閱讀位置
  const arts = $$('#reader-inner > .art');
  let lo = 0, hi = arts.length - 1, found = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const r = arts[mid].getBoundingClientRect();
    if (r.bottom < top - 40) lo = mid + 1; else { found = arts[mid]; hi = mid - 1; }
  }
  if (found) { settings.pos[cur] = found.dataset.id; saveSettings(); }
}, 200);

function renderLawSeg() {
  $('#law-seg').innerHTML = REG.laws.map((l) => `<button type="button" data-law="${l.pcode}" aria-pressed="${l.pcode === cur}" title="${esc(l.name)}"><span class="ls-full">${esc(l.name)}</span><span class="ls-short">${esc(l.short)}</span></button>`).join('');
  $('#brand-mark').textContent = L ? (REG.laws.find((l) => l.pcode === cur).mark || L.meta.name[0]) : '法';
  document.title = L ? `${L.meta.name}・法典註記本` : '法典註記本';
}
async function switchLaw(pc, { aid, tab, open = true } = {}) {
  if (pc !== cur) {
    if (current) closeDetail();
    $('#reader-inner').innerHTML = '<div class="loading">載入條文中…</div>';
    try { await loadLaw(pc); } catch (e) { toast('無法載入：' + e.message); return; }
    cur = pc;
    L = LAWS.get(pc);
    settings.lastLaw = pc;
    saveSettings();
    renderLawSeg();
    renderTOC();
    renderReader();
    loadRulings(pc).then(() => { if (cur !== pc) return; for (const id of Object.keys(L.R || {})) refreshChips(id); refreshRefs(); if (current) renderDetail(); });
    if (!aid) {
      const p = settings.pos[pc];
      if (p && L.byId.has(p)) { scrollToEl(document.getElementById('a-' + p)); tocExpandTo(L.byId.get(p).h); }
      else { $('#reader').scrollTop = 0; if (!isNarrow() && L.headings.length) tocExpandTo(0); }
      try { history.replaceState(null, '', '#' + pc); } catch {}
    }
  }
  if (aid) { if (tab) detailTab = tab; gotoArticle(aid, { open }); }
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
  setTimeout(() => el.scrollIntoView({ block: 'start' }), 200);
}
function gotoArticle(aid, { open = true, flash = true } = {}) {
  if (!L.byId.has(aid)) { toast(`${L.meta.name}沒有${aidLabel(aid)}`); return; }
  const el = document.getElementById('a-' + aid);
  scrollToEl(el);
  if (flash) { el.classList.remove('flash'); void el.offsetWidth; el.classList.add('flash'); }
  tocExpandTo(L.byId.get(aid).h);
  setSide(false);
  if (open) openDetail(aid);
}
function gotoHeading(hi) {
  scrollToEl(document.getElementById('h-' + hi));
  setSide(false);
}
function goRef(pc, aid, opts) {
  if (pc === cur) gotoArticle(aid, opts);
  else if (isBundled(pc)) switchLaw(pc, { aid, ...opts });
}

// ---------------------------------------------------------------------------
// 引用條文彈出視窗
// ---------------------------------------------------------------------------
function showRefPop(rect, pc, aids) {
  const pop = $('#ref-pop');
  const items = aids.map((aid) => {
    const p = artText(pc, aid);
    const cap = artCaption(pc, aid);
    const LD = LAWS.get(pc);
    const exists = LD ? LD.byId.has(aid) : !!p;
    const link = isBundled(pc)
      ? (exists ? `<button class="btn small" data-go="${pc}|${aid}">${pc === cur ? '跳到此條' : `前往${esc(lawAbbr(pc))}`}</button>` : '')
      : `<a class="btn small" href="https://law.moj.gov.tw/LawClass/LawSingle.aspx?pcode=${pc}&flno=${aid}" target="_blank" rel="noopener">全國法規資料庫</a>`;
    return `<section class="rp-item"><header><b>${esc(lawName(pc))}${aidLabel(aid)}</b>${cap ? `<small>（${esc(cap)}）</small>` : ''}</header>
      <div class="rp-text">${p ? p.map((t) => `<p>${esc(t)}</p>`).join('') : `<p class="empty">${LD || !isBundled(pc) ? '本機沒有這條的內容。' : '載入中…'}</p>`}</div>
      <div class="row-actions">${link}</div></section>`;
  }).join('');
  pop.innerHTML = `<div class="rp-scroll">${items}</div>`;
  pop.hidden = false;
  const pw = Math.min(460, innerWidth - 16);
  pop.style.width = pw + 'px';
  const ph = pop.offsetHeight;
  let x = Math.max(8, Math.min(innerWidth - pw - 8, rect.left + rect.width / 2 - pw / 2));
  let y = rect.bottom + 8;
  if (y + ph > innerHeight - 12) y = Math.max(8, rect.top - ph - 8);
  pop.style.left = x + 'px';
  pop.style.top = y + 'px';
  if (isBundled(pc) && !LAWS.has(pc)) loadLaw(pc).then(() => { if (!pop.hidden) showRefPop(rect, pc, aids); });
}
function hideRefPop() { $('#ref-pop').hidden = true; }

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
  try { history.replaceState(null, '', '#' + cur); } catch {}
}
function renderDetailText() {
  const a = L.byId.get(current);
  const k = keyOf(cur, current);
  const rec = notes.get(k);
  const el = $('#d-text');
  el.dataset.id = current;
  el.dataset.key = k;
  el.classList.toggle('mine-hidden', hasMine(rec) && isHidden(k));
  const cap = artCaption(cur, current);
  el.innerHTML = (cap ? `<div class="acap">（${esc(cap)}）</div>` : '') +
    `<div class="atext${settings.pn ? '' : ' no-pn'}">${renderParas(L, a, rec, { side: false })}</div>` +
    (pendingNote(L, current) ? `<div class="pend-note">${esc(pendingNote(L, current))}</div>` : '');
  const t = el.querySelector('.atext');
  if (t.querySelector('.ann-layer')) requestAnimationFrame(() => layoutAnnotations(t));
}
function renderDetail() {
  if (!current) return;
  const a = L.byId.get(current);
  const rec = notes.get(keyOf(cur, current));
  const no = $('#d-no');
  no.textContent = aidLabel(current);
  no.setAttribute('style', (badgeStyle(L, current).match(/style="([^"]*)"/) || [, ''])[1]);
  $('#d-path').textContent = `${L.meta.name} › ` + headingPath(L, a.h).join(' › ');
  $('#d-star').setAttribute('aria-pressed', rec && rec.star ? 'true' : 'false');
  renderDetailText();
  const rc = rulingCount(L, current), ac = amendCount(L, current);
  $('#t-rulings').textContent = rc || '';
  $('#t-history').textContent = ac || '';
  $('#t-reason').textContent = rec && rec.why && Object.keys(rec.why).length ? Object.keys(rec.why).length : '';
  const nc = rec ? ((rec.note ? 1 : 0) + (rec.hl ? rec.hl.length : 0) + (hasInk(rec) ? 1 : 0) + (rec.stk ? rec.stk.length : 0)) : 0;
  $('#t-notes').textContent = nc || '';
  $$('.tabs button').forEach((b) => b.setAttribute('aria-selected', b.dataset.tab === detailTab ? 'true' : 'false'));
  const body = $('#d-body');
  if (detailTab === 'rulings') renderRulings(body);
  else if (detailTab === 'history') renderHistory(body);
  else if (detailTab === 'reason') renderReason(body);
  else renderNotes(body);
  body.scrollTop = 0;
}

// ----- 判解・函釋 -----
function rulingList(aid) {
  const rec = notes.get(keyOf(cur, aid)) || {};
  const imp = rec.imp || {};
  const list = (L.R && L.R[aid] ? L.R[aid] : []).map((r, i) => ({ ...r, key: r.ty + ':' + r.no, idx: i }));
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
  const rec = notes.get(keyOf(cur, current)) || {};
  let html = `<div class="filters">${filters.map(([k, l, n]) => `<button class="fchip" data-rf="${k}" aria-pressed="${rulFilter === k}">${l}<i>${n}</i></button>`).join('')}</div>`;
  html += `<div class="row-actions" style="margin-bottom:12px"><button class="btn small primary" data-act="add-item">＋ 新增判決／函釋</button>
    <a class="btn small" href="https://judgment.judicial.gov.tw/FJUD/default.aspx" target="_blank" rel="noopener">司法院裁判書查詢</a>
    <a class="btn small" href="https://law.judicial.gov.tw/" target="_blank" rel="noopener">法學資料檢索（函釋）</a></div>`;
  if (!L.R && !(rec.items && rec.items.length)) html += '<p class="empty">判解資料載入中…</p>';
  else if (!list.length) html += `<p class="empty">${rulFilter === 'U' ? '尚無自建資料。可新增最高法院判決、司法院函釋、法律座談會、民事庭會議決議等，並寫下要旨與個人筆記。' : rulFilter === 'imp' ? '尚未標記重要判解。點判解卡右上角的星號即可標記，標記後會以小字顯示在條文下方。' : '全國法規資料庫沒有本條的相關解釋或判例。可自行新增實務判決或函釋。'}</p>`;
  if (all.some((r) => r.ty === 'J')) html += '<p class="callout">判例制度已於民國108年7月4日廢止。依法院組織法第57條之1，未經停止適用之判例，其效力與未經選編為判例之最高法院裁判相同。字號前標「廢」者為已不再援用。</p>';
  for (const r of list) html += rulingCard(r, rec);
  body.innerHTML = html;
}
function rulingCard(r, rec) {
  const isVoid = (r.no || '').startsWith('廢');
  const typeLabel = r.ty === 'U' ? (r.kind || '其他') : TYPE_LABEL[r.ty];
  const parts = r.user ? (r.text ? [['要旨', r.text]] : []) : (r.parts || []);
  const rnote = rec.rnote && rec.rnote[r.key];
  const ctx = { mode: 'ruling', pc: cur, aid: current, inter: false };
  const partsHTML = parts.map(([lbl, txt]) => `<div class="rpart${txt.length > 220 ? ' clamp' : ''}"><span class="lbl">${esc(lbl)}</span>${renderRich(txt, [], ctx)}</div>`).join('');
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
function versionsOf(aid) { return (L.changes[aid] || []).map((h, i) => ({ ...h, i })); }
function histItemFor(d) { return L.histories.find((h) => h.dates.includes(d)); }
function renderHistory(body) {
  const a = L.byId.get(current);
  const vs = versionsOf(current);
  if (vs.length < 2) {
    const it = a.since && histItemFor(a.since);
    body.innerHTML = `<p class="empty">${aidLabel(current)}自${a.since ? roc(a.since) : '制定'}${a.since && a.since === (L.versions[0] || {}).d ? '制定' : '公布'}以來，未曾修正。</p>
      ${it ? `<div class="hist-item"><b>沿革第 ${it.n} 點</b><br>${esc(it.t)}</div>` : ''}
      <p class="callout" style="margin-top:12px">新舊對照以全國法規資料庫的歷次版本逐條比對產生；僅標點或個別字的資料庫勘誤不列為修正。</p>`;
    return;
  }
  const pend = L.meta.pending || {};
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
  } else html += `<div class="inline-diff">${dd.inline}</div>`;
  html += '<div class="legend"><span><ins class="d">新增文字</ins></span><span><del class="d">刪除文字</del></span></div>';
  const it = histItemFor(B.d);
  if (it) html += `<div class="hist-item"><b>沿革第 ${it.n} 點</b><br>${esc(it.t)}</div>`;
  const rec = notes.get(keyOf(cur, current));
  const why = rec && rec.why && rec.why[B.d];
  html += `<div class="why-peek"><b>立法理由（${roc(B.d, true)}）</b>${why ? `<p>${esc(why)}</p>` : '<p class="empty" style="padding:2px 0">尚未填寫。</p>'}<button class="linkish" data-act="why" data-d="${B.d}">${why ? '編輯' : '填寫立法理由'}</button></div>`;
  body.innerHTML = html;
}

// ----- 立法理由 -----
function renderReason(body) {
  const a = L.byId.get(current);
  const vs = versionsOf(current);
  const list = vs.length ? vs : [{ d: a.since, k: a.since === (L.versions[0] || {}).d ? 'orig' : 'new', p: a.p, i: 0 }];
  const rec = notes.get(keyOf(cur, current)) || {};
  let html = `<p class="callout">每次制定或修正的立法理由可在此保存。條文的歷次內容與沿革取自全國法規資料庫；理由原文請至<a href="https://lis.ly.gov.tw/lglawc/lglawkm" target="_blank" rel="noopener">立法院法律系統</a>查詢後貼上。</p>`;
  for (const v of [...list].reverse()) {
    if (!v.d) continue;
    const it = histItemFor(v.d);
    const why = rec.why && rec.why[v.d];
    html += `<section class="reason${why ? ' has' : ''}">
      <header><b>${roc(v.d)}</b><span class="tpill tp-${v.k === 'amend' ? 'C' : v.k === 'del' ? 'CJ' : 'J'}">${KIND_LABEL[v.k] || '公布'}</span></header>
      ${it ? `<p class="hist">沿革第 ${it.n} 點：${esc(it.t)}</p>` : ''}
      <div class="why-text">${why ? esc(why) : '<span class="empty">尚未填寫立法理由。</span>'}</div>
      <div class="row-actions"><button class="btn small${why ? '' : ' primary'}" data-act="why" data-d="${v.d}">${why ? '編輯' : '＋ 填寫立法理由'}</button>${v.i > 0 ? `<button class="btn small" data-act="cmp-from-why" data-i="${v.i}">看新舊對照</button>` : ''}</div>
    </section>`;
  }
  html += `<div class="row-actions" style="margin-top:6px"><a class="btn small" href="https://law.moj.gov.tw/LawClass/LawHistory.aspx?pcode=${cur}" target="_blank" rel="noopener">全國法規資料庫・法規沿革</a></div>`;
  body.innerHTML = html;
}
function editWhy(aid, d) {
  const k = keyOf(cur, aid);
  const r = getRec(k, true);
  r.why = r.why || {};
  modal({
    title: `${aidLabel(aid)}・${roc(d)}立法理由`,
    body: `<textarea class="note tall" id="m-why" placeholder="貼上立法理由、修正說明或自己的整理">${esc(r.why[d] || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => {
      const v = $('#m-why').value.trim();
      if (v) r.why[d] = v; else delete r.why[d];
      saveRec(k); renderDetail(); toast('已儲存');
    } }],
    onOpen: () => $('#m-why').focus(),
  });
}

// ----- 我的註記 -----
function allTags() {
  const s = new Set();
  notes.forEach((r) => (r.tags || []).forEach((t) => s.add(t)));
  return [...s].sort();
}
function renderNotes(body) {
  const k = keyOf(cur, current);
  const rec = notes.get(k) || {};
  const hls = rec.hl || [];
  const strokes = hasInk(rec) ? rec.ink.strokes.length : 0;
  const a = L.byId.get(current);
  const qText = (h) => { const sp = splitPara(a.p[h.p] || ''); return sp.body.slice(h.s, h.e); };
  const capDefault = a.c || '';
  let html = `<div class="field"><label for="cap-input">條旨（顯示在條號下方括號內）</label>
    <div class="row-actions"><input class="inp" id="cap-input" value="${esc(rec.cap || '')}" placeholder="${esc(capDefault || '例如：債務人異議之訴')}" style="flex:1;min-width:0">${rec.cap ? '<button class="btn small" data-act="cap-reset">還原</button>' : ''}</div></div>`;
  html += `<div class="field"><span class="lbl">條號顏色</span><div class="swatches">
    <button class="cs${!rec.color ? ' on' : ''}" data-color="" title="依章節"><span style="--gc:var(--g${(L.gOf.get(current) || 0) % GROUP_COLORS})">預設</span></button>
    ${['#2b5ea7', '#c0392b', '#127a68', '#7246a8', '#a6532b', '#946200', '#a83e6e', '#2f7d3b', '#1b1b1b'].map((c) => `<button class="cs${rec.color === c ? ' on' : ''}" data-color="${c}" aria-label="${c}"><span style="--gc:${c}"></span></button>`).join('')}</div></div>`;
  html += `<div class="field"><label for="note-text">本條筆記（以紅色小字顯示在條文${rec.notePos === 'up' ? '上方' : '下方'}）</label>
    <textarea class="note" id="note-text" placeholder="寫下要件、學說爭議、考點、實務見解…">${esc(rec.note || '')}</textarea>
    <div class="row-actions"><span class="segs" role="group" aria-label="筆記位置"><button type="button" data-npos="up" aria-pressed="${rec.notePos === 'up'}">條文上方</button><button type="button" data-npos="down" aria-pressed="${rec.notePos !== 'up'}">條文下方</button></span>
    <span class="saved" id="note-saved">${rec.t ? '上次更新 ' + new Date(rec.t).toLocaleString('zh-TW') : '自動儲存於本機'}</span></div></div>`;
  html += `<div class="field"><label for="tag-input">標籤</label>
    <div class="tags">${(rec.tags || []).map((t) => `<button class="tag" data-act="rm-tag" data-tag="${esc(t)}">${esc(t)} ×</button>`).join('')}</div>
    <input class="inp" id="tag-input" list="tag-list" placeholder="輸入標籤後按 Enter，例如：考點、爭點、實務見解" enterkeyhint="done">
    <datalist id="tag-list">${allTags().map((t) => `<option value="${esc(t)}">`).join('')}</datalist></div>`;
  html += `<div class="field"><span class="lbl">劃線與紅字註記（${hls.length}）</span>`;
  html += hls.length ? `<ul class="hl-list">${hls.map((h) => `<li><div><span class="q"><mark class="hl hl-${h.c}">${esc(qText(h))}</mark></span>${h.n ? `<span class="n">${notePos(h) === 'up' ? '↑' : '↓'} ${esc(h.n)}</span>` : ''}</div>
      <div class="row-actions"><button class="linkish" data-act="hl-note" data-id="${h.id}">${h.n ? '改註' : '加註'}</button><button class="linkish" data-act="hl-del" data-id="${h.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>`
    : '<p class="empty" style="padding:4px 0">在條文上選取文字，即可劃線，或加上紅色小字註記（放在文字上方或下方）。</p>';
  html += '</div>';
  const stk = rec.stk || [];
  html += `<div class="field"><span class="lbl">便利貼（${stk.length}）</span>
    ${stk.length ? `<ul class="hl-list">${stk.map((s) => `<li><div><span class="q stk-sw st-${s.c || 'y'}"></span>${esc(s.t || '（空白）')}</div><div class="row-actions"><button class="linkish" data-act="stk-del" data-id="${s.id}" style="color:var(--seal)">刪除</button></div></li>`).join('')}</ul>` : ''}
    <div class="row-actions"><button class="btn small" data-act="stk-add">＋ 在本條貼便利貼</button></div></div>`;
  html += `<div class="field"><span class="lbl">手寫（${strokes} 筆）</span>
    <div class="row-actions"><button class="btn small" data-act="ink-on">在條文上手寫</button>${strokes ? '<button class="btn small danger" data-act="ink-clear">清除本條手寫</button>' : ''}</div>
    ${ink.layoutShifted(k) ? '<p class="ink-warn">版面寬度與書寫時不同，手寫位置可能略有偏移。</p>' : ''}</div>`;
  body.innerHTML = html;
  const ta = $('#note-text');
  const save = debounce(() => {
    const r = getRec(k, true);
    r.note = ta.value;
    saveRec(k).then(() => { $('#note-saved') && ($('#note-saved').textContent = '已儲存'); });
    refreshArticle(current);
  }, 500);
  ta.addEventListener('input', () => { $('#note-saved').textContent = '儲存中…'; save(); });
  const ci = $('#cap-input');
  ci.addEventListener('change', () => {
    const r = getRec(k, true);
    const v = ci.value.trim().replace(/^[（(]|[）)]$/g, '');
    if (v && v !== a.c) r.cap = v; else delete r.cap;
    saveRec(k); refreshArticle(current); renderDetail();
  });
  const ti = $('#tag-input');
  ti.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.isComposing) {
      e.preventDefault();
      const v = ti.value.trim().replace(/^#/, '');
      if (!v) return;
      const r = getRec(k, true);
      r.tags = Array.from(new Set([...(r.tags || []), ...v.split(/[,，、\s]+/).filter(Boolean)]));
      saveRec(k);
      renderNotes(body);
      $('#tag-input').focus();
    }
  });
}

// ---------------------------------------------------------------------------
// 劃線與紅字註記
// ---------------------------------------------------------------------------
let pendingSel = null; // { k, aid, parts:[{p,s,e}] }
let activeHl = null;   // { k, aid, id }

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
  const node = range.commonAncestorContainer.nodeType === 1 ? range.commonAncestorContainer : range.commonAncestorContainer.parentElement;
  const host = node && node.closest('[data-key]');
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
  return { k: host.dataset.key, aid, parts, rect: range.getBoundingClientRect() };
}
function showPop(rect, existing, h) {
  const pop = $('#hl-pop');
  pop.hidden = false;
  $$('[data-exist]', pop).forEach((b) => { b.hidden = !existing; });
  $$('[data-new]', pop).forEach((b) => { b.hidden = !!existing; });
  const pn = $('#pop-note');
  pn.hidden = !(h && h.n);
  pn.innerHTML = h && h.n ? `<b>${notePos(h) === 'up' ? '↑' : '↓'}</b>${esc(h.n)}` : '';
  const nb = $('[data-hl="note"]', pop);
  nb.textContent = h && h.n ? '改註' : '加註';
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  let x = rect.left + rect.width / 2 - pw / 2;
  let y = rect.bottom + 10;
  if (y + ph > innerHeight - 70) y = rect.top - ph - 10;
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, x)) + 'px';
  pop.style.top = Math.max(8, y) + 'px';
}
function hidePop() { $('#hl-pop').hidden = true; pendingSel = null; activeHl = null; }
const onSelChange = debounce(() => {
  if (ink.active || stickies.placing) return;
  const c = captureSelection();
  if (c) { pendingSel = c; activeHl = null; showPop(c.rect, false); }
  else if (!activeHl && !$('#hl-pop').matches(':hover')) $('#hl-pop').hidden = true;
}, 280);

function revealIfHidden(k) {
  if (hasMine(notes.get(k)) && isHidden(k)) { override.set(k, true); updateHidden(k.split(':')[1]); }
}
function afterHlChange(k, aid) {
  if (isHidden(k)) override.set(k, true);
  saveRec(k);
  refreshArticle(aid);
  refreshChips(aid);
  if (current === aid) renderDetail();
}
function applyHighlight(action) {
  // action：y/g/b/p/u 顏色；note-up/note-down 紅字註記；note 加註；del 刪除；flip 換上下
  if (activeHl) {
    const { k, aid, id } = activeHl;
    const r = getRec(k, true);
    const h = (r.hl || []).find((x) => x.id === id);
    if (!h) return hidePop();
    hidePop();
    if (action === 'del') r.hl = r.hl.filter((x) => x.id !== h.id);
    else if (action === 'note') return editHlNote(k, aid, id);
    else if (action === 'flip') h.pos = notePos(h) === 'up' ? 'down' : 'up';
    else if (action === 'note-up' || action === 'note-down') { h.pos = action === 'note-up' ? 'up' : 'down'; return editHlNote(k, aid, id); }
    else h.c = action;
    return afterHlChange(k, aid);
  }
  if (!pendingSel) return;
  const { k, aid, parts } = pendingSel;
  const r = getRec(k, true);
  r.hl = r.hl || [];
  const isNote = action.startsWith('note');
  const ids = [];
  for (const pt of parts) {
    const h = { id: uid(), p: pt.p, s: pt.s, e: pt.e, c: isNote ? 'r' : action };
    if (isNote) h.pos = action === 'note-down' ? 'down' : action === 'note-up' ? 'up' : settings.notePos;
    r.hl.push(h);
    ids.push(h.id);
  }
  window.getSelection()?.removeAllRanges();
  hidePop();
  afterHlChange(k, aid);
  if (isNote) editHlNote(k, aid, ids[ids.length - 1], true);
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
function editHlNote(k, aid, id, isNew) {
  const r = getRec(k, true);
  const h = (r.hl || []).find((x) => x.id === id);
  if (!h) return;
  const a = L.byId.get(aid);
  const sp = splitPara(a.p[h.p] || '');
  let pos = notePos(h), col = h.c;
  modal({
    title: `${aidLabel(aid)}・紅字註記`,
    body: `<p class="callout" style="font-family:var(--font-law);font-size:15px">「${esc(sp.body.slice(h.s, h.e))}」</p>
      <textarea class="note" id="m-hlnote" placeholder="寫在這段文字旁的小字註記（紅色）">${esc(h.n || '')}</textarea>
      <div class="set-row"><span class="l">位置</span><span class="segs" role="group" id="m-pos"><button type="button" data-v="up" aria-pressed="${pos === 'up'}">文字上方</button><button type="button" data-v="down" aria-pressed="${pos === 'down'}">文字下方</button></span></div>
      <div class="set-row"><span class="l">文字標示</span><span class="segs" role="group" id="m-col">${Object.entries(HL_LABEL).map(([c, l]) => `<button type="button" data-v="${c}" aria-pressed="${col === c}">${l}</button>`).join('')}</span></div>`,
    buttons: [
      { label: isNew ? '不加註' : '取消', onClick: () => { if (isNew && !h.n) { r.hl = r.hl.filter((x) => x !== h); afterHlChange(k, aid); } } },
      { label: '儲存', cls: 'primary', onClick: () => {
        h.n = $('#m-hlnote').value.trim();
        h.pos = pos; h.c = col;
        if (!h.n && h.c === 'r') r.hl = r.hl.filter((x) => x !== h);
        afterHlChange(k, aid);
        toast(h.n ? '已儲存註記' : '已移除註記');
      } },
    ],
    onOpen: (body) => {
      $('#m-hlnote').focus();
      if (isNew) $('#modal').addEventListener('close', () => {
        if (!h.n && h.c === 'r' && (r.hl || []).includes(h)) { r.hl = r.hl.filter((x) => x !== h); afterHlChange(k, aid); }
      }, { once: true });
      body.onclick = (e) => {
        const b = e.target.closest('[data-v]');
        if (!b) return;
        const grp = b.parentElement;
        $$('button', grp).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
        if (grp.id === 'm-pos') pos = b.dataset.v; else col = b.dataset.v;
      };
    },
  });
}
function editItem(aid, item) {
  const k = keyOf(cur, aid);
  const isNew = !item;
  item = item || { id: uid(), kind: '判決', no: '', date: '', text: '', url: '' };
  modal({
    title: isNew ? `${aidLabel(aid)}・新增判決／函釋` : '編輯判決／函釋',
    body: `<div class="form-grid">
      <div class="field"><label for="m-kind">類型</label><select class="inp" id="m-kind">${USER_KINDS.map((x) => `<option${x === item.kind ? ' selected' : ''}>${x}</option>`).join('')}</select></div>
      <div class="field"><label for="m-date">日期</label><input class="inp" id="m-date" value="${esc(item.date)}" placeholder="例：112年03月24日"></div>
      <div class="field full"><label for="m-no">字號</label><input class="inp" id="m-no" value="${esc(item.no)}" placeholder="例：最高法院112年度台抗字第1234號裁定／司法院○年○月○日院台廳民二字第○號函"></div>
      <div class="field full"><label for="m-text">要旨</label><textarea class="note" id="m-text" placeholder="裁判要旨或函釋內容">${esc(item.text)}</textarea></div>
      <div class="field full"><label for="m-url">原文連結（選填）</label><input class="inp" id="m-url" type="url" value="${esc(item.url)}" placeholder="https://"></div>
      <label class="field full chk"><input type="checkbox" id="m-imp"${(getRec(k) || {}).imp?.['U:' + item.id] ? ' checked' : ''}> 標為重要（以小字顯示在條文下方）</label></div>`,
    buttons: [
      ...(isNew ? [] : [{ label: '刪除', cls: 'danger', onClick: () => {
        const r = getRec(k, true);
        r.items = (r.items || []).filter((x) => x.id !== item.id);
        if (r.imp) delete r.imp['U:' + item.id];
        saveRec(k); refreshArticle(aid); renderDetail(); toast('已刪除');
      } }]),
      { label: '取消' },
      { label: '儲存', cls: 'primary', onClick: () => {
        const no = $('#m-no').value.trim();
        if (!no) { toast('請填寫字號'); return true; }
        Object.assign(item, { kind: $('#m-kind').value, no, date: $('#m-date').value.trim(), text: $('#m-text').value.trim(), url: $('#m-url').value.trim() });
        const r = getRec(k, true);
        r.items = r.items || [];
        if (isNew) r.items.push(item);
        r.imp = r.imp || {};
        if ($('#m-imp').checked) r.imp['U:' + item.id] = 1; else delete r.imp['U:' + item.id];
        saveRec(k); refreshArticle(aid);
        rulFilter = isNew ? 'U' : rulFilter;
        renderDetail(); toast('已儲存');
      } },
    ],
    onOpen: () => $('#m-no').focus(),
  });
}
function editRulingNote(aid, key) {
  const k = keyOf(cur, aid);
  const r = getRec(k, true);
  r.rnote = r.rnote || {};
  modal({
    title: `${key.split(':').slice(1).join(':')}・筆記`,
    body: `<textarea class="note" id="m-rnote" placeholder="這則判解的重點、與本條的關係…">${esc(r.rnote[key] || '')}</textarea>`,
    buttons: [{ label: '取消' }, { label: '儲存', cls: 'primary', onClick: () => {
      const v = $('#m-rnote').value.trim();
      if (v) r.rnote[key] = v; else delete r.rnote[key];
      saveRec(k); renderDetail();
    } }],
    onOpen: () => $('#m-rnote').focus(),
  });
}

// ---------------------------------------------------------------------------
// 便利貼選單
// ---------------------------------------------------------------------------
function showStkMenu(rect, s, k) {
  const pop = $('#stk-pop');
  pop.dataset.key = k;
  pop.dataset.id = s.id;
  pop.innerHTML = `<div class="pop-row">${STK_COLORS.map(([c, l]) => `<button class="stk-sw st-${c}${(s.c || 'y') === c ? ' on' : ''}" data-sc="${c}" aria-label="${l}"></button>`).join('')}</div>
    <label class="stk-op">透明度<input type="range" min="0.1" max="0.9" step="0.05" value="${s.op ?? 0.35}" data-sop></label>
    <div class="pop-row"><button class="pop-txt" data-sa="edit">編輯文字</button><button class="pop-txt danger" data-sa="del">刪除</button></div>`;
  pop.hidden = false;
  const pw = pop.offsetWidth, ph = pop.offsetHeight;
  pop.style.left = Math.max(8, Math.min(innerWidth - pw - 8, rect.right - pw)) + 'px';
  pop.style.top = Math.max(8, rect.bottom + ph + 8 > innerHeight ? rect.top - ph - 6 : rect.bottom + 6) + 'px';
}

// ---------------------------------------------------------------------------
// 搜尋與我的註記
// ---------------------------------------------------------------------------
function showSide(which) {
  $$('.seg button').forEach((b) => b.setAttribute('aria-selected', b.dataset.side === which ? 'true' : 'false'));
  ['toc', 'search', 'mine'].forEach((x) => { $('#side-' + x).hidden = x !== which; });
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
  const lawChips = `<div class="mine-filter">${[['all', '全部法律'], ...REG.laws.map((l) => [l.pcode, l.short])].map(([k, l]) => `<button class="fchip" data-sl="${k}" aria-pressed="${searchLaw === k}">${esc(l)}</button>`).join('')}</div>`;
  if (!q) { box.innerHTML = lawChips + '<p class="side-note">可跨法律搜尋條文、條旨、判解與你的註記。輸入條號直接跳轉，例如：<b>4-1</b>、<b>強執14</b>、<b>民訴402</b>、<b>民法184</b>、<b>第一百八十四條</b>。</p>'; return; }
  const terms = q.split(/\s+/).filter(Boolean);
  const has = (t) => terms.every((x) => t.includes(x));
  const laws = REG.laws.filter((l) => searchLaw === 'all' || l.pcode === searchLaw).map((l) => l.pcode);
  let html = lawChips;
  const jump = parseJump(q);
  if (jump) {
    const LD = LAWS.get(jump.pc);
    if (LD && LD.byId.has(jump.aid)) html += `<button class="res jump" data-goto="${jump.pc}|${jump.aid}"><b>跳到${esc(LD.meta.name)}${aidLabel(jump.aid)}</b><span>${esc(LD.byId.get(jump.aid).p.join('').slice(0, 60))}…</span></button>`;
  }
  let need = [];
  for (const pc of laws) {
    const LD = LAWS.get(pc);
    if (!LD) { need.push(pc); continue; }
    const arts = [];
    for (const a of LD.articles) { const t = (a.c || '') + ' ' + a.p.join(''); if (has(t)) arts.push([a.id, a.p.join(''), a.c]); }
    const mine = [];
    notes.forEach((r, k) => {
      if (!k.startsWith(pc + ':')) return;
      const t = [r.note || '', r.cap || '', ...(r.tags || []), ...(r.hl || []).map((h) => h.n || ''), ...(r.items || []).map((i) => i.no + i.text), ...Object.values(r.rnote || {}), ...(r.stk || []).map((s) => s.t || ''), ...Object.values(r.why || {})].join(' ');
      if (has(t)) mine.push([k.slice(pc.length + 1), t]);
    });
    const ruls = [];
    if (LD.R) for (const aid in LD.R) for (const r of LD.R[aid]) { const t = r.no + ' ' + (r.parts || []).map((p) => p[1]).join(' '); if (has(t)) ruls.push([aid, r, t]); }
    else need.push(pc);
    if (!arts.length && !mine.length && !ruls.length) continue;
    html += `<div class="res-law">${esc(LD.meta.name)}</div>`;
    if (arts.length) {
      html += `<div class="res-group">條文 ${arts.length}</div>`;
      html += arts.slice(0, 120).map(([aid, t, c]) => `<button class="res" data-goto="${pc}|${aid}"><b>${aidLabel(aid)}</b>${c ? `<small>（${esc(c)}）</small>` : ''}<span>${snippet(t, terms)}</span></button>`).join('');
    }
    if (mine.length) {
      html += `<div class="res-group">我的註記 ${mine.length}</div>`;
      html += mine.map(([aid, t]) => `<button class="res" data-goto="${pc}|${aid}" data-tab="notes"><b>${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
    }
    if (ruls.length) {
      html += `<div class="res-group">判解 ${ruls.length}</div>`;
      html += ruls.slice(0, 80).map(([aid, r, t]) => `<button class="res" data-goto="${pc}|${aid}" data-tab="rulings"><b>${esc(r.no)}・${aidLabel(aid)}</b><span>${snippet(t, terms)}</span></button>`).join('');
    }
  }
  if (html === lawChips + '') html += '<p class="side-note">沒有符合的結果。</p>';
  box.innerHTML = html;
  need = [...new Set(need)];
  if (need.length) Promise.all(need.map((pc) => loadLaw(pc).then(() => loadRulings(pc)))).then(() => { if ($('#q').value.trim() === q) doSearch(q); });
}
function renderMine() {
  const rows = [];
  for (const l of REG.laws) {
    const LD = LAWS.get(l.pcode);
    const keys = [...notes.keys()].filter((k) => k.startsWith(l.pcode + ':'));
    keys.sort((a, b) => aidKey(a.split(':')[1]) - aidKey(b.split(':')[1]));
    for (const k of keys) {
      const r = notes.get(k);
      if (isEmptyRec(r)) continue;
      const aid = k.split(':')[1];
      const f = { star: !!r.star, note: !!r.note, hl: !!(r.hl && r.hl.length), ink: hasInk(r), stk: !!(r.stk && r.stk.length), item: !!(r.items && r.items.length) || !!(r.imp && Object.keys(r.imp).length) };
      rows.push({ pc: l.pcode, LD, aid, r, f });
    }
  }
  const tags = allTags();
  const flt = [['all', '全部'], ['star', '★ 書籤'], ['note', '筆記'], ['hl', '劃線・紅字'], ['ink', '手寫'], ['stk', '便利貼'], ['item', '判解']];
  const list = rows.filter(({ r, f }) => mineFilter === 'all' || (mineFilter.startsWith('#') ? (r.tags || []).includes(mineFilter.slice(1)) : f[mineFilter]));
  let html = `<div class="mine-filter">${flt.map(([x, l]) => `<button class="fchip" data-mf="${x}" aria-pressed="${mineFilter === x}">${l}</button>`).join('')}${tags.map((t) => `<button class="fchip" data-mf="#${esc(t)}" aria-pressed="${mineFilter === '#' + t}">#${esc(t)}</button>`).join('')}</div>`;
  if (!list.length) html += `<p class="side-note">${rows.length ? '沒有符合的註記。' : '還沒有註記。選取條文文字可劃線或加紅字註記；用 Apple Pencil 可直接在條文上書寫；按上方便利貼按鈕可貼便利貼。'}</p>`;
  let lastPc = null;
  for (const { pc, LD, aid, r, f } of list) {
    if (pc !== lastPc) { html += `<div class="res-law">${esc(lawName(pc))}</div>`; lastPc = pc; }
    const bits = [f.star && '★', f.note && '筆記', f.hl && `劃線 ${r.hl.length}`, f.ink && '手寫', f.stk && `便利貼 ${r.stk.length}`, r.items && r.items.length && `自建 ${r.items.length}`, r.imp && Object.keys(r.imp).length && `重要判解 ${Object.keys(r.imp).length}`].filter(Boolean).join('・');
    const peek = r.note || (r.tags || []).map((t) => '#' + t).join(' ') || (r.hl || []).map((h) => h.n).filter(Boolean).join('／') || (LD && LD.byId.get(aid) ? LD.byId.get(aid).p.join('').slice(0, 60) : '');
    html += `<button class="res" data-goto="${pc}|${aid}" data-tab="notes"><b>${aidLabel(aid)}</b> <small style="color:var(--faint)">${bits}</small><span>${esc(peek)}</span></button>`;
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
  applyHideFlags();
  requestAnimationFrame(() => { ink.redrawAll(); relayoutVisible(true); });
}
function exportData() {
  return JSON.stringify({ app: 'law-notes', version: 2, exported: new Date().toISOString(), settings, notes: Object.fromEntries(notes) });
}
async function importData(text, replace) {
  const data = JSON.parse(text);
  if (!data || !data.notes || !['law-notes', 'civil-code-notes'].includes(data.app)) throw new Error('不是法典註記本的備份檔');
  const legacy = data.app === 'civil-code-notes';
  if (replace) { await store.clearAll(); notes.clear(); }
  for (const [k0, rec] of Object.entries(data.notes)) {
    const k = legacy ? keyOf('B0000001', k0) : k0;
    if (!/^[A-Z0-9]+:\d+(-\d+)?$/.test(k)) continue;
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
      merged.why = { ...(rec.why || {}), ...(c.why || {}) };
      if (rec.ink && c.ink) merged.ink = { ...c.ink, strokes: [...(c.ink.strokes || []), ...(rec.ink.strokes || [])] };
      merged.star = c.star || rec.star;
      notes.set(k, merged);
    } else notes.set(k, rec);
    await saveRec(k);
  }
  if (data.settings && replace && !legacy) {
    settings = { ...structuredClone(DEFAULTS), ...data.settings, pen: { ...DEFAULTS.pen, ...(data.settings.pen || {}) }, pos: data.settings.pos || {} };
    ink.opts = settings.pen;
    saveSettings(); applySettings(); syncInkbar();
  }
  renderReader();
  if (current) renderDetail();
}
function openSettings() {
  const seg = (key, opts) => `<span class="segs" role="group">${opts.map(([v, l]) => `<button type="button" data-set="${key}" data-val="${v}" aria-pressed="${String(settings[key]) === String(v)}">${l}</button>`).join('')}</span>`;
  const n = [...notes.values()].filter((r) => !isEmptyRec(r)).length;
  const rCount = [...LAWS.values()].reduce((s, LD) => s + (LD.R ? Object.values(LD.R).reduce((x, v) => x + v.length, 0) : 0), 0);
  modal({
    title: '設定與備份',
    body: `
      <div class="set-h">閱讀</div>
      <div class="set-row"><span class="l">主題</span>${seg('theme', [['system', '系統'], ['light', '淺色'], ['sepia', '護眼'], ['dark', '深色']])}</div>
      <div class="set-row"><span class="l">字級<small id="size-val">${settings.size}px</small></span><span class="segs"><button type="button" data-size="-1">A−</button><button type="button" data-size="1">A＋</button></span></div>
      <div class="set-row"><span class="l">行距</span>${seg('lh', [['1.7', '緊'], ['1.9', '中'], ['2.2', '鬆']])}</div>
      <div class="set-row"><span class="l">條號顏色<small>依章節以不同顏色反白條號</small></span>${seg('badge', [['group', '依章節'], ['mono', '單色']])}</div>
      <div class="set-row"><span class="l">項次標示<small>以 Ⅰ Ⅱ Ⅲ 標示同條各項</small></span>${seg('pn', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">相關法條小字<small>引用他法的條文內容以小字顯示在條文下方</small></span>${seg('refs', [['all', '條文＋清單'], ['chips', '只列清單'], ['off', '隱藏']])}</div>
      <div class="set-row"><span class="l">重要判解小字<small>標為重要的判解顯示在條文下方</small></span>${seg('rulUnder', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-row"><span class="l">判解／修正標記</span>${seg('chips', [['true', '顯示'], ['false', '隱藏']])}</div>
      <div class="set-h">我的註記</div>
      <div class="set-row"><span class="l">劃線註記顯示<small>行間：紅色小字在文字上方或下方；旁註：在條文右側；點選：點文字才顯示</small></span>${seg('side', [['inter', '行間'], ['side', '旁註'], ['tap', '點選']])}</div>
      <div class="set-row"><span class="l">新註記預設位置</span>${seg('notePos', [['up', '文字上方'], ['down', '文字下方']])}</div>
      <div class="set-row"><span class="l">隱藏註記時一併隱藏</span><span class="chk-row">
        <label><input type="checkbox" data-chk="hideInk"${settings.hideInk ? ' checked' : ''}> 手寫</label>
        <label><input type="checkbox" data-chk="hideNote"${settings.hideNote ? ' checked' : ''}> 紅字註記</label>
        <label><input type="checkbox" data-chk="hideStk"${settings.hideStk ? ' checked' : ''}> 便利貼</label>
        <label><input type="checkbox" data-chk="hideHl"${settings.hideHl ? ' checked' : ''}> 螢光劃線</label></span></div>
      <div class="set-row"><span class="l">觸碰切換<small>隱藏時點一下條文即顯示該條註記，再點一下隱藏；任何時候雙指輕點條文也可切換</small></span>${seg('tapReveal', [['true', '開啟'], ['false', '關閉']])}</div>
      <div class="set-row"><span class="l">Apple Pencil 隨時書寫<small>不必先開手寫模式；手指仍用來捲動、選取文字</small></span><span class="segs" role="group"><button type="button" data-pencil="true" aria-pressed="${settings.pen.pencil}">開啟</button><button type="button" data-pencil="false" aria-pressed="${!settings.pen.pencil}">關閉</button></span></div>
      <div class="set-h">備份（註記只存在這台裝置）</div>
      <div class="set-row"><span class="l">目前共有 ${n} 條有註記<small>儲存方式：${store.storageMode() === 'idb' ? 'IndexedDB' : store.storageMode() === 'ls' ? 'localStorage' : '暫存（關閉後消失）'}</small></span>
        <span class="row-actions"><button type="button" class="btn small" data-act="export">匯出備份</button><button type="button" class="btn small" data-act="copy-export">複製</button></span></div>
      <div class="set-row"><span class="l">匯入備份<small>可選檔案或貼上 JSON（也可匯入舊版「民法註記本」備份）</small></span>
        <span class="row-actions"><label class="btn small" for="imp-file">選擇檔案</label><input type="file" id="imp-file" accept=".json,application/json" hidden></span></div>
      <textarea class="json" id="imp-text" placeholder="或在此貼上備份 JSON"></textarea>
      <div class="row-actions" style="margin-top:8px"><button type="button" class="btn small" data-act="imp-merge">合併匯入</button><button type="button" class="btn small" data-act="imp-replace">取代現有註記</button></div>
      <div class="set-h">資料</div>
      <div class="meta-list">${REG.laws.map((l) => { const LD = LAWS.get(l.pcode); return `${esc(l.name)}：${LD ? `修正日期 ${roc(LD.meta.modified)}，${LD.versions.length} 個歷次版本` : '尚未載入'}`; }).join('<br>')}<br>
        條文、歷次版本、相關法條與判解（憲法法庭裁判、大法官解釋、判例${rCount ? `，已載入 ${rCount} 筆` : ''}）取自全國法規資料庫（法務部）。<br>
        強制執行法之條旨與「參照」條文為編者整理，僅供參考。<br>
        本工具供學習參考，正式引用請以官方公布之法規與裁判全文為準。</div>
      <div class="row-actions" style="margin-top:10px"><button type="button" class="btn small" data-act="help">使用說明</button></div>
      <div class="set-h">危險區域</div>
      <div class="row-actions"><input class="inp" id="wipe-confirm" placeholder="輸入「清除」以刪除全部註記" style="max-width:260px"><button type="button" class="btn small danger" data-act="wipe">刪除全部註記</button></div>`,
    buttons: [{ label: '完成', cls: 'primary' }],
    onOpen: (body) => {
      body.onchange = (e) => {
        const c = e.target.closest('[data-chk]');
        if (c) { settings[c.dataset.chk] = c.checked; saveSettings(); applyHideFlags(); }
      };
      body.onclick = async (e) => {
        const b = e.target.closest('button');
        if (!b) return;
        if (b.dataset.set) {
          const k = b.dataset.set, v = b.dataset.val;
          settings[k] = ['theme', 'side', 'refs', 'badge', 'notePos'].includes(k) ? v : k === 'lh' ? +v : v === 'true';
          $$(`[data-set="${k}"]`, body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          saveSettings(); applySettings();
          if (['chips', 'pn', 'side', 'refs', 'rulUnder', 'badge'].includes(k)) { renderReader(); renderTOC(); if (current) renderDetail(); }
        } else if (b.dataset.pencil) {
          settings.pen.pencil = b.dataset.pencil === 'true';
          $$('[data-pencil]', body).forEach((x) => x.setAttribute('aria-pressed', x === b ? 'true' : 'false'));
          saveSettings(); syncInkbar();
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
        } else if (b.dataset.act === 'help') {
          showHelp();
        } else if (b.dataset.act === 'wipe') {
          if ($('#wipe-confirm').value.trim() !== '清除') { toast('請先輸入「清除」'); return; }
          await store.clearAll(); notes.clear(); saveSettings();
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
function showHelp() {
  settings.seenHelp = true;
  saveSettings();
  modal({
    title: '使用說明',
    body: `<ul class="help">
      <li><b>切換法律</b>：上方「強執／民訴／民法」。搜尋可跨法律，輸入「民訴402」「強執4-1」直接跳轉。</li>
      <li><b>條號</b>：依章節以顏色反白，下方括號為條旨。點條號開啟判解、新舊對照、立法理由與我的註記。</li>
      <li><b>引用條文</b>：條文中的「第○條」可點，同法直接跳過去；他法（如民法、民事訴訟法）會跳出條文內容，條文下方也以小字列出。</li>
      <li><b>紅字註記</b>：選取文字 →「紅字↑」或「紅字↓」，註記以紅色小字放在那段文字的上方或下方。也可只用螢光筆劃線。</li>
      <li><b>Apple Pencil</b>：直接在條文上書寫（設定中可關閉）。按右上筆形按鈕開啟工具列，可選顏色、螢光筆、橡皮擦，筆寬最細 0.05 mm；開啟「手指」可用手指書寫。</li>
      <li><b>便利貼</b>：按上方便利貼按鈕，再點條文要貼的位置。拖曳上緣移動、拖右下角縮放，「⋯」可換色、調透明度。</li>
      <li><b>顯示／隱藏</b>：右上眼睛按鈕隱藏或顯示全部「我的註記」；隱藏時點一下條文即可單獨顯示，雙指輕點條文可隨時切換該條；條號旁「註記」標籤也可切換。</li>
      <li><b>備份</b>：註記存在這台 iPad 的瀏覽器裡，請定期在設定中匯出備份。</li></ul>`,
    buttons: [{ label: '開始使用', cls: 'primary', onClick: () => { settings.seenHelp = true; saveSettings(); } }],
  });
}

// ---------------------------------------------------------------------------
// 手寫
// ---------------------------------------------------------------------------
let ink, stickies;
function setInk(on) {
  ink.setActive(on);
  $('#btn-ink').setAttribute('aria-pressed', on ? 'true' : 'false');
  $('#inkbar').hidden = !on;
  if (on) {
    stickies.setPlacing(false);
    hidePop(); window.getSelection()?.removeAllRanges();
    syncInkbar();
  }
}
function syncInkbar() {
  const o = settings.pen;
  const bar = $('#inkbar');
  $$('[data-tool]', bar).forEach((b) => b.setAttribute('aria-pressed', b.dataset.tool === o.tool ? 'true' : 'false'));
  const marker = o.tool === 'marker';
  const colors = marker ? MARK_COLORS : PEN_COLORS;
  const curc = marker ? o.markColor : o.color;
  $('#ink-colors').innerHTML = o.tool === 'eraser' ? '<span class="ink-hint-inline">點或劃過筆畫即可擦除</span>' :
    colors.map(([c, l]) => `<button class="sw" data-c="${c}" style="--sw:var(--pen-${c})" aria-pressed="${c === curc}" title="${l}" aria-label="${l}"></button>`).join('');
  const mm = marker ? o.markMM : o.mm;
  const rng = $('#ink-width');
  rng.min = marker ? 1 : 0.05; rng.max = marker ? 8 : 3; rng.step = marker ? 0.25 : 0.05;
  rng.value = mm;
  $('#ink-width-val').textContent = (marker ? mm.toFixed(2).replace(/0$/, '') : mm.toFixed(2)) + ' mm';
  $('#ink-presets').innerHTML = (marker ? [1.5, 2.5, 3.5, 5] : PEN_PRESETS).map((v) => `<button class="pchip" data-mm="${v}" aria-pressed="${Math.abs(v - mm) < 0.001}">${v}</button>`).join('');
  $('#ink-width-row').hidden = o.tool === 'eraser';
  const pv = $('#ink-preview');
  const px = mm * PX_PER_MM;
  pv.style.setProperty('--pw', Math.max(0.5, px) + 'px');
  pv.style.setProperty('--pc', `var(--pen-${curc})`);
  pv.classList.toggle('marker', marker);
  $('[data-act="pressure"]', bar).setAttribute('aria-pressed', o.pressure ? 'true' : 'false');
  $('[data-act="pressure"]', bar).hidden = marker || o.tool === 'eraser';
  $('[data-act="finger"]', bar).setAttribute('aria-pressed', o.finger ? 'true' : 'false');
  $('[data-act="pencil"]', bar).setAttribute('aria-pressed', o.pencil ? 'true' : 'false');
  document.body.classList.toggle('finger', o.finger);
}
function bindInkbar() {
  const bar = $('#inkbar');
  const o = settings.pen;
  bar.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.tool) o.tool = b.dataset.tool;
    else if (b.dataset.c) { if (o.tool === 'marker') o.markColor = b.dataset.c; else o.color = b.dataset.c; }
    else if (b.dataset.mm) { if (o.tool === 'marker') o.markMM = +b.dataset.mm; else o.mm = +b.dataset.mm; }
    else if (b.dataset.act === 'undo') { if (!ink.undo()) toast('沒有可復原的筆畫'); return; }
    else if (b.dataset.act === 'redo') { if (!ink.redo()) toast('沒有可重做的筆畫'); return; }
    else if (b.dataset.act === 'pressure') o.pressure = !o.pressure;
    else if (b.dataset.act === 'finger') { o.finger = !o.finger; toast(o.finger ? '手指也可書寫（捲動請用兩指）' : '只有 Apple Pencil 可書寫'); }
    else if (b.dataset.act === 'pencil') { o.pencil = !o.pencil; toast(o.pencil ? '不在手寫模式時，Apple Pencil 也可直接書寫' : 'Apple Pencil 只在手寫模式中書寫'); }
    else if (b.dataset.act === 'done') { setInk(false); return; }
    else return;
    saveSettings(); syncInkbar();
  });
  $('#ink-width').addEventListener('input', (e) => {
    const v = +e.target.value;
    if (o.tool === 'marker') o.markMM = v; else o.mm = v;
    saveSettings(); syncInkbar();
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
  $('#btn-eye').onclick = () => setShowMine(!settings.showMine);
  $('#btn-stk').onclick = () => {
    const on = !stickies.placing;
    if (on && ink.active) setInk(false);
    stickies.setPlacing(on);
    $('#btn-stk').setAttribute('aria-pressed', on ? 'true' : 'false');
    if (on) toast('點條文上要貼便利貼的位置');
  };
  $('#law-seg').onclick = (e) => { const b = e.target.closest('[data-law]'); if (b) switchLaw(b.dataset.law); };
  $('#d-close').onclick = closeDetail;
  $('#d-prev').onclick = () => { const i = L.order.indexOf(current); if (i > 0) gotoArticle(L.order[i - 1], { flash: false }); };
  $('#d-next').onclick = () => { const i = L.order.indexOf(current); if (i < L.order.length - 1) gotoArticle(L.order[i + 1], { flash: false }); };
  $('#d-star').onclick = () => {
    const k = keyOf(cur, current);
    const r = getRec(k, true);
    r.star = !r.star;
    saveRec(k); refreshChips(current);
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
    const j = parseJump(q.value);
    if (j && isBundled(j.pc)) {
      loadLaw(j.pc).then((LD) => { if (LD.byId.has(j.aid)) { goRef(j.pc, j.aid); q.blur(); } else { showSide('search'); doSearch(q.value); setSide(true); } });
      return;
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
    if (tg || (kids && kids.hidden && L.headings[hi].lv === 0 && L.headings.some((h) => h.p === hi && h.first === L.headings[hi].first))) {
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
      const [pc, aid] = b.dataset.goto.split('|');
      if (b.dataset.tab) detailTab = b.dataset.tab;
      goRef(pc, aid);
    });
  }

  // 閱讀區
  const reader = $('#reader');
  reader.addEventListener('scroll', () => { trackScroll(); if (!$('#hl-pop').hidden && !pendingSel) hidePop(); hideRefPop(); $('#stk-pop').hidden = true; }, { passive: true });
  const clickArticle = (e) => {
    const pad = e.target.closest('[data-pad]');
    if (pad) {
      const k = keyOf(cur, pad.dataset.aid);
      const r = getRec(k, true);
      r.pad = Math.max(0, Math.min(60, (r.pad || 0) + 4 * +pad.dataset.pad));
      if (!r.pad) delete r.pad;
      saveRec(k); refreshArticle(pad.dataset.aid);
      return;
    }
    if (ink.active) return;
    const eye = e.target.closest('[data-eye]');
    if (eye) { toggleArticleMine(eye.dataset.eye); return; }
    const ref = e.target.closest('[data-ref]');
    if (ref && !e.target.closest('.hl[data-hl]')) {
      e.preventDefault();
      const [pc, aid] = ref.dataset.ref.split('|');
      if (pc === cur && ref.tagName === 'A') { gotoArticle(aid); return; }
      showRefPop(ref.getBoundingClientRect(), pc, [aid]);
      return;
    }
    const refs = e.target.closest('[data-refs]');
    if (refs) {
      const [pc, list] = refs.dataset.refs.split('|');
      const aids = list.split(',');
      if (pc === cur && aids.length === 1) { gotoArticle(aids[0]); return; }
      if (pc === cur) { showRefPop(refs.getBoundingClientRect(), pc, aids); return; }
      showRefPop(refs.getBoundingClientRect(), pc, aids);
      return;
    }
    const op = e.target.closest('[data-open]');
    if (op) { openDetail(op.dataset.open, op.dataset.tab); return; }
    const hl = e.target.closest('.hl[data-hl]');
    const sel = window.getSelection();
    if (hl && (!sel || sel.isCollapsed)) {
      const host = hl.closest('[data-key]');
      const rec = getRec(host.dataset.key);
      const h = rec && (rec.hl || []).find((x) => x.id === hl.dataset.hl);
      if (host.classList.contains('mine-hidden') && settings.hideHl) { /* 已隱藏：當作點條文 */ }
      else {
        activeHl = { k: host.dataset.key, aid: host.dataset.id, id: hl.dataset.hl };
        pendingSel = null;
        showPop(hl.getBoundingClientRect(), true, h);
        return;
      }
    }
    const sn = e.target.closest('[data-sn]');
    if (sn) { const host = sn.closest('[data-key]'); editHlNote(host.dataset.key, host.dataset.id, sn.dataset.sn); return; }
    const ann = e.target.closest('.ann[data-ann]');
    if (ann) { const host = ann.closest('[data-key]'); editHlNote(host.dataset.key, host.dataset.id, ann.dataset.ann); return; }
    // 觸碰切換：隱藏中的條文點一下即顯示
    const art = e.target.closest('.art');
    if (art && settings.tapReveal && (!sel || sel.isCollapsed) && !e.target.closest('button, a, input, textarea, .sticky')) {
      const k = art.dataset.key;
      if (hasMine(notes.get(k)) && (art.classList.contains('mine-hidden') || override.get(k) === true)) toggleArticleMine(art.dataset.id);
    }
  };
  reader.addEventListener('click', clickArticle);
  $('#d-text').addEventListener('click', clickArticle);

  // 雙指輕點：切換該條註記
  let two = null;
  reader.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) {
      const [a, b] = e.touches;
      two = { t: performance.now(), x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2, pts: [[a.clientX, a.clientY], [b.clientX, b.clientY]], moved: false };
    } else if (e.touches.length > 2) two = null;
  }, { passive: true });
  reader.addEventListener('touchmove', (e) => {
    if (!two) return;
    for (let i = 0; i < Math.min(2, e.touches.length); i++) {
      const t = e.touches[i];
      if (Math.min(...two.pts.map(([x, y]) => Math.hypot(t.clientX - x, t.clientY - y))) > 12) two.moved = true;
    }
  }, { passive: true });
  reader.addEventListener('touchend', (e) => {
    if (!two || e.touches.length) return;
    const t = two; two = null;
    if (t.moved || performance.now() - t.t > 350) return;
    const el = document.elementFromPoint(t.x, t.y);
    const art = el && el.closest('.art');
    if (art && hasMine(notes.get(art.dataset.key))) toggleArticleMine(art.dataset.id);
  }, { passive: true });

  document.addEventListener('selectionchange', onSelChange);
  $('#hl-pop').addEventListener('pointerdown', (e) => e.preventDefault());
  $('#hl-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-hl]');
    if (b) applyHighlight(b.dataset.hl);
  });
  $('#ref-pop').addEventListener('click', (e) => {
    const b = e.target.closest('[data-go]');
    if (!b) return;
    const [pc, aid] = b.dataset.go.split('|');
    hideRefPop();
    goRef(pc, aid);
  });
  $('#stk-pop').addEventListener('input', (e) => {
    const pop = $('#stk-pop');
    if (e.target.matches('[data-sop]')) {
      const v = +e.target.value;
      const st = document.querySelector(`.art[data-key="${CSS.escape(pop.dataset.key)}"] .sticky[data-stk="${pop.dataset.id}"]`);
      if (st) st.style.setProperty('--op', v);
      const r = getRec(pop.dataset.key, true);
      const s = (r.stk || []).find((x) => x.id === pop.dataset.id);
      if (s) { s.op = v; saveRecLater(pop.dataset.key); }
    }
  });
  $('#stk-pop').addEventListener('click', (e) => {
    const pop = $('#stk-pop');
    const b = e.target.closest('button');
    if (!b) return;
    const k = pop.dataset.key, id = pop.dataset.id;
    if (b.dataset.sc) { stickies.update(k, id, { c: b.dataset.sc }); $$('[data-sc]', pop).forEach((x) => x.classList.toggle('on', x === b)); }
    else if (b.dataset.sa === 'del') { stickies.update(k, id, null); pop.hidden = true; toast('已刪除便利貼'); }
    else if (b.dataset.sa === 'edit') {
      pop.hidden = true;
      const st = document.querySelector(`.art[data-key="${CSS.escape(k)}"] .sticky[data-stk="${id}"]`);
      if (st) { const r = getRec(k); const s = r.stk.find((x) => x.id === id); if (s && s.min) { stickies.update(k, id, { min: false }); } stickies.edit(document.querySelector(`.art[data-key="${CSS.escape(k)}"] .sticky[data-stk="${id}"]`)); }
    }
  });
  document.addEventListener('pointerdown', (e) => {
    if (!$('#hl-pop').hidden && !e.target.closest('#hl-pop') && !e.target.closest('.hl')) {
      setTimeout(() => { const s = window.getSelection(); if (!s || s.isCollapsed) hidePop(); }, 10);
    }
    if (!$('#ref-pop').hidden && !e.target.closest('#ref-pop') && !e.target.closest('[data-ref], [data-refs]')) hideRefPop();
    if (!$('#stk-pop').hidden && !e.target.closest('#stk-pop') && !e.target.closest('[data-sact="menu"]')) $('#stk-pop').hidden = true;
  });

  // 詳細面板內容
  $('#d-body').addEventListener('click', (e) => {
    const b = e.target.closest('button, [data-ref]');
    if (!b) return;
    if (b.dataset.ref) {
      e.preventDefault();
      const [pc, aid] = b.dataset.ref.split('|');
      if (pc === cur) gotoArticle(aid); else showRefPop(b.getBoundingClientRect(), pc, [aid]);
      return;
    }
    if (b.dataset.rf) { rulFilter = b.dataset.rf; renderDetail(); return; }
    if (b.dataset.cm) { cmpMode = b.dataset.cm; renderHistory($('#d-body')); return; }
    if (b.dataset.cmp) { const i = +b.dataset.cmp; cmpSel = { aid: current, a: i - 1, b: i }; renderHistory($('#d-body')); return; }
    if (b.dataset.npos) {
      const k = keyOf(cur, current);
      const r = getRec(k, true);
      r.notePos = b.dataset.npos;
      saveRec(k); refreshArticle(current); renderDetail();
      return;
    }
    if (b.dataset.color !== undefined && b.classList.contains('cs')) {
      const k = keyOf(cur, current);
      const r = getRec(k, true);
      if (b.dataset.color) r.color = b.dataset.color; else delete r.color;
      saveRec(k); refreshArticle(current); renderDetail();
      return;
    }
    const card = b.closest('.rcard');
    const act = b.dataset.act;
    const k = keyOf(cur, current);
    if (act === 'add-item') editItem(current);
    else if (act === 'imp' && card) {
      const r = getRec(k, true);
      r.imp = r.imp || {};
      const key = card.dataset.key;
      if (r.imp[key]) delete r.imp[key]; else r.imp[key] = 1;
      saveRec(k); renderDetail(); refreshArticle(current);
    } else if (act === 'expand' && card) {
      $$('.rpart.clamp', card).forEach((p) => p.classList.remove('clamp'));
      b.remove();
    } else if (act === 'rnote' && card) editRulingNote(current, card.dataset.key);
    else if (act === 'edit-item' && card) {
      const id = card.dataset.key.slice(2);
      editItem(current, (getRec(k).items || []).find((x) => x.id === id));
    } else if (act === 'rm-tag') {
      const r = getRec(k, true);
      r.tags = (r.tags || []).filter((t) => t !== b.dataset.tag);
      saveRec(k); renderDetail();
    } else if (act === 'cap-reset') {
      const r = getRec(k, true);
      delete r.cap;
      saveRec(k); refreshArticle(current); renderDetail();
    } else if (act === 'hl-note') editHlNote(k, current, b.dataset.id);
    else if (act === 'hl-del') {
      const r = getRec(k, true);
      r.hl = (r.hl || []).filter((h) => h.id !== b.dataset.id);
      afterHlChange(k, current);
    } else if (act === 'stk-del') {
      stickies.update(k, b.dataset.id, null); renderDetail();
    } else if (act === 'stk-add') {
      const art = document.getElementById('a-' + current);
      if (isNarrow() && matchMedia('(max-width: 760px)').matches) closeDetail();
      if (art) { const r = art.getBoundingClientRect(); scrollToEl(art); setTimeout(() => { const r2 = art.getBoundingClientRect(); stickies.create(art, r2.left + r2.width * 0.55, r2.top + 40); if (current) renderDetail(); }, 260); }
    } else if (act === 'why') editWhy(current, b.dataset.d);
    else if (act === 'cmp-from-why') { const i = +b.dataset.i; detailTab = 'history'; cmpSel = { aid: current, a: i - 1, b: i }; renderDetail(); cmpSel = { aid: current, a: i - 1, b: i }; renderHistory($('#d-body')); }
    else if (act === 'ink-on') {
      setInk(true);
      if (isNarrow() && matchMedia('(max-width: 760px)').matches) closeDetail();
      gotoArticle(current, { open: false });
    } else if (act === 'ink-clear') { ink.clear(k); toast('已清除，可按「復原」還原'); }
  });
  $('#d-body').addEventListener('change', (e) => {
    if (e.target.id === 'cmp-a' || e.target.id === 'cmp-b') {
      cmpSel[e.target.id === 'cmp-a' ? 'a' : 'b'] = +e.target.value;
      renderHistory($('#d-body'));
    }
  });

  window.addEventListener('hashchange', () => {
    const h = parseHash();
    if (h && (h.pc !== cur || (h.aid && h.aid !== current))) switchLaw(h.pc, { aid: h.aid });
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#ref-pop').hidden) hideRefPop();
      else if (!$('#hl-pop').hidden) hidePop();
      else if (stickies.placing) { stickies.setPlacing(false); $('#btn-stk').setAttribute('aria-pressed', 'false'); }
      else if (ink.active) setInk(false);
      else if (current) closeDetail();
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'f') { e.preventDefault(); $('#q').focus(); }
    if ((e.metaKey || e.ctrlKey) && e.key === 'z' && ink.active) { e.preventDefault(); if (e.shiftKey) ink.redo(); else ink.undo(); }
  });
  matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', () => ink.redrawAll());
  const ro = new ResizeObserver(debounce(() => relayoutVisible(), 120));
  ro.observe($('#reader-inner'));
  ro.observe($('#d-text'));
}
const saveRecLater = debounce((k) => saveRec(k), 400);

function parseHash() {
  const h = decodeURIComponent(location.hash.slice(1));
  let m = h.match(/^([A-Z]\d{7})(?:\/(\d+(?:-\d+)?))?$/);
  if (m && isBundled(m[1])) return { pc: m[1], aid: m[2] || null };
  m = h.match(/^a-(\d+(?:-\d+)?)$/); // 舊版民法註記本
  if (m) return { pc: 'B0000001', aid: m[1] };
  return null;
}

// ---------------------------------------------------------------------------
// 啟動
// ---------------------------------------------------------------------------
async function boot() {
  let saved;
  try {
    const [reg, xr, sv] = await Promise.all([
      fetch('data/laws.json').then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); }),
      fetch('data/xref.json').then((r) => (r.ok ? r.json() : null)).catch(() => null),
      store.getAll().catch(() => ({})),
    ]);
    REG = reg;
    if (xr) XR = xr;
    saved = sv;
  } catch (e) {
    $('#loading').textContent = '無法載入資料：' + e.message;
    return;
  }
  // 舊版「民法註記本」的註記（a:條號）改存為 n:B0000001:條號
  for (const [k, v] of Object.entries(saved)) {
    if (k.startsWith('n:')) notes.set(k.slice(2), v);
    else if (k === 'settings') settings = { ...structuredClone(DEFAULTS), ...v, pen: { ...DEFAULTS.pen, ...(v.pen || {}) }, pos: v.pos || {} };
  }
  for (const [k, v] of Object.entries(saved)) {
    if (!k.startsWith('a:')) continue;
    const nk = keyOf('B0000001', k.slice(2));
    if (!notes.has(nk)) { notes.set(nk, v); store.put('n:' + nk, v).catch(() => {}); }
    store.del(k).catch(() => {});
  }
  const names = { ...XR.names };
  for (const l of REG.laws) { names[l.name] = l.pcode; for (const a of l.aliases || []) names[a] = l.pcode; }
  finder = new RefFinder(names);

  ink = new Ink({
    root: $('#reader'),
    getRec, saveRec: (k) => saveRec(k),
    opts: settings.pen,
    onStart: (k) => { if (isHidden(k) && hasMine(notes.get(k))) { override.set(k, true); updateHidden(k.split(':')[1]); } },
    onChange: (k) => {
      const aid = k.split(':')[1];
      const el = document.getElementById('a-' + aid);
      if (el) el.classList.toggle('mine-hidden', hasMine(notes.get(k)) && isHidden(k));
      refreshChips(aid);
      if (current === aid && detailTab === 'notes') renderDetail();
    },
  });
  stickies = new Stickies({
    root: $('#reader'),
    getRec, saveRec: (k) => saveRec(k), toast,
    menu: showStkMenu,
    onChange: (k) => {
      const aid = k.split(':')[1];
      revealIfHidden(k);
      refreshChips(aid);
      $('#btn-stk').setAttribute('aria-pressed', 'false');
      if (current === aid && detailTab === 'notes') renderDetail();
    },
  });

  const h = parseHash();
  const main = (REG.laws.find((l) => l.main) || REG.laws[0]).pcode;
  const first = (h && h.pc) || (settings.lastLaw && isBundled(settings.lastLaw) ? settings.lastLaw : main);
  bind();
  bindInkbar();
  applySettings();
  await switchLaw(first, h && h.aid ? { aid: h.aid } : {});
  doSearch('');
  // 其他法律於背景載入（供引用小字、跨法搜尋）
  Promise.all(REG.laws.filter((l) => l.pcode !== first).map((l) => loadLaw(l.pcode).catch(() => null))).then(() => refreshRefs());
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => relayoutVisible(true));
  if (!settings.seenHelp) setTimeout(showHelp, 600);

  store.persist();
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) {
    navigator.serviceWorker.register('sw.js').catch(() => {});
  }
}
boot();
