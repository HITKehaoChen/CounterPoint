# M1 Real Slice — 真实 Agent 技术决策实验

> 2026-08-12 完成的第一份真实 Decision Pack。仓库内归档的是产物快照；完整事件链与
> 工作区在本地 `data/m1/store.json`（被 `.gitignore` 忽略，不入库）。

## 实验内容

真实技术决策：CounterPoint Web Console 实时更新通道应保持 SSE（现状）、改用
WebSocket，还是退化为纯轮询？

- **Worker A**：Chrys（deepseek-v4-pro，Python agent runtime）
- **Worker B**：Claude Code（deepseek-v4-pro[1m]）
- **Reviewer**：Claude Code（deepseek-v4-flash），候选匿名随机排序
- **Evidence**：2 次真实代码检索 + `npm run typecheck` + `npm test`（4 条 verified）
- **结论**：批准保持 SSE + 轮询兜底（candidate_a），不引入 WebSocket；附 3 条生效条件

## 关键指标

| 指标 | 数值 |
|---|---|
| 独有有效 Claim | 17 / 17 |
| 证据覆盖率 | 1.0 |
| 上下文泄漏 | 0 |
| 总成本 | $1.818597（A 估算 $0.344325 + B $1.251647 + Reviewer $0.222625） |
| 总耗时 | 519,753ms |
| 人工干预 | 4 次（冻结、质询回复、证据选择、Human Gate 批准） |

## 复现

```bash
npm install
npm run slice:real
```

运行前需要本机可用的 CLI：

- `CHRYS_BIN`：Chrys 可执行文件（默认
  `C:\Users\tgyzc\project\chrys\.venv\Scripts\chrys.exe`）
- `CLAUDE_BIN`：Claude Code 可执行文件（默认
  `C:\Users\tgyzc\.local\bin\claude.exe`）
- `WORKER_B_MODEL` / `REVIEWER_MODEL`：Worker B 与 Reviewer 的模型（默认
  `deepseek-v4-pro[1m]` / `deepseek-v4-flash`）
- `NPM_CLI_PATH`：npm CLI 脚本路径（Windows 下 Node 无法直接 spawn `npm`）

产物写入 `data/out/`（Decision Pack）与 `data/m1/`（store + 指标报告）。

## 产物

- [Decision Pack (Markdown)](decision-pack.md)
- [Decision Pack (JSON)](decision-pack.json)（unresolvedRefs = 0）
- [指标报告 (Markdown)](slice-report.md)
- [指标报告 (JSON)](slice-report.json)

## 实验过程中的引擎修复

1. Claude prompt 改走 stdin，避免 Windows 命令行长度上限（ENAMETOOLONG）。
2. 提交 Position 时保证 claim id 全局唯一，避免真实 Agent 的通用 id 造成质询目标错位。
3. CLI Reviewer 适配器补齐/钳制 rubric 分数；Reviewer run 持久化 fingerprint 与 cost。
4. Chrys 会话 token 用量解析（session 目录取 UUID 前 12 位），成本按实测费率估算。
