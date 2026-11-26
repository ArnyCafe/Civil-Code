#!/usr/bin/env python3
"""
勞動事件法註記本：建立 labor/data/labor.json

資料來源
  - 全國法規資料庫 API（law.moj.gov.tw）：現行條文、相關法律條文、勞動事件審理細則／施行細則
  - 立法院法律系統（lis.ly.gov.tw）「法條沿革」：各條歷次條文與立法理由、修正理由
  - 司法院（www.judicial.gov.tw）勞動事件常見問答（快取於 .cache/labor/jy_qa.json）

用法：
    python3 tools/build_labor.py            # 使用快取
    python3 tools/build_labor.py --refresh  # 重新下載

需求：Python 3.8+、curl。立法院網站需允許舊式 TLS renegotiation，本程式會自動設定（僅限該次 curl）。
"""
import html
import json
import os
import re
import subprocess
import sys
import zipfile
from datetime import datetime, timezone

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "labor")
OUT = os.path.join(ROOT, "labor", "data", "labor.json")
PCODE = "B0010064"
LY_CODE = "07132"
RULES = [("B0010069", "勞動事件審理細則", "審理細則"),
         ("B0010070", "勞動事件法施行細則", "施行細則"),
         ("B0010067", "勞動事件法第四十條第二項委任律師酬金支給標準", "酬金標準")]

# ---------------------------------------------------------------------------
# 下載
# ---------------------------------------------------------------------------
LEGACY_CNF = """openssl_conf = openssl_init
[openssl_init]
ssl_conf = ssl_sect
[ssl_sect]
system_default = system_default_sect
[system_default_sect]
Options = UnsafeLegacyRenegotiation
"""


def curl(url, path, legacy=False, cookie=None):
    env = dict(os.environ)
    if legacy:
        cnf = os.path.join(CACHE, "legacy.cnf")
        open(cnf, "w").write(LEGACY_CNF)
        env["OPENSSL_CONF"] = cnf
    args = ["curl", "-sS", "-L", "-m", "300", "-o", path]
    if cookie:
        args += ["-c", cookie, "-b", cookie]
    subprocess.run(args + [url], check=True, env=env)
    return path


def fetch_all(refresh):
    os.makedirs(CACHE, exist_ok=True)
    for name, url in [("ChLaw.zip", "https://law.moj.gov.tw/api/Ch/Law/JSON"),
                      ("ChOrder.zip", "https://law.moj.gov.tw/api/Ch/Order/JSON")]:
        p = os.path.join(CACHE, name)
        if refresh or not os.path.exists(p):
            print("下載", url, flush=True)
            curl(url, p)
    p = os.path.join(CACHE, "lis_hist.html")
    if refresh or not os.path.exists(p):
        # 立法院法律系統：先取得法律主頁（含工作階段代碼），再進入「法條沿革」
        ck = os.path.join(CACHE, "ly_cookie.txt")
        first = os.path.join(CACHE, "lis1.html")
        curl("https://www.ly.gov.tw/Pages/ashx/LawRedirect.ashx?CODE=" + LY_CODE, first, legacy=True, cookie=ck)
        s = open(first, encoding="utf-8", errors="replace").read()
        m = re.search(r'<li>立法沿革</li><li><a href=(/lglawc/lawsingle\?[^ >]+)[^>]*>法條沿革', s)
        if not m:
            raise RuntimeError("找不到立法院「法條沿革」連結")
        curl("https://lis.ly.gov.tw" + html.unescape(m.group(1)), p, legacy=True, cookie=ck)


