// Krystal Bot — 命令列表（`/` 补全）回归测试（确定性，零 API、零 TTY）
// 用法：npm run test:commands
//
// 覆盖：
//   ① 输入 `/` 即列出全部命令（与 pi 同款：名字 + 描述）
//   ② 模糊过滤（/re → resume；/mo → model/memory）
//   ③ 补全结果 = `/name `（带尾空格，可直接接着打字）
//   ④ `:` 前缀等价（同样弹列表，补全保留 `:` 写法）
//   ⑤ 不打扰：消息里的路径（/etc/hosts）、已带参数（/resume x）、非首行、无匹配 → 不弹
//   ⑥ 单一真源：/help 文案与未知命令清单都从命令表生成，不会与列表漂移
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krystal-cmdtest-"));
process.env.HOME = TMP;
process.env.KRISTAL_SESSIONS_DIR = path.join(TMP, "sessions");

const { CommandProvider, BOT_COMMANDS, helpLines, commandNames, commandItems } = await import("../src/ui/commands.ts");

type Sug = { items: { value: string; label: string; description?: string }[]; prefix: string };
const p = new CommandProvider();
const ask = async (line: string, cursorCol = line.length, cursorLine = 0): Promise<Sug | null> =>
  (await p.getSuggestions([line], cursorLine, cursorCol)) as Sug | null;
const complete = (line: string, value: string, prefix: string) => {
  const item = commandItems().find((i) => i.value === value)!;
  return p.applyCompletion([line], 0, line.length, item, prefix);
};

// ── ① 输入 "/" → 全部命令
{
  const s = await ask("/");
  assert.ok(s, "打 / 应弹出命令列表");
  assert.deepEqual(
    s!.items.map((i) => i.value),
    BOT_COMMANDS.map((c) => c.name),
    "打 / 应列出全部命令（顺序与命令表一致）",
  );
  assert.equal(s!.prefix, "/", "前缀应是 /（编辑器据此选 slash 两栏布局）");
  assert.ok(s!.items.every((i) => i.label === i.value), "label 是命令名（pi 同款，不带前缀）");
  assert.ok(s!.items.every((i) => (i.description ?? "").length > 0), "每条都要有描述");
  const withHint = BOT_COMMANDS.find((c) => c.argumentHint)!;
  const item = s!.items.find((i) => i.value === withHint.name)!;
  assert.ok(item.description!.startsWith(withHint.argumentHint!), "pi 同款描述格式：`<hint> — <desc>`");
  const withAlias = BOT_COMMANDS.find((c) => c.aliases?.length)!;
  assert.ok(s!.items.find((i) => i.value === withAlias.name)!.description!.includes("/sessions"), "别名写进描述");
  console.log("1) 打 / 列出全部命令（名字 + 描述 + 参数提示 + 别名）✓");
}

// ── ② 模糊过滤
{
  assert.deepEqual((await ask("/re"))!.items.map((i) => i.value)[0], "resume", "/re 首选 resume");
  const mo = (await ask("/mo"))!.items.map((i) => i.value);
  assert.ok(mo.includes("model") && mo.includes("memory"), "/mo 应命中 model 与 memory");
  assert.deepEqual((await ask("/mem"))!.items.map((i) => i.value), ["memory"], "/mem 只命中 memory");
  console.log("2) 模糊过滤（/re · /mo · /mem）✓");
}

// ── ③ 补全成 `/name `
{
  const r = complete("/re", "resume", "/re");
  assert.equal(r.lines[0], "/resume ", "补全应带尾空格（可直接接着打字）");
  assert.equal(r.cursorCol, "/resume ".length, "光标落在补全之后");
  const mid = p.applyCompletion(["/re后面"], 0, 3, commandItems().find((i) => i.value === "resume")!, "/re");
  assert.equal(mid.lines[0], "/resume 后面", "补全只替换命令词，不吞后面的文本");
  console.log("3) 补全 `/name `（带尾空格 · 光标位置 · 不吞后文）✓");
}

// ── ④ `:` 等价
{
  const s = await ask(":sl");
  assert.ok(s && s.items[0]!.value === "sleep", ":sl 应命中 sleep（冒号等价）");
  assert.equal(complete(":sl", "sleep", ":sl").lines[0], ":sleep ", "冒号前缀补全后仍是冒号");
  assert.ok(p.triggerCharacters.includes("/") && p.triggerCharacters.includes(":"), "两个前缀都要能自动触发");
  console.log("4) `:` 与 `/` 等价（同样弹列表 · 保留原写法）✓");
}

