# Counterpoint v0.2 M0 Planning Contract Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 交付可验证、可编译、可被确定性宪法裁决的规划契约：Autonomy Envelope、Collaboration Plan/Node/Patch Schema、Plan Validator、Graph Compiler，并用真实 Chrys 与 Claude Code 跑通 Planner 探测。

**Architecture:** 控制面（planning/）与授权面（autonomy/）为纯 TypeScript 模块；`ProtocolEngine` 只在其 `loadDatabase` 挂接 v0.2 迁移，内核逻辑不改。Planner 是一个接口，真实 CLI 实现复用现有 `runCliProcess` / `extractClaudeResult` / `extractChrysResult`；Mock Planner 仅存在于单元测试。效果验证（真实模型能否产出合法且随任务变化的计划）由 `apps/cli/planner-probe.ts` 完成，不进 CI。

**Tech Stack:** TypeScript 5.9、Zod 3.24、Node ≥22.18、`node:test`、npm scripts；真实 Agent 为 Chrys（`chrys run -a Code --json`）与 Claude Code（`claude -p --output-format json`）。

**Spec:** `docs/superpowers/specs/2026-08-13-counterpoint-v02-planning-design.md`

## Global Constraints

- `ProtocolEngine` 的协议状态机、Context Policy、Commit–Reveal、评审、事件链与 Decision Pack 逻辑**不改**；仅改 `loadDatabase` 的迁移链与 `createWorkItem` 入参。
- 计划合法性只由纯函数 `validatePlan` 决定，Validator 与 Compiler 不调用任何模型；`rationale` 不参与裁决。
- `private / blind / sealed` 对象不得被未授权节点引用；独立性按血缘/能力而非角色名检查。
- Schema `schemaVersion` 升至 `0.2.0`；旧数据必须经 `migrateDatabaseV2` 解析，`investigating` 状态映射为 `running`。
- **真实模型只用于 `planner-probe.ts`（L1）与 M1 切片（L2）；Mock Planner 只用于单元测试；`npm test` 不得调用任何真实 CLI。**
- 探测预算硬上限 $6，单次 Planner 调用超时 10 分钟，修复循环上限 2 次。
- 现有测试基线保持通过：`npm run typecheck`、`npm test`（107 项）；每任务新增测试并逐任务提交。

---

## File Structure

Create:

- `src/autonomy/autonomy-envelope.ts` — Envelope/Sharing/Network schema、`defaultAutonomyEnvelope`、`tightenEnvelope`
- `src/autonomy/risk-policy.ts` — RiskPolicy schema、`classifyRisk`、`requiresReview`、`requiresHumanGate`
- `src/autonomy/human-gate.ts` — HumanGateRequest schema 与类型
- `src/planning/schemas.ts` — Plan/Node/OperatorSpec/ContextPolicy v2/完成与停止条件/预算契约
- `src/planning/plan-patch.ts` — PlanOperation/PlanPatch schema
- `src/planning/capabilities.ts` — CapabilityCatalog
- `src/planning/plan-validator.ts` — 六道宪法检查与 `validatePlan`
- `src/planning/planner.ts` — `Planner` 接口、`PlannerOrchestrator`、`MockPlanner`（测试专用）
- `src/planning/planner-prompt.ts` — `renderPlannerPrompt`
- `src/planning/cli-planner.ts` — `CliPlannerAdapter`（真实 Chrys/Claude）
- `src/execution/execution-graph.ts` — ExecutionGraph/GraphNode 类型、`computeReadyNodes`
- `src/execution/graph-compiler.ts` — `compilePlan`
- `apps/cli/planner-fixtures.ts` — 探测 Fixture 与 `topologySignature`
- `apps/cli/planner-probe.ts` — L1 真实 Planner 探测

Modify:

- `src/schemas.ts` — WorkItem v2 字段、状态机扩展、EvidenceScope、Opinion、Database v0.2、`migrateDatabaseV2`
- `src/protocol-engine.ts` — `loadDatabase` 与 `createWorkItem`
- `package.json` — `probe:planner` 脚本
- `README.md` — M0 完成状态

Test:

- `tests/helpers/plan-fixtures.ts` — 合法 Plan/Envelope/WorkItem 构造器
- `tests/unit/autonomy-envelope.test.ts`、`tests/unit/work-item-v2.test.ts`、
  `tests/unit/evidence-opinion.test.ts`、`tests/unit/planning-schemas.test.ts`、
  `tests/unit/plan-patch.test.ts`、`tests/unit/database-v2.test.ts`、
  `tests/unit/plan-validator.test.ts`、`tests/unit/graph-compiler.test.ts`、
  `tests/unit/planner-orchestrator.test.ts`、`tests/unit/cli-planner.test.ts`
- `tests/fixtures/fake-planner-claude.mjs`、`tests/fixtures/fake-planner-chrys.mjs`

---

## Task 1: Autonomy Envelope + Risk Policy + Human Gate

**Files:**
- Create: `src/autonomy/autonomy-envelope.ts`, `src/autonomy/risk-policy.ts`, `src/autonomy/human-gate.ts`
- Test: `tests/unit/autonomy-envelope.test.ts`

**Interfaces:**
- Produces: `AutonomyEnvelopeSchema` / `type AutonomyEnvelope`
- Produces: `AutonomyEnvelopeOverrides = Partial<Pick<AutonomyEnvelope, 'maxAgents' | 'maxParallelism' | 'maxRounds' | 'tokenBudget' | 'costBudget' | 'timeBudgetMs' | 'allowedTools' | 'allowedActions' | 'writableScopes' | 'networkPolicy' | 'riskPolicy' | 'sharingPolicy'>>`
- Produces: `defaultAutonomyEnvelope(workspaceId: string): AutonomyEnvelope`
- Produces: `tightenEnvelope(base: AutonomyEnvelope, overrides: AutonomyEnvelopeOverrides): AutonomyEnvelope` —— 数值只能变小、数组只能是子集、`networkPolicy` 只能沿 `allow → allowlist → deny` 收紧，违反即抛错
- Produces: `RiskPolicySchema` / `type RiskPolicy`
- Produces: `classifyRisk(action: string, policy: RiskPolicy): 'low' | 'medium' | 'high'`
- Produces: `requiresReview(action: string, policy: RiskPolicy): boolean`
- Produces: `requiresHumanGate(action: string, policy: RiskPolicy): boolean`
- Produces: `HumanGateRequestSchema` / `type HumanGateRequest` / `type HumanGateKind` / `type HumanGateAction`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/autonomy-envelope.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomyEnvelopeSchema,
  defaultAutonomyEnvelope,
  tightenEnvelope,
} from '../../src/autonomy/autonomy-envelope.ts';
import {
  classifyRisk,
  requiresHumanGate,
  requiresReview,
} from '../../src/autonomy/risk-policy.ts';
import { HumanGateRequestSchema } from '../../src/autonomy/human-gate.ts';

test('default envelope parses and tightens numeric limits downward', () => {
  const base = defaultAutonomyEnvelope('ws_1');
  const tightened = tightenEnvelope(base, { maxAgents: 2, timeBudgetMs: 60_000 });
  assert.equal(tightened.maxAgents, 2);
  assert.equal(tightened.timeBudgetMs, 60_000);
  assert.equal(AutonomyEnvelopeSchema.safeParse(tightened).success, true);
});

test('tightenEnvelope rejects widening a numeric budget', () => {
  const base = defaultAutonomyEnvelope('ws_1');
  assert.throws(() => tightenEnvelope(base, { maxAgents: base.maxAgents + 1 }), /widen/);
});

test('tightenEnvelope rejects adding a tool outside the base allowlist', () => {
  const base = defaultAutonomyEnvelope('ws_1');
  assert.throws(() => tightenEnvelope(base, { allowedTools: [...base.allowedTools, 'curl'] }), /subset|widen/);
});

test('risk policy classifies actions and requires gates', () => {
  const policy = { highRiskActions: ['git push'], requireReviewFor: ['rm'], requireHumanGateFor: ['git push'] };
  assert.equal(classifyRisk('git push', policy), 'high');
  assert.equal(requiresHumanGate('git push', policy), true);
  assert.equal(requiresReview('rm', policy), true);
  assert.equal(requiresHumanGate('npm test', policy), false);
});

