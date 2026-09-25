// Krystal — 模型上下文窗口（动态获取，不硬编码）
// 决策：spec §12.4 #18（2026-09-24 owner：删掉内置模型表，窗口一律动态得到）
// 来源优先级：① provider /models 上报（OpenRouter/vLLM/LM Studio 等会带）
//            ② 上下文超限报错学习（各家云端不回报时的兜底——免费、事件驱动）
//            ③ 人手改 ~/.krystal/windows.json（与 MEMORY.md 同哲学：数据在人手里）
// 未知模型的窗口 → undefined，调用方用 assumedWindow（128k）保守假设，UI 标注「估」
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const FILE = path.join(os.homedir(), ".krystal", "windows.json");
const MIN = 4_000;
const MAX = 4_000_000;

export const assumedWindow = 128_000;

let cache: Record<string, number> | undefined;

const load = (): Record<string, number> => {
  if (cache) return cache;
  try {
    cache = JSON.parse(fs.readFileSync(FILE, "utf8")) as Record<string, number>;
  } catch {
    cache = {};
  }
  if (!cache || typeof cache !== "object") cache = {};
  return cache;
};

const persist = (): void => {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, `${JSON.stringify(cache, null, 2)}\n`);
  } catch {
    /* 降级：学习失败不影响对话 */
  }
};

/** 已知窗口；未知返回 undefined（不要在这里塞兜底值——兜底是调用方的显式决策） */
export function getWindow(model: string): number | undefined {
  const w = load()[model];
  return typeof w === "number" && w >= MIN && w <= MAX ? w : undefined;
}

/** 学习/上报：后写覆盖（自纠错——报错学的输入上限会被后来的 /models 全窗口值修正） */
export function learnWindow(model: string, tokens: number): void {
  if (!model || !Number.isFinite(tokens) || tokens < MIN || tokens > MAX) return;
  load()[model] = Math.round(tokens);
  persist();
}

// 限定词紧跟数字才算数：「maximum context length is 1048576」「limit 262144」「最大支持 1024000」。
// 不能取报错里所有数字的最大值 —— 「requested 1100000」比上限大，学进去就永远压不到底。
const LIMIT_NUM =
  /(?:maximum context length(?:\s+is)?|context length(?:\s+is)?|(?:input\s+)?limit(?:\s+is)?|上限[为是]?|最大支持|最大[长输]*度?[为是]?|max\s+input\s+tokens[^\d]{0,16})[^\d]{0,12}(\d{4,8})/gi;

/** 从报错文本提取上下文上限。只在像「超限」的报错里学（避免把错误码/请求号学成窗口）；
 *  多个候选数字取最大（报错常同时出现「当前 N / 上限 M」）；范围钳制在 [4k, 4M]。 */
export function learnFromErrorMessage(model: string, msg: string): void {
  if (!model || !msg) return;
  if (!/context|长度|输入|input|上限|超长|too long|exceed|maximum/i.test(msg)) return;
  const nums = [...msg.matchAll(LIMIT_NUM)].map((m) => Number(m[1])).filter((n) => n >= MIN && n <= MAX);
  if (nums.length) learnWindow(model, Math.max(...nums));
}
