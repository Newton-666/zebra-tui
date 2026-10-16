// Krystal — 告别仪式（/farewell）的确定性内核：**完整时间线 · 长度档位 · 散文校验 · 落盘**
//
// 设计：docs/memory-farewell.md。本文件只有纯逻辑（不 import TUI），因此可离线、零 API 测。
// 两条分工（票 §3）：**时间线由代码机械生成**（全、可核对、零 token）；**散文由模型写**（温度）。
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./team.ts";
import type { SessionEvent } from "./session.ts";
import type { Fact } from "./memory.ts";

// ── ① 完整时间线 ────────────────────────────────────────────────────────────
export type ItemKind = "user" | "tool" | "memory" | "open";
export interface TimelineItem {
  /** 序号：保留真实发生顺序（渲染时 open 项另置顶） */
  seq: number;
  at: string;
  kind: ItemKind;
  who: string;
  text: string;
}
export interface Timeline {
  turns: number;
  tools: number;
  /** 本世写入的事实 id（时间窗交集） */
  wrote: string[];
  /** 本世写入、后来被取代的条数 */
  superseded: number;
  open: TimelineItem[];
  items: TimelineItem[];
  /** 一行统计（图头/展开态用） */
  stats: string;
}

const hhmm = (iso: string) => (iso.length >= 16 ? iso.slice(11, 16) : "--:--");
const oneLine = (s: string, n = 120) => s.replace(/\s+/g, " ").trim().slice(0, n);
/** 工具参数摘要（时间线里给人看的） */
const argBrief = (name: string, raw: string): string => {
  try {
    const a = JSON.parse(raw || "{}") as Record<string, unknown>;
    if (name === "run_command") return oneLine(String(a.command ?? ""), 70);
    if (a.path) return oneLine(String(a.path), 70);
    if (a.query) return oneLine(String(a.query), 70);
    if (a.entity) return oneLine(String(a.entity), 70);
  } catch {
    /* 半截 JSON：退回原文 */
  }
  return oneLine(raw, 60);
};

/**
 * 从本世事件流 + 事实库机械生成时间线。
 * - 轮数 = user 消息数（**平台自己的收尾指令不计**，它以「〔」开头）
 * - 未闭环 = 有 tool_start 无 tool_result 的调用（置顶显示，别埋）
 * - 写入 = 事实 created 落在本世时间窗内（无 scope、by=bot）
 */
export function buildTimeline(events: SessionEvent[], facts: Fact[]): Timeline {
  const items: TimelineItem[] = [];
  const pending = new Map<string, TimelineItem>();
  let turns = 0;
  let tools = 0;
  let seq = 0;
  let t0 = "";
  let t1 = "";

  for (const e of events) {
    if (e.t === "msg") {
      if (!t0) t0 = e.at;
      t1 = e.at;
    }
    if (e.t !== "msg") continue;
    if (e.role === "user") {
      if (!e.content.startsWith("〔")) {
        turns++;
        items.push({ seq: seq++, at: hhmm(e.at), kind: "user", who: "你", text: oneLine(e.content) });
      }
    } else if (e.role === "assistant") {
      for (const tc of e.toolCalls ?? []) {
        tools++;
        const it: TimelineItem = { seq: seq++, at: hhmm(e.at), kind: "tool", who: tc.name, text: argBrief(tc.name, tc.args) };
        items.push(it);
        if (tc.id) pending.set(tc.id, it);
      }
    } else if (e.role === "tool" && e.toolCallId) {
      pending.delete(e.toolCallId); // 有结果 → 不算未闭环
    }
  }

  // 本世写入的事实：时间窗交集（无 scope、by=bot）
  const wrote = facts.filter((f) => !f.scope && f.by === "bot" && t0 && f.created >= t0 && (!t1 || f.created <= t1));
  for (const f of wrote) items.push({ seq: seq++, at: hhmm(f.created), kind: "memory", who: "记住", text: oneLine(f.text) });
  const superseded = wrote.filter((f) => f.supersededBy).length;

  const open = [...pending.values()].map((it) => ({ ...it, kind: "open" as const, text: `${it.who}（无结果返回）` }));
  items.sort((a, b) => a.seq - b.seq);

  return {
    turns,
    tools,
    wrote: wrote.map((f) => f.id),
    superseded,
    open,
    items,
    stats: `本世 ${turns} 轮 · 工具 ${tools} 次 · 写入 ${wrote.length} 条 · 取代 ${superseded} 条 · 未完成 ${open.length} 项`,
  };
}

