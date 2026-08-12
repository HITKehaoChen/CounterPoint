import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { InMemoryStore } from '../../src/store.ts';
import { MockAgentAdapter, type MockAgentScript } from '../../src/adapters/mock-agent.ts';
import { MockReviewerAdapter } from '../../src/adapters/mock-reviewer.ts';
import { LocalProcessAgentAdapter } from '../../src/adapters/local-process-agent.ts';
import { decisionPackToMarkdown } from '../../src/decision-pack.ts';

const workerAScript: MockAgentScript = {
  summary:
    'Keep the ledger call synchronous: transactional rollback stays local and tests stay simple.',
  claims: [
    {
      id: 'demo-a-1',
      statement: 'Synchronous calls preserve a single transaction boundary.',
      type: 'fact',
      evidenceRefs: [],
      confidence: 0.82,
    },
    {
      id: 'demo-a-2',
      statement: 'Eventual consistency would hide ordering failures behind retries.',
      type: 'risk',
      evidenceRefs: [],
      confidence: 0.7,
    },
  ],
  unknowns: ['Peak throughput is not measured in the repo snapshot'],
  decisionConditions: ['If the P99 latency budget is below 50ms, revisit the design'],
  confidence: 0.78,
  artifacts: [
    {
      logicalName: 'candidate-a-design',
      type: 'markdown',
      content: '# Candidate A: synchronous ledger call\n\n- Single transaction boundary\n- Retry with exponential backoff\n- Circuit breaker on ledger availability',
    },
  ],
  model: 'demo-model-a',
  provider: 'demo-provider',
};

