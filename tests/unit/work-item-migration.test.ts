import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyDatabase,
  migrateDatabase,
  type Database,
} from '../../src/schemas.ts';

function legacyDatabase(): Database {
  const db = emptyDatabase();
  db.projects.push({
    id: 'prj_1',
    name: 'Legacy Project',
    sourceBindings: [],
    createdAt: '2026-08-12T00:00:00.000Z',
  });
  db.taskPackets.push({
    id: 'tp_1',
    version: 1,
    hash: 'h1',
    problem: 'Should the billing module call the ledger synchronously?',
    goals: ['Choose a reliable integration'],
    constraints: ['No new infrastructure'],
    rubric: {
      items: [{ id: 'correctness', name: 'Correctness', weight: 1 }],
      maxScore: 5,
    },
    sources: ['src_repo@v1'],
  });
  db.deliberations.push({
    id: 'delib_1',
    projectId: 'prj_1',
    protocolVersion: '0.1.0',
    state: 'decided',
    taskPacketId: 'tp_1',
    ownerId: 'human-owner',
    participants: [],
    runs: [],
    positions: [],
    challenges: [],
    responses: [],
    evidenceRequests: [],
    evidence: [],
    reviews: [],
    decisions: [
      {
        id: 'dec_1',
        deliberationId: 'delib_1',
        selectedRefs: ['position:p_1', 'design-a@v1'],
        rationale: 'Accepted after review',
        conditions: [],
        dissent: [],
        humanAction: 'approve',
        decidedAt: '2026-08-12T01:00:00.000Z',
        ownerId: 'human-owner',
      },
    ],
    rounds: { challenge: 0, evidence: 0 },
    timeoutPolicy: { defaultMs: 120000, maxEvidenceRounds: 1 },
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T01:00:00.000Z',
  });
  db.deliberations.push({
    id: 'delib_2',
    projectId: 'prj_1',
    protocolVersion: '0.1.0',
    state: 'draft',
    taskPacketId: 'tp_1',
    ownerId: 'human-owner',
    participants: [],
    runs: [],
    positions: [],
    challenges: [],
    responses: [],
    evidenceRequests: [],
    evidence: [],
    reviews: [],
    decisions: [],
    rounds: { challenge: 0, evidence: 0 },
    timeoutPolicy: { defaultMs: 120000, maxEvidenceRounds: 1 },
    createdAt: '2026-08-12T02:00:00.000Z',
    updatedAt: '2026-08-12T02:00:00.000Z',
  });
  return db;
}

test('migration: legacy deliberations become one work item + one linked round each', () => {
  const migrated = migrateDatabase(legacyDatabase());
  assert.equal(migrated.workItems.length, 2);

  const decided = migrated.workItems.find((item) => item.id === 'wi_delib_1');
  assert.ok(decided);
  assert.equal(decided.kind, 'decision');
  assert.equal(decided.title, 'Should the billing module call the ledger synchronously?');
  assert.equal(decided.ownerId, 'human-owner');
  assert.equal(decided.status, 'resolved');
  assert.deepEqual(decided.currentConclusionRefs, ['position:p_1', 'design-a@v1']);
  assert.equal(decided.version, 1);

  const draft = migrated.workItems.find((item) => item.id === 'wi_delib_2');
  assert.ok(draft);
  assert.equal(draft.status, 'open');
  assert.deepEqual(draft.currentConclusionRefs, []);

  assert.equal(
    migrated.deliberations.find((item) => item.id === 'delib_1')?.workItemId,
    'wi_delib_1',
  );
  assert.equal(
    migrated.deliberations.find((item) => item.id === 'delib_2')?.workItemId,
    'wi_delib_2',
  );
});

test('migration: is idempotent and never duplicates work items', () => {
  const once = migrateDatabase(legacyDatabase());
  const twice = migrateDatabase(once);
  assert.equal(twice.workItems.length, 2);
  assert.deepEqual(
    twice.workItems.map((item) => item.id).sort(),
    once.workItems.map((item) => item.id).sort(),
  );
  assert.equal(
    twice.deliberations.find((item) => item.id === 'delib_1')?.workItemId,
    'wi_delib_1',
  );
});

test('migration: empty and already-migrated databases are untouched', () => {
  const empty = migrateDatabase(emptyDatabase());
  assert.deepEqual(empty.workItems, []);

  const migrated = migrateDatabase(legacyDatabase());
  migrated.workItems[0].title = 'Changed title';
  const again = migrateDatabase(migrated);
  assert.equal(again.workItems.length, 2);
  assert.equal(again.workItems[0].title, 'Changed title');
});
