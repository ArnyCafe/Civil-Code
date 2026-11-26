// 行間註記排版：註記以紅色小字放在被註記文字的上方或下方。
// 做法：在被註記文字的首字前、末字後各放一個寬度為 0 的 inline-block「撐高點」(.gs)，
// 量測文字位置後，把該行的行框撐高到足以容納註記，再把註記 (.gl) 絕對定位到該行上方或下方。
// 撐高點寬度為 0，不影響每行的斷行位置，因此量測後再撐高不會改變水平位置。

const GAP = 1.5; // 註記與文字的間距（px）

function lineHeightOf(el) {
  const cs = getComputedStyle(el);
  const lh = parseFloat(cs.lineHeight);
  return Number.isFinite(lh) ? lh : parseFloat(cs.fontSize) * 1.9;
}

function textRects(blk, id) {
  const s0 = blk.querySelector(`.gs[data-s="${id}"]`);
  const s1 = blk.querySelector(`.gs[data-e="${id}"]`);
  if (!s0 || !s1) return null;
  const r = document.createRange();
  try { r.setStartAfter(s0); r.setEndBefore(s1); } catch { return null; }
  const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0.5 && x.height > 0.5);
  return rects.length ? { rects, s0, s1 } : null;
}

// blk：含 .gl-layer 的區塊（position: relative）；hidden(id) 回傳該註記是否不顯示
export function layoutBlock(blk, hidden) {
  const layer = blk.querySelector(':scope > .gl-layer');
  if (!layer) return;
  const struts = blk.querySelectorAll('.gs');
  for (const s of struts) { s.style.height = ''; s.style.verticalAlign = ''; }
  const boxes = Array.from(layer.children);
  if (!boxes.length) return;
  for (const g of boxes) g.hidden = !!hidden(g.dataset.g);
  const vis = boxes.filter((g) => !g.hidden);
  if (!vis.length) return;
  if (!blk.offsetParent && getComputedStyle(blk).position !== 'fixed') return; // 未顯示

  const W = blk.clientWidth;
  let b = blk.getBoundingClientRect();
  const lhHost = blk.querySelector('.pt, .rt') || blk;
  const L = lineHeightOf(lhHost);

  // 第一階段：量測寬高與所在行
  const items = [];
  for (const g of vis) {
    const t = textRects(blk, g.dataset.g);
    if (!t) { g.hidden = true; continue; }
    const below = g.dataset.pos === 'below';
    const lr = below ? t.rects[t.rects.length - 1] : t.rects[0];
    g.style.left = '0px'; g.style.top = '0px';
    g.style.maxWidth = Math.max(60, W) + 'px';
    const w = Math.min(g.offsetWidth, W), h = g.offsetHeight;
    const base = (below ? t.s1 : t.s0).getBoundingClientRect().top; // 高度 0 的 inline-block 頂端即基線
    items.push({ g, id: g.dataset.g, below, lr, w, h, base, x: lr.left - b.left, key: (below ? 'b' : 'a') + Math.round(below ? lr.bottom : lr.top), s0: t.s0, s1: t.s1 });
  }

  // 同一行、同一側的註記水平排列，重疊時往外堆疊
  const groups = new Map();
  for (const it of items) { if (!groups.has(it.key)) groups.set(it.key, []); groups.get(it.key).push(it); }
  for (const grp of groups.values()) {
    grp.sort((p, q) => p.x - q.x);
    const placed = [];
    for (const it of grp) {
      it.x = Math.max(0, Math.min(it.x, W - it.w));
      let y = 0, moved = true;
      while (moved) {
        moved = false;
        for (const p of placed) {
          if (p.x < it.x + it.w + 4 && it.x < p.x + p.w + 4 && p.y < y + it.h && y < p.y + p.h) { y = p.y + p.h + 1; moved = true; }
        }
      }
      it.y = y;
      placed.push(it);
    }
    grp.need = Math.max(...grp.map((i) => i.y + i.h)) + GAP * 2;
  }

  // 第二階段：撐高行框（只使用本行自己那一半的行距，避免與相鄰行的註記重疊）
  for (const grp of groups.values()) {
    const it = grp[0];
    const half = Math.max(0, (L - it.lr.height) / 2);
    const extra = Math.max(0, grp.need - half);
    if (!it.below) {
      const h = it.base - it.lr.top + half + extra;
      it.s0.style.height = Math.max(0, h).toFixed(2) + 'px';
    } else {
      const x = it.lr.bottom - it.base + half + extra;
      it.s1.style.height = Math.max(0, x).toFixed(2) + 'px';
      it.s1.style.verticalAlign = (-Math.max(0, x)).toFixed(2) + 'px';
    }
  }

  // 第三階段：依撐高後的位置放置註記
  b = blk.getBoundingClientRect();
  for (const it of items) {
    const t = textRects(blk, it.id);
    if (!t) continue;
    const lr = it.below ? t.rects[t.rects.length - 1] : t.rects[0];
    const top = it.below ? lr.bottom - b.top + GAP + it.y : lr.top - b.top - GAP - it.y - it.h;
    it.g.style.left = it.x.toFixed(1) + 'px';
    it.g.style.top = top.toFixed(1) + 'px';
  }
}

export function layoutAll(root, hidden) {
  for (const blk of root.querySelectorAll('.gblk')) layoutBlock(blk, (id) => hidden(blk, id));
}
