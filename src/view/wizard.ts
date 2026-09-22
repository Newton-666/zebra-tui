// zebra — first-run flow: session chooser + team setup wizard
import {
  Input,
  SelectList,
  Text,
  TuiAltScreen,
  ProcessTerminal,
  matchesKey,
  truncateToWidth,
  type Component,
  type Focusable,
  type TUI,
} from "../../deps/pi-tui/dist/index.js";
import { bold, dim, fg } from "../ui/ansi.ts";
import { DEFAULT_COMMANDS, MEMBER_COLORS, type Member, type MemberType, type TeamConfig } from "../types.ts";
import { listSessions, newSessionId } from "../team.ts";
import fs from "node:fs";

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
  | { action: "quit" };

const TYPE_ITEMS: { value: MemberType; label: string; description: string }[] = [
  { value: "pi", label: "pi", description: "pi coding agent" },
  { value: "hermes", label: "hermes", description: "hermes agent (chat)" },
  { value: "codex", label: "codex", description: "openai codex cli" },
  { value: "kimi", label: "kimi", description: "kimi code cli" },
  { value: "custom", label: "custom…", description: "自定义启动命令" },
];

function uniqueName(base: string, taken: string[]): string {
  let name = base;
  let i = 2;
  while (taken.includes(name)) name = `${base}${i++}`;
  return name;
}

const rule = (width: number) => fg("36", `─`.repeat(Math.max(0, width)));
const inverse = (s: string) => `\x1b[7m${s}\x1b[27m`;

class Wizard implements Component, Focusable {
  onSubmitResult?: (r: WizardResult) => void;

  private instr = new Text("", 0, 0);
  private error = "";
  private active:
    | (Component & { onSubmit?: (v: string) => void; onEscape?: () => void; onSelect?: (item: { value: string }) => void; onCancel?: () => void })
    | undefined;

  private size = 4;
  private members: Partial<Member>[] = [];
  private cwd: string;
  private sessionsCount: number;
  private tui: TUI;

  constructor(tui: TUI, cwd: string, sessionsCount: number) {
    this.tui = tui;
    this.cwd = cwd;
    this.sessionsCount = sessionsCount;
  }

  start(): void {
    this.buildChooserOrSize();
  }

  private fail(e: unknown): void {
    this.error = e instanceof Error ? e.message : String(e);
    try {
      fs.appendFileSync("/tmp/zebra-crash.log", `${new Date().toISOString()} [wizard] ${e instanceof Error ? (e.stack ?? e.message) : String(e)}\n`);
    } catch {}
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

  private setActive(w: typeof this.active): void {
    this.active = w;
    this.tui.requestRender();
  }

  private renderChrome(instruction: string): void {
    this.instr.setText(instruction);
  }

  render(width: number): string[] {
    const out: string[] = [];
    const title = truncateToWidth(
      `${bold(inverse(" Krystal "))} ${dim("团队配置")} ${dim(`· ${this.sessionsCount} 个历史团队 · cwd: ${this.cwd}`)}`,
      width,
    );
    out.push(title);
    out.push(rule(width));
    for (const line of this.instr.render(width)) out.push(line);
    if (this.error) {
      out.push(fg("31", `⚠ ${this.error}  (详情 /tmp/zebra-crash.log)`));
    }
    out.push(rule(width));
    if (this.active) out.push(...this.active.render(width));
    out.push(rule(width));
    out.push(truncateToWidth(dim("esc 上一步 · enter 确认"), width));
    return out;
  }

  private buildChooserOrSize(): void {
    this.error = "";
    const sessions = listSessions();
    if (sessions.length === 0) {
      this.buildSizeStep();
      return;
    }
    this.renderChrome("选择一个历史团队恢复，或新建：");
    const items = [
      { value: "__new", label: "➕ 新建团队", description: "配置大小与成员" },
      ...sessions.map((s) => ({
        value: s.id,
        label: `▸ ${s.name}`,
        description: `${s.members.map((m) => m.name).join(", ")} · ${s.createdAt.slice(0, 16).replace("T", " ")}`,
      })),
    ];
    const list = new SelectList(items, Math.min(items.length, 10), THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (!this.onSubmitResult) return;
      if (item.value === "__new") this.buildSizeStep();
      else this.onSubmitResult({ action: "resume", id: item.value });
    });
    list.onCancel = this.safe(() => this.buildSizeStep());
    this.setActive(list);
  }

