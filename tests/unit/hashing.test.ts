import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalStringify,
  formatVersionRef,
  hashJson,
  parseVersionRef,
  sha256,
} from '../../src/hashing.ts';

test('sha256 matches the standard vector for "abc"', () => {
  assert.equal(
    sha256('abc'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
});

test('canonicalStringify sorts object keys so hashing is stable', () => {
  const a = canonicalStringify({ b: 1, a: [3, 2] });
  const b = canonicalStringify({ a: [3, 2], b: 1 });
  assert.equal(a, b);
  assert.equal(a, '{"a":[3,2],"b":1}');
});

test('hashJson is content-addressable and order-independent', () => {
  assert.equal(hashJson({ x: 1, y: 2 }), hashJson({ y: 2, x: 1 }));
  assert.notEqual(hashJson({ x: 1 }), hashJson({ x: 2 }));
});

test('version refs parse and format', () => {
  assert.deepEqual(parseVersionRef('design@v3'), { name: 'design', version: 3 });
  assert.equal(parseVersionRef('design@v0'), undefined);
  assert.equal(parseVersionRef('Design@v1'), undefined);
  assert.equal(parseVersionRef('design'), undefined);
  assert.equal(formatVersionRef('design', 2), 'design@v2');
});
