#!/usr/bin/env python3
"""
從「全國法規資料庫」(law.moj.gov.tw) 下載民法現行條文與歷次修正版本，
產生 data/civil.json（條文、目錄、各條文新舊版本沿革）。

用法：
    python3 tools/build_data.py            # 下載（有快取）並建立資料
    python3 tools/build_data.py --refresh  # 重新下載現行條文

需求：Python 3.8+、curl（無第三方套件）
"""
import difflib
import html
import io
import json
import os
import re
import subprocess
import sys
import time
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
OUT = os.path.join(ROOT, "data", "civil.json")
PCODE = "B0000001"
API = "https://law.moj.gov.tw/api/Ch/Law/JSON"
OLDVER = "https://law.moj.gov.tw/LawClass/LawOldVer.aspx?pcode={p}&lnndate={d}&lser={s}"

CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "三": 3, "四": 4, "五": 5,
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
    return total + cur


def fetch(url, path, tries=5):
    if os.path.exists(path) and os.path.getsize(path) > 2000:
        return path
    for i in range(tries):
        r = subprocess.run(["curl", "-sS", "-m", "90", "-o", path, url])
        if r.returncode == 0 and os.path.exists(path):
            return path
        time.sleep(3 * (i + 1))
    raise RuntimeError("下載失敗：" + url)


def load_current(refresh=False):
    zp = os.path.join(CACHE, "ChLaw.zip")
    if refresh and os.path.exists(zp):
        os.remove(zp)
    fetch(API, zp)
    with zipfile.ZipFile(zp) as z:
        raw = z.read("ChLaw.json").decode("utf-8-sig")
    data = json.loads(raw)
    for law in data["Laws"]:
        if law["LawURL"].endswith("pcode=" + PCODE):
            return law, data.get("UpdateDate", "")
    raise RuntimeError("找不到民法")


def history_dates(hist):
    flat = re.sub(r"\s+", "", hist)
    out = set()
    for y, m, d in re.findall(
            r"中華民國([一二三四五六七八九十百零]+)年([一二三四五六七八九十]+)月([一二三四五六七八九十]+)日", flat):
        out.add("%04d%02d%02d" % (cn2int(y) + 1911, cn2int(m), cn2int(d)))
    return sorted(out)


def history_items(hist):
    """把沿革文字切成 [{n, text, dates}]"""
    lines = hist.replace("\r", "").split("\n")
    items, cur = [], None
    for ln in lines:
        m = re.match(r"^\s*(\d+)\.\s*(.*)$", ln)
        if m:
            cur = {"n": int(m.group(1)), "text": m.group(2).strip()}
            items.append(cur)
        elif cur is not None:
            cur["text"] += ln.strip()
    for it in items:
        it["text"] = re.sub(r"\s+", "", it["text"])
        it["text"] = re.sub(r"(?<=[\d、～])(?=\d)", "", it["text"])
        it["dates"] = history_dates(it["text"])
    return items


def item_articles(text):
    """從沿革文字取出條號集合（含範圍「～」與「之一」型條號）。"""
    out = set()
    for seg in re.findall(r"第([\d\-、～]+)條", text):
        for tok in seg.split("、"):
            if not tok:
                continue
            if "～" in tok:
                a, b = tok.split("～", 1)
                if "-" in a and "-" in b and a.split("-")[0] == b.split("-")[0]:
                    base = a.split("-")[0]
                    for i in range(int(a.split("-")[1]), int(b.split("-")[1]) + 1):
                        out.add("%s-%d" % (base, i))
                elif a.isdigit() and b.isdigit():
                    for i in range(int(a), int(b) + 1):
                        out.add(str(i))
                else:
                    out.update([a, b])
            else:
                out.add(tok)
    return out


def strip_punct(s):
    return re.sub(r"[，、；：。「」『』（）()\s]", "", s)


def minor_edit(a, b):
    """沿革未列的條號，若僅標點或少數字差異，視為資料庫勘誤。"""
    if strip_punct(a) == strip_punct(b):
        return True
    sm = difflib.SequenceMatcher(None, a, b)
    changed = sum(max(i2 - i1, j2 - j1) for op, i1, i2, j1, j2 in sm.get_opcodes() if op != "equal")
    return changed <= 4


