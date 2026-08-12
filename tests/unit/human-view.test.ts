import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  setupDeliberation,
  defaultWorkerAScript,
  defaultWorkerBScript,
} from '../helpers.ts';
import { buildHumanView } from '../../src/human-view.ts';

const FORBIDDEN_MARKERS = [
  'Use synchronous calls',
  'Synchronous calls preserve',
  'Use RPC with retries.',
  'mock run',
  'mock-model-a',
  'mock-model-b',
];

test('human view: blind/committed states hide candidate content, artifacts and logs', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);

  const db = h.store.load();
  const deliberation = db.deliberations.find((item) => item.id === setup.deliberationId)!;
  for (const state of ['blind_run', 'committed']) {
    deliberation.state = state as typeof deliberation.state;
    const view = buildHumanView(db, setup.deliberationId, 'test-seed');
    assert.equal(view.positions.length, 0);
    assert.equal(view.claims.length, 0);
    assert.equal(view.runs.length, 2);
    const serialized = JSON.stringify(view);
    for (const marker of FORBIDDEN_MARKERS) {
      assert.ok(!serialized.includes(marker), `${state} leaked marker: ${marker}`);
    }
    for (const artifact of view.artifacts) {
      assert.equal(artifact.content, undefined);
    }
  }
});

test('human view: revealed state shows anonymous candidates X/Y without author/model', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);

  const view = buildHumanView(h.store.load(), setup.deliberationId, 'test-seed');
  assert.equal(view.state, 'challenging');
  assert.equal(view.positions.length, 2);
  assert.deepEqual(
    view.positions.map((position) => position.label),
    ['候选 X', '候选 Y'],
  );
  const positionJson = JSON.stringify(view.positions);
  assert.ok(positionJson.includes('Use synchronous calls'));
  assert.ok(positionJson.includes('Use an event bus'));
  for (const marker of ['mock-model-a', 'mock-model-b', 'run_', 'participantId']) {
    assert.ok(!positionJson.includes(marker), `candidate view leaked marker: ${marker}`);
  }
  const artifact = view.artifacts.find((item) => item.logicalName === 'design-a');
  assert.ok(artifact);
  assert.ok(artifact.content?.includes('Use RPC with retries.'));
});

test('human view: review content appears only after the review is submitted', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);

  const state = h.engine.getState(setup.deliberationId);
  const targetPosition = state.positions[0];
  const targetClaim = targetPosition.claims[0];
  const responseRun = state.runs.find((run) => run.id === targetPosition.runId)!;
  const otherRun = state.runs.find((run) => run.id !== targetPosition.runId)!;
  const challenge = h.engine.createChallenge({
    deliberationId: setup.deliberationId,
    targetRef: `claim:${targetClaim.id}`,
    authorRunId: otherRun.id,
    question: 'Delivery guarantee under ledger outage?',
  });
  h.engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: responseRun.id,
    text: 'At-least-once with idempotency keys.',
  });
  h.engine.freezeEvidencePack(setup.deliberationId);

  const before = buildHumanView(h.store.load(), setup.deliberationId, 'test-seed');
  assert.equal(before.reviews.length, 0);
  assert.ok(!JSON.stringify(before).includes('candidate_a'));

  await h.engine.runReview(setup.deliberationId);
  const after = buildHumanView(h.store.load(), setup.deliberationId, 'test-seed');
  assert.equal(after.reviews.length, 1);
  assert.equal(after.reviews[0].recommendation, 'candidate_a');
});

test('human view: unresolved conflicts are always listed explicitly', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    reviewer: { unresolvedRisks: ['Load testing evidence is missing'] },
  });
  await h.engine.startBlindRun(setup.deliberationId);

  const state = h.engine.getState(setup.deliberationId);
  const targetPosition = state.positions[0];
  const targetClaim = targetPosition.claims[0];
  const responseRun = state.runs.find((run) => run.id === targetPosition.runId)!;
  const otherRun = state.runs.find((run) => run.id !== targetPosition.runId)!;
  const challenge = h.engine.createChallenge({
    deliberationId: setup.deliberationId,
    targetRef: `claim:${targetClaim.id}`,
    authorRunId: otherRun.id,
    question: 'What is the delivery guarantee?',
  });

  const withOpenChallenge = buildHumanView(h.store.load(), setup.deliberationId, 'test-seed');
  assert.deepEqual(withOpenChallenge.unresolvedConflicts, ['What is the delivery guarantee?']);

  h.engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: responseRun.id,
    text: 'At-least-once with idempotency keys.',
  });
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);

  const withReview = buildHumanView(h.store.load(), setup.deliberationId, 'test-seed');
  assert.equal(withReview.reviews.length, 1);
  assert.ok(withReview.unresolvedConflicts.includes('Load testing evidence is missing'));
});

test('human view: candidate labels follow review order when available', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);

  const state = h.engine.getState(setup.deliberationId);
  const targetPosition = state.positions[0];
  const targetClaim = targetPosition.claims[0];
  const responseRun = state.runs.find((run) => run.id === targetPosition.runId)!;
  const otherRun = state.runs.find((run) => run.id !== targetPosition.runId)!;
  const challenge = h.engine.createChallenge({
    deliberationId: setup.deliberationId,
    targetRef: `claim:${targetClaim.id}`,
    authorRunId: otherRun.id,
    question: 'Delivery guarantee?',
  });
  h.engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: responseRun.id,
    text: 'At-least-once.',
  });
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);

  const view = buildHumanView(h.store.load(), setup.deliberationId, 'test-seed');
  assert.equal(view.positions.length, 2);
  assert.deepEqual(view.candidateOrder, view.reviewOrder);
});
