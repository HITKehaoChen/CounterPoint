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

test('orchestrator records per-attempt cost details', async () => {
  let calls = 0;
  const planner: Planner = {
    name: 'costed-planner',
    async plan(): Promise<PlannerResult> {
      calls += 1;
      if (calls === 1) {
        return {
          plan: validPlan({ nodes: [badNode()] }),
          meta: { costUsd: 0.25, model: 'm1', usage: { inputTokens: 100, outputTokens: 50 } },
        };
      }
      return { plan: validPlan(), meta: { costUsd: 0.35, model: 'm2' } };
    },
  };
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 2 });
  const proposal = await orchestrator.propose(baseInput());
  assert.deepEqual(proposal.attemptsDetail.map((item) => item.costUsd), [0.25, 0.35]);
  assert.equal(proposal.attemptsDetail[0].inputTokens, 100);
  assert.equal(proposal.attemptsDetail[0].model, 'm1');
  assert.equal(proposal.totalCostUsd, 0.6);
});

test('parse-error attempts keep their cost in attemptsDetail', async () => {
  let calls = 0;
  const planner: Planner = {
    name: 'parse-costed-planner',
    async plan(): Promise<PlannerResult> {
      calls += 1;
      if (calls === 1) {
        throw new PlannerParseError(
          [{ code: 'invalid_enum_value', path: 'nodes.0.contextPolicy.visibility', message: 'invalid' }],
          { costUsd: 0.1, model: 'm1', usage: { inputTokens: 20, outputTokens: 5 } },
        );
      }
      return { plan: validPlan(), meta: { costUsd: 0.2, model: 'm2' } };
    },
  };
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan, maxRepairAttempts: 2 });
  const proposal = await orchestrator.propose(baseInput());
  assert.equal(proposal.result.verdict, 'accepted');
  assert.deepEqual(
    proposal.attemptsDetail.map((item) => ({ attempt: item.attempt, costUsd: item.costUsd, outcome: item.outcome })),
    [
      { attempt: 1, costUsd: 0.1, outcome: 'parse_error' },
      { attempt: 2, costUsd: 0.2, outcome: 'parsed' },
    ],
  );
  assert.equal(proposal.attemptsDetail[0].inputTokens, 20);
  assert.ok(Math.abs(proposal.totalCostUsd - 0.3) < 1e-9);
});

test('runtime errors carry attemptsDetail on the thrown error', async () => {
  const planner: Planner = {
    name: 'boom-planner',
    async plan(): Promise<PlannerResult> {
      throw new Error('boom');
    },
  };
  const orchestrator = new PlannerOrchestrator({ planner, validator: validatePlan });
  await assert.rejects(
    () => orchestrator.propose(baseInput()),
    (error: unknown) => {
      assert.deepEqual((error as { attemptsDetail?: unknown[] }).attemptsDetail, [
        { attempt: 1, costUsd: 0, outcome: 'runtime_error' },
      ]);
      return true;
    },
  );
});

function badNode() {
  return makeNode({
    completionCriteria: [{ id: 'c1', kind: 'evidence', description: 'needs evidence', refs: [] }],
  });
}
