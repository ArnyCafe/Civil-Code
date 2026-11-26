#!/usr/bin/env python3
"""
勞動事件法註記本：重要裁判摘錄 → labor/data/cases.json

做法：
  1. 以司法院裁判書查詢系統（judgment.judicial.gov.tw）進階查詢，列出最高法院民事裁判中
     引用「勞動事件法第 N 條」者（--search，結果存於 .cache/labor/tps_lists.json）。
  2. 下方 PICKS 為人工挑選之重要見解；程式自裁判全文中「逐字」擷取 start…end 之間的文字，
     不改寫、不摘要。找不到起訖文字時會報錯，避免錯植。

用法：
    python3 tools/labor_cases.py            # 依快取擷取
    python3 tools/labor_cases.py --search   # 重新查詢清單並下載裁判全文
"""
import html
import json
import os
import re
import subprocess
import sys
import time

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE = os.path.join(ROOT, ".cache", "labor")
JUD = os.path.join(CACHE, "jud")
LISTS = os.path.join(CACHE, "tps_lists.json")
OUT = os.path.join(ROOT, "labor", "data", "cases.json")
BASE = "https://judgment.judicial.gov.tw/FJUD/"
COOKIE = os.path.join(CACHE, "fj_cookie.txt")

# (適用條號, 裁判字號關鍵字, 擷取起點, 擷取終點, 說明)
# 說明中「同旨」為以相同文字重複援用該見解之最高法院裁判（由本工具比對而得）。
PICKS = [
    (["2"], "114 年度 台聲 字第 3 號", "按勞動事件法第2條第2項規定", "而得任意為訴之追加。", "牽連民事事件之合併、追加，仍應依民事訴訟法判斷其要件"),
    (["2", "3", "49"], "114 年度 台抗 字第 460 號", "又參酌勞動事件法第2條第1項規定", "亦包含在內。", "勞動事件不限勞基法上勞資爭議；民法上僱傭關係亦得聲請繼續僱用處分"),
    (["2", "6", "15"], "110 年度 台抗 字第 315 號", "按勞動事件法第2條第1項所定之勞動事件，其爭議如涉及第三人", "聲請移送其選定之法院。", "雇主併列第三人為共同被告時，勞工移送管轄之選擇權應受限縮"),
    (["11", "12", "51"], "111 年度 台抗 字第 234 號", "至於勞動事件法施行細則第2條第1項第3款規定", "核定其訴訟標的價額。", "施行前繫屬事件之訴訟標的價額，仍依起訴時規定核定"),
    (["14"], "111 年度 台聲 字第 1468 號", "次按勞工或其遺屬因職業災害提起勞動訴訟", "而不以無資力為要件。", "職災訴訟救助不以無資力為要件"),
    (["14"], "112 年度 台抗 字第 1097 號", "所謂顯無勝訴之望", "即知其應受敗訴之裁判者而言。", "「顯無勝訴之望」之意義"),
    (["15", "49"], "115 年度 台抗 字第 284 號", "按有關勞動事件之處理，依本法之規定", "自應適用強制執行法之相關規定。", "第49條處分之執行，依第15條適用強制執行法"),
    (["15", "49"], "114 年度 台抗 字第 434 號", "所謂定暫時狀態處分之原因消滅", "無容債務人聲請撤銷定暫時狀態處分裁定之餘地。", "撤銷繼續僱用處分之要件"),
    (["16", "29"], "110 年度 台抗 字第 245 號", "按勞動事件，除有勞動事件法第16條第1項第1款、第2款之情形外", "所定額數繳納聲請費。", "調解前置：逕行起訴視為聲請調解，應繳調解聲請費"),
    (["30"], "113 年度 台上 字第 259 號", "調解程序中，當事人所為不利於己之陳述或讓步", "顯有誤會。", "調解程序中之不利陳述或讓步，不得採為裁判基礎"),
    (["35", "36", "51"], "110 年度 台上 字第 1506 號", "又勞工請求之事件，雇主就其依法令應備之文書", "對違反提出命令之當事人發揮制裁之實效。", "雇主應備置文書之提出義務及不從之效果；施行前發生之事件亦適用"),
    (["36"], "114 年度 台上 字第 1696 號", "按文書資料之持有人，無正當理由不從法院之命提出者", "立法理由參照）。", "須先以裁定命提出，並於裁判前予當事人辯論機會"),
    (["37"], "112 年度 台上 字第 1908 號", "觀諸被上訴人付薪予上訴人之薪津明細表", "亦應計入工資。", "原審適用工資推定之例（最高法院以上訴不合法裁定駁回）"),
    (["38"], "111 年度 台上 字第 2305 號", "另被上訴人出勤紀錄如原判決附表一所示", "不足作為勞動事件法第38條之反對證據", "加班申請制度徒具形式時，不足推翻工作時間推定（原審見解，此部分經最高法院駁回上訴而確定）"),
    (["38"], "113 年度 台上 字第 626 號", "依系爭工作規則第37條規定", "作為勞工經雇主同意執行職務時間。", "雇主設有加班申請核可制度且勞工知悉者，不適用第38條推定（原審見解，最高法院認於法並無違誤）"),
    (["40"], "112 年度 台上 字第 431 號", "揆諸勞動事件法第40條第1項規定之立法意旨", "包括勞工之勞動條件及福利。", "工會不作為訴訟之性質與範圍"),
    (["40"], "111 年度 台上 字第 2784 號", "按工會於章程所定目的範圍內，得對侵害其多數會員利益之雇主", "均須於其訴之聲明表明給付之範圍。", "不作為之訴之意義及聲明應明確"),
    (["46", "49"], "109 年度 台抗 字第 809 號", "按勞工依勞資爭議處理法就民事爭議事件申請裁決", "否准勞工之聲請。", "以裁決決定代替釋明之意義"),
    (["46", "49"], "113 年度 台抗 字第 250 號", "勞動事件法第49條第4項規定意旨在於", "以填補該法律漏洞。", "依第46條第2項所為處分撤銷時，類推適用第49條第4項"),
    (["49"], "113 年度 台抗 字第 250 號", "雇主依勞工保險、全民健康保險或其他社會保險之保費負擔", "自不在前開規定得請求返還之範圍。", "社會保險保費、勞退提繳非屬得請求返還之工資"),
    (["49"], "109 年度 台抗 字第 961 號", "參酌立法理由：勞動事件之勞工", "勞工即得聲請法院命為定暫時狀態之處分。", "第49條第1項係民事訴訟法第538條要件之具體化"),
    (["49"], "109 年度 台抗 字第 1134 號", "參酌立法理由：勞動事件之勞工", "自得不許為繼續僱用之定暫時狀態處分。", "勞工有資力維生且雇主繼續僱用顯有重大困難者，得不准許"),
    (["49"], "112 年度 台抗 字第 437 號", "按勞動事件法第49條第2項明定", "企業存續之危害或其他相類之情形。", "「雇主繼續僱用非顯有重大困難」之意義"),
    (["49"], "110 年度 台抗 字第 673 號", "蓋第一審判決既已確認僱傭關係存在", "不必再審查其他要件。", "第一審判決勞工勝訴，第二審應依聲請為處分"),
    (["49"], "112 年度 台抗 字第 581 號", "又勞動事件法第49條第1項規定，不以勞工生活陷於困難為要件。", "亦不受債權人聲明所拘束。", "不以勞工生活陷於困難為要件"),
    (["49"], "112 年度 台抗 字第 581 號", "再者，勞動事件法第49條第1項規定，旨在保障勞工之生存權及工作權", "無從斟酌該項利益。", "家庭生活利益非審酌範圍"),
    (["49"], "114 年度 台抗 字第 629 號", "所謂「繼續僱用」之處分內容", "聲請撤銷定暫時狀態處分。", "勞工受繼續僱用處分後任意拒絕提供勞務，雇主得聲請撤銷"),
    (["49"], "110 年度 台抗 字第 493 號", "又法院依勞動事件法第49條第1項規定，為繼續僱用及給付工資之定暫時狀態處分者", "與適用法規是否顯有錯誤無涉。", "給付工資為繼續僱用之附隨結果；處分內容由法院裁量"),
    (["50"], "111 年度 台抗 字第 235 號", "又法院依勞動事件法第50條規定", "與適用法規是否顯有錯誤無涉。", "調動爭議之繼續僱用處分屬法院裁量"),
    (["51"], "109 年度 台抗 字第 1065 號", "惟按本法施行前已繫屬尚未終結之勞動事件", "與其請求之是否成立無涉。", "施行前繫屬事件之管轄"),
]


