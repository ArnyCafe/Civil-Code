#!/usr/bin/env python3
"""由 index.html 產生不含 <html>/<head>/<body> 外框的頁面（供 claude.ai Artifact 發布）。"""
import re, sys, os
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
src = open(os.path.join(ROOT, 'index.html'), encoding='utf-8').read()
body = src[src.index('<!--APP-START-->') + 16:src.index('<!--APP-END-->')]
head = '''<title>法典註記本</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&display=swap">
<link rel="stylesheet" href="css/app.css">
'''
out = head + body + '<script type="module" src="js/app.js"></script>\n'
dst = sys.argv[1]
open(dst, 'w', encoding='utf-8').write(out)
print(dst, len(out))
