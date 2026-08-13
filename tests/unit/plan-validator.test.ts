import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validatePlan } from '../../src/planning/plan-validator.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validEnvelope, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';

const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
  { capability: 'verification', adapterKind: 'mock', tools: ['node', 'npm'] },
  { capability: 'independent-review', adapterKind: 'mock', tools: ['read_candidates'] },
]);

test('a structurally valid plan is accepted', () => {
  const result = validatePlan({ plan: validPlan(), envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.issues.length, 0);
});

test('duplicate node ids are rejected', () => {
  const plan = validPlan({ nodes: [makeNode(), makeNode()] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'DUPLICATE_NODE_ID'));
});

test('unknown dependencies are rejected', () => {
  const plan = validPlan({ nodes: [makeNode({ dependsOn: ['missing'] })] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'UNKNOWN_DEPENDENCY'));
});

test('cycles are rejected', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', dependsOn: ['b'] }),
      makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'agent_task', instructions: 'check' } }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'CYCLE'));
});

test('unknown capability is rejected', () => {
  const plan = validPlan({ nodes: [makeNode({ capabilityRequirements: ['telepathy'] })] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'rejected');
  assert.ok(result.issues.some((issue) => issue.code === 'UNKNOWN_CAPABILITY'));
});
