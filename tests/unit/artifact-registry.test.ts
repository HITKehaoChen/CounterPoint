import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactRegistry } from '../../src/artifact-registry.ts';
import { emptyDatabase } from '../../src/schemas.ts';

test('publish creates versioned, content-addressed artifacts', () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  const v1 = registry.publish({ logicalName: 'design', type: 'markdown', content: 'one' });
  const v2 = registry.publish({ logicalName: 'design', type: 'markdown', content: 'two' });
  assert.equal(v1.ref, 'design@v1');
  assert.equal(v2.ref, 'design@v2');
  assert.notEqual(v1.version.contentHash, v2.version.contentHash);
  assert.equal(registry.getVersion('design@v1')?.content, 'one');
  assert.equal(registry.getVersion('design@v2')?.content, 'two');
});

test('version references do not drift', () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  registry.publish({ logicalName: 'design', type: 'markdown', content: 'v1' });
  registry.publish({ logicalName: 'design', type: 'markdown', content: 'v2' });
  assert.equal(registry.getVersion('design@v1')?.content, 'v1');
  assert.equal(registry.latestVersion('design')?.ref, 'design@v2');
});

test('publishing again never overwrites a version (FR-033)', () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  const v1 = registry.publish({ logicalName: 'design', type: 'markdown', content: 'original' });
  const v2 = registry.publish({ logicalName: 'design', type: 'markdown', content: 'updated' });
  assert.equal(registry.getVersion(v1.ref)?.content, 'original');
  assert.equal(registry.getVersion(v2.ref)?.content, 'updated');
  assert.equal(registry.list()[0].versionCount, 2);
});

test('diff reports text changes and binary metadata', () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  registry.publish({ logicalName: 'doc', type: 'text', content: 'a\nb\nc\n' });
  registry.publish({ logicalName: 'doc', type: 'text', content: 'a\nX\nc\n' });
  const diff = registry.diff('doc@v1', 'doc@v2');
  assert.equal(diff.kind, 'text');
  assert.equal(diff.added, 1);
  assert.equal(diff.removed, 1);
  const same = registry.diff('doc@v1', 'doc@v1');
  assert.equal(same.kind, 'none');
});

test('invalid logical names and unknown refs are rejected', () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  assert.throws(() => registry.publish({ logicalName: 'Bad Name', type: 'text', content: 'x' }));
  assert.equal(registry.getVersion('missing@v1'), undefined);
  assert.throws(() => registry.diff('missing@v1', 'missing@v2'));
});

test('dependencies resolve into an ordered chain', () => {
  const db = emptyDatabase();
  const registry = new ArtifactRegistry(db);
  registry.publish({ logicalName: 'base', type: 'text', content: 'base' });
  registry.publish({
    logicalName: 'derived',
    type: 'text',
    content: 'derived',
    dependencies: ['base@v1'],
  });
  assert.deepEqual(registry.resolveDependencyChain('derived@v1'), ['derived@v1', 'base@v1']);
});
