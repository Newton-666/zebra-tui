// Krystal — 一句话建队：用平台搭建模型（builder，OpenAI 兼容）把一句描述整理成团队规格
// 无静默回退：未配置平台模型时抛 BuilderNotConfigured，由向导引导去首页配置
import { BuilderNotConfigured, chat, loadBuilder } from "./builder.ts";
import type { MemberType } from "./types.ts";

export interface TeamSpec {
  teamName: string;
  goal: string;
  protocol: string[];
  members: { name: string; type: MemberType; role: string }[];
}

const VALID_TYPES: MemberType[] = ["pi", "hermes", "codex", "kimi"];

const PROMPT_HEAD = `你是团队编排器。根据用户描述，输出下面 4 类行（纯文本，每行一条，不要解释、不要 markdown 围栏、不要在行内换行）：

TEAM: <英文小写连字符团队名，<=20 字符>
GOAL: <一句话目标>
PROTOCOL: <纪律1> | <纪律2> | <纪律3>（3-5 条，用 | 分隔，每条一句话：谁起草 / 谁验收 / 产出格式 / 禁止事项）
MEMBER: <英文小写短名，<=10 字符> | <pi|hermes|codex|kimi> | <该成员职责与产出要求，1-2 句，单行，直接写给成员本人看>
MEMBER: ...（共 2-4 条）

type 选择建议：实现/编码 → pi 或 codex；验证/审查 → hermes；研究/长文 → kimi。

用户描述：`;

export function extractJson(text: string): unknown {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("生成结果里找不到 JSON");
  return JSON.parse(text.slice(start, end + 1));
}

/** 归一化：补齐缺省、去重、限幅 */
export function normalizeSpec(raw: unknown): TeamSpec {
  const o = (raw ?? {}) as Record<string, unknown>;
  const name = (s: unknown, fallback: string) => String(s ?? fallback).trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").slice(0, 12) || fallback;
  const rawMembers = Array.isArray(o.members) ? (o.members as Record<string, unknown>[]) : [];
  const used = new Set<string>();
  const members = rawMembers.slice(0, 6).map((m, i) => {
    let n = name(m.name, `m${i + 1}`);
    while (used.has(n)) n = `${n}${i}`;
    used.add(n);
    const t = String(m.type ?? "pi").toLowerCase() as MemberType;
    return {
      name: n,
      type: VALID_TYPES.includes(t) ? t : "pi",
      role: String(m.role ?? "").trim().slice(0, 400),
    };
  });
  if (members.length < 1) throw new Error("生成结果没有成员");
  const protocol = (Array.isArray(o.protocol) ? o.protocol : []).map((p) => String(p).trim()).filter(Boolean).slice(0, 6);
  return {
    teamName: String(o.teamName ?? "krystal-team").trim().slice(0, 30) || "krystal-team",
    goal: String(o.goal ?? "").trim().slice(0, 200),
    protocol,
    members,
  };
}

const clean = (s: string) => s.replace(/[`*_>#]/g, "").replace(/^[-•\s]+/, "").trim();

/** 解析行式输出：TEAM / GOAL / PROTOCOL / MEMBER */
export function parseLines(text: string): TeamSpec | undefined {
  const members: TeamSpec["members"] = [];
  let teamName = "";
  let goal = "";
  const protocol: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.replace(/\r/g, "").trim();
    // 容忍缩进、项目符号、粗体标记（各模型输出风格不一）
    const m = /^[\s>*\-•`]*?(TEAM|GOAL|PROTOCOL|MEMBER)[*\s]*[:：]\s*(.*)$/i.exec(line);
    if (!m) continue;
    const [, keyRaw, rest] = m;
    const key = keyRaw!.toUpperCase();
    if (key === "TEAM") teamName = clean(rest!);
    else if (key === "GOAL") goal = clean(rest!);
    else if (key === "PROTOCOL") {
      for (const part of rest!.split("|")) if (clean(part)) protocol.push(clean(part));
    } else {
      const cols = rest!.split("|").map((c) => clean(c));
      if (cols.length >= 2) members.push({ name: cols[0]!, type: (cols[1] as MemberType) ?? "pi", role: cols.slice(2).join(" ") });
    }
  }
  if (!members.length) return undefined;
  return normalizeSpec({ teamName: teamName || "krystal-team", goal, protocol, members });
}

/** 生成团队规格（异步，TUI 不阻塞）；未配置平台模型 → BuilderNotConfigured（向导引导配置） */
export async function generateTeamSpec(description: string): Promise<TeamSpec> {
  const cfg = loadBuilder();
  if (!cfg) throw new BuilderNotConfigured();
  const out = await chat(cfg, PROMPT_HEAD + description);
  const cleaned = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "").replace(/\r/g, "");
  return parseLines(cleaned) ?? normalizeSpec(extractJson(cleaned));
}
