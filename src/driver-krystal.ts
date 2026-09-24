// Krystal — 原生成员驱动（spec §4 MemberDriver 的进程内实现）
// send = runTurn（runBotTask）；poll = onEvent 直接产出结构化事件；screen = 原生组件（零抓屏）。
// 与独立 Krystal Bot（runBotFlow）共享同一 loop/工具/闸门/记忆，仅入口不同（§12.4：两入口互不干预）。
import { createBotSession, loadEvents, appendEvent, touchSession } from "./session.ts";
import { runBotTask, type BotEvent } from "./bot.ts";
import { Transcript, ToolBlock, StreamText, UserBlock, BOT_THEME } from "./view/bot-view.ts";
import { Markdown } from "../deps/pi-tui/dist/index.js";
import { dim } from "./ui/ansi.ts";
import { renderPortrait, type PortraitInfo } from "./ui/portrait.ts";
import { activeFacts, loadFacts } from "./memory.ts";
import type { BuilderConfig } from "./builder.ts";
import type { Component } from "../deps/pi-tui/dist/index.js";

/** 开场画像：宽度响应式（格子里自动降档到迷你玫瑰） */
class PortraitBlock implements Component {
  private info: PortraitInfo;
  constructor(info: PortraitInfo) {
    this.info = info;
  }
  render(w: number): string[] {
    return renderPortrait(Math.max(34, Math.min(w, 100)), 40, this.info);
  }
  invalidate(): void {}
}

export interface KrystalMemberOpts {
  member: { id: string; name: string; role?: string };
  config: BuilderConfig;      // 凭据来自平台（/login 共用）；model = 成员模型 ?? bot 默认 ?? 平台模型
  cwd: string;                // 团队工作目录
  identity?: string;          // 身份 + 团队简报（SYSTEM 追加）
  sessionId?: string;         // 复用已有会话（驾驶舱 resume）
  onRender?: () => void;      // 事件落格后请求重绘
}

export class KrystalMember {
  readonly transcript = new Transcript(); // 格子直接渲染这个（逐项缓存）
  readonly sessionId: string;
  private cfg: BuilderConfig;
  private busy = false;
  private state = "空闲";
  private turnThinking = "";
  private streamBlock: StreamText | undefined;
  private streamKind: "thinking" | "text" | null = null;
  private currentTool: ToolBlock | undefined;
  private toolById = new Map<string, ToolBlock>();
  private queue: string[] = [];   // v0 串行：忙时派工排队，完成即跑
  private abort = new AbortController();
  private onEvent: (e: BotEvent) => void;
  private opts: KrystalMemberOpts;

  constructor(opts: KrystalMemberOpts) {
    this.opts = opts;
    this.cfg = opts.config;
    this.sessionId = opts.sessionId ?? createBotSession({ cwd: opts.cwd, model: opts.config.model, tier: "写作者" }).id;
    this.onEvent = (e) => this.handle(e);
    // 开场画像置顶（pi/独立视图同款）；intro 事件只在首次写入
    const evs = loadEvents(this.sessionId);
    this.transcript.items.push(
      new PortraitBlock({
        name: opts.member.name,
        model: opts.config.model,
        tier: "写作者",
        cwd: opts.cwd,
        sessionId: this.sessionId.replace(/^bot-/, ""),
        memories: activeFacts(loadFacts()).length,
      }),
      "",
    );
    if (!evs.some((e) => e.t === "intro"))
      appendEvent(this.sessionId, { t: "intro", at: new Date().toISOString(), cwd: opts.cwd, model: opts.config.model, tier: "写作者" });
    // 注入的 context 可视化（与 tmux 成员「看见注入文本」对等；模型侧在 SYSTEM，不重复进上下文）
    if (opts.identity) {
      opts.identity.split("\n").forEach((l) => this.transcript.items.push(dim("  " + l)));
      this.transcript.items.push("");
    }
    this.replayFrom(evs);
  }

  /** 可见性备注（身份/简报注入等，与 tmux 成员的注入消息对等） */
  note(text: string): void {
    this.transcript.items.push(dim(`  ${text}`), "");
    this.touch();
  }

  get busyFlag(): boolean {
    return this.busy;
  }
  get stateText(): string {
    return this.state;
  }

  /** 派工/广播入口：文本进 Krystal 的输入线（忙则排队，v0 串行） */
  send(text: string): void {
    appendEvent(this.sessionId, { t: "msg", at: new Date().toISOString(), role: "user", content: text });
    this.transcript.items.push(new UserBlock(text), "");
    this.touch();
    if (this.busy) {
      this.queue.push(text);
      return;
    }
    this.startTurn(text);
  }

  kill(): void {
    this.abort.abort();
  }

  private touch(): void {
    this.transcript.invalidate();
    this.opts.onRender?.();
  }

  private startTurn(text: string): void {
    this.busy = true;
    this.state = "连接中";
    this.turnThinking = "";
    const events = loadEvents(this.sessionId);
    void runBotTask({
      cfg: this.cfg,
      cwd: this.opts.cwd,
      events,
      identity: this.opts.identity,
      signal: this.abort.signal,
      onEvent: (e) => this.handle(e),
    });
    this.touch();
  }

