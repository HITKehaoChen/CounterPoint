# Counterpoint v0.2 M1 Autonomous Vertical Slice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 跑通「目标 → 规划 → 验证 → 编译 → 调度 → 改计划 → 决策」真实闭环：Scheduler、六个 P0 Operator、Replan Controller、Stop/Decision 语义，并用真实 Chrys + Claude Code 跑复杂 Bug 切片，至少发生一次 Evidence-grounded PlanPatch。

**Architecture:** 在 M0 控制面之上新增执行面。`Operator` 是统一运行契约；`Scheduler` 只调度 Ready 节点并遵守并行度/预算/失败策略；`counterpoint_deliberation` 是薄 facade 驱动现有 `ProtocolEngine`；`PlanPatch` 经 `ReplanController` 重新验证后只改未开始节点；`DecisionRecord` 只在 Stop Condition 满足后生成，节点 succeeded（含 Reviewer Verdict）不等于已解决。

**Tech Stack:** TypeScript 5.9、Zod 3.24、Node ≥22.18、node:test；真实 Agent 沿用现有 `CliAgentAdapter` / `CliReviewerAdapter` / `CliPlannerAdapter`（Claude 规划用 `deepseek-v4-flash` + `--tools ""`）。

**Spec:** `docs/superpowers/specs/2026-08-13-counterpoint-v02-planning-design.md`（含 §9.1 评审修正）

## Global Constraints

- 宪法不可绕过：调度、改计划、决策全部沿用 M0 的确定性 Validator/预算/上下文/血缘规则。
- `ProtocolEngine` 内核不改；`counterpoint_deliberation` 只能调用其公开方法。
- **terminal output ≠ decision**：`NodeRun.status === 'succeeded'` 仅表示节点有合法输出；WorkItem Decision 只能由 Stop Condition 满足后的 `recordDecision` 产生（spec §9.1 第 4 条）。
- 已开始/已完成的 Run 不可被 PlanPatch 删除或覆盖；历史追加保存。
- 每个 Attempt 的成本（Token/模型/耗时/花费）必须记录且修复尝试成本不得丢失（spec §9.1 第 2 条）。
- `--fresh` 探测禁止复用历史结果；报告带 `gitCommitSha` 与版本标识（spec §9.1 第 1 条）。
- 语义拓扑断言进入 `--strict` 验收（spec §9.1 第 3 条）。
- 单用户 local-first；Scheduler 进程内确定性调度 + 事件链恢复，不引外部队列。
- 现有基线保持：`npm run typecheck`、`npm test`（155 项）；每任务 TDD、逐任务提交。
- 执行在隔离 worktree（`using-git-worktrees`）中进行，不在 main 上直接开发。

---

## File Structure

Create:

- `src/execution/budget-ledger.ts` — 预算账本
- `src/execution/context-view.ts` — 节点级 Context View
- `src/execution/scheduler.ts` — Scheduler
- `src/execution/replan-controller.ts` — PlanPatch 应用与再验证
- `src/execution/work-item-runner.ts` — 规划→调度→决策编排
- `src/planning/stop-condition.ts` — Stop 判定与 `recordDecision`
- `src/operators/operator.ts` — Operator 契约 + Registry
- `src/operators/agent-task.ts`、`tool-task.ts`、`verification.ts`、
  `independent-review.ts`、`human-gate.ts`、`counterpoint-deliberation.ts`
- `apps/cli/m1-slice.ts` — M1 真实垂直切片

Modify:

- `src/schemas.ts` — NodeRun/Attempt/DecisionRecord、Claim/Evidence 泛化、Database v0.2 增列
- `src/verifier.ts` — 顶层 `recordNodeEvidence`
- `src/planning/planner.ts`、`apps/cli/planner-probe.ts`、`apps/cli/planner-fixtures.ts`、
  `tests/unit/planner-probe.test.ts` — Task 0 硬化
- `package.json`（`slice:m1`）、`README.md`

Test:

- `tests/unit/budget-ledger.test.ts`、`tests/unit/node-context-view.test.ts`、
  `tests/unit/operators.test.ts`、`tests/unit/scheduler.test.ts`、
  `tests/unit/replan-controller.test.ts`、`tests/unit/stop-condition.test.ts`、
  `tests/integration/m1-runner.test.ts`、`tests/unit/node-run-schema.test.ts`

---

## Task 0：Probe Evidence Hardening（评审四条中的 1–3）

### Task 0A：报告血缘与 `--fresh`

**Files:** Modify `apps/cli/planner-probe.ts`、`tests/unit/planner-probe.test.ts`

**Interfaces:**
- Produces: `const SCHEMA_VERSION = '0.2.0'`、`const VALIDATOR_VERSION = '2'`（`src/planning/plan-validator.ts` 导出）、`const PLANNER_PROMPT_VERSION = 'counterpoint-planner-prompt-2'`（`src/planning/planner-prompt.ts` 导出）
- Produces: `loadResumedResults(opts: { fresh: boolean }): FixtureResult[]`——`fresh === true` 返回 `[]`
- Modifies: report 增加 `gitCommitSha: string`、`schemaVersion`、`validatorVersion`、`promptVersion`；`resumed` 行增加 `originalRunId: string`（来源报告文件名）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/planner-probe.test.ts 追加
import { execFileSync } from 'node:child_process';

