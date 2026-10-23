"""参考图处理：直接用参考图当赛场画面，只去掉水印 + 擦掉需要"活"的元素。

用户要求："就用参考图，去掉水印即可"。

参考图里已经画好整套赛场（球台 / 球网 / 光海 / 聚光灯锥 / 地板 / 看台），
但同时**烘死**了几样必须实时变化的东西：两名球员与球拍、球、比分条 / 判定面板 /
操作提示 / "发球 6s"、判定虚线框。

产出：
  1) docs/ref_arena_nowatermark.jpg —— 整张参考图，只去水印
  2) public/assets/arena/arena_plate.jpg —— 去水印 + 擦掉那些"活"元素，
     球台/球网/光海/光锥/地板/看台原样保留

填充分两种，各管各的区域（混用就会糊）：
  · 球台**内部**：台面沿行几乎恒定 ⇒ 用**同行台面像素的中位数**填，
    干净且不破坏纵向渐变。用通用扩散会把台面糊成"人影"。
  · 球台**外部**（球员上半身、台前地板、顶部 HUD）：push-pull 金字塔加权插值。

用法：python tools/make-arena-plate.py
"""
from __future__ import annotations
import os
import sys
import numpy as np
from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, "docs", "ref_arena_target_20261022.jpg")


def dilate(mask: np.ndarray, r: int) -> np.ndarray:
    if r <= 0:
        return mask
    m = Image.fromarray((mask * 255).astype(np.uint8)).filter(ImageFilter.MaxFilter(2 * r + 1))
    return np.asarray(m) > 127


