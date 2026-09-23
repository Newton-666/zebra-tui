// Krystal — 记忆图（M2）
// 设计：docs/agent-spec.md §11（事实是节点、实体是边；五查询；压缩=搬迁不删）、§13（稳定序、易变值不进前缀）
// 存储：facts.jsonl（append-only 版本流：事实版本 + 取代事件）——「一主题一条、旧条不删只标被取代」
// 镜像：MEMORY.md（人可读可改；运行时真源仍是 facts.jsonl）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface Fact {
  id: string;
  text: string;
  entities: string[];
  by: string;
  evidence?: string;
  trust: number;
  used: number;
  created: string;
  updated: string;
  supersededBy?: string;
}

type Line =
  | { t: "fact"; f: Fact }
  | { t: "fact_update"; id: string; patch: Partial<Fact> }
  | { t: "supersede"; id: string; by: string; at: string };

const DIR = path.join(os.homedir(), ".krystal");
const FACTS = path.join(DIR, "facts.jsonl");
const MIRROR = path.join(DIR, "MEMORY.md");

export const factsPath = () => FACTS;
export const mirrorPath = () => MIRROR;

const rid = () => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/** 实体兜底抽取（主路径是模型显式给）：路径 / 扩展名 / 命令 / @成员 / 反引号 */
export function guessEntities(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/`([^`]{1,40})`/g)) out.add(m[1]!.trim());
  for (const m of text.matchAll(/([\w./-]+\.(?:ts|js|py|md|json|toml|yaml|yml|sh|sql|css|html))/g)) out.add(m[1]!);
  for (const m of text.matchAll(/@([a-zA-Z][\w-]{1,20})/g)) out.add(m[1]!);
  for (const m of text.matchAll(/\b(npm|pnpm|yarn|cargo|go|pytest|make|docker|git)\s+([\w-]+)/g)) out.add(`${m[1]} ${m[2]}`);
  return [...out].slice(0, 8);
}

function append(line: Line): void {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.appendFileSync(FACTS, `${JSON.stringify(line)}\n`);
  } catch {
    /* 降级：记忆写入失败不影响对话 */
  }
}

/** 读全部事实（版本流折叠；被取代的标记保留、默认不参与注入） */
export function loadFacts(): Fact[] {
  let raw = "";
  try {
    raw = fs.readFileSync(FACTS, "utf8");
  } catch {
    return [];
  }
  const byId = new Map<string, Fact>();
  const superseded = new Set<string>();
  for (const l of raw.split("\n")) {
    if (!l.trim()) continue;
    let e: Line;
    try {
      e = JSON.parse(l) as Line;
    } catch {
      continue;
    }
    if (e.t === "fact") byId.set(e.f.id, { ...e.f });
    else if (e.t === "fact_update") {
      const f = byId.get(e.id);
      if (f) byId.set(e.id, { ...f, ...e.patch });
    } else if (e.t === "supersede") {
      const f = byId.get(e.id);
      if (f) byId.set(e.id, { ...f, supersededBy: e.by });
      superseded.add(e.id);
    }
  }
  return [...byId.values()];
}

export const activeFacts = (facts: Fact[]): Fact[] => facts.filter((f) => !f.supersededBy);

export interface AddInput { text: string; entities?: string[]; by?: string; evidence?: string; trust?: number }

export function addFact(input: AddInput): Fact & { existed?: boolean } {
  const at = new Date().toISOString();
  // 一主题一条：同文本的活跃事实 → 更新原条（加强信任），不新增（否则重复记忆会淹没注入块）
  const key = input.text.trim().toLowerCase();
  const dup = activeFacts(loadFacts()).find((f) => f.text.trim().toLowerCase() === key);
  if (dup && key) {
    const trust = Math.min(1, dup.trust + 0.05);
    append({ t: "fact_update", id: dup.id, patch: { updated: at, trust } });
    writeMirror();
    return { ...dup, trust, existed: true };
  }
  const f: Fact = {
    id: rid(),
    text: input.text.trim().slice(0, 600),
    entities: (input.entities?.length ? input.entities : guessEntities(input.text)).map((e) => String(e).trim()).filter(Boolean).slice(0, 12),
    by: input.by ?? "bot",
    evidence: input.evidence,
    trust: input.trust ?? 0.6,
    used: 0,
    created: at,
    updated: at,
  };
  append({ t: "fact", f });
  writeMirror();
  return f;
}

/** 取代：新事实入图，旧事实标 supersededBy（**不删**，符合「压缩=搬迁」红线） */
export function supersedeFact(oldId: string, input: AddInput): Fact | undefined {
  const old = loadFacts().find((f) => f.id === oldId);
  if (!old) return undefined;
  const f = addFact({ ...input, entities: input.entities ?? old.entities });
  append({ t: "supersede", id: oldId, by: f.id, at: new Date().toISOString() });
  writeMirror();
  return f;
}

export function markUsed(ids: string[]): void {
  for (const id of ids) append({ t: "fact_update", id, patch: { used: (loadFacts().find((f) => f.id === id)?.used ?? 0) + 1 } });
}

// ---------- 五个确定性查询（grep 式，无向量库） ----------

const toks = (s: string) => s.toLowerCase().split(/[^\p{L}\p{N}_./@-]+/u).filter((t) => t.length > 1);
const score = (f: Fact, ts: string[]) => {
  const hay = f.text.toLowerCase();
  const ents = f.entities.map((e) => e.toLowerCase());
  let s = 0;
  for (const t of ts) {
    if (ents.some((e) => e === t || e.includes(t))) s += 3;
    else if (hay.includes(t)) s += 1;
  }
  return s * (0.5 + f.trust);
};

export function recall(query: string, limit = 6): Fact[] {
  const ts = toks(query);
  return activeFacts(loadFacts())
    .map((f) => ({ f, s: score(f, ts) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.f.created < b.f.created ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.f);
}

export const about = (entity: string, limit = 8): Fact[] =>
  activeFacts(loadFacts()).filter((f) => f.entities.some((e) => e.toLowerCase().includes(entity.toLowerCase()))).slice(0, limit);

/** 一跳邻居：与「关于 entity 的事实」共享其他实体的事实 */
export function related(entity: string, limit = 8): Fact[] {
  const base = about(entity);
  const shared = new Set(base.flatMap((f) => f.entities.map((e) => e.toLowerCase())).filter((e) => !e.includes(entity.toLowerCase())));
  return activeFacts(loadFacts())
    .filter((f) => !base.includes(f) && f.entities.some((e) => shared.has(e.toLowerCase())))
    .slice(0, limit);
}

/** 交集：同时关联两实体的事实 */
export const connect = (a: string, b: string, limit = 8): Fact[] =>
  activeFacts(loadFacts())
    .filter((f) => {
      const es = f.entities.map((e) => e.toLowerCase());
      return es.some((e) => e.includes(a.toLowerCase())) && es.some((e) => e.includes(b.toLowerCase()));
    })
    .slice(0, limit);

/** 矛盾启发式：同一实体下，文本里出现相反词对 → 视为潜在冲突（确定性、可审计） */
// 只保留「强相反」词对（去掉 是/有 这类单字词——实测一次误报 8 处，太吵）
const OPPOSITES: [RegExp, RegExp][] = [
  [/通过|成功|已修|已完成|可用/, /失败|不通过|未修|未完成|不可用|报错/],
  [/支持/, /不支持|无法支持/],
  [/只读|不可写|禁止写/, /可写|能写入/],
];
// 同一组事实里，只保留最近 3 条参与比对（越旧越可能是历史状态）
const CONFLICT_PER_ENTITY = 3;

export function conflicts(): { a: Fact; b: Fact; reason: string }[] {
  const active = activeFacts(loadFacts());
  // 每个实体只取最近 N 条：历史状态之间的"矛盾"不是矛盾
  const recent = new Set<string>();
  const byEntity = new Map<string, Fact[]>();
  for (const f of active.slice().sort((x, y) => (x.created < y.created ? 1 : -1))) {
    for (const e of f.entities) {
      const list = byEntity.get(e.toLowerCase()) ?? [];
      if (list.length < CONFLICT_PER_ENTITY) list.push(f);
      byEntity.set(e.toLowerCase(), list);
    }
  }
  for (const list of byEntity.values()) for (const f of list) recent.add(f.id);
  const facts = active.filter((f) => recent.has(f.id));
  const out: { a: Fact; b: Fact; reason: string }[] = [];
  for (let i = 0; i < facts.length; i++) {
    for (let j = i + 1; j < facts.length; j++) {
      const a = facts[i]!;
      const b = facts[j]!;
      const shared = a.entities.filter((e) => b.entities.some((x) => x.toLowerCase() === e.toLowerCase()));
      if (!shared.length) continue;
      for (const [p, n] of OPPOSITES) {
        if ((p.test(a.text) && n.test(b.text)) || (n.test(a.text) && p.test(b.text))) {
          out.push({ a, b, reason: `同实体 ${shared[0]} 上出现相反断言` });
          break;
        }
      }
    }
  }
  return out.slice(0, 8);
}

// ---------- 注入块（稳定序 → 缓存友好；不含年龄/次数等易变值） ----------

export const PIN_LIMIT = 20;
export function memoryBlock(limit = PIN_LIMIT): string {
  const facts = activeFacts(loadFacts()).slice().sort((a, b) => (a.created < b.created ? -1 : 1)); // 稳定序：创建序
  if (!facts.length) return "";
  const lines = facts.slice(0, limit).map((f) => `- ${f.text}${f.entities.length ? `  [${f.entities.join(", ")}]` : ""}${f.evidence ? `  (${f.evidence})` : ""}`);
  return `[长期记忆（facts.jsonl 的镜像；可用 memory 工具 recall/about/connect 检索）]\n${lines.join("\n")}`;
}

// ---------- 人可读镜像（LN-1 形状：运行时真源是 jsonl，md 是人的入口） ----------

export function writeMirror(): void {
  try {
    const facts = activeFacts(loadFacts()).slice().sort((a, b) => (a.created < b.created ? -1 : 1));
    const groups = new Map<string, Fact[]>();
    for (const f of facts) {
      const key = f.entities[0] ?? "未分类";
      groups.set(key, [...(groups.get(key) ?? []), f]);
    }
    const out: string[] = [
      "# MEMORY.md — Krystal 的记忆（可手改；运行时真源是 facts.jsonl）",
      "<!-- 本文件由 writeMirror() 幂等全量重生成；一主题一条，时间只作元数据 -->",
      "",
    ];
    for (const [key, list] of groups) {
      out.push(`## ${key}`);
      for (const f of list) out.push(`- [${f.id}] ${f.text} (${f.created.slice(0, 10)} · trust ${f.trust.toFixed(2)} · used ${f.used} · by ${f.by})`);
      out.push("");
    }
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(MIRROR, `${out.join("\n")}\n`);
  } catch {
    /* 降级 */
  }
}

