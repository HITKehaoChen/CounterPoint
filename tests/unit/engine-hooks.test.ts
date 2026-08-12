import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createHarness,
  setupDeliberation,
  defaultWorkerAScript,
  defaultWorkerBScript,
  type RunUpdate,
} from '../helpers.ts';
import { JsonFileStore } from '../../src/store.ts';
import type { Event } from '../../src/schemas.ts';

test('hooks: onRunUpdate fires running then committed for every blind worker', async () => {
  const updates: RunUpdate[] = [];
  const h = createHarness({ onRunUpdate: (update) => updates.push(update) });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);

  const runUpdates = updates.filter((update) => update.deliberationId === setup.deliberationId);
  const byRun = new Map<string, string[]>();
  for (const update of runUpdates) {
    byRun.set(update.runId, [...(byRun.get(update.runId) ?? []), update.status]);
  }
  assert.equal(byRun.size, 2);
  for (const sequence of byRun.values()) {
    assert.deepEqual(sequence, ['running', 'committed']);
  }
});

test('hooks: onEvent fires for every appended protocol event', async () => {
  const events: Event[] = [];
  const h = createHarness({ onEvent: (event) => events.push(event) });
  const setup = setupDeliberation(h);
  await h.engine.startBlindRun(setup.deliberationId);

  const types = events.map((event) => event.type);
  for (const expected of [
    'project.created',
    'source.added',
    'deliberation.created',
    'participant.added',
    'task_packet.frozen',
    'blind_run.started',
    'run.committed',
    'candidates.revealed',
    'challenging.started',
  ]) {
    assert.ok(types.includes(expected), `missing event type ${expected}`);
  }
});

test('hooks: onRunUpdate reports failed runs', async () => {
  const updates: RunUpdate[] = [];
  const h = createHarness({ onRunUpdate: (update) => updates.push(update) });
  const setup = setupDeliberation(h, {
    workerA: { ...defaultWorkerAScript(), failWith: 'boom' },
    workerB: defaultWorkerBScript(),
  });
  await h.engine.startBlindRun(setup.deliberationId);

  const failed = updates.filter((update) => update.status === 'failed');
  assert.equal(failed.length, 1);
  assert.match(failed[0].error ?? '', /boom/);
});

test('hooks: runVerification persists evidence and appends evidence.recorded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-hooks-'));
  const dbPath = join(dir, 'store.json');
  try {
    const h = createHarness({ store: new JsonFileStore(dbPath) });
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
      question: 'What happens on ledger outage?',
    });
    h.engine.respondToChallenge({
      challengeId: challenge.id,
      authorRunId: responseRun.id,
      text: 'Retry with backoff; ledger stays the source of truth.',
    });
    assert.equal(h.engine.getState(setup.deliberationId).state, 'verifying');

    await h.engine.runVerification({
      deliberationId: setup.deliberationId,
      command: 'node',
      args: ['-e', 'console.log("probe ok")'],
      targetRefs: [`claim:${targetClaim.id}`],
      description: 'probe',
    });

    const fresh = new JsonFileStore(dbPath).load();
    const freshDeliberation = fresh.deliberations.find((item) => item.id === setup.deliberationId)!;
    assert.ok(freshDeliberation.evidence.length >= 1);
    const eventTypes = fresh.events
      .filter((event) => event.objectRef === setup.deliberationId)
      .map((event) => event.type);
    assert.ok(eventTypes.includes('evidence.recorded'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('hooks: runReview fires running then committed for the reviewer run', async () => {
  const updates: RunUpdate[] = [];
  const h = createHarness({ onRunUpdate: (update) => updates.push(update) });
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
    text: 'At-least-once with idempotency keys.',
  });
  h.engine.freezeEvidencePack(setup.deliberationId);

  await h.engine.runReview(setup.deliberationId);

  const reviewerUpdates = updates.filter(
    (update) => update.phase === 'reviewing' && update.deliberationId === setup.deliberationId,
  );
  const statuses = reviewerUpdates.map((update) => update.status);
  assert.ok(statuses.includes('running'));
  assert.ok(statuses.includes('committed'));
});
