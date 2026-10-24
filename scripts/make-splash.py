"""从新标记生成 Android 全套启动图（splash）。

以前这套图是 Capacitor 出厂的默认蓝闪电，开屏第一眼就是「没做完」。
现在统一成：品牌橙底 + 居中的白色火标（i-mark 的同一团火）。

为什么要先渲染一张 1024 的 PNG 再拼：
PIL 画不了 SVG 路径，所以先用 Edge 无头把火焰渲成透明底 PNG，
再按各密度缩放贴到橙底上 —— 这样曲线边缘不会因为反复缩放而糊。

用法（在仓库根目录）：
    python scripts/make-splash.py apps/mobile/android
"""

import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image

# 与 --accent 同色系；启动图和图标必须是一个橙，否则开屏会「闪一下」
BRAND = (232, 98, 58)
DEEP = (199, 74, 40)

# 火焰轮廓（与 WenjinSprite 的 i-mark 完全一致，24 网格，未旋转）
FLAME_D = (
    "M6.0 18.2C6.6 12.0 7.1 8.8 7.8 6.6C9.4 10.2 10.3 12.5 10.7 14.1"
    "C11.2 9.5 11.7 5.2 12.4 2.0C13.6 5.6 14.1 9.6 14.5 13.3"
    "C15.3 9.7 16.1 7.0 16.6 4.9C17.6 8.3 18.3 12.6 18.5 18.2"
    "C14.7 20.0 9.7 20.0 6.0 18.2Z"
)

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


def render_flame(workdir: Path) -> Image.Image:
    """渲一张 1024 透明底的火标 PNG。"""
    html = workdir / "flame.html"
    html.write_text(
        """<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;width:1024px;height:1024px;background:transparent;overflow:hidden}
svg{display:block;width:1024px;height:1024px}
</style></head><body>
<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
  <g transform="rotate(-5 12 12)"><path fill="#fff" d="%s"/></g>
</svg></body></html>"""
        % FLAME_D,
        encoding="utf-8",
    )
    png = workdir / "flame.png"
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
        raise SystemExit("火标渲染失败")
    return Image.open(png).convert("RGBA")


def make_splash(flame: Image.Image, w: int, h: int) -> Image.Image:
    """橙底 + 居中火标。火标取短边的 32%——够醒目，又不至于像广告屏。"""
    bg = Image.new("RGBA", (w, h), BRAND + (255,))
    # 从左上往右下的极轻渐变，避免大面积纯色显得廉价
    top = Image.new("RGBA", (w, h), (255, 138, 92, 255))
    mask = Image.linear_gradient("L").resize((w, h))
    bg = Image.composite(top, bg, mask.point(lambda v: int(v * 0.35)))

    side = int(min(w, h) * 0.32)
    glyph = flame.resize((side, side), Image.LANCZOS)
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
        flame = render_flame(Path(td))
        n = 0
        for rel, (w, h) in SIZES.items():
            out = res / rel
            out.parent.mkdir(parents=True, exist_ok=True)
            make_splash(flame, w, h).save(out, optimize=True)
            n += 1
    print(f"已写入 {n} 张启动图")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
