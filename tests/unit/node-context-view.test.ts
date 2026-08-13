import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildNodeContextView, materializeNodeContext } from '../../src/execution/context-view.ts';
import { compilePlan } from '../../src/execution/graph-compiler.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';
import { ArtifactRegistry } from '../../src/artifact-registry.ts';
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
