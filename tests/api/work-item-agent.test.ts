import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../../apps/api/server.ts';

async function startServer() {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-agent-'));
  const app = createApiServer({
    storePath: join(dir, 'store.json'),
    workspaceRoot: join(dir, 'workspaces'),
    seed: 'agent-test',
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

async function waitFor<T>(
  baseUrl: string,
  path: string,
  predicate: (json: T) => boolean,
  timeoutMs = 10_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: T;
  while (Date.now() < deadline) {
    const response = await fetch(baseUrl + path);
    last = (await response.json()) as T;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`waitFor timeout on ${path}`);
}

test('API: invite-agent appends an update and tentative claims to the work item', async () => {
  const server = await startServer();
  try {
    const project = await request(server.baseUrl, 'POST', '/api/projects', { name: 'W' });
    const projectId = (await project.json()).project.id;
    const created = await request(server.baseUrl, 'POST', `/api/workspaces/${projectId}/work-items`, {
      kind: 'bug',
      title: 'Ledger call hangs on outage',
      templateFields: { reproSteps: '1. stop ledger' },
    });
    const workItemId = (await created.json()).workItem.id;

    const invited = await request(server.baseUrl, 'POST', `/api/work-items/${workItemId}/invite-agent`, {
      prompt: '请分析可能原因',
    });
    assert.equal(invited.status, 202);
    assert.ok((await invited.json()).jobId);

    const view = await waitFor<{ workItem: { entries: Array<{ kind: string; status?: string }> } }>(
      server.baseUrl,
      `/api/work-items/${workItemId}`,
      (json) => json.workItem.entries.length >= 2,
    );
    const claims = view.workItem.entries.filter((entry) => entry.kind === 'claim');
    const updates = view.workItem.entries.filter((entry) => entry.kind === 'update');
    assert.ok(claims.length >= 1, 'agent should produce at least one claim');
    assert.ok(updates.length >= 1, 'agent should produce an update');
    for (const claim of claims) {
      assert.equal(claim.status, 'tentative');
    }
  } finally {
    await server.close();
  }
});
