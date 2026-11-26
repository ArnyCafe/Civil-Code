// 逐字差異比對（LCS），適用於中文條文
export function diffChars(a, b) {
  // 去掉共同前後綴以加速
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++;
  const A = a.slice(pre, a.length - suf);
  const B = b.slice(pre, b.length - suf);
  const n = A.length, m = B.length;
  const ops = [];
  if (pre) ops.push(['=', a.slice(0, pre)]);
  if (n === 0 && m) ops.push(['+', B]);
  else if (m === 0 && n) ops.push(['-', A]);
  else if (n && m) {
    if (n * m > 4_000_000) { ops.push(['-', A], ['+', B]); }
    else {
      const W = m + 1;
      const dp = new Uint16Array((n + 1) * W);
      for (let i = n - 1; i >= 0; i--) {
        for (let j = m - 1; j >= 0; j--) {
          dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
        }
      }
      let i = 0, j = 0;
      const push = (t, s) => { const l = ops[ops.length - 1]; if (l && l[0] === t) l[1] += s; else ops.push([t, s]); };
      while (i < n && j < m) {
        if (A[i] === B[j]) { push('=', A[i]); i++; j++; }
        else if (dp[(i + 1) * W + j] >= dp[i * W + j + 1]) { push('-', A[i]); i++; }
        else { push('+', B[j]); j++; }
      }
      while (i < n) push('-', A[i++]);
      while (j < m) push('+', B[j++]);
    }
  }
  if (suf) {
    const l = ops[ops.length - 1];
    if (l && l[0] === '=') l[1] += a.slice(a.length - suf); else ops.push(['=', a.slice(a.length - suf)]);
  }
  return cleanup(ops);
}

// 將很短的相同片段併入前後的變動，讓結果較易閱讀
function cleanup(ops) {
  const out = [];
  for (let k = 0; k < ops.length; k++) {
    const [t, s] = ops[k];
    if (t === '=' && s.length <= 1 && k > 0 && k < ops.length - 1 && ops[k - 1][0] !== '=' && ops[k + 1][0] !== '=') {
      // 將單字相同片段拆成 刪＋增
      out.push(['-', s], ['+', s]);
    } else out.push([t, s]);
  }
  // 合併相鄰同型，並把 - 排在 + 之前
  const merged = [];
  let dels = '', adds = '';
  const flush = () => { if (dels) merged.push(['-', dels]); if (adds) merged.push(['+', adds]); dels = adds = ''; };
  for (const [t, s] of out) {
    if (t === '-') dels += s; else if (t === '+') adds += s; else { flush(); merged.push([t, s]); }
  }
  flush();
  return merged;
}

const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// 以段落為單位比對：回傳 { old: html, new: html, inline: html }
export function diffParas(oldP, newP) {
  const SEP = '\n';
  const ops = diffChars(oldP.join(SEP), newP.join(SEP));
  let o = '', n = '', inl = '';
  for (const [t, s] of ops) {
    const parts = s.split(SEP);
    const wrapTag = (tag, html) => parts.map((p) => (p ? `<${tag} class="d">${esc(p)}</${tag}>` : '')).join('</p><p>');
    if (t === '=') { const h = parts.map(esc).join('</p><p>'); o += h; n += h; inl += h; }
    else if (t === '-') { const h = wrapTag('del'); o += h; inl += h; }
    else { const h = wrapTag('ins'); n += h; inl += h; }
  }
  const p = (h) => '<p>' + h + '</p>';
  return { old: p(o), new: p(n), inline: p(inl) };
}
