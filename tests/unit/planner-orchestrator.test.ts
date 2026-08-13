import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockPlanner, PlannerOrchestrator, PlannerParseError, type Planner, type PlannerInput, type PlannerResult } from '../../src/planning/planner.ts';
import { validatePlan } from '../../src/planning/plan-validator.ts';
import { catalogFromEntries } from '../../src/planning/capabilities.ts';
import { makeNode, validEnvelope, validPlan, validWorkItem } from '../helpers/plan-fixtures.ts';

const catalog = catalogFromEntries([
  { capability: 'code-analysis', adapterKind: 'mock', tools: ['read_sources'] },
]);

function baseInput(): PlannerInput {
  return {
    workItem: validWorkItem(),
    envelope: validEnvelope(),
    catalog,
    sources: [{ id: 'src_inventory', label: 'inventory', excerpt: 'sync adapter', versionRef: 'src_inventory@v1' }],
    reusableEvidence: [],
  };
}

test('orchestrator returns an accepted plan on the first attempt', async () => {
  const planner = new MockPlanner(() => validPlan());
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'accepted');
  assert.equal(proposal.attempts, 1);
  assert.equal(proposal.repairHistory.length, 0);
});

test('orchestrator feeds validator issues back and repairs within the limit', async () => {
  let calls = 0;
  const planner = new MockPlanner((input) => {
    calls += 1;
    if (calls === 1) return validPlan({ nodes: [badNode()] });
    assert.ok(input.repairContext?.issues.length);
    return validPlan();
  });
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 2 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'accepted');
  assert.equal(proposal.attempts, 2);
  assert.equal(proposal.repairHistory.length, 1);
});

test('orchestrator stops at the repair limit', async () => {
  const planner = new MockPlanner(() => validPlan({ nodes: [badNode()] }));
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 1 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'needs_revision');
  assert.equal(proposal.attempts, 2);
});

test('orchestrator repairs a schema parse failure', async () => {
  let calls = 0;
  const planner: Planner = {
    name: 'parse-fix-planner',
    async plan(input: PlannerInput): Promise<PlannerResult> {
      calls += 1;
      if (calls === 1) throw new PlannerParseError([{ code: 'invalid_enum_value', path: 'nodes.0.contextPolicy.visibility', message: 'invalid' }]);
      assert.ok(input.repairContext?.issues.length);
      return { plan: validPlan(), meta: {} };
    },
  };
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 2 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'accepted');
  assert.equal(proposal.attempts, 2);
  assert.equal(proposal.repairHistory.length, 1);
});

test('orchestrator rejects after repeated schema parse failures', async () => {
  const planner: Planner = {
    name: 'parse-fail-planner',
    async plan(): Promise<PlannerResult> {
      throw new PlannerParseError([{ code: 'invalid_type', path: 'goal', message: 'Required' }]);
    },
  };
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 1 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'rejected');
  assert.equal(proposal.attempts, 2);
  assert.equal(proposal.repairHistory.length, 2);
});

function badNode() {
  return makeNode({
    completionCriteria: [{ id: 'c1', kind: 'evidence', description: 'needs evidence', refs: [] }],
  });
}
