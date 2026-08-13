import type { CollaborationPlan, OperatorSpec } from './schemas.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { CapabilityCatalog } from './capabilities.ts';
import type { WorkItem } from '../schemas.ts';

export const VALIDATOR_VERSION = '2';

export type IssueKind = 'schema' | 'dag' | 'permission' | 'budget' | 'context' | 'independence' | 'evidence' | 'gate';
export interface ValidationIssue {
  code: string;
  path: string;
  message: string;
  kind: IssueKind;
}

export type ValidationVerdict = 'accepted' | 'rejected' | 'needs_revision' | 'needs_human_approval';

export interface ValidationResult {
  verdict: ValidationVerdict;
  issues: ValidationIssue[];
}

export interface ValidatePlanInput {
  plan: CollaborationPlan;
  envelope: AutonomyEnvelope;
  workItem: WorkItem;
  catalog: CapabilityCatalog;
  lineage?: Record<string, { authorRunIds: string[]; fingerprints: string[]; contextViewHashes: string[] }>;
  evidenceIndex?: Map<string, 'verified' | 'unverified' | 'unknown'>;
}

export function collectStructureIssues(input: ValidatePlanInput): ValidationIssue[] {
  const { plan, catalog } = input;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  for (const node of plan.nodes) {
    if (ids.has(node.id)) issues.push({ code: 'DUPLICATE_NODE_ID', path: `nodes.${node.id}`, message: 'node id must be unique', kind: 'dag' });
    ids.add(node.id);
    for (const capability of node.capabilityRequirements) {
      if (!catalog.byCapability.has(capability)) {
        issues.push({ code: 'UNKNOWN_CAPABILITY', path: `nodes.${node.id}.capabilityRequirements`, message: `unknown capability ${capability}`, kind: 'dag' });
      }
    }
  }
  for (const node of plan.nodes) {
    for (const dependency of node.dependsOn) {
      if (!ids.has(dependency)) issues.push({ code: 'UNKNOWN_DEPENDENCY', path: `nodes.${node.id}.dependsOn`, message: `dependency not found: ${dependency}`, kind: 'dag' });
    }
  }
  const colors = new Map<string, 'white' | 'gray' | 'black'>();
  const visit = (nodeId: string, stack: string[]): void => {
    const color = colors.get(nodeId) ?? 'white';
    if (color === 'black') return;
    if (color === 'gray') {
      issues.push({ code: 'CYCLE', path: `nodes.${nodeId}`, message: `cycle: ${[...stack, nodeId].join(' -> ')}`, kind: 'dag' });
      return;
    }
    colors.set(nodeId, 'gray');
    const node = plan.nodes.find((item) => item.id === nodeId);
    for (const dependency of node?.dependsOn ?? []) visit(dependency, [...stack, nodeId]);
    colors.set(nodeId, 'black');
  };
  for (const node of plan.nodes) visit(node.id, []);
  const dependents = new Set(plan.nodes.flatMap((node) => node.dependsOn));
  for (const sink of plan.nodes.filter((node) => !dependents.has(node.id))) {
    const producesDecision =
      sink.operator.type === 'human_gate' ||
      sink.operator.type === 'independent_review' ||
      sink.operator.type === 'counterpoint_deliberation' ||
      sink.completionCriteria.some((criterion) => ['artifact', 'evidence', 'human_acceptance'].includes(criterion.kind));
    if (!producesDecision) {
      issues.push({ code: 'SINK_WITHOUT_OUTPUT', path: `nodes.${sink.id}`, message: 'sink node must produce a decision, artifact, evidence or human acceptance', kind: 'dag' });
    }
  }
  return issues;
}

export function finalizeVerdict(issues: ValidationIssue[]): ValidationVerdict {
  if (issues.length === 0) return 'accepted';
  if (issues.some((issue) => issue.kind === 'schema')) return 'rejected';
  if (issues.some((issue) => issue.kind === 'permission' || issue.kind === 'budget')) return 'needs_human_approval';
  return 'needs_revision';
}

function operatorCommands(operator: OperatorSpec): string[] {
  if (operator.type === 'tool_task' || operator.type === 'verification') return [operator.command];
  return [];
}

