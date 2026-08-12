import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MockAgentScript } from '../src/adapters/mock-agent.ts';
import type { MockReviewerConfig } from '../src/adapters/mock-reviewer.ts';
import type { Rubric } from '../src/schemas.ts';
import { ProtocolEngine } from '../src/protocol-engine.ts';
import { InMemoryStore } from '../src/store.ts';
import { MockAgentAdapter } from '../src/adapters/mock-agent.ts';
import { MockReviewerAdapter } from '../src/adapters/mock-reviewer.ts';

export interface EvalFixture {
  id: string;
  problem: string;
  goals: string[];
  constraints: string[];
  rubric: Rubric;
  sourceText: string;
  groundTruth: { decision: 'A' | 'B'; criticalIssues: string[] };
  workerA: MockAgentScript;
  workerB: MockAgentScript;
  workerAShared?: MockAgentScript;
  workerBShared?: MockAgentScript;
  reviewer: MockReviewerConfig;
}

export type ConditionName = 'A' | 'B' | 'C';

export interface ConditionResult {
  fixtureId: string;
  condition: ConditionName;
  decided: boolean;
  decisionLabel?: 'A' | 'B' | 'merge' | 'none';
  criticalIssuesFound: string[];
  criticalIssueRecall: number;
  uniqueValidClaims: number;
  evidenceCoverage: number;
  contextLeaks: number;
  falseConsensus: boolean;
  timeMs: number;
  cost: number;
  positions: number;
}

export interface EvalReport {
  generatedAt: string;
  caveat: string;
  fixtures: string[];
  results: ConditionResult[];
  summary: Array<{
    condition: ConditionName;
    avgCriticalIssueRecall: number;
    avgEvidenceCoverage: number;
    totalContextLeaks: number;
    avgUniqueValidClaims: number;
  }>;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function findCriticalIssues(scripts: MockAgentScript[], criticalIssues: string[]): string[] {
  const allStatements = scripts.flatMap((script) => script.claims.map((claim) => claim.statement));
  return criticalIssues.filter((issue) =>
    allStatements.some((statement) => normalize(statement).includes(normalize(issue))),
  );
}

function uniqueValidClaims(scripts: MockAgentScript[]): number {
  const counts = new Map<string, number>();
  for (const script of scripts) {
    for (const claim of script.claims) {
      const key = normalize(claim.statement);
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts.values()].filter((count) => count === 1).length;
}

function evidenceCoverage(scripts: MockAgentScript[]): number {
  const claims = scripts.flatMap((script) => script.claims);
  if (!claims.length) return 0;
  return claims.filter((claim) => (claim.evidenceRefs?.length ?? 0) > 0).length / claims.length;
}

export async function runConditionC(fixture: EvalFixture): Promise<ConditionResult> {
  const started = Date.now();
  const store = new InMemoryStore();
  const workspaceRoot = mkdtempSync(join(tmpdir(), 'counterpoint-eval-'));
  const engine = new ProtocolEngine({
    store,
    seed: `eval-${fixture.id}`,
    workspaceRoot,
    verifierConfig: { allowlist: ['node'], timeoutMs: 10_000, environmentRef: 'eval' },
    resolveAdapter: (participant) => {
      if (participant.role === 'worker') {
        const script = participant.label === 'Worker A' ? fixture.workerA : fixture.workerB;
        return new MockAgentAdapter(() => script);
      }
      if (participant.role === 'reviewer') return new MockReviewerAdapter(fixture.reviewer);
      return undefined;
    },
  });
  const project = engine.createProject({ name: `eval-${fixture.id}` });
  engine.addSourceBinding({
    projectId: project.id,
    type: 'text',
    label: 'source',
    text: fixture.sourceText,
  });
  const deliberation = engine.createDeliberation({
    projectId: project.id,
    ownerId: 'eval-owner',
    problem: fixture.problem,
    goals: fixture.goals,
    constraints: fixture.constraints,
    rubric: fixture.rubric,
  });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: 'Worker A' });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: 'Worker B' });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'reviewer', label: 'Reviewer' });
  engine.freezeTaskPacket(deliberation.id);
  await engine.startBlindRun(deliberation.id);
  engine.finalizeChallenges(deliberation.id);
  engine.freezeEvidencePack(deliberation.id);
  await engine.runReview(deliberation.id);
  engine.humanDecision({
    deliberationId: deliberation.id,
    action: 'approve',
    rationale: 'eval approval',
    ownerId: 'eval-owner',
  });
  const state = engine.getState(deliberation.id);
  const decision = state.decisions[0];
  const decisionPositionIds = decision.selectedRefs
    .filter((ref) => ref.startsWith('position:'))
    .map((ref) => ref.slice('position:'.length));
  const chosenPositions = state.positions.filter((position) => decisionPositionIds.includes(position.id));
  let decisionLabel: ConditionResult['decisionLabel'] = 'none';
  if (decision.humanAction === 'no_decision') decisionLabel = 'none';
  else if (chosenPositions.length === 2) decisionLabel = 'merge';
  else if (chosenPositions.length === 1) {
    const participant = state.participants.find(
      (item) => item.id === state.runs.find((run) => run.id === chosenPositions[0].runId)?.participantId,
    );
    decisionLabel = participant?.label === 'Worker A' ? 'A' : participant?.label === 'Worker B' ? 'B' : 'none';
  }

  const scripts = [fixture.workerA, fixture.workerB];
  const criticalIssuesFound = findCriticalIssues(scripts, fixture.groundTruth.criticalIssues);
  const result: ConditionResult = {
    fixtureId: fixture.id,
    condition: 'C',
    decided: true,
    decisionLabel,
    criticalIssuesFound,
    criticalIssueRecall:
      fixture.groundTruth.criticalIssues.length === 0
        ? 1
        : criticalIssuesFound.length / fixture.groundTruth.criticalIssues.length,
    uniqueValidClaims: uniqueValidClaims(scripts),
    evidenceCoverage: evidenceCoverage(scripts),
    contextLeaks: engine.auditBlindLeaks(deliberation.id).length,
    falseConsensus: false,
    timeMs: Date.now() - started,
    cost: state.runs.reduce((sum, run) => sum + (run.cost ?? 0), 0),
    positions: state.positions.length,
  };
  return result;
}

