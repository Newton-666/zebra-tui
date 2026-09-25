// Krystal Bot — 旁路会话（divert）：一次性派发的存储与语义
//
// 定位（owner 定）：`/divert` = 人按的一次**派发**，跑完即止。输入框永远属于主会话；
// 主会话的 prompt / 工具清单 / events **完全不知道它存在**（连 append 都不做）—— 这是缓存与注意力的双保险。
//
// 上下文（关键设计）：旁路**不复制**主会话的 events，而是按引用切片：
//   旁路的输入 = 主会话 events[0 .. afterSeq) ⊕ 自己的 delta 事件
//   → 前缀与派发那一刻主会话发出去的逐字节相同 → provider 前缀缓存命中（~0.1x）
//   → 原文只有一份（红线①：压缩=搬迁，绝不复制成第二份真相）
//   → afterSeq 一个数字同时承担两件事：重播时的插入位置 + 上下文前缀长度（不加概念）
import fs from "node:fs";
import path from "node:path";
import { appendEvent, loadEvents, type SessionEvent } from "./session.ts";
import type { BotEvent } from "./bot.ts";
import { SESSIONS_DIR } from "./team.ts";

export interface DivertMeta {
  id: string;
  kind: "divert";
  /** 主会话 id（父）：上下文前缀与重播位置都从这里来 */
  parent: string;
  /** 派发时的任务（弹窗里那一句） */
  task: string;
  /** 与主会话同一个模型（换模型 → 装配形状变 → 缓存不命中） */
  model: string;
  /** 派发时主会话的事件数：重播插入位置 + 上下文前缀长度 */
  afterSeq: number;
  createdAt: string;
  updatedAt: string;
  status: "running" | "done" | "aborted" | "failed";
}

export const newDivertId = (d = new Date()): string =>
  `d-${d.toISOString().replace(/[:.]/g, "-").slice(0, 19)}-${Math.random().toString(36).slice(2, 6)}`;

/** 旁路落盘在**主会话目录内部**：sessions/<parent>/diverts/<id>/
 *  这样 `/resume` 零改动就看不到它（listBotSessions 只扫 SESSIONS_DIR 的直接子项且要求 bot.json） */
export const divertsRoot = (parent: string): string => path.join(SESSIONS_DIR, parent, "diverts");
/** 复用 session.ts 的 appendEvent/loadEvents：它们按 id 拼路径，嵌套 id 天然可用 */
export const divertStoreId = (parent: string, id: string): string => `${parent}/diverts/${id}`;
const dirOf = (parent: string, id: string): string => path.join(divertsRoot(parent), id);
const metaFile = (parent: string, id: string): string => path.join(dirOf(parent, id), "divert.json");

export function loadDivert(parent: string, id: string): DivertMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaFile(parent, id), "utf8")) as DivertMeta;
  } catch {
    return undefined;
  }
}

/** 主会话的全部旁路，按派发位置升序（重播时按此顺序插回原位） */
export function listDiverts(parent: string): DivertMeta[] {
  let names: string[] = [];
  try {
    names = fs.readdirSync(divertsRoot(parent));
  } catch {
    return [];
  }
  const out: DivertMeta[] = [];
  for (const n of names) {
    const m = loadDivert(parent, n);
    if (m) out.push(m);
  }
  out.sort((a, b) => (a.afterSeq - b.afterSeq) || (a.createdAt < b.createdAt ? -1 : 1));
  return out;
}

export function createDivert(opts: {
  parent: string;
  task: string;
  model: string;
  afterSeq: number;
  id?: string;
  at?: string;
}): DivertMeta {
  const id = opts.id ?? newDivertId();
  const at = opts.at ?? new Date().toISOString();
  const meta: DivertMeta = {
    id,
    kind: "divert",
    parent: opts.parent,
    task: opts.task,
    model: opts.model,
    afterSeq: opts.afterSeq,
    createdAt: at,
    updatedAt: at,
    status: "running",
  };
  fs.mkdirSync(dirOf(opts.parent, id), { recursive: true });
  fs.writeFileSync(metaFile(opts.parent, id), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

export function updateDivert(parent: string, id: string, patch: Partial<DivertMeta>): DivertMeta | undefined {
  const m = loadDivert(parent, id);
  if (!m) return undefined;
  const next = { ...m, ...patch, updatedAt: new Date().toISOString() };
  try {
    fs.writeFileSync(metaFile(parent, id), `${JSON.stringify(next, null, 2)}\n`);
  } catch {
    return undefined;
  }
  return next;
}

/** 旁路自己的事件流（只有 delta：task 消息 + 它自己的思考/工具/回答） */
export const divertEvents = (parent: string, id: string): SessionEvent[] =>
  loadEvents(divertStoreId(parent, id));

export const appendDivertEvent = (parent: string, id: string, ev: SessionEvent): void =>
  appendEvent(divertStoreId(parent, id), ev);

/**
 * 旁路本次运行要喂给模型的完整事件序列 = 主会话前缀 ⊕ 自己的事件。
 * 前缀是**只读切片**（主会话 events 是 append-only，[0..afterSeq) 永不变化）→ 与派发时主会话发出的前缀逐字节相同。
 */
export function divertContext(parent: string, id: string): SessionEvent[] {
  const m = loadDivert(parent, id);
  if (!m) return divertEvents(parent, id);
  const prefix = loadEvents(m.parent).slice(0, m.afterSeq);
  return [...prefix, ...divertEvents(parent, id)];
}

/** 进程被杀时来不及写 status → 启动/重播时把遗留的 running 判为「中断/未完成」（推断，不猜内容） */
export function settleStaleDiverts(parent: string): DivertMeta[] {
  const stale = listDiverts(parent).filter((d) => d.status === "running");
  return stale.map((d) => updateDivert(parent, d.id, { status: "aborted" }) ?? d);
}

/**
 * BotEvent → 落盘事件（旁路只持久化「成了历史」的那些；思考增量不单独存，随 assistant/final 一起存）。
 * 抽出来是为了让「直播 → 落盘 → 重播」的往返能被离线测试真实驱动（不重写一份映射）。
 */
export function toDivertEvent(
  e: BotEvent,
  opts: { model: string; thinking?: string; at?: string },
): SessionEvent | undefined {
  const at = opts.at ?? new Date().toISOString();
  switch (e.type) {
    case "assistant":
      return { t: "msg", at, role: "assistant", content: e.content, thinking: opts.thinking || undefined, toolCalls: e.toolCalls };
    case "final":
      return { t: "msg", at, role: "assistant", content: e.text, thinking: opts.thinking || undefined };
    case "tool_result":
      return { t: "msg", at, role: "tool", content: (e.denied ? "[策略闸门拒绝] " : "") + e.output, toolCallId: e.id };
    case "usage":
      return { t: "usage", at, prompt: e.prompt, cached: e.cached, completion: e.completion, model: opts.model };
    default:
      return undefined; // thinking 增量 / tool_args / retry / context：不落盘
  }
}