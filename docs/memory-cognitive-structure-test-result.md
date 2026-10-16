# Krystal 记忆「认知结构」只读测试 — 评测结果

> 协议：[`docs/memory-cognitive-structure-test.md`](./memory-cognitive-structure-test.md)
> 评测者：助手（AI）｜评测日期：2026-10-16
> 主题：`Krystal Bot`（全局活跃 hub）

## 0. 快照与口径（结论钉在这一帧上）

| 项 | 值 |
|---|---|
| 快照时间 | 2026-10-16（本地 11:24） |
| `~/.krystal/facts.jsonl` | mtime 2026-10-15 14:20 · 94,867 字节 |
| 全库 | 87 条 fact = **活跃 65**（全局 **60** + 团队 scope 5）+ **已取代 22**（取代率 25%） |
| 冲突对 | 8（`conflicts()` 上限：每实体最近 3 条 / 最多 8 对） |
| 主判集 | 全局活跃（无 `scope`）60 条 |

**约束遵守**：未改任何源码；未写入 / 修改 / 删除 / supersede 记忆；未跑 `/sleep`；未引入向量检索或新子系统；分析脚本仅在 `/tmp`（只读调用 `loadFacts / activeFacts / conflicts` 等纯读函数）。

---

## 1. 主题与事实 id（17 条全局活跃）

选主题依据：`Krystal Bot` 是最大全局 hub（17 条），且参与 18 条取代链、3 处冲突——三类线索最密。

```
mueustiazs21  456字 used8   三方 harness 对比（pi / Krystal Bot / bobo）
mueva8hyk2rz  512字 used7   Krystal Bot 与 pi 的 compaction 实测对比
mufb0zem1tca  197字 used0   conflicts() 假阳性根因
mufb98faw4ef  417字 used0   记忆容量机制（注入块硬顶 PIN_LIMIT=20、600 字截断）
mufbe638t380  168字 used3   记忆系统两大设计原则（极简 + 神经科学驱动）
mufc1oyke19f  495字 used1   记忆系统缺陷清单·二修后状态
mufcgdl3hvbd  310字 used0   记忆检索性能基线（mtime:size 缓存）
mufcow4n3da0  360字 used2   记忆污染伤害机制（三个阀门）
mufcvdnk7txt  542字 used0   hermes 记忆体系实测对比
mufczq8w7hu8  561字 used1   hermes 记忆整理机制全解
mufdl9y5e96y  441字 used6   记忆架构拍板→已落地（纯检索架构）
mufgbxakch12  497字 used0   分类方式对比结论（hermes 装饰性标签 vs §12.5 分类即编码）
mufgwrpjhow0  486字 used4   /sleep 触发机制定稿（终版）
mugevoj7l0fc  579字 used1   pi compaction 代码级机制（0.84.1 实读）
mugw71kb3st1  118字 used1   owner 的 agent 能力框架（cognition / attention / experience）
muh38gzq5uri  600字 used4   owner 的 compaction 决策图设计（第四版）
muh3fyqt0uoj  422字 used3   决策图施工文档已定稿落盘（docs/compaction-graph.md）
```

---

## 2. 机器共现图摘要

只使用机器结构边：**「共享同一 entity 字符串」**与**「同条 fact 内实体共现」**，不发明关系类型。

| 指标 | 值 | 说明 |
|---|---|---|
| 节点 | 17 | 主题活跃事实 |
| 完全图边数 | 136 | `17×16/2` |
| **原始共现边** | **136（密度 100%）** | 任意两条事实都共享至少一个实体 |
| 其中「只靠主题 hub 本身」 | **66 条** | 全部共享 `Krystal Bot` → **零信息** |
| 靠非 hub 实体连上的 | 70 条（密度 51%） | 真正有信息的部分 |
| 孤立点 | **0** | hub 把所有节点连通 → 图**无分区 / 无导航能力** |
| 主题内 top hub | `Krystal Bot` 17/17 · `agent-spec` 10 · `memory.ts` 6 · `facts.jsonl` 4 · `pi-coding-agent` 4 | |
| 带类型结构边 | **updates 4**（落入活跃集；涉题取代链共 10）· **contradicts 2**（皆误报） | 由 supersede 链与 conflicts 启发式提供 |
| **结构 : 噪声** | **6 : 136 ≈ 1 : 23** | |

---

## 3. 三类关系表

判定规则（协议 B）：`结构可读` = 图上已有结构支撑；`仅文本` = 关系只在自然语言里；`无` = 金标也不认为存在。

