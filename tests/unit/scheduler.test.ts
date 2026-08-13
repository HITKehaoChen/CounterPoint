import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Scheduler } from '../../src/execution/scheduler.ts';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { InMemoryStore } from '../../src/store.ts';
import { emptyDatabase, NodeRunSchema } from '../../src/schemas.ts';
import { PlanPatchSchema } from '../../src/planning/plan-patch.ts';
import { defaultAutonomyEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import { makeNode, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import type { WorkItem } from '../../src/schemas.ts';
import type { Store } from '../../src/store.ts';
import { JsonFileStore } from '../../src/store.ts';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Operator, OperatorResult } from '../../src/operators/operator.ts';
import type { OperatorRegistry } from '../../src/operators/operator.ts';

const catalog = catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]);

function succeeded(): OperatorResult {
  return { status: 'succeeded', artifactRefs: [], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {} };
}

function failed(message = 'boom'): OperatorResult {
  return { status: 'failed', artifactRefs: [], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {}, error: message };
}

function waiting(): OperatorResult {
  return { status: 'waiting_human', artifactRefs: [], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {} };
}

function makeScheduler(options: {
  db?: ReturnType<typeof emptyDatabase>;
  plan?: ReturnType<typeof validPlan>;
  operators?: OperatorRegistry;
  maxParallelism?: number;
  envelope?: ReturnType<typeof defaultAutonomyEnvelope>;
  workItem?: WorkItem;
  store?: Store;
  ledger?: BudgetLedger;
}) {
  const db = options.db ?? emptyDatabase();
  const envelope = options.envelope ?? defaultAutonomyEnvelope('ws');
  const plan = options.plan ?? validPlan();
  const graph = compilePlan({ plan, catalog });
  const scheduler = new Scheduler({
    db,
    store: options.store ?? new InMemoryStore(),
    envelope,
    operators: options.operators ?? new Map([['agent_task', { type: 'agent_task' as const, async run() { return succeeded(); } } satisfies Operator]]),
    ledger: options.ledger ?? new BudgetLedger(envelope),
    catalog,
    maxParallelism: options.maxParallelism ?? 2,
    resolveAgent: () => undefined,
    resolveReviewer: () => undefined,
  });
  scheduler.attach(graph, plan, options.workItem ?? validWorkItem());
  return { scheduler, db, graph, plan };
}

test('scheduler runs ready nodes in dependency order', async () => {
  const order: string[] = [];
  const ops: OperatorRegistry = new Map([
    ['agent_task', {
      type: 'agent_task',
      async run(ctx) {
        order.push(ctx.graphNode.planNodeId);
        return succeeded();
      },
    }],
  ]);
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const { scheduler, db } = makeScheduler({ plan, operators: ops });
  const outcome = await scheduler.runUntilIdle();
  assert.equal(outcome.completed, true);
  assert.deepEqual(order, ['a', 'b']);
  assert.equal(db.nodeRuns.filter((run) => run.status === 'succeeded').length, 2);
});

test('scheduler stops at a human gate', async () => {
  const ops: OperatorRegistry = new Map([
    ['human_gate', {
      type: 'human_gate',
      async run(ctx) {
        ctx.requestHumanGate({
          id: `hg_${ctx.nodeRun.id}`,
          workItemId: ctx.workItem.id,
          planId: ctx.nodeRun.planId,
          nodeId: ctx.graphNode.id,
          kind: 'high_risk',
          summary: 'need approval',
          requested: {},
          status: 'pending',
          availableActions: ['approve_once', 'reject_and_stop'],
          createdAt: new Date().toISOString(),
        });
        return waiting();
      },
    }],
  ]);
  const plan = validPlan({ nodes: [makeNode({ operator: { type: 'human_gate', summary: 'approve', options: ['approve_once', 'reject_and_stop'] } })] });
  const { scheduler, db } = makeScheduler({ plan, operators: ops });
  const outcome = await scheduler.runUntilIdle();
  assert.equal(outcome.waitingHuman, true);
  assert.equal(db.humanGateRequests.length, 1);
});

