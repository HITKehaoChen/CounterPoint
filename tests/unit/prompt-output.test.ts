import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderAgentPrompt } from '../../src/adapters/prompt.ts';
import {
  extractJsonPayload,
  parseAgentResultJson,
  parseAgentResultText,
} from '../../src/adapters/output.ts';
import type { AgentRunInput } from '../../src/adapters/agent.ts';

function makeInput(): AgentRunInput {
  return {
    runId: 'run_1',
    participantId: 'part_1',
    phase: 'blind_run',
    taskPacket: {
      id: 'tp_1',
      version: 1,
      problem: 'Sync or events?',
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
      runId: 'run_1',
      phase: 'blind_run',
      visible: {
        authoritySources: ['src_code@v1'],
        artifacts: ['src_code@v1'],
        claims: [],
        evidence: [],
      },
      hidden: { agentRuns: ['run_2'], objectTypes: ['position_draft'] },
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
    workspacePath: '/tmp/ws',
  };
}

test('renderAgentPrompt includes the task, blind isolation and output contract', () => {
  const prompt = renderAgentPrompt(makeInput());
  assert.ok(prompt.includes('Sync or events?'));
  assert.ok(prompt.includes('BLIND isolation'));
  assert.ok(prompt.includes('"position"'));
  assert.ok(prompt.includes('claim-1'));
  assert.ok(prompt.includes('src_code@v1'));
});

test('extractJsonPayload handles fenced JSON', () => {
  const payload = extractJsonPayload('Here you go:\n```json\n{"a": 1}\n```\n');
  assert.deepEqual(payload, { a: 1 });
});

test('extractJsonPayload handles pure and embedded JSON', () => {
  assert.deepEqual(extractJsonPayload('{"a": 1}'), { a: 1 });
  assert.deepEqual(extractJsonPayload('prefix {"a": {"b": 2}} suffix'), { a: { b: 2 } });
});

test('extractJsonPayload throws when no balanced JSON exists', () => {
  assert.throws(() => extractJsonPayload('no json here'));
  assert.throws(() => extractJsonPayload('{"a": 1'));
});

test('parseAgentResultText validates the submission contract', () => {
  const text = '```json\n{"position":{"summary":"s","claims":[{"id":"c1","statement":"st","type":"fact","evidenceRefs":[]}],"unknowns":[],"artifactRefs":[],"decisionConditions":[],"confidence":0.5},"artifacts":[]}\n```';
  const parsed = parseAgentResultText(text);
  assert.equal(parsed.position.summary, 's');
  assert.equal(parsed.artifacts.length, 0);
});

test('parseAgentResultJson rejects submissions without position', () => {
  assert.throws(() => parseAgentResultJson({ artifacts: [] }), /missing "position"/);
  assert.throws(() => parseAgentResultJson('nope'), /must be an object/);
});