def fetch_qa(refresh):
    """司法院「勞動事件常見問答」→ .cache/labor/jy_qa.json"""
    out_p = os.path.join(CACHE, "jy_qa.json")
    if os.path.exists(out_p) and not refresh:
        return
    d = os.path.join(CACHE, "jy")
    os.makedirs(d, exist_ok=True)
    lst = curl("https://www.judicial.gov.tw/tw/lp-1303-1-xCat-17-1-60.html", os.path.join(d, "list.html"))
    s = open(lst, encoding="utf-8").read()
    items, seen = [], set()
    for h, t in re.findall(r'<a[^>]*href="(/tw/cp-1303-[^"]+)"[^>]*>(.*?)</a>', s, re.S):
        t = " ".join(html.unescape(re.sub(r"<[^>]+>", "", t)).split())
        if t and h not in seen:
            seen.add(h)
            items.append((h, t))
    out = []
    for h, t in items:
        pth = os.path.join(d, h.split("/")[-1])
        if refresh or not os.path.exists(pth):
            curl("https://www.judicial.gov.tw" + h, pth)
        c = open(pth, encoding="utf-8").read()
        m = re.search(r'<section class="cp">(.*?)</section>', c, re.S)
        body = re.sub(r"<br\s*/?>|</p>|</li>", "\n", m.group(1) if m else "")
        body = html.unescape(re.sub(r"<[^>]+>", "", body))
        body = "\n".join(l.strip() for l in body.split("\n") if l.strip())
        out.append({"href": h, "title": t, "body": body, "date": ""})
    json.dump(out, open(out_p, "w", encoding="utf-8"), ensure_ascii=False, indent=0)
    print("司法院問答 %d 則" % len(out))


# ---------------------------------------------------------------------------
# 數字與條號
# ---------------------------------------------------------------------------
CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}
NUM = r"[零〇一二三四五六七八九十百千\d]+"


def num(s):
    s = s.strip()
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


def aid_of(no):
    m = re.match(r"第\s*([\d\-]+)\s*條", no)
    return m.group(1) if m else None


def akey(aid):
    a, _, b = aid.partition("-")
    return (int(a), int(b or 0))


def paras_of(content):
    return [p.strip() for p in content.replace("\r", "").split("\n") if p.strip()]


# ---------------------------------------------------------------------------
# 法規
# ---------------------------------------------------------------------------
def load_laws():
    laws = {}
    for zname, jname, kind in [("ChLaw.zip", "ChLaw.json", "law"), ("ChOrder.zip", "ChOrder.json", "order")]:
        with zipfile.ZipFile(os.path.join(CACHE, zname)) as z:
            data = json.loads(z.read(jname).decode("utf-8-sig"))
        for law in data["Laws"]:
            pc = law["LawURL"].split("pcode=")[-1]
            law["_pcode"] = pc
            law["_kind"] = kind
            if kind == "order" and pc not in {r[0] for r in RULES}:
                continue  # 命令僅保留勞動事件相關子法
            if law["LawName"] in laws and kind == "order":
                continue
            laws[law["LawName"]] = law
    return laws, data.get("UpdateDate", "")


def articles_of(law):
    """回傳 (headings, articles)：headings=[{t,lv,p,first}], articles=[{id,h,p}]"""
    headings, articles, stack = [], [], []
    for a in law["LawArticles"]:
        if a["ArticleType"] == "C":
            raw = a["ArticleContent"]
            level = (len(raw) - len(raw.lstrip(" "))) // 3
            title = re.sub(r"\s+", " ", raw.strip())
            title = re.sub(r"第 (\S+) (編|章|節|款|目)", r"第\1\2", title)
            while stack and stack[-1][0] >= level:
                stack.pop()
            headings.append({"t": title, "lv": level, "p": stack[-1][1] if stack else -1, "first": None})
            stack.append((level, len(headings) - 1))
        else:
            aid = aid_of(a["ArticleNo"])
            if not aid:
                continue
            for _, hi in stack:
                if headings[hi]["first"] is None:
                    headings[hi]["first"] = aid
            articles.append({"id": aid, "h": stack[-1][1] if stack else -1, "p": paras_of(a["ArticleContent"])})
    return headings, articles


# ---------------------------------------------------------------------------
# 引用條文解析
# ---------------------------------------------------------------------------
ALIAS = {
    "性別工作平等法": "性別平等工作法",   # 112.8.16 更名
    "兩性工作平等法": "性別平等工作法",
}
SELF_NAMES = ["本法", "勞動事件法", "本細則", "本標準"]


