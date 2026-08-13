import type { CollaborationPlan } from './schemas.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { CapabilityCatalog } from './capabilities.ts';
import type { WorkItem } from '../schemas.ts';
import type { ValidationIssue, ValidationResult, validatePlan } from './plan-validator.ts';

export interface SourceSummary {
  id: string;
  label: string;
  excerpt: string;
  versionRef: string;
}

export interface EvidenceSummary {
  id: string;
  summary: string;
  status: string;
  appliesWhen: string[];
}

export interface PlannerInput {
  workItem: WorkItem;
  envelope: AutonomyEnvelope;
  catalog: CapabilityCatalog;
  sources: SourceSummary[];
  reusableEvidence: EvidenceSummary[];
  repairContext?: { issues: ValidationIssue[]; previousPlan?: CollaborationPlan };
}

export interface PlannerRunMeta {
  costUsd?: number;
  durationMs?: number;
  model?: string;
  provider?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export interface PlannerResult {
  plan: CollaborationPlan;
  meta: PlannerRunMeta;
}

export interface Planner {
  readonly name: string;
  plan(input: PlannerInput): Promise<PlannerResult>;
}

export interface PlannerParseIssue {
  code: string;
  path: string;
  message: string;
}

export class PlannerParseError extends Error {
  readonly issues: PlannerParseIssue[];

  constructor(issues: PlannerParseIssue[]) {
    super(`Planner output failed schema validation: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join('; ')}`);
    this.name = 'PlannerParseError';
    this.issues = issues;
  }
}

export interface PlannerOrchestratorOptions {
  planner: Planner;
  validator: typeof validatePlan;
  maxRepairAttempts?: number;
}

export interface ProposeResult {
  plan?: CollaborationPlan;
  result: ValidationResult;
  attempts: number;
  repairHistory: ValidationIssue[][];
  totalCostUsd: number;
  attemptsDetail: Array<{
    attempt: number;
    costUsd: number;
    durationMs?: number;
    model?: string;
    provider?: string;
    inputTokens?: number;
    outputTokens?: number;
  }>;
}

export class PlannerOrchestrator {
  private readonly planner: Planner;
  private readonly validator: typeof validatePlan;
  private readonly maxRepairAttempts: number;

  constructor(options: PlannerOrchestratorOptions) {
    this.planner = options.planner;
    this.validator = options.validator;
    this.maxRepairAttempts = options.maxRepairAttempts ?? 2;
  }

  async propose(input: PlannerInput): Promise<ProposeResult> {
    const repairHistory: ValidationIssue[][] = [];
    let plan: CollaborationPlan | undefined;
    let result: ValidationResult = { verdict: 'needs_revision', issues: [] };
    let totalCostUsd = 0;
    let attempts = 0;
    const attemptsDetail: ProposeResult['attemptsDetail'] = [];
    let repairContext: PlannerInput['repairContext'];
    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      attempts += 1;
      const plannerInput: PlannerInput = repairContext ? { ...input, repairContext } : input;
      let proposal;
      try {
        proposal = await this.planner.plan(plannerInput);
      } catch (error) {
        if (!(error instanceof PlannerParseError)) throw error;
        const issues: ValidationIssue[] = error.issues.map((issue) => ({
          code: `PARSE_${issue.code}`.toUpperCase(),
          path: issue.path,
          message: issue.message,
          kind: 'schema',
        }));
        result = { verdict: 'rejected', issues };
        repairHistory.push(issues);
        repairContext = { issues, previousPlan: plan };
        if (attempt < this.maxRepairAttempts) continue;
        break;
      }
      totalCostUsd += proposal.meta.costUsd ?? 0;
      attemptsDetail.push({
        attempt: attempts,
        costUsd: proposal.meta.costUsd ?? 0,
        durationMs: proposal.meta.durationMs,
        model: proposal.meta.model,
        provider: proposal.meta.provider,
        inputTokens: proposal.meta.usage?.inputTokens,
        outputTokens: proposal.meta.usage?.outputTokens,
      });
      plan = proposal.plan;
      result = this.validator({ plan, envelope: input.envelope, workItem: input.workItem, catalog: input.catalog });
      if (result.verdict !== 'needs_revision') break;
      repairHistory.push(result.issues);
      repairContext = { issues: result.issues, previousPlan: plan };
    }
    return { plan, result, attempts, repairHistory, totalCostUsd, attemptsDetail };
  }
}

/**
 * Test-only planner. Never use in probe or slice runs; it cannot demonstrate
 * real planning quality (see spec §9).
 */
export class MockPlanner implements Planner {
  readonly name = 'mock-planner';
  private readonly script: (input: PlannerInput) => CollaborationPlan;

  constructor(script: (input: PlannerInput) => CollaborationPlan) {
    this.script = script;
  }

  async plan(input: PlannerInput): Promise<PlannerResult> {
    return { plan: structuredClone(this.script(input)), meta: {} };
  }
}
