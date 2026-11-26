#!/usr/bin/env python3
"""
從全國法規資料庫抓取勞資爭議處理法各條的「判例(J)」「相關法條(L)」「授權子法(S)」，
存成 .cache/ld/rela.json（供 tools/build_labor.py 使用）。
"""
import html, json, os, re, subprocess, sys, time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "ld")
PCODE = "N0020007"
BASE = "https://law.moj.gov.tw"
SINGLE = BASE + "/LawClass/LawSingle.aspx?pcode=%s&flno={a}" % PCODE
RELA = BASE + "/LawClass/LawSingleRela.aspx?PCODE=%s&FLNO={a}&ty={t}" % PCODE


def get(url, path, minsize=3000):
    if os.path.exists(path) and os.path.getsize(path) > minsize:
        return open(path, encoding="utf-8", errors="ignore").read()
    for i in range(8):
        r = subprocess.run(["curl", "-sS", "-m", "60", "-o", path, url], stderr=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > minsize:
            time.sleep(0.5)
            return open(path, encoding="utf-8", errors="ignore").read()
        time.sleep(2 + 2 * i)
    raise RuntimeError(url)


def text(s):
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    return "\n".join(l.strip() for l in s.replace("\r", "").split("\n") if l.strip())


def main_part(t):
    m = re.search(r'<div id="pnJudge">(.*?)(?:<!-- 主要內容結束|<footer)', t, re.S)
    if m:
        return m.group(1)
    i = t.find('class="law-reg-content"')
    return t[i:] if i >= 0 else t


def parse_J(t):
    out = []
    for tr in re.findall(r"<tr>(.*?)</tr>", main_part(t), re.S):
        rows = re.findall(r'<div class="col-th">\s*(.*?)</div>\s*<div class="col-td[^"]*">(.*?)</div>\s*</div>', tr, re.S)
        item = {"ty": "J"}
        for th, td in rows:
            th = text(th).rstrip("：:")
            if "字號" in th:
                item["no"] = re.sub(r"\s+", " ", text(td))
                a = re.search(r'href="([^"]+)"', td)
                if a:
                    item["url"] = BASE + html.unescape(a.group(1))
            elif "日期" in th:
                item["date"] = text(td).replace("民國", "").strip()
            else:
                item.setdefault("parts", []).append([th, re.sub(r"\s+", "", text(td))])
        if item.get("no"):
            out.append(item)
    return out


def parse_L(t):
    """相關法條：回傳 [{pcode, law, flno}]，條文內容由 build_labor.py 自法規資料補上"""
    i = t.find('id="pnLaw"')
    seg = t[i:].split("<footer")[0] if i >= 0 else ""
    out, law, pc = [], None, None
    for m in re.finditer(r'<a id="hlkName" href="[^"]*pcode=(\w+)">([^<]+)</a>|LawSingle\.aspx\?pcode=(\w+)&(?:amp;)?flno=([\d\-]+)', seg):
        if m.group(1):
            pc, law = m.group(1), m.group(2).strip()
        elif law:
            out.append({"pcode": m.group(3), "law": law, "flno": m.group(4)})
    return out


def parse_S(t):
    seg = main_part(t)
    out = []
    for row in re.findall(r"<tr>(.*?)</tr>", seg, re.S):
        tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
        if len(tds) >= 2:
            name = text(tds[1])
            a = re.search(r'href="([^"]+)"', tds[1])
            m = re.match(r"(.+?)（民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*）", name.replace(" ", ""))
            item = {"name": m.group(1) if m else name}
            if m:
                item["date"] = "%d.%s.%s" % (int(m.group(2)), m.group(3), m.group(4))
            if a:
                href = html.unescape(a.group(1))
                item["url"] = href if href.startswith("http") else BASE + "/LawClass/" + href.lstrip("./").replace("LawClass/", "")
            out.append(item)
    return out


def main():
    os.makedirs(os.path.join(CACHE, "single"), exist_ok=True)
    os.makedirs(os.path.join(CACHE, "rela"), exist_ok=True)
    law = json.load(open(os.path.join(CACHE, "law.json"), encoding="utf-8"))
    ids = [a["id"] for a in law]
    res = {}
    for aid in ids:
        t = get(SINGLE.format(a=aid), os.path.join(CACHE, "single", aid + ".html"))
        tys = sorted(set(re.findall(r"ty=([A-Z]+)", t.replace("&amp;", "&"))) - {"ONEBAR"})
        r = {}
        for ty in tys:
            if ty not in ("J", "L", "S", "C", "CJ"):
                continue
            rt = get(RELA.format(a=aid, t=ty), os.path.join(CACHE, "rela", "%s_%s.html" % (aid, ty)))
            if ty == "L":
                r["L"] = parse_L(rt)
            elif ty == "S":
                r["S"] = parse_S(rt)
            else:
                r.setdefault("J", []).extend(parse_J(rt))
        if r:
            res[aid] = r
        print(aid, {k: len(v) for k, v in r.items()}, flush=True)
    json.dump(res, open(os.path.join(CACHE, "rela.json"), "w", encoding="utf-8"), ensure_ascii=False, indent=1)


if __name__ == "__main__":
    main()
