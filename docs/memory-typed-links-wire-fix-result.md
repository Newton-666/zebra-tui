# 任务实施报告：Typed link 主路径接线补丁（P0）

> 任务书：[`docs/memory-typed-links-wire-fix.md`](./memory-typed-links-wire-fix.md)
> 上游：[`docs/memory-typed-links.md`](./memory-typed-links.md) / [`-result.md`](./memory-typed-links-result.md)
> 实施者：助手（AI）｜实施日期：2026-10-16
> 代码提交：**`01386ee`**（本地，未推 `main`）
> 开工前备份（**已推 GitHub**）：分支 `backup/20261016-typed-links-wire-fix` · tag `backup-20261016-before-wire-fix`（= `d9f8706`）

---

## 1. 审计结论：属实，三处全部复现

这是我上一轮交付的真实缺陷。**库层做对了、工具层没接线**，而我的第 14 组只直调 `M.addFact`，**测试层次盖不住接线层**。

| # | 现象 | 复现（隔离 HOME） | 现状 |
|---|---|---|---|
| ① | **P0**：`executeTool(remember, {…, links})` → 事实写入成功但 `links === undefined` | 工具返回「已记住 [mvafq4r2jbp4] wire 复现：源事实」，`links = undefined` | ✓ 已修 |
| ② | `links: []` 清不掉边（dup 分支用 `input.links?.length` 判断） | 传 `[]` 后 `links.length === 1` | ✓ 已修 |
| ③ | `validateLinks` 未传 `selfId` → 同文补边可写出自环 | 未覆盖，代码路径确认（`validateLinks(input.links)` 无第二参） | ✓ 已修 |

修后同一脚本：① `links = [{"rel":"causes","to":"…"}]` ② 与直调库层结果一致 ③ `[] → 已清空`。

---

## 2. 改动清单

| 文件 | 改动 |
|---|---|
| `src/bot.ts` | 新增 `linksArg()`：**三种情况必须分清**（见下表）；`remember` / `supersede` 均把 `links` 传入库层；`supersede` 回执增加「（带 N 条边）」以便确认边真的落了 |
| `src/memory.ts` | `addFact` 改按「**字段是否出现**」决定是否 patch `links`（`[]` = 显式清空）；自环校验传入 `dup?.id` |
| `scripts/memory-tests.ts` | 新增**第 15 组：工具路径** 7 项断言 |
| `docs/agent-spec.md` | §11.3 补两点：`[]` = 显式清空（与不传字段是两件事）；「工具声明了字段却没往库层传 = 静默丢边」的教训 |

### 2.1 `linksArg()` 的三分法（本补丁的核心）

| `args.links` | 语义 | 为什么不能混 |
|---|---|---|
| **字段缺失**（`undefined`/`null`） | → `undefined`：dup / 更新时**不动**旧边 | 与「清空」语义相反，混了会**静默清边** |
| **数组**（含 `[]`） | → 原样传库层：`[]` = **显式清空**，非空 = 校验后替换 | — |
| **其它类型**（字符串/对象/数字…） | → **明确报错**「links 需为数组 [{rel,to}]（清空请传 []）」 | 若按 `arr()` 的老习惯静默强转 `[]`，等于把模型的格式错误变成**清空出边** |

> 保留 `entities` 的旧行为（非数组 → 空数组）不动：那里「丢弃」是安全的；而 `links` 的「丢弃」会**删数据**，所以必须报错。

---

## 3. 任务书 §5 验收清单

| 验收项 | 结果 |
|---|---|
| agent 工具路径 remember 带 links → `loadFacts` / `renderFacts` 可见 `→rel:id` | ✓ 第 15 组① |
| supersede 带 links → 新条有边（未带则仍继承，与现逻辑一致） | ✓ 第 15 组⑦（两条路径都测） |
| `links: []` 清空成功 | ✓ 第 15 组② |
| 自环拒绝，错误信息可读 | ✓ 第 15 组④（`rel=causes 的 to 指向自己（自环不允许）`） |
| 真实 `facts.jsonl` mtime 未变（默认） | ✓ 全程 `10-15 14:20`（字节数 94,867 未变） |
| 结果写入 `docs/memory-typed-links-wire-fix-result.md`（含最终 commit 哈希） | ✓ 本文件（代码提交 `01386ee`） |
| 若修正上游 result 文档中的过期 commit 号，在结果里注明 | ✓ 已把 `memory-typed-links-result.md` 的 `05d3ee6` 改为 `d9f8706`（**注明**：那是 amend 前的哈希；本补丁的报告改为两段式提交——先提交代码、再提交含哈希的文档，避免哈希自指再次过期） |

