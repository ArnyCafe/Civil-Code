// 條文引用解析：找出「第○條」「本條例第○條」「勞動基準法第○條、第○條及第○條」「同法第○條」「前條」
const CN = { 零: 0, 〇: 0, 一: 1, 二: 2, 兩: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
export function cnNum(s) {
  s = String(s).trim();
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

const N = '(?:[零〇一二三四五六七八九十百千]+|\\s*\\d+\\s*)';
const ART = new RegExp(`第\\s*(${N})\\s*條(?:\\s*之\\s*(${N}))?`, 'y');
const QUAL = new RegExp(`(?:\\s*第\\s*${N}\\s*項)?(?:\\s*第\\s*${N}\\s*款)?(?:\\s*第\\s*${N}\\s*目)?(?:前段|後段|但書|本文|序文)?`, 'y');
const SEP = /(?:、|，|以及|及|與|或|和|暨|至)/y;
const ALIAS_RE = /^（以下簡稱[^）]*）/;
const LAWISH = /[法則例程典約]$/;

function matchAt(re, text, i) { re.lastIndex = i; const m = re.exec(text); return m && m.index === i ? m : null; }
const aidOf = (m) => (m[2] ? `${cnNum(m[1])}-${cnNum(m[2])}` : String(cnNum(m[1])));

// ctx = { self, names: [[名稱, key]]（長者在前）, aliases: {本條例: 'lpa'}, prev, last }
// 回傳 [{s, e, key, aid}]；ctx.last 會記住最近提到的法律，供「同法」使用
export function findRefs(text, ctx) {
  const out = [];
  const chain = (i, key) => {
    let j = i;
    for (;;) {
      const m = matchAt(ART, text, j);
      if (!m) break;
      out.push({ s: j, e: j + m[0].length, key, aid: aidOf(m) });
      j += m[0].length;
      const q = matchAt(QUAL, text, j);
      if (q) j += q[0].length;
      const sp = matchAt(SEP, text, j);
      if (!sp || !matchAt(ART, text, j + sp[0].length)) break;
      j += sp[0].length;
    }
    return j;
  };
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    // 「同法」「同條例」
    if ((ch === '同') && ctx.last && (text.startsWith('同法', i) || text.startsWith('同條例', i))) {
      const ln = text.startsWith('同法', i) ? 2 : 3;
      if (matchAt(ART, text, i + ln)) { i = Math.max(i + 1, chain(i + ln, ctx.last)); continue; }
    }
    // 本法、本條例、本細則
    let hit = null;
    for (const [a, key] of Object.entries(ctx.aliases || {})) if (text.startsWith(a, i)) { hit = [a, key]; break; }
    if (!hit) for (const nk of ctx.names) if (text.startsWith(nk[0], i)) { hit = nk; break; }
    if (hit) {
      let j = i + hit[0].length;
      const am = text.slice(j).match(ALIAS_RE);
      if (am) j += am[0].length;
      if (hit[1] !== ctx.self) ctx.last = hit[1];
      if (matchAt(ART, text, j)) { i = Math.max(i + 1, chain(j, hit[1])); continue; }
      i += hit[0].length;
      continue;
    }
    if (ch === '第') {
      const m = matchAt(ART, text, i);
      if (m) {
        const before = text.slice(Math.max(0, i - 1), i);
        // 前面緊接未知的法規名稱（如「私立學校法第○條」）時不連結
        if (LAWISH.test(before)) { i += m[0].length; continue; }
        i = Math.max(i + 1, chain(i, ctx.self));
        continue;
      }
    }
    if (ch === '前' && text.startsWith('前條', i) && ctx.prev) {
      out.push({ s: i, e: i + 2, key: ctx.self, aid: ctx.prev });
      i += 2;
      continue;
    }
    i++;
  }
  return out;
}
