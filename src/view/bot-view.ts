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
import { BG_BLUE, BLUE_LIGHT, bold, chip, dim, fg } from "../ui/ansi.ts";
import { KRYSTAL_GRADIENT, LOGO_ROWS, LOGO_WIDTH } from "../ui/logo.ts";
import { fetchModelInfos, loadBotModel, loadBuilder, maskKey, nextApiKey, PROVIDER_PRESETS, saveBuilder, setBotModel, testBuilder, type BuilderConfig, type ModelInfo } from "../builder.ts";
import { activeFacts, importMirror, lastSleepError, loadFacts, renderGraph, sleepMemories, undoLastSleep, type SleepMarks } from "../memory.ts";
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
import { CommandProvider, commandNames, helpLines } from "../ui/commands.ts";
import {
  appendDivertEvent,
  createDivert,
  divertContext,
  divertEvents,
  listDiverts,
  settleStaleDiverts,
  toDivertEvent,
  updateDivert,
} from "../divert.ts";
import { SubsessionBlock, createDivertPrompt } from "./subsession.ts";
import { FarewellBlock, FAREWELL } from "./farewell-block.ts";
import {
  buildTimeline,
  eulogyPath,
  lifeScale,
  timelineLines,
  loadEulogy,
  recallFromPrevLife,
  truncateBySentence,
  validateEulogy,
  writeEulogy,
} from "../farewell.ts";
import { createTextSegment, type TextSegment } from "./stream-seg.ts";

const BLUE = BLUE_LIGHT; // 平台常量 38;5;45（浅蓝前景）——写成 "45" 会变成洋红背景
const THEME = {
  selectedPrefix: (t: string) => fg("36", t),
  selectedText: (t: string) => bold(t),
  description: (t: string) => dim(t),
  scrollInfo: (t: string) => dim(t),
  noMatch: (t: string) => fg("33", t),
};
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

/** 端点短标签：域名（本地带端口）——列表头写清「这一屏是哪家的模型」 */
export const endpointLabel = (baseUrl: string): string => {
  try {
    const u = new URL(baseUrl);
    return u.port ? `${u.hostname}:${u.port}` : u.hostname;
  } catch {
    return baseUrl;
  }
};

/** 与主 app 同源：pi-tui 的 Editor 自己画上下两条线，颜色由 borderColor 决定（重画会被渲染层吃掉） */
export const EDITOR_THEME: EditorTheme = { borderColor: (s: string) => fg(BLUE, s), selectList: THEME };
/** 补全列表一屏显示几条（pi 默认值：autocompleteMaxVisible ?? 5，pi 里是 /settings 可调项，范围 3-20）
 *  剩下的靠 ↑↓ 滚动，列表底部自带位置指示 `(3/10)`（pi-tui SelectList 内置，不用自己画） */
export const AUTOCOMPLETE_MAX_VISIBLE = 5;

const rule = (w: number, color = "36") => fg(color, "─".repeat(Math.max(0, w - 2)));

type Line = string;

