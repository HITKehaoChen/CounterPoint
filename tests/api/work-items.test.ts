import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../../apps/api/server.ts';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-wi-api-'));
  const app = createApiServer({
    storePath: join(dir, 'store.json'),
    workspaceRoot: join(dir, 'workspaces'),
    seed: 'wi-api-test',
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function jsonRequest(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: () => Promise<any> }> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: () => response.json() };
}

test('API: work item board/detail/entries/promote/knowledge and round link', async () => {
  const server = await startServer();
  try {
    const project = await jsonRequest(server.baseUrl, 'POST', '/api/projects', {
      name: 'Workspace',
    });
    const projectId = (await project.json()).project.id;

    const created = await jsonRequest(server.baseUrl, 'POST', `/api/workspaces/${projectId}/work-items`, {
      kind: 'bug',
      title: 'Ledger call hangs on outage',
      templateFields: { reproSteps: '1. stop ledger' },
    });
    assert.equal(created.status, 201);
    const workItem = (await created.json()).workItem;
    assert.equal(workItem.status, 'open');

    const board = await jsonRequest(server.baseUrl, 'GET', `/api/workspaces/${projectId}/work-items`);
    assert.equal(board.status, 200);
    const boardBody = await board.json();
    assert.equal(boardBody.board.groups.bug[0].id, workItem.id);

    const patched = await jsonRequest(server.baseUrl, 'PATCH', `/api/work-items/${workItem.id}`, {
      status: 'investigating',
    });
    assert.equal(patched.status, 200);
    assert.equal((await patched.json()).workItem.status, 'investigating');

    const claim = await jsonRequest(server.baseUrl, 'POST', `/api/work-items/${workItem.id}/entries`, {
      kind: 'claim',
      statement: 'The ledger RPC has no timeout.',
      author: 'human-owner',
    });
    assert.equal(claim.status, 201);
    const claimEntry = (await claim.json()).entry;
    assert.equal(claimEntry.status, 'tentative');

    const prematurePromote = await jsonRequest(
      server.baseUrl,
      'POST',
      `/api/work-items/${workItem.id}/entries/${claimEntry.id}/promote`,
      {},
    );
    assert.equal(prematurePromote.status, 409);

    const supported = await jsonRequest(
      server.baseUrl,
      'POST',
      `/api/work-items/${workItem.id}/entries/${claimEntry.id}/status`,
      { status: 'supported' },
    );
    assert.equal(supported.status, 200);
    const promoted = await jsonRequest(
      server.baseUrl,
      'POST',
      `/api/work-items/${workItem.id}/entries/${claimEntry.id}/promote`,
      {},
    );
    assert.equal(promoted.status, 200);
    assert.equal((await promoted.json()).entry.status, 'promoted');

    const knowledge = await jsonRequest(
      server.baseUrl,
      'POST',
      `/api/work-items/${workItem.id}/knowledge-refs`,
      { ref: 'evidence:ev_1', scope: 'module', status: 'verified' },
    );
    assert.equal(knowledge.status, 200);
    assert.equal((await knowledge.json()).workItem.knowledgeRefs.length, 1);

    const detail = await jsonRequest(server.baseUrl, 'GET', `/api/work-items/${workItem.id}`);
    const detailBody = await detail.json();
    assert.equal(detailBody.workItem.entries.length, 1);
    assert.equal(detailBody.workItem.entries[0].status, 'promoted');

    const round = await jsonRequest(server.baseUrl, 'POST', `/api/workspaces/${projectId}/deliberations`, {
      ownerId: 'human-owner',
      problem: 'Round one',
      goals: ['g'],
      constraints: ['c'],
      rubric: { items: [{ id: 'correctness', name: 'Correctness', weight: 1 }], maxScore: 5 },
      workItemId: workItem.id,
    });
    assert.equal(round.status, 201);
    const roundBody = await round.json();
    assert.equal(roundBody.deliberation.workItemId, workItem.id);

    const missing = await jsonRequest(server.baseUrl, 'GET', '/api/work-items/wi_nope');
    assert.equal(missing.status, 404);
    const invalid = await jsonRequest(server.baseUrl, 'POST', `/api/workspaces/${projectId}/work-items`, {
      kind: 'task',
      title: 'nope',
    });
    assert.equal(invalid.status, 400);
  } finally {
    await server.close();
  }
});
