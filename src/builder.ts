// Krystal — 搭建模型（平台底层模型）
// 职责：搭建期智能（一句话 → 团队/成员规格、装备分配）。与成员模型互不干预：
//      成员模型是每个成员自己的脑子（team.json 的 members[].model）；
//      本文件只管「平台配置里的 builder」这一份。
// 协议：OpenAI 兼容 chat completions —— 一个适配器覆盖绝大多数云端与本地服务。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface BuilderConfig {
  baseUrl: string; // OpenAI 兼容根地址（含 /v1），例：https://api.example.com/v1
  apiKey: string;
  model: string;
}

export class BuilderNotConfigured extends Error {
  constructor() {
    super("未配置平台模型——请在首页选择 Platform model 配置（Base URL / API Key / 模型名）");
    this.name = "BuilderNotConfigured";
  }
}

const CONFIG_DIR = path.join(os.homedir(), ".krystal");
const CONFIG_FILE = path.join(CONFIG_DIR, "config.json");

export const builderConfigPath = (): string => CONFIG_FILE;

const trimSlash = (s: string) => s.trim().replace(/\/+$/, "");

/** 读取：显式保存的配置文件优先；否则环境变量兜底（三项齐全才算已配置） */
export function loadBuilder(): BuilderConfig | undefined {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as { builder?: Partial<BuilderConfig> };
    const b = raw.builder;
    if (b?.baseUrl && b?.apiKey && b?.model) {
      return { baseUrl: trimSlash(b.baseUrl), apiKey: b.apiKey, model: b.model };
    }
  } catch {
    /* 无文件 / 坏 JSON → 走环境变量 */
  }
  const baseUrl = process.env.KRYSTAL_BUILDER_BASE_URL ?? process.env.OPENAI_BASE_URL;
  const apiKey = process.env.KRYSTAL_BUILDER_API_KEY ?? process.env.OPENAI_API_KEY;
  const model = process.env.KRYSTAL_BUILDER_MODEL;
  if (baseUrl && apiKey && model) return { baseUrl: trimSlash(baseUrl), apiKey, model };
  return undefined;
}

/** 显式保存（UI 测试通过后调用）：合并进已有 JSON，保留无关字段 */
export function saveBuilder(cfg: BuilderConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
  } catch {
    /* 首次保存 */
  }
  raw.builder = { baseUrl: trimSlash(cfg.baseUrl), apiKey: cfg.apiKey, model: cfg.model };
  fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
}

export function clearBuilder(): void {
  try {
    const raw = JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) as Record<string, unknown>;
    if ("builder" in raw) {
      delete raw.builder;
      fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
    }
  } catch {
    /* 无文件 → 无需清除 */
  }
}

/** 打码显示：sk-abcd…ef12 */
export function maskKey(k: string): string {
  return k.length > 10 ? `${k.slice(0, 7)}…${k.slice(-4)}` : "•".repeat(k.length);
}

/** 预设 provider（baseUrl 是数据；模型列表动态拉取，provider 上新无需改 Krystal） */
export interface ProviderPreset {
  id: string;
  label: string;
  baseUrl: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  { id: "deepseek", label: "DeepSeek", baseUrl: "https://api.deepseek.com/v1" },
  { id: "openai", label: "OpenAI", baseUrl: "https://api.openai.com/v1" },
  { id: "moonshot", label: "Moonshot（Kimi）", baseUrl: "https://api.moonshot.cn/v1" },
  { id: "qwen", label: "通义千问（DashScope 兼容）", baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1" },
  { id: "zhipu", label: "智谱 GLM", baseUrl: "https://open.bigmodel.cn/api/paas/v4" },
  { id: "openrouter", label: "OpenRouter", baseUrl: "https://openrouter.ai/api/v1" },
  { id: "ollama", label: "Ollama（本机）", baseUrl: "http://localhost:11434/v1" },
  { id: "lmstudio", label: "LM Studio（本机）", baseUrl: "http://localhost:1234/v1" },
];

/** 动态拉取模型列表（GET /models）——provider 侧上新模型自动可见 */
export async function fetchModels(
  cfg: { baseUrl: string; apiKey: string },
  signal?: AbortSignal,
): Promise<string[]> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: signal ?? AbortSignal.timeout(15_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/timeout|abort|TimeoutError/i.test(msg) ? "拉取超时——检查网络" : `连接失败：${msg}`);
  }
  if (!res.ok) throw friendlyHttp(res.status, await res.text().catch(() => ""));
  const data = (await res.json().catch(() => undefined)) as { data?: { id?: unknown }[] } | undefined;
  const ids = (data?.data ?? []).map((m) => String(m?.id ?? "")).filter(Boolean).sort();
  if (!ids.length) throw new Error("端点返回了空模型列表——确认 baseUrl 正确，或改用手动输入模型 id");
  return ids;
}

