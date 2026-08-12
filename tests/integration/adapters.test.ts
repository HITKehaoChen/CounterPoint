import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AcpClient } from '../../src/adapters/acp-client.ts';
import { AcpAgentAdapter } from '../../src/adapters/acp-agent.ts';
import { CliAgentAdapter } from '../../src/adapters/cli-agent.ts';
import type { AgentRunInput } from '../../src/adapters/agent.ts';

const fixturesDir = fileURLToPath(new URL('../fixtures/', import.meta.url));

function makeInput(workspacePath: string): AgentRunInput {
  return {
    runId: 'run_adapter_1',
    participantId: 'part_worker_1',
    phase: 'blind_run',
    taskPacket: {
      id: 'tp_1',
      version: 1,
      problem: 'Should we migrate synchronously or via events?',
      goals: ['Choose a testable design'],
      constraints: ['No new infrastructure'],
      rubric: {
        items: [{ id: 'r1', name: 'Correctness', weight: 1 }],
        maxScore: 5,
      },
      sources: ['src_code'],
      frozenAt: '2026-01-01T00:00:00.000Z',
      hash: 'h',
    },
    contextView: {
      id: 'ctx_1',
      runId: 'run_adapter_1',
      phase: 'blind_run',
      visible: {
        authoritySources: ['src_code@v1'],
        artifacts: ['src_code@v1'],
        claims: [],
        evidence: [],
      },
      hidden: { agentRuns: ['run_adapter_2'], objectTypes: ['position_draft'] },
      tools: { allow: ['read_sources'], deny: ['write_shared'] },
      hash: 'ctx-hash',
    },
    authoritySources: [
      {
        ref: 'src_code@v1',
        binding: {
          id: 'src_code',
          type: 'text',
          label: 'codebase',
          version: 1,
          text: 'billing -> ledger',
        },
        content: 'billing -> ledger',
      },
    ],
    visibleArtifacts: [],
    workspacePath,
  };
}

test('AcpClient completes initialize -> session/new -> prompt with a fake ACP server', async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-acp-server.mjs')],
    timeoutMs: 5000,
  });
  try {
    const init = await client.initialize();
    assert.equal(init.protocolVersion, 1);
    assert.equal(init.agentInfo.name, 'fake-acp-agent');
    const sessionId = await client.newSession({ cwd: tmpdir() });
    assert.equal(sessionId, 'sess_fake_001');
    const result = await client.prompt({
      sessionId,
      text: 'analyze',
    });
    assert.equal(result.stopReason, 'end_turn');
    assert.ok(result.text.includes('Fake ACP worker recommends'));
    assert.equal(result.cost, 0.042);
    assert.ok(result.updateCount >= 4);
  } finally {
    client.close();
  }
});

test('AcpAgentAdapter returns a valid Position, Artifacts and Fingerprint', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-acp-'));
  const adapter = new AcpAgentAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-acp-server.mjs')],
    timeoutMs: 5000,
    model: 'fake-model',
  });
  const result = await adapter.run(makeInput(workspace));
  assert.equal(result.position.summary, 'Fake ACP worker recommends synchronous calls with retries.');
  assert.equal(result.position.claims.length, 2);
  assert.equal(result.artifacts[0].logicalName, 'acp-design');
  assert.equal(result.fingerprint.adapter, 'acp-agent');
  assert.equal(result.fingerprint.model, 'fake-model');
  assert.equal(result.fingerprint.contextViewHash, 'ctx-hash');
  assert.equal(result.cost, 0.042);
  assert.ok(result.logs?.includes('stopReason=end_turn'));
});

test('AcpClient cancellation returns stopReason cancelled', async () => {
  const client = new AcpClient({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-acp-server.mjs')],
    timeoutMs: 5000,
    env: { FAKE_ACP_DELAY_MS: '300' },
  });
  try {
    await client.initialize();
    const sessionId = await client.newSession({ cwd: tmpdir() });
    const promptPromise = client.prompt({ sessionId, text: 'work' });
    await new Promise((resolve) => setTimeout(resolve, 80));
    client.cancel(sessionId);
    const result = await promptPromise;
    assert.equal(result.stopReason, 'cancelled');
  } finally {
    client.close();
  }
});

test('CliAgentAdapter parses fenced JSON from stdout', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-cli-'));
  const adapter = new CliAgentAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-cli-json.mjs'), '{promptFile}'],
    outputMode: 'json_stdout',
    timeoutMs: 5000,
  });
  const result = await adapter.run(makeInput(workspace));
  assert.equal(result.position.summary, 'Fake CLI worker chooses the strangler pattern.');
  assert.equal(result.artifacts[0].logicalName, 'cli-design');
  assert.equal(result.fingerprint.adapter, 'cli-agent');
});

test('CliAgentAdapter reads agent-output.json from the workspace', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-cli-'));
  const adapter = new CliAgentAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-cli-file.mjs'), '{workspace}'],
    outputMode: 'json_file',
    timeoutMs: 5000,
  });
  const result = await adapter.run(makeInput(workspace));
  assert.equal(result.position.summary, 'Fake file worker recommends synchronous integration.');
  assert.equal(result.position.claims.length, 1);
});

test('CliAgentAdapter parses codex exec --json JSONL events', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-cli-'));
  const adapter = new CliAgentAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-codex-jsonl.mjs'), '{promptFile}'],
    outputMode: 'codex_jsonl',
    timeoutMs: 5000,
  });
  const result = await adapter.run(makeInput(workspace));
  assert.equal(result.position.summary, 'Fake codex worker recommends events with an outbox.');
});

test('CliAgentAdapter parses claude --output-format json JSONL events', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-cli-'));
  const adapter = new CliAgentAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-claude-jsonl.mjs'), '{promptFile}'],
    outputMode: 'claude_jsonl',
    timeoutMs: 5000,
  });
  const result = await adapter.run(makeInput(workspace));
  assert.equal(result.position.summary, 'Fake claude worker recommends a phased migration.');
});

test('CliAgentAdapter fails on non-zero exit', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-cli-'));
  const adapter = new CliAgentAdapter({
    command: process.execPath,
    args: ['-e', 'process.exit(3)'],
    timeoutMs: 5000,
  });
  await assert.rejects(adapter.run(makeInput(workspace)), /exited with code 3/);
});

test('CliAgentAdapter times out and rejects', async () => {
  const workspace = mkdtempSync(join(tmpdir(), 'counterpoint-cli-'));
  const adapter = new CliAgentAdapter({
    command: process.execPath,
    args: [join(fixturesDir, 'fake-slow.mjs')],
    timeoutMs: 100,
  });
  await assert.rejects(adapter.run(makeInput(workspace)));
});
