// Krystal — 记忆图（M2）
// 设计：docs/agent-spec.md §11（事实是节点、实体是边；五查询；压缩=搬迁不删）、§13（稳定序、易变值不进前缀）
// 存储：facts.jsonl（append-only 版本流：事实版本 + 取代事件）——「一主题一条、旧条不删只标被取代」
// 镜像：MEMORY.md（人可读可改；运行时真源仍是 facts.jsonl）
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chat, type BuilderConfig } from "./builder.ts";
import { fg } from "./ui/ansi.ts";

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
  /** 归属：undefined = 全局（Bot 的记忆）；team-xxx = 某团队（团队断言互不污染） */
  scope?: string;
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

/** 读全部事实（版本流折叠；被取代的标记保留、默认不参与注入）。
 *  进程内缓存 + mtime:size 签名失效——append-only 文件任何写入（append 追加）都会同时变mtime与size，签名必变，无需手动失效。 */
let cache: { key: string; facts: Fact[] } | undefined;

export function loadFacts(): Fact[] {
  let raw = "";
  let key = "";
  try {
    const st = fs.statSync(FACTS);
    key = `${st.mtimeMs}:${st.size}`;
    if (cache && cache.key === key) return cache.facts;
    raw = fs.readFileSync(FACTS, "utf8");
  } catch {
    cache = undefined;
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
  cache = { key, facts: [...byId.values()] };
  return cache.facts;
}

export const activeFacts = (facts: Fact[]): Fact[] => facts.filter((f) => !f.supersededBy);

export interface AddInput { text: string; entities?: string[]; by?: string; evidence?: string; trust?: number; scope?: string }

export function addFact(input: AddInput): Fact & { existed?: boolean } {
  const at = new Date().toISOString();
  // 一主题一条：同文本的活跃事实 → 更新原条（加强信任），不新增（否则重复记忆会淹没注入块）
  const key = `${input.scope ?? ""}\u0000${input.text.trim().toLowerCase()}`;
  const dup = activeFacts(loadFacts()).find((f) => `${f.scope ?? ""}\u0000${f.text.trim().toLowerCase()}` === key);
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
    scope: input.scope,
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

/** 反馈：helpful +0.2 / wrong −0.3（显式、可审计；不做自动信号分） */
export function adjustTrust(id: string, delta: number): Fact | undefined {
  const f = loadFacts().find((x) => x.id === id);
  if (!f) return undefined;
  const trust = Math.max(0.1, Math.min(1, f.trust + delta));
  append({ t: "fact_update", id, patch: { trust, updated: new Date().toISOString() } });
  writeMirror();
  return { ...f, trust };
}

/** 提取练习：命中即计数（提取效应）。批量一次读库、N 条一次落盘；批后失效缓存并同步镜像 */
export function markUsed(ids: string[]): void {
  if (!ids.length) return;
  const uniq = [...new Set(ids)];
  const byId = new Map(loadFacts().map((f) => [f.id, f]));
  for (const id of uniq) {
    const f = byId.get(id);
    if (!f) continue;
    append({ t: "fact_update", id, patch: { used: f.used + 1 } });
  }
  cache = undefined; // append 已使文件签名变化，但进程内缓存里的 used 是旧值——显式失效最稳
  writeMirror(); // 修复历史失步：used 变更也要同步人可读镜像
}

// ---------- 五个确定性查询（grep 式，无向量库） ----------

// 中文没有词边界：整句会被当成一个 token → 用 2-gram 展开做最小检索（不引入分词器）
const CJK = /[\u4e00-\u9fff]/;
const toks = (s: string): string[] => {
  const raw = s.toLowerCase().split(/[^\p{L}\p{N}_./@-]+/u).filter((t) => t.length > 1);
  const out = new Set<string>();
  for (const t of raw) {
    out.add(t);
    if (CJK.test(t) && t.length > 2) {
      for (let i = 0; i + 2 <= t.length; i++) out.add(t.slice(i, i + 2));
    }
  }
  return [...out];
};
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

export function recall(query: string, limit = 6, scope?: string): Fact[] {
  const ts = toks(query);
  return activeFacts(loadFacts()).filter((f) => !scope || f.scope === scope)
    .map((f) => ({ f, s: score(f, ts) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || (a.f.created < b.f.created ? 1 : -1))
    .slice(0, limit)
    .map((x) => x.f);
}

export const about = (entity: string, limit = 8, scope?: string): Fact[] =>
  activeFacts(loadFacts())
    .filter((f) => !scope || f.scope === scope)
    .filter((f) => f.entities.some((e) => e.toLowerCase().includes(entity.toLowerCase())))
    .slice(0, limit);

/** 一跳邻居：与「关于 entity 的事实」共享其他实体的事实 */
export function related(entity: string, limit = 8, scope?: string): Fact[] {
  const base = about(entity, 8, scope);
  const baseIds = new Set(base.map((f) => f.id));
  const shared = new Set(base.flatMap((f) => f.entities.map((e) => e.toLowerCase())).filter((e) => !e.includes(entity.toLowerCase())));
  return activeFacts(loadFacts())
    .filter((f) => !scope || f.scope === scope)
    .filter((f) => !baseIds.has(f.id) && f.entities.some((e) => shared.has(e.toLowerCase())))
    .slice(0, limit);
}

/** 交集：同时关联两实体的事实 */
export const connect = (a: string, b: string, limit = 8, scope?: string): Fact[] =>
  activeFacts(loadFacts())
    .filter((f) => !scope || f.scope === scope)
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

export function conflicts(scope?: string): { a: Fact; b: Fact; reason: string }[] {
  const active = activeFacts(loadFacts()).filter((f) => !scope || f.scope === scope);
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

// ---------- 注入通道已废除（spec §12.4 #22，2026-09-24 owner：纯检索架构） ----------
// 记忆绝不预装进上下文；一切访问走五查询工具。原 memoryBlock/cognitionFacts/PIN_LIMIT 已删——
// 无注入槽即无淘汰问题；prompt 前缀字节永续（缓存命中率最大化）。
// 「必须天生知道」的人格级事实走人工编辑 prompt 文件（人审、低频、字节稳定）。

// ---------- 人可读镜像（LN-1 形状：运行时真源是 jsonl，md 是人的入口） ----------

// ── 睡眠协议（/sleep，spec §11.6 草案）：睡眠 = 压缩的兄弟
// 模型只出策展方案、内核只执行 append-only 事件（同 summarize 分工）。
// 触发：全局活跃事实数（不含 scope）软阈值 85 → memory 工具返回附提醒；
//       硬阈值 100 → 下次 memory 调用先睡再答；owner 手动 :sleep 强制同流程。
// 事件全部走既有三原语：addFact / supersedeFact / adjustTrust（+ entities patch）——零新 schema。
export const SLEEP_SOFT = 85;
export const SLEEP_HARD = 100;

let sleepRunning = false; // 防重入旗：睡眠中再调 memory 直接放行查询

export function globalFactCount(): number {
  return activeFacts(loadFacts()).filter((f) => !f.scope).length;
}

const SLEEP_PLAN_PROMPT = (list: string) =>
  `你是记忆策展人。下面是 Krystal 全局活跃事实清单（[id] 内容 · 实体 · trust · 证据）。
按分类标准四问（用户偏好/项目事实/坑与修法/会话状态）与实体纪律（具体名词>宽泛标签，一条 1-4 个实体）策展：
- merge：同主题多条 → 合并为一条（text + entities）
- supersede：表述过时/被新事实取代 → 给出新文本
- retag：实体挂错或太宽泛 → 重挂实体（具体名词，1-4 个）
- promote：确实有用但 trust 偏低 → 升 trust
- drop：会话状态类/无价值 → 退役（降权沉底，原文保留）
只输出 JSON，不要 markdown 围栏，不确定的条目不要动：
{"merge":[{"sources":["id","id"],"text":"…","entities":["…"]}],"supersede":[{"id":"…","text":"…"}],"retag":[{"id":"…","entities":["…"]}],"promote":["id"],"drop":["id"]}
清单：
${list}`;

export interface SleepEvent {
  sign: "+" | "−" | "~"; // + 新增/合并结果 · − 被覆盖/退役 · ~ 重挂/升降权
  id: string;
  text: string;
  note?: string;
}
export interface SleepResult {
  applied: number;
  skipped: number;
  reportPath: string;
  summary: string;
  /** 结构化事件流（供 UI 做 diff 展示与记忆图变更标注） */
  events: SleepEvent[];
}

/** 睡眠整理：打包全局活跃事实 → 模型出策展方案 → 内核逐条应用 append-only 事件 → 报告落盘。
 *  失败/进行中返回 undefined（调用方附注跳过，不阻塞）。 */
export async function sleepMemories(cfg: BuilderConfig): Promise<SleepResult | undefined> {
  if (sleepRunning) return undefined;
  const facts = activeFacts(loadFacts()).filter((f) => !f.scope);
  if (!facts.length) return undefined;
  sleepRunning = true;
  try {
    const events: SleepEvent[] = [];
    const list = facts
      .map((f, i) => `${i + 1}. [${f.id}] ${f.text}  实体[${f.entities.join(",")}] trust ${f.trust.toFixed(2)}${f.evidence ? ` · ${f.evidence}` : ""}`)
      .join("\n");
    const raw = await chat(cfg, SLEEP_PLAN_PROMPT(list), { timeoutMs: 120_000, maxTokens: 4096 });
    const cleaned = raw.replace(/^\s*```(?:json)?/, "").replace(/```\s*$/, "").trim();
    const ps = cleaned.indexOf("{"), pe = cleaned.lastIndexOf("}");
    if (ps < 0 || pe <= ps) return undefined;
    const plan = JSON.parse(cleaned.slice(ps, pe + 1)) as {
      merge?: { sources?: string[]; text?: string; entities?: string[] }[];
      supersede?: { id?: string; text?: string }[];
      retag?: { id?: string; entities?: string[] }[];
      promote?: string[];
      drop?: string[];
    };
    const byId = new Map(facts.map((f) => [f.id, f]));
    let applied = 0, skipped = 0;
    const log: string[] = [];
    const mark = (ok: boolean, line: string) => (ok ? applied++ : skipped++, log.push((ok ? "✓ " : "✗ ") + line));
    for (const m of plan.merge ?? []) {
      const src = (m.sources ?? []).filter((id) => byId.has(id));
      if (src.length < 2 || !m.text?.trim()) { mark(false, `merge 缺源或文本`); continue; }
      const nf = addFact({ text: m.text.trim(), entities: m.entities ?? [], by: "sleep" });
      src.forEach((id) => {
        if (id === nf.id) return;
        append({ t: "supersede", id, by: nf.id, at: new Date().toISOString() });
        events.push({ sign: "−", id, text: byId.get(id)?.text ?? id, note: "被合并覆盖" });
      });
      events.push({ sign: "+", id: nf.id, text: m.text.trim() });
      mark(true, `merge ${src.join(" + ")} → [${nf.id}] ${m.text.trim().slice(0, 40)}`);
    }
    for (const sItem of plan.supersede ?? []) {
      const id = sItem.id ?? "";
      if (!byId.has(id) || !sItem.text?.trim()) { mark(false, `supersede ${id} 无效`); continue; }
      const nf = supersedeFact(id, { text: sItem.text.trim(), entities: byId.get(id)!.entities, by: "sleep" });
      events.push({ sign: "−", id, text: byId.get(id)?.text ?? id, note: "被取代" });
      if (nf) events.push({ sign: "+", id: nf.id, text: nf.text });
      mark(!!nf, `supersede [${id}] → [${nf?.id}] ${sItem.text.trim().slice(0, 40)}`);
    }
    for (const rItem of plan.retag ?? []) {
      const id = rItem.id ?? "";
      if (!byId.has(id) || !rItem.entities?.length) { mark(false, `retag ${id} 无效`); continue; }
      append({ t: "fact_update", id, patch: { entities: rItem.entities.slice(0, 8), updated: new Date().toISOString() } });
      events.push({ sign: "~", id, text: byId.get(id)?.text ?? id, note: `实体重挂 [${rItem.entities.join(",")}]` });
      mark(true, `retag [${id}] ← [${rItem.entities.join(",")}]`);
    }
    for (const id of plan.promote ?? []) {
      if (!byId.has(id)) { mark(false, `promote ${id} 无效`); continue; }
      adjustTrust(id, 0.2);
      events.push({ sign: "~", id, text: byId.get(id)?.text ?? id, note: "trust +0.2" });
      mark(true, `promote [${id}] trust +0.2`);
    }
    for (const id of plan.drop ?? []) {
      if (!byId.has(id)) { mark(false, `drop ${id} 无效`); continue; }
      adjustTrust(id, -0.4); // 退役=降权沉底（trust 下限 0.1，recall 排序沉底；原文永不删除）
      events.push({ sign: "−", id, text: byId.get(id)?.text ?? id, note: "退役降权（原文保留）" });
      mark(true, `drop [${id}] trust −0.4（退役沉底，原文保留）`);
    }
    writeMirror();
    const after = globalFactCount();
    const reportPath = path.join(DIR, `sleep-report-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.md`);
    const report = [
      `# 睡眠报告 ${new Date().toISOString()}`,
      "", `- 睡前全局活跃事实：${facts.length}`, `- 醒后：${after}`, `- 应用 ${applied} 条 · 跳过 ${skipped} 条`, "",
      "## 事件明细", ...log, "",
      "## 原则", "- 全部 append-only（supersede/降权），原文永不删除；本报告即审计链。",
    ].join("\n");
    try { fs.writeFileSync(reportPath, report + "\n"); } catch { /* 降级 */ }
    return { applied, skipped, reportPath, summary: `应用 ${applied} · 跳过 ${skipped} · 库 ${facts.length}→${after}`, events };
  } catch {
    return undefined;
  } finally {
    sleepRunning = false;
  }
}

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

// ---------- 双向镜像：MEMORY.md（人入口）→ facts.jsonl（真源）（LN-1） ----------

export interface ImportResult { imported: number; added: number; skipped?: string }

/**
 * 启动时导入：md 比 jsonl 新 → 解析并应用（全量校验通过才写，写前备份）
 * 保守降级：解析异常 → 不导入、不动数据。删除（md 里整条消失）暂不处理（避免误删，见文档）
 */
export function importMirror(): ImportResult {
  let md = "";
  let mdMtime = 0;
  try {
    md = fs.readFileSync(MIRROR, "utf8");
    mdMtime = fs.statSync(MIRROR).mtimeMs;
  } catch {
    return { imported: 0, added: 0 };
  }
  let jsonMtime = 0;
  try {
    jsonMtime = fs.statSync(FACTS).mtimeMs;
  } catch {
    /* 还没有 jsonl：全量导入 */
  }
  if (jsonMtime && mdMtime <= jsonMtime) return { imported: 0, added: 0 }; // md 不比真源新 → 无事可做

  const facts = loadFacts();
  const byId = new Map(facts.map((f) => [f.id, f]));
  const changes: { id: string; text: string }[] = [];
  const additions: { id: string; text: string }[] = [];
  for (const raw of md.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("- ")) continue;
    const m = /^-\s*\[([\w-]+)\]\s*(.+?)\s*(?:\([^)]*\))?$/.exec(line);
    if (!m) {
      // 有人手写了一条没有 id 的：当作新事实
      if (line.startsWith("- ") && line.length > 4) additions.push({ id: "", text: line.slice(2).trim() });
      continue;
    }
    const [, id, text] = m;
    const exist = byId.get(id!);
    if (!exist) additions.push({ id: id!, text: text!.trim() });
    else if (exist.text.trim() !== text!.trim()) changes.push({ id: id!, text: text!.trim() });
  }

  if (!changes.length && !additions.length) return { imported: 0, added: 0 };
  try {
    fs.copyFileSync(FACTS, `${FACTS}.bak`); // 写前备份（保留最近一次）
  } catch {
    /* 首次导入无文件可备份 */
  }
  for (const c of changes) append({ t: "fact_update", id: c.id, patch: { text: c.text, updated: new Date().toISOString() } });
  for (const a of additions) {
    const f: Fact = {
      id: a.id || rid(),
      text: a.text.slice(0, 600),
      entities: guessEntities(a.text),
      by: "human",
      trust: 0.8, // 人手写的更可信
      used: 0,
      created: new Date().toISOString(),
      updated: new Date().toISOString(),
    };
    append({ t: "fact", f });
  }
  // 重生成镜像：给人手写的无 id 行补上 id → 保证再次导入幂等（否则每次启动都会重复新增）
  writeMirror();
  return { imported: changes.length, added: additions.length };
}

/** 把查询结果渲染成给模型看的一行行文本 */
export const renderFacts = (facts: Fact[], emptyHint = "（没有匹配的记忆）"): string =>
  facts.length
    ? facts.map((f) => `[${f.id}] ${f.text}${f.entities.length ? `  [${f.entities.join(", ")}]` : ""}${f.evidence ? `  (${f.evidence})` : ""} · trust ${f.trust.toFixed(2)} · by ${f.by}`).join("\n")
    : emptyHint;
// ---------- /memory：把记住的东西与图都画出来（终端友好的「树 + 边」） ----------

export interface GraphView { lines: string[]; facts: number; entities: number; superseded: number; edges: number; conflicts: number }

export interface SleepMarks {
  greenIds: Set<string>; // 睡眠中新增/修改的事实 id（图中标绿）
  retired: { id: string; text: string; note?: string }[]; // 被覆盖/退役的旧知（单列标红）
}
export function renderGraph(scope?: string, marks?: SleepMarks): GraphView {
  const all = loadFacts().filter((f) => !scope || f.scope === scope);
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

    const cs = conflicts(scope); const lines: string[] = [];
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
      const seg = `[${f.id}] ${f.text}  · ${f.by} · trust ${f.trust.toFixed(2)}${f.evidence ? ` · ${f.evidence}` : ""}`;
      lines.push(`  ${branch} ` + (marks?.greenIds.has(f.id) ? fg("38;5;71", seg) : seg));
    });
  }
  if (marks?.retired.length) {
    lines.push("", "睡眠覆盖（旧知保留可审计）：");
    for (const r of marks.retired) lines.push(fg("38;5;218", `  − [${r.id}] ${r.text}${r.note ? ` · ${r.note}` : ""}`));
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
