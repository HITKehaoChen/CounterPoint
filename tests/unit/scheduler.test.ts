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
}) {
  const db = options.db ?? emptyDatabase();
  const envelope = options.envelope ?? defaultAutonomyEnvelope('ws');
  const plan = options.plan ?? validPlan();
  const graph = compilePlan({ plan, catalog });
  const scheduler = new Scheduler({
    db,
    store: new InMemoryStore(),
    envelope,
    operators: options.operators ?? new Map([['agent_task', { type: 'agent_task' as const, async run() { return succeeded(); } } satisfies Operator]]),
    ledger: new BudgetLedger(envelope),
    catalog,
    maxParallelism: options.maxParallelism ?? 2,
    resolveAgent: () => undefined,
    resolveReviewer: () => undefined,
  });
  scheduler.attach(graph, plan, validWorkItem());
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
