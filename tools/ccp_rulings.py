#!/usr/bin/env python3
"""
從全國法規資料庫抓取民事訴訟法各條文的「相關判解」：
  CJ 憲法法庭裁判（新制）、C 大法官解釋（舊制）、J 判例（最高法院）
產生 data/rulings.json。需先執行 tools/ccp_build.py。

用法：python3 tools/ccp_rulings.py [--workers 3]
"""
import html
import json
import os
import re
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "ccp", "rela")
OUT = os.path.join(ROOT, "ccp", "data", "rulings.json")
BASE = "https://law.moj.gov.tw"
SINGLE = BASE + "/LawClass/LawSingle.aspx?pcode=B0010001&flno={a}"
RELA = BASE + "/LawClass/LawSingleRela.aspx?PCODE=B0010001&FLNO={a}&ty={t}"
TYPES = ["CJ", "C", "J"]
lock = threading.Lock()


def get(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 3000:
        return open(path, encoding="utf-8", errors="ignore").read()
    for i in range(6):
        r = subprocess.run(["curl", "-sS", "-m", "60", "-o", path, url],
                           stderr=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 3000:
            time.sleep(0.4)
            return open(path, encoding="utf-8", errors="ignore").read()
        time.sleep(2 + 3 * i)
    raise RuntimeError(url)


def clean(s):
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    lines = [l.strip() for l in s.replace("\r", "").split("\n")]
    out = ""
    for l in lines:
        if not l:
            continue
        out += l
    out = re.sub(r"(?<=[一-鿿\d])\s{1,}(?=[一-鿿\d])", lambda m: m.group(0) if False else "", out)
    out = re.sub(r"\s{2,}", " ", out)
    return out.strip()


def parse(t, ty):
    out = []
    m = re.search(r'<div id="pnJudge">(.*?)(?:<!-- 主要內容結束|<footer)', t, re.S)
    if not m:
        return out
    seg = m.group(1)
    for tr in re.findall(r"<tr>(.*?)</tr>", seg, re.S):
        rows = re.findall(r'<div class="col-th">\s*(.*?)</div>\s*<div class="col-td[^"]*">(.*?)</div>\s*</div>', tr, re.S)
        if not rows:
            continue
        item = {"ty": ty}
        for th, td in rows:
            th = clean(th).rstrip("：:")
            if "字號" in th:
                a = re.search(r'href="([^"]+)"', td)
                item["no"] = clean(td)
                if a:
                    item["url"] = BASE + html.unescape(a.group(1))
            elif "日期" in th:
                item["date"] = clean(td).replace("民國", "").strip()
            else:
                item.setdefault("parts", []).append([th, clean(td)])
        if item.get("no"):
            out.append(item)
    return out


def work(aid):
    safe = aid.replace("/", "_")
    t = get(SINGLE.format(a=aid), os.path.join(CACHE, "s_%s.html" % safe))
    types = [ty for ty in TYPES if ("ty=%s\"" % ty) in t.replace("&amp;", "&")]
    res = []
    for ty in types:
        rt = get(RELA.format(a=aid, t=ty), os.path.join(CACHE, "r_%s_%s.html" % (safe, ty)))
        res.extend(parse(rt, ty))
    return aid, res


def main():
    workers = 3
    if "--workers" in sys.argv:
        workers = int(sys.argv[sys.argv.index("--workers") + 1])
    os.makedirs(CACHE, exist_ok=True)
    civ = json.load(open(os.path.join(ROOT, "ccp", "data", "law.json"), encoding="utf-8"))
    ids = [a["id"] for a in civ["articles"]]
    result, done, failed = {}, 0, []
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(work, aid): aid for aid in ids}
        for f in futs:
            aid = futs[f]
            try:
                _, res = f.result()
                if res:
                    result[aid] = res
            except Exception as e:  # noqa
                failed.append(aid)
            done += 1
            if done % 50 == 0:
                print("進度 %d/%d，有判解 %d 條" % (done, len(ids), len(result)), flush=True)
    # 合併同一號判解（多條共用）時保留
    with open(OUT, "w", encoding="utf-8") as fo:
        json.dump(result, fo, ensure_ascii=False, separators=(",", ":"))
    n = sum(len(v) for v in result.values())
    print("完成：%d 條有判解，共 %d 筆；失敗 %d：%s" % (len(result), n, len(failed), failed[:30]))


if __name__ == "__main__":
    main()
