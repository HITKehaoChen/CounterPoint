import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDatabase, NodeRunSchema, DecisionRecordSchema, EvidenceSchema, ClaimSchema } from '../../src/schemas.ts';

test('node run accepts attempts, outputs, cancel reason and effect class', () => {
  const run = NodeRunSchema.parse({
    id: 'nr_1',
    workItemId: 'wi_1',
    planId: 'plan_1',
    planVersion: 1,
    graphNodeId: 'gn_a',
    role: 'Analyst',
    operatorType: 'agent_task',
    status: 'running',
    attempts: [{ attempt: 1, startedAt: 't', finishedAt: 't2', costUsd: 0.1, inputTokens: 10, outputTokens: 5, model: 'm' }],
    outputs: { answer: 'x' },
    cancelReason: 'patch',
    effectClass: 'idempotent',
  });
  assert.equal(run.attempts[0].model, 'm');
  assert.equal(run.cancelReason, 'patch');
  assert.equal(run.effectClass, 'idempotent');
});

test('decision record is separate from node runs', () => {
  const decision = DecisionRecordSchema.parse({ id: 'dec_1', workItemId: 'wi_1', planId: 'plan_1', planVersion: 1, outcome: 'resolved', summary: 'root cause verified', decidedAt: 't', ownerId: 'human' });
  assert.equal(decision.outcome, 'resolved');
});

test('evidence and claim accept node-level provenance', () => {
  const evidence = EvidenceSchema.parse({ id: 'evid_1', workItemId: 'wi_1', planId: 'plan_1', nodeRunId: 'nr_1', kind: 'command_result', source: { command: 'node', args: [] }, targetRefs: ['claim:c1'], result: { exitCode: 0 }, status: 'verified', hash: 'h', createdAt: 't' });
  assert.equal(evidence.deliberationId, undefined);
  const claim = ClaimSchema.parse({ id: 'c1', workItemId: 'wi_1', nodeRunId: 'nr_1', statement: 'x', type: 'fact' });
  assert.equal(claim.nodeRunId, 'nr_1');
});

test('database v0.2 carries node runs, decisions, evidence and claims', () => {
  const db = emptyDatabase();
  assert.deepEqual(db.nodeRuns, []);
  assert.deepEqual(db.decisionRecords, []);
  assert.deepEqual(db.evidence, []);
  assert.deepEqual(db.claims, []);
});
