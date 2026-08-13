import type { HumanGateAction, HumanGateRequest } from '../autonomy/human-gate.ts';
import type { Operator, OperatorContext, OperatorResult } from './operator.ts';

export class HumanGateOperator implements Operator {
  readonly type = 'human_gate' as const;

  async run(ctx: OperatorContext): Promise<OperatorResult> {
    if (ctx.graphNode.operator.type !== 'human_gate') throw new Error('HUMAN_GATE_SPEC_REQUIRED');
    const gate: HumanGateRequest = ctx.requestHumanGate({
      id: `hg_${ctx.nodeRun.id}`,
      workItemId: ctx.workItem.id,
      planId: ctx.nodeRun.planId,
      nodeId: ctx.graphNode.id,
      kind: 'high_risk',
      summary: ctx.graphNode.operator.summary,
      requested: { nodeId: ctx.graphNode.id },
      status: 'pending',
      availableActions: [...ctx.graphNode.operator.options],
      createdAt: new Date().toISOString(),
    });
    return {
      status: 'waiting_human',
      artifactRefs: [],
      evidenceRefs: [],
      claimRefs: [],
      opinionRefs: [],
      outputs: { gateId: gate.id, action: null },
    };
  }

  async resume(
    ctx: OperatorContext,
    gate: HumanGateRequest,
    action: HumanGateAction,
  ): Promise<OperatorResult> {
    return {
      status: action === 'reject_and_stop' ? 'failed' : 'succeeded',
      artifactRefs: [],
      evidenceRefs: [],
      claimRefs: [],
      opinionRefs: [],
      outputs: { gateId: gate.id, action, workItemId: ctx.workItem.id },
    };
  }
}
