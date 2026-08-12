import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LEGAL_TRANSITIONS,
  assertLegalTransition,
  guardTransition,
} from '../../src/state-machine.ts';
import type { Deliberation } from '../../src/schemas.ts';

function makeDeliberation(overrides: Partial<Deliberation> = {}): Deliberation {
  return {
    id: 'delib-1',
    projectId: 'prj-1',
    protocolVersion: '0.1.0',
    state: 'draft',
    ownerId: 'human-1',
    participants: [
      { id: 'human-1', deliberationId: 'delib-1', role: 'human', label: 'Owner' },
      { id: 'w1', deliberationId: 'delib-1', role: 'worker', label: 'W1' },
      { id: 'w2', deliberationId: 'delib-1', role: 'worker', label: 'W2' },
      { id: 'r1', deliberationId: 'delib-1', role: 'reviewer', label: 'R1' },
    ],
    runs: [],
    positions: [],
    challenges: [],
    responses: [],
    evidenceRequests: [],
    evidence: [],
    reviews: [],
    decisions: [],
    rounds: { challenge: 0, evidence: 0 },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    timeoutPolicy: { defaultMs: 1000, maxEvidenceRounds: 1 },
    ...overrides,
  };
}

test('legal transition table matches PRD 6.2', () => {
  assert.deepEqual(LEGAL_TRANSITIONS.draft, ['frozen']);
  assert.deepEqual(LEGAL_TRANSITIONS.frozen, ['blind_run']);
  assert.deepEqual(LEGAL_TRANSITIONS.blind_run, ['committed']);
  assert.deepEqual(LEGAL_TRANSITIONS.committed, ['revealed']);
  assert.deepEqual(LEGAL_TRANSITIONS.revealed, ['challenging']);
  assert.deepEqual(LEGAL_TRANSITIONS.challenging, ['verifying']);
  assert.deepEqual(LEGAL_TRANSITIONS.verifying, ['reviewing']);
  assert.deepEqual(LEGAL_TRANSITIONS.reviewing, ['decided', 'escalated', 'verifying']);
  assert.deepEqual(LEGAL_TRANSITIONS.escalated, ['decided']);
  assert.deepEqual(LEGAL_TRANSITIONS.decided, []);
});

test('assertLegalTransition rejects illegal jumps', () => {
  assert.throws(() => assertLegalTransition('draft', 'blind_run'));
  assert.throws(() => assertLegalTransition('blind_run', 'decided'));
  assert.doesNotThrow(() => assertLegalTransition('reviewing', 'escalated'));
});

test('draft -> frozen guard requires frozen packet, 2 workers and human owner', () => {
  const deliberation = makeDeliberation();
  assert.ok(
    guardTransition('draft', 'frozen', { deliberation, taskPacket: undefined }).length > 0,
  );
  const packet = {
    id: 'tp-1',
    version: 1,
    problem: 'p',
    goals: ['g'],
    constraints: ['c'],
    rubric: { items: [{ id: 'r1', name: 'Correctness', weight: 1 }], maxScore: 5 },
    sources: ['src-1'],
    hash: 'h',
    frozenAt: '2026-01-01T00:00:00.000Z',
  };
  assert.deepEqual(guardTransition('draft', 'frozen', { deliberation, taskPacket: packet }), []);
  assert.ok(
    guardTransition('draft', 'frozen', {
      deliberation: makeDeliberation({
        participants: [{ id: 'w1', deliberationId: 'd', role: 'worker' }],
      }),
      taskPacket: packet,
    }).length > 0,
  );
});

test('blind_run -> committed guard blocks when not all active workers committed', () => {
  const deliberation = makeDeliberation({
    state: 'blind_run',
    runs: [
      { id: 'run-1', participantId: 'w1', phase: 'blind_run', status: 'committed' },
      { id: 'run-2', participantId: 'w2', phase: 'blind_run', status: 'running' },
    ],
  });
  const violations = guardTransition('blind_run', 'committed', {
    deliberation,
    committedWorkers: 1,
    activeWorkers: 2,
  });
  assert.ok(violations.some((v) => v.includes('Not all active Workers committed')));
});

test('challenging -> verifying guard blocks open challenges and pending evidence requests', () => {
  const deliberation = makeDeliberation({
    state: 'challenging',
    challenges: [{ id: 'c1', deliberationId: 'd', targetRef: 'claim:x', authorRunId: 'r1', question: 'q', status: 'open', createdAt: 't' }],
  });
  const violations = guardTransition('challenging', 'verifying', { deliberation });
  assert.ok(violations.some((v) => v.includes('Open challenges remain')));
});

test('reviewing -> decided guard requires review and human decision', () => {
  const deliberation = makeDeliberation({ state: 'reviewing' });
  const violations = guardTransition('reviewing', 'decided', { deliberation });
  assert.ok(violations.some((v) => v.includes('Reviewer verdict is required')));
});

test('reviewing -> verifying guard enforces evidence round limit', () => {
  const deliberation = makeDeliberation({ state: 'reviewing' });
  assert.deepEqual(
    guardTransition('reviewing', 'verifying', {
      deliberation,
      evidenceRounds: 1,
      maxEvidenceRounds: 1,
    }),
    ['Evidence round limit reached'],
  );
});
