import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runCliProcess } from './cli-agent.ts';
import { extractJsonPayload } from './output.ts';
import {
  extractChrysResult,
  extractClaudeResult,
  type CliMeta,
  type CostEstimateRates,
} from './cli-meta.ts';
import type { ReviewerAdapter, ReviewerRunInput, ReviewerRunResult } from './reviewer.ts';
import type { AgentFingerprint, ReviewRecommendation } from '../schemas.ts';

export type CliReviewerOutputMode = 'json_stdout' | 'claude_jsonl' | 'chrys_json';

export interface CliReviewerConfig {
  command: string;
  args?: string[];
  timeoutMs?: number;
  outputMode?: CliReviewerOutputMode;
  promptVersion?: string;
  model?: string;
  provider?: string;
  env?: Record<string, string>;
  promptTextAsArg?: boolean;
  promptViaStdin?: boolean;
  costEstimateRates?: CostEstimateRates;
  chrysStateDir?: string;
}

const RECOMMENDATIONS = new Set<ReviewRecommendation>([
  'candidate_a',
  'candidate_b',
  'merge',
  'insufficient_evidence',
  'no_decision',
]);

const SUFFICIENCY = new Set(['sufficient', 'partial', 'insufficient']);

function renderReviewerPrompt(input: ReviewerRunInput): string {
  const lines: string[] = [];
  lines.push('You are the Reviewer in a Counterpoint technical decision review.');
  lines.push(`Run: ${input.runId} (phase: reviewing)`);
  lines.push('');
  lines.push('Candidates are ANONYMOUS and randomly ordered. Their identities, models and');
  lines.push('tooling are hidden from you. Judge candidates strictly on merit, rubric fit and');
  lines.push('evidence, never on order or style.');
  lines.push('');
  lines.push('## Rubric');
  for (const item of input.rubric.items) {
    const description = item.description ? `: ${item.description}` : '';
    lines.push(`- ${item.name}${description} (weight ${item.weight}, score 0..${input.rubric.maxScore})`);
  }
  lines.push('');
  lines.push('## Anonymous Candidates');
  lines.push('');
  for (const candidate of input.candidates) {
    lines.push(`### Candidate ${candidate.candidateId}`);
    lines.push('');
    lines.push(candidate.redacted.summary);
    lines.push('');
    lines.push('Claims:');
    for (const claim of candidate.redacted.claims) {
      lines.push(
        `- [${claim.id}] (${claim.type}${claim.confidence !== undefined ? `, confidence ${claim.confidence}` : ''}) ${claim.statement}`,
      );
    }
    if (candidate.redacted.unknowns.length) {
      lines.push('');
      lines.push(`Unknowns: ${candidate.redacted.unknowns.join('; ')}`);
    }
    if (candidate.redacted.decisionConditions.length) {
      lines.push('');
      lines.push(`Decision conditions: ${candidate.redacted.decisionConditions.join('; ')}`);
    }
    lines.push('');
  }
  lines.push('## Evidence');
  lines.push('');
  if (!input.evidence.length) lines.push('(none)');
  for (const evidence of input.evidence) {
    lines.push(
      `- ${evidence.id} [${evidence.kind} ${evidence.status}] targets ${evidence.targetRefs.join(', ')}: ${evidence.resultSummary ?? 'no summary'}`,
    );
  }
  lines.push('');
  lines.push('## Unresolved Conflicts');
  lines.push('');
  lines.push(input.unresolvedConflicts.length ? input.unresolvedConflicts.join('\n') : '(none)');
  lines.push('');
  lines.push('## Output Contract');
  lines.push('');
  lines.push('Score EVERY rubric item by its exact id (e.g. "fit", "latency") with an integer 0..maxScore.');
  lines.push('');
  lines.push('Respond with ONLY a single JSON document (no prose before or after):');
  lines.push('');
  lines.push('```json');
  lines.push('{');
  lines.push('  "rubricScores": { "fit": 4, "latency": 4 },');
  lines.push('  "recommendation": "candidate_a | candidate_b | merge | insufficient_evidence | no_decision",');
  lines.push('  "rationale": "why this candidate wins or why evidence is insufficient",');
  lines.push('  "unresolvedRisks": ["risk that remains"],');
  lines.push('  "evidenceSufficiency": "sufficient | partial | insufficient"');
  lines.push('}');
  lines.push('```');
  return lines.join('\n');
}

/**
 * CLI Reviewer Adapter: drives any headless coding-agent CLI (Claude Code,
 * Chrys, Codex) with an anonymized candidate set and parses the review JSON.
 */
export class CliReviewerAdapter implements ReviewerAdapter {
  readonly name = 'cli-reviewer';
  private readonly config: CliReviewerConfig;

