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

test('duplicate node ids need revision', () => {
  const plan = validPlan({ nodes: [makeNode(), makeNode()] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'DUPLICATE_NODE_ID'));
});

test('unknown dependencies need revision', () => {
  const plan = validPlan({ nodes: [makeNode({ dependsOn: ['missing'] })] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'UNKNOWN_DEPENDENCY'));
});

test('cycles need revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'a', dependsOn: ['b'] }),
      makeNode({ id: 'b', dependsOn: ['a'], operator: { type: 'agent_task', instructions: 'check' } }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'CYCLE'));
});

test('unknown capability needs revision', () => {
  const plan = validPlan({ nodes: [makeNode({ capabilityRequirements: ['telepathy'] })] });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
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

test('private object referenced by another node needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'secret', contextPolicy: { visibility: 'private', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] } }),
      makeNode({ id: 'consumer', dependsOn: ['secret'], inputRefs: ['secret:notes'] }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'CONTEXT_PRIVATE_REF'));
});

test('two blind nodes sharing input need revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'blind-a', contextPolicy: { visibility: 'blind', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] }, inputRefs: ['src_inventory@v1'] }),
      makeNode({ id: 'blind-b', contextPolicy: { visibility: 'blind', readScopes: [], writeScopes: [], includeObjectTypes: [], excludeObjectTypes: [] }, inputRefs: ['src_inventory@v1'] }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'CONTEXT_BLIND_SHARED_INPUT'));
});

test('reviewer sharing capabilities with its target needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'candidate', capabilityRequirements: ['code-analysis'] }),
      makeNode({
        id: 'review',
        dependsOn: ['candidate'],
        capabilityRequirements: ['code-analysis'],
        operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['candidate'] },
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'INDEPENDENCE_CAPABILITY_OVERLAP'));
});

test('lineage conflict between reviewer and target is caught', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'candidate', capabilityRequirements: ['code-analysis'] }),
      makeNode({
        id: 'review',
        dependsOn: ['candidate'],
        capabilityRequirements: ['independent-review'],
        operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['candidate'] },
      }),
    ],
  });
  const result = validatePlan({
    plan,
    envelope: validEnvelope(),
    workItem: validWorkItem(),
    catalog,
    lineage: {
      review: { authorRunIds: [], fingerprints: ['adapter-cli/model-a'], contextViewHashes: [] },
      candidate: { authorRunIds: [], fingerprints: ['adapter-cli/model-a'], contextViewHashes: [] },
    },
  });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'INDEPENDENCE_LINEAGE_CONFLICT'));
});

test('evidence completion without refs needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        completionCriteria: [{ id: 'c1', kind: 'evidence', description: 'verified root cause', refs: [] }],
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'EVIDENCE_CRITERION_NO_REF'));
});

test('high risk action without a human gate node needs revision', () => {
  const plan = validPlan({
    nodes: [makeNode({ operator: { type: 'tool_task', command: 'git', args: ['push'] }, capabilityRequirements: ['verification'] })],
  });
  const envelope = validEnvelope({ riskPolicy: { requireHumanGateFor: ['git push'], highRiskActions: [], requireReviewFor: [] } });
  const result = validatePlan({ plan, envelope, workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'GATE_REQUIRED_MISSING'));
});

test('sink independent review node is a valid decision producer', () => {
  const plan = validPlan({
    nodes: [
      makeNode({ id: 'candidate' }),
      makeNode({
        id: 'review',
        dependsOn: ['candidate'],
        capabilityRequirements: ['independent-review'],
        operator: { type: 'independent_review', rubricRef: 'rubric:1', targetNodeIds: ['candidate'] },
        completionCriteria: [{ id: 'c1', kind: 'claim_supported', description: 'review decision', refs: [] }],
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'accepted');
  assert.equal(result.issues.some((issue) => issue.code === 'SINK_WITHOUT_OUTPUT'), false);
});

test('non-idempotent command requires a human gate node', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        operator: { type: 'tool_task', command: 'git', args: ['push'], effectClass: 'non_idempotent' },
        capabilityRequirements: ['verification'],
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'GATE_REQUIRED_FOR_NON_IDEMPOTENT'));
});

test('non-idempotent command with a gate node is accepted', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        operator: { type: 'tool_task', command: 'git', args: ['push'], effectClass: 'non_idempotent' },
        capabilityRequirements: ['verification'],
      }),
      makeNode({
        id: 'gate',
        dependsOn: ['repro'],
        operator: { type: 'human_gate', summary: 'approve push', options: ['approve_once', 'reject_and_stop'] },
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'accepted');
});

test('missing effectClass on a command node needs revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        operator: { type: 'tool_task', command: 'git', args: ['status'] },
        capabilityRequirements: ['verification'],
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'EFFECT_CLASS_REQUIRED'));
});

test('unsupported deliberation options need revision', () => {
  const plan = validPlan({
    nodes: [
      makeNode({
        operator: {
          type: 'counterpoint_deliberation',
          workerCount: 2,
          blind: true,
          commitReveal: true,
          challengeRounds: 1,
          verificationPolicy: { commands: [{ command: 'node', args: ['--version'], targetKinds: ['claims'] }] },
          reviewerPolicy: 'mock',
        },
      }),
    ],
  });
  const result = validatePlan({ plan, envelope: validEnvelope(), workItem: validWorkItem(), catalog });
  assert.equal(result.verdict, 'needs_revision');
  assert.ok(result.issues.some((issue) => issue.code === 'DELIBERATION_UNSUPPORTED_CHALLENGE_ROUNDS'));
  assert.ok(result.issues.some((issue) => issue.code === 'DELIBERATION_UNSUPPORTED_REVIEWER_POLICY'));
});
