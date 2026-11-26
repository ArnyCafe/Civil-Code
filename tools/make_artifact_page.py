#!/usr/bin/env python3
"""由 index.html 產生不含 <html>/<head>/<body> 外框的頁面（供 claude.ai Artifact 發布）。

用法：
    python3 tools/make_artifact_page.py <輸出檔>            # 民法註記本（根目錄）
    python3 tools/make_artifact_page.py <輸出檔> labor      # 勞動事件法註記本（labor/）
"""
import os
import re
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
app = sys.argv[2] if len(sys.argv) > 2 else ''
src = open(os.path.join(ROOT, app, 'index.html'), encoding='utf-8').read()
title = re.search(r'<title>(.*?)</title>', src).group(1)
body = src[src.index('<!--APP-START-->') + 16:src.index('<!--APP-END-->')]
head = f'''<title>{title}</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+TC:wght@400;600;700&display=swap">
<link rel="stylesheet" href="css/app.css">
'''
out = head + body + '<script type="module" src="js/app.js"></script>\n'
dst = sys.argv[1]
open(dst, 'w', encoding='utf-8').write(out)
print(dst, len(out))
