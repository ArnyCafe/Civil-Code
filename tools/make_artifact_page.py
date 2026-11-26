#!/usr/bin/env python3
"""由 index.html 產生不含 <html>/<head>/<body> 外框的頁面（供 claude.ai Artifact 發布）。
用法：python3 tools/make_artifact_page.py 輸出路徑 [頁面標題]"""
import sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
body = src[src.index('<!--APP-START-->') + 16:src.index('<!--APP-END-->')]
title = sys.argv[2] if len(sys.argv) > 2 else '強制執行法註記本'
head = f'''<title>{title}</title>
<meta name="description" content="強制執行法電子法典：條號依章節著色、條旨、紅字行間註記、Apple Pencil 手寫、便利貼、判解函釋、新舊條文對照、立法理由，並可跨民事訴訟法、民法查詢。">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&display=swap">
<link rel="stylesheet" href="css/app.css">
'''
out = head + body + '<script type="module" src="js/app.js"></script>\n'
dst = sys.argv[1]
open(dst, 'w', encoding='utf-8').write(out)
print(dst, len(out))