  private buildSizeStep(): void {
    this.error = "";
    this.members = [];
    this.renderChrome("团队几名成员？（1–6）");
    const items = [1, 2, 3, 4, 5, 6].map((n) => ({
      value: String(n),
      label: `${n} 名成员`,
      description: n === 1 ? "单 agent" : "双列网格",
    }));
    const list = new SelectList(items, 6, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      this.size = Number(item.value);
      this.members = Array.from({ length: this.size }, () => ({}));
      this.buildNameStep(0);
    });
    list.onCancel = () => this.buildChooserOrSize();
    this.setActive(list);
  }

  private buildNameStep(i: number): void {
    this.error = "";
    const taken = this.members.map((m) => m.name).filter(Boolean) as string[];
    const def = uniqueName(TYPE_ITEMS[i % 4]!.label, taken);
    this.renderChrome(`成员 ${i + 1}/${this.size} — 名字：`);
    const input = new Input();
    input.setValue(def);
    input.onSubmit = this.safe(() => {
      const name = (input.getValue().trim() || def).replace(/\s+/g, "-");
      this.members[i]!.name = name;
      this.members[i]!.id = name;
      this.buildTypeStep(i);
    });
    input.onEscape = this.safe(() => (i === 0 ? this.buildSizeStep() : this.buildTypeStep(i - 1)));
    this.setActive(input);
  }

  private buildTypeStep(i: number): void {
    this.error = "";
    this.renderChrome(`成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 类型：`);
    const list = new SelectList(TYPE_ITEMS, TYPE_ITEMS.length, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      const type = item.value as MemberType;
      this.members[i]!.type = type;
      if (type === "custom") {
        this.buildCmdStep(i);
        return;
      }
      this.members[i]!.command = DEFAULT_COMMANDS[type]!.command;
      this.members[i]!.resumeCommand = DEFAULT_COMMANDS[type]!.resume;
      this.members[i]!.color = MEMBER_COLORS[type];
      if (i + 1 < this.size) this.buildNameStep(i + 1);
      else this.buildConfirmStep();
    });
    list.onCancel = this.safe(() => this.buildNameStep(i));
    this.setActive(list);
  }

  private buildCmdStep(i: number): void {
    this.error = "";
    this.renderChrome(`成员 ${i + 1}/${this.size} (${this.members[i]!.name}) — 启动命令：`);
    const input = new Input();
    input.onSubmit = this.safe(() => {
      this.members[i]!.command = input.getValue().trim() || "bash";
      this.members[i]!.resumeCommand = this.members[i]!.command;
      this.members[i]!.color = MEMBER_COLORS.custom;
      if (i + 1 < this.size) this.buildNameStep(i + 1);
      else this.buildConfirmStep();
    });
    input.onEscape = this.safe(() => this.buildTypeStep(i));
    this.setActive(input);
  }

  private buildConfirmStep(): void {
    this.error = "";
    const lines = this.members
      .map((m, i) => `  ${fg(m.color || "36", bold(String(i + 1)))} ${m.name} ${dim(`(${m.type})`)} ${dim(`→ ${m.command}`)}`)
      .join("\n");
    this.renderChrome(`确认团队（${this.size} 名成员）：\n${lines}`);
    const items = [
      { value: "go", label: "🚀 创建并启动", description: "写入团队历史并拉起 tmux 引擎" },
      { value: "size", label: "↩ 重新配置大小/成员" },
      { value: "quit", label: "🚪 退出" },
    ];
    const list = new SelectList(items, items.length, THEME);
    list.onSelect = this.safe((item: { value: string }) => {
      if (!this.onSubmitResult) return;
      if (item.value === "go") this.onSubmitResult({ action: "create", config: this.buildConfig() });
      else if (item.value === "size") this.buildSizeStep();
      else this.onSubmitResult({ action: "quit" });
    });
    list.onCancel = this.safe(() => this.buildCmdStep(this.size - 1));
    this.setActive(list);
  }

  private buildConfig(): TeamConfig {
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
        command: m.command!,
        resumeCommand: m.resumeCommand,
        color: m.color,
      })) as Member[],
    };
  }

  // --- Component/Focusable
  handleInput(data: string): void {
    if (matchesKey(data, "ctrl+c")) {
      this.onSubmitResult?.({ action: "quit" });
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

/** Run the first-run flow; resolves when the user picked something. */
export async function runWizardFlow(cwd: string): Promise<WizardResult> {
  const terminal = new ProcessTerminal();
  const tui: TUI = new TuiAltScreen(terminal, false, undefined, { wheelScrollLines: 3 });
  const wizard = new Wizard(tui, cwd, listSessions().length);
  const done = new Promise<WizardResult>((resolve) => {
    wizard.onSubmitResult = (r) => {
      tui.stop();
      resolve(r);
    };
  });
  tui.setLayoutRoot(
    new (class implements Component {
      private w: Wizard;
      constructor(w: Wizard) {
        this.w = w;
      }
      render(width: number): string[] {
        return this.w.render(width);
      }
      invalidate(): void {
        this.w.invalidate();
      }
      handleInput(data: string): void {
        this.w.handleInput(data);
      }
    })(wizard),
  );
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
