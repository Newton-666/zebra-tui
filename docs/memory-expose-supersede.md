# 任务：让 supersede「立场」对产品可见

> 对应讨论结论第 1 步：**让已有立场可见**。  
> 原则：薄 harness · 零新概念 · 零新表 · 不改已有记忆内容 · 尽量小改。

## 1. 背景：问题是什么

Krystal 记忆库里**已经有**版本关系：

- `facts.jsonl` 里存在 `{ t: "supersede", id, by, at }` 事件
- 加载后折叠为 Fact 上的 `supersededBy`
- 红线「压缩 = 搬迁，永不删除」依赖这条链

但评测（见 `docs/memory-cognitive-structure-test-result.md`）表明：

| 接口 | 能否看到「这条已被 X 取代」 |
|------|---------------------------|
| `recall` / `about` / `related` / `connect` / `conflicts` | 否 —— 经 `activeFacts()` 过滤，已取代条不返回 |
| `renderFacts`（模型实际看到的工具输出） | 否 —— 不打印 `supersededBy` |
| `/memory` 图视图 `renderGraph` | 否 —— 只有「N 条被取代」计数 |
| `MEMORY.md` 镜像 | 否 —— 只写活跃条 |

结果：

- **磁盘上**有 updates 链（立场结构）
- **agent / 人通过产品**看不见这根箭头
- 更糟：部分「旧认知」与「新认知」**同时仍为活跃**（未 supersede），图上只有实体共现，答不出「当前到底信哪句」
- `renderGraph` 文案写「可检索」与实现不符（已取代条无法被查询取回）

一句话：**立场结构存在，但未暴露；第 1 步只做暴露，不发明新记忆理论。**

## 2. 目标（验收）

做完后，满足全部：

1. 模型通过任一 memory **读** op 拿到的事实行，若该条（或命中上下文）存在取代关系，能看到明确标记，例如：
   - `supersededBy: <newId>`（本条已被取代），或
   - `supersedes: <oldId>` / `replaces: <oldId>`（本条取代了谁）——至少一种方向清晰即可，推荐**双向都能推断**
2. 对「链头（现行活跃条）」召回时，可选带上「本条接替了哪些旧 id」（短列表），避免只能直读 jsonl 才知道历史
3. `/memory` 或等价人读视图：不再声称已取代条「可检索」除非真的可查；计数与文案诚实
4. **不**改 `~/.krystal/facts.jsonl` 里已有事件；**不**强制给历史活跃冲突自动 supersede（那是 sleep / 写入纪律，不是本任务）
5. **不**新增 edge 表、向量库、策展模型、新 op 名称（可扩展现有 render，不扩概念面）
6. 现有 `test:memory` / 相关脚本不因本改动红；若补测，只加「渲染含 supersededBy」类只读断言

## 3. 非目标（本任务不做）

- 不引入 typed link（causes / part-of 等）——那是第 2 步
- 不改 sleep 策展、不自动合并语义重复
- 不解决 hub 实体稀释、conflicts 假阳性（可另开）
- 不重写 MEMORY.md 为完整版本历史浏览器
- 不要求默认把**全部**已取代正文注入上下文（避免撑爆窗口）

## 4. 推荐设计（最小）

### 4.1 核心原则

- **真源不变**：仍是 append-only `facts.jsonl` + `supersededBy` 字段
- **暴露在渲染层**：优先改 `renderFacts` / 查询结果拼装，而不是改存储
- **活跃集仍默认主结果**：继续以 `activeFacts()` 为主召回；额外附带取代元数据，而不是把所有旧正文灌回

### 4.2 建议行为明细

#### A. `renderFacts`（最高优先级）

每条输出增加取代元数据，例如：

```text
[id] text [entities…] · trust · by · supersededBy:newId
```

或现行条：

```text
[id] text … · replaces:oldId1,oldId2
```

`replaces` 可由加载后索引反查（谁的 `supersededBy === 本 id`），**不必改写入格式**。

#### B. 五个读查询

