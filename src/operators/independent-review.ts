import type { ReviewerCandidate } from '../context-policy.ts';
import type { Operator, OperatorContext, OperatorResult } from './operator.ts';

export class IndependentReviewOperator implements Operator {
  readonly type = 'independent_review' as const;

  async run(ctx: OperatorContext): Promise<OperatorResult> {
    if (ctx.graphNode.operator.type !== 'independent_review') throw new Error('INDEPENDENT_REVIEW_SPEC_REQUIRED');
    const capability = ctx.graphNode.capabilityRequirements[0];
    const reviewer = ctx.resolveReviewer(capability ?? 'independent-review');
    if (!reviewer) throw new Error(`No reviewer adapter for capability "${capability}"`);
    const db = ctx.readDb();
    const targetGraphIds = ctx.graphNode.operator.targetNodeIds.map((id) => `gn_${id}`);
    const producerRuns = db.nodeRuns.filter((run) => targetGraphIds.includes(run.graphNodeId));
    const producerRunIds = new Set(producerRuns.map((run) => run.id));
    const claims = db.claims.filter((claim) => claim.nodeRunId && producerRunIds.has(claim.nodeRunId));
    const candidates: ReviewerCandidate[] = claims.map((claim, index) => ({
      candidateId: index === 0 ? 'A' : `C${index + 1}`,
      originalRunId: claim.nodeRunId ?? '',
      originalPositionId: claim.id,
      redacted: {
        summary: claim.statement,
        claims: [{ id: claim.id, statement: claim.statement, type: claim.type, confidence: claim.confidence }],
        unknowns: [],
        decisionConditions: [],
        confidence: claim.confidence ?? 0.5,
      },
      artifactRefs: [],
    }));
    const claimIds = new Set(claims.map((claim) => claim.id));
    const evidence = db.evidence
      .filter((item) => item.targetRefs.some((ref) => ref.startsWith('claim:') && claimIds.has(ref.slice('claim:'.length))))
      .map((item) => ({ id: item.id, kind: item.kind, targetRefs: item.targetRefs, status: item.status, resultSummary: item.result.summary }));
    const started = Date.now();
    const result = await reviewer.review({
      runId: ctx.nodeRun.id,
      rubric: { items: [{ id: 'fit', name: 'Fit', weight: 1 }], maxScore: 5 },
      candidates,
      evidence,
      unresolvedConflicts: [],
    });
    const producerFingerprints = producerRuns.map((run) => JSON.stringify(run.adapterFingerprint ?? {}));
    if (producerFingerprints.includes(JSON.stringify(result.fingerprint ?? {}))) {
      throw new Error(`INDEPENDENCE_VIOLATION: reviewer lineage conflicts with target producers`);
    }
    return {
      status: 'succeeded',
      artifactRefs: [],
      evidenceRefs: [],
      claimRefs: [],
      opinionRefs: [],
      outputs: {
        review: {
          recommendation: result.recommendation,
          rationale: result.rationale,
          evidenceSufficiency: result.evidenceSufficiency,
          unresolvedRisks: result.unresolvedRisks,
          rubricScores: result.rubricScores,
        },
      },
      usage: { timeMs: Date.now() - started, costUsd: result.cost ?? 0 },
    };
  }
}
