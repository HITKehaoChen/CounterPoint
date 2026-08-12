import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildContextView,
  buildReviewerCandidates,
  findBlindLeaks,
  findReviewerIdentityLeaks,
  shuffled,
} from '../../src/context-policy.ts';
import type { Deliberation, Position } from '../../src/schemas.ts';

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: 'delib-1',
    projectId: 'prj-1',
    protocolVersion: '0.1.0',
    state: 'blind_run',
    ownerId: 'human-1',
    participants: [],
    runs: [
      { id: 'run_worker_a', participantId: 'w1', phase: 'blind_run', status: 'committed' },
      { id: 'run_worker_b', participantId: 'w2', phase: 'blind_run', status: 'committed' },
    ],
    positions: [],
    challenges: [],
    responses: [],
    evidenceRequests: [],
    evidence: [],
    reviews: [],
    decisions: [],
    rounds: { challenge: 0, evidence: 0 },
    createdAt: 't',
    updatedAt: 't',
    timeoutPolicy: { defaultMs: 1000, maxEvidenceRounds: 1 },
    ...overrides,
  };
}

test('blind context view hides other runs and candidate objects', () => {
  const deliberation = makeDeliberation();
  const view = buildContextView({
    deliberation,
    viewerRunId: 'run_worker_a',
    role: 'worker',
    phase: 'blind_run',
    authoritySources: ['src_task@v1'],
    authorityArtifactRefs: ['src_task@v1'],
    candidateArtifactRefs: ['design-b@v1'],
    seed: 's',
  });
  assert.deepEqual(view.hidden.agentRuns, ['run_worker_b']);
  assert.ok(view.hidden.objectTypes.includes('position_draft'));
  assert.deepEqual(view.visible.claims, []);
  assert.deepEqual(view.visible.artifacts, ['src_task@v1']);
  assert.deepEqual(findBlindLeaks(view, ['run_worker_b']), []);
  assert.ok(view.hash.length >= 16);
});

test('revealed context view includes all candidate claims and artifacts', () => {
  const deliberation = makeDeliberation({
    state: 'revealed',
    positions: [
      {
        id: 'pos-a',
        runId: 'run_worker_a',
        summary: 'A',
        claims: [{ id: 'claim-a', statement: 'A is better', type: 'design', evidenceRefs: [] }],
        unknowns: [],
        artifactRefs: ['design-a@v1'],
        decisionConditions: [],
        confidence: 0.5,
        commitmentHash: 'h1',
        committedAt: 't',
        status: 'committed',
      },
      {
        id: 'pos-b',
        runId: 'run_worker_b',
        summary: 'B',
        claims: [{ id: 'claim-b', statement: 'B is better', type: 'design', evidenceRefs: [] }],
        unknowns: [],
        artifactRefs: ['design-b@v1'],
        decisionConditions: [],
        confidence: 0.5,
        commitmentHash: 'h2',
        committedAt: 't',
        status: 'committed',
      },
    ],
  });
  const view = buildContextView({
    deliberation,
    viewerRunId: 'run_worker_a',
    role: 'worker',
    phase: 'revealed',
    authoritySources: ['src_task@v1'],
    authorityArtifactRefs: ['src_task@v1'],
    candidateArtifactRefs: ['design-a@v1', 'design-b@v1'],
    seed: 's',
  });
  assert.deepEqual(view.visible.claims.sort(), ['claim-a', 'claim-b']);
  assert.deepEqual(view.visible.artifacts.sort(), ['design-a@v1', 'design-b@v1', 'src_task@v1']);
});

test('reviewer candidates are anonymous and deterministically ordered by seed', () => {
  const positions: Position[] = [
    {
      id: 'pos-a',
      runId: 'run_worker_a',
      summary: 'A',
      claims: [{ id: 'claim-a', statement: 'A', type: 'design', evidenceRefs: [] }],
      unknowns: [],
      artifactRefs: ['design-a@v1'],
      decisionConditions: [],
      confidence: 0.5,
      commitmentHash: 'h1',
      committedAt: 't',
      status: 'committed',
    },
    {
      id: 'pos-b',
      runId: 'run_worker_b',
      summary: 'B',
      claims: [{ id: 'claim-b', statement: 'B', type: 'design', evidenceRefs: [] }],
      unknowns: [],
      artifactRefs: ['design-b@v1'],
      decisionConditions: [],
      confidence: 0.5,
      commitmentHash: 'h2',
      committedAt: 't',
      status: 'committed',
    },
  ];
  const first = buildReviewerCandidates(positions, 'seed-1');
  const second = buildReviewerCandidates(positions, 'seed-1');
  assert.deepEqual(first.order, second.order);
  assert.deepEqual(first.candidates.map((c) => c.candidateId), ['A', 'B']);
  assert.deepEqual(findReviewerIdentityLeaks(first.candidates), []);
  const different = buildReviewerCandidates(positions, 'seed-2');
  // With two items, different seeds should produce a different order for at
  // least one seed pair; verify mapping is still lossless.
  assert.equal(
    new Set(different.candidates.map((c) => c.originalRunId)).size,
    2,
  );
});

test('shuffled is deterministic for the same seed', () => {
  assert.deepEqual(shuffled([1, 2, 3, 4, 5], 'x'), shuffled([1, 2, 3, 4, 5], 'x'));
});