/** 把查询结果渲染成给模型看的一行行文本 */
export const renderFacts = (facts: Fact[], emptyHint = "（没有匹配的记忆）"): string =>
  facts.length
    ? facts.map((f) => `[${f.id}] ${f.text}${f.entities.length ? `  [${f.entities.join(", ")}]` : ""}${f.evidence ? `  (${f.evidence})` : ""} · trust ${f.trust.toFixed(2)} · by ${f.by}`).join("\n")
    : emptyHint;
// ---------- /memory：把记住的东西与图都画出来（终端友好的「树 + 边」） ----------

export interface GraphView { lines: string[]; facts: number; entities: number; superseded: number; edges: number; conflicts: number }

export function renderGraph(): GraphView {
  const all = loadFacts();
  const active = activeFacts(all);
  const superseded = all.length - active.length;

  // 实体 → 事实（稳定序：事实按创建序）
  const byEntity = new Map<string, Fact[]>();
  for (const f of active) {
    for (const e of f.entities) byEntity.set(e, [...(byEntity.get(e) ?? []), f]);
  }
  const sorted = [...byEntity.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));

  // 实体间的边：同一条事实里的实体两两相连
  const edge = new Map<string, number>();
  for (const f of active) {
    const es = [...new Set(f.entities)];
    for (let i = 0; i < es.length; i++) {
      for (let j = i + 1; j < es.length; j++) {
        const [a, b] = [es[i]!, es[j]!].sort((x, y) => x.localeCompare(y));
        edge.set(`${a} ↔ ${b}`, (edge.get(`${a} ↔ ${b}`) ?? 0) + 1);
      }
    }
  }

  const cs = conflicts();
  const lines: string[] = [];
  lines.push(
    `记忆图：${active.length} 条事实 · ${byEntity.size} 个实体 · ${edge.size} 条关联` +
      `${superseded ? ` · ${superseded} 条被取代（不注入，可检索）` : ""}` +
      `${cs.length ? ` · ${cs.length} 处矛盾` : ""}`,
  );
  if (!active.length) {
    lines.push("", "（记忆还是空的——让我做事时可以说「记住：……」或直接用 memory 工具 remember）");
  }
  for (const [e, list] of sorted) {
    lines.push("", `● ${e} (${list.length})`);
    list.forEach((f, i) => {
      const branch = i === list.length - 1 ? "└─" : "├─";
      lines.push(`  ${branch} [${f.id}] ${f.text}  · ${f.by} · trust ${f.trust.toFixed(2)}${f.evidence ? ` · ${f.evidence}` : ""}`);
    });
  }
  const orphan = active.filter((f) => !f.entities.length);
  if (orphan.length) {
    lines.push("", `○ 未挂实体 (${orphan.length})`);
    for (const f of orphan) lines.push(`  └─ [${f.id}] ${f.text}`);
  }
  if (edge.size) {
    lines.push("", "实体关联（共享事实）：");
    for (const [k, n] of [...edge.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))) {
      lines.push(`  ${k}${n > 1 ? ` ×${n}` : ""}`);
    }
  }
  if (cs.length) {
    lines.push("", "矛盾：");
    for (const c of cs) lines.push(`  ${c.reason}`, `    A [${c.a.id}] ${c.a.text} (by ${c.a.by})`, `    B [${c.b.id}] ${c.b.text} (by ${c.b.by})`);
  }
  lines.push("", `可手改：${MIRROR}`, `真源：${FACTS}`);
  return { lines, facts: active.length, entities: byEntity.size, superseded, edges: edge.size, conflicts: cs.length };
}
