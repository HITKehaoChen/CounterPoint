# Workspace/WorkItem/ResearchRound 领域重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 Counterpoint 从“项目 → 一次性 Deliberation 会议”重构为“Workspace 常驻 → WorkItem 持续协作 → ResearchRound 可选深度研究”的三层模型，同时保持协议内核不变。

**Architecture:** 数据层新增 `WorkItem` 实体并把 `Deliberation` 语义升级为 `ResearchRound`（增加 `workItemId` 与冻结快照）；引擎层新增 WorkItem 生命周期与协作流 API；Web 层新增 Workspace 看板与 WorkItem 详情页，现有 Console 变为 Round 视图。协议状态机、Context Policy、盲态、评审逻辑不改。

**Tech Stack:** TypeScript、Zod、Node 内置 http、React 19 + Vite、node:test、Vitest + Testing Library。

## Global Constraints

- 协议状态机、Context Policy、Commit–Reveal、匿名评审、事件链与 Decision Pack 逻辑**不改**。
- `kind` 只属于 WorkItem；Deliberation 只增加 `workItemId`，产品语义为 ResearchRound。
- Task Packet 保持冻结语义；ResearchRound 启动时快照 WorkItem 版本，禁止直接引用可变对象。
- Evidence 保留原始作用域；Workspace Knowledge 只存带适用范围的引用；只有 `Promoted` Claim 默认进入知识视图。
- 单用户本地优先；界面中文；不引入常驻 Agent/Watcher（v1 明确排除）。
- 现有测试（`npm test` 86 项、`test:api` 4 项、`test:web` 6 项）必须保持通过；每阶段新增测试。
- 当前目录不是 git 仓库，跳过逐任务提交。

---

## Phase 0：领域模型分层

### Task 0.1：WorkItem 与协作流 Schema

**Files:**
- Modify: `src/schemas.ts`
- Test: `tests/unit/work-item-schema.test.ts`（新建）

**Interfaces:**
- Produces: `WorkItemKind = 'problem' | 'requirement' | 'bug' | 'hypothesis' | 'decision'`
- Produces: `WorkItemStatus = 'open' | 'investigating' | 'resolved' | 'rejected' | 'needs_evidence'`
- Produces: `WorkItemEntry = WorkItemClaim | WorkItemQuestion | WorkItemUpdate`
- Produces: `WorkItemClaimStatus = 'tentative' | 'supported' | 'contested' | 'refuted' | 'promoted' | 'superseded'`
- Produces: `WorkItemRelation = { relation: 'related_to' | 'depends_on' | 'supersedes'; targetRef: string }`
- Produces: `KnowledgeRef = { ref: string; scope: 'workspace' | 'module' | 'work_item'; sourceVersion?: string; status: 'verified' | 'disputed' | 'superseded' | 'expired'; appliesWhen?: string; notApplicableWhen?: string; verifiedAt?: string; expiresAt?: string; provenance?: { workItemId: string; researchRoundId?: string } }`
- Produces: `WorkItem = { id, workspaceId, kind, title, description, ownerId, status, templateFields: Record<string, unknown>, currentConclusionRefs: string[], knowledgeRefs: KnowledgeRef[], relations: WorkItemRelation[], entries: WorkItemEntry[], version: number, createdAt, updatedAt, resolvedAt? }`
- Produces: `DeliberationSchema` 增加可选 `workItemId: z.string().optional()`
- Produces: `DatabaseSchema` 增加 `workItems: z.array(WorkItemSchema).default([])`
- Produces: `TaskPacketSchema` 增加可选 `workItemSnapshot: z.object({ workItemId, title, description, templateFields, version, hash }).optional()`

**Steps:**
- [ ] 1. 写失败测试：合法 WorkItem 通过解析；非法 kind/status 被拒绝；`workItems` 默认空数组；Deliberation 可带 `workItemId`；TaskPacket 可带 `workItemSnapshot`
- [ ] 2. 运行 `node --test tests/unit/work-item-schema.test.ts`，确认因字段缺失失败
- [ ] 3. 在 `src/schemas.ts` 实现上述 Schema 与类型
- [ ] 4. 重跑测试至通过；运行 `npx tsc --noEmit`

### Task 0.2：旧数据一对一迁移

