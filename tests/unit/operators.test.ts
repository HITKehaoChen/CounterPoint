import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AgentTaskOperator } from '../../src/operators/agent-task.ts';
import { ToolTaskOperator } from '../../src/operators/tool-task.ts';
import { VerificationOperator } from '../../src/operators/verification.ts';
import { IndependentReviewOperator } from '../../src/operators/independent-review.ts';
import { MockReviewerAdapter } from '../../src/adapters/mock-reviewer.ts';
import { CounterpointDeliberationOperator } from '../../src/operators/counterpoint-deliberation.ts';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { InMemoryStore } from '../../src/store.ts';
import type { HumanGateRequest } from '../../src/autonomy/human-gate.ts';
import type { OperatorContext, OperatorWriteBatch } from '../../src/operators/operator.ts';
import { MockAgentAdapter } from '../../src/adapters/mock-agent.ts';
import { defaultWorkerAScript } from '../helpers.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { defaultAutonomyEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import { emptyDatabase, NodeRunSchema } from '../../src/schemas.ts';
import type { GraphNode } from '../../src/execution/execution-graph.ts';

function graphNode(overrides: Partial<GraphNode> = {}): GraphNode {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' })] });
  const graph = compilePlan({ plan, catalog: catalogFromEntries([{ capability: 'code-analysis', adapterKind: 'mock', tools: [] }]) });
  return { ...graph.nodes[0], ...overrides };
}

function makeCtx(overrides: Partial<OperatorContext> = {}, commit?: (batch: OperatorWriteBatch) => string[]): OperatorContext {
  const node = graphNode();
  const db = emptyDatabase();
  return {
    graphNode: node,
    nodeRun: NodeRunSchema.parse({ id: 'nr_1', workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, graphNodeId: node.id, role: 'x', operatorType: 'agent_task', status: 'running' }),
    workItem: validWorkItem(),
    contextView: { id: 'c', runId: 'nr_1', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' },
    workspacePath: 'C:/tmp/op-test',
    envelope: defaultAutonomyEnvelope('ws'),
    resolveAgent: () => undefined,
    resolveReviewer: () => undefined,
    commit: commit ?? (() => ['artifact:1']),
    ledger: new BudgetLedger(defaultAutonomyEnvelope('ws')),
    emit: () => undefined,
    requestHumanGate: () => { throw new Error('unused'); },
    readDb: () => db,
    ...overrides,
  };
}

test('agent task commits artifacts and claims through the serialized commit callback', async () => {
  const batches: OperatorWriteBatch[] = [];
  const ctx = makeCtx(
    { resolveAgent: () => new MockAgentAdapter(defaultWorkerAScript) },
    (batch) => {
      batches.push(batch);
      return ['artifact:1'];
    },
  );
  const result = await new AgentTaskOperator().run(ctx);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.artifactRefs, ['artifact:1']);
  assert.ok(result.claimRefs.length > 0);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].claims?.length, defaultWorkerAScript().claims.length);
});

test('tool task rejects a command outside the envelope allowlist', async () => {
  const ctx = makeCtx({ graphNode: { ...graphNode(), operator: { type: 'tool_task', command: 'curl', args: [] } } });
  await assert.rejects(() => new ToolTaskOperator().run(ctx), /allowlist/);
});

test('verification operator commits node-level evidence', async () => {
  const batches: OperatorWriteBatch[] = [];
  const ctx = makeCtx(
    {
      graphNode: { ...graphNode(), operator: { type: 'verification', command: 'node', args: ['--version'], cwd: process.cwd(), targetRefs: ['claim:c1'] } },
    },
    (batch) => {
      batches.push(batch);
      return [];
    },
  );
  const result = await new VerificationOperator().run(ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal(batches.length, 1);
  assert.equal(batches[0].evidence?.length, 1);
  assert.equal(batches[0].evidence?.[0].status, 'verified');
  assert.deepEqual(result.evidenceRefs, [batches[0].evidence![0].id]);
});

test('independent review stores a verdict in outputs, not a decision', async () => {
  const db = emptyDatabase();
  db.claims.push({ id: 'c1', workItemId: 'wi_test', nodeRunId: 'nr_src', statement: 'x', type: 'fact', evidenceRefs: [] });
  db.nodeRuns.push(
    NodeRunSchema.parse({ id: 'nr_src', workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, graphNodeId: 'gn_src', role: 'src', operatorType: 'agent_task', status: 'succeeded' }),
  );
  const ctx = makeCtx({
    graphNode: { ...graphNode(), operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['src'] } },
    resolveReviewer: () => new MockReviewerAdapter({ recommendation: 'candidate_a', evidenceSufficiency: 'partial' }),
    readDb: () => db,
  });
  const result = await new IndependentReviewOperator().run(ctx);
  assert.equal(result.status, 'succeeded');
  assert.equal((result.outputs as { review?: { recommendation: string } }).review?.recommendation, 'candidate_a');
  assert.equal(db.decisionRecords.length, 0);
});

test('deliberation facade pauses at the human gate and resumes to decided', async () => {
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
  const ctx: OperatorContext = {
    graphNode: {
      id: 'gn_delib',
      planNodeId: 'delib',
      role: 'Deliberation',
      objective: 'choose transport',
      dependsOn: [],
      inputRefs: [],
      contextPolicy: { visibility: 'blind', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] },
      operator: { type: 'counterpoint_deliberation', workerCount: 2, blind: true, commitReveal: true, challengeRounds: 0, verificationPolicy: 'version', reviewerPolicy: 'mock', humanGatePolicy: 'always' },
      capabilityRequirements: [],
      completionCriteria: [],
      failurePolicy: { maxRetries: 0, onFailure: 'escalate' },
      allocatedBudget: { maxTimeMs: 30_000 },
      status: 'running',
    },
    nodeRun,
    workItem,
    contextView: { id: 'c', runId: 'nr_delib', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' },
    workspacePath: 'C:/tmp/facade-test',
    envelope: defaultAutonomyEnvelope(project.id),
    resolveAgent: () => new MockAgentAdapter(defaultWorkerAScript),
    resolveReviewer: () => new MockReviewerAdapter({}),
    commit: () => [],
    ledger: new BudgetLedger(defaultAutonomyEnvelope(project.id)),
    emit: () => undefined,
    requestHumanGate: (input) => {
      gates.push(input);
      return input;
    },
    readDb: () => db,
  };
  const paused = await op.run(ctx);
  assert.equal(paused.status, 'waiting_human');
  assert.equal(gates.length, 1);
  const finished = await op.resume(ctx, gates[0], 'approve_once');
  assert.equal(finished.status, 'succeeded');
  assert.equal(db.deliberations[0].state, 'decided');
});