test('human gate request parses with defaults', () => {
  const request = HumanGateRequestSchema.parse({
    id: 'hg_1',
    workItemId: 'wi_1',
    planId: 'plan_1',
    kind: 'permission_escalation',
    summary: 'Need write access to prod config',
    requested: { scope: 'prod' },
  });
  assert.equal(request.status, 'pending');
  assert.deepEqual(request.availableActions, ['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/autonomy-envelope.test.ts`
Expected: FAIL，`Cannot find module '../../src/autonomy/autonomy-envelope.ts'`

- [ ] **Step 3: Write minimal implementation**

```ts
// src/autonomy/autonomy-envelope.ts
import { z } from 'zod';
import { newId } from '../ids.ts';

export const NetworkPolicySchema = z.enum(['deny', 'allowlist', 'allow']);
export const RiskPolicySchema = z.object({
  highRiskActions: z.array(z.string()).default([]),
  requireReviewFor: z.array(z.string()).default([]),
  requireHumanGateFor: z.array(z.string()).default([]),
});
export type RiskPolicy = z.infer<typeof RiskPolicySchema>;

export const SharingPolicySchema = z.object({
  defaultVisibility: z.enum(['shared', 'private', 'blind', 'sealed']).default('shared'),
  allowedVisibility: z
    .array(z.enum(['shared', 'private', 'blind', 'sealed']))
    .default(['shared', 'private', 'blind', 'sealed']),
});

export const AutonomyEnvelopeSchema = z.object({
  id: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1).default('default'),
  maxAgents: z.number().int().positive(),
  maxParallelism: z.number().int().positive(),
  maxRounds: z.number().int().nonnegative(),
  tokenBudget: z.number().positive().optional(),
  costBudget: z.number().positive().optional(),
  timeBudgetMs: z.number().int().positive(),
  allowedTools: z.array(z.string()).default([]),
  allowedActions: z.array(z.string()).default([]),
  writableScopes: z.array(z.string()).default([]),
  networkPolicy: NetworkPolicySchema.default('deny'),
  riskPolicy: RiskPolicySchema.default({ highRiskActions: [], requireReviewFor: [], requireHumanGateFor: [] }),
  sharingPolicy: SharingPolicySchema.default({
    defaultVisibility: 'shared',
    allowedVisibility: ['shared', 'private', 'blind', 'sealed'],
  }),
});
export type AutonomyEnvelope = z.infer<typeof AutonomyEnvelopeSchema>;
export type AutonomyEnvelopeOverrides = Partial<
  Pick<AutonomyEnvelope, 'maxAgents' | 'maxParallelism' | 'maxRounds' | 'tokenBudget' | 'costBudget' | 'timeBudgetMs' | 'allowedTools' | 'allowedActions' | 'writableScopes' | 'networkPolicy' | 'riskPolicy' | 'sharingPolicy'>
>;

export function defaultAutonomyEnvelope(workspaceId: string): AutonomyEnvelope {
  return AutonomyEnvelopeSchema.parse({
    id: newId('env'),
    workspaceId,
    maxAgents: 4,
    maxParallelism: 2,
    maxRounds: 3,
    timeBudgetMs: 20 * 60_000,
    allowedTools: ['node', 'npm', 'git', 'rg', 'python'],
    allowedActions: ['read_sources', 'write_scratch', 'run_tests'],
    writableScopes: ['data/scratch'],
    networkPolicy: 'deny',
    riskPolicy: { highRiskActions: ['git push'], requireReviewFor: [], requireHumanGateFor: ['git push'] },
  });
}

const NETWORK_ORDER: Record<string, number> = { allow: 2, allowlist: 1, deny: 0 };

export function tightenEnvelope(base: AutonomyEnvelope, overrides: AutonomyEnvelopeOverrides): AutonomyEnvelope {
  const next: AutonomyEnvelope = { ...base };
  for (const key of ['maxAgents', 'maxParallelism', 'maxRounds', 'tokenBudget', 'costBudget', 'timeBudgetMs'] as const) {
    const value = overrides[key];
    if (value === undefined) continue;
    const current = base[key] as number | undefined;
    if (current !== undefined && (value as number) > current) {
      throw new Error(`Cannot widen ${key} from ${current} to ${value}`);
    }
    (next as unknown as Record<string, unknown>)[key] = value;
  }
  for (const key of ['allowedTools', 'allowedActions', 'writableScopes'] as const) {
    const value = overrides[key];
    if (value === undefined) continue;
    const missing = value.filter((item) => !base[key].includes(item));
    if (missing.length) throw new Error(`Cannot widen ${key}: not in base ${missing.join(', ')}`);
    next[key] = [...value];
  }
  if (overrides.networkPolicy !== undefined) {
    if (NETWORK_ORDER[overrides.networkPolicy] > NETWORK_ORDER[base.networkPolicy]) {
      throw new Error(`Cannot widen networkPolicy from ${base.networkPolicy} to ${overrides.networkPolicy}`);
    }
    next.networkPolicy = overrides.networkPolicy;
  }
  if (overrides.riskPolicy !== undefined) {
    next.riskPolicy = {
      highRiskActions: [...new Set([...base.riskPolicy.highRiskActions, ...overrides.riskPolicy.highRiskActions])],
      requireReviewFor: [...new Set([...base.riskPolicy.requireReviewFor, ...overrides.riskPolicy.requireReviewFor])],
      requireHumanGateFor: [...new Set([...base.riskPolicy.requireHumanGateFor, ...overrides.riskPolicy.requireHumanGateFor])],
    };
  }
  if (overrides.sharingPolicy !== undefined) {
    const allowed = overrides.sharingPolicy.allowedVisibility ?? base.sharingPolicy.allowedVisibility;
    const missing = allowed.filter((item) => !base.sharingPolicy.allowedVisibility.includes(item));
    if (missing.length) throw new Error(`Cannot widen sharing visibility: ${missing.join(', ')}`);
    next.sharingPolicy = {
      defaultVisibility: overrides.sharingPolicy.defaultVisibility ?? base.sharingPolicy.defaultVisibility,
      allowedVisibility: [...allowed],
    };
  }
  return AutonomyEnvelopeSchema.parse(next);
}
```

```ts
// src/autonomy/risk-policy.ts
import type { RiskPolicy } from './autonomy-envelope.ts';

export function classifyRisk(action: string, policy: RiskPolicy): 'low' | 'medium' | 'high' {
  if (policy.highRiskActions.includes(action)) return 'high';
  if (policy.requireHumanGateFor.includes(action)) return 'high';
  if (policy.requireReviewFor.includes(action)) return 'medium';
  return 'low';
}

export function requiresReview(action: string, policy: RiskPolicy): boolean {
  return policy.requireReviewFor.includes(action);
}

export function requiresHumanGate(action: string, policy: RiskPolicy): boolean {
  return policy.highRiskActions.includes(action) || policy.requireHumanGateFor.includes(action);
}
```

```ts
// src/autonomy/human-gate.ts
import { z } from 'zod';

export const HumanGateKindSchema = z.enum([
  'permission_escalation',
  'budget_escalation',
  'high_risk',
  'indecision',
  'human_accountability',
]);
export type HumanGateKind = z.infer<typeof HumanGateKindSchema>;

export const HumanGateActionSchema = z.enum([
  'approve_once',
  'approve_work_item',
  'modify_envelope',
  'reject_and_stop',
]);
export type HumanGateAction = z.infer<typeof HumanGateActionSchema>;

export const HumanGateRequestSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  planId: z.string().min(1),
  nodeId: z.string().optional(),
  kind: HumanGateKindSchema,
  summary: z.string().min(1),
  requested: z.record(z.unknown()),
  availableActions: z.array(HumanGateActionSchema).default(['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop']),
  status: z.enum(['pending', 'approved', 'rejected', 'modified']).default('pending'),
  createdAt: z.string(),
  resolvedAt: z.string().optional(),
  decisionRef: z.string().optional(),
  reason: z.string().optional(),
});
export type HumanGateRequest = z.infer<typeof HumanGateRequestSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/autonomy-envelope.test.ts`
Expected: PASS（5/5）

- [ ] **Step 5: Commit**

```bash
git add src/autonomy tests/unit/autonomy-envelope.test.ts
git commit -m "feat(autonomy): envelope, risk policy and human gate contracts"
```

---

## Task 2: WorkItem v2 字段与状态机

**Files:**
- Modify: `src/schemas.ts`, `src/protocol-engine.ts`
- Test: `tests/unit/work-item-v2.test.ts`

**Interfaces:**
- Modifies: `WorkItemStatusSchema` 扩展为 `'draft' | 'open' | 'planning' | 'running' | 'waiting_human' | 'blocked' | 'resolved' | 'partially_resolved' | 'rejected' | 'needs_evidence' | 'archived' | 'investigating'`（`investigating` 为 legacy，仅供旧数据解析）
- Modifies: `WorkItemSchema` 增加 `goal?: string`、`constraints: string[]`（default []）、`expectedOutcomes: string[]`（default []）、`sourceRefs: string[]`（default []）、`autonomyEnvelopeId?: string`
- Modifies: `ProtocolEngine.createWorkItem(input)` 增加 `goal?, constraints?, expectedOutcomes?, sourceRefs?, autonomyEnvelopeId?`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/work-item-v2.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../../src/store.ts';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { WorkItemSchema } from '../../src/schemas.ts';

function engine(): ProtocolEngine {
  return new ProtocolEngine({
    store: new InMemoryStore(),
    workspaceRoot: 'C:/tmp/counterpoint-workitem-v2',
    resolveAdapter: () => undefined,
  });
}

test('WorkItem v2 parses goal, constraints, expected outcomes and envelope id', () => {
  const workItem = WorkItemSchema.parse({
    id: 'wi_1',
    workspaceId: 'ws_1',
    kind: 'bug',
    title: 'Inventory sync drops data intermittently',
    ownerId: 'human',
    status: 'open',
    goal: 'Locate a verifiable root cause',
    constraints: ['No production access'],
    expectedOutcomes: ['Root cause + regression plan'],
    sourceRefs: ['src_inventory@v1'],
    autonomyEnvelopeId: 'env_1',
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  });
  assert.equal(workItem.goal, 'Locate a verifiable root cause');
  assert.equal(workItem.autonomyEnvelopeId, 'env_1');
});

test('createWorkItem accepts v2 fields', () => {
  const e = engine();
  const project = e.createProject({ name: 'P' });
  const workItem = e.createWorkItem({
    workspaceId: project.id,
    kind: 'bug',
    title: 'Bug',
    goal: 'Find root cause',
    constraints: ['No prod'],
    expectedOutcomes: ['Fix plan'],
    sourceRefs: ['src_a@v1'],
    autonomyEnvelopeId: 'env_1',
  });
  assert.deepEqual(workItem.constraints, ['No prod']);
  assert.deepEqual(workItem.expectedOutcomes, ['Fix plan']);
  assert.deepEqual(workItem.sourceRefs, ['src_a@v1']);
  assert.equal(workItem.autonomyEnvelopeId, 'env_1');
});

test('new statuses parse and legacy investigating still parses', () => {
  assert.equal(WorkItemSchema.safeParse({ ...minimalWorkItem(), status: 'planning' }).success, true);
  assert.equal(WorkItemSchema.safeParse({ ...minimalWorkItem(), status: 'investigating' }).success, true);
});

function minimalWorkItem(): Record<string, unknown> {
  return {
    id: 'wi_2',
    workspaceId: 'ws_2',
    kind: 'problem',
    title: 'P',
    ownerId: 'human',
    status: 'open',
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/work-item-v2.test.ts`
Expected: FAIL，`goal` 在 Schema 未定义时被剥离，`workItem.goal` 断言为 `undefined`；`createWorkItem` 返回对象缺 v2 字段

- [ ] **Step 3: Write minimal implementation**

在 `src/schemas.ts`：

```ts
export const WorkItemStatusSchema = z.enum([
  'draft',
  'open',
  'planning',
  'running',
  'waiting_human',
  'blocked',
  'resolved',
  'partially_resolved',
  'rejected',
  'needs_evidence',
  'archived',
  'investigating', // legacy: migrated to 'running' by migrateDatabaseV2
]);
```

在 `WorkItemSchema` 的 `description` 之后插入：

```ts
  goal: z.string().optional(),
  constraints: z.array(z.string()).default([]),
  expectedOutcomes: z.array(z.string()).default([]),
  sourceRefs: z.array(z.string()).default([]),
  autonomyEnvelopeId: z.string().optional(),
```

在 `src/protocol-engine.ts` 的 `createWorkItem(input)` 中，input 类型增加五个可选字段，构造对象增加：

```ts
      goal: input.goal,
      constraints: input.constraints ?? [],
      expectedOutcomes: input.expectedOutcomes ?? [],
      sourceRefs: input.sourceRefs ?? [],
      autonomyEnvelopeId: input.autonomyEnvelopeId,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/work-item-v2.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Run regression and commit**

Run: `npm run typecheck && npm test`
Expected: 全绿

```bash
git add src/schemas.ts src/protocol-engine.ts tests/unit/work-item-v2.test.ts
git commit -m "feat(schemas): work item v2 fields and statuses"
```

---

## Task 3: EvidenceScope 与 Opinion

**Files:**
- Modify: `src/schemas.ts`
- Test: `tests/unit/evidence-opinion.test.ts`

**Interfaces:**
- Modifies: `EvidenceSchema` 增加可选 `scope: { sourceVersionRefs: string[]; appliesWhen: string[]; invalidatedWhen?: string[]; expiresAt?: string }`
- Produces: `OpinionSchema` / `type Opinion`：`{ id, workItemId, statement, rationale, authorRunId?, author, createdAt }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/evidence-opinion.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceSchema, OpinionSchema } from '../../src/schemas.ts';

test('evidence accepts a scope with applicability conditions', () => {
  const evidence = EvidenceSchema.parse({
    id: 'evid_1',
    deliberationId: 'delib_1',
    kind: 'command_result',
    source: { command: 'node', args: ['-e', '1'] },
    targetRefs: ['claim:1'],
    result: { exitCode: 0 },
    status: 'verified',
    hash: 'h',
    createdAt: '2026-08-13T00:00:00.000Z',
    scope: {
      sourceVersionRefs: ['src_inventory@v1'],
      appliesWhen: ['sync adapter version 2.x'],
      invalidatedWhen: ['schema migration v3'],
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
  });
  assert.equal(evidence.scope?.expiresAt, '2026-12-31T00:00:00.000Z');
});

test('opinion is a separate object from claim', () => {
  const parsed = OpinionSchema.parse({
    id: 'op_1',
    workItemId: 'wi_1',
    statement: 'Synchronous calls are preferable here',
    rationale: 'Simpler rollback within one transaction',
    authorRunId: 'run_1',
    author: 'worker-a',
    createdAt: '2026-08-13T00:00:00.000Z',
    kind: 'claim',
  });
  assert.equal(parsed.statement.startsWith('Synchronous'), true);
  assert.equal('kind' in parsed, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/evidence-opinion.test.ts`
Expected: FAIL，`scope` 字段未知、`OpinionSchema` 未定义

- [ ] **Step 3: Write minimal implementation**

在 `EvidenceSchema` 的 `createdAt` 前插入：

```ts
  scope: z
    .object({
      sourceVersionRefs: z.array(z.string()).default([]),
      appliesWhen: z.array(z.string()).default([]),
      invalidatedWhen: z.array(z.string()).optional(),
      expiresAt: z.string().optional(),
    })
    .optional(),
```

在 `DecisionSchema` 之后追加：

```ts
export const OpinionSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  statement: z.string().min(1),
  rationale: z.string().min(1),
  authorRunId: z.string().optional(),
  author: z.string().min(1),
  createdAt: z.string(),
});
export type Opinion = z.infer<typeof OpinionSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/evidence-opinion.test.ts`
Expected: PASS（2/2）

- [ ] **Step 5: Commit**

```bash
git add src/schemas.ts tests/unit/evidence-opinion.test.ts
git commit -m "feat(schemas): evidence scope and opinion object"
```

---

## Task 4: Planning Schemas

**Files:**
- Create: `src/planning/schemas.ts`
- Test: `tests/unit/planning-schemas.test.ts`

**Interfaces:**
- Produces: `NodeContextPolicySchema` / `type NodeContextPolicy`
- Produces: `OperatorKind`、各 Operator Spec Schema、`OperatorSpecSchema` / `type OperatorSpec`
- Produces: `CompletionCriterionSchema`、`FailurePolicySchema`、`NodeBudgetSchema`
- Produces: `CollaborationNodeSchema` / `type CollaborationNode`
- Produces: `StopConditionSchema`、`EscalationConditionSchema`、`BudgetAllocationSchema`
- Produces: `PlanStatusSchema`、`CollaborationPlanSchema` / `type CollaborationPlan`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/planning-schemas.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CollaborationPlanSchema,
  CounterpointDeliberationSpecSchema,
  OperatorSpecSchema,
} from '../../src/planning/schemas.ts';

test('a valid plan with a deliberation node parses', () => {
  const plan = CollaborationPlanSchema.parse({
    id: 'plan_1',
    workItemId: 'wi_1',
    goal: 'Choose transport',
    rationale: 'ambiguous high-stakes decision',
    nodes: [
      {
        id: 'delib',
        role: 'Deliberation',
        objective: 'Blind independent analysis',
        contextPolicy: { visibility: 'blind' },
        operator: {
          type: 'counterpoint_deliberation',
          workerCount: 2,
          blind: true,
          commitReveal: true,
          challengeRounds: 1,
          verificationPolicy: 'code-search-and-tests',
          reviewerPolicy: 'anonymous-rubric',
        },
        completionCriteria: [{ id: 'c1', kind: 'human_acceptance', description: 'human approves ADR' }],
        failurePolicy: { maxRetries: 0, onFailure: 'escalate' },
        allocatedBudget: { maxTimeMs: 600_000 },
      },
    ],
    stopConditions: [{ id: 's1', kind: 'human_acceptance', description: 'ADR approved', targetOutcome: 'resolved' }],
    budgetAllocation: { maxTotalTimeMs: 900_000, maxTotalAgents: 3, maxTotalRounds: 2 },
    createdByRunId: 'run_planner',
  });
  assert.equal(plan.nodes[0].operator.type, 'counterpoint_deliberation');
  assert.equal(plan.status, 'proposed');
});

test('operator union rejects an unknown operator type', () => {
  assert.equal(OperatorSpecSchema.safeParse({ type: 'group_chat' }).success, false);
});

test('deliberation operator enforces blind commit-reveal constants', () => {
  const parsed = CounterpointDeliberationSpecSchema.parse({
    type: 'counterpoint_deliberation',
    workerCount: 3,
    blind: true,
    commitReveal: true,
    challengeRounds: 2,
    verificationPolicy: 'tests',
    reviewerPolicy: 'rubric',
  });
  assert.equal(parsed.workerCount, 3);
  assert.equal(CounterpointDeliberationSpecSchema.safeParse({ ...parsed, blind: false }).success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/planning-schemas.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

创建 `src/planning/schemas.ts`，完整内容：

```ts
import { z } from 'zod';

export const VisibilitySchema = z.enum(['shared', 'private', 'blind', 'sealed']);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const NodeContextPolicySchema = z.object({
  readScopes: z.array(z.string()).default([]),
  writeScopes: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default('shared'),
  includeObjectTypes: z.array(z.string()).default([]),
  excludeObjectTypes: z.array(z.string()).default([]),
  revealAfter: z.string().optional(),
});
export type NodeContextPolicy = z.infer<typeof NodeContextPolicySchema>;

export const AgentTaskOperatorSpecSchema = z.object({
  type: z.literal('agent_task'),
  instructions: z.string().min(1),
});
export const ToolTaskOperatorSpecSchema = z.object({
  type: z.literal('tool_task'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
});
export const VerificationOperatorSpecSchema = z.object({
  type: z.literal('verification'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  targetRefs: z.array(z.string()).default([]),
});
export const IndependentReviewOperatorSpecSchema = z.object({
  type: z.literal('independent_review'),
  rubricRef: z.string().min(1),
  targetNodeIds: z.array(z.string()).min(1),
});
export const CounterpointDeliberationSpecSchema = z.object({
  type: z.literal('counterpoint_deliberation'),
  workerCount: z.number().int().min(2).max(5).default(2),
  blind: z.literal(true).default(true),
  commitReveal: z.literal(true).default(true),
  challengeRounds: z.number().int().min(0).max(3).default(1),
  verificationPolicy: z.string().min(1),
  reviewerPolicy: z.string().min(1),
  humanGatePolicy: z.string().optional(),
});
export const HumanGateOperatorSpecSchema = z.object({
  type: z.literal('human_gate'),
  summary: z.string().min(1),
  options: z
    .array(z.enum(['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop']))
    .default(['approve_once', 'reject_and_stop']),
});

export const OperatorSpecSchema = z.discriminatedUnion('type', [
  AgentTaskOperatorSpecSchema,
  ToolTaskOperatorSpecSchema,
  VerificationOperatorSpecSchema,
  IndependentReviewOperatorSpecSchema,
  CounterpointDeliberationSpecSchema,
  HumanGateOperatorSpecSchema,
]);
export type OperatorSpec = z.infer<typeof OperatorSpecSchema>;
export type OperatorKind = OperatorSpec['type'];

export const CompletionCriterionKindSchema = z.enum(['evidence', 'artifact', 'human_acceptance', 'claim_supported']);
export const CompletionCriterionSchema = z.object({
  id: z.string().min(1),
  kind: CompletionCriterionKindSchema,
  description: z.string().min(1),
  refs: z.array(z.string()).default([]),
});
export type CompletionCriterion = z.infer<typeof CompletionCriterionSchema>;

export const FailurePolicySchema = z.object({
  maxRetries: z.number().int().min(0).max(3).default(0),
  onFailure: z.enum(['fail_node', 'cancel_pending_children', 'escalate']).default('fail_node'),
});

export const NodeBudgetSchema = z.object({
  maxTimeMs: z.number().int().positive(),
  maxTokens: z.number().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});

export const CollaborationNodeSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  objective: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  inputRefs: z.array(z.string()).default([]),
  contextPolicy: NodeContextPolicySchema,
  capabilityRequirements: z.array(z.string()).default([]),
  operator: OperatorSpecSchema,
  completionCriteria: z.array(CompletionCriterionSchema).min(1),
  failurePolicy: FailurePolicySchema,
  allocatedBudget: NodeBudgetSchema,
});
export type CollaborationNode = z.infer<typeof CollaborationNodeSchema>;

export const StopConditionKindSchema = z.enum(['evidence', 'artifact', 'decision', 'budget_exhausted', 'human_acceptance']);
export const StopConditionSchema = z.object({
  id: z.string().min(1),
  kind: StopConditionKindSchema,
  description: z.string().min(1),
  refs: z.array(z.string()).default([]),
  targetOutcome: z.enum(['resolved', 'partially_resolved', 'needs_evidence', 'blocked', 'rejected', 'escalated']),
});
export const EscalationConditionKindSchema = z.enum([
  'conflicting_evidence',
  'budget_exceeded',
  'high_risk_action',
  'completion_unreachable',
  'agent_unable_to_continue',
]);
export const EscalationConditionSchema = z.object({
  id: z.string().min(1),
  kind: EscalationConditionKindSchema,
  description: z.string().min(1),
});
export const BudgetAllocationSchema = z.object({
  maxTotalTimeMs: z.number().int().positive(),
  maxTotalAgents: z.number().int().positive(),
  maxTotalRounds: z.number().int().nonnegative(),
});
export const PlanStatusSchema = z.enum(['proposed', 'validating', 'validated', 'rejected', 'executing', 'completed', 'failed', 'superseded']);

export const CollaborationPlanSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  version: z.number().int().positive().default(1),
  goal: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  nodes: z.array(CollaborationNodeSchema).min(1),
  stopConditions: z.array(StopConditionSchema).min(1),
  escalationConditions: z.array(EscalationConditionSchema).default([]),
  budgetAllocation: BudgetAllocationSchema,
  createdByRunId: z.string().min(1),
  status: PlanStatusSchema.default('proposed'),
});
export type CollaborationPlan = z.infer<typeof CollaborationPlanSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/planning-schemas.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add src/planning/schemas.ts tests/unit/planning-schemas.test.ts
git commit -m "feat(planning): plan, node, operator and condition contracts"
```

---

## Task 5: PlanPatch Schema

**Files:**
- Create: `src/planning/plan-patch.ts`
- Test: `tests/unit/plan-patch.test.ts`

**Interfaces:**
- Produces: `PlanOperationSchema`（判别联合，八种 `op`）与 `type PlanOperation`
- Produces: `PlanPatchSchema` / `type PlanPatch`：`{ id, basePlanVersion, reason, evidenceRefs(min 1), operations(min 1), proposedByRunId, createdAt, status: 'proposed' | 'validated' | 'rejected' | 'applied' }`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/plan-patch.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PlanPatchSchema } from '../../src/planning/plan-patch.ts';

test('patch accepts cancel and add dependency operations', () => {
  const patch = PlanPatchSchema.parse({
    id: 'patch_1',
    basePlanVersion: 1,
    reason: 'Experiment disproved hypothesis B',
    evidenceRefs: ['evidence:exp-1'],
    operations: [
      { op: 'cancel_pending_node', nodeId: 'fix-b', reason: 'hypothesis B refuted' },
      { op: 'add_dependency', from: 'verify-fix-a', to: 'review', reason: 'review needs the verified fix' },
    ],
    proposedByRunId: 'run_exp',
    createdAt: '2026-08-13T00:00:00.000Z',
  });
  assert.equal(patch.operations.length, 2);
  assert.equal(patch.status, 'proposed');
});

test('patch requires at least one evidence ref and one operation', () => {
  const base = {
    id: 'patch_2',
    basePlanVersion: 1,
    reason: 'r',
    evidenceRefs: ['evidence:1'],
    operations: [{ op: 'request_human_gate', kind: 'high_risk', summary: 's' }],
    proposedByRunId: 'run_1',
    createdAt: '2026-08-13T00:00:00.000Z',
  };
  assert.equal(PlanPatchSchema.safeParse({ ...base, evidenceRefs: [] }).success, false);
  assert.equal(PlanPatchSchema.safeParse({ ...base, operations: [] }).success, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/plan-patch.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
// src/planning/plan-patch.ts
import { z } from 'zod';
import {
  CollaborationNodeSchema,
  NodeContextPolicySchema,
  StopConditionSchema,
} from './schemas.ts';
import { HumanGateKindSchema } from '../autonomy/human-gate.ts';

export const PlanOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_node'), node: CollaborationNodeSchema }),
  z.object({ op: z.literal('cancel_pending_node'), nodeId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ op: z.literal('replace_pending_node'), nodeId: z.string().min(1), replacement: CollaborationNodeSchema, reason: z.string().min(1) }),
  z.object({ op: z.literal('add_dependency'), from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1) }),
  z.object({ op: z.literal('tighten_context_policy'), nodeId: z.string().min(1), policy: NodeContextPolicySchema, reason: z.string().min(1) }),
  z.object({ op: z.literal('request_additional_budget'), amount: z.object({ maxTimeMs: z.number().int().positive(), maxTokens: z.number().positive().optional(), maxCostUsd: z.number().positive().optional() }), reason: z.string().min(1) }),
  z.object({ op: z.literal('request_human_gate'), kind: HumanGateKindSchema, summary: z.string().min(1) }),
  z.object({ op: z.literal('change_stop_condition'), stopCondition: StopConditionSchema, reason: z.string().min(1) }),
]);
export type PlanOperation = z.infer<typeof PlanOperationSchema>;

export const PlanPatchSchema = z.object({
  id: z.string().min(1),
  basePlanVersion: z.number().int().positive(),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string()).min(1),
  operations: z.array(PlanOperationSchema).min(1),
  proposedByRunId: z.string().min(1),
  createdAt: z.string(),
  status: z.enum(['proposed', 'validated', 'rejected', 'applied']).default('proposed'),
});
export type PlanPatch = z.infer<typeof PlanPatchSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/plan-patch.test.ts`
Expected: PASS（2/2）

- [ ] **Step 5: Commit**

```bash
git add src/planning/plan-patch.ts tests/unit/plan-patch.test.ts
git commit -m "feat(planning): plan patch and operation contracts"
```

---

## Task 6: Database v0.2 与迁移

**Files:**
- Modify: `src/schemas.ts`, `src/protocol-engine.ts`
- Test: `tests/unit/database-v2.test.ts`

**Interfaces:**
- Modifies: `DatabaseSchema.schemaVersion` 默认值改为 `'0.2.0'`，并增加 `autonomyEnvelopes / plans / planPatches / opinions / humanGateRequests` 五个数组（全部 `.default([])`）
- Produces: `migrateDatabaseV2(db: Database): Database` —— 先执行现有 `migrateDatabase`，再把每个 `status === 'investigating'` 的 WorkItem 映射为 `running`；幂等
- Modifies: `ProtocolEngine.loadDatabase` 把两处 `migrateDatabase(...)` 换成 `migrateDatabaseV2(...)`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/database-v2.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DatabaseSchema,
  emptyDatabase,
  migrateDatabaseV2,
} from '../../src/schemas.ts';

test('empty database is schema 0.2.0 with planning arrays', () => {
  const db = emptyDatabase();
  assert.equal(db.schemaVersion, '0.2.0');
  assert.deepEqual(db.plans, []);
  assert.deepEqual(db.autonomyEnvelopes, []);
  assert.deepEqual(db.humanGateRequests, []);
  assert.equal(DatabaseSchema.safeParse(db).success, true);
});

test('migrateDatabaseV2 maps investigating to running and is idempotent', () => {
  const db = migrateDatabaseV2({
    ...emptyDatabase(),
    workItems: [
      {
        id: 'wi_1',
        workspaceId: 'ws_1',
        kind: 'bug',
        title: 'B',
        ownerId: 'human',
        status: 'investigating' as const,
        version: 1,
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      },
    ],
  });
  assert.equal(db.workItems[0].status, 'running');
  const again = migrateDatabaseV2(db);
  assert.equal(again.workItems[0].status, 'running');
  assert.equal(again.workItems.length, 1);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/database-v2.test.ts`
Expected: FAIL，`emptyDatabase().plans` 为 `undefined`、`migrateDatabaseV2` 未定义

- [ ] **Step 3: Write minimal implementation**

在 `src/schemas.ts`：

```ts
import {
  AutonomyEnvelopeSchema,
} from './autonomy/autonomy-envelope.ts';
import { CollaborationPlanSchema } from './planning/schemas.ts';
import { PlanPatchSchema } from './planning/plan-patch.ts';
import { HumanGateRequestSchema } from './autonomy/human-gate.ts';
```

`DatabaseSchema` 改为：

```ts
export const DatabaseSchema = z.object({
  schemaVersion: z.string().default('0.2.0'),
  projects: z.array(ProjectSchema).default([]),
  workItems: z.array(WorkItemSchema).default([]),
  deliberations: z.array(DeliberationSchema).default([]),
  taskPackets: z.array(TaskPacketSchema).default([]),
  contextViews: z.array(ContextViewSchema).default([]),
  events: z.array(EventSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  artifactVersions: z.array(ArtifactVersionSchema).default([]),
  artifactContents: z.record(z.string()).default({}),
  logs: z.record(z.string()).default({}),
  autonomyEnvelopes: z.array(AutonomyEnvelopeSchema).default([]),
  plans: z.array(CollaborationPlanSchema).default([]),
  planPatches: z.array(PlanPatchSchema).default([]),
  opinions: z.array(OpinionSchema).default([]),
  humanGateRequests: z.array(HumanGateRequestSchema).default([]),
});
```

`emptyDatabase` 返回对象增加：

```ts
    autonomyEnvelopes: [],
    plans: [],
    planPatches: [],
    opinions: [],
    humanGateRequests: [],
```

`migrateDatabase` 之后追加：

```ts
export function migrateDatabaseV2(db: Database): Database {
  const base = migrateDatabase(db);
  return {
    ...base,
    workItems: base.workItems.map((workItem) =>
      workItem.status === 'investigating' ? { ...workItem, status: 'running' as const } : workItem,
    ),
  };
}
```

在 `src/protocol-engine.ts` 的 `loadDatabase` 中，把 `migrateDatabase(store.load())` 与
`migrateDatabase(emptyDatabase())` 分别替换为 `migrateDatabaseV2(store.load())` 与
`migrateDatabaseV2(emptyDatabase())`，并同步更新 import。

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/database-v2.test.ts`
Expected: PASS（2/2）

- [ ] **Step 5: Run regression and commit**

Run: `npm run typecheck && npm test`
Expected: 全绿

```bash
git add src/schemas.ts src/protocol-engine.ts tests/unit/database-v2.test.ts
git commit -m "feat(schemas): database 0.2.0 aggregation and v2 migration"
```

---

## Task 7: Capability Catalog + Validator 结构检查

**Files:**
- Create: `src/planning/capabilities.ts`, `src/planning/plan-validator.ts`
- Test: `tests/helpers/plan-fixtures.ts`, `tests/unit/plan-validator.test.ts`

**Interfaces:**
- Produces: `CapabilityDescriptor { capability: string; adapterKind: 'mock' | 'local-process' | 'cli' | 'acp'; adapterId?: string; tools: string[] }`
- Produces: `CapabilityCatalog { byCapability: Map<string, CapabilityDescriptor> }`、`catalogFromEntries(entries)`
- Produces: `ValidationIssue { code: string; path: string; message: string; kind: 'schema' | 'dag' | 'permission' | 'budget' | 'context' | 'independence' | 'evidence' | 'gate' }`
- Produces: `ValidatePlanInput { plan, envelope, workItem, catalog, lineage?, evidenceIndex? }`
- Produces: `collectStructureIssues(input): ValidationIssue[]`
- Produces: `finalizeVerdict(issues): 'accepted' | 'rejected' | 'needs_revision' | 'needs_human_approval'`
- Produces: `validatePlan(input): ValidationResult`（本任务只接结构检查，Task 8/9 再扩展）

- [ ] **Step 1: Write the failing test**

```ts
// tests/helpers/plan-fixtures.ts
import { defaultAutonomyEnvelope, tightenEnvelope, type AutonomyEnvelope, type AutonomyEnvelopeOverrides } from '../../src/autonomy/autonomy-envelope.ts';
import { CollaborationPlanSchema, type CollaborationNode, type CollaborationPlan } from '../../src/planning/schemas.ts';
import type { WorkItem } from '../../src/schemas.ts';

export function validEnvelope(overrides: AutonomyEnvelopeOverrides = {}): AutonomyEnvelope {
  return tightenEnvelope(defaultAutonomyEnvelope('ws_test'), overrides);
}

export function validWorkItem(): WorkItem {
  return {
    id: 'wi_test',
    workspaceId: 'ws_test',
    kind: 'bug',
    title: 'Inventory sync drops data intermittently',
    ownerId: 'human',
    status: 'open',
    goal: 'Locate a verifiable root cause and produce a regression plan',
    constraints: ['No production access'],
    expectedOutcomes: ['Root cause', 'Fix plan'],
    sourceRefs: ['src_inventory@v1'],
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}

export function makeNode(overrides: Partial<CollaborationNode> = {}): CollaborationNode {
  return {
    id: 'repro',
    role: 'Reproducer',
    objective: 'Reproduce the loss and collect logs',
    dependsOn: [],
    inputRefs: ['src_inventory@v1'],
    contextPolicy: { visibility: 'shared', includeObjectTypes: ['source'] },
    capabilityRequirements: ['code-analysis'],
    operator: { type: 'agent_task', instructions: 'Reproduce and collect logs' },
    completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'repro log', refs: ['artifact:repro-log'] }],
    failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
    allocatedBudget: { maxTimeMs: 120_000 },
    ...overrides,
  };
}

export function validPlan(overrides: Partial<CollaborationPlan> = {}): CollaborationPlan {
  return CollaborationPlanSchema.parse(
    Object.assign(
      {
        id: 'plan_test',
        workItemId: 'wi_test',
        goal: 'Find root cause of intermittent inventory sync data loss',
        rationale: 'Reproduce, then verify root cause with a test',
        nodes: [makeNode()],
        stopConditions: [
          { id: 's1', kind: 'evidence', description: 'root cause verified by test', refs: ['evidence:root-cause'], targetOutcome: 'resolved' },
        ],
        budgetAllocation: { maxTotalTimeMs: 600_000, maxTotalAgents: 4, maxTotalRounds: 3 },
        createdByRunId: 'run_planner',
      },
      overrides,
    ),
  );
}
```

```ts
// tests/unit/plan-validator.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../src/planning/plan-validator.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validEnvelope, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';

const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
  { capability: 'verification', adapterKind: 'mock', tools: ['node', 'npm'] },
  { capability: 'independent-review', adapterKind: 'mock', tools: ['read_candidates'] },
]);

test('a structurally valid plan is accepted', () => {
  const result = validatePlan({ plan: validPlan(), envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.issues.length, 0);
});

test('duplicate node ids are rejected', () => {
  const plan = validPlan({ nodes: [makeNode(), makeNode()] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'DUPLICATE_NODE_ID'));
});

test('unknown dependencies are rejected', () => {
  const plan = validPlan({ nodes: [makeNode({ dependsOn: ['missing'] })] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'UNKNOWN_DEPENDENCY'));
});

test('cycles are rejected', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', dependsOn: ['b'] }),
      makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'verification', command: 'node', args: ['--version'] } }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'CYCLE'));
});

