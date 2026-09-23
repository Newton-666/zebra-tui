#!/usr/bin/env python3
"""把图片转成 Braille 点阵字符画（学 hermes 的画法：1 字符 = 2×4 点）。

用法： python3 scripts/rose-to-braille.py Rose.png --cols 72 [--gamma 2.6] [--bg 0.135]
输出： 直接把各行打印到 stdout（可粘贴进 src/ui/portrait.ts，或重定向到文件）
原理： 块均值降采样（去噪）→ 背景减法（亮底归零）→ 对比拉伸 → Floyd–Steinberg 抖动
        → 逐 2×4 点块合成 Braille 码位（U+2800 + 位掩码）→ 裁剪全空行列
"""
import argparse, sys
from PIL import Image
import numpy as np

BIT = {(0, 0): 1, (0, 1): 2, (0, 2): 4, (1, 0): 8, (1, 1): 16, (1, 2): 32, (0, 3): 64, (1, 3): 128}


def braille(ink, cols, rows):
    gw, gh = cols * 2, rows * 4
    g = np.asarray(Image.fromarray((ink * 255).astype(np.uint8)).resize((gw, gh), Image.BOX)).astype(float) / 255
    w = g.copy()
    for y in range(gh):                       # Floyd–Steinberg：用点密度表达灰度
        for x in range(gw):
            old = w[y, x]; new = 1.0 if old > 0.5 else 0.0; w[y, x] = new; e = old - new
            if x + 1 < gw: w[y, x + 1] += e * 7 / 16
            if y + 1 < gh:
                if x > 0: w[y + 1, x - 1] += e * 3 / 16
                w[y + 1, x] += e * 5 / 16
                if x + 1 < gw: w[y + 1, x + 1] += e * 1 / 16
    d = w > 0.5
    out = []
    for cy in range(rows):
        out.append("".join(chr(0x2800 + sum(BIT[(dx, dy)] for dx in (0, 1) for dy in range(4) if d[cy * 4 + dy, cx * 2 + dx])) for cx in range(cols)))
    return trim([r for r in out if r.strip("\u2800 ")])


def trim(rows):
    if not rows: return rows
    n = max(len(r) for r in rows)
    rows = [r.ljust(n) for r in rows]
    keep = [x for x in range(n) if any(r[x] not in "\u2800 " for r in rows)]
    return [r[keep[0]:keep[-1] + 1] for r in rows]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("--cols", type=int, default=72)
    ap.add_argument("--rows", type=int, default=0, help="0 = 按原图长宽比自动（终端字符高约宽两倍）")
    ap.add_argument("--bg", type=float, default=0.135, help="背景墨迹水平（亮底图 ≈ 0.13）")
    ap.add_argument("--gamma", type=float, default=2.6, help="对比提升系数")
    a = ap.parse_args()
    gray = np.asarray(Image.open(a.image).convert("L")).astype(float)
    ink = np.clip((1.0 - gray / 255.0 - a.bg) / (1 - a.bg), 0, 1)
    ink = np.clip(ink * a.gamma, 0, 1)
    ys, xs = np.where(ink > 0.25)              # 紧裁到主体
    ink = ink[ys.min():ys.max() + 1, xs.min():xs.max() + 1]
    rows = a.rows or max(6, int(a.cols * ink.shape[0] / ink.shape[1] / 2))
    print("\n".join(braille(ink, a.cols, rows)))


if __name__ == "__main__":
    main()
