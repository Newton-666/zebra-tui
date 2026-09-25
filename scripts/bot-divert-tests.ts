// Krystal Bot — 旁路会话（/divert）回归测试（确定性，零 API、零 TTY）
// 用法：npm run test:divert
//
// 覆盖：
//   ① 存储与语义：delta-only 落盘、主会话 events 零污染、afterSeq 一数两用
//   ② 缓存护栏（本能力的命根子）：派发后主会话装配逐字节不变；旁路首次请求 = 主会话前缀 ⊕ 追加
//   ③ 块渲染：折叠/展开、结论预览、宽度严进严出（不得把外框撞破）
//   ④ 直播 → 落盘 → 重播 往返一致（用真实 toDivertEvent，不重写映射）
//   ⑤ 弹窗渲染：标题/说明/两条浅蓝线/键提示 + 蓝色方块光标 + esc 取消
//   ⑥ 状态语义：遗留 running → 中断（进程被杀过）；/stop 的中断态
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";

// 隔离 HOME / 会话目录：绝不碰真实会话与真实记忆库
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krystal-divtest-"));
process.env.HOME = TMP;
process.env.KRISTAL_SESSIONS_DIR = path.join(TMP, "sessions");

const { appendEvent, createBotSession, loadEvents } = await import("../src/session.ts");
const D = await import("../src/divert.ts");
const { assembleContext, withSystem } = await import("../src/context.ts");
const { SYSTEM } = await import("../src/bot.ts");
const { SubsessionBlock, createDivertPrompt } = await import("../src/view/subsession.ts");
const { EDITOR_THEME } = await import("../src/view/bot-view.ts");
const { visibleWidth } = await import("../deps/pi-tui/dist/index.js");

const at = new Date().toISOString();
const plain = (lines: string[]) => lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, "").trimEnd());
const vw = (s: string) => visibleWidth(s); // 权威宽度（会正确处理 pi-tui 的光标占位符 \x1b_pi:c）

// ── 造一个主会话（4 条事件：问 / 答带工具 / 工具结果 / 摘要）
const MAIN = createBotSession({ cwd: TMP, model: "m-test", tier: "写作者" }).id;
appendEvent(MAIN, { t: "msg", at, role: "user", content: "主会话第一问" });
appendEvent(MAIN, { t: "msg", at, role: "assistant", content: "主会话先看一下。", toolCalls: [{ id: "m1", name: "read_file", args: '{"path":"a.md"}' }] });
appendEvent(MAIN, { t: "msg", at, role: "tool", content: "a.md 的内容", toolCallId: "m1" });
appendEvent(MAIN, { t: "note", at, text: "早期对话摘要：主会话已确认 X" });
const afterSeq = loadEvents(MAIN).length;

// ── ① 存储与语义
const d = D.createDivert({ parent: MAIN, task: "调查 Y 的实现", model: "m-test", afterSeq });
D.appendDivertEvent(MAIN, d.id, { t: "msg", at, role: "user", content: "调查 Y 的实现" });
assert.equal(loadEvents(MAIN).length, afterSeq, "派发**不得**往主会话 events 里写任何东西（缓存 + 注意力的双保险）");
assert.equal(D.divertEvents(MAIN, d.id).length, 1, "旁路只落自己的 delta（不复制主会话前缀 → 原文只有一份）");
assert.equal(D.listDiverts(MAIN).length, 1, "listDiverts 能从磁盘读回");
assert.equal(D.loadDivert(MAIN, d.id)!.status, "running", "新派发是 running");
const ctx = D.divertContext(MAIN, d.id);
assert.equal(ctx.length, afterSeq + 1, "旁路上下文 = 主会话前缀 ⊕ 自己的事件");
assert.equal(
  JSON.stringify(ctx.slice(0, afterSeq)),
  JSON.stringify(loadEvents(MAIN).slice(0, afterSeq)),
  "前缀是主会话 events 的**只读切片**（逐字节相同）",
);
assert.equal(ctx[ctx.length - 1]!.t === "msg" && ctx[ctx.length - 1]!.role === "user", true, "任务作为尾巴追加");
console.log("1) 存储与语义（delta-only · 主会话零污染 · 前缀切片）✓");

