// Krystal Bot — 旁路块（subsession）：折叠的子树，展开后与主会话同观感
//
// 两条硬约束（设计教训，别踩）：
//  ① 自带嵌套 Transcript + 自己的流状态（liveText/liveThinking/curTool）。**绝不共用主会话那套** ——
//     那正是 2026-09-25 修掉的「共享槽位」bug 类：两条线共用可变状态 → 旧段改显新文字 + 重复打印。
//  ② 行宽严进严出：嵌套内容按 w - 7 渲染，再逐行加左框 │ → 绝不越过外框（越过会让合成器写出屏幕边界）。
import {
  Editor,
  Markdown,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
} from "../../deps/pi-tui/dist/index.js";
import { BOT_THEME, DOT_PEND, DOT_ROSE, StreamText, ToolBlock, Transcript } from "./bot-view.ts";
import { createTextSegment, type TextSegment } from "./stream-seg.ts";
import type { BotEvent } from "../bot.ts";
import type { SessionEvent } from "../session.ts";
import { BLUE_LIGHT, bold, dim, fg } from "../ui/ansi.ts";

/** 左框：展开态的"框"，与 `╰─` 分支同一条竖线（比画方框克制，嵌套时也不糊） */
const GUTTER = `     ${dim("│")} `;
const GUTTER_W = 7; // "     │ " 的可见宽度
const INDENT = "     ";

export type SubsessionStatus = "running" | "done" | "aborted" | "failed";

const STATUS_LABEL: Record<SubsessionStatus, string> = {
  running: "",
  done: "完成",
  aborted: "中断",
  failed: "失败",
};

const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));
const kfmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)));

/**
 * /divert 弹窗内容：标题 + 说明 + 内嵌编辑器（与主输入框同源的两条浅蓝线 + 蓝色方块光标）+ 键提示。
 * 抽成独立函数是为了能无头测试渲染（外框由 openOverlay 画 —— 内行越宽会把框撞破，宽度必须严进严出）。
 */
