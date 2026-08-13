import { defaultAutonomyEnvelope, tightenEnvelope, type AutonomyEnvelope, type AutonomyEnvelopeOverrides } from '../../src/autonomy/autonomy-envelope.ts';
import { CollaborationNodeSchema, CollaborationPlanSchema, type CollaborationNode, type CollaborationPlan } from '../../src/planning/schemas.ts';
import type { WorkItem } from '../../src/schemas.ts';

export function validEnvelope(overrides: AutonomyEnvelopeOverrides = {}): AutonomyEnvelope {
  return tightenEnvelope(defaultAutonomyEnvelope('ws_test'), overrides);
}

export function validWorkItem(): WorkItem {
  return {
    id: 'wi_test',
    workspaceId: 'ws_test',
    kind: 'bug',
    title: 'Inventory sync drops data intermittently',
    ownerId: 'human',
    status: 'open',
    goal: 'Locate a verifiable root cause and produce a regression plan',
    constraints: ['No production access'],
    expectedOutcomes: ['Root cause', 'Fix plan'],
    sourceRefs: ['src_inventory@v1'],
    templateFields: {},
    currentConclusionRefs: [],
    knowledgeRefs: [],
    relations: [],
    entries: [],
    version: 1,
    createdAt: '2026-08-13T00:00:00.000Z',
    updatedAt: '2026-08-13T00:00:00.000Z',
  };
}

export function makeNode(overrides: Partial<CollaborationNode> = {}): CollaborationNode {
  return CollaborationNodeSchema.parse({
    id: 'repro',
    role: 'Reproducer',
    objective: 'Reproduce the loss and collect logs',
    dependsOn: [],
    inputRefs: ['src_inventory@v1'],
    contextPolicy: { visibility: 'shared', includeObjectTypes: ['source'] },
    capabilityRequirements: ['code-analysis'],
    operator: { type: 'agent_task', instructions: 'Reproduce and collect logs' },
    completionCriteria: [{ id: 'c1', kind: 'artifact', description: 'repro log', refs: ['artifact:repro-log'] }],
    failurePolicy: { maxRetries: 0, onFailure: 'fail_node' },
    allocatedBudget: { maxTimeMs: 120_000 },
    ...overrides,
  });
}

export function validPlan(overrides: Partial<CollaborationPlan> = {}): CollaborationPlan {
  return CollaborationPlanSchema.parse(
    Object.assign(
      {
        id: 'plan_test',
        workItemId: 'wi_test',
        goal: 'Find root cause of intermittent inventory sync data loss',
        rationale: 'Reproduce, then verify root cause with a test',
        nodes: [makeNode()],
        stopConditions: [
          { id: 's1', kind: 'evidence', description: 'root cause verified by test', refs: ['evidence:root-cause'], targetOutcome: 'resolved' },
        ],
        budgetAllocation: { maxTotalTimeMs: 600_000, maxTotalAgents: 4, maxTotalRounds: 3 },
        createdByRunId: 'run_planner',
      },
      overrides,
    ),
  );
}
