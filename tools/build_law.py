#!/usr/bin/env python3
"""
建立單一法規的資料檔 data/<id>.json 與 data/<id>-rulings.json。

  現行條文、編章節 ── 全國法規資料庫 law.moj.gov.tw（LawAll.aspx）
  歷次條文＋立法理由 ── 法律：立法院法律系統 lis.ly.gov.tw「法條沿革」
                      命令：全國法規資料庫「歷史條文」（LawOldVer.aspx）＋條文對照表連結
  相關判解 ────────── 全國法規資料庫各條「憲法法庭裁判」「大法官解釋」「判例」

用法：
    python3 tools/build_law.py lpa            # 勞工退休金條例
    python3 tools/build_law.py lpar           # 勞工退休金條例施行細則
    python3 tools/build_law.py lsa            # 勞動基準法
    python3 tools/build_law.py all --refresh  # 全部重新下載

需求：Python 3.8+（無第三方套件）
"""
import html
import json
import os
import re
import ssl
import sys
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "laws")
MOJ = "https://law.moj.gov.tw"
LY = "https://lis.ly.gov.tw"

LAWS = {
    "lpa": {"name": "勞工退休金條例", "short": "勞退條例", "pcode": "N0030020", "ly": "03623", "kind": "law"},
    "lpar": {"name": "勞工退休金條例施行細則", "short": "勞退細則", "pcode": "N0030021", "kind": "order"},
    "lsa": {"name": "勞動基準法", "short": "勞基法", "pcode": "N0030001", "ly": "01139", "kind": "law"},
}

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
    return total + cur


# ---------------------------------------------------------------------------
# 下載
# ---------------------------------------------------------------------------
_ctx = ssl.create_default_context(cafile=os.environ.get("SSL_CERT_FILE") or None)
# 立法院法律系統的伺服器只支援舊式 TLS 重新協商（仍驗證憑證）
_ctx.options |= getattr(ssl, "OP_LEGACY_SERVER_CONNECT", 0x4)
REFRESH = False


def fetch(url, name, minsize=1500):
    path = os.path.join(CACHE, name)
    if not REFRESH and os.path.exists(path) and os.path.getsize(path) >= minsize:
        return open(path, "rb").read().decode("utf-8", "ignore")
    last = None
    for i in range(6):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0 (law-notes builder)"})
            b = urllib.request.urlopen(req, context=_ctx, timeout=90).read()
            if len(b) >= minsize:
                open(path, "wb").write(b)
                time.sleep(0.3)
                return b.decode("utf-8", "ignore")
            last = "too small (%d)" % len(b)
        except Exception as e:  # noqa
            last = e
        time.sleep(2 + 3 * i)
    raise RuntimeError("下載失敗 %s：%s" % (url, last))


def clean(s):
    s = re.sub(r"<br\s*/?>", "\n", s, flags=re.I)
    s = html.unescape(re.sub(r"<[^>]+>", "", s))
    return s


def paras_of(s):
    out = []
    for ln in clean(s).replace("\r", "").split("\n"):
        ln = ln.strip().strip("　").strip()
        if ln:
            out.append(ln)
    return out


def norm(paras):
    s = re.sub(r"\s+", "", "".join(paras))
    return s.replace("(", "（").replace(")", "）").replace(",", "，").replace(";", "；").replace(":", "：")


def art_key(aid):
    a, _, b = aid.partition("-")
    return (int(a), int(b or 0))


def roc_dates(text):
    flat = re.sub(r"\s+", "", text)
    out = []
    for y, m, d in re.findall(r"中華民國([一二三四五六七八九十百零〇]+)年([一二三四五六七八九十]+)月([一二三四五六七八九十]+)日", flat):
        out.append("%04d%02d%02d" % (cn2int(y) + 1911, cn2int(m), cn2int(d)))
    return out