class RefParser:
    def __init__(self, laws):
        names = set(laws) | set(ALIAS)
        # 只保留以法、條例、通則、細則、標準、規則結尾之名稱，避免誤判
        names = {n for n in names if re.search(r"(法|條例|通則|細則|標準|規則|辦法)$", n) and len(n) >= 2}
        self.names = sorted(names, key=len, reverse=True)
        self.name_re = re.compile("|".join(re.escape(n) for n in self.names + ["同法", "同條例"] + SELF_NAMES))
        self.art_re = re.compile(
            r"第\s*(" + NUM + r")\s*條(?:\s*之\s*(" + NUM + r"))?"
            r"((?:\s*(?:第\s*" + NUM + r"\s*[項款目]|前段|後段|但書|本文|前項|各款)"
            r"(?:\s*(?:、|及|或|與|至|、第)\s*第\s*" + NUM + r"\s*[項款目])*)*)")

    def canon(self, name):
        return ALIAS.get(name, name)

    def parse(self, text, self_name="勞動事件法"):
        # 「本法」一律指勞動事件法；「本細則」「本標準」及未冠法規名稱之條號指 self_name
        """回傳 refs：[{s,e,law,a,sub}]；law 為法規名稱（勞動事件法本身以 self_name 表示）；
        另回傳僅提及法規名稱而未指明條號者 names：[{s,e,law}]"""
        refs, bare = [], []
        names = [(m.start(), m.end(), m.group(0)) for m in self.name_re.finditer(text)]
        last_law, last_end, last_other = None, -10, None
        for m in self.art_re.finditer(text):
            s, e = m.start(), m.end()
            before = text[max(0, s - 40):s]
            law = None
            # 緊鄰法規名稱：「民事訴訟法第七十六條」
            nm = [n for n in names if n[1] <= s and re.fullmatch(r"\s*(?:[（(]以下簡稱[^）)]*[）)])?\s*", text[n[1]:s])]
            if nm:
                n = nm[-1][2]
                ss = nm[-1][0]
                if n in ("本法", "勞動事件法"):
                    law = "勞動事件法"
                elif n in SELF_NAMES:
                    law = self_name
                elif n in ("同法", "同條例"):
                    prev = [x[2] for x in names if x[1] <= nm[-1][0] and x[2] not in SELF_NAMES + ["同法", "同條例"]]
                    law = self.canon(prev[-1]) if prev else (last_other or self_name)
                else:
                    law = self.canon(n)
                s = ss
            elif last_law and re.fullmatch(r"\s*(、|及|或|與|至|，|、及|及同條|、同條)?\s*", text[last_end:s]) and last_end > 0:
                law = last_law
            else:
                law = self_name
            n1 = num(m.group(1))
            aid = str(n1) + ("-%d" % num(m.group(2)) if m.group(2) else "")
            sub = re.sub(r"\s+", "", m.group(3) or "")
            refs.append({"s": s, "e": e, "law": law, "a": aid, "sub": sub})
            # 「第二十條至第二十三條」範圍
            if refs and len(refs) >= 2 and text[last_end:m.start()].strip() == "至" and refs[-2]["law"] == law:
                a0 = refs[-2]["a"]
                if "-" not in a0 and "-" not in aid:
                    refs[-1]["range"] = [a0, aid]
            last_law, last_end = law, e
            if law not in (self_name, "勞動事件法"):
                last_other = law
        covered = [(r["s"], r["e"]) for r in refs]
        for s, e, n in names:
            if n in SELF_NAMES or n in ("同法", "同條例"):
                continue
            if any(cs <= s < ce for cs, ce in covered):
                continue
            # 名稱後面接「第…條」者已處理
            if self.art_re.match(text, e) or re.match(r"\s*第", text[e:e + 3]):
                continue
            bare.append({"s": s, "e": e, "law": self.canon(n)})
        return refs, bare


