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

test('tool outside the envelope allowlist requires human approval', () => {
  const plan = validPlan({
    nodes: [makeNode({ operator: { type: 'tool_task', command: 'curl', args: [] }, capabilityRequirements: ['verification'] })],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'PERMISSION_TOOL'));
});

test('write scope outside the envelope requires human approval', () => {
  const plan = validPlan({
    nodes: [makeNode({ contextPolicy: { visibility: 'shared', writeScopes: ['/prod'], readScopes: [], includeObjectTypes: [], excludeObjectTypes: [] } })],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'PERMISSION_WRITE_SCOPE'));
});

test('budget allocation above the envelope requires human approval', () => {
  const plan = validPlan({ budgetAllocation: { maxTotalTimeMs: 99_999_999, maxTotalAgents: 4, maxTotalRounds: 3 } });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'BUDGET_OVER_ENVELOPE'));
});

test('parallelism beyond the envelope requires human approval', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a' }),
      makeNode({ id: 'b' }),
      makeNode({ id: 'c' }),
      makeNode({ id: 'd', dependsOn: ['a', 'b', 'c'], operator: { type: 'verification', command: 'node', args: ['--version'], targetRefs: [] } }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'BUDGET_PARALLELISM'));
});

test('retries beyond rounds require human approval', () => {
  const envelope = validEnvelope({ maxRounds: 2 });
  const plan = validPlan({
    budgetAllocation: { maxTotalTimeMs: 600_000, maxTotalAgents: 4, maxTotalRounds: 2 },
    nodes: [makeNode({ failurePolicy: { maxRetries: 3, onFailure: 'fail_node' } })],
  });
  const result = validatePlan({ plan, envelope, workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_human_approval');
  assert.ok(result.issues.some((issue) => issue.code === 'BUDGET_RETRY_OVER_ROUNDS'));
});
