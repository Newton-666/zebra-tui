// Krystal Bot — 原生 agent 核心（与 pi 同构）：SSE 流式 + 工具调用 + 档位闸门
// 设计：docs/agent-spec.md §9。渲染由 bot-view 负责（cell 即它的 TUI）。
// 档位：原型阶段实现「阅读者」（只读）——三层强制之第一层（命令白名单，未列入 = 拒绝）。
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BuilderConfig } from "./builder.ts";

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
          usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
        };
        if (json.usage) {
          h.onUsage?.({
            prompt: json.usage.prompt_tokens ?? 0,
            cached: json.usage.prompt_tokens_details?.cached_tokens ?? 0,
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
  history: { role: string; content?: string | null; tool_calls?: unknown[]; tool_call_id?: string }[];
  signal?: AbortSignal;
  onEvent: (e: BotEvent) => void;
  maxTurns?: number;
}): Promise<void> {
  const { cfg, cwd, history, signal, onEvent, maxTurns = 8 } = opts;
  const messages: unknown[] = [{ role: "system", content: SYSTEM(cwd, "阅读者") }, ...history];
  try {
    for (let turn = 0; turn < maxTurns; turn++) {
      const { content, toolCalls } = await streamChat(cfg, messages, READER_TOOLS, {
        signal,
        onThinking: (d) => onEvent({ type: "thinking", delta: d }),
        onText: (d) => onEvent({ type: "text", delta: d }),
        onToolArgs: (name, argsSoFar) => onEvent({ type: "tool_args", name, argsSoFar }),
        onUsage: (u) => onEvent({ type: "usage", ...u }),
      });
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