test('scheduler retries a transient failure within maxRetries', async () => {
  let calls = 0;
  const ops: OperatorRegistry = new Map([
    ['agent_task', {
      type: 'agent_task',
      async run() {
        calls += 1;
        return calls === 1 ? failed('transient') : succeeded();
      },
    }],
  ]);
  const plan = validPlan({ nodes: [makeNode({ failurePolicy: { maxRetries: 1, onFailure: 'fail_node' } })] });
  const { scheduler, db } = makeScheduler({ plan, operators: ops });
  await scheduler.runUntilIdle();
  assert.equal(db.nodeRuns[0].status, 'succeeded');
  assert.equal(db.nodeRuns[0].attempt, 2);
  assert.equal(calls, 2);
});

test('failure policy cancels pending children', async () => {
  const ops: OperatorRegistry = new Map([
    ['agent_task', {
      type: 'agent_task',
      async run(ctx) {
        return ctx.graphNode.planNodeId === 'a' ? failed('always fails') : succeeded();
      },
    }],
  ]);
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', failurePolicy: { maxRetries: 0, onFailure: 'cancel_pending_children' } }),
      makeNode({ id: 'b', dependsOn: ['a'] }),
    ],
  });
  const { scheduler, db } = makeScheduler({ plan, operators: ops });
  await scheduler.runUntilIdle();
  const runA = db.nodeRuns.find((run) => run.graphNodeId === 'gn_a')!;
  const runB = db.nodeRuns.find((run) => run.graphNodeId === 'gn_b')!;
  assert.equal(runA.status, 'failed');
  assert.equal(runB.status, 'cancelled');
  assert.equal(runB.cancelReason, 'failure_policy');
});

test('interrupted non-idempotent run waits for a human, read-only fails safely', () => {
  const db = emptyDatabase();
  db.nodeRuns.push(
    NodeRunSchema.parse({ id: 'nr_side', workItemId: 'wi', planId: 'plan', planVersion: 1, graphNodeId: 'gn_x', role: 'x', operatorType: 'tool_task', status: 'running', effectClass: 'non_idempotent' }),
    NodeRunSchema.parse({ id: 'nr_read', workItemId: 'wi', planId: 'plan', planVersion: 1, graphNodeId: 'gn_y', role: 'y', operatorType: 'verification', status: 'running', effectClass: 'read_only' }),
  );
  new Scheduler({
    db,
    store: new InMemoryStore(),
    envelope: defaultAutonomyEnvelope('ws'),
    operators: new Map(),
    ledger: new BudgetLedger(defaultAutonomyEnvelope('ws')),
    catalog,
    maxParallelism: 2,
    resolveAgent: () => undefined,
    resolveReviewer: () => undefined,
  });
  assert.equal(db.nodeRuns[0].status, 'waiting_human');
  assert.equal(db.humanGateRequests.length, 1);
  assert.equal(db.nodeRuns[1].status, 'ready');
  assert.match(db.nodeRuns[1].error ?? '', /interrupted/);
});

test('applyPlanUpdate cancels pending nodes atomically and rejects immutable targets', async () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const { scheduler, db } = makeScheduler({ plan, operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]) });
  scheduler.getGraph().nodes.find((node) => node.planNodeId === 'a')!.status = 'succeeded';
  db.nodeRuns.find((run) => run.graphNodeId === 'gn_a')!.status = 'succeeded';
  const updatedPlan = validPlan({ version: 2, nodes: [makeNode({ id: 'a' })] });
  const patch = PlanPatchSchema.parse({
    id: 'p1',
    basePlanVersion: 1,
    reason: 'b disproved',
    evidenceRefs: ['evidence:e1'],
    operations: [{ op: 'cancel_pending_node', nodeId: 'b', reason: 'disproved' }],
    proposedByRunId: 'nr_a',
    createdAt: 't',
  });
  scheduler.applyPlanUpdate({ previousPlan: plan, updatedPlan, patch });
  const runB = db.nodeRuns.find((run) => run.graphNodeId === 'gn_b')!;
  assert.equal(runB.status, 'cancelled');
  assert.equal(runB.cancelReason, 'patch');
  assert.equal((runB.outputs as { cancelled_by_patch?: string }).cancelled_by_patch, 'p1');
  assert.equal(scheduler.getGraph().nodes.length, 1);
  const patch2 = PlanPatchSchema.parse({
    id: 'p2',
    basePlanVersion: 2,
    reason: 'remove a',
    evidenceRefs: ['evidence:e1'],
    operations: [{ op: 'cancel_pending_node', nodeId: 'a', reason: 'immutable' }],
    proposedByRunId: 'nr_a',
    createdAt: 't',
  });
  assert.throws(
    () => scheduler.applyPlanUpdate({ previousPlan: updatedPlan, updatedPlan: validPlan({ version: 3, nodes: [makeNode({ id: 'b', dependsOn: ['a'] })] }), patch: patch2 }),
    /PATCH_TARGET_IMMUTABLE/,
  );
  assert.throws(
    () => scheduler.applyPlanUpdate({ previousPlan: plan, updatedPlan: validPlan({ version: 3, nodes: [makeNode({ id: 'a' })] }), patch: patch2 }),
    /VERSION_CONFLICT/,
  );
});

