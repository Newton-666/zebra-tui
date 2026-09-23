// Krystal Bot — 原型 TUI：cell 即它的 TUI（§9.4）
// 布局与 app.ts 同构：VStack[header, ScrollView(grow), status, 输入框（两条线，浅蓝）]
// 流式渲染：thinking（dim 流动行）/ 工具调用（▸ 工具 参数 → 结果行）/ 回答
import {
  Editor,
  Markdown,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
} from "../../deps/pi-tui/dist/index.js";
import { BLUE_LIGHT, bold, dim, fg } from "../ui/ansi.ts";
import { KRYSTAL_GRADIENT, LOGO_ROWS, LOGO_WIDTH } from "../ui/logo.ts";
import { loadBuilder, type BuilderConfig } from "../builder.ts";
import { runBotTask, type BotEvent } from "../bot.ts";

const BLUE = BLUE_LIGHT; // 平台常量 38;5;45（浅蓝前景）——写成 "45" 会变成洋红背景
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

/** 与主 app 同源：pi-tui 的 Editor 自己画上下两条线，颜色由 borderColor 决定（重画会被渲染层吃掉） */
const EDITOR_THEME: EditorTheme = { borderColor: (s: string) => fg(BLUE, s) };

const rule = (w: number, color = "36") => fg(color, "─".repeat(Math.max(0, w - 2)));

type Line = string;

/** 与 pi 一致：回答用 Markdown 渲染（pi-tui 自带组件） */
const BOT_THEME: MarkdownTheme = {
  heading: (t) => bold(fg("36", t)),
  link: (t) => fg("34", t),
  linkUrl: (t) => dim(t),
  code: (t) => fg("33", t),
  codeBlock: (t) => fg("33", t),
  codeBlockBorder: (t) => dim(t),
  quote: (t) => dim(t),
  quoteBorder: (t) => dim(t),
  hr: (t) => dim("─".repeat(30)),
  listBullet: (t) => fg("36", t),
  bold,
  italic: (t) => t,
  strikethrough: (t) => t,
  underline: (t) => t,
};

class Transcript implements Component {
  items: (string | Markdown)[] = [];
  render(w: number): string[] {
    const out: string[] = [];
    for (const it of this.items) {
      if (typeof it === "string") out.push(truncateToWidth(it, w, "…"));
      else out.push(...it.render(w));
    }
    return out;
  }
  invalidate(): void {}
}

