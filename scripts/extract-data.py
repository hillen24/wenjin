"""从 v2.1 单文件 HTML 中抽取领域数据，生成 core 包的 type-safe 数据模块。

原则：数据是资产，原样搬运，只加类型标注 —— 不做「顺手优化」，
否则 UI 层对账时无法区分「数据变了」还是「渲染变了」。
"""
import re
import pathlib

SRC = pathlib.Path(r"D:\问津\源码\问津-电脑端-v2.1.html")
OUT = pathlib.Path(r"D:\wenjin\packages\core\src\data")

html = SRC.read_text(encoding="utf-8")
js = "".join(re.findall(r"<script[^>]*>(.*?)</script>", html, re.S))


def grab(name: str) -> str:
    """抓出 `const NAME = <字面量>` 右侧的完整字面量源码（括号配平）。"""
    m = re.search(r"^const\s+" + name + r"\s*=\s*", js, re.M)
    if not m:
        raise SystemExit(f"未找到 {name}")
    i = m.end()
    depth = 0
    started = False
    for j in range(i, len(js)):
        c = js[j]
        if c in "[{":
            depth += 1
            started = True
        elif c in "]}":
            depth -= 1
            if started and depth == 0:
                return js[i : j + 1]
    raise SystemExit(f"{name} 括号未配平")


HEADER = """/**
 * {desc}
 *
 * 由 scripts/extract-data.py 从 问津-电脑端-v2.1.html 机械抽取。
 * 改数据请改本文件，不要回改 HTML —— 那份已经归档为只读基准。
 */

"""

SPECS = [
    (
        "philosophers.ts",
        "哲人库：6 位角色的人设、开场白、预置问答与 system prompt。",
        [("PHILOSOPHERS", "readonly Philosopher[]", "PHILOS")],
        ["Philosopher"],
    ),
    (
        "star-map.ts",
        "星图：节点与边。节点是概念/人物/学派，边是它们之间的思想关系。",
        [
            ("STAR_NODES", "readonly StarNode[]", "NODES"),
            ("STAR_EDGES", "readonly StarEdge[]", "EDGES"),
        ],
        ["StarNode", "StarEdge"],
    ),
    (
        "methods.ts",
        "方法论仓库：11 条方法论的说明、操作步骤与误用提醒。",
        [("METHOD_ENTRIES", "readonly MethodEntry[]", "ENTRIES")],
        ["MethodEntry"],
    ),
    (
        "readings.ts",
        "精读材料：按 id 索引的原文段落。",
        [("READINGS", "Record<string, ReadingDoc>", "DOCS")],
        ["ReadingDoc"],
    ),
    (
        "gewu.ts",
        "格物图层：离线降级用的追问剧本，以及格物卡的预填文案。",
        [
            ("GEWU_SCRIPTS", "Record<string, GewuScript>", "GW_SCRIPTS"),
            ("CARD_TEXTS", "Record<string, CardText>", "CARD_TEXT"),
        ],
        ["GewuScript", "CardText"],
    ),
    (
        "debate.ts",
        "论道层：苏格拉底式追问的四步流程（离线降级）。",
        [("DEBATE_FLOW", "readonly DebateStep[]", "Q_FLOW")],
        ["DebateStep"],
    ),
    (
        "providers.ts",
        "AI 服务商定义。key: true 表示必须配 API Key 才能调用。",
        [("PROVIDERS", "Record<string, ProviderDef>", "PROVIDERS")],
        ["ProviderDef"],
    ),
    (
        "voices.ts",
        "Edge TTS 内置音色表。",
        [("EDGE_VOICES", "readonly VoiceOption[]", "EDGE_VOICES")],
        ["VoiceOption"],
    ),
]


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    for fname, desc, blocks, imports in SPECS:
        body = HEADER.format(desc=desc)
        if imports:
            body += "import type { " + ", ".join(imports) + " } from '../types';\n\n"
        for var, typ, src in blocks:
            body += f"export const {var}: {typ} = {grab(src)};\n\n"
        (OUT / fname).write_text(body, encoding="utf-8")
        print(f"写入 {fname:18s} {len(body):6d} 字符  <- {[b[2] for b in blocks]}")


if __name__ == "__main__":
    main()
