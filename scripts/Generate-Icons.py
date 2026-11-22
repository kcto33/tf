"""生成 PWA 图标：static/icons/icon-512.png / icon-192.png / apple-touch-icon.png。

设计与应用内 logo 一致：蓝色圆角底 + 白色下载箭头。
maskable 图标的内容绘制在 80% 安全区内，四角留白由系统裁切。
用法: python scripts/Generate-Icons.py
"""
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
OUT_DIR = ROOT / "static" / "icons"

ACCENT = (37, 99, 235, 255)
WHITE = (255, 255, 255, 255)
SIZE = 512
# maskable 安全区：内容绘制在中央 80% 内
SAFE = int(SIZE * 0.8)
OFFSET = (SIZE - SAFE) // 2


def build_icon() -> Image.Image:
    image = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
    draw = ImageDraw.Draw(image)
    # 全出血背景（maskable 圆形裁切后仍是无缝底色）
    draw.rounded_rectangle((0, 0, SIZE, SIZE), radius=int(SIZE * 0.2), fill=ACCENT)

    # 下载箭头（在安全区内按比例绘制）
    cx = SIZE / 2
    shaft_top = OFFSET + SAFE * 0.26
    shaft_bottom = OFFSET + SAFE * 0.55
    shaft_width = SAFE * 0.09
    arrow_head = SAFE * 0.18
    base_y = OFFSET + SAFE * 0.74
    base_width = SAFE * 0.46
    base_height = SAFE * 0.075

    draw.rounded_rectangle(
        (cx - shaft_width / 2, shaft_top, cx + shaft_width / 2, shaft_bottom),
        radius=shaft_width / 2,
        fill=WHITE,
    )
    draw.polygon(
        [
            (cx - arrow_head, shaft_bottom - arrow_head * 0.35),
            (cx + arrow_head, shaft_bottom - arrow_head * 0.35),
            (cx, shaft_bottom + arrow_head * 0.65),
        ],
        fill=WHITE,
    )
    draw.rounded_rectangle(
        (cx - base_width / 2, base_y, cx + base_width / 2, base_y + base_height),
        radius=base_height / 2,
        fill=WHITE,
    )
    return image


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    icon = build_icon()
    icon.save(OUT_DIR / "icon-512.png")
    icon.resize((192, 192), Image.LANCZOS).save(OUT_DIR / "icon-192.png")
    icon.resize((180, 180), Image.LANCZOS).save(OUT_DIR / "apple-touch-icon.png")
    print(f"icons written to {OUT_DIR}")


if __name__ == "__main__":
    main()
