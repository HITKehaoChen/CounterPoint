import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HELP_TEXT } from '../../apps/cli/planner-probe.ts';
import {
  PROBE_FIXTURES,
  assertPlanTopology,
  planWidth,
  topologySignature,
} from '../../apps/cli/planner-fixtures.ts';
import { makeNode, validPlan } from '../helpers/plan-fixtures.ts';

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
        inputRefs: [],
        contextPolicy: { visibility: 'shared', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] },
        capabilityRequirements: ['verification'],
        operator: { type: 'verification', command: 'node', args: ['--version'], targetRefs: [] },
        completionCriteria: [{ id: 'c2', kind: 'evidence', description: 'tests pass', refs: ['evidence:tests'] }],
        failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
        allocatedBudget: { maxTimeMs: 60_000 },
      },
    ],
  });
  assert.notEqual(topologySignature(simple), topologySignature(complex));
});

test('probe help lists --fresh and --strict flags', () => {
  assert.ok(HELP_TEXT.includes('--fresh'));
  assert.ok(HELP_TEXT.includes('--strict'));
});

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