**Files:**
- Modify: `src/schemas.ts`（新增 `migrateDatabase(db: Database): Database`）
- Modify: `src/protocol-engine.ts`（`loadDatabase` 在 parse 后调用 `migrateDatabase`）
- Test: `tests/unit/work-item-migration.test.ts`（新建）

**Interfaces:**
- Produces: `migrateDatabase(db): Database` —— 幂等；仅当 `db.workItems.length === 0 && db.deliberations.length > 0` 时执行
- 每个 Deliberation 迁移为一个 WorkItem：`kind='decision'`、`title=taskPacket.problem`、`ownerId=deliberation.ownerId`、`status=deliberation.state==='decided' ? 'resolved' : 'open'`、`currentConclusionRefs=[最新 decision 的 selectedRefs]`（若有）、`version=1`；同时写入 `deliberation.workItemId`

**Steps:**
- [ ] 1. 写失败测试：含 2 个已决策/未决策 Deliberation 的旧 Database 经 `migrateDatabase` 后生成 2 个 WorkItem、`workItemId` 正确关联、结论引用正确；连续调用两次结果不变（幂等）；空库不变
- [ ] 2. 运行测试确认失败，然后实现 `migrateDatabase`
- [ ] 3. 在 `ProtocolEngine.loadDatabase` 接入；运行测试 + 全量 `npm test`

### Task 0.3：WorkItem 引擎 API

**Files:**
- Modify: `src/protocol-engine.ts`
- Test: `tests/unit/work-items.test.ts`（新建）

**Interfaces:**
- Produces: `createWorkItem(input: { workspaceId, kind, title, description?, ownerId?, templateFields? }): WorkItem`
- Produces: `getWorkItem(workItemId): WorkItem`（不存在抛 `WorkItem not found`）
- Produces: `updateWorkItem(workItemId, patch: { description?, status?, templateFields?, currentConclusionRefs?, relations? }): WorkItem`（version+1；不覆盖 entries/knowledgeRefs）
- Produces: `listWorkItems(workspaceId): WorkItem[]`
- Produces: `addWorkItemEntry(workItemId, entry: WorkItemEntry): WorkItemEntry`（claim 初始 `tentative`；question/update 直接追加）
- Produces: `promoteWorkItemClaim(workItemId, claimId): WorkItemClaim`（仅 `supported → promoted`；其他状态抛错）
- Produces: `addWorkItemKnowledgeRef(workItemId, ref: KnowledgeRef): WorkItem`
- 事件：`work_item.created / work_item.updated / work_item.entry.added / work_item.claim.promoted / work_item.knowledge.added`，全部走现有 `onEvent` 回调

**Steps:**
- [ ] 1. 写失败测试：创建/读取/列表/更新版本递增；entry 追加；claim 状态机 `tentative→supported→promoted` 与非法跳转；事件回调触发
- [ ] 2. 运行确认失败后实现；跑 `npm test` + typecheck

### Task 0.4：ResearchRound 快照与结论回流

**Files:**
- Modify: `src/protocol-engine.ts`、`src/schemas.ts`（快照已在 Task 0.1）
- Test: `tests/unit/research-round.test.ts`（新建）

**Interfaces:**
- Produces: `createDeliberation` 的 `CreateDeliberationInput` 增加可选 `workItemId`；传值时将当前 WorkItem 快照写入 `packet.workItemSnapshot`（含 `version` 与 `hash`）
- Produces: `humanDecision` 在写入 Decision 后，若 Deliberation 有 `workItemId`，把 `selectedRefs` 追加到 WorkItem 的 `currentConclusionRefs`（追加不覆盖，历史保留在旧轮次）

**Steps:**
- [ ] 1. 写失败测试：同一 WorkItem 发起两轮 Round，两轮快照的 version 不同且互不覆盖；第一轮决策后 `currentConclusionRefs` 含其引用；第二轮决策后引用为两轮并集
- [ ] 2. 实现后跑测试 + typecheck

---

## Phase 1：工作空间与导航

### Task 1.1：WorkItem 视图投影与 API

**Files:**
- Modify: `src/human-view.ts`（新增 `buildWorkItemView(db, workItemId)` 与 `buildWorkItemBoard(db, workspaceId)`）
- Modify: `apps/api/server.ts`
- Test: `tests/unit/work-item-view.test.ts`、`tests/api/work-items.test.ts`（均新建）

