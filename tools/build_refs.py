#!/usr/bin/env python3
"""
掃描 App 內各法規條文中「○○法第○條」的引用，從全國法規資料庫 API（ChLaw.json）
取出未收錄於 App 的其他法律之被引用條文，產生 data/refs.json，
供 App 以小字顯示「引用條文」。另依 tools/gists/*.tsv 產生 data/gists.json（條旨）。

用法：python3 tools/build_refs.py   （需先執行 build_law.py；會下載/使用 .cache/ChLaw.zip）
"""
import io
import json
import os
import re
import subprocess
import zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
API = "https://law.moj.gov.tw/api/Ch/Law/JSON"
APP = {"lpa": "勞工退休金條例", "lpar": "勞工退休金條例施行細則", "lsa": "勞動基準法", "civil": "民法"}
NUM = "[零〇一二三四五六七八九十百千]+"
ART = re.compile(r"第(%s)條(?:之(%s))?" % (NUM, NUM))
QUAL = re.compile(r"(?:第%s項)?(?:第%s款)?(?:第%s目)?(?:前段|後段|但書|本文|序文)?" % (NUM, NUM, NUM))
SEP = re.compile(r"(?:、|，|及|與|或|和|暨|至|以及)")
CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def cn2int(s):
    total, cur = 0, 0
    for ch in s:
        if ch in CN:
            cur = CN[ch]
        elif ch in "十百千":
            total += (cur or 1) * {"十": 10, "百": 100, "千": 1000}[ch]
            cur = 0
    return total + cur


def load_api():
    zp = os.path.join(CACHE, "ChLaw.zip")
    if not (os.path.exists(zp) and os.path.getsize(zp) > 1_000_000):
        subprocess.run(["curl", "-sS", "-m", "600", "-o", zp, API], check=True)
    with zipfile.ZipFile(zp) as z:
        return json.loads(z.read("ChLaw.json").decode("utf-8-sig"))


def refs_in(text, names):
    """回傳 [(法規名稱, 條號)]；names 依長度由長到短。"""
    out = []
    i = 0
    last = None
    while i < len(text):
        hit = None
        if text.startswith("同法", i) and last:
            hit = (last, 2)
        else:
            for n in names:
                if text.startswith(n, i):
                    hit = (n, len(n))
                    break
        if not hit:
            i += 1
            continue
        name, ln = hit
        last = name
        j = i + ln
        m = re.match(r"（以下簡稱[^）]*）", text[j:])
        if m:
            j += m.end()
        while True:
            m = ART.match(text, j)
            if not m:
                break
            aid = str(cn2int(m.group(1))) + ("-%d" % cn2int(m.group(2)) if m.group(2) else "")
            out.append((name, aid))
            j = m.end()
            q = QUAL.match(text, j)
            j = q.end()
            s = SEP.match(text, j)
            if not s or not ART.match(text, s.end()):
                break
            j = s.end()
        i = max(j, i + 1)
    return out


def main():
    data = load_api()
    laws = {l["LawName"]: l for l in data["Laws"]}
    names = sorted(laws, key=len, reverse=True)
    want = {}
    for lid in APP:
        path = os.path.join(ROOT, "data", lid + ".json")
        if not os.path.exists(path):
            continue
        d = json.load(open(path, encoding="utf-8"))
        for a in d["articles"]:
            for p in a["p"]:
                for name, aid in refs_in(p, names):
                    if name not in APP.values():
                        want.setdefault(name, set()).add(aid)
    out = {}
    for name, aids in sorted(want.items()):
        law = laws[name]
        arts = {}
        for a in law["LawArticles"]:
            if a["ArticleType"] != "A":
                continue
            m = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"])
            if m and m.group(1) in aids:
                arts[m.group(1)] = [p.strip() for p in a["ArticleContent"].replace("\r", "").split("\n") if p.strip()]
        pcode = re.search(r"pcode=(\w+)", law["LawURL"]).group(1)
        out[name] = {"pcode": pcode, "modified": law["LawModifiedDate"],
                     "abandon": re.sub(r"\s+", "", law.get("LawAbandonNote") or ""), "arts": arts}
        print("%s（%s）：%s" % (name, pcode, "、".join(sorted(arts, key=lambda x: [int(v) for v in x.split("-")]))))
    with open(os.path.join(ROOT, "data", "refs.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    gists = {}
    gdir = os.path.join(ROOT, "tools", "gists")
    for fn in sorted(os.listdir(gdir)):
        if fn.endswith(".tsv"):
            rows = [l.split("\t", 1) for l in open(os.path.join(gdir, fn), encoding="utf-8").read().strip().split("\n") if "\t" in l]
            gists[fn[:-4]] = {k.strip(): v.strip() for k, v in rows}
    with open(os.path.join(ROOT, "data", "gists.json"), "w", encoding="utf-8") as f:
        json.dump(gists, f, ensure_ascii=False, separators=(",", ":"))
    print("條旨：", {k: len(v) for k, v in gists.items()})


if __name__ == "__main__":
    main()
