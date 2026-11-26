"""
條文引用解析（與 js/xref.js 同一規則）：

  「本法第六條第一項、第十六條」→ 本法（子法中之「本法」指母法）
  「勞動基準法第五十九條」「勞基法第59條」→ 書架上的其他法典
  「同法第三條」→ 前一個被引用的法典
  「第八條及第九條」（未冠法名）→ 本法典自身
  「前條」「次條」→ 前／後一條
法名之後連續列舉之條號（以、及或與至等連接，含項款）均屬同一法典。
"""
import re

CNUM = "零〇一二三四五六七八九十百千"
NUM = r"(?:\d+|[%s]+)" % CNUM
ART = r"第\s*(%s)\s*條(?:\s*之\s*(%s))?" % (NUM, NUM)
SUB = r"(?:第\s*%s\s*(?:項|款|目))*(?:前段|後段|但書|本文)?" % NUM
SEP = r"(?:、|及|或|與|和|至|暨|以及)"
CN = {"〇": 0, "零": 0, "一": 1, "二": 2, "兩": 2, "三": 3, "四": 4, "五": 5, "六": 6, "七": 7, "八": 8, "九": 9}


def num(s):
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


def make_resolver(lib):
    """lib: [{id, alias:[...], parent}]；回傳 refs(text, law_id, aid) → [(start, end, law, aid)]"""
    names = []
    for e in lib:
        for a in e.get("alias", []) + [e["name"]]:
            names.append((a, e["id"]))
    names.sort(key=lambda x: -len(x[0]))
    alias_re = "|".join(re.escape(a) for a, _ in names)
    by_alias = dict(names)
    parent = {e["id"]: e.get("parent") for e in lib}
    pre = re.compile(r"(%s|本法|本細則|本規則|本辦法|本標準|本準則|同法|同細則|同規則)?(?:（(?:以下)?簡稱[^）]{1,10}）)?\s*(%s)(\s*%s(?:\s*%s\s*(?:%s)?\s*%s)*)" %
                     (alias_re, ART, SUB, SEP, ART, SUB))
    art_re = re.compile(ART)
    rel_re = re.compile(r"(前條|次條)")

    def refs(text, law, aid=None, order=None):
        out = []
        last_law = None
        for m in pre.finditer(text):
            p = m.group(1)
            before = text[max(0, m.start() - 6):m.start()]
            if p in ("本法",):
                target = parent.get(law) or law
            elif p in ("本細則", "本規則", "本辦法", "本標準", "本準則"):
                target = law
            elif p in ("同法", "同細則", "同規則"):
                target = last_law or law
            elif p:
                target = by_alias[p]
            else:
                # 未冠法名：前面緊接其他法律名稱（不在書架上）者不連結
                if re.search(r"[法則例程準]$", before) and not re.search(r"本法$", before):
                    continue
                target = law
            last_law = target
            seg_start = m.start(2) if p else m.start()
            for a in art_re.finditer(text, seg_start, m.end()):
                n = num(a.group(1))
                aid2 = "%d-%d" % (n, num(a.group(2))) if a.group(2) else str(n)
                out.append((a.start(), a.end(), target, aid2))
        if order and aid in order:
            i = order.index(aid)
            for m in rel_re.finditer(text):
                j = i - 1 if m.group(1) == "前條" else i + 1
                if 0 <= j < len(order):
                    out.append((m.start(), m.end(), law, order[j]))
        return sorted(out)

    return refs
