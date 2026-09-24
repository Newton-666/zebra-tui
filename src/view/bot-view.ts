// Krystal Bot — 原型 TUI：cell 即它的 TUI（§9.4）
// 布局与 app.ts 同构：VStack[header, ScrollView(grow), status, 输入框（两条线，浅蓝）]
// 流式渲染：thinking（dim 流动行）/ 工具调用（▸ 工具 参数 → 结果行）/ 回答
import {
  Editor,
  Input,
  Markdown,
  SelectList,
  ProcessTerminal,
  ScrollView,
  TuiAltScreen,
  VStack,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
  type Component,
  type EditorTheme,
  type MarkdownTheme,
} from "../../deps/pi-tui/dist/index.js";
import { BG_BLUE, BLUE_LIGHT, bold, chip, dim, fg, FG_WHITE } from "../ui/ansi.ts";
import { KRYSTAL_GRADIENT, LOGO_ROWS, LOGO_WIDTH } from "../ui/logo.ts";
import { fetchModelInfos, loadBotModel, loadBuilder, maskKey, PROVIDER_PRESETS, saveBuilder, setBotModel, testBuilder, type BuilderConfig, type ModelInfo } from "../builder.ts";
import { activeFacts, importMirror, loadFacts, renderGraph } from "../memory.ts";
import { renderPortrait } from "../ui/portrait.ts";
import {
  appendEvent,
  contextStatus,
  countEvents,
  createBotSession,
  lastUsage,
  loadBotMeta,
  latestNote as lastSummary,
  loadEvents,
  listBotSessions,
  messagesFrom,
  renameSession,
  setSessionModel,
  touchSession,
  trashSession,
} from "../session.ts";
import { runBotTask, type BotEvent } from "../bot.ts";

const BLUE = BLUE_LIGHT; // 平台常量 38;5;45（浅蓝前景）——写成 "45" 会变成洋红背景
const THEME = {
  selectedPrefix: (t: string) => fg("36", t),
  selectedText: (t: string) => bold(t),
  description: (t: string) => dim(t),
  scrollInfo: (t: string) => dim(t),
  noMatch: (t: string) => fg("33", t),
};
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

export class Transcript implements Component {
  items: (string | Component)[] = [];
  lastWidth = 0;
  // ── 性能（对齐 pi-tui 自建组件的缓存契约）：框架每帧的 renderCache 是新建的，跨帧缓存只能靠组件自己。
  // 每项按（对象身份 + 版本号 + 宽度）缓存裁剪后的行：滚动/流式增量时全是缓存命中，不再每帧重排全量文本。
  // 可变组件（StreamText.append / ToolBlock）在内容变化时自增 rev → 只有那一项重算。
  private cache = new Map<object | string, { rev: number | string; w: number; lines: string[] }>();
  private static revOf(it: string | Component): number | string {
    if (typeof it === "string") return it;
    return (it as { rev?: number }).rev ?? 0;
  }
  render(w: number): string[] {
    this.lastWidth = w;
    const out: string[] = [];
    for (const it of this.items) {
      const rev = Transcript.revOf(it);
      const key = typeof it === "string" ? it : it;
      let entry = this.cache.get(key);
      if (!entry || entry.rev !== rev || entry.w !== w) {
        const lines = typeof it === "string" ? [it] : it.render(w);
        const clipped: string[] = [];
        // 关键：任何来源的行都不允许超过宽度——Markdown 表格不折行，
        // 超宽会让合成器写出屏幕边界 → 整屏错乱、输入框消失
        for (const l of lines) clipped.push(truncateToWidth(l, w, ""));
        entry = { rev, w, lines: clipped };
        this.cache.set(key, entry);
      }
      out.push(...entry.lines);
    }
    return out;
  }
  /** 项目被移出列表时丢掉它的缓存（防旧块常驻内存） */
  forget(it: string | Component): void {
    this.cache.delete(typeof it === "string" ? it : it);
  }
  invalidate(): void {
    this.cache.clear();
  }
}

/** 用户消息块：整页宽蓝底 + 上下留白（对齐 pi 的 Box(padX=1, padY=1) 观感）
 *  说明：对话区的 ScrollView 会裁掉「纯空白行」，故留白行末尾缀一个零宽字符（不可见但非空白，保住整行背景） */
const ZWSP = "\u200b";
export class UserBlock implements Component {
  private text: string;
  constructor(text: string) {
    this.text = text;
  }
  render(w: number): string[] {
    const inner = Math.max(8, w - 4);
    const fill = (body: string) => {
      const padTo = Math.max(0, inner - visibleWidth(body));
      return chip(body + " ".repeat(padTo) + ZWSP, "48;5;24", "38;5;255");
    };
    const rows = wrapTextWithAnsi(this.text, inner - 2).map((r) => fill(" " + r));
    return [fill(""), ...rows, fill("")];
  }
  invalidate(): void {}
}

/** 工具调用块：与 pi 同源（tool-execution.js）——Box(padX=1, padY=1, toolXxxBg)
 *  状态色整页宽背景 + 加粗工具名 + dim 输出 + 截断提示；块内只用 bold/dim（\x1b[22m 还原）以免清掉底色 */
