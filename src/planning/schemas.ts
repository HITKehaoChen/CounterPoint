import { z } from 'zod';

export const VisibilitySchema = z.enum(['shared', 'private', 'blind', 'sealed']);
export type Visibility = z.infer<typeof VisibilitySchema>;

export const NodeContextPolicySchema = z.object({
  readScopes: z.array(z.string()).default([]),
  writeScopes: z.array(z.string()).default([]),
  visibility: VisibilitySchema.default('shared'),
  includeObjectTypes: z.array(z.string()).default([]),
  excludeObjectTypes: z.array(z.string()).default([]),
  revealAfter: z.string().optional(),
});
export type NodeContextPolicy = z.infer<typeof NodeContextPolicySchema>;

export const AgentTaskOperatorSpecSchema = z.object({
  type: z.literal('agent_task'),
  instructions: z.string().min(1),
});
export const ToolTaskOperatorSpecSchema = z.object({
  type: z.literal('tool_task'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
});
export const VerificationOperatorSpecSchema = z.object({
  type: z.literal('verification'),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional(),
  targetRefs: z.array(z.string()).default([]),
});
export const IndependentReviewOperatorSpecSchema = z.object({
  type: z.literal('independent_review'),
  rubricRef: z.string().min(1),
  targetNodeIds: z.array(z.string()).min(1),
});
export const CounterpointDeliberationSpecSchema = z.object({
  type: z.literal('counterpoint_deliberation'),
  workerCount: z.number().int().min(2).max(5).default(2),
  blind: z.literal(true).default(true),
  commitReveal: z.literal(true).default(true),
  challengeRounds: z.number().int().min(0).max(3).default(1),
  verificationPolicy: z.string().min(1),
  reviewerPolicy: z.string().min(1),
  humanGatePolicy: z.string().optional(),
});
export const HumanGateOperatorSpecSchema = z.object({
  type: z.literal('human_gate'),
  summary: z.string().min(1),
  options: z
    .array(z.enum(['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop']))
    .default(['approve_once', 'reject_and_stop']),
});

export const OperatorSpecSchema = z.discriminatedUnion('type', [
  AgentTaskOperatorSpecSchema,
  ToolTaskOperatorSpecSchema,
  VerificationOperatorSpecSchema,
  IndependentReviewOperatorSpecSchema,
  CounterpointDeliberationSpecSchema,
  HumanGateOperatorSpecSchema,
]);
export type OperatorSpec = z.infer<typeof OperatorSpecSchema>;
export type OperatorKind = OperatorSpec['type'];

export const CompletionCriterionKindSchema = z.enum(['evidence', 'artifact', 'human_acceptance', 'claim_supported']);
export const CompletionCriterionSchema = z.object({
  id: z.string().min(1),
  kind: CompletionCriterionKindSchema,
  description: z.string().min(1),
  refs: z.array(z.string()).default([]),
});
export type CompletionCriterion = z.infer<typeof CompletionCriterionSchema>;

export const FailurePolicySchema = z.object({
  maxRetries: z.number().int().min(0).max(3).default(0),
  onFailure: z.enum(['fail_node', 'cancel_pending_children', 'escalate']).default('fail_node'),
});

export const NodeBudgetSchema = z.object({
  maxTimeMs: z.number().int().positive(),
  maxTokens: z.number().positive().optional(),
  maxCostUsd: z.number().positive().optional(),
});

export const CollaborationNodeSchema = z.object({
  id: z.string().min(1),
  role: z.string().min(1),
  objective: z.string().min(1),
  dependsOn: z.array(z.string()).default([]),
  inputRefs: z.array(z.string()).default([]),
  contextPolicy: NodeContextPolicySchema,
  capabilityRequirements: z.array(z.string()).default([]),
  operator: OperatorSpecSchema,
  completionCriteria: z.array(CompletionCriterionSchema).min(1),
  failurePolicy: FailurePolicySchema,
  allocatedBudget: NodeBudgetSchema,
});
export type CollaborationNode = z.infer<typeof CollaborationNodeSchema>;

export const StopConditionKindSchema = z.enum(['evidence', 'artifact', 'decision', 'budget_exhausted', 'human_acceptance']);
export const StopConditionSchema = z.object({
  id: z.string().min(1),
  kind: StopConditionKindSchema,
  description: z.string().min(1),
  refs: z.array(z.string()).default([]),
  targetOutcome: z.enum(['resolved', 'partially_resolved', 'needs_evidence', 'blocked', 'rejected', 'escalated']),
});
export const EscalationConditionKindSchema = z.enum([
  'conflicting_evidence',
  'budget_exceeded',
  'high_risk_action',
  'completion_unreachable',
  'agent_unable_to_continue',
]);
export const EscalationConditionSchema = z.object({
  id: z.string().min(1),
  kind: EscalationConditionKindSchema,
  description: z.string().min(1),
});
export const BudgetAllocationSchema = z.object({
  maxTotalTimeMs: z.number().int().positive(),
  maxTotalAgents: z.number().int().positive(),
  maxTotalRounds: z.number().int().nonnegative(),
});
export const PlanStatusSchema = z.enum(['proposed', 'validating', 'validated', 'rejected', 'executing', 'completed', 'failed', 'superseded']);

export const CollaborationPlanSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  version: z.number().int().positive().default(1),
  goal: z.string().min(1),
  assumptions: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  nodes: z.array(CollaborationNodeSchema).min(1),
  stopConditions: z.array(StopConditionSchema).min(1),
  escalationConditions: z.array(EscalationConditionSchema).default([]),
  budgetAllocation: BudgetAllocationSchema,
  createdByRunId: z.string().min(1),
  status: PlanStatusSchema.default('proposed'),
});
export type CollaborationPlan = z.infer<typeof CollaborationPlanSchema>;