test('parallelism bound serializes ready nodes', async () => {
  const events: string[] = [];
  const ops: OperatorRegistry = new Map([
    ['agent_task', {
      type: 'agent_task',
      async run(ctx) {
        events.push(`start:${ctx.graphNode.planNodeId}`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`end:${ctx.graphNode.planNodeId}`);
        return succeeded();
      },
    }],
  ]);
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b' })] });
  const { scheduler } = makeScheduler({ plan, operators: ops, maxParallelism: 1 });
  await scheduler.runUntilIdle();
  assert.deepEqual(events, ['start:a', 'end:a', 'start:b', 'end:b']);
});

test('runUntilIdle is idempotent after completion', async () => {
  const { scheduler, db } = makeScheduler({ operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]) });
  await scheduler.runUntilIdle();
  const count = db.nodeRuns.length;
  const again = await scheduler.runUntilIdle();
  assert.equal(again.completed, true);
  assert.equal(db.nodeRuns.length, count);
});

test('node runs and context do not leak across work items', async () => {
  const db = emptyDatabase();
  const planA = validPlan({ id: 'planA', nodes: [makeNode({ id: 'a' })] });
  const publish: Operator = {
    type: 'agent_task',
    async run(ctx) {
      ctx.commit({ artifacts: [{ logicalName: 'a-art', type: 'text', content: 'from-A', ownerRunId: ctx.nodeRun.id }] });
      return { status: 'succeeded', artifactRefs: ['a-art@v1'], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {} };
    },
  };
  const workItemA = { ...validWorkItem(), id: 'wi_A' };
  const a = makeScheduler({ db, plan: planA, operators: new Map([['agent_task', publish]]), workItem: workItemA });
  await a.scheduler.runUntilIdle();
  const seen: string[] = [];
  const observe: Operator = {
    type: 'agent_task',
    async run(ctx) {
      seen.push(...ctx.contextView.visible.artifacts);
      return succeeded();
    },
  };
  const planB = validPlan({ id: 'planB', nodes: [makeNode({ id: 'a' })] });
  const workItemB = { ...validWorkItem(), id: 'wi_B' };
  const b = makeScheduler({ db, plan: planB, operators: new Map([['agent_task', observe]]), workItem: workItemB });
  await b.scheduler.runUntilIdle();
  assert.equal(db.nodeRuns.length, 2);
  assert.equal(seen.includes('a-art@v1'), false);
});

test('context view is persisted and bound to the run before execution', async () => {
  const { scheduler, db } = makeScheduler({ operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]) });
  await scheduler.runUntilIdle();
  const run = db.nodeRuns[0];
  assert.ok(run.contextViewId);
  assert.equal(db.contextViews.length, 1);
  assert.equal(db.contextViews[0].id, run.contextViewId);
});

test('agent fingerprint is stored on the node run', async () => {
  const ops: OperatorRegistry = new Map([
    ['agent_task', {
      type: 'agent_task',
      async run() {
        return { ...succeeded(), outputs: { fingerprint: { adapter: 'cli-agent', model: 'm' } } };
      },
    }],
  ]);
  const { scheduler, db } = makeScheduler({ operators: ops });
  await scheduler.runUntilIdle();
  assert.equal((db.nodeRuns[0].adapterFingerprint as { adapter?: string }).adapter, 'cli-agent');
});

