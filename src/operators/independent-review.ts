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
    const producerRuns = db.nodeRuns.filter(
      (run) =>
        targetGraphIds.includes(run.graphNodeId) &&
        run.workItemId === ctx.workItem.id &&
        run.planId === ctx.nodeRun.planId,
    );
    const producerRunIds = new Set(producerRuns.map((run) => run.id));
    const claims = db.claims.filter(
      (claim) =>
        claim.nodeRunId &&
        producerRunIds.has(claim.nodeRunId) &&
        claim.workItemId === ctx.workItem.id,
    );
    const claimsByRun = new Map<string, typeof claims>();
    for (const claim of claims) {
      if (!claim.nodeRunId) continue;
      const list = claimsByRun.get(claim.nodeRunId) ?? [];
      list.push(claim);
      claimsByRun.set(claim.nodeRunId, list);
    }
    const runsById = new Map(producerRuns.map((run) => [run.id, run]));
    const candidates: ReviewerCandidate[] = producerRuns.map((run, index) => {
      const runClaims = claimsByRun.get(run.id) ?? [];
      const confidence =
        runClaims.length === 0
          ? 0.5
          : runClaims.reduce((sum, claim) => sum + (claim.confidence ?? 0.5), 0) / runClaims.length;
      return {
        candidateId: String.fromCharCode(65 + (index % 26)),
        originalRunId: run.id,
        originalPositionId: runClaims[0]?.id ?? run.id,
        redacted: {
          summary: runClaims.map((claim) => claim.statement).join(' | '),
          claims: runClaims.map((claim) => ({ id: claim.id, statement: claim.statement, type: claim.type, confidence: claim.confidence })),
          unknowns: [],
          decisionConditions: [],
          confidence,
        },
        artifactRefs: [...(runsById.get(run.id)?.artifactRefs ?? [])],
      };
    });
    if (candidates.length === 0) throw new Error('NO_REVIEW_CANDIDATES');
    const claimIds = new Set(claims.map((claim) => claim.id));
    const evidence = db.evidence
      .filter(
        (item) =>
          item.workItemId === ctx.workItem.id &&
          item.targetRefs.some((ref) => ref.startsWith('claim:') && claimIds.has(ref.slice('claim:'.length))),
      )
      .map((item) => ({ id: item.id, kind: item.kind, targetRefs: item.targetRefs, status: item.status, resultSummary: item.result.summary }));
    const started = Date.now();
    const result = await reviewer.review({
      runId: ctx.nodeRun.id,
      rubric: { items: [{ id: 'fit', name: 'Fit', weight: 1 }], maxScore: 5 },
      candidates,
      evidence,
      unresolvedConflicts: [],
    });
    const reviewerFingerprint = result.fingerprint ? JSON.stringify(result.fingerprint) : undefined;
    const producerFingerprints = producerRuns.map((run) => (run.adapterFingerprint ? JSON.stringify(run.adapterFingerprint) : undefined));
    const knownConflict =
      reviewerFingerprint !== undefined && producerFingerprints.includes(reviewerFingerprint);
    const missingFingerprint =
      reviewerFingerprint === undefined || producerFingerprints.some((fingerprint) => fingerprint === undefined);
    const independence = knownConflict ? 'conflict' : missingFingerprint ? 'unknown' : 'ok';
    if (independence === 'conflict') throw new Error('INDEPENDENCE_VIOLATION: reviewer lineage conflicts with target producers');
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
          candidateCount: candidates.length,
          independence,
        },
      },
      usage: { timeMs: Date.now() - started, costUsd: result.cost ?? 0 },
    };
  }
}
