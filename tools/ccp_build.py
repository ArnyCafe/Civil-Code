#!/usr/bin/env python3
"""
民事訴訟法註記本（ccp/）的資料建置。

  * 現行條文、編章節目錄：全國法規資料庫 (law.moj.gov.tw) 法規 API（ChLaw.zip）
  * 各條歷次條文與立法／修正理由：立法院法律系統 (lis.ly.gov.tw)「法條沿革」
  * 引用其他法律之條文：同一份 ChLaw.zip（全部中央法規）
  * 條旨：tools/ccp_gists.tsv（人工撰寫）

產生：
  ccp/data/law.json   條文、目錄、條旨、他法條文
  ccp/data/hist.json  各條歷次條文、修正理由、修法日期（公布／施行）

用法：
    python3 tools/ccp_build.py            # 有快取就用快取
    python3 tools/ccp_build.py --refresh  # 重新下載

需求：Python 3.8+、curl。立法院網站使用舊式 TLS 重新協商，curl 會以
OPENSSL_CONF 允許 legacy renegotiation（憑證仍照常驗證）。
"""
import html
import json
import os
import re
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "ccp")
OUTDIR = os.path.join(ROOT, "ccp", "data")
PCODE = "B0010001"
LAWNAME = "民事訴訟法"
MOJ_API = "https://law.moj.gov.tw/api/Ch/Law/JSON"
LY = "https://lis.ly.gov.tw"

CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5,
      "六": 6, "七": 7, "八": 8, "九": 9}


def cn2int(s):
    total, cur = 0, 0
    for ch in s:
        if ch in CN:
            cur = CN[ch]
        elif ch == "十":
            total += (cur or 1) * 10
            cur = 0
        elif ch == "百":
            total += (cur or 1) * 100
            cur = 0
        elif ch == "千":
            total += (cur or 1) * 1000
            cur = 0
    return total + cur


def art_key(aid):
    a, _, b = aid.partition("-")
    return (int(a), int(b or 0))


# ---------------------------------------------------------------------------
# 下載
# ---------------------------------------------------------------------------
LEGACY_CNF = os.path.join(CACHE, "openssl-legacy.cnf")


def curl(args, legacy=False, tries=5):
    env = dict(os.environ)
    if legacy:
        if not os.path.exists(LEGACY_CNF):
            with open(LEGACY_CNF, "w") as f:
                f.write("openssl_conf = openssl_init\n[openssl_init]\nssl_conf = ssl_sect\n"
                        "[ssl_sect]\nsystem_default = system_default_sect\n"
                        "[system_default_sect]\nOptions = UnsafeLegacyRenegotiation\n")
        env["OPENSSL_CONF"] = LEGACY_CNF
    for i in range(tries):
        r = subprocess.run(["curl", "-sS", "-m", "180"] + args, env=env)
        if r.returncode == 0:
            return
        time.sleep(3 * (i + 1))
    raise RuntimeError("下載失敗：" + " ".join(args))


def load_moj(refresh):
    zp = os.path.join(ROOT, ".cache", "ChLaw.zip")
    if refresh or not os.path.exists(zp) or os.path.getsize(zp) < 100000:
        curl(["-o", zp, MOJ_API])
    with zipfile.ZipFile(zp) as z:
        data = json.loads(z.read("ChLaw.json").decode("utf-8-sig"))
    return data


def ly_pages(refresh):
    """立法院法律系統：檢索 → 法律頁（含修法日期）→ 法條沿革（含理由）。"""
    law_p = os.path.join(CACHE, "ly_law.html")
    hist_p = os.path.join(CACHE, "ly_history.html")
    if not refresh and os.path.exists(hist_p) and os.path.getsize(hist_p) > 500000:
        return open(law_p, encoding="utf-8", errors="ignore").read(), \
            open(hist_p, encoding="utf-8", errors="ignore").read()
    jar = os.path.join(CACHE, "ly_cookies.txt")
    if os.path.exists(jar):
        os.remove(jar)
    p1 = os.path.join(CACHE, "ly_km.html")
    curl(["-c", jar, "-b", jar, "-o", p1, LY + "/lglawc/lglawkm"], legacy=True)
    t = open(p1, encoding="utf-8", errors="ignore").read()
    action = re.search(r'action="([^"]+)"', t).group(1)
    info = re.search(r"name=INFO value=([0-9A-Za-z]+)", t).group(1)
    p2 = os.path.join(CACHE, "ly_search.html")
    form = {"INFO": info, "@_1_6_T": "T_LN/LW", "_1_6_T": LAWNAME,
            "@_1_5_T": "T_LW/AL/AX/AZ/AW/AY/AV/AN", "_1_5_T": "",
            "@_1_7_r": "r6_", "_1_7_r_1": "0", "_IMG_檢索.x": "10", "_IMG_檢索.y": "10"}
    args = ["-c", jar, "-b", jar, "-o", p2]
    for k, v in form.items():
        args += ["--data-urlencode", "%s=%s" % (k, v)]
    curl(args + [LY + action], legacy=True)
    t = open(p2, encoding="utf-8", errors="ignore").read()
    link = None
    for m in re.finditer(r"<a href=(/lglawc/lawsingle\?[^ >]+)[^>]*>(.*?)</a>", t, re.S):
        if re.sub(r"<[^>]+>", "", m.group(2)).strip() == LAWNAME:
            link = m.group(1)
            break
    if not link:
        raise RuntimeError("立法院法律系統找不到" + LAWNAME)
    curl(["-c", jar, "-b", jar, "-o", law_p, LY + link], legacy=True)
    t = open(law_p, encoding="utf-8", errors="ignore").read()
    m = re.search(r'<a href=(/lglawc/lawsingle\?[^ >]+)[^>]*>\s*法條沿革\s*</a>', t)
    if not m:
        raise RuntimeError("找不到法條沿革連結")
    curl(["-c", jar, "-b", jar, "-o", hist_p, LY + html.unescape(m.group(1))], legacy=True)
    return t, open(hist_p, encoding="utf-8", errors="ignore").read()