test('unknown capability is rejected', () => {
  const plan = validPlan({ nodes: [makeNode({ capabilityRequirements: ['telepathy'] })] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'UNKNOWN_CAPABILITY'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/plan-validator.test.ts`
Expected: FAIL，`validatePlan` 未定义

- [ ] **Step 3: Write minimal implementation**

```ts
// src/planning/capabilities.ts
export interface CapabilityDescriptor {
  capability: string;
  adapterKind: 'mock' | 'local-process' | 'cli' | 'acp';
  adapterId?: string;
  tools: string[];
}

export interface CapabilityCatalog {
  byCapability: Map<string, CapabilityDescriptor>;
}

export function catalogFromEntries(entries: CapabilityDescriptor[]): CapabilityCatalog {
  return { byCapability: new Map(entries.map((entry) => [entry.capability, entry])) };
}
```

```ts
// src/planning/plan-validator.ts
import type { CollaborationPlan } from './schemas.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { CapabilityCatalog } from './capabilities.ts';
import type { WorkItem } from '../schemas.ts';

export type IssueKind = 'schema' | 'dag' | 'permission' | 'budget' | 'context' | 'independence' | 'evidence' | 'gate';
export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  kind: IssueKind;
}

export type ValidationVerdict = 'accepted' | 'rejected' | 'needs_revision' | 'needs_human_approval';

export interface ValidationResult {
  verdict: ValidationVerdict;
  issues: ValidationIssue[];
}

export interface ValidatePlanInput {
  plan: CollaborationPlan;
  envelope: AutonomyEnvelope;
  workItem: WorkItem;
  catalog: CapabilityCatalog;
  lineage?: Record<string, { authorRunIds: string[]; fingerprints: string[]; contextViewHashes: string[] }>;
  evidenceIndex?: Map<string, 'verified' | 'unverified' | 'unknown'>;
}

export function collectStructureIssues(input: ValidatePlanInput): ValidationIssue[] {
  const { plan, catalog } = input;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) issues.push({ code: 'DUPLICATE_NODE_ID', path: `nodes.${node.id}`, message: 'node id must be unique', kind: 'schema' });
    ids.add(node.id);
    for (const capability of node.capabilityRequirements) {
      if (!catalog.byCapability.has(capability)) {
        issues.push({ code: 'UNKNOWN_CAPABILITY', path: `nodes.${node.id}.capabilityRequirements`, message: `unknown capability ${capability}`, kind: 'dag' });
      }
    }
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) issues.push({ code: 'UNKNOWN_DEPENDENCY', path: `nodes.${node.id}.dependsOn`, message: `dependency not found: ${dependency}`, kind: 'dag' });
    }
  }
  const colors = new Map<string, 'white' | 'gray' | 'black'>();
  const visit = (nodeId: string, stack: string[]): void => {
    const color = colors.get(nodeId) ?? 'white';
    if (color === 'black') return;
    if (color === 'gray') {
      issues.push({ code: 'CYCLE', path: `nodes.${nodeId}`, message: `cycle: ${[...stack, nodeId].join(' -> ')}`, kind: 'dag' });
      return;
    }
    colors.set(nodeId, 'gray');
    const node = plan.nodes.find((item) => item.id === nodeId);
    for (const dependency of node?.dependsOn ?? []) visit(dependency, [...stack, nodeId]);
    colors.set(nodeId, 'black');
  };
  for (const node of plan.nodes) visit(node.id, []);
  const dependents = new Set(plan.nodes.flatMap((node) => node.dependsOn));
  for (const sink of plan.nodes.filter((node) => !dependents.has(node.id))) {
    const producesDecision =
      sink.operator.type === 'human_gate' ||
      sink.completionCriteria.some((criterion) => ['artifact', 'evidence', 'human_acceptance'].includes(criterion.kind));
    if (!producesDecision) {
      issues.push({ code: 'SINK_WITHOUT_OUTPUT', path: `nodes.${sink.id}`, message: 'sink node must produce a decision, artifact, evidence or human acceptance', kind: 'dag' });
    }
  }
  return issues;
}

