import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  PositionDraftSchema,
  EvidenceSchema,
  TaskPacketSchema,
  ContextViewSchema,
  emptyDatabase,
  DatabaseSchema,
} from '../../src/schemas.ts';

test('Position minimal contract is accepted', () => {
  const position = {
    summary: 'Use event-driven architecture',
    claims: [
      {
        id: 'claim-1',
        statement: 'Write path must tolerate downstream failure',
        type: 'fact',
        evidenceRefs: ['evid-1'],
        confidence: 0.78,
      },
    ],
    unknowns: ['Peak traffic unknown'],
    artifactRefs: ['design@v1'],
    decisionConditions: ['Revisit if strong consistency is required'],
    confidence: 0.7,
  };
  const parsed = PositionDraftSchema.parse(position);
  assert.equal(parsed.summary, position.summary);
  assert.equal(parsed.claims.length, 1);
});

test('Position rejects empty summary or missing claims', () => {
  assert.throws(() =>
    PositionDraftSchema.parse({
      summary: '',
      claims: [],
      confidence: 0.5,
    }),
  );
});

test('Evidence minimal contract is accepted', () => {
  const evidence = {
    id: 'evid-1',
    deliberationId: 'delib-1',
    kind: 'command_result',
    source: { command: 'node', args: ['test.js'], environmentRef: 'repo@v3' },
    targetRefs: ['claim:claim-1'],
    result: { exitCode: 0, stdoutHash: 'sha256:abc' },
    status: 'verified',
    reproducibility: 'reproducible',
    hash: 'h',
    createdAt: '2026-01-01T00:00:00.000Z',
  };
  const parsed = EvidenceSchema.parse(evidence);
  assert.equal(parsed.status, 'verified');
});

test('TaskPacket requires problem, goals, constraints, rubric and sources', () => {
  assert.throws(() =>
    TaskPacketSchema.parse({
      id: 'tp-1',
      version: 1,
      problem: '',
      goals: [],
      constraints: [],
      rubric: { items: [] },
      sources: [],
    }),
  );
});

test('ContextView requires a hash and explicit tool policy', () => {
  const view = {
    id: 'ctx-1',
    runId: 'run-1',
    phase: 'blind_run',
    visible: { authoritySources: ['src@v1'], artifacts: [], claims: [], evidence: [] },
    hidden: { agentRuns: ['run-2'], objectTypes: ['position_draft'] },
    tools: { allow: ['read_sources'], deny: ['write_shared'] },
    hash: 'abc',
  };
  assert.ok(ContextViewSchema.parse(view));
  assert.throws(() => ContextViewSchema.parse({ ...view, hash: '' }));
});

test('empty database validates', () => {
  const db = emptyDatabase();
  assert.ok(DatabaseSchema.parse(db));
});
