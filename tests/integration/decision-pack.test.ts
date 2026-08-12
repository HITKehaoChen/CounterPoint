import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decisionPackToMarkdown } from '../../src/decision-pack.ts';
import { createHarness, setupDeliberation } from '../helpers.ts';

test('Decision Pack exports full traceability and surfaces unresolved conflicts', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    reviewer: {
      unresolvedRisks: ['The load-test evidence is missing'],
      rationale: 'A is safer; B is more scalable. Choosing A pending load test.',
    },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const runA = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId)!;
  const runB = deliberation.runs.find((run) => run.participantId === setup.workerBParticipantId)!;
  const challenge = h.engine.createChallenge({
    deliberationId: setup.deliberationId,
    targetRef: 'claim:b-1',
    authorRunId: runA.id,
    question: 'What delivery guarantee applies?',
  });
  h.engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: runB.id,
    text: 'At-least-once with idempotent consumers.',
  });
  await h.engine.runVerification({
    deliberationId: setup.deliberationId,
    command: 'node',
    args: ['-e', 'console.log("probe ok")'],
    targetRefs: ['claim:a-1'],
  });
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'approve',
    rationale: 'Approve A with load-test condition',
    conditions: ['Run a load test before production rollout'],
    ownerId: 'human-owner',
  });

  const pack = h.engine.exportDecisionPack(setup.deliberationId);
  assert.deepEqual(pack.traceability.unresolvedRefs, []);
  assert.ok(pack.traceability.resolvedRefs.length >= 8);
  assert.equal(pack.candidates.length, 2);
  assert.equal(pack.challenges.length, 1);
  assert.equal(pack.challenges[0].response?.text, 'At-least-once with idempotent consumers.');
  assert.equal(pack.evidence[0].status, 'verified');
  assert.equal(pack.decision?.humanAction, 'approve');
  assert.ok(pack.divergence.uniqueClaims.length >= 1);
  assert.ok(pack.divergence.unresolvedConflicts.includes('The load-test evidence is missing'));

  const markdown = decisionPackToMarkdown(pack);
  assert.ok(markdown.includes('# Decision Pack'));
  assert.ok(markdown.includes('## Evidence'));
  assert.ok(markdown.includes('**VERIFIED**'));
  assert.ok(markdown.includes('## Decision'));
  assert.ok(markdown.includes('**approve**'));
  assert.ok(markdown.includes('The load-test evidence is missing'));
  assert.ok(markdown.includes('## Traceability'));
  assert.ok(markdown.includes('Resolved refs:'));
  assert.ok(markdown.includes('Run a load test before production rollout'));
  assert.ok(markdown.includes('## Timeline'));
});

test('Decision Pack JSON round-trips through structured data', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'approve',
    rationale: 'ok',
    ownerId: 'human-owner',
  });
  const pack = h.engine.exportDecisionPack(setup.deliberationId);
  const roundTripped = JSON.parse(JSON.stringify(pack)) as typeof pack;
  assert.deepEqual(roundTripped.traceability.unresolvedRefs, pack.traceability.unresolvedRefs);
  assert.equal(roundTripped.candidates.length, 2);
  assert.equal(roundTripped.decision?.rationale, 'ok');
});