export function finalizeVerdict(issues: ValidationIssue[]): ValidationVerdict {
  if (issues.length === 0) return 'accepted';
  if (issues.some((issue) => issue.kind === 'schema' || issue.kind === 'dag')) return 'rejected';
  if (issues.some((issue) => issue.kind === 'permission' || issue.kind === 'budget')) return 'needs_human_approval';
  return 'needs_revision';
}

export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const issues = collectStructureIssues(input);
  return { verdict: finalizeVerdict(issues), issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/plan-validator.test.ts`
Expected: PASS（5/5）

- [ ] **Step 5: Commit**

```bash
git add src/planning/capabilities.ts src/planning/plan-validator.ts tests/helpers/plan-fixtures.ts tests/unit/plan-validator.test.ts
git commit -m "feat(planning): capability catalog and structural plan validation"
```

---

## Task 8: Validator 权限与预算检查

**Files:**
- Modify: `src/planning/plan-validator.ts`
- Test: `tests/unit/plan-validator.test.ts`（追加）

**Interfaces:**
- Produces: `collectPermissionBudgetIssues(input): ValidationIssue[]`
- Modifies: `validatePlan` 改为 `[...collectStructureIssues(input), ...collectPermissionBudgetIssues(input)]`

规则（与 spec §4 对应）：

- 每个节点 Operator 的命令/工具必须在 `envelope.allowedTools` 中（`PERMISSION_TOOL`）；
- 节点 `contextPolicy.writeScopes` 每个值必须等于或前缀匹配 `envelope.writableScopes`（`PERMISSION_WRITE_SCOPE`）；
- `budgetAllocation.maxTotalAgents ≤ envelope.maxAgents`、`maxTotalRounds ≤ envelope.maxRounds`、`maxTotalTimeMs ≤ envelope.timeBudgetMs`（`BUDGET_OVER_ENVELOPE`）；
- 节点 `allocatedBudget.maxTimeMs` 之和 ≤ `envelope.timeBudgetMs`（`BUDGET_SUM_TIME`）；
- 节点 `failurePolicy.maxRetries ≤ envelope.maxRounds`（`BUDGET_RETRY_OVER_ROUNDS`）；
- 并行宽度按拓扑层计算：`level(n) = 1 + max(level(dep))`，同层节点数的最大值 ≤ `envelope.maxParallelism`（`BUDGET_PARALLELISM`）。

- [ ] **Step 1: Write the failing test（追加到现有测试文件）**

```ts
test('tool outside the envelope allowlist requires human approval', () => {
  const plan = validPlan({
    nodes: [makeNode({ operator: { type: 'tool_task', command: 'curl', args: [] }, capabilityRequirements: ['verification'] })],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'PERMISSION_TOOL'));
});

test('write scope outside the envelope requires human approval', () => {
  const plan = validPlan({
    nodes: [makeNode({ contextPolicy: { visibility: 'shared', writeScopes: ['/prod'] } })],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'PERMISSION_WRITE_SCOPE'));
});

test('budget allocation above the envelope requires human approval', () => {
  const plan = validPlan({ budgetAllocation: { maxTotalTimeMs: 99_999_999, maxTotalAgents: 4, maxTotalRounds: 3 } });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'BUDGET_OVER_ENVELOPE'));
});

