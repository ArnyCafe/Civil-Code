#!/usr/bin/env python3
"""
建立「法典書架」資料：data/laws.json 與 data/law/<id>.json。

各法規格式與 data/civil.json 相同（meta / histories / versions / headings / articles / changes），
另加：
  - articles[].cap   條旨（職業安全衛生法，見 tools/curated_osh.py）
  - headings[].c     章別顏色代號（條號反白顏色）
  - changes[aid][].r 立法／修正理由（立法院法律系統）、.no 當時條號（全文修正條次變更）
  - meta.parent      子法所屬母法（「本法」所指）

來源：
  - 法律現行條文：全國法規資料庫 API（.cache/ChLaw.zip）
  - 命令（細則、規則、辦法、標準）：全國法規資料庫網頁 LawAll.aspx
  - 法律之歷次條文與立法理由：立法院法律系統（tools/fetch_ly.py）
  - 命令之歷次條文：全國法規資料庫 LawOldVer.aspx

用法：python3 tools/build_laws.py [id ...]
"""
import difflib
import html
import json
import os
import re
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_data import cn2int, history_items, history_dates, parse_version, norm, art_key, split_paras_current, minor_edit  # noqa: E402
import curated_osh  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
MOJ = "https://law.moj.gov.tw"

# 書架。group 決定書架分類；parent 為子法之母法（「本法」）。
LIB = [
    dict(id="osh", pcode="N0060001", name="職業安全衛生法", short="職安法", alias=["職業安全衛生法", "職安法"],
         group="職業安全衛生", ly=True, rulings=True),
    dict(id="osh-r", pcode="N0060002", name="職業安全衛生法施行細則", short="職安法細則",
         alias=["職業安全衛生法施行細則"], group="職業安全衛生", parent="osh", oldver=True),
    dict(id="osh-fac", pcode="N0060009", name="職業安全衛生設施規則", short="設施規則",
         alias=["職業安全衛生設施規則"], group="職業安全衛生", parent="osh", oldver=True),
    dict(id="osh-mgmt", pcode="N0060027", name="職業安全衛生管理辦法", short="管理辦法",
         alias=["職業安全衛生管理辦法"], group="職業安全衛生", parent="osh", oldver=True),
    dict(id="osh-edu", pcode="N0060010", name="職業安全衛生教育訓練規則", short="教育訓練規則",
         alias=["職業安全衛生教育訓練規則"], group="職業安全衛生", parent="osh", oldver=True),
    dict(id="osh-health", pcode="N0060022", name="勞工健康保護規則", short="健康保護規則",
         alias=["勞工健康保護規則"], group="職業安全衛生", parent="osh", oldver=True),
    dict(id="osh-cons", pcode="N0060014", name="營造安全衛生設施標準", short="營造標準",
         alias=["營造安全衛生設施標準"], group="職業安全衛生", parent="osh", oldver=True),
    dict(id="lsa", pcode="N0030001", name="勞動基準法", short="勞基法", alias=["勞動基準法", "勞基法"],
         group="勞動法", ly=True),
    dict(id="lsa-r", pcode="N0030002", name="勞動基準法施行細則", short="勞基法細則",
         alias=["勞動基準法施行細則"], group="勞動法", parent="lsa", oldver=True),
    dict(id="lia", pcode="N0070001", name="勞動檢查法", short="勞檢法", alias=["勞動檢查法", "勞檢法"],
         group="勞動法", ly=True),
    dict(id="oia", pcode="N0050031", name="勞工職業災害保險及保護法", short="災保法",
         alias=["勞工職業災害保險及保護法", "災保法"], group="勞動法", ly=True),
    dict(id="gee", pcode="N0030014", name="性別平等工作法", short="性平工作法",
         alias=["性別平等工作法", "性別工作平等法"], group="勞動法"),
    dict(id="apa", pcode="A0030210", name="行政罰法", short="行政罰法", alias=["行政罰法"], group="基本法"),
    dict(id="crim", pcode="C0000001", name="中華民國刑法", short="刑法", alias=["中華民國刑法", "刑法"],
         group="基本法"),
    # 民法沿用 tools/build_data.py 產生之 data/civil.json
    dict(id="civil", pcode="B0000001", name="民法", short="民法", alias=["民法"], group="基本法",
         file="data/civil.json", rulings_file="data/rulings.json", prebuilt=True),
]

# 條號反白顏色（CSS 以 --c-<key> 定義）
PALETTE = ["blue", "green", "teal", "amber", "violet", "slate", "rose", "olive", "cyan", "brown"]


