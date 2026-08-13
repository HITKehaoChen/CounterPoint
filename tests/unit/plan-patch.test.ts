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