**Interfaces:**
- Produces: `HumanWorkItemView`：`{ id, workspaceId, kind, title, description, ownerId, status, templateFields, currentConclusionRefs, knowledgeRefs, relations, entries, rounds: Array<{ deliberationId, state, createdAt, decidedAt?, recommendation? }>, version, createdAt, updatedAt, resolvedAt? }`
- Produces: `HumanWorkItemBoard`：按 `kind` 分组的摘要数组（id/title/status/updatedAt/roundCount）
- API：
  - `GET /api/workspaces/:id/work-items` → `{ board }`
  - `POST /api/workspaces/:id/work-items` → `{ workItem }`（body：kind/title/description/templateFields）
  - `GET /api/work-items/:id` → `HumanWorkItemView`
  - `PATCH /api/work-items/:id` → `{ workItem }`（仅允许 description/status/templateFields/currentConclusionRefs/relations）
  - `POST /api/work-items/:id/entries` → `{ entry }`（body：`{ type: 'claim'|'question'|'update', ... }`）
  - `POST /api/work-items/:id/entries/:entryId/promote` → `{ entry }`
  - `POST /api/work-items/:id/knowledge-refs` → `{ workItem }`
  - `POST /api/workspaces/:id/deliberations`（沿用现有 createDeliberation，body 增加 `workItemId`）→ `{ deliberation }`

**Steps:**
- [ ] 1. 写失败测试：视图投影包含 rounds 摘要且不含候选正文；board 分组正确；HTTP 全流程（建 WorkItem→改状态→加 claim→support→promote→非法 promote 409→发起 Round→决策后结论回流）
- [ ] 2. 实现 `buildWorkItemView`/`buildWorkItemBoard` 与 API 路由；跑测试 + typecheck + `npm run test:api`

### Task 1.2：Web 导航重构

**Files:**
- Modify: `apps/web/src/App.tsx`、`apps/web/src/pages/Dashboard.tsx`、`apps/web/src/pages/Wizard.tsx`、`apps/web/src/api.ts`
- Create: `apps/web/src/pages/WorkspacePage.tsx`、`apps/web/src/pages/WorkItemPage.tsx`、`apps/web/src/pages/RoundView.tsx`
- Test: `tests/web/workspace.test.tsx`（新建）

**Routes:**
- `/` → Workspace 列表（原 Dashboard 语义）
- `/workspaces/:id` → WorkItem 看板（按类型/状态分组）
- `/workspaces/:id/items/new` → New WorkItem Wizard（类型选择 + 模板表单）
- `/workspaces/:id/items/:itemId` → WorkItem 详情页
- `/workspaces/:id/items/:itemId/rounds/:roundId` → Round 视图（复用现有 Console）
- `/workspaces/:id/items/:itemId/rounds/:roundId/pack` → Decision Snapshot Viewer（复用 PackViewer）
- 旧路由 `/projects/...` 与 `/deliberations/:id` 301 重定向到新路由（保留兼容）

**WorkItem 详情页区块：**
- Overview：标题、类型、状态、Owner、描述、当前结论 refs、关联项
- 协作流：entries 时间线（claim 状态徽章 + 证据引用；question/update 卡片）+ 追加表单 + promote 按钮
- Research Rounds：历史轮次列表（状态、时间、推荐结论）+ “发起深度研究”按钮（跳 Round 向导，复用现有五步，提交时携带 `workItemId`）
- 知识：Promoted claims 与 knowledgeRefs

**Steps:**
- [ ] 1. 写失败测试：board 分组渲染；WorkItem 页渲染问题/当前结论/未知项区块；Round 入口跳转；旧路由重定向
- [ ] 2. 实现页面与路由；跑 `npm run test:web` + `npm run build:web`

---

## Phase 2：轻量协作流

### Task 2.1：@Agent 与“邀请分析”（Mock 演示路径）

**Files:**
- Modify: `apps/api/adapters.ts`、`apps/api/server.ts`
- Test: `tests/api/work-item-agent.test.ts`（新建）