# ---------------------------------------------------------------------------
# 立法院法條沿革
# ---------------------------------------------------------------------------
def parse_ly(path):
    s = open(path, encoding="utf-8", errors="replace").read()
    out = {}
    blocks = re.split(r'<font class="artino">', s)[1:]
    for b in blocks:
        no = re.match(r"([^<]+)</font>", b).group(1).strip()
        m = re.match(r"第(" + NUM + r")條(?:之(" + NUM + r"))?", no)
        aid = str(num(m.group(1))) + ("-%d" % num(m.group(2)) if m.group(2) else "")
        vers = []
        for vm in re.finditer(r'<font class="upddate">\((\d{7})&nbsp;([^)]+)\)</font>(.*?)(?=<font class="upddate">|</table></td></tr>|$)', b, re.S):
            pass_date, kind, body = vm.group(1), vm.group(2), vm.group(3)
            def cell(cls):
                mm = re.search(r"class=%s>(.*?)</td>" % cls, body, re.S)
                if not mm:
                    return []
                t = re.sub(r"<br\s*/?>", "\n", mm.group(1))
                t = html.unescape(re.sub(r"<[^>]+>", "", t))
                return [x.strip().lstrip("　").strip() for x in t.split("\n") if x.strip()]
            vers.append({"pass": pass_date, "kind": kind, "p": cell("artiupd_TH_2"), "r": cell("artiupd_RS_2")})
        out[aid] = vers
    return out


# 三讀、公布、施行日期（立法院法律系統、全國法規資料庫沿革）
LEG_DATES = {
    "1071109": {"pass": "20181109", "pub": "20181205", "eff": "20200101", "k": "orig",
                "doc": "總統107年12月5日華總一義字第10700129441號令制定公布；司法院108年8月16日院台廳民一字第1080022655號令定自109年1月1日施行"},
    "1121205": {"pass": "20231205", "pub": "20231215", "eff": "20240108", "k": "amend",
                "doc": "總統112年12月15日華總一義字第11200109951號令修正公布第2、16、25、32條；司法院113年1月5日院台廳民一字第11201020561號令定自113年1月8日施行"},
}


# 條文雖未寫出條號，但使用了其他法律的概念或規定（依立法理由所引或法條明文所指），
# 以「相關」標示並顯示該條小字。格式：條號 -> [(條文中的詞, 法規, [條號…])]
CURATED = {
    "2": [("團體協約", "團體協約法", ["2"]), ("工作規則", "勞動基準法", ["70"]), ("勞資會議決議", "勞動基準法", ["83"]),
          ("勞動契約", "勞動基準法", ["2#第六款"]), ("高級中等學校建教合作實施及建教生權益保障法", "高級中等學校建教合作實施及建教生權益保障法", ["3"]),
          ("性別平等工作之違反", "性別平等工作法", ["7", "8", "9", "10", "11"]), ("就業歧視", "就業服務法", ["5"]),
          ("工會活動與爭議行為", "工會法", ["35"]), ("爭議行為", "勞資爭議處理法", ["5#第四款"])],
    "3": [("受僱人", "民法", ["482"]), ("其他基於從屬關係提供其勞動力而獲致報酬之人", "勞動基準法", ["2#第一款"]),
          ("技術生", "勞動基準法", ["64"]), ("建教生", "高級中等學校建教合作實施及建教生權益保障法", ["3#第二款"]),
          ("要派契約", "勞動基準法", ["2#第七款至第十款"])],
    "14": [("社會救助法規定之低收入戶、中低收入戶", "社會救助法", ["4", "4-1"])],
    "20": [("民事訴訟法有關法院職員迴避之規定", "民事訴訟法", ["32", "33", "34", "35", "36", "37", "38", "39"])],
    "35": [("依法令應備置之文書", "勞動基準法", ["23#第二項", "30#第五項"])],
    "36": [("強制執行法關於物之交付請求權執行之規定", "強制執行法", ["123", "124", "125", "126"])],
    "37": [("工資", "勞動基準法", ["2#第三款"])],
    "38": [("出勤紀錄", "勞動基準法", ["30#第五項、第六項"])],
    "45": [("依工會法無得加入之工會", "工會法", ["6", "7", "8"])],
    "46": [("勞工依勞資爭議處理法就民事爭議事件申請裁決", "勞資爭議處理法", ["39", "48"])],
    "49": [("定暫時狀態處分", "民事訴訟法", ["538"])],
    "50": [("雇主調動勞工之工作", "勞動基準法", ["10-1"]), ("定暫時狀態處分", "民事訴訟法", ["538"])],
}