test('parallelism beyond the envelope requires human approval', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b' }),
      makeNode({ id: 'c' }),
      makeNode({ id: 'd', dependsOn: ['a', 'b', 'c'], operator: { type: 'verification', command: 'node', args: ['--version'] } }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'BUDGET_PARALLELISM'));
});

test('retries beyond rounds require human approval', () => {
  const envelope = validEnvelope({ maxRounds: 2 });
  const plan = validPlan({
    budgetAllocation: { maxTotalTimeMs: 600_000, maxTotalAgents: 4, maxTotalRounds: 2 },
    nodes: [makeNode({ failurePolicy: { maxRetries: 3, onFailure: 'fail_node' } })],
  });
  const result = validatePlan({ plan, envelope, workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'BUDGET_RETRY_OVER_ROUNDS'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/plan-validator.test.ts`
Expected: FAIL（新增 5 项断言不成立）

- [ ] **Step 3: Write minimal implementation**

在 `plan-validator.ts` 追加：

```ts
import type { CollaborationPlan, OperatorSpec } from './schemas.ts';

function operatorCommands(operator: OperatorSpec): string[] {
  if (operator.type === 'tool_task' || operator.type === 'verification') return [operator.command];
  return [];
}

function isWithinScope(scope: string, allowed: string[]): boolean {
  const normalized = scope.replaceAll('\\', '/');
  return allowed.some((item) => {
    const prefix = item.replaceAll('\\', '/').replace(/\/$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export function collectPermissionBudgetIssues(input: ValidatePlanInput): ValidationIssue[] {
  const { plan, envelope } = input;
  const issues: ValidationIssue[] = [];
  for (const node of plan.nodes) {
    for (const command of operatorCommands(node.operator)) {
      if (!envelope.allowedTools.includes(command)) {
        issues.push({ code: 'PERMISSION_TOOL', path: `nodes.${node.id}.operator.command`, message: `tool "${command}" is not in the envelope allowlist`, kind: 'permission' });
      }
    }
    for (const scope of node.contextPolicy.writeScopes) {
      if (!isWithinScope(scope, envelope.writableScopes)) {
        issues.push({ code: 'PERMISSION_WRITE_SCOPE', path: `nodes.${node.id}.contextPolicy.writeScopes`, message: `write scope "${scope}" is outside the envelope`, kind: 'permission' });
      }
    }
    if (node.failurePolicy.maxRetries > envelope.maxRounds) {
      issues.push({ code: 'BUDGET_RETRY_OVER_ROUNDS', path: `nodes.${node.id}.failurePolicy`, message: 'retries exceed envelope rounds', kind: 'budget' });
    }
  }
  const allocation = plan.budgetAllocation;
  if (
    allocation.maxTotalAgents > envelope.maxAgents ||
    allocation.maxTotalRounds > envelope.maxRounds ||
    allocation.maxTotalTimeMs > envelope.timeBudgetMs
  ) {
    issues.push({ code: 'BUDGET_OVER_ENVELOPE', path: 'budgetAllocation', message: 'plan allocation exceeds the envelope', kind: 'budget' });
  }
  const nodeTimeTotal = plan.nodes.reduce((sum, node) => sum + node.allocatedBudget.maxTimeMs, 0);
  if (nodeTimeTotal > envelope.timeBudgetMs) {
    issues.push({ code: 'BUDGET_SUM_TIME', path: 'nodes', message: `node time budgets sum to ${nodeTimeTotal}ms > envelope ${envelope.timeBudgetMs}ms`, kind: 'budget' });
  }
  const levels = new Map<string, number>();
  const levelOf = (nodeId: string): number => {
    const cached = levels.get(nodeId);
    if (cached !== undefined) return cached;
    const node = plan.nodes.find((item) => item.id === nodeId);
    const level = 1 + Math.max(0, ...(node?.dependsOn ?? []).map(levelOf));
    levels.set(nodeId, level);
    return level;
  };
  const perLevel = new Map<number, number>();
  for (const node of plan.nodes) {
    const level = levelOf(node.id);
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
  }
  const maxWidth = Math.max(0, ...perLevel.values());
  if (maxWidth > envelope.maxParallelism) {
    issues.push({ code: 'BUDGET_PARALLELISM', path: 'nodes', message: `max parallel width ${maxWidth} > envelope ${envelope.maxParallelism}`, kind: 'budget' });
  }
  return issues;
}
```

`validatePlan` 改为：

```ts
export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const issues = [...collectStructureIssues(input), ...collectPermissionBudgetIssues(input)];
  return { verdict: finalizeVerdict(issues), issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/plan-validator.test.ts`
Expected: PASS（10/10）

- [ ] **Step 5: Commit**

```bash
git add src/planning/plan-validator.ts tests/unit/plan-validator.test.ts
git commit -m "feat(planning): permission and budget validation"
```

---

## Task 9: Validator 上下文、独立性与证据门禁

**Files:**
- Modify: `src/planning/plan-validator.ts`
- Test: `tests/unit/plan-validator.test.ts`（追加）

**Interfaces:**
- Produces: `collectConstitutionIssues(input): ValidationIssue[]`
- Modifies: `validatePlan` 把三类收集器合并

规则：

- 节点的 `inputRefs` 若引用 `private/blind/sealed` 节点的输出命名空间，且不是自身输出，则 `CONTEXT_PRIVATE_REF`；
- 两个 `visibility === 'blind'` 节点的 `inputRefs` 交集必须为空（`CONTEXT_BLIND_SHARED_INPUT`）；
- `independent_review` 节点的 `targetNodeIds` 若与自身能力集合相交（静态代理），则 `INDEPENDENCE_CAPABILITY_OVERLAP`；若 `lineage` 提供且 reviewer 节点指纹与目标节点指纹相交，则 `INDEPENDENCE_LINEAGE_CONFLICT`；
- `completionCriterion.kind === 'evidence'` 且 `refs` 为空，则 `EVIDENCE_CRITERION_NO_REF`；若 `evidenceIndex` 提供且任何 ref 标记为 `'unknown'`，则 `EVIDENCE_REF_UNRESOLVED`；
- `envelope.riskPolicy.requireHumanGateFor` 命中任何节点命令时，计划必须含至少一个 `human_gate` 节点，否则 `GATE_REQUIRED_MISSING`；
- `stopConditions` 为空由 Schema 已拒绝（min 1）；每个 `stopConditions` 的 `refs` 若为 `evidence:` 前缀而 `evidenceIndex` 提供且未知，则 `GATE_STOP_REF_UNRESOLVED`。

- [ ] **Step 1: Write the failing test（追加）**

```ts
test('private object referenced by another node needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'secret', contextPolicy: { visibility: 'private' } }),
      makeNode({ id: 'consumer', dependsOn: ['secret'], inputRefs: ['secret:notes'] }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'CONTEXT_PRIVATE_REF'));
});

test('two blind nodes sharing input need revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'blind-a', contextPolicy: { visibility: 'blind' }, inputRefs: ['src_inventory@v1'] }),
      makeNode({ id: 'blind-b', contextPolicy: { visibility: 'blind' }, inputRefs: ['src_inventory@v1'] }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'CONTEXT_BLIND_SHARED_INPUT'));
});

test('reviewer sharing capabilities with its target needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'candidate', capabilityRequirements: ['code-analysis'] }),
      makeNode({
        id: 'review',
        dependsOn: ['candidate'],
        capabilityRequirements: ['code-analysis'],
        operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['candidate'] },
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'INDEPENDENCE_CAPABILITY_OVERLAP'));
});

test('lineage conflict between reviewer and target is caught', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'candidate', capabilityRequirements: ['code-analysis'] }),
      makeNode({
        id: 'review',
        dependsOn: ['candidate'],
        capabilityRequirements: ['independent-review'],
        operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['candidate'] },
      }),
    ],
  });
  const result = validatePlan({
    plan,
    envelope: validEnvelope(),
    workItem: validWorkItem(),
    catalog,
    lineage: {
      review: { authorRunIds: [], fingerprints: ['adapter-cli/model-a'], contextViewHashes: [] },
      candidate: { authorRunIds: [], fingerprints: ['adapter-cli/model-a'], contextViewHashes: [] },
    },
  });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'INDEPENDENCE_LINEAGE_CONFLICT'));
});

test('evidence completion without refs needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        completionCriteria: [{ id: 'c1', kind: 'evidence', description: 'verified root cause', refs: [] }],
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'EVIDENCE_CRITERION_NO_REF'));
});

