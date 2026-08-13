import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeContextView, materializeNodeContext } from '../../src/execution/context-view.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import { ArtifactRegistry } from '../../src/artifact-registry.ts';
import { emptyDatabase, NodeRunSchema } from '../../src/schemas.ts';
import { AgentTaskOperator } from '../../src/operators/agent-task.ts';
import { MockAgentAdapter } from '../../src/adapters/mock-agent.ts';
import { BudgetLedger } from '../../src/execution/budget-ledger.ts';
import { defaultAutonomyEnvelope } from '../../src/autonomy/autonomy-envelope.ts';
import type { OperatorContext } from '../../src/operators/operator.ts';

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
    node: graph.nodes[0],
    db: emptyDatabase(),
    workItem: validWorkItem(),
    nodes: graph.nodes,
    producerIndex: new Map([['gn_blind-b', ['claim:b1']]]),
    producerVisibility: new Map([['gn_blind-b', 'blind']]),
    seed: 't',
  });
  assert.equal(view.visible.claims.includes('b1'), false);
  assert.ok(view.hidden.agentRuns.includes('gn_blind-b'));
});

test('shared upstream outputs are visible', () => {
  const emptyPolicy = { visibility: 'shared' as const, readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] };
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', contextPolicy: emptyPolicy }),
      makeNode({ id: 'b', dependsOn: ['a'], contextPolicy: emptyPolicy }),
    ],
  });
  const graph = compilePlan({ plan, catalog });
  const view = buildNodeContextView({
    node: graph.nodes[1],
    db: emptyDatabase(),
    workItem: validWorkItem(),
    nodes: graph.nodes,
    producerIndex: new Map([['gn_a', ['claim:a1']]]),
    producerVisibility: new Map([['gn_a', 'shared']]),
    seed: 't',
  });
  assert.ok(view.visible.claims.includes('a1'));
});

test('a shared sibling branch does not leak into an unrelated consumer', () => {
  const emptyPolicy = { visibility: 'shared' as const, readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] };
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', contextPolicy: emptyPolicy }),
      makeNode({ id: 'b', contextPolicy: emptyPolicy }),
      makeNode({ id: 'c', dependsOn: ['a', 'b'], contextPolicy: emptyPolicy }),
      makeNode({ id: 'd', dependsOn: ['a'], contextPolicy: emptyPolicy }),
    ],
  });
  const graph = compilePlan({ plan, catalog });
  const view = buildNodeContextView({
    node: graph.nodes[3],
    db: emptyDatabase(),
    workItem: validWorkItem(),
    nodes: graph.nodes,
    producerIndex: new Map([['gn_b', ['claim:b-leak']]]),
    producerVisibility: new Map([['gn_b', 'shared']]),
    seed: 't',
  });
  assert.equal(view.visible.claims.includes('b-leak'), false);
});

test('materialize resolves authority source text and artifact content', () => {
  const db = emptyDatabase();
  const published = new ArtifactRegistry(db).publish({
    logicalName: 'note',
    type: 'text',
    content: 'unique-string-123',
    ownerRunId: 'nr_a',
  });
  db.projects.push({
    id: 'ws_test',
    name: 'ws',
    sourceBindings: [{ id: 'src_inventory', type: 'text', label: 'inventory', text: 'source-text', version: 1 }],
    createdAt: 't',
  });
  const materialized = materializeNodeContext({
    view: {
      id: 'c',
      runId: 'nr_1',
      phase: 'node',
      visible: { authoritySources: ['src_inventory@v1'], artifacts: [published.ref], claims: [], evidence: [] },
      hidden: { agentRuns: [], objectTypes: [] },
      tools: { allow: [], deny: [] },
      hash: 'h',
    },
    db,
    workItem: validWorkItem(),
  });
  assert.equal(materialized.authoritySources[0].content, 'source-text');
  assert.equal(materialized.visibleArtifacts[0].content, 'unique-string-123');
});