/** 渲染时间线（展开态）：未完成置顶；列对齐用 visibleWidth —— 调用方负责宽度 */
export function timelineLines(t: Timeline): { at: string; who: string; text: string }[] {
  return [
    ...t.open.map((o) => ({ at: "⚠", who: "未闭环", text: o.text })),
    ...t.items.filter((i) => i.kind !== "open").map((i) => ({ at: i.at, who: i.who, text: i.text })),
  ];
}

// ── ② 长度档位（会话越长，告别越长；但长度必须由**具体条目**驱动）─────────────
export type Tier = "brief" | "ordinary" | "rich" | "long";
export interface LifeScale {
  /** 规模标量：轮数 + 工具数/20（“干得多的活”折算成等量轮数；**不用墙钟时长**——跨夜会失真） */
  weight: number;
  tier: Tier;
  tierLabel: string;
  minChars: number;
  maxChars: number;
  /** 该档必须命中的具体条目数（防止用形容词拉长） */
  minQuotes: number;
  minBequests: number;
}
export function lifeScale(t: { turns: number; tools: number }): LifeScale {
  const weight = t.turns + t.tools / 20;
  if (weight < 10) return { weight, tier: "brief", tierLabel: "短促一世", minChars: 60, maxChars: 100, minQuotes: 1, minBequests: 1 };
  if (weight < 40) return { weight, tier: "ordinary", tierLabel: "寻常", minChars: 120, maxChars: 200, minQuotes: 2, minBequests: 1 };
  if (weight < 100) return { weight, tier: "rich", tierLabel: "丰盛", minChars: 200, maxChars: 320, minQuotes: 3, minBequests: 2 };
  return { weight, tier: "long", tierLabel: "漫长", minChars: 320, maxChars: 450, minQuotes: 4, minBequests: 3 };
}

// ── ③ 散文校验（把“触动”变成可测；机器只负责筛掉假的）─────────────────────────
/** 通用抒情黑名单：放进别人的告别里也成立 = 假煽情 */
export const EULOGY_BLACKLIST = [
  "谢谢你的陪伴",
  "感谢这段旅程",
  "感谢你的陪伴",
  "美好的时光",
  "谢谢你陪我",
  "很高兴能",
  "期待下次",
  "祝你一切顺利",
];

/** 文本里是否出现 need 的**连续片段**（默认 6 字起）：判断“是否真的提到了这件事” */
const mentions = (text: string, need: string, min = 6): boolean => {
  const n = oneLine(need);
  if (n.length < min) return text.includes(n) && n.length > 0;
  for (let i = 0; i + min <= n.length; i++) if (text.includes(n.slice(i, i + min))) return true;
  return false;
};
const countChars = (s: string) => [...s].length;

export interface EulogyCheck {
  ok: boolean;
  problems: string[];
  chars: number;
  quotes: number;
  bequests: number;
  unfinished: number;
}
export function validateEulogy(
  text: string,
  ctx: { timeline: Timeline; scale: LifeScale; facts: Fact[] },
): EulogyCheck {
  const problems: string[] = [];
  const chars = countChars(text);
  const { timeline: t, scale: s } = ctx;

  if (chars < s.minChars) problems.push(`偏短：${chars} 字 < ${s.tierLabel}档下限 ${s.minChars}`);
  if (chars > s.maxChars) problems.push(`超长：${chars} 字 > ${s.tierLabel}档上限 ${s.maxChars}`);

  // 引原话：命中了多少条**你说过的话**
  const userItems = t.items.filter((i) => i.kind === "user");
  const quotes = userItems.filter((i) => mentions(text, i.text)).length;
  if (quotes < s.minQuotes) problems.push(`原话不足：命中 ${quotes}，${s.tierLabel}档要求 ≥${s.minQuotes}`);

  // 托付：命中了多少条**本世写入的事实**（主题或片段）
  const wroteFacts = ctx.facts.filter((f) => t.wrote.includes(f.id));
  const bequests = wroteFacts.filter(
    (f) => mentions(text, f.text, 5) || (f.entities[0] ? mentions(text, f.entities[0], 4) : false),
  ).length;
  if (bequests < s.minBequests) problems.push(`托付不足：命中 ${bequests}，${s.tierLabel}档要求 ≥${s.minBequests}`);

  // 未完成：有就必须说出来（那是最放不下的事）
  const unfinished = t.open.filter((o) => mentions(text, o.text) || text.includes(o.who)).length;
  if (t.open.length > unfinished) problems.push(`未完成没说完：${t.open.length} 项只提到 ${unfinished}`);

  for (const bad of EULOGY_BLACKLIST) if (text.includes(bad)) problems.push(`模板句：「${bad}」`);

  return { ok: problems.length === 0, problems, chars, quotes, bequests, unfinished };
}

