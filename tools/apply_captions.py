#!/usr/bin/env python3
"""把 tools/captions/<pcode>.json 的條旨套進既有的 data/<pcode>.json（不需重新下載）。
用法：python3 tools/apply_captions.py [PCODE ...]"""
import json, os, sys
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
codes = sys.argv[1:] or [l["pcode"] for l in json.load(open(os.path.join(ROOT, "data", "laws.json"), encoding="utf-8"))["laws"]]
for pc in codes:
    cap_path = os.path.join(ROOT, "tools", "captions", pc + ".json")
    if not os.path.exists(cap_path):
        continue
    caps = json.load(open(cap_path, encoding="utf-8"))
    path = os.path.join(ROOT, "data", pc + ".json")
    d = json.load(open(path, encoding="utf-8"))
    n, missing = 0, []
    for a in d["articles"]:
        c = caps.get(a["id"])
        if c:
            a["c"] = c; n += 1
        elif not a.get("del"):
            missing.append(a["id"])
    extra = [k for k in caps if not k.startswith("_") and k not in {a["id"] for a in d["articles"]}]
    with open(path, "w", encoding="utf-8") as f:
        json.dump(d, f, ensure_ascii=False, separators=(",", ":"))
    print("%s：套用 %d 條條旨；缺 %d 條 %s；多餘 %s" % (d["meta"]["name"], n, len(missing), missing[:20], extra[:20]))
