#!/usr/bin/env node
// Krystal — 记忆评估（维度一：储存效果）· 留存率 / 时效正确性 / 睡眠存活率
// 设计：owner 拍板两维（2026-10-17）+ 测试与 agent 分离三合同：
//   ① 写隔离：全程临时 HOME（沿用 fffd522 机制）
//   ② 读隔离：启动时对生产库做一次只读快照，此后只碰副本（提取计数 used 属 agent 状态，读即写）
//   ③ 分离可验证：开跑前后各取生产库 (mtime,size) 签名，不一致 = 红色失败
// 计算与渲染分离：本脚本只算指标 + 产 JSON；图由 memory-eval-chart.py（matplotlib）渲染，
// 无 matplotlib 时降级为零依赖 PNG 趋势条（本文件内置 PNG 编码器）。
// 本脚本住在 scripts/，不进 src/ 主干；guard 的 harness 指纹不含 eval——eval 结构上改不坏 agent。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url)); // ESM 无 __dirname

const REAL_HOME = os.homedir();
const REAL_FACTS = path.join(REAL_HOME, ".krystal", "facts.jsonl");
const sig = (p: string) => { try { const s = fs.statSync(p); return `${s.mtimeMs}:${s.size}`; } catch { return "absent"; } };
const BEFORE = sig(REAL_FACTS);

// ── ② 读隔离：快照生产库 → 临时 HOME；此后 memory.ts 读到的全是副本
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), "krystal-memory-eval-"));
const TMP_KRYSTAL = path.join(TMP, ".krystal");
fs.mkdirSync(TMP_KRYSTAL, { recursive: true });
let snapCount = 0;
try {
  fs.copyFileSync(REAL_FACTS, path.join(TMP_KRYSTAL, "facts.jsonl"));
  snapCount = fs.readFileSync(path.join(TMP_KRYSTAL, "facts.jsonl"), "utf8").split("\n").filter((l) => l.trim()).length;
} catch { console.error("快照失败：生产库不存在？"); process.exit(1); }

process.env.HOME = TMP; // 必须在 import memory.ts 之前——DIR 在模块加载时由 homedir() 定格
const { activeFacts, loadFacts, recall, sleepMemories } = await import("../src/memory.ts");

const DAY = 86_400_000;
const now = Date.now();
const snap = activeFacts(loadFacts());

// ---------- 面板 A：留存率（created >7d 的活跃事实，实体查询能否召回） ----------
interface Miss { id: string; why: "trust沉底" | "排序挤出" | "检索未中" }
const misses: Miss[] = [];
let testedA = 0, hitA = 0;
for (const f of snap) {
  if (now - new Date(f.created).getTime() < 7 * DAY) continue;
  const q = f.entities[0];
  if (!q) continue;
  testedA++;
  const top6 = recall(q, 6);
  if (top6.some((x) => x.id === f.id)) { hitA++; continue; }
  const top50 = recall(q, 50);
  if (top50.some((x) => x.id === f.id)) misses.push({ id: f.id, why: "排序挤出" });
  else if (f.trust < 0.3) misses.push({ id: f.id, why: "trust沉底" });
  else misses.push({ id: f.id, why: "检索未中" });
}
const retention = testedA ? hitA / testedA : 0;