| # | 事实 A | 关系 | 事实 B | 判定 |
|---|---|---|---|---|
| 1 | `mufgr7ueu89z` /sleep 方案定稿 | **updates** | `mufgwrpjhow0` /sleep 终版 | **结构可读** |
| 2 | `mugxjbgl7pe6` compaction 第三版 | **updates** | `muh38gzq5uri` 第四版 | **结构可读** |
| 3 | `mufd5izxg0gh` 记忆架构拍板 | **updates** | `mufdl9y5e96y` 拍板→已落地 | **结构可读** |
| 4 | `mufb0zekrxe6` 记忆体系复测快照 | **updates** | `mufc1oyke19f` 缺陷清单二修 | **结构可读** |
| 5 | `mueva8hyk2rz` compaction 实测对比 | contradicts | `mufb0zem1tca` conflicts 假阳性根因 | 机器给了边；**金标=无关 → 误报** |
| 6 | `mueva8hyk2rz` compaction 实测对比 | contradicts | `mufc1oyke19f` 缺陷清单 | 机器给了边；**金标=无关 → 误报** |
| 7 | `mufb98faw4ef` 容量机制「注入块硬顶 PIN_LIMIT=20」 | **updates / contradicts** | `mufdl9y5e96y`「已删 PIN_LIMIT 与注入通道」 | **仅文本** ★核心缺口 |
| 8 | `mufb0zem1tca` 假阳性根因（配对不查自述） | **causes** | 第 5/6 行那两条误报本身 | **仅文本** |
| 9 | `mufcow4n3da0` 三阀门伤害分析 | **leads-to** | `mufdl9y5e96y` 删注入通道（最优修复） | **仅文本** |
| 10 | `mufcgdl3hvbd` 检索性能基线 | **supports** | `mufcow4n3da0`「库大不是病」 | **仅文本** |
| 11 | `mugevoj7l0fc` pi 代码级实读 | **supports** | `mueva8hyk2rz` 对比实测结论 | **仅文本** |
| 12 | `muh38gzq5uri` 第四版设计 | **requires / uses** | `muh3fyqt0uoj` 施工文档落盘 | **仅文本**（共现 `graph-demo`，无类型） |
| 13 | `muh3fyqt0uoj` 施工文档 | **part-of** | `docs/compaction-graph.md` | **仅文本**（实体存在，读不出 part-of） |
| 14 | `mufb98faw4ef` 容量机制 | — | `mufcgdl3hvbd` 性能基线 | **无**（金标也不认为有类型关系） |

**统计：结构可读 4 行（全属第 1 类「立场」）· 仅文本 8 行 · 无 1 行 · 误报 2 行。**

### 3.1 决定性命中判定：唯一带类型的结构「不可达」

supersede 链（`updates`）**在所有产品接口里都看不见**：

| 接口 | 能否看到「这条已被 X 取代」 | 位置 |
|---|---|---|
| 五个查询 `recall / about / related / connect / conflicts` | ✗ 全部经 `activeFacts()` 过滤，已取代条**根本不返回** | `memory.ts` `activeFacts()` |
| `renderFacts`（模型实际收到的工具输出） | ✗ 只印 `[id] text [entities] (evidence) · trust · by`，**无 `supersededBy`** | `memory.ts` `renderFacts()` |
| `/memory` 图视图 | ✗ 只有一个计数「N 条被取代」 | `memory.ts` `renderGraph()` |
| `MEMORY.md`（人的入口） | ✗ 只写活跃条，已取代条整条不在 | `memory.ts` `writeMirror()` |

**且 `renderGraph` 里那句「N 条被取代（不注入，**可检索**）」与实现不符**——没有任何查询能取回被取代的事实。
多跳链的中间节点全部是已取代条（`/sleep` 三跳、compaction 四跳），因此**从活跃集走不通**。

> 结论：这个结构只有**直接读原始 `facts.jsonl`** 才看得见；agent 与人通过产品本身都看不见。
> 对「结构可读」的判定必须附带这条限定。

---

## 4. 与金标的差集

**缺口（金标有、机器结构无）**

1. **活跃事实之间的时效性**（最严重）：`mufb98faw4ef`（旧认知：存在注入槽 PIN_LIMIT=20）与 `mufdl9y5e96y`（新认知：注入通道已删）**都处于活跃集**，图上二者之间只有共现边 → 机器**无法回答「当前设计到底是哪个」**。
2. **全部因果**（第 8/9 行 + 5/6 的成因）：根因→误报、伤害机制→修复、根因→机器自身误报。
3. **全部依赖**（第 10–13 行）：设计→施工文档、文档→文件、基线→结论、实读→对比。
4. **退役中间节点导致的断链**：`/sleep` 三跳与 compaction 四跳的中段已取代 → 活跃集不可达。

**噪声（机器有、金标无语义）**

