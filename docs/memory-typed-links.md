# 任务：Memory 可选 typed link（从标签共现走向认知结构）

> 对应讨论第 2 步：**写入时让模型标关系，不只标实体**。  
> 上游：第 1 步 `docs/memory-expose-supersede.md`（已落地，见 `memory-expose-supersede-result.md`）。  
> 评测基线：`docs/memory-cognitive-structure-test-result.md`（结论：标签共现图）。

## 0. 原则（硬约束 · 必须成立）

1. **薄 harness**：系统只提供原语，**不**设硬分类器、不静默抽记忆、不强制每条必带关系。
2. **写不写、关联怎么做，交给 AI**：typed link **可选**；模型可以只 `remember` 文本 + entities，与今天行为兼容。
3. **不准复杂化**：不新建子系统、不上向量库、不另起「图谱引擎」、不挂策展模型当依赖。
4. **尽量不破坏已有记忆**：迁移以**向前兼容**为准；旧 `facts.jsonl` 无 link 的条仍合法。
5. **概念极简**：关系类型是一小撮封闭词表（可演进），不是开放 ontology 工程。

## 1. 问题（为什么要这一步）

第 1 步只解决了：**已有 supersede 链能被读到**。

评测仍显示：

- 边的主来源仍是 **实体字符串共现** → 完全图 / hub 噪声
- **因果 / 依赖** 几乎全在 `text` 里，结构读不出
- 双活跃无 supersede 时，仍无箭头

一句话：共现边 ≠ 认知结构。要结构，关系必须被**编码**，不能只靠标签撞车投影出来。

## 2. 目标

1. 模型可在写入（或极薄的关联写法）时声明：`from --rel--> to`
2. 读路径能返回这些边（至少 id + 类型），而不只返回共现
3. 实体共现**保留**作索引/兜底，但不再是唯一拓扑
4. 与 supersede 并存：`updates` 可由 supersede 推导，也可由显式 link 声明；不互相打架
5. 再跑「认知结构」只读评测时，主题上至少能稳定出现 **2～3 类**结构可读关系（相对评测基线升级），且不靠读 text 脑补

## 3. 非目标

- 不自动从自然语言抽取关系（除非日后另开；本任务禁止静默抽取）
- 不上完整时空知识图谱（时间/空间见 §6，本任务最多预留，不强制落地）
- 不重做 sleep 大策展、不解决 conflicts 假阳性全集
- 不要求历史 60 条事实全部人工补边

## 4. 推荐最小设计

### 4.1 关系词表（起步 · 封闭 · 少）

| rel | 含义 | 备注 |
|-----|------|------|
| `updates` | 新认知接替旧认知 | 可与 supersede 对齐 |
| `contradicts` | 对立断言 | 显式立场；优于词表启发式 |
| `causes` / `leads_to` | 因果（选一个作正式名，另一个作别名或删） | 建议正式名只用 `causes` |
| `depends_on` / `part_of` | 依赖 / 组成（二选一或两个都留，但 ≤5 个正式类型） | 建议：`depends_on` + `part_of` |

**建议落地词表（≤5）**：`updates` · `contradicts` · `causes` · `depends_on` · `part_of`

不做开放字符串关系名（避免同义爆炸）。未知 `rel` → 拒绝并提示合法集合（硬的是**词表边界**，不是「必不必须写」）。

### 4.2 存储（向前兼容）

两条路，选**更薄**的一条（施工时二选一，写进结果报告）：

**方案 A（推荐）——挂在 fact 事件上的出边列表**

```json
{
  "t": "fact",
  "f": {
    "id": "…",
    "text": "…",
    "entities": ["…"],
    "links": [{ "rel": "causes", "to": "otherId" }]
  }
}
```

- 旧条无 `links` ≡ `[]`
- 改边用 `fact_update` patch `links`，或 append 新 fact + supersede（纪律仍交模型）

**方案 B——独立 append 事件（不改 Fact 形状）**

```json
{ "t": "link", "from": "idA", "rel": "causes", "to": "idB", "at": "…" }
```

- 更像真·边表，但多一种 `t`；加载时折叠进邻接表

**约束**：无论 A/B，**不删旧行**；真源仍 append-only。

### 4.3 写入 API（薄）