// 莫兰迪色系：低饱和灰调（三者明度相近，块感统一，不刺眼）
//   执行中 = 灰蓝(48;5;60)｜成功 = 灰绿(48;5;65)｜被闸门拦下 = 灰玫(48;5;95)
const TOOL_BG: Record<string, string> = { pending: "48;5;60", ok: "48;5;65", denied: "48;5;95", error: "48;5;95" };
const TOOL_MARK: Record<string, string> = { pending: "38;5;223", ok: "38;5;231", denied: "38;5;231", error: "38;5;231" };
// 块内文字用实色（dim 在彩底上会发灰）：标题加粗白、参数浅青白、输出浅灰、提示中灰
const T_TITLE = "\x1b[38;5;231m";
const T_ARGS = "\x1b[38;5;195m";
const T_OUT = "\x1b[38;5;252m";
const T_HINT = "\x1b[38;5;246m";
const B_ON = "\x1b[1m";
const B_OFF = "\x1b[22m";
export class ToolBlock implements Component {
  name: string;
  /** 渲染版本号：内容变化时 +1（Transcript 缓存据此只重算这一项） */
  rev = 0;
  private _args: string;
  private state = "pending";
  private output: string[] = [];
  private note = "";
  constructor(name: string, args: string) {
    this.name = name;
    let preview = args;
    try {
      preview = JSON.stringify(JSON.parse(args));
    } catch {
      /* 原样 */
    }
    this._args = preview.slice(0, 90);
  }
  get args(): string {
    return this._args;
  }
  set args(v: string) {
    this._args = v;
    this.rev++;
  }
  setResult(ok: boolean, denied: boolean, output: string): void {
    this.state = denied ? "denied" : ok ? "ok" : "error";
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    this.output = lines.slice(0, 6).map((l) => l.slice(0, 160));
    this.note = lines.length > 6 ? `… +${lines.length - 6} 行` : "";
    this.rev++;
  }
  render(w: number): string[] {
    const inner = Math.max(12, w - 4);
    const bar = (body = "") => {
      const padTo = Math.max(0, inner - visibleWidth(body));
      return chip(" " + body + " ".repeat(padTo) + ZWSP, TOOL_BG[this.state]!, FG_WHITE);
    };
    const mark = this.state === "pending" ? "●" : this.state === "ok" ? "✓" : "✗ 闸门拒绝";
    const markColored = `\x1b[${TOOL_MARK[this.state]!}m${mark}`;
    const head = `${markColored} ${T_TITLE}${B_ON}${this.name}${B_OFF} ${T_ARGS}${this.args}`;
    const rows = [bar(), bar(head)];
    for (const l of this.output) rows.push(bar(T_OUT + "  " + l));
    if (this.note) rows.push(bar(T_HINT + "  " + this.note));
    rows.push(bar());
    return rows;
  }
  invalidate(): void {}
}

/** 流式文本块：多行折行渲染，原地增长（思考/回答共用）——pi 的思考是「一段」而不是一行 */
export class StreamText implements Component {
  text = "";
  /** 渲染版本号：每追加一段增量 +1（Transcript 缓存据此只重算这一项） */
  rev = 0;
  private prefix: string;
  private style: (s: string) => string;
  private indent: string;
  constructor(prefix: string, style: (s: string) => string, indent = "   ") {
    this.prefix = prefix;
    this.style = style;
    this.indent = indent;
  }
  append(delta: string): void {
    this.text += delta;
    this.rev++;
  }
  render(w: number): string[] {
    const rows = wrapTextWithAnsi(this.text.replace(/\s+$/, ""), Math.max(8, w - 4));
    if (!rows.length) rows.push("");
    return rows.map((r, i) => (i === 0 ? " " + this.style(this.prefix) + this.style(r) : this.indent + this.style(r)));
  }
  invalidate(): void {}
}

/** 选择器块：提示行 + 列表一体（原位替换，不堆积；note 承载反馈/标题） */
class PickerBlock implements Component {
  note = "";
  list: SelectList;
  constructor(list: SelectList) {
    this.list = list;
  }
  render(w: number): string[] {
    const head = this.note ? fg("33", `  ${this.note}`) : dim("  回溯历史（↑↓ 恢复 · enter 确认 · d 删除 · esc 返回）");
    return [head, ...this.list.render(w)];
  }
  invalidate(): void {
    this.list.invalidate();
  }
}

/**
 * 通用弹层选择器（照 bobo activeSessionSwitcher 的架构）：
 * - 常驻 overlay（不是往对话流塞组件）→ 结构上不可能「堆出一堆」
 * - 选择/删除由状态驱动：删除 = **原位过滤数组** + 选中夹到新长度（= 自动落在下一个）✓
 * - `d` 两次删除：第一次武装（按会话 id 记录，不是行号），第二次删除；其他键取消武装
 */
export interface ListOverlayOpts {
  title: string;
  hint: string;
  items: { value: string; label: string; description?: string }[];
  onPick: (value: string) => void;
  onCancel: () => void;
  /** 返回错误文案表示失败；undefined = 成功（成功后内部会自动 reload） */
  onDelete?: (id: string) => string | undefined;
  reload?: () => { value: string; label: string; description?: string }[];
  onChange?: () => void;
}

export class ListOverlay implements Component {
  private o: ListOverlayOpts;
  private items: { value: string; label: string; description?: string }[];
  private list: SelectList;
  private note = "";
  private err = "";
  private armed?: string;

  constructor(o: ListOverlayOpts) {
    this.o = o;
    this.items = o.items;
    this.list = this.buildList(o.items);
  }

