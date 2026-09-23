// Krystal — 上下文装配（M1：回收）
// 设计：docs/agent-spec.md §10（五层预算 / 回收顺序）、§13（缓存友好）、§14.1（链路图）
// 三件事，从便宜到贵：① 工具输出折叠 ② 思考折叠（我们从不把思考写入上下文 → 天然完成）③ 远期摘要（方案 A：紧跟稳定前缀）
import { chat, type BuilderConfig } from "./builder.ts";
import type { SessionEvent } from "./session.ts";

export interface Msg {
  role: string;
  content?: string | null;
  tool_calls?: unknown[];
  tool_call_id?: string;
}

/** 粗略 token 估算（决定是否回收用；真实用量以 usage 为准） */
export const estimateTokens = (messages: unknown[]): number => Math.round(JSON.stringify(messages).length / 3);

const FOLD_MIN_CHARS = 200;
const foldStub = (content: string) => {
  const lines = content.split("\n").length;
  return `…（已折叠 ${lines} 行工具输出；原文在会话事件流里，需要时可 /resume 回溯或重新执行）`;
};

/** ① 工具输出折叠：保留最近 keepRecent 条不动，更早的工具输出换成一行桩（原文不删） */
export function foldToolOutputs(messages: Msg[], keepRecent: number): { messages: Msg[]; folded: number } {
  const cut = Math.max(0, messages.length - keepRecent);
  let folded = 0;
  const out = messages.map((m, i) => {
    if (i < cut && m.role === "tool" && (m.content ?? "").length > FOLD_MIN_CHARS) {
      folded++;
      return { ...m, content: foldStub(m.content ?? "") };
    }
    return m;
  });
  return { messages: out, folded };
}

export interface AssembleOpts {
  system: string;
  events: SessionEvent[];
  summary?: string;
  foldAt: number; // 超过则开始折叠（窗口 × 0.70）
  summarizeAt: number; // 超过则触发摘要（窗口 × 0.85）
  keepRecent: number; // 保底最近消息条数
  /** 摘要失败后重算时置 false：只做折叠，不再要求摘要 */
  allowSummarize?: boolean;
}

export interface Assembled {
  messages: Msg[];
  folded: number;
  usedSummary: boolean;
  summary?: string;
  /** 需要生成摘要时，给出待摘要的旧消息（调用方生成后落盘为 note 事件） */
  toSummarize?: Msg[];
}

/** 从事件流装配模型上下文 */
export function assembleContext(o: AssembleOpts): Assembled {
  const all: Msg[] = [];
  for (const e of o.events) {
    if (e.t !== "msg") continue;
    if (e.role === "assistant") {
      all.push({
        role: "assistant",
        content: e.content || null,
        tool_calls: e.toolCalls?.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })),
      });
    } else if (e.role === "tool") {
      all.push({ role: "tool", tool_call_id: e.toolCallId, content: e.content });
    } else {
      all.push({ role: "user", content: e.content });
    }
  }

  const over = estimateTokens([{ role: "system", content: o.system }, ...all]);
  if (over <= o.foldAt) {
    return { messages: all, folded: 0, usedSummary: false };
  }

  // 需要摘要但还没有 → 交给调用方生成（摘要覆盖「最近 K 条」之前的部分）
  // 若尾巴比保底窗口还短（没有可摘要的旧内容），不要提前返回——继续走折叠路径
  if (o.allowSummarize !== false && !o.summary && over > o.summarizeAt) {
    const cut = Math.max(0, all.length - o.keepRecent);
    if (cut > 0) return { messages: all, folded: 0, usedSummary: false, toSummarize: all.slice(0, cut) };
  }

  // 有摘要：尾部只保留最近 K 条（更早的已被摘要覆盖）
  const tail = o.summary ? all.slice(Math.max(0, all.length - o.keepRecent)) : all;
  const { messages, folded } = foldToolOutputs(tail, o.keepRecent);
  return { messages, folded, usedSummary: !!o.summary, summary: o.summary };
}

/** 组装最终发给模型的 messages：system（摘要紧跟其后 = 方案 A 位置）+ 对话尾巴 */
export function withSystem(system: string, a: Assembled): unknown[] {
  const sys = a.summary ? `${system}\n\n[早期对话摘要（已压缩；原文可用 /resume 回溯）]\n${a.summary}` : system;
  return [{ role: "system", content: sys }, ...a.messages];
}


const SUMMARY_PROMPT = (dialog: string) => `把下面这段早期对话压缩成不超过 200 字的中文摘要。
只保留：结论、已做的决定、涉及的文件与命令、未完成事项。
不要复述寒暄与过程。输出纯文本，不要 markdown 标题。

对话：
${dialog}`;

/** ③ 远期摘要：一次模型调用（无工具）；失败降级（本轮不压缩，绝不删信息） */
export async function summarize(cfg: BuilderConfig, messages: Msg[], signal?: AbortSignal): Promise<string | undefined> {
  const dialog = messages
    .map((m) => `${m.role}: ${(m.content ?? "").slice(0, 1200)}`)
    .join("\n")
    .slice(0, 12_000);
  try {
    const text = await chat(cfg, SUMMARY_PROMPT(dialog), { maxTokens: 2000, timeoutMs: 90_000, signal });
    return text.trim().slice(0, 1200) || undefined;
  } catch {
    return undefined;
  }
}
