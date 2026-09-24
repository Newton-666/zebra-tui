// Krystal Bot — 原生 agent 核心（与 pi 同构）：SSE 流式 + 工具调用 + 终端闸门
// 设计：docs/agent-spec.md §9。渲染由 bot-view 负责（cell 即它的 TUI）。
// 终端恒定完全访问（spec §12.4 #19）：约束 = 黑名单 + 路径围栏 + 防误删（gate.ts），没有档位。
import { exec } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { BuilderConfig } from "./builder.ts";
import { assembleContext, estimateTokens, summarize, withSystem } from "./context.ts";
import { decide } from "./gate.ts";
import { contextWindow, latestNote, type SessionEvent } from "./session.ts";
import { about, addFact, adjustTrust, conflicts, connect, markUsed, memoryBlock, recall, related, renderFacts, supersedeFact } from "./memory.ts";
import { assumedWindow, learnFromErrorMessage } from "./windows.ts";

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
    description: "读文件（相对当前工作目录，禁止越出工作目录）。默认前 2000 行；大文件用 offset/limit 分段读",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径" },
        offset: { type: "number", description: "起始行（从 1 起，默认 1）" },
        limit: { type: "number", description: "本次读的行数（默认 2000）" },
      },
      required: ["path"],
    },
  },
  {
    name: "memory",
    description:
      "长期记忆（跨会话）。op=remember 写入｜recall 检索｜about 实体｜related 相关｜connect 交集｜conflicts 矛盾｜helpful/wrong 反馈某条（调信任）｜supersede 用新事实取代旧条",
    parameters: {
      type: "object",
      properties: {
        op: { type: "string", enum: ["remember", "recall", "about", "related", "connect", "conflicts", "helpful", "wrong", "supersede"] },
        id: { type: "string", description: "op=helpful/wrong/supersede：目标事实 id（supersede 时是要被取代的旧条）" },
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
    description:
      "跑一条终端命令（管道/重定向可用）。构建、测试、git add·commit、名单外的非破坏命令都放行；仅删除类（rm）、提权（sudo）、git push、磁盘/系统级命令被安全网拦截",
    parameters: {
      type: "object",
      properties: { command: { type: "string", description: "命令行" } },
      required: ["command"],
    },
  },
];

/** 写装备：与读装备一起常驻（终端恒定完全访问） */
const WRITER_TOOLS: BotTool[] = [
  {
    name: "write_file",
    description: "整文件写入（覆盖；自动建父目录），限工作目录内",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对当前工作目录）" },
        content: { type: "string", description: "完整文件内容" },
      },
      required: ["path", "content"],
    },
  },
  {
    name: "edit_file",
    description: "精确替换文件片段（oldText 须与文件内容逐字节一致且唯一；多处命中时补上下文，或 replace_all=true）",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "文件路径（相对当前工作目录）" },
        oldText: { type: "string", description: "要被替换的原文（精确匹配）" },
        newText: { type: "string", description: "替换后的文本（删除则传空串）" },
        replace_all: { type: "boolean", description: "替换全部匹配（默认要求唯一匹配）" },
      },
      required: ["path", "oldText", "newText"],
    },
  },
];

/** 全量装备：终端恒定完全访问，读写工具常驻（§12.4 #19） */
const TOOLS: BotTool[] = [...READER_TOOLS, ...WRITER_TOOLS];

// ---------- 终端闸门（黑名单 + 围栏 + 防误删，见 gate.ts） ----------

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

