// Krystal — 初始界面：Krystal logo + 模式选择（新建 / 一句话建队 / 历史群聊）+ 配置向导
import {
  Input,
  SelectList,
  TuiAltScreen,
  ProcessTerminal,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Focusable,
  type TUI,
} from "../../deps/pi-tui/dist/index.js";
import { bold, dim, fg } from "../ui/ansi.ts";
import { KRYSTAL_GRADIENT, LOGO_ROWS, LOGO_WIDTH } from "../ui/logo.ts";
import { DEFAULT_COMMANDS, MEMBER_COLORS, type Member, type MemberType, type TeamConfig } from "../types.ts";
import { listSessions, newSessionId } from "../team.ts";
import { generateTeamSpec, type TeamSpec } from "../generator.ts";
import { clearBuilder, fetchModels, loadBuilder, maskKey, PROVIDER_PRESETS, saveBuilder, testBuilder, type BuilderConfig } from "../builder.ts";
import { listBotSessions } from "../session.ts";
import { discoverModelGroups, withModel, type ModelGroup } from "../models.ts";

const THEME = {
  selectedPrefix: (t: string) => fg("36", t),
  selectedText: (t: string) => bold(t),
  description: (t: string) => dim(t),
  scrollInfo: (t: string) => dim(t),
  noMatch: (t: string) => fg("33", t),
};

export type WizardResult =
  | { action: "create"; config: TeamConfig }
  | { action: "resume"; id: string }
  | { action: "bot"; resumeId?: string }
  | { action: "quit" };

type Step =
  | "mode"
  | "chooser"
  | "size"
  | "name"
  | "type"
  | "cmd"
  | "confirm"
  | "genInput"
  | "genLoading"
  | "genConfirm"
  | "builderMenu"
  | "builderProvider"
  | "builderUrl"
  | "builderKey"
  | "builderFetch"
  | "builderPick"
  | "builderModelInput"
  | "builderTesting"
  | "botMenu";

const TYPE_ITEMS: { value: MemberType; label: string; description: string }[] = [
  { value: "pi", label: "pi", description: "pi coding agent" },
  { value: "hermes", label: "hermes", description: "hermes agent (chat)" },
  { value: "codex", label: "codex", description: "openai codex cli" },
  { value: "kimi", label: "kimi", description: "kimi code cli" },
  { value: "custom", label: "custom", description: "自定义启动命令" },
];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

const rule = (width: number) => fg("36", "─".repeat(Math.max(0, width)));
const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - visibleWidth(s)));

function uniqueName(base: string, taken: string[]): string {
  let name = base;
  let i = 2;
  while (taken.includes(name)) name = `${base}${i++}`;
  return name;
}

class Wizard implements Component, Focusable {
  onSubmitResult?: (r: WizardResult) => void;

  private tui: TUI;
  private cwd: string;
  private step: Step = "mode";
  private instr = "";
  private error = "";
  private active:
    | (Component & {
        onSubmit?: (v: string) => void;
        onEscape?: () => void;
        onSelect?: (item: { value: string }) => void;
        onCancel?: () => void;
      })
    | undefined;

  // 手动配置用
  private size = 4;
  private members: Partial<Member>[] = [];

  // 一句话建队用
  private genDesc = "";
  private spec: TeamSpec | undefined;
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  private spinnerFrame = 0;

  // 平台模型（搭建模型）配置用
  private pendingGen = false; // 配置完成后要回到「一句话建队」
  private builderAbort: AbortController | undefined;
  private builderModel = ""; // genLoading 展示用
  private builderDraft: Partial<BuilderConfig> = {};
  private builderProviderLabel = ""; // 仅展示用
  private builderModels: string[] = []; // 动态拉取的模型列表
  private builderModelsAbort: AbortController | undefined;

  constructor(tui: TUI, cwd: string) {
    this.tui = tui;
    this.cwd = cwd;
  }

  start(): void {
    this.showMode();
  }

