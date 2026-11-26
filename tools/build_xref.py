#!/usr/bin/env python3
"""
建立跨法律參照資料 data/xref.json：
  - names：條文中可能出現的法規名稱（含簡稱）→ pcode
  - laws ：pcode → 法規名稱
  - arts ：非內建法規中「被引用條文」的內容（供條文下方顯示小字）
  - ed   ：編者整理之參照條文（tools/related/<pcode>.json）

被引用條文來源：
  1. 內建法規條文中明文引用他法條號者（如「民事訴訟法第四百零二條」）
  2. 全國法規資料庫「相關法條」（data/<pcode>.rel.json）
  3. 編者整理之參照條文

用法：python3 tools/build_xref.py（需先執行 build_data.py、fetch_rulings.py）
"""
import json
import os
import re
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
DATA = os.path.join(ROOT, "data")

CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5,
      "六": 6, "七": 7, "八": 8, "九": 9}


def cnnum(s):
    if s.isdigit():
        return int(s)
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


NUM = r"[零〇一二三四五六七八九十百千\d]+"
ART = r"第(%s)條(?:之(%s))?" % (NUM, NUM)
QUAL = r"(?:第%s[項款目]|前段|後段|但書|本文|各款|序文)*" % NUM
CONN = r"(?:、|及|或|與|至|暨|和)"


def load_zip(name, inner):
    p = os.path.join(CACHE, name)
    if not os.path.exists(p):
        return []
    with zipfile.ZipFile(p) as z:
        n = [x for x in z.namelist() if x.endswith(".json")][0]
        return json.loads(z.read(n).decode("utf-8-sig"))["Laws"]


def law_arts(law):
    out = {}
    for a in law["LawArticles"]:
        if a["ArticleType"] != "A":
            continue
        m = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"])
        if m:
            out[m.group(1)] = [p.strip() for p in a["ArticleContent"].replace("\r", "").split("\n") if p.strip()]
    return out


def main():
    reg = json.load(open(os.path.join(DATA, "laws.json"), encoding="utf-8"))
    bundled = {l["pcode"]: l for l in reg["laws"]}
    all_laws = load_zip("ChLaw.zip", "ChLaw.json")
    orders = load_zip("ChOrder.zip", "ChOrder.json")
    by_name, by_code = {}, {}
    for l in all_laws + orders:
        pc = l["LawURL"].split("pcode=")[-1]
        by_code[pc] = l
        by_name.setdefault(l["LawName"], pc)
    law_names = sorted({l["LawName"] for l in all_laws}, key=len, reverse=True)
    for alias, full in reg.get("aliases", {}).items():
        if full in by_name:
            by_name.setdefault(alias, by_name[full])
    for l in reg["laws"]:
        by_name[l["name"]] = l["pcode"]
        for a in l.get("aliases", []):
            by_name[a] = l["pcode"]
    names_re = "|".join(re.escape(n) for n in sorted(set(law_names) | set(reg.get("aliases", {})), key=len, reverse=True))
    ref_re = re.compile(r"(%s|同法)((?:%s%s)(?:%s(?:%s%s))*)" % (names_re, ART, QUAL, CONN, ART, QUAL))
    art_re = re.compile(ART)

    need = {}       # pcode -> set(aid)
    mentioned = set()

    def want(pc, aid):
        if pc and pc not in bundled:
            need.setdefault(pc, set()).add(aid)

    for pc in bundled:
        path = os.path.join(DATA, pc + ".json")
        if not os.path.exists(path):
            continue
        law = json.load(open(path, encoding="utf-8"))
        for a in law["articles"]:
            text = "".join(a["p"])
            last = None
            for nm in re.findall(names_re, text):
                if nm in by_name:
                    mentioned.add(nm)
            for m in ref_re.finditer(text):
                nm = m.group(1)
                if nm == "同法":
                    nm = last
                if not nm:
                    continue
                last = nm
                tpc = by_name.get(nm)
                for am in art_re.finditer(m.group(2)):
                    aid = str(cnnum(am.group(1))) + ("-%d" % cnnum(am.group(2)) if am.group(2) else "")
                    want(tpc, aid)
        relp = os.path.join(DATA, pc + ".rel.json")
        if os.path.exists(relp):
            for lst in json.load(open(relp, encoding="utf-8")).values():
                for r in lst:
                    want(r["p"], r["a"])
                    mentioned.add(r["n"])

    ed = {}
    for pc in bundled:
        p = os.path.join(ROOT, "tools", "related", pc + ".json")
        if not os.path.exists(p):
            continue
        cur = {}
        for aid, lst in json.load(open(p, encoding="utf-8")).items():
            if aid.startswith("_"):
                continue
            items = []
            for nm, taid in lst:
                tpc = by_name.get(nm)
                if not tpc:
                    print("找不到法規：", nm)
                    continue
                want(tpc, taid)
                mentioned.add(nm)
                items.append([tpc, taid])
            cur[aid] = items
        ed[pc] = cur

    arts, laws = {}, {}
    missing = []
    for pc, aids in sorted(need.items()):
        law = by_code.get(pc)
        if not law:
            missing.append((pc, sorted(aids)))
            continue
        la = law_arts(law)
        arts[pc] = {}
        for aid in sorted(aids, key=lambda x: [int(v) for v in x.split("-")]):
            if aid in la:
                arts[pc][aid] = la[aid]
            else:
                missing.append((law["LawName"], aid))
        laws[pc] = law["LawName"]
    for pc, l in bundled.items():
        laws[pc] = l["name"]
    names = {}
    for nm in mentioned | set(reg.get("aliases", {})):
        if nm in by_name:
            names[nm] = by_name[nm]
            laws.setdefault(by_name[nm], by_code[by_name[nm]]["LawName"] if by_name[nm] in by_code else nm)
    for l in reg["laws"]:
        names[l["name"]] = l["pcode"]
        for a in l.get("aliases", []):
            names[a] = l["pcode"]
    out = {"names": names, "laws": laws, "arts": arts, "ed": ed}
    dst = os.path.join(DATA, "xref.json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    n = sum(len(v) for v in arts.values())
    print("完成：%d 部法規、%d 條被引用條文 → %s (%.0f KB)" % (len(arts), n, dst, os.path.getsize(dst) / 1024))
    if missing:
        print("找不到條文：", missing[:40])


if __name__ == "__main__":
    main()