export function createDivertPrompt(
  tui: ConstructorParameters<typeof Editor>[0],
  opts: {
    theme: ConstructorParameters<typeof Editor>[1];
    onSubmit: (task: string) => void;
    onCancel: () => void;
  },
): Component & { handleInput(d: string): void; getTask(): string } {
  const input = new Editor(tui, opts.theme, { autocompleteMaxVisible: 4 });
  input.focused = true; // 必须真切聚焦：否则退化成反色软件光标块（粉/白高亮）
  input.onSubmit = (v: string) => {
    const task = (v ?? input.getText()).trim();
    if (!task) return;
    opts.onSubmit(task);
  };
  const blueBlock = "\x1b[48;5;45m\x1b[38;5;16m"; // 与主输入框同一颗蓝色方块光标
  return {
    render(w: number): string[] {
      const out: string[] = [
        bold(" 派发旁路会话"),
        dim(truncateToWidth(" 带主会话当前上下文出发（同模型 · 一次即止）· 结论留在块里，不进主上下文", w, "…")),
        "",
      ];
      for (const l of input.render(Math.max(24, w - 2))) out.push(" " + l.replace(/\x1b\[7m/g, blueBlock));
      out.push("");
      out.push(dim(truncateToWidth(" enter 派发 · shift+enter 换行 · esc 取消", w, "…")));
      return out;
    },
    handleInput(d: string): void {
      if (matchesKey(d, "escape")) {
        opts.onCancel();
        return;
      }
      input.handleInput(d);
    },
    invalidate: () => input.invalidate(),
    getTask: () => input.getText().trim(),
  };
}

export interface SubsessionOpts {
  id: string;
  task: string;
  /** 圆点闪烁相位（由 bot-view 的工作计时器驱动，与工具块同频） */
  blink?: () => boolean;
}

export class SubsessionBlock implements Component {
  /** 渲染版本号（Transcript 按它缓存；展开/状态变化时 +1） */
  rev = 0;
  expanded = false;
  readonly id: string;
  readonly task: string;

  private status: SubsessionStatus = "running";
  private readonly nested = new Transcript();
  private readonly blink: () => boolean;

  // ── 本块自己的流状态（与主会话隔离）
  private liveText: TextSegment | undefined;
  private liveThinking: StreamText | undefined;
  private kind: "thinking" | "text" | null = null;
  private curTool: ToolBlock | undefined;
  private readonly toolById = new Map<string, ToolBlock>();

  private tools = 0;
  private tokens = 0; // 估算（无 usable usage 时的兜底）
  private usagePrompt = 0; // 真实上下文占用（provider 上报）——与主会话状态行同口径：真值优先
  private activity = "连接中";
  private answer = "";

  constructor(o: SubsessionOpts) {
    this.id = o.id;
    this.task = o.task;
    this.blink = o.blink ?? (() => false);
  }

  /** 运行中逐帧重渲（圆点闪烁 + 活状态）；定稿后转缓存 */
  get volatile(): boolean {
    return this.status === "running";
  }

  // ── 自己的段管理（与 bot-view 的 begin/close 同型，但只作用在自己的 nested 上）
  private closeStream(): void {
    this.liveText?.seal();
    this.liveThinking = undefined;
    this.liveText = undefined;
    this.kind = null;
  }
  /** 段间留白（与主会话同节奏） */
  private gap(): void {
    const last = this.nested.items[this.nested.items.length - 1];
    if (this.nested.items.length > 0 && last !== "") this.nested.items.push("");
  }
  private beginText(): void {
    if (this.kind) this.closeStream();
    this.gap();
    this.liveText = createTextSegment(BOT_THEME);
    this.nested.items.push(this.liveText.comp);
    this.kind = "text";
  }
  private beginThinking(): void {
    if (this.kind) this.closeStream();
    this.gap();
    this.liveThinking = new StreamText("· thinking ", (t) => dim(t));
    this.nested.items.push(this.liveThinking);
    this.kind = "thinking";
  }
  private streamTo(delta: string): void {
    if (this.kind === "thinking") this.liveThinking?.append(delta);
    else this.liveText?.append(delta);
  }

  /** 直播：runBotTask 的事件进来（与主会话同型，但写进本块的嵌套区） */
  feedLive(e: BotEvent): void {
    switch (e.type) {
      case "thinking":
        this.activity = "思考中";
        if (this.kind !== "thinking") this.beginThinking();
        this.tokens += e.delta.length / 4;
        this.streamTo(e.delta);
        break;
      case "text":
        this.activity = "回答中";
        if (this.kind !== "text") this.beginText();
        this.tokens += e.delta.length / 4;
        this.streamTo(e.delta);
        break;
      case "tool_args":
        this.activity = `调用 ${e.name}`;
        if (!this.curTool) {
          this.closeStream();
          this.gap();
          this.curTool = new ToolBlock(e.name, e.argsSoFar);
          this.tools++;
          this.nested.items.push(this.curTool);
        } else this.curTool.args = e.argsSoFar;
        this.tokens += e.argsSoFar.length / 40;
        break;
      case "tool_start":
        this.activity = `调用 ${e.name}`;
        if (!this.curTool) {
          this.closeStream();
          this.gap();
          this.curTool = new ToolBlock(e.name, e.args);
          this.tools++;
          this.nested.items.push(this.curTool);
          this.toolById.set(e.id, this.curTool);
        } else {
          this.curTool.args = e.args;
          this.toolById.set(e.id, this.curTool);
        }
        break;
      case "tool_result":
        this.curTool?.setResult(e.ok, e.denied, e.output);
        this.curTool = undefined;
        break;
      case "usage":
        this.usagePrompt = e.prompt; // 真值优先；估算不再叠加（否则直播与重播数字不一致）
        break;
      case "retry":
        this.nested.items.push(dim(`  ⟳ ${e.reason} —— ${Math.round(e.waitMs / 1000)} 秒后重试（第 ${e.attempt + 1}/${e.max} 次）`));
        break;
      case "final": {
        // 空 final ≠ 没内容（先答后记）：保留已流式的回答 —— 与 bot-view 同规则
        let seg = this.liveText;
        if (!seg && e.text.trim()) {
          this.beginText();
          seg = this.liveText;
        }
        seg?.finish(e.text);
        this.closeStream();
        this.answer = (e.text.trim() || this.answer).trim();
        this.activity = "完成";
        this.status = "done";
        this.rev++;
        break;
      }
      case "error":
        this.closeStream();
        this.nested.items.push(fg(DOT_ROSE, ` ✗ ${e.message}`));
        this.activity = e.message.includes("已中断") ? "中断" : "失败";
        this.status = e.message.includes("已中断") ? "aborted" : "failed";
        this.rev++;
        break;
      default:
        break; // context/summary 等：旁路块保持安静（状态行已足够）
    }
    this.rev++;
  }

  /** 重播：磁盘上的事件流 → 同一棵嵌套区（与 bot-view.rebuild 同规则） */
  loadFrom(events: SessionEvent[]): void {
    for (const e of events) {
      if (e.t === "usage") {
        this.usagePrompt = e.prompt;
        continue;
      }
      if (e.t !== "msg" || e.role === "user") continue; // 任务本身在标题里，不重复渲染
      if (e.role === "assistant") {
        if (e.thinking) {
          const tb = new StreamText("· thinking ", (t) => dim(t));
          tb.append(e.thinking);
          this.nested.items.push(tb);
        }
        // 顺序与直播一致：先说（中段答复）再调工具 —— 反了会导致“重播与当时看到的不一样”
        if (e.content.trim()) {
          this.answer = e.content.trim();
          this.gap();
          this.nested.items.push(new Markdown(e.content.trim(), 1, 0, BOT_THEME));
        }
        if (e.toolCalls?.length) {
          for (const tc of e.toolCalls) {
            const b = new ToolBlock(tc.name, tc.args);
            this.toolById.set(tc.id, b);
            this.tools++;
            this.gap();
            this.nested.items.push(b);
          }
        }
      } else if (e.role === "tool") {
        const b = e.toolCallId ? this.toolById.get(e.toolCallId) : undefined;
        const denied = e.content.startsWith("[策略闸门拒绝]");
        b?.setResult(!denied, denied, e.content.replace(/^\[策略闸门拒绝\] /, ""));
      }
    }
    this.rev++;
  }

  /** 从落盘状态恢复：进程被杀时遗留的 running 由调用方判为 aborted（推断，不猜内容） */
  setStatus(s: SubsessionStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.activity = STATUS_LABEL[s] || this.activity;
    this.rev++;
  }

  get isRunning(): boolean {
    return this.status === "running";
  }

  toggle(): void {
    this.expanded = !this.expanded;
    this.rev++;
  }

  /** 折叠态预览：结论首行（结论还没出来时给活状态） */
  private preview(): string {
    if (this.answer) return this.answer.split("\n").map((l) => l.trim()).find((l) => l) ?? "";
    return "";
  }

  private header(w: number): string {
    const dot =
      this.status === "running"
        ? this.blink()
          ? dim("○")
          : fg(DOT_PEND, "●")
        : this.status === "done"
          ? fg(BLUE_LIGHT, "●")
          : fg(DOT_ROSE, "●");
    const hint = this.nested.items.length ? dim(this.expanded ? "▾ ctrl+o" : "▸ ctrl+o") : "";
    const left = `  ${dim("╰─")} ${dot} ${bold("subsession")} ${dim(this.task)}`;
    // 右对齐折叠提示（宽度不够就丢掉提示，绝不让标题溢出）
    const room = w - visibleWidth(left) - visibleWidth(hint) - 1;
    if (!hint || room < 4) return truncateToWidth(left, w, "");
    return truncateToWidth(left + " ".repeat(room), w, "") + hint;
  }

  private statusLine(): string {
    const bits = [`${this.tools} 工具`];
    if (this.usagePrompt > 0) bits.push(`${kfmt(this.usagePrompt)} tok`);
    else if (this.tokens > 0) bits.push(`~${kfmt(this.tokens)} tok`);
    const label = STATUS_LABEL[this.status];
    if (label) bits.push(label);
    else bits.push(this.activity);
    return `     ${dim(bits.join(" · "))}`;
  }

  render(w: number): string[] {
    const out: string[] = [this.header(w)];
    if (this.expanded) {
      const body = this.nested.render(Math.max(8, w - GUTTER_W));
      for (const l of body) out.push(GUTTER + l);
      out.push(this.statusLine());
    } else {
      const p = this.preview();
      if (p) out.push(INDENT + dim(truncateToWidth(p, Math.max(8, w - INDENT.length), "…")));
      else if (this.status === "running") out.push(INDENT + dim(`${this.activity}${this.tools > 0 ? ` · ${this.tools} 工具` : ""}`));
      // 无结论但已终结（被中断 / 失败 / 空回答）：必须把状态词摆出来，不能让它看起来像“跑完了”
      else out.push(INDENT + dim(`${STATUS_LABEL[this.status]}${this.tools > 0 ? ` · ${this.tools} 工具` : ""}`));
    }
    return out.map((l) => truncateToWidth(l, w, ""));
  }

  invalidate(): void {
    this.nested.invalidate();
  }
}