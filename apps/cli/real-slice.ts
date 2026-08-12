import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { JsonFileStore } from '../../src/store.ts';
import { CliAgentAdapter } from '../../src/adapters/cli-agent.ts';
import { CliReviewerAdapter } from '../../src/adapters/cli-reviewer.ts';
import { decisionPackToMarkdown } from '../../src/decision-pack.ts';
import { buildReviewerCandidates } from '../../src/context-policy.ts';
import type { Evidence, Position } from '../../src/schemas.ts';

const repoRoot = process.cwd();
const chrysBin =
  process.env.CHRYS_BIN ?? 'C:\\Users\\tgyzc\\project\\chrys\\.venv\\Scripts\\chrys.exe';
const claudeBin = process.env.CLAUDE_BIN ?? 'C:\\Users\\tgyzc\\.local\\bin\\claude.exe';
const workerBModel = process.env.WORKER_B_MODEL ?? 'deepseek-v4-pro[1m]';
const reviewerModel = process.env.REVIEWER_MODEL ?? 'deepseek-v4-flash';
const seed = process.env.SLICE_SEED ?? 'm1-real-slice-2026-08-12';
const npmCli =
  process.env.NPM_CLI_PATH ?? 'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js';

// Observed on this machine from the same DeepSeek-backed provider: ~$5/M input
// and ~$25/M output. Chrys does not report billing, so Worker A cost is an
// estimate built from real token usage at these rates.
const chrysCostRates = { inputPerMTokenUsd: 5, outputPerMTokenUsd: 25 };

interface Intervention {
  at: string;
  actor: string;
  action: string;
  detail: string;
}

