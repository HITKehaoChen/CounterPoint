import { z } from 'zod';

export const HumanGateKindSchema = z.enum([
  'permission_escalation',
  'budget_escalation',
  'high_risk',
  'indecision',
  'human_accountability',
]);
export type HumanGateKind = z.infer<typeof HumanGateKindSchema>;

export const HumanGateActionSchema = z.enum([
  'approve_once',
  'approve_work_item',
  'modify_envelope',
  'reject_and_stop',
]);
export type HumanGateAction = z.infer<typeof HumanGateActionSchema>;

export const HumanGateRequestSchema = z.object({
  id: z.string().min(1),
  workItemId: z.string().min(1),
  planId: z.string().min(1),
  nodeId: z.string().optional(),
  kind: HumanGateKindSchema,
  summary: z.string().min(1),
  requested: z.record(z.unknown()),
  availableActions: z.array(HumanGateActionSchema).default(['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop']),
  status: z.enum(['pending', 'approved', 'rejected', 'modified']).default('pending'),
  createdAt: z.string().default(() => new Date().toISOString()),
  resolvedAt: z.string().optional(),
  decisionRef: z.string().optional(),
  reason: z.string().optional(),
});
export type HumanGateRequest = z.infer<typeof HumanGateRequestSchema>;
