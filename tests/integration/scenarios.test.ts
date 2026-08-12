import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  setupDeliberation,
  defaultWorkerAScript,
  defaultWorkerBScript,
  type EngineHarness,
  type SetupResult,
} from '../helpers.ts';
import { MockAgentAdapter } from '../../src/adapters/mock-agent.ts';
import type { MockAgentScript } from '../../src/adapters/mock-agent.ts';

const TINY_TIMEOUT = { defaultMs: 80, maxEvidenceRounds: 1 };

async function completeAfterReveal(h: EngineHarness, setup: SetupResult) {
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  const review = await h.engine.runReview(setup.deliberationId);
  return review;
}

test('S1 happy path: blind run -> reveal -> review -> human approval', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  let deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.state, 'challenging');
  assert.equal(deliberation.positions.length, 2);
  assert.equal(deliberation.runs.filter((run) => run.status === 'committed').length, 2);
  assert.ok(h.engine.verifyEventChain());

  const review = await completeAfterReveal(h, setup);
  assert.equal(review.recommendation, 'candidate_a');
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'approve',
    rationale: 'Accepted after review',
    ownerId: 'human-owner',
  });
  deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.state, 'decided');
  assert.ok(decision.selectedRefs.length >= 1);
  const pack = h.engine.exportDecisionPack(setup.deliberationId);
  assert.deepEqual(pack.traceability.unresolvedRefs, []);
});

test('S2 unified reveal: no candidate is disclosed before all workers commit', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    workerA: { ...defaultWorkerAScript(), delayMs: 250 },
    workerB: defaultWorkerBScript(),
  });
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.positions.length, 2);
  const revealEvents = h.engine.getTimeline(setup.deliberationId).filter((event) => event.type === 'candidates.revealed');
  assert.equal(revealEvents.length, 1);
  const payload = revealEvents[0].payload as { commitmentHashes: string[] };
  assert.equal(payload.commitmentHashes.length, 2);
  const runEvents = h.engine.getTimeline(setup.deliberationId).filter((event) => event.type === 'run.committed');
  assert.equal(runEvents.length, 2);
  const revealIndex = h.engine.getTimeline(setup.deliberationId).findIndex((event) => event.type === 'candidates.revealed');
  const lastCommitIndex = h.engine.getTimeline(setup.deliberationId).reduce(
    (acc, event, index) => (event.type === 'run.committed' ? index : acc),
    -1,
  );
  assert.ok(revealIndex > lastCommitIndex, 'reveal must happen after the last commit');
});

test('S3 timeout -> timed_out -> retry creates a new run and keeps the old one', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h, {
    timeoutPolicy: TINY_TIMEOUT,
    workerA: { ...defaultWorkerAScript(), delayMs: 10_000 },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  let deliberation = h.engine.getState(setup.deliberationId);
  const runA = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId);
  const runB = deliberation.runs.find((run) => run.participantId === setup.workerBParticipantId);
  assert.equal(runA?.status, 'timed_out');
  assert.equal(runB?.status, 'committed');
  assert.equal(deliberation.state, 'committed');

  h.workers.set(setup.workerAParticipantId, new MockAgentAdapter(() => defaultWorkerAScript()));
  const newRun = await h.engine.retryRun(setup.deliberationId, runA!.id);
  deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(newRun.status, 'committed');
  assert.notEqual(newRun.id, runA!.id);
  assert.equal(deliberation.runs.filter((run) => run.status === 'committed').length, 2);
  assert.equal(deliberation.runs.filter((run) => run.id === runA!.id)[0].status, 'timed_out');

  h.engine.reveal(setup.deliberationId);
  deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.positions.length, 2);
});

test('S4 cancel: running worker is cancelled without corrupting the flow', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h, {
    timeoutPolicy: { defaultMs: 5000, maxEvidenceRounds: 1 },
    workerA: { ...defaultWorkerAScript(), delayMs: 10_000 },
    workerB: { ...defaultWorkerBScript(), delayMs: 50 },
  });
  const promise = h.engine.startBlindRun(setup.deliberationId);
  await new Promise((resolve) => setTimeout(resolve, 120));
  const running = h.engine.getState(setup.deliberationId).runs.find(
    (run) => run.participantId === setup.workerAParticipantId,
  )!;
  h.engine.cancelRun(setup.deliberationId, running.id);
  await promise;
  const deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.runs.find((run) => run.id === running.id)?.status, 'cancelled');
  assert.equal(deliberation.positions.length, 1);
});

