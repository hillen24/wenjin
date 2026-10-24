"""把 assets/icon-source.html 的徽章渲成 512 白底 PNG，覆盖 assets/icon.png。

Edge 无头截图：file:// URL + --screenshot=绝对路径（相对路径会写到 Edge 自己的
工作目录， silently 失败）。窗口 512x512 正好框住页面第一个 512 主视图（body margin:0）。

⚠ 实测坑：Edge 无头模式下窗口尺寸必须大于页面内容，否则布局塌坏
（小 SVG 被压成细条、内容不绘制）。窗口要比内容宽和高各大几十像素。
"""

import subprocess
import sys
from pathlib import Path

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
]


def find_edge() -> str:
    for p in EDGE_CANDIDATES:
        if Path(p).exists():
            return p
    raise SystemExit("找不到 Edge")


def shot(url: Path, out: Path, w: int, h: int) -> None:
    subprocess.run(
        [
            find_edge(),
            "--headless",
            "--disable-gpu",
            "--hide-scrollbars",
            "--force-device-scale-factor=1",
            f"--window-size={w},{h}",
            f"--screenshot={out}",
            url.resolve().as_uri(),
        ],
        check=True,
        capture_output=True,
    )
    if not out.exists():
        raise SystemExit(f"渲染失败：{out}")


def main() -> int:
    root = Path(__file__).resolve().parent.parent
    src = root / "assets" / "icon-source.html"
    if not src.exists():
        print(f"找不到渲染源：{src}")
        return 1

    shot(src, root / "assets" / "icon.png", 512, 512)
    print("assets/icon.png 512x512 已生成")

    if "--ladder" in sys.argv:
        out = root / "shots" / "logo-ladder.png"
        out.parent.mkdir(parents=True, exist_ok=True)
        shot(src, out, 460, 780)
        print(f"{out} 已生成")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