def _down_sum(a: np.ndarray) -> np.ndarray:
    h, w = a.shape[:2]
    h2, w2 = h // 2 * 2, w // 2 * 2
    a = a[:h2, :w2]
    if a.ndim == 2:
        return a.reshape(h2 // 2, 2, w2 // 2, 2).sum(axis=(1, 3))
    c = a.shape[2]
    return a.reshape(h2 // 2, 2, w2 // 2, 2, c).sum(axis=(1, 3))


def _up(a: np.ndarray, w: int, h: int) -> np.ndarray:
    if a.ndim == 2:
        return np.asarray(Image.fromarray(a.astype(np.float32), mode="F")
                          .resize((w, h), Image.BILINEAR), dtype=np.float64)
    out = np.zeros((h, w, a.shape[2]), np.float64)
    for i in range(a.shape[2]):
        out[:, :, i] = np.asarray(Image.fromarray(a[:, :, i].astype(np.float32), mode="F")
                                  .resize((w, h), Image.BILINEAR), dtype=np.float64)
    return out


def push_pull(img: np.ndarray, mask: np.ndarray) -> np.ndarray:
    cov = (~mask).astype(np.float64)
    cs, ws = [img * cov[:, :, None]], [cov.copy()]
    while min(ws[-1].shape) > 2:
        cs.append(_down_sum(cs[-1]))
        ws.append(_down_sum(ws[-1]))
    for i in range(len(cs)):
        wn = np.clip(ws[i] / 4.0, 0.0, 1.0)
        cs[i] = np.where(ws[i][:, :, None] > 1e-9,
                         cs[i] / np.maximum(ws[i], 1e-9)[:, :, None], 0.0)
        ws[i] = wn
    for i in range(len(cs) - 2, -1, -1):
        hh, ww = ws[i].shape
        coarse = _up(cs[i + 1], ww, hh)
        a = np.clip(ws[i], 0.0, 1.0)[:, :, None]
        cs[i] = cs[i] * a + coarse * (1.0 - a)
    return np.clip(np.where(mask[:, :, None], cs[0], img), 0, 255)


def row_fill(img: np.ndarray, mask: np.ndarray, region: np.ndarray):
    """mask∩region 的像素换成"同一行 region 内已知像素的中位数"。"""
    out = img.copy()
    H, W, _ = out.shape
    filled = 0
    for y in range(H):
        todo = mask[y] & region[y]
        if not todo.any():
            continue
        src = region[y] & (~mask[y])
        idx = np.nonzero(src)[0]
        if idx.size < 6:
            continue
        med = np.median(out[y, idx], axis=0)
        out[y, todo] = med
        filled += int(todo.sum())
    return out, filled


def main() -> int:
    img = np.asarray(Image.open(SRC).convert("RGB")).astype(np.float64)
    H, W, _ = img.shape
    r, g, b = img[:, :, 0], img[:, :, 1], img[:, :, 2]
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    mx = img.max(axis=2)
    mn = img.min(axis=2)
    sat = (mx - mn) / (mx + 1e-6)

    # ================= 1) 只去水印 =================
    wm = np.zeros((H, W), bool)
    x0, x1 = int(W * 0.900), int(W * 0.995)
    y0, y1 = int(H * 0.905), int(H * 0.982)
    wm[y0:y1, x0:x1] = (lum[y0:y1, x0:x1] > 80) & (sat[y0:y1, x0:x1] < 0.60)
    wm = dilate(wm, 6)
    clean = push_pull(img, wm)
    sm = np.asarray(Image.fromarray(np.clip(clean, 0, 255).astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(1.0))).astype(np.float64)
    clean = np.where(wm[:, :, None], sm, clean)
    Image.fromarray(np.clip(clean, 0, 255).astype(np.uint8)).save(
        os.path.join(ROOT, "docs", "ref_arena_nowatermark.jpg"), quality=95)
    print("已保存 docs/ref_arena_nowatermark.jpg（只去水印）")

    # ================= 2) 底板 =================
    # 台面（青蓝 rgb(44,141,218) 一带）：既当"区域"也当"取色源"
    table = (b > 150) & (b > r + 60) & (g > 95) & (lum > 70)
    table = dilate(table, 2)
    keep = np.zeros((H, W), bool)
    keep[int(H * 0.53):int(H * 0.94), int(W * 0.36):int(W * 0.63)] = True
    table &= keep
    row_region = np.zeros((H, W), bool)
    for y in range(H):
        idx = np.nonzero(table[y])[0]
        if idx.size >= 6:
            row_region[y, idx.min():idx.max() + 1] = True

    # 球员轮廓判据（实测采样后定）：
    #   · 身体是深藏青 rgb(31,54,95)；台面是亮青 rgb(44,141,218)；地板是暖棕 rgb(62,44,34)
    #   · 除了深色身体，还要把抗锯齿边缘与人物在地板上的淡影一起圈进来：
    #     它们亮度落在 95~132，只按 <95 切会留下一圈人影轮廓。
    #   · 用「明显比同区域台面暗 且 不是台面青蓝」兜住这些过渡带。
    is_table_cyan = (b > 165) & (b > r + 70) & (g > 105)
    person = ((lum < 95) & (b < 150) & (g < 130)) | ((lum < 132) & (~is_table_cyan))
    red_paddle = (r > 110) & (r > b + 30)
    white_line = (lum > 165) & (np.abs(b - r) < 60)
    sil = person | red_paddle | white_line

    mask = np.zeros((H, W), bool)

    for (yy0, yy1, xx0, xx1) in (
        (int(H * 0.485), int(H * 0.672), int(W * 0.438), int(W * 0.582)),
        (int(H * 0.688), int(H * 1.000), int(W * 0.358), int(W * 0.662)),
    ):
        box = np.zeros((H, W), bool)
        box[yy0:yy1, xx0:xx1] = True
        mask |= box & sil

    ball_box = np.zeros((H, W), bool)
    ball_box[int(H * 0.586):int(H * 0.636), int(W * 0.544):int(W * 0.596)] = True
    mask |= ball_box & (lum > 140) & (sat < 0.50)

    hud = np.zeros((H, W), bool)
    for (yy0, yy1, xx0, xx1) in (
        (int(H * 0.015), int(H * 0.180), int(W * 0.015), int(W * 0.222)),
        (int(H * 0.035), int(H * 0.115), int(W * 0.295), int(W * 0.705)),
        (int(H * 0.108), int(H * 0.165), int(W * 0.305), int(W * 0.685)),
        (int(H * 0.035), int(H * 0.125), int(W * 0.748), int(W * 0.905)),
        (int(H * 0.035), int(H * 0.105), int(W * 0.890), int(W * 0.990)),
        (int(H * 0.038), int(H * 0.100), int(W * 0.755), int(W * 0.805)),
    ):
        hud[yy0:yy1, xx0:xx1] = True
    mask |= hud

    sv = np.zeros((H, W), bool)
    sv[int(H * 0.238):int(H * 0.328), int(W * 0.400):int(W * 0.600)] = True
    mask |= sv & (lum > 38)

    mask = dilate(mask, 7)
    print("掩膜:", int(mask.sum()), "像素，占比", round(mask.mean() * 100, 2), "%")

    # 台外：push-pull
    plate = push_pull(clean, mask)
    sm = np.asarray(Image.fromarray(np.clip(plate, 0, 255).astype(np.uint8))
                    .filter(ImageFilter.GaussianBlur(1.3))).astype(np.float64)
    plate = np.where(mask[:, :, None], sm, plate)

    # 台内：同行台面中位数
    plate, n_fill = row_fill(plate, mask, row_region)
    print("台内按行补:", n_fill, "像素")

    tm = mask & row_region
    if tm.any():
        sm2 = np.asarray(Image.fromarray(np.clip(plate, 0, 255).astype(np.uint8))
                         .filter(ImageFilter.GaussianBlur(2.0))).astype(np.float64)
        plate = np.where(tm[:, :, None], sm2, plate)

    pim = Image.fromarray(np.clip(plate, 0, 255).astype(np.uint8))
    arr = np.asarray(pim).astype(np.float64)
    rng = np.random.default_rng(20261023)
    arr = np.clip(arr + rng.normal(0, 1.1, (H, W, 1)), 0, 255).astype(np.uint8)
    pim = Image.fromarray(arr)

    dst = os.path.join(ROOT, "public", "assets", "arena")
    os.makedirs(dst, exist_ok=True)
    pim.save(os.path.join(dst, "arena_plate.jpg"), quality=93, optimize=True)
    pim.save(os.path.join(ROOT, "docs", "arena_plate_preview.png"))
    print("已保存 public/assets/arena/arena_plate.jpg", pim.size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