export interface ChatOptions {
  timeoutMs?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  /** 连接测试用：HTTP 200 且无 error 字段即算通过（思考型模型可能把 token 全花在推理上，content 为空是正常的） */
  lenient?: boolean;
}

/** OpenAI 兼容 chat completions（非流式——搭建期一次性调用足够） */
export async function chat(cfg: BuilderConfig, prompt: string, opts: ChatOptions = {}): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${cfg.apiKey}` },
      body: JSON.stringify({
        model: cfg.model,
        messages: [{ role: "user", content: prompt }],
        temperature: 0.4,
        max_tokens: opts.maxTokens ?? 4096,
      }),
      signal: opts.signal ?? AbortSignal.timeout(opts.timeoutMs ?? 180_000),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(/timeout|abort|TimeoutError/i.test(msg) ? "连接超时——检查网络或 Base URL 是否可达" : `连接失败：${msg}`);
  }
  if (!res.ok) throw friendlyHttp(res.status, await res.text().catch(() => ""));
  const data = (await res.json().catch(() => undefined)) as
    | { error?: unknown; choices?: { message?: { content?: unknown; reasoning_content?: unknown } }[] }
    | undefined;
  // 有些代理 HTTP 200 也把错误放进 body
  const errField = data?.error;
  if (errField) {
    const m = (errField as { message?: unknown })?.message;
    throw new Error(`端点返回错误：${String(m ?? JSON.stringify(errField)).slice(0, 160)}`);
  }
  const msg0 = data?.choices?.[0]?.message;
  // 思考型模型（如 GLM-4.5/4.6/4.7 默认开思考）：content 可能空，推理文本在 reasoning_content
  const text =
    typeof msg0?.content === "string" && msg0.content.trim()
      ? msg0.content
      : typeof msg0?.reasoning_content === "string"
        ? msg0.reasoning_content
        : "";
  if (!opts.lenient && !text.trim()) {
    throw new Error("平台模型返回为空——若选的是思考型模型，请增大 max_tokens 或换非思考模型");
  }
  return text;
}

function friendlyHttp(status: number, body: string): Error {
  const hint = body.slice(0, 160).replace(/\s+/g, " ");
  if (status === 401 || status === 403) return new Error(`密钥无效或无权限（HTTP ${status}）`);
  if (status === 404) return new Error("地址或模型名不对（HTTP 404）——确认 baseUrl 含 /v1、模型 id 正确");
  if (status === 429) return new Error(`限流或额度不足（HTTP 429）${hint ? `：${hint}` : ""}`);
  return new Error(`平台模型 HTTP ${status}${hint ? `：${hint}` : ""}`);
}

/** 连接测试：几十 token 的最小请求；HTTP 200 且无 error 字段即通过（不要求 content 非空——思考型模型会把 token 花在推理上） */
export async function testBuilder(cfg: BuilderConfig, signal?: AbortSignal): Promise<void> {
  await chat(cfg, "连接测试，请只回复两个字母：ok", { timeoutMs: 30_000, maxTokens: 64, signal, lenient: true });
}
