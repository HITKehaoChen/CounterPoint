import type { CollaborationPlan } from './schemas.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { CapabilityCatalog } from './capabilities.ts';
import type { WorkItem } from '../schemas.ts';

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
    if (ids.has(node.id)) issues.push({ code: 'DUPLICATE_NODE_ID', path: `nodes.${node.id}`, message: 'node id must be unique', kind: 'schema' });
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
      sink.completionCriteria.some((criterion) => ['artifact', 'evidence', 'human_acceptance'].includes(criterion.kind));
    if (!producesDecision) {
      issues.push({ code: 'SINK_WITHOUT_OUTPUT', path: `nodes.${sink.id}`, message: 'sink node must produce a decision, artifact, evidence or human acceptance', kind: 'dag' });
    }
  }
  return issues;
}

export function finalizeVerdict(issues: ValidationIssue[]): ValidationVerdict {
  if (issues.length === 0) return 'accepted';
  if (issues.some((issue) => issue.kind === 'schema' || issue.kind === 'dag')) return 'rejected';
  if (issues.some((issue) => issue.kind === 'permission' || issue.kind === 'budget')) return 'needs_human_approval';
  return 'needs_revision';
}

export function validatePlan(input: ValidatePlanInput): ValidationResult {
  const issues = collectStructureIssues(input);
  return { verdict: finalizeVerdict(issues), issues };
}