test('reserve, missing operator and settle failures terminate both node and run', async () => {
  const reserveFail = makeScheduler({
    envelope: defaultAutonomyEnvelope('ws'),
    operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]),
  });
  // node budget exceeds envelope: budget default 1_200_000ms; override via custom envelope below instead
  const smallEnvelope = defaultAutonomyEnvelope('ws');
  const db2 = emptyDatabase();
  const scheduler2 = new Scheduler({
    db: db2,
    store: new InMemoryStore(),
    envelope: smallEnvelope,
    operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]),
    ledger: new BudgetLedger(smallEnvelope),
    catalog,
    maxParallelism: 2,
    resolveAgent: () => undefined,
    resolveReviewer: () => undefined,
  });
  const bigPlan = validPlan({ nodes: [makeNode({ allocatedBudget: { maxTimeMs: 9_999_999 } })] });
  const bigGraph = compilePlan({ plan: bigPlan, catalog });
  scheduler2.attach(bigGraph, bigPlan, validWorkItem());
  const reserveOutcome = await scheduler2.runUntilIdle();
  assert.equal(reserveOutcome.completed, true);
  assert.equal(db2.nodeRuns[0].status, 'failed');
  assert.equal(bigGraph.nodes[0].status, 'failed');

  const missingOp = makeScheduler({ operators: new Map() });
  await missingOp.scheduler.runUntilIdle();
  assert.equal(missingOp.db.nodeRuns[0].status, 'failed');
  assert.equal(missingOp.graph.nodes[0].status, 'failed');

  const settleFailOps: OperatorRegistry = new Map([
    ['agent_task', { type: 'agent_task', async run() { return { ...succeeded(), usage: { timeMs: 999_999 } }; } }],
  ]);
  const settleFailPlan = validPlan({ nodes: [makeNode({ allocatedBudget: { maxTimeMs: 1000 } })] });
  const settleFail = makeScheduler({ plan: settleFailPlan, operators: settleFailOps });
  await settleFail.scheduler.runUntilIdle();
  assert.equal(settleFail.db.nodeRuns[0].status, 'failed');
  assert.equal(settleFail.graph.nodes[0].status, 'failed');
});

test('recovered non-idempotent gate can be reconciled without auto rerun', async () => {
  const db = emptyDatabase();
  db.nodeRuns.push(
    NodeRunSchema.parse({ id: 'nr_side', workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, graphNodeId: 'gn_x', role: 'x', operatorType: 'tool_task', status: 'running', effectClass: 'non_idempotent' }),
  );
  const plan = validPlan({ nodes: [makeNode({ id: 'x', operator: { type: 'tool_task', command: 'node', args: [], effectClass: 'non_idempotent' } })] });
  const { scheduler, db: db2 } = makeScheduler({ db, plan, operators: new Map() });
  const run = db2.nodeRuns[0];
  await scheduler.resumeGate(run.id, 'approve_once', { reconciliation: 'confirm_completed' });
  const gate = db2.humanGateRequests[0];
  assert.equal(run.status, 'succeeded');
  assert.equal(gate.status, 'approved');
  assert.ok(gate.resolvedAt);
  await assert.rejects(() => scheduler.resumeGate(run.id, 'approve_once', { reconciliation: 'confirm_completed' }), /GATE_ALREADY_RESOLVED/);
  assert.equal(run.attempt, 0);
});

test('recovered read-only run retries after ledger snapshot restore', async () => {
  const db = emptyDatabase();
  const envelope = defaultAutonomyEnvelope('ws');
  const firstLedger = new BudgetLedger(envelope);
  firstLedger.reserve('nr_read', { maxTimeMs: 100 });
  const restored = new BudgetLedger(envelope, firstLedger.snapshot());
  db.nodeRuns.push(
    NodeRunSchema.parse({ id: 'nr_read', workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, graphNodeId: 'gn_a', role: 'a', operatorType: 'agent_task', status: 'running', effectClass: 'read_only' }),
  );
  const plan = validPlan({ nodes: [makeNode({ id: 'a' })] });
  const ops: OperatorRegistry = new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]);
  const { scheduler } = makeScheduler({ db, plan, operators: ops, ledger: restored });
  const outcome = await scheduler.runUntilIdle();
  assert.equal(outcome.completed, true);
  assert.equal(db.nodeRuns[0].status, 'succeeded');
  assert.equal(db.nodeRuns[0].attempt, 1);
});

