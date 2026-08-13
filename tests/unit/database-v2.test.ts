import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DatabaseSchema,
  emptyDatabase,
  migrateDatabaseV2,
} from '../../src/schemas.ts';

test('empty database is schema 0.2.0 with planning arrays', () => {
  const db = emptyDatabase();
  assert.equal(db.schemaVersion, '0.2.0');
  assert.deepEqual(db.plans, []);
  assert.deepEqual(db.autonomyEnvelopes, []);
  assert.deepEqual(db.humanGateRequests, []);
  assert.equal(DatabaseSchema.safeParse(db).success, true);
});

test('migrateDatabaseV2 maps investigating to running and is idempotent', () => {
  const db = migrateDatabaseV2({
    ...emptyDatabase(),
    workItems: [
      {
        id: 'wi_1',
        workspaceId: 'ws_1',
        kind: 'bug',
        title: 'B',
        ownerId: 'human',
        status: 'investigating' as const,
        templateFields: {},
        currentConclusionRefs: [],
        knowledgeRefs: [],
        relations: [],
        entries: [],
        constraints: [],
        expectedOutcomes: [],
        sourceRefs: [],
        version: 1,
        createdAt: '2026-08-13T00:00:00.000Z',
        updatedAt: '2026-08-13T00:00:00.000Z',
      },
    ],
  });
  assert.equal(db.workItems[0].status, 'running');
  const again = migrateDatabaseV2(db);
  assert.equal(again.workItems[0].status, 'running');
  assert.equal(again.workItems.length, 1);
});
