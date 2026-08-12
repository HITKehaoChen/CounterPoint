import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { createApiServer } from '../../apps/api/server.ts';

interface TestServer {
  baseUrl: string;
  close(): Promise<void>;
}

interface ApiErrorBody {
  error: { code: number; message: string };
}

async function startTestServer(options: { autoReveal?: boolean } = {}): Promise<TestServer> {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-api-'));
  const app = createApiServer({
    storePath: join(dir, 'store.json'),
    workspaceRoot: join(dir, 'workspaces'),
    seed: 'api-test-seed',
    autoReveal: options.autoReveal ?? true,
  });
  await new Promise<void>((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const address = app.server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  return {
    baseUrl,
    close: async () => {
      app.server.closeAllConnections();
      await new Promise<void>((resolve) => app.server.close(() => resolve()));
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; json: () => Promise<unknown> }> {
  const response = await fetch(baseUrl + path, {
    method,
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: () => response.json() as Promise<unknown> };
}

async function post(baseUrl: string, path: string, body?: unknown): Promise<Record<string, any>> {
  const response = await request(baseUrl, 'POST', path, body);
  const json = (await response.json()) as Record<string, any>;
  assert.ok(response.status < 300, `POST ${path} failed with ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function get(baseUrl: string, path: string): Promise<Record<string, any>> {
  const response = await fetch(baseUrl + path);
  const json = (await response.json()) as Record<string, any>;
  assert.ok(response.status === 200, `GET ${path} failed with ${response.status}: ${JSON.stringify(json)}`);
  return json;
}

async function waitFor(
  baseUrl: string,
  path: string,
  predicate: (json: Record<string, any>) => boolean,
  timeoutMs = 10_000,
): Promise<Record<string, any>> {
  const deadline = Date.now() + timeoutMs;
  let last: Record<string, any> = {};
  while (Date.now() < deadline) {
    const response = await fetch(baseUrl + path);
    last = (await response.json()) as Record<string, any>;
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`waitFor timeout on ${path}: ${JSON.stringify(last).slice(0, 600)}`);
}

async function createDeliberationFixture(
  baseUrl: string,
  options: { freeze?: boolean } = {},
): Promise<{
  projectId: string;
  deliberationId: string;
  participantIds: string[];
}> {
  const project = await post(baseUrl, '/api/projects', { name: 'Demo Project' });
  await post(baseUrl, `/api/projects/${project.project.id}/sources`, {
    type: 'text',
    label: 'repo',
    text: 'billing service -> ledger (RPC)\nledger has retries; no outbox yet\np95 latency budget: 200ms',
  });
  const deliberation = await post(baseUrl, `/api/projects/${project.project.id}/deliberations`, {
    ownerId: 'human-owner',
    problem: 'Should the billing module call the ledger synchronously or via events?',
    goals: ['Choose an integration style that is testable and fault-tolerant'],
    constraints: ['No new infrastructure; existing retry semantics must remain'],
    rubric: {
      items: [
        { id: 'correctness', name: 'Correctness', weight: 1 },
        { id: 'fit', name: 'Fit with existing code', weight: 0.8 },
      ],
      maxScore: 5,
    },
    deliverable: 'ADR with conditions',
  });
  const participantIds: string[] = [];
  for (const label of ['Worker A', 'Worker B']) {
    const participant = await post(baseUrl, `/api/deliberations/${deliberation.deliberation.id}/participants`, {
      role: 'worker',
      label,
      adapterConfig: { kind: 'mock', side: label === 'Worker A' ? 'a' : 'b' },
    });
    participantIds.push(participant.participant.id);
  }
  const reviewer = await post(baseUrl, `/api/deliberations/${deliberation.deliberation.id}/participants`, {
    role: 'reviewer',
    label: 'Reviewer',
    adapterConfig: { kind: 'mock-reviewer' },
  });
  participantIds.push(reviewer.participant.id);
  if (options.freeze !== false) {
    await post(baseUrl, `/api/deliberations/${deliberation.deliberation.id}/freeze`);
  }
  return {
    projectId: project.project.id,
    deliberationId: deliberation.deliberation.id,
    participantIds,
  };
}

test('API: full deliberation lifecycle over HTTP ends in a traceable decision pack', async () => {
  const server = await startTestServer();
  try {
    const { deliberationId } = await createDeliberationFixture(server.baseUrl);
    const started = await post(server.baseUrl, `/api/deliberations/${deliberationId}/start`);
    assert.ok(started.jobId);
    assert.equal(started.status, 202);

    await waitFor(server.baseUrl, `/api/deliberations/${deliberationId}`, (view) => view.state === 'challenging');
    const revealed = await get(server.baseUrl, `/api/deliberations/${deliberationId}`);
    assert.equal(revealed.positions.length, 2);
    assert.deepEqual(
      revealed.positions.map((position: { label: string }) => position.label),
      ['候选 X', '候选 Y'],
    );

    const targetPosition = revealed.positions[0];
    const targetRun = revealed.runs.find((run: { positionId?: string }) => run.positionId === targetPosition.id)!;
    const otherRun = revealed.runs.find((run: { id: string }) => run.id !== targetRun.id)!;
    const challenge = await post(server.baseUrl, `/api/deliberations/${deliberationId}/challenges`, {
      targetRef: `claim:${targetPosition.claims[0].id}`,
      authorRunId: otherRun.id,
      question: 'What is the delivery guarantee under a ledger outage?',
    });
    await post(server.baseUrl, `/api/challenges/${challenge.challenge.id}/respond`, {
      authorRunId: targetRun.id,
      text: 'At-least-once via outbox with idempotent consumers.',
    });

    await waitFor(server.baseUrl, `/api/deliberations/${deliberationId}`, (view) => view.state === 'verifying');
    const verification = await post(server.baseUrl, `/api/deliberations/${deliberationId}/verify`, {
      command: 'node',
      args: ['-e', 'console.log("probe ok")'],
      targetRefs: [`claim:${targetPosition.claims[0].id}`],
      description: 'idempotency probe',
    });
    assert.equal(verification.status, 202);
    await waitFor(
      server.baseUrl,
      `/api/deliberations/${deliberationId}`,
      (view) => view.evidence.length >= 1,
    );

    await post(server.baseUrl, `/api/deliberations/${deliberationId}/freeze-evidence`);
    const reviewing = await get(server.baseUrl, `/api/deliberations/${deliberationId}`);
    assert.equal(reviewing.state, 'reviewing');
    assert.equal(reviewing.reviews.length, 0);

    const reviewJob = await post(server.baseUrl, `/api/deliberations/${deliberationId}/review`);
    assert.equal(reviewJob.status, 202);
    await waitFor(
      server.baseUrl,
      `/api/deliberations/${deliberationId}`,
      (view) => view.reviews.length === 1,
    );
    const reviewed = await get(server.baseUrl, `/api/deliberations/${deliberationId}`);
    assert.equal(reviewed.reviews[0].recommendation, 'candidate_a');

    const decision = await post(server.baseUrl, `/api/deliberations/${deliberationId}/decision`, {
      action: 'approve',
      rationale: 'Approve after review; revisit if scale targets change.',
      conditions: ['Run a load test before production rollout'],
      ownerId: 'human-owner',
    });
    assert.equal(decision.decision.humanAction, 'approve');

    const pack = await get(server.baseUrl, `/api/deliberations/${deliberationId}/decision-pack`);
    assert.deepEqual(pack.pack.traceability.unresolvedRefs, []);
    assert.equal(pack.pack.state, 'decided');

    const markdownResponse = await fetch(server.baseUrl + `/api/deliberations/${deliberationId}/decision-pack.md`);
    assert.equal(markdownResponse.status, 200);
    const markdown = await markdownResponse.text();
    assert.ok(markdown.includes('# Decision Pack'));

    const timeline = await get(server.baseUrl, `/api/deliberations/${deliberationId}/timeline`);
    const eventTypes = timeline.events.map((event: { type: string }) => event.type);
    for (const expected of ['candidates.revealed', 'evidence.recorded', 'review.submitted', 'decision.recorded']) {
      assert.ok(eventTypes.includes(expected), `missing timeline event ${expected}`);
    }

    const contextViews = await get(
      server.baseUrl,
      `/api/deliberations/${deliberationId}/context-views?runId=${otherRun.id}`,
    );
    assert.ok(contextViews.contextViews[0].visible.authoritySources.includes('src_repo@v1'));
  } finally {
    await server.close();
  }
});

test('API: blind phase redacts candidate content over REST and SSE', async () => {
  const server = await startTestServer({ autoReveal: false });
  try {
    const { deliberationId } = await createDeliberationFixture(server.baseUrl);
    await post(server.baseUrl, `/api/deliberations/${deliberationId}/start`);
    await waitFor(server.baseUrl, `/api/deliberations/${deliberationId}`, (view) => view.state === 'committed');

    const blind = await get(server.baseUrl, `/api/deliberations/${deliberationId}`);
    assert.equal(blind.positions.length, 0);
    const blindJson = JSON.stringify(blind);
    for (const marker of ['transactional rollback', 'Use RPC with retries.', 'mock-web-a']) {
      assert.ok(!blindJson.includes(marker), `blind REST leaked marker: ${marker}`);
    }

    const streamResponse = await fetch(
      server.baseUrl + `/api/stream?deliberationId=${deliberationId}`,
    );
    assert.equal(streamResponse.status, 200);
    const streamPromise = readSseUntil(
      streamResponse,
      (text) => text.includes('candidates.revealed'),
    );
    await post(server.baseUrl, `/api/deliberations/${deliberationId}/reveal`);
    const streamText = await streamPromise;
    for (const marker of ['transactional rollback', 'Use RPC with retries.', 'mock-web-a']) {
      assert.ok(!streamText.includes(marker), `SSE stream leaked marker: ${marker}`);
    }

    const revealed = await get(server.baseUrl, `/api/deliberations/${deliberationId}`);
    assert.equal(revealed.state, 'challenging');
    assert.equal(revealed.positions.length, 2);
  } finally {
    await server.close();
  }
});

test('API: error mapping returns 400/404/409', async () => {
  const server = await startTestServer();
  try {
    const notFound = await fetch(server.baseUrl + '/api/deliberations/nope');
    assert.equal(notFound.status, 404);
    const notFoundBody = (await notFound.json()) as ApiErrorBody;
    assert.equal(notFoundBody.error.code, 404);

    const badProject = await request(server.baseUrl, 'POST', '/api/projects', {});
    assert.equal(badProject.status, 400);
    const badProjectBody = (await badProject.json()) as ApiErrorBody;
    assert.equal(badProjectBody.error.code, 400);

    const { deliberationId } = await createDeliberationFixture(server.baseUrl, { freeze: false });
    const conflict = await request(server.baseUrl, 'POST', `/api/deliberations/${deliberationId}/start`, {});
    assert.equal(conflict.status, 409);
    const conflictBody = (await conflict.json()) as ApiErrorBody;
    assert.equal(conflictBody.error.code, 409);
  } finally {
    await server.close();
  }
});

test('API: SSE stream delivers protocol events to subscribers', async () => {
  const server = await startTestServer();
  try {
    const streamResponse = await fetch(server.baseUrl + '/api/stream');
    assert.equal(streamResponse.status, 200);
    const streamPromise = readSseUntil(streamResponse, (text) => text.includes('project.created'));
    await post(server.baseUrl, '/api/projects', { name: 'SSE Project' });
    const streamText = await streamPromise;
    assert.ok(streamText.includes('event: event'));
  } finally {
    await server.close();
  }
});

async function readSseUntil(
  response: Response,
  predicate: (text: string) => boolean,
  timeoutMs = 8_000,
): Promise<string> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    if (predicate(buffer)) {
      await reader.cancel();
      return buffer;
    }
  }
  await reader.cancel();
  throw new Error(`SSE timeout; buffer so far: ${buffer.slice(0, 600)}`);
}
