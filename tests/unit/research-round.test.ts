import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createHarness,
  defaultWorkerAScript,
  defaultWorkerBScript,
  DEFAULT_RUBRIC,
  type EngineHarness,
} from '../helpers.ts';
import { MockAgentAdapter } from '../../src/adapters/mock-agent.ts';
import { MockReviewerAdapter } from '../../src/adapters/mock-reviewer.ts';

function createWorkItemFixture(h: EngineHarness): { projectId: string; workItemId: string } {
  const project = h.engine.createProject({ name: 'Workspace' });
  h.engine.addSourceBinding({
    projectId: project.id,
    type: 'text',
    label: 'repo',
    text: 'billing service -> ledger (RPC)\nledger has retries; no outbox yet',
  });
  const workItem = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'decision',
    title: 'Ledger sync or events?',
    templateFields: { deliverable: 'ADR with conditions' },
  });
  return { projectId: project.id, workItemId: workItem.id };
}

function setupRound(
  h: EngineHarness,
  projectId: string,
  workItemId: string,
  problem: string,
): string {
  const deliberation = h.engine.createDeliberation({
    projectId,
    ownerId: 'human-owner',
    problem,
    goals: ['Choose a reliable integration'],
    constraints: ['No new infrastructure'],
    rubric: DEFAULT_RUBRIC,
    workItemId,
  });
  const workerA = h.engine.addParticipant({
    deliberationId: deliberation.id,
    role: 'worker',
    label: 'Worker A',
  });
  const workerB = h.engine.addParticipant({
    deliberationId: deliberation.id,
    role: 'worker',
    label: 'Worker B',
  });
  const reviewer = h.engine.addParticipant({
    deliberationId: deliberation.id,
    role: 'reviewer',
    label: 'Reviewer',
  });
  h.workers.set(workerA.id, new MockAgentAdapter(() => defaultWorkerAScript()));
  h.workers.set(workerB.id, new MockAgentAdapter(() => defaultWorkerBScript()));
  h.reviewers.set(reviewer.id, new MockReviewerAdapter({}));
  h.engine.freezeTaskPacket(deliberation.id);
  return deliberation.id;
}

async function completeRound(h: EngineHarness, deliberationId: string): Promise<void> {
  await h.engine.startBlindRun(deliberationId);
  const state = h.engine.getState(deliberationId);
  const targetPosition = state.positions[0];
  const targetClaim = targetPosition.claims[0];
  const responseRun = state.runs.find((run) => run.id === targetPosition.runId)!;
  const otherRun = state.runs.find((run) => run.id !== targetPosition.runId)!;
  const challenge = h.engine.createChallenge({
    deliberationId,
    targetRef: `claim:${targetClaim.id}`,
    authorRunId: otherRun.id,
    question: 'Delivery guarantee under a ledger outage?',
  });
  h.engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: responseRun.id,
    text: 'At-least-once with idempotency keys.',
  });
  await h.engine.runVerification({
    deliberationId,
    command: 'node',
    args: ['-e', 'console.log("probe ok")'],
    targetRefs: [`claim:${targetClaim.id}`],
  });
  h.engine.freezeEvidencePack(deliberationId);
  await h.engine.runReview(deliberationId);
  h.engine.humanDecision({
    deliberationId,
    action: 'approve',
    rationale: 'Accepted after review.',
    ownerId: 'human-owner',
  });
}

test('research round: task packet freezes the work item version snapshot at creation', () => {
  const h = createHarness();
  const { projectId, workItemId } = createWorkItemFixture(h);
  h.engine.updateWorkItem(workItemId, { description: 'Round 2 notes' });

  const deliberationId = setupRound(h, projectId, workItemId, 'Sync or events?');
  const snapshot = h.engine.getTaskPacket(deliberationId).workItemSnapshot;
  assert.ok(snapshot);
  assert.equal(snapshot.workItemId, workItemId);
  assert.equal(snapshot.version, 2);
  assert.equal(snapshot.title, 'Ledger sync or events?');
  assert.deepEqual(snapshot.templateFields, { deliverable: 'ADR with conditions' });
  assert.ok(snapshot.hash.length >= 8);
});

test('research round: multiple rounds keep independent snapshots', () => {
  const h = createHarness();
  const { projectId, workItemId } = createWorkItemFixture(h);
  const first = setupRound(h, projectId, workItemId, 'Round one');
  h.engine.updateWorkItem(workItemId, { description: 'New evidence arrived' });
  const second = setupRound(h, projectId, workItemId, 'Round two');

  const firstSnapshot = h.engine.getTaskPacket(first).workItemSnapshot!;
  const secondSnapshot = h.engine.getTaskPacket(second).workItemSnapshot!;
  assert.equal(firstSnapshot.version, 1);
  assert.equal(secondSnapshot.version, 2);
  assert.equal(firstSnapshot.workItemId, workItemId);
  assert.equal(secondSnapshot.workItemId, workItemId);
});

test('research round: decisions flow back to work item conclusions without overwriting', async () => {
  const h = createHarness();
  const { projectId, workItemId } = createWorkItemFixture(h);
  const first = setupRound(h, projectId, workItemId, 'Round one');
  await completeRound(h, first);

  let workItem = h.engine.getWorkItem(workItemId);
  const firstRefs = [...workItem.currentConclusionRefs];
  assert.ok(firstRefs.length >= 1);

  const second = setupRound(h, projectId, workItemId, 'Round two');
  await completeRound(h, second);
  workItem = h.engine.getWorkItem(workItemId);
  assert.ok(workItem.currentConclusionRefs.length > firstRefs.length);
  for (const ref of firstRefs) {
    assert.ok(
      workItem.currentConclusionRefs.includes(ref),
      `first round ref ${ref} must remain in conclusions`,
    );
  }
});
