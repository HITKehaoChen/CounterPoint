import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWorkItemBoard, buildWorkItemView } from '../../src/human-view.ts';
import { createHarness, DEFAULT_RUBRIC } from '../helpers.ts';

test('work item view: projects work item with entries, knowledge and round history', () => {
  const h = createHarness();
  const project = h.engine.createProject({ name: 'Workspace' });
  h.engine.addSourceBinding({
    projectId: project.id,
    type: 'text',
    label: 'repo',
    text: 'billing service -> ledger (RPC)',
  });
  const workItem = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'bug',
    title: 'Ledger call hangs on outage',
    templateFields: { reproSteps: '1. stop ledger' },
  });
  const claim = h.engine.addWorkItemEntry(workItem.id, {
    kind: 'claim',
    statement: 'The ledger RPC has no timeout.',
    author: 'human-owner',
  });
  h.engine.transitionWorkItemClaim(workItem.id, claim.id, 'supported');
  h.engine.promoteWorkItemClaim(workItem.id, claim.id);
  h.engine.addWorkItemEntry(workItem.id, {
    kind: 'update',
    text: 'Reproduced twice.',
    author: 'worker-a',
  });
  h.engine.addWorkItemKnowledgeRef(workItem.id, {
    ref: 'evidence:ev_1',
    scope: 'module',
    status: 'verified',
    provenance: { workItemId: workItem.id },
  });

  const firstRound = h.engine.createDeliberation({
    projectId: project.id,
    ownerId: 'human-owner',
    problem: 'Round one',
    goals: ['g'],
    constraints: ['c'],
    rubric: DEFAULT_RUBRIC,
    workItemId: workItem.id,
  });
  const secondRound = h.engine.createDeliberation({
    projectId: project.id,
    ownerId: 'human-owner',
    problem: 'Round two',
    goals: ['g'],
    constraints: ['c'],
    rubric: DEFAULT_RUBRIC,
    workItemId: workItem.id,
  });

  const view = buildWorkItemView(h.engine.deliberationDatabase, workItem.id);
  assert.equal(view.id, workItem.id);
  assert.equal(view.kind, 'bug');
  assert.equal(view.entries.length, 2);
  const claimEntry = view.entries.find((entry) => entry.kind === 'claim')!;
  assert.equal(claimEntry.status, 'promoted');
  assert.equal(view.knowledgeRefs[0].ref, 'evidence:ev_1');
  assert.deepEqual(
    view.rounds.map((round) => round.deliberationId).sort(),
    [firstRound.id, secondRound.id].sort(),
  );
  assert.throws(() => buildWorkItemView(h.engine.deliberationDatabase, 'wi_nope'));
});

test('work item board: groups summaries by kind with round counts', () => {
  const h = createHarness();
  const project = h.engine.createProject({ name: 'Workspace' });
  const bug = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'bug',
    title: 'Hang on outage',
  });
  const decision = h.engine.createWorkItem({
    workspaceId: project.id,
    kind: 'decision',
    title: 'Sync or events?',
  });
  h.engine.updateWorkItem(bug.id, { status: 'investigating' });
  const round = h.engine.createDeliberation({
    projectId: project.id,
    ownerId: 'human-owner',
    problem: 'Round',
    goals: ['g'],
    constraints: ['c'],
    rubric: DEFAULT_RUBRIC,
    workItemId: decision.id,
  });
  void round;

  const board = buildWorkItemBoard(h.engine.deliberationDatabase, project.id);
  assert.equal(board.groups.bug.length, 1);
  assert.equal(board.groups.decision.length, 1);
  assert.equal(board.groups.bug[0].status, 'investigating');
  assert.equal(board.groups.decision[0].roundCount, 1);
  assert.equal(board.groups.bug[0].roundCount, 0);
});