**Interfaces:**
- Produces: `POST /api/work-items/:id/invite-agent`（body：`{ prompt? }`）→ 202 `{ jobId }`
- 后台任务：用 Mock Agent Adapter 基于 WorkItem 上下文（title/description/entries/currentConclusionRefs）生成 1 条 `update` entry 与至多 3 条 `tentative` claim entries；通过 `onEvent` 推送
- `@Agent` 提问复用同一端点：entry type=question（assignee=agent）→ 用户点“邀请分析”时执行

**Steps:**
- [ ] 1. 写失败测试：invite-agent 产生 entries；claim 初始 tentative；SSE 收到 entry 事件
- [ ] 2. 实现后跑测试

### Task 2.2：协作流 UI 与知识提升门禁

**Files:**
- Modify: `apps/web/src/pages/WorkItemPage.tsx`、`apps/web/src/components/`（新增 `CollaborationStream.tsx`、`EntryComposer.tsx`、`KnowledgePanel.tsx`）
- Test: `tests/web/work-item-page.test.tsx`（新建）

**行为：**
- 追加表单支持 claim/question/update；claim 默认显示 `Tentative` 徽章
- 仅 `Supported` 的 claim 显示“提升为 Promoted”按钮；点击后调用 promote；非 Supported 状态禁用并给出原因
- 知识面板只显示 `promoted` claims 与 `knowledgeRefs`；其余条目带状态标注，不进入知识视图
- “邀请分析”按钮调用 invite-agent 并在完成后刷新

**Steps:**
- [ ] 1. 写失败测试：Tentative 无 promote 按钮、Supported 有、点击后调 API；知识面板过滤非 Promoted；邀请分析按钮存在
- [ ] 2. 实现后跑 `npm run test:web` + typecheck

---

## Phase 3：沉淀与检索（v1 最小版）

### Task 3.1：决策档案与 Workspace Knowledge 页

**Files:** `apps/web/src/pages/WorkspacePage.tsx`、`src/human-view.ts`、`apps/api/server.ts`

- Workspace 看板增加“决策档案”区：列出 `status='resolved'` 的 WorkItem 及其最新 decision 摘要
- Workspace 看板增加“知识”区：聚合所有 `promoted` claims 与 `knowledgeRefs`（带 scope/provenance 标注）
- API：`GET /api/workspaces/:id/knowledge` → `{ promotedClaims, knowledgeRefs }`
- 测试：`tests/api/workspace-knowledge.test.ts` 断言聚合正确、只含 promoted；UI 测试断言两区块渲染

### Task 3.2：类型模板

**Files:** `apps/web/src/pages/Wizard.tsx`、`apps/web/src/templates.ts`（新建）

- 每种 `kind` 一个模板字段集：bug（复现步骤/环境/期望/实际）、requirement（验收标准/优先级）、hypothesis（预测/实验/测量）、decision（沿用目标/约束/Rubric/交付）、problem（自由描述/已知边界）
- 模板字段存入 `templateFields`；Round 向导仍使用完整表单
- 测试：`tests/web/templates.test.tsx` 断言选择类型后字段变化

### Task 3.3：关联关系

**Files:** `apps/web/src/pages/WorkItemPage.tsx`、`apps/api/server.ts`、`src/human-view.ts`

- WorkItem 详情显示“关联项”区（related_to / depends_on / supersedes）
- `PATCH /api/work-items/:id` 的 `relations` 已支持（Task 1.1），UI 增加添加/删除
- 测试：UI 断言关系列表与添加表单

**明确排除（后续 v0.2）：** 常驻 Watcher、自动发起 Round、完整知识图谱页面。

---

## 测试计划与验收

- 回归：`npm test`（86+）、`npm run test:api`、`npm run test:web`、`npm run typecheck`、`npm run build:web` 全部通过。
- 迁移：旧 store 加载后一对一生成 WorkItem；幂等；`workItemId` 关联正确。
- 协议不变性：现有状态机/泄漏/决策包测试零修改通过。
- 端到端：`npm run dev` 手动走通“创建 Workspace → 新建 Bug WorkItem → 追加 Claim/邀请 Mock Agent → 发起深度研究 → 盲态运行 → 披露 → 评审 → 决策 → 结论回流 → 决策档案可见 → 再次发起第二轮（引用第一轮不覆盖）”。
- 每次任务按 TDD：先写失败测试 → 确认失败原因 → 最小实现 → 通过 → 全量验证。