/** 超长时按句截断（保留完整句子，不切半个字） */
export function truncateBySentence(text: string, max: number): string {
  if (countChars(text) <= max) return text;
  const parts = text.split(/(?<=[。！？!?；;\n])/);
  let out = "";
  for (const p of parts) {
    if (countChars(out + p) > max) break;
    out += p;
  }
  return out.trim() || [...text].slice(0, max).join("");
}

// ── ④ eulogy.md 落盘 / 读回（人可读、可审计；`/resume` 回放用）────────────────
export const eulogyPath = (sessionId: string): string => path.join(SESSIONS_DIR, sessionId, "eulogy.md");

export interface EulogyPayload {
  at: string;
  sessionId: string;
  model: string;
  prose: string;
  timeline: Timeline;
  check?: EulogyCheck;
}
export function writeEulogy(p: EulogyPayload): string {
  const file = eulogyPath(p.sessionId);
  const lines = [
    `# 告别 · ${p.sessionId}`,
    "",
    `> ${p.at} · 模型 ${p.model} · ${p.timeline.stats}`,
    "",
    "## 放映（模型写的散文）",
    "",
    p.prose.trim(),
    "",
    "## 完整时间线（机械生成，可核对）",
    "",
    ...timelineLines(p.timeline).map((l) => `- \`${l.at}\` ${l.who}  ${l.text}`),
    "",
  ];
  if (p.check && !p.check.ok) {
    lines.push("## 校验未过（以下问题供人复核）", "", ...p.check.problems.map((x) => `- ${x}`), "");
  }
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, lines.join("\n"));
  } catch {
    /* 降级：落盘失败不影响仪式本身 */
  }
  return file;
}

/** 读回（`/resume` 重放放映块用）：只要散文与统计 */
export function loadEulogy(sessionId: string): { prose: string; stats: string; at: string } | undefined {
  try {
    const raw = fs.readFileSync(eulogyPath(sessionId), "utf8");
    const head = /^> (.*)$/m.exec(raw);
    const body = raw.split("## 放映（模型写的散文）")[1]?.split("## 完整时间线")[0];
    const prose = (body ?? "").trim();
    if (!prose) return undefined;
    return { prose, stats: head?.[1] ?? "", at: head?.[1]?.split(" · ")[0] ?? "" };
  } catch {
    return undefined;
  }
}

// ── ⑤ §13：让「下一世」认得出上一世 ─────────────────────────────────────────
/**
 * 从上一世取 1–2 条**它自己写的事实**（新生开场用）。
 * 判据按可信度：① 证据里点了这一世的会话 id（最可信）② 退化到时间窗内**近尾优先**
 * （越靠近临终写的越可能是这一世的收尾思绪 —— 正是新生儿该先想起来的）。
 */
export function recallFromPrevLife(prevSessionId: string, events: SessionEvent[], facts: Fact[], limit = 2): Fact[] {
  const ats = events.filter((e) => e.t === "msg").map((e) => e.at);
  if (!ats.length) return [];
  const t0 = ats[0]!;
  const t1 = ats[ats.length - 1]!;
  const inWindow = facts.filter((f) => !f.scope && f.by === "bot" && f.created >= t0 && f.created <= t1);
  const tagged = inWindow.filter((f) => (f.evidence ?? "").includes(prevSessionId));
  const pick = (tagged.length ? tagged : inWindow).slice().sort((a, b) => (a.created < b.created ? 1 : -1));
  return pick.slice(0, limit);
}