def get(url, path, tries=6, minsize=1500):
    if os.path.exists(path) and os.path.getsize(path) > minsize:
        return open(path, encoding="utf-8", errors="ignore").read()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    err = ""
    for i in range(tries):
        r = subprocess.run(["curl", "-sS", "-m", "120", "-o", path, url], stderr=subprocess.PIPE)
        if r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > minsize:
            time.sleep(0.5)
            return open(path, encoding="utf-8", errors="ignore").read()
        err = r.stderr.decode(errors="ignore")
        time.sleep(3 * (i + 1))
    raise RuntimeError("下載失敗：%s %s" % (url, err[:200]))


def roc_to_ad(s7):
    """'1020703' → '20130703'"""
    return "%04d%s" % (int(s7[:3]) + 1911, s7[3:])


def clean_heading(raw):
    title = re.sub(r"\s+", " ", raw.strip())
    title = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", title)
    title = re.sub(r"(第\S+?(?:編|章|節|款|目)(?:之[一二三四五六七八九十]+)?)\s*", r"\1 ", title, count=1).strip()
    return title


def aid_of_no(no):
    m = re.match(r"第\s*([\d\-]+)\s*條", no)
    return m.group(1) if m else None


# ---------------------------------------------------------------------------
# 現行條文
# ---------------------------------------------------------------------------
_API = None


def api_laws():
    global _API
    if _API is None:
        zp = os.path.join(CACHE, "ChLaw.zip")
        if not os.path.exists(zp):
            subprocess.run(["curl", "-sS", "-m", "300", "-o", zp, MOJ + "/api/Ch/Law/JSON"], check=True)
        with zipfile.ZipFile(zp) as z:
            data = json.loads(z.read("ChLaw.json").decode("utf-8-sig"))
        _API = ({l["LawURL"].split("pcode=")[-1]: l for l in data["Laws"]}, data.get("UpdateDate", ""))
    return _API