test('probe help lists --fresh and --strict flags', () => {
  const out = execFileSync(process.execPath, ['apps/cli/planner-probe.ts', '--help'], { encoding: 'utf8' });
  assert.ok(out.includes('--fresh'));
  assert.ok(out.includes('--strict'));
});
```

- [ ] **Step 2: RED**：`node --test tests/unit/planner-probe.test.ts`（`--help` 分支尚不存在）
- [ ] **Step 3: 实现**

在 `apps/cli/planner-probe.ts`：`const fresh = process.argv.includes('--fresh');`
加 `--help` 分支打印用法并 `process.exit(0)`；`loadResumedResults({ fresh })` 在 fresh 时返回 `[]`；
resumed 行附加 `originalRunId`；report 字段：

```ts
gitCommitSha: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
schemaVersion: SCHEMA_VERSION,
validatorVersion: VALIDATOR_VERSION,
promptVersion: PLANNER_PROMPT_VERSION,
```

- [ ] **Step 4: GREEN** + `npm run typecheck`
- [ ] **Step 5: Commit** `fix(probe): fresh mode, run provenance and version stamps`

### Task 0B：每次 Attempt 的成本与累计口径

**Files:** Modify `src/planning/planner.ts`、`apps/cli/planner-probe.ts`、`tests/unit/planner-orchestrator.test.ts`

**Interfaces:**
- Produces: `ProposeResult.attemptsDetail: Array<{ attempt: number; costUsd: number; durationMs?: number; model?: string; provider?: string; inputTokens?: number; outputTokens?: number }>`
- Modifies: `PlannerOrchestrator.propose` 每次 `planner.plan()` 后 push 一条 detail（`proposal.meta`）
- Modifies: report 增加 `currentRunCostUsd` 与 `cumulativeCostUsd`（resumed 行按 `costUsd ?? 0` 累计）；`FixtureResult` 增加 `costUsd`、`model` 字段并回填

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/planner-orchestrator.test.ts 追加
test('orchestrator records per-attempt cost details', async () => {
  let calls = 0;
  const planner: Planner = {
    name: 'costed-planner',
    async plan(): Promise<PlannerResult> {
      calls += 1;
      if (calls === 1) {
        return { plan: validPlan({ nodes: [badNode()] }), meta: { costUsd: 0.25, model: 'm1', usage: { inputTokens: 100, outputTokens: 50 } } };
      }
      return { plan: validPlan(), meta: { costUsd: 0.35, model: 'm2' } };
    },
  };
  const proposal = await new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 2 }).propose(baseInput());
  assert.deepEqual(proposal.attemptsDetail.map((item) => item.costUsd), [0.25, 0.35]);
  assert.equal(proposal.attemptsDetail[0].inputTokens, 100);
  assert.equal(proposal.totalCostUsd, 0.6);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（`propose` 循环内 push detail；probe 回填 `costUsd/model` 并按 resumed 累计）
- [ ] **Step 4: GREEN** + 全量 `npm test`
- [ ] **Step 5: Commit** `feat(planning): per-attempt cost accounting`

### Task 0C：语义拓扑断言

**Files:** Modify `apps/cli/planner-fixtures.ts`、`apps/cli/planner-probe.ts`、`tests/unit/planner-probe.test.ts`

**Interfaces:**
- Produces: `export interface TopologyRequirement { agentTaskCount: 'eq' | 'gte' | 'none'; value?: number; verificationGte: number; parallelWidth: 'eq' | 'gte'; parallelValue: number; hasIndependentReview: boolean; hasDeliberation: boolean; hasConvergingNode: boolean }`
- Produces: `assertPlanTopology(plan: CollaborationPlan, requirement: TopologyRequirement): string[]`（返回违规描述数组，空 = 通过）
- Modifies: `PROBE_FIXTURES` 的 `expectedTopology` 改为 `topology: TopologyRequirement`：
  - simple-bug：`{ agentTaskCount:'eq', value:1, verificationGte:1, parallelWidth:'eq', parallelValue:1, hasIndependentReview:false, hasDeliberation:false, hasConvergingNode:false }`
  - complex-bug：`{ agentTaskCount:'gte', value:1, verificationGte:1, parallelWidth:'gte', parallelValue:2, hasIndependentReview:true, hasDeliberation:false, hasConvergingNode:true }`
- Modifies: `--strict` 验收 = 每行 `accepted` 且 `assertPlanTopology` 为空；`topologySignature` 仅入报告展示

并行宽度与汇聚判定（计划内固定实现）：

```ts
export function planWidth(plan: CollaborationPlan): number {
  const levels = new Map<string, number>();
  const levelOf = (id: string, trail = new Set<string>()): number => {
    if (trail.has(id)) return 1;
    const node = plan.nodes.find((item) => item.id === id);
    const next = new Set(trail); next.add(id);
    return 1 + Math.max(0, ...(node?.dependsOn ?? []).map((dep) => levelOf(dep, next)));
  };
  for (const node of plan.nodes) levels.set(node.id, levelOf(node.id));
  const perLevel = new Map<number, number>();
  for (const node of plan.nodes) {
    const level = levels.get(node.id)!;
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
  }
  return Math.max(0, ...perLevel.values());
}

export function hasConvergingNode(plan: CollaborationPlan): boolean {
  return plan.nodes.some((node) => node.dependsOn.length >= 2);
}
```

- [ ] **Step 1: 写失败测试**

```ts
test('simple topology assertion rejects an extra agent task', () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const violations = assertPlanTopology(plan, PROBE_FIXTURES[0].topology);
  assert.ok(violations.some((item) => item.includes('agent_task')));
});

test('complex topology assertion requires parallelism and review', () => {
  const violations = assertPlanTopology(validPlan(), PROBE_FIXTURES[1].topology);
  assert.ok(violations.length > 0);
});

test('plan width counts parallel source nodes', () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' }), makeNode({ id: 'c', dependsOn: ['a', 'b'] })] });
  assert.equal(planWidth(plan), 2);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现** `assertPlanTopology`/`planWidth`/`hasConvergingNode`；`--strict` 中调用
- [ ] **Step 4: GREEN** + 全量 `npm test`
- [ ] **Step 5: Commit** `feat(probe): semantic topology assertions in strict mode`

注意：按评审结论，本轮不重新花钱跑 `--fresh --strict`；M1 Vertical Slice 完成后统一执行一次。

---

## Task 1：NodeRun / DecisionRecord / Claim、Evidence 泛化

**Files:** Modify `src/schemas.ts`；Test `tests/unit/node-run-schema.test.ts`

**Interfaces:**
- Produces: `AttemptDetailSchema`、`NodeRunSchema` / `type NodeRun` / `type NodeRunStatus`
- Produces: `DecisionOutcomeSchema`、`DecisionRecordSchema` / `type DecisionRecord`
- Modifies: `ClaimSchema` 增 `nodeRunId?`、`workItemId?`；`EvidenceSchema.deliberationId` 改 optional，增 `workItemId?`、`planId?`、`nodeRunId?`
- Modifies: `DatabaseSchema` 增 `nodeRuns / decisionRecords / evidence / claims`（全部 `.default([])`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/node-run-schema.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDatabase, NodeRunSchema, DecisionRecordSchema, EvidenceSchema, ClaimSchema } from '../../src/schemas.ts';

