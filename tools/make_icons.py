# -*- coding: utf-8 -*-
"""アプリアイコンを生成する。 python3 tools/make_icons.py"""
import os
from PIL import Image, ImageDraw

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

BG = (107, 74, 47)        # 表紙の革の色
BG_DARK = (82, 55, 33)
PAGE = (247, 243, 234)
PAGE_SHADE = (226, 216, 198)
GOLD = (214, 174, 108)


def draw(size, pad_ratio):
    """開いた聖書 + 十字のアイコンを描く。"""
    S = size * 4                      # 4倍で描いて縮小（アンチエイリアス）
    img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    d = ImageDraw.Draw(img)

    # 角丸の表紙
    pad = int(S * pad_ratio)
    box = (pad, pad, S - pad, S - pad)
    d.rounded_rectangle(box, radius=int(S * 0.19), fill=BG)

    w = box[2] - box[0]
    h = box[3] - box[1]

    # 本の領域
    bx0 = box[0] + w * 0.13
    bx1 = box[2] - w * 0.13
    by0 = box[1] + h * 0.26
    by1 = box[3] - h * 0.20
    mid = (bx0 + bx1) / 2
    lift = h * 0.055                  # ページ外側の反り

    # 左右のページ
    for sign, outer in ((-1, bx0), (1, bx1)):
        d.polygon([
            (mid, by0),
            (outer, by0 + lift),
            (outer, by1),
            (mid, by1 - lift * 0.35),
        ], fill=PAGE if sign < 0 else PAGE_SHADE)

    # 左ページを明るく、右ページを少し暗くして見開きらしくする
    d.polygon([(mid, by0), (bx0, by0 + lift), (bx0, by1), (mid, by1 - lift * 0.35)], fill=PAGE)

    # 綴じ目
    d.line([(mid, by0), (mid, by1 - lift * 0.35)], fill=BG_DARK, width=max(2, int(S * 0.012)))

    # 本文を示す罫
    rule = max(2, int(S * 0.009))
    for i in range(4):
        y = by0 + (by1 - by0) * (0.36 + i * 0.145)
        inset = (by1 - by0) * 0.04
        d.line([(mid - (mid - bx0) * 0.78, y + inset), (mid - (mid - bx0) * 0.14, y + inset)],
               fill=PAGE_SHADE, width=rule)
        d.line([(mid + (bx1 - mid) * 0.14, y), (mid + (bx1 - mid) * 0.78, y)],
               fill=(205, 194, 174), width=rule)

    # 上部の十字
    cw = max(3, int(S * 0.030))
    cx = S / 2
    cy0 = box[1] + h * 0.075
    cy1 = by0 - h * 0.035
    d.line([(cx, cy0), (cx, cy1)], fill=GOLD, width=cw)
    arm = w * 0.085
    ay = cy0 + (cy1 - cy0) * 0.38
    d.line([(cx - arm, ay), (cx + arm, ay)], fill=GOLD, width=cw)

    return img.resize((size, size), Image.LANCZOS)


def main():
    out = [
        ('icon-192.png', 192, 0.055),
        ('icon-512.png', 512, 0.055),
        ('apple-touch-icon.png', 180, 0.0),
        ('icon-maskable-512.png', 512, 0.125),   # セーフゾーンを確保
    ]
    for name, size, pad in out:
        img = draw(size, pad)
        if name in ('apple-touch-icon.png', 'icon-maskable-512.png'):
            flat = Image.new('RGB', img.size, BG)
            flat.paste(img, (0, 0), img)
            img = flat
        img.save(os.path.join(ROOT, name))
        print(name, size)


if __name__ == '__main__':
    main()
