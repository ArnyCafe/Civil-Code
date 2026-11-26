#!/usr/bin/env python3
"""
建立各條之附加資料：
  data/xref.json         各條「被其他法典引用」之反查索引（如施行細則「本法第六條」→ 職安法第6條）
  data/extra/osh.json    職業安全衛生法：重要判決、判決引用之函釋、相關法條、授權子法

需先執行 tools/build_laws.py、tools/fetch_judgments.py。
用法：python3 tools/build_extra.py
"""
import difflib
import html
import json
import os
import re
import subprocess
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from xref import make_resolver, num as cnum  # noqa: E402
import curated_osh  # noqa: E402

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache")
FJ = os.path.join(CACHE, "fj")
MOJ = "https://law.moj.gov.tw"
JUD = "https://judgment.judicial.gov.tw/FJUD/data.aspx?ty=JD&id="


def load_lib():
    lib = json.load(open(os.path.join(ROOT, "data", "laws.json"), encoding="utf-8"))["laws"]
    laws = {e["id"]: json.load(open(os.path.join(ROOT, e["file"]), encoding="utf-8")) for e in lib}
    return lib, laws


# ---------------------------------------------------------------------------
# 反查索引
# ---------------------------------------------------------------------------
def build_xref(lib, laws):
    refs = make_resolver(lib)
    idx = {}
    for e in lib:
        d = laws[e["id"]]
        order = [a["id"] for a in d["articles"]]
        for a in d["articles"]:
            seen = set()
            for p in a["p"]:
                for s, en, law, aid in refs(p, e["id"], a["id"], order):
                    if law == e["id"] or (law, aid) in seen:
                        continue
                    seen.add((law, aid))
                    idx.setdefault("%s:%s" % (law, aid), []).append("%s:%s" % (e["id"], a["id"]))
    with open(os.path.join(ROOT, "data", "xref.json"), "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, separators=(",", ":"))
    print("反查索引：%d 條被引用" % len(idx))


# ---------------------------------------------------------------------------
# 授權子法（全國法規資料庫「授權子法」頁）
# ---------------------------------------------------------------------------
def get(url, path, minsize=3000):
    if os.path.exists(path) and os.path.getsize(path) > minsize:
        return open(path, encoding="utf-8", errors="ignore").read()
    for i in range(6):
        r = subprocess.run(["curl", "-sS", "-m", "90", "-o", path, url], stderr=subprocess.DEVNULL)
        if r.returncode == 0 and os.path.exists(path) and os.path.getsize(path) > minsize:
            time.sleep(0.4)
            return open(path, encoding="utf-8", errors="ignore").read()
        time.sleep(3 * (i + 1))
    raise RuntimeError(url)


def sub_laws(pcode, aids, lib):
    by_pcode = {e["pcode"]: e["id"] for e in lib}
    out = {}
    d = os.path.join(CACHE, "moj", "rela")
    os.makedirs(d, exist_ok=True)
    for aid in aids:
        single = get(MOJ + "/LawClass/LawSingle.aspx?pcode=%s&flno=%s" % (pcode, aid), os.path.join(d, "s_%s_%s.html" % (pcode, aid)))
        if "ty=S" not in single:
            continue
        t = get(MOJ + "/LawClass/LawSingleRela.aspx?PCODE=%s&FLNO=%s&ty=S" % (pcode, aid), os.path.join(d, "S_%s_%s.html" % (pcode, aid)))
        items = []
        for pc, name in re.findall(r'LawAll\.aspx\?pcode=(\w+)">([^<]+)</a>', t):
            if pc == pcode:
                continue
            m = re.match(r"(.+?)（民國\s*(\d+)\s*年\s*(\d+)\s*月\s*(\d+)\s*日\s*）", name.strip())
            nm, date = (m.group(1), "%d.%s.%s" % (int(m.group(2)), m.group(3), m.group(4))) if m else (name.strip(), "")
            it = {"name": nm, "pcode": pc, "date": date}
            if pc in by_pcode:
                it["law"] = by_pcode[pc]
            items.append(it)
        if items:
            out[aid] = items
    return out


# ---------------------------------------------------------------------------
# 判決
# ---------------------------------------------------------------------------
ARTNUM = r"([\d]+|[零〇一二三四五六七八九十百]+)"
CITE = re.compile(r"(職業安全衛生法|職安法|勞工安全衛生法|勞安法)(?:（(?:下稱|以下簡稱)[^）]{1,8}）)?第\s*%s\s*條(?:\s*之\s*%s)?" % (ARTNUM, ARTNUM))
GOOD = re.compile(r"所謂|係指|乃指|意旨|立法目的|立法理由|保護他人之法律|旨在|目的在|規範目的|係為|乃為|核屬|應負|即應|始得|並非|不以|自應|應認|揆諸|準此")
OPEN = re.compile(r"^(?:[㈠-㈩⑴-⒇（(]?[一二三四五六七八九十\d]+[）)、.]?)?(?:惟|又|次|再|復|另|末|且|而|然)?按")
BAD = re.compile(r"鈞院|理由稱|理由略謂|略以|意旨略謂|上訴人已|上訴人並|聲請意旨|非常上訴意旨|上訴人(?:等)?(?:主張|抗辯|起訴|則以|另以|陳稱)|被上訴人(?:主張|抗辯|則以|陳稱)|辯稱|伊|起訴主張|上訴意旨|上訴理由|抗告意旨|原告主張|被告主張")
PROC = re.compile(r"不得上訴(?:於)?第三審|第三百七十六條|第376條|上訴(?:為)?不合法|違背法律上之程式|無從併予|併予駁回|從程序上|核其所為|核.{0,12}所為，?係犯|論以|量處|宣告緩刑|發回|撤銷改判")
FACT = re.compile(r"竟|疏未|疏於|當時|當日|是日|送醫|不治|前往|\d+元|[一二三四五六七八九十百千萬]+元|民國\S{1,8}年\S{1,3}月|系爭|公司|工地|現場|罹災者|被害人")


def unwrap(t):
    lines = t.split("\n")
    out = []
    for l in lines:
        l = l.strip()
        if not l:
            continue
        out.append(l)
    s = "".join(out)
    return s


def parties(raw):
    """從裁判書首部取得當事人等姓名，以便擷取段落時遮蔽。"""
    names = set()
    head = raw.split("主  文")[0].split("主文")[0][:3000]
    for l in head.split("\n"):
        m = re.match(r"^\s*(上\s*訴\s*人|被\s*上\s*訴\s*人|被\s*告|原\s*告|參\s*加\s*人|法定代理人|訴訟代理人|選任辯護人|代\s*表\s*人|輔\s*佐\s*人|共\s*同|再審原告|再審被告)?\s*(.+)$", l)
        if not m:
            continue
        val = m.group(2).strip()
        if m.group(1) or re.match(r"^[一-鿿○]{2,4}$", val):
            for part in re.split(r"[\s　、]+", val):
                part = part.strip()
                if re.fullmatch(r"[一-鿿○]{2,4}", part) and not re.search(r"律師|公司|法院|檢察|主任|地方|高等", part):
                    names.add(part)
    return names


def redact(s, names):
    for n in sorted(names, key=len, reverse=True):
        if len(n) >= 2:
            s = s.replace(n, n[0] + "○" * (len(n) - 1))
    return s


def old_map(osh):
    """勞工安全衛生法（80～102年）條次 → 現行條次"""
    m = {}
    for aid, vs in osh["changes"].items():
        for v in vs:
            if "19910517" <= v["d"] < "20130703":
                m[v.get("no", aid)] = aid
    return m


def sentences(s):
    out, cur = [], ""
    for ch in s:
        cur += ch
        if ch == "。":
            out.append(cur)
            cur = ""
    if cur:
        out.append(cur)
    return out


def score(sent):
    sc = 0
    if OPEN.search(sent[:8]):
        sc += 4
    sc += 2 * min(3, len(GOOD.findall(sent)))
    if BAD.search(sent):
        sc -= 6
    if PROC.search(sent):
        sc -= 8
    sc -= 2 * min(3, len(FACT.findall(sent)))
    if "原審" in sent or "原判決" in sent:
        sc -= 2
    if len(sent) < 30:
        sc -= 3
    if len(sent) > 420:
        sc -= 2
    return sc


def norm_txt(s):
    return re.sub(r"[，、；：。「」『』（）()\s]", "", s)


INTERP = re.compile(
    r"(行政院勞工委員會|勞委會|勞動部職業安全衛生署|職業安全衛生署|職安署|勞動部|內政部)"
    r"\s*((?:民國)?\s*[\d零〇○一二三四五六七八九十百]{2,6}\s*年\s*[\d一二三四五六七八九十]{1,3}\s*月\s*[\d一二三四五六七八九十]{1,3}\s*日)?"
    r"\s*([一-鿿\d（）()]{1,14}?字第\s*[\d零〇○一二三四五六七八九]+\s*號)\s*(函釋|函示|解釋令|令釋|函|令)?")
CASE_LETTER = re.compile(r"附卷|在卷|卷附|卷可|可稽|可參|可佐|可證|函覆|函復|檢送|檢附|函送|移送|附於|為憑|為證")


def canon_no(s):
    tr = str.maketrans("零〇○一二三四五六七八九", "00012345678 9".replace(" ", ""))
    return re.sub(r"\s+", "", s).translate(tr)


def judgments(osh):
    items = json.load(open(os.path.join(FJ, "list.json"), encoding="utf-8"))
    omap = old_map(osh)
    cur_ids = {a["id"] for a in osh["articles"]}
    found = {}   # aid -> list of hits
    interps = {}  # canon no -> {...}
    for it in items:
        if not it["title"].endswith("判決"):
            continue
        p = os.path.join(FJ, "doc", re.sub(r"[^\w]", "_", it["id"]) + ".txt")
        if not os.path.exists(p):
            continue
        raw = open(p, encoding="utf-8").read()
        names = parties(raw)
        body = unwrap(raw)
        k = body.find("理由")
        body = body[k:] if k > 0 else body
        body = body.split("中華民國")[0] if False else body
        sents = sentences(body)
        court, ysys = it["id"].split(",")[0][:3], it["id"].split(",")[0][3:]
        sysname = {"V": "民事", "M": "刑事", "A": "行政"}.get(ysys[-1], "")
        for i, s in enumerate(sents):
            for m in CITE.finditer(s):
                n = cnum(m.group(2))
                aid = "%d-%d" % (n, cnum(m.group(3))) if m.group(3) else str(n)
                old = m.group(1) in ("勞工安全衛生法", "勞安法")
                if old:
                    if re.search(r"六十三年|63年|民國63", s):
                        continue  # 引述 63 年舊條次，無法對應
                    aid = omap.get(aid)
                if not aid or aid not in cur_ids:
                    continue
                ex = s
                if OPEN.search(s[:8]) and i + 1 < len(sents) and re.match(r"^(是|此|故|準此|揆其|其立法|又|且|即|亦即|易言之|換言之)", sents[i + 1]) and len(s) + len(sents[i + 1]) < 520:
                    ex = s + sents[i + 1]
                sc = score(ex)
                hits = found.setdefault(aid, {})
                key = it["id"]
                if key not in hits or hits[key]["sc"] < sc:
                    hits[key] = {"id": it["id"], "no": it["title"], "date": it["date"], "cause": it.get("cause", ""),
                                 "sys": sysname, "court": "最高行政法院" if court == "TPA" else "最高法院",
                                 "text": redact(ex.strip(), names), "sc": sc, "old": old}
            # 函釋
            for m in INTERP.finditer(s):
                ctx = s
                if CASE_LETTER.search(ctx[m.start():m.end() + 12]) or "檢查所" in ctx[max(0, m.start() - 8):m.end()] or "檢查處" in ctx[max(0, m.start() - 8):m.end()]:
                    continue
                if not re.search(r"參照|意旨|函釋|函示|解釋|認為|認定|可知|指出|表示", ctx):
                    continue
                arts = set()
                for cm in CITE.finditer(s):
                    n = cnum(cm.group(2))
                    a = "%d-%d" % (n, cnum(cm.group(3))) if cm.group(3) else str(n)
                    if cm.group(1) in ("勞工安全衛生法", "勞安法"):
                        a = omap.get(a)
                    if a in cur_ids:
                        arts.add(a)
                if not arts:
                    continue
                no = re.sub(r"\s+", "", "".join(x for x in m.group(1, 2, 3) if x)) + (m.group(4) or "函")
                key = canon_no(m.group(3))
                ent = interps.setdefault(key, {"no": no, "arts": set(), "ctx": [], "from": []})
                ent["arts"].update(arts)
                a0 = max(0, m.start() - 160)
                c = redact((("…" if a0 else "") + ctx[a0:m.end() + 60] + ("…" if m.end() + 60 < len(ctx) else "")).strip(), names)
                if len(c) < 600 and c not in ent["ctx"]:
                    ent["ctx"].append(c)
                ref = {"no": it["title"], "id": it["id"]}
                if ref not in ent["from"]:
                    ent["from"].append(ref)

    # 依文字相似度分群：同旨判決合併，引用次數多者視為重要
    judg = {}
    for aid, hits in found.items():
        lst = sorted(hits.values(), key=lambda h: (-h["sc"], h["id"]))
        lst = [h for h in lst if h["sc"] >= 4 and not any(x in h["no"] for x in curated_osh.JUDG_EXCLUDE.get(aid, []))]
        groups = []
        for h in lst:
            nt = norm_txt(h["text"])
            for g in groups:
                if difflib.SequenceMatcher(None, nt, g["nt"], autojunk=False).quick_ratio() > 0.75 and \
                        difflib.SequenceMatcher(None, nt, g["nt"], autojunk=False).ratio() > 0.72:
                    g["same"].append(h)
                    break
            else:
                groups.append({"nt": nt, "rep": h, "same": []})
        for g in groups:
            # 代表：最新之判決
            allh = [g["rep"]] + g["same"]
            allh.sort(key=lambda h: h["id"].split(",")[4] if len(h["id"].split(",")) > 4 else "", reverse=True)
            g["rep"], g["same"] = allh[0], allh[1:]
            g["w"] = g["rep"]["sc"] + 3 * len(g["same"])
        groups.sort(key=lambda g: (-g["w"], g["rep"]["id"]))
        out = []
        for g in groups[:8]:
            r = g["rep"]
            out.append({"court": r["court"], "sys": r["sys"], "no": r["no"], "date": r["date"], "cause": r["cause"],
                        "url": JUD + r["id"], "text": r["text"], "old": r["old"],
                        "same": [{"no": s["no"], "url": JUD + s["id"]} for s in g["same"][:12]],
                        "nsame": len(g["same"])})
        if out:
            judg[aid] = out
    interp = {}
    for key, ent in interps.items():
        best = sorted(ent["ctx"], key=lambda c: (-len(GOOD.findall(c)), len(c)))[0]
        for aid in ent["arts"]:
            interp.setdefault(aid, []).append({"no": ent["no"], "text": best, "from": ent["from"][:6], "n": len(ent["from"])})
    for aid in interp:
        interp[aid].sort(key=lambda x: -x["n"])
        interp[aid] = interp[aid][:10]
    return judg, interp


def update_index():
    """在 data/laws.json 標註有附加資料之法典"""
    p = os.path.join(ROOT, "data", "laws.json")
    idx = json.load(open(p, encoding="utf-8"))
    for e in idx["laws"]:
        if os.path.exists(os.path.join(ROOT, "data", "extra", e["id"] + ".json")):
            e["extra"] = "data/extra/%s.json" % e["id"]
    with open(p, "w", encoding="utf-8") as f:
        json.dump(idx, f, ensure_ascii=False, indent=1)


def main():
    lib, laws = load_lib()
    build_xref(lib, laws)
    osh = laws["osh"]
    aids = [a["id"] for a in osh["articles"]]
    sub = sub_laws("N0060001", aids, lib)
    print("授權子法：%d 條" % len(sub))
    judg, interp = judgments(osh)
    print("判決：%d 條、%d 則；函釋：%d 條、%d 則" % (len(judg), sum(len(v) for v in judg.values()),
                                              len(interp), sum(len(v) for v in interp.values())))
    rel = curated_osh.RELATED
    # 檢查相關法條是否存在
    for aid, lst in rel.items():
        for law, a, _ in lst:
            if not any(x["id"] == a for x in laws[law]["articles"]):
                print("  相關法條不存在：", law, a)
    out = {"judg": judg, "interp": interp, "rel": rel, "sub": sub,
           "note": {"judg": "最高法院、最高行政法院判決中引用本條之段落（自動擷取，當事人姓名已遮蔽）；同旨判決合併列示。",
                    "interp": "最高法院、最高行政法院判決所引用之勞動部（原行政院勞工委員會）函釋，文字為判決所述內容。"}}
    os.makedirs(os.path.join(ROOT, "data", "extra"), exist_ok=True)
    with open(os.path.join(ROOT, "data", "extra", "osh.json"), "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    update_index()
    print("→ data/extra/osh.json %.0f KB" % (os.path.getsize(os.path.join(ROOT, "data", "extra", "osh.json")) / 1024))


if __name__ == "__main__":
    main()
