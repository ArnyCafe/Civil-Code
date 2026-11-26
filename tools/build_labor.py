#!/usr/bin/env python3
"""
建立「勞資爭議處理法註記本」資料：labor-dispute/data/law.json

來源：
  - 全國法規資料庫 API（.cache/ChLaw.zip）：現行條文、目錄、沿革、被引用之其他法律條文
  - 全國法規資料庫歷次版本（LawOldVer）：新舊條文對照
  - tools/fetch_labor_rela.py 抓取之各條判例、相關法條、授權子法（.cache/ld/）
  - tools/labor_curated.json：內建編者註、重要判決與函釋

用法：
    python3 tools/fetch_labor_rela.py   # （第一次或要更新時）
    python3 tools/build_labor.py [--refresh]
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

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "tools"))
import build_data as bd  # noqa: E402  共用：中文數字、沿革、舊版解析

CACHE = os.path.join(ROOT, ".cache")
LD = os.path.join(CACHE, "ld")
OUT = os.path.join(ROOT, "labor-dispute", "data", "law.json")
PCODE = "N0020007"
OLDVER = "https://law.moj.gov.tw/LawClass/LawOldVer.aspx?pcode={p}&lnndate={d}&lser={s}"

# 條文中可能引用的其他法律（名稱 → pcode）；「災害防治法」為條文用語，現行法名為災害防救法
LAWS = {
    "工會法": "N0020001", "團體協約法": "N0020006", "行政程序法": "A0030055",
    "仲裁法": "I0020001", "民事訴訟法": "B0010001", "非訟事件法": "B0010008",
    "鄉鎮市調解條例": "I0020003", "政府資訊公開法": "I0020026", "災害防治法": "D0120014",
    "勞動事件法": "B0010064", "勞動基準法": "N0030001",
}
FULL_TEXT = {"N0020001", "N0020006"}  # 全文收錄，供瀏覽
CNUM = "零〇一二三四五六七八九十百"
REF_RE = re.compile(
    r"(?P<law>%s)(?:第(?P<a>[%s]+)條(?:之(?P<a2>[%s]+))?(?:第(?P<x>[%s]+)項)?"
    r"(?:第(?P<k1>[%s]+)款(?:至第(?P<k2>[%s]+)款)?)?|第(?P<ch>[%s]+)章)?" % (
        "|".join(sorted(LAWS, key=len, reverse=True)), CNUM, CNUM, CNUM, CNUM, CNUM, CNUM))


def load_api():
    zp = os.path.join(CACHE, "ChLaw.zip")
    if "--refresh" in sys.argv and os.path.exists(zp):
        os.remove(zp)
    bd.fetch(bd.API, zp)
    with zipfile.ZipFile(zp) as z:
        data = json.loads(z.read("ChLaw.json").decode("utf-8-sig"))
    laws = {l["LawURL"].rsplit("=", 1)[-1]: l for l in data["Laws"]}
    return laws, data.get("UpdateDate", "")


def parse_law(law):
    """回傳 headings, articles（與民法註記本相同格式）"""
    headings, articles, stack = [], [], []
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            raw = a["ArticleContent"]
            level = (len(raw) - len(raw.lstrip(" "))) // 3
            title = re.sub(r"\s+", " ", raw.strip())
            title = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", title)
            while stack and stack[-1][0] >= level:
                stack.pop()
            idx = len(headings)
            headings.append({"t": title, "lv": level, "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, idx))
        else:
            aid = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"]).group(1)
            paras = bd.split_paras_current(a["ArticleContent"])
            for _, hi in stack:
                if headings[hi]["first"] is None:
                    headings[hi]["first"] = aid
            articles.append({"id": aid, "h": stack[-1][1] if stack else -1, "p": paras,
                             "del": bd.norm(paras) in ("（刪除）", "刪除")})
    return headings, articles


def fetch_versions(dates):
    os.makedirs(os.path.join(LD, "ver"), exist_ok=True)
    out = []
    for d in dates:
        path = os.path.join(LD, "ver", "%s_001.html" % d)
        if os.path.exists(path + ".none"):
            continue
        if not (os.path.exists(path) and os.path.getsize(path) > 2000):
            for i in range(3):
                subprocess.run(["curl", "-sS", "-m", "90", "-o", path, OLDVER.format(p=PCODE, d=d, s="001")])
                if os.path.exists(path) and os.path.getsize(path) > 2000:
                    break
                time.sleep(2 + 2 * i)
        if not (os.path.exists(path) and os.path.getsize(path) > 2000):
            if os.path.exists(path) and os.path.getsize(path) < 1000:
                open(path + ".none", "w").close()  # 資料庫無此版本
            continue
        label, arts = bd.parse_version(path)
        if arts:
            out.append({"d": d, "label": label, "arts": arts})
    return out


def similarity(a, b):
    a, b = bd.strip_punct(a), bd.strip_punct(b)
    if not a or not b:
        return 0
    return difflib.SequenceMatcher(None, a, b, autojunk=False).ratio()


def best_match(text, arts):
    best, score = None, 0
    for no, paras in arts.items():
        s = similarity(text, "".join(paras))
        if s > score:
            best, score = no, s
    return best, score


OLDMAP = {}


def build_history(articles, versions, final_date):
    """各條新舊版本。民國98年全文修正後條號重編，98年以前以文字相似度對應舊條號。"""
    cur = {a["id"]: a["p"] for a in articles}
    vmap = {v["d"]: v["arts"] for v in versions}
    modern = [d for d in sorted(vmap) if d >= "20090701"]
    old = [d for d in sorted(vmap) if d < "20090701"]
    seq = [(d, vmap[d]) for d in modern]
    if not seq or {k: bd.norm(v) for k, v in seq[-1][1].items()} != {k: bd.norm(v) for k, v in cur.items()}:
        seq.append((final_date, cur))
    hist = {}
    for a in articles:
        aid = a["id"]
        hs = []
        first_new = next((d for d, arts in seq if aid in arts), None)
        base_text = "".join(next(arts[aid] for d, arts in seq if aid in arts))
        # 98年以前：98年全文修正處依人工對照表（labor_curated.json oldMap），其餘依條號／文字相似度
        chain = []
        start = OLDMAP.get(aid)
        if first_new == "20090701" and old and start:
            ref, prev_no = None, start
            for d in reversed(old):
                arts = vmap[d]
                if ref is None:
                    cand, sc = (start, 1.0) if start in arts else (None, 0)
                else:
                    cand, sc = (prev_no, similarity(ref, "".join(arts[prev_no]))) if prev_no in arts else (None, 0)
                    if sc < 0.5:
                        cand, sc = best_match(ref, arts)
                        if sc < 0.5:
                            cand = None
                if not cand:
                    break
                chain.append({"d": d, "p": arts[cand], "old": cand, "sim": round(sc, 2)})
                ref = "".join(arts[cand])
                prev_no = cand
            chain.reverse()
        last = None
        for c in chain:
            n = bd.norm(c["p"])
            if n != last:
                hs.append({"d": c["d"], "k": "old", "p": c["p"], "old": c["old"], "sim": c["sim"]})
            last = n
        for d, arts in seq:
            if aid not in arts:
                continue
            n = bd.norm(arts[aid])
            if n == last:
                continue
            if last is not None and not hs[-1].get("old") and bd.minor_edit(last, n):
                hs[-1]["p2"] = arts[aid]
                last = n
                continue
            k = "amend" if hs else ("new" if d > "20090701" or not chain else "amend")
            if d == "20090701" and not chain:
                k = "new"
            if n in ("（刪除）", "刪除"):
                k = "del"
            hs.append({"d": d, "k": k, "p": arts[aid]})
            last = n
        if hs and hs[0]["k"] == "old" and hs[0]["d"] == "19280609":
            hs[0]["k"] = "orig"
        hist[aid] = hs
    return hist


def cn(s):
    return bd.cn2int(s) if s else None


def extract_refs(articles, laws):
    """條文中對其他法律的引用 → [{p, q, pcode, flno?, x?, k?, ch?}]"""
    out = {}
    for a in articles:
        seen = set()
        for i, para in enumerate(a["p"]):
            for m in REF_RE.finditer(para):
                law = m.group("law")
                pc = LAWS[law]
                if not m.group("a") and not m.group("ch"):
                    continue  # 只有法律名稱，沒有條號
                r = {"p": i, "q": m.group(0), "pcode": pc}
                if m.group("a"):
                    r["flno"] = str(cn(m.group("a"))) + ("-%d" % cn(m.group("a2")) if m.group("a2") else "")
                    if m.group("x"):
                        r["x"] = cn(m.group("x"))
                    if m.group("k1"):
                        k1, k2 = cn(m.group("k1")), cn(m.group("k2")) or cn(m.group("k1"))
                        r["k"] = list(range(k1, k2 + 1))
                else:
                    ch = cn(m.group("ch"))
                    r["ch"] = ch
                    r["flnos"] = chapter_articles(laws[pc], ch)
                key = (pc, r.get("flno"), r.get("x"), tuple(r.get("k", [])), r.get("ch"))
                if key in seen:
                    continue
                seen.add(key)
                out.setdefault(a["id"], []).append(r)
    return out


def chapter_articles(law, ch):
    res, inside = [], False
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            m = re.search(r"第\s*(\S+)\s*章", a["ArticleContent"])
            if m:
                inside = bd.cn2int(m.group(1)) == ch
        elif inside:
            res.append(re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"]).group(1))
    return res


def law_articles(law):
    """pcode 的條文 dict 與章名"""
    arts, chap = {}, {}
    cur = ""
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            cur = re.sub(r"\s+", " ", a["ArticleContent"].strip())
            cur = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", cur)
        else:
            aid = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"]).group(1)
            arts[aid] = bd.split_paras_current(a["ArticleContent"])
            chap[aid] = cur
    return arts, chap


def parse_subsidiary(path):
    if not os.path.exists(path):
        return []
    t = open(path, encoding="utf-8", errors="ignore").read()
    t = t[t.find("授權子法名稱"):].split("<footer")[0]
    out = []
    for pc, name in re.findall(r'href="LawAll\.aspx\?pcode=(\w+)">([^<]+)</a>', t):
        name = re.sub(r"\s+", "", html.unescape(name))
        m = re.match(r"(.+?)（民國(\d+)年(\d+)月(\d+)日）", name)
        item = {"name": m.group(1) if m else name, "url": "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=" + pc}
        if m:
            item["date"] = "%d.%s.%s" % (int(m.group(2)), m.group(3), m.group(4))
        out.append(item)
    return out


def locate(paras, q, p=None, occ=1):
    """找 q 在哪一段（回傳段號）；p 指定時只找該段"""
    rng = [p] if p is not None else range(len(paras))
    for i in rng:
        if i < len(paras) and q in paras[i]:
            return i
    return None


def main():
    laws, update_date = load_api()
    law = laws[PCODE]
    headings, articles = parse_law(law)
    dates = bd.history_dates(law["LawHistories"])
    versions = fetch_versions(dates)
    final_date = law["LawModifiedDate"]
    curated = json.load(open(os.path.join(ROOT, "tools", "labor_curated.json"), encoding="utf-8"))
    OLDMAP.update({k: v for k, v in curated.get("oldMap", {}).items() if not k.startswith("_")})
    hist = build_history(articles, versions, final_date)
    items = bd.history_items(law["LawHistories"])

    # ---- 其他法律引用 ----
    refs = extract_refs(articles, laws)
    cur = {a["id"]: a for a in articles}
    for aid, lst in curated.get("extraRefs", {}).items():
        for r in lst:
            refs.setdefault(aid, []).append({"p": r.get("p", 0), "pcode": r["pcode"], "flno": r["flno"], "why": r.get("why", ""), "extra": True})
    rela = json.load(open(os.path.join(LD, "rela.json"), encoding="utf-8")) if os.path.exists(os.path.join(LD, "rela.json")) else {}
    for aid, r in rela.items():
        for l in r.get("L", []):
            if l["pcode"] == PCODE:
                continue
            if any(x["pcode"] == l["pcode"] and (x.get("flno") == l["flno"] or l["flno"] in x.get("flnos", [])) for x in refs.get(aid, [])):
                continue
            name = next((k for k, v in LAWS.items() if v == l["pcode"]), l["law"])
            p = locate(cur[aid]["p"], name)
            refs.setdefault(aid, []).append({"p": p if p is not None else 0, "pcode": l["pcode"], "flno": l["flno"], "why": "全國法規資料庫「相關法條」", "extra": True})

    # 被引用法律之條文
    need = {}
    for lst in refs.values():
        for r in lst:
            s = need.setdefault(r["pcode"], set())
            if r.get("flno"):
                s.add(r["flno"])
            s.update(r.get("flnos", []))
    reflaws = {}
    for pc, flnos in need.items():
        if pc == PCODE:
            continue
        L = laws[pc]
        arts, chap = law_articles(L)
        keep = arts if pc in FULL_TEXT else {k: v for k, v in arts.items() if k in flnos}
        reflaws[pc] = {
            "name": L["LawName"] if pc != "D0120014" else L["LawName"],
            "modified": L["LawModifiedDate"],
            "url": "https://law.moj.gov.tw/LawClass/LawAll.aspx?pcode=" + pc,
            "arts": keep,
            "chap": {k: chap[k] for k in keep},
            "full": pc in FULL_TEXT,
        }

    # ---- 內建註記 ----
    notes = {}
    miss = []
    for aid, lst in curated.get("notes", {}).items():
        for j, n in enumerate(lst):
            p = locate(cur[aid]["p"], n["q"], n.get("p"))
            if p is None:
                miss.append((aid, n["q"]))
                continue
            notes.setdefault(aid, []).append({"id": "b%s-%d" % (aid, j), "p": p, "q": n["q"], "pos": n.get("pos", "below"), "n": n["n"]})
    if miss:
        print("警告：以下註記文字在條文中找不到：", miss)

    # ---- 判解 ----
    rulings = {}
    for aid, r in rela.items():
        for j in r.get("J", []):
            j = dict(j)
            j["no"] = re.sub(r"\s+", "", j["no"]).replace("年", "年").strip()
            if j["no"].startswith("釋字") or "ty=C" in j.get("url", ""):
                j["ty"] = "C"
            j["date"] = re.sub(r"\s+", "", j.get("date", ""))
            rulings.setdefault(aid, []).append(j)
    for aid, lst in curated.get("items", {}).items():
        for i, it in enumerate(lst):
            it = dict(it)
            it["ty"] = "F" if it["kind"] == "函釋" else "P"
            it["key"] = "B:%s:%d" % (aid, i)
            rulings.setdefault(aid, []).append(it)
    subs = {}
    for a in articles:
        s = parse_subsidiary(os.path.join(LD, "rela", "%s_S.html" % a["id"]))
        if s:
            subs[a["id"]] = s

    # ---- 輸出 ----
    for a in articles:
        hs = hist.get(a["id"], [])
        a["v"] = len([h for h in hs if h["k"] != "old"])
        mod = [h for h in hs if h["k"] != "old"]
        if mod:
            a["since"] = mod[0]["d"]
            a["last"] = mod[-1]["d"]
        if OLDMAP.get(a["id"]):
            a["oldNo"] = OLDMAP[a["id"]]
    out = {
        "meta": {
            "name": law["LawName"], "eng": law.get("EngLawName", ""), "pcode": PCODE,
            "modified": law["LawModifiedDate"],
            "effectiveNote": re.sub(r"\s*\r?\n\s*", "", law.get("LawEffectiveNote", "")),
            "source": "全國法規資料庫 law.moj.gov.tw（法務部）",
            "sourceUpdate": update_date,
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        },
        "histories": [{"n": it["n"], "t": it["text"], "dates": it["dates"]} for it in items],
        "versions": [{"d": v["d"], "label": v["label"], "arts": [[k, p] for k, p in sorted(v["arts"].items(), key=lambda x: bd.art_key(x[0]))]} for v in versions]
                    + ([] if any(v["d"] == final_date for v in versions) else [{"d": final_date, "label": "現行", "arts": [[a["id"], a["p"]] for a in articles]}]),
        "headings": headings,
        "articles": articles,
        "changes": {aid: hs for aid, hs in hist.items() if len(hs) > 1 or (hs and hs[0]["k"] == "old")},
        "refs": refs,
        "reflaws": reflaws,
        "notes": notes,
        "rulings": rulings,
        "subs": subs,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("完成：%d 條、%d 個版本、%d 條有引用他法、%d 則內建註記、%d 則判解函釋 → %s (%.0f KB)" % (
        len(articles), len(out["versions"]), len(refs), sum(len(v) for v in notes.values()),
        sum(len(v) for v in rulings.values()), OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
