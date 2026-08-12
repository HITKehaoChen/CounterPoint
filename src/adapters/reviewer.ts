import type {
  AgentFingerprint,
  ReviewRecommendation,
  Rubric,
} from '../schemas.ts';
import type {
  RedactedReviewerEvidence,
  ReviewerCandidate,
} from '../context-policy.ts';

export interface ReviewerRunInput {
  runId: string;
  rubric: Rubric;
  candidates: ReviewerCandidate[];
  evidence: RedactedReviewerEvidence[];
  unresolvedConflicts: string[];
}

export interface ReviewerRunResult {
  rubricScores: Record<string, number>;
  recommendation: ReviewRecommendation;
  rationale: string;
  unresolvedRisks: string[];
  evidenceSufficiency: 'sufficient' | 'partial' | 'insufficient';
  fingerprint: AgentFingerprint;
  logs?: string;
  cost?: number;
}

export interface ReviewerAdapter {
  readonly name: string;
  review(input: ReviewerRunInput): Promise<ReviewerRunResult>;
}
