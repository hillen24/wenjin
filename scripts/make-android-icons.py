"""从 assets/icon.png 生成 Android 全套启动图标。

为什么要自己写而不用 Android Studio 的 Image Asset：
这里没有 GUI，而且图标源只有一张 512×512，用 Pillow 直接缩放最省事。

产出：
  mipmap-*/ic_launcher.png            传统方形图标（带圆角）
  mipmap-*/ic_launcher_round.png      圆形图标（圆形遮罩）
  mipmap-*/ic_launcher_foreground.png 自适应图标前景（透明底，logo 占安全区）

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


def rounded(img: Image.Image, radius_ratio: float = 0.22) -> Image.Image:
    """按比例给方形图加圆角（安卓方形图标惯例约 20%~25%）。"""
    size = img.width
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (0, 0, size - 1, size - 1), radius=int(size * radius_ratio), fill=255
    )
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def circular(img: Image.Image) -> Image.Image:
    size = img.width
    mask = Image.new("L", (size, size), 0)
    ImageDraw.Draw(mask).ellipse((0, 0, size - 1, size - 1), fill=255)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img, (0, 0), mask)
    return out


def glyph(img: Image.Image) -> Image.Image:
    """抠出 logo 里的白色拱门，做成透明底前景。

    自适应图标是「背景色 + 前景层」两层叠加。如果把带橙底的完整 logo
    当前景，圆形遮罩下会露出一圈方角；所以前景只留白色图形，
    橙色交给 background 层去填。
    """
    src = img.convert("RGB")
    out = Image.new("RGBA", src.size, (0, 0, 0, 0))
    px_src = src.load()
    px_out = out.load()

    for y in range(src.height):
        for x in range(src.width):
            r, g, b = px_src[x, y]
            # 橙色底的最低通道约 58，白色图形三通道都在 250 以上，
            # 用最低通道做阈值就能顺着抗锯齿边缘取到半透明
            low = min(r, g, b)
            alpha = int(max(0, min(255, (low - 110) * 255 / (250 - 110))))
            if alpha > 0:
                px_out[x, y] = (255, 255, 255, alpha)

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

    white_glyph = glyph(src)

    written = 0
    for density, px in DENSITIES.items():
        out_dir = android / "app" / "src" / "main" / "res" / f"mipmap-{density}"
        if not out_dir.exists():
            continue

        big = src.resize((px, px), Image.LANCZOS)
        rounded(big).save(out_dir / "ic_launcher.png", optimize=True)
        circular(big).save(out_dir / "ic_launcher_round.png", optimize=True)

        # 前景层：透明画布 + 居中的白色拱门
        fg = Image.new("RGBA", (ADAPTIVE_CANVAS, ADAPTIVE_CANVAS), (0, 0, 0, 0))
        g = white_glyph.resize((ADAPTIVE_LOGO, ADAPTIVE_LOGO), Image.LANCZOS)
        offset = (ADAPTIVE_CANVAS - ADAPTIVE_LOGO) // 2
        fg.paste(g, (offset, offset), g)
        fg.save(out_dir / "ic_launcher_foreground.png", optimize=True)
        written += 3

    print(f"已写入 {written} 个图标文件")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
