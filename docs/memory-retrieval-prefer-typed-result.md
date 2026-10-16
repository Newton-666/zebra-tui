# 任务实施报告：提取偏向结构（最轻）

> 票：[`docs/memory-retrieval-prefer-typed.md`](./memory-retrieval-prefer-typed.md)
> 上游：`docs/memory-typed-links.md` / `-result.md`、`docs/memory-typed-links-wire-fix.md` / `-result.md`
> 实施者：助手（AI）｜实施日期：2026-10-16
> 代码提交：**`f80d14f`**（本地，未推 `main`）
> 开工前备份（**已推 GitHub**）：分支 `backup/20261016-retrieval-prefer-typed` · tag `backup-20261016-before-prefer-typed`（= `306f95b`）

---

## 0. 约束遵守

| 约束 | 状态 |
|---|---|
| 不改词表 / 不加 `prevents` / 不加新 op | ✓ 无概念变化 |
| 不补真实库边 / 不跑 sleep / 不上向量 | ✓ 真实库**零写入**（`facts.jsonl` mtime 全程 `10-15 14:20`，typed 边仍 0） |
| 改动尽量只在 `memory.ts` + 测试 | ✓ 只动 `src/memory.ts` + `scripts/memory-tests.ts`（**未动** `bot.ts`、**未动** `agent-spec.md`） |
| 测试与回归绿 | ✓ 16 组 ALL PASS + 四套件 + smoke |

---

## 1. 改动清单

| 文件 | 改动 |
|---|---|
| `src/memory.ts` | 新增读侧 `linkIndex()`（`out` / `in` / `structured`，与 `loadFacts` 共用 `mtime:size` 签名缓存）· `preferStructured()` 稳定排序键 · `Fact.via`（仅读路径视图标记）· 重写 `related()` · `about()` / `connect()` 加偏结构排序 · `recall()` 加持平偏向 · `renderFacts` 输出 `via` |
| `scripts/memory-tests.ts` | 新增第 16 组（5 项断言） |

**未改**：词表、工具 schema、`bot.ts`、`facts.jsonl` schema、`MEMORY.md` 格式、`renderGraph` 分区（上一票已完成）。

---

## 2. 四项最小改动怎么落的

| 票的要求 | 落地 |
|---|---|
| ① `about` / `related` / `connect`（及 `recall` 若易接）：命中后把 **typed 邻居排在共现邻居前**；结果标 `→rel:id` | `related()` 重写为「**先 typed 后共现**」；`about`/`connect` 加稳定排序「有边者优先」；`recall` 加**仅持平**偏向；标记见 §2.1 |
| ② 无 typed 边时行为与现在一致 | 排序键为 0/1 且 `structured` 为空 ⇒ 排序是 **no-op**；实测见 §4 |
| ③ 测试：有边时箭头对端先返回；无边回归绿 | 第 16 组（§5.1） |
| ④ 结果报告；真实库零写入 | 本文件；§0 证明 |

### 2.1 `related()` 的 typed 邻居与标记方向（本票唯一的设计取舍）

typed 邻居有两个方向，标记策略**有意不对称**：

| 方向 | 例子 | 怎么标 | 为什么不两边都标 |
|---|---|---|---|
| base **出边** → 邻居 | `anchor --causes--> target` | 给邻居挂 `via = ←causes:anchor`（**需要新标记**） | 邻居自己的 `linkTag` 只显示出边，这条边对它而言是**入边**，原本看不见 |
| 邻居 **出边** → base（对 base 是入边） | `inbound --depends_on--> anchor` | **不加 via** —— `inbound` 自己的 `linkTag` 已经写了 `→depends_on:anchor` | 加了就是**同一件事打两遍**（`→depends_on:anchor` + `←…`） |

`via` 的定义写死为：**仅读路径的视图标记，任何写路径都不会整对象回写**（`addFact` 新建对象、`importMirror` 新建对象、`markUsed`/`adjustTrust`/`applyOps` 只按 id 打 patch），因此不会落盘污染真源。

### 2.2 `recall` 只做「持平偏向」，**不做图扩展**

`recall` 的主排序是关键词得分（`score × (0.5+trust)`）——它是召回精度的来源。本票只加了**第三级**排序键：

```
score desc  →  参与 typed 边者优先  →  created desc
```

即**只在得分完全相同时**偏向结构。**没有**沿箭头做结果扩展，理由：扩展会把与查询词无关的事实塞进前 6 条，直接稀释精度；票里该项也写作「若易接」。若日后要扩展，建议单独开票并用 `recall-eval` 做前后对比（红线④）。

---

## 3. 边界与口径（已写进代码注释）

1. **只返回活跃条**：指向已退役条的边**不展开**（`related` 的 `byId` 取自 `activeFacts`）。查询口径保持活跃集不变；历史仍从头条的 `replaces:` 看（上一票）。
2. **`structured` 集合包含退役目标**：一条活跃边指向退役条时，退役条也算"参与结构"，但它不会被返回。
3. **排序稳定**：JS `sort` 自 ES2019 起稳定 ⇒ 组内保持 `loadFacts` 的创建序，无边时与改前逐项一致。

---

## 4. 无边不变性验证（真实库实测）

真实库目前 `typed = 0`，所以**本票在真实数据上看不出任何差别**——这正是必须验证的点：