export async function runConditionA(fixture: EvalFixture): Promise<ConditionResult> {
  const started = Date.now();
  // Baseline A: single agent generates a position, then self-checks it once.
  const scripts = [fixture.workerA, { ...fixture.workerA, claims: fixture.workerA.claims }];
  const criticalIssuesFound = findCriticalIssues([fixture.workerA], fixture.groundTruth.criticalIssues);
  return {
    fixtureId: fixture.id,
    condition: 'A',
    decided: true,
    decisionLabel: 'A',
    criticalIssuesFound,
    criticalIssueRecall:
      fixture.groundTruth.criticalIssues.length === 0
        ? 1
        : criticalIssuesFound.length / fixture.groundTruth.criticalIssues.length,
    uniqueValidClaims: uniqueValidClaims(scripts),
    evidenceCoverage: evidenceCoverage(scripts),
    contextLeaks: 0,
    falseConsensus: false,
    timeMs: Date.now() - started,
    cost: 0,
    positions: 1,
  };
}

export async function runConditionB(fixture: EvalFixture): Promise<ConditionResult> {
  const started = Date.now();
  // Baseline B: both agents share full context from the start. The shared
  // variant scripts model anchoring: the second agent agrees and drops
  // independent claims.
  const workerB = fixture.workerBShared ?? fixture.workerB;
  const scripts = [fixture.workerA, workerB];
  const criticalIssuesFound = findCriticalIssues(scripts, fixture.groundTruth.criticalIssues);
  return {
    fixtureId: fixture.id,
    condition: 'B',
    decided: true,
    decisionLabel: 'B',
    criticalIssuesFound,
    criticalIssueRecall:
      fixture.groundTruth.criticalIssues.length === 0
        ? 1
        : criticalIssuesFound.length / fixture.groundTruth.criticalIssues.length,
    uniqueValidClaims: uniqueValidClaims(scripts),
    evidenceCoverage: evidenceCoverage(scripts),
    contextLeaks: 0,
    falseConsensus: Boolean(fixture.workerBShared),
    timeMs: Date.now() - started,
    cost: 0,
    positions: 2,
  };
}

export function buildReport(
  fixtures: EvalFixture[],
  results: ConditionResult[],
): EvalReport {
  const conditions: ConditionName[] = ['A', 'B', 'C'];
  const summary = conditions.map((condition) => {
    const rows = results.filter((result) => result.condition === condition);
    const avg = (selector: (row: ConditionResult) => number) =>
      rows.length === 0 ? 0 : rows.reduce((sum, row) => sum + selector(row), 0) / rows.length;
    return {
      condition,
      avgCriticalIssueRecall: Number(avg((row) => row.criticalIssueRecall).toFixed(3)),
      avgEvidenceCoverage: Number(avg((row) => row.evidenceCoverage).toFixed(3)),
      totalContextLeaks: rows.reduce((sum, row) => sum + row.contextLeaks, 0),
      avgUniqueValidClaims: Number(avg((row) => row.uniqueValidClaims).toFixed(2)),
    };
  });
  return {
    generatedAt: new Date().toISOString(),
    caveat:
      'Directional harness demonstration with scripted mock agents. Not a statistically significant evaluation; per PRD 14.3, conclusions require 15-30 real historical tasks.',
    fixtures: fixtures.map((fixture) => fixture.id),
    results,
    summary,
  };
}

export function reportToMarkdown(report: EvalReport): string {
  const lines: string[] = [];
  lines.push('# Counterpoint A/B/C Evaluation Report');
  lines.push('');
  lines.push(`Generated: ${report.generatedAt}`);
  lines.push('');
  lines.push(`> ${report.caveat}`);
  lines.push('');
  lines.push('## Summary');
  lines.push('');
  lines.push('| Condition | Avg Critical Issue Recall | Avg Evidence Coverage | Total Context Leaks | Avg Unique Valid Claims |');
  lines.push('|---|---|---|---|---|');
  for (const row of report.summary) {
    lines.push(
      `| ${row.condition} | ${row.avgCriticalIssueRecall} | ${row.avgEvidenceCoverage} | ${row.totalContextLeaks} | ${row.avgUniqueValidClaims} |`,
    );
  }
  lines.push('');
  lines.push('## Per-fixture results');
  lines.push('');
  for (const fixtureId of report.fixtures) {
    lines.push(`### ${fixtureId}`);
    lines.push('');
    for (const result of report.results.filter((row) => row.fixtureId === fixtureId)) {
      lines.push(
        `- **Condition ${result.condition}**: decision=${result.decisionLabel ?? 'none'}, recall=${result.criticalIssueRecall}, leaks=${result.contextLeaks}, positions=${result.positions}`,
      );
    }
    lines.push('');
  }
  return lines.join('\n');
}
