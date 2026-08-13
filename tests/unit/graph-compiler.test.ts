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
      makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'verification', command: 'node', args: ['--version'], targetRefs: [] }, capabilityRequirements: ['code-analysis'] }),
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
        makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'verification', command: 'node', args: ['--version'], targetRefs: [] }, capabilityRequirements: ['code-analysis'] }),
      ],
    }),
    catalog,
  });
  graph.nodes.find((node) => node.id === 'gn_a')!.status = 'succeeded';
  assert.deepEqual(computeReadyNodes(graph).map((node) => node.id), ['gn_b']);
});