export async function runBotFlow(cwd: string): Promise<void> {
  const cfg: BuilderConfig | undefined = loadBuilder();
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 });

  const transcript = new Transcript();
  const scroll = new ScrollView(transcript, { follow: "end", scrollbar: "auto", overscroll: "contain" });
  const editor = new Editor(tui, EDITOR_THEME, { autocompleteMaxVisible: 4 });
  const clearEditor = () => editor.setText("");

  const push = (...lines: (string | Markdown)[]) => {
    transcript.items.push(...lines);
    tui.requestRender();
  };

  let busy = false;
  let state = cfg ? "空闲" : "未配置";
  let tokens = 0;
  let streamIdx = -1; // 正在流动的那一行
  let streamBuf = "";
  const abort = new AbortController();
  const history: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] = [];

  const modelLine = cfg ? `${cfg.model}` : "未配置平台模型——回首页 Platform model 配置";
  const headerComp: Component = {
    render(w: number): string[] {
      const inner = Math.max(10, w - 2);
      const side = w >= LOGO_WIDTH + 46;
      const tag = [
        "",
        ` ${bold("原生成员")} ${dim("· 阅读者档位 · 原型")}`,
        dim(` ${modelLine}`),
        dim(` ${cwd}`),
        "",
      ];
      const out = [dim("╭" + "─".repeat(inner) + "╮")];
      for (let r = 0; r < LOGO_ROWS.length; r++) {
        const logo = fg(KRYSTAL_GRADIENT[r]!, LOGO_ROWS[r]!);
        const content = side ? ` ${logo}${pad(logo, LOGO_WIDTH)}  ${tag[r] ?? ""}` : ` ${logo}`;
        out.push(dim("│") + pad(truncateToWidth(content, inner, "…"), inner) + dim("│"));
      }
      out.push(dim("╰" + "─".repeat(inner) + "╯"));
      return out;
    },
    invalidate(): void {},
  };
  const statusComp: Component = {
    render(w: number): string[] {
      return [truncateToWidth(` ${dim(`state: ${busy ? state : "空闲"} · ~${(tokens / 1000).toFixed(1)}k tokens · esc 中断 · ctrl+c 退出`)}`, w)];
    },
    invalidate(): void {},
  };
  const inputFrame: Component = {
    render(w: number): string[] {
      // Editor 总会画一个 \x1b[7m 反色软件光标块（终端主题下会显成粉/白），
      // 我方统一改成平台蓝底方块，保证输入框全蓝
      const blueBlock = `\x1b[48;5;45m\x1b[38;5;16m`;
      return editor.render(w).map((l) => l.replace(/\x1b\[7m/g, blueBlock));
    },
    invalidate(): void {
      editor.invalidate();
    },
  };

  // 流动行：同一行原地增长（thinking / 回答）
  const beginStream = (prefix: string) => {
    if (streamIdx >= 0) closeStream();
    streamBuf = "";
    push(prefix);
    streamIdx = transcript.items.length - 1;
  };
  const streamTo = (delta: string, build: (buf: string) => string) => {
    streamBuf += delta;
    if (streamIdx >= 0) transcript.items[streamIdx] = build(streamBuf);
    tui.requestRender();
  };
  const closeStream = () => {
    streamIdx = -1;
    streamBuf = "";
  };

  const onEvent = (e: BotEvent) => {
    switch (e.type) {
      case "thinking":
        state = "思考中";
        if (streamIdx < 0 || !transcript.lines[streamIdx]!.startsWith(dim("· "))) beginStream(dim("· "));
        tokens += e.delta.length / 4;
        streamTo(e.delta, (b) => dim("· thinking " + b.replace(/\s+/g, " ")));
        break;
      case "text":
        state = "回答中";
        if (streamIdx < 0 || transcript.lines[streamIdx]!.startsWith(dim("· "))) beginStream("");
        tokens += e.delta.length / 4;
        streamTo(e.delta, (b) => " " + b);
        break;
      case "tool_start": {
        closeStream();
        state = "工具 " + e.name;
        tokens += e.args.length / 4;
        let argsPreview = e.args;
        try {
          argsPreview = JSON.stringify(JSON.parse(e.args));
        } catch {
          /* 原样 */
        }
        push(` ${fg("33", "▸")} ${fg("33", e.name)} ${dim(argsPreview.slice(0, 120))}`);
        break;
      }
      case "tool_result": {
        const mark = e.denied ? fg("31", "✗ 闸门") : e.ok ? fg("32", "✓") : fg("31", "✗");
        const first = e.output.split("\n").slice(0, 4).join(" ⏎ ");
        push(`   ${mark} ${dim(first.slice(0, 200))}`);
        break;
      }
      case "final": {
        // 流式原始行 → Markdown 渲染块（与 pi 的回答观感一致）
        const at = streamIdx;
        closeStream();
        state = "完成";
        if (e.text.trim()) {
          if (at >= 0) transcript.items.splice(at, 1);
          push(new Markdown(e.text, 1, 0, BOT_THEME));
          push("");
        }
        history.push({ role: "assistant", content: e.text });
        busy = false;
        break;
      }
      case "error":
        closeStream();
        push(fg("31", ` ✗ ${e.message}`));
        busy = false;
        state = "出错";
        break;
    }
    tui.requestRender();
  };

  const runTurn = (text: string) => {
    if (!cfg) return;
    busy = true;
    state = "连接中";
    history.push({ role: "user", content: text });
    void runBotTask({ cfg, cwd, history, signal: abort.signal, onEvent });
  };

  editor.onSubmit = (text: string) => {
    if (busy || !cfg) return;
    const body = text.trim();
    if (!body) return;
    clearEditor();
    // pi 风格：提交后输入框清空，消息作为「块」落入对话区（左侧竖线 + 青色前缀）
    push(fg("36", " ▌") + fg("36", " 你") + "", fg("36", " ▌") + " " + body, "");
    runTurn(body);
  };

  const focusTarget = {
    get focused(): boolean {
      return editor.focused; // 必须真实转发：否则 Editor 认为未聚焦 → 退化成反色软件光标块（粉色高亮）
    },
    set focused(v: boolean) {
      editor.focused = v;
    },
    handleInput(data: string): void {
      const quit = () => {
        tui.stop();
        finish();
      };
      if (matchesKey(data, "ctrl+c")) {
        quit();
        return;
      }
      if (matchesKey(data, "escape")) {
        if (busy) {
          abort.abort(); // 中断当前生成（可继续输入）
        } else {
          quit();
        }
        return;
      }
      editor.handleInput(data);
    },
    invalidate(): void {
      editor.invalidate();
    },
  };

  if (!cfg) push(fg("31", " ✗ 未配置平台模型——esc 返回首页，先到 Platform model 配置"));

  tui.setLayoutRoot(
    new VStack([
      { component: headerComp, basis: "auto" },
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: statusComp, basis: "auto" },
      { component: inputFrame, basis: "auto" },
    ]),
  );
  tui.setFocus(focusTarget as never);
  let finish = () => {};
  const finished = new Promise<void>((r) => (finish = r));
  tui.start();
  await finished;
}