  private buildList(items: { value: string; label: string; description?: string }[], keep?: string): SelectList {
    const l = new SelectList(items, Math.min(items.length, 12), THEME);
    const idx = keep ? items.findIndex((it) => it.value === keep) : 0;
    l.setSelectedIndex(Math.max(0, Math.min(idx, items.length - 1)));
    l.onSelect = (it: { value: string }) => this.o.onPick(it.value);
    return l;
  }

  render(w: number): string[] {
    const out: string[] = [];
    out.push(bold(this.o.title));
    out.push(this.err ? fg("31", this.err) : this.note ? fg("33", this.note) : dim(this.o.hint));
    out.push("");
    out.push(...this.list.render(w));
    if (this.o.onDelete) out.push("", dim("  d 删除（连按两次确认）· esc 返回"));
    return out;
  }

  handleInput(d: string): void {
    if (this.armed) {
      if (d.toLowerCase() === "d") {
        const id = this.armed;
        this.armed = undefined;
        this.err = "";
        const err = this.o.onDelete?.(id);
        if (err) {
          this.err = err;
        } else {
          this.items = this.o.reload?.() ?? this.items.filter((it) => it.value !== id);
          const keep = undefined; // 删除后停在原索引 = 下一个会话
          const prevIdx = 0;
          void prevIdx;
          this.list = this.buildList(this.items);
          this.note = `已删除 ${id}（移入 .trash，可恢复）· 可继续按 d`;
        }
      } else {
        this.armed = undefined;
        this.note = "";
      }
      this.o.onChange?.();
      return;
    }
    if (matchesKey(d, "escape")) {
      this.o.onCancel();
      return;
    }
    if ((d === "d" || d === "D") && this.o.onDelete) {
      const sel = this.list.getSelectedItem();
      if (sel?.value) {
        this.armed = sel.value;
        this.note = `再按一次 d 删除「${String(sel.label ?? sel.value)}」（移入 .trash，可恢复）`;
        this.o.onChange?.();
      }
      return;
    }
    this.list.handleInput(d);
  }

  invalidate(): void {
    this.list.invalidate();
  }
}

