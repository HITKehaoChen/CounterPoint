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
  repairContext?: { issues: ValidationIssue[]; previousPlan: CollaborationPlan };
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
    for (let attempt = 0; attempt <= this.maxRepairAttempts; attempt++) {
      attempts += 1;
      const plannerInput: PlannerInput =
        plan && result.issues.length
          ? { ...input, repairContext: { issues: result.issues, previousPlan: plan } }
          : input;
      const proposal = await this.planner.plan(plannerInput);
      totalCostUsd += proposal.meta.costUsd ?? 0;
      plan = proposal.plan;
      result = this.validator({ plan, envelope: input.envelope, workItem: input.workItem, catalog: input.catalog });
      if (result.verdict !== 'needs_revision') break;
      repairHistory.push(result.issues);
    }
    return { plan, result, attempts, repairHistory, totalCostUsd };
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
