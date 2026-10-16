# 任务实施报告：让 supersede「立场」对产品可见

> 任务书：[`docs/memory-expose-supersede.md`](./memory-expose-supersede.md)
> 上游评测：[`docs/memory-cognitive-structure-test-result.md`](./memory-cognitive-structure-test-result.md)（§3.1、§6 观察 1）
> 实施者：助手（AI）｜实施日期：2026-10-16
> 提交：`08ce0c1`（本地，未推 `main`）
> 开工前备份（**已推 GitHub**）：分支 `backup/20261016-expose-supersede` · tag `backup-20261016-before-expose-supersede`，均指向 `8cb5a73`（含此前 6 个提交）

## 0. 约束遵守

| 约束 | 状态 |
|---|---|
| 不改已有记忆内容 | ✓ 全程未调用 `addFact / supersedeFact / adjustTrust / markUsed / sleepMemories / importMirror`；验收前后 `~/.krystal/facts.jsonl` mtime 未变（`10-15 14:20`） |
| 不新增 edge 表 / 向量库 / 策展模型 / 新 op | ✓ 只动渲染层；`facts.jsonl` 事件 schema 未变（无新 `t` 类型） |
| 不自动 supersede 历史双活跃冲突 | ✓ 未写盘合并 |
| 现有测试不红 | ✓ 五套件 + smoke 全绿 |
| 尽量小改 | ✓ `+84 / −5` 行，跨 3 文件 |

---

## 1. 开工前提出的 3 点（及处理）

| # | 发现 | 处理 |
|---|---|---|
| ① | **`conflicts` 不走 `renderFacts`** —— 任务书步骤 4 假设「五查询都走同一渲染函数」，实际只有 4 个走（`recall/about/related/connect`），`conflicts` 在 `bot.ts` 里自己拼字符串 | 在 `bot.ts` 的 conflicts 分支同样附加标记，否则「暴露」会漏掉一个查询 |
| ② | **`MEMORY.md` 建议不动** —— 理由不是「人读面膨胀」，而是镜像**双向**：`importMirror` 用 `/^-\s*\[([\w-]+)\]\s*(.+?)\s*(?:\([^)]*\))?$/` 解析，`(.+?)` 惰性，在**括号外**追加注记会被当作**新正文** → 下次启动（md 比 jsonl 新时）静默追加一条 `fact_update` **改写事实正文** | 按任务书 4.D「可不改」走；代码注释写明「若日后要加，只能加在行尾括号内」（`[^)]*` 容得下） |
| ③ | **双活跃无链**（`PIN_LIMIT` vs「已删注入通道」）**不会被本次修好** —— 没有 supersede 就没有箭头 | 记为已知残留（任务书 §4.3 已同意），未扩范围、未偷偷写盘合并 |

---

## 2. 改动清单

| 文件 | 改动 | 行数 |
|---|---|---|
| `src/memory.ts` | 新增 `replaceIndex()`（读侧反查索引）+ `supersedeTag()`（双向标记）；`renderFacts` 追加之；`renderGraph` 文案修正 + 链头 `←K` | +50 / −3 |
| `src/bot.ts` | `conflicts` 分支附加同一标记 | +9 / −2 |
| `scripts/memory-tests.ts` | 新增第 13 组只读渲染断言 | +30 |

### 2.1 关键实现

```ts
// 读侧反查索引：newId → 被它接替的旧 id[]（由 supersededBy 反查）
// 真源不变（仍是 append-only facts.jsonl + supersededBy）；与 loadFacts 共用 mtime:size 签名缓存，零落盘物
let replaceCache: { key: string; map: Map<string, string[]> } | undefined;
function replaceIndex(): Map<string, string[]> { /* ... */ }

// 双向标记，只给 id，不展开旧正文（避免撑窗口）
export function supersedeTag(f: Fact, limit = 4): string {
  //   · supersededBy:<新id>                          本条已被取代
  //   · replaces:<旧id,…>（超 4 条折成 +N）            本条接替了谁 → agent 由此推断「谁更新了谁」
}
```

### 2.2 设计取舍（记录理由）

