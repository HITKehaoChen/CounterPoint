# M0 真实 Planner 探测报告

> 2026-08-13，使用本机真实 Chrys 与 Claude Code，`npm run probe:planner -- --strict` 通过（exit 0）。

## 最终结果

| Fixture | Planner | 结果 | 尝试次数 | 耗时 |
|---|---|---|---|---|
| simple-bug（期望 1 Agent + 1 Verifier） | Chrys | accepted | 2 | 587s |
| simple-bug | Claude Code（deepseek-v4-flash） | accepted | 2 | 214s |
| complex-bug（期望多节点 + 并行 + 验证 + 评审） | Chrys | accepted | 1 | 358s |
| complex-bug | Claude Code（deepseek-v4-flash） | accepted | 1 | 149s |

## 验收

- 两个 Planner 各产出至少一份合法计划：✅
- 简单 / 复杂 Fixture 拓扑签名不同（每 Planner）：✅
  - Chrys 简单：3 节点线性（定位 → 验证 → 发布）；复杂：5 节点（并行分析/验证 → 修复 → 回归 + 独立评审）
  - Claude 简单：3 节点线性；复杂：5 节点（双并行分析 → 修复 → 回归 + 独立评审）
- 累计真实模型花费 ≈ $2.95（预算上限 $6）

## 探测驱动的关键修复

1. Prompt 契约枚举化 + 数组元素 id 要求（真实模型输出 `visibility: public`、`onFailure: abort`、`kind: verdict` 等非法值）。
2. Schema 解析失败进入修复循环（此前直接报错，不触发修复）。
3. 可修复的 DAG 问题从 `rejected` 改为 `needs_revision`，让 Planner 有机会修正。
4. `independent_review` / `counterpoint_deliberation` 汇节点视为合法决策产出。
5. 默认 Claude 规划模型 `deepseek-v4-flash`（pro[1m] 实测 7–15 分钟）；Claude `--tools ""` 禁用工具（复杂任务从 10 分钟超时降至 149 秒）。
6. 探测支持续跑已通过组合 + 实时进度 + 整体时间预算（20 分钟）。

完整 JSON 见 [probe-report.json](probe-report.json)。