// ── ② 缓存护栏：主前缀逐字节不变 + 旁路首请求是「严格扩展」
{
  const system = SYSTEM(TMP);
  const opts = { system, foldAt: 1e9, summarizeAt: 1e9, keepRecent: 6 };
  const hash = (x: unknown) => createHash("sha1").update(JSON.stringify(x)).digest("hex").slice(0, 12);
  const mainBefore = withSystem(system, assembleContext({ ...opts, events: loadEvents(MAIN) }));

  // 派发第一个旁路（已在上方完成）→ 再派发一个，模拟多次派发
  const d2 = D.createDivert({ parent: MAIN, task: "调查 Z", model: "m-test", afterSeq: loadEvents(MAIN).length });
  D.appendDivertEvent(MAIN, d2.id, { t: "msg", at, role: "user", content: "调查 Z" });

  const mainAfter = withSystem(system, assembleContext({ ...opts, events: loadEvents(MAIN) }));
  assert.equal(hash(mainAfter), hash(mainBefore), "派发前后主会话装配**逐字节**相同 → 前缀缓存绝不受影响");

  const divMsgs = withSystem(system, assembleContext({ ...opts, events: D.divertContext(MAIN, d.id) }));
  assert.equal(
    JSON.stringify(divMsgs.slice(0, mainAfter.length)),
    JSON.stringify(mainAfter),
    "旁路首次请求 = 主会话前缀 ⊕ 追加 → 严格扩展，provider 前缀缓存必命中",
  );
  assert.ok(divMsgs.length > mainAfter.length, "旁路只多出自己那几条（任务 + 它的工具与回答）");
  console.log("2) 缓存护栏（主前缀逐字节不变 · 旁路首请求严格扩展）✓");
}

// ── ③ 块渲染 + ④ 往返一致
const LIVE = [
  { type: "thinking", delta: "先看 docs 里 tree 的说法" },
  { type: "text", delta: "我先翻一下文档。" },
  {
    type: "assistant",
    content: "我先翻一下文档。",
    toolCalls: [{ id: "c1", name: "read_file", args: '{"path":"docs/session-format.md"}' }],
  },
  { type: "tool_start", id: "c1", name: "read_file", args: '{"path":"docs/session-format.md"}' },
  { type: "tool_result", id: "c1", name: "read_file", ok: true, denied: false, output: "第一行命中\n第二行命中" },
  { type: "usage", prompt: 12400, cached: 11800, completion: 220 }, // 真实用量（provider 每轮都带）
  { type: "text", delta: "结论：pi 的 /tree 是原地导航。" },
  { type: "final", text: "结论：pi 的 /tree 是原地导航。" },
] as const;

const block = new SubsessionBlock({ id: d.id, task: "调查 Y 的实现" });
let think = "";
for (const e of LIVE) {
  block.feedLive(e as never);
  if (e.type === "thinking") think += e.delta;
  const ev = D.toDivertEvent(e as never, { model: "m-test", thinking: think });
  if (ev) D.appendDivertEvent(MAIN, d.id, ev);
  if (e.type === "assistant" || e.type === "final") think = "";
}

// 折叠（运行中）：只有标题 + 活行，嵌套内容不可见
{
  const running = new SubsessionBlock({ id: "d-run", task: "调查 Y 的实现" });
  running.feedLive({ type: "thinking", delta: "先看 docs" } as never);
  const lines = plain(running.render(90));
  assert.ok(lines[0]!.includes("subsession") && lines[0]!.includes("调查 Y 的实现"), "标题行含 subsession + 任务");
  assert.ok(lines.join("\n").includes("思考中"), "折叠态显示活状态（subsession working）");
  assert.ok(!lines.join("\n").includes("先看 docs"), "折叠态**不**显示嵌套内容");
  assert.ok(lines[0]!.includes("ctrl+o"), "折叠态给出展开提示");
}

// 展开：嵌套内容 + 左框；状态行收尾
block.toggle();
{
  const lines = plain(block.render(90));
  const body = lines.join("\n");
  assert.ok(body.includes("先看 docs 里 tree 的说法"), "展开后能看到思考");
  assert.ok(body.includes("read_file"), "展开后能看到工具调用");
  assert.ok(/read_file.*2 行/.test(body), "工具结果按平台约定只给行数（read_file 不回显内容）");
  assert.ok(body.includes("结论：pi 的 /tree 是原地导航。"), "展开后能看到回答");
  assert.ok(lines.slice(2).some((l) => l.includes("│")), "展开内容带左框（框内是子树）");
  assert.ok(lines[lines.length - 1]!.includes("完成"), "尾部状态行显示完成");
  assert.ok(lines[0]!.includes("▾ ctrl+o"), "展开态提示变为收起");
}

// 折叠（完成）：预览结论首行
{
  block.toggle();
  const lines = plain(block.render(90));
  assert.equal(lines.length, 2, "折叠后只有标题 + 预览两行");
  assert.ok(lines[1]!.includes("结论：pi 的 /tree 是原地导航。"), "折叠态预览结论首行");
}

