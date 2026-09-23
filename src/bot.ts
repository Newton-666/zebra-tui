// Krystal Bot — 原生 agent 核心（与 pi 同构）：SSE 流式 + 工具调用 + 档位闸门
// 设计：docs/agent-spec.md §9。渲染由 bot-view 负责（cell 即它的 TUI）。
// 档位：原型阶段实现「阅读者」（只读）——三层强制之第一层（命令白名单，未列入 = 拒绝）。
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BuilderConfig } from "./builder.ts";
import { assembleContext, summarize, withSystem } from "./context.ts";
import { contextWindow, latestNote, type SessionEvent } from "./session.ts";
import { about, addFact, conflicts, connect, markUsed, memoryBlock, recall, related, renderFacts } from "./memory.ts";

const execAsync = promisify(exec);

// ---------- 工具（JSON schema 声明） ----------

export interface BotTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export const READER_TOOLS: BotTool[] = [
  {
    name: "list_dir",
    description: "列出目录内容（相对当前工作目录）",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "目录路径，默认 ." } },
      required: [],
    },
  },
  {
    name: "read_file",
    description: "读文件前 32KB（相对当前工作目录，禁止越出工作目录）",
    parameters: {
      type: "object",
      properties: { path: { type: "string", description: "文件路径" } },
      required: ["path"],
    },
  },
  {
    name: "memory",
    description:
      "长期记忆（跨会话）。op=remember 写入一句话事实｜recall 关键词检索｜about 某实体｜related 相关事实｜connect 两实体交集｜conflicts 矛盾",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["remember", "recall", "about", "related", "connect", "conflicts"] },
        text: { type: "string", description: "op=remember：一句话事实（一主题一条）" },
        entities: { type: "array", items: { type: "string" }, description: "op=remember：实体（文件/命令/成员/概念）" },
        query: { type: "string", description: "op=recall" },
        entity: { type: "string", description: "op=about/related" },
        a: { type: "string", description: "op=connect 的第一个实体" },
        b: { type: "string", description: "op=connect 的第二个实体" },
        evidence: { type: "string", description: "op=remember：证据（文件:行号 / 命令输出片段）" },
      },
      required: ["op"],
    },
  },
  {
    name: "run_command",
    description: "跑一条只读命令（白名单：pwd/ls/cat/head/tail/grep/rg/find/wc/which/git status/log/diff/show/branch）",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "命令行" } },
      required: ["command"],
    },
  },
];

// ---------- 档位闸门（§2.1 第一层：白名单，未列入 = 拒绝） ----------

const READONLY_FIRST = new Set(["pwd", "ls", "cat", "head", "tail", "grep", "rg", "find", "wc", "which"]);
const GIT_READONLY_SUB = new Set(["status", "log", "diff", "show", "branch"]);

