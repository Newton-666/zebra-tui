#!/usr/bin/env node
// Krystal — 记忆回归测试（recall-eval）
// 设计：docs/agent-spec.md §12.2 —— 记忆/检索/注入的任何改动，必须先有离线对比数据
// 因为检索是**确定性**的（grep + 实体索引，无向量库），这个评测不需要 API、不需要基建。
//
// 用法：
//   node --experimental-strip-types scripts/recall-eval.ts questions.json [--limit 6]
//
// questions.json 形如：
//   [{ "q": "闸门白名单在哪实现", "expect": ["src/bot.ts", "白名单"] }, ...]
// expect 里任一关键词命中召回结果即算命中（大小写不敏感；同时看事实文本与实体）
import fs from "node:fs";
import { activeFacts, loadFacts, memoryBlock, recall } from "../src/memory.ts";

const [file, ...rest] = process.argv.slice(2);
if (!file) {
  console.error("用法: recall-eval.ts <questions.json> [--limit N]");
  process.exit(1);
}
const limitIdx = rest.indexOf("--limit");
const limit = limitIdx >= 0 ? Number(rest[limitIdx + 1] ?? 6) : 6;

interface Case {
  q: string;
  expect: string[];
}
const cases = JSON.parse(fs.readFileSync(file, "utf8")) as Case[];

let hit = 0;
const rows: string[] = [];
for (const c of cases) {
  const got = recall(c.q, limit);
  const hay = got.map((f) => `${f.text} ${f.entities.join(" ")}`.toLowerCase()).join(" | ");
  const ok = c.expect.some((k) => hay.includes(k.toLowerCase()));
  if (ok) hit++;
  rows.push(`${ok ? "命中" : "未命中"}  ${c.q}  →  ${got.length ? got.map((f) => f.id).join(",") : "（无结果）"}`);
}

const block = memoryBlock();
const blockTokens = Math.round(block.length / 3);
const rate = cases.length ? (hit / cases.length) * 100 : 0;

console.log(`记忆回归（recall@${limit}）`);
console.log(`  用例 ${cases.length} · 命中 ${hit} · 命中率 ${rate.toFixed(1)}%`);
console.log(`  注入块：${block.length} 字符 ≈ ${blockTokens} tokens（信噪比：${(cases.length ? blockTokens / cases.length : 0).toFixed(0)} tokens/用例）`);
console.log(`  事实总数 ${activeFacts((await import("../src/memory.ts")).loadFacts()).length}`);
console.log("");
for (const r of rows) console.log(`  ${r}`);
console.log("");
console.log("说明：本脚本是「确定性回归」——改动检索/注入算法后，命中率与 token 成本不得变差。");
console.log("     「有效记忆周期（recall@N 曲线）」需要按轮次重放会话，属后续扩展（当前事实不随轮次衰减）。");
process.exit(0);