function normalize(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function readSource(label: string, path: string): { label: string; text: string } {
  return { label, text: readFileSync(join(repoRoot, path), 'utf8') };
}

function prdExcerpt(): string {
  const lines = readFileSync(join(repoRoot, 'docs', 'prd', 'Counterpoint_复调_PRD_v0.1.md'), 'utf8').split(/\r?\n/);
  const first = lines.slice(606, 640);
  const second = lines.slice(858, 876);
  return ['# PRD excerpt (realtime & M1 scope)', '', '## Realtime', ...first, '', '## M1 scope', ...second].join('\n');
}

function claimRefs(positions: Position[], predicate: (statement: string, type: string) => boolean): string[] {
  return positions
    .flatMap((position) => position.claims)
    .filter((claim) => predicate(claim.statement, claim.type))
    .map((claim) => `claim:${claim.id}`);
}

function withClaimFallback(refs: string[], positions: Position[]): string[] {
  const unique = [...new Set(refs.length ? refs : positions.map((position) => `claim:${position.claims[0].id}`))];
  return unique;
}

function selectedRefsFor(
  recommendation: string,
  positions: Position[],
  reviewOrder: string[] | undefined,
): string[] {
  if (recommendation === 'merge') return positions.map((position) => `position:${position.id}`);
  if (recommendation === 'candidate_a' && reviewOrder?.[0]) return [`position:${reviewOrder[0]}`];
  if (recommendation === 'candidate_b' && reviewOrder?.[1]) return [`position:${reviewOrder[1]}`];
  return [];
}

function elapsedMs(started?: string, finished?: string): number | undefined {
  if (!started || !finished) return undefined;
  return new Date(finished).getTime() - new Date(started).getTime();
}

async function main(): Promise<void> {
  const startedAt = Date.now();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = join(repoRoot, 'data', 'out');
  const sliceDir = join(repoRoot, 'data', 'm1');
  mkdirSync(outDir, { recursive: true });
  mkdirSync(sliceDir, { recursive: true });
  const interventions: Intervention[] = [];
  const record = (action: string, detail: string) =>
    interventions.push({ at: new Date().toISOString(), actor: 'm1-operator', action, detail });

  const engine = new ProtocolEngine({
    store: new JsonFileStore(join(sliceDir, 'store.json')),
    workspaceRoot: join(sliceDir, 'workspaces'),
    seed,
    autoReveal: true,
    verifierConfig: {
      allowlist: ['node', 'git'],
      timeoutMs: 240_000,
      environmentRef: `counterpoint-repo@${repoRoot}`,
    },
    resolveAdapter: (participant) => {
      if (participant.role === 'worker') {
        if (participant.label === 'Worker A') {
          return new CliAgentAdapter({
            command: chrysBin,
            args: ['run', '-a', 'Code', '--json', '-t', '{promptFile}', '-C', '{workspace}'],
            outputMode: 'chrys_json',
            timeoutMs: 600_000,
            model: 'deepseek-v4-pro',
            provider: 'chrys/deepseek-openai',
            promptVersion: 'counterpoint-prompt-1',
            costEstimateRates: chrysCostRates,
          });
        }
        return new CliAgentAdapter({
          command: claudeBin,
          args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', workerBModel],
          outputMode: 'claude_jsonl',
          timeoutMs: 600_000,
          promptViaStdin: true,
          model: workerBModel,
          provider: 'claude-code/anthropic-deepseek',
          promptVersion: 'counterpoint-prompt-1',
        });
      }
      if (participant.role === 'reviewer') {
        return new CliReviewerAdapter({
          command: claudeBin,
          args: ['-p', '--output-format', 'json', '--dangerously-skip-permissions', '--model', reviewerModel],
          outputMode: 'claude_jsonl',
          timeoutMs: 600_000,
          promptViaStdin: true,
          model: reviewerModel,
          provider: 'claude-code/anthropic-deepseek',
          promptVersion: 'counterpoint-reviewer-prompt-1',
        });
      }
      return undefined;
    },
  });

  const project = engine.createProject({
    name: 'M1 Real Slice',
    description: 'First real technical decision review: Web Console realtime transport (SSE vs WebSocket vs polling)',
  });
  for (const source of [
    readSource('package_json', 'package.json'),
    readSource('api_server', 'apps/api/server.ts'),
    readSource('event_bus', 'apps/api/bus.ts'),
    readSource('web_use_deliberation', 'apps/web/src/hooks/useDeliberation.ts'),
    { label: 'prd_realtime_excerpt', text: prdExcerpt() },
  ]) {
    engine.addSourceBinding({ projectId: project.id, type: 'text', label: source.label, text: source.text });
  }

  const deliberation = engine.createDeliberation({
    projectId: project.id,
    ownerId: 'm1-operator',
    problem:
      'CounterPoint Web Console 当前通过 /api/stream（SSE）+ 5 秒轮询兜底获取实时状态。' +
      'M1 需要一个真实技术决策：实时更新通道应保持 SSE（现状）、改用 WebSocket，还是退化为纯轮询？',
    goals: [
      '提供近实时的状态/Timeline 更新（秒级延迟可接受）',
      '与单进程、本地优先（单文件 JSON 存储）架构匹配',
      '兼容现代浏览器与 React/Vite 前端栈',
      '断线、代理中断、休眠、服务器重启等场景有可测试的兜底',
    ],
    constraints: [
      '不引入外部基础设施（Redis、消息队列、第三方推送）',
      '尽量不新增运行时依赖；若必须新增，须给出理由',
      'REST POST 写路径保持不变',
      '单用户 local-first 部署，不需要跨进程广播',
      '保持 Node.js 内置 http 服务器，不更换框架',
    ],
    rubric: {
      items: [
        { id: 'fit', name: '架构契合度', description: '与单进程/本地优先/现有代码结构匹配', weight: 1 },
        { id: 'latency', name: '实时性', description: '状态与 Timeline 更新的端到端延迟', weight: 0.8 },
        { id: 'complexity', name: '实现与运维复杂度', description: '代码量、依赖、心智负担', weight: 0.8 },
        { id: 'reliability', name: '断线与兜底', description: '重连、恢复、不丢事件', weight: 0.8 },
        { id: 'testability', name: '可测试性', description: '能否用真实编译/测试/检索验证', weight: 0.6 },
      ],
      maxScore: 5,
    },
    deliverable: '一份 ADR 草稿：推荐方案、备选方案、理由、反证与生效条件',
    timeoutPolicy: { defaultMs: 600_000, maxEvidenceRounds: 1 },
  });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: 'Worker A' });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: 'Worker B' });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'reviewer', label: 'Reviewer' });
  engine.freezeTaskPacket(deliberation.id);
  record('freeze', `Task Packet frozen (${deliberation.id})`);

  console.log(`[slice] starting blind run with real agents: ${chrysBin} + ${claudeBin}`);
  await engine.startBlindRun(deliberation.id);

  let state = engine.getState(deliberation.id);
  const committedRuns = state.runs.filter((run) => run.status === 'committed');
  console.log(
    `[slice] blind run done: ${state.runs.map((run) => `${run.id}=${run.status}${run.error ? `(${run.error})` : ''}`).join(', ')}`,
  );
  if (committedRuns.length < 2) {
    throw new Error(`M1 slice needs two committed workers; got ${committedRuns.length}`);
  }

  const participants = state.participants;
  const runA = committedRuns.find(
    (run) => participants.find((item) => item.id === run.participantId)?.label === 'Worker A',
  )!;
  const runB = committedRuns.find(
    (run) => participants.find((item) => item.id === run.participantId)?.label === 'Worker B',
  )!;
  const positions = state.positions.filter((position) => position.status === 'committed');
  const positionA = positions.find((position) => position.runId === runA.id)!;
  const positionB = positions.find((position) => position.runId === runB.id)!;
  const targetClaim = positionB.claims[0];

  const challenge = engine.createChallenge({
    deliberationId: deliberation.id,
    targetRef: `claim:${targetClaim.id}`,
    authorRunId: runA.id,
    question:
      '在单进程、单文件存储下，如果服务器重启或 SSE 连接被代理/休眠中断，你的方案如何保证客户端不丢事件？请给出机制、恢复点与可验证条件。',
    requestedEvidence: '代码检索或测试证据',
  });
  const responseText = [
    `（响应由 m1-operator 依据 Worker B 已提交的 Position 整理）`,
    `方案要点：${positionB.summary}`,
    positionB.decisionConditions.length ? `生效条件：${positionB.decisionConditions.join('；')}` : '',
  ]
    .filter(Boolean)
    .join('\n');
  engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: runB.id,
    text: responseText,
  });
  record('challenge-response', `Challenge ${challenge.id} answered with Worker B committed position content`);
  engine.finalizeChallenges(deliberation.id);
  console.log(`[slice] state after challenge round: ${engine.getState(deliberation.id).state}`);

  const allPositions = [positionA, positionB];
  const scanRefs = claimRefs(allPositions, (statement, type) => {
    const text = normalize(statement);
    return (
      type !== 'unknown' &&
      /eventsource|sse|websocket|轮询|poll|stream|实时/.test(text)
    );
  });
  const buildRefs = claimRefs(allPositions, (statement, type) => {
    const text = normalize(statement);
    return (
      type === 'fact' ||
      type === 'design' ||
      /typecheck|compile|test|依赖|dependency|实现|server|运行/.test(text)
    );
  });
  const scanEvidenceRefs = withClaimFallback(scanRefs, allPositions);
  const buildEvidenceRefs = withClaimFallback([...scanRefs, ...buildRefs], allPositions);

  await engine.runVerification({
    deliberationId: deliberation.id,
    command: 'node',
    args: ['scripts/evidence-scan.mjs', 'SSE', 'EventSource', 'WebSocket', 'setInterval', '--', 'package.json', 'apps/api', 'apps/web', 'src'],
    cwd: repoRoot,
    targetRefs: scanEvidenceRefs,
    description: 'code search: existing realtime transport patterns (SSE/EventSource/WebSocket/polling)',
  });
  await engine.runVerification({
    deliberationId: deliberation.id,
    command: 'node',
    args: ['scripts/evidence-scan.mjs', 'text/event-stream', 'retry: 3000', 'heartbeat', 'EventSource', '--', 'apps/api', 'apps/web', 'src'],
    cwd: repoRoot,
    targetRefs: scanEvidenceRefs,
    description: 'code search: SSE endpoint specifics (event-stream, retry, heartbeat)',
  });
  await engine.runVerification({
    deliberationId: deliberation.id,
    command: 'node',
    args: [npmCli, 'run', 'typecheck'],
    cwd: repoRoot,
    targetRefs: buildEvidenceRefs,
    description: 'real TypeScript typecheck of the current repository',
  });
  await engine.runVerification({
    deliberationId: deliberation.id,
    command: 'node',
    args: [npmCli, 'test'],
    cwd: repoRoot,
    targetRefs: buildEvidenceRefs,
    description: 'real test suite (unit + integration + web)',
  });
  record('evidence', 'Selected and executed 4 real verification commands (2 code searches, typecheck, tests)');

  engine.freezeEvidencePack(deliberation.id);
  await engine.runReview(deliberation.id);
  state = engine.getState(deliberation.id);
  let review = state.reviews[state.reviews.length - 1];
  console.log(`[slice] reviewer: recommendation=${review.recommendation} sufficiency=${review.evidenceSufficiency}`);

  while (review.evidenceSufficiency === 'insufficient' && state.rounds.evidence < state.timeoutPolicy.maxEvidenceRounds) {
    engine.requestMoreEvidence({
      deliberationId: deliberation.id,
      rationale: 'Reviewer 证据不足：补充 Web 构建产物证据',
      ownerId: 'm1-operator',
    });
    record('evidence-round', 'Reviewer 判定 insufficient，进入补证轮');
    await engine.runVerification({
      deliberationId: deliberation.id,
      command: 'node',
      args: [npmCli, 'run', 'build:web'],
      cwd: repoRoot,
      targetRefs: buildEvidenceRefs,
      description: 'real production web build (vite build)',
    });
    engine.freezeEvidencePack(deliberation.id);
    await engine.runReview(deliberation.id);
    state = engine.getState(deliberation.id);
    review = state.reviews[state.reviews.length - 1];
  }

  const reviewOrder = state.reviewOrder;
  const recommendation = review.recommendation;
  const humanAction = recommendation === 'insufficient_evidence' || recommendation === 'no_decision' ? 'override' : 'approve';
  const selectedRefs =
    selectedRefsFor(recommendation, allPositions, reviewOrder) ??
    (humanAction === 'approve' ? [] : [`position:${positionA.id}`]);
  const finalSelectedRefs =
    selectedRefs.length > 0
      ? selectedRefs
      : humanAction === 'override'
        ? [`position:${positionA.id}`]
        : [];
  const decision = engine.humanDecision({
    deliberationId: deliberation.id,
    action: humanAction,
    rationale: `M1 operator gate: ${recommendation}. ${review.rationale}`,
    selectedRefs: finalSelectedRefs,
    conditions: [
      '上线前为 SSE 增加 last-event-id/EventSource 重放，验证重启不丢事件',
      '用真实浏览器会话做断线/休眠恢复测试',
      '若部署演进为多进程或多用户，重新评估 WebSocket/广播方案',
    ],
    ownerId: 'm1-operator',
  });
  record('human-gate', `Human gate ${humanAction}; recommendation=${recommendation}; decision=${decision.id}`);

  const pack = engine.exportDecisionPack(deliberation.id);
  const packMarkdownPath = join(outDir, `decision-pack-${deliberation.id}.md`);
  const packJsonPath = join(outDir, `decision-pack-${deliberation.id}.json`);
  writeFileSync(packMarkdownPath, decisionPackToMarkdown(pack), 'utf8');
  writeFileSync(packJsonPath, JSON.stringify(pack, null, 2), 'utf8');

  // -------------------------------------------------------------------------
  // Metrics
  // -------------------------------------------------------------------------
  state = engine.getState(deliberation.id);
  const verifiedTargets = new Set(
    state.evidence
      .filter((evidence: Evidence) => evidence.status === 'verified')
      .flatMap((evidence) => evidence.targetRefs.map((ref) => ref.replace(/^claim:/, ''))),
  );
  const counts = new Map<string, number>();
  for (const position of allPositions) {
    for (const claim of position.claims) counts.set(normalize(claim.statement), (counts.get(normalize(claim.statement)) ?? 0) + 1);
  }
  const uniqueClaims = allPositions
    .flatMap((position) =>
      position.claims
        .filter((claim) => counts.get(normalize(claim.statement)) === 1)
        .map((claim) => ({ positionId: position.id, claimId: claim.id, statement: claim.statement })),
    )
    .filter((item, index, array) => array.findIndex((other) => other.claimId === item.claimId) === index);
  const uniqueValidClaims = uniqueClaims.filter((item) => verifiedTargets.has(item.claimId));
  const allClaimIds = new Set(allPositions.flatMap((position) => position.claims.map((claim) => claim.id)));
  const coveredClaimIds = [...allClaimIds].filter((id) => verifiedTargets.has(id));
  const evidenceCoverage = allClaimIds.size ? coveredClaimIds.length / allClaimIds.size : 0;

  const runs = state.runs.map((run) => {
    const participant = state.participants.find((item) => item.id === run.participantId);
    const log = run.logsRef ? engine.deliberationDatabase.logs[run.logsRef] ?? '' : '';
    const usageMatch = /usage=(\{[^}]+\})/.exec(log);
    const durationMatch = /durationMs=(\d+)/.exec(log);
    let usage: { inputTokens?: number; outputTokens?: number } | undefined;
    if (usageMatch) {
      try {
        usage = JSON.parse(usageMatch[1]) as { inputTokens?: number; outputTokens?: number };
      } catch {
        usage = undefined;
      }
    }
    const costBasis = participant?.label === 'Worker A' ? 'estimated-token-based' : run.cost ? 'reported-by-cli' : 'n/a';
    const adapterElapsedMs = durationMatch ? Number(durationMatch[1]) : undefined;
    return {
      runId: run.id,
      participant: participant?.label ?? run.participantId,
      phase: run.phase,
      status: run.status,
      model: run.fingerprint?.model ?? 'unknown',
      provider: run.fingerprint?.provider ?? 'unknown',
      cost: run.cost ?? 0,
      costBasis,
      usage,
      elapsedMs: adapterElapsedMs ?? elapsedMs(run.startedAt, run.finishedAt),
      error: run.error ?? undefined,
    };
  });

  const totalCost = runs.reduce((sum, run) => sum + run.cost, 0);
  const report = {
    formatVersion: 'm1-slice-report/0.1.0',
    generatedAt: new Date().toISOString(),
    deliberationId: deliberation.id,
    task: {
      problem: engine.deliberationDatabase.taskPackets.find(
        (packet) => packet.id === deliberation.taskPacketId,
      )?.problem,
      state: state.state,
      seed,
    },
    agents: [
      { worker: 'Worker A', runtime: 'Chrys', model: 'deepseek-v4-pro', provider: 'chrys/deepseek-openai', costBasis: 'estimated-token-based' },
      { worker: 'Worker B', runtime: 'Claude Code', model: workerBModel, provider: 'claude-code/anthropic-deepseek', costBasis: 'reported-by-cli' },
      { worker: 'Reviewer', runtime: 'Claude Code', model: reviewerModel, provider: 'claude-code/anthropic-deepseek', costBasis: 'reported-by-cli', anonymity: 'randomized-anonymous-order' },
    ],
    metrics: {
      uniqueClaims: uniqueClaims.length,
      uniqueValidClaims: uniqueValidClaims.length,
      totalClaims: allClaimIds.size,
      evidenceCoverage: Number(evidenceCoverage.toFixed(4)),
      verifiedEvidenceCount: state.evidence.filter((evidence) => evidence.status === 'verified').length,
      contextLeaks: engine.auditBlindLeaks(deliberation.id).length,
      totalCostUsd: Number(totalCost.toFixed(6)),
      totalElapsedMs: Date.now() - startedAt,
      runs,
    },
    evidence: state.evidence.map((evidence) => ({
      id: evidence.id,
      kind: evidence.kind,
      status: evidence.status,
      command: evidence.source.command,
      args: evidence.source.args,
      description: evidence.source.description,
      exitCode: evidence.result.exitCode,
      targetRefs: evidence.targetRefs,
      summary: evidence.result.summary,
    })),
    review: {
      recommendation: review.recommendation,
      evidenceSufficiency: review.evidenceSufficiency,
      rubricScores: review.rubricScores,
      unresolvedRisks: review.unresolvedRisks,
      rationale: review.rationale,
      reviewOrder: reviewOrder ?? [],
      anonymousMapping: buildReviewerCandidates(allPositions, seed).candidates.map((candidate) => ({
        candidateId: candidate.candidateId,
        originalPositionId: candidate.originalPositionId,
      })),
    },
    decision: {
      humanAction: decision.humanAction,
      selectedRefs: decision.selectedRefs,
      conditions: decision.conditions,
      dissent: decision.dissent,
      rationale: decision.rationale,
    },
    humanInterventions: interventions,
    artifacts: {
      decisionPackMarkdown: packMarkdownPath,
      decisionPackJson: packJsonPath,
      store: join(sliceDir, 'store.json'),
    },
  };

  const reportJsonPath = join(sliceDir, `slice-report-${stamp}.json`);
  const reportMarkdownPath = join(sliceDir, `slice-report-${stamp}.md`);
  writeFileSync(reportJsonPath, JSON.stringify(report, null, 2), 'utf8');
  writeFileSync(reportMarkdownPath, renderReportMarkdown(report), 'utf8');

  console.log(`[slice] deliberation=${deliberation.id} state=${state.state}`);
  console.log(`[slice] decision=${decision.humanAction} recommendation=${recommendation}`);
  console.log(`[slice] metrics: unique=${uniqueClaims.length} valid=${uniqueValidClaims.length} coverage=${evidenceCoverage.toFixed(3)} cost=$${totalCost.toFixed(4)} elapsed=${Date.now() - startedAt}ms leaks=${report.metrics.contextLeaks}`);
  console.log(`[slice] decision pack: ${packMarkdownPath}`);
  console.log(`[slice] metrics report: ${reportMarkdownPath}`);
}

