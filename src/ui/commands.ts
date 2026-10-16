// Krystal Bot — 命令表 + `/` 命令列表补全（与 pi 同款观感）
//
// 交互：输入 `/` 立刻弹出全部命令（名字 + 描述），↑↓ 选择 · enter 补全为 `/name `；
//       继续打字母即模糊过滤。`:name` 与 `/name` 等价（平台约定），所以两个前缀都能弹列表。
// 实现：pi 用的是 pi-tui 的 CombinedAutocompleteProvider（命令 + 文件补全）；这里只做命令 ——
//       不掺文件补全（Bot 的读文件是 read_file 工具，弹文件列表会误导），
//       好处是命令表成为**唯一真源**：列表、/help 文案、未知命令提示都从这里生成，永不漂移。
import {
  fuzzyFilter,
  type AutocompleteItem,
  type AutocompleteProvider,
  type AutocompleteSuggestions,
} from "../../deps/pi-tui/dist/index.js";

export interface BotCommand {
  /** 不含前缀的命令名（`/resume` 的 `resume`） */
  name: string;
  /** 参数提示，例 `<名称>`（与 pi 同规则：显示在描述之前） */
  argumentHint?: string;
  description: string;
  /** 等价写法（只在描述里注明，不单列一项，保持列表短） */
  aliases?: string[];
}

export const BOT_COMMANDS: BotCommand[] = [
  {
    name: "resume",
    aliases: ["sessions"],
    description: "回溯历史会话（↑↓ 选择 · enter 恢复 · d 删除 · esc 返回）",
  },
  {
    name: "farewell",
    description: "告别这一世：写一段告别（模型）+ 完整时间线（机械）→ 重生（不可逆；想先巩固记忆用 /sleep）",
  },
  { name: "new", description: "立刻换一世（无仪式；告别用 /farewell）" },
  { name: "name", argumentHint: "<名称>", description: "给当前会话命名（历史列表里可见）" },
  { name: "model", description: "切换模型（弹窗：来源 → 模型）" },
  { name: "login", description: "配置平台 API（Base URL / Key / 模型名）" },
  { name: "memory", aliases: ["mem"], description: "查看记忆图（统计 · 实体事实树 · 关联 · 矛盾）" },
  {
    name: "divert",
    argumentHint: "<任务>",
    description: "派发旁路会话（一次性；带主会话上下文出发，结论留在块里不进主上下文）",
  },
  { name: "stop", description: "中断全部在跑的旁路会话" },
  { name: "sleep", argumentHint: "[undo]", description: "记忆睡眠整理（undo 反演最近一次）" },
  { name: "help", description: "命令与快捷键" },
];

/** pi 同款描述格式：`<hint> — <desc>`；help 里调用名已带 hint，就不再重复（withHint=false） */
const describe = (c: BotCommand, withHint = true): string => {
  const alias = c.aliases?.length ? `（别名 ${c.aliases.map((a) => `/${a}`).join(" · ")}）` : "";
  const desc = `${c.description}${alias}`;
  return withHint && c.argumentHint ? `${c.argumentHint} — ${desc}` : desc;
};

const toItem = (c: BotCommand): AutocompleteItem => ({
  value: c.name,
  label: c.name,
  description: describe(c),
});

/** 补全列表的条目（供测试与扩展） */
export const commandItems = (): AutocompleteItem[] => BOT_COMMANDS.map(toItem);

/** `/help` 正文：一行一条（同源生成，永不与列表漂移；单行长文案会被 Transcript 截断 → 不能挤在一行） */
export const helpLines = (): string[] => {
  const invocation = (c: BotCommand) => `/${c.name}${c.argumentHint ? ` ${c.argumentHint}` : ""}`;
  const width = Math.max(...BOT_COMMANDS.map((c) => invocation(c).length));
  return BOT_COMMANDS.map((c) => `  ${invocation(c).padEnd(width)}  ${describe(c, false)}`);
};

/** 未知命令提示里的可用命令清单（与命令表同源） */
export const commandNames = (): string => BOT_COMMANDS.map((c) => `/${c.name}`).join(" · ");

const SIGILS = ["/", ":"] as const;

/**
 * 命令列表 provider：只认「整行就是一个 `/xx` 或 `:xx` 词」的那一瞬。
 * 刻意不认消息中的路径（`/etc/hosts`、`见 src/a.ts`）——那些交给模型，不该弹列表。
 */
export class CommandProvider implements AutocompleteProvider {
  triggerCharacters = [...SIGILS];
  private items: AutocompleteItem[];

  constructor(commands: BotCommand[] = BOT_COMMANDS) {
    this.items = commands.map(toItem);
  }

  /** 返回待过滤 token（含前缀）；不是命令上下文则 null */
  private token(lines: string[], cursorLine: number, cursorCol: number): string | null {
    if (cursorLine !== 0) return null; // 命令只落在首行（与编辑器 slash 菜单同规则）
    const before = (lines[cursorLine] ?? "").slice(0, cursorCol);
    const m = /^[/:]\S*$/.exec(before);
    return m ? m[0] : null;
  }

  async getSuggestions(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): Promise<AutocompleteSuggestions | null> {
    const prefix = this.token(lines, cursorLine, cursorCol);
    if (prefix === null) return null;
    const items = fuzzyFilter(this.items, prefix.slice(1), (i) => i.value);
    if (items.length === 0) return null;
    return { items, prefix };
  }

  applyCompletion(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
    item: AutocompleteItem,
    prefix: string,
  ): { lines: string[]; cursorLine: number; cursorCol: number } {
    const line = lines[cursorLine] ?? "";
    const start = cursorCol - prefix.length;
    const sigil = prefix[0] ?? "/"; // 用户写 `:` 就保持 `:`（两者等价，不擅自改写法）
    const replacement = `${sigil}${item.value} `;
    const out = [...lines];
    out[cursorLine] = line.slice(0, start) + replacement + line.slice(cursorCol);
    return { lines: out, cursorLine, cursorCol: start + replacement.length };
  }
}