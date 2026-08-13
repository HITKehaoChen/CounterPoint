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
    node: graph.nodes[0],
    db: emptyDatabase(),
    workItem: validWorkItem(),
    producerIndex: new Map([['gn_blind-b', ['claim:b1']]]),
    producerVisibility: new Map([['gn_blind-b', 'blind']]),
    seed: 't',
  });
  assert.equal(view.visible.claims.includes('b1'), false);
  assert.ok(view.hidden.objectTypes.includes('blind_claims'));
});

test('shared upstream outputs are visible', () => {
  const plan = validPlan({ nodes: [makeNode({ id: 'a' }), makeNode({ id: 'b', dependsOn: ['a'] })] });
  const graph = compilePlan({ plan, catalog });
  const view = buildNodeContextView({
    node: graph.nodes[1],
    db: emptyDatabase(),
    workItem: validWorkItem(),
    producerIndex: new Map([['gn_a', ['claim:a1']]]),
    producerVisibility: new Map([['gn_a', 'shared']]),
    seed: 't',
  });
  assert.ok(view.visible.claims.includes('a1'));
});