def curl(args):
    r = subprocess.run(["curl", "-sS", "-m", "90", "-c", COOKIE, "-b", COOKIE, "-L"] + args, capture_output=True)
    return r.stdout.decode("utf-8", "replace")


def search(kw):
    s = curl([BASE + "Default_AD.aspx"])
    f = [(k, v) for k, v in re.findall(r'name="(__[A-Z]+)" id="[^"]+" value="([^"]*)"', s)]
    f += [("jud_court", "TPS"), ("jud_sys", "V"), ("jud_kw", kw), ("judtype", "JUDBOOK"), ("whosub", "0"),
          ("ctl00$cp_content$btnQry", "送出查詢")]
    args = []
    for k, v in f:
        args += ["--data-urlencode", "%s=%s" % (k, v)]
    r = curl(args + [BASE + "Default_AD.aspx"])
    m = re.search(r"qryresultlst\.aspx\?[^\"']+", r)
    if not m:
        return []
    q = re.search(r"q=([0-9a-f]+)", m.group(0)).group(1)
    out = []
    for page in range(1, 9):
        s = curl([BASE + "qryresultlst.aspx?ty=JUDBOOK&q=%s&sort=DS&page=%d" % (q, page)])
        got = [(html.unescape(h), " ".join(re.sub(r"<[^>]+>", "", t).split()))
               for h, t in re.findall(r'<a[^>]*href="(data\.aspx\?[^"]+)"[^>]*>(.*?)</a>', s, re.S)]
        out += got
        if len(got) < 20:
            break
    return out


