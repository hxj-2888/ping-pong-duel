# -*- coding: utf-8 -*-
"""参考图定向探针：沿扫描线打印 RGB，人工/半自动判定结构边界。
用法：python tools/probe-ref.py <图> <模式>
模式：vline x_frac y0 y1 ｜ hline y_frac x0 x1 ｜ sample x y（0~1 归一化）｜ grid rows cols
"""
import sys
import numpy as np
from PIL import Image


def cls(r, g, b):
    """粗分类，便于读扫描线。"""
    mx, mn = max(r, g, b), min(r, g, b)
    if mx < 28:
        return "K"          # 近黑背景
    if r > 110 and r - g > 45 and r - b > 45:
        return "R"          # 红/橙
    if b > 110 and b - r > 40 and b - g > 15:
        return "B"          # 蓝
    if r > 150 and g > 120 and b < 110:
        return "W"          # 暖白（亮棒芯/光）
    if mx - mn < 25:
        return "G" if mx > 90 else "k"   # 灰/深灰
    return "."


def main():
    im = Image.open(sys.argv[1]).convert("RGB")
    a = np.asarray(im).astype(int)
    H, W = a.shape[:2]
    mode = sys.argv[2]
    if mode == "vline":
        x = int(float(sys.argv[3]) * W)
        y0, y1 = float(sys.argv[4]), float(sys.argv[5])
        print(f"vline x={x} ({float(sys.argv[3]):.3f}) y {y0}~{y1}")
        prev = None
        for yy in range(int(y0 * H), min(H, int(y1 * H) + 1), max(1, (int(y1 * H) - int(y0 * H)) // 60)):
            r, g, b = a[yy, x]
            c = cls(r, g, b)
            mark = "" if c == prev else "  <<<"
            print(f"  y={yy/H:.4f} ({yy:4d}) rgb=({r:3d},{g:3d},{b:3d}) {c}{mark}")
            prev = c
    elif mode == "hline":
        y = int(float(sys.argv[3]) * H)
        x0, x1 = float(sys.argv[4]), float(sys.argv[5])
        print(f"hline y={y} ({float(sys.argv[3]):.3f}) x {x0}~{x1}")
        prev = None
        for xx in range(int(x0 * W), min(W, int(x1 * W) + 1), max(1, (int(x1 * W) - int(x0 * W)) // 80)):
            r, g, b = a[y, xx]
            c = cls(r, g, b)
            mark = "" if c == prev else "  <<<"
            print(f"  x={xx/W:.4f} ({xx:4d}) rgb=({r:3d},{g:3d},{b:3d}) {c}{mark}")
            prev = c
    elif mode == "sample":
        for spec in sys.argv[3:]:
            xs, ys = spec.split(",")
            x, y = int(float(xs) * W), int(float(ys) * H)
            r, g, b = a[y, x]
            print(f"({xs},{ys}) -> rgb=({r},{g},{b}) #%02x%02x%02x %s" % (r, g, b, cls(r, g, b)))
    elif mode == "grid":
        rows, cols = int(sys.argv[3]), int(sys.argv[4])
        print("grid (class per cell):")
        for i in range(rows):
            line = []
            for j in range(cols):
                yy = int((i + 0.5) / rows * H)
                xx = int((j + 0.5) / cols * W)
                r, g, b = a[yy, xx]
                line.append(cls(r, g, b))
            print(f"  y={(i+0.5)/rows:.2f} " + "".join(line))


if __name__ == "__main__":
    main()