// ---------- 面板 B：时效正确性（版本链的链头是否排最前） ----------
const all = loadFacts();
const byId = new Map(all.map((f) => [f.id, f]));
const headOf = (id: string): string => { let c = byId.get(id); while (c?.supersededBy) c = byId.get(c.supersededBy); return c?.id ?? id; };
let chains = 0, freshHit = 0, chainsGlobal = 0, freshGlobal = 0, freshDeep = 0;
for (const f of all) {
  if (!f.supersededBy) continue;
  const q = f.entities[0];
  if (!q) continue;
  const head = byId.get(headOf(f.id));
  if (!head) continue;
  chains++;
  const hit = recall(q, 3).some((x) => x.id === head.id);
  const hitDeep = recall(q, 50).some((x) => x.id === head.id);
  if (hit) freshHit++;
  if (hitDeep) freshDeep++;
  if (!head.scope) { chainsGlobal++; if (hit) freshGlobal++; } // 团队 scope 的链头默认查询不可见=设计使然，单列不计入全局口径
}
const freshness = chains ? freshHit / chains : 0;
const freshnessGlobal = chainsGlobal ? freshGlobal / chainsGlobal : 0;
const freshnessDeep = chains ? freshDeep / chains : 0; // 深挖口径：top-50 内能找到=被挤出前排，找不到=彻底失联

// ---------- 面板 C：睡眠存活（合成事实 + 假时间戳 + 真实跑一次睡眠内核） ----------
const probe = (n: number, daysAgo: number) => ({
  t: "fact" as const,
  f: {
    id: `zzprobe${n}`, text: `zz-sleep-probe-alpha-${n} 专属探针事实`, entities: [`zz-probe-${n}`],
    by: "eval", trust: 0.6, used: 0,
    created: new Date(now - daysAgo * DAY).toISOString(), updated: new Date(now - daysAgo * DAY).toISOString(),
  },
});
const FACTS_TMP = path.join(TMP_KRYSTAL, "facts.jsonl");
const stale = [1, 2, 3, 4].map((n) => probe(n, 20)); // 20 天前 + used=0 → 必入陈旧降权区
const fresh = [5, 6].map((n) => probe(n, 1));        // 1 天前 → 对照组，不应被动
fs.appendFileSync(FACTS_TMP, [...stale, ...fresh].map((e) => JSON.stringify(e)).join("\n") + "\n");
await sleepMemories(); // 确定性内核在临时库上真实执行（规范化合并 + 陈旧降权）
const after = new Map(loadFacts().map((f) => [f.id, f]));
let survived = 0;
const decayed: number[] = [];
for (const e of stale) {
  const f = after.get(e.f.id);
  if (!f) continue;
  if (recall(f.entities[0]!, 6).some((x) => x.id === f.id)) survived++;
  decayed.push(f.trust);
}
const expected = 0.6 * Math.pow(0.5, 20 / 30); // 半衰期 30d 的理论值
const freshTrust = after.get("zzprobe5")?.trust ?? -1;
const sleepSurvival = stale.length ? survived / stale.length : 0;

// ---------- 指标 JSON → 渲染 + 历史 ----------
const OUT = path.join(HERE, "eval-out");
fs.mkdirSync(OUT, { recursive: true });
const metrics = { date: new Date().toISOString(), testedA, hitA, retention, chains, freshHit, freshness, chainsGlobal, freshGlobal, freshnessGlobal, stale: stale.length, survived, sleepSurvival, meanDecay: decayed.length ? decayed.reduce((a, b) => a + b, 0) / decayed.length : 0, expectedDecay: expected, freshTrust, misses, snapCount };
fs.writeFileSync(path.join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2) + "\n");
const HIST = path.join(HERE, ".eval-history.json");
const prev = fs.existsSync(HIST) ? JSON.parse(fs.readFileSync(HIST, "utf8")) as { date: string; retention: number; freshness: number }[] : [];
const todayKey = metrics.date.slice(0, 10);
const hist = [...prev.filter((h) => h.date.slice(0, 10) !== todayKey), { date: metrics.date, retention, freshness }]; // 同日只留最新一点
fs.writeFileSync(HIST, JSON.stringify(hist, null, 2) + "\n");

