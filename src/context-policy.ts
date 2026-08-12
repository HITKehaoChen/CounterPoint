import type {
  Claim,
  ContextView,
  Deliberation,
  Evidence,
  Position,
} from './schemas.ts';
import { hashJson } from './hashing.ts';
import { newId } from './ids.ts';

export type ViewerRole = 'worker' | 'reviewer' | 'verifier' | 'human';

export interface BuildContextViewInput {
  deliberation: Deliberation;
  viewerRunId: string;
  role: ViewerRole;
  phase: string;
  /** Version refs for authority sources, e.g. ["src_task@v1"]. Always visible. */
  authoritySources: string[];
  /** Version refs shared before candidates exist (e.g. source snapshots). */
  authorityArtifactRefs: string[];
  /** Version refs published by candidate runs (only after Reveal). */
  candidateArtifactRefs: string[];
  /** Optional seed used for deterministic hashing in tests. */
  seed?: string;
}

const BLIND_HIDDEN_OBJECT_TYPES = [
  'position_draft',
  'private_scratch',
  'commitment',
  'challenge',
  'response',
  'evidence_request',
  'review',
];

/**
 * Context Policy Engine (PRD FR-020/021/023).
 *
 * Default posture: deny by default, allow explicitly. A Context View is a
 * snapshot of what a specific run may observe in a specific phase; it is
 * hashed and recorded so audit trails can prove what each Agent actually saw.
 */
export function buildContextView(input: BuildContextViewInput): ContextView {
  const { deliberation, viewerRunId, role, phase } = input;
  const otherRunIds = deliberation.runs
    .map((run) => run.id)
    .filter((id) => id !== viewerRunId);

  const revealed = isRevealedPhase(phase);
  const evidenceVisible =
    role === 'human' ||
    phase === 'verifying' ||
    phase === 'reviewing' ||
    phase === 'escalated';

  const artifacts = revealed
    ? [...input.authorityArtifactRefs, ...input.candidateArtifactRefs]
    : [...input.authorityArtifactRefs];

  const visible = {
    authoritySources: [...input.authoritySources],
    artifacts: [...new Set(artifacts)],
    claims: revealed ? visibleCommittedClaims(deliberation) : [],
    evidence: evidenceVisible ? deliberation.evidence.map((item) => item.id) : [],
  };

  const hiddenObjectTypes =
    phase === 'blind_run' || phase === 'committed'
      ? [...BLIND_HIDDEN_OBJECT_TYPES]
      : phase === 'reviewing' || phase === 'escalated'
        ? ['position_draft', 'private_scratch', 'agent_run_logs']
        : [];

  const tools =
    role === 'reviewer'
      ? {
          allow: ['read_candidates', 'read_rubric', 'read_evidence'],
          deny: ['write_artifacts'],
        }
      : phase === 'blind_run'
        ? {
            allow: ['read_sources', 'write_private_scratch'],
            deny: ['read_other_runs', 'write_shared'],
          }
        : {
            allow: ['read_sources', 'read_candidates', 'write_private_scratch'],
            deny: ['overwrite_shared'],
          };

  const view: ContextView = {
    id: newId('ctx'),
    runId: viewerRunId,
    phase,
    visible,
    hidden: {
      agentRuns: otherRunIds,
      objectTypes: hiddenObjectTypes,
    },
    tools,
    hash: '',
  };
  view.hash = hashJson({
    runId: view.runId,
    phase: view.phase,
    visible: view.visible,
    hidden: view.hidden,
    tools: view.tools,
    seed: input.seed ?? null,
  });
  return view;
}

export function isRevealedPhase(phase: string): boolean {
  return ['revealed', 'challenging', 'verifying', 'reviewing', 'escalated'].includes(phase);
}

function visibleCommittedClaims(deliberation: Deliberation): string[] {
  return deliberation.positions.flatMap((position) =>
    position.claims.map((claim) => claim.id),
  );
}

