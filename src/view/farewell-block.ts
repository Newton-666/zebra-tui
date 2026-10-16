// Krystal — 告别放映块（/farewell 的渲染）。设计：docs/memory-farewell.md §5。
//
// 三条硬要求（都在这里落地）：
//  ① **一个字一个字吐出**（不是按行、也不是项目符号逐条弹）；散文来自模型流式增量 → 吐出队列
//  ② **折叠 = 情绪，展开 = 审计**：折叠态只有散文与「我熄灯了。」；路径/统计/时间线全在 ctrl+o
//  ③ 节拍**可注入**（`advance(ms)` 由外部时钟驱动）→ 能用假时钟离线测帧序，不必真等 40 秒
import { truncateToWidth, visibleWidth, wrapTextWithAnsi, type Component } from "../../deps/pi-tui/dist/index.js";
import { bold, dim, fg } from "../ui/ansi.ts";
import { timelineLines, type LifeScale, type Timeline } from "../farewell.ts";

/** 仪式调色板与节拍（票 §5.2/§5.5）。颜色从平台既有语义里挑空缺：蓝=干活、红玫=报错、绿=记忆新增、黄=警告 */
export const FAREWELL = {
  base: "38;5;97", // 暮紫（推荐候选 A）
  bright: "38;5;183",
  lead: "38;5;140",
  body: "38;5;252",
  frameMs: 250, // 扫光帧（working 是 150 —— 仪式放慢）
  leadMs: 700, // 引子后停顿
  charMs: Number(process.env.KRYSTAL_FAREWELL_CHAR_MS ?? 90), // 每字（≈11 字/秒）
  silenceMs: 1800, // 散文吐完 → 最后一句话之间的**静默**
  footerMs: 900, // 落最后一句话 → 定格
  rebirthMs: 2500, // 定格 → 自动重生前的停留（让人读完）
  maxMs: Number(process.env.KRYSTAL_FAREWELL_MAX_MS ?? 45_000), // 总时长上限（只有会超才提速）
  lastWords: "我熄灯了。",
  lead2: "你还记得吗——",
} as const;

export interface FarewellBlockOpts {
  timeline: Timeline;
  scale: LifeScale;
  /** 落盘后的路径（定格时才显示；只在展开态） */
  eulogyFile?: string;
}
type Phase = "sweep" | "waiting" | "typing" | "silence" | "last" | "frozen";

export class FarewellBlock implements Component {
  /** 渲染版本号（Transcript 按它缓存） */
  rev = 0;
  expanded = false;
  readonly timeline: Timeline;
  readonly scale: LifeScale;
  eulogyFile?: string;

  private prose = "";
  private revealed = 0;
  private acc = 0; // 累积毫秒
  private phase: Phase = "sweep";
  private sweepTick = 0;
  private seenSweep = 0;

  constructor(o: FarewellBlockOpts) {
    this.timeline = o.timeline;
    this.scale = o.scale;
    this.eulogyFile = o.eulogyFile;
  }

  // ── 数据入口
  /** 散文增量（流式到达）→ 进吐出队列 */
  setProse(text: string): void {
    this.prose = text;
    this.rev++;
  }
  /** 定格（可带权威全文，校准流式尾部差异） */
  freeze(full?: string): void {
    if (full && full.trim()) this.prose = full.trim();
    this.revealed = [...this.prose].length;
    this.phase = "frozen";
    this.rev++;
  }
  /**
   * 任意键：立刻吐完并定格。
   * ⚠ 散文**还没到**（模型仍在写）时**不允许**跳过 —— 否则会冻结成空的，
   * 界面上只有 header 与「我熄灯了。」、看不到告别段落（2026-10-16 实测踩到）。
   */
  skip(): boolean {
    if (!this.prose.trim()) return false;
    this.freeze();
    return true;
  }
  /** 正在等模型写完散文（用于状态提示） */
  get waitingForProse(): boolean {
    return !this.prose.trim() && this.phase !== "frozen";
  }
  get frozen(): boolean {
    return this.phase === "frozen";
  }
  /** 未定格 = 活块（逐帧重渲：扫光在动） */
  get volatile(): boolean {
    return this.phase !== "frozen";
  }
  get revealedChars(): number {
    return this.revealed;
  }
  /** 定稿全文（落盘 eulogy.md 用） */
  get proseText(): string {
    return this.prose;
  }
  toggle(): void {
    this.expanded = !this.expanded;
    this.rev++;
  }

