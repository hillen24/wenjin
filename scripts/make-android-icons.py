"""从 assets/icon.png 生成 Android 全套启动图标。

为什么要自己写而不用 Android Studio 的 Image Asset：
这里没有 GUI，而且图标源只有一张 512×512，用 Pillow 直接缩放最省事。

致知 3.7.0 起图标源换成「白底黑徽章」（日出于书），与旧的火苗标相反：
  - glyph() 以前抠白图形，现在抠黑图形；
  - 传统图标以前透出橙底，现在圆角/圆形之外填白，
    否则透明角落在深色桌面上会露出难看的黑洞。

产出：
  mipmap-*/ic_launcher.png            传统方形图标（白底圆角）
  mipmap-*/ic_launcher_round.png      圆形图标（白底圆形遮罩）
  mipmap-*/ic_launcher_foreground.png 自适应图标前景（透明底，黑徽章占安全区）

用法：
    python make-android-icons.py <android 工程根目录>
"""

import sys
from pathlib import Path

from PIL import Image, ImageDraw

# 安卓各密度下 launcher 图标的边长
DENSITIES = {
    "mdpi": 48,
    "hdpi": 72,
    "xhdpi": 96,
    "xxhdpi": 144,
    "xxxhdpi": 192,
}

# 自适应图标：108dp 画布，中间 72dp 是安全区，logo 再留一点余量
ADAPTIVE_CANVAS = 432
ADAPTIVE_LOGO = 240

# 白底黑徽章：低于 BLACK_MAX 视为图形，高于 WHITE_MIN 视为白底，中间线性过渡
WHITE_MIN = 235
BLACK_MAX = 40


def rounded(img: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    """白底圆角方形：徽章本体不动，四角填白而不是透空。"""
    size = img.width
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    out = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    out.paste(img, (0, 0), mask)
    return out


def circular(img: Image.Image) -> Image.Image:
    """白底圆形：同上，圆外填白。"""
    size = img.width
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (255, 255, 255, 255))
    out.paste(img, (0, 0), mask)
    return out


def glyph(img: Image.Image) -> Image.Image:
    """抠出 logo 里的黑色徽章，做成透明底前景。

    自适应图标是「背景色 + 前景层」两层叠加。ic_launcher_background
    已经改成白色，所以前景只留黑色图形；背景层那边也是白的，
    圆形遮罩下四角由系统裁掉，不会露出方角。
    """
    src = img.convert("RGB")
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    px_src = src.load()
    px_out = out.load()

    span = WHITE_MIN - BLACK_MAX
    for y in range(src.height):
        for x in range(src.width):
            r, g, b = px_src[x, y]
            # 黑徽章三通道都低，用最高通道做阈值，抗锯齿边缘取半透明
            high = max(r, g, b)
            alpha = int(max(0, min(255, (WHITE_MIN - high) * 255 / span)))
            if alpha > 0:
                px_out[x, y] = (0, 0, 0, alpha)

    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2

    android = Path(sys.argv[1])
    src_path = Path(__file__).resolve().parent.parent / "assets" / "icon.png"
    if not src_path.exists():
        print(f"找不到图标源：{src_path}")
        return 1

    src = Image.open(src_path).convert("RGBA")
    if src.width != src.height:
        print(f"图标源必须是正方形，当前 {src.size}")
        return 1

    black_glyph = glyph(src)

    written = 0
    for density, px in DENSITIES.items():
        out_dir = android / "app" / "src" / "main" / "res" / f"mipmap-{density}"
        if not out_dir.exists():
            continue

        big = src.resize((px, px), Image.LANCZOS)
        rounded(big).save(out_dir / "ic_launcher.png", optimize=True)
        circular(big).save(out_dir / "ic_launcher_round.png", optimize=True)

        # 前景层：透明画布 + 居中的黑色徽章
        fg = Image.new("RGBA", (ADAPTIVE_CANVAS, ADAPTIVE_CANVAS), (0, 0, 0, 0))
        g = black_glyph.resize((ADAPTIVE_LOGO, ADAPTIVE_LOGO), Image.LANCZOS)
        offset = (ADAPTIVE_CANVAS - ADAPTIVE_LOGO) // 2
        fg.paste(g, (offset, offset), g)
        fg.save(out_dir / "ic_launcher_foreground.png", optimize=True)
        written += 3

    print(f"已写入 {written} 个图标文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