export async function runDemo(options: { useLocalWorker?: boolean } = {}): Promise<{
  deliberationId: string;
  packMarkdownPath: string;
  packJsonPath: string;
}> {
  const store = new InMemoryStore();
  const engine = new ProtocolEngine({
    store,
    seed: 'demo-seed',
    workspaceRoot: join(process.cwd(), 'data', 'workspaces'),
    verifierConfig: {
      allowlist: ['node'],
      timeoutMs: 30_000,
      environmentRef: 'demo-local',
    },
    resolveAdapter: (participant) => {
      if (participant.role === 'worker') {
        if (participant.label === 'Worker A' && options.useLocalWorker) {
          return new LocalProcessAgentAdapter({
            command: 'node',
            args: [join(process.cwd(), 'apps', 'worker-sample.mjs')],
            timeoutMs: 30_000,
          });
        }
        return new MockAgentAdapter(() =>
          participant.label === 'Worker A'
            ? workerAScript
            : {
                summary:
                  'Move the ledger call onto the event bus: failure domains decouple and the write path scales independently.',
                claims: [
                  {
                    id: 'demo-b-1',
                    statement: 'Events decouple the ledger from downstream availability.',
                    type: 'fact',
                    evidenceRefs: [],
                    confidence: 0.76,
                  },
                  {
                    id: 'demo-b-2',
                    statement: 'A synchronous call couples uptime to the weakest downstream link.',
                    type: 'risk',
                    evidenceRefs: [],
                    confidence: 0.68,
                  },
                ],
                unknowns: ['Exactly-once delivery must be verified'],
                decisionConditions: [
                  'If strong end-to-end consistency is a hard requirement, reassess',
                ],
                confidence: 0.74,
                artifacts: [
                  {
                    logicalName: 'candidate-b-design',
                    type: 'markdown',
                    content: '# Candidate B: event-driven ledger call\n\n- Outbox pattern\n- Idempotent consumers\n- Dead-letter queue with alerting',
                  },
                ],
                model: 'demo-model-b',
                provider: 'demo-provider',
              },
        );
      }
      if (participant.role === 'reviewer') {
        return new MockReviewerAdapter({
          recommendation: 'candidate_a',
          rationale:
            'Both candidates are coherent. A wins on the verifiable constraint (single transaction boundary); B remains the fallback if scale targets change.',
          unresolvedRisks: ['Load testing evidence is not yet available'],
          evidenceSufficiency: 'partial',
        });
      }
      return undefined;
    },
  });

  const project = engine.createProject({
    name: 'Ledger integration demo',
    description: 'Demo deliberation: synchronous vs event-driven ledger call',
  });
  engine.addSourceBinding({
    projectId: project.id,
    type: 'text',
    label: 'repo_snapshot',
    text: 'billing service -> ledger (RPC)\nledger has retries; no outbox yet\np95 latency budget: 200ms',
  });
  const deliberation = engine.createDeliberation({
    projectId: project.id,
    ownerId: 'human-owner',
    problem: 'Should the billing module call the ledger synchronously or via events?',
    goals: ['Choose an integration that is testable, recoverable and matches current constraints'],
    constraints: ['No new infrastructure', 'Existing retry semantics must remain'],
    rubric: {
      items: [
        { id: 'correctness', name: 'Correctness under failure', weight: 1 },
        { id: 'fit', name: 'Fit with existing code', weight: 0.8 },
      ],
      maxScore: 5,
    },
    deliverable: 'ADR with conditions',
  });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: 'Worker A' });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'worker', label: 'Worker B' });
  engine.addParticipant({ deliberationId: deliberation.id, role: 'reviewer', label: 'Reviewer' });
  engine.freezeTaskPacket(deliberation.id);
  await engine.startBlindRun(deliberation.id);

  const state = engine.getState(deliberation.id);
  const committedRuns = state.runs.filter((run) => run.status === 'committed');
  const runA = committedRuns[0];
  const runB = committedRuns[1];
  if (!runA || !runB) {
    throw new Error(
      `Demo requires two committed workers; got: ${state.runs.map((run) => `${run.id}=${run.status}${run.error ? `(${run.error})` : ''}`).join(', ')}`,
    );
  }
  const targetClaim = state.positions
    .find((position) => position.runId === runB.id)!
    .claims[0];
  const challenge = engine.createChallenge({
    deliberationId: deliberation.id,
    targetRef: `claim:${targetClaim.id}`,
    authorRunId: runA.id,
    question: 'What is the delivery guarantee under a ledger outage?',
  });
  engine.respondToChallenge({
    challengeId: challenge.id,
    authorRunId: runB.id,
    text: 'At-least-once via outbox with idempotent consumers; duplicate ledger posts are filtered by idempotency key.',
    evidenceRefs: [],
  });

  await engine.runVerification({
    deliberationId: deliberation.id,
    command: 'node',
    args: ['-e', 'console.log("idempotency probe: pass")'],
    targetRefs: [`claim:${targetClaim.id}`],
    description: 'idempotency probe',
  });
  engine.freezeEvidencePack(deliberation.id);
  await engine.runReview(deliberation.id);
  engine.humanDecision({
    deliberationId: deliberation.id,
    action: 'approve',
    rationale: 'Approve Candidate A; revisit if scale targets are revised.',
    conditions: ['Run a load test before production rollout'],
    ownerId: 'human-owner',
  });

  const pack = engine.exportDecisionPack(deliberation.id);
  const outDir = join(process.cwd(), 'data', 'out');
  mkdirSync(outDir, { recursive: true });
  const packMarkdownPath = join(outDir, 'decision-pack.md');
  const packJsonPath = join(outDir, 'decision-pack.json');
  writeFileSync(packMarkdownPath, decisionPackToMarkdown(pack), 'utf8');
  writeFileSync(packJsonPath, JSON.stringify(pack, null, 2), 'utf8');
  return { deliberationId: deliberation.id, packMarkdownPath, packJsonPath };
}

async function main() {
  const useLocalWorker = process.argv.includes('--local');
  const result = await runDemo({ useLocalWorker });
  console.log(`Deliberation: ${result.deliberationId}`);
  console.log(`Decision Pack Markdown: ${result.packMarkdownPath}`);
  console.log(`Decision Pack JSON: ${result.packJsonPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main();
}
