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
import { strictGate } from '../../apps/cli/planner-probe.ts';

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

test('simple topology rejects an extra independent review', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'candidate' }),
      makeNode({
        id: 'review',
        dependsOn: ['candidate'],
        capabilityRequirements: ['independent-review'],
        operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['candidate'] },
      }),
    ],
  });
  assert.ok(assertPlanTopology(plan, PROBE_FIXTURES[0].topology).some((item) => item.includes('independent_review forbidden')));
});

test('simple topology rejects a deliberation node', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        operator: {
          type: 'counterpoint_deliberation',
          workerCount: 2,
          blind: true,
          commitReveal: true,
          challengeRounds: 0,
          verificationPolicy: 'version',
          reviewerPolicy: 'mock',
        },
      }),
    ],
  });
  assert.ok(assertPlanTopology(plan, PROBE_FIXTURES[0].topology).some((item) => item.includes('counterpoint_deliberation forbidden')));
});

test('simple topology rejects a converging node', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b' }),
      makeNode({ id: 'c', dependsOn: ['a', 'b'] }),
    ],
  });
  assert.ok(assertPlanTopology(plan, PROBE_FIXTURES[0].topology).some((item) => item.includes('converging node forbidden')));
});

test('strict gate requires a fresh unfiltered full run', () => {
  assert.equal(strictGate({ fresh: true, fixtureFilter: [], plannerFilter: [], results: [{ fixture: 'simple-bug', planner: 'chrys', verdict: 'accepted', attempts: 1, issueCodes: [], topology: '' }], semanticPassed: true }), true);
  assert.equal(strictGate({ fresh: false, fixtureFilter: [], plannerFilter: [], results: [{ fixture: 'simple-bug', planner: 'chrys', verdict: 'accepted', attempts: 1, issueCodes: [], topology: '' }], semanticPassed: true }), false);
  assert.equal(strictGate({ fresh: true, fixtureFilter: ['complex-bug'], plannerFilter: [], results: [], semanticPassed: true }), false);
  assert.equal(strictGate({ fresh: true, fixtureFilter: [], plannerFilter: [], results: [{ fixture: 'simple-bug', planner: 'chrys', verdict: 'accepted', attempts: 1, issueCodes: [], topology: '', resumed: true }], semanticPassed: true }), false);
});
