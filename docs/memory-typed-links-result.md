# 任务实施报告：Memory 可选 typed link（从标签共现走向认知结构）

> 任务书：[`docs/memory-typed-links.md`](./memory-typed-links.md)
> 上游：`docs/memory-expose-supersede.md` / `-result.md`（第 1 步，已核实）
> 评测基线：[`docs/memory-cognitive-structure-test-result.md`](./memory-cognitive-structure-test-result.md)（结论：标签共现图）
> 实施者：助手（AI）｜实施日期：2026-10-16
> 提交：`05d3ee6`（本地，未推 `main`）
> 开工前备份（**已推 GitHub**）：分支 `backup/20261016-typed-links` · tag `backup-20261016-before-typed-links`，均指向 `08ce0c1`

## 0. 约束遵守

| 约束 | 状态 |
|---|---|
| 不建新子系统 / 不上向量库 / 不挂策展模型 | ✓ 只加一个可选字段 + 词表常量 + 渲染 |
| typed link **可选**，不写完全合法 | ✓ 旧条无该字段 ≡ 无出边；真实库（0 条边）行为与改前一致 |
| 不静默抽取关系 | ✓ 边只能由模型显式声明（`links`）；无任何 NLP/正则抽取 |
| 真源仍 append-only，不删旧行 | ✓ 边的写入也是 `fact` / `fact_update` 追加；无新 `t` 类型 |
| 尽量不破坏已有记忆 | ✓ 向前兼容（字段可选、loadFacts 折叠不变） |
| 动真实记忆需 owner 显式同意 | ✓ 真实库**零写入**（`facts.jsonl` mtime 全程未变：`10-15 14:20`） |
| 测试不红 | ✓ 五套件 + smoke 全绿（含按任务书 §4.4 更新的旧断言） |

---

## 1. 开工前两个决策（任务书 §8 步骤 1 要求确认）

| 决策 | 结论 | 理由 |
|---|---|---|
| **存储方案** | **A（挂在 fact 事件上的出边列表）** | 任务书自己推荐 A；且 A **不新增事件 `t` 类型**（B 要加 `link` 事件），写入路径复用现成的 `remember`；`loadFacts` 的 `fact_update` 折叠是 `{...f, ...patch}`，**存储层零改动**就能支持改边 |
| **词表** | **按任务书建议的 5 个**：`updates · contradicts · causes · depends_on · part_of` | 我原本倾向砍掉 `updates`（怕与 supersede 双源）。**改主意了**：`updates` 作为**非破坏性**立场标记正是第 1 步残留缺口（双活跃无 supersede → 无箭头）的解 —— 模型可以只 `remember` 一条新认知并连 `updates→旧条`，而**不必真去 supersede**。代价是与 supersede 的重复显示，已在读侧去重 |

补充：别名只收 `leads_to → causes`（任务书明确提到的那一个）；单条出边上限 `LINK_MAX = 8`（与 entities 上限 12 同风格）。

---

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `src/memory.ts` | `Fact.links?` · `REL_TYPES` / `RelType` / `REL_ALIAS` / `LINK_MAX` · `normalizeRel()` · `validateLinks()` · `addFact` 校验+写边（dup 分支支持替换/补边）· `supersedeFact` **继承**旧条出边 · `linkTag()` · `renderFacts` 追加之 · `renderGraph` 分区（关系 typed / 关联共现）+ 图头计数 + `GraphView.typed` |
| `src/bot.ts` | memory 工具 schema 增 `links`（数组 of `{rel,to}`）+ 描述补一句（词表、`to` 需已存在、不写也合法） |
| `scripts/memory-tests.ts` | 新增第 14 组 8 项断言；第 8 组按 §4.4 的改名更新（`实体关联` → `关联（共现兜底）`） |
| `docs/agent-spec.md` | §11.3 末尾加一小节「边 = 可选 typed link + 共现兜底」（含待定缺口 `prevents`） |

**未改**：`facts.jsonl` 事件 schema（无新 `t`）· `MEMORY.md` 镜像格式（防 `importMirror` 回灌，理由见第 1 步报告 §1②）· 未加新 op（`links` 挂在 `remember` / `supersede` 上，不设 `op:"link"`）。

---

## 3. 行为矩阵（改前 → 改后）

