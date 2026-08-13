import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CollaborationPlanSchema,
  CounterpointDeliberationSpecSchema,
  OperatorSpecSchema,
} from '../../src/planning/schemas.ts';

test('a valid plan with a deliberation node parses', () => {
  const plan = CollaborationPlanSchema.parse({
    id: 'plan_1',
    workItemId: 'wi_1',
    goal: 'Choose transport',
    rationale: 'ambiguous high-stakes decision',
    nodes: [
      {
        id: 'delib',
        role: 'Deliberation',
        objective: 'Blind independent analysis',
        contextPolicy: { visibility: 'blind' },
        operator: {
          type: 'counterpoint_deliberation',
          workerCount: 2,
          blind: true,
          commitReveal: true,
          challengeRounds: 1,
          verificationPolicy: { commands: [{ command: 'node', args: ['--version'], targetKinds: ['claims'] }] },
          reviewerPolicy: 'anonymous-rubric',
        },
        completionCriteria: [{ id: 'c1', kind: 'human_acceptance', description: 'human approves ADR' }],
        failurePolicy: { maxRetries: 0, onFailure: 'escalate' },
        allocatedBudget: { maxTimeMs: 600_000 },
      },
    ],
    stopConditions: [{ id: 's1', kind: 'human_acceptance', description: 'ADR approved', targetOutcome: 'resolved' }],
    budgetAllocation: { maxTotalTimeMs: 900_000, maxTotalAgents: 3, maxTotalRounds: 2 },
    createdByRunId: 'run_planner',
  });
  assert.equal(plan.nodes[0].operator.type, 'counterpoint_deliberation');
  assert.equal(plan.status, 'proposed');
});

test('operator union rejects an unknown operator type', () => {
  assert.equal(OperatorSpecSchema.safeParse({ type: 'group_chat' }).success, false);
});

test('deliberation operator enforces blind commit-reveal constants', () => {
  const parsed = CounterpointDeliberationSpecSchema.parse({
    type: 'counterpoint_deliberation',
    workerCount: 3,
    blind: true,
    commitReveal: true,
    challengeRounds: 2,
    verificationPolicy: { commands: [{ command: 'node', args: ['--version'] }] },
    reviewerPolicy: 'rubric',
  });
  assert.equal(parsed.workerCount, 3);
  assert.equal(CounterpointDeliberationSpecSchema.safeParse({ ...parsed, blind: false }).success, false);
});