- 返回体仍以活跃命中为主
- 若命中条有 `supersededBy`（理论上活跃集不应大量出现；若出现则必须标出，便于发现「该 supersede 未执行」的脏活跃）
- 若命中为链头，附 `replaces: […]`（id 列表即可；旧正文默认不展开）
- **可选开关**（若要保持极简，可不做开关，固定「只附 id」）：`includeSupersededText: false`

#### C. `renderGraph` / `/memory`

- 修正文案：已取代条「不注入；**默认不可经五查询取回全文**」——与实现一致
- 图头可显示：`活跃 N · 已取代 M`
- 可选：链头节点旁标注 `←K`（接替了 K 条），仍不画复杂边 UI

#### D. `MEMORY.md`

- 本任务**可不改**镜像格式（避免人读面膨胀）
- 若改：仅在活跃条下增加一行 `replaces: id,…`，仍不倾倒旧正文

### 4.3 关于「旧新双活跃」缺口

评测里的 PIN_LIMIT vs 已删注入通道：两者都活跃、中间**没有** supersede。

- **本任务不自动修数据**
- 暴露 `supersededBy` **之后**，模型才有工具看见链；双活跃问题要靠：
  - 写入纪律（remember 时 supersede），或
  - 日后 sleep 结构整理  
  在任务文档里记为**已知残留**，避免范围蔓延

## 5. 涉及文件（预期）

以仓库现状为准，主要动：

| 文件 | 改动 |
|------|------|
| `src/memory.ts` | `renderFacts`；可能小幅辅助：`replacedByIndex` / 查 `replaces`；`renderGraph` 文案；读查询拼装处 |
| `src/bot.ts` | 仅当工具结果说明文字需同步时（软文案）；无新 op |
| `scripts/memory-tests.ts`（可选） | 渲染含取代元数据的断言 |

不改：`facts.jsonl` 事件 schema（无需新 `t` 类型）。

## 6. 实现步骤（给施工 AI）

1. 读 `src/memory.ts`：`loadFacts` / `activeFacts` / `renderFacts` / `renderGraph` / 五查询实现
2. 建内存索引：`id → Fact`，以及 `newId → oldIds[]`（由 `supersededBy` 反查）
3. 改 `renderFacts`：输出 `supersededBy` 与/或 `replaces`
4. 确认五查询都走同一渲染函数（避免只改一处）
5. 改 `renderGraph` 误导文案
6. 跑 `npm run test:memory`（或项目内等价命令）；补 1～2 个渲染用例
7. **只读**抽查：对已知链（见评测附录 B1）验证链头渲染含 `replaces`
8. 交付：简述 diff、示例前后输出、测试结果；**不**改记忆库

## 7. 验收用例（手工）

用评测已列链条（只读）：

```
mufgr7ueu89z → mufgwrpjhow0   /sleep 定稿 → 终版
mufd5izxg0gh → mufdl9y5e96y   拍板 → 已落地
mugxjbgl7pe6 → muh38gzq5uri   compaction 第三版 → 第四版
```

期望：

- 查询命中链头 id 时，输出含对应旧 id（`replaces`）
- 若测试环境故意渲染已取代条，应含 `supersededBy: 新id`
- 不出现「已取代可检索」的虚假文案

## 8. 风险与注意

- **上下文膨胀**：只附 id，不附旧全文，除非日后显式需要
- **双活跃冲突**：本任务暴露后更显眼，属预期；勿在本任务偷偷写盘合并
- **缓存**：若有 mtime:size 结果缓存，改渲染后确认缓存键不会让旧格式残留
- **极简**：不要借机加「关系类型系统」；本任务关键字只有 `supersededBy` / `replaces`

## 9. 一句话指令（可复制）

> 在不改记忆库、不新增概念的前提下，让 memory 读路径与 `renderFacts` 暴露已有 `supersededBy`（及反查 `replaces`），并修正「已取代可检索」文案；使 agent 无需直读 `facts.jsonl` 也能看到谁更新了谁。

## 10. 相关文档

- 协议：`docs/memory-cognitive-structure-test.md`
- 评测：`docs/memory-cognitive-structure-test-result.md`（尤其 §3.1、§6 观察 1）
- 设计圣经：`docs/agent-spec.md`（压缩=搬迁、纯检索）