def split_paras_current(content):
    return [p.strip() for p in content.replace("\r", "").split("\n") if p.strip()]


KUAN = re.compile(r"^[（(]?[一二三四五六七八九十]+[、)）]")


def unwrap_pre(text):
    """舊版網頁條文為固定寬度換行，需還原為項／款。"""
    lines = [l.rstrip() for l in text.replace("\r", "").split("\n")]
    lines = [l for l in lines if l.strip()]
    paras = []
    for ln in lines:
        s = ln.strip()
        if not paras:
            paras.append(s)
            continue
        prev = paras[-1]
        starts_punct = s[:1] in "。，、；：」）』"
        ends = prev[-1:] in "。：；" and not starts_punct
        if ends or (KUAN.match(s) and not starts_punct):
            paras.append(s)
        else:
            paras[-1] = prev + s
    return paras


def parse_version(path):
    t = open(path, encoding="utf-8", errors="ignore").read()
    m = re.search(r"修正日期：</th>\s*<td>([^<]*)", t)
    label = re.sub(r"\s+", "", m.group(1)) if m else ""
    arts = {}
    for chunk in t.split('<div class="row">')[1:]:
        mno = re.search(r'<div class="col-no">\s*(?:<a[^>]*>)?([^<]+?)(?:</a>)?\s*</div>', chunk)
        mdata = re.search(r'<div class="col-data([^"]*)">(.*)', chunk, re.S)
        if not mno or not mdata:
            continue
        no, cls, body = mno.group(1).strip(), mdata.group(1), mdata.group(2)
        body = re.split(r'<div class="h3|<footer', body)[0]
        if "text-pre" in cls:
            body = body.split("</div>")[0]
            paras = unwrap_pre(html.unescape(re.sub(r"<[^>]+>", "", body)))
        else:
            paras = [html.unescape(re.sub(r"<[^>]+>", "", x)).strip()
                     for x in re.findall(r'<div class="line-\d+[^"]*">(.*?)</div>', body, re.S)]
            paras = [p for p in paras if p]
        mm = re.match(r"第\s*([\d\-]+)\s*條", no)
        if mm:
            arts[mm.group(1)] = paras
    return label, arts


def norm(paras):
    s = "".join(paras)
    s = re.sub(r"\s+", "", s)
    return s.replace("(", "（").replace(")", "）").replace(",", "，")


def art_key(aid):
    a, _, b = aid.partition("-")
    return (int(a), int(b or 0))