  /**
   * 按毫秒推进（**外部时钟驱动**：生产用 50ms 定时器，测试直接喂假时钟）。
   * 顺序：扫光一个周期 → 引子（等散文）→ 逐字吐出 → 静默 → 最后一句话 → 定格。
   */
  advance(ms: number): void {
    if (this.phase === "frozen") return;
    this.acc += ms;
    this.rev++;
    const total = () => [...this.prose].length;
    // 一个循环把余量一路消耗下去：**相位切换不丢时间**（否则一次大跳跃会卡在中间相位）
    for (let guard = 0; guard < 10_000 && this.phase !== "frozen"; guard++) {
      if (this.phase === "sweep") {
        while (this.acc >= FAREWELL.frameMs && this.seenSweep < 4) {
          this.acc -= FAREWELL.frameMs;
          this.sweepTick++;
          this.seenSweep++;
        }
        if (this.seenSweep < 4) return; // 还没扫完一个周期
        this.phase = "waiting";
        this.acc = Math.min(this.acc, FAREWELL.leadMs); // 压住等待期累积，避免模型一到就暴吐
      } else if (this.phase === "waiting") {
        if (total() === 0) return; // 散文还没到：继续等（真流式下就是“模型还在写”）
        if (this.acc < FAREWELL.leadMs) return;
        this.acc = Math.min(this.acc, FAREWELL.leadMs);
        this.phase = "typing";
      } else if (this.phase === "typing") {
        while (this.acc >= FAREWELL.charMs && this.revealed < total()) {
          // 队列滞后保护：**只有“预计会超过总时长上限”时才提速**（慢是默认）
          const remain = (total() - this.revealed) * FAREWELL.charMs;
          const step = remain > FAREWELL.maxMs ? Math.ceil(remain / FAREWELL.maxMs) : 1;
          this.revealed = Math.min(total(), this.revealed + step);
          this.acc -= FAREWELL.charMs;
        }
        if (this.revealed < total()) return;
        this.phase = "silence";
      } else if (this.phase === "silence") {
        if (this.acc < FAREWELL.silenceMs) return;
        this.acc -= FAREWELL.silenceMs;
        this.phase = "last";
      } else if (this.phase === "last") {
        if (this.acc < FAREWELL.footerMs) return;
        this.acc -= FAREWELL.footerMs;
        this.phase = "frozen";
      }
    }
  }

  // ── 渲染
  private head(w: number): string {
    const dot = this.phase === "frozen" ? fg(FAREWELL.base, "●") : Math.floor(this.sweepTick / 4) % 2 === 0 ? fg(FAREWELL.bright, "●") : dim("○");
    const word =
      this.phase === "frozen"
        ? bold(fg(FAREWELL.base, "farewell")) // 定格保留仪式色（不得回默认白）
        : [..."farewell"]
            .map((ch, i) => {
              const period = Math.max(8 + 6, 10);
              const d = (i - (this.sweepTick % period) + period) % period;
              return `\x1b[${d < 3 ? FAREWELL.bright : FAREWELL.base}m${ch}\x1b[0m`;
            })
            .join("");
    const left = `  ${dim("╰─")} ${dot} ${word}`;
    const tag = dim(this.expanded ? "▾ ctrl+o" : "▸ ctrl+o");
    const room = w - visibleWidth(left) - visibleWidth(tag) - 1;
    return room >= 4 ? left + " ".repeat(room) + tag : left;
  }

  /** 长路径从**左侧**截断（保留尾部：真正有用的是 .../bot-<id>/eulogy.md） */
  private fitTail(s: string, w: number): string {
    const plain = s.replace(/\x1b\[[0-9;]*m/g, "");
    if (visibleWidth(s) <= w) return s;
    const keep = Math.max(4, w - 1);
    return "…" + [...plain].slice(-keep).join("");
  }

  private pad(s: string, n: number): string {
    return s + " ".repeat(Math.max(0, n - visibleWidth(s)));
  }

  render(w: number): string[] {
    const out: string[] = [this.head(w)];
    const gutter = `     ${dim("│")}  `;
    if (this.phase !== "sweep") out.push(`     ${dim("│")}  ${fg(FAREWELL.lead, FAREWELL.lead2)}`);

    // 等模型写完时给个可见提示（否则用户按键无反应、以为坏了）
    if (this.waitingForProse && this.phase !== "sweep") out.push(`     ${dim("│")}  ${dim("（正在写……）")}`);

    // 散文（按已吐出的字数裁切；按宽度折行）
    const shown = [...this.prose].slice(0, this.revealed).join("");
    for (const para of shown.split("\n")) {
      if (!para) continue;
      for (const l of wrapTextWithAnsi(para, Math.max(8, w - 8))) out.push(gutter + fg(FAREWELL.body, l));
    }

    // 静默之后：最后一句话（仪式色，单独落下来）
    if (this.phase === "last" || this.phase === "frozen") {
      out.push(`     ${dim("│")}`);
      out.push(`     ${fg(FAREWELL.base, `·  ${FAREWELL.lastWords}`)}`);
    }

    // 展开 = 审计（路径 / 统计 / 时间线）
    if (this.expanded) {
      out.push(`     ${dim("│")}`);
      out.push(`     ${dim("│")}  ${fg(FAREWELL.lead, "本世时间线")}  ${dim(`（${this.timeline.stats}）`)}`);
      if (this.eulogyFile) {
        const line = `遗嘱全文 → ${this.eulogyFile}`;
        out.push(`     ${dim("│")}  ${dim(this.fitTail(line, Math.max(20, w - 8)))}`);
      }
      const rows = timelineLines(this.timeline);
      const wAt = Math.max(5, ...rows.map((r) => visibleWidth(r.at)));
      const wWho = Math.min(14, Math.max(6, ...rows.map((r) => visibleWidth(r.who))));
      for (const r of rows.slice(0, 40)) {
        const mark = r.at === "⚠" ? fg("38;5;218", r.at) : dim(this.pad(r.at, wAt));
        out.push(`     ${dim("│")}  ${mark}  ${fg(FAREWELL.body, this.pad(r.who, wWho))} ${dim(r.text)}`);
      }
      if (rows.length > 40) out.push(`     ${dim("│")}  ${dim(`… +${rows.length - 40} 条（全文在遗嘱里）`)}`);
    }
    return out.map((l) => truncateToWidth(l, w, ""));
  }

  invalidate(): void {}
}