| 面 | 改前 | 改后 |
|---|---|---|
| 写入 | `remember(text, entities, evidence)` | 同上，**可选** `links=[{rel,to}]`（`supersede` 同） |
| 校验 | — | 未知 rel / 缺 `to` / `to` 不存在 / 自环 / 超 8 条 → **拒绝并说明合法集合**；重复 `(rel,to)` 静默去重 |
| 未声明 links | — | 完全合法；**dup 分支**不动原有边；显式声明则**替换**（→ 这是补边/改边/删边的路径） |
| `supersede` | 继承 entities | 增量：**未声明 links 时继承旧条出边**（换代不断链） |
| `renderFacts`（模型看到的行） | `… · trust · by` + 第 1 步取代标记 | 再加出边 `· →causes:id`（最多 3 条，超出 `+N`） |
| `/memory` | `实体关联（共享事实）` | **两区**：`关系（typed，显式声明 N 条）`（导航主路径，画 `from --rel--> to`）+ `关联（共现兜底，无类型）` |
| `/memory` 图头 | `N 条关联` | `N 条关联(共现)` + `M 条关系(typed)` |
| 共现边 | 唯一拓扑 | **保留**做索引/兜底，但不再是唯一拓扑 |
| `MEMORY.md` | 仅活跃条 | **未改**（有意） |

### 3.1 输出示例（fixture）

```text
[msx…] 修复：createTextSegment 段即对象  [fixture, render] · trust 0.60 · by bot · →depends_on:msx… · →causes:msx…

记忆图：7 条事实 · 3 个实体 · 21 条关联(共现) · 4 条关系(typed) · 1 条被取代（…）…

关系（typed，显式声明 4 条）：
  msvq… --causes--> msvp…
  msvr… --updates--> msvp…
  msvs… --depends_on--> msvr…
  msvt… --part_of--> msvs…

关联（共现兜底，无类型）：
  fixture ↔ render ×7
```

---

## 4. 任务书 §5 验收逐条

| # | 要求 | 结果 |
|---|---|---|
| 1 | 旧库无 link 时行为与改前一致，测试不红 | ✓ 真实库 `typed=0`、带 links 的事实 `0` 条；`linkTag()` 返回空串 → 渲染与改前逐字节一致；五套件全绿 |
| 2 | 写入带 `links` 后读路径能看到 typed 边 | ✓ `renderFacts` 带出 `→rel:id`；`/memory` 画 `from --rel--> to` |
| 3 | 非法 `rel` 被拒；缺 `links` 成功 | ✓ 抛错信息含合法集合；无 links 一切照旧 |
| 4 | 优先 fixture；动真实库需显式同意 | ✓ 全部验收在 `/tmp` fixture；真实库**零写入** |
| 5 | 文档：任务书 + 结果报告 + agent-spec 短节 | ✓ 本文件 + `agent-spec.md` §11.3 新增小节 |
| 6 | 可选：用评测协议复跑，报告类数变化 | ✓ 见 §5 |

---

## 5. 评测协议复跑（结构可读类数）

同一套判据（只走结构，不读 `text`）：立场 = `updates`/`supersede`/`contradicts`；因果 = `causes`；依赖 = `depends_on`/`part_of`。

| 数据 | 立场 | 因果 | 依赖 | 类数 | 分档 |
|---|---|---|---|---|---|
| **fixture**（按结构编码一条真实故事线） | 2 | 1 | 2 | **3/3** | **认知结构** |
| **真实库**（尚未写入任何 typed 边） | 22（全来自 supersede 链） | 0 | 0 | **1/3** | 标签图（= 基线，未变） |

fixture 里的三个**结构问答**（不读文本、只走边）：

```
谁更新了 msvp…j？   → msvr…    （updates 边 / supersede 链）
什么导致 msvn…i？   → msvp…    （causes 边）
msvt… 属于谁？      → msvs…    （part_of 边）
```

> **结论（务必对齐预期）**：**能力**已具备，分档提升取决于**数据积累** —— 真实库要等模型在真实使用中写边
> （或 owner 同意做一次小规模补边实验）才会从 1/3 变 2~3/3。本次没有、也不应在未获同意时改真实库。

---

## 6. 测试

| 套件 | 结果 |
|---|---|
| `npm run test:memory` | **ALL MEMORY TESTS PASS**（含新增第 14 组） |
| `npm run test:render` / `test:commands` / `test:divert` / `test:login` | 5 / 7 / 6 / 5 组 ✓ |
| `npm run smoke` | SMOKE OK |

### 6.1 新增第 14 组断言（8 项）