# ---------------------------------------------------------------------------
# 解析
# ---------------------------------------------------------------------------
def paras_of(cell):
    s = re.sub(r"<br\s*/?>", "\n", cell)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    out = []
    for ln in s.replace("\r", "").split("\n"):
        ln = ln.strip().strip("　").strip()
        if ln:
            out.append(ln)
    return out


def aid_from_cn(s):
    s = re.sub(r"\s", "", s)
    m = re.match(r"第([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?", s)
    if not m:
        return None
    return "%d-%d" % (cn2int(m.group(1)), cn2int(m.group(2))) if m.group(2) else str(cn2int(m.group(1)))


def roc7_to_date(s):
    # 0920114 → 20030114
    return "%04d%s" % (int(s[:3]) + 1911, s[3:7])


def parse_ly_history(t):
    out = {}
    blocks = re.split(r'<font class="artino">', t)[1:]
    for b in blocks:
        no = re.match(r"([^<]+)</font>", b).group(1).strip()
        aid = aid_from_cn(no)
        if not aid:
            continue
        vers = []
        for seg in re.split(r'<font class="upddate">', b)[1:]:
            m = re.match(r"\((\d{7})&nbsp;([^)]+)\)", seg)
            if not m:
                continue
            d, kind = roc7_to_date(m.group(1)), m.group(2)
            th = re.search(r"artiupd_TH_2>(.*?)</td>", seg, re.S)
            rs = re.search(r"artiupd_RS_2>(.*?)</td>", seg, re.S)
            v = {"d": d, "k": kind, "p": paras_of(th.group(1)) if th else []}
            if rs:
                r = paras_of(rs.group(1))
                if r:
                    v["r"] = r
            if d < "19341219":
                v["old"] = 1  # 民國19、20年舊民事訴訟法，條次與現行法不同
            vers.append(v)
        out[aid] = vers
    return out


def roc_cn_date(s):
    m = re.match(r"中華民國(\d+)年(\d+)月(\d+)日", s)
    return "%04d%02d%02d" % (int(m.group(1)) + 1911, int(m.group(2)), int(m.group(3)))


def parse_ly_dates(t):
    """修法（三讀）日期 → 公布、施行日期。"""
    t = re.sub(r"<script.*?</script>|<style.*?</style>", "", t, flags=re.S)
    s = html.unescape(re.sub(r"<[^>]+>", "\n", t))
    lines = [l.strip() for l in s.split("\n") if l.strip()]
    out, cur = {}, None
    for ln in lines:
        m = re.match(r"(中華民國\d+年\d+月\d+日)(制定|全文修正|修正|公布|施行)$", ln)
        if not m:
            if ln.startswith("現行條文"):
                break
            continue
        d = roc_cn_date(m.group(1))
        if m.group(2) in ("制定", "全文修正", "修正"):
            cur = d
            out[cur] = {"k": m.group(2)}
        elif cur:
            out[cur]["pub" if m.group(2) == "公布" else "eff"] = d
    return out