test('high risk action without a human gate node needs revision', () => {
  const plan = validPlan({
    nodes: [makeNode({ operator: { type: 'tool_task', command: 'git', args: ['push'] }, capabilityRequirements: ['verification'] })],
  });
  const envelope = validEnvelope({ riskPolicy: { requireHumanGateFor: ['git push'] } });
  const result = validatePlan({ plan, envelope, workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'GATE_REQUIRED_MISSING'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/plan-validator.test.ts`
Expected: FAIL（新增 6 项断言不成立）

- [ ] **Step 3: Write minimal implementation**

在 `plan-validator.ts` 追加：

```ts
export function collectConstitutionIssues(input: ValidatePlanInput): ValidationIssue[] {
  const { plan, envelope, lineage, evidenceIndex } = input;
  const issues: ValidationIssue[] = [];
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  for (const node of plan.nodes) {
    for (const ref of node.inputRefs) {
      const producerId = ref.split(':')[0];
      const producer = byId.get(producerId);
      if (producer && producer.id !== node.id && ['private', 'blind', 'sealed'].includes(producer.contextPolicy.visibility)) {
        issues.push({ code: 'CONTEXT_PRIVATE_REF', path: `nodes.${node.id}.inputRefs`, message: `ref ${ref} points at ${producer.contextPolicy.visibility} node ${producer.id}`, kind: 'context' });
      }
    }
    for (const criterion of node.completionCriteria) {
      if (criterion.kind === 'evidence' && criterion.refs.length === 0) {
        issues.push({ code: 'EVIDENCE_CRITERION_NO_REF', path: `nodes.${node.id}.completionCriteria`, message: 'evidence criterion must reference evidence', kind: 'evidence' });
      }
      for (const ref of criterion.refs) {
        if (evidenceIndex && ref.startsWith('evidence:') && evidenceIndex.get(ref) === 'unknown') {
          issues.push({ code: 'EVIDENCE_REF_UNRESOLVED', path: `nodes.${node.id}.completionCriteria`, message: `evidence ref unresolved: ${ref}`, kind: 'evidence' });
        }
      }
    }
  }
  const blindNodes = plan.nodes.filter((node) => node.contextPolicy.visibility === 'blind');
  for (let i = 0; i < blindNodes.length; i++) {
    for (let j = i + 1; j < blindNodes.length; j++) {
      const shared = blindNodes[i].inputRefs.filter((ref) => blindNodes[j].inputRefs.includes(ref));
      if (shared.length) {
        issues.push({ code: 'CONTEXT_BLIND_SHARED_INPUT', path: 'nodes', message: `blind nodes ${blindNodes[i].id}/${blindNodes[j].id} share inputs: ${shared.join(', ')}`, kind: 'context' });
      }
    }
  }
  for (const node of plan.nodes) {
    if (node.operator.type !== 'independent_review') continue;
    for (const targetId of node.operator.targetNodeIds) {
      const target = byId.get(targetId);
      if (!target) continue;
      const overlap = target.capabilityRequirements.filter((capability) => node.capabilityRequirements.includes(capability));
      if (overlap.length) {
        issues.push({ code: 'INDEPENDENCE_CAPABILITY_OVERLAP', path: `nodes.${node.id}`, message: `reviewer shares capabilities with target ${targetId}: ${overlap.join(', ')}`, kind: 'independence' });
      }
      if (lineage) {
        const reviewerLineage = lineage[node.id]?.fingerprints ?? [];
        const targetLineage = lineage[targetId]?.fingerprints ?? [];
        const conflict = reviewerLineage.some((fingerprint) => targetLineage.includes(fingerprint));
        if (conflict) {
          issues.push({ code: 'INDEPENDENCE_LINEAGE_CONFLICT', path: `nodes.${node.id}`, message: `reviewer lineage conflicts with target ${targetId}`, kind: 'independence' });
        }
      }
    }
  }
  const gatedActions = envelope.riskPolicy.requireHumanGateFor;
  const planUsesGatedAction = plan.nodes.some((node) => {
    if (node.operator.type !== 'tool_task' && node.operator.type !== 'verification') return false;
    const full = `${node.operator.command} ${node.operator.args.join(' ')}`.trim();
    return gatedActions.includes(full) || gatedActions.includes(node.operator.command);
  });
  const hasGateNode = plan.nodes.some((node) => node.operator.type === 'human_gate');
  if (planUsesGatedAction && !hasGateNode) {
    issues.push({ code: 'GATE_REQUIRED_MISSING', path: 'nodes', message: 'plan uses a gated action but has no human_gate node', kind: 'gate' });
  }
  for (const stopCondition of plan.stopConditions) {
    for (const ref of stopCondition.refs) {
      if (evidenceIndex && ref.startsWith('evidence:') && evidenceIndex.get(ref) === 'unknown') {
        issues.push({ code: 'GATE_STOP_REF_UNRESOLVED', path: 'stopConditions', message: `stop condition ref unresolved: ${ref}`, kind: 'gate' });
      }
    }
  }
  return issues;
}
```

`validatePlan` 改为：

```ts
export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const issues = [
    ...collectStructureIssues(input),
    ...collectPermissionBudgetIssues(input),
    ...collectConstitutionIssues(input),
  ];
  return { verdict: finalizeVerdict(issues), issues };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/plan-validator.test.ts`
Expected: PASS（16/16）

- [ ] **Step 5: Commit**

```bash
git add src/planning/plan-validator.ts tests/unit/plan-validator.test.ts
git commit -m "feat(planning): context, independence and evidence gate validation"
```

---

## Task 10: Execution Graph 类型与 Graph Compiler

**Files:**
- Create: `src/execution/execution-graph.ts`, `src/execution/graph-compiler.ts`
- Test: `tests/unit/graph-compiler.test.ts`

**Interfaces:**
- Produces: `GraphNodeStatus`、`GraphNode`、`ExecutionGraph`
- Produces: `computeReadyNodes(graph): GraphNode[]` —— 节点 `pending` 且所有依赖 `succeeded`（`skipped` 视为已满足）
- Produces: `compilePlan(input: { plan: CollaborationPlan; catalog: CapabilityCatalog }): ExecutionGraph` —— 校验能力存在、按 `capabilityRequirements[0]` 绑定 adapter、源节点置 `ready`、图节点 id 为 `gn_${node.id}`

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/graph-compiler.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { computeReadyNodes } from '../../src/execution/execution-graph.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan } from '../helpers/plan-fixtures.ts';

const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', adapterId: 'adapter-mock', tools: ['read_sources'] },
]);

test('compiler binds adapters and marks source nodes ready', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'verification', command: 'node', args: ['--version'] }, capabilityRequirements: ['code-analysis'] }),
    ],
  });
  const graph = compilePlan({ plan, catalog });
  assert.equal(graph.planId, 'plan_test');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.nodes[0].adapterBinding?.adapterId, 'adapter-mock');
  const ready = computeReadyNodes(graph);
  assert.deepEqual(ready.map((node) => node.id), ['gn_a']);
});

test('compiler rejects a node whose capability is unknown', () => {
  const plan = validPlan({ nodes: [makeNode({ capabilityRequirements: ['telepathy'] })] });
  assert.throws(() => compilePlan({ plan, catalog }), /capability/i);
});

test('ready nodes expand after dependencies succeed', () => {
  const graph = compilePlan({
    plan: validPlan({
      nodes: [
        makeNode({ id: 'a' }),
        makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'verification', command: 'node', args: ['--version'] }, capabilityRequirements: ['code-analysis'] }),
      ],
    }),
    catalog,
  });
  graph.nodes.find((node) => node.id === 'gn_a')!.status = 'succeeded';
  assert.deepEqual(computeReadyNodes(graph).map((node) => node.id), ['gn_b']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/graph-compiler.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
// src/execution/execution-graph.ts
import type { CollaborationNode } from '../planning/schemas.ts';

export type GraphNodeStatus = 'pending' | 'ready' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface AdapterBinding {
  adapterId: string;
  kind: string;
  capabilities: string[];
}

export interface GraphNode {
  id: string;
  planNodeId: string;
  role: string;
  objective: string;
  dependsOn: string[];
  inputRefs: string[];
  contextPolicy: CollaborationNode['contextPolicy'];
  operator: CollaborationNode['operator'];
  capabilityRequirements: string[];
  completionCriteria: CollaborationNode['completionCriteria'];
  failurePolicy: CollaborationNode['failurePolicy'];
  allocatedBudget: CollaborationNode['allocatedBudget'];
  adapterBinding?: AdapterBinding;
  status: GraphNodeStatus;
}

export interface ExecutionGraph {
  id: string;
  planId: string;
  planVersion: number;
  nodes: GraphNode[];
  status: 'pending' | 'active' | 'completed' | 'failed';
}

export function computeReadyNodes(graph: ExecutionGraph): GraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const satisfied = (node: GraphNode): boolean =>
    node.dependsOn.every((dependency) => {
      const depNode = byId.get(`gn_${dependency}`);
      return depNode && (depNode.status === 'succeeded' || depNode.status === 'skipped');
    });
  return graph.nodes.filter((node) => node.status === 'pending' && satisfied(node));
}
```

```ts
// src/execution/graph-compiler.ts
import { newId } from '../ids.ts';
import type { CollaborationPlan } from '../planning/schemas.ts';
import type { CapabilityCatalog } from '../planning/capabilities.ts';
import type { AdapterBinding, ExecutionGraph, GraphNode } from './execution-graph.ts';

export interface CompilePlanInput {
  plan: CollaborationPlan;
  catalog: CapabilityCatalog;
}

export function compilePlan(input: CompilePlanInput): ExecutionGraph {
  const nodes: GraphNode[] = input.plan.nodes.map((node) => {
    const primary = node.capabilityRequirements[0];
    if (!primary || !input.catalog.byCapability.has(primary)) {
      throw new Error(`No capability "${primary ?? ''}" for node ${node.id}`);
    }
    const descriptor = input.catalog.byCapability.get(primary)!;
    const adapterBinding: AdapterBinding = {
      adapterId: descriptor.adapterId ?? `${descriptor.adapterKind}-${primary}`,
      kind: descriptor.adapterKind,
      capabilities: node.capabilityRequirements,
    };
    const isSource = node.dependsOn.length === 0;
    return {
      id: `gn_${node.id}`,
      planNodeId: node.id,
      role: node.role,
      objective: node.objective,
      dependsOn: node.dependsOn.map((dependency) => `gn_${dependency}`),
      inputRefs: [...node.inputRefs],
      contextPolicy: node.contextPolicy,
      operator: node.operator,
      capabilityRequirements: [...node.capabilityRequirements],
      completionCriteria: node.completionCriteria,
      failurePolicy: node.failurePolicy,
      allocatedBudget: node.allocatedBudget,
      adapterBinding,
      status: isSource ? 'ready' : 'pending',
    };
  });
  return {
    id: newId('graph'),
    planId: input.plan.id,
    planVersion: input.plan.version,
    nodes,
    status: 'pending',
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/graph-compiler.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add src/execution/execution-graph.ts src/execution/graph-compiler.ts tests/unit/graph-compiler.test.ts
git commit -m "feat(execution): execution graph types and compiler"
```

---

## Task 11: Planner 接口、Orchestrator 与 MockPlanner（仅测试）

**Files:**
- Create: `src/planning/planner.ts`
- Test: `tests/unit/planner-orchestrator.test.ts`

**Interfaces:**
- Produces: `SourceSummary`、`EvidenceSummary`、`PlannerInput`（含可选 `repairContext: { issues: ValidationIssue[]; previousPlan: CollaborationPlan }`）
- Produces: `PlannerResult { plan: CollaborationPlan; meta: PlannerRunMeta }`
- Produces: `Planner { readonly name: string; plan(input: PlannerInput): Promise<PlannerResult> }`
- Produces: `PlannerOrchestratorOptions { planner; validator; maxRepairAttempts? }`
- Produces: `PlannerOrchestrator.propose(input): Promise<ProposeResult>`，`ProposeResult { plan?, result, attempts, repairHistory, totalCostUsd }`
- Produces: `MockPlanner` —— **只允许在单元测试构造；任何探测/切片代码不得使用**

修复循环语义：`needs_revision` 且未达上限时，把 `issues` 与上一版计划放进 `repairContext` 再次调用；`accepted / rejected / needs_human_approval` 或达到上限即返回。

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/planner-orchestrator.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockPlanner, PlannerOrchestrator, type PlannerInput } from '../../src/planning/planner.ts';
import { validatePlan } from '../../src/planning/plan-validator.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validEnvelope, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';

const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
]);

function baseInput(): PlannerInput {
  return {
    workItem: validWorkItem(),
    envelope: validEnvelope(),
    catalog,
    sources: [{ id: 'src_inventory', label: 'inventory', excerpt: 'sync adapter', versionRef: 'src_inventory@v1' }],
    reusableEvidence: [],
  };
}

test('orchestrator returns an accepted plan on the first attempt', async () => {
  const planner = new MockPlanner(() => validPlan());
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'accepted');
  assert.equal(proposal.attempts, 1);
  assert.equal(proposal.repairHistory.length, 0);
});

test('orchestrator feeds validator issues back and repairs within the limit', async () => {
  let calls = 0;
  const planner = new MockPlanner((input) => {
    calls += 1;
    if (calls === 1) return validPlan({ nodes: [badNode()] });
    assert.ok(input.repairContext?.issues.length);
    return validPlan();
  });
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 2 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'accepted');
  assert.equal(proposal.attempts, 2);
  assert.equal(proposal.repairHistory.length, 1);
});

test('orchestrator stops at the repair limit', async () => {
  const planner = new MockPlanner(() => validPlan({ nodes: [badNode()] }));
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 1 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'needs_revision');
  assert.equal(proposal.attempts, 2);
});

function badNode() {
  return makeNode({
    completionCriteria: [{ id: 'c1', kind: 'evidence', description: 'needs evidence', refs: [] }],
  });
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/planner-orchestrator.test.ts`
Expected: FAIL，`MockPlanner` 未定义

- [ ] **Step 3: Write minimal implementation**

```ts
// src/planning/planner.ts
import type { CollaborationPlan } from './schemas.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { CapabilityCatalog } from './capabilities.ts';
import type { WorkItem } from '../schemas.ts';
import type { ValidationIssue, ValidationResult, validatePlan } from './plan-validator.ts';

export interface SourceSummary {
  id: string;
  label: string;
  excerpt: string;
  versionRef: string;
}

export interface EvidenceSummary {
  id: string;
  summary: string;
  status: string;
  appliesWhen: string[];
}

export interface PlannerInput {
  workItem: WorkItem;
  envelope: AutonomyEnvelope;
  catalog: CapabilityCatalog;
  sources: SourceSummary[];
  reusableEvidence: EvidenceSummary[];
  repairContext?: { issues: ValidationIssue[]; previousPlan: CollaborationPlan };
}

export interface PlannerRunMeta {
  costUsd?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface PlannerResult {
  plan: CollaborationPlan;
  meta: PlannerRunMeta;
}

export interface Planner {
  readonly name: string;
  plan(input: PlannerInput): Promise<PlannerResult>;
}

export interface PlannerOrchestratorOptions {
  planner: Planner;
  validator: typeof validatePlan;
  maxRepairAttempts?: number;
}

export interface ProposeResult {
  plan?: CollaborationPlan;
  result: ValidationResult;
  attempts: number;
  repairHistory: ValidationIssue[][];
  totalCostUsd: number;
}

export class PlannerOrchestrator {
  private readonly planner: Planner;
  private readonly validator: typeof validatePlan;
  private readonly maxRepairAttempts: number;

  constructor(options: PlannerOrchestratorOptions) {
    this.planner = options.planner;
    this.validator = options.validator;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
  }

  async propose(input: PlannerInput): Promise<ProposeResult> {
    const repairHistory: ValidationIssue[][] = [];
    let plan: CollaborationPlan | undefined;
    let result: ValidationResult = { verdict: 'needs_revision', issues: [] };
    let totalCostUsd = 0;
    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      const plannerInput: PlannerInput =
        plan && result.issues.length
          ? { ...input, repairContext: { issues: result.issues, previousPlan: plan } }
          : input;
      const proposal = await this.planner.plan(plannerInput);
      totalCostUsd += proposal.meta.costUsd ?? 0;
      plan = proposal.plan;
      result = this.validator({ plan, envelope: input.envelope, workItem: input.workItem, catalog: input.catalog });
      if (result.verdict !== 'needs_revision') break;
      repairHistory.push(result.issues);
    }
    return { plan, result, attempts: repairHistory.length + 1, repairHistory, totalCostUsd };
  }
}

/**
 * Test-only planner. Never use in probe or slice runs; it cannot demonstrate
 * real planning quality (see spec §9).
 */
export class MockPlanner implements Planner {
  readonly name = 'mock-planner';
  constructor(private readonly script: (input: PlannerInput) => CollaborationPlan) {}

  async plan(input: PlannerInput): Promise<PlannerResult> {
    return { plan: structuredClone(this.script(input)), meta: {} };
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test tests/unit/planner-orchestrator.test.ts`
Expected: PASS（3/3）

- [ ] **Step 5: Commit**

```bash
git add src/planning/planner.ts tests/unit/planner-orchestrator.test.ts
git commit -m "feat(planning): planner interface, repair orchestrator and test-only mock"
```

---

## Task 12: Planner Prompt 与 CliPlannerAdapter

**Files:**
- Create: `src/planning/planner-prompt.ts`, `src/planning/cli-planner.ts`
- Test: `tests/fixtures/fake-planner-claude.mjs`, `tests/fixtures/fake-planner-chrys.mjs`, `tests/unit/cli-planner.test.ts`

**Interfaces:**
- Produces: `renderPlannerPrompt(input: PlannerInput): string` —— 包含 goal/constraints/expectedOutcomes、Envelope 摘要、能力目录、Source 摘要、reusable Evidence、输出契约说明与 repair 反馈；**不得要求链式思考**
- Produces: `CliPlannerConfig { command; args?; outputMode: 'json_stdout' | 'claude_jsonl' | 'chrys_json'; promptViaStdin?; timeoutMs?; model?; provider?; promptVersion?; costEstimateRates?; chrysStateDir?; workspacePath }`
- Produces: `CliPlannerAdapter implements Planner` —— 复用 `runCliProcess`、`extractClaudeResult`、`extractChrysResult`、`extractJsonPayload`，输出经 `CollaborationPlanSchema.parse`

- [ ] **Step 1: Write the failing fixtures**

```js
// tests/fixtures/fake-planner-claude.mjs
import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const plan = {
  id: 'plan_fake_claude',
  workItemId: 'wi_fake',
  version: 1,
  goal: 'Verify the fake plan parses',
  assumptions: [],
  rationale: 'single agent is enough for a simple question',
  nodes: [
    {
      id: 'answer',
      role: 'Analyst',
      objective: 'Answer with a code check',
      dependsOn: [],
      inputRefs: [],
      contextPolicy: { visibility: 'shared' },
      capabilityRequirements: ['code-analysis'],
      operator: { type: 'agent_task', instructions: 'Search and answer' },
      completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'answer note', refs: ['artifact:answer'] }],
      failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
      allocatedBudget: { maxTimeMs: 60000 },
    },
  ],
  stopConditions: [{ id: 's1', kind: 'artifact', description: 'answer produced', refs: ['artifact:answer'], targetOutcome: 'resolved' }],
  escalationConditions: [],
  budgetAllocation: { maxTotalTimeMs: 120000, maxTotalAgents: 1, maxTotalRounds: 1 },
  createdByRunId: 'run_planner',
  status: 'proposed',
};

process.stdout.write(
  `${JSON.stringify({ type: 'result', result: '```json\n' + JSON.stringify(plan) + '\n```', usage: { input_tokens: 100, output_tokens: 50 }, total_cost_usd: 0.001 })}`,
);
```

```js
// tests/fixtures/fake-planner-chrys.mjs
import { readFileSync } from 'node:fs';

const promptFile = process.argv[2];
if (promptFile) readFileSync(promptFile, 'utf8');

const plan = {
  id: 'plan_fake_chrys',
  workItemId: 'wi_fake',
  goal: 'Verify the fake plan parses',
  rationale: 'single agent is enough for a simple question',
  nodes: [
    {
      id: 'answer',
      role: 'Analyst',
      objective: 'Answer with a code check',
      contextPolicy: { visibility: 'shared' },
      capabilityRequirements: ['code-analysis'],
      operator: { type: 'agent_task', instructions: 'Search and answer' },
      completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'answer note', refs: ['artifact:answer'] }],
      failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
      allocatedBudget: { maxTimeMs: 60000 },
    },
  ],
  stopConditions: [{ id: 's1', kind: 'artifact', description: 'answer produced', refs: ['artifact:answer'], targetOutcome: 'resolved' }],
  budgetAllocation: { maxTotalTimeMs: 120000, maxTotalAgents: 1, maxTotalRounds: 1 },
  createdByRunId: 'run_planner',
};

