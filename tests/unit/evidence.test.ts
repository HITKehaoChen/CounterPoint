import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceLedger } from '../../src/verifier.ts';
import { emptyDatabase, type Deliberation } from '../../src/schemas.ts';

function makeDeliberation(): Deliberation {
  return {
    id: 'delib-1',
    projectId: 'prj-1',
    protocolVersion: '0.1.0',
    state: 'verifying',
    ownerId: 'human-1',
    participants: [],
    runs: [],
    positions: [],
    challenges: [],
    responses: [],
    evidenceRequests: [],
    evidence: [],
    reviews: [],
    decisions: [],
    rounds: { challenge: 0, evidence: 0 },
    createdAt: 't',
    updatedAt: 't',
    timeoutPolicy: { defaultMs: 1000, maxEvidenceRounds: 1 },
  };
}

test('command verifier records exit code, stdout hash and verified status', async () => {
  const db = emptyDatabase();
  const deliberation = makeDeliberation();
  const ledger = new EvidenceLedger(deliberation, db, {
    allowlist: ['node'],
    timeoutMs: 10_000,
    environmentRef: 'test-env',
  });
  const evidence = await ledger.runCommandVerifier({
    command: 'node',
    args: ['-e', 'console.log("ok")'],
    targetRefs: ['claim:claim-1'],
  });
  assert.equal(evidence.status, 'verified');
  assert.equal(evidence.result.exitCode, 0);
  assert.ok(evidence.result.stdoutHash);
  assert.equal(evidence.source.environmentRef, 'test-env');
  assert.equal(deliberation.evidence.length, 1);
});

test('command verifier marks non-zero exits as failed', async () => {
  const db = emptyDatabase();
  const deliberation = makeDeliberation();
  const ledger = new EvidenceLedger(deliberation, db, { allowlist: ['node'], timeoutMs: 10_000 });
  const evidence = await ledger.runCommandVerifier({
    command: 'node',
    args: ['-e', 'process.exit(3)'],
    targetRefs: ['claim:claim-2'],
  });
  assert.equal(evidence.status, 'failed');
  assert.equal(evidence.result.exitCode, 3);
});

test('allowlist rejects unlisted commands', async () => {
  const db = emptyDatabase();
  const deliberation = makeDeliberation();
  const ledger = new EvidenceLedger(deliberation, db, { allowlist: ['node'], timeoutMs: 1000 });
  await assert.rejects(
    ledger.runCommandVerifier({
      command: 'rm',
      args: ['-rf', '/tmp/x'],
      targetRefs: ['claim:claim-3'],
    }),
    /not in the verifier allowlist/,
  );
});

test('manual evidence binds claims and stays append-only', () => {
  const db = emptyDatabase();
  const deliberation = makeDeliberation();
  const ledger = new EvidenceLedger(deliberation, db, { allowlist: ['node'], timeoutMs: 1000 });
  const evidence = ledger.addManualEvidence({
    description: 'Owner confirmed SLA',
    targetRefs: ['claim:claim-4'],
    source: 'human-owner',
  });
  assert.equal(evidence.status, 'verified');
  assert.equal(deliberation.evidence[0].result.summary, 'Owner confirmed SLA');
  const superseded = ledger.supersede(evidence.id, 'replaced by measurement');
  assert.equal(superseded.status, 'superseded');
  assert.ok(superseded.result.summary?.includes('replaced by measurement'));
});
