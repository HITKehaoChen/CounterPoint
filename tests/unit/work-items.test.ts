import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHarness } from '../helpers.ts';
import type { Event } from '../../src/schemas.ts';

test('work items: create/get/list/update with version increments', () => {
  const h = createHarness();
  const project = h.engine.createProject({ name: 'Workspace A' });
  const other = h.engine.createProject({ name: 'Workspace B' });

  const item = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'bug',
    title: 'Ledger call hangs on outage',
    description: 'Reproduce: stop ledger, call billing API.',
    templateFields: { reproSteps: '1. stop ledger' },
  });
  assert.equal(item.status, 'open');
  assert.equal(item.version, 1);
  assert.equal(item.ownerId, 'human-owner');

  const second = h.engine.createWorkItem({
    workspaceId: other.id,
    kind: 'hypothesis',
    title: 'Retry loop causes the hang',
  });
  assert.deepEqual(h.engine.listWorkItems(project.id).map((item) => item.id), [item.id]);

  const updated = h.engine.updateWorkItem(item.id, {
    status: 'investigating',
    description: 'Updated repro notes',
  });
  assert.equal(updated.status, 'investigating');
  assert.equal(updated.version, 2);
  assert.equal(h.engine.getWorkItem(item.id).description, 'Updated repro notes');

  assert.throws(() => h.engine.getWorkItem('wi_nope'), /WorkItem not found/);
  assert.throws(() => h.engine.updateWorkItem('wi_nope', { status: 'open' }), /WorkItem not found/);
  assert.ok(second.id !== item.id);
});

test('work items: entries start tentative; claim state machine is guarded', () => {
  const h = createHarness();
  const project = h.engine.createProject({ name: 'Workspace' });
  const item = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'problem',
    title: 'Which integration style?',
  });

  const claim = h.engine.addWorkItemEntry(item.id, {
    kind: 'claim',
    statement: 'The ledger RPC has no timeout.',
    author: 'human-owner',
  });
  assert.equal(claim.kind, 'claim');
  assert.equal(claim.status, 'tentative');

  const question = h.engine.addWorkItemEntry(item.id, {
    kind: 'question',
    text: 'Is there a timeout configured?',
    assignee: 'agent',
    author: 'human-owner',
  });
  assert.equal(question.kind, 'question');

  const update = h.engine.addWorkItemEntry(item.id, {
    kind: 'update',
    text: 'Found the retry loop.',
    author: 'worker-b',
  });
  assert.equal(update.kind, 'update');
  assert.equal(h.engine.getWorkItem(item.id).entries.length, 3);

  assert.throws(
    () => h.engine.promoteWorkItemClaim(item.id, claim.id),
    /only supported claims can be promoted/i,
  );
  h.engine.transitionWorkItemClaim(item.id, claim.id, 'supported');
  const promoted = h.engine.promoteWorkItemClaim(item.id, claim.id);
  assert.equal(promoted.status, 'promoted');
  assert.throws(
    () => h.engine.transitionWorkItemClaim(item.id, claim.id, 'supported'),
    /cannot transition/i,
  );
  assert.throws(
    () => h.engine.promoteWorkItemClaim(item.id, 'e_nope'),
    /claim not found/i,
  );
});

test('work items: knowledge refs are appended and events fire', () => {
  const events: Event[] = [];
  const h = createHarness({ onEvent: (event) => events.push(event) });
  const project = h.engine.createProject({ name: 'Workspace' });
  const item = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'requirement',
    title: 'Add retry budget',
  });
  h.engine.addWorkItemKnowledgeRef(item.id, {
    ref: 'evidence:ev_1',
    scope: 'module',
    sourceVersion: 'repo@v3',
    status: 'verified',
    appliesWhen: 'ledger is the downstream RPC target',
    provenance: { workItemId: item.id },
  });

  const workItem = h.engine.getWorkItem(item.id);
  assert.equal(workItem.knowledgeRefs.length, 1);
  assert.equal(workItem.knowledgeRefs[0].ref, 'evidence:ev_1');

  const types = events.map((event) => event.type);
  for (const expected of ['work_item.created', 'work_item.knowledge.added']) {
    assert.ok(types.includes(expected), `missing event ${expected}`);
  }
});
