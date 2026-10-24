"""从新标记生成 Android 全套启动图（splash）。

3.7.0「致知」起换成「日出于书」几何徽章：白底 + 居中黑徽章，
与 assets/icon.png、assets/icon-source.html 是同一套几何。

为什么要先渲染一张 1024 的 PNG 再拼：
PIL 画不了 SVG 路径，所以先用 Edge 无头把徽章渲成透明底 PNG，
再按各密度缩放贴到白底上 —— 这样曲线边缘不会因为反复缩放而糊。

用法（在仓库根目录）：
    python scripts/make-splash.py apps/mobile/android
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

# 启动图底色：纯白。徽章是纯黑单色，白底是规格的一部分，不加渐变
BG = (255, 255, 255)

# 徽章几何（与 assets/icon-source.html 的 #badge 完全一致，512 网格）
BOOK_D = (
    "M 110.1 316.8 C 98 352, 88 392, 86 428 Q 86 446, 104 446 "
    "L 408 446 Q 426 446, 426 428 C 424 392, 414 352, 401.9 316.8 "
    "A 172 172 0 0 1 110.1 316.8 Z"
)
SUN = (256, 226, 54)
RAYS = [
    (332, 226, 390, 226),
    (294, 291.8, 323, 342.2),
    (218, 291.8, 189, 342.2),
    (180, 226, 122, 226),
    (218, 160.2, 189, 109.8),
    (294, 160.2, 323, 109.8),
]
RAY_SW = 19
DOTS = [
    (406, 226, 11),
    (331, 355.9, 11),
    (181, 355.9, 11),
    (106, 226, 11),
    (181, 96.1, 11),
    (331, 96.1, 11),
]
FORKS = [(106, 226, 69.7, 209.1), (406, 226, 442.3, 209.1)]
FORK_SW = 14
FORK_DOTS = [(69.7, 209.1, 8.5), (442.3, 209.1, 8.5)]

# 各密度启动图尺寸，与 Capacitor 出厂布局一致
SIZES = {
    "drawable/splash.png": (480, 320),
    "drawable-land-mdpi/splash.png": (480, 320),
    "drawable-land-hdpi/splash.png": (800, 480),
    "drawable-land-xhdpi/splash.png": (1280, 720),
    "drawable-land-xxhdpi/splash.png": (1600, 960),
    "drawable-land-xxxhdpi/splash.png": (1920, 1280),
    "drawable-port-mdpi/splash.png": (320, 480),
    "drawable-port-hdpi/splash.png": (480, 800),
    "drawable-port-xhdpi/splash.png": (720, 1280),
    "drawable-port-xxhdpi/splash.png": (960, 1600),
    "drawable-port-xxxhdpi/splash.png": (1280, 1920),
}

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_edge() -> str:
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            return p
    raise SystemExit("找不到 Edge，无法渲染矢量标记")


def badge_svg() -> str:
    """拼出与 icon-source.html 一致的徽章 SVG（透明底、纯黑）。"""
    rays = "".join(
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>'
        for x1, y1, x2, y2 in RAYS
    )
    dots = "".join(f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y, r in DOTS)
    forks = "".join(
        f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}"/>'
        for x1, y1, x2, y2 in FORKS
    )
    fork_dots = "".join(
        f'<circle cx="{x}" cy="{y}" r="{r}"/>' for x, y, r in FORK_DOTS
    )
    return f"""<svg viewBox="0 0 512 512" xmlns="http://www.w3.org/2000/svg">
  <path fill="#000" d="{BOOK_D}"/>
  <circle cx="{SUN[0]}" cy="{SUN[1]}" r="{SUN[2]}" fill="#000"/>
  <g stroke="#000" stroke-width="{RAY_SW}" stroke-linecap="round">{rays}</g>
  <g fill="#000">{dots}</g>
  <g stroke="#000" stroke-width="{FORK_SW}" stroke-linecap="round">{forks}</g>
  <g fill="#000">{fork_dots}</g>
</svg>"""


def render_badge(workdir: Path) -> Image.Image:
    """渲一张 1024 透明底的黑徽章 PNG。"""
    html = workdir / "badge.html"
    html.write_text(
        """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
svg{display:block;width:1024px;height:1024px}
</style></head><body>"""
        + badge_svg()
        + "</body></html>",
        encoding="utf-8",
    )
    png = workdir / "badge.png"
    subprocess.run(
        [
            find_edge(),
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            "--default-background-color=00000000",
            "--window-size=1024,1024",
            f"--screenshot={png}",
            html.resolve().as_uri(),
        ],
        check=True,
        capture_output=True,
    )
    if not png.exists():
        raise SystemExit("徽章渲染失败")
    return Image.open(png).convert("RGBA")


def make_splash(badge: Image.Image, w: int, h: int) -> Image.Image:
    """白底 + 居中徽章。徽章取短边的 34%——开屏上够稳，又不占满屏。"""
    bg = Image.new("RGBA", (w, h), BG + (255,))
    side = int(min(w, h) * 0.34)
    glyph = badge.resize((side, side), Image.LANCZOS)
    bg.alpha_composite(glyph, ((w - side) // 2, (h - side) // 2))
    return bg.convert("RGB")


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    res = Path(sys.argv[1]) / "app" / "src" / "main" / "res"
    if not res.exists():
        print(f"找不到 res 目录：{res}")
        return 1

    with tempfile.TemporaryDirectory() as td:
        badge = render_badge(Path(td))
        n = 0
        for rel, (w, h) in SIZES.items():
            out = res / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            make_splash(badge, w, h).save(out, optimize=True)
            n += 1
    print(f"已写入 {n} 张启动图")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