| 取舍 | 理由 |
|---|---|
| 索引放在**渲染层**，不进 `Fact` | 不泄漏「视图字段」进数据模型；`Fact` 仍是存储形状 |
| 索引复用 `loadFacts` 的 `mtime:size` 签名 | append-only 文件的任何写入都会同时改 mtime 与 size → 签名必变，无需手动失效；也避免新增缓存物 |
| 标记**只给 id**，不给旧正文 | 任务书 §8 风险第 1 条：防上下文膨胀。实测每处约 **21 字符** |
| `replaces` 上限 4 条 + `+N` | 一个链头理论上可接替多条（模型合并时），给个上界让 token 成本可预期 |
| `renderGraph` 用 `←K` 而不是画边 | 任务书要求「仍不画复杂边 UI」；`←K` 三个字符就能让人看出该条接替了几条 |

---

## 3. 接口行为矩阵（改前 → 改后）

| 接口 | 改前 | 改后 |
|---|---|---|
| `recall / about / related / connect` | 无任何取代信息 | 链头带 `replaces:<旧id>`；已取代条仍不返回（`activeFacts()` 过滤不变） |
| `conflicts` | 无任何取代信息 | A/B 两行各自附加同一标记 |
| `renderFacts`（模型看到的行） | `[id] text [entities] · trust · by` | 同上 + ` · replaces:…` / ` · supersededBy:…` |
| `remember` 的「相关旧知」回显 | 无取代信息 | 随 `renderFacts` 一并带上 → 有助于模型判断**该 supersede 谁** |
| `/memory` 图头 | `N 条被取代（不注入，**可检索**）` ← **与实现不符** | `N 条被取代（保留可审计；五查询默认取不回，真源在 facts.jsonl）` + `N 条接替了旧条（标 ←K，取代链在真源里）` |
| `/memory` 事实行 | 无 | 链头行尾标 ` · ←K` |
| `MEMORY.md` 镜像 | 仅活跃条 | **有意未改**（见 §1 ②） |
| `supersedeTag()` | —（不存在） | 双向、只给 id、上限 4 |

### 3.1 前后输出对比（真实库数据）

```diff
- [mufgwrpjhow0] /sleep 触发机制定稿（2026-09-24 owner 终版，…）… · trust 0.60 · by bot
+ [mufgwrpjhow0] /sleep 触发机制定稿（2026-09-24 owner 终版，…）… · trust 0.60 · by bot · replaces:mufgr7ueu89z
```

**中间节点**（链条中段，两个方向同时给出）— `mugxjbgl7pe6`（第二版 → 第三版 → 第四版 的中段）：

```
[mugxjbgl7pe6] owner 的 compaction 决策图设计（第三版…）… · by bot · supersededBy:muh38gzq5uri · replaces:mugxek24n0lt
```

**`/memory` 图头（新）**：

```
记忆图：65 条事实 · 130 个实体 · 296 条关联 · 22 条被取代（保留可审计；五查询默认取不回，真源在 facts.jsonl） · 13 条接替了旧条（标 ←K，取代链在真源里） · 8 处矛盾
```

> 注：`带 ←K 的图行数 59` ≠ `链头数 13` —— 因为图按**实体**分组，一条事实会按它的每个实体各列一次。两个数字都对。

---

## 4. 验收（任务书 §7 三条链 · 真实库只读）

```
✓ /sleep 定稿 → 终版          链头 [mufgwrpjhow0] 已标 replaces:mufgr7ueu89z
✓ 拍板 → 已落地              链头 [mufdl9y5e96y] 已标 replaces:mufd5izxg0gh
✓ compaction 三版 → 四版      链头 [muh38gzq5uri] 已标 replaces:mugxjbgl7pe6
```

**成本实测**：每处标记约 **21 字符**（只给 id）；典型 6 条召回通常 0–1 处带标记。

**只读证明**：验收前后 `~/.krystal/facts.jsonl` mtime 未变（`10-15 14:20`），字节数未变（94,867）。

---

## 5. 测试