// 零依赖 PNG 趋势条（无 matplotlib 时的降级渲染：留存率曲线，白底黑线红点）
function trendPng(values: number[], w = 640, h = 160): Buffer {
  const px = Buffer.alloc(w * h * 3, 255);
  const dot = (x: number, y: number, r = 2) => { for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) { const i = ((y + dy) * w + (x + dx)) * 3; if (i >= 0 && i < px.length) px[i] = 200, px[i + 1] = 30, px[i + 2] = 30; } };
  const line = (x0: number, y0: number, x1: number, y1: number) => { const n = Math.max(Math.abs(x1 - x0), Math.abs(y1 - y0)); for (let s = 0; s <= n; s++) { const i = (Math.round(y0 + (y1 - y0) * s / n) * w + Math.round(x0 + (x1 - x0) * s / n)) * 3; px[i] = px[i + 1] = px[i + 2] = 20; } };
  if (values.length > 1) {
    const X = (i: number) => 40 + Math.round((i * (w - 80)) / (values.length - 1));
    const Y = (v: number) => h - 30 - Math.round(v * (h - 60));
    for (let i = 1; i < values.length; i++) line(X(i - 1), Y(values[i - 1]!), X(i), Y(values[i]!));
    values.forEach((v, i) => dot(X(i), Y(v)));
  } else if (values.length === 1) dot(w >> 1, h >> 1, 4);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; px.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3); }
  const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcT[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type); const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const c = Buffer.alloc(4); c.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const today = metrics.date.slice(0, 10);
let chartNote = "";
try {
  // 关键：HOME 必须还给真实用户目录（eval 进程的 HOME 是临时目录），否则 matplotlib 找不到字体缓存
  execFileSync("python3", [path.join(HERE, "memory-eval-chart.py"), path.join(OUT, "metrics.json"), HIST, OUT], { stdio: "ignore", env: { ...process.env, HOME: REAL_HOME } });
  chartNote = "matplotlib 渲染 ✓";
} catch (e) {
  fs.writeFileSync(path.join(OUT, `trend-${today}.png`), trendPng(hist.map((h) => h.retention)));
  chartNote = `无 matplotlib → 零依赖趋势条（${e instanceof Error ? e.message.split("\n")[0] : "渲染失败"}）`;
}

// ---------- ③ 分离断言 ----------
const AFTER = sig(REAL_FACTS);
const separated = BEFORE === AFTER;

// ---------- 终端仪表盘（图给 PNG，轴注释给终端） ----------
const bar = (r: number, w = 18) => "█".repeat(Math.round(r * w)) + "░".repeat(w - Math.round(r * w));
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
console.log(`记忆评估仪表盘 · ${today} · 快照 ${snapCount} 事件 / ${snap.length} 活跃事实`);
console.log("─────────────────────────────────────────────");
console.log(`留存率（>7 天活跃事实可召回）  ${bar(retention)}  ${pct(retention)}  (n=${testedA})`);
console.log(`时效正确（版本链头排前三）     ${bar(freshness)}  ${pct(freshness)}  (n=${chains}；深挖 top-50 ${pct(freshnessDeep)}；全局口径 ${pct(freshnessGlobal)})`);
console.log(`睡眠存活（20 天 used=0 探针）  ${bar(sleepSurvival)}  ${pct(sleepSurvival)}  (n=${stale.length})`);
console.log(`  理论衰减 0.6→${expected.toFixed(2)} · 实测均值 ${metrics.meanDecay.toFixed(2)} · 对照组（1 天）trust=${freshTrust.toFixed(2)} 不应衰减`);
if (misses.length) for (const m of misses) console.log(`  失忆归因 [${m.id}] ${m.why}`);
console.log(`图表：scripts/eval-out/memory-eval-${today}.png（${chartNote}）· 历史点 ${hist.length} 个`);
console.log(`分离断言：before=${BEFORE} after=${AFTER} → ${separated ? "生产库未动 ✓" : "生产库被碰！红色失败 ✗"}`);
if (!separated) process.exit(1);
const worst = Math.min(retention, freshness, sleepSurvival);
console.log(worst >= 0.8 ? "结论：三面板均健康，无需干预" : "结论：存在面板低于 80%，归因清单见上，建议人工复核");
