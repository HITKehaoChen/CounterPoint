import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  AutonomyEnvelopeSchema,
  defaultAutonomyEnvelope,
  tightenEnvelope,
} from '../../src/autonomy/autonomy-envelope.ts';
import {
  classifyRisk,
  requiresHumanGate,
  requiresReview,
} from '../../src/autonomy/risk-policy.ts';
import { HumanGateRequestSchema } from '../../src/autonomy/human-gate.ts';

test('default envelope parses and tightens numeric limits downward', () => {
  const base = defaultAutonomyEnvelope('ws_1');
  const tightened = tightenEnvelope(base, { maxAgents: 2, timeBudgetMs: 60_000 });
  assert.equal(tightened.maxAgents, 2);
  assert.equal(tightened.timeBudgetMs, 60_000);
  assert.equal(AutonomyEnvelopeSchema.safeParse(tightened).success, true);
});

test('tightenEnvelope rejects widening a numeric budget', () => {
  const base = defaultAutonomyEnvelope('ws_1');
  assert.throws(() => tightenEnvelope(base, { maxAgents: base.maxAgents + 1 }), /widen/);
});

test('tightenEnvelope rejects adding a tool outside the base allowlist', () => {
  const base = defaultAutonomyEnvelope('ws_1');
  assert.throws(() => tightenEnvelope(base, { allowedTools: [...base.allowedTools, 'curl'] }), /subset|widen/);
});

test('risk policy classifies actions and requires gates', () => {
  const policy = { highRiskActions: ['git push'], requireReviewFor: ['rm'], requireHumanGateFor: ['git push'] };
  assert.equal(classifyRisk('git push', policy), 'high');
  assert.equal(requiresHumanGate('git push', policy), true);
  assert.equal(requiresReview('rm', policy), true);
  assert.equal(requiresHumanGate('npm test', policy), false);
});

test('human gate request parses with defaults', () => {
  const request = HumanGateRequestSchema.parse({
    id: 'hg_1',
    workItemId: 'wi_1',
    planId: 'plan_1',
    kind: 'permission_escalation',
    summary: 'Need write access to prod config',
    requested: { scope: 'prod' },
  });
  assert.equal(request.status, 'pending');
  assert.deepEqual(request.availableActions, ['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop']);
});
