// Krystal · harness 守卫（冻结契约的可执行版本）
// 用法：npm run guard
//
// 三件事（对应 docs/harness-map.md §4/§5）：
//   ① 方向：harness 六模块不得 import view/、ui/、pi-tui（UI 可以 import harness，反之不行）
//   ② 指纹：SYSTEM 与 TOOLS（名字+描述）必须与 docs/harness-map.md §4 记录的一致
//   ③ 契约：事件类型（5）与 memory 的 op（9）数目/集合不得变
//
// 失败时**不要**改本文件来让它变绿 —— 先回答 "docs/harness-map.md §6：能不能用那 5 个入口达成？"；
// 确实必须改 harness，才更新 harness-map §4 的指纹 + §9 账本写明理由，然后同步这里的快照。
import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const read = (p: string) => fs.readFileSync(path.join(ROOT, p), "utf8");
const sha = (s: string) => createHash("sha1").update(s).digest("hex").slice(0, 12);

// ── 冻结契约（与 docs/harness-map.md §4 一一对应）
const EXPECT = {
  system: "c58a45237437",
  tools: "cdef2b5ef303",
  toolNames: ["list_dir", "read_file", "memory", "run_command", "write_file", "edit_file"],
  events: 5,
  ops: 9,
};
/** harness 六模块（只允许往下依赖） */
const HARNESS = ["src/bot.ts", "src/context.ts", "src/session.ts", "src/memory.ts", "src/gate.ts", "src/windows.ts"];

const fails: string[] = [];
/**
 * 已知豁免：**每一项都对应 harness-map §9 账本里的一条**（不允许"静默忽略"）。
 * 清掉账本条目时，必须同时删掉这里的一条 —— 豁免到期就该变红。
 */
const EXEMPT: { from: string; dep: string; ledger: string }[] = [
  { from: "src/memory.ts", dep: "./ui/ansi.ts", ledger: "§9 #2：/memory 渲染（87 行 + 终端颜色）应搬到视图层" },
];
const hits: string[] = [];

// ① 方向
for (const f of HARNESS) {
  const src = read(f);
  for (const m of src.matchAll(/from "([^"]+)"/g)) {
    const dep = m[1]!;
    if (/^(\.\.\/)?(view|ui)\/|pi-tui/.test(dep) || dep.startsWith("./view/") || dep.startsWith("./ui/")) {
      const ex = EXEMPT.find((e) => e.from === f && e.dep === dep);
      if (ex) hits.push(`${f} → ${dep}（豁免：${ex.ledger}）`);
      else fails.push(`方向违约：${f} → ${dep}（harness 不得依赖 view/ui/pi-tui）`);
    }
  }
}

// ② 指纹（SYSTEM 用固定 cwd 占位符；TOOLS 用名字+描述）
const { SYSTEM, READER_TOOLS } = await import(path.join(ROOT, "src/bot.ts"));
const botSrc = read("src/bot.ts");
const writerBlock = /const WRITER_TOOLS: BotTool\[\] = \[[\s\S]*?\n\];/.exec(botSrc)?.[0] ?? "";
const writerNames = [...writerBlock.matchAll(/name: "(\w+)"/g)].map((m) => m[1]!);
const allNames = [...READER_TOOLS.map((t) => t.name), ...writerNames];
const sysFp = sha(SYSTEM("/__cwd__"));
const toolsFp = sha(JSON.stringify([...READER_TOOLS.map((t) => [t.name, t.description]), ...writerNames]));

if (sysFp !== EXPECT.system) fails.push(`SYSTEM 指纹变了：${EXPECT.system} → ${sysFp}（prompt 是缓存前缀的一部分，改它必须写明理由）`);
if (toolsFp !== EXPECT.tools) fails.push(`TOOLS 指纹变了：${EXPECT.tools} → ${toolsFp}`);
if (allNames.join(",") !== EXPECT.toolNames.join(",")) {
  fails.push(`工具清单变了：期望 [${EXPECT.toolNames.join(", ")}]，实际 [${allNames.join(", ")}]（工具面恒为 6 —— §5）`);
}

// ③ 契约：事件类型 / memory op
const eventTypes = [...new Set([...read("src/session.ts").matchAll(/t: "(\w+)"/g)].map((m) => m[1]!))];
if (eventTypes.length !== EXPECT.events) fails.push(`事件类型数变了：期望 ${EXPECT.events}，实际 ${eventTypes.length}（${eventTypes.join("/")}）`);
const opEnum = /enum: \[([^\]]*)\]/.exec(botSrc)?.[1] ?? "";
const ops = [...opEnum.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
if (ops.length !== EXPECT.ops) fails.push(`memory 的 op 数变了：期望 ${EXPECT.ops}，实际 ${ops.length}（${ops.join("/")}）`);

// ── 报告
if (fails.length) {
  console.error("\x1b[31mharness 守卫未通过\x1b[0m —— 这不是「改守卫」，是「先证明必须改 harness」：\n");
  for (const f of fails) console.error("  ✗ " + f);
  console.error("\n先看 docs/harness-map.md §6（5 个不改 harness 的入口）与 §8（checklist）。");
  process.exit(1);
}
console.log("harness 守卫 ✓  方向纯净 · SYSTEM/TOOLS 指纹一致 · 事件 5 种 · memory op 9 个");
for (const h of hits) console.log(`  ⚠ 已知豁免（到期即变红）：${h}`);
console.log(`  SYSTEM ${EXPECT.system} · TOOLS ${EXPECT.tools}`);
console.log(`  工具：${allNames.join(" · ")}`);