test('S5 failed adapter -> retry succeeds without overwriting the failure record', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h, {
    workerA: { ...defaultWorkerAScript(), failWith: 'adapter exploded' },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  let deliberation = h.engine.getState(setup.deliberationId);
  const failedRun = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId)!;
  assert.equal(failedRun.status, 'failed');
  h.workers.set(setup.workerAParticipantId, new MockAgentAdapter(() => defaultWorkerAScript()));
  await h.engine.retryRun(setup.deliberationId, failedRun.id);
  deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.runs.find((run) => run.id === failedRun.id)?.status, 'failed');
  assert.equal(deliberation.runs.filter((run) => run.status === 'committed').length, 2);
});

test('S6 reviewer insufficient_evidence -> escalate -> human decides', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    reviewer: {
      recommendation: 'insufficient_evidence',
      evidenceSufficiency: 'insufficient',
      unresolvedRisks: ['Load test missing'],
    },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  const review = await h.engine.runReview(setup.deliberationId);
  assert.equal(review.recommendation, 'insufficient_evidence');
  h.engine.escalateToHuman({
    deliberationId: setup.deliberationId,
    rationale: 'Need human judgment',
    ownerId: 'human-owner',
  });
  let deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.state, 'escalated');
  const chosen = deliberation.positions[0];
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'approve',
    rationale: 'Human accepts candidate despite missing load test',
    selectedRefs: [`position:${chosen.id}`, ...chosen.artifactRefs],
    ownerId: 'human-owner',
  });
  deliberation = h.engine.getState(setup.deliberationId);
  assert.equal(deliberation.state, 'decided');
  assert.ok(decision.dissent.includes('Load test missing'));
});

test('S7 human override selects the candidate the reviewer did not recommend', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const positions = deliberation.positions;
  const candidateB = positions.find((position) => position.claims.some((claim) => claim.statement.includes('Events decouple')))!;
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'override',
    rationale: 'Choosing B on operational grounds',
    selectedRefs: [`position:${candidateB.id}`, ...candidateB.artifactRefs],
    ownerId: 'human-owner',
  });
  assert.ok(decision.selectedRefs[0].includes(candidateB.id));
});

test('S8 human merges both candidates', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    reviewer: { recommendation: 'merge' },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const allRefs = deliberation.positions.flatMap((position) => [
    `position:${position.id}`,
    ...position.artifactRefs,
  ]);
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'merge',
    rationale: 'Merge both',
    selectedRefs: allRefs,
    ownerId: 'human-owner',
  });
  assert.equal(decision.selectedRefs.length, allRefs.length);
});

test('S9 challenge/response cycle drives challenging -> verifying automatically', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const runA = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId)!;
  const runB = deliberation.runs.find((run) => run.participantId === setup.workerBParticipantId)!;
  const challenge = h.engine.createChallenge({
    deliberationId: setup.deliberationId,
    targetRef: 'claim:b-1',
    authorRunId: runA.id,
    question: 'What is the delivery guarantee of the event bus?',
    requestedEvidence: 'Delivery guarantee spec',
  });
  assert.equal(challenge.status, 'open');
  const response = h.engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: runB.id,
    text: 'Outbox + idempotent consumers, at-least-once.',
  });
  assert.equal(response.concession, false);
  let state = h.engine.getState(setup.deliberationId);
  assert.equal(state.state, 'verifying');
  assert.equal(state.challenges[0].status, 'answered');
});

test('S10 evidence request: pending request blocks advance until fulfilled', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);
  const deliberation = h.engine.getState(setup.deliberationId);
  const runA = deliberation.runs.find((run) => run.participantId === setup.workerAParticipantId)!;
  const challenge = h.engine.createChallenge({
    deliberationId: setup.deliberationId,
    targetRef: 'claim:b-2',
    authorRunId: runA.id,
    question: 'Prove that synchronous calls couple availability.',
  });
  const request = h.engine.createEvidenceRequest({
    deliberationId: setup.deliberationId,
    challengeId: challenge.id,
    assignee: 'verifier',
    question: 'Run the coupling probe',
  });
  assert.equal(request.status, 'pending');
  assert.equal(h.engine.getState(setup.deliberationId).state, 'challenging');
  const evidence = h.engine.addEvidence({
    deliberationId: setup.deliberationId,
    targetRefs: ['claim:b-2'],
    status: 'verified',
    resultSummary: 'Coupling probe passed: p95 +12ms under 100ms outage',
    kind: 'authoritative_source',
  });
  h.engine.fulfillEvidenceRequest(request.id, evidence.id);
  let state = h.engine.getState(setup.deliberationId);
  assert.equal(state.state, 'verifying');
  assert.equal(state.evidenceRequests[0].status, 'fulfilled');
});