1. **136/136 共现边 = 完全图（100%）**，其中 **66 条只靠主题 hub 连上 = 纯噪声**；0 孤立点 ⇒ 图退化为全连接网，导航信息量为零。
2. **`conflicts` 2/2 全误报**（两对在语义上都不构成相反断言）。讽刺的是：库里 `mufb0zem1tca` 正是记录「conflicts 有假阳性」的那条事实，而它自己成了被误报的对象之一。
3. 结构 : 噪声 ≈ **1 : 23**。

---

## 5. 最终分档

# 标签共现图

按协议评分标准：三类里结构可读 **1 类**（立场）**< 2** → 「标签图」。
且这唯一 1 类**无法通过产品接口读取**，只能直读 JSONL；`contradicts` 半边精度为 0/2。

> **一句话结论**：现有 memory graph 是**标签共现图**——边是「共享标签」，不是「关系」；唯一带类型的 supersede 链既不进任何查询结果、也不进图视图与镜像，对 agent 与人皆不可见，故**未达认知结构**。
>
> （符合协议预期：「基于当前架构的预期：多半为标签图或过渡」。）

---

## 6. 观察（建议级，**未实现**）

1. **最小改动即可让「立场」真正可用**：让五查询与 `renderFacts` 一并带出 `supersededBy`（或其链头 id）——零新概念、零新表，agent 在 recall 时就能自己看到「这条已被 X 取代」；同时把 `renderGraph` 里「可检索」的文案改成事实。**这是把「立场」从「结构上存在」变成「可被使用」的唯一必要动作。**
2. **hub 实体是「桶」不是「路标」**：排掉主题 hub 后仍有 51% 密度，说明实体只做了聚类、没做区分。任何依赖图导航的设计都需先解决 hub 稀释（例：某实体挂载 ≥K 条时不参与连边），否则加边只会加噪。
3. **「立场」若靠启发式词表会自我污染**：conflicts 的误报已被库自身记录，而那条记录同时又是误报对象。若将来收紧，方向是「排除同一事实自述内的正负词反转」，而不是继续加词对。

---

## 附录 A：方法与可复现性

- **只读做法**：直接调用 `loadFacts()` / `activeFacts()` / `conflicts()`（纯读，无 `markUsed`、无写盘）；未调用 `addFact / supersedeFact / adjustTrust / sleepMemories / importMirror`。
- **字段名更正**：首轮误用 `superseded_by`（应为 `supersededBy`，见 `loadFacts()` 折叠逻辑），导致一度误判「取代从未发生」。修正后：**取代 22 次、取代率 25%**，取代闭环是活的。本报告全部数字以修正后口径为准。
- **主题内两两共现**：对 17 条事实两两求 `entities` 交集（大小写不敏感）判定是否连边。
- **带类型边来源**：`updates` = `facts.jsonl` 中 `supersede` 行的 `id → supersededBy` 指向关系；`contradicts` = `conflicts()` 启发式的返回。
- **金标**：由评测者按 `text` 语义人工标注（第 3 节表中 `仅文本` 与 `无` 两列即金标侧判断），未写入记忆库。

## 附录 B：原始数据

**B1. 涉题取代链 10 条**（旧 → 新）：

```
muevuh3n5lam → mufb0zekrxe6   记忆体系实测快照 → 复测快照
mufb0zekrxe6 → mufc1oyke19f   复测快照 → 缺陷清单二修            ★活跃端
mufd5izxg0gh → mufdl9y5e96y   记忆架构拍板 → 拍板已落地           ★活跃端
mufgkgvc4ec7 → mufgr7ueu89z   /sleep 提案 → 方案定稿
mufgr7ueu89z → mufgwrpjhow0   /sleep 定稿 → 触发机制终版          ★活跃端
mufifo1x492w → mur3mprl1hvd   /sleep 蓝图 → 已落地
mugx9rdbxb3w → mugxek24n0lt   compaction 立场 → 第二版
mugxek24n0lt → mugxjbgl7pe6   第二版 → 第三版
mugxjbgl7pe6 → muh38gzq5uri   第三版 → 第四版                    ★活跃端
mugxz6ublzx1 → muh056at9ap5   决策图 demo v1 → v2
```
★ = 两端有一端在主题活跃集内（共 4 条）；其余链的中间/旧端已退役，活跃集不可达。
updates 链覆盖主题事实 **8/17**，其余 9 条只能靠共现 + 读文本。

**B2. 主题内 conflicts（2 对，均为误报）**

```
mueva8hyk2rz ↔ mufb0zem1tca   机器理由：同实体 Krystal Bot 上出现相反断言
mueva8hyk2rz ↔ mufc1oyke19f   机器理由：同实体 Krystal Bot 上出现相反断言
```

**B3. 主题内 hub 实体挂载数**

```
Krystal Bot 17/17 ｜ agent-spec 10 ｜ memory.ts 6 ｜ facts.jsonl 4 ｜ pi-coding-agent 4
```