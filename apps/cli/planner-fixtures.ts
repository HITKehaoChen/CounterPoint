import type { AutonomyEnvelopeOverrides } from '../../src/autonomy/autonomy-envelope.ts';
import type { CollaborationPlan } from '../../src/planning/schemas.ts';
import type { SourceSummary } from '../../src/planning/planner.ts';

export interface ProbeFixture {
  id: 'simple-bug' | 'complex-bug';
  label: string;
  topology: TopologyRequirement;
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
    topology: {
      agentTaskCount: { kind: 'eq', value: 1 },
      verificationGte: 1,
      parallelWidth: { kind: 'eq', value: 1 },
      hasIndependentReview: false,
      hasDeliberation: false,
      hasConvergingNode: false,
    },
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
    topology: {
      agentTaskCount: { kind: 'gte', value: 1 },
      verificationGte: 1,
      parallelWidth: { kind: 'gte', value: 2 },
      hasIndependentReview: true,
      hasDeliberation: false,
      hasConvergingNode: true,
    },
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

export interface TopologyRequirement {
  agentTaskCount: { kind: 'eq' | 'gte'; value: number };
  verificationGte: number;
  parallelWidth: { kind: 'eq' | 'gte'; value: number };
  hasIndependentReview: boolean;
  hasDeliberation: boolean;
  hasConvergingNode: boolean;
}

export function planWidth(plan: CollaborationPlan): number {
  const levels = new Map<string, number>();
  const levelOf = (id: string, trail = new Set<string>()): number => {
    if (trail.has(id)) return 1;
    const node = plan.nodes.find((item) => item.id === id);
    const next = new Set(trail);
    next.add(id);
    return 1 + Math.max(0, ...(node?.dependsOn ?? []).map((dep) => levelOf(dep, next)));
  };
  for (const node of plan.nodes) levels.set(node.id, levelOf(node.id));
  const perLevel = new Map<number, number>();
  for (const node of plan.nodes) {
    const level = levels.get(node.id)!;
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
  }
  return Math.max(0, ...perLevel.values());
}

export function hasConvergingNode(plan: CollaborationPlan): boolean {
  return plan.nodes.some((node) => node.dependsOn.length >= 2);
}

export function assertPlanTopology(plan: CollaborationPlan, requirement: TopologyRequirement): string[] {
  const violations: string[] = [];
  const counts = new Map<string, number>();
  for (const node of plan.nodes) counts.set(node.operator.type, (counts.get(node.operator.type) ?? 0) + 1);
  const agentTasks = counts.get('agent_task') ?? 0;
  const verifications = counts.get('verification') ?? 0;
  const reviews = counts.get('independent_review') ?? 0;
  const deliberations = counts.get('counterpoint_deliberation') ?? 0;
  if (requirement.agentTaskCount.kind === 'eq' && agentTasks !== requirement.agentTaskCount.value) {
    violations.push(`agent_task expected exactly ${requirement.agentTaskCount.value}, got ${agentTasks}`);
  }
  if (requirement.agentTaskCount.kind === 'gte' && agentTasks < requirement.agentTaskCount.value) {
    violations.push(`agent_task expected >= ${requirement.agentTaskCount.value}, got ${agentTasks}`);
  }
  if (verifications < requirement.verificationGte) violations.push(`verification expected >= ${requirement.verificationGte}, got ${verifications}`);
  const width = planWidth(plan);
  if (requirement.parallelWidth.kind === 'eq' && width !== requirement.parallelWidth.value) {
    violations.push(`parallel width expected exactly ${requirement.parallelWidth.value}, got ${width}`);
  }
  if (requirement.parallelWidth.kind === 'gte' && width < requirement.parallelWidth.value) {
    violations.push(`parallel width expected >= ${requirement.parallelWidth.value}, got ${width}`);
  }
  if (requirement.hasIndependentReview && reviews < 1) violations.push('independent_review missing');
  if (requirement.hasDeliberation && deliberations < 1) violations.push('counterpoint_deliberation missing');
  if (requirement.hasConvergingNode && !hasConvergingNode(plan)) violations.push('no converging node (needs a node with >= 2 dependencies)');
  return violations;
}
