# -*- coding: utf-8 -*-
"""赛场画面「像不像」量化对比：参考图 vs 游戏截图。

用法：
    python tools/arena-compare.py <参考图> <候选截图> [--flip] [--json out.json]

指标（全部画幅归一化，aspect 不一致时先把宽图中心裁到同 aspect 并注明）：
  1. 区域 bbox IoU：球台（饱和蓝掩膜）/ 观众带（上部亮像素）/ 台上亮池
  2. HSV 三维直方图 L1 距离（12×4×4）
  3. 32×32 单元格均值色 L1
  4. 12 条水平带平均亮度 L1
  5. 左右红蓝均衡（左 1/3 与右 1/3 的 mean(R-B)）
  6. 全局平均亮度差

判定阈值在 THRESH，可按轮次调整；输出 verdict=OK/DIFF 供脚本门禁。
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image

THRESH = {
    "table_iou": 0.55,     # 越高越好（IoU）
    "crowd_iou": 0.60,     # 越高越好（IoU）
    "pool_iou": 0.40,      # 越高越好（IoU）
    "hist_l1": 0.45,       # 越低越好
    "cell32_l1": 0.20,     # 越低越好
    "band_lum_l1": 0.10,   # 越低越好
    "side_slope_diff": 0.06,   # 参考图左红右蓝：左third(R-B) - 右third(R-B) 的差，越低越好
    "lum_diff": 0.10,      # 越低越好
}
HIGHER_BETTER = {"table_iou", "crowd_iou", "pool_iou"}


def load_rgb(path):
    return np.asarray(Image.open(path).convert("RGB")).astype(np.float64)


def crop_to_aspect(a, aspect):
    """把图中心裁到目标 aspect（w/h）。"""
    h, w = a.shape[:2]
    cur = w / h
    if abs(cur - aspect) < 0.02:
        return a, "none"
    if cur > aspect:  # 太宽 → 裁左右
        nw = int(round(h * aspect))
        x0 = (w - nw) // 2
        return a[:, x0:x0 + nw], f"crop-x {w}->{nw}"
    nh = int(round(w / aspect))
    y0 = (h - nh) // 2
    return a[y0:y0 + nh, :], f"crop-y {h}->{nh}"


def mask_table(a):
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    return (B > 140) & (B - R > 70) & (B - G > 35) & (G > 90)


def mask_sticks(a):
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    red = (R > 120) & (R - G > 50) & (R - B > 50)
    blue = (B > 120) & (B - R > 40) & (B - G > 20)
    return red | blue


def bbox_of(mask, min_px=40):
    ys, xs = np.where(mask)
    if len(ys) < min_px:
        return None
    return [xs.min(), ys.min(), xs.max(), ys.max()]


def iou(b1, b2):
    if not b1 or not b2:
        return 0.0
    x0 = max(b1[0], b2[0]); y0 = max(b1[1], b2[1])
    x1 = min(b1[2], b2[2]); y1 = min(b1[3], b2[3])
    inter = max(0, x1 - x0) * max(0, y1 - y0)
    a1 = (b1[2] - b1[0]) * (b1[3] - b1[1])
    a2 = (b2[2] - b2[0]) * (b2[3] - b2[1])
    union = a1 + a2 - inter
    return inter / union if union > 0 else 0.0


def region_metrics(ref, cand):
    H, W = ref.shape[:2]
    out = {}
    # 球台：全图饱和蓝
    out["table_iou"] = round(iou(bbox_of(mask_table(ref)), bbox_of(mask_table(cand))), 3)
    # 观众带：上部 45% 的亮棒像素 bbox
    top = np.zeros(ref.shape[:2], bool)
    top[:int(H * 0.45)] = True
    mr = mask_sticks(ref) & top
    mc = mask_sticks(cand) & top
    out["crowd_iou"] = round(iou(bbox_of(mr), bbox_of(mc)), 3)
    # 台上亮池：台区（y 0.45~0.78, x 0.25~0.75）内亮度 > 140 的像素 bbox
    zone = np.zeros(ref.shape[:2], bool)
    zone[int(H * 0.45):int(H * 0.78), int(W * 0.25):int(W * 0.75)] = True
    lum_r = ref.mean(2)
    lum_c = cand.mean(2)
    pr = (lum_r > 140) & zone
    pc = (lum_c > 140) & zone
    out["pool_iou"] = round(iou(bbox_of(pr, 30), bbox_of(pc, 30)), 3)
    return out


def hist_hsv(a, hb=12, sb=4, vb=4):
    small = np.asarray(Image.fromarray(a.astype(np.uint8)).resize((192, 128)))
    r, g, b = small[..., 0] / 255, small[..., 1] / 255, small[..., 2] / 255
    mx = small.max(2).astype(float) / 255
    mn = small.min(2).astype(float) / 255
    v = mx
    s = np.where(mx > 0, (mx - mn) / np.maximum(mx, 1e-6), 0)
    hsv = np.asarray(Image.fromarray(small).convert("HSV")).astype(float)
    hh = hsv[..., 0] / 255 * hb
    ss = hsv[..., 1] / 255 * sb
    vv = hsv[..., 2] / 255 * vb
    hi = np.clip(hh.astype(int), 0, hb - 1)
    si = np.clip(ss.astype(int), 0, sb - 1)
    vi = np.clip(vv.astype(int), 0, vb - 1)
    idx = (hi * sb + si) * vb + vi
    hist = np.bincount(idx.ravel(), minlength=hb * sb * vb).astype(float)
    return hist / hist.sum()


def color_metrics(ref, cand):
    out = {}
    hr = hist_hsv(ref)
    hc = hist_hsv(cand)
    out["hist_l1"] = round(float(np.abs(hr - hc).sum() / 2), 3)
    # 32×32 单元格均值色
    def cells(a):
        im = np.asarray(Image.fromarray(a.astype(np.uint8)).resize((32, 32)))
        return im.astype(float) / 255
    cr, cc = cells(ref), cells(cand)
    out["cell32_l1"] = round(float(np.abs(cr - cc).mean()), 3)
    # 12 条水平带平均亮度
    lr = ref.mean(2) / 255
    lc = cand.mean(2) / 255
    H = ref.shape[0]
    br = [lr[int(H * i / 12):int(H * (i + 1) / 12)].mean() for i in range(12)]
    bc = [lc[int(H * i / 12):int(H * (i + 1) / 12)].mean() for i in range(12)]
    out["band_lum_l1"] = round(float(np.abs(np.array(br) - np.array(bc)).mean()), 3)
    out["band_profile"] = {"ref": [round(x, 3) for x in br], "cand": [round(x, 3) for x in bc]}
    # 左右红蓝均衡
    W = ref.shape[1]
    def side_slope(a):
        l = a[:, :W // 3].mean(axis=(0, 1))  # (3,) R G B
        r = a[:, 2 * W // 3:].mean(axis=(0, 1))
        return float(l[0] - l[2]), float(r[0] - r[2])
    lr_rb, rr_rb = side_slope(ref)
    lc_rb, rc_rb = side_slope(cand)
    out["side_balance"] = {
        "ref": {"left_RB": round(lr_rb, 1), "right_RB": round(rr_rb, 1)},
        "cand": {"left_RB": round(lc_rb, 1), "right_RB": round(rc_rb, 1)},
    }
    out["side_slope_diff"] = round(abs((lr_rb - rr_rb) - (lc_rb - rc_rb)) / 255, 3)
    out["lum_diff"] = round(abs(float(ref.mean() / 255 - cand.mean() / 255)), 3)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("ref")
    ap.add_argument("cand")
    ap.add_argument("--flip", action="store_true", help="候选图水平镜像（参考图是红方视角、harness 截图未镜像）")
    ap.add_argument("--json", default=None)
    args = ap.parse_args()

    ref = load_rgb(args.ref)
    cand = load_rgb(args.cand)
    if args.flip:
        cand = cand[:, ::-1]
    # aspect 对齐：以参考图为准裁候选
    aspect = ref.shape[1] / ref.shape[0]
    cand2, note = crop_to_aspect(cand, aspect)
    if cand2.shape[:2] != ref.shape[:2]:
        cand2 = np.asarray(Image.fromarray(cand2.astype(np.uint8)).resize((ref.shape[1], ref.shape[0])))

    m = {}
    m.update(region_metrics(ref, cand2))
    m.update(color_metrics(ref, cand2))

    fails = []
    for k, t in THRESH.items():
        v = m.get(k)
        if v is None:
            continue
        if k in HIGHER_BETTER:
            if v < t:
                fails.append(f"{k}={v} < {t}")
        elif v > t:
            fails.append(f"{k}={v} > {t}")
    m["verdict"] = "DIFF" if fails else "OK"
    m["fails"] = fails
    m["note"] = f"cand {note}; flip={args.flip}"

    txt = json.dumps(m, ensure_ascii=False, indent=2)
    print(txt)
    if args.json:
        with open(args.json, "w", encoding="utf-8") as f:
            f.write(txt + "\n")
    sys.exit(0 if m["verdict"] == "OK" else 1)


if __name__ == "__main__":
    main()
