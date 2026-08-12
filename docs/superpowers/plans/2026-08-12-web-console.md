# Counterpoint Web Console 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 M0/M1/M2 协议引擎之上实现 PRD v0.1 的 Web Console（React+Vite SPA + Node HTTP/SSE 服务）。

**Architecture:** `apps/api` 单实例长驻 ProtocolEngine，提供 REST + SSE；`apps/web` 为 React 单页应用，通过人工视图投影获取 UI 安全数据。

**Tech Stack:** TypeScript、Node 内置 http、React 18、Vite、react-router-dom、node:test、Vitest + Testing Library。

## Global Constraints

- 协议语义、状态机与数据模型不改变；只新增人工视图投影与实时层。
- 盲态（blind_run/committed）任何 API/SSE 载荷不得包含候选正文、Claim、Artifact 内容或日志。
- 界面文案中文，代码标识符英文；单用户本地优先，无鉴权。
- 默认 API 端口 8787、Vite 5173；数据库 `data/store.json`（`COUNTERPOINT_DB` 可覆盖）。
- 当前目录不是 git 仓库，跳过逐任务提交。

---

## Phase A：引擎钩子 + 人工视图 + API

- [ ] 保存本计划到 `docs/superpowers/plans/2026-08-12-web-console.md`
- [ ] `EngineOptions` 新增 `onEvent?(event)` 与 `onRunUpdate?(update)`；`mutate`/`transition` 触发 `onEvent`；run 状态变化触发 `onRunUpdate`
- [ ] `startBlindRun`/`runReview`/`retryRun`/`cancelRun` 逐 run 持久化并触发回调
- [ ] 修复 `runVerification` 完成后未持久化、未追加 `evidence.recorded` 事件
- [ ] 新增 `src/human-view.ts`：`buildHumanView(db, deliberationId, seed)` 投影（盲态红action、候选 X/Y 匿名、状态图标+文字、未解决分歧显式列出）
- [ ] 新增 `apps/api`：Node 内置 http 服务、REST 路由、SSE、后台任务、每 Deliberation 互斥、错误映射 400/404/409、静态托管 `apps/web/dist`
- [ ] 适配器解析：`participant.adapterConfig` 支持 `{kind:'mock'}` / `{kind:'local-process'}` / `{kind:'mock-reviewer'}`
- [ ] 新增测试：引擎回调、human-view 红action、API 全生命周期/盲态不泄漏/错误映射/SSE/导出

## Phase B：Web 应用

- [ ] 根 `package.json` 增加依赖与脚本（dev:api / dev:web / dev / build:web / start / test:api / test:web）；根 `tsconfig.json` 支持 `.tsx` 与 DOM
- [ ] `apps/web` Vite + React 脚手架；`api.ts` 类型化客户端；`useDeliberation` Hook（EventSource + 5s 轮询兜底）
- [ ] Project Dashboard：项目卡片、新建项目、进入向导
- [ ] New Deliberation Wizard：任务 → 来源 → Rubric → 参与者 → 预览/冻结
- [ ] Deliberation Console 七个视图：Overview / Runs / Artifacts / Claims / Evidence / Decision / Timeline；盲态锁与状态动作按钮

## Phase C：Viewer 与收尾

- [ ] Decision Pack Viewer（结构化展示 + Markdown/JSON 下载）
- [ ] README 更新 Web Console 使用说明
- [ ] 全量验证：typecheck、npm test、test:api、test:web、build:web、手动闭环

---

## 测试计划

- 回归：现有 57 项引擎/集成测试保持全绿。
- `human-view`：盲态无候选内容；披露后匿名 X/Y；Review 结果阶段可见；未解决分歧恒在。
- API 集成：HTTP 全生命周期；盲态 REST/SSE 无候选内容；400/404/409；SSE 事件；导出 unresolvedRefs = 0。
- UI（Vitest+RTL）：CandidateView 披露前隐藏、状态徽章图标+文字、Human Gate 阶段出现、向导完整性错误、未解决分歧可见。
- 验收命令：`npm run typecheck`、`npm test`、`npm run test:api`、`npm run test:web`、`npm run build:web`。
