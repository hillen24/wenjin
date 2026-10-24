"""按固定区域裁剪截图。

用途：手机端截图走的是「iframe 钉死视口 → 截整窗 → 裁掉背景」这条路，
      见 scripts/shot-mobile.sh 里的说明。

用法：
    python crop.py <输入> <输出> <宽> <高> [左边距] [上边距]
"""

import sys
from pathlib import Path

from PIL import Image


def main() -> int:
    if len(sys.argv) < 5:
        print(__doc__)
        return 2

    src, dst = Path(sys.argv[1]), Path(sys.argv[2])
    w, h = int(sys.argv[3]), int(sys.argv[4])
    left = int(sys.argv[5]) if len(sys.argv) > 5 else 0
    top = int(sys.argv[6]) if len(sys.argv) > 6 else 0

    img = Image.open(src)
    if img.width < left + w or img.height < top + h:
        print(f"截图太小：{img.size}，需要至少 {left + w}x{top + h}")
        return 1

    img.crop((left, top, left + w, top + h)).save(dst, optimize=True)
    print(f"{dst.name}  {w}x{h}  {Path(dst).stat().st_size} B")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