/** 与 pi 一致：回答用 Markdown 渲染（pi-tui 自带组件） */
export const BOT_THEME: MarkdownTheme = {
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
  private static revOf(it: string | Component): number | string | symbol {
    if (typeof it === "string") return it;
    const v = it as { rev?: number; volatile?: boolean };
    // volatile 组件（闪烁/扫光等逐帧变化的活行）：每次返回唯一键 → 永不命中缓存
    if (v.volatile) return Symbol("volatile");
    return v.rev ?? 0;
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

// ── 工具调用 · 圆点样式（水晶语言）：点管状态，一行管信息，diff 是唯一展开的内容
//    pending：●↔○ 冰蓝闪烁（600ms 相位，工作计时器驱动）· ok：蓝点 · denied/error：玫点
//    展开：仅 edit_file 出 diff（旧行玫、新行绿，全 dim，上限 6 行）；write_file 给 +N 行；
//    run_command 给前 2 行输出；read_file/list_dir 只有一行（内容本来就在编辑器里）
export const DOT_PEND = "38;5;117";
export const DOT_ROSE = "38;5;218";
const DIFF_ADD = "38;5;71";
const DIFF_DEL = "38;5;218";
let toolBlink = false; // 由工作计时器翻转（每 4 tick = 600ms）

export class ToolBlock implements Component {
  name: string;
  /** 渲染版本号：内容变化时 +1（Transcript 缓存据此只重算这一项） */
  rev = 0;
  private summary: string;
  private state = "pending";
  private parsed: Record<string, unknown> | undefined;
  private detail: { kind: "out" | "del" | "add"; text: string }[] = [];
  private note = "";

  constructor(name: string, args: string) {
    this.name = name;
    this.args = args;
  }

  get args(): string {
    return this.summary;
  }
  /** pending 态逐帧重渲（圆点闪烁）；完成后恢复缓存 */
  get volatile(): boolean {
    return this.state === "pending";
  }
  /** 传入原始 args JSON：重新提取摘要（修正流式半截 JSON）+ 重算 diff 源数据 */
  set args(raw: string) {
    try {
      this.parsed = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      /* 流式半截：沿用旧 parsed，摘要回退原文 */
    }
    const p = this.parsed;
    const str = (k: string) => String(p?.[k] ?? "");
    if (p) {
      if (this.name === "run_command") this.summary = str("command").slice(0, 56) || "…";
      else if (this.name === "memory") this.summary = str("op") + (p.query ? ` · ${str("query").slice(0, 20)}` : "");
      else this.summary = str("path") || str("command").slice(0, 40) || str("raw").slice(0, 40) || "…";
    } else if (!this.summary) {
      this.summary = raw.replace(/^[{"\s]+|[}"\s]+$/g, "").slice(0, 48) || "…";
    }
    this.rev++;
  }

  setResult(ok: boolean, denied: boolean, output: string): void {
    this.state = denied ? "denied" : ok ? "ok" : "error";
    const lines = output.split("\n").filter((l) => l.trim() !== "");
    if (denied) {
      this.summary += " · 被闸门拦截";
      this.detail = lines.slice(0, 2).map((l) => ({ kind: "out" as const, text: l }));
    } else if (this.name === "read_file") {
      this.summary += ` · ${lines.filter((l) => !l.startsWith("…(")).length} 行`;
    } else if (this.name === "list_dir") {
      this.summary += ` · ${lines.length} 项`;
    } else if (this.name === "run_command") {
      this.detail = lines.slice(0, 2).map((l) => ({ kind: "out" as const, text: l }));
      if (lines.length > 2) this.note = `… +${lines.length - 2} 行`;
    } else if (this.name === "edit_file") {
      const oldL = String(this.parsed?.oldText ?? "").split("\n").filter((l) => l !== "");
      const newL = String(this.parsed?.newText ?? "").split("\n").filter((l) => l !== "");
      let s = 0;
      while (s < oldL.length && s < newL.length && oldL[s] === newL[s]) s++;
      let eo = oldL.length, en = newL.length;
      while (eo > s && en > s && oldL[eo - 1] === newL[en - 1]) { eo--; en--; }
      const dels = oldL.slice(s, eo), adds = newL.slice(s, en);
      this.summary += ` · ${fg(DIFF_ADD, `+${adds.length}`)} ${fg(DIFF_DEL, `−${dels.length}`)}`;
      this.detail = [...dels.map((t) => ({ kind: "del" as const, text: t })), ...adds.map((t) => ({ kind: "add" as const, text: t }))].slice(0, 6);
      if (dels.length + adds.length > 6) this.note = `… +${adds.length} −${dels.length} 行（完整 diff 在会话文件里）`;
    } else if (this.name === "write_file") {
      this.summary += ` · +${String(this.parsed?.content ?? "").split("\n").length} 行`;
    } else {
      this.summary += lines[0] ? ` · ${lines[0].slice(0, 40)}` : "";
    }
    this.rev++;
  }

  render(w: number): string[] {
    const dot =
      this.state === "pending"
        ? toolBlink ? dim("○") : fg(DOT_PEND, "●")
        : this.state === "denied" || this.state === "error"
          ? fg(DOT_ROSE, "●")
          : fg(BLUE, "●");
    const head = `  ${dim("╰─")} ${dot} ${bold(this.name)} ${dim(this.summary)}`;
    const body = this.detail.map((d) =>
      "      " + (d.kind === "del" ? fg(DIFF_DEL, dim("− " + d.text)) : d.kind === "add" ? fg(DIFF_ADD, dim("+ " + d.text)) : dim(d.text)),
    );
    if (this.note) body.push("    " + dim(this.note));
    return [head, ...body].map((l) => truncateToWidth(l, w, ""));
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
  const editor = new Editor(tui, EDITOR_THEME, { autocompleteMaxVisible: AUTOCOMPLETE_MAX_VISIBLE });
  // 输入 `/`（或 `:`）即弹出全部命令（与 pi 同款：pi-tui 的 SelectList，命令表见 ui/commands.ts）
  // 一屏只列 AUTOCOMPLETE_MAX_VISIBLE 条，其余 ↑↓ 滚动（与 pi 同款，不像铺满屏占地方）
  editor.setAutocompleteProvider(new CommandProvider());
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
  let sleeping = false; // /sleep 进行中（活行：圆点闪烁 + sleeping 扫光）
  let state = cfg ? "空闲" : "未配置";
  let turnThinking = ""; // 本回合累积的思考原文（落盘 + /resume 重放）
  let tokens = 0;
  // 主会话的中断控制器：**每回合重建**（AbortController 一旦 abort 就永久失效，
  // 旧写法全局只建一次 → esc 每个进程只能中断第一次，之后再按都不生效）
  let abort = new AbortController();

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

  /** §13：让新生认得出上一世（只读；不改 system、不动前缀） */
  const lifeLines = (): string[] => {
    const meta = loadBotMeta(sessionId);
    const life = meta?.life ?? 1;
    const out: string[] = [dim(`  ·  这是第 ${life} 世。`)];
    if (meta?.prev) {
      const prevFacts = recallFromPrevLife(meta.prev, loadEvents(meta.prev), loadFacts());
      if (prevFacts.length) {
        const items = prevFacts
          .map((f) => `${f.text.slice(0, 36)}${f.evidence ? `（${f.evidence}）` : ""}`)
          .join(" · ");
        out.push(dim(`  ·  上一世我记得：${items}`));
      }
    }
    return out;
  };
  const introWithLife = (model: string, sessionCwd: string): string[] => [...pushIntro(model, sessionCwd), ...lifeLines()];

  /** 从事件流重建对话区（新会话为空；/resume 切换会话时复用） */
  const rebuild = (id: string) => {
    const toolById = new Map<string, ToolBlock>();
    const evs = loadEvents(id);    const intro = evs.find((e) => e.t === "intro");
    const meta = loadBotMeta(id);
    if (intro && intro.t === "intro") {
      transcript.items.push(...introWithLife(cfg?.model ?? intro.model, intro.cwd), "");
    } else if (meta) {
      // 旧会话（本次改动前建的）没有 intro 事件 → 补渲染并回填落盘
      transcript.items.push(...introWithLife(cfg?.model ?? meta.model, meta.cwd), "");
      appendEvent(id, { t: "intro", at: new Date().toISOString(), cwd: meta.cwd, model: meta.model, tier: meta.tier });
    }
    // ── 旁路块：按 afterSeq **原位插回**（进程被杀遗留的 running → 判为中断，不猜内容）
    settleStaleDiverts(id);
    const pending = listDiverts(id);
    const flushDiverts = (processed: number) => {
      while (pending.length > 0 && pending[0]!.afterSeq <= processed) {
        const d = pending.shift()!;
        const b = new SubsessionBlock({ id: d.id, task: d.task });
        b.loadFrom(divertEvents(id, d.id));
        b.setStatus(d.status);
        transcript.items.push(b, "");
      }
    };
    let seq = 0;
    for (const e of evs) {
      if (e.t === "msg" && e.role === "user") transcript.items.push(new UserBlock(e.content), "");
      else if (e.t === "msg" && e.role === "assistant") {
        if (e.thinking) {
          // 思考重放：与直播时同观感（dim + 前缀），pi 式「历史思考可见」
          const tb = new StreamText("· thinking ", (t) => dim(t));
          tb.append(e.thinking);
          transcript.items.push(tb, "");
        }
        // 顺序与直播一致：先说（中段答复）再调工具
        if (e.content.trim()) transcript.items.push(new Markdown(e.content, 1, 0, BOT_THEME), "");
        if (e.toolCalls?.length) {
          for (const tc of e.toolCalls) {
            const b = new ToolBlock(tc.name, tc.args);
            toolById.set(tc.id, b);
            transcript.items.push(b);
          }
        }
      } else if (e.t === "msg" && e.role === "tool") {
        const b = e.toolCallId ? toolById.get(e.toolCallId) : undefined;
        const denied = e.content.startsWith("[策略闸门拒绝]");
        b?.setResult(!denied, denied, e.content.replace(/^\[策略闸门拒绝\] /, ""));
      }
      flushDiverts(++seq);
    }
    flushDiverts(evs.length);

    // §7：这一世若告别过 → 把放映块重放出来（它在生命的最末尾，位置本来就对）
    // 只重放**散文**（时间线已在 eulogy.md 里；展开态可对照），不参与任何写盘
    const eu = loadEulogy(id);
    if (eu) {
      const tl = buildTimeline(evs, loadFacts());
      const b = new FarewellBlock({ timeline: tl, scale: lifeScale(tl), eulogyFile: eulogyPath(id) });
      b.freeze(eu.prose);
      transcript.items.push(b, "");
    }
  };
  if (resumed) rebuild(sessionId);
  else {
    // 开场画像（hermes 式 Braille 点阵）：作为滚动流的第一条 → 一用起来就自然滚走
    transcript.items.push(...introWithLife(cfg?.model ?? "（未配置）", cwd), "");
    appendEvent(sessionId, { t: "intro", at: new Date().toISOString(), cwd, model: cfg?.model ?? "", tier: "写作者" });
  }
  /** 回溯历史（/resume）：清空对话区并重放所选会话 */
  const resumeSession = (id: string) => {
    abortMain(); // 切走前级联中断旁路：否则它们会往旧会话目录里写事件
    runningDiverts.clear();
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
      transcript.items = [...introWithLife(cfg?.model ?? "", cwd), ""];
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
  /** 通用输入弹层：标题 + 可选说明 + 单行输入（enter 提交 · esc 取消）
   *  allowEmpty：允许空值提交（本地服务无 key / 「留空保持不变」都需要它） */
  const openInputOverlay = (
    title: string,
    prefill: string,
    onSubmit: (v: string) => void,
    opts: { allowEmpty?: boolean; hint?: string } = {},
  ): void => {
    const input = new Input();
    if (prefill) input.setValue(prefill);
    input.onSubmit = (v: string) => {
      const val = (v ?? input.getValue()).trim();
      if (!val && !opts.allowEmpty) return;
      closeOverlay();
      onSubmit(val);
    };
    input.onEscape = () => closeOverlay();
    const panel: Component = {
      // 标题/说明都要截断：外框只补齐不定宽，超宽会把框撞破
      render: (w: number) => [
        bold(truncateToWidth(` ${title}`, w, "…")),
        ...(opts.hint ? [dim(truncateToWidth(` ${opts.hint}`, w, "…"))] : []),
        "",
        ...input.render(Math.max(24, w - 4)),
      ],
      handleInput: (d: string) => input.handleInput(d),
      invalidate: () => input.invalidate(),
    };
    openOverlay(panel, 64);
  };

  // ── 旁路会话（/divert）：人按的一次性派发
  //    定位：输入框永远属于主会话；主会话的 prompt / 工具清单 / events **完全不知道它存在**（连 append 都不做）。
  //    上下文：主会话前缀（按引用切片，不复制）⊕ 自己的 delta → 首次调用命中前缀缓存（见 divert.ts）
  //    渲染：块 + 嵌套 Transcript，与主会话流状态完全隔离（见 view/subsession.ts）
  const runningDiverts = new Map<string, { block: SubsessionBlock; abort: AbortController }>();

  /** 主会话终结的**唯一出口**：esc / /new / /resume 切走 / ctrl+c 退出 都必须走它 —— 否则会留下孤儿旁路 */
  const abortMain = (): void => {
    abort.abort();
    for (const { abort: a } of runningDiverts.values()) a.abort();
  };

  /** /stop：只中断旁路（主会话不受影响） */
  const stopDiverts = (): void => {
    const n = runningDiverts.size;
    for (const { abort: a } of runningDiverts.values()) a.abort();
    push(dim(n ? `  已中断 ${n} 个旁路会话` : "  当前没有在跑的旁路会话"), "");
    refresh();
  };

  /** 派发一个旁路（task 来自弹窗，或 `/divert <任务>` 直接给） */
  const dispatchDivert = (task: string): void => {
    if (!cfg) return;
    // 捕获父会话 id：之后用户可能 /new 或 /resume 切走，事件必须仍写回**派发时**的那个会话目录
    const parent = sessionId;
    const mainEvents = loadEvents(parent); // 前缀长度 = 重播插入位置（同一个数字，不加概念）
    const d = createDivert({ parent, task, model: cfg.model, afterSeq: mainEvents.length });
    appendDivertEvent(parent, d.id, { t: "msg", at: new Date().toISOString(), role: "user", content: task });
    const block = new SubsessionBlock({ id: d.id, task, blink: () => toolBlink });
    if (transcript.items.length > 0 && transcript.items[transcript.items.length - 1] !== "") push("");
    transcript.items.push(block, "");
    const ac = new AbortController();
    runningDiverts.set(d.id, { block, abort: ac });
    refresh();

    let think = ""; // 本段思考（归属到下一个 assistant 事件，与主会话同规则）
    const settle = (status: "done" | "aborted" | "failed") => {
      updateDivert(parent, d.id, { status });
      runningDiverts.delete(d.id);
      refresh();
    };
    void runBotTask({
      cfg,
      cwd,
      events: divertContext(parent, d.id), // 主会话前缀 ⊕ 自己（含刚写的任务）
      signal: ac.signal,
      onEvent: (e: BotEvent) => {
        block.feedLive(e);
        if (e.type === "thinking") think += e.delta; // 思考增量不单独落盘：随 assistant/final 一起存
        const ev = toDivertEvent(e, { model: cfg.model, thinking: think });
        if (ev) appendDivertEvent(parent, d.id, ev);
        if (e.type === "assistant" || e.type === "final") think = "";
        if (e.type === "final") settle("done");
        else if (e.type === "error") settle(e.message.includes("已中断") ? "aborted" : "failed");
        refresh();
      },
    });
  };

  /** /divert 弹窗：输入框上方的任务输入（内嵌编辑器，与主输入框同款两条浅蓝线） */
  const openDivertPopup = (): void => {
    if (!cfg) {
      push(fg("31", " ✗ 未配置平台模型——先到 Platform model 配置"), "");
      refresh();
      return;
    }
    openOverlay(
      createDivertPrompt(tui, {
        theme: EDITOR_THEME,
        onSubmit: (task: string) => {
          closeOverlay();
          dispatchDivert(task);
        },
        onCancel: closeOverlay,
      }),
      80,
    );
  };

  // ── 告别仪式（/farewell）：确认 → 临终一轮 → 放映（逐字吐出）→ 落盘 → 重生
  //    设计：docs/memory-farewell.md。时间线由代码机械生成（全、可核对）；散文由模型写（温度）。
  let farewellTimer: ReturnType<typeof setInterval> | undefined;
  const stopFarewell = (): void => {
    if (farewellTimer) clearInterval(farewellTimer);
    farewellTimer = undefined;
  };

  /** 确认弹窗：**代价可见**（不可逆＝换会话），列表选择而非敲 yes */
  const openFarewellConfirm = (): void => {
    if (!cfg) {
      push(fg("31", " ✗ 未配置平台模型——先到 Platform model 配置"), "");
      refresh();
      return;
    }
    if (busy) {
      push(dim("  主会话正在跑——先 esc 中断，再告别"), "");
      refresh();
      return;
    }
    if (runningDiverts.size > 0) {
      push(dim(`  还有 ${runningDiverts.size} 个旁路在跑——先 /stop，再告别`), "");
      refresh();
      return;
    }
    const picker = new ListOverlay({
      title: "告别这一世",
      hint: "↑↓ 选择 · enter 确认 · esc 取消",
      items: [
        {
          value: "go",
          label: "继续告别",
          description: "写下一段告别（模型）+ 完整时间线（机械生成），然后开新的一世",
        },
        { value: "cancel", label: "取消", description: "什么都不做（想先巩固记忆：esc 后跑一次 /sleep）" },
      ],
      onPick: (v) => {
        closeOverlay();
        if (v === "go") void runFarewell();
      },
      onCancel: closeOverlay,
    });
    openOverlay(picker, 84);
  };

  /** 档位/长度/门槛算好后写进临终指令；工具调用保留（写记忆库是“托付”的来源） */
  const dyingInstruction = (timeline: ReturnType<typeof buildTimeline>, scale: ReturnType<typeof lifeScale>): string =>
    [
      "〔告别仪式〕这一世的上下文要结束了。请为本世写一段告别。",
      `- 只写**一段连贯的散文**（不要项目符号列表），${scale.minChars}–${scale.maxChars} 字`,
      `- 至少引用 ${scale.minQuotes} 句**我说过的原话**（下面时间线里 who=你 的条目）`,
      timeline.open.length ? `- 有 ${timeline.open.length} 件未完成的事，必须说出来` : "- 没有未完成的事，不必编",
      `- 至少提到 ${scale.minBequests} 条你写进记忆库的事实，并说“下一世我会先想起来”`,
      "- 不要客套模板（“谢谢你的陪伴”之类，放进别人的告别也成立的话）；不要技术流水账；最后不要写“我熄灯了”（那行由平台落）",
      "",
      "本世时间线（机械生成，可核对）：",
      `统计：${timeline.stats}`,
      ...timelineLines(timeline).slice(0, 80).map((l) => `${l.at}  ${l.who}  ${l.text}`),
    ].join("\n");

  /** 临终一轮 → 放映 → 落盘 → 重生 */
  const runFarewell = async (): Promise<void> => {
    if (!cfg) return;
    const parent = sessionId; // 捕获：稍后会换会话
    const timeline = buildTimeline(loadEvents(parent), loadFacts());
    const scale = lifeScale(timeline);
    const block = new FarewellBlock({ timeline, scale });
    if (transcript.items.length > 0 && transcript.items[transcript.items.length - 1] !== "") push("");
    transcript.items.push(block, "");
    busy = true;
    state = "告别中";
    abort = new AbortController();
    refresh();

    // 仪式自己的时钟：扫光与吐字都由它推进（**不挂 busy 条件** —— 正是“旁路圆点不闪”那个坑）
    let acc = "";
    let settled = false;
    stopFarewell();
    farewellTimer = setInterval(() => {
      block.advance(50);
      if (!settled && block.frozen) {
        settled = true;
        stopFarewell();
        settleFarewell(parent, block, timeline, scale);
      }
      refresh(); // 块在长高 → 必须重算滚动布局（只 requestRender 会让新行落不进视口）
    }, 50);
    farewellTimer.unref?.();

    // 临终一轮：指令走 **user 消息（尾巴）**，SYSTEM 一字不动 → 前缀缓存零影响
    appendEvent(parent, { t: "msg", at: new Date().toISOString(), role: "user", content: dyingInstruction(timeline, scale) });
    await runBotTask({
      cfg,
      cwd,
      events: loadEvents(parent),
      signal: abort.signal,
      onEvent: (e: BotEvent) => {
        if (e.type === "text") {
          acc += e.delta;
          block.setProse(acc); // 队列增长；吐字由时钟按节拍消费
          refresh();
        } else if (e.type === "assistant") {
          appendEvent(parent, {
            t: "msg",
            at: new Date().toISOString(),
            role: "assistant",
            content: e.content,
            toolCalls: e.toolCalls,
          });
        } else if (e.type === "tool_result") {
          appendEvent(parent, {
            t: "msg",
            at: new Date().toISOString(),
            role: "tool",
            content: (e.denied ? "[策略闸门拒绝] " : "") + e.output,
            toolCallId: e.id,
          });
        } else if (e.type === "usage") {
          appendEvent(parent, { t: "usage", at: new Date().toISOString(), prompt: e.prompt, cached: e.cached, completion: e.completion, model: cfg.model });
        } else if (e.type === "final") {
          if (!acc.trim() && e.text.trim()) {
            acc = e.text; // 兜底：模型没走流式增量（少见）
            block.setProse(acc);
          }
        } else if (e.type === "error") {
          // 降级必须可见：不假装写出了告别
          acc = `（这一世的告别没能写出来——临终一轮失败：${e.message}。时间线在展开里。）`;
          block.setProse(acc);
          push(fg("31", ` ✗ 临终一轮失败：${e.message}`), "");
          refresh();
        }
      },
    });
    // 模型回合结束 → 散文定稿（校准流式尾部差异）；之后时钟继续吐完并定格
    if (!acc.trim()) {
      acc = "（这一世的告别没能写出来——临终一轮没有产出。时间线在展开里。）";
      block.setProse(acc);
    } else {
      block.setProse(acc.trim());
    }
    touchSession(parent);
    state = "告别中";
    refresh();
  };

  /** 定格之后：写 eulogy.md（人可读、可审计）→ 停一下 → 重生 */
  const settleFarewell = (
    parent: string,
    block: FarewellBlock,
    timeline: ReturnType<typeof buildTimeline>,
    scale: ReturnType<typeof lifeScale>,
  ): void => {
    const prose = block.proseText;
    // 兜底：散文为空（不该发生——skip 已被拦住、回合结束会塞 fallback）→ 不写空遗嘱、不重生
    if (!prose.trim()) {
      push(dim("  · 告别没有产出（散文为空）——本次不写遗嘱、也不重生；可再试一次 /farewell"), "");
      stopFarewell();
      busy = false;
      state = "空闲";
      refresh();
      return;
    }
    const check = validateEulogy(prose, { timeline, scale, facts: loadFacts() });
    const file = writeEulogy({
      at: new Date().toISOString(),
      sessionId: parent,
      model: cfg?.model ?? "",
      prose,
      timeline,
      check,
    });
    block.eulogyFile = file;
    refresh();
    // 校验未过是**给人看**的（机器只筛掉假的；真的动人由人打分）
    if (!check.ok) push(dim(`  · 告别校验：${check.problems.length} 项待人工复核（已写进遗嘱）`), "");
    const life = (loadBotMeta(parent)?.life ?? 1) + 1;
    setTimeout(() => rebirth(parent, life), FAREWELL.rebirthMs);
  };

  /** 重生：新的一世（`prev` 记住从哪来 —— §13） */
  const rebirth = (prevId: string, life: number): void => {
    stopFarewell();
    sessionId = createBotSession({ cwd, model: cfg?.model ?? "", tier: "写作者", life, prev: prevId }).id;
    transcript.items = [...introWithLife(cfg?.model ?? "", cwd), ""];
    transcript.invalidate();
    usage = undefined;
    prevHistory = undefined;
    prefixStable = undefined;
    foldCount = 0;
    summaryActive = false;
    busy = false;
    state = "空闲";
    push(dim(`  已为你开新的一世（第 ${life} 世）`), "");
    refresh();
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
          // 标题写明是哪家的列表：「只有 glm 还是全部」不再靠猜（一家 provider 一次）
          title: `Krystal Bot 模型 · ${endpointLabel(cfg!.baseUrl)}`,
          hint: "↑↓ 选择 · enter 确认 · esc 取消（只列当前端点；换 provider 用 /login）",
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
            // 本机服务（Ollama/LM Studio）不问 key：直接给占位值（pi 的做法：本地也要一个占位符）
            if (preset.local) {
              draft.apiKey = nextApiKey("", undefined);
              startFetch();
            } else showKey();
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
      openInputOverlay(
        `API Key · ${providerLabel}`,
        // 故意**不**预填已存的 key：预填后光标停在位置 0，敲新 key 会被拼在旧 key 前面 → 提交必然失败
        "",
        (v) => {
          draft.apiKey = nextApiKey(v, draft.apiKey);
          startFetch();
        },
        {
          allowEmpty: true,
          hint: draft.apiKey
            ? `已存 ${maskKey(draft.apiKey)}——留空回车保持不变，或直接输入新 key`
            : "本机服务（Ollama / LM Studio）留空回车即可（占位 none）",
        },
      );
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
      const divertText = runningDiverts.size > 0 ? ` · ${bold(fg(BLUE_LIGHT, `旁路 ${runningDiverts.size}`))}` : "";
      const seg = `${sid} · ${busy ? state : "空闲"}${divertText} ${ctxText} · 缓存 ${cache} · ${pfx} · ${extra}${tok} · /resume 回溯 · /model 模型 · /login API`;
      return [truncateToWidth(` ${seg} ${dim("· esc 中断 · ctrl+c 退出")}`, w)];
    },
    invalidate(): void {},
  };
  // ── 工作指示（pi 的 Working 同型）：busy 时显示 spinner·状态（英文 · 蓝字 · 扫光）
  const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  let workingTick = 0;
  const STATE_EN: Record<string, string> = {
    "连接中": "connecting",
    "思考中": "thinking",
    "回答中": "answering",
    "整理早期摘要": "compacting",
    "完成": "done",
    "出错": "error",
  };
  const stateEn = (s: string): string => {
    if (STATE_EN[s]) return STATE_EN[s]!;
    if (s.startsWith("工具 ")) return `tool · ${s.slice(3)}`;
    if (s.startsWith("重试 ")) return `retrying ${s.slice(2)}`;
    return s;
  };
  /** 扫光：亮蓝窗口（3 字符宽）随 tick 在蓝字上从左往右游走 */
  const sweep = (text: string, tick: number): string => {
    const BLUE = "38;5;39", BRIGHT = "38;5;117";
    const period = Math.max([...text].length + 6, 10);
    let out = "";
    [...text].forEach((ch, i) => {
      const d = (i - (tick % period) + period) % period;
      out += `\x1b[${d < 3 ? BRIGHT : BLUE}m${ch}\x1b[0m`;
    });
    return out;
  };
  const workingComp: Component = {
    render(w: number): string[] {
      if (!busy) return [];
      // 尾部留一行空白：和下面的状态行/输入框保持呼吸感
      return [truncateToWidth(`${fg(BLUE_LIGHT, SPINNER[Math.floor(workingTick / 2) % SPINNER.length]!)} ${sweep(stateEn(state), workingTick)}`, w, ""), ""];
    },
    invalidate(): void {},
  };
  const workingTimer = setInterval(() => {
    // 有旁路在跑时也要推进：否则「主会话空闲 + 旁路运行」下 toolBlink 冻住，旁路圆点不闪烁
    // （workingComp 在 !busy 时 return []，所以放行这个条件不会多出任何可见行）
    if (busy || sleeping || runningDiverts.size > 0) {
      workingTick++;
      toolBlink = Math.floor(workingTick / 4) % 2 === 1;
      tui.requestRender();
    }
  }, 150);
  workingTimer.unref?.();

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

  // 流动块：思考/回答各自一个多行组件，delta 原地增长。
  // 教训（2026-09-25）：此前所有回答块共用一个 `streamMd` 槽位，块在 render 时读「槽位当前值」，
  // 于是新一段回答一建就把槽位指过去 —— 旧块立刻改显新文字（旧答复消失 + 同一段印两遍）；
  // `final` 的校准也写进槽位，先答后记时会把上一段长答案覆盖掉。
  // 现在改为「段即对象」：每段持有自己的 Markdown/文本/定格标记（契约与回归见 view/stream-seg.ts）。
  let liveThinking: StreamText | undefined;
  let liveText: TextSegment | undefined;
  let streamKind: "thinking" | "text" | null = null;
  let currentTool: ToolBlock | undefined;
  const beginThinking = () => {
    if (streamKind) closeStream();
    // 思考：dim 纯文本流（成本最低，观感与 pi 的 thinking 一致）
    liveThinking = new StreamText("· thinking ", (t) => dim(t));
    push(liveThinking);
    streamKind = "thinking";
  };
  const beginText = () => {
    if (streamKind) closeStream();
    // 回答：pi 同款——边流式边渲染真 Markdown（部分文本喂 Markdown，每帧重解析；
    // pi-tui 自带 trimPartialClosingFences 处理未闭合代码围栏）。本段结束时定格，不再替换。
    liveText = createTextSegment(BOT_THEME);
    push(liveText.comp);
    streamKind = "text";
  };
  const streamTo = (delta: string) => {
    if (streamKind === "thinking") liveThinking?.append(delta);
    else liveText?.append(delta);
    refresh();
  };
  /** 结束当前段并把回答段定格（done → Transcript 转缓存；否则它会永远被当活块逐帧重渲） */
  const closeStream = () => {
    liveText?.seal();
    liveThinking = undefined;
    liveText = undefined;
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
          beginThinking();
        }
        tokens += e.delta.length / 4;
        streamTo(e.delta);
        turnThinking += e.delta; // 思考原文累积（final/assistant 时落盘 → /resume 可重放）
        break;
      case "text":
        state = "回答中";
        if (streamKind !== "text") {
          ensureGap();
          beginText();
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
          currentTool.args = e.argsSoFar;
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
          currentTool.args = e.args;
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
          thinking: turnThinking || undefined,
          toolCalls: e.toolCalls,
        });
        turnThinking = ""; // 本段思考已归属这条 assistant 事件
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
        // 本段活 Markdown 已流式渲染完毕 → 原地定格（volatile 关闭 → 转入缓存），不再替换。
        // e.text 是权威全文（流式尾部可能有 trim 差异）→ 对本段 setText 校准一次。
        // 只碰「本段」：liveText 为空 = 本段没出过文字（先答后记，final 只是收尾那句）
        // → 前面的回答段落原样保留（此前写共享槽位会把上一段整段覆盖）。
        let seg = liveText;
        if (!seg && e.text.trim()) {
          // 本段没有流式文字但 final 带文字（端点未按 delta 推流 / 收尾句）→ 单独成段，不寄居在上一段里
          ensureGap();
          beginText();
          seg = liveText;
        }
        seg?.finish(e.text);
        closeStream(); // 定格本段
        state = "完成";
        if (seg && seg.isEmpty()) {
          // 真正空回答（本段流式也没内容）→ 移除空活组件
          const idx = transcript.items.indexOf(seg.comp);
          if (idx >= 0) transcript.items.splice(idx, 1);
          transcript.forget(seg.comp);
        } else {
          push("");
        }
        appendEvent(sessionId, { t: "msg", at: new Date().toISOString(), role: "assistant", content: e.text, thinking: turnThinking || undefined });
        turnThinking = "";
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
    turnThinking = ""; // 新回合从零累积思考
    abort = new AbortController(); // 每回合新开：否则上一回合的 abort 会让本轮无法中断
    // 每回合从事件流装配上下文：只追加、顺序稳定 → 前缀缓存友好（§13.2）
    const events = loadEvents(sessionId);
    checkPrefix(events.filter((e) => e.t === "msg"));
    void runBotTask({ cfg, cwd, events, signal: abort.signal, onEvent });
  };

  editor.onSubmit = (text: string) => {
    if (!cfg) return;
    const body = text.trim();
    if (!body) return;
    // 命令前缀 / 与 : 等价（平台约定）；未知命令只提示，绝不发给模型。
    // 命令层在主会话忙时也接受：旁路要能在主会话跑着的时候派发（真并行）与 /stop。
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
        abortMain(); // 开新会话前级联中断旁路（同 /resume）
        runningDiverts.clear();
        sessionId = createBotSession({ cwd, model: cfg.model, tier: "写作者" }).id;
        transcript.items = [...introWithLife(cfg.model, cwd), ""];
        transcript.invalidate();
        usage = undefined;
        prevHistory = undefined;
        prefixStable = undefined;
        foldCount = 0;
        summaryActive = false;
        push(dim("  新会话已开始"), "");
        refresh();
      } else if (cmd.startsWith("sleep")) {
        const sleepArg = cmd.slice(5).trim();
        if (sleepArg === "undo") {
          const u = undoLastSleep();
          push(dim(u ? `  已反演最近一次睡眠（恢复 ${u.restored} 条）· /memory 查看` : "  没有可反演的睡眠记录"), "");
          refresh();
          return;
        }
        if (sleepArg) {
          push(dim(`  未知参数 ${sleepArg}（用法：/sleep · /sleep undo）`), "");
          refresh();
          return;
        }
        if (sleeping) {
          push(dim("  睡眠整理进行中…"), "");
          refresh();
          return;
        }
        // 活行：与工具调用同型 —— 圆点闪烁 + sleeping 扫光，完成后原地换成蓝点 + diff + 新记忆图
        sleeping = true;
        const live: Component = {
          volatile: true, // 活行：圆点闪烁 + 扫光逐帧变化，不做逐项缓存
          render(wid: number): string[] {
            const dot = Math.floor(workingTick / 4) % 2 === 0 ? fg("38;5;117", "●") : dim("○");
            return [truncateToWidth(`  ${dim("╰─")} ${dot} ${sweep("sleeping", workingTick)}`, wid, "")];
          },
          invalidate(): void {},
        };
        push(live, "");
        refresh();
        void sleepMemories().then((r) => {
          sleeping = false;
          const idx = transcript.items.indexOf(live);
          if (idx >= 0) transcript.items.splice(idx, 1);
          transcript.forget(live);
          if (!r) {
            push(dim("  睡眠整理跳过（库空/进行中）或失败——详见 ~/.krystal/"), "");
            refresh();
            return;
          }
          // 分支样式：╰─ ● sleep · 摘要，下面逐条 diff（绿 + 新增/合并 · 红 − 覆盖/退役 · 绿 ~ 重挂/升权）
          push(`  ${dim("╰─")} ${fg(BLUE, "●")} ${bold("sleep")} ${dim(r.summary)}`, "");
          for (const ev of r.events) {
            const mark = ev.sign === "−" ? fg("38;5;218", "−") : fg("38;5;71", ev.sign);
            push("      " + mark + " " + dim(`[${ev.id}] ${ev.text}${ev.note ? ` · ${ev.note}` : ""}`));
          }
          // 睡眠后记忆图（变更条目标绿，被覆盖旧知单列红）
          const marks: SleepMarks = {
            greenIds: new Set(r.events.filter((e) => e.sign !== "−").map((e) => e.id)),
            retired: r.events.filter((e) => e.sign === "−").map((e) => ({ id: e.id, text: e.text, note: e.note })),
          };
          const g = renderGraph(undefined, marks);
          push("", ...g.lines.map((l) => (l.includes("\x1b[38;5;71m") ? l : l.startsWith("●") || l.startsWith("○") ? fg("36", l) : dim(l))), "");
          push(dim(`  报告：${r.reportPath}`), "");
          refresh();
        });
        return;
      } else if (cmd === "farewell") {
        openFarewellConfirm();
      } else if (cmd === "divert" || cmd.startsWith("divert ")) {
        // 给任务→直接派发；只打命令→弹窗输入（两种都工作）
        const task = body.replace(/^[/:]\s*divert\s*/i, "").trim();
        if (task) dispatchDivert(task);
        else openDivertPopup();
      } else if (cmd === "stop") {
        stopDiverts();
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
          ...helpLines().map((l) => dim(l)),
          dim("  esc 中断 · ctrl+c 退出 · 打 / 弹出命令列表（↑↓ 选择 · enter 执行）"),
          "",
        );
        refresh();
      } else {
        push(dim(`  未知命令 ${body}（可用 ${commandNames()}）`), "");
        refresh();
      }
      return;
    }
    if (busy) return; // 正文消息仍要求主会话空闲（命令层不受限）
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
        stopFarewell(); // 仪式时钟一并收掉
        abortMain(); // 退出前级联中断旁路：绝不留孤儿（它还会跑命令、写文件、写记忆）
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
      // 仪式进行中：任意键 → 立刻吐完并定格（票 §5.5“可跳过”）；ctrl+c 已在上面处理
      {
        const live = transcript.items.find((i) => i instanceof FarewellBlock && !i.frozen);
        if (live instanceof FarewellBlock) {
          live.skip();
          tui.requestRender();
          return;
        }
      }
      // ctrl+o：折叠/展开可折叠块（pi 同款惯例：app.tools.expand = ctrl+o）
      // 旁路块与告别放映块共用这一个开关
      if (matchesKey(data, "ctrl+o")) {
        const blocks = transcript.items.filter(
          (i): i is SubsessionBlock | FarewellBlock => i instanceof SubsessionBlock || i instanceof FarewellBlock,
        );
        if (blocks.length > 0) {
          const to = !blocks.some((b) => b.expanded); // 有折叠的 → 全展开；全展开 → 全收起
          for (const b of blocks) if (b.expanded !== to) b.toggle();
          refresh();
          return;
        }
      }
      if (matchesKey(data, "escape")) {
        // esc = 中断主会话 + 级联中断旁路（唯一出口）；主会话空闲但旁路在跑 → 只停旁路，不退出
        if (busy || runningDiverts.size > 0) abortMain();
        else quit();
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
      { component: workingComp, basis: "auto" },
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