# ---------------------------------------------------------------------------
# 現行條文
# ---------------------------------------------------------------------------
def build_current(law):
    headings, articles, stack = [], [], []
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            raw = a["ArticleContent"]
            level = (len(raw) - len(raw.lstrip(" "))) // 3
            title = re.sub(r"\s+", " ", raw.strip())
            title = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", title)
            title = re.sub(r"(第\S+?(?:編|章|節|款|目)(?:之[一二三四五六七八九十]+)?)\s*", r"\1 ", title, count=1).strip()
            title = re.sub(r"\s{2,}", " ", title)
            while stack and stack[-1][0] >= level:
                stack.pop()
            idx = len(headings)
            headings.append({"t": title, "lv": level, "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, idx))
        else:
            aid = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"]).group(1)
            paras = [p.strip() for p in a["ArticleContent"].replace("\r", "").split("\n") if p.strip()]
            for _, hi in stack:
                if headings[hi]["first"] is None:
                    headings[hi]["first"] = aid
            flat = re.sub(r"\s", "", "".join(paras))
            articles.append({"id": aid, "h": stack[-1][1] if stack else -1, "p": paras,
                             "del": flat in ("（刪除）", "刪除")})
    # 「編」索引（供條號配色）
    for a in articles:
        hi = a["h"]
        while hi >= 0 and headings[hi]["p"] >= 0:
            hi = headings[hi]["p"]
        a["part"] = hi
    return headings, articles


def history_items(hist):
    lines = hist.replace("\r", "").split("\n")
    items, cur = [], None
    for ln in lines:
        m = re.match(r"^\s*(\d+)\.\s*(.*)$", ln)
        if m:
            cur = {"n": int(m.group(1)), "t": m.group(2).strip()}
            items.append(cur)
        elif cur is not None:
            cur["t"] += ln.strip()
    for it in items:
        it["t"] = re.sub(r"\s+", "", it["t"])
        it["t"] = re.sub(r"(?<=[\d、～])(?=\d)", "", it["t"])
        it["dates"] = sorted({"%04d%02d%02d" % (cn2int(y) + 1911, cn2int(m), cn2int(d)) for y, m, d in re.findall(
            r"中華民國([一二三四五六七八九十百零]+)年([一二三四五六七八九十]+)月([一二三四五六七八九十]+)日", it["t"])})
    return items


# ---------------------------------------------------------------------------
# 他法條文
# ---------------------------------------------------------------------------
# 條文未寫明條號的引用（如「依民法之規定」），以下列條文作為相關法條
GENERIC = {
    # 受輔助宣告之人（民法之輔助宣告制度）
    "45-1": [("民法", ["15-1", "15-2"])],
    # 訴訟之法定代理及為訴訟所必要之允許，依民法及其他法令之規定
    "47": [("民法", ["76", "77", "1086", "1098"])],
    # 期間之計算，依民法之規定
    "161": [("民法", ["119", "120", "121", "122", "123"])],
    # 破產、消費者債務清理之當然停止
    "174": [("破產法", ["75", "90"]), ("消費者債務清理條例", ["94", "98"])],
    # 證人之拘提準用刑事訴訟法
    "303": [("刑事訴訟法", ["77", "78", "79", "80", "81", "82", "83"])],
    # 第三人不從提出文書之命，準用強制執行法關於物之交付請求權執行之規定
    "349": [("強制執行法", ["123", "124", "125", "126"])],
}

XLAW_RE = re.compile(
    r"(?P<law>[一-鿿]{1,20}?(?:法|條例|通則))第(?P<a>[零〇一二三四五六七八九十百千]+)條(?:之(?P<b>[一二三四五六七八九十]+))?")


def build_xlaw(articles, laws):
    by_name = {}
    for l in laws:
        by_name[l["LawName"]] = l
    arts_of = {}

    def law_articles(name):
        if name not in arts_of:
            l = by_name.get(name)
            m = {}
            if l:
                for a in l["LawArticles"]:
                    if a["ArticleType"] != "A":
                        continue
                    mm = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"])
                    if mm:
                        m[mm.group(1)] = [p.strip() for p in a["ArticleContent"].replace("\r", "").split("\n") if p.strip()]
            arts_of[name] = m
        return arts_of[name]

    def pcode_of(name):
        l = by_name.get(name)
        if not l:
            return ""
        m = re.search(r"pcode=(\w+)", l["LawURL"])
        return m.group(1) if m else ""

    out = {}
    names = sorted(by_name, key=len, reverse=True)
    for a in articles:
        refs = []
        text = "".join(a["p"])
        for m in XLAW_RE.finditer(text):
            raw = m.group("law")
            law = next((n for n in names if raw.endswith(n)), None)
            if not law or law in (LAWNAME,):
                continue
            no = str(cn2int(m.group("a"))) + ("-%d" % cn2int(m.group("b")) if m.group("b") else "")
            refs.append((law, no, m.group(0)[len(raw) - len(law):]))
        for law, nos in GENERIC.get(a["id"], []):
            for no in nos:
                refs.append((law, no, None))
        items, seen = [], set()
        for law, no, quote in refs:
            if (law, no) in seen:
                continue
            seen.add((law, no))
            p = law_articles(law).get(no)
            if not p:
                print("  找不到他法條文：", a["id"], law, no)
                continue
            it = {"law": law, "a": no, "p": p, "pc": pcode_of(law)}
            if quote:
                it["q"] = quote
            items.append(it)
        if items:
            out[a["id"]] = items
    return out


# ---------------------------------------------------------------------------
def load_gists():
    path = os.path.join(ROOT, "tools", "ccp_gists.tsv")
    g = {}
    if os.path.exists(path):
        for ln in open(path, encoding="utf-8"):
            ln = ln.rstrip("\n")
            if not ln or ln.startswith("#") or "\t" not in ln:
                continue
            k, v = ln.split("\t", 1)
            g[k.strip()] = v.strip()
    return g


def norm(paras):
    s = re.sub(r"\s+", "", "".join(paras))
    return s.replace("(", "（").replace(")", "）").replace(",", "，").replace(":", "：").replace(";", "；")


def minor(a, b):
    import difflib
    sm = difflib.SequenceMatcher(None, a, b, autojunk=False)
    return sum(max(i2 - i1, j2 - j1) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal") <= 6


def main():
    refresh = "--refresh" in sys.argv
    os.makedirs(CACHE, exist_ok=True)
    os.makedirs(OUTDIR, exist_ok=True)
    data = load_moj(refresh)
    law = next(l for l in data["Laws"] if l["LawURL"].endswith("pcode=" + PCODE))
    headings, articles = build_current(law)
    gists = load_gists()
    missing = []
    for a in articles:
        g = gists.get(a["id"])
        if a["del"]:
            g = g or "刪除"
        if g:
            a["g"] = g
        else:
            missing.append(a["id"])
    if missing:
        print("尚無條旨：%d 條，例如 %s" % (len(missing), missing[:20]))

    xlaw = build_xlaw(articles, data["Laws"])

    law_html, hist_html = ly_pages(refresh)
    hist = parse_ly_history(hist_html)
    dates = parse_ly_dates(law_html)

    # 比對立法院最新條文與全國法規資料庫現行條文
    diff = []
    for a in articles:
        hs = hist.get(a["id"])
        if not hs:
            diff.append((a["id"], "立法院無資料"))
            continue
        if norm(hs[-1]["p"]) != norm(a["p"]):
            diff.append((a["id"], "最新版本文字不同"))
    # 僅標點差異者，以全國法規資料庫現行條文為準（立法院資料多為早期標點）
    cur = {a["id"]: a["p"] for a in articles}
    real = []
    for aid, why in diff:
        hs = hist.get(aid)
        if hs and minor(norm(hs[-1]["p"]), norm(cur[aid])):
            hs[-1]["p"] = cur[aid]
        else:
            real.append((aid, why))
    if real:
        print("注意：%d 條與現行條文不一致：%s" % (len(real), real[:15]))

    for a in articles:
        hs = [h for h in hist.get(a["id"], []) if not h.get("old")]
        a["v"] = len(hs)
        amends = [h for h in hs[1:] if h["k"] != "全文修正" or norm(h["p"]) != norm(hs[hs.index(h) - 1]["p"])]
        a["am"] = len(amends)
        if hs:
            a["last"] = hs[-1]["d"]

    meta = {
        "name": law["LawName"],
        "eng": law.get("EngLawName", ""),
        "pcode": PCODE,
        "modified": law["LawModifiedDate"],
        "effectiveNote": re.sub(r"\s*\r?\n\s*", "", law.get("LawEffectiveNote", "")),
        "source": "全國法規資料庫 law.moj.gov.tw（法務部）",
        "sourceUpdate": data.get("UpdateDate", ""),
        "histSource": "立法院法律系統 lis.ly.gov.tw（法條沿革）",
        "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
    }
    out = {"meta": meta, "headings": headings, "articles": articles, "xlaw": xlaw,
           "histories": history_items(law["LawHistories"])}
    with open(os.path.join(OUTDIR, "law.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    hout = {"dates": dates, "arts": {k: hist[k] for k in sorted(hist, key=art_key)}}
    with open(os.path.join(OUTDIR, "hist.json"), "w", encoding="utf-8") as f:
        json.dump(hout, f, ensure_ascii=False, separators=(",", ":"))
    nr = sum(1 for v in hist.values() for h in v if h.get("r"))
    print("完成：%d 條（刪除 %d）、條旨 %d、他法引用 %d 條、沿革 %d 條／理由 %d 則、修法 %d 次" % (
        len(articles), sum(a["del"] for a in articles), sum(1 for a in articles if a.get("g")),
        len(xlaw), len(hist), nr, len(dates)))
    for fn in ("law.json", "hist.json"):
        print("  ccp/data/%s %.0f KB" % (fn, os.path.getsize(os.path.join(OUTDIR, fn)) / 1024))


if __name__ == "__main__":
    main()