// 宽度严进严出：不同宽度下每行都不得超宽（否则会把外框撞破）
for (const w of [40, 60, 90, 120]) {
  for (const expanded of [false, true]) {
    block.expanded = expanded;
    for (const l of block.render(w)) {
      assert.ok(vw(l) <= w, `宽度 ${w}（展开=${expanded}）下超宽：${JSON.stringify(plain([l])[0])}`);
    }
  }
}
console.log("3) 块渲染（折叠/展开 · 结论预览 · 宽度严进严出）✓");

// ④ 直播 → 落盘 → 重播：渲染必须一致
{
  block.expanded = true;
  const live = plain(block.render(90));
  const replayed = new SubsessionBlock({ id: d.id, task: "调查 Y 的实现" });
  replayed.loadFrom(D.divertEvents(MAIN, d.id));
  replayed.setStatus("done");
  replayed.expanded = true;
  const after = plain(replayed.render(90));
  assert.deepEqual(after, live, "重播渲染 == 直播渲染（重启后看到的东西与当时一致）");
  console.log("4) 直播 → 落盘 → 重播 往返一致 ✓");
}

// ── ⑤ 弹窗渲染（真实 Editor + 真实主题）
{
  const stub = { requestRender() {}, terminal: { rows: 40, cols: 100 } };
  let cancelled = 0;
  let submitted = "";
  const prompt = createDivertPrompt(stub as never, {
    theme: EDITOR_THEME,
    onSubmit: (t) => (submitted = t),
    onCancel: () => (cancelled += 1),
  });
  const W = 76;
  const raw = prompt.render(W);
  const lines = plain(raw);
  assert.ok(lines[0]!.includes("派发旁路会话"), "标题");
  assert.ok(lines.join("\n").includes("带主会话当前上下文出发"), "说明：它带走什么上下文");
  assert.ok(lines.join("\n").includes("不进主上下文"), "说明：结论不污染主上下文");
  assert.ok(lines.join("\n").includes("enter 派发"), "键提示");
  assert.ok(lines.filter((l) => l.includes("─")).length >= 2, "内嵌编辑器自带两条线（与主输入框同款）");
  const joined = raw.join("\n");
  assert.ok(joined.includes("48;5;45m"), "光标已换成平台蓝方块");
  assert.ok(!joined.includes("\x1b[7m"), "不得残留反色软件光标（会长成粉/白高亮）");
  for (const l of raw) assert.ok(vw(l) <= W, `弹窗行超宽：${JSON.stringify(plain([l])[0])}`);

  prompt.handleInput("调");
  prompt.handleInput("查");
  assert.equal(prompt.getTask(), "调查", "输入进入内嵌编辑器");
  prompt.handleInput("\x1b");
  assert.equal(cancelled, 1, "esc → 取消（不派发）");
  assert.equal(submitted, "", "esc 不得触发派发");

  // 空任务不得派发（另开一个，避开上面已经输入的内容）
  let emptySubmit = "";
  const empty = createDivertPrompt(stub as never, {
    theme: EDITOR_THEME,
    onSubmit: (t) => (emptySubmit = t),
    onCancel: () => {},
  });
  empty.handleInput("\r");
  assert.equal(emptySubmit, "", "空任务不派发");
  empty.handleInput("X");
  empty.handleInput("\r");
  assert.equal(emptySubmit, "X", "enter → 派发该任务");

  prompt.handleInput("X");
  prompt.handleInput("\r");
  assert.equal(submitted, "调查X", "原有内容 + 新输入可正常派发");
  console.log("5) 弹窗渲染（标题/说明/两条线/蓝方块光标/宽度/键语义）✓");
}

// ── ⑥ 状态语义
{
  const stale = D.createDivert({ parent: MAIN, task: "被杀的旁路", model: "m-test", afterSeq });
  const settled = D.settleStaleDiverts(MAIN).map((x) => x.id);
  assert.ok(settled.includes(stale.id), "遗留 running（进程被杀）→ 判为中断");
  assert.equal(D.loadDivert(MAIN, stale.id)!.status, "aborted", "状态已落盘");
  assert.equal(D.settleStaleDiverts(MAIN).length, 0, "幂等：已判定过的不再重复处理");
  assert.ok(D.listDiverts(MAIN).every((x) => x.status !== "running"), "整理后不得再有 running 残留");

  const b = new SubsessionBlock({ id: stale.id, task: "被杀的旁路" });
  b.setStatus("aborted");
  assert.ok(plain(b.render(80)).join("\n").includes("中断"), "中断态在块上可见（不骗人）");
  console.log("6) 状态语义（遗留 running → 中断 · 幂等 · 可见）✓");
}

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nKrystal Bot 旁路回归：全部通过 · 6 组");