def main():
    refresh = "--refresh" in sys.argv
    os.makedirs(os.path.join(CACHE, "ver"), exist_ok=True)
    law, update_date = load_current(refresh)

    # ---- 現行條文與目錄 ----
    headings, articles = [], []
    stack = []  # (level, idx)
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            raw = a["ArticleContent"]
            level = (len(raw) - len(raw.lstrip(" "))) // 3
            title = re.sub(r"\s+", " ", raw.strip())
            title = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", title)
            title = re.sub(r"(第\S+?(?:編|章|節|款|目)(?:之[一二三四五六七八九十]+)?)\s*", r"\1 ", title, count=1).strip()
            while stack and stack[-1][0] >= level:
                stack.pop()
            idx = len(headings)
            headings.append({"t": title, "lv": level,
                             "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, idx))
        else:
            mm = re.match(r"第\s*([\d\-]+)\s*條", a["ArticleNo"])
            aid = mm.group(1)
            paras = split_paras_current(a["ArticleContent"])
            hidx = stack[-1][1] if stack else -1
            for lv, hi in stack:
                if headings[hi]["first"] is None:
                    headings[hi]["first"] = aid
            articles.append({"id": aid, "h": hidx, "p": paras,
                             "del": norm(paras) in ("（刪除）", "刪除")})

    # ---- 歷次版本 ----
    dates = history_dates(law["LawHistories"])
    versions = []
    for d in dates:
        for ser in ("001", "002"):
            path = os.path.join(CACHE, "ver", "%s_%s.html" % (d, ser))
            if not (os.path.exists(path) and os.path.getsize(path) > 2000):
                if os.path.exists(path + ".none"):
                    continue
                try:
                    subprocess.run(["curl", "-sS", "-m", "90", "-o", path,
                                    OLDVER.format(p=PCODE, d=d, s=ser)], check=True)
                    time.sleep(1)
                except subprocess.CalledProcessError:
                    time.sleep(5)
                    continue
            if not os.path.exists(path):
                continue
            label, arts = parse_version(path)
            if not arts:
                os.remove(path)
                open(path + ".none", "w").close()
                continue
            versions.append({"d": d, "ser": ser, "label": label, "arts": arts})
            print("版本", d, ser, label, len(arts), "條", flush=True)

    items = history_items(law["LawHistories"])
    final_date = max(dates)
    cur_map = {a["id"]: a["p"] for a in articles}
    seq = [(v["d"], v["arts"]) for v in versions]
    if not versions or norm_all(versions[-1]["arts"]) != norm_all(cur_map):
        seq.append((final_date, cur_map))

    listed = {}
    for it in items:
        arts_in = item_articles(it["text"])
        for d in it["dates"]:
            listed.setdefault(d, set()).update(arts_in)

    history = {}
    last = {}
    unlisted = []
    for d, arts in seq:
        for aid, paras in arts.items():
            n = norm(paras)
            if aid not in last:
                history.setdefault(aid, []).append({"d": d, "p": paras, "k": "new"})
            elif last[aid] != n:
                if aid not in listed.get(d, ()) and minor_edit(last[aid], n):
                    # 資料庫標點校正，非實質修正：不列為修正，但記錄最新文字
                    history[aid][-1]["p2"] = paras
                else:
                    if aid not in listed.get(d, ()):
                        unlisted.append((aid, d))
                    k = "del" if n in ("（刪除）", "刪除") else "amend"
                    history[aid].append({"d": d, "p": paras, "k": k})
            last[aid] = n
    if unlisted:
        print("注意：以下變動未見於沿革條號清單（仍列入）：", unlisted)
    # 第一個版本視為「制定」
    for aid, hs in history.items():
        if hs[0]["d"] in dates[:7]:
            hs[0]["k"] = "orig"

    # 對應沿革項目
    def item_for(d):
        for it in items:
            if d in it["dates"]:
                return it["n"]
        return None

    ver_list = []
    for d in sorted({d for d, _ in seq}):
        ver_list.append({"d": d, "item": item_for(d)})

    changed = {aid: hs for aid, hs in history.items() if len(hs) > 1}
    for a in articles:
        hs = history.get(a["id"], [])
        a["v"] = len(hs)
        if hs:
            a["since"] = hs[0]["d"]
            a["last"] = hs[-1]["d"]

    eff_note = re.sub(r"\s*\r?\n\s*", "", law["LawEffectiveNote"])
    out = {
        "meta": {
            "name": law["LawName"],
            "eng": law.get("EngLawName", ""),
            "pcode": PCODE,
            "modified": law["LawModifiedDate"],
            "effectiveNote": eff_note,
            "source": "全國法規資料庫 law.moj.gov.tw（法務部）",
            "sourceUpdate": update_date,
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "pending": {"1223": "20260817"} if "1223" in changed else {},
        },
        "histories": [{"n": it["n"], "t": it["text"], "dates": it["dates"]} for it in items],
        "versions": ver_list,
        "headings": headings,
        "articles": articles,
        "changes": {aid: [{"d": h["d"], "k": h["k"], "p": h["p"]} for h in hs]
                    for aid, hs in sorted(changed.items(), key=lambda x: art_key(x[0]))},
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    print("完成：%d 條、%d 條有修正沿革、%d 個版本 → %s (%.0f KB)" % (
        len(articles), len(changed), len(ver_list), OUT, os.path.getsize(OUT) / 1024))


def norm_all(m):
    return {k: norm(v) for k, v in m.items()}


if __name__ == "__main__":
    main()