| 套件 | 结果 |
|---|---|
| `npm run test:memory` | **ALL MEMORY TESTS PASS**（含新增第 13 组） |
| `npm run test:render` | 5 组 ✓ |
| `npm run test:commands` | 7 组 ✓ |
| `npm run test:divert` | 6 组 ✓ |
| `npm run test:login` | 5 组 ✓ |
| `npm run smoke` | SMOKE OK |

### 5.1 新增第 13 组断言（只读渲染）

```
13) 取代立场暴露（replaces · supersededBy · 文案诚实 · ←K）✓
```

1. 链头渲染含 `replaces:<旧id>`
2. 已取代条渲染含 `supersededBy:<新id>`
3. `recall` / `about` **确认不返回**已取代条 → 这是「取不回」文案的事实依据
4. `/memory` 图头**不得**再出现「可检索」，且须含「五查询默认取不回」
5. 链头在图里标 `←1`
6. `supersedeTag` 双向正确，且**不携带旧正文**（防止未来有人图省事把旧文本塞进标记）

---

## 6. 未做 / 已知残留

| 项 | 说明 |
|---|---|
| 双活跃无链仍不可见 | `PIN_LIMIT` vs「已删注入通道」两条都活跃、中间无 supersede → **没有箭头可暴露**。只能靠写入纪律或日后 sleep 结构整理（任务书 §4.3 记为残留） |
| 已取代条**正文**仍取不回 | 本任务只暴露 **id**；要读旧正文仍须直读 `facts.jsonl`。若日后需要，应作为显式开关（任务书 §4.2 B 提到的 `includeSupersededText`），默认仍为 `false` |
| `conflicts` 假阳性未处理 | 评测中 2/2 误报，属独立问题（建议方向：排除「同一事实自述内的正负词反转」） |
| hub 实体制约未处理 | 主题子图密度 100% 的问题属第 2 步（typed link）前置 |
| `MEMORY.md` 未改 | 见 §1 ② |
| 未推 `main` | 本次改动仅在本地 `08ce0c1`；备份分支/标签已在 GitHub |

---

## 7. 与评测报告的关系（这次修掉了什么）

评测报告 §3.1 的四行「看不见」矩阵：

| 接口 | 评测时 | 现在 |
|---|---|---|
| 五查询 | ✗ 不返回已取代条 | 仍不返回（保持活跃集为主），**但链头带上 `replaces`** → agent 能推断「谁更新了谁」 |
| `renderFacts` | ✗ 无 `supersededBy` | ✓ 双向标记 |
| `/memory` | ✗ 只有计数 + 不实文案 | ✓ 诚实文案 + `←K` |
| `MEMORY.md` | ✗ 只写活跃条 | 未改（有意，附具体机制风险） |

即：评测里的核心缺口「**唯一带类型的结构不可通过产品接口读取**」已消除（现可由 agent 经读 op 得到替代链的**方向**）；
仍未消除的是「**替代链上的旧正文**」与「**双活跃无链**」两项。

---

## 8. 如何复现验证

```bash
cd "/Users/niuqingwei/Desktop/zebra tui"

# 1) 全套测试（含第 13 组取代暴露断言）
npm run test:memory && npm run test:render && npm run test:commands && npm run test:divert && npm run test:login && npm run smoke

# 2) 真实库只读验收（不写盘）：查链头是否带 replaces
#    期望：mufgwrpjhow0 → replaces:mufgr7ueu89z 等三条链均命中
node --experimental-strip-types --no-warnings -e '
import { about, renderFacts } from "./src/memory.ts";
for (const l of renderFacts(about("Krystal Bot", 50)).split("\n")) if (/replaces:/.test(l)) console.log(l.slice(0, 80) + " … " + l.match(/replaces:\S*/)[0]);
'

# 3) 只读证明：跑完 mtime 不应变化
ls -l ~/.krystal/facts.jsonl
```

## 9. 相关文档

- 任务书：`docs/memory-expose-supersede.md`
- 上游评测：`docs/memory-cognitive-structure-test-result.md`
- 测试协议：`docs/memory-cognitive-structure-test.md`
- 设计圣经：`docs/agent-spec.md`（压缩=搬迁 · 纯检索架构）