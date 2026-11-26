#!/usr/bin/env python3
"""
從全國法規資料庫抓取各條文的「相關判解」與「相關法條」：
  CJ 憲法法庭裁判（新制）、C 大法官解釋（舊制）、J 判例（最高法院）
  L  相關法條（資料庫編者所列）
產生 data/<pcode>.rulings.json（判解）與 data/<pcode>.rel.json（相關法條）。
需先執行 tools/build_data.py。

用法：python3 tools/fetch_rulings.py [PCODE ...] [--workers 3] [--no-rel] [--rel-only]
  --rel-only  只抓相關法條（保留既有的判解檔）
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
BASE = "https://law.moj.gov.tw"
SINGLE = BASE + "/LawClass/LawSingle.aspx?pcode={p}&flno={a}"
RELA = BASE + "/LawClass/LawSingleRela.aspx?PCODE={p}&FLNO={a}&ty={t}"
RULING_TYPES = ["CJ", "C", "J"]
IGNORED_TYPES = {"S"}  # S：授權子法
lock = threading.Lock()
unknown_types = set()


def get(url, path):
    if os.path.exists(path) and os.path.getsize(path) > 3000:
        return open(path, encoding="utf-8", errors="ignore").read()
    for i in range(6):
        r = subprocess.run(["curl", "-sS", "-m", "60", "-o", path, url],
                           stderr=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > 3000:
            time.sleep(0.3)
            return open(path, encoding="utf-8", errors="ignore").read()
        time.sleep(2 + 3 * i)
    raise RuntimeError(url)


def clean(s):
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    lines = [l.strip() for l in s.replace("\r", "").split("\n")]
    out = "".join(l for l in lines if l)
    out = re.sub(r"\s{2,}", " ", out)
    return out.strip()


def parse_rulings(t, ty):
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


def parse_rel(t):
    """相關法條：[{n: 法規名稱, p: pcode, a: 條號}]"""
    m = re.search(r'<div id="pnLaw">(.*?)(?:<!-- 主要內容結束|<footer)', t, re.S)
    if not m:
        return []
    seg = m.group(1)
    out = []
    # 依法規名稱分組
    parts = re.split(r'<div class="h3[^"]*">', seg)
    for part in parts[1:]:
        mn = re.search(r'pcode=([A-Z0-9]+)">([^<]+)</a>', part)
        if not mn:
            continue
        pc, name = mn.group(1), clean(mn.group(2))
        for flno in re.findall(r'LawSingle\.aspx\?pcode=[A-Z0-9]+&(?:amp;)?flno=([\d\-]+)', part):
            out.append({"n": name, "p": pc, "a": flno})
    return out


def work(pcode, aid, cache, rel_only=False):
    safe = aid.replace("/", "_")
    t = get(SINGLE.format(p=pcode, a=aid), os.path.join(cache, "s_%s.html" % safe))
    flat = t.replace("&amp;", "&")
    types = sorted(set(re.findall(r'LawSingleRela\.aspx\?PCODE=[A-Z0-9]+&FLNO=[\d\-]+&ty=([A-Z]+)', flat)))
    rul, rel = [], []
    for ty in types:
        if ty in IGNORED_TYPES or (rel_only and ty != "L"):
            continue
        rt = get(RELA.format(p=pcode, a=aid, t=ty), os.path.join(cache, "r_%s_%s.html" % (safe, ty)))
        if ty in RULING_TYPES:
            rul.extend(parse_rulings(rt, ty))
        elif ty == "L":
            rel.extend(parse_rel(rt))
        else:
            with lock:
                unknown_types.add(ty)
    return aid, rul, rel


def run(pcode, workers, want_rel=True, rel_only=False):
    cache = os.path.join(ROOT, ".cache", "rela", pcode)
    os.makedirs(cache, exist_ok=True)
    law = json.load(open(os.path.join(ROOT, "data", pcode + ".json"), encoding="utf-8"))
    ids = [a["id"] for a in law["articles"] if not a.get("del")]
    rulings, rels, done, failed = {}, {}, 0, []
    with ThreadPoolExecutor(workers) as ex:
        futs = {ex.submit(work, pcode, aid, cache, rel_only): aid for aid in ids}
        for f in futs:
            aid = futs[f]
            try:
                _, rul, rel = f.result()
                if rul:
                    rulings[aid] = rul
                if rel:
                    rels[aid] = rel
            except Exception:  # noqa
                failed.append(aid)
            done += 1
            if done % 50 == 0:
                print("%s 進度 %d/%d，有判解 %d 條、相關法條 %d 條" % (pcode, done, len(ids), len(rulings), len(rels)), flush=True)
    if not rel_only:
        with open(os.path.join(ROOT, "data", pcode + ".rulings.json"), "w", encoding="utf-8") as fo:
            json.dump(rulings, fo, ensure_ascii=False, separators=(",", ":"))
    if want_rel:
        with open(os.path.join(ROOT, "data", pcode + ".rel.json"), "w", encoding="utf-8") as fo:
            json.dump(rels, fo, ensure_ascii=False, separators=(",", ":"))
    n = sum(len(v) for v in rulings.values())
    print("完成 %s：%d 條有判解，共 %d 筆；%d 條有相關法條；失敗 %d：%s" % (
        law["meta"]["name"], len(rulings), n, len(rels), len(failed), failed[:30]))
    if unknown_types:
        print("未處理的關聯類型：", sorted(unknown_types))


def main():
    workers = 3
    args = sys.argv[1:]
    if "--workers" in args:
        workers = int(args[args.index("--workers") + 1])
        del args[args.index("--workers"):args.index("--workers") + 2]
    want_rel = "--no-rel" not in args
    rel_only = "--rel-only" in args
    codes = [a for a in args if not a.startswith("--")]
    if not codes:
        codes = [l["pcode"] for l in json.load(open(os.path.join(ROOT, "data", "laws.json"), encoding="utf-8"))["laws"]]
    for pcode in codes:
        run(pcode, workers, want_rel, rel_only)


if __name__ == "__main__":
    main()