  // ---------- 工具 ----------
  private fail(e: unknown): void {
    this.error = e instanceof Error ? e.message : String(e);
    this.tui.requestRender();
  }
  private safe<T>(fn: (arg: T) => void): (arg: T) => void {
    return (arg: T) => {
      try {
        fn(arg);
      } catch (e) {
        this.fail(e);
      }
    };
  }
  private setActive(w: typeof this.active, step: Step, instruction: string): void {
    this.active = w;
    this.step = step;
    this.instr = instruction;
    this.error = "";
    this.tui.requestRender();
  }
  private stopSpinner(): void {
    if (this.spinnerTimer) clearInterval(this.spinnerTimer);
    this.spinnerTimer = undefined;
  }

  // ---------- 渲染 ----------
  render(width: number): string[] {
    const out: string[] = [];
    // logo 框（全宽圆角，青→蓝渐变）
    const inner = Math.max(10, width - 2);
    const tagline =
      this.step === "mode"
        ? ["", ` ${bold("Krystal")} ${dim("· 多 agent 团队驾驶舱")}`, dim(" 选择模式开始，或恢复历史团队"), ""]
        : ["", dim(" Krystal"), "", ""];
    const top = dim("╭" + "─".repeat(Math.max(0, width - 2)) + "╮");
    const bottom = dim("╰" + "─".repeat(Math.max(0, width - 2)) + "╯");
    const side = width >= LOGO_WIDTH + 46;
    const logoBox: string[] = [];
    if (side) {
      for (let r = 0; r < LOGO_ROWS.length; r++) {
        const logo = pad(fg(KRYSTAL_GRADIENT[r]!, LOGO_ROWS[r]!), LOGO_WIDTH);
        const content = ` ${logo}  ${tagline[r] ?? ""}`;
        logoBox.push(dim("│") + pad(truncateToWidth(content, inner, "…"), inner) + dim("│"));
      }
    } else {
      for (let r = 0; r < LOGO_ROWS.length; r++) {
        logoBox.push(dim("│") + pad(truncateToWidth(` ${fg(KRYSTAL_GRADIENT[r]!, LOGO_ROWS[r]!)}`, inner, ""), inner) + dim("│"));
      }
    }
    out.push(top, ...logoBox, bottom);

    // 当前步骤
    if (this.step !== "mode") out.push(truncateToWidth(dim(this.instr), width));
    if (this.step === "mode") out.push(dim(" 选择模式："));
    out.push(rule(width));
    if (this.step === "genLoading" || this.step === "builderTesting" || this.step === "builderFetch") {
      const sp = SPINNER[this.spinnerFrame % SPINNER.length]!;
      if (this.step === "genLoading") {
        out.push(truncateToWidth(` ${fg("36", sp)} 平台模型 ${bold(this.builderModel)} 整理中…（esc 取消）`, width));
        out.push(truncateToWidth(dim(` 描述：${this.genDesc}`), width));
      } else if (this.step === "builderFetch") {
        out.push(truncateToWidth(` ${fg("36", sp)} 正在拉取模型列表 ${this.builderDraft.baseUrl ?? ""}…（esc 取消）`, width));
      } else {
        out.push(
          truncateToWidth(
            ` ${fg("36", sp)} 正在测试 ${bold(this.builderDraft.model ?? "")} @ ${this.builderDraft.baseUrl ?? ""}…（esc 取消）`,
            width,
          ),
        );
      }
    } else if (this.active) {
      if (this.step === "genConfirm" && this.spec) {
        out.push(...this.specLines());
        out.push("");
      } else if (this.step === "confirm") {
        out.push(...this.manualLines());
        out.push("");
      }
      out.push(...this.active.render(width));
    }
    if (this.error) out.push(fg("31", ` ${this.error}`));
    out.push(rule(width));
    out.push(
      truncateToWidth(
        dim(" ↑↓ 选择 · enter 确认 · esc 返回 · ctrl+c 退出"),
        width,
      ),
    );
    return out;
  }

