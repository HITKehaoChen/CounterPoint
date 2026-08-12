import type { ReviewerAdapter, ReviewerRunInput, ReviewerRunResult } from './reviewer.ts';
import type { AgentFingerprint, ReviewRecommendation } from '../schemas.ts';

export interface MockReviewerConfig {
  recommendation?: ReviewRecommendation;
  scores?: Record<string, number>;
  rationale?: string;
  unresolvedRisks?: string[];
  evidenceSufficiency?: 'sufficient' | 'partial' | 'insufficient';
  delayMs?: number;
  failWith?: string;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class MockReviewerAdapter implements ReviewerAdapter {
  readonly name = 'mock-reviewer';
  private readonly config: MockReviewerConfig;

  constructor(config: MockReviewerConfig = {}) {
    this.config = config;
  }

  async review(input: ReviewerRunInput): Promise<ReviewerRunResult> {
    if (this.config.delayMs) await sleep(this.config.delayMs);
    if (this.config.failWith) throw new Error(this.config.failWith);

    const scores: Record<string, number> = this.config.scores ?? {};
    for (const item of input.rubric.items) {
      if (scores[item.id] === undefined) {
        scores[item.id] = Math.max(1, Math.round(input.candidates.length * 2));
      }
    }

    const fingerprint: AgentFingerprint = {
      adapter: this.name,
      model: 'mock-reviewer-model',
      provider: 'mock-provider',
      promptVersion: 'reviewer-prompt-1',
      toolset: ['read_candidates', 'read_rubric', 'read_evidence'],
    };

    return {
      rubricScores: scores,
      recommendation: this.config.recommendation ?? 'candidate_a',
      rationale:
        this.config.rationale ??
        `Reviewed ${input.candidates.length} anonymous candidate(s) against the fixed rubric.`,
      unresolvedRisks: this.config.unresolvedRisks ?? [],
      evidenceSufficiency: this.config.evidenceSufficiency ?? 'sufficient',
      fingerprint,
      logs: 'mock review completed',
      cost: 0,
    };
  }
}
