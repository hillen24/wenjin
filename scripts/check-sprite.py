"""从 WenjinSprite.vue 抽 i-logo / i-mark 渲染验证图。

用途：改完 sprite 后确认页面实际拿到的图形与 assets/icon.png 一致，
      以及压缩标在 26/32px 印章尺寸下的实效（橙底白图形）。
产出：shots/sprite-check.png
"""

import re
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPRITE = ROOT / "packages" / "ui" / "src" / "WenjinSprite.vue"
OUT = ROOT / "shots" / "sprite-check.png"

EDGE = r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"


def extract(symbol_id: str) -> str:
    text = SPRITE.read_text(encoding="utf-8")
    m = re.search(
        r'<symbol id="%s".*?</symbol>' % re.escape(symbol_id), text, re.S
    )
    if not m:
        raise SystemExit(f"sprite 里找不到 #{symbol_id}")
    return m.group(0)


def main() -> int:
    logo = extract("i-logo")
    mark = extract("i-mark")

    # 真实用法：symbol 定义在隐藏 defs 里，页面经 <use> 引用
    defs = (
        '<svg width="0" height="0" style="position:absolute">'
        + logo
        + mark
        + "</svg>"
    )

    def badge(ref: str, size: int, bg: str, radius: bool = False) -> str:
        style = f"display:block;background:{bg};"
        if radius:
            style += "border-radius:9px;"
        return (
            f'<svg width="{size}" height="{size}" viewBox="0 0 512 512" '
            f'style="{style}"><use href="#{ref}"/></svg>'
        )

    figs = [
        ("完整标 512（白底，应等同 icon.png）", badge("i-logo", 512, "#fff")),
        ("压缩标 48", badge("i-mark", 48, "#E8623A", True)),
        ("压缩标 32", badge("i-mark", 32, "#E8623A", True)),
        ("压缩标 26", badge("i-mark", 26, "#E8623A", True)),
        ("完整标 128（白底）", badge("i-logo", 128, "#fff")),
    ]
    cells = "".join(
        f'<figure><figcaption style="margin-bottom:8px">{cap}</figcaption>{svg}</figure>'
        for cap, svg in figs
    )
    html = f"""<!doctype html><html><head><meta charset="utf-8"><style>
html,body{{margin:0;background:#f4f4f4;font:12px/1.8 system-ui;color:#555}}
.wrap{{padding:28px;display:flex;gap:40px;align-items:flex-end}}
figure{{margin:0;text-align:center;flex:none}}
</style></head><body>{defs}<div class="wrap">{cells}</div></body></html>"""

    tmp = ROOT / "shots" / "_sprite-check.html"
    tmp.write_text(html, encoding="utf-8")
    subprocess.run(
        [
            EDGE,
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--virtual-time-budget=3000",
            "--window-size=1400,700",
            f"--screenshot={OUT}",
            tmp.resolve().as_uri(),
        ],
        check=True,
        capture_output=True,
    )
    if not OUT.exists():
        raise SystemExit("渲染失败")
    print(f"{OUT} 已生成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
