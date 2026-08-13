import type { AutonomyEnvelopeOverrides } from '../../src/autonomy/autonomy-envelope.ts';
import type { CollaborationPlan } from '../../src/planning/schemas.ts';
import type { SourceSummary } from '../../src/planning/planner.ts';

export interface ProbeFixture {
  id: 'simple-bug' | 'complex-bug';
  label: string;
  expectedTopology: 'single-agent' | 'multi-node';
  workItem: {
    kind: 'bug';
    title: string;
    goal: string;
    constraints: string[];
    expectedOutcomes: string[];
    sourceRefs: string[];
  };
  envelopeOverrides: AutonomyEnvelopeOverrides;
  sources: SourceSummary[];
}

export const PROBE_FIXTURES: ProbeFixture[] = [
  {
    id: 'simple-bug',
    label: 'Simple engineering question',
    expectedTopology: 'single-agent',
    workItem: {
      kind: 'bug',
      title: 'Typo breaks the health endpoint',
      goal: 'Find the exact failing expression and confirm it with a test',
      constraints: ['Read-only repository access'],
      expectedOutcomes: ['A verifiable fix'],
      sourceRefs: ['src_api@v1'],
    },
    envelopeOverrides: { maxAgents: 2, maxParallelism: 1, timeBudgetMs: 10 * 60_000 },
    sources: [{ id: 'src_api', label: 'api server', excerpt: 'health handler', versionRef: 'src_api@v1' }],
  },
  {
    id: 'complex-bug',
    label: 'Complex intermittent data-loss bug',
    expectedTopology: 'multi-node',
    workItem: {
      kind: 'bug',
      title: 'Inventory sync intermittently drops data',
      goal: 'Locate a verifiable root cause and produce a fix plus regression plan',
      constraints: ['Read the repo and run tests; no production access'],
      expectedOutcomes: ['Root cause', 'Fix candidate', 'Regression evidence'],
      sourceRefs: ['src_inventory@v1', 'src_tests@v1'],
    },
    envelopeOverrides: {},
    sources: [
      { id: 'src_inventory', label: 'inventory sync adapter', excerpt: 'retry window logic', versionRef: 'src_inventory@v1' },
      { id: 'src_tests', label: 'sync tests', excerpt: 'idempotency tests', versionRef: 'src_tests@v1' },
    ],
  },
];

export function topologySignature(plan: CollaborationPlan): string {
  const signature = plan.nodes
    .map((node) => ({
      id: node.id,
      role: node.role,
      operator: node.operator.type,
      dependsOn: [...node.dependsOn].sort(),
      visibility: node.contextPolicy.visibility,
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
  return JSON.stringify(signature);
}