export async function runBotFlow(cwd: string, resumeId?: string): Promise<void> {
  // Krystal Bot 的模型与平台搭建模型分离（spec §1）：bot 单独设过 → 用 bot 的；否则继承平台（「平台设好了这边自动有」）
  let cfg: BuilderConfig | undefined = loadBuilder();
  const botDefaultModel = loadBotModel();
  if (cfg && botDefaultModel) cfg = { ...cfg, model: botDefaultModel };
  const terminal = new ProcessTerminal();
  const tui = new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 });

  const transcript = new Transcript();
  const scroll = new ScrollView(transcript, { follow: "end", scrollbar: "auto", overscroll: "contain" });
  const editor = new Editor(tui, EDITOR_THEME, { autocompleteMaxVisible: 4 });
  const clearEditor = () => editor.setText("");

  /** 内容变化后主动重算滚动视图布局：否则高度突变的那一帧会用旧高度 → 溢出、破坏输入框 */
  const refresh = () => {
    const w = transcript.lastWidth || 100;
    try {
      scroll.updateLayout(transcript.render(w).length, scroll.viewportHeight, () => tui.requestRender());
    } catch {
      /* 布局尚未就绪 */
    }
    tui.requestRender();
  };
  const push = (...lines: (string | Component)[]) => {
    transcript.items.push(...lines);
    refresh();
  };

  // ── 会话：续聊则重放事件（与中断前同一前缀 → 缓存立刻恢复），否则新开一个
  const resumed = resumeId ? loadBotMeta(resumeId) : undefined;
  let sessionId = resumed?.id ?? createBotSession({ cwd, model: cfg?.model ?? "", tier: "写作者" }).id;
  let usage = resumed ? lastUsage(loadEvents(sessionId)) : undefined;
  let sessionName: string | undefined = resumed ? loadBotMeta(sessionId)?.name : undefined; // /name 设置
  let picker: SelectList | undefined;
  let pickerBlock: PickerBlock | undefined;
  let pickerKind: "sessions" | undefined;
  // 会话自己的模型优先（/model 设置过的存 bot.json；续聊时延续那个会话当时用的脑）
  if (resumed?.model && cfg) cfg = { ...cfg, model: resumed.model };
  let deleteArmed: string | undefined; // 两次 d 删除：第一次只武装并提示
  let pickerSel: string | undefined; // 当前选中的会话 id（重开列表时恢复位置）
  let foldCount = 0; // 本回合折叠的工具输出条数（上下文回收的可见性）
  let summaryActive = resumed ? !!lastSummary(loadEvents(sessionId)) : false;
  // 本地「前缀稳定性」：与上一回合的稳定前缀逐字节比对（provider 不报 cached_tokens 时的可靠判据）
  let prevHistory: unknown[] | undefined;
  let prefixStable: boolean | undefined;
  /** 前缀稳定性 = 「旧上下文是新上下文的前缀」（append-only 检测）。增长是正常的；重写才是问题 */
  const checkPrefix = (history: unknown[]) => {
    if (!prevHistory) {
      prefixStable = undefined;
    } else {
      prefixStable =
        history.length >= prevHistory.length &&
        prevHistory.every((m, i) => JSON.stringify(m) === JSON.stringify(history[i]));
    }
    prevHistory = JSON.parse(JSON.stringify(history)) as unknown[];
  };
  let busy = false;
  let state = cfg ? "空闲" : "未配置";
  let tokens = 0;
  const abort = new AbortController();

  let modelLine = cfg ? `${cfg.model}` : "未配置 API——对话内 /login 配置（与平台共用）";
  const applyModelChange = (model: string, note: string): void => {
    if (!cfg) return;
    cfg = { ...cfg, model };
    modelLine = cfg.model;
    push(dim(note), "");
    refresh();
  };
  /** 开场面板（logo + 画像 + 信息卡）：新会话与续聊都渲染 */
  const pushIntro = (model: string, sessionCwd: string) =>
    renderPortrait(tui.terminal?.columns ?? 80, tui.terminal?.rows ?? 24, {
      name: "Krystal Bot",
      model,
      tier: "写作者",
      cwd: sessionCwd,
      sessionId: sessionId.replace(/^bot-/, ""),
      memories: activeFacts(loadFacts()).length,
    });

  /** 从事件流重建对话区（新会话为空；/resume 切换会话时复用） */
  const rebuild = (id: string) => {
    const toolById = new Map<string, ToolBlock>();
    const evs = loadEvents(id);
    const intro = evs.find((e) => e.t === "intro");
    const meta = loadBotMeta(id);
    if (intro && intro.t === "intro") {
      transcript.items.push(...pushIntro(cfg?.model ?? intro.model, intro.cwd), "");
    } else if (meta) {
      // 旧会话（本次改动前建的）没有 intro 事件 → 补渲染并回填落盘
      transcript.items.push(...pushIntro(cfg?.model ?? meta.model, meta.cwd), "");
      appendEvent(id, { t: "intro", at: new Date().toISOString(), cwd: meta.cwd, model: meta.model, tier: meta.tier });
    }
    for (const e of evs) {
      if (e.t === "msg" && e.role === "user") transcript.items.push(new UserBlock(e.content), "");
      else if (e.t === "msg" && e.role === "assistant") {
        if (e.toolCalls?.length) {
          for (const tc of e.toolCalls) {
            const b = new ToolBlock(tc.name, tc.args);
            toolById.set(tc.id, b);
            transcript.items.push(b);
          }
        } else if (e.content.trim()) transcript.items.push(new Markdown(e.content, 1, 0, BOT_THEME), "");
      } else if (e.t === "msg" && e.role === "tool") {
        const b = e.toolCallId ? toolById.get(e.toolCallId) : undefined;
        const denied = e.content.startsWith("[策略闸门拒绝]");
        b?.setResult(!denied, denied, e.content.replace(/^\[策略闸门拒绝\] /, ""));
      }
    }
  };
  if (resumed) rebuild(sessionId);
  else {
    // 开场画像（hermes 式 Braille 点阵）：作为滚动流的第一条 → 一用起来就自然滚走
    transcript.items.push(...pushIntro(cfg?.model ?? "（未配置）", cwd), "");
    appendEvent(sessionId, { t: "intro", at: new Date().toISOString(), cwd, model: cfg?.model ?? "", tier: "写作者" });
  }
  /** 回溯历史（/resume）：清空对话区并重放所选会话 */
  const resumeSession = (id: string) => {
    sessionId = id;
    transcript.items = [];
    transcript.invalidate();
    rebuild(id);
    usage = lastUsage(loadEvents(id));
    prevHistory = undefined;
    prefixStable = undefined;
    foldCount = 0;
    summaryActive = !!lastSummary(loadEvents(id));
    push(dim(`  已回溯到 ${id}`), "");
    refresh();
  };
  // ── 弹层选择器（照 bobo activeSessionSwitcher 的架构：真弹层 + 状态驱动 + d 两次删除）
  // 不再往 transcript 里 push 组件（那是「一堆」的根源）
  let overlayHandle: { hide: () => void } | undefined;
  let currentDeleted = false; // 删掉了当前会话 → 关闭弹层时新建一个
  let overlayKeys: ((d: string) => void) | undefined;

  const closeOverlay = (): void => {
    overlayKeys = undefined;
    overlayHandle?.hide();
    overlayHandle = undefined;
    if (currentDeleted) {
      // 删的是当前会话：这里才新建，避免删除瞬间列表里冒出一条
      currentDeleted = false;
      sessionId = createBotSession({ cwd, model: cfg?.model ?? "", tier: "写作者" }).id;
      transcript.items = [...pushIntro(cfg?.model ?? "", cwd), ""];
      transcript.invalidate();
      usage = undefined;
      prevHistory = undefined;
      prefixStable = undefined;
      foldCount = 0;
      summaryActive = false;
      push(dim("  当前会话已删除——已为你新开一个会话（继承模式）"), "");
      refresh();
    }
  };

  const openOverlay = (picker: Component & { handleInput(d: string): void }, width = 92): void => {
    closeOverlay();
    // 面板样式（与 model-picker 的圆角弹层同一家族）：描边 + 实底背景，锚在输入框上方 ——
    // 之前是居中且无框无底，与终端背景叠在一起
    const BG = "\x1b[48;5;236m";
    const BD = "\x1b[38;5;45m";
    const RESET = "\x1b[0m";
    const bordered: Component = {
      render: (w: number) => {
        const inner = Math.max(20, w - 2);
        const bgLine = (l: string) => {
          const padded = l + " ".repeat(Math.max(0, inner - visibleWidth(l)));
          // 行内若有 reset（列表行样式切换处），reset 后重新上底色，保证整行实底
          return BG + padded.replace(/\x1b\[0m/g, RESET + BG) + RESET;
        };
        const edge = (l: string, r: string) => BD + l + BG + "─".repeat(inner) + BD + r + RESET;
        return [
          edge("╭", "╮"),
          ...picker.render(inner).map((l) => BD + "│" + RESET + bgLine(l) + BD + "│" + RESET),
          edge("╰", "╯"),
        ];
      },
      handleInput: (d: string) => picker.handleInput(d),
      invalidate: () => picker.invalidate(),
    };
    const handle = tui.showOverlay(bordered, {
      width,
      maxHeight: "70%",
      anchor: "bottom-center", // 浮在输入框上方，不挡全屏；底部留出状态行 + 输入框的高度
      margin: { top: 1, bottom: 6, left: 0, right: 0 },
    });
    handle.focus?.();
    overlayKeys = (d: string) => picker.handleInput(d); // 平台的 overlay 自动聚焦不生效 → 显式转发
    overlayHandle = handle;
  };

  const openSessionsPicker = (): void => {
    const sessions = listBotSessions();
    const items = sessions.map((m) => ({
      value: m.id,
      label: m.name ? `${m.name}  (${m.createdAt.slice(5, 16).replace("T", " ")})` : `${m.createdAt.slice(0, 16).replace("T", " ")} · ${m.id.replace(/^bot-/, "").slice(0, 15)}`,
      description: `${m.model} · ${countEvents(m.id)} 条消息`,
    }));
    const picker = new ListOverlay({
      title: "回溯历史",
      hint: "↑↓ 选择 · enter 恢复 · d 删除 · esc 返回",
      items,
      onPick: (v) => {
        closeOverlay();
        resumeSession(v);
      },
      onCancel: closeOverlay,
      onDelete: (id) => {
        const r = trashSession(id);
        if (!r.ok) return `删除失败：${r.error ?? "未知错误"}`;
        if (id === sessionId) {
          sessionId = createBotSession({ cwd, model: cfg?.model ?? "", tier: "写作者" }).id;
        }
        return undefined;
      },
      reload: () =>
        listBotSessions().map((m) => ({
          value: m.id,
          label: m.name ? `${m.name}  (${m.createdAt.slice(5, 16).replace("T", " ")})` : `${m.createdAt.slice(0, 16).replace("T", " ")} · ${m.id.replace(/^bot-/, "").slice(0, 15)}`,
          description: `${m.model}`,
        })),
      onChange: () => tui.requestRender(),
    });
    openOverlay(picker);
  };

  // ── /model 与 /login（参考 pi：模型切换与凭据配置都是对话内的轻流程）
  /** 通用输入弹层：标题 + 单行输入（enter 提交 · esc 取消） */
  const openInputOverlay = (title: string, prefill: string, onSubmit: (v: string) => void): void => {
    const input = new Input();
    if (prefill) input.setValue(prefill);
    input.onSubmit = (v: string) => {
      const val = (v ?? input.getValue()).trim();
      if (!val) return;
      closeOverlay();
      onSubmit(val);
    };
    input.onEscape = () => closeOverlay();
    const panel: Component = {
      render: (w: number) => [bold(` ${title}`), "", ...input.render(Math.max(24, w - 4))],
      handleInput: (d: string) => input.handleInput(d),
      invalidate: () => input.invalidate(),
    };
    openOverlay(panel, 64);
  };

  /** /model：切 Krystal Bot 自己的模型（动态拉取；与平台搭建模型分离，只写 config.json 的 bot.model） */
  const ctxNote = (t?: number): string => (t ? `${Math.round(t / 1000)}k 窗口` : "窗口未知");
  const openModelPicker = (): void => {
    if (!cfg) {
      push(dim("  未配置 API——先用 /login 配置（与平台共用凭据）"), "");
      refresh();
      return;
    }
    push(dim(`  正在拉取模型列表（${cfg.baseUrl}）…`), "");
    refresh();
    void fetchModelInfos({ baseUrl: cfg.baseUrl, apiKey: cfg.apiKey })
      .then((infos: ModelInfo[]) => {
        const picker = new ListOverlay({
          title: "Krystal Bot 模型（与平台搭建模型分离）",
          hint: "↑↓ 选择 · enter 确认 · esc 取消",
          items: [
            ...infos.map((m) => ({
              value: m.id,
              label: m.id,
              description: m.id === cfg!.model ? `当前 · ${ctxNote(m.contextTokens)}` : ctxNote(m.contextTokens),
            })),
            { value: "__manual", label: "手动输入模型 id…", description: "列表里没有时使用" },
          ],
          onPick: (v) => {
            closeOverlay();
            if (v === "__manual") openInputOverlay("模型 id", "", applyBotModel);
            else applyBotModel(v);
          },
          onCancel: closeOverlay,
        });
        openOverlay(picker, 78);
      })
      .catch((e: unknown) => {
        const msg = e instanceof Error ? e.message : String(e);
        push(fg("31", ` ✗ 拉取失败：${msg}——改用手动输入模型 id`), "");
        refresh();
        openInputOverlay("模型 id（手动输入）", "", applyBotModel);
      });
  };
  const applyBotModel = (model: string): void => {
    if (!cfg) return;
    setBotModel(model); // Bot 自己的默认模型（config.json 的 bot.model，平台搭建模型不动）
    setSessionModel(sessionId, model); // 本会话即刻生效；/resume 列表同步
    applyModelChange(model, `  Krystal Bot 模型已切换：${model}（平台搭建模型不受影响）`);
  };

  /** /login：配置 API（provider 预设 → Base URL → Key → 动态拉模型 → 测试 → 保存）。
   *  凭据与平台共用（存同一份 config.json 的 builder 段）：平台设好了这边自动有，这边设了平台也有；
   *  模型分离：保存后 Bot 用自己的 bot.model（若有），平台搭建模型不被覆盖。 */
  const openLoginFlow = (): void => {
    const draft: Partial<BuilderConfig> = loadBuilder() ?? {};
    let providerLabel = "";
    const showProvider = (): void => {
      const picker = new ListOverlay({
        title: "选择模型提供商（/login · 凭据与平台共用，模型分离）",
        hint: "↑↓ 选择 · enter 确认 · esc 取消",
        items: [
          ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label, description: p.baseUrl })),
          { value: "__custom", label: "自定义 Base URL…", description: "任何 OpenAI 兼容端点" },
        ],
        onPick: (v) => {
          closeOverlay();
          const preset = PROVIDER_PRESETS.find((p) => p.id === v);
          if (preset) {
            providerLabel = preset.label;
            draft.baseUrl = preset.baseUrl;
            showKey();
          } else showUrl();
        },
        onCancel: closeOverlay,
      });
      openOverlay(picker, 86);
    };
    const showUrl = (): void =>
      openInputOverlay("Base URL（OpenAI 兼容根地址，含 /v1）", draft.baseUrl ?? "", (v) => {
        providerLabel = "自定义";
        draft.baseUrl = v;
        showKey();
      });
    const showKey = (): void =>
      openInputOverlay(`API Key · ${providerLabel}（本地服务如 Ollama 可留空回车）`, draft.apiKey ?? "", (v) => {
        draft.apiKey = v || "none"; // 本地服务不需要真 key，留空占位
        startFetch();
      });
    const startFetch = (): void => {
      if (!draft.baseUrl || !draft.apiKey) return;
      push(dim(`  正在拉取模型列表（${draft.baseUrl}）…`), "");
      refresh();
      void fetchModelInfos({ baseUrl: draft.baseUrl, apiKey: draft.apiKey })
        .then((infos: ModelInfo[]) => {
          const picker = new ListOverlay({
            title: `选择模型（${providerLabel}，动态拉取——测试通过后才保存）`,
            hint: "↑↓ 选择 · enter 确认 · esc 取消",
            items: [
              ...infos.map((m) => ({ value: m.id, label: m.id, description: ctxNote(m.contextTokens) })),
              { value: "__manual", label: "手动输入模型 id…", description: "列表里没有时使用" },
            ],
            onPick: (v) => {
              closeOverlay();
              if (v === "__manual") openInputOverlay("模型 id", draft.model ?? "", (mv) => { draft.model = mv; testAndSave(); });
              else {
                draft.model = v;
                testAndSave();
              }
            },
            onCancel: closeOverlay,
          });
          openOverlay(picker, 86);
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          push(fg("31", ` ✗ 拉取失败：${msg}——改用手动输入模型 id`), "");
          refresh();
          openInputOverlay("模型 id（拉取失败，可手输）", draft.model ?? "", (mv) => {
            draft.model = mv;
            testAndSave();
          });
        });
    };
    const testAndSave = (): void => {
      if (!draft.baseUrl || !draft.apiKey || !draft.model) return;
      push(dim(`  测试连接中（${draft.model}）…`), "");
      refresh();
      void testBuilder(draft as BuilderConfig)
        .then(() => {
          saveBuilder(draft as BuilderConfig); // 平台与 Krystal Bot 共用同一份凭据
          // 模型分离：Bot 有自己的默认模型 → 保持；没有 → 用这次登录选的（平台设好了这边自动有）
          cfg = { baseUrl: draft.baseUrl!, apiKey: draft.apiKey!, model: loadBotModel() ?? draft.model! };
          modelLine = cfg.model;
          push(dim(`  已保存（凭据与平台共用）：${cfg.baseUrl} · ${maskKey(cfg.apiKey)} · Bot 模型 ${cfg.model}`), "");
          refresh();
        })
        .catch((e: unknown) => {
          const msg = e instanceof Error ? e.message : String(e);
          push(fg("31", ` ✗ 测试未通过（未保存）：${msg}`), "");
          refresh();
        });
    };
    if (cfg) {
      const picker = new ListOverlay({
        title: "Platform API（/login · 已配置）",
        hint: "enter 确认 · esc 取消",
        items: [{ value: "edit", label: "重新配置", description: `${cfg.baseUrl} · ${maskKey(cfg.apiKey)} · 平台模型 ${cfg.model}` }],
        onPick: () => {
          closeOverlay();
          showProvider();
        },
        onCancel: closeOverlay,
      });
      openOverlay(picker, 86);
    } else showProvider();
  };

  const headerComp: Component = {
    render(w: number): string[] {
      const inner = Math.max(10, w - 2);
      const side = w >= LOGO_WIDTH + 46;
      const tag = [
        "",
        ` ${bold("原生成员")} ${dim("· 写作者 · 原型")}`,
        dim(` ${modelLine}`),
        dim(` ${cwd}`),
        "",
      ];
      const out = [dim("╭" + "─".repeat(inner) + "╮")];
      for (let r = 0; r < LOGO_ROWS.length; r++) {
        const logo = fg(KRYSTAL_GRADIENT[r]!, LOGO_ROWS[r]!);
        const content = side ? ` ${pad(logo, LOGO_WIDTH)}  ${tag[r] ?? ""}` : ` ${logo}`;
        out.push(dim("│") + pad(truncateToWidth(content, inner, "…"), inner) + dim("│"));
      }
      out.push(dim("╰" + "─".repeat(inner) + "╯"));
      return out;
    },
    invalidate(): void {},
  };
  const statusComp: Component = {
    render(w: number): string[] {
      const cs = contextStatus(usage ? usage.prompt : tokens, cfg?.model ?? "");
      const ctx = cs.pct;
      // provider 普遍不报（GLM 实测恒为 0）→ 报 0 时显示「—」而不是误导性的 0%
      const cache = usage && usage.cached > 0 ? `${Math.round((usage.cached / usage.prompt) * 100)}%` : "—";
      const tok = usage ? `${usage.prompt} tok` : `~${tokens.toFixed(0)} tok`;
      const pfx = prefixStable === undefined ? "前缀 —" : prefixStable ? "前缀 稳定" : "前缀 变化";
      const sid = sessionName ? `${sessionName}` : sessionId.replace(/^bot-/, "").slice(0, 15);
      const extra = `${foldCount ? `折叠 ${foldCount} · ` : ""}${summaryActive ? "摘要 有 · " : ""}`;
      const ctxText = cs.level === "ok" ? dim(cs.label) : cs.level === "fold" ? fg(BLUE_LIGHT, cs.label) : bold(fg(BLUE_LIGHT, `${cs.label} ▲`));
      const seg = `${sid} · ${busy ? state : "空闲"} ${ctxText} · 缓存 ${cache} · ${pfx} · ${extra}${tok} · /resume 回溯 · /model 模型 · /login API`;
      return [truncateToWidth(` ${seg} ${dim("· esc 中断 · ctrl+c 退出")}`, w)];
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

  // 流动块：思考/回答各自一个多行组件，delta 原地增长
  let streamItem: StreamText | undefined;
  let streamKind: "thinking" | "text" | null = null;
  let currentTool: ToolBlock | undefined;
  const beginStream = (prefix: string, style: (s: string) => string) => {
    if (streamKind) closeStream();
    streamItem = new StreamText(prefix, style);
    push(streamItem);
    streamKind = prefix ? "thinking" : "text";
  };
  const streamTo = (delta: string) => {
    streamItem?.append(delta);
    refresh();
  };
  const closeStream = () => {
    streamItem = undefined;
    streamKind = null;
  };
  /** 分段之间留一空行（pi 的做法：思考/工具/回答 各自成段） */
  const ensureGap = () => {
    const last = transcript.items[transcript.items.length - 1];
    if (transcript.items.length > 0 && last !== "") push("");
  };

  const onEvent = (e: BotEvent) => {
    switch (e.type) {
      case "thinking":
        state = "思考中";
        if (streamKind !== "thinking") {
          ensureGap();
          beginStream("· thinking ", (t) => dim(t));
        }
        tokens += e.delta.length / 4;
        streamTo(e.delta);
        break;
      case "text":
        state = "回答中";
        if (streamKind !== "text") {
          ensureGap();
          beginStream("", (t) => t);
        }
        tokens += e.delta.length / 4;
        streamTo(e.delta);
        break;
      case "tool_args": {
        // 工具参数流式显示：块在参数生成时就出现（不再等生成完才有动静）
        state = "工具 " + e.name;
        if (!currentTool) {
          closeStream();
          ensureGap();
          currentTool = new ToolBlock(e.name, e.argsSoFar);
          push(currentTool);
        } else {
          currentTool.args = new ToolBlock(e.name, e.argsSoFar).args;
        }
        tokens += e.argsSoFar.length / 40;
        refresh();
        break;
      }
      case "tool_start": {
        state = "工具 " + e.name;
        if (!currentTool) {
          closeStream();
          ensureGap();
          currentTool = new ToolBlock(e.name, e.args);
          push(currentTool);
        } else {
          currentTool.args = new ToolBlock(e.name, e.args).args;
        }
        break;
      }
      case "tool_result": {
        currentTool?.setResult(e.ok, e.denied, e.output);
        currentTool = undefined;
        appendEvent(sessionId, {
          t: "msg",
          at: new Date().toISOString(),
          role: "tool",
          content: (e.denied ? "[策略闸门拒绝] " : "") + e.output,
          toolCallId: e.id,
        });
        refresh();
        break;
      }
      case "retry": {
        closeStream();
        state = `重试 ${e.attempt}/${e.max}`;
        push(
          dim(
            `  ⟳ ${e.reason} —— ${Math.round(e.waitMs / 1000)} 秒后重试（第 ${e.attempt + 1}/${e.max} 次）`,
          ),
          "",
        );
        refresh();
        break;
      }
      case "context": {
        if (e.stage === "summarizing") {
          state = "整理早期摘要";
          push(dim("  ⟳ 上下文接近上限，正在压缩早期对话为摘要（原文保留在事件流）…"), "");
        } else if (e.stage === "summarize_failed") {
          push(dim("  · 摘要生成失败（本轮不压缩；原文仍在事件流，可 /resume 回溯）"), "");
        } else {
          foldCount = e.folded ?? 0;
          if (foldCount) push(dim(`  · 已折叠 ${foldCount} 条旧工具输出（原文保留，可 /resume 回溯）`));
        }
        refresh();
        break;
      }
      case "summary": {
        summaryActive = true;
        appendEvent(sessionId, { t: "note", at: new Date().toISOString(), text: e.text });
        push(dim("  · 早期对话已压缩为摘要（prefix 变化一次后重新稳定）"), "");
        refresh();
        break;
      }
      case "assistant": {
        appendEvent(sessionId, {
          t: "msg",
          at: new Date().toISOString(),
          role: "assistant",
          content: e.content,
          toolCalls: e.toolCalls,
        });
        break;
      }
      case "usage": {
        usage = { prompt: e.prompt, cached: e.cached, completion: e.completion };
        appendEvent(sessionId, {
          t: "usage",
          at: new Date().toISOString(),
          prompt: e.prompt,
          cached: e.cached,
          completion: e.completion,
          model: cfg?.model ?? "",
        });
        break;
      }
      case "final": {
        // 流式原始行 → Markdown 渲染块（与 pi 的回答观感一致）
        const streamed = streamItem; // 先留引用：closeStream 会清空
        closeStream();
        state = "完成";
        if (e.text.trim()) {
          const idx = streamed ? transcript.items.indexOf(streamed) : -1;
          if (idx >= 0) transcript.items.splice(idx, 1);
          if (streamed) transcript.forget(streamed); // 释放旧流式块的缓存（其内容由 Markdown 块接管）
          push(new Markdown(e.text, 1, 0, BOT_THEME));
          push("");
        }
        appendEvent(sessionId, { t: "msg", at: new Date().toISOString(), role: "assistant", content: e.text });
        touchSession(sessionId);
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
    // 每回合从事件流装配上下文：只追加、顺序稳定 → 前缀缓存友好（§13.2）
    const events = loadEvents(sessionId);
    checkPrefix(events.filter((e) => e.t === "msg"));
    void runBotTask({ cfg, cwd, events, signal: abort.signal, onEvent });
  };

  editor.onSubmit = (text: string) => {
    if (busy || !cfg) return;
    const body = text.trim();
    if (!body) return;
    // 命令前缀 / 与 : 等价（平台约定）；未知命令只提示，绝不发给模型
    if (body.startsWith("/") || body.startsWith(":")) {
      const cmd = body.slice(1).trim().toLowerCase();
      clearEditor();
      if (cmd === "resume" || cmd === "sessions") openSessionsPicker();
      else if (cmd.startsWith("name")) {
        const nm = body.slice(body.indexOf("name") + 4).trim();
        if (!nm) {
          push(dim(`  当前会话名：${sessionName ?? "（未命名）"}  用法：/name <名称>`), "");
        } else {
          const m = renameSession(sessionId, nm);
          sessionName = m?.name;
          if (m) push(dim(`  会话已命名为「${m.name}」（历史列表 /resume 里可见）`), "");
          else push(fg("31", "  命名失败（会话元数据不可写）"), "");
        }
        refresh();
      }
      else if (cmd === "new") {
        sessionId = createBotSession({ cwd, model: cfg.model, tier: "写作者" }).id;
        transcript.items = [...pushIntro(cfg.model, cwd), ""];
        transcript.invalidate();
        usage = undefined;
        prevHistory = undefined;
        prefixStable = undefined;
        foldCount = 0;
        summaryActive = false;
        push(dim("  新会话已开始"), "");
        refresh();
      } else if (cmd === "model") {
        openModelPicker();
        return;
      } else if (cmd === "login") {
        openLoginFlow();
        return;
            } else if (cmd === "memory" || cmd === "mem") {
        const g = renderGraph();
        push("", ...g.lines.map((l) => (l.startsWith("●") || l.startsWith("○") ? fg("36", l) : dim(l))), "");
        refresh();
      } else if (cmd === "help") {
        push(
          dim("  /resume 回溯历史（选中后按两次 d 删除）· /name <名称> 命名会话 · /model 模型 · /login 配置 API · /memory 记忆图 · /new 新会话 · esc 中断 · ctrl+c 退出"),
          "",
        );
        refresh();
      } else {
        push(dim(`  未知命令 ${body}（可用 /resume · /name · /model · /login · /memory · /new · /help）`), "");
        refresh();
      }
      return;
    }
    clearEditor();
    // pi 风格：消息以「整宽蓝色背景块」落入对话区（块后留一空行）
    push(new UserBlock(body), "");
    appendEvent(sessionId, { t: "msg", at: new Date().toISOString(), role: "user", content: body });
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
      if (overlayKeys) {
        overlayKeys(data); // 弹层打开 → 按键全给它（含 esc 关闭，不会退回主页面）
        tui.requestRender();
        return;
      }
      if (matchesKey(data, "escape")) {
        if (false) {
          // 兼容占位（已由上方 overlayKeys 处理）
        }
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

  // 启动时：MEMORY.md 若比真源新（人改过）→ 导入（备份 + 保守降级）
  const imp = importMirror();
  if (imp.imported || imp.added) push(dim(`  · 已从 MEMORY.md 导入：更新 ${imp.imported} 条、新增 ${imp.added} 条`), "");

  if (!cfg) push(fg("31", " ✗ 未配置平台模型——esc 返回首页，先到 Platform model 配置"));

  // 滚动区与状态行之间的固定空行：内容（思考/工具块）不再贴着输入框上沿
  const gapComp: Component = {
    render(): string[] {
      return [""];
    },
    invalidate(): void {},
  };

  tui.setLayoutRoot(
    new VStack([
      { component: scroll, basis: 0, grow: 1, minSize: 1 },
      { component: gapComp, basis: 1 },
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