// ── ⑤ 不打扰：路径 / 已带参数 / 非首行 / 无匹配
{
  assert.equal(await ask("/etc/hosts"), null, "消息里的路径不该弹命令列表");
  assert.equal(await ask("/resume 已带参数"), null, "/resume 已有参数 → 不再弹（参数由模型/弹窗处理）");
  assert.equal(await ask("/re", 3, 1), null, "非首行不弹（与编辑器 slash 菜单同规则）");
  assert.equal(await ask("/zzz"), null, "无匹配 → 不弹（不显示空列表）");
  assert.equal(await ask("abc /re"), null, "行首不是命令 → 不弹");
  console.log("5) 不打扰（路径 · 已带参数 · 非首行 · 无匹配 · 行首非命令）✓");
}

// ── ⑥ 单一真源：help / 未知命令提示与列表同源；bot-view 用同一张表
{
  const help = helpLines().join("\n");
  const names = commandNames();
  for (const c of BOT_COMMANDS) {
    assert.ok(help.includes(`/${c.name}`), `/help 应包含 /${c.name}`);
    assert.ok(names.includes(`/${c.name}`), `未知命令提示应包含 /${c.name}`);
  }
  assert.equal(helpLines().length, BOT_COMMANDS.length, "help 行数 = 命令数（一行一条，不会被截断吃掉命令）");
  assert.ok(helpLines().every((l) => l.startsWith("  /")), "help 每行以命令开头，便于扫读");
  assert.ok(
    helpLines().every((l) => l.length <= 100),
    "单行不过宽（Transcript 会按终端宽度截断）",
  );
  const botView = fs
    .readFileSync(new URL("../src/view/bot-view.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
  assert.ok(botView.includes("new CommandProvider()"), "bot-view 必须挂上 CommandProvider");
  assert.ok(!/可用 \/resume · \/name/.test(botView), "未知命令提示不得再手写命令清单（与命令表漂移）");
  assert.ok(botView.includes("helpLines()") && botView.includes("commandNames()"), "/help 与未知命令提示应从命令表生成");
  console.log("6) 单一真源（/help · 未知命令提示 · 列表同表）✓");
}

// ── ⑦ 真实 Editor 接线：打 / 真会弹出列表，enter 补全并立即执行（pi 同款 fall-through submit）
// 用真实 pi-tui Editor + 真实 EDITOR_THEME（顺带验证主题里配了 selectList —— 否则下拉渲染会抛）
{
  const { Editor } = await import("../deps/pi-tui/dist/index.js");
  const { EDITOR_THEME } = await import("../src/view/bot-view.ts");
  const stub = { requestRender() {}, terminal: { rows: 40, cols: 100 } };
  const submitted: string[] = [];
  const editor = new Editor(stub as never, EDITOR_THEME, { autocompleteMaxVisible: 8 });
  editor.setAutocompleteProvider(new CommandProvider());
  editor.focused = true;
  editor.onSubmit = (t: string) => submitted.push(t);
  const rows = () => editor.render(70).map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
  const settle = () => new Promise((r) => setTimeout(r, 30)); // 等 debounce + 异步 getSuggestions

  editor.handleInput("/");
  await settle();
  assert.equal(
    rows().filter((l) => BOT_COMMANDS.some((c) => new RegExp(`^\\s*(→\\s+)?${c.name}\\b`).test(l))).length,
    BOT_COMMANDS.length,
    "打 / 应弹出全部命令",
  );
  assert.ok(rows().some((l) => l.includes("→")), "默认选中第一项（↑↓ 可移动）");

  for (const ch of "sl") editor.handleInput(ch);
  await settle();
  assert.equal(rows().filter((l) => l.includes("sleep")).length, 1, "继续打字母应模糊过滤");

  editor.handleInput("\r");
  await settle();
  assert.deepEqual(submitted, ["/sleep"], "enter 补全为 /sleep 并立即执行（与 pi 同款：行首 / 的补全确认后直接提交）");

  // 普通消息里的路径不得弹列表（渲染高度 3 = 上下两条线 + 1 行文本）
  const e2 = new Editor(stub as never, EDITOR_THEME, { autocompleteMaxVisible: 8 });
  e2.setAutocompleteProvider(new CommandProvider());
  e2.focused = true;
  for (const ch of "看看 /etc/hosts 里") e2.handleInput(ch);
  await settle();
  assert.equal(e2.render(70).length, 3, "消息含路径时不弹命令列表");
  console.log("7) 真实 Editor 接线（/ 弹列表 · 模糊过滤 · enter 执行 · 路径不扰）✓");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nKrystal Bot 命令列表回归：全部通过 · 7 组");