#!/usr/bin/env python3
"""
從「立法院法律系統」(lis.ly.gov.tw) 抓取法律的「法條沿革」：
每一條歷次三讀通過之條文與立法（修正）理由。

用法：
    python3 tools/fetch_ly.py 職業安全衛生法 勞動基準法 ...

輸出：.cache/ly/<法名>.json
    {"law": 名稱, "events": [{"pass": "1020618", "prom": "1020703", "kind": "全文修正"}],
     "arts": {"6": [{"pass": "1020618", "kind": "全文修正", "p": [...條文], "r": [...理由]}]}}

注意：立法院網站使用舊版 TLS，需允許 legacy renegotiation（不影響憑證驗證）。
"""
import html
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "ly")
BASE = "https://lis.ly.gov.tw"
JAR = os.path.join(CACHE, "cookies.txt")

CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


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


def env():
    cnf = os.path.join(CACHE, "openssl-legacy.cnf")
    if not os.path.exists(cnf):
        with open(cnf, "w") as f:
            f.write("openssl_conf = openssl_init\n[openssl_init]\nssl_conf = ssl_sect\n"
                    "[ssl_sect]\nsystem_default = sys_sect\n[sys_sect]\nOptions = UnsafeLegacyRenegotiation\n")
    e = dict(os.environ)
    e["OPENSSL_CONF"] = cnf
    return e


def curl(url, out, data=None, tries=5):
    for i in range(tries):
        cmd = ["curl", "-sS", "-m", "120", "-c", JAR, "-b", JAR, "-o", out, url]
        for k, v in (data or []):
            cmd += ["--data-urlencode", "%s=%s" % (k, v)]
        r = subprocess.run(cmd, env=env(), stderr=subprocess.PIPE)
        if r.returncode == 0 and os.path.exists(out) and os.path.getsize(out) > 1000:
            time.sleep(0.6)
            return open(out, encoding="utf-8", errors="ignore").read()
        time.sleep(3 * (i + 1))
    raise RuntimeError("下載失敗：%s %s" % (url, r.stderr.decode(errors="ignore")[:200]))


def clean(s):
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    lines = [l.strip().replace("　", "") for l in s.replace("\r", "").split("\n")]
    return [l for l in lines if l]


def aid_of(no):
    """「第十五條 之一」→ 15-1"""
    no = re.sub(r"\s+", "", no)
    m = re.match(r"第([零〇一二三四五六七八九十百千]+)條(?:之([一二三四五六七八九十]+))?", no)
    if not m:
        return None
    a = cn2int(m.group(1))
    return "%d-%d" % (a, cn2int(m.group(2))) if m.group(2) else str(a)


def roc7(y, m, d):
    return "%03d%02d%02d" % (int(y), int(m), int(d))


def fetch(law):
    os.makedirs(CACHE, exist_ok=True)
    safe = re.sub(r"[^\w]", "_", law)
    out = os.path.join(CACHE, safe + ".json")
    hist_path = os.path.join(CACHE, safe + "_hist.html")
    page_path = os.path.join(CACHE, safe + "_law.html")
    if not os.path.exists(hist_path):
        if os.path.exists(JAR):
            os.remove(JAR)
        t = curl(BASE + "/lglawc/lglawkm", os.path.join(CACHE, "km.html"))
        act = re.search(r'action="(/lglawc/lglawkm\?[^"]+)"', t).group(1)
        info = re.search(r"name=INFO value=(\w+)", t).group(1)
        data = [("INFO", info), ("@_1_6_T", "T_LN/LW"), ("_1_6_T", law),
                ("@_1_5_T", "T_LW/AL/AX/AZ/AW/AY/AV/AN"), ("_1_5_T", ""),
                ("@_1_7_r", "r6_"), ("_1_7_r_1", "0"), ("_IMG_檢索.x", "10"), ("_IMG_檢索.y", "10")]
        t = curl(BASE + act, os.path.join(CACHE, "res.html"), data)
        # 找出「現行法」中名稱完全相符者
        cands = re.findall(r"href=(/lglawc/lawsingle\?[^ >]+)[^>]*>(?:<[^>]+>)*([^<]*)", t)
        link = None
        for href, txt in cands:
            if txt.strip() == law:
                link = href
                break
        if not link:
            hrefs = re.findall(r"href=(/lglawc/lawsingle\?[^ >]+)", t)
            if not hrefs:
                raise RuntimeError("立法院法律系統找不到：" + law)
            link = hrefs[0]
        t = curl(BASE + link, page_path)
        m = re.search(r"href=(/lglawc/lawsingle\?[^ >]+)[^>]*>法條沿革", t)
        if not m:
            raise RuntimeError("找不到法條沿革：" + law)
        curl(BASE + m.group(1), hist_path)
    page = open(page_path, encoding="utf-8", errors="ignore").read()
    t = open(hist_path, encoding="utf-8", errors="ignore").read()

    # 立法沿革：三讀日期 → 公布日期
    flat = re.sub(r"<[^>]+>", " ", page)
    flat = re.sub(r"\s+", "", html.unescape(flat))
    events = []
    for m in re.finditer(r"中華民國(\d+)年(\d+)月(\d+)日(制定|全文修正|修正|增訂|刪除|廢止)(?:中華民國(\d+)年(\d+)月(\d+)日公布)?", flat):
        ev = {"pass": roc7(*m.group(1, 2, 3)), "kind": m.group(4)}
        if m.group(5):
            ev["prom"] = roc7(*m.group(5, 6, 7))
        if not any(e["pass"] == ev["pass"] for e in events):
            events.append(ev)

    arts = {}
    for blk in re.split(r'<font class="artino">', t)[1:]:
        no = re.match(r"([^<]+)</font>", blk).group(1)
        aid = aid_of(no)
        if not aid:
            continue
        ents = []
        for seg in re.split(r'<font class="upddate">', blk)[1:]:
            mh = re.match(r"\((\d{7})(?:&nbsp;|\s)*([^)]*)\)", seg)
            if not mh:
                continue
            e = {"pass": mh.group(1), "kind": html.unescape(mh.group(2)).strip()}
            mt = re.search(r"artiupd_TH_2>(.*?)</td>", seg, re.S)
            mr = re.search(r"artiupd_RS_2>(.*?)</td>", seg, re.S)
            e["p"] = clean(mt.group(1)) if mt else []
            e["r"] = clean(mr.group(1)) if mr else []
            ents.append(e)
        arts[aid] = ents
    res = {"law": law, "events": events, "arts": arts}
    with open(out, "w", encoding="utf-8") as f:
        json.dump(res, f, ensure_ascii=False, indent=0)
    n = sum(len(v) for v in arts.values())
    print("%s：%d 條、%d 筆沿革、%d 次立法 → %s" % (law, len(arts), n, len(events), out))
    return res


if __name__ == "__main__":
    for name in sys.argv[1:] or ["職業安全衛生法"]:
        fetch(name)
