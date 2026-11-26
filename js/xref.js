// 條文引用解析（與 tools/xref.py 同一規則）
//  「本法第六條第一項、第十六條」→ 本法（子法中之「本法」指母法）
//  「勞動基準法第五十九條」「勞基法第59條」→ 書架上的其他法典
//  「同法第三條」→ 前一個被引用的法典；「第八條及第九條」（未冠法名）→ 本法典自身
//  「前條」「次條」→ 前／後一條
const CNUM = '零〇一二三四五六七八九十百千';
const NUM = `(?:\\d+|[${CNUM}]+)`;
const ART = `第\\s*(${NUM})\\s*條(?:\\s*之\\s*(${NUM}))?`;
const SUB = `(?:第\\s*${NUM}\\s*(?:項|款|目))*(?:前段|後段|但書|本文)?`;
const SEP = '(?:、|及|或|與|和|至|暨|以及)';
const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };

export function cnNum(s) {
  if (/^\d+$/.test(s)) return +s;
  let total = 0, cur = 0;
  for (const ch of s) {
    if (ch in CN) cur = CN[ch];
    else if (ch === '十') { total += (cur || 1) * 10; cur = 0; }
    else if (ch === '百') { total += (cur || 1) * 100; cur = 0; }
    else if (ch === '千') { total += (cur || 1) * 1000; cur = 0; }
  }
  return total + cur;
}

const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function makeResolver(lib) {
  const names = [];
  for (const e of lib) for (const a of [...(e.alias || []), e.name]) names.push([a, e.id]);
  names.sort((a, b) => b[0].length - a[0].length);
  const byAlias = new Map(names);
  const parent = new Map(lib.map((e) => [e.id, e.parent]));
  const alias = names.map(([a]) => reEsc(a)).join('|');
  const pre = new RegExp(`(${alias}|本法|本細則|本規則|本辦法|本標準|本準則|同法|同細則|同規則)?(?:（(?:以下)?簡稱[^）]{1,10}）)?\\s*(${ART})(\\s*${SUB}(?:\\s*${SEP}\\s*(?:${ART})?\\s*${SUB})*)`, 'g');
  const artRe = new RegExp(ART, 'g');
  const relRe = /前條|次條/g;
  const own = new Set(['本細則', '本規則', '本辦法', '本標準', '本準則']);

  // 回傳 [{s, e, law, aid}]
  return function refs(text, law, aid, order) {
    const out = [];
    let last = null;
    pre.lastIndex = 0;
    let m;
    while ((m = pre.exec(text))) {
      const p = m[1];
      const before = text.slice(Math.max(0, m.index - 6), m.index);
      let target;
      if (p === '本法') target = parent.get(law) || law;
      else if (own.has(p)) target = law;
      else if (p && p.startsWith('同')) target = last || law;
      else if (p) target = byAlias.get(p);
      else {
        if (/[法則例程準]$/.test(before) && !/本法$/.test(before)) continue;
        target = law;
      }
      last = target;
      const segStart = m.index + m[0].indexOf(m[2]);
      const seg = text.slice(segStart, m.index + m[0].length);
      artRe.lastIndex = 0;
      let a;
      while ((a = artRe.exec(seg))) {
        const n = cnNum(a[1]);
        out.push({ s: segStart + a.index, e: segStart + a.index + a[0].length, law: target, aid: a[2] ? `${n}-${cnNum(a[2])}` : String(n) });
      }
    }
    if (order && aid) {
      const i = order.indexOf(aid);
      if (i >= 0) {
        relRe.lastIndex = 0;
        while ((m = relRe.exec(text))) {
          const j = m[0] === '前條' ? i - 1 : i + 1;
          if (j >= 0 && j < order.length) out.push({ s: m.index, e: m.index + 2, law, aid: order[j] });
        }
      }
    }
    return out.sort((x, y) => x.s - y.s);
  };
}

// 使用者輸入的條號：「6」「15-1」「第十五條之一」「勞基法59」「勞動基準法第59條」
export function parseJump(q, lib) {
  q = q.trim().replace(/\s+/g, '');
  let law = null;
  const names = [];
  for (const e of lib) for (const a of [...(e.alias || []), e.name, e.short]) if (a) names.push([a, e.id]);
  names.sort((a, b) => b[0].length - a[0].length);
  for (const [a, id] of names) if (q.startsWith(a)) { law = id; q = q.slice(a.length); break; }
  if (!q) return law ? { law, aid: null } : null;
  let m = q.match(/^(?:§|第)?(\d+)(?:條)?(?:[-之](\d+))?(?:條)?$/);
  if (m) return { law, aid: m[2] ? `${m[1]}-${m[2]}` : m[1] };
  m = q.match(/^第?([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?$/);
  if (m) return { law, aid: m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1])) };
  return null;
}