export function commandAllowed(cmd: string): boolean {
  const c = cmd.trim();
  if (!c) return false;
  if (/[;&|`$><]/.test(c)) return false; // 白名单不允许组合/重定向（第二层沙箱前的第一道闸）
  const parts = c.split(/\s+/);
  if (parts[0] === "git") return GIT_READONLY_SUB.has(parts[1] ?? "");
  return READONLY_FIRST.has(parts[0]!);
}

const OUT_LIMIT = 4000;

// ── 失败重试（网络抖动是常态：自然化处理，不是复杂化）
// 总尝试 3 次（首发 + 2 次重试），每次间隔 10 秒；三次都拉不起来就停下来报错。
// 只有「可重试」错误才重试：网络/超时/5xx/429；鉴权与参数类（400/401/403/404/422）立即停。
const RETRY_MAX = 3;
const RETRY_WAIT_MS = Number(process.env.KRYSTAL_RETRY_WAIT_MS ?? 10_000);
export const isRetryable = (msg: string): boolean => {
  if (/已中断|abort/i.test(msg)) return false;
  if (/HTTP (400|401|403|404|422)\b/.test(msg)) return false;
  return /fetch failed|连接失败|超时|timeout|timed out|terminated|ECONNRESET|ECONNREFUSED|socket|network|HTTP (5\d\d|429)/i.test(msg);
};

/** 可中断的等待（esc 能立刻打断重试等待） */
const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(t); resolve(); }, { once: true });
  });

export interface ToolResult {
  ok: boolean;
  denied?: boolean;
  output: string;
}

export async function executeTool(name: string, rawArgs: string, cwd: string): Promise<ToolResult> {
  let args: Record<string, unknown> = {};
  try {
    args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
  } catch {
    return { ok: false, output: "参数不是合法 JSON" };
  }
  const rel = (v: unknown, d: string) => path.resolve(cwd, String(v ?? d));
  const inside = (p: string) => p === cwd || p.startsWith(cwd + path.sep);
  try {
    if (name === "list_dir") {
      const dir = rel(args.path, ".");
      if (!inside(dir)) return { ok: false, denied: true, output: "越出工作目录（档位：阅读者）" };
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const lines = entries.slice(0, 200).map((e) => (e.isDirectory() ? "d " : "- ") + e.name);
      return { ok: true, output: lines.join("\n") || "（空目录）" };
    }
    if (name === "read_file") {
      const file = rel(args.path, "");
      if (!inside(file)) return { ok: false, denied: true, output: "越出工作目录（档位：阅读者）" };
      const fh = await fs.promises.open(file, "r");
      try {
        const buf = Buffer.alloc(32 * 1024);
        const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
        return { ok: true, output: buf.toString("utf8", 0, bytesRead) + (bytesRead === buf.length ? "\n…（截断，前 32KB）" : "") };
      } finally {
        await fh.close();
      }
    }
    if (name === "memory") {
      // 记忆是平台原语（不是文件系统操作）→ 不受只读档位限制；写入的是记忆库，不是仓库
      const op = String(args.op ?? "");
      const str = (v: unknown) => String(v ?? "").trim();
      const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
      if (op === "remember") {
        const text = str(args.text);
        if (!text) return { ok: false, output: "op=remember 需要 text" };
        const f = addFact({ text, entities: arr(args.entities), evidence: str(args.evidence) || undefined, by: "bot" });
        return { ok: true, output: `${f.existed ? "已有此条（已加强信任）" : "已记住"} [${f.id}] ${f.text}${f.entities.length ? `  [${f.entities.join(", ")}]` : ""}` };
      }
      if (op === "recall") {
        const r = recall(str(args.query));
        markUsed(r.map((f) => f.id));
        return { ok: true, output: renderFacts(r) };
      }
      if (op === "about" || op === "related") {
        const f = (op === "about" ? about : related)(str(args.entity));
        markUsed(f.map((x) => x.id));
        return { ok: true, output: renderFacts(f) };
      }
      if (op === "connect") return { ok: true, output: renderFacts(connect(str(args.a), str(args.b))) };
      if (op === "conflicts") {
        const cs = conflicts();
        return {
          ok: true,
          output: cs.length
            ? cs
                .map((c) => `冲突（${c.reason}）：\n  A [${c.a.id}] ${c.a.text} (by ${c.a.by})\n  B [${c.b.id}] ${c.b.text} (by ${c.b.by})`)
                .join("\n")
            : "（未发现矛盾）",
        };
      }
      return { ok: false, output: `未知 op：${op}` };
    }
    if (name === "run_command") {
      const cmd = String(args.command ?? "");
      if (!commandAllowed(cmd)) return { ok: false, denied: true, output: `策略闸门拒绝（档位：阅读者，白名单外）：${cmd.slice(0, 80)}` };
      const r = await execAsync(cmd, { cwd, timeout: 15_000, maxBuffer: 1024 * 1024 });
      const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
      return { ok: true, output: out.slice(0, OUT_LIMIT) + (out.length > OUT_LIMIT ? "…（截断）" : "") || "（无输出）" };
    }
    return { ok: false, output: `未知工具：${name}` };
  } catch (e) {
    return { ok: false, output: `执行失败：${e instanceof Error ? e.message.split("\n")[0] : String(e)}` };
  }
}

// ---------- OpenAI 兼容 SSE 流式（三类 delta：content / reasoning_content / tool_calls） ----------

export interface ToolCall {
  id: string;
  name: string;
  args: string;
}

export interface StreamHandlers {
  signal?: AbortSignal;
  onThinking?: (delta: string) => void;
  onText?: (delta: string) => void;
  onToolArgs?: (name: string, argsSoFar: string) => void;
  /** 真实用量（含缓存命中）：stream_options.include_usage 时由流末尾分片带回 */
  onUsage?: (u: { prompt: number; cached: number; completion: number }) => void;
}

export async function streamChat(
  cfg: BuilderConfig,
  messages: unknown[],
  tools: BotTool[],
  h: StreamHandlers = {},
): Promise<{ content: string; toolCalls: ToolCall[] }> {
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify({
      model: cfg.model,
      messages,
      tools: tools.map((t) => ({ type: "function", function: { name: t.name, description: t.description, parameters: t.parameters } })),
      stream: true,
      stream_options: { include_usage: true }, // 真实 usage + cached_tokens（§13.5 度量）
    }),
    signal: h.signal ?? AbortSignal.timeout(180_000),
  });
  if (!res.ok) throw new Error(`平台模型 HTTP ${res.status}：${(await res.text().catch(() => "")).slice(0, 160)}`);
  if (!res.body) throw new Error("平台模型无响应体");

  let content = "";
  const acc = new Map<number, ToolCall>();
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of res.body) {
    buf += decoder.decode(chunk as Uint8Array, { stream: true });
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const payload = t.slice(5).trim();
      if (payload === "[DONE]") continue;
      let delta: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] };
      try {
        const json = JSON.parse(payload) as {
          choices?: { delta?: typeof delta }[];
          usage?: {
            prompt_tokens?: number;
            completion_tokens?: number;
            prompt_tokens_details?: { cached_tokens?: number };
            prompt_cache_hit_tokens?: number; // DeepSeek
            cached_tokens?: number; // 部分兼容端点
            cache_read_input_tokens?: number; // Anthropic 风格
          };
        };
        if (json.usage) {
          h.onUsage?.({
            prompt: json.usage.prompt_tokens ?? 0,
            // 跨厂商兼容：取第一个存在的缓存命中字段（都不报 → 0，界面显示「—」，靠本地前缀稳定性判据）
            cached:
              json.usage.prompt_tokens_details?.cached_tokens ??
              json.usage.prompt_cache_hit_tokens ??
              json.usage.cached_tokens ??
              json.usage.cache_read_input_tokens ??
              0,
            completion: json.usage.completion_tokens ?? 0,
          });
        }
        delta = json.choices?.[0]?.delta ?? {};
      } catch {
        continue;
      }
      if (delta.reasoning_content) h.onThinking?.(delta.reasoning_content);
      if (delta.content) {
        content += delta.content;
        h.onText?.(delta.content);
      }
      for (const tc of delta.tool_calls ?? []) {
        const cur = acc.get(tc.index) ?? { id: "", name: "", args: "" };
        if (tc.id) cur.id = tc.id;
        if (tc.function?.name) cur.name += tc.function.name;
        if (tc.function?.arguments) cur.args += tc.function.arguments;
        acc.set(tc.index, cur);
        if (cur.name) h.onToolArgs?.(cur.name, cur.args);
      }
    }
  }
  // 工具调用顺序 = Map 插入序（流里的 index 顺序）；此前按 Number(id) 排序是错的（id 非数字 → NaN）
  return { content, toolCalls: [...acc.values()] };
}

// ---------- Bot 循环（等输入 → 模型 → 工具 → 回填 → 直到 final） ----------

export type BotEvent =
  | { type: "thinking"; delta: string }
  | { type: "usage"; prompt: number; cached: number; completion: number }
  | { type: "retry"; attempt: number; max: number; waitMs: number; reason: string }
  | { type: "context"; stage: "folding" | "summarizing" | "summarize_failed"; folded?: number }
  | { type: "summary"; text: string }
  | { type: "assistant"; content: string; toolCalls: { id: string; name: string; args: string }[] }
  | { type: "tool_args"; name: string; argsSoFar: string }
  | { type: "text"; delta: string }
  | { type: "tool_start"; id: string; name: string; args: string }
  | { type: "tool_result"; id: string; name: string; ok: boolean; denied: boolean; output: string }
  | { type: "final"; text: string }
  | { type: "error"; message: string };

const SYSTEM = (cwd: string, tier: string) => `你是 Krystal Bot——Krystal 平台的原生成员。
工作目录：${cwd}
当前档位：${tier}
规则：
- 调工具前先用一句话说明意图；工具输出会由系统回填给你
- ${tier === "阅读者" ? "你是只读档位：只能查看，任何写操作都会被策略闸门拒绝——不要尝试" : "按档位白名单行事"}
- 回答精炼，用中文；先给结论，再给依据（文件:行号）
- 不使用 emoji（平台审美：纯文字/几何符号）`;

export async function runBotTask(opts: {
  cfg: BuilderConfig;
  cwd: string;
  events: SessionEvent[];
  signal?: AbortSignal;
  onEvent: (e: BotEvent) => void;
  maxTurns?: number;
}): Promise<void> {
  const { cfg, cwd, events, signal, onEvent, maxTurns = 8 } = opts;
  // ── 上下文装配（M1）：折叠 →（必要时）摘要 → 稳定前缀 + 尾巴
  const mem = memoryBlock();
  const system = SYSTEM(cwd, "阅读者") + (mem ? `\n\n${mem}` : "");
  const win = contextWindow(cfg.model);
  const foldAt = Number(process.env.KRYSTAL_CONTEXT_FOLD_AT ?? Math.round(win * 0.7));
  const summarizeAt = Number(process.env.KRYSTAL_CONTEXT_SUMMARIZE_AT ?? Math.round(win * 0.85));
  const keepRecent = 6;
  let summary = latestNote(events);
  let asm = assembleContext({ system, events, summary, foldAt, summarizeAt, keepRecent });
  if (asm.toSummarize?.length) {
    onEvent({ type: "context", stage: "summarizing" });
    const text = await summarize(cfg, asm.toSummarize, signal);
    if (text) {
      summary = text;
      onEvent({ type: "summary", text });
      asm = assembleContext({ system, events, summary, foldAt, summarizeAt, keepRecent });
    } else {
      // 降级也要可见（绝不静默）：本轮不摘要，但仍做折叠
      onEvent({ type: "context", stage: "summarize_failed" });
      asm = assembleContext({ system, events, foldAt, summarizeAt, keepRecent, allowSummarize: false });
    }
  }
  if (asm.folded) onEvent({ type: "context", stage: "folding", folded: asm.folded });
  const messages: unknown[] = withSystem(system, asm);
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      // ── 重试：可重试错误等 10 秒再来，最多 3 次尝试
      let content = "";
      let toolCalls: Awaited<ReturnType<typeof streamChat>>["toolCalls"] = [];
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await streamChat(cfg, messages, READER_TOOLS, {
            signal,
            onThinking: (d) => onEvent({ type: "thinking", delta: d }),
            onText: (d) => onEvent({ type: "text", delta: d }),
            onToolArgs: (name, argsSoFar) => onEvent({ type: "tool_args", name, argsSoFar }),
            onUsage: (u) => onEvent({ type: "usage", ...u }),
          });
          content = r.content;
          toolCalls = r.toolCalls;
          break;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (signal?.aborted) {
            onEvent({ type: "error", message: "已中断" });
            return;
          }
          const canRetry = attempt < RETRY_MAX && isRetryable(msg);
          if (!canRetry) {
            onEvent({ type: "error", message: attempt > 1 ? `${msg}（已重试 ${attempt - 1} 次仍失败，停下）` : msg });
            return;
          }
          onEvent({ type: "retry", attempt, max: RETRY_MAX, waitMs: RETRY_WAIT_MS, reason: msg });
          await sleep(RETRY_WAIT_MS, signal);
          if (signal?.aborted) {
            onEvent({ type: "error", message: "已中断" });
            return;
          }
        }
      }
      if (!toolCalls.length) {
        onEvent({ type: "final", text: content });
        return;
      }
      onEvent({ type: "assistant", content, toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args })) });
      messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })) });
      for (const t of toolCalls) {
        onEvent({ type: "tool_start", id: t.id, name: t.name, args: t.args });
        const r = await executeTool(t.name, t.args, cwd);
        onEvent({ type: "tool_result", id: t.id, name: t.name, ok: r.ok, denied: !!r.denied, output: r.output });
        messages.push({ role: "tool", tool_call_id: t.id, content: (r.denied ? "[策略闸门拒绝] " : "") + r.output });
      }
    }
    onEvent({ type: "error", message: `超过最大轮数（${maxTurns}）` });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    onEvent({ type: "error", message: /abort/i.test(msg) ? "已中断" : msg });
  }
}
