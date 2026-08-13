import { newId } from '../ids.ts';
import type { Claim, TaskPacket } from '../schemas.ts';
import type { Operator, OperatorContext, OperatorResult } from './operator.ts';

export class AgentTaskOperator implements Operator {
  readonly type = 'agent_task' as const;

  async run(ctx: OperatorContext): Promise<OperatorResult> {
    const capability = ctx.graphNode.capabilityRequirements[0];
    const adapter = ctx.resolveAgent(capability ?? '');
    if (!adapter) throw new Error(`No agent adapter for capability "${capability}"`);
    const packet: TaskPacket = {
      id: newId('packet'),
      version: 1,
      problem: ctx.graphNode.objective,
      goals: [ctx.graphNode.objective],
      constraints: [...ctx.workItem.constraints],
      rubric: { items: [{ id: 'objective', name: 'Objective', weight: 1 }], maxScore: 5 },
      sources: [...ctx.workItem.sourceRefs],
    };
    const started = Date.now();
    const result = await adapter.run({
      runId: ctx.nodeRun.id,
      participantId: ctx.nodeRun.id,
      phase: 'node',
      taskPacket: packet,
      contextView: ctx.contextView,
      authoritySources: [],
      visibleArtifacts: [],
      workspacePath: ctx.workspacePath,
    });
    const claims: Claim[] = result.position.claims.map((claim) => ({
      id: claim.id ?? newId('claim'),
      workItemId: ctx.workItem.id,
      nodeRunId: ctx.nodeRun.id,
      statement: claim.statement,
      type: claim.type,
      evidenceRefs: [...(claim.evidenceRefs ?? [])],
      confidence: claim.confidence,
    }));
    const artifactRefs = ctx.commit({ artifacts: result.artifacts, claims });
    return {
      status: 'succeeded',
      artifactRefs,
      evidenceRefs: [],
      claimRefs: claims.map((claim) => claim.id),
      opinionRefs: [],
      outputs: {
        summary: result.position.summary,
        unknowns: result.position.unknowns,
        decisionConditions: result.position.decisionConditions,
        confidence: result.position.confidence,
        fingerprint: result.fingerprint,
      },
      usage: { timeMs: Date.now() - started, costUsd: result.cost ?? 0 },
    };
  }
}