function isWithinScope(scope: string, allowed: string[]): boolean {
  const normalized = scope.replaceAll('\\', '/');
  return allowed.some((item) => {
    const prefix = item.replaceAll('\\', '/').replace(/\/$/, '');
    return normalized === prefix || normalized.startsWith(`${prefix}/`);
  });
}

export function collectPermissionBudgetIssues(input: ValidatePlanInput): ValidationIssue[] {
  const { plan, envelope } = input;
  const issues: ValidationIssue[] = [];
  for (const node of plan.nodes) {
    for (const command of operatorCommands(node.operator)) {
      if (!envelope.allowedTools.includes(command)) {
        issues.push({ code: 'PERMISSION_TOOL', path: `nodes.${node.id}.operator.command`, message: `tool "${command}" is not in the envelope allowlist`, kind: 'permission' });
      }
    }
    for (const scope of node.contextPolicy.writeScopes) {
      if (!isWithinScope(scope, envelope.writableScopes)) {
        issues.push({ code: 'PERMISSION_WRITE_SCOPE', path: `nodes.${node.id}.contextPolicy.writeScopes`, message: `write scope "${scope}" is outside the envelope`, kind: 'permission' });
      }
    }
    if (node.failurePolicy.maxRetries > envelope.maxRounds) {
      issues.push({ code: 'BUDGET_RETRY_OVER_ROUNDS', path: `nodes.${node.id}.failurePolicy`, message: 'retries exceed envelope rounds', kind: 'budget' });
    }
  }
  const allocation = plan.budgetAllocation;
  if (
    allocation.maxTotalAgents > envelope.maxAgents ||
    allocation.maxTotalRounds > envelope.maxRounds ||
    allocation.maxTotalTimeMs > envelope.timeBudgetMs
  ) {
    issues.push({ code: 'BUDGET_OVER_ENVELOPE', path: 'budgetAllocation', message: 'plan allocation exceeds the envelope', kind: 'budget' });
  }
  const nodeTimeTotal = plan.nodes.reduce((sum, node) => sum + node.allocatedBudget.maxTimeMs, 0);
  if (nodeTimeTotal > envelope.timeBudgetMs) {
    issues.push({ code: 'BUDGET_SUM_TIME', path: 'nodes', message: `node time budgets sum to ${nodeTimeTotal}ms > envelope ${envelope.timeBudgetMs}ms`, kind: 'budget' });
  }
  const levels = new Map<string, number>();
  const levelOf = (nodeId: string, trail: Set<string> = new Set()): number => {
    if (trail.has(nodeId)) return 1;
    const cached = levels.get(nodeId);
    if (cached !== undefined) return cached;
    const node = plan.nodes.find((item) => item.id === nodeId);
    const nextTrail = new Set(trail);
    nextTrail.add(nodeId);
    const level = 1 + Math.max(0, ...(node?.dependsOn ?? []).map((dependency) => levelOf(dependency, nextTrail)));
    levels.set(nodeId, level);
    return level;
  };
  const perLevel = new Map<number, number>();
  for (const node of plan.nodes) {
    const level = levelOf(node.id);
    perLevel.set(level, (perLevel.get(level) ?? 0) + 1);
  }
  const maxWidth = Math.max(0, ...perLevel.values());
  if (maxWidth > envelope.maxParallelism) {
    issues.push({ code: 'BUDGET_PARALLELISM', path: 'nodes', message: `max parallel width ${maxWidth} > envelope ${envelope.maxParallelism}`, kind: 'budget' });
  }
  return issues;
}