process.stdout.write(JSON.stringify({ result: '```json\n' + JSON.stringify(plan) + '\n```', session_id: '00000000-0000-4000-8000-000000000000', duration: 1.5 }));
```

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/cli-planner.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CliPlannerAdapter } from '../../src/planning/cli-planner.ts';
import { renderPlannerPrompt } from '../../src/planning/planner-prompt.ts';
import type { PlannerInput } from '../../src/planning/planner.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { validEnvelope, validWorkItem } from '../helpers/plan-fixtures.ts';

const fixturesDir = join(process.cwd(), 'tests', 'fixtures');

function input(): PlannerInput {
  return {
    workItem: validWorkItem(),
    envelope: validEnvelope(),
    catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] }]),
    sources: [{ id: 'src_1', label: 'inventory', excerpt: 'sync', versionRef: 'src_1@v1' }],
    reusableEvidence: [],
  };
}

test('prompt includes constraints, envelope limits and no chain-of-thought request', () => {
  const prompt = renderPlannerPrompt(input());
  assert.ok(prompt.includes('No production access'));
  assert.ok(prompt.includes('maxAgents'));
  assert.ok(!/chain.of.thought|思维链|step by step reasoning/i.test(prompt));
});

test('cli planner parses claude jsonl output', async () => {
  const adapter = new CliPlannerAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-planner-claude.mjs'), '{promptFile}'],
    outputMode: 'claude_jsonl',
    promptViaStdin: false,
    timeoutMs: 10_000,
    workspacePath: mkdtempSync(join(tmpdir(), 'counterpoint-planner-')),
  });
  const result = await adapter.plan(input());
  assert.equal(result.plan.id, 'plan_fake_claude');
  assert.equal(result.meta.provider, 'claude-code');
});

test('cli planner parses chrys json output', async () => {
  const adapter = new CliPlannerAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-planner-chrys.mjs'), '{promptFile}'],
    outputMode: 'chrys_json',
    timeoutMs: 10_000,
    workspacePath: mkdtempSync(join(tmpdir(), 'counterpoint-planner-')),
  });
  const result = await adapter.plan(input());
  assert.equal(result.plan.id, 'plan_fake_chrys');
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `node --test tests/unit/cli-planner.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 4: Write minimal implementation**

```ts
// src/planning/planner-prompt.ts
import type { PlannerInput } from './planner.ts';

export function renderPlannerPrompt(input: PlannerInput): string {
  const lines: string[] = [];
  lines.push('You are a collaboration planner. Design a structured, executable plan for the work item below.');
  lines.push('Output exactly one JSON object matching the CollaborationPlan schema described below. No commentary outside the JSON.');
  lines.push('');
  lines.push('## Work item');
  lines.push(`Title: ${input.workItem.title}`);
  if (input.workItem.goal) lines.push(`Goal: ${input.workItem.goal}`);
  if (input.workItem.constraints.length) lines.push(`Constraints:\n- ${input.workItem.constraints.join('\n- ')}`);
  if (input.workItem.expectedOutcomes.length) lines.push(`Expected outcomes:\n- ${input.workItem.expectedOutcomes.join('\n- ')}`);
  lines.push('');
  lines.push('## Autonomy envelope (hard limits; you cannot exceed them)');
  lines.push(`- maxAgents: ${input.envelope.maxAgents}`);
  lines.push(`- maxParallelism: ${input.envelope.maxParallelism}`);
  lines.push(`- maxRounds: ${input.envelope.maxRounds}`);
  lines.push(`- timeBudgetMs: ${input.envelope.timeBudgetMs}`);
  lines.push(`- allowedTools: ${input.envelope.allowedTools.join(', ') || '(none)'}`);
  lines.push(`- writableScopes: ${input.envelope.writableScopes.join(', ') || '(none)'}`);
  lines.push('');
  lines.push('## Capabilities');
  for (const [capability, descriptor] of input.catalog.byCapability) {
    lines.push(`- ${capability} (${descriptor.adapterKind}): ${descriptor.tools.join(', ')}`);
  }
  lines.push('');
  lines.push('## Operator kinds');
  lines.push('- agent_task { type, instructions }');
  lines.push('- tool_task { type, command, args }');
  lines.push('- verification { type, command, args, targetRefs }');
  lines.push('- independent_review { type, rubricRef, targetNodeIds }');
  lines.push('- counterpoint_deliberation { type, workerCount, blind, commitReveal, challengeRounds, verificationPolicy, reviewerPolicy }');
  lines.push('- human_gate { type, summary }');
  lines.push('');
  lines.push('## Node contract');
  lines.push('Each node needs: id, role, objective, dependsOn[], inputRefs[], contextPolicy { readScopes[], writeScopes[], visibility, includeObjectTypes[], excludeObjectTypes[] }, capabilityRequirements[], operator, completionCriteria[{id,kind,description,refs}], failurePolicy { maxRetries, onFailure }, allocatedBudget { maxTimeMs }.');
  lines.push('Blind nodes must not share inputRefs with each other. Reviewers must not share capabilities with nodes they review. Evidence completion criteria must carry refs.');
  if (input.sources.length) {
    lines.push('');
    lines.push('## Sources');
    for (const source of input.sources) lines.push(`- ${source.label} (${source.versionRef}): ${source.excerpt}`);
  }
  if (input.reusableEvidence.length) {
    lines.push('');
    lines.push('## Reusable evidence');
    for (const evidence of input.reusableEvidence) lines.push(`- ${evidence.id} [${evidence.status}]: ${evidence.summary}`);
  }
  if (input.repairContext) {
    lines.push('');
    lines.push('## Previous plan was rejected by the deterministic validator');
    for (const issue of input.repairContext.issues) lines.push(`- ${issue.code}: ${issue.message}`);
    lines.push('Revise the plan to fix every listed issue. Do not repeat the same invalid structure.');
  }
  return lines.join('\n');
}
```

```ts
// src/planning/cli-planner.ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { runCliProcess } from '../adapters/cli-agent.ts';
import { extractChrysResult, extractClaudeResult, type CliMeta, type CostEstimateRates } from '../adapters/cli-meta.ts';
import { extractJsonPayload } from '../adapters/output.ts';
import { CollaborationPlanSchema } from './schemas.ts';
import type { Planner, PlannerInput, PlannerResult } from './planner.ts';
import { renderPlannerPrompt } from './planner-prompt.ts';

export type PlannerOutputMode = 'json_stdout' | 'claude_jsonl' | 'chrys_json';

export interface CliPlannerConfig {
  command: string;
  args?: string[];
  outputMode: PlannerOutputMode;
  promptViaStdin?: boolean;
  timeoutMs?: number;
  model?: string;
  provider?: string;
  promptVersion?: string;
  costEstimateRates?: CostEstimateRates;
  chrysStateDir?: string;
  workspacePath: string;
}

export class CliPlannerAdapter implements Planner {
  readonly name: string;
  private readonly config: CliPlannerConfig;

  constructor(config: CliPlannerConfig) {
    this.config = config;
    this.name = `cli-planner/${config.command}`;
  }

  async plan(input: PlannerInput): Promise<PlannerResult> {
    const prompt = renderPlannerPrompt(input);
    const promptFile = join(this.config.workspacePath, 'planner-prompt.txt');
    writeFileSync(promptFile, prompt, 'utf8');
    const args = (this.config.args ?? []).map((arg) =>
      arg
        .replaceAll('{promptFile}', promptFile)
        .replaceAll('{workspace}', this.config.workspacePath),
    );
    const { stdout, stderr } = await runCliProcess({
      command: this.config.command,
      args,
      cwd: this.config.workspacePath,
      timeoutMs: this.config.timeoutMs ?? 600_000,
      stdinText: this.config.promptViaStdin ? prompt : undefined,
    });
    let text = stdout;
    let meta: CliMeta = {};
    if (this.config.outputMode === 'claude_jsonl') {
      ({ text, meta } = extractClaudeResult(stdout));
    } else if (this.config.outputMode === 'chrys_json') {
      ({ text, meta } = extractChrysResult(stdout, {
        stateDir: this.config.chrysStateDir,
        rates: this.config.costEstimateRates,
      }));
    }
    if (!text.trim()) throw new Error(`Planner produced no output; stderr: ${stderr.slice(0, 1000)}`);
    const plan = CollaborationPlanSchema.parse(extractJsonPayload(text));
    return {
      plan,
      meta: {
        costUsd: meta.costUsd,
        durationMs: meta.durationMs,
        model: meta.model ?? this.config.model,
        provider: meta.provider ?? this.config.provider,
        usage: meta.usage,
      },
    };
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `node --test tests/unit/cli-planner.test.ts`
Expected: PASS（3/3）

- [ ] **Step 6: Commit**

```bash
git add src/planning/planner-prompt.ts src/planning/cli-planner.ts tests/fixtures/fake-planner-claude.mjs tests/fixtures/fake-planner-chrys.mjs tests/unit/cli-planner.test.ts
git commit -m "feat(planning): real CLI planner adapter and prompt contract"
```

---

## Task 13: 真实 Planner 探测（Chrys + Claude Code）

**Files:**
- Create: `apps/cli/planner-fixtures.ts`, `apps/cli/planner-probe.ts`
- Modify: `package.json`, `README.md`

**Interfaces:**
- Produces: `ProbeFixture { id; label; expectedTopology; workItem; envelopeOverrides; sources }`
- Produces: `PROBE_FIXTURES`：`simple-bug`（期望 1 Agent + 1 Verifier）、`complex-bug`（期望多节点 + 并行假设 + 验证 + Review）
- Produces: `topologySignature(plan): string`

**关键行为（与 spec §9 L1 一致）：**

- 两个真实 Planner：Chrys（`CHRYS_BIN` 默认 `C:\Users\tgyzc\project\chrys\.venv\Scripts\chrys.exe`）与 Claude Code（`CLAUDE_BIN` 默认 `C:\Users\tgyzc\.local\bin\claude.exe`，模型默认 `deepseek-v4-pro[1m]`）；
- 每个 Fixture × Planner 各跑一次 `PlannerOrchestrator.propose`（修复上限 2）；
- 累计成本超过 $6 立即停止并报告 `budget-exceeded`；
- 报告写入 `data/probe/probe-report-<stamp>.json` 与 `.md`；
- 默认退出码 0（探测是报告，不是 CI 门禁）；`--strict` 时若验收未达成退出 1。

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/planner-probe.test.ts
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PROBE_FIXTURES, topologySignature } from '../../apps/cli/planner-fixtures.ts';
import { validPlan } from '../helpers/plan-fixtures.ts';

test('probe fixtures cover simple and complex bug shapes', () => {
  assert.deepEqual(PROBE_FIXTURES.map((fixture) => fixture.id), ['simple-bug', 'complex-bug']);
});

test('topology signature differs when node structure differs', () => {
  const simple = validPlan();
  const complex = validPlan({
    nodes: [
      ...validPlan().nodes,
      {
        id: 'verify',
        role: 'Verifier',
        objective: 'run regression tests',
        dependsOn: ['repro'],
        contextPolicy: { visibility: 'shared' },
        capabilityRequirements: ['verification'],
        operator: { type: 'verification', command: 'node', args: ['--version'] },
        completionCriteria: [{ id: 'c2', kind: 'evidence', description: 'tests pass', refs: ['evidence:tests'] }],
        failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
        allocatedBudget: { maxTimeMs: 60_000 },
      },
    ],
  });
  assert.notEqual(topologySignature(simple), topologySignature(complex));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test tests/unit/planner-probe.test.ts`