test('node run accepts attempts and outputs', () => {
  const run = NodeRunSchema.parse({
    id: 'nr_1', workItemId: 'wi_1', planId: 'plan_1', planVersion: 1,
    graphNodeId: 'gn_a', role: 'Analyst', operatorType: 'agent_task', status: 'running',
    attempts: [{ attempt: 1, startedAt: 't', finishedAt: 't2', costUsd: 0.1, inputTokens: 10, outputTokens: 5, model: 'm' }],
    outputs: { answer: 'x' },
  });
  assert.equal(run.attempts[0].model, 'm');
});

test('decision record is separate from node runs', () => {
  const decision = DecisionRecordSchema.parse({ id: 'dec_1', workItemId: 'wi_1', planId: 'plan_1', planVersion: 1, outcome: 'resolved', summary: 'root cause verified', decidedAt: 't', ownerId: 'human' });
  assert.equal(decision.outcome, 'resolved');
});

test('evidence and claim accept node-level provenance', () => {
  const evidence = EvidenceSchema.parse({ id: 'evid_1', workItemId: 'wi_1', planId: 'plan_1', nodeRunId: 'nr_1', kind: 'command_result', source: { command: 'node', args: [] }, targetRefs: ['claim:c1'], result: { exitCode: 0 }, status: 'verified', hash: 'h', createdAt: 't' });
  assert.equal(evidence.deliberationId, undefined);
  const claim = ClaimSchema.parse({ id: 'c1', workItemId: 'wi_1', nodeRunId: 'nr_1', statement: 'x', type: 'fact' });
  assert.equal(claim.nodeRunId, 'nr_1');
});

test('database v0.2 carries node runs and decisions', () => {
  const db = emptyDatabase();
  assert.deepEqual(db.nodeRuns, []);
  assert.deepEqual(db.decisionRecords, []);
  assert.deepEqual(db.evidence, []);
  assert.deepEqual(db.claims, []);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（`emptyDatabase` 同步加四个数组；migrate 无需新逻辑）
- [ ] **Step 4: GREEN** + `npm run typecheck` + 全量 `npm test`（旧 Evidence 测试仍带 `deliberationId`，兼容）
- [ ] **Step 5: Commit** `feat(schemas): node runs, decision records, node-level claims and evidence`

---

## Task 2：Budget Ledger

**Files:** Create `src/execution/budget-ledger.ts`；Test `tests/unit/budget-ledger.test.ts`

**Interfaces:**
- Produces: `BudgetUsage { timeMs: number; tokens?: number; costUsd?: number }`
- Produces: `class BudgetLedger { constructor(envelope: AutonomyEnvelope); startRun(runId, nodeBudget: NodeBudget): void; finishRun(runId, usage: BudgetUsage): void; canRetry(runId, maxRetries): boolean; envelopeExhausted(): boolean; snapshot(): {...} }`
- 规则：`startRun` 在 envelope 总时间/Token/成本耗尽时抛 `BUDGET_EXCEEDED`；节点累计时间超过 `nodeBudget.maxTimeMs` 抛 `NODE_BUDGET_EXCEEDED`；`canRetry` 要求 `attempts ≤ maxRetries` 且未耗尽

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/budget-ledger.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { validEnvelope } from '../helpers/plan-fixtures.ts';

test('ledger accumulates usage and enforces node time budget', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 10_000 }));
  ledger.startRun('nr_1', { maxTimeMs: 100 });
  ledger.finishRun('nr_1', { timeMs: 60 });
  assert.throws(() => ledger.finishRun('nr_1', { timeMs: 60 }), /NODE_BUDGET_EXCEEDED/);
});

test('ledger blocks retries beyond maxRetries', () => {
  const ledger = new BudgetLedger(validEnvelope());
  ledger.startRun('nr_1', { maxTimeMs: 1000 });
  ledger.finishRun('nr_1', { timeMs: 10 });
  assert.equal(ledger.canRetry('nr_1', 1), true);
  ledger.startRun('nr_1', { maxTimeMs: 1000 });
  assert.equal(ledger.canRetry('nr_1', 1), false);
});

test('envelope exhaustion raises BUDGET_EXCEEDED', () => {
  const ledger = new BudgetLedger(validEnvelope({ timeBudgetMs: 1000 }));
  ledger.startRun('nr_1', { maxTimeMs: 900 });
  assert.throws(() => ledger.startRun('nr_2', { maxTimeMs: 900 }), /BUDGET_EXCEEDED/);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（Map 记账；`startRun` 先检查 envelope 余额）
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(execution): budget ledger`

---

## Task 3：节点级 Context View

**Files:** Create `src/execution/context-view.ts`；Test `tests/unit/node-context-view.test.ts`

**Interfaces:**
- Produces: `buildNodeContextView(input: { node: GraphNode; db: Database; workItem: WorkItem; producerIndex: Map<string, string[]>; seed?: string }): ContextView`
- 规则：`visible.authoritySources = workItem.sourceRefs`；`visible.artifacts = node.inputRefs 解析 + 上游 shared 产出`；`private/blind/sealed` 上游的产出只对生产者自身可见；`hidden.objectTypes` 含被排除类型与盲态上游对象；`tools` 由 operator 类型映射（agent_task → `read_sources/write_scratch`，tool_task/verification → `read_sources/run_command`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/node-context-view.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeContextView } from '../../src/execution/context-view.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import { emptyDatabase } from '../../src/schemas.ts';

const catalog = catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] }]);

test('blind sibling outputs are hidden from each other', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'blind-a', contextPolicy: { visibility: 'blind', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] } }),
      makeNode({ id: 'blind-b', contextPolicy: { visibility: 'blind', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] } }),
    ],
  });
  const graph = compilePlan({ plan, catalog });
  const view = buildNodeContextView({
    node: graph.nodes[0], db: emptyDatabase(), workItem: validWorkItem(),
    producerIndex: new Map([['gn_blind-b', ['claim:b1']]]), seed: 't',
  });
  assert.equal(view.visible.claims.includes('claim:b1'), false);
  assert.ok(view.hidden.objectTypes.includes('blind_claims'));
});

test('shared upstream outputs are visible', () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const graph = compilePlan({ plan, catalog });
  const view = buildNodeContextView({
    node: graph.nodes[1], db: emptyDatabase(), workItem: validWorkItem(),
    producerIndex: new Map([['gn_a', ['claim:a1']]]), seed: 't',
  });
  assert.ok(view.visible.claims.includes('claim:a1'));
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（读取 db.claims/artifacts 按 producerIndex 与 visibility 裁剪，hash 复用 `hashJson`）
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(execution): node-level context views`

---

## Task 4：Operator 契约 + agent_task + tool_task

**Files:** Create `src/operators/operator.ts`、`src/operators/agent-task.ts`、`src/operators/tool-task.ts`；Test `tests/unit/operators.test.ts`

**Interfaces:**
- Produces: `OperatorContext { graphNode; nodeRun; db; store; workItem; contextView; workspacePath; envelope; resolveAgent(capability): AgentAdapter | undefined; resolveReviewer(capability): ReviewerAdapter | undefined; publishArtifact(input): string; ledger; emit(event: NewEvent): void; requestHumanGate(input): HumanGateRequest }`
- Produces: `OperatorResult { status: 'succeeded' | 'failed' | 'waiting_human'; artifactRefs; evidenceRefs; claimRefs; opinionRefs; outputs: Record<string, unknown>; usage?: BudgetUsage; error?: string }`
- Produces: `interface Operator { readonly type: OperatorKind; run(ctx): Promise<OperatorResult> }`
- Produces: `createOperatorRegistry(deps: { engine?: ProtocolEngine }): Map<OperatorKind, Operator>`
- Produces: `AgentTaskOperator`（把 `objective` 组装成 TaskPacket，调 `resolveAgent`，publish 产物、claims 写入 `db.claims`）
- Produces: `ToolTaskOperator`（校验命令在 envelope.allowedTools，spawn，stdout 发布为 artifact，exit 0 = succeeded）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/operators.test.ts（节选）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTaskOperator } from '../../src/operators/agent-task.ts';
import { ToolTaskOperator } from '../../src/operators/tool-task.ts';
import { MockAgentAdapter } from '../../src/adapters/mock-agent.ts';
import { defaultWorkerAScript, validWorkItem } from '../helpers/plan-fixtures.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan } from '../helpers/plan-fixtures.ts';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { emptyDatabase, NodeRunSchema } from '../../src/schemas.ts';

function ctxFor(nodeId: string) {
  const plan = validPlan({ nodes: [makeNode({ id: nodeId })] });
  const graph = compilePlan({ plan, catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]) });
  const db = emptyDatabase();
  const nodeRun = NodeRunSchema.parse({ id: 'nr_1', workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, graphNodeId: graph.nodes[0].id, role: 'x', operatorType: 'agent_task', status: 'running' });
  return { graph: graph.nodes[0], db, nodeRun };
}