export interface ReviewerCandidate {
  candidateId: 'A' | 'B' | string;
  originalRunId: string;
  originalPositionId: string;
  redacted: {
    summary: string;
    claims: Array<{ id: string; statement: string; type: string; confidence?: number }>;
    unknowns: string[];
    decisionConditions: string[];
    confidence: number;
  };
  artifactRefs: string[];
}

/**
 * Builds the anonymous, randomly-ordered candidate set for the Reviewer
 * (PR-05 / FR-060). Author, model, provider and run identity are stripped.
 * Ordering is deterministic when a seed is supplied; the mapping is recorded
 * so the final Decision Pack can trace Candidate X/Y back to the Position.
 */
export function buildReviewerCandidates(
  positions: Position[],
  seed?: string,
): { candidates: ReviewerCandidate[]; order: string[] } {
  const order = shuffled(positions.map((position) => position.id), seed);
  const candidates: ReviewerCandidate[] = order.map((positionId, index) => {
    const position = positions.find((candidate) => candidate.id === positionId);
    if (!position) throw new Error(`Position not found: ${positionId}`);
    const label = index === 0 ? 'A' : index === 1 ? 'B' : `C${index + 1}`;
    return {
      candidateId: label,
      originalRunId: position.runId,
      originalPositionId: position.id,
      redacted: {
        summary: position.summary,
        claims: position.claims.map((claim: Claim) => ({
          id: claim.id,
          statement: claim.statement,
          type: claim.type,
          confidence: claim.confidence,
        })),
        unknowns: position.unknowns,
        decisionConditions: position.decisionConditions,
        confidence: position.confidence,
      },
      artifactRefs: position.artifactRefs,
    };
  });
  return { candidates, order };
}

export interface RedactedReviewerEvidence {
  id: string;
  kind: string;
  targetRefs: string[];
  status: string;
  resultSummary?: string;
}

export function redactEvidenceForReviewer(evidence: Evidence[]): RedactedReviewerEvidence[] {
  return evidence.map((item) => ({
    id: item.id,
    kind: item.kind,
    targetRefs: item.targetRefs,
    status: item.status,
    resultSummary: item.result.summary,
  }));
}

export function shuffled<T>(items: T[], seed?: string): T[] {
  const copy = [...items];
  let state = hashSeed(seed ?? String(Date.now()));
  for (let i = copy.length - 1; i > 0; i--) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function hashSeed(seed: string): number {
  let hash = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/**
 * Structural leak check used by tests and engine audits: a blind view must
 * never expose another run's candidate content, and hidden runs must always
 * be listed as hidden.
 */
export function findBlindLeaks(view: ContextView, otherRunIds: string[]): string[] {
  const leaks: string[] = [];
  for (const runId of otherRunIds) {
    if (!view.hidden.agentRuns.includes(runId)) {
      leaks.push(`hidden.agentRuns missing ${runId}`);
    }
    if (view.visible.claims.some((ref) => ref.includes(runId))) {
      leaks.push(`visible claims reference hidden run ${runId}`);
    }
    if (view.visible.artifacts.some((ref) => ref.includes(runId))) {
      leaks.push(`visible artifacts reference hidden run ${runId}`);
    }
  }
  return leaks;
}

/**
 * Identity-leak check for Reviewer input: serialized redacted candidates must
 * not contain author/run/model/producer markers.
 */
export function findReviewerIdentityLeaks(candidates: ReviewerCandidate[]): string[] {
  const leaks: string[] = [];
  for (const candidate of candidates) {
    const serialized = JSON.stringify(candidate.redacted);
    for (const marker of ['run_', 'worker_a', 'worker_b', 'model:', 'provider:']) {
      if (serialized.includes(marker)) {
        leaks.push(`identity marker "${marker}" found in ${candidate.candidateId}`);
      }
    }
  }
  return leaks;
}
