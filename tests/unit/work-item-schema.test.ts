import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DatabaseSchema,
  DeliberationSchema,
  TaskPacketSchema,
  WorkItemEntrySchema,
  WorkItemSchema,
  emptyDatabase,
} from '../../src/schemas.ts';

const VALID_WORK_ITEM = {
  id: 'wi_1',
  workspaceId: 'prj_1',
  kind: 'bug',
  title: 'Ledger call hangs on outage',
  description: 'Reproduce: stop ledger, call billing API.',
  ownerId: 'human-owner',
  status: 'open',
  templateFields: { reproSteps: '1. stop ledger\n2. call billing' },
  currentConclusionRefs: [],
  knowledgeRefs: [],
  relations: [],
  entries: [],
  version: 1,
  createdAt: '2026-08-12T00:00:00.000Z',
  updatedAt: '2026-08-12T00:00:00.000Z',
};

test('work item schema: parses a valid work item and fills default arrays', () => {
  const parsed = WorkItemSchema.parse({ ...VALID_WORK_ITEM, templateFields: undefined });
  assert.equal(parsed.kind, 'bug');
  assert.deepEqual(parsed.templateFields, {});
  assert.deepEqual(parsed.currentConclusionRefs, []);
  assert.deepEqual(parsed.entries, []);
});

test('work item schema: rejects unknown kind and status', () => {
  assert.throws(() => WorkItemSchema.parse({ ...VALID_WORK_ITEM, kind: 'task' }));
  assert.throws(() => WorkItemSchema.parse({ ...VALID_WORK_ITEM, status: 'done' }));
});

test('work item schema: entry union accepts claim/question/update and rejects unknown kinds', () => {
  const claim = WorkItemEntrySchema.parse({
    id: 'e_1',
    kind: 'claim',
    statement: 'The ledger RPC has no timeout.',
    status: 'tentative',
    evidenceRefs: [],
    author: 'worker-a',
    createdAt: '2026-08-12T00:00:00.000Z',
  });
  assert.equal(claim.kind, 'claim');

  const question = WorkItemEntrySchema.parse({
    id: 'e_2',
    kind: 'question',
    text: 'Is there a timeout configured?',
    assignee: 'agent',
    author: 'human-owner',
    createdAt: '2026-08-12T00:00:00.000Z',
  });
  assert.equal(question.kind, 'question');

  const update = WorkItemEntrySchema.parse({
    id: 'e_3',
    kind: 'update',
    text: 'Found the retry loop.',
    author: 'worker-b',
    createdAt: '2026-08-12T00:00:00.000Z',
  });
  assert.equal(update.kind, 'update');

  assert.throws(() =>
    WorkItemEntrySchema.parse({
      id: 'e_4',
      kind: 'note',
      text: 'nope',
      createdAt: '2026-08-12T00:00:00.000Z',
    }),
  );
});

test('work item schema: knowledge ref requires scope and status', () => {
  const valid = WorkItemSchema.parse({
    ...VALID_WORK_ITEM,
    knowledgeRefs: [
      {
        ref: 'evidence:ev_1',
        scope: 'module',
        sourceVersion: 'repo@v3',
        status: 'verified',
        appliesWhen: 'ledger is the downstream RPC target',
        expiresAt: '2026-09-01T00:00:00.000Z',
        provenance: { workItemId: 'wi_1', researchRoundId: 'delib_1' },
      },
    ],
  });
  assert.equal(valid.knowledgeRefs[0].scope, 'module');

  assert.throws(() =>
    WorkItemSchema.parse({
      ...VALID_WORK_ITEM,
      knowledgeRefs: [{ ref: 'evidence:ev_1' }],
    }),
  );
});

test('work item schema: relations accept the three v1 relation kinds', () => {
  const parsed = WorkItemSchema.parse({
    ...VALID_WORK_ITEM,
    relations: [
      { relation: 'related_to', targetRef: 'wi_2' },
      { relation: 'depends_on', targetRef: 'wi_3' },
      { relation: 'supersedes', targetRef: 'wi_4' },
    ],
  });
  assert.equal(parsed.relations.length, 3);
  assert.throws(() =>
    WorkItemSchema.parse({
      ...VALID_WORK_ITEM,
      relations: [{ relation: 'blocks', targetRef: 'wi_2' }],
    }),
  );
});

test('deliberation schema: accepts optional workItemId; task packet accepts work item snapshot', () => {
  const deliberation = DeliberationSchema.parse({
    id: 'delib_1',
    projectId: 'prj_1',
    protocolVersion: '0.1.0',
    state: 'draft',
    workItemId: 'wi_1',
    ownerId: 'human-owner',
    createdAt: '2026-08-12T00:00:00.000Z',
    updatedAt: '2026-08-12T00:00:00.000Z',
  });
  assert.equal(deliberation.workItemId, 'wi_1');

  const packet = TaskPacketSchema.parse({
    id: 'tp_1',
    version: 1,
    problem: 'Should the call be synchronous?',
    goals: ['Choose a reliable integration'],
    constraints: ['No new infrastructure'],
    rubric: { items: [{ id: 'correctness', name: 'Correctness', weight: 1 }], maxScore: 5 },
    sources: ['src_repo@v1'],
    workItemSnapshot: {
      workItemId: 'wi_1',
      title: 'Ledger call hangs on outage',
      templateFields: { reproSteps: '1. stop ledger' },
      version: 3,
      hash: 'abc123',
    },
  });
  assert.equal(packet.workItemSnapshot?.version, 3);
  assert.equal(packet.workItemSnapshot?.hash, 'abc123');
});

test('database schema: emptyDatabase contains an empty workItems array', () => {
  const db = emptyDatabase();
  assert.deepEqual(db.workItems, []);
  assert.equal(DatabaseSchema.parse(db).workItems.length, 0);
});