def from_api(law):
    headings, articles, stack = [], [], []
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            raw = a["ArticleContent"]
            level = (len(raw) - len(raw.lstrip(" "))) // 3
            title = clean_heading(raw)
            while stack and stack[-1][0] >= level:
                stack.pop()
            idx = len(headings)
            headings.append({"t": title, "lv": level, "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, idx))
        else:
            aid = aid_of_no(a["ArticleNo"])
            paras = split_paras_current(a["ArticleContent"])
            for _, hi in stack:
                if headings[hi]["first"] is None:
                    headings[hi]["first"] = aid
            articles.append({"id": aid, "h": stack[-1][1] if stack else -1, "p": paras,
                             "del": norm(paras) in ("（刪除）", "刪除")})
    return headings, articles


def from_lawall(t):
    """解析 LawAll.aspx：章節標題與條文。"""
    seg = t.split('<div class="law-reg-content">', 1)[-1]
    headings, articles, stack = [], [], []
    tok = re.compile(r'<div class="h3 char-(\d)">([^<]*)</div>|<div class="row"><div class="col-no">(.*?)</div><div class="col-data[^"]*">(.*?)</div>\s*</div></div>', re.S)
    levels = {}
    for m in tok.finditer(seg):
        if m.group(1):
            ch = int(m.group(1))
            levels.setdefault(ch, None)
    lvmap = {c: i for i, c in enumerate(sorted(levels))}
    for m in tok.finditer(seg):
        if m.group(1):
            level = lvmap[int(m.group(1))]
            title = clean_heading(html.unescape(m.group(2)))
            while stack and stack[-1][0] >= level:
                stack.pop()
            idx = len(headings)
            headings.append({"t": title, "lv": level, "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, idx))
        else:
            no = html.unescape(re.sub(r"<[^>]+>", "", m.group(3))).strip()
            aid = aid_of_no(no)
            if not aid:
                continue
            body = m.group(4)
            paras = [html.unescape(re.sub(r"<[^>]+>", "", x)).strip()
                     for x in re.findall(r'<div class="line-\d+[^"]*">(.*?)</div>', body, re.S)]
            paras = [p for p in paras if p]
            if not paras:
                paras = [html.unescape(re.sub(r"<[^>]+>", "", body)).strip()]
            for _, hi in stack:
                if headings[hi]["first"] is None:
                    headings[hi]["first"] = aid
            articles.append({"id": aid, "h": stack[-1][1] if stack else -1, "p": paras,
                             "del": norm(paras) in ("（刪除）", "刪除")})
    return headings, articles


def lawall_meta(t):
    name = re.search(r'id="hlLawName"[^>]*>([^<]*)', t).group(1).strip()
    m = re.search(r"(修正|發布)日期：</th>\s*<td>([^<]*)", t)
    mod = ""
    if m:
        mm = re.search(r"(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日", m.group(2))
        if mm:
            mod = "%04d%02d%02d" % (int(mm.group(1)) + 1911, int(mm.group(2)), int(mm.group(3)))
    return name, mod


def parse_history_page(t):
    """全國法規資料庫沿革頁：每次修正之說明、舊版連結、總說明與對照表。"""
    rows = re.findall(r'<div class="row">\s*<div id="historyPanel"[^>]*>(.*?)</div>\s*<div class="col-data text-pre">(.*?)</div>', t, re.S)
    out = []
    for links, txt in rows:
        txt = html.unescape(re.sub(r"<[^>]+>", "", txt))
        m = re.match(r"\s*(\d+)\.\s*(.*)", txt, re.S)
        if not m:
            continue
        text = re.sub(r"\s+", "", m.group(2))
        text = re.sub(r"(?<=[\d、～])(?=\d)", "", text)
        it = {"n": int(m.group(1)), "t": text, "dates": history_dates(text)}
        for href in re.findall(r'href="([^"]+)"', links):
            href = html.unescape(href)
            if "LawOldVer" in href:
                it["old"] = re.search(r"lnndate=(\d+)", href).group(1)
            elif "LawGetDesc" in href:
                it["desc"] = MOJ + href
            elif "LawGetFile" in href:
                it["cmp"] = MOJ + href
        out.append(it)
    return sorted(out, key=lambda x: x["n"])


# ---------------------------------------------------------------------------
# 新舊條文：立法院法律系統
# ---------------------------------------------------------------------------
PUNCT = re.compile(r"[，、；：。「」『』（）()\s：:．.]")


def sim(a, b):
    a, b = PUNCT.sub("", a), PUNCT.sub("", b)
    if not a or not b:
        return 0.0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def is_deleted(paras):
    return norm(paras) in ("（刪除）", "刪除", "")


def ly_changes(ly, current_ids):
    events = sorted(ly["events"], key=lambda e: e["pass"])
    prom = {e["pass"]: e.get("prom", e["pass"]) for e in events}
    arts = ly["arts"]
    by_ev = {}
    for aid, ents in arts.items():
        for e in ents:
            by_ev.setdefault(e["pass"], []).append((aid, e))
    states = []
    state = {}
    for ev in events:
        before = dict(state)
        if ev["kind"] in ("全文修正", "制定"):
            state = {}
        for aid, e in by_ev.get(ev["pass"], []):
            state[aid] = e
        states.append((ev, before))

    NEWRE = re.compile(r"本條新增|新增本條|增訂本條")

    def assign(ev, before):
        """全文修正：以文字相似度為新條文找出修正前之條次（一對一優先，必要時允許一條拆成數條）。"""
        pairs, fresh = [], set()
        for num, e in by_ev.get(ev["pass"], []):
            r = "".join(e["r"])
            if NEWRE.search(r):
                fresh.add(num)
                continue
            explicit = set()
            for m in re.finditer(r"原(?:條文|勞工安全衛生法)?第([零〇一二三四五六七八九十百]+)條(?:之([一二三四五六七八九十]+))?", r):
                a = str(cn2int(m.group(1)))
                if m.group(2):
                    a += "-%d" % cn2int(m.group(2))
                explicit.add(a)
            txt = "".join(e["p"])
            for cand, ce in before.items():
                if is_deleted(ce["p"]):
                    continue
                s = sim(txt, "".join(ce["p"]))
                if cand in explicit:
                    s += 0.3
                if cand == num:
                    s += 0.05
                pairs.append((s, num, cand, "條次變更" in r))
        pairs.sort(key=lambda x: -x[0])
        res, used = {}, set()
        for s, num, cand, renum in pairs:
            if num in res or cand in used or s < (0.22 if renum else 0.38):
                continue
            res[num] = cand
            used.add(cand)
        for s, num, cand, renum in pairs:
            if num not in res and s >= 0.5:
                res[num] = cand
        return res

    preds = {ev["pass"]: assign(ev, before) for ev, before in states if ev["kind"] == "全文修正"}

    changes = {}
    for aid in current_ids:
        num = aid
        chain = []
        for ev, before in reversed(states):
            e = next((x for x in arts.get(num, []) if x["pass"] == ev["pass"]), None)
            if e is None:
                continue
            chain.append((ev, num, e))
            if e["kind"] in ("制定", "增訂"):
                break
            if ev["kind"] == "全文修正":
                pred = preds[ev["pass"]].get(num)
                if pred is None:
                    chain[-1] = (ev, num, dict(e, kind="增訂"))
                    break
                num = pred
        chain.reverse()
        vers = []
        for i, (ev, num, e) in enumerate(chain):
            k = "amend"
            if i == 0:
                k = "new" if e["kind"] == "增訂" or ev["kind"] != "制定" else "orig"
            if is_deleted(e["p"]):
                k = "del"
            v = {"d": roc_to_ad(prom[ev["pass"]]), "pass": roc_to_ad(ev["pass"]), "k": k, "p": e["p"], "r": e["r"]}
            if num != aid:
                v["no"] = num
            if vers:
                prev = vers[-1]
                if norm(prev["p"]) == norm(e["p"]) and prev.get("no") == v.get("no"):
                    continue  # 本條未修正
                if norm(prev["p"]) == norm(e["p"]):
                    v["k"] = "renum"
            vers.append(v)
        if vers:
            changes[aid] = vers
    return changes, [{"d": roc_to_ad(e.get("prom", e["pass"])), "pass": roc_to_ad(e["pass"]), "kind": e["kind"]} for e in events]


# ---------------------------------------------------------------------------
# 新舊條文：全國法規資料庫歷史條文
# ---------------------------------------------------------------------------
def oldver_changes(pcode, hist, cur_articles):
    seq = []
    for it in hist:
        if not it.get("old"):
            continue
        d = it["old"]
        path = os.path.join(CACHE, "moj", "ver_%s_%s.html" % (pcode, d))
        t = get(MOJ + "/LawClass/LawOldVer.aspx?pcode=%s&lnndate=%s&lser=001" % (pcode, d), path)
        label, arts = parse_version(path)
        if arts:
            seq.append((d, arts))
    cur = {a["id"]: a["p"] for a in cur_articles}
    last_date = max([d for it in hist for d in it["dates"]] or ["99999999"])
    seq.sort()
    seq.append((last_date if not seq or last_date > seq[-1][0] else seq[-1][0] + "z", cur))
    history, last = {}, {}
    first = seq[0][0] if seq else None
    for d, arts in seq:
        for aid, paras in arts.items():
            n = norm(paras)
            if aid not in last:
                history.setdefault(aid, []).append({"d": d[:8], "p": paras, "k": "base" if d == first else "new"})
            elif last[aid] != n:
                if minor_edit(last[aid], n) and strip_eq(last[aid], n):
                    history[aid][-1]["p2"] = paras
                else:
                    k = "del" if n in ("（刪除）", "刪除") else "amend"
                    history[aid].append({"d": d[:8], "p": paras, "k": k})
            last[aid] = n
    return {aid: hs for aid, hs in history.items() if len(hs) > 1}


def strip_eq(a, b):
    return PUNCT.sub("", a) == PUNCT.sub("", b)


# ---------------------------------------------------------------------------
# 主程式
# ---------------------------------------------------------------------------
def color_headings(lid, headings):
    custom = curated_osh.CHAPTER_COLORS if lid == "osh" else {}
    i = 0
    for h in headings:
        if h["p"] < 0:
            key = None
            for k, c in custom.items():
                if h["t"].startswith(k):
                    key = c
            if not key:
                key = PALETTE[i % len(PALETTE)]
                i += 1
            h["c"] = key
        else:
            h["c"] = headings[h["p"]]["c"] if h["p"] >= 0 else PALETTE[0]


def build(e):
    lid = e["id"]
    api, upd = api_laws()
    meta = {"id": lid, "name": e["name"], "pcode": e["pcode"], "source": "全國法規資料庫 law.moj.gov.tw（法務部）",
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d")}
    if e.get("parent"):
        meta["parent"] = e["parent"]
    hist_html = get(MOJ + "/LawClass/LawHistory.aspx?pcode=" + e["pcode"],
                    os.path.join(CACHE, "moj", "hist_%s.html" % e["pcode"]))
    hist = parse_history_page(hist_html)
    if e["pcode"] in api:
        law = api[e["pcode"]]
        headings, articles = from_api(law)
        meta.update({"kind": "法律", "modified": law["LawModifiedDate"], "eng": law.get("EngLawName", ""),
                     "effectiveNote": re.sub(r"\s*\r?\n\s*", "", law.get("LawEffectiveNote", "")),
                     "sourceUpdate": upd})
        histories = [{"n": it["n"], "t": it["text"], "dates": it["dates"]} for it in history_items(law["LawHistories"])]
    else:
        t = get(MOJ + "/LawClass/LawAll.aspx?pcode=" + e["pcode"], os.path.join(CACHE, "moj", "all_%s.html" % e["pcode"]))
        name, mod = lawall_meta(t)
        headings, articles = from_lawall(t)
        meta.update({"kind": "命令", "modified": mod, "effectiveNote": "", "sourceUpdate": ""})
        histories = [{"n": it["n"], "t": it["t"], "dates": it["dates"]} for it in hist]
    # 沿革附件連結（總說明、條文對照表）
    for h in histories:
        src = next((x for x in hist if x["n"] == h["n"]), None)
        if src:
            for k in ("desc", "cmp"):
                if src.get(k):
                    h[k] = src[k]
    color_headings(lid, headings)
    changes, versions = {}, []
    if e.get("ly"):
        ly = json.load(open(os.path.join(CACHE, "ly", e["name"] + ".json"), encoding="utf-8"))
        changes, versions = ly_changes(ly, [a["id"] for a in articles])
        meta["reasons"] = "立法院法律系統 lis.ly.gov.tw"
    elif e.get("oldver"):
        changes = oldver_changes(e["pcode"], hist, articles)
        versions = [{"d": d} for d in sorted({h["d"] for hs in changes.values() for h in hs})]
    ids = {a["id"] for a in articles}
    changes = {k: v for k, v in changes.items() if k in ids}
    if lid == "osh":
        for a in articles:
            cap = curated_osh.CAPTIONS.get(a["id"])
            if cap:
                a["cap"] = cap
            else:
                print("  缺條旨：", a["id"])
    for a in articles:
        hs = changes.get(a["id"], [])
        a["v"] = len(hs)
    out = {"meta": meta, "histories": histories, "versions": versions, "headings": headings,
           "articles": articles, "changes": {k: v for k, v in sorted(changes.items(), key=lambda x: art_key(x[0]))}}
    dst = os.path.join(ROOT, "data", "law", lid + ".json")
    os.makedirs(os.path.dirname(dst), exist_ok=True)
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    amended = sum(1 for v in changes.values() if len(v) > 1)
    print("%-14s %4d 條  %3d 條有沿革  %6.0f KB" % (e["name"], len(articles), amended, os.path.getsize(dst) / 1024), flush=True)
    return out


def write_index(built):
    idx = []
    for e in LIB:
        if e.get("prebuilt"):
            d = json.load(open(os.path.join(ROOT, e["file"]), encoding="utf-8"))
            meta, n = d["meta"], len(d["articles"])
            kind, mod = "法律", meta.get("modified", "")
        else:
            p = os.path.join(ROOT, "data", "law", e["id"] + ".json")
            if not os.path.exists(p):
                continue
            d = built.get(e["id"]) or json.load(open(p, encoding="utf-8"))
            meta, n = d["meta"], len(d["articles"])
            kind, mod = meta.get("kind", ""), meta.get("modified", "")
        item = {k: e[k] for k in ("id", "pcode", "name", "short", "alias", "group") if k in e}
        item.update({"kind": kind, "modified": mod, "n": n,
                     "file": e.get("file", "data/law/%s.json" % e["id"])})
        for k in ("parent",):
            if e.get(k):
                item[k] = e[k]
        if e.get("rulings_file"):
            item["rulings"] = e["rulings_file"]
        ex = os.path.join(ROOT, "data", "extra", e["id"] + ".json")
        if os.path.exists(ex):
            item["extra"] = "data/extra/%s.json" % e["id"]
        idx.append(item)
    with open(os.path.join(ROOT, "data", "laws.json"), "w", encoding="utf-8") as f:
        json.dump({"default": "osh", "laws": idx}, f, ensure_ascii=False, indent=1)
    print("書架：%d 部 → data/laws.json" % len(idx))


def main():
    want = set(sys.argv[1:])
    built = {}
    for e in LIB:
        if e.get("prebuilt") or (want and e["id"] not in want):
            continue
        built[e["id"]] = build(e)
    write_index(built)


if __name__ == "__main__":
    main()