```
about("Krystal Bot", 50) 返回顺序 == 创建序（排序 no-op）: ✓
related("Krystal Bot", 50) 返回顺序 == 创建序:            ✓
真实库 typed 边: 0
~/.krystal/facts.jsonl: 94867 字节 · mtime 10-15 14:20（未变）
```

---

## 5. 测试

### 5.1 新增第 16 组（5 项）

```
16) 提取偏向结构（typed 邻居优先 · via 标记 · about 偏结构 · recall 持平偏向 · 无边回归）✓
```

1. **typed 邻居优先**：出边方向（`anchor→target`）与入边方向（`inbound→anchor`）的邻居，都排在共现邻居之前
2. **via 标记方向正确**：出边邻居含 `←causes:<anchor>`；入边邻居含自己的 `→depends_on:<anchor>` 且**不含** `←…`（不重复）；普通无 via 事实不得凭空多出
3. **`about` 偏结构**：同一实体下"有 typed 边"的事实排在无边事实之前
4. **`recall` 持平偏向**：两条得分相同的事实在同一查询里，跟 typed 边的那条排第一
5. **无边回归**：无边实体上 `about` 严格保持创建序；`related` 仍靠共现兜底找回邻居

### 5.2 全套

| 套件 | 结果 |
|---|---|
| `npm run test:memory` | **ALL MEMORY TESTS PASS**（16 组） |
| `test:render` / `test:commands` / `test:divert` / `test:login` | 5 / 7 / 6 / 5 组 ✓ |
| `npm run smoke` | SMOKE OK |

---

## 6. 未做 / 残留

| 项 | 说明 |
|---|---|
| **真实库仍看不出差别** | 无 typed 边 ⇒ 偏向无处可偏。机制已就位；要观察效果需真实使用积累边，或另开**补边实验**（需 owner 显式同意） |
| `recall` 图扩展 | 有意不做（§2.2）；需要时另开票 + `recall-eval` 前后对比 |
| 入边读 op（"谁指向我"整表） | 本票只覆盖了 `related` 场景；独立只读 op 仍缺（前票已记为第二迭代） |
| `bot.ts` 文案 | 未改（工具描述里的 links 说明已足够；本票无需新增词汇） |
| `agent-spec.md` | 未改（票要求「尽量只在 memory.ts + 测试」；§11.3 已写明"共现是兜底"，本票只是把该原则落到读路径） |
| 未推 `main` | 备份分支/标签已在 GitHub |

---

## 7. 复现

```bash
cd "/Users/niuqingwei/Desktop/zebra tui"

# 1) 全套（第 16 组 = 提取偏向结构）
npm run test:memory && npm run test:render && npm run test:commands && npm run test:divert && npm run test:login && npm run smoke

# 2) 无边不变性（真实库只读：返回顺序应等于创建序）
node --experimental-strip-types --no-warnings -e '
import { loadFacts, activeFacts, about, related } from "./src/memory.ts";
const order = activeFacts(loadFacts()).filter((f) => !f.scope).map((f) => f.id);
const ok = (ids) => ids.every((id, i) => i === 0 || order.indexOf(ids[i-1]) < order.indexOf(id));
console.log("about 保持创建序:", ok(about("Krystal Bot", 50).map((f) => f.id)));
console.log("related 保持创建序:", ok(related("Krystal Bot", 50).map((f) => f.id)));
'
ls -l ~/.krystal/facts.jsonl   # mtime 应保持 10-15 14:20
```

## 8. 相关文档

- 票：`docs/memory-retrieval-prefer-typed.md`
- 路线图：`docs/memory-cognition-roadmap.md`（本票 = 阶段 3 第 1 条）
- 上游链：`docs/memory-typed-links.md` / `-result.md` → `docs/memory-typed-links-wire-fix.md` / `-result.md`
- 评测协议与基线：`docs/memory-cognitive-structure-test.md` / `-result.md`
- 设计圣经：`docs/agent-spec.md`（§11.3 边 = 可选 typed link + 共现兜底）

---

## 9. 与路线图的对应（`docs/memory-cognition-roadmap.md`）

本票 = **阶段 3 的第 1 条**：「召回默认优先 typed 邻域，共现降为兜底」✓

| 阶段 3 条目 | 状态 |
|---|---|
| 召回默认优先 typed 邻域，共现降为兜底 | ✓ **本票完成**（`related` 先箭头后共现；`about`/`connect` 有边者优先；`recall` 持平偏向） |
| 链头 / 出边摘要在工具结果里可扫 | ✓ 已具备：`replaces:` / `supersededBy:`（阶段 1）+ `→rel:id`（阶段 2） |
| （可选）**入边**摘要在工具结果里可扫 | **部分**：`related` 返回的入边邻居已可读（靠 `via` / 其自身 `linkTag`）；**独立「谁指向我」读 op 仍缺**（列为可选，未做） |
| 双活跃无箭头：靠模型 `updates` / supersede，**不自动瞎合并** | ✓ 未添加任何自动合并逻辑 |
| **门禁**：关键主题能回答「谁更新了谁 / 什么导致什么 / 依赖谁」且主要走边 | **待数据**：真实库 typed 边仍 0 条 |

> 阶段 2 的门禁（「真实使用中边开始出现」）也未达成。两张票都只让**机制**就位；
> 路线图 §5 行动序第 1 条（让 solo bot 在真实任务里开始写 `links`）是**能力之外的动作**，
> 若要做需 owner 明确同意（补边实验），否则就是日常使用自然积累。