function renderReportMarkdown(report: unknown): string {
  const r = report as {
    generatedAt: string;
    deliberationId: string;
    agents: Array<{ worker: string; runtime: string; model: string; provider: string; costBasis: string }>;
    metrics: {
      uniqueClaims: number;
      uniqueValidClaims: number;
      totalClaims: number;
      evidenceCoverage: number;
      verifiedEvidenceCount: number;
      contextLeaks: number;
      totalCostUsd: number;
      totalElapsedMs: number;
      runs: Array<{
        participant: string;
        status: string;
        model: string;
        cost: number;
        costBasis: string;
        elapsedMs?: number;
        usage?: { inputTokens?: number; outputTokens?: number };
      }>;
    };
    review: {
      recommendation: string;
      evidenceSufficiency: string;
      rubricScores: Record<string, number>;
      unresolvedRisks: string[];
      anonymousMapping: Array<{ candidateId: string; originalPositionId: string }>;
    };
    decision: { humanAction: string; selectedRefs: string[]; conditions: string[] };
    humanInterventions: Array<{ at: string; actor: string; action: string; detail: string }>;
  };
  const lines: string[] = [];
  lines.push('# M1 Real Slice Report');
  lines.push('');
  lines.push(`Generated: ${r.generatedAt}`);
  lines.push(`Deliberation: ${r.deliberationId}`);
  lines.push('');
  lines.push('## Agents');
  lines.push('');
  lines.push('| Worker | Runtime | Model | Cost basis |');
  lines.push('|---|---|---|---|');
  for (const agent of r.agents) lines.push(`| ${agent.worker} | ${agent.runtime} | ${agent.model} | ${agent.costBasis} |`);
  lines.push('');
  lines.push('## Metrics');
  lines.push('');
  lines.push(`- Total claims: ${r.metrics.totalClaims}`);
  lines.push(`- Unique claims (appear in exactly one candidate): ${r.metrics.uniqueClaims}`);
  lines.push(`- Unique valid claims (unique + covered by verified evidence): ${r.metrics.uniqueValidClaims}`);
  lines.push(`- Evidence coverage (claims covered by verified evidence): ${r.metrics.evidenceCoverage}`);
  lines.push(`- Verified evidence records: ${r.metrics.verifiedEvidenceCount}`);
  lines.push(`- Context leaks: ${r.metrics.contextLeaks}`);
  lines.push(`- Total cost: $${r.metrics.totalCostUsd.toFixed(6)}`);
  lines.push(`- Total elapsed: ${r.metrics.totalElapsedMs}ms`);
  lines.push('');
  lines.push('### Runs');
  lines.push('');
  lines.push('| Participant | Status | Model | Cost (USD) | Basis | Elapsed (ms) |');
  lines.push('|---|---|---|---|---|---|');
  for (const run of r.metrics.runs) {
    const usage = run.usage ? `in=${run.usage.inputTokens ?? '?'} out=${run.usage.outputTokens ?? '?'}` : 'tokens=n/a';
    lines.push(`| ${run.participant} | ${run.status} | ${run.model} | ${run.cost.toFixed(6)} | ${run.costBasis} | ${run.elapsedMs ?? 'n/a'} (${usage}) |`);
  }
  lines.push('');
  lines.push('## Review');
  lines.push('');
  lines.push(`- Recommendation: ${r.review.recommendation}`);
  lines.push(`- Evidence sufficiency: ${r.review.evidenceSufficiency}`);
  lines.push(`- Rubric scores: ${JSON.stringify(r.review.rubricScores)}`);
  lines.push(`- Anonymous mapping: ${r.review.anonymousMapping.map((item) => `${item.candidateId}->${item.originalPositionId}`).join(', ')}`);
  if (r.review.unresolvedRisks.length) lines.push(`- Unresolved risks: ${r.review.unresolvedRisks.join('; ')}`);
  lines.push('');
  lines.push('## Decision (Human Gate)');
  lines.push('');
  lines.push(`- Action: ${r.decision.humanAction}`);
  lines.push(`- Selected refs: ${r.decision.selectedRefs.join(', ')}`);
  lines.push(`- Conditions: ${r.decision.conditions.join('; ')}`);
  lines.push('');
  lines.push('## Human Interventions');
  lines.push('');
  for (const item of r.humanInterventions) lines.push(`- ${item.at} [${item.action}] ${item.detail}`);
  lines.push('');
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(`[slice] FAILED: ${error instanceof Error ? error.stack : String(error)}`);
    process.exitCode = 1;
  });
}
