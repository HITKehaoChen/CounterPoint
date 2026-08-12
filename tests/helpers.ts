import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ProtocolEngine } from '../src/protocol-engine.ts';
import { InMemoryStore, JsonFileStore, type Store } from '../src/store.ts';
import { MockAgentAdapter, type MockAgentScript } from '../src/adapters/mock-agent.ts';
import { MockReviewerAdapter, type MockReviewerConfig } from '../src/adapters/mock-reviewer.ts';
import type { AgentAdapter } from '../src/adapters/agent.ts';
import type { ReviewerAdapter } from '../src/adapters/reviewer.ts';
import type { Deliberation, Event, Participant, Rubric } from '../src/schemas.ts';

export interface RunUpdate {
  deliberationId: string;
  runId: string;
  status: string;
  phase: string;
  error?: string;
}

export const DEFAULT_RUBRIC: Rubric = {
  items: [
    { id: 'correctness', name: 'Correctness', weight: 1 },
    { id: 'risk', name: 'Risk exposure', weight: 0.8 },
  ],
  maxScore: 5,
};

export interface HarnessOptions {
  seed?: string;
  autoReveal?: boolean;
  timeoutMs?: number;
  workspaceRoot?: string;
  store?: Store;
  onEvent?: (event: Event) => void;
  onRunUpdate?: (update: RunUpdate) => void;
}

export interface EngineHarness {
  engine: ProtocolEngine;
  store: Store;
  workers: Map<string, AgentAdapter>;
  reviewers: Map<string, ReviewerAdapter>;
  projectId: string;
  deliberationId: string;
}

export function createHarness(options: HarnessOptions = {}): EngineHarness {
  const store = options.store ?? new InMemoryStore();
  const workers = new Map<string, AgentAdapter>();
  const reviewers = new Map<string, ReviewerAdapter>();
  const workspaceRoot =
    options.workspaceRoot ?? mkdtempSync(join(tmpdir(), 'counterpoint-tests-'));
  const engine = new ProtocolEngine({
    store,
    seed: options.seed ?? 'test-seed',
    autoReveal: options.autoReveal ?? true,
    workspaceRoot,
    verifierConfig: {
      allowlist: ['node'],
      timeoutMs: options.timeoutMs ?? 30_000,
      environmentRef: 'test-env',
    },
    onEvent: options.onEvent,
    onRunUpdate: options.onRunUpdate,
    resolveAdapter: (participant: Participant) => {
      if (participant.role === 'worker') return workers.get(participant.id);
      if (participant.role === 'reviewer') return reviewers.get(participant.id);
      return undefined;
    },
  });
  return { engine, store, workers, reviewers, projectId: '', deliberationId: '' };
}

export interface SetupOptions {
  problem?: string;
  goal?: string;
  constraint?: string;
  sourceText?: string;
  rubric?: Rubric;
  timeoutPolicy?: Deliberation['timeoutPolicy'];
  workerA?: MockAgentScript;
  workerB?: MockAgentScript;
  reviewer?: MockReviewerConfig;
  registerAdapters?: boolean;
}

export interface SetupResult {
  projectId: string;
  deliberationId: string;
  workerAParticipantId: string;
  workerBParticipantId: string;
  reviewerParticipantId: string;
}

export function setupDeliberation(h: EngineHarness, options: SetupOptions = {}): SetupResult {
  const project = h.engine.createProject({ name: 'Test Project' });
  const source = h.engine.addSourceBinding({
    projectId: project.id,
    type: 'text',
    label: 'codebase',
    text: options.sourceText ?? 'module A: synchronous facade\nmodule B: event bus\nconstraints: no new infra',
  });
  const deliberation = h.engine.createDeliberation({
    projectId: project.id,
    ownerId: 'human-owner',
    problem: options.problem ?? 'Should the billing module call the ledger synchronously or via events?',
    goals: [options.goal ?? 'Choose an integration style that is testable and fault-tolerant'],
    constraints: [options.constraint ?? 'No new infrastructure; existing process boundaries must stay'],
    rubric: options.rubric ?? DEFAULT_RUBRIC,
    deliverable: 'ADR with conditions',
    timeoutPolicy: options.timeoutPolicy ?? { defaultMs: 5000, maxEvidenceRounds: 1 },
  });
  const workerA = h.engine.addParticipant({
    deliberationId: deliberation.id,
    role: 'worker',
    label: 'Worker A',
  });
  const workerB = h.engine.addParticipant({
    deliberationId: deliberation.id,
    role: 'worker',
    label: 'Worker B',
  });
  const reviewer = h.engine.addParticipant({
    deliberationId: deliberation.id,
    role: 'reviewer',
    label: 'Reviewer',
  });
  if (options.registerAdapters !== false) {
    h.workers.set(
      workerA.id,
      new MockAgentAdapter(() => options.workerA ?? defaultWorkerAScript()),
    );
    h.workers.set(
      workerB.id,
      new MockAgentAdapter(() => options.workerB ?? defaultWorkerBScript()),
    );
    h.reviewers.set(reviewer.id, new MockReviewerAdapter(options.reviewer ?? {}));
  }
  h.engine.freezeTaskPacket(deliberation.id);
  h.projectId = project.id;
  h.deliberationId = deliberation.id;
  return {
    projectId: project.id,
    deliberationId: deliberation.id,
    workerAParticipantId: workerA.id,
    workerBParticipantId: workerB.id,
    reviewerParticipantId: reviewer.id,
  };
}

export function defaultWorkerAScript(): MockAgentScript {
  return {
    summary: 'Use synchronous calls: simpler rollback and testability.',
    claims: [
      {
        id: 'a-1',
        statement: 'Synchronous calls preserve transactional rollback.',
        type: 'fact',
        confidence: 0.8,
      },
      {
        id: 'a-2',
        statement: 'Eventual consistency adds hidden failure modes.',
        type: 'risk',
        confidence: 0.7,
      },
    ],
    unknowns: ['Peak load is not measured'],
    decisionConditions: ['If P99 latency budget is below 50ms, revisit'],
    confidence: 0.7,
    artifacts: [
      {
        logicalName: 'design-a',
        type: 'markdown',
        content: '# Design A: synchronous\nUse RPC with retries.',
      },
    ],
    model: 'mock-model-a',
  };
}

export function defaultWorkerBScript(): MockAgentScript {
  return {
    summary: 'Use an event bus: decouples failure domains and scales.',
    claims: [
      {
        id: 'b-1',
        statement: 'Events decouple the ledger from downstream outages.',
        type: 'fact',
        confidence: 0.75,
      },
      {
        id: 'b-2',
        statement: 'Synchronous calls couple availability to the weakest link.',
        type: 'risk',
        confidence: 0.65,
      },
    ],
    unknowns: ['Exactly-once delivery semantics'],
    decisionConditions: ['If strong end-to-end consistency is a hard constraint, reassess'],
    confidence: 0.72,
    artifacts: [
      {
        logicalName: 'design-b',
        type: 'markdown',
        content: '# Design B: event-driven\nUse an outbox pattern.',
      },
    ],
    model: 'mock-model-b',
  };
}

export function cleanHarness(h: EngineHarness): void {
  if (h.store instanceof JsonFileStore) {
    const { rmSync } = require('node:fs') as typeof import('node:fs');
    const filePath = (h.store as unknown as { filePath: string }).filePath;
    if (filePath) rmSync(filePath, { force: true });
  }
}
