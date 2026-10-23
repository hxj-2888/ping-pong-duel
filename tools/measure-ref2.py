# -*- coding: utf-8 -*-
"""参考图聚焦测量 v2：分区掩膜 + 连通聚类，输出可校验的场景 spec JSON。
用法：python tools/measure-ref2.py <图> [--out docs/ref-arena-spec.json]
"""
import argparse
import json
import sys

import numpy as np
from PIL import Image


def hexof(rgb):
    return "#%02x%02x%02x" % tuple(int(round(max(0, min(255, c)))) for c in rgb)


def runs(mask1d, min_len=1):
    """返回 1D 布尔数组中的 True 游段 [(start, end_exclusive), ...]"""
    out, s = [], None
    for i, v in enumerate(mask1d):
        if v and s is None:
            s = i
        elif not v and s is not None:
            if i - s >= min_len:
                out.append((s, i))
            s = None
    if s is not None and len(mask1d) - s >= min_len:
        out.append((s, len(mask1d)))
    return out


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
    S = {"image": {"w": W, "h": H, "aspect": round(W / H, 4)}}

    # ============ 1. 球台 ============
    # 台面蓝：饱和且亮（聚光灯下台心 ~ (96,157,250)）
    tbl_blue = (B > 140) & (B - R > 70) & (B - G > 35) & (G > 90)
    zone = np.zeros_like(tbl_blue)
    zone[int(0.40 * H):int(0.96 * H), int(0.12 * W):int(0.88 * W)] = True
    m = tbl_blue & zone
    rowrun = []
    for y in range(int(0.40 * H), int(0.96 * H)):
        rr = runs(m[y], min_len=int(0.10 * W))
        if rr:
            best = max(rr, key=lambda t: t[1] - t[0])
            rowrun.append((y, best[0], best[1], best[1] - best[0]))
    if rowrun:
        ys = [r[0] for r in rowrun]
        far_y, near_y = min(ys), max(ys)
        # 台宽：取中间三行的 run 均值（避开远近收缩）
        mid = rowrun[len(rowrun) // 2 - 1:len(rowrun) // 2 + 2]
        lx = int(np.mean([r[1] for r in mid]))
        rx = int(np.mean([r[2] for r in mid]))
        core = a[(far_y + near_y) // 2, lx:rx]
        S["table"] = {
            "far_y": round(far_y / H, 4), "near_y": round(near_y / H, 4),
            "left_x": round(lx / W, 4), "right_x": round(rx / W, 4),
            "mid_row_y": round(mid[len(mid) // 2][0] / H, 4),
            "hex_center": hexof(a[int(0.55 * H), int(0.5 * W)]),
            "hex_midband": hexof(core.reshape(-1, 3).mean(0)),
        }

    # ============ 2. 球网（台面上横向白线） ============
    if "table" in S:
        ty0, ty1 = int(S["table"]["far_y"] * H), int(S["table"]["near_y"] * H)
        tx0, tx1 = int(S["table"]["left_x"] * W), int(S["table"]["right_x"] * W)
        white = (R > 170) & (G > 175) & (B > 175)
        cnt = [int(white[y, tx0:tx1].sum()) for y in range(ty0, ty1)]
        if cnt:
            ny = ty0 + int(np.argmax(cnt))
            S["net"] = {"top_y": round(ny / H, 4),
                        "white_px": int(max(cnt)),
                        "left_x": round(tx0 / W, 4), "right_x": round(tx1 / W, 4)}

    # ============ 3. 双方球员 ============
    # 近景红衣：避开左侧观众红（x>0.35），台面以下
    red = (R > 100) & (R - G > 45) & (R - B > 40)
    z = np.zeros_like(red)
    z[int(0.58 * H):, int(0.33 * W):int(0.68 * W)] = True
    mr = red & z
    ys, xs = np.where(mr)
    if len(ys) > 200:
        S["player_near"] = {
            "head_y": round(ys.min() / H, 4), "foot_y": round(ys.max() / H, 4),
            "cx": round(xs.mean() / W, 4),
            "left_x": round(xs.min() / W, 4), "right_x": round(xs.max() / W, 4),
            "h_frac": round((ys.max() - ys.min()) / H, 4),
            "hex_shirt": hexof(a[int(0.71 * H), int(0.49 * W)]),
        }
    # 远景蓝衣：台面远边之上
    blue = (B > 90) & (B - R > 35) & (B - G > 15)
    z2 = np.zeros_like(blue)
    z2[int(0.34 * H):int(0.47 * H), int(0.38 * W):int(0.62 * W)] = True
    mf = blue & z2
    ys2, xs2 = np.where(mf)
    if len(ys2) > 100:
        S["player_far"] = {
            "head_y": round(ys2.min() / H, 4), "foot_y": round(ys2.max() / H, 4),
            "cx": round(xs2.mean() / W, 4),
            "h_frac": round((ys2.max() - ys2.min()) / H, 4),
            "hex_shirt": hexof(a[int(0.42 * H), int(0.50 * W)]),
        }

    # ============ 4. 观众墙 ============
    stickR = (R > 120) & (R - G > 50) & (R - B > 50)
    stickB = (B > 120) & (B - R > 40) & (B - G > 20)
    band = np.zeros_like(stickR)
    band[:int(0.44 * H)] = True
    mL, mR = stickR & band, stickB & band

    def zone_stat(m):
        ys, xs = np.where(m)
        if len(ys) < 100:
            return None
        return {"y_top": round(ys.min() / H, 4), "y_bot": round(ys.max() / H, 4),
                "x_min": round(xs.min() / W, 4), "x_max": round(xs.max() / W, 4),
                "px": int(m.sum()), "hex_mean": hexof(a[m].mean(0)),
                "hex_core": hexof(a[m][np.argsort(lum[m])[-max(1, len(ys) // 50):]].mean(0))}
    S["crowd_left"] = zone_stat(mL)
    S["crowd_right"] = zone_stat(mR)

    # 红蓝分界：顶部带内按列统计主色
    prof = []
    for yf in (0.08, 0.16, 0.24, 0.32, 0.40):
        y = int(yf * H)
        row_r, row_b = mL[y], mR[y]
        # 左半红命中列、右半蓝命中列
        lc = np.where(row_r[:W // 2])[0]
        rc = np.where(row_b[W // 2:])[0]
        # 找红→蓝翻转列：红命中最后列 vs 蓝命中最前列
        cross = None
        if len(lc) and len(rc):
            cross = round((lc.max() + (rc.min() + W // 2)) / 2 / W, 4)
        prof.append({"y": yf, "red_cols": len(lc), "blue_cols": len(rc), "cross_x": cross})
    S["crowd_boundary_profile"] = prof

    # 光棒尺寸：左上 / 右上两块，按 x 间隙聚类
    def stick_size(m, y0f, y1f, x0f, x1f):
        sub = np.zeros_like(m)
        sub[int(y0f * H):int(y1f * H), int(x0f * W):int(x1f * W)] = True
        mm = m & sub
        ys, xs = np.where(mm)
        if len(ys) < 100:
            return None
        order = np.argsort(xs)
        xs_s, ys_s = xs[order], ys[order]
        groups, cur = [], [0]
        for i in range(1, len(xs_s)):
            if xs_s[i] - xs_s[i - 1] > 10:
                groups.append(cur)
                cur = []
            cur.append(i)
        groups.append(cur)
        lens, wids = [], []
        for g in groups:
            if len(g) >= 10:
                lens.append(ys_s[g].max() - ys_s[g].min())
                wids.append(xs_s[g].max() - xs_s[g].min())
        if not lens:
            return None
        return {"n": len(lens),
                "len_px_med": float(np.median(lens)), "len_px_p90": float(np.percentile(lens, 90)),
                "wid_px_med": float(np.median(wids)),
                "aspect": round(float(np.median(lens)) / max(1.0, float(np.median(wids))), 2)}
    S["stick_left"] = stick_size(mL, 0.05, 0.35, 0.02, 0.28)
    S["stick_right"] = stick_size(mR, 0.05, 0.35, 0.72, 0.98)

    # ============ 5. 聚光灯锥 ============
    # 中心列亮度 + 锥体半宽（相对背景的增量）
    cone = []
    for yf in (0.03, 0.10, 0.18, 0.26, 0.34, 0.40, 0.44):
        y = int(yf * H)
        row = lum[y]
        bg = np.median(row)
        cols = np.where(row > bg + 18)[0]
        if len(cols) > 4:
            cone.append({"y": yf, "x0": round(cols.min() / W, 4), "x1": round(cols.max() / W, 4),
                         "cx": round(cols.mean() / W, 4), "half_w": round((cols.max() - cols.min()) / 2 / W, 4)})
        else:
            cone.append({"y": yf, "x0": None, "x1": None})
    S["spotlight_profile"] = cone
    # 台上亮池（table zone 内的亮度）
    if "table" in S:
        pool = lum[int(0.50 * H):int(0.62 * H), int(0.35 * W):int(0.65 * W)]
        S["table_pool_lum"] = round(float(pool.mean()), 1)

    # ============ 6. 地板与全局 ============
    S["floor"] = {
        "y_top_est": 0.86,
        "hex_center": hexof(a[int(0.97 * H), W // 2]),
        "hex_left": hexof(a[int(0.90 * H), int(0.06 * W)]),
        "hex_right": hexof(a[int(0.90 * H), int(0.94 * W)]),
    }
    S["background"] = {
        "hex_top_center": hexof(a[int(0.02 * H), W // 2]),
        "hex_top_left": hexof(a[int(0.02 * H), int(0.02 * W)]),
        "hex_top_right": hexof(a[int(0.02 * H), int(0.98 * W)]),
    }
    # 主色板（降采样 k-means）
    small = np.asarray(im.resize((192, 120))).astype(np.float64).reshape(-1, 3)
    rng = np.random.default_rng(7)
    cent = small[rng.choice(len(small), 10, replace=False)].copy()
    for _ in range(30):
        d = ((small[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
        lab = d.argmin(1)
        for j in range(10):
            mm = lab == j
            if mm.any():
                cent[j] = small[mm].mean(0)
    d = ((small[:, None, :] - cent[None, :, :]) ** 2).sum(-1)
    lab = d.argmin(1)
    pal = sorted(((int((lab == j).sum()), cent[j]) for j in range(10)), key=lambda t: -t[0])
    S["palette"] = [{"hex": hexof(c), "frac": round(n / len(small), 4)} for n, c in pal]

    txt = json.dumps(S, ensure_ascii=False, indent=2)
    print(txt)
    if args.out:
        with open(args.out, "w", encoding="utf-8") as f:
            f.write(txt + "\n")
        print("written:", args.out, file=sys.stderr)


if __name__ == "__main__":
    main()
