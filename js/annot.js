// 行間紅字註記排版：把小字註記放在被註記文字的正上方或正下方。
//
// 條文中被註記的文字前（上方註記）或後（下方註記）有一個寬度 0 的 .slot。
// 排版時把 .slot 撐高，讓該行上方或下方多出剛好放得下註記的空間，
// 再把 .ann（絕對定位）放進那段空間。因 .slot 寬度為 0，不會改變斷行。
const GAP = 6;     // 同一行兩則註記的水平間距（px）
const PAD = 2;     // 註記與條文的垂直間距（px）
const metricsCache = new Map();

function metrics(pt) {
  const cs = getComputedStyle(pt);
  const fs = parseFloat(cs.fontSize) || 18;
  const key = fs + '|' + cs.lineHeight + '|' + cs.fontFamily;
  let m = metricsCache.get(key);
  if (m) return m;
  let L = parseFloat(cs.lineHeight);
  if (!L || cs.lineHeight === 'normal') L = fs * 1.9;
  const probe = document.createElement('i');
  probe.className = 'slot';
  pt.insertBefore(probe, pt.firstChild);
  const dTop = probe.getBoundingClientRect().top - pt.getBoundingClientRect().top;
  probe.remove();
  m = { L, dTop: Math.max(0, dTop) };
  metricsCache.set(key, m);
  return m;
}

export function clearMetrics() { metricsCache.clear(); }

export function resetLayout(container) {
  for (const s of container.querySelectorAll('.slot[data-ann]')) { s.style.height = ''; s.style.verticalAlign = ''; }
  delete container.dataset.lw;
}

// 回傳 true 表示已完成排版
export function layoutAnnotations(container) {
  const layer = container.querySelector(':scope > .ann-layer');
  if (!layer || !layer.children.length) return true;
  const anns = Array.from(layer.children);
  const slots = Array.from(container.querySelectorAll('.slot[data-ann]'));
  for (const s of slots) { s.style.height = ''; s.style.verticalAlign = ''; }
  for (const pn of container.querySelectorAll('.pn[style]')) pn.style.paddingTop = '';
  const W = container.clientWidth;
  if (!W || !container.offsetParent || getComputedStyle(layer).display === 'none') return false;
  const fs = parseFloat(getComputedStyle(container).fontSize) || 18;
  const byId = new Map(anns.map((a) => [a.dataset.ann, a]));
  for (const a of anns) {
    a.style.left = '0px'; a.style.top = '0px'; a.style.width = 'max-content'; a.style.maxWidth = W + 'px';
    a.classList.remove('placed');
  }
  const c0 = container.getBoundingClientRect();
  const groups = [];
  for (const s of slots) {
    const a = byId.get(s.dataset.ann);
    if (!a) continue;
    const r = s.getBoundingClientRect();
    const pt = s.closest('.pt');
    const y = r.top - c0.top;
    let g = groups.find((x) => x.pt === pt && Math.abs(x.y - y) < 3);
    if (!g) {
      const firstBase = pt.getBoundingClientRect().top - c0.top + metrics(pt).dTop;
      g = { pt, y, up: [], down: [], first: Math.abs(y - firstBase) < 3 };
      groups.push(g);
    }
    const pos = s.dataset.pos === 'down' ? 'down' : 'up';
    if (g[pos].some((it) => it.ann === a)) continue;
    const ar = a.getBoundingClientRect();
    // 寬度無條件進位，避免次像素誤差讓最後一個字換行
    g[pos].push({ slot: s, ann: a, x: r.left - c0.left, w: Math.min(W, Math.ceil(ar.width) + 1), h: Math.ceil(ar.height) });
  }
  // 第一輪：決定每則註記的水平位置與列，撐高該行
  for (const g of groups) {
    const m = metrics(g.pt);
    for (const pos of ['up', 'down']) {
      const items = g[pos];
      if (!items.length) continue;
      items.sort((p, q) => p.x - q.x);
      const rows = [];
      for (const it of items) {
        const w = it.w;
        let left = Math.max(0, Math.min(it.x, W - w));
        let row = rows.find((r) => left >= r.right + GAP);
        if (!row) {
          // 往右挪一點即可放進既有的列
          row = rows.find((r) => r.right + GAP + w <= W && r.right + GAP - it.x < W * 0.4);
          if (row) left = row.right + GAP;
        }
        if (!row) { row = { right: 0, h: 0, items: [] }; rows.push(row); }
        row.items.push(it);
        row.right = left + w;
        row.h = Math.max(row.h, it.h);
        it.left = left; it.w2 = w; it.row = row;
      }
      let off = 0;
      for (const r of rows) { r.off = off; off += r.h; }
      const H = off + PAD * 2;
      g[pos + 'H'] = H;
      const slot = pos === 'up' ? items[0].slot : items[items.length - 1].slot;
      g[pos + 'Slot'] = slot;
      if (pos === 'up') {
        slot.style.height = (m.dTop + H) + 'px';
      } else {
        const d = m.L - m.dTop + H;
        slot.style.height = d + 'px';
        slot.style.verticalAlign = (-d) + 'px';
      }
    }
  }
  // 段首那一行上方有註記時，項次（Ⅰ Ⅱ）跟著下移，與文字對齊
  for (const g of groups) {
    if (g.upH && g.first) {
      const pn = g.pt.parentElement && g.pt.parentElement.querySelector(':scope > .pn');
      if (pn) pn.style.paddingTop = g.upH + 'px';
    }
  }
  // 第二輪：依撐高後的位置放上註記
  const c1 = container.getBoundingClientRect();
  for (const g of groups) {
    for (const pos of ['up', 'down']) {
      const items = g[pos];
      if (!items.length) continue;
      const r = g[pos + 'Slot'].getBoundingClientRect();
      const H = g[pos + 'H'];
      const top = pos === 'up' ? r.top - c1.top : r.bottom - c1.top - H;
      for (const it of items) {
        // 上方註記：第一列最靠近條文（最下）；下方註記：第一列最靠近條文（最上）
        const y = pos === 'up' ? top + H - PAD - it.row.off - it.row.h + (it.row.h - it.h) : top + PAD + it.row.off;
        it.ann.style.left = it.left + 'px';
        it.ann.style.top = y + 'px';
        it.ann.style.width = it.w2 + 'px';
        it.ann.style.maxWidth = '';
        it.ann.classList.add('placed');
      }
    }
  }
  container.dataset.lw = W + '|' + fs;
  return true;
}

export function needsLayout(container) {
  const layer = container.querySelector(':scope > .ann-layer');
  if (!layer || !layer.children.length) return false;
  const fs = parseFloat(getComputedStyle(container).fontSize) || 18;
  return container.dataset.lw !== container.clientWidth + '|' + fs;
}