def doc_path(href):
    return os.path.join(JUD, re.sub(r"[^0-9A-Za-z]+", "_", href)[-120:] + ".html")


def doc(href):
    p = doc_path(href)
    if os.path.exists(p) and os.path.getsize(p) > 3000:
        s = open(p, encoding="utf-8").read()
    else:
        s = curl([BASE + href])
        open(p, "w", encoding="utf-8").write(s)
        time.sleep(0.5)
    m = re.search(r'<div class="htmlcontent">(.*?)</div>\s*</div>', s, re.S) or re.search(r"<pre[^>]*>(.*?)</pre>", s, re.S)
    body = m.group(1) if m else s
    body = re.sub(r"<br\s*/?>", "\n", body)
    return html.unescape(re.sub(r"<[^>]+>", "", body))


def main():
    os.makedirs(JUD, exist_ok=True)
    if "--search" in sys.argv or not os.path.exists(LISTS):
        lists = {}
        for n in range(1, 54):
            lists[str(n)] = search("勞動事件法第%d條" % n)
            print(n, len(lists[str(n)]), flush=True)
        json.dump(lists, open(LISTS, "w"), ensure_ascii=False)
    lists = json.load(open(LISTS, encoding="utf-8"))
    index = {}
    for res in lists.values():
        for h, t in res:
            index.setdefault(t, h)
    cases, errors = [], []
    for arts, key, start, end, note in PICKS:
        hits = [(t, h) for t, h in index.items() if key in t]
        if not hits:
            errors.append("找不到裁判：" + key)
            continue
        title, href = hits[0]
        body = re.sub(r"\s+", "", doc(href))
        i = body.find(re.sub(r"\s+", "", start))
        j = body.find(re.sub(r"\s+", "", end), i) if i >= 0 else -1
        if i < 0 or j < 0:
            errors.append("找不到擷取範圍：%s｜%s…%s" % (key, start[:12], end[-12:]))
            continue
        text = body[i:j + len(re.sub(r"\s+", "", end))]
        mid = re.search(r"id=([^&]+)", href).group(1)
        parts = [x for x in re.split(r"%2c|,", mid)]
        d = parts[4] if len(parts) > 4 else ""
        # 同旨：其他最高法院裁判含相同起始文字者
        same = []
        probe = re.sub(r"\s+", "", start)[:40] if len(start) >= 24 else re.sub(r"\s+", "", text)[:40]
        for t2, h2 in index.items():
            if t2 == title or not os.path.exists(doc_path(h2)):
                continue
            if probe in re.sub(r"\s+", "", doc(h2)):
                same.append(t2.replace("最高法院 ", "").replace(" ", ""))
        no = title.replace(" ", "")
        cases.append({
            "id": re.sub(r"\W+", "", no) + "-" + str(len(cases)),
            "a": arts, "no": no, "kind": "裁定" if no.endswith("裁定") else "判決",
            "date": "%d.%s.%s" % (int(d[:4]) - 1911, d[4:6], d[6:8]) if len(d) == 8 else "",
            "d": d, "text": text, "note": note,
            "same": sorted(set(same))[:30], "nsame": len(set(same)),
            "url": BASE + href.replace("&ot=in", ""),
        })
    if errors:
        print("\n".join(errors))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    json.dump({"source": "司法院裁判書查詢系統（最高法院民事裁判）", "cases": cases},
              open(OUT, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
    print("完成：%d 則 → %s" % (len(cases), OUT))


if __name__ == "__main__":
    main()
