// Krystal — 记忆/上下文回归测试（确定性，零 API）
// 用法：npm run test:memory
// 覆盖：M1 上下文装配（折叠 / 摘要 / 方案 A 位置）· M2 记忆图（写入去重 / 五查询 / 取代 / 注入块 / 镜像 / 工具层）
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔离 HOME：绝不碰真实记忆库
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krystal-memtest-"));
process.env.HOME = TMP;
process.env.KRISTAL_SESSIONS_DIR = path.join(TMP, "sessions");

const { foldToolOutputs, assembleContext, withSystem } = await import("../src/context.ts");
const M = await import("../src/memory.ts");
const { executeTool, READER_TOOLS } = await import("../src/bot.ts");

// ── M1：工具输出折叠（近端保留原文，更早的换桩）
const tool = (n: number, chars: number) => ({ role: "tool", tool_call_id: `c${n}`, content: "x".repeat(chars) });
const f = foldToolOutputs([{ role: "user", content: "1" }, tool(1, 500), { role: "user", content: "2" }, tool(2, 500), { role: "user", content: "3" }, tool(3, 500)], 2);
assert.equal(f.folded, 2, "keepRecent=2 → 更早的两条工具输出应折叠");
assert.ok(f.messages[1]!.content!.includes("已折叠") && f.messages[5]!.content!.length === 500, "老条换桩、近条保原文");
console.log("1) 工具输出折叠 ✓");

// ── M1：阈值内不动；超上限触发摘要；有摘要时 = system(含摘要) + 最近 K 条（方案 A）
const sys = "S".repeat(50);
const evs = Array.from({ length: 20 }, (_, i) => ({ t: "msg" as const, at: "", role: "user" as const, content: `第 ${i} 条 ` + "z".repeat(400) }));
assert.equal(assembleContext({ system: sys, events: [], foldAt: 10_000, summarizeAt: 20_000, keepRecent: 6 }).folded, 0);
const cs = assembleContext({ system: sys, events: evs, foldAt: 500, summarizeAt: 900, keepRecent: 6 });
assert.ok(cs.toSummarize && cs.toSummarize.length > 0, "超上限应给出待摘要内容");
const ws = assembleContext({ system: sys, events: evs, summary: "早期结论……", foldAt: 500, summarizeAt: 900, keepRecent: 6 });
assert.equal(ws.messages.length, 6, "有摘要时尾巴 = 最近 6 条");
const fin = withSystem(sys, ws) as { role: string; content: string }[];
assert.ok(fin[0]!.role === "system" && fin[0]!.content.includes("早期对话摘要"), "摘要紧跟 system（方案 A）");
console.log("2) 装配/折叠/摘要（方案 A 位置）✓");

// ── M2：写入 + 实体兜底 + 去重（一主题一条）
const f1 = M.addFact({ text: "闸门在 src/bot.ts 用白名单实现", by: "bot" });
assert.ok(f1.entities.some((e) => e.includes("bot.ts")), "应兜底抽出 bot.ts");
const again = M.addFact({ text: "闸门在 src/bot.ts 用白名单实现", by: "bot" });
assert.equal(again.id, f1.id, "同文本 → 同一条（不新增）");
assert.ok(again.existed && again.trust > f1.trust, "已存在 → 加强信任");
console.log("3) 写入/实体兜底/去重 ✓");

// ── M2：五查询 + 取代语义
const f2 = M.addFact({ text: "npm test 当前失败", entities: ["npm test"], by: "beta" });
const f3 = M.addFact({ text: "npm test 覆盖 gate 白名单", entities: ["npm test", "gate"], by: "alpha" });
assert.ok(M.recall("闸门白名单").some((x) => x.id === f1.id), "recall（含中文 2-gram）");
assert.ok(M.about("bot.ts").some((x) => x.id === f1.id), "about");
assert.ok(M.connect("npm test", "gate").some((x) => x.id === f3.id), "connect（实体交集）");
assert.ok(M.conflicts().some((c) => c.a.id === f2.id || c.b.id === f2.id) === false, "单条状态不构成矛盾（需相反断言）");
const sup = M.supersedeFact(f2.id, { text: "npm test 现已通过" });
assert.equal(M.loadFacts().find((x) => x.id === f2.id)?.supersededBy, sup!.id, "旧条保留并标记被取代");
assert.ok(!M.activeFacts(M.loadFacts()).some((x) => x.id === f2.id), "被取代的不参与注入");
console.log("4) 五查询 + 取代（旧条不删）✓");

// ── M2：注入块稳定序 + 不含易变值
const block = M.memoryBlock();
assert.ok(block.includes("长期记忆"), "有注入块");
assert.ok(!/used \d|天前|\d{4}-\d{2}-\d{2}/.test(block), "注入块不含年龄/次数等易变值（缓存友好）");
assert.equal(block, M.memoryBlock(), "同集合 → 字节相同");
console.log("5) 注入块稳定且无易变值 ✓");

// ── M2：镜像（分节 + 双向导入 + 幂等 + 备份）
assert.ok(fs.readFileSync(M.mirrorPath(), "utf8").includes(f1.id), "镜像含事实 id");
let md = fs.readFileSync(M.mirrorPath(), "utf8").replace("闸门在 src/bot.ts 用白名单实现", "人手改过的事实 A");
md = `${md.trimEnd()}\n- 人手新增的事实 C\n`;
fs.writeFileSync(M.mirrorPath(), md);
const later = new Date(Date.now() + 5000);
fs.utimesSync(M.mirrorPath(), later, later);
const imp = M.importMirror();
assert.equal(imp.imported, 1, "应更新 1 条");
assert.equal(imp.added, 1, "应新增 1 条（人手写的行）");
assert.ok(M.activeFacts(M.loadFacts()).some((x) => x.text === "人手新增的事实 C" && x.by === "human"), "人手条目来源 human");
assert.ok(fs.existsSync(`${M.factsPath()}.bak`), "写前备份");
assert.deepEqual(M.importMirror(), { imported: 0, added: 0 }, "再次导入幂等");
console.log("6) MEMORY.md 双向导入（更新/新增/备份/幂等）✓");

// ── 工具层：一个 memory 工具 + 九个 op
const t = READER_TOOLS.find((x) => x.name === "memory")!;
assert.ok(t, "应有 memory 工具");
const props = t.parameters as { properties: { op: { enum: string[] } } };
assert.equal(props.properties.op.enum.length, 9, "九个 op");
assert.ok((await executeTool("memory", JSON.stringify({ op: "remember", text: "回归测试写入的一条", entities: ["回归"] }), TMP)).output.includes("已记住"));
assert.ok((await executeTool("memory", JSON.stringify({ op: "wrong", id: f1.id }), TMP)).output.includes("已降权"), "wrong 反馈降权");
assert.ok(!(await executeTool("memory", JSON.stringify({ op: "nope" }), TMP)).ok, "未知 op 应拒绝");
console.log("7) 工具层（九 op + 反馈）✓");

// ── /memory 图
const g = M.renderGraph();
assert.ok(g.lines[0]!.includes("记忆图") && g.lines.some((l) => l.includes("实体关联")), "图含统计与关联边");
console.log(`8) /memory 图 ✓ ${g.facts} 事实 / ${g.entities} 实体 / ${g.edges} 关联`);

fs.rmSync(TMP, { recursive: true, force: true });
console.log("\nALL MEMORY TESTS PASS");