test('S11 failed verification -> conditional decision keeps the risk visible', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    reviewer: { unresolvedRisks: ['Latency probe failed'] },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  await h.engine.runVerification({
    deliberationId: setup.deliberationId,
    command: 'node',
    args: ['-e', 'process.exit(1)'],
    targetRefs: ['claim:a-1'],
    description: 'latency probe',
  });
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'approve',
    rationale: 'Approve conditionally',
    conditions: ['Do not ship until latency probe passes'],
    ownerId: 'human-owner',
  });
  const evidence = h.engine.getState(setup.deliberationId).evidence[0];
  assert.equal(evidence.status, 'failed');
  assert.ok(decision.conditions.includes('Do not ship until latency probe passes'));
});

test('S12 human marks no_decision without selecting a candidate', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    reviewer: { recommendation: 'insufficient_evidence', evidenceSufficiency: 'insufficient' },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'no_decision',
    rationale: 'Cannot decide with current evidence',
    ownerId: 'human-owner',
  });
  assert.deepEqual(decision.selectedRefs, []);
  assert.equal(h.engine.getState(setup.deliberationId).state, 'decided');
});

test('S13 artifact registry: same logical name from both workers creates immutable versions', async () => {
  const h = createHarness({ autoReveal: false });
  const setup = setupDeliberation(h, {
    workerA: {
      ...defaultWorkerAScript(),
      artifacts: [{ logicalName: 'shared-design', type: 'markdown', content: 'v1 from A' }],
    },
    workerB: {
      ...defaultWorkerBScript(),
      artifacts: [{ logicalName: 'shared-design', type: 'markdown', content: 'v2 from B' }],
    },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  const artifactVersions = h.engine.deliberationDatabase.artifactVersions;
  assert.equal(
    artifactVersions.filter((version) => version.sourceRunId).length,
    2,
  );
  const pack = h.engine.exportDecisionPack(setup.deliberationId);
  assert.deepEqual(pack.traceability.unresolvedRefs, []);
});

test('S14 evidence round limit: second request_evidence is rejected', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    timeoutPolicy: { defaultMs: 5000, maxEvidenceRounds: 1 },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  h.engine.requestMoreEvidence({
    deliberationId: setup.deliberationId,
    rationale: 'one more probe',
    ownerId: 'human-owner',
  });
  await h.engine.runVerification({
    deliberationId: setup.deliberationId,
    command: 'node',
    args: ['-e', 'console.log(1)'],
    targetRefs: ['claim:a-1'],
  });
  const pendingRequest = h.engine.getState(setup.deliberationId).evidenceRequests.find(
    (request) => request.status === 'pending',
  )!;
  const evidence = h.engine.getState(setup.deliberationId).evidence.at(-1)!;
  h.engine.fulfillEvidenceRequest(pendingRequest.id, evidence.id);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  assert.throws(() =>
    h.engine.requestMoreEvidence({
      deliberationId: setup.deliberationId,
      rationale: 'second round',
      ownerId: 'human-owner',
    }),
    /Evidence round limit reached/,
  );
});

test('S15 request_evidence loop resumes and completes', async () => {
  const h = createHarness();
  const setup = setupDeliberation(h, {
    timeoutPolicy: { defaultMs: 5000, maxEvidenceRounds: 2 },
  });
  await h.engine.startBlindRun(setup.deliberationId);
  h.engine.finalizeChallenges(setup.deliberationId);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const request = h.engine.requestMoreEvidence({
    deliberationId: setup.deliberationId,
    rationale: 'need a probe',
    ownerId: 'human-owner',
  });
  const evidence = await h.engine.runVerification({
    deliberationId: setup.deliberationId,
    command: 'node',
    args: ['-e', 'console.log(1)'],
    targetRefs: ['claim:a-1'],
  });
  h.engine.fulfillEvidenceRequest(request.id, evidence.id);
  h.engine.freezeEvidencePack(setup.deliberationId);
  await h.engine.runReview(setup.deliberationId);
  const decision = h.engine.humanDecision({
    deliberationId: setup.deliberationId,
    action: 'approve',
    rationale: 'Evidence satisfied',
    ownerId: 'human-owner',
  });
  assert.ok(decision.selectedRefs.length >= 1);
  assert.equal(h.engine.getState(setup.deliberationId).rounds.evidence, 1);
});