# 司法院問答未寫出本法條號者，依內容指定
QA_ARTS = {
    "工會所屬多數會員因為相同的紛爭要一起告老闆，可以由工會為會員勞工對老闆起訴嗎？": ["42"],
    "什麼是「勞動調解程序」？": ["16", "21", "24"],
    "勞動事件法相關的子法有哪些？": ["52", "40"],
    "勞動事件法什麼時候開始施行？": ["53"],
}


def norm(ps):
    return re.sub(r"\s+", "", "".join(ps)).replace("(", "（").replace(")", "）")


# ---------------------------------------------------------------------------
# 主程式
# ---------------------------------------------------------------------------
def main():
    refresh = "--refresh" in sys.argv
    fetch_all(refresh)
    fetch_qa(refresh)
    laws, update = load_laws()
    me = laws["勞動事件法"]
    headings, articles = articles_of(me)
    byid = {a["id"]: a for a in articles}
    rp = RefParser(laws)
    ly = parse_ly(os.path.join(CACHE, "lis_hist.html"))

    need = {}  # law -> set(aid)

    rule_names = {r[1] for r in RULES}

    def want(law, aid):
        if law == "勞動事件法" or law in rule_names:
            return
        need.setdefault(law, set()).add(aid)

    def refs_for(paras, self_name="勞動事件法"):
        out = []
        for i, t in enumerate(paras):
            refs, bare = rp.parse(t, self_name)
            for r in refs:
                if r["law"] == self_name and self_name != "勞動事件法":
                    r["law"] = self_name
                want(r["law"], r["a"])
                out.append([i, r["s"], r["e"], r["law"], r["a"], r["sub"]])
            for b in bare:
                out.append([i, b["s"], b["e"], b["law"], "", ""])
        return out

    # 條文、沿革、理由
    for a in articles:
        a["refs"] = refs_for(a["p"])
        for term, lname, aids in CURATED.get(a["id"], []):
            hit = None
            for i, t in enumerate(a["p"]):
                k = t.find(term)
                if k >= 0:
                    hit = (i, k)
                    break
            if not hit:
                print("注意：第%s條找不到「%s」" % (a["id"], term))
                continue
            for spec in aids:
                aid, _, sub = spec.partition("#")
                want(lname, aid)
                a["refs"].append([hit[0], hit[1], hit[1] + len(term), lname, aid, sub, 1])
        vs = []
        for v in ly.get(a["id"], []):
            info = LEG_DATES.get(v["pass"], {})
            vs.append({"pass": info.get("pass", v["pass"]), "pub": info.get("pub", ""), "eff": info.get("eff", ""),
                       "k": info.get("k", "amend"), "kind": v["kind"], "p": v["p"], "r": v["r"],
                       "rrefs": refs_for(v["r"])})
        if vs and norm(vs[-1]["p"]) != norm(a["p"]):
            print("注意：第%s條 立法院最新版本與現行條文不同" % a["id"])
        a["v"] = vs

    # 子法（審理細則等）：條文全文與對應本法條號
    rules, rule_map = {}, {}
    for pc, name, short in RULES:
        law = laws.get(name)
        if not law:
            print("找不到", name)
            continue
        hs, arts = articles_of(law)
        for ra in arts:
            ra["refs"] = []
            for i, t in enumerate(ra["p"]):
                refs, bare = rp.parse(t, self_name=name)
                for r in refs:
                    if r["law"] == "勞動事件法":
                        rule_map.setdefault(r["a"], [])
                        if [pc, ra["id"]] not in rule_map[r["a"]]:
                            rule_map[r["a"]].append([pc, ra["id"]])
                        if r.get("range"):
                            for k in range(akey(r["range"][0])[0], akey(r["range"][1])[0] + 1):
                                rule_map.setdefault(str(k), [])
                                if [pc, ra["id"]] not in rule_map[str(k)]:
                                    rule_map[str(k)].append([pc, ra["id"]])
                    elif r["law"] != name:
                        want(r["law"], r["a"])
                    ra["refs"].append([i, r["s"], r["e"], r["law"], r["a"], r["sub"]])
                for b in bare:
                    ra["refs"].append([i, b["s"], b["e"], b["law"], "", ""])
        rules[pc] = {"name": name, "short": short, "modified": law["LawModifiedDate"],
                     "history": law["LawHistories"].replace("\r", ""), "headings": hs, "articles": arts}
    for k in rule_map:
        rule_map[k].sort(key=lambda x: ([r[0] for r in RULES].index(x[0]), akey(x[1])))

    # 司法院勞動事件常見問答
    qa = []
    qp = os.path.join(CACHE, "jy_qa.json")
    if os.path.exists(qp):
        for q in json.load(open(qp, encoding="utf-8")):
            body = q["body"].split("\n")
            # 去除與標題重複之首行及頁尾資訊
            body = [l for l in body if not re.match(r"^(發布日期|更新日期|發布單位)\s*:", l)]
            title = re.sub(r"^Q\d+", "", q["title"]).strip()
            if body and body[0].strip() == title:
                body = body[1:]
            text = "\n".join(body)
            arts = set()
            for m in re.finditer(r"勞動事件法第(" + NUM + r")條(?:之(" + NUM + r"))?((?:(?:、|及|或)第(?:" + NUM + r")條(?:之" + NUM + r")?)*)", text):
                arts.add(str(num(m.group(1))) + ("-%d" % num(m.group(2)) if m.group(2) else ""))
                for mm in re.finditer(r"第(" + NUM + r")條(?:之(" + NUM + r"))?", m.group(3) or ""):
                    arts.add(str(num(mm.group(1))) + ("-%d" % num(mm.group(2)) if mm.group(2) else ""))
            refs, _ = rp.parse(text)
            for r in refs:
                if r["law"] != "勞動事件法":
                    want(r["law"], r["a"])
            pd = re.search(r"發布日期\s*:\s*([\d\-]+)", q["body"])
            if title in QA_ARTS:
                arts = set(QA_ARTS[title])
            qa.append({"t": title, "b": text, "a": sorted(arts & set(byid), key=akey),
                       "d": (pd.group(1) if pd else q.get("date", "")), "url": "https://www.judicial.gov.tw" + q["href"],
                       "refs": [[0, r["s"], r["e"], r["law"], r["a"], r["sub"]] for r in refs]})

    # 被引用的其他法律條文（現行條文）
    ext = {}
    for lname, aids in sorted(need.items()):
        law = laws.get(lname)
        if not law:
            print("未收錄之法規：", lname, sorted(aids))
            continue
        arts = {}
        allarts = {aid_of(x["ArticleNo"]): x for x in law["LawArticles"] if x["ArticleType"] == "A"}
        for aid in sorted(aids, key=akey):
            x = allarts.get(aid)
            if x:
                arts[aid] = paras_of(x["ArticleContent"])
        ext[lname] = {"pcode": law["_pcode"], "modified": law["LawModifiedDate"],
                      "abandon": law.get("LawAbandonNote", ""), "arts": arts}

    out = {
        "meta": {
            "name": me["LawName"], "eng": me.get("EngLawName", ""), "pcode": PCODE,
            "modified": me["LawModifiedDate"], "history": me["LawHistories"].replace("\r", ""),
            "source": "全國法規資料庫（法務部）、立法院法律系統（立法院國會圖書館）、司法院",
            "sourceUpdate": update, "built": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
            "leg": LEG_DATES,
        },
        "headings": headings,
        "articles": articles,
        "ext": ext,
        "rules": rules,
        "ruleMap": rule_map,
        "qa": qa,
    }
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))
    nref = sum(len(a["refs"]) for a in articles)
    print("完成：%d 條；條文引用 %d 處；外部法規 %d 部 %d 條；子法 %d 部；問答 %d 則 → %s (%.0f KB)" % (
        len(articles), nref, len(ext), sum(len(v["arts"]) for v in ext.values()), len(rules), len(qa),
        OUT, os.path.getsize(OUT) / 1024))


if __name__ == "__main__":
    main()