test('agent task publishes artifacts and claims', async () => {
  const { graph: node, db, nodeRun } = ctxFor('a');
  const op = new AgentTaskOperator();
  const result = await op.run({
    graphNode: node, nodeRun, db, store: { save() {}, load() { return db; } } as never,
    workItem: validWorkItem(), contextView: { id: 'c', runId: 'nr_1', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' },
    workspacePath: 'C:/tmp/op-test', envelope: (await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws'),
    resolveAgent: () => new MockAgentAdapter(defaultWorkerAScript),
    publishArtifact: () => 'artifact:1',
    ledger: new BudgetLedger((await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws')),
    emit: () => undefined,
    requestHumanGate: () => { throw new Error('unused'); },
  });
  assert.equal(result.status, 'succeeded');
  assert.ok(result.artifactRefs.length > 0);
  assert.ok(result.claimRefs.length > 0);
  assert.ok(db.claims.length > 0);
});

test('tool task rejects a command outside the allowlist', async () => {
  const { graph: node, db, nodeRun } = ctxFor('t');
  const op = new ToolTaskOperator();
  await assert.rejects(() => op.run({ graphNode: { ...node, operator: { type: 'tool_task', command: 'curl', args: [] } }, nodeRun, db, store: { save() {}, load() { return db; } } as never, workItem: validWorkItem(), contextView: { id: 'c', runId: 'nr_1', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' }, workspacePath: 'C:/tmp/op-test', envelope: (await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws'), resolveAgent: () => undefined, publishArtifact: () => 'artifact:1', ledger: new BudgetLedger((await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws')), emit: () => undefined, requestHumanGate: () => { throw new Error('unused'); } }), /allowlist/);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（`AgentTaskOperator` 组装 TaskPacket：`{id, problem: objective, goals: [objective], constraints: workItem.constraints, rubric: {items:[{id:'r',name:'objective',weight:1}], maxScore:5}, sources: workItem.sourceRefs}`；claims 逐条 push 进 `db.claims`）
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(operators): operator contract, agent task and tool task`

---

## Task 5：verification Operator

**Files:** Modify `src/verifier.ts`（新增顶层 `recordNodeEvidence`）；Create `src/operators/verification.ts`；Test `tests/unit/operators.test.ts` 追加

**Interfaces:**
- Produces: `recordNodeEvidence(db: Database, input: { workItemId; planId; nodeRunId; command; args; exitCode; stdoutHash?; status: EvidenceStatus; description?; targetRefs: string[] }): Evidence`（push 到 `db.evidence`）
- Produces: `VerificationOperator`：执行 `operator.command/args`（复用 `runCliProcess`），exit 0 → `verified` 否则 `failed`，返回 `evidenceRefs`

- [ ] **Step 1: 写失败测试**

```ts
test('verification operator records node-level evidence', async () => {
  const op = new VerificationOperator();
  const { graph: node, db, nodeRun } = ctxFor('v');
  const result = await op.run({ graphNode: { ...node, operator: { type: 'verification', command: process.execPath, args: ['--version'], targetRefs: ['claim:c1'] } }, nodeRun, db, store: { save() {}, load() { return db; } } as never, workItem: validWorkItem(), contextView: { id: 'c', runId: 'nr_1', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' }, workspacePath: 'C:/tmp/op-test', envelope: (await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws'), resolveAgent: () => undefined, publishArtifact: () => 'artifact:1', ledger: new BudgetLedger((await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws')), emit: () => undefined, requestHumanGate: () => { throw new Error('unused'); } });
  assert.equal(result.status, 'succeeded');
  assert.equal(db.evidence.length, 1);
  assert.equal(db.evidence[0].status, 'verified');
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(operators): node-level verification`

---

## Task 6：independent_review Operator

**Files:** Create `src/operators/independent-review.ts`；Test `tests/unit/operators.test.ts` 追加

**Interfaces:**
- Produces: `IndependentReviewOperator`：目标节点 claims → 匿名候选（复用 `shuffled` + 脱敏），`resolveReviewer('independent-review')` 评审；输出写入 `nodeRun.outputs.review`（`{ recommendation, rationale, evidenceSufficiency, unresolvedRisks, rubricScores }`），**不产生 Decision**；若 reviewer fingerprint 与目标生产者 fingerprint 相交，抛 `INDEPENDENCE_VIOLATION`

- [ ] **Step 1: 写失败测试**

```ts
test('independent review stores a verdict in outputs, not a decision', async () => {
  const { graph: node, db, nodeRun } = ctxFor('r');
  db.claims.push({ id: 'c1', workItemId: 'wi_test', nodeRunId: 'nr_src', statement: 'x', type: 'fact' });
  const op = new IndependentReviewOperator();
  const result = await op.run({ graphNode: { ...node, operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['src'] } }, nodeRun, db, store: { save() {}, load() { return db; } } as never, workItem: validWorkItem(), contextView: { id: 'c', runId: 'nr_1', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: ['claim:c1'], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' }, workspacePath: 'C:/tmp/op-test', envelope: (await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws'), resolveAgent: () => undefined, resolveReviewer: () => new MockReviewerAdapter({ recommendation: 'candidate_a', evidenceSufficiency: 'partial' }), publishArtifact: () => 'artifact:1', ledger: new BudgetLedger((await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws')), emit: () => undefined, requestHumanGate: () => { throw new Error('unused'); } });
  assert.equal(result.status, 'succeeded');
  assert.equal((nodeRun.outputs as { review?: { recommendation: string } }).review?.recommendation, 'candidate_a');
  assert.equal(db.decisionRecords.length, 0);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（`OperatorContext.resolveReviewer` 加入契约）
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(operators): independent review produces verdicts, not decisions`

---

## Task 7：counterpoint_deliberation facade

**Files:** Create `src/operators/counterpoint-deliberation.ts`；Test `tests/unit/operators.test.ts` 追加（Mock 引擎闭环）

**Interfaces:**
- Produces: `class CounterpointDeliberationOperator implements Operator`（构造注入 `engine: ProtocolEngine`）
- Produces: `resume(ctx, gate, action: HumanGateAction, payload?: { selectedRefs?: string[]; rationale?: string }): Promise<OperatorResult>`
- 流程：`engine.createDeliberation({ projectId: workItem.workspaceId, ownerId: workItem.ownerId, problem: objective, goals: [objective], constraints: workItem.constraints, rubric: { items: [{ id: 'fit', name: 'fit', weight: 1 }], maxScore: 5 }, deliverable: 'decision', workItemId })` → 按 `workerCount` 加 worker、加 reviewer → `freezeTaskPacket` → `startBlindRun` → `reveal` → `finalizeChallenges` → `runVerification({ command: process.execPath, args: ['--version'], targetRefs: committed claim refs })` → `freezeEvidencePack` → `runReview` → `humanGatePolicy` 存在时 `ctx.requestHumanGate` 返回 `waiting_human`（outputs 带 `deliberationId`）；resume 调 `engine.humanDecision`；最终 outputs 带 `decisionRefs`

测试文件顶部补充导入：`ProtocolEngine`、`InMemoryStore`、`MockReviewerAdapter`、
`HumanGateRequest`（type）、`CounterpointDeliberationOperator`、`defaultAutonomyEnvelope`。

- [ ] **Step 1: 写失败测试**

```ts
test('deliberation facade drives the engine to a decision', async () => {
  const store = new InMemoryStore();
  const engine = new ProtocolEngine({
    store,
    seed: 'facade-test',
    workspaceRoot: 'C:/tmp/facade-test',
    resolveAdapter: (participant) =>
      participant.role === 'worker'
        ? new MockAgentAdapter(defaultWorkerAScript)
        : participant.role === 'reviewer'
          ? new MockReviewerAdapter({ recommendation: 'candidate_a', evidenceSufficiency: 'partial' })
          : undefined,
  });
  const project = engine.createProject({ name: 'Facade' });
  const workItem = engine.createWorkItem({ workspaceId: project.id, kind: 'decision', title: 'transport choice' });
  const db = engine.deliberationDatabase;
  const nodeRun = NodeRunSchema.parse({ id: 'nr_delib', workItemId: workItem.id, planId: 'plan_1', planVersion: 1, graphNodeId: 'gn_delib', role: 'Deliberation', operatorType: 'counterpoint_deliberation', status: 'running' });
  const gates: HumanGateRequest[] = [];
  const op = new CounterpointDeliberationOperator(engine);
  const ctx = {
    graphNode: { id: 'gn_delib', planNodeId: 'delib', role: 'Deliberation', objective: 'choose transport', dependsOn: [], inputRefs: [], contextPolicy: { visibility: 'blind' as const }, operator: { type: 'counterpoint_deliberation' as const, workerCount: 2, blind: true, commitReveal: true, challengeRounds: 0, verificationPolicy: 'version', reviewerPolicy: 'mock', humanGatePolicy: 'always' }, capabilityRequirements: [], completionCriteria: [], failurePolicy: { maxRetries: 0, onFailure: 'escalate' as const }, allocatedBudget: { maxTimeMs: 30_000 }, status: 'running' as const },
    nodeRun, db, store, workItem,
    contextView: { id: 'c', runId: 'nr_delib', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' },
    workspacePath: 'C:/tmp/facade-test',
    envelope: defaultAutonomyEnvelope(project.id),
    resolveAgent: () => new MockAgentAdapter(defaultWorkerAScript),
    resolveReviewer: () => new MockReviewerAdapter({}),
    publishArtifact: () => 'artifact:1',
    ledger: new BudgetLedger(defaultAutonomyEnvelope(project.id)),
    emit: () => undefined,
    requestHumanGate: (input) => { gates.push(input); return input; },
  };
  const paused = await op.run(ctx);
  assert.equal(paused.status, 'waiting_human');
  assert.equal(gates.length, 1);
  const finished = await op.resume(ctx, gates[0], 'approve_once');
  assert.equal(finished.status, 'succeeded');
  assert.equal(db.deliberations[0].state, 'decided');
});
```

说明：本 Operator 与引擎状态机耦合，完整闭环在 `tests/integration/m1-runner.test.ts`（Task 12）覆盖；本任务先验证「human gate → waiting_human → resume → decided」分支的最小驱动。步骤 2 的 RED 即模块缺失。

- [ ] **Step 2: RED**（模块不存在）
- [ ] **Step 3: 实现** facade；单测用 `createHarness` + Mock adapters 跑「freeze→start→reveal→verify→review→waiting_human→resume(approve)→decided」
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(operators): counterpoint deliberation facade with human gate resume`

---

## Task 8：human_gate Operator

**Files:** Create `src/operators/human-gate.ts`；Test `tests/unit/operators.test.ts` 追加

**Interfaces:**
- Produces: `class HumanGateOperator implements Operator`：`run` 创建并持久化 `HumanGateRequest`（kind=`high_risk`，summary=operator.summary），返回 `waiting_human`；`resume(ctx, gate, action)`：`approve_once/approve_work_item/modify_envelope` → `succeeded`（outputs.action），`reject_and_stop` → `failed`

- [ ] **Step 1: 写失败测试**

```ts
test('human gate operator pauses and resumes', async () => {
  const op = new HumanGateOperator();
  const { graph: node, db, nodeRun } = ctxFor('h');
  const requests: unknown[] = [];
  const base = { graphNode: { ...node, operator: { type: 'human_gate', summary: 'prod write needed' } }, nodeRun, db, store: { save() {}, load() { return db; } } as never, workItem: validWorkItem(), contextView: { id: 'c', runId: 'nr_1', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' }, workspacePath: 'C:/tmp/op-test', envelope: (await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws'), resolveAgent: () => undefined, publishArtifact: () => 'artifact:1', ledger: new BudgetLedger((await import('../../src/autonomy/autonomy-envelope.ts')).defaultAutonomyEnvelope('ws')), emit: () => undefined, requestHumanGate: (input) => { requests.push(input); return input; } };
  const result = await op.run(base);
  assert.equal(result.status, 'waiting_human');
  assert.equal(db.humanGateRequests.length, 1);
  const resumed = await op.resume(base, db.humanGateRequests[0], 'approve_once');
  assert.equal(resumed.status, 'succeeded');
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(operators): human gate operator`

---

## Task 9：Scheduler

**Files:** Create `src/execution/scheduler.ts`；Test `tests/unit/scheduler.test.ts`

**Interfaces:**
- Produces: `SchedulerOptions { db; store; envelope; operators: Map<OperatorKind, Operator>; ledger: BudgetLedger; maxParallelism: number; onEvent?; onNodeRunUpdate?; seed? }`
- Produces: `class Scheduler { constructor(options); attach(graph: ExecutionGraph, plan: CollaborationPlan, workItem: WorkItem): void; async runUntilIdle(): Promise<{ completed: boolean; waitingHuman: boolean }>; async resumeGate(runId: string, action: HumanGateAction, payload?): Promise<void>; getGraph(): ExecutionGraph }`
- 行为：只运行 `computeReadyNodes` 且 ≤ `maxParallelism`；每个 Run 前 `buildNodeContextView` + `ledger.startRun` + 记录 attempt；`waiting_human` 停止并等待 `resumeGate`；失败按 `failurePolicy`（`fail_node` / `cancel_pending_children` 传递取消 / `escalate` → human gate）；每次状态变化写 `db.nodeRuns` + `store.save` + 事件（`node.ready/run.started/run.finished/run.retried/human_gate.requested`）；构造时把上次 `running` 的 NodeRun 标记 `failed(error='recovered after restart')`

- [ ] **Step 1: 写失败测试（用两个假 Operator）**

```ts
// tests/unit/scheduler.test.ts（节选）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/execution/scheduler.ts';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { InMemoryStore } from '../../src/store.ts';
import { emptyDatabase, NodeRunSchema } from '../../src/schemas.ts';
import { defaultAutonomyEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import { makeNode, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import type { Operator, OperatorContext, OperatorResult } from '../../src/operators/operator.ts';

const ok: Operator = { type: 'agent_task', async run(ctx) { const run = dbFind(ctx); run.status = 'succeeded'; return { status: 'succeeded', artifactRefs: [], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {} }; } };
const gate: Operator = { type: 'human_gate', async run(ctx) { const run = dbFind(ctx); run.status = 'waiting_human'; return { status: 'waiting_human', artifactRefs: [], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {} }; } };
function dbFind(ctx: OperatorContext) { return ctx.db.nodeRuns.find((item) => item.id === ctx.nodeRun.id)!; }

test('scheduler runs ready nodes in dependency order', async () => {
  const db = emptyDatabase();
  const envelope = defaultAutonomyEnvelope('ws');
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const graph = compilePlan({ plan, catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]) });
  const scheduler = new Scheduler({ db, store: new InMemoryStore(), envelope, operators: new Map([['agent_task', ok]]), ledger: new BudgetLedger(envelope), maxParallelism: 2, seed: 't' });
  scheduler.attach(graph, plan, validWorkItem());
  await scheduler.runUntilIdle();
  assert.equal(scheduler.getGraph().nodes.every((node) => node.status === 'succeeded'), true);
  assert.equal(db.nodeRuns.length, 2);
  assert.equal(db.nodeRuns[0].status, 'succeeded');
});

test('scheduler stops at a human gate', async () => {
  const db = emptyDatabase();
  const envelope = defaultAutonomyEnvelope('ws');
  const plan = validPlan({ nodes: [makeNode({ id: 'h', operator: { type: 'human_gate', summary: 'need approval' } })] });
  const graph = compilePlan({ plan, catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]) });
  const scheduler = new Scheduler({ db, store: new InMemoryStore(), envelope, operators: new Map([['human_gate', gate]]), ledger: new BudgetLedger(envelope), maxParallelism: 1, seed: 't' });
  scheduler.attach(graph, plan, validWorkItem());
  const outcome = await scheduler.runUntilIdle();
  assert.equal(outcome.waitingHuman, true);
  assert.equal(db.humanGateRequests.length, 1);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（注意 `human_gate` Operator 自身持久化 request；Scheduler 只负责暂停/恢复语义）
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(execution): scheduler with readiness, parallelism and gates`

---

## Task 10：Replan Controller

**Files:** Create `src/execution/replan-controller.ts`；Test `tests/unit/replan-controller.test.ts`

**Interfaces:**
- Produces: `class ReplanController { constructor(options: { db; workItemId; plan: CollaborationPlan; envelope; catalog; evidenceIndex: Map<string, Evidence>; lineage?; maxPatches?: number }); submit(patch: PlanPatch): { updatedPlan: CollaborationPlan; validation: ValidationResult; applied: boolean } }`
- 规则：`patch.evidenceRefs` 必须全部解析（evidenceIndex 或 `db.evidence`/artifact 版本），否则 `applied: false` 且不产生计划；操作只允许改 `pending/ready` 节点；`request_additional_budget/request_human_gate` 返回 `validation.verdict === 'needs_human_approval'`；应用后 `plan.version + 1`、`PlanPatchSchema.status = 'applied'` 持久化、emit `plan_patch.applied`；已应用 patch 数 ≥ `maxPatches`（默认 5）时拒绝（`REPLAN_LIMIT`）

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/replan-controller.test.ts（节选）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ReplanController } from '../../src/execution/replan-controller.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validEnvelope, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import { emptyDatabase, EvidenceSchema, PlanPatchSchema } from '../../src/schemas.ts';

const catalog = catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }, { capability: 'verification', adapterKind: 'mock', tools: ['node'] }]);

test('patch with unresolvable evidence refs is rejected', () => {
  const plan = validPlan();
  const controller = new ReplanController({ db: emptyDatabase(), workItemId: 'wi_test', plan, envelope: validEnvelope(), catalog });
  const patch = PlanPatchSchema.parse({ id: 'p1', basePlanVersion: 1, reason: 'x', evidenceRefs: ['evidence:missing'], operations: [{ op: 'cancel_pending_node', nodeId: 'repro', reason: 'refuted' }], proposedByRunId: 'nr_1', createdAt: 't' });
  const outcome = controller.submit(patch);
  assert.equal(outcome.applied, false);
  assert.equal(outcome.updatedPlan.version, 1);
});

test('evidence-grounded patch increments the plan and applies the change', () => {
  const db = emptyDatabase();
  const evidence = EvidenceSchema.parse({ id: 'evid_1', workItemId: 'wi_test', planId: 'plan_test', nodeRunId: 'nr_1', kind: 'command_result', source: { command: 'node', args: [] }, targetRefs: [], result: { exitCode: 0 }, status: 'verified', hash: 'h', createdAt: 't' });
  db.evidence.push(evidence);
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const controller = new ReplanController({ db, workItemId: 'wi_test', plan, envelope: validEnvelope(), catalog, evidenceIndex: new Map([['evid_1', evidence]]) });
  const patch = PlanPatchSchema.parse({ id: 'p2', basePlanVersion: 1, reason: 'experiment refuted b', evidenceRefs: ['evid_1'], operations: [{ op: 'cancel_pending_node', nodeId: 'b', reason: 'refuted' }], proposedByRunId: 'nr_1', createdAt: 't' });
  const outcome = controller.submit(patch);
  assert.equal(outcome.applied, true);
  assert.equal(outcome.updatedPlan.version, 2);
  assert.equal(outcome.updatedPlan.nodes.length, 1);
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（补 `db.plans` 版本追加与 `db.planPatches` 持久化）
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(execution): evidence-gated replan controller`

---

## Task 11：Stop Condition 与 DecisionRecord

**Files:** Create `src/planning/stop-condition.ts`；Test `tests/unit/stop-condition.test.ts`

**Interfaces:**
- Produces: `evaluateStopConditions(opts: { plan; db; graph }): { satisfied: boolean; outcome?: DecisionOutcome; matched: StopCondition[] }`
- Produces: `recordDecision(db, input: { workItemId; planId; planVersion; outcome; summary; refs; conditions; ownerId }): DecisionRecord`（append + emit 由调用方处理）
- 匹配规则：`evidence`（refs 全为 `verified`）/ `artifact`（registry 有版本）/ `decision`（db.decisionRecords 存在）/ `human_acceptance`（存在 approved gate）/ `budget_exhausted`（ledger 参数传入）；命中顺序取第一个，`satisfied = matched.length > 0`

- [ ] **Step 1: 写失败测试**

```ts
// tests/unit/stop-condition.test.ts（节选）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateStopConditions, recordDecision } from '../../src/planning/stop-condition.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan } from '../helpers/plan-fixtures.ts';
import { emptyDatabase, EvidenceSchema } from '../../src/schemas.ts';

test('verified evidence satisfies the evidence stop condition', () => {
  const db = emptyDatabase();
  const evidence = EvidenceSchema.parse({ id: 'evid_1', workItemId: 'wi_test', planId: 'plan_test', nodeRunId: 'nr_1', kind: 'command_result', source: { command: 'node', args: [] }, targetRefs: [], result: { exitCode: 0 }, status: 'verified', hash: 'h', createdAt: 't' });
  db.evidence.push(evidence);
  const plan = validPlan({ stopConditions: [{ id: 's1', kind: 'evidence', description: 'root cause', refs: ['evid_1'], targetOutcome: 'resolved' }] });
  const graph = compilePlan({ plan, catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]) });
  const evaluation = evaluateStopConditions({ plan, db, graph });
  assert.equal(evaluation.satisfied, true);
  assert.equal(evaluation.outcome, 'resolved');
});

test('succeeded nodes alone do not create a decision', () => {
  const db = emptyDatabase();
  const plan = validPlan();
  const graph = compilePlan({ plan, catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]) });
  graph.nodes[0].status = 'succeeded';
  assert.equal(evaluateStopConditions({ plan, db, graph }).satisfied, false);
  assert.equal(db.decisionRecords.length, 0);
});

test('recordDecision appends an immutable decision record', () => {
  const db = emptyDatabase();
  const decision = recordDecision(db, { workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, outcome: 'resolved', summary: 'root cause verified', refs: ['evid_1'], conditions: [], ownerId: 'human' });
  assert.equal(db.decisionRecords.length, 1);
  assert.equal(decision.outcome, 'resolved');
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**
- [ ] **Step 4: GREEN** + typecheck
- [ ] **Step 5: Commit** `feat(planning): stop conditions and decision records`

---

## Task 12：WorkItemRunner 集成

**Files:** Create `src/execution/work-item-runner.ts`；Test `tests/integration/m1-runner.test.ts`

**Interfaces:**
- Produces: `class WorkItemRunner { constructor(options: { store: Store; engine: ProtocolEngine; catalog; planner: Planner; envelopeFactory?: (workItem) => AutonomyEnvelope; operatorsOverride?: Map<OperatorKind, Operator>; onEvent?; onRunUpdate? }); async run(workItemId: string): Promise<{ outcome: 'running' | 'waiting_human' | DecisionOutcome; decision?: DecisionRecord }>; resumeHumanGate(gateId: string, action: HumanGateAction, payload?): Promise<void> }`
- 流程：冻结 WorkItem → PlannerOrchestrator（事件 `plan.proposed/plan.validation_failed/plan.validated`）→ `compilePlan`（`graph.compiled`）→ Scheduler.attach/runUntilIdle；`waiting_human` 时返回等待；节点成功但 Stop 未满足且无失败时按 `escalationConditions`/预算判断是否 escalation；Stop 满足 → `recordDecision` + WorkItem.status 映射（resolved/partially_resolved/needs_evidence 等）+ `decision.recorded`；`plan.validation_failed` 且修复后仍失败 → status `blocked`

- [ ] **Step 1: 写失败测试（Mock 全链路）**

```ts
// tests/integration/m1-runner.test.ts（节选）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { InMemoryStore } from '../../src/store.ts';
import { MockPlanner } from '../../src/planning/planner.ts';
import { WorkItemRunner } from '../../src/execution/work-item-runner.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { defaultAutonomyEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import { makeNode, validPlan } from '../helpers/plan-fixtures.ts';

test('runner plans, schedules and records a decision', async () => {
  const store = new InMemoryStore();
  const engine = new ProtocolEngine({ store, workspaceRoot: 'C:/tmp/m1-runner', resolveAdapter: () => undefined });
  const project = engine.createProject({ name: 'M1' });
  const workItem = engine.createWorkItem({ workspaceId: project.id, kind: 'bug', title: 'bug', goal: 'verify' });
  const db = engine.deliberationDatabase;
  db.autonomyEnvelopes.push(defaultAutonomyEnvelope(project.id));
  // 计划：一个 verification 节点产出证据，stopCondition 引用该证据
  const plan = validPlan({
    workItemId: workItem.id,
    nodes: [makeNode({ id: 'v', operator: { type: 'verification', command: process.execPath, args: ['--version'], targetRefs: [] } })],
    stopConditions: [{ id: 's1', kind: 'evidence', description: 'verified', refs: ['evidence:v1'], targetOutcome: 'resolved' }],
  });
  // verification operator 在 Task 5 中把证据 id 写回 nodeRun.evidenceRefs；此处用脚本化 operator 保证 ref 固定
  const scripted = { type: 'verification', async run(ctx) { ctx.db.evidence.push({ id: 'evidence:v1', workItemId: workItem.id, planId: plan.id, nodeRunId: ctx.nodeRun.id, kind: 'command_result', source: { command: 'node', args: [] }, targetRefs: [], result: { exitCode: 0 }, status: 'verified', hash: 'h', createdAt: 't' }); return { status: 'succeeded', artifactRefs: [], evidenceRefs: ['evidence:v1'], claimRefs: [], opinionRefs: [], outputs: {} }; } };
  const runner = new WorkItemRunner({ store, engine, catalog: catalogFromEntries([{ capability: 'verification', adapterKind: 'mock', tools: ['node'] }]), planner: new MockPlanner(() => plan), operatorsOverride: new Map([['verification', scripted]]) });
  const outcome = await runner.run(workItem.id);
  assert.equal(outcome.outcome, 'resolved');
  assert.equal(db.decisionRecords.length, 1);
  assert.equal(engine.getWorkItem(workItem.id).status, 'resolved');
});
```

- [ ] **Step 2: RED** → **Step 3: 实现**（runner 构造真实 registry，测试用 `operatorsOverride`）
- [ ] **Step 4: GREEN** + typecheck + 全量 `npm test`
- [ ] **Step 5: Commit** `feat(execution): work item runner wires planner, scheduler and decisions`

---

## Task 13：M1 真实垂直切片

**Files:** Create `apps/cli/m1-slice.ts`；Modify `package.json`（`"slice:m1": "node apps/cli/m1-slice.ts"`）、`README.md`

**行为（与 spec §10 M1 一致，真实模型）：**

- 复杂 Bug Fixture（复用 `PROBE_FIXTURES[1]`）；Planner = Claude Code `deepseek-v4-flash` + `--tools ""`（`PLANNER_MODEL` 可覆盖）；
- Worker = Chrys + Claude Code（`CHRYS_BIN/CLAUDE_BIN`，沿用 `real-slice.ts` 参数）；Reviewer = Claude Code；Verification = 真实 `npm run typecheck` / `npm test`；
- 计划中放入一个 `agent_task`「Replan Proposer」：其输出契约含 `planPatch` JSON（引用已验证 Evidence 的 id）；Runner 在节点成功后提交 `ReplanController.submit`；若 Agent 未产出合法 patch，脚本化回退 patch 引用同一条 Evidence；
- 完成条件：至少一次 Evidence-grounded PlanPatch 被应用、Scheduler 增量取消/新增节点、Stop Condition 满足 → `DecisionRecord`（与 Reviewer Verdict 分开展示）；
- 报告写入 `docs/m1-autonomous-slice/`（plan 演化、每个 NodeRun 的 attempts/cost、Context Leak Count = 0、Decision 引用解析）；
- 完成后按 §9.1 执行 `npm run probe:planner -- --fresh --strict` 一次全新验收并归档报告（预计 ≤ 20 分钟时间预算，成本 ≤ $6）。

- [ ] **Step 1: 写失败测试**（`tests/unit/m1-slice.test.ts`：断言脚本加载 Fixture、patch fallback 构造合法且 evidenceRefs 解析）
- [ ] **Step 2: RED** → **Step 3: 实现** slice 脚本
- [ ] **Step 4: 离线验证**：`npm run typecheck && npm test`（不调用真实 CLI）
- [ ] **Step 5: 人工真实运行**：`npm run slice:m1`（预算/时间护栏同探测：总 $10、30 分钟）；然后 `npm run probe:planner -- --fresh --strict`
- [ ] **Step 6: Commit** `feat(cli): m1 autonomous vertical slice with real agents`

---

## 测试计划与验收

- 回归：`npm run typecheck`、`npm test`（155 + 新增，全绿）。
- M1 DoD：目标→规划→验证→编译→调度→改计划→决策全自动；≥1 次 Evidence-grounded PlanPatch；每个 Run 有 Context View、泄漏 = 0；Reviewer 独立性按血缘验证；重启恢复（`running` → `failed`）；`DecisionRecord` 引用可解析；`--fresh --strict` 探测全量通过语义拓扑断言。

## 执行方式说明

本环境子代理消息通道不可用（M0 已验证），因此执行采用 **Inline Execution**（`executing-plans`），由 /root 逐任务 TDD + 提交；隔离 worktree 在开始实现时创建。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-counterpoint-v02-m1-autonomous-slice.md`。在本环境仅提供 Inline Execution（子代理通道故障）。
