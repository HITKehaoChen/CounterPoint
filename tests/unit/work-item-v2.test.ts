import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryStore } from '../../src/store.ts';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { WorkItemSchema } from '../../src/schemas.ts';

function engine(): ProtocolEngine {
  return new ProtocolEngine({
    store: new InMemoryStore(),
    workspaceRoot: 'C:/tmp/counterpoint-workitem-v2',
    resolveAdapter: () => undefined,
  });
}

test('WorkItem v2 parses goal, constraints, expected outcomes and envelope id', () => {
  const workItem = WorkItemSchema.parse({
    id: 'wi_1',
    workspaceId: 'ws_1',
    kind: 'bug',
    title: 'Inventory sync drops data intermittently',
    ownerId: 'human',
    status: 'open',
    goal: 'Locate a verifiable root cause',
    constraints: ['No production access'],
    expectedOutcomes: ['Root cause + regression plan'],
    sourceRefs: ['src_inventory@v1'],
    autonomyEnvelopeId: 'env_1',
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  });
  assert.equal(workItem.goal, 'Locate a verifiable root cause');
  assert.equal(workItem.autonomyEnvelopeId, 'env_1');
});

test('createWorkItem accepts v2 fields', () => {
  const e = engine();
  const project = e.createProject({ name: 'P' });
  const workItem = e.createWorkItem({
    workspaceId: project.id,
    kind: 'bug',
    title: 'Bug',
    goal: 'Find root cause',
    constraints: ['No prod'],
    expectedOutcomes: ['Fix plan'],
    sourceRefs: ['src_a@v1'],
    autonomyEnvelopeId: 'env_1',
  });
  assert.deepEqual(workItem.constraints, ['No prod']);
  assert.deepEqual(workItem.expectedOutcomes, ['Fix plan']);
  assert.deepEqual(workItem.sourceRefs, ['src_a@v1']);
  assert.equal(workItem.autonomyEnvelopeId, 'env_1');
});

test('new statuses parse and legacy investigating still parses', () => {
  assert.equal(WorkItemSchema.safeParse({ ...minimalWorkItem(), status: 'planning' }).success, true);
  assert.equal(WorkItemSchema.safeParse({ ...minimalWorkItem(), status: 'investigating' }).success, true);
});

function minimalWorkItem(): Record<string, unknown> {
  return {
    id: 'wi_2',
    workspaceId: 'ws_2',
    kind: 'problem',
    title: 'P',
    ownerId: 'human',
    status: 'open',
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}
