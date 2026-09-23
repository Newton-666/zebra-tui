// Krystal — 模型发现：从各个 agent 自己的配置/缓存里读出可用模型，按来源分组
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { MemberType } from "./types.ts";

export interface ModelChoice {
  value: string;
  label: string;
  hint?: string;
}
export interface ModelGroup {
  group: string;
  models: ModelChoice[];
  /** 附加提示（例如：该来源与 agent 当前 provider 不同，可能需先在 agent 侧配置） */
  note?: string;
}

const HOME = os.homedir();
const readJson = (p: string): unknown => {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return undefined;
  }
};

/** 一次性 CLI 的模型参数（拼命令用） */
const MODEL_FLAG: Record<MemberType, string | undefined> = {
  pi: "--model",
  hermes: "-m",
  codex: "-m",
  kimi: "-m",
  custom: undefined,
};

/** 把模型参数注入启动/恢复命令（每个 `||` 分支的指挥词之后） */
export function withModel(cmd: string, type: MemberType, model?: string): string {
  if (!cmd) return cmd;
  if (!model) return cmd;
  if (type === "custom") return cmd.includes("{}") ? cmd.split("{}").join(model) : cmd;
  const flag = MODEL_FLAG[type];
  if (!flag) return cmd;
  return cmd
    .split("||")
    .map((part) => {
      const t = part.trim();
      const sp = t.indexOf(" ");
      if (sp < 0) return `${t} ${flag} ${model}`;
      return `${t.slice(0, sp)} ${flag} ${model}${t.slice(sp)}`;
    })
    .join(" || ");
}

// ---------------- pi ----------------
function piGroups(): ModelGroup[] {
  const groups: ModelGroup[] = [];
  const push = (src: string, label: string) => {
    const d = readJson(src) as { providers?: Record<string, { models?: unknown[] }> } | undefined;
    if (!d?.providers) return;
    for (const [prov, p] of Object.entries(d.providers)) {
      const models = (p?.models ?? [])
        .map((m) => {
          if (typeof m === "string") return { value: `${prov}/${m}`, label: m };
          const o = m as { id?: string; name?: string; contextWindow?: number };
          if (!o?.id) return undefined;
          const ctx = o.contextWindow ? `${Math.round(o.contextWindow / 1000)}k ctx` : undefined;
          return { value: `${prov}/${o.id}`, label: o.name && o.name !== o.id ? `${o.id}  ${o.name}` : o.id, hint: ctx };
        })
        .filter(Boolean) as ModelChoice[];
      if (models.length) groups.push({ group: `${prov}${label}`, models });
    }
  };
  push(path.join(HOME, ".pi/agent/models.json"), "");
  push(path.join(HOME, ".pi/agent/models-store.json"), "（store）");
  return groups;
}

// ---------------- hermes ----------------
function hermesGroups(): ModelGroup[] {
  const groups: ModelGroup[] = [];
  let active = "";
  try {
    const y = fs.readFileSync(path.join(HOME, ".hermes/config.yaml"), "utf8");
    active = /^\s*provider:\s*(\S+)/m.exec(y)?.[1] ?? "";
  } catch {
    /* 没有配置就跳过 */
  }
  // 1) 当前默认（从 config.yaml 读）
  try {
    const y = fs.readFileSync(path.join(HOME, ".hermes/config.yaml"), "utf8");
    const def = /^\s*default:\s*(\S+)/m.exec(y)?.[1];
    const prov = /^\s*provider:\s*(\S+)/m.exec(y)?.[1];
    if (def) groups.push({ group: `当前默认（${prov ?? "?"}）`, models: [{ value: def, label: def, hint: "config.yaml default" }] });
  } catch {
    /* 没有配置文件就跳过 */
  }
  // 2) provider 模型缓存
  const d = readJson(path.join(HOME, ".hermes/provider_models_cache.json")) as
    | Record<string, { models?: unknown[] }>
    | undefined;
  if (d) {
    for (const [prov, v] of Object.entries(d)) {
      const models = (v?.models ?? [])
        .map((m) => (typeof m === "string" ? { value: m, label: m } : undefined))
        .filter(Boolean) as ModelChoice[];
      if (models.length) groups.push({ group: prov, models });
    }
  }
  // 当前 provider 排在最前；其他来源标注提示（换了来源可能需要先配置密钥/端点）
  groups.sort((a, b) => {
    const rank = (g: ModelGroup) => (/当前默认/.test(g.group) ? 0 : g.group === active ? 1 : 2);
    return rank(a) - rank(b);
  });
  for (const g of groups) {
    if (/当前默认/.test(g.group)) continue;
    if (g.group === active) g.group = `${g.group}（当前 provider）`;
    else g.note = "其他来源：需该 provider 已配置密钥/端点";
  }
  return groups;
}

// ---------------- codex ----------------
function codexGroups(): ModelGroup[] {
  const d = readJson(path.join(HOME, ".codex/models.json")) as
    | { models?: { slug?: string; display_name?: string; description?: string }[] }
    | undefined;
  const models = (d?.models ?? [])
    .map((m) =>
      m?.slug ? { value: m.slug, label: m.display_name && m.display_name !== m.slug ? `${m.slug}  ${m.display_name}` : m.slug, hint: m.description } : undefined,
    )
    .filter(Boolean) as ModelChoice[];
  return models.length ? [{ group: "codex 目录", models }] : [];
}

// ---------------- kimi ----------------
function kimiGroups(): ModelGroup[] {
  let y = "";
  try {
    y = fs.readFileSync(path.join(HOME, ".kimi-code/config.toml"), "utf8");
  } catch {
    return [];
  }
  const aliases = [...y.matchAll(/^\[models\."([^"]+)"\]/gm)].map((m) => m[1]!);
  const def = /^default_model\s*=\s*"([^"]+)"/m.exec(y)?.[1];
  const models: ModelChoice[] = aliases.map((a) => ({
    value: a,
    label: a,
    hint: a === def ? "默认" : undefined,
  }));
  return models.length ? [{ group: "kimi 配置", models }] : [];
}

/** 发现某类型的可用模型（按来源分组）；失败返回空数组 */
export function discoverModelGroups(type: MemberType): ModelGroup[] {
  try {
    switch (type) {
      case "pi":
        return piGroups();
      case "hermes":
        return hermesGroups();
      case "codex":
        return codexGroups();
      case "kimi":
        return kimiGroups();
      default:
        return [];
    }
  } catch {
    return [];
  }
}

/** 该类型配置里的默认模型（用于预览提示） */
export function defaultModel(type: MemberType): string | undefined {
  const g = discoverModelGroups(type);
  const hit = g.find((x) => x.group.startsWith("当前默认"))?.models[0]?.value;
  if (hit) return hit;
  return g[0]?.models[0]?.value;
}