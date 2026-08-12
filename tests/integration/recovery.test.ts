import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHarness, setupDeliberation } from '../helpers.ts';
import { JsonFileStore } from '../../src/store.ts';

test('deliberation state and immutable events recover from the JSON store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-recovery-'));
  const storePath = join(dir, 'store.json');
  try {
    const h = createHarness({ store: new JsonFileStore(storePath) });
    const setup = setupDeliberation(h);
    await h.engine.startBlindRun(setup.deliberationId);
    h.engine.finalizeChallenges(setup.deliberationId);
    h.engine.freezeEvidencePack(setup.deliberationId);
    await h.engine.runReview(setup.deliberationId);
    h.engine.humanDecision({
      deliberationId: setup.deliberationId,
      action: 'approve',
      rationale: 'recovery test approval',
      ownerId: 'human-owner',
    });
    assert.equal(h.engine.getState(setup.deliberationId).state, 'decided');

    const h2 = createHarness({ store: new JsonFileStore(storePath) });
    const recovered = h2.engine.getState(setup.deliberationId);
    assert.equal(recovered.state, 'decided');
    assert.equal(recovered.positions.length, 2);
    assert.equal(recovered.decisions.length, 1);
    assert.ok(h2.engine.verifyEventChain());
    const pack = h2.engine.exportDecisionPack(setup.deliberationId);
    assert.deepEqual(pack.traceability.unresolvedRefs, []);
    assert.equal(pack.decision?.humanAction, 'approve');
    assert.ok(h2.engine.getTimeline(setup.deliberationId).length >= 12);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a missing store file starts an empty database', () => {
  const dir = mkdtempSync(join(tmpdir(), 'counterpoint-recovery-'));
  try {
    const h = createHarness({ store: new JsonFileStore(join(dir, 'missing.json')) });
    const project = h.engine.createProject({ name: 'Fresh' });
    assert.equal(project.name, 'Fresh');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
