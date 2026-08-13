import { z } from 'zod';
import {
  CollaborationNodeSchema,
  NodeContextPolicySchema,
  StopConditionSchema,
} from './schemas.ts';
import { HumanGateKindSchema } from '../autonomy/human-gate.ts';

export const PlanOperationSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add_node'), node: CollaborationNodeSchema }),
  z.object({ op: z.literal('cancel_pending_node'), nodeId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ op: z.literal('replace_pending_node'), nodeId: z.string().min(1), replacement: CollaborationNodeSchema, reason: z.string().min(1) }),
  z.object({ op: z.literal('add_dependency'), from: z.string().min(1), to: z.string().min(1), reason: z.string().min(1) }),
  z.object({ op: z.literal('tighten_context_policy'), nodeId: z.string().min(1), policy: NodeContextPolicySchema, reason: z.string().min(1) }),
  z.object({ op: z.literal('request_additional_budget'), amount: z.object({ maxTimeMs: z.number().int().positive(), maxTokens: z.number().positive().optional(), maxCostUsd: z.number().positive().optional() }), reason: z.string().min(1) }),
  z.object({ op: z.literal('request_human_gate'), kind: HumanGateKindSchema, summary: z.string().min(1) }),
  z.object({ op: z.literal('change_stop_condition'), stopCondition: StopConditionSchema, reason: z.string().min(1) }),
]);
export type PlanOperation = z.infer<typeof PlanOperationSchema>;

export const PlanPatchSchema = z.object({
  id: z.string().min(1),
  basePlanVersion: z.number().int().positive(),
  reason: z.string().min(1),
  evidenceRefs: z.array(z.string()).min(1),
  operations: z.array(PlanOperationSchema).min(1),
  proposedByRunId: z.string().min(1),
  createdAt: z.string(),
  status: z.enum(['proposed', 'validated', 'rejected', 'applied']).default('proposed'),
});
export type PlanPatch = z.infer<typeof PlanPatchSchema>;
