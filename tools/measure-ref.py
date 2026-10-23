# -*- coding: utf-8 -*-
"""参考图像素测量：输出结构化场景 spec（JSON）的半自动工具。

用法：
    python tools/measure-ref.py <参考图.jpg> [--out docs/ref-arena-spec.json]

测量项（全部归一化到 0~1，画幅 W×H）：
  - 球台：远边/近边 y、左右边 x、台面主色
  - 球网：网顶 y、网柱 x
  - 双方球员：头顶 y、身体 x 中心、上衣主色
  - 观众墙：左/右阵营分界 x、人群带 y 范围、可见行数、光棒平均长宽（px）
  - 聚光灯：光锥中心 x、锥顶/锥底 y、锥底半宽
  - 地板：地板带 y 范围、主色
  - 全局：主色板（k-means，转 hex）、四角暗角色温
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(int(round(c)) for c in rgb)


def kmeans_palette(px, k=8, iters=24, seed=7):
    """px: (N,3) float. 返回 [[r,g,b],...] 按占比降序。"""
    rng = np.random.default_rng(seed)
    n = len(px)
    if n == 0:
        return []
    idx = rng.choice(n, size=min(k, n), replace=False)
    cent = px[idx].astype(np.float64).copy()
    for _ in range(iters):
        d = ((px[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        for j in range(len(cent)):
            m = lab == j
            if m.any():
                cent[j] = px[m].mean(0)
    d = ((px[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
    lab = d.argmin(1)
    out = []
    for j in range(len(cent)):
        m = (lab == j).sum()
        if m:
            out.append((int(m), cent[j]))
    out.sort(key=lambda t: -t[0])
    tot = sum(c for c, _ in out) or 1
    return [(c / tot, cent) for c, cent in out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    im = Image.open(args.image).convert("RGB")
    W, H = im.size
    a = np.asarray(im).astype(np.float64)
    R, G, B = a[..., 0], a[..., 1], a[..., 2]
    lum = 0.2126 * R + 0.7152 * G + 0.0722 * B

    rep = {"image": {"file": args.image, "w": W, "h": H, "aspect": round(W / H, 4)}}

    # ---------- 1. 球台：饱和蓝的大块连通区域（中下部） ----------
    blue = (B > 90) & (B - R > 45) & (B - G > 25)
    # 只看画面中下部 35%~92%（排除上方观众里的蓝色光棒）
    band = np.zeros_like(blue)
    band[int(H * 0.35):int(H * 0.95), :] = True
    tbl = blue & band
    rows = np.where(tbl.sum(1) > W * 0.02)[0]
    if len(rows):
        y0, y1 = rows.min(), rows.max()
        sub = tbl[y0:y1 + 1]
        cols = np.where(sub.sum(0) > (y1 - y0) * 0.25)[0]
        x0, x1 = cols.min(), cols.max()
        rep["table"] = {
            "far_y": round(y0 / H, 4), "near_y": round(y1 / H, 4),
            "left_x": round(x0 / W, 4), "right_x": round(x1 / W, 4),
            "w_frac": round((x1 - x0) / W, 4), "h_frac": round((y1 - y0) / H, 4),
        }
        core = a[(y0 + (y1 - y0) // 3):(y0 + 2 * (y1 - y0) // 3),
                 (x0 + (x1 - x0) // 3):(x0 + 2 * (x1 - x0) // 3)]
        rep["table"]["hex"] = hexof(core.reshape(-1, 3).mean(0))
    else:
        rep["table"] = None

    # ---------- 2. 球网：台区内横向亮线 ----------
    if rep["table"]:
        ty0, ty1 = int(rep["table"]["far_y"] * H), int(rep["table"]["near_y"] * H)
        tx0, tx1 = int(rep["table"]["left_x"] * W), int(rep["table"]["right_x"] * W)
        seg = lum[ty0:ty1, tx0:tx1]
        rowmax = seg.max(1)
        # 网是横向贯穿的亮结构：找行亮度梯度最大的位置
        cand = np.argsort(rowmax)[-max(3, (ty1 - ty0) // 12):]
        ny = int(np.median(cand)) + ty0
        rep["net"] = {"top_y": round(ny / H, 4),
                      "left_x": round(tx0 / W, 4), "right_x": round(tx1 / W, 4)}

    # ---------- 3. 球员：上衣色聚类（红/蓝两条人形） ----------
    # 近景球员：红衣，位于画面下 1/3 中部；远景球员：蓝衣，位于台面远端上方
    def find_figure(y0f, y1f, x0f, x1f, want):
        sub = a[int(H * y0f):int(H * y1f), int(W * x0f):int(W * x1f)]
        if sub.size == 0:
            return None
        if want == "red":
            m = (sub[..., 0] > 110) & (sub[..., 0] - sub[..., 2] > 40) & (sub[..., 0] - sub[..., 1] > 25)
        else:
            m = (sub[..., 2] > 90) & (sub[..., 2] - sub[..., 0] > 35) & (sub[..., 2] - sub[..., 1] > 20)
        ys, xs = np.where(m)
        if len(ys) < 30:
            return None
        oy, ox = int(H * y0f), int(W * x0f)
        return {
            "head_y": round((ys.min() + oy) / H, 4),
            "foot_y": round((ys.max() + oy) / H, 4),
            "cx": round((xs.mean() + ox) / W, 4),
            "left_x": round((xs.min() + ox) / W, 4),
            "right_x": round((xs.max() + ox) / W, 4),
            "hex": hexof(sub[m].mean(0)),
            "px": int(m.sum()),
        }

    rep["player_near"] = find_figure(0.55, 1.0, 0.30, 0.70, "red")
    rep["player_far"] = find_figure(0.30, 0.62, 0.25, 0.75, "blue")

    # ---------- 4. 观众墙 ----------
    # 红色应援（左半）与蓝色应援（右半）：高亮小色块
    stickL = (R > 120) & (R - G > 55) & (R - B > 55)
    stickR = (B > 120) & (B - R > 45) & (B - G > 25)
    top_zone = np.zeros_like(stickL)
    top_zone[:int(H * 0.62), :] = True   # 观众带（台面以上）
    mL = stickL & top_zone
    mR = stickR & top_zone
    # 去掉球台蓝（远球员蓝衣在台区，已限制 y<0.62H 大体避开）
    def zone(m, name):
        ys, xs = np.where(m)
        if len(ys) < 50:
            return None
        # 按 y 分 12 行桶，数每桶命中，估计可见排数
        buckets = np.linspace(0, H, 13).astype(int)
        rowcount = [int(m[buckets[i]:buckets[i + 1]].sum()) for i in range(12)]
        return {
            "y_top": round(ys.min() / H, 4), "y_bottom": round(ys.max() / H, 4),
            "x_min": round(xs.min() / W, 4), "x_max": round(xs.max() / W, 4),
            "row_buckets": rowcount, "px": int(m.sum()),
            "hex": hexof(a[m].mean(0)),
        }
    rep["crowd_left"] = zone(mL, "L")
    rep["crowd_right"] = zone(mR, "R")
    if rep["crowd_left"] and rep["crowd_right"]:
        rep["crowd"] = {
            "boundary_x": round((rep["crowd_left"]["x_max"] + rep["crowd_right"]["x_min"]) / 2 / W, 4),
            "rows_visible_est": int(sum(1 for c in (rep["crowd_left"]["row_buckets"]) if c > 200)),
        }

    # 光棒尺寸：左上方一块局部区域的亮块连通域粗估
    def stick_size(m, y0f, y1f, x0f, x1f):
        sub = np.zeros_like(m)
        sub[int(H * y0f):int(H * y1f), int(W * x0f):int(W * x1f)] = True
        mm = m & sub
        ys, xs = np.where(mm)
        if len(ys) < 50:
            return None
        # 简单列聚类：按 x 排序后找间隔 >6px 的分组，取组内 y 跨度中位数
        order = np.argsort(xs)
        xs_s, ys_s = xs[order], ys[order]
        groups, cur = [], [0]
        for i in range(1, len(xs_s)):
            if xs_s[i] - xs_s[i - 1] > 6:
                groups.append(cur); cur = []
            cur.append(i)
        groups.append(cur)
        hs = []
        for g in groups:
            if len(g) >= 8:
                hs.append(ys_s[g].max() - ys_s[g].min())
        if not hs:
            return None
        # 宽：组内 x 跨度
        ws = []
        for g in groups:
            if len(g) >= 8:
                ws.append(xs_s[g].max() - xs_s[g].min())
        return {"len_px_med": float(np.median(hs)), "wid_px_med": float(np.median(ws)),
                "groups": len(groups)}
    rep["stick_left"] = stick_size(mL, 0.06, 0.40, 0.02, 0.30)
    rep["stick_right"] = stick_size(mR, 0.06, 0.40, 0.70, 0.98)

    # ---------- 5. 聚光灯锥：顶部中央高亮 ----------
    glow = lum > 150
    top = glow[:int(H * 0.5)]
    cols = np.where(top.sum(0) > H * 0.02)[0]
    if len(cols):
        # 锥体：中心亮带，随 y 增大变宽
        prof = []
        for f in (0.05, 0.15, 0.25, 0.35, 0.45):
            row = glow[int(H * f)]
            xs2 = np.where(row)[0]
            prof.append({"y": f, "x0": round(xs2.min() / W, 4) if len(xs2) else None,
                         "x1": round(xs2.max() / W, 4) if len(xs2) else None,
                         "px": int(row.sum())})
        rep["spotlight"] = {"cx": round(cols.mean() / W, 4), "profile": prof}

    # ---------- 6. 地板：画面底部两侧的暗反光带 ----------
    floor = (lum > 18) & (lum < 90) & (B > R)
    fz = floor[int(H * 0.80):]
    rep["floor"] = {"y_top": 0.80,
                    "hex": hexof(a[int(H * 0.80):].reshape(-1, 3).mean(0))}

    # ---------- 7. 全局色板 ----------
    small = np.asarray(im.resize((160, 100))).astype(np.float64).reshape(-1, 3)
    pal = kmeans_palette(small, k=10)
    rep["palette"] = [{"hex": hexof(c), "frac": round(f, 4)} for f, c in pal]

    # 四角色温
    for name, (yy, xx) in {"tl": (0.02, 0.02), "tr": (0.02, 0.98),
                           "bl": (0.98, 0.02), "br": (0.98, 0.98)}.items():
        patch = a[int(H * yy) - 12:int(H * yy) + 12, int(W * xx) - 12:int(W * xx) + 12]
        rep.setdefault("corners", {})[name] = hexof(patch.reshape(-1, 3).mean(0))

    txt = json.dumps(rep, ensure_ascii=False, indent=2)
    print(txt)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(txt + "\n")
        print("written:", args.out, file=sys.stderr)


if __name__ == "__main__":
    main()
