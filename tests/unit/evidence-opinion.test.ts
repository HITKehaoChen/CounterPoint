import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceSchema, OpinionSchema } from '../../src/schemas.ts';

test('evidence accepts a scope with applicability conditions', () => {
  const evidence = EvidenceSchema.parse({
    id: 'evid_1',
    deliberationId: 'delib_1',
    kind: 'command_result',
    source: { command: 'node', args: ['-e', '1'] },
    targetRefs: ['claim:1'],
    result: { exitCode: 0 },
    status: 'verified',
    hash: 'h',
    createdAt: '2026-08-13T00:00:00.000Z',
    scope: {
      sourceVersionRefs: ['src_inventory@v1'],
      appliesWhen: ['sync adapter version 2.x'],
      invalidatedWhen: ['schema migration v3'],
      expiresAt: '2026-12-31T00:00:00.000Z',
    },
  });
  assert.equal(evidence.scope?.expiresAt, '2026-12-31T00:00:00.000Z');
});

test('opinion is a separate object from claim', () => {
  const parsed = OpinionSchema.parse({
    id: 'op_1',
    workItemId: 'wi_1',
    statement: 'Synchronous calls are preferable here',
    rationale: 'Simpler rollback within one transaction',
    authorRunId: 'run_1',
    author: 'worker-a',
    createdAt: '2026-08-13T00:00:00.000Z',
    kind: 'claim',
  });
  assert.equal(parsed.statement.startsWith('Synchronous'), true);
  assert.equal('kind' in parsed, false);
});
