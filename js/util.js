// 共用小工具
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
export const uid = () => Math.random().toString(36).slice(2, 9);

export function aidLabel(aid) {
  const [a, b] = String(aid).split('-');
  return b ? `第${a}條之${b}` : `第${a}條`;
}
export function aidShort(aid) {
  return '§' + aid;
}
export function roc(d, short) {
  if (!d) return '';
  const y = +d.slice(0, 4) - 1911, m = d.slice(4, 6), dd = d.slice(6, 8);
  return short ? `${y}.${m}.${dd}` : `民國${y}年${+m}月${+dd}日`;
}

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

export function aidKey(aid) {
  const [a, b] = String(aid).split('-');
  return (+a) * 1000 + (+b || 0);
}
