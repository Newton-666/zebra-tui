#!/usr/bin/env python3
# Krystal — 记忆评估仪表盘渲染器（matplotlib）
# 只负责画：读 memory-eval.ts 产出的 metrics.json + .eval-history.json → 出一张 PNG
# 无字库依赖：纯几何渲染（条形/折线/点），中文标题降级为拼音占位（图例用英文短标签）
import json
import os
import sys
from datetime import datetime

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

metrics_path, hist_path, out_dir = sys.argv[1], sys.argv[2], sys.argv[3]
with open(metrics_path, "r", encoding="utf-8") as f:
    m = json.load(f)
hist = []
if os.path.exists(hist_path):
    with open(hist_path, "r", encoding="utf-8") as f:
        hist = json.load(f)

retention = m["retention"]
freshness = m["freshness"]
sleep_surv = m["sleepSurvival"]
worst = min(retention, freshness, sleep_surv)

fig = plt.figure(figsize=(11, 6.5), dpi=150, facecolor="white")
gs = fig.add_gridspec(2, 2, height_ratios=[2, 1.1], hspace=0.55, wspace=0.25)

# ── 面板 1：三指标横向条形（60%→100% 映射，一眼看健康度）
ax1 = fig.add_subplot(gs[0, 0])
labels = ["retention", "freshness", "sleep-surv"]
vals = [retention, freshness, sleep_surv]
colors = ["#2e7d32" if v >= 0.8 else ("#f9a825" if v >= 0.6 else "#c62828") for v in vals]
y = range(len(labels))
ax1.barh(y, [max(0.0, (v - 0.6) / 0.4) for v in vals], color=colors, height=0.55)
for i, v in enumerate(vals):
    ax1.text(max(0.01, (v - 0.6) / 0.4) + 0.02, i, f"{v*100:.0f}%", va="center", fontsize=11, fontweight="bold")
ax1.set_yticks(list(y))
ax1.set_yticklabels(labels, fontsize=11)
ax1.set_xlim(0, 1.15)
ax1.set_title("Panel scores (axis: 60% - 100%)", fontsize=10, color="#555555")
ax1.axvline(0.5, color="#999999", linewidth=0.8, linestyle="--")  # =80% 健康线
ax1.spines[["top", "right"]].set_visible(False)

# ── 面板 2：睡眠衰减验证（理论半衰曲线 vs 实测探针 trust）
ax2 = fig.add_subplot(gs[0, 1])
days = list(range(0, 61))
theo = [0.6 * (0.5 ** (d / 30)) for d in days]
ax2.plot(days, theo, color="#1565c0", linewidth=2, label="theoretical decay")
ax2.axhline(0.1, color="#888888", linewidth=0.8, linestyle=":", label="trust floor")
ax2.scatter([20] * 4, [m["meanDecay"]] * 4, color="#c62828", s=28, zorder=3, label="measured probes (d=20)")
ax2.set_xlabel("days idle", fontsize=9)
ax2.set_ylabel("trust", fontsize=9)
ax2.set_ylim(0, 0.7)
ax2.set_title(f"sleep decay check (fresh control={m['freshTrust']:.2f})", fontsize=10, color="#555555")
ax2.legend(fontsize=8, loc="upper right")
ax2.spines[["top", "right"]].set_visible(False)

# ── 面板 3：留存率历史曲线（周巡检趋势）
ax3 = fig.add_subplot(gs[1, :])
if len(hist) >= 2:
    dates = [h["date"][:10] for h in hist]
    rs = [h["retention"] * 100 for h in hist]
    ax3.plot(dates, rs, color="#c62828", marker="o", linewidth=2)
    for x, v in zip(dates, rs):
        ax3.annotate(f"{v:.0f}%", (x, v), textcoords="offset points", xytext=(0, 7), ha="center", fontsize=8)
    ax3.set_ylim(max(0, min(rs) - 10), 100)
    ax3.set_ylabel("retention %", fontsize=9)
    ax3.set_title("retention trend (weekly patrol)", fontsize=10, color="#555555")
else:
    ax3.text(0.5, 0.5, "history < 2 points - trend line appears next run", ha="center", va="center", transform=ax3.transAxes, fontsize=10, color="#666666")
    ax3.set_title("retention trend", fontsize=10, color="#555555")
ax3.spines[["top", "right"]].set_visible(False)

fig.suptitle(f"Krystal Memory Eval Dashboard  -  {m['date'][:10]}  -  worst panel {worst*100:.0f}%", fontsize=13, fontweight="bold")
fig.text(0.99, 0.01, f"snapshot {m['snapCount']} events / tested n={m['testedA']}", ha="right", fontsize=7, color="#aaaaaa")
today = m["date"][:10]
fig.savefig(os.path.join(out_dir, f"memory-eval-{today}.png"), bbox_inches="tight")
print(f"chart -> scripts/eval-out/memory-eval-{today}.png")