  // ---------- 模式选择 ----------
  private showMode(): void {
    const sessions = listSessions();
    const builderCfg = loadBuilder();
    const items = [
      { value: "new", label: "新建团队", description: "手动配置：人数 / 名字 / 类型 / 启动命令" },
      { value: "gen", label: "一句话建队", description: "用一句描述生成成员职责与协作协议（推荐）" },
      {
        value: "history",
        label: "历史群聊",
        description: sessions.length ? `${sessions.length} 个历史团队，恢复对话与画面` : "暂无历史团队",
      },
      {
        value: "bot",
        label: "Krystal Bot",
        description: builderCfg ? `和原生 agent 对话（原型）· ${builderCfg.model}` : "原生 agent（需先配置 Platform model）",
      },
      {
        value: "builder",
        label: "Platform model",
        description: builderCfg ? `已配置 · ${builderCfg.model}` : "未配置——一句话建队需要它",
      },
      { value: "quit", label: "退出" },
    ];
    const list = new SelectList(items, items.length, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "new") this.showSize();
      else if (item.value === "gen") this.showGenInput();
      else if (item.value === "history") this.showChooser();
      else if (item.value === "bot") {
        if (!loadBuilder()) {
          this.showMode();
          this.error = "Krystal Bot 需要平台模型——先到 Platform model 配置";
        } else this.showBotMenu();
      }
      else if (item.value === "builder") this.showBuilder();
      else this.onSubmitResult?.({ action: "quit" });
    });
    list.onCancel = () => this.onSubmitResult?.({ action: "quit" });
    this.setActive(list, "mode", "");
  }

  // ---------- 历史群聊 ----------
  private showChooser(): void {
    const sessions = listSessions();
    if (sessions.length === 0) {
      this.error = "暂无历史团队——先用「新建团队」或「一句话建队」建一个";
      this.showMode();
      this.error = "暂无历史团队";
      return;
    }
    const items = [
      { value: "__back", label: "返回" },
      ...sessions.map((s) => ({
        value: s.id,
        label: s.name,
        description: `${s.members.map((m) => m.name).join(" / ")} · ${s.createdAt.slice(0, 16).replace("T", " ")}`,
      })),
    ];
    const list = new SelectList(items, Math.min(items.length, 12), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "__back") this.showMode();
      else this.onSubmitResult?.({ action: "resume", id: item.value });
    });
    list.onCancel = () => this.showMode();
    this.setActive(list, "chooser", "历史群聊（恢复团队视图与引擎）");
  }

  // ---------- Krystal Bot：续聊 / 新会话 ----------
  private showBotMenu(): void {
    const past = listBotSessions();
    if (!past.length) {
      this.onSubmitResult?.({ action: "bot" });
      return;
    }
    const items = [
      {
        value: past[0]!.id,
        label: "继续上次对话",
        description: `${past[0]!.createdAt.slice(0, 16).replace("T", " ")} · ${past[0]!.model} · 共 ${past.length} 个会话`,
      },
      { value: "__new", label: "新会话", description: "开一段新的对话" },
      ...past.slice(1, 6).map((m) => ({
        value: m.id,
        label: `更早：${m.createdAt.slice(0, 16).replace("T", " ")}`,
        description: `${m.model} · ${m.cwd}`,
      })),
      { value: "__back", label: "返回" },
    ];
    const list = new SelectList(items, Math.min(items.length, 10), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "__back") this.showMode();
      else if (item.value === "__new") this.onSubmitResult?.({ action: "bot" });
      else this.onSubmitResult?.({ action: "bot", resumeId: item.value });
    });
    list.onCancel = () => this.showMode();
    this.setActive(list, "botMenu", "Krystal Bot（事件流已落盘，可继续上次对话）");
  }

  // ---------- 一句话建队 ----------
  private showGenInput(): void {
    const input = new Input();
    input.onSubmit = this.safe(() => {
      const desc = input.getValue().trim();
      if (!desc) return;
      this.genDesc = desc;
      this.runGeneration();
    });
    input.onEscape = () => this.showMode();
    this.setActive(input, "genInput", "一句话描述你的团队/目标，例如：Rust CLI 小工具，一人实现一人测试验收");
  }

  private runGeneration(): void {
    const cfg = loadBuilder();
    if (!cfg) {
      // 无静默回退：未配置平台模型 → 引导配置，完成后自动回到一句话建队
      this.pendingGen = true;
      this.showBuilder();
      this.error = "未配置平台模型——一句话建队需要它，先配置吧（测试通过后自动回到这里）";
      return;
    }
    this.builderModel = cfg.model;
    this.stopSpinner();
    this.step = "genLoading";
    this.instr = "生成中";
    this.error = "";
    this.spinnerFrame = 0;
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame++;
      this.tui.requestRender();
    }, 90);
    this.spinnerTimer.unref?.();
    this.tui.requestRender();

    void generateTeamSpec(this.genDesc)
      .then((spec) => {
        this.stopSpinner();
        this.spec = spec;
        this.showGenConfirm();
      })
      .catch((e: unknown) => {
        this.stopSpinner();
        this.error = e instanceof Error ? e.message : String(e);
        this.showGenInput();
        this.error = `生成失败：${this.error}`;
      });
  }

  private showGenConfirm(): void {
    const spec = this.spec!;
    const list = new SelectList(
      [
        { value: "go", label: "创建并启动", description: "写入团队历史并拉起 tmux 引擎" },
        { value: "redo", label: "重新描述" },
        { value: "quit", label: "退出" },
      ],
      3,
      THEME,
    );
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "go") this.onSubmitResult?.({ action: "create", config: this.configFromSpec(spec) });
      else if (item.value === "redo") this.showGenInput();
      else this.onSubmitResult?.({ action: "quit" });
    });
    list.onCancel = () => this.showGenInput();
    this.setActive(list, "genConfirm", "确认团队规格（可回车直接创建）");
  }

  /** 生成规格的展示块（渲染在列表上方） */
  private specLines(): string[] {
    const spec = this.spec!;
    const lines: string[] = [];
    lines.push(`  队名  ${bold(spec.teamName)}`);
    if (spec.goal) lines.push(`  目标  ${spec.goal}`);
    lines.push("  成员");
    for (const m of spec.members) {
      const color = { icon: "36", color: "35", m: "33", k: "32" } as Record<string, string>;
      const c = MEMBER_COLORS[m.type] ?? color.icon;
      lines.push(`   ${fg(c!, m.name.padEnd(12))} ${dim(m.type.padEnd(7))} ${truncateToWidth(m.role, 90, "…")}`);
    }
    if (spec.protocol.length) {
      lines.push("  协议");
      spec.protocol.forEach((p, i) => lines.push(`   ${dim(`${i + 1}.`)} ${truncateToWidth(p, 96, "…")}`));
    }
    return lines;
  }

  private configFromSpec(spec: TeamSpec): TeamConfig {
    const id = newSessionId(spec.teamName);
    return {
      id,
      name: spec.teamName,
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
      tmuxSession: `zebra-${id}`,
      goal: spec.goal,
      protocol: spec.protocol,
      members: spec.members.map((m) => ({
        id: m.name,
        name: m.name,
        type: m.type,
        command: DEFAULT_COMMANDS[m.type]!.command,
        resumeCommand: DEFAULT_COMMANDS[m.type]!.resume,
        color: MEMBER_COLORS[m.type],
        role: m.role,
      })),
    };
  }

  // ---------- 平台模型（搭建模型）配置 ----------
  private showBuilder(): void {
    const cfg = loadBuilder();
    const items = [
      {
        value: "edit",
        label: cfg ? "重新配置" : "配置",
        description: cfg
          ? `${cfg.baseUrl} · ${maskKey(cfg.apiKey)} · ${cfg.model}`
          : "选提供商 · 填 API Key · 动态拉模型，测试通过后保存",
      },
      ...(cfg
        ? [{ value: "clear", label: "清除配置", description: "回到未配置状态（一句话建队会要求先配置）" }]
        : []),
      { value: "__back", label: "返回" },
    ];
    const list = new SelectList(items, items.length, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "edit") this.showBuilderProvider();
      else if (item.value === "clear") {
        clearBuilder();
        this.showBuilder();
        this.error = "已清除平台模型配置";
      } else if (this.pendingGen) this.showGenInput();
      else this.showMode();
    });
    list.onCancel = () => (this.pendingGen ? this.showGenInput() : this.showMode());
    this.setActive(
      list,
      "builderMenu",
      cfg ? "Platform model（平台搭建模型，与成员模型互不干预）" : "Platform model（未配置——一句话建队需要它）",
    );
  }

  private showBuilderProvider(): void {
    this.builderDraft = loadBuilder() ?? {}; // 保留旧 key/模型做预填
    const items = [
      ...PROVIDER_PRESETS.map((p) => ({ value: p.id, label: p.label, description: p.baseUrl })),
      { value: "__custom", label: "自定义 Base URL…", description: "任何 OpenAI 兼容端点" },
      { value: "__back", label: "返回" },
    ];
    const list = new SelectList(items, Math.min(items.length, 12), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "__back") {
        this.showBuilder();
        return;
      }
      const preset = PROVIDER_PRESETS.find((p) => p.id === item.value);
      if (preset) {
        this.builderProviderLabel = preset.label;
        this.builderDraft.baseUrl = preset.baseUrl;
        this.showBuilderKey();
      } else {
        this.showBuilderUrl();
      }
    });
    list.onCancel = () => this.showBuilder();
    this.setActive(
      list,
      "builderProvider",
      "选择模型提供商（模型列表动态拉取，provider 上新无需更新 Krystal）",
    );
  }

  private showBuilderUrl(): void {
    const input = new Input();
    if (this.builderDraft.baseUrl) input.setValue(this.builderDraft.baseUrl);
    input.onSubmit = this.safe(() => {
      const v = input.getValue().trim();
      if (!v) return;
      this.builderProviderLabel = "自定义";
      this.builderDraft.baseUrl = v;
      this.showBuilderKey();
    });
    input.onEscape = () => this.showBuilderProvider();
    this.setActive(input, "builderUrl", "Base URL（OpenAI 兼容根地址，含 /v1，例：https://api.example.com/v1）");
  }

  private showBuilderKey(): void {
    const input = new Input();
    if (this.builderDraft.apiKey) input.setValue(this.builderDraft.apiKey);
    input.onSubmit = this.safe(() => {
      const v = input.getValue().trim() || "none"; // 本地服务（如 Ollama）不需要真 key，留空则占位
      this.builderDraft.apiKey = v;
      this.startFetchModels();
    });
    input.onEscape = () => this.showBuilderProvider();
    this.setActive(input, "builderKey", "API Key（唯一必填项；本地服务如 Ollama 可留空回车。仅存本机 ~/.krystal/config.json）");
  }

  private startFetchModels(): void {
    const cfg = this.builderDraft as BuilderConfig;
    if (!cfg.baseUrl || !cfg.apiKey) {
      this.showBuilderKey();
      this.error = "先填 API Key";
      return;
    }
    this.stopSpinner();
    this.step = "builderFetch";
    this.instr = "拉取模型";
    this.error = "";
    this.spinnerFrame = 0;
    this.builderModelsAbort = new AbortController();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame++;
      this.tui.requestRender();
    }, 90);
    this.spinnerTimer.unref?.();
    this.tui.requestRender();
    void fetchModels(cfg, this.builderModelsAbort.signal)
      .then((models) => {
        this.stopSpinner();
        this.builderModelsAbort = undefined;
        this.builderModels = models;
        this.showBuilderPick();
      })
      .catch((e: unknown) => {
        this.stopSpinner();
        this.builderModelsAbort = undefined;
        this.showBuilderModelInput();
        this.error = `拉取模型列表失败（可直接手输模型 id）：${e instanceof Error ? e.message : String(e)}`;
      });
  }

  private showBuilderPick(): void {
    const items = [
      ...this.builderModels.map((m) => ({ value: m, label: m, description: "" })),
      { value: "__manual", label: "手动输入模型 id…", description: "列表里没有时使用" },
      { value: "__back", label: "返回" },
    ];
    const list = new SelectList(items, Math.min(items.length, 14), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "__back") {
        this.showBuilderKey();
        return;
      }
      if (item.value === "__manual") {
        this.showBuilderModelInput();
        return;
      }
      this.builderDraft.model = item.value;
      this.testAndSave();
    });
    list.onCancel = () => this.showBuilderKey();
    this.setActive(list, "builderPick", `选择模型（来自 ${this.builderProviderLabel || this.builderDraft.baseUrl}，动态拉取）`);
  }

  private showBuilderModelInput(): void {
    const input = new Input();
    if (this.builderDraft.model) input.setValue(this.builderDraft.model);
    input.onSubmit = this.safe(() => {
      const v = input.getValue().trim();
      if (!v) return;
      this.builderDraft.model = v;
      this.testAndSave();
    });
    input.onEscape = () => (this.builderModels.length ? this.showBuilderPick() : this.showBuilderKey());
    this.setActive(input, "builderModelInput", "模型 id（回车开始测试连接，通过后才保存）");
  }

  private testAndSave(): void {
    const cfg = this.builderDraft as BuilderConfig;
    if (!cfg.baseUrl || !cfg.apiKey || !cfg.model) {
      this.showBuilder();
      this.error = "三项都要填";
      return;
    }
    this.stopSpinner();
    this.step = "builderTesting";
    this.instr = "测试连接";
    this.error = "";
    this.spinnerFrame = 0;
    this.builderAbort = new AbortController();
    this.spinnerTimer = setInterval(() => {
      this.spinnerFrame++;
      this.tui.requestRender();
    }, 90);
    this.spinnerTimer.unref?.();
    this.tui.requestRender();
    void testBuilder(cfg, this.builderAbort.signal)
      .then(() => {
        this.stopSpinner();
        this.builderAbort = undefined;
        saveBuilder(cfg);
        const resumeGen = this.pendingGen;
        this.pendingGen = false;
        this.showBuilder();
        this.error = `已保存，测试通过：${cfg.model}${resumeGen ? "——继续一句话建队吧" : ""}`;
      })
      .catch((e: unknown) => {
        this.stopSpinner();
        this.builderAbort = undefined;
        this.showBuilder();
        this.error = `测试未通过（未保存）：${e instanceof Error ? e.message : String(e)}`;
      });
  }

  // ---------- 手动配置 ----------
  private showSize(): void {
    this.members = [];
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({
      value: String(n),
      label: `${n} 名成员`,
      description: n === 1 ? "单 agent" : "双列网格",
    }));
    const list = new SelectList(items, 6, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      this.size = Number(item.value);
      this.members = Array.from({ length: this.size }, () => ({}));
      this.showName(0);
    });
    list.onCancel = () => this.showMode();
    this.setActive(list, "size", "团队几名成员？（1–6）");
  }

  private showName(i: number): void {
    const taken = this.members.map((m) => m.name).filter(Boolean) as string[];
    const def = uniqueName(TYPE_ITEMS[i % 4]!.label, taken);
    const input = new Input();
    input.setValue(def);
    input.onSubmit = this.safe(() => {
      const name = (input.getValue().trim() || def).replace(/\s+/g, "-");
      this.members[i]!.name = name;
      this.members[i]!.id = name;
      this.showType(i);
    });
    input.onEscape = this.safe(() => (i === 0 ? this.showSize() : this.showType(i - 1)));
    this.setActive(input, "name", `成员 ${i + 1}/${this.size} — 名字`);
  }

  private showType(i: number): void {
    const list = new SelectList(TYPE_ITEMS, TYPE_ITEMS.length, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      const type = item.value as MemberType;
      this.members[i]!.type = type;
      if (type === "custom") {
        this.showCmd(i);
        return;
      }
      this.members[i]!.command = DEFAULT_COMMANDS[type]!.command;
      this.members[i]!.resumeCommand = DEFAULT_COMMANDS[type]!.resume;
      this.members[i]!.color = MEMBER_COLORS[type];
      if (type === "custom") this.showIdentity(i);
      else this.showModelProvider(i);
    });
    list.onCancel = () => this.showName(i);
    this.setActive(list, "type", `成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 类型`);
  }

  private showCmd(i: number): void {
    const input = new Input();
    input.onSubmit = this.safe(() => {
      this.members[i]!.command = input.getValue().trim() || "bash";
      this.members[i]!.resumeCommand = this.members[i]!.command;
      this.members[i]!.color = MEMBER_COLORS.custom;
      this.showIdentity(i);
    });
    input.onEscape = () => this.showType(i);
    this.setActive(input, "cmd", `成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 启动命令`);
  }

  /** 模型来源（按各 agent 自己的配置分组） */
  private showModelProvider(i: number): void {
    const type = this.members[i]!.type!;
    const groups = discoverModelGroups(type);
    const items = [
      { value: "__none", label: "默认（不指定模型）", description: `跟随 ${type} 自身配置` },
      ...groups.map((g, gi) => ({
        value: `g${gi}`,
        label: g.group,
        description: g.note ?? (g.models.length ? `${g.models.length} 个模型 · 例：${g.models[0]!.value}` : ""),
      })),
      { value: "__custom", label: "自定义…", description: "手输模型 id" },
      { value: "__back", label: "返回" },
    ];
    const list = new SelectList(items, Math.min(items.length, 14), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "__none") {
        delete this.members[i]!.model;
        this.showIdentity(i);
      } else if (item.value === "__custom") {
        this.showModelInput(i);
      } else if (item.value === "__back") {
        this.showType(i);
      } else {
        const gi = Number(item.value.slice(1));
        this.showModelPick(i, groups[gi]!);
      }
    });
    list.onCancel = () => this.showType(i);
    this.setActive(
      list,
      "modelProvider",
      `成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 模型来源（来自 ${type} 的配置）`,
    );
  }

  private showModelPick(i: number, group: ModelGroup): void {
    const items = [
      ...group.models.map((m) => ({ value: m.value, label: m.label, description: m.hint ?? "" })),
      { value: "__back", label: "返回" },
    ];
    const list = new SelectList(items, Math.min(items.length, 14), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "__back") this.showModelProvider(i);
      else {
        this.members[i]!.model = item.value;
        this.showIdentity(i);
      }
    });
    list.onCancel = () => this.showModelProvider(i);
    this.setActive(list, "model", `成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 模型 · ${group.group}`);
  }

  private showModelInput(i: number): void {
    const input = new Input();
    input.onSubmit = this.safe(() => {
      const m = input.getValue().trim();
      if (m) this.members[i]!.model = m;
      this.showIdentity(i);
    });
    input.onEscape = () => this.showModelProvider(i);
    this.setActive(input, "modelInput", `成员 ${i + 1}/${this.size} — 输入模型 id（回车确认）`);
  }

  /** 逐个成员输入一句话身份/职责（可回车跳过）——持久化到 team.json，每次进群都会注入 */
  private showIdentity(i: number): void {
    const input = new Input();
    input.onSubmit = this.safe(() => {
      const role = input.getValue().trim();
      if (role) this.members[i]!.role = role;
      if (i + 1 < this.size) this.showName(i + 1);
      else this.showManualConfirm();
    });
    input.onEscape = this.safe(() => (this.members[i]!.type === "custom" ? this.showCmd(i) : this.showModelProvider(i)));
    this.setActive(
      input,
      "identity",
      `成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 一句话身份/职责（回车跳过）`,
    );
  }

  /** 手动配置的确认块（含职责） */
  private manualLines(): string[] {
    const out: string[] = [];
    for (const m of this.members) {
      const c = m.color ?? "36";
      const cmd = withModel(m.command ?? "", m.type ?? "custom", m.model);
      out.push(`   ${fg(c, (m.name ?? "").padEnd(12))} ${dim((m.type ?? "").padEnd(7))} ${dim(cmd)}`);
      if (m.model) out.push(`     ${dim("模型")} ${m.model}`);
      if (m.role) out.push(`     ${dim("职责")} ${truncateToWidth(m.role, 96, "…")}`);
    }
    return out;
  }

  private showManualConfirm(): void {
    const list = new SelectList(
      [
        { value: "go", label: "创建并启动", description: "写入团队历史并拉起 tmux 引擎" },
        { value: "redo", label: "重新配置" },
        { value: "quit", label: "退出" },
      ],
      3,
      THEME,
    );
    list.onSelect = this.safe((item: { value: string }) => {
      if (item.value === "go") this.onSubmitResult?.({ action: "create", config: this.configManual() });
      else if (item.value === "redo") this.showSize();
      else this.onSubmitResult?.({ action: "quit" });
    });
    list.onCancel = () => this.showCmd(this.size - 1);
    this.setActive(list, "confirm", `确认团队（${this.size} 名成员）`);
  }

  private configManual(): TeamConfig {
    const id = newSessionId(`${this.size}up`);
    return {
      id,
      name: `${this.size}up-${this.members.map((m) => m.name).join("+")}`.slice(0, 60),
      createdAt: new Date().toISOString(),
      cwd: this.cwd,
      tmuxSession: `zebra-${id}`,
      members: this.members.map((m) => ({
        id: m.id!,
        name: m.name!,
        type: m.type!,
        command: withModel(m.command!, m.type!, m.model),
        resumeCommand: withModel(m.resumeCommand ?? m.command!, m.type!, m.model),
        color: m.color,
        role: m.role,
        model: m.model,
      })) as Member[],
    };
  }

  // ---------- 组件接口 ----------
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.stopSpinner();
      this.onSubmitResult?.({ action: "quit" });
      return;
    }
    if (this.step === "genLoading") {
      if (matchesKey(data, "escape")) {
        this.stopSpinner();
        this.showGenInput();
        this.error = "已取消（生成进程会在后台超时结束）";
      }
      return;
    }
    if (this.step === "builderTesting") {
      if (matchesKey(data, "escape")) {
        this.builderAbort?.abort();
        this.builderAbort = undefined;
        this.stopSpinner();
        this.showBuilder();
        this.error = "已取消测试";
      }
      return;
    }
    if (this.step === "builderFetch") {
      if (matchesKey(data, "escape")) {
        this.builderModelsAbort?.abort();
        this.builderModelsAbort = undefined;
        this.stopSpinner();
        this.showBuilderKey();
        this.error = "已取消拉取";
      }
      return;
    }
    try {
      this.active?.handleInput?.(data);
    } catch (e) {
      this.fail(e);
    }
  }
  invalidate(): void {}
  get focused(): boolean {
    return true;
  }
  set focused(v: boolean) {
    const a = this.active as { focused?: boolean } | undefined;
    if (a && "focused" in a) a.focused = v;
  }
}

/** 运行初始界面（logo + 模式选择 + 向导），直到用户做出选择 */
export async function runWizardFlow(cwd: string): Promise<WizardResult> {
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 });
  const wizard = new Wizard(tui, cwd);
  const done = new Promise<WizardResult>((resolve) => {
    wizard.onSubmitResult = (r) => {
      tui.stop();
      resolve(r);
    };
  });
  tui.setLayoutRoot(wizard as unknown as Component);
  tui.setFocus(wizard);
  tui.addInputListener((data) => {
    if (matchesKey(data, "ctrl+c")) {
      wizard.handleInput(data);
      return { consume: true };
    }
    return undefined;
  });
  wizard.start();
  tui.start();
  return await done;
}