扩展现有 `memory` 工具即可，**不强制新 op 名称**（若加 `op:"link"` 也必须是可选糖）：

- `remember` 增加可选字段：`links?: { rel, to }[]`（`to` 为已有 fact id）
- 或 `op: "link", from, rel, to` —— 仅写边，不改正文

校验：

- `rel` ∈ 词表
- `to` / `from` 存在（允许指向已 supersede 的 id，便于连历史；渲染时沿用第 1 步标记）
- 不因缺 `links` 而失败

### 4.4 读取 API

- `renderFacts` / 五查询：命中条附带出边摘要，例如 `→ causes:idX · contradicts:idY`
- 可选只读 op 或现有 `related` 增强：按 `rel` 过滤（若实现成本低；否则第二迭代）
- **共现边仍可算**，但文档与 `/memory` 需区分：`关联(共现)` vs `关系(typed)`

### 4.5 与 supersede 的关系

| 机制 | 角色 |
|------|------|
| supersede | 版本搬迁；第 1 步已暴露 `replaces` / `supersededBy` |
| `updates` link | 显式「认知更新」边；若与 supersede 同时存在，读侧可去重显示 |

不要求每次 supersede 自动写 `updates` link（可做，但是糖；默认让模型在 supersede 时可选带上，避免双写政策变硬栅栏）。

## 5. 验收

1. 旧库无 link 时：行为与改前一致，测试不红
2. 写入带 `links` 的 remember（或 link op）后，读路径能看到对应 typed 边
3. 非法 `rel` 被拒；缺 `links` 成功
4. 记忆库若用于验收，**优先用临时 fixture**；动真实 `~/.krystal` 需 owner 显式同意
5. 文档：本任务书 + 结果报告；更新 agent-spec 一小段「边 = 可选 typed link + 共现兜底」（概念仍少）
6. 可选：用评测协议复跑同一主题，报告结构可读类数变化（只读）

## 6. 时间 / 空间（回应讨论 · 本任务不强制）

人脑情节记忆确有时间维、空间/情境维。本任务**承认**但**不展开成硬系统**：

- **时间**：已有 `created` / `updated`；叙述先后可先靠 text；若加边，预留 `before` 一类即可，**本任务可不实现**
- **空间 / 情境**：继续用实体或简短 context 标签；真要 `at`/`during` 边，另开任务

避免一次把「认知结构」做成全时空图谱。

## 7. 涉及文件（预期）

| 文件 | 改动 |
|------|------|
| `src/memory.ts` | 加载 links、校验、渲染、可选 related |
| `src/bot.ts` | 工具 schema / 说明：links 可选、词表、示例 |
| `scripts/memory-tests.ts` | 兼容旧条 + typed link 读写 |
| `docs/agent-spec.md` | 短更新（边的概念） |
| 本文件 + `docs/memory-typed-links-result.md`（施工后） | 任务 / 结果 |

## 8. 实施步骤（给施工 AI）

1. 与 owner 确认词表最终集合（§4.1）与存储方案 A 或 B（§4.2）
2. 实现加载 + 校验 + 渲染（只读路径先通）
3. 扩展 remember / 可选 link op（写入可选）
4. 测试：无 links 回归；有 links 往返；非法 rel
5. 更新 agent-spec 一小段
6. 写结果 md；**默认不改**真实记忆内容除非 owner 同意补边实验

## 9. 风险

- 模型乱连边 → 靠词表小 + 可 supersede/更新 links，不靠硬禁止写入
- hub 仍吵 → typed 边应成为导航主路径；共现降级为兜底（文案上说清）
- 与第 1 步重复 → `updates` 显示去重
- 范围膨胀 → 时空边、自动抽取、sleep 重组**另开**，本任务拒绝夹带

## 10. 一句话指令（可复制）

> 在薄 harness 前提下，为 memory 增加**可选**封闭词表 typed link（写入由模型决定、可不写）；读路径能展示这些边；旧记忆无 link 完全兼容；不建新子系统，不动真实库除非 owner 同意。

## 11. 相关文档

- `docs/memory-expose-supersede.md` / `memory-expose-supersede-result.md`
- `docs/memory-cognitive-structure-test.md` / `memory-cognitive-structure-test-result.md`
- `docs/agent-spec.md`
- `docs/compaction-graph.md`（决策图是另一条「结构」线，勿与本任务混工）
