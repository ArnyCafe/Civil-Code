#!/usr/bin/env python3
"""
從「司法院裁判書系統」(judgment.judicial.gov.tw) 檢索引用特定法律的終審裁判，
下載全文並擷取引用各條文的段落，供 tools/build_osh.py 整理成「重要判決」。

用法：
    python3 tools/fetch_judgments.py search  # 檢索清單 → .cache/fj/list.json
    python3 tools/fetch_judgments.py fetch   # 下載全文 → .cache/fj/doc/*.txt

檢索條件（QUERIES）：最高法院民事／刑事、最高行政法院，全文含「職業安全衛生法」或舊法「勞工安全衛生法」。
"""
import html
import json
import os
import re
import subprocess
import sys
import time
import urllib.parse

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "fj")
JAR = os.path.join(CACHE, "cookies.txt")
BASE = "https://judgment.judicial.gov.tw/FJUD/"

QUERIES = [
    # (court, sys, keyword)
    ("TPS", "V", "職業安全衛生法"),
    ("TPS", "M", "職業安全衛生法"),
    ("TPA", "A", "職業安全衛生法"),
    ("TPS", "V", "勞工安全衛生法"),
    ("TPS", "M", "勞工安全衛生法"),
    ("TPA", "A", "勞工安全衛生法"),
]


def curl(url, out, data=None, tries=5):
    last = ""
    for i in range(tries):
        cmd = ["curl", "-sS", "-m", "90", "-c", JAR, "-b", JAR, "-o", out, url]
        for k, v in (data or []):
            cmd += ["--data-urlencode", "%s=%s" % (k, v)]
        r = subprocess.run(cmd, stderr=subprocess.PIPE)
        if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 500:
            time.sleep(0.8)
            return open(out, encoding="utf-8", errors="ignore").read()
        last = r.stderr.decode(errors="ignore")
        time.sleep(4 * (i + 1))
    raise RuntimeError("下載失敗：%s %s" % (url, last[:200]))


def text(s):
    s = re.sub(r"<script.*?</script>", "", s, flags=re.S)
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s))).strip()


def search(court, sysc, kw, max_pages=40):
    t = curl(BASE + "Default_AD.aspx", os.path.join(CACHE, "ad0.html"))
    g = lambda n: re.search(r'name="%s" id="%s" value="([^"]*)"' % (n, n), t).group(1)
    data = [("__VIEWSTATE", g("__VIEWSTATE")), ("__VIEWSTATEGENERATOR", g("__VIEWSTATEGENERATOR")),
            ("__VIEWSTATEENCRYPTED", ""), ("__EVENTVALIDATION", g("__EVENTVALIDATION")),
            ("jud_court", court), ("jud_sys", sysc), ("jud_kw", kw), ("judtype", "JUDBOOK"), ("whosub", "0"),
            ("ctl00$cp_content$btnQry", "送出查詢")]
    for k in ["jud_year", "jud_case", "jud_no", "jud_no_end", "dy1", "dm1", "dd1", "dy2", "dm2", "dd2",
              "jud_title", "jud_jmain", "KbStart", "KbEnd", "sel_judword"]:
        data.append((k, ""))
    r = curl(BASE + "Default_AD.aspx", os.path.join(CACHE, "ad1.html"), data)
    m = re.search(r"qryresultlst\.aspx\?ty=JUDBOOK&amp;q=(\w+)", r)
    if not m:
        print("無結果", court, sysc, kw)
        return []
    q = m.group(1)
    out = []
    page = 1
    while page <= max_pages:
        url = BASE + "qryresultlst.aspx?ty=JUDBOOK&q=%s&sort=DS&page=%d" % (q, page)
        lst = curl(url, os.path.join(CACHE, "lst.html"))
        rows = re.findall(r'<tr>(.*?)</tr>', lst, re.S)
        n0 = len(out)
        for row in rows:
            a = re.search(r'<a[^>]+href="(data\.aspx\?ty=JD&amp;id=([^"&]+)[^"]*)"[^>]*>(.*?)</a>', row, re.S)
            if not a:
                continue
            jid = urllib.parse.unquote(html.unescape(a.group(2)))
            title = text(a.group(3))
            tds = re.findall(r"<td[^>]*>(.*?)</td>", row, re.S)
            date = cause = ""
            for td in tds:
                tt = text(td)
                if re.fullmatch(r"\d{2,3}\.\d{2}\.\d{2}", tt):
                    date = tt
            if len(tds) >= 4:
                cause = text(tds[3])
            out.append({"id": jid, "title": re.sub(r"\s+", "", title), "date": date, "cause": cause})
        total = re.search(r"共\s*([\d,]+)\s*筆", text(lst))
        if len(out) == n0 or "下一頁" not in lst:
            break
        page += 1
    print("%s %s 「%s」：%d 筆%s" % (court, sysc, kw, len(out), "（共 %s）" % total.group(1) if total else ""), flush=True)
    return out


def doc_path(jid):
    return os.path.join(CACHE, "doc", re.sub(r"[^\w]", "_", jid) + ".txt")


def fetch_doc(jid):
    p = doc_path(jid)
    if os.path.exists(p) and os.path.getsize(p) > 200:
        return open(p, encoding="utf-8").read()
    url = BASE + "data.aspx?ty=JD&id=" + urllib.parse.quote(jid, safe="")
    t = curl(url, os.path.join(CACHE, "doc.html"))
    m = re.search(r'<div class="htmlcontent">(.*?)</div>\s*</div>', t, re.S) or \
        re.search(r'<div id="jud"[^>]*>(.*?)<div class="row"', t, re.S)
    body = m.group(1) if m else t
    body = re.sub(r"<br\s*/?>", "\n", body)
    body = re.sub(r"</(p|div|tr)>", "\n", body)
    body = html.unescape(re.sub(r"<[^>]+>", "", body))
    body = "\n".join(l.strip() for l in body.replace("\r", "").split("\n"))
    body = re.sub(r"\n{2,}", "\n", body).strip()
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "w", encoding="utf-8") as f:
        f.write(body)
    return body


def main():
    os.makedirs(CACHE, exist_ok=True)
    cmd = sys.argv[1] if len(sys.argv) > 1 else "search"
    lp = os.path.join(CACHE, "list.json")
    if cmd == "search":
        allr = {}
        for court, sysc, kw in QUERIES:
            for it in search(court, sysc, kw):
                it.setdefault("q", [])
                cur = allr.setdefault(it["id"], it)
                cur.setdefault("q", [])
                if kw not in cur["q"]:
                    cur["q"].append(kw)
        json.dump(list(allr.values()), open(lp, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
        print("合計 %d 筆 → %s" % (len(allr), lp))
    elif cmd == "fetch":
        items = json.load(open(lp, encoding="utf-8"))
        # 只下載判決（裁定多為程序駁回）
        todo = [it for it in items if it["title"].endswith("判決")]
        print("下載 %d 筆判決全文" % len(todo), flush=True)
        for i, it in enumerate(todo):
            try:
                fetch_doc(it["id"])
            except Exception as e:  # noqa
                print("失敗", it["id"], e)
            if (i + 1) % 25 == 0:
                print("進度 %d/%d" % (i + 1, len(todo)), flush=True)


if __name__ == "__main__":
    main()