export function collectConstitutionIssues(input: ValidatePlanInput): ValidationIssue[] {
  const { plan, envelope, lineage, evidenceIndex } = input;
  const issues: ValidationIssue[] = [];
  const byId = new Map(plan.nodes.map((node) => [node.id, node]));
  for (const node of plan.nodes) {
    for (const ref of node.inputRefs) {
      const producerId = ref.split(':')[0];
      const producer = byId.get(producerId);
      if (producer && producer.id !== node.id && ['private', 'blind', 'sealed'].includes(producer.contextPolicy.visibility)) {
        issues.push({ code: 'CONTEXT_PRIVATE_REF', path: `nodes.${node.id}.inputRefs`, message: `ref ${ref} points at ${producer.contextPolicy.visibility} node ${producer.id}`, kind: 'context' });
      }
    }
    for (const criterion of node.completionCriteria) {
      if (criterion.kind === 'evidence' && criterion.refs.length === 0) {
        issues.push({ code: 'EVIDENCE_CRITERION_NO_REF', path: `nodes.${node.id}.completionCriteria`, message: 'evidence criterion must reference evidence', kind: 'evidence' });
      }
      for (const ref of criterion.refs) {
        if (evidenceIndex && ref.startsWith('evidence:') && evidenceIndex.get(ref) === 'unknown') {
          issues.push({ code: 'EVIDENCE_REF_UNRESOLVED', path: `nodes.${node.id}.completionCriteria`, message: `evidence ref unresolved: ${ref}`, kind: 'evidence' });
        }
      }
    }
  }
  const blindNodes = plan.nodes.filter((node) => node.contextPolicy.visibility === 'blind');
  for (let i = 0; i < blindNodes.length; i++) {
    for (let j = i + 1; j < blindNodes.length; j++) {
      const shared = blindNodes[i].inputRefs.filter((ref) => blindNodes[j].inputRefs.includes(ref));
      if (shared.length) {
        issues.push({ code: 'CONTEXT_BLIND_SHARED_INPUT', path: 'nodes', message: `blind nodes ${blindNodes[i].id}/${blindNodes[j].id} share inputs: ${shared.join(', ')}`, kind: 'context' });
      }
    }
  }
  for (const node of plan.nodes) {
    if (node.operator.type !== 'independent_review') continue;
    for (const targetId of node.operator.targetNodeIds) {
      const target = byId.get(targetId);
      if (!target) continue;
      const overlap = target.capabilityRequirements.filter((capability) => node.capabilityRequirements.includes(capability));
      if (overlap.length) {
        issues.push({ code: 'INDEPENDENCE_CAPABILITY_OVERLAP', path: `nodes.${node.id}`, message: `reviewer shares capabilities with target ${targetId}: ${overlap.join(', ')}`, kind: 'independence' });
      }
      if (lineage) {
        const reviewerLineage = lineage[node.id]?.fingerprints ?? [];
        const targetLineage = lineage[targetId]?.fingerprints ?? [];
        const conflict = reviewerLineage.some((fingerprint) => targetLineage.includes(fingerprint));
        if (conflict) {
          issues.push({ code: 'INDEPENDENCE_LINEAGE_CONFLICT', path: `nodes.${node.id}`, message: `reviewer lineage conflicts with target ${targetId}`, kind: 'independence' });
        }
      }
    }
  }
  const gatedActions = envelope.riskPolicy.requireHumanGateFor;
  const planUsesGatedAction = plan.nodes.some((node) => {
    if (node.operator.type !== 'tool_task' && node.operator.type !== 'verification') return false;
    const full = `${node.operator.command} ${node.operator.args.join(' ')}`.trim();
    return gatedActions.includes(full) || gatedActions.includes(node.operator.command);
  });
  const hasGateNode = plan.nodes.some((node) => node.operator.type === 'human_gate');
  if (planUsesGatedAction && !hasGateNode) {
    issues.push({ code: 'GATE_REQUIRED_MISSING', path: 'nodes', message: 'plan uses a gated action but has no human_gate node', kind: 'gate' });
  }
  const planUsesNonIdempotent = plan.nodes.some(
    (node) =>
      (node.operator.type === 'tool_task' || node.operator.type === 'verification') &&
      node.operator.effectClass === 'non_idempotent',
  );
  if (planUsesNonIdempotent && !hasGateNode) {
    issues.push({
      code: 'GATE_REQUIRED_FOR_NON_IDEMPOTENT',
      path: 'nodes',
      message: 'non_idempotent command requires a human_gate node',
      kind: 'gate',
    });
  }
  for (const stopCondition of plan.stopConditions) {
    for (const ref of stopCondition.refs) {
      if (evidenceIndex && ref.startsWith('evidence:') && evidenceIndex.get(ref) === 'unknown') {
        issues.push({ code: 'GATE_STOP_REF_UNRESOLVED', path: 'stopConditions', message: `stop condition ref unresolved: ${ref}`, kind: 'gate' });
      }
    }
  }
  return issues;
}

export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const issues = [
    ...collectStructureIssues(input),
    ...collectPermissionBudgetIssues(input),
    ...collectConstitutionIssues(input),
  ];
  return { verdict: finalizeVerdict(issues), issues };
}