Expected: FAIL，模块不存在

- [ ] **Step 3: Write minimal implementation**

```ts
// apps/cli/planner-fixtures.ts
import type { AutonomyEnvelopeOverrides } from '../../src/autonomy/autonomy-envelope.ts';
import type { CollaborationPlan } from '../../src/planning/schemas.ts';
import type { SourceSummary } from '../../src/planning/planner.ts';

export interface ProbeFixture {
  id: 'simple-bug' | 'complex-bug';
  label: string;
  expectedTopology: 'single-agent' | 'multi-node';
  workItem: {
    kind: 'bug';
    title: string;
    goal: string;
    constraints: string[];
    expectedOutcomes: string[];
    sourceRefs: string[];
  };
  envelopeOverrides: AutonomyEnvelopeOverrides;
  sources: SourceSummary[];
}

export const PROBE_FIXTURES: ProbeFixture[] = [
  {
    id: 'simple-bug',
    label: 'Simple engineering question',
    expectedTopology: 'single-agent',
    workItem: {
      kind: 'bug',
      title: 'Typo breaks the health endpoint',
      goal: 'Find the exact failing expression and confirm it with a test',
      constraints: ['Read-only repository access'],
      expectedOutcomes: ['A verifiable fix'],
      sourceRefs: ['src_api@v1'],
    },
    envelopeOverrides: { maxAgents: 2, maxParallelism: 1, timeBudgetMs: 10 * 60_000 },
    sources: [{ id: 'src_api', label: 'api server', excerpt: 'health handler', versionRef: 'src_api@v1' }],
  },
  {
    id: 'complex-bug',
    label: 'Complex intermittent data-loss bug',
    expectedTopology: 'multi-node',
    workItem: {
      kind: 'bug',
      title: 'Inventory sync intermittently drops data',
      goal: 'Locate a verifiable root cause and produce a fix plus regression plan',
      constraints: ['Read the repo and run tests; no production access'],
      expectedOutcomes: ['Root cause', 'Fix candidate', 'Regression evidence'],
      sourceRefs: ['src_inventory@v1', 'src_tests@v1'],
    },
    envelopeOverrides: {},
    sources: [
      { id: 'src_inventory', label: 'inventory sync adapter', excerpt: 'retry window logic', versionRef: 'src_inventory@v1' },
      { id: 'src_tests', label: 'sync tests', excerpt: 'idempotency tests', versionRef: 'src_tests@v1' },
    ],
  },
];

export function topologySignature(plan: CollaborationPlan): string {
  const signature = plan.nodes
    .map((node) => ({
      id: node.id,
      role: node.role,
      operator: node.operator.type,
      dependsOn: [...node.dependsOn].sort(),
      visibility: node.contextPolicy.visibility,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(signature);
}
```

```ts
// apps/cli/planner-probe.ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { defaultAutonomyEnvelope, tightenEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { validatePlan } from '../../src/planning/plan-validator.ts';
import { PlannerOrchestrator, type PlannerInput } from '../../src/planning/planner.ts';
import { CliPlannerAdapter } from '../../src/planning/cli-planner.ts';
import { PROBE_FIXTURES, topologySignature } from './planner-fixtures.ts';

const chrysBin = process.env.CHRYS_BIN ?? 'C:\\Users\\tgyzc\\project\\chrys\\.venv\\Scripts\\chrys.exe';
const claudeBin = process.env.CLAUDE_BIN ?? 'C:\\Users\\tgyzc\\.local\\bin\\claude.exe';
const claudeModel = process.env.PLANNER_MODEL ?? 'deepseek-v4-pro[1m]';
const budgetUsd = Number(process.env.PROBE_BUDGET_USD ?? 6);
const chrysCostRates = { inputPerMTokenUsd: 5, outputPerMTokenUsd: 25 };
const workspaceRoot = process.env.PROBE_WORKSPACE ?? join(process.cwd(), 'data', 'probe', 'workspaces');
const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
  { capability: 'verification', adapterKind: 'mock', tools: ['node', 'npm'] },
  { capability: 'independent-review', adapterKind: 'mock', tools: ['read_candidates'] },
]);

interface PlannerEntry {
  name: string;
  adapter: CliPlannerAdapter;
}

interface FixtureResult {
  fixture: string;
  planner: string;
  verdict: string;
  attempts: number;
  issueCodes: string[];
  topology: string;
  costUsd?: number;
  durationMs?: number;
  model?: string;
  error?: string;
}

async function main(): Promise<void> {
  mkdirSync(workspaceRoot, { recursive: true });
  const planners: PlannerEntry[] = [
    {
      name: 'chrys',
      adapter: new CliPlannerAdapter({
        command: chrysBin,
        args: ['run', '-a', 'Code', '--json', '-t', '{promptFile}', '-C', '{workspace}'],
        outputMode: 'chrys_json',
        timeoutMs: 600_000,
        model: 'deepseek-v4-pro',
        provider: 'chrys/deepseek-openai',
        costEstimateRates: chrysCostRates,
        workspacePath: join(workspaceRoot, 'chrys'),
      }),
    },
    {
      name: 'claude-code',
      adapter: new CliPlannerAdapter({
        command: claudeBin,
        args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', claudeModel],
        outputMode: 'claude_jsonl',
        promptViaStdin: true,
        timeoutMs: 600_000,
        model: claudeModel,
        provider: 'claude-code/anthropic-deepseek',
        workspacePath: join(workspaceRoot, 'claude'),
      }),
    },
  ];

  const results: FixtureResult[] = [];
  let spentUsd = 0;
  let budgetExceeded = false;

  for (const fixture of PROBE_FIXTURES) {
    const workspaceId = `probe_${fixture.id}`;
    const envelope = tightenEnvelope(defaultAutonomyEnvelope(workspaceId), fixture.envelopeOverrides);
    const input: PlannerInput = {
      workItem: {
        id: `wi_${fixture.id}`,
        workspaceId,
        kind: fixture.workItem.kind,
        title: fixture.workItem.title,
        ownerId: 'probe-operator',
        status: 'open',
        goal: fixture.workItem.goal,
        constraints: fixture.workItem.constraints,
        expectedOutcomes: fixture.workItem.expectedOutcomes,
        sourceRefs: fixture.workItem.sourceRefs,
        templateFields: {},
        currentConclusionRefs: [],
        knowledgeRefs: [],
        relations: [],
        entries: [],
        version: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      envelope,
      catalog,
      sources: fixture.sources,
      reusableEvidence: [],
    };
    for (const planner of planners) {
      if (spentUsd >= budgetUsd) {
        budgetExceeded = true;
        break;
      }
      mkdirSync(join(workspaceRoot, planner.name), { recursive: true });
      const orchestrator = new PlannerOrchestrator({ planner: planner.adapter, validator: validatePlan, maxRepairAttempts: 2 });
      const startedAt = Date.now();
      try {
        const proposal = await orchestrator.propose(input);
        spentUsd += proposal.totalCostUsd;
        results.push({
          fixture: fixture.id,
          planner: planner.name,
          verdict: proposal.result.verdict,
          attempts: proposal.attempts,
          issueCodes: proposal.result.issues.map((issue) => issue.code),
          topology: proposal.plan ? topologySignature(proposal.plan) : '',
          durationMs: Date.now() - startedAt,
        });
      } catch (error) {
        results.push({
          fixture: fixture.id,
          planner: planner.name,
          verdict: 'error',
          attempts: 0,
          issueCodes: [],
          topology: '',
          durationMs: Date.now() - startedAt,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (budgetExceeded) break;
  }

  const diversityByPlanner = new Map<string, boolean>();
  for (const planner of planners) {
    const rows = results.filter((row) => row.planner === planner.name && row.verdict === 'accepted');
    const signatures = new Set(rows.map((row) => row.topology));
    diversityByPlanner.set(planner.name, signatures.size >= 2);
  }
  const acceptance = {
    chrys: results.some((row) => row.planner === 'chrys' && row.verdict === 'accepted'),
    claude: results.some((row) => row.planner === 'claude-code' && row.verdict === 'accepted'),
  };
  const report = {
    formatVersion: 'planner-probe/0.1.0',
    generatedAt: new Date().toISOString(),
    budgetUsd,
    spentUsd: Number(spentUsd.toFixed(6)),
    budgetExceeded,
    results,
    acceptance,
    diversity: Object.fromEntries(diversityByPlanner),
  };
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(process.cwd(), 'data', 'probe');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, `probe-report-${stamp}.json`), JSON.stringify(report, null, 2), 'utf8');
  console.log(JSON.stringify(report, null, 2));

  const strict = process.argv.includes('--strict');
  const passed = acceptance.chrys && acceptance.claude && [...diversityByPlanner.values()].every(Boolean);
  if (strict && !passed) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[planner-probe] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
```

- [ ] **Step 4: Add npm script**

`package.json` scripts 增加：

```json
"probe:planner": "node apps/cli/planner-probe.ts"
```

README「里程碑路线」一节在 M0 前增加一行：

```markdown
- ▶ **M0 Planning Contract**：Plan/Validator/Compiler 契约 + 真实 Chrys/Claude Planner 探测（`npm run probe:planner`）。
```

- [ ] **Step 5: Run unit test and offline checks**

Run: `node --test tests/unit/planner-probe.test.ts && npm run typecheck && npm test`
Expected: 全绿（真实探测不在此步运行）

- [ ] **Step 6: Run the real probe（人工步骤，不进 CI）**

Run: `npm run probe:planner -- --strict`
Expected: 真实 Chrys 与 Claude Code 各产出合法计划，`simple-bug` 与 `complex-bug` 拓扑签名不同；报告写入 `data/probe/`；总成本 ≤ $6。

若 `--strict` 失败：记录报告，修 Prompt 契约或 Fixture，再跑一次；**不要修改 Validator 来迁就模型**。

- [ ] **Step 7: Commit**

```bash
git add apps/cli/planner-fixtures.ts apps/cli/planner-probe.ts tests/unit/planner-probe.test.ts src/planning/planner.ts package.json README.md
git commit -m "feat(cli): real planner probe for chrys and claude code"
```

---

## 测试计划与验收

回归基线：`npm run typecheck`、`npm test`（107 + 本计划新增 39 项断言 = 全绿）。

M0 DoD：

- [ ] 六类宪法违规全部有对应拒绝用例（Task 7/8/9）；
- [ ] 合法计划可编译为可调度 DAG（Task 10）；
- [ ] Chrys 与 Claude Code 各产出至少一份合法计划（Task 13 真实运行）；
- [ ] `simple-bug` 与 `complex-bug` 拓扑签名不同（Task 13 真实运行）；
- [ ] 探测成本、耗时、拒绝原因写入 `data/probe/` 报告。

## Phase M1（下一份计划）

M1 的详细任务计划在 M0 探测报告评审后单独编写（spec §9 明确要求先评审首次通过率与
拒绝原因，再进入 Scheduler/Operator/Replan）。范围预告：Budget Ledger、Scheduler、
六个 P0 Operator、`counterpoint_deliberation` facade、Replan Controller、CLI 复杂 Bug
闭环（真实 Chrys/Claude Code + 至少一次 Evidence-grounded PlanPatch），以及 spec §3.3
的 `plan.proposed / plan.validation_failed / plan.validated` 等事件在引擎/Scheduler
集成点上的追加（M0 的探测不落库，故不含这些事件）。

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-13-counterpoint-v02-m0-planning-contract.md`. Two execution options:

1. **Subagent-Driven (recommended)** — 每个 Task 派一个全新 subagent，任务间两级评审（使用 superpowers:subagent-driven-development）；
2. **Inline Execution** — 在本会话按 superpowers:executing-plans 分批执行并设检查点。

Which approach?