test('a published artifact propagates to dependent nodes only', async () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  const emptyPolicy = { visibility: 'shared' as const, readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] };
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', contextPolicy: emptyPolicy }),
      makeNode({ id: 'b', dependsOn: ['a'], contextPolicy: emptyPolicy }),
      makeNode({ id: 'c', contextPolicy: emptyPolicy }),
    ],
  });
  const graph = compilePlan({ plan, catalog });
  const script = () => ({
    summary: 'x',
    claims: [],
    unknowns: [],
    artifactRefs: [],
    decisionConditions: [],
    confidence: 0.5,
    artifacts: [{ logicalName: 'note', type: 'text' as const, content: 'unique-string-123' }],
    model: 'm',
  });
  const nodeRunA = NodeRunSchema.parse({ id: 'nr_a', workItemId: 'wi_test', planId: 'plan_test', planVersion: 1, graphNodeId: 'gn_a', role: 'A', operatorType: 'agent_task', status: 'running' });
  const ctxA: OperatorContext = {
    graphNode: graph.nodes[0],
    nodeRun: nodeRunA,
    workItem: validWorkItem(),
    contextView: { id: 'c', runId: 'nr_a', phase: 'node', visible: { authoritySources: [], artifacts: [], claims: [], evidence: [] }, hidden: { agentRuns: [], objectTypes: [] }, tools: { allow: [], deny: [] }, hash: 'h' },
    workspacePath: 'C:/tmp/prop-test',
    envelope: defaultAutonomyEnvelope('ws_test'),
    resolveAgent: () => new MockAgentAdapter(script),
    resolveReviewer: () => undefined,
    commit: (batch) => (batch.artifacts ?? []).map((artifact) => registry.publish({ ...artifact, ownerRunId: 'nr_a' }).ref),
    ledger: new BudgetLedger(defaultAutonomyEnvelope('ws_test')),
    emit: () => undefined,
    requestHumanGate: () => {
      throw new Error('unused');
    },
    readDb: () => db,
    materialize: () => ({ authoritySources: [], visibleArtifacts: [] }),
  };
  const resultA = await new AgentTaskOperator().run(ctxA);
  const producerIndex = new Map([['gn_a', resultA.artifactRefs]]);
  const producerVisibility = new Map<string, 'shared' | 'private' | 'blind' | 'sealed'>([['gn_a', 'shared']]);
  const viewB = buildNodeContextView({ node: graph.nodes[1], db, workItem: validWorkItem(), nodes: graph.nodes, producerIndex, producerVisibility, seed: 't' });
  const materializedB = materializeNodeContext({ view: viewB, db, workItem: validWorkItem() });
  assert.equal(materializedB.visibleArtifacts[0].content, 'unique-string-123');
  const viewC = buildNodeContextView({ node: graph.nodes[2], db, workItem: validWorkItem(), nodes: graph.nodes, producerIndex, producerVisibility, seed: 't' });
  const materializedC = materializeNodeContext({ view: viewC, db, workItem: validWorkItem() });
  assert.equal(materializedC.visibleArtifacts.length, 0);
});

test('normalized claim and evidence refs propagate to dependent nodes', () => {
  const db = emptyDatabase();
  db.claims.push({ id: 'c1', workItemId: 'wi_test', nodeRunId: 'nr_a', statement: 's', type: 'fact', evidenceRefs: [] });
  db.evidence.push({
    id: 'e1',
    workItemId: 'wi_test',
    planId: 'plan_test',
    nodeRunId: 'nr_a',
    kind: 'command_result',
    source: { command: 'node', args: [] },
    targetRefs: ['claim:c1'],
    result: { exitCode: 0 },
    status: 'verified',
    hash: 'h',
    createdAt: 't',
  });
  const emptyPolicy = { visibility: 'shared' as const, readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] };
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', contextPolicy: emptyPolicy }),
      makeNode({ id: 'b', dependsOn: ['a'], contextPolicy: emptyPolicy }),
    ],
  });
  const graph = compilePlan({ plan, catalog });
  const view = buildNodeContextView({
    node: graph.nodes[1],
    db,
    workItem: validWorkItem(),
    nodes: graph.nodes,
    producerIndex: new Map([['gn_a', ['claim:c1', 'evidence:e1']]]),
    producerVisibility: new Map([['gn_a', 'shared']]),
    seed: 't',
  });
  assert.deepEqual(view.visible.claims, ['c1']);
  assert.deepEqual(view.visible.evidence, ['e1']);
});
