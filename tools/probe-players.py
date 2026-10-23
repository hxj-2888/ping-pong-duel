"""量球员/球拍的真实颜色，用来做**紧贴轮廓**的擦除掩膜。

实测（近端球员头部）：球衣/皮肤是深藏青 rgb(31,54,95)、(26,56,90)；
台面是亮青蓝 rgb(44,141,218)；地板是暖棕 rgb(82,86,98) 附近。
所以判据是：
  · 人   ：lum < 95 且 b < 150（台面 b 在 200+，地板 b 在 100 左右但 lum 更高）
  · 红拍 ：r > b + 30 且 r > 110
  · 白虚线：lum > 165 且 (b - r) < 45
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "ref_arena_nowatermark.jpg")
img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float64)
H, W, _ = img.shape
r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
lum = 0.2126 * r + 0.7152 * g + 0.0722 * b

person = (lum < 95) & (b < 150) & (g < 130)
red = (r > 110) & (r > b + 30)
white = (lum > 165) & (b - r < 45) & (b - r > -60)

for name, (yy0, yy1, xx0, xx1) in (
    ("far", (int(H * 0.485), int(H * 0.670), int(W * 0.440), int(W * 0.580))),
    ("near", (int(H * 0.690), int(H * 1.000), int(W * 0.360), int(W * 0.660))),
):
    box = np.zeros((H, W), bool)
    box[yy0:yy1, xx0:xx1] = True
    n = box.sum()
    print(f"{name}: box={n}")
    for label, m in (("person", person), ("red", red), ("white", white)):
        c = int((box & m).sum())
        print(f"   {label:7s} {c:7d}  {c / n * 100:5.1f}%")
    allm = box & (person | red | white)
    print(f"   union   {int(allm.sum()):7d}  {allm.sum() / n * 100:5.1f}%")
