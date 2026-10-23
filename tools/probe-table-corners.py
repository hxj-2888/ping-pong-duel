"""量出底板里"烘死"的球台四角（归一化坐标）。

用途：把相机标定到这张图上——只要真实球台（2.74×1.525，台高 0.76）投影到这四个角，
后面用同一相机画的球员就会**正好站在底板的球台上**，不会错位。
"""
import os
import numpy as np
from PIL import Image

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "arena_plate_preview.png")
img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float64)
H, W, _ = img.shape
r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
lum = 0.2126 * r + 0.7152 * g + 0.0722 * b

# 台面青蓝
tab = (b > 150) & (b > r + 60) & (g > 95) & (lum > 70)
# 只在球台那块
keep = np.zeros((H, W), bool)
keep[int(H * 0.52):int(H * 0.95), int(W * 0.33):int(W * 0.66)] = True
tab &= keep

ys, xs = np.nonzero(tab)
print("台面像素", len(xs))
print("bbox x", xs.min(), xs.max(), " y", ys.min(), ys.max())

# 逐行左右边界（用于找梯形四角）
rows = {}
for y, x in zip(ys, xs):
    lo, hi = rows.get(y, (10 ** 9, -1))
    rows[y] = (min(lo, x), max(hi, x))
ks = sorted(rows)
print("\n行边界样本（归一化）:")
for i in range(0, len(ks), max(1, len(ks) // 14)):
    y = ks[i]
    lo, hi = rows[y]
    print(f"  y={y/H:.3f}  xL={lo/W:.3f}  xR={hi/W:.3f}  width={(hi-lo)/W:.3f}")

# 四角：最上行（远边）、最下行（近边）
y_far = ks[0]
y_near = ks[-1]
print(f"\n远边 y={y_far/H:.4f}  xL={rows[y_far][0]/W:.4f} xR={rows[y_far][1]/W:.4f}")
print(f"近边 y={y_near/H:.4f}  xL={rows[y_near][0]/W:.4f} xR={rows[y_near][1]/W:.4f}")

# 拟合左右两条边（线性），得到更稳的四角
lo_x = np.array([rows[y][0] for y in ks], float)
hi_x = np.array([rows[y][1] for y in ks], float)
yy = np.array(ks, float)
# 去掉明显被球员遮挡的异常行（宽度骤降）
wdt = hi_x - lo_x
med = np.median(wdt)
ok = wdt > med * 0.55
if ok.sum() > 20:
    kl, kr, ky = lo_x[ok], hi_x[ok], yy[ok]
    pl = np.polyfit(ky, kl, 1)
    pr = np.polyfit(ky, kr, 1)
    for name, yv in (("far", y_far), ("near", y_near)):
        print(f"{name}: xL={np.polyval(pl, yv)/W:.4f} xR={np.polyval(pr, yv)/W:.4f} y={yv/H:.4f}")