# ---------------------------------------------------------------------------
# 現行條文（全國法規資料庫）
# ---------------------------------------------------------------------------
def parse_lawall(t):
    meta = {}
    m = re.search(r"修正日期：</th>\s*<td>([^<]*)", t) or re.search(r"發布日期：</th>\s*<td>([^<]*)", t)
    if m:
        y, mo, d = re.findall(r"\d+", m.group(1))[:3]
        meta["modified"] = "%04d%02d%02d" % (int(y) + 1911, int(mo), int(d))
    m = re.search(r'id="trLNNEffectiveNote".*?<td[^>]*>(.*?)</td>', t, re.S)
    if m:
        meta["effectiveNote"] = re.sub(r"\s+", "", clean(m.group(1)))
    body = t[t.find('law-reg-content'):]
    body = body[:body.find('<footer')] if '<footer' in body else body
    headings, articles, stack = [], [], []
    toks = list(re.finditer(r'<div class="h3 char-(\d)">(.*?)</div>|<div class="row">', body, re.S))
    for i, m in enumerate(toks):
        if m.group(1):
            level = int(m.group(1)) - 2
            title = re.sub(r"\s+", " ", clean(m.group(2)).strip())
            title = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", title)
            while stack and stack[-1][0] >= level:
                stack.pop()
            idx = len(headings)
            headings.append({"t": title, "lv": level, "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, idx))
            continue
        row = body[m.end():toks[i + 1].start() if i + 1 < len(toks) else len(body)]
        mno = re.search(r'name="([\d\-]+)"[^>]*>\s*第\s*([\d\-]+)\s*條', row)
        if not mno:
            continue
        aid = mno.group(2)
        paras = [clean(x).strip() for x in re.findall(r'<div class="line-\d+[^"]*">(.*?)</div>', row, re.S)]
        paras = [p for p in paras if p]
        if not paras:
            mm = re.search(r'<div class="law-article">(.*?)</div>', row, re.S)
            paras = paras_of(mm.group(1)) if mm else []
        for _, hi in stack:
            if headings[hi]["first"] is None:
                headings[hi]["first"] = aid
        articles.append({"id": aid, "h": stack[-1][1] if stack else -1, "p": paras,
                         "del": norm(paras) in ("（刪除）", "刪除")})
    return meta, headings, articles


def parse_history_page(t):
    """全國法規資料庫「沿革」頁：沿革文字、各版本日期、條文對照表連結。"""
    s = re.sub(r"<script.*?</script>", "", t, flags=re.S)
    items = []
    seg = s[s.find("law-reg-content"):] if "law-reg-content" in s else s
    for stop in ("<footer", ":::"):
        if stop in seg:
            seg = seg[:seg.find(stop)]
    txt = clean(seg)
    for m in re.finditer(r"(?m)^\s*(\d+)\.\s*(中華民國.*?)(?=^\s*\d+\.\s*中華民國|\Z)", txt, re.S):
        body = re.sub(r"\s+", "", m.group(2))
        body = re.sub(r"(歷史條文|立法總說明|條文對照表)+$", "", body)
        body = re.sub(r"(?<=[\d、～])(?=\d)", "", body)
        items.append({"n": int(m.group(1)), "t": body, "dates": sorted(set(roc_dates(body)))})
    items.sort(key=lambda x: x["n"])
    files = {}
    for href, label in re.findall(r'<a href="(/LawClass/LawGet(?:File|Desc)\.ashx\?[^"]+)"[^>]*>\s*(條文對照表|立法總說明)', s):
        href = html.unescape(href)
        d = re.search(r"date=(\d{8})", href)
        if d:
            files.setdefault(d.group(1), {})["cmp" if label == "條文對照表" else "desc"] = MOJ + href
    oldver = sorted(set(re.findall(r"lnndate=(\d{8})&(?:amp;)?lser=(\d{3})", s)))
    return items, files, oldver


# ---------------------------------------------------------------------------
# 立法院法律系統：法條沿革（歷次條文＋理由）
# ---------------------------------------------------------------------------
def ly_history(code):
    t = fetch("https://www.ly.gov.tw/Pages/ashx/LawRedirect.ashx?CODE=" + code, "ly_%s_index.html" % code, 3000)
    # 立法院三讀日 → 總統公布日
    flat = re.sub(r"\s+", "", clean(t))
    pairs = re.findall(r"中華民國(\d+)年(\d+)月(\d+)日(制定|修正|增訂|廢止)中華民國(\d+)年(\d+)月(\d+)日公布", flat)
    pass2pub = {}
    for y, m, d, _k, y2, m2, d2 in pairs:
        pass2pub["%04d%02d%02d" % (int(y) + 1911, int(m), int(d))] = "%04d%02d%02d" % (int(y2) + 1911, int(m2), int(d2))
    link = None
    for _q, href, label in re.findall(r'(?i)<a\s[^>]*?href=([\'"]?)([^\'" >]+)\1[^>]*>(.*?)</a>', t, re.S):
        if "法條沿革" in clean(label):
            link = html.unescape(href)
            break
    if not link:
        raise RuntimeError("找不到法條沿革連結")
    h = fetch(LY + link, "ly_%s_hist.html" % code, 5000)
    out = {}
    blocks = re.split(r'<font class="artino">', h)[1:]
    for b in blocks:
        mno = re.match(r"\s*第([一二三四五六七八九十百零〇]+)條(?:\s*之([一二三四五六七八九十]+))?", clean(b.split("</font>")[0]))
        if not mno:
            continue
        aid = str(cn2int(mno.group(1))) + ("-%d" % cn2int(mno.group(2)) if mno.group(2) else "")
        vers = []
        for vm in re.finditer(r'<font class="upddate">\((\d{7})(?:&nbsp;|\s)*([^)<]*)\)</font>(.*?)(?=<font class="upddate">|\Z)', b, re.S):
            ymd = vm.group(1)
            dpass = "%04d%s" % (int(ymd[:3]) + 1911, ymd[3:])
            kind = clean(vm.group(2)).strip()
            seg = vm.group(3)
            tx = re.search(r"artiupd_TH_2[^>]*>(.*?)</td>", seg, re.S)
            rs = re.search(r"artiupd_RS_2[^>]*>(.*?)</td>", seg, re.S)
            vers.append({
                "pass": dpass, "kind": kind,
                "p": paras_of(tx.group(1)) if tx else [],
                "r": paras_of(rs.group(1)) if rs else [],
            })
        out[aid] = vers
    return out, pass2pub


def ly_kind(k):
    if "刪除" in k:
        return "del"
    if "增訂" in k:
        return "new"
    if "制定" in k:
        return "orig"
    return "amend"


# ---------------------------------------------------------------------------
# 命令：全國法規資料庫歷史條文
# ---------------------------------------------------------------------------
def parse_oldver(t):
    arts = {}
    for chunk in t.split('<div class="row">')[1:]:
        mno = re.search(r'<div class="col-no">\s*(?:<a[^>]*>)?([^<]+?)(?:</a>)?\s*</div>', chunk)
        mdata = re.search(r'<div class="col-data([^"]*)">(.*)', chunk, re.S)
        if not mno or not mdata:
            continue
        body = re.split(r'<div class="h3|<footer', mdata.group(2))[0]
        paras = [clean(x).strip() for x in re.findall(r'<div class="line-\d+[^"]*">(.*?)</div>', body, re.S)]
        paras = [p for p in paras if p]
        if not paras:
            paras = paras_of(body.split("</div>")[0])
        mm = re.match(r"第\s*([\d\-]+)\s*條", mno.group(1).strip())
        if mm:
            arts[mm.group(1)] = paras
    return arts


# ---------------------------------------------------------------------------
# 判解
# ---------------------------------------------------------------------------
RULING_TYPES = ["CJ", "C", "J"]


def parse_rela(t, ty):
    out = []
    m = re.search(r'<div id="pnJudge">(.*?)(?:<!-- 主要內容結束|<footer)', t, re.S)
    if not m:
        return out
    for tr in re.findall(r"<tr>(.*?)</tr>", m.group(1), re.S):
        rows = re.findall(r'<div class="col-th">\s*(.*?)</div>\s*<div class="col-td[^"]*">(.*?)</div>\s*</div>', tr, re.S)
        if not rows:
            continue
        item = {"ty": ty}
        for th, td in rows:
            th = re.sub(r"\s+", "", clean(th)).rstrip("：:")
            val = re.sub(r"\s{2,}", " ", re.sub(r"\s*\n\s*", "", clean(td))).strip()
            if "字號" in th:
                a = re.search(r'href="([^"]+)"', td)
                item["no"] = val
                if a:
                    item["url"] = MOJ + html.unescape(a.group(1))
            elif "日期" in th:
                item["date"] = val.replace("民國", "").strip()
            else:
                item.setdefault("parts", []).append([th, val])
        if item.get("no"):
            out.append(item)
    return out


def rulings_for(pcode, aid):
    t = fetch("%s/LawClass/LawSingle.aspx?pcode=%s&flno=%s" % (MOJ, pcode, aid), "%s_s_%s.html" % (pcode, aid), 3000)
    types = [ty for ty in RULING_TYPES if ("ty=%s\"" % ty) in t.replace("&amp;", "&")]
    res = []
    for ty in types:
        rt = fetch("%s/LawClass/LawSingleRela.aspx?PCODE=%s&FLNO=%s&ty=%s" % (MOJ, pcode, aid, ty),
                   "%s_r_%s_%s.html" % (pcode, aid, ty), 3000)
        res.extend(parse_rela(rt, ty))
    return aid, res


# ---------------------------------------------------------------------------
def build(lid):
    cfg = LAWS[lid]
    pcode = cfg["pcode"]
    t = fetch("%s/LawClass/LawAll.aspx?pcode=%s" % (MOJ, pcode), "%s_all.html" % pcode, 5000)
    meta, headings, articles = parse_lawall(t)
    ht = fetch("%s/LawClass/LawHistory.aspx?pcode=%s" % (MOJ, pcode), "%s_hist.html" % pcode, 5000)
    items, files, oldver = parse_history_page(ht)
    cur = {a["id"]: a["p"] for a in articles}

    changes = {}
    if cfg["kind"] == "law":
        hist, pass2pub = ly_history(cfg["ly"])
        for aid, vers in hist.items():
            hs = []
            for v in vers:
                k = ly_kind(v["kind"])
                hs.append({"d": pass2pub.get(v["pass"], v["pass"]), "pass": v["pass"], "k": k,
                           "kl": v["kind"], "p": v["p"] or (["（刪除）"] if k == "del" else []), "r": v["r"]})
            changes[aid] = hs
        # 與現行條文核對
        mism = [aid for aid in cur if aid in changes and norm(changes[aid][-1]["p"]) != norm(cur[aid])]
        miss = [aid for aid in cur if aid not in changes]
        if mism:
            print("注意：立法院最新版與現行條文文字不同（以現行條文為準）：", mism)
        if miss:
            print("注意：立法院法條沿革缺少：", miss)
    else:
        last = {}
        for d, ser in oldver:
            vt = fetch("%s/LawClass/LawOldVer.aspx?pcode=%s&lnndate=%s&lser=%s" % (MOJ, pcode, d, ser),
                       "%s_v_%s_%s.html" % (pcode, d, ser), 3000)
            arts = parse_oldver(vt)
            if not arts:
                continue
            for aid, paras in arts.items():
                n = norm(paras)
                if aid not in last:
                    changes.setdefault(aid, []).append({"d": d, "k": "new", "p": paras})
                elif last[aid] != n:
                    changes[aid].append({"d": d, "k": "del" if n in ("（刪除）", "刪除") else "amend", "p": paras})
                last[aid] = n
        final = meta.get("modified") or max(it["dates"][0] for it in items if it["dates"])
        for aid, paras in cur.items():
            n = norm(paras)
            if aid not in last:
                changes.setdefault(aid, []).append({"d": final, "k": "new", "p": paras})
            elif last[aid] != n:
                changes[aid].append({"d": final, "k": "del" if n in ("（刪除）", "刪除") else "amend", "p": paras})
        first = min(d for d, _ in oldver) if oldver else None
        for hs in changes.values():
            if hs[0]["d"] == first:
                hs[0]["k"] = "orig"

    for a in articles:
        hs = changes.get(a["id"], [])
        a["v"] = len(hs)
        if hs:
            a["since"] = hs[0]["d"]
            a["last"] = hs[-1]["d"]

    vdates = sorted({h["d"] for hs in changes.values() for h in hs})
    def item_for(d):
        for it in items:
            if d in it["dates"]:
                return it["n"]
        return None

    out = {
        "meta": {
            "id": lid, "name": cfg["name"], "short": cfg["short"], "pcode": pcode, "kind": cfg["kind"],
            "modified": meta.get("modified", ""), "effectiveNote": meta.get("effectiveNote", ""),
            "source": "全國法規資料庫 law.moj.gov.tw（法務部）" + ("；歷次條文與立法理由：立法院法律系統 lis.ly.gov.tw" if cfg["kind"] == "law" else ""),
            "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "ly": cfg.get("ly", ""), "files": files, "pending": {},
        },
        "histories": items,
        "versions": [{"d": d, "item": item_for(d)} for d in vdates],
        "headings": headings,
        "articles": articles,
        "changes": {aid: hs for aid, hs in sorted(changes.items(), key=lambda x: art_key(x[0])) if aid in cur},
    }
    os.makedirs(os.path.join(ROOT, "data"), exist_ok=True)
    dst = os.path.join(ROOT, "data", lid + ".json")
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    nreason = sum(1 for hs in changes.values() for h in hs if h.get("r"))
    print("%s：%d 條、%d 個章節、%d 則理由 → %s (%.0f KB)" % (
        cfg["name"], len(articles), len(headings), nreason, dst, os.path.getsize(dst) / 1024))

    # 判解
    result = {}
    with ThreadPoolExecutor(3) as ex:
        for aid, res in ex.map(lambda a: rulings_for(pcode, a), [a["id"] for a in articles]):
            if res:
                result[aid] = res
    rdst = os.path.join(ROOT, "data", lid + "-rulings.json")
    with open(rdst, "w", encoding="utf-8") as f:
        json.dump(result, f, ensure_ascii=False, separators=(",", ":"))
    print("  判解：%d 條、%d 筆 → %s" % (len(result), sum(len(v) for v in result.values()), rdst))


def main():
    global REFRESH
    REFRESH = "--refresh" in sys.argv
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    ids = list(LAWS) if not args or args == ["all"] else args
    os.makedirs(CACHE, exist_ok=True)
    for lid in ids:
        build(lid)


if __name__ == "__main__":
    main()
