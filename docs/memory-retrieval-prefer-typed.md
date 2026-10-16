# 任务：提取偏向结构（最轻）

> 路线图阶段 3 最小切片。原则：薄 harness · 不复杂化 · 默认不改真实记忆内容。

## 目标
召回时：**先跟 typed 箭头，再跟实体共现**。`/memory` 已能画箭头；本票让读路径也偏向箭头。

## 非目标
- 不改词表、不补真实库边、不动 sleep、不加向量、不加新 op（除非一行糖）

## 最小改动
1. `about` / `related` / `connect`（及 `recall` 若易接）：命中后，把 **typed 邻居**排在共现邻居前；结果里标 `→rel:id`（已有 `linkTag` 则复用）。
2. 无 typed 边时行为与现在一致（纯共现兜底）。
3. 测试：fixture 有边时，相关查询先返回箭头对端；无边时回归绿。
4. 结果报告：`docs/memory-retrieval-prefer-typed-result.md`；真实库零写入。

## 一句话
> 读路径排序/展示优先 typed link；无边则退回共现；改动尽量只在 `memory.ts` + 测试。