  constructor(config: CliReviewerConfig) {
    this.config = config;
  }

  async review(input: ReviewerRunInput): Promise<ReviewerRunResult> {
    const workDir = mkdtempSync(join(tmpdir(), 'counterpoint-review-'));
    const promptFile = join(workDir, 'reviewer-prompt.txt');
    writeFileSync(promptFile, renderReviewerPrompt(input), 'utf8');
    const args = (this.config.args ?? []).map((arg) =>
      arg.replaceAll('{promptFile}', promptFile).replaceAll('{runId}', input.runId),
    );
    if (this.config.promptTextAsArg) args.push(renderReviewerPrompt(input));
    const stdinText = this.config.promptViaStdin ? renderReviewerPrompt(input) : undefined;
    const { stdout } = await runCliProcess({
      command: this.config.command,
      args,
      cwd: workDir,
      timeoutMs: this.config.timeoutMs ?? 300_000,
      env: this.config.env,
      stdinText,
    });
    const outputMode = this.config.outputMode ?? 'claude_jsonl';
    let text = '';
    let meta: CliMeta = {};
    if (outputMode === 'claude_jsonl') {
      const claude = extractClaudeResult(stdout);
      text = claude.text;
      meta = claude.meta;
    } else if (outputMode === 'chrys_json') {
      const chrys = extractChrysResult(stdout, {
        stateDir: this.config.chrysStateDir,
        rates: this.config.costEstimateRates,
      });
      text = chrys.text;
      meta = chrys.meta;
    } else {
      text = stdout;
    }
    const parsed = JSON.parse(JSON.stringify(extractJsonPayload(text))) as Record<string, unknown>;
    const rawScores = parsed.rubricScores as Record<string, unknown> | undefined;
    if (!rawScores || typeof rawScores !== 'object') {
      throw new Error('Reviewer output missing rubricScores');
    }
    const maxScore = input.rubric.maxScore;
    const clamp = (value: number) => Math.max(0, Math.min(maxScore, Math.round(value)));
    const providedValues: number[] = [];
    for (const value of Object.values(rawScores)) {
      const num = typeof value === 'number' ? value : Number(value);
      if (Number.isFinite(num)) providedValues.push(num);
    }
    const fallback =
      providedValues.length > 0
        ? Math.round(providedValues.reduce((sum, value) => sum + value, 0) / providedValues.length)
        : Math.round(maxScore / 2);
    const rubricScores: Record<string, number> = {};
    let normalized = false;
    for (const item of input.rubric.items) {
      const exact = rawScores[item.id];
      let score = typeof exact === 'number' ? exact : Number(exact);
      if (!Number.isFinite(score)) {
        const looseKey = Object.keys(rawScores).find((key) => {
          const haystack = `${item.id} ${item.name}`.toLowerCase();
          return key.toLowerCase().includes(item.id.toLowerCase()) || haystack.includes(key.toLowerCase());
        });
        score = looseKey !== undefined ? Number(rawScores[looseKey]) : fallback;
        normalized = true;
      }
      rubricScores[item.id] = clamp(score);
    }
    const recommendation = parsed.recommendation as ReviewRecommendation;
    if (!RECOMMENDATIONS.has(recommendation)) {
      throw new Error(`Reviewer output has invalid recommendation: ${String(recommendation)}`);
    }
    const evidenceSufficiency = parsed.evidenceSufficiency as ReviewerRunResult['evidenceSufficiency'];
    if (!SUFFICIENCY.has(evidenceSufficiency)) {
      throw new Error(`Reviewer output has invalid evidenceSufficiency: ${String(evidenceSufficiency)}`);
    }
    const rationale = typeof parsed.rationale === 'string' ? parsed.rationale : '';
    if (!rationale) throw new Error('Reviewer output missing rationale');
    const unresolvedRisks = Array.isArray(parsed.unresolvedRisks)
      ? parsed.unresolvedRisks.map(String)
      : [];
    const fingerprint: AgentFingerprint = {
      adapter: this.name,
      model: meta.model ?? this.config.model ?? this.config.command,
      provider: meta.provider ?? this.config.provider ?? 'cli',
      promptVersion: this.config.promptVersion ?? 'counterpoint-reviewer-prompt-1',
      toolset: ['read_candidates', 'read_rubric', 'read_evidence'],
    };
    return {
      rubricScores,
      recommendation,
      rationale,
      unresolvedRisks,
      evidenceSufficiency,
      fingerprint,
      logs: `cli=${this.config.command} mode=${outputMode} stdout=${stdout.length} bytes cost=${meta.costUsd ?? 0} scoresNormalized=${normalized}`,
      cost: meta.costUsd ?? 0,
    };
  }
}