const OUT_LIMIT = Number(process.env.KRYSTAL_TOOL_OUT_MAX ?? 16_000);
const CMD_TIMEOUT_MS = Number(process.env.KRYSTAL_CMD_TIMEOUT_MS ?? 120_000);

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
      if (!inside(dir)) return { ok: false, denied: true, output: "越出工作目录" };
      const entries = await fs.promises.readdir(dir, { withFileTypes: true });
      const lines = entries.slice(0, 200).map((e) => (e.isDirectory() ? "d " : "- ") + e.name);
      return { ok: true, output: lines.join("\n") || "（空目录）" };
    }
    if (name === "read_file") {
      const file = rel(args.path, "");
      if (!inside(file)) return { ok: false, denied: true, output: "越出工作目录" };
      const fh = await fs.promises.open(file, "r");
      try {
        const CAP = 256 * 1024;
        const buf = Buffer.alloc(CAP);
        const { bytesRead } = await fh.read(buf, 0, CAP, 0);
        if (bytesRead === 0) return { ok: true, output: "（空文件）" };
        const allLines = buf.toString("utf8", 0, bytesRead).split("\n");
        const offset = Math.max(1, Math.floor(Number(args.offset ?? 1) || 1));
        const limit = Math.max(1, Math.floor(Number(args.limit ?? 2000) || 2000));
        const slice = allLines.slice(offset - 1, offset - 1 + limit);
        const notes: string[] = [];
        if (bytesRead === CAP) notes.push("…（截断，只显示前 256KB）");
        else if (offset - 1 + slice.length < allLines.length)
          notes.push(`…（第 ${offset + slice.length - 1} 行之后未显示，可用 offset=${offset + slice.length} 续读）`);
        return { ok: true, output: slice.join("\n") + (notes.length ? "\n" + notes.join(" ") : "") };
      } finally {
        await fh.close();
      }
    }
    if (name === "write_file") {
      const file = rel(args.path, "");
      if (!inside(file)) return { ok: false, denied: true, output: "越出工作目录" };
      const content = String(args.content ?? "");
      await fs.promises.mkdir(path.dirname(file), { recursive: true });
      await fs.promises.writeFile(file, content, "utf8");
      return { ok: true, output: `已写入 ${path.relative(cwd, file) || "."}（${content.split("\n").length} 行 / ${Buffer.byteLength(content)} 字节）` };
    }
    if (name === "edit_file") {
      const file = rel(args.path, "");
      if (!inside(file)) return { ok: false, denied: true, output: "越出工作目录" };
      const oldText = String(args.oldText ?? "");
      const newText = String(args.newText ?? "");
      if (!oldText) return { ok: false, output: "oldText 不能为空" };
      let src: string;
      try {
        src = await fs.promises.readFile(file, "utf8");
      } catch {
        return { ok: false, output: `读不到文件：${path.relative(cwd, file) || file}` };
      }
      const count = src.split(oldText).length - 1;
      if (count === 0) return { ok: false, output: "oldText 未找到（须与文件内容逐字节一致——先 read_file 核对）" };
      if (count > 1 && !args.replace_all)
        return { ok: false, output: `oldText 匹配 ${count} 处——补充上下文使其唯一，或设 replace_all=true` };
      const next = args.replace_all ? src.split(oldText).join(newText) : src.replace(oldText, newText);
      await fs.promises.writeFile(file, next, "utf8");
      return { ok: true, output: `已编辑 ${path.relative(cwd, file) || "."}（替换 ${args.replace_all ? count : 1} 处）` };
    }
    if (name === "memory") {
      // 记忆是平台原语（写入的是记忆库，不是仓库）
      const op = String(args.op ?? "");
      const str = (v: unknown) => String(v ?? "").trim();
      const arr = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x)).filter(Boolean) : []);
      if (op === "remember") {
        const text = str(args.text);
        if (!text) return { ok: false, output: "op=remember 需要 text" };
        const f = addFact({ text, entities: arr(args.entities), evidence: str(args.evidence) || undefined, by: "bot" });
        // 认知刷新提示：写入后回看同主实体的旧知（确定性检索）——若本条是更新/纠正，引导模型接着 supersede
        let hint = "";
        if (!f.existed && f.entities.length) {
          const kin = about(f.entities[0]!).filter((x) => x.id !== f.id).slice(0, 3);
          if (kin.length)
            hint = `\n相关旧知：\n${renderFacts(kin)}\n若本条是对旧知的更新/纠正，请接着 supersede(id, 本条)，不要两并存`;
        }
        return { ok: true, output: `${f.existed ? "已有此条（已加强信任）" : "已记住"} [${f.id}] ${f.text}${f.entities.length ? `  [${f.entities.join(", ")}]` : ""}${hint}` };
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
      if (op === "helpful" || op === "wrong") {
        const f = adjustTrust(str(args.id), op === "helpful" ? 0.2 : -0.3);
        return f ? { ok: true, output: `${op === "helpful" ? "已加强" : "已降权"} [${f.id}] ${f.text} → trust ${f.trust.toFixed(2)}` } : { ok: false, output: `找不到事实 ${str(args.id)}` };
      }
      if (op === "supersede") {
        const text = str(args.text);
        if (!text) return { ok: false, output: "op=supersede 需要 text（新事实）" };
        const f = supersedeFact(str(args.id), { text, entities: arr(args.entities), by: "bot" });
        return f ? { ok: true, output: `已取代：新 [${f.id}] ${f.text}（旧条保留但不注入）` } : { ok: false, output: `找不到事实 ${str(args.id)}` };
      }
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
      const d = decide(cmd, cwd);
      if (!d.allow) return { ok: false, denied: true, output: `策略闸门拒绝［${d.list}］${d.reason ?? ""}：${cmd.slice(0, 80)}` };
      const r = await execAsync(cmd, { cwd, timeout: CMD_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 });
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
  // 空闲看门狗：流上超过 idleMs 没有任何数据 → abort（转成可重试错误）；用户 esc 信号原样穿透。
  // 旧写法 `h.signal ?? timeout(180s)` —— 传了 signal 超时就永远不生效，流一旦挂起整个任务冻住（2026-09-23 教训）。
  const idleMs = Number(process.env.KRYSTAL_STREAM_IDLE_MS ?? 120_000);
  const ctrl = new AbortController();
  let idleFired = false;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const kick = () => {
    clearTimeout(idle);
    idle = setTimeout(() => {
      idleFired = true;
      ctrl.abort();
    }, idleMs);
  };
  const onUserAbort = () => ctrl.abort();
  h.signal?.addEventListener("abort", onUserAbort, { once: true });
  kick();
  try {
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
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`平台模型 HTTP ${res.status}：${(await res.text().catch(() => "")).slice(0, 160)}`);
    if (!res.body) throw new Error("平台模型无响应体");

    let content = "";
    const acc = new Map<number, ToolCall>();
    const decoder = new TextDecoder();
    let buf = "";
    for await (const chunk of res.body) {
      kick(); // 收到数据 → 重置空闲看门狗
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
  } catch (e) {
    if (h.signal?.aborted) throw e; // 用户中断：上层判「已中断」（不重试）
    if (idleFired) throw new Error(`流式空闲超时（${Math.round(idleMs / 1000)}s 无数据）`); // 可重试（isRetryable 命中「超时」）
    throw e;
  } finally {
    clearTimeout(idle);
    h.signal?.removeEventListener("abort", onUserAbort);
  }
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

const SYSTEM = (cwd: string) => `你是 Krystal Bot——Krystal 平台的原生成员（写作者）。
工作目录：${cwd}
规则：
- 调工具前先用一句话说明意图；工具输出会由系统回填给你
- 终端在围栏内完全可用：write_file/edit_file 改文件；run_command 跑构建/测试/git 等；仅删除类（rm）、提权（sudo）、git push、磁盘/系统级命令被安全网拦截——不要尝试
- 记忆是活的认知：新信息与已有记忆矛盾或使其过时 → 用 memory 的 supersede 刷新旧条（旧条保留可检索），不要无脑堆新条；remember 结果里回显的「相关旧知」正是在告诉你该刷新谁
- 主动沉淀（事件驱动，不等人吩咐）：工作中学到值得跨会话保留的东西——用户偏好、项目事实、踩过的坑、关键决定 → 当场 memory remember（带 entities 和 evidence）；回合收尾前若有未沉淀的重要发现，先记住再交最终回答
- 像真正的工程师一样干活：多步查证（read_file 可 offset/limit 分段），动手前先看清现状
- 回答精炼，用中文；先给结论，再给依据（文件:行号）
- 不使用 emoji（平台审美：纯文字/几何符号）`;

export async function runBotTask(opts: {
  cfg: BuilderConfig;
  cwd: string;
  events: SessionEvent[];
  signal?: AbortSignal;
  onEvent: (e: BotEvent) => void;
}): Promise<void> {
  const { cfg, cwd, events, signal, onEvent } = opts;
  // ── 上下文装配（M1）：折叠 →（必要时）摘要 → 稳定前缀 + 尾巴
  const mem = memoryBlock();
  const system = SYSTEM(cwd) + (mem ? `\n\n${mem}` : "");
  const tools = TOOLS;
  const win = contextWindow(cfg.model) ?? assumedWindow; // 窗口未知 → 128k 保守假设（报错学习会自动纠准）
  const foldAt = Number(process.env.KRYSTAL_CONTEXT_FOLD_AT ?? Math.round(win * 0.7));
  const summarizeAt = Number(process.env.KRYSTAL_CONTEXT_SUMMARIZE_AT ?? Math.round(win * 0.85));
  const keepRecent = 6;
  let summary = latestNote(events);
  let summarizeFailed = false;
  // 本任务运行期间新产生的事件（与视图落盘的形状一致）→ 回合中回收时与开场快照合并重装配
  const fresh: SessionEvent[] = [];
  // 回收装配：预装配与回合中共用同一套（折叠 → 摘要 → 稳定前缀 + 尾巴）
  const compact = async (all: SessionEvent[]): Promise<unknown[]> => {
    let asm = assembleContext({ system, events: all, summary, foldAt, summarizeAt, keepRecent, allowSummarize: !summarizeFailed });
    if (asm.toSummarize?.length) {
      onEvent({ type: "context", stage: "summarizing" });
      const text = await summarize(cfg, asm.toSummarize, signal);
      if (text) {
        summary = text;
        onEvent({ type: "summary", text });
      } else {
        // 降级也要可见（绝不静默）：不摘要，但仍做折叠
        summarizeFailed = true;
        onEvent({ type: "context", stage: "summarize_failed" });
      }
      asm = assembleContext({ system, events: all, summary, foldAt, summarizeAt, keepRecent, allowSummarize: false });
    }
    if (asm.folded) onEvent({ type: "context", stage: "folding", folded: asm.folded });
    return withSystem(system, asm);
  };
  let messages = await compact(events);
  try {
    // 循环无轮数上限（与 pi 同构：靠 final/esc/错误退出）；长任务靠回合中回收续航，不靠计数器截停
    while (true) {
      // ── 回合中回收（M1 同款）：逼近窗口 → 折叠/摘要后重装配
      if (estimateTokens(messages) > foldAt) {
        messages = await compact([...events, ...fresh]);
      }
      // ── 重试：可重试错误等 10 秒再来，最多 3 次尝试
      let content = "";
      let toolCalls: Awaited<ReturnType<typeof streamChat>>["toolCalls"] = [];
      for (let attempt = 1; ; attempt++) {
        try {
          const r = await streamChat(cfg, messages, tools, {
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
          learnFromErrorMessage(cfg.model, msg); // 上下文超限报错 → 学习真实窗口（下次阈值即准）
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
      fresh.push({ t: "msg", at: new Date().toISOString(), role: "assistant", content, toolCalls: toolCalls.map((t) => ({ id: t.id, name: t.name, args: t.args })) });
      messages.push({ role: "assistant", content: content || null, tool_calls: toolCalls.map((t) => ({ id: t.id, type: "function", function: { name: t.name, arguments: t.args } })) });
      for (const t of toolCalls) {
        onEvent({ type: "tool_start", id: t.id, name: t.name, args: t.args });
        const r = await executeTool(t.name, t.args, cwd);
        onEvent({ type: "tool_result", id: t.id, name: t.name, ok: r.ok, denied: !!r.denied, output: r.output });
        const toolContent = (r.denied ? "[策略闸门拒绝] " : "") + r.output;
        fresh.push({ t: "msg", at: new Date().toISOString(), role: "tool", content: toolContent, toolCallId: t.id });
        messages.push({ role: "tool", tool_call_id: t.id, content: toolContent });
      }
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    learnFromErrorMessage(cfg.model, msg);
    onEvent({ type: "error", message: /abort/i.test(msg) ? "已中断" : msg });
  }
}
