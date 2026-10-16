# 任务：Typed link 主路径接线补丁（P0）

> 上游：`docs/memory-typed-links.md` / `memory-typed-links-result.md`  
> 核查：第 2 步库层 PASS，但 **bot 工具未把 `links` 传入 `addFact` / `supersedeFact`**。  
> 原则不变：薄 harness · 可选边 · 不静默抽取 · 不复杂化 · 默认不动真实 `~/.krystal`。

## 1. 问题（已复现）

| 层 | 状态 |
|----|------|
| `src/memory.ts` | typed link 原语可用（校验、渲染、图分区、测试第 14 组） |
| `src/bot.ts` 工具 schema | 已声明 `links` |
| `src/bot.ts` `executeTool` | **未传 `args.links`** → agent 经 memory 工具写边时 **静默丢弃** |

隔离现象：

- `executeTool(remember, { …, links:[{rel,to}] })` → 事实写入成功，`links === undefined`
- 同参数直调 `addFact({…, links})` → 边存在

第 14 组测的是 `M.addFact`，**盖不住本洞**。

另两个小洞（本任务一并修）：

1. **`links: []` 清不了边** —— dup 分支用 `input.links?.length` 才 patch，空数组不触发替换，与「显式声明可删边」不符。
2. **`validateLinks(selfId)` 未从 `addFact` 传入** —— 同文补边时可能写出自环（`to === 本条 id`）。

报告提交号写 `05d3ee6`，核查时 HEAD 为 `d9f8706` —— 以当前 HEAD 为准，结果报告更新哈希。

## 2. 目标

1. `remember` / `supersede` 经 `executeTool` 写入时，**原样传递**合法 `links`（含空数组语义，见下）。
2. `links: []` 在 dup / 更新路径上表示 **清空出边**（显式）。
3. 补边 / 更新时用当前事实 id 做自环拒绝。
4. 测试必须覆盖 **bot 工具路径**，不能只测 `addFact`。
5. 真实库默认零写入；fixture / 隔离 HOME 验收。

## 3. 非目标

- 不改词表、不加 `prevents`、不加 `op:"link"`（除非接线必须）
- 不做真实库补边实验
- 不改 conflicts / hub / sleep
- 不改 `MEMORY.md` 镜像格式

## 4. 改动指引

### 4.1 `src/bot.ts`（P0）

在 `executeTool` 的 remember / supersede 分支：

```ts
// 伪代码：把工具 args.links 传入库层
addFact({ text, entities, evidence, by: "bot", links: args.links })
supersedeFact(id, { text, entities, by: "bot", links: args.links })
```

注意：

- `args.links === undefined` → 不传或传 `undefined`（dup 时**不动**旧边）
- `args.links` 为数组（含 `[]`）→ 传入，由库层解释为替换/清空
- 非法 rel 等错误应回到工具错误信息（库层已抛，勿吞掉）

### 4.2 `src/memory.ts`（两处小修）

**清空语义**

- dup / patch：用「字段是否出现」而非 `links?.length`
  - 未传 `links` → 保留原边
  - 传 `links: []` → 清空
  - 传非空 → 校验后替换

**自环**

- `addFact` / 更新路径调用 `validateLinks(..., selfId)`  
  - 新建：若尚无 id，可先分配 id 再校验，或校验时允许「to ≠ 即将写入的 id」在写入后二次检查；推荐：**先生成 id，再 validate，再 append**（若当前流程允许）

### 4.3 测试（必须）

在 `scripts/memory-tests.ts` 或 bot 级测试中新增：

1. 经 **与 executeTool 相同的入参拼装**（或直接调 `executeTool`）带 `links` → 读回有边  
2. `links: []` → 出边被清空  
3. `to === self` → 拒绝  
4. 不传 `links` 的 dup remember → 旧边仍在  

回归：第 14 组仍绿；全套 `test:memory` + smoke。

## 5. 验收清单

- [ ] agent 工具路径 remember 带 links → `loadFacts` / `renderFacts` 可见 `→rel:id`
- [ ] supersede 带 links → 新条有边（未带则仍继承，与现逻辑一致）
- [ ] `links: []` 清空成功
- [ ] 自环拒绝，错误信息可读
- [ ] 真实 `facts.jsonl` mtime 未变（默认）
- [ ] 结果写入 `docs/memory-typed-links-wire-fix-result.md`（含最终 commit 哈希）
- [ ] 若修正上游 result 文档中的过期 commit 号，在结果里注明

## 6. 一句话指令

> 修好 `bot.ts` `executeTool` 把 `args.links` 传入 `addFact`/`supersedeFact`；同时修正空数组清边与自环校验；用工具路径测试盖住回归；默认不写真实记忆库。

## 7. 相关文档

- `docs/memory-typed-links.md`
- `docs/memory-typed-links-result.md`
- `docs/memory-expose-supersede-result.md`
- `docs/memory-cognitive-structure-test-result.md`
