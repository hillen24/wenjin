"""从 v2.1 抽取 SVG sprite（36 个 symbol），生成 Vue 组件。

为什么不留在 HTML 里：
  symbol 定义被复制在两份 HTML 中，改一个图标要动两个地方 ——
  这正是 62 个函数漂移的同款成因。现在它只有一份。
"""
import re
import pathlib

SRC = pathlib.Path(r"D:\问津\源码\问津-电脑端-v2.1.html")
OUT = pathlib.Path(r"D:\wenjin\packages\ui\src\WenjinSprite.vue")

html = SRC.read_text(encoding="utf-8")

# sprite 容器：<svg aria-hidden="true" style="display:none"> ... </svg>
m = re.search(r'<svg aria-hidden="true" style="display:none">(.*?)</svg>', html, re.S)
if not m:
    raise SystemExit("未找到 sprite 容器")

inner = m.group(1)
symbols = re.findall(r"<symbol\b.*?</symbol>", inner, re.S)
if not symbols:
    raise SystemExit("未找到 symbol")

ids = re.findall(r'<symbol[^>]*id="([^"]+)"', inner)

ICONS = [i for i in ids if i.startswith("i-") and not i.startswith("i-ph-") and i != "i-logo"]
PORTRAITS = [i for i in ids if i.startswith("i-ph-")]

body = "\n".join("    " + s.strip() for s in symbols)

vue = f"""<template>
  <!--
    图标精灵图 · {len(symbols)} 个 symbol（{len(ICONS)} 个界面图标 + 1 个 logo + {len(PORTRAITS)} 个哲人剪影）

    由 scripts/extract-sprite.py 从 v2.1 抽取，改图标请改本文件。
    用法：<Icon name="i-star" /> 或直接 <svg><use href="#i-star" /></svg>
    所有图标使用 currentColor，颜色由父级 color 决定。
  -->
  <svg xmlns="http://www.w3.org/2000/svg" aria-hidden="true" style="display: none">
{body}
  </svg>
</template>

<script setup lang="ts">
// 纯展示组件，无逻辑。挂到根组件一次即可全站可用。
</script>
"""

OUT.parent.mkdir(parents=True, exist_ok=True)
OUT.write_text(vue, encoding="utf-8")
print(f"写入 {OUT.name}: {len(symbols)} 个 symbol，{len(vue)} 字符")
print("  界面图标:", len(ICONS))
print("  哲人剪影:", len(PORTRAITS), PORTRAITS)
