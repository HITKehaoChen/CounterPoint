import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { findBlindLeaks } from '../../src/context-policy.ts';
import { createHarness, setupDeliberation } from '../helpers.ts';

test('blind phase: Context Views never expose another worker candidate', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const runA = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId)!;
  const runB = deliberation.runs.find((run) => run.participantId === setup.workerBParticipantId)!;

  const viewA = h.engine.getContextView(setup.deliberationId, runA.id);
  const viewB = h.engine.getContextView(setup.deliberationId, runB.id);
  assert.deepEqual(findBlindLeaks(viewA, [runB.id]), []);
  assert.deepEqual(findBlindLeaks(viewB, [runA.id]), []);
  assert.deepEqual(viewA.visible.claims, []);
  assert.deepEqual(viewB.visible.claims, []);
  assert.ok(!viewA.visible.artifacts.some((ref) => ref.includes(runB.id)));
  assert.ok(!viewB.visible.artifacts.some((ref) => ref.includes(runA.id)));
  assert.deepEqual(h.engine.auditBlindLeaks(setup.deliberationId), []);
});

test('blind phase: getVisibleObjects cannot read the other candidate', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const runA = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId)!;
  const objectsA = h.engine.getVisibleObjects(setup.deliberationId, runA.id, 'worker');
  const otherArtifacts = deliberation.positions
    .filter((position) => position.runId !== runA.id)
    .flatMap((position) => position.artifactRefs);
  const visibleRefs = objectsA.artifacts.map((artifact) => artifact.ref);
  for (const ref of otherArtifacts) {
    assert.ok(!visibleRefs.includes(ref), `blind view leaked ${ref}`);
  }
  assert.deepEqual(objectsA.claims, []);
  assert.equal(objectsA.candidates, undefined);
});

test('blind phase: workspaces are physically isolated', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const runs = deliberation.runs.filter((run) => run.status === 'committed');
  assert.equal(runs.length, 2);
  const [runA, runB] = runs;
  assert.notEqual(runA.workspacePath, runB.workspacePath);
  assert.ok(!runA.workspacePath!.includes(runB.id));
  assert.ok(!runB.workspacePath!.includes(runA.id));
  const filesA = readdirSync(runA.workspacePath!, { recursive: true }) as string[];
  const filesB = readdirSync(runB.workspacePath!, { recursive: true }) as string[];
  for (const file of filesA) assert.ok(!file.includes(runB.id));
  for (const file of filesB) assert.ok(!file.includes(runA.id));
});

test('blind phase: event payloads contain hashes, never candidate prose', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  const timeline = h.engine.getTimeline(setup.deliberationId);
  const serialized = JSON.stringify(timeline);
  for (const marker of ['synchronous calls preserve', 'Events decouple the ledger', 'event bus: decouples']) {
    assert.ok(!serialized.toLowerCase().includes(marker.toLowerCase()), `event log leaked "${marker}"`);
  }
  const commitEvents = timeline.filter((event) => event.type === 'run.committed');
  for (const event of commitEvents) {
    const payload = event.payload as { commitmentHash: string; positionId: string };
    assert.ok(payload.commitmentHash.length === 64, 'commitment must be a SHA-256 hash');
    assert.ok(payload.positionId.startsWith('pos_'));
  }
});

test('review phase: reviewer view is anonymous and randomized', async () => {
  const h = createHarness({ seed: 'fixed-review-seed' });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const reviewerRun = deliberation.runs.find((run) => run.phase === 'reviewing')!;
  const objects = h.engine.getVisibleObjects(setup.deliberationId, reviewerRun.id, 'reviewer');
  assert.ok(objects.candidates, 'reviewer must receive candidates');
  const serialized = JSON.stringify(objects.candidates);
  for (const marker of ['run_worker', 'mock-model', 'mock-provider', 'worker_a', 'worker_b']) {
    assert.ok(!serialized.includes(marker), `reviewer input leaked identity marker ${marker}`);
  }
  assert.deepEqual(
    new Set(objects.candidates.map((candidate) => candidate.candidateId)),
    new Set(['A', 'B']),
  );
  assert.equal(objects.candidates[0].originalRunId !== objects.candidates[1].originalRunId, true);
});