test('modifying a started node definition is rejected', async () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' })] });
  const { scheduler, db } = makeScheduler({ plan, operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]) });
  scheduler.getGraph().nodes[0].status = 'succeeded';
  db.nodeRuns[0].status = 'succeeded';
  db.nodeRuns[0].attempt = 1;
  const changed = validPlan({ version: 2, nodes: [makeNode({ id: 'a', objective: 'different objective' })] });
  const patch = PlanPatchSchema.parse({ id: 'p3', basePlanVersion: 1, reason: 'x', evidenceRefs: ['evidence:e1'], operations: [{ op: 'replace_pending_node', nodeId: 'a', replacement: changed.nodes[0], reason: 'x' }], proposedByRunId: 'nr', createdAt: 't' });
  assert.throws(() => scheduler.applyPlanUpdate({ previousPlan: plan, updatedPlan: changed, patch }), /PATCH_TARGET_IMMUTABLE/);
});

test('replacing a pending node creates a new node run for the new plan version', async () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const { scheduler, db } = makeScheduler({ plan, operators: new Map([['agent_task', { type: 'agent_task', async run() { return succeeded(); } }]]) });
  scheduler.getGraph().nodes.find((node) => node.planNodeId === 'a')!.status = 'succeeded';
  db.nodeRuns.find((run) => run.graphNodeId === 'gn_a')!.status = 'succeeded';
  const changed = validPlan({ version: 2, nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'], objective: 'new objective' })] });
  const patch = PlanPatchSchema.parse({ id: 'p4', basePlanVersion: 1, reason: 'x', evidenceRefs: ['evidence:e1'], operations: [{ op: 'replace_pending_node', nodeId: 'b', replacement: changed.nodes[1], reason: 'x' }], proposedByRunId: 'nr', createdAt: 't' });
  scheduler.applyPlanUpdate({ previousPlan: plan, updatedPlan: changed, patch });
  const bRuns = db.nodeRuns.filter((run) => run.graphNodeId === 'gn_b');
  assert.equal(bRuns.length, 2);
  const oldRun = bRuns.find((run) => run.planVersion === 1)!;
  const newRun = bRuns.find((run) => run.planVersion === 2)!;
  assert.equal(oldRun.status, 'cancelled');
  assert.equal(oldRun.cancelReason, 'patch');
  assert.equal(newRun.status, 'pending');
});

test('json store retains run.finished and gate events after reload', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'counterpoint-sched-')), 'store.json');
  const store = new JsonFileStore(file);
  const gateOps: OperatorRegistry = new Map([
    ['human_gate', {
      type: 'human_gate',
      async run(ctx) {
        ctx.requestHumanGate({
          id: `hg_${ctx.nodeRun.id}`,
          workItemId: ctx.workItem.id,
          planId: ctx.nodeRun.planId,
          nodeId: ctx.graphNode.id,
          kind: 'high_risk',
          summary: 'g',
          requested: {},
          status: 'pending',
          availableActions: ['approve_once', 'reject_and_stop'],
          createdAt: new Date().toISOString(),
        });
        return waiting();
      },
    }],
  ]);
  const gatePlan = validPlan({ nodes: [makeNode({ operator: { type: 'human_gate', summary: 'g', options: ['approve_once', 'reject_and_stop'] } })] });
  const first = makeScheduler({ plan: gatePlan, operators: gateOps, store });
  await first.scheduler.runUntilIdle();
  const reloaded = store.load();
  assert.ok(reloaded.events.some((event) => event.type === 'run.finished'));
  assert.ok(reloaded.events.some((event) => event.type === 'human_gate.requested'));
});