```
14) typed link（往返 · 归一化 · 非法拒绝 · 去重 · 换代继承 · 图分区 · 镜像不污染）✓
```

1. **往返**：`→depends_on:<id>` 渲染；别名 `leads_to` 归一化为 `causes`
2. **兼容**：无 links 的条 `linkTag()` 为空串，且 `Fact.links` 仍为 `undefined`（不凭空多字段）
3. **拒绝**：未知 rel（`because`）/ `to` 不存在 / 超过 `LINK_MAX` → 全部抛错
4. **去重**：重复 `(rel,to)` 静默合并为 1 条
5. **换代继承**：`supersede` 不带 links → 新条继承旧条出边
6. **补边**：同文本 re-remember 带 links → dup 分支替换 links（即「先写事实、事后连边」路径）
7. **图分区**：`typed` 计数、`关系（typed` 区、`关联（共现兜底` 区、`--rel-->` 画法、图头 typed 计数
8. **镜像不污染**：`MEMORY.md` 内不得出现任何 typed 边或边画法（防 `importMirror` 把注记当正文回灌）

---

## 7. 已知残留 / 待 owner 定

| 项 | 说明 |
|---|---|
| **词表缺口：`prevents`** | 因果类只有 `causes`，「修复**阻止了**该 bug」这类断言只能勉强写成 `causes`，语义偏。加它 = 一行常量 + 别名。**未擅自加**（任务书定 ≤5） |
| **入边（谁指向我）读不到** | `renderFacts` 只给出边（该条自己的断言）。「谁依赖我 / 谁被我取代」目前看 `/memory` 的 typed 区。按 rel 过滤的只读 op / `related` 增强 = 任务书 §4.4 明确列为第二迭代 |
| **真实库仍 1/3 类** | 能力已具备；要提升需真实使用积累边，或另开一次**补边实验**（需 owner 显式同意） |
| **`to` 必须已存在 → 先写后连** | 因果/依赖边天然要先有目标。已提供补边路径（同文本 re-remember，links 替换）；但这是**使用纪律**，不是强制 |
| conflicts 假阳性 / hub 稀释 | 任务书 §3 列为非目标，未动 |
| 未推 `main` | 本次改动仅本地提交；备份分支/标签已在 GitHub |

---

## 8. 风险与对策（任务书 §9 逐条）

| 风险 | 本实现的对策 |
|---|---|
| 模型乱连边 | 词表封闭（5 + 1 别名）+ `to` 必须存在 + 自环拒绝 + 上限 8 + 重复去重；**不硬禁止写入**（可 rewrite links） |
| hub 仍吵 | typed 区列为导航主路径、共现区降级为兜底并在标签上写明「无类型」 |
| 与第 1 步重复 | `updates` 边与 `replaces` **读侧去重**（同一条上不重复打印） |
| 范围膨胀 | 未夹带时空边 / 自动抽取 / sleep 重组（§3 非目标）；`created/updated` 时间维度按 §6 保持不展开 |
| 上下文膨胀 | 出边最多 3 条（`+N`）；实测每条约 21–25 字符 |

---

## 9. 如何复现

```bash
cd "/Users/niuqingwei/Desktop/zebra tui"

# 1) 全套测试（含第 14 组 typed link）
npm run test:memory && npm run test:render && npm run test:commands && npm run test:divert && npm run test:login && npm run smoke

# 2) 真实库兼容性 + 只读证明（应显示 typed=0、带 links 的事实=0）
node --experimental-strip-types --no-warnings -e '
import { loadFacts, renderGraph } from "./src/memory.ts";
const g = renderGraph();
console.log("typed 边数:", g.typed, "· 带 links 的事实:", loadFacts().filter((f) => f.links?.length).length);
console.log(g.lines[0]);
'
ls -l ~/.krystal/facts.jsonl   # mtime 应保持 10-15 14:20

# 3) 结构类数复跑：在隔离 HOME 里建 fixture（脚本见报告 §5；真实库只读对照）
```

## 10. 相关文档

- 任务书：`docs/memory-typed-links.md`
- 第 1 步：`docs/memory-expose-supersede.md` / `-result.md`
- 评测协议与基线：`docs/memory-cognitive-structure-test.md` / `-result.md`
- 设计圣经：`docs/agent-spec.md`（§11.3 已加「边 = 可选 typed link + 共现兜底」）
- 另一条结构线：`docs/compaction-graph.md`（决策图，勿与本任务混工）