import type { HumanGateAction, HumanGateRequest } from '../autonomy/human-gate.ts';
import type { ProtocolEngine } from '../protocol-engine.ts';
import type { Decision, Deliberation } from '../schemas.ts';
import type { Operator, OperatorContext, OperatorResult } from './operator.ts';

export class CounterpointDeliberationOperator implements Operator {
  readonly type = 'counterpoint_deliberation' as const;
  private readonly engine: ProtocolEngine;

  constructor(engine: ProtocolEngine) {
    this.engine = engine;
  }

  async run(ctx: OperatorContext): Promise<OperatorResult> {
    if (ctx.graphNode.operator.type !== 'counterpoint_deliberation') throw new Error('DELIBERATION_SPEC_REQUIRED');
    const spec = ctx.graphNode.operator;
    const started = Date.now();
    const project = this.engine.getProject(ctx.workItem.workspaceId);
    if (project.sourceBindings.length === 0) {
      this.engine.addSourceBinding({
        projectId: ctx.workItem.workspaceId,
        type: 'text',
        label: 'work-item',
        text: ctx.workItem.description ?? ctx.workItem.title,
      });
    }
    const deliberation = this.engine.createDeliberation({
      projectId: ctx.workItem.workspaceId,
      ownerId: ctx.workItem.ownerId,
      problem: ctx.graphNode.objective,
      goals: [ctx.graphNode.objective],
      constraints: ctx.workItem.constraints.length ? [...ctx.workItem.constraints] : ['No additional constraints'],
      rubric: { items: [{ id: 'fit', name: 'Fit', weight: 1 }], maxScore: 5 },
      deliverable: 'decision',
      workItemId: ctx.workItem.id,
    });
    for (let index = 0; index < spec.workerCount; index++) {
      this.engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: `Worker ${index + 1}` });
    }
    this.engine.addParticipant({ deliberationId: deliberation.id, role: 'reviewer', label: 'Reviewer' });
    this.engine.freezeTaskPacket(deliberation.id);
    await this.engine.startBlindRun(deliberation.id);
    let state = this.engine.getState(deliberation.id);
    if (state.state === 'committed') this.engine.reveal(deliberation.id);
    state = this.engine.getState(deliberation.id);
    if (state.state === 'challenging') this.engine.finalizeChallenges(deliberation.id);
    const claimRefs = this.engine.getState(deliberation.id).positions.flatMap((position) =>
      position.claims.map((claim) => `claim:${claim.id}`),
    );
    await this.engine.runVerification({
      deliberationId: deliberation.id,
      command: 'node',
      args: ['--version'],
      cwd: process.cwd(),
      targetRefs: claimRefs,
      description: 'facade verification command',
    });
    this.engine.freezeEvidencePack(deliberation.id);
    await this.engine.runReview(deliberation.id);

    if (spec.humanGatePolicy) {
      const gate: HumanGateRequest = ctx.requestHumanGate({
        id: `hg_${deliberation.id}`,
        workItemId: ctx.workItem.id,
        planId: ctx.nodeRun.planId,
        nodeId: ctx.graphNode.id,
        kind: 'high_risk',
        summary: spec.humanGatePolicy,
        requested: { deliberationId: deliberation.id },
        status: 'pending',
        availableActions: ['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop'],
        createdAt: new Date().toISOString(),
      });
      return {
        status: 'waiting_human',
        artifactRefs: [],
        evidenceRefs: [],
        claimRefs: [],
        opinionRefs: [],
        outputs: { deliberationId: deliberation.id, gateId: gate.id },
        usage: { timeMs: Date.now() - started },
      };
    }
    const decision = this.decide(deliberation.id, ctx.workItem.ownerId);
    return {
      status: 'succeeded',
      artifactRefs: [],
      evidenceRefs: [],
      claimRefs: [],
      opinionRefs: [],
      outputs: { deliberationId: deliberation.id, decisionRefs: [decision.id] },
      usage: { timeMs: Date.now() - started },
    };
  }

  async resume(
    ctx: OperatorContext,
    gate: HumanGateRequest,
    action: HumanGateAction,
    payload?: { selectedRefs?: string[]; rationale?: string },
  ): Promise<OperatorResult> {
    const deliberationId = String((gate.requested as { deliberationId?: string }).deliberationId ?? '');
    if (!deliberationId) throw new Error('GATE_MISSING_DELIBERATION_ID');
    const decision = this.decide(deliberationId, ctx.workItem.ownerId, action, payload);
    return {
      status: action === 'reject_and_stop' ? 'failed' : 'succeeded',
      artifactRefs: [],
      evidenceRefs: [],
      claimRefs: [],
      opinionRefs: [],
      outputs: { deliberationId, decisionRefs: action === 'reject_and_stop' ? [] : [decision.id] },
    };
  }

  private decide(
    deliberationId: string,
    ownerId: string,
    action: HumanGateAction = 'approve_once',
    payload?: { selectedRefs?: string[]; rationale?: string },
  ): Decision {
    const deliberation: Deliberation = this.engine.getState(deliberationId);
    const review = deliberation.reviews[deliberation.reviews.length - 1];
    if (!review) throw new Error('NO_REVIEW_FOR_DECISION');
    const selectedRefs =
      payload?.selectedRefs ??
      this.refsForRecommendation(deliberation, review.recommendation);
    const humanAction =
      action === 'reject_and_stop' ? 'no_decision' : action === 'modify_envelope' ? 'override' : 'approve';
    return this.engine.humanDecision({
      deliberationId,
      action: humanAction,
      rationale: payload?.rationale ?? 'facade human gate',
      selectedRefs,
      ownerId,
    });
  }

  private refsForRecommendation(deliberation: Deliberation, recommendation: string): string[] {
    if (!deliberation.reviewOrder?.length) return [];
    if (recommendation === 'candidate_a') return [`position:${deliberation.reviewOrder[0]}`];
    if (recommendation === 'candidate_b') return [`position:${deliberation.reviewOrder[1]}`];
    if (recommendation === 'merge') return deliberation.reviewOrder.map((id) => `position:${id}`);
    return [];
  }
}
