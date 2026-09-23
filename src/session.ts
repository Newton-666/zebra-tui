// Krystal — 会话事件流（append-only）
// 设计：docs/agent-spec.md §11（温层=全量只增原文）、§13（只追加 → 前缀缓存友好）、§14（全链路图）
// 团队与 Bot 共用同一形态：sessions/<id>/ 下 team.json（团队）或 bot.json（原生成员）+ events.jsonl
import fs from "node:fs";
import path from "node:path";
import { SESSIONS_DIR } from "./team.ts";

export interface BotMeta {
  id: string;
  kind: "bot";
  cwd: string;
  model: string;
  tier: string;
  createdAt: string;
  updatedAt: string;
}

export type SessionEvent =
  | { t: "meta"; at: string; cwd: string; model: string; tier: string }
  | { t: "msg"; at: string; role: "user" | "assistant" | "tool"; content: string; toolCalls?: { id: string; name: string; args: string }[]; toolCallId?: string }
  | { t: "usage"; at: string; prompt: number; cached: number; completion: number; model: string }
  | { t: "note"; at: string; text: string } // M1 摘要 / M2 记忆
  // 开场（logo + 画像 + 信息卡）也是历史的一部分：落盘 → 续聊时一并重建（与 hermes 的 intro 消息同思路）
  | { t: "intro"; at: string; cwd: string; model: string; tier: string };

const dirOf = (id: string) => path.join(SESSIONS_DIR, id);
const eventsFile = (id: string) => path.join(dirOf(id), "events.jsonl");
const metaFile = (id: string) => path.join(dirOf(id), "bot.json");

export const newBotSessionId = (d = new Date()) => `bot-${d.toISOString().replace(/[:.]/g, "-").slice(0, 19)}`;

export function createBotSession(opts: { cwd: string; model: string; tier: string; id?: string }): BotMeta {
  const id = opts.id ?? newBotSessionId();
  const at = new Date().toISOString();
  const meta: BotMeta = { id, kind: "bot", cwd: opts.cwd, model: opts.model, tier: opts.tier, createdAt: at, updatedAt: at };
  fs.mkdirSync(dirOf(id), { recursive: true });
  fs.writeFileSync(metaFile(id), `${JSON.stringify(meta, null, 2)}\n`);
  appendEvent(id, { t: "meta", at, cwd: opts.cwd, model: opts.model, tier: opts.tier });
  return meta;
}

/** 追加一个事件（落盘失败不影响对话——记忆类写入一律降级） */
export function appendEvent(id: string, ev: SessionEvent): void {
  try {
    fs.appendFileSync(eventsFile(id), `${JSON.stringify(ev)}\n`);
  } catch {
    /* 降级 */
  }
}

export function loadEvents(id: string): SessionEvent[] {
  try {
    return fs
      .readFileSync(eventsFile(id), "utf8")
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => {
        try {
          return JSON.parse(l) as SessionEvent;
        } catch {
          return undefined;
        }
      })
      .filter((e): e is SessionEvent => !!e);
  } catch {
    return [];
  }
}

export function loadBotMeta(id: string): BotMeta | undefined {
  try {
    return JSON.parse(fs.readFileSync(metaFile(id), "utf8")) as BotMeta;
  } catch {
    return undefined;
  }
}

/** 每回合结束触碰一次（不做每事件写，避免复杂化） */
export function touchSession(id: string): void {
  try {
    const m = loadBotMeta(id);
    if (!m) return;
    m.updatedAt = new Date().toISOString();
    fs.writeFileSync(metaFile(id), `${JSON.stringify(m, null, 2)}\n`);
  } catch {
    /* 降级 */
  }
}

export function listBotSessions(): BotMeta[] {
  if (!fs.existsSync(SESSIONS_DIR)) return [];
  const out: BotMeta[] = [];
  for (const dir of fs.readdirSync(SESSIONS_DIR)) {
    const m = loadBotMeta(dir);
    if (m) out.push(m);
  }
  out.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return out;
}

export const latestBotSession = (): BotMeta | undefined => listBotSessions()[0];

/** 旧的 usage 事件（状态行展示用）：取最后一条 */
export function lastUsage(events: SessionEvent[]): { prompt: number; cached: number; completion: number } | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.t === "usage") return { prompt: e.prompt, cached: e.cached, completion: e.completion };
  }
  return undefined;
}

/** 最近一条 note（M1 摘要落在这里） */
export function latestNote(events: SessionEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e && e.t === "note") return e.text;
  }
  return undefined;
}

/** 重放为模型上下文（只取 msg 事件，顺序不变 → 前缀稳定） */
export function messagesFrom(events: SessionEvent[]): { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] {
  const out: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[] = [];
  for (const e of events) {
    if (e.t !== "msg") continue;
    if (e.role === "assistant") {
      out.push({
        role: "assistant",
        content: e.content || null,
        tool_calls: e.toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })),
      });
    } else if (e.role === "tool") {
      out.push({ role: "tool", tool_call_id: e.toolCallId, content: e.content });
    } else {
      out.push({ role: "user", content: e.content });
    }
  }
  return out;
}

/** 模型上下文窗口（内置常见表；不猜不探测，未知按 128k） */
const WINDOWS: [RegExp, number][] = [
  [/^glm-4\.[567]|^glm-5/, 200_000],
  [/^glm-4(-flash|-air|-long)?$/, 128_000],
  [/deepseek/, 128_000],
  [/qwen|qwq/, 131_072],
  [/kimi|moonshot/, 128_000],
  [/gpt-4o|gpt-4-turbo|gpt-4\.1|o[134]/, 128_000],
  [/claude/, 200_000],
  [/gemini/, 1_000_000],
];
export const contextWindow = (model: string): number => WINDOWS.find(([re]) => re.test(model))?.[1] ?? 128_000;

export interface ContextStatus { pct: number; level: "ok" | "fold" | "summarize"; label: string }
/** 窗口占用与阈值级别（折叠线 70% / 摘要线 85%，与 context.ts 的触发阈值一致） */
export function contextStatus(promptTokens: number, model: string, foldRatio = 0.7, summarizeRatio = 0.85): ContextStatus {
  const pct = Math.max(0, Math.round((promptTokens / contextWindow(model)) * 100));
  const level: ContextStatus["level"] = promptTokens >= contextWindow(model) * summarizeRatio ? "summarize" : promptTokens >= contextWindow(model) * foldRatio ? "fold" : "ok";
  const label = `上下文 ${pct}%${level === "fold" ? "（折叠线）" : level === "summarize" ? "（摘要线）" : ""}`;
  return { pct, level, label };
}