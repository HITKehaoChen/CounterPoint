import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../../apps/api/server.ts';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-knowledge-'));
  const app = createApiServer({
    storePath: join(dir, 'store.json'),
    workspaceRoot: join(dir, 'workspaces'),
    seed: 'knowledge-test',
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

async function request(baseUrl: string, method: string, path: string, body?: unknown) {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: () => response.json() as Promise<any> };
}

test('API: workspace knowledge aggregates only promoted claims and scoped refs', async () => {
  const server = await startServer();
  try {
    const project = await request(server.baseUrl, 'POST', '/api/projects', { name: 'W' });
    const projectId = (await project.json()).project.id;
    const created = await request(server.baseUrl, 'POST', `/api/workspaces/${projectId}/work-items`, {
      kind: 'hypothesis',
      title: 'Retry loop causes the hang',
    });
    const workItemId = (await created.json()).workItem.id;

    const tentative = await request(server.baseUrl, 'POST', `/api/work-items/${workItemId}/entries`, {
      kind: 'claim',
      statement: 'Tentative hypothesis.',
      author: 'human-owner',
    });
    const tentativeEntry = (await tentative.json()).entry;

    const supported = await request(server.baseUrl, 'POST', `/api/work-items/${workItemId}/entries`, {
      kind: 'claim',
      statement: 'Supported by evidence.',
      author: 'human-owner',
    });
    const supportedEntry = (await supported.json()).entry;
    await request(server.baseUrl, 'POST', `/api/work-items/${workItemId}/entries/${supportedEntry.id}/status`, {
      status: 'supported',
    });
    await request(server.baseUrl, 'POST', `/api/work-items/${workItemId}/entries/${supportedEntry.id}/promote`, {});

    await request(server.baseUrl, 'POST', `/api/work-items/${workItemId}/knowledge-refs`, {
      ref: 'evidence:ev_9',
      scope: 'module',
      sourceVersion: 'repo@v3',
      status: 'verified',
      appliesWhen: 'retry loop exists',
      provenance: { workItemId },
    });

    const knowledge = await request(server.baseUrl, 'GET', `/api/workspaces/${projectId}/knowledge`);
    assert.equal(knowledge.status, 200);
    const body = await knowledge.json();
    assert.equal(body.knowledge.promotedClaims.length, 1);
    assert.equal(body.knowledge.promotedClaims[0].statement, 'Supported by evidence.');
    assert.ok(!JSON.stringify(body.knowledge.promotedClaims).includes('Tentative hypothesis.'));
    assert.equal(body.knowledge.knowledgeRefs.length, 1);
    assert.equal(body.knowledge.knowledgeRefs[0].ref.ref, 'evidence:ev_9');
    assert.equal(body.knowledge.knowledgeRefs[0].workItemId, workItemId);
  } finally {
    await server.close();
  }
});