  private handle(e: BotEvent): void {
    switch (e.type) {
      case "thinking":
        this.state = "思考中";
        if (this.streamKind !== "thinking") this.beginStream("· thinking ", (t) => dim(t));
        this.streamBlock?.append(e.delta);
        this.turnThinking += e.delta;
        break;
      case "text":
        this.state = "回答中";
        if (this.streamKind !== "text") this.beginStream("", (t) => t);
        this.streamBlock?.append(e.delta);
        break;
      case "tool_args": {
        this.state = "工具 " + e.name;
        if (!this.currentTool) {
          this.closeStream();
          this.currentTool = new ToolBlock(e.name, e.argsSoFar);
          this.transcript.items.push(this.currentTool, "");
        } else this.currentTool.args = e.argsSoFar;
        break;
      }
      case "tool_start": {
        this.state = "工具 " + e.name;
        if (!this.currentTool) {
          this.closeStream();
          this.currentTool = new ToolBlock(e.name, e.args);
          this.transcript.items.push(this.currentTool, "");
        } else this.currentTool.args = e.args;
        break;
      }
      case "tool_result":
        this.currentTool?.setResult(e.ok, e.denied, e.output);
        this.currentTool = undefined;
        appendEvent(this.sessionId, {
          t: "msg",
          at: new Date().toISOString(),
          role: "tool",
          content: (e.denied ? "[策略闸门拒绝] " : "") + e.output,
          toolCallId: e.id,
        });
        break;
      case "assistant":
        appendEvent(this.sessionId, {
          t: "msg",
          at: new Date().toISOString(),
          role: "assistant",
          content: e.content,
          thinking: this.turnThinking || undefined,
          toolCalls: e.toolCalls,
        });
        this.turnThinking = "";
        this.closeStream();
        break;
      case "usage":
        appendEvent(this.sessionId, {
          t: "usage",
          at: new Date().toISOString(),
          prompt: e.prompt,
          cached: e.cached,
          completion: e.completion,
          model: this.cfg.model,
        });
        break;
      case "final": {
        this.closeStream();
        this.state = "完成";
        // 流式原文块 → Markdown 块：先移除原块（否则重复打印 —— bot-view 同规则）
        const streamed = this.streamBlock;
        if (streamed) {
          const idx = this.transcript.items.indexOf(streamed);
          if (idx >= 0) this.transcript.items.splice(idx, 1);
          this.transcript.forget(streamed);
        }
        if (e.text.trim()) this.transcript.items.push(new Markdown(e.text, 1, 0, BOT_THEME), "");
        appendEvent(this.sessionId, {
          t: "msg",
          at: new Date().toISOString(),
          role: "assistant",
          content: e.text,
          thinking: this.turnThinking || undefined,
        });
        this.turnThinking = "";
        touchSession(this.sessionId);
        this.busy = false;
        this.pump();
        break;
      }
      case "error": {
        this.closeStream();
        this.transcript.items.push(dim(`  ✗ ${e.message}`), "");
        this.state = "出错";
        this.busy = false;
        this.pump();
        break;
      }
      default:
        break; // retry/context 等可见性事件：格子模式保持安静（状态行已足够）
    }
    this.touch();
  }

  private beginStream(prefix: string, style: (t: string) => string): void {
    this.closeStream();
    this.streamBlock = new StreamText(prefix, style);
    this.transcript.items.push(this.streamBlock, "");
    this.streamKind = prefix ? "thinking" : "text";
  }
  private closeStream(): void {
    this.streamBlock = undefined;
    this.streamKind = null;
  }
  private pump(): void {
    const next = this.queue.shift();
    if (next) this.send(next);
  }

  /** 驾驶舱 resume：事件流 → 组件（与 runBotFlow.rebuild 同规则） */
  private replayFrom(evs: ReturnType<typeof loadEvents>): void {
    for (const e of evs) {
      if (e.t !== "msg") continue;
      if (e.role === "user") {
        this.transcript.items.push(new UserBlock(e.content), "");
      } else if (e.role === "assistant") {
        if (e.thinking) {
          const tb = new StreamText("· thinking ", (t) => dim(t));
          tb.append(e.thinking);
          this.transcript.items.push(tb, "");
        }
        if (e.toolCalls?.length) {
          for (const tc of e.toolCalls) {
            const b = new ToolBlock(tc.name, tc.args);
            this.toolById.set(tc.id, b);
            this.transcript.items.push(b);
          }
        } else if (e.content.trim()) this.transcript.items.push(new Markdown(e.content, 1, 0, BOT_THEME), "");
      } else if (e.role === "tool") {
        const b = e.toolCallId ? this.toolById.get(e.toolCallId) : undefined;
        const denied = e.content.startsWith("[策略闸门拒绝]");
        b?.setResult(!denied, denied, e.content.replace(/^\[策略闸门拒绝\] /, ""));
      }
    }
  }
}