---

## 4. 测试

### 4.1 新增第 15 组（工具路径，7 项）

```
15) 工具接线（links 传递 · 清空 · dup 不动边 · 自环拒 · 错误可见 · supersede 带/继承）✓
```

1. 经 `executeTool` 写边 → `links.length === 1` 且可渲染 `→depends_on:<id>`
2. `links: []` → 清空（`length === 0`）
3. 不传 `links` 的 dup remember → **旧边仍在**
4. 自环（`to` = 本条 id）→ 拒绝，错误含「自环」
5. 库层抛错回到工具层：非法 rel / 悬空 `to` 各自出现在工具错误文本里（**不吞**）
6. 非数组 `links` → 明确报错，且**不写库**（断言该文本的事实数为 0）
7. supersede：显式 links 原样落到新条（`deepEqual`）；未带则继承旧条出边；回执提示「带 N 条边」

### 4.2 全套回归

| 套件 | 结果 |
|---|---|
| `npm run test:memory` | **ALL MEMORY TESTS PASS**（15 组） |
| `npm run test:render` / `test:commands` / `test:divert` / `test:login` | 5 / 7 / 6 / 5 组 ✓ |
| `npm run smoke` | SMOKE OK |
| P0 复现脚本（`/tmp/repro-wire.mjs`） | 三处全部转 ✓ |

---

## 5. 教训（防再犯）

1. **「测试层次」要和「交付层次」对齐**：库层测试再全，也盖不住「上层没把参数传下来」。
   规矩：**凡新增一个可写字段，必须有一条经真实入口（`executeTool`）的往返断言**——已由第 15 组固化。
2. **「没传」与「传空」必须分开表达**：可写字段的 patch 判断一律看**字段是否出现**，不看值的长度/真值。
   `links` 已按此改；将来新增任何数组型字段都沿用。
3. **类型错误不能静默降级**：`entities` 非数组 → 丢弃是安全的；`links` 非数组 → 丢弃会**删数据**。
   同一个工具里两种字段两种策略，是本补丁唯一需要「不对称」的地方，已在代码注释里写明理由。

---

## 6. 残留 / 未做（均符合任务书 §3 非目标）

| 项 | 说明 |
|---|---|
| 词表未变 | 未加 `prevents`（仍待 owner 定）；未加 `op:"link"` |
| 真实库未补边 | `typed=0`、带 links 事实 0 条；补边实验需 owner 显式同意 |
| 入边（谁指向我）仍无读 op | 任务书 §4.4 列为第二迭代 |
| `conflicts` / hub 稀释 / sleep | 未动 |
| `MEMORY.md` 格式 | 未动（防 `importMirror` 回灌） |
| 未推 `main` | 备份分支/标签已在 GitHub |

---

## 7. 复现

```bash
cd "/Users/niuqingwei/Desktop/zebra tui"

# 1) 全套（第 14 组=库层、第 15 组=工具接线）
npm run test:memory && npm run test:render && npm run test:commands && npm run test:divert && npm run test:login && npm run smoke

# 2) 三处原现象（隔离 HOME，不碰真实库）
node --experimental-strip-types --no-warnings -e '
// 见 /tmp/repro-wire.mjs：① 工具路径写边 ② 直调对照 ③ links:[] 清空
'

# 3) 只读证明
ls -l ~/.krystal/facts.jsonl    # mtime 应保持 10-15 14:20
```

## 8. 相关文档

- 任务书：`docs/memory-typed-links-wire-fix.md`
- 上游：`docs/memory-typed-links.md` / `-result.md`（哈希已更正为 `d9f8706`）
- 更上游：`docs/memory-expose-supersede.md` / `-result.md`、`docs/memory-cognitive-structure-test.md` / `-result.md`
- 设计圣经：`docs/agent-spec.md`（§11.3）