// 條文中引用條號的辨識：本法／他法（民法、民事訴訟法…）／同法／前條
import { cnNum } from './util.js';

const NUM = '[零〇一二三四五六七八九十百千\\d]+';
const reEsc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export class RefFinder {
  // names: { 法規名稱或簡稱: pcode }
  constructor(names) {
    this.names = names;
    const list = Object.keys(names).sort((a, b) => b.length - a.length).map(reEsc);
    const law = list.length ? `(${list.join('|')}|本法|同法)?` : '(本法|同法)?';
    this.re = new RegExp(`${law}第\\s*(${NUM})\\s*條(?:之\\s*(${NUM}))?`, 'g');
    this.prevRe = /前([二三四五六七八九]?)條/g;
    // 兩個條號之間只有項、款或連接詞時，沿用前一個條號所屬的法律
    this.gapRe = new RegExp(`^(?:第${NUM}[項款目]|前段|後段|但書|本文|各款|序文|之規定|規定)*(?:[、及或與至暨和]|或第|及第)?$`);
  }

  // mode: 'law'（法條本文，未指明法律者為本法）或 'ruling'（判解，僅連結指明法律者）
  // ctx: { pc, aid, order }
  find(text, mode, ctx) {
    const out = [];
    let lawCtx = null, lastEnd = -1, lastLaw = null;
    this.re.lastIndex = 0;
    let m;
    while ((m = this.re.exec(text))) {
      const nm = m[1];
      let pc = null;
      if (nm) {
        if (nm === '本法') pc = mode === 'law' ? ctx.pc : null;
        else if (nm === '同法') pc = lastLaw || (mode === 'law' ? ctx.pc : null);
        else pc = this.names[nm] || null;
        lawCtx = pc;
        if (nm !== '本法' && pc) lastLaw = pc;
      } else {
        const gap = text.slice(lastEnd, m.index);
        if (lawCtx && lastEnd >= 0 && this.gapRe.test(gap)) pc = lawCtx;
        else { lawCtx = null; pc = mode === 'law' ? ctx.pc : null; }
      }
      lastEnd = m.index + m[0].length;
      if (!pc) continue;
      const aid = m[3] ? `${cnNum(m[2])}-${cnNum(m[3])}` : String(cnNum(m[2]));
      if (pc === ctx.pc && aid === ctx.aid) continue; // 本條
      out.push({ s: m.index, e: lastEnd, pc, aid, named: !!nm && nm !== '本法' });
    }
    if (mode === 'law' && ctx.order) {
      const idx = ctx.order.indexOf(ctx.aid);
      this.prevRe.lastIndex = 0;
      while ((m = this.prevRe.exec(text))) {
        const n = m[1] ? cnNum(m[1]) : 1;
        const t = ctx.order[idx - n];
        if (idx >= 0 && t && !out.some((r) => r.s < m.index + m[0].length && r.e > m.index)) {
          out.push({ s: m.index, e: m.index + m[0].length, pc: ctx.pc, aid: t, prev: true });
        }
      }
    }
    return out.sort((a, b) => a.s - b.s);
  }
}
