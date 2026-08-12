import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  AgentRun,
  Challenge,
  ContextView,
  Database,
  Decision,
  Deliberation,
  Event,
  Evidence,
  EvidenceRequest,
  Participant,
  Position,
  Project,
  Response,
  Review,
  SourceBinding,
  TaskPacket,
} from './schemas.ts';
import { emptyDatabase } from './schemas.ts';
import { formatVersionRef, hashJson, parseVersionRef, sha256 } from './hashing.ts';
import { newId } from './ids.ts';
import { appendEvent } from './events.ts';
import { ArtifactRegistry, type ResolvedArtifactVersion } from './artifact-registry.ts';
import {
  buildContextView,
  buildReviewerCandidates,
  findBlindLeaks,
  redactEvidenceForReviewer,
  type ReviewerCandidate,
} from './context-policy.ts';
import {
  assertLegalTransition,
  guardTransition,
} from './state-machine.ts';
import type { AgentAdapter, AgentRunResult } from './adapters/agent.ts';
import type { ReviewerAdapter, ReviewerRunResult } from './adapters/reviewer.ts';
import type { Store } from './store.ts';
import { JsonFileStore } from './store.ts';
import { WorkspaceManager } from './workspace.ts';
import { EvidenceLedger, type CommandVerifierConfig } from './verifier.ts';
import { exportDecisionPack, type DecisionPack } from './decision-pack.ts';

export interface EngineOptions {
  store: Store;
  resolveAdapter: (participant: Participant) => AgentAdapter | ReviewerAdapter | undefined;
  verifierConfig?: CommandVerifierConfig;
  workspaceRoot?: string;
  now?: () => Date;
  seed?: string;
  autoReveal?: boolean;
  /** Called for every appended protocol event (used by the Web Console SSE bus). */
  onEvent?: (event: Event) => void;
  /** Called whenever an AgentRun status changes (running/committed/failed/...). */
  onRunUpdate?: (update: RunUpdate) => void;
}

export interface RunUpdate {
  deliberationId: string;
  runId: string;
  status: AgentRun['status'];
  phase: string;
  error?: string;
}

export interface CreateProjectInput {
  name: string;
  description?: string;
}

export interface AddSourceInput {
  projectId: string;
  type: SourceBinding['type'];
  label: string;
  path?: string;
  text?: string;
}

export interface CreateDeliberationInput {
  projectId: string;
  ownerId: string;
  problem: string;
  goals: string[];
  constraints: string[];
  rubric: TaskPacket['rubric'];
  deliverable?: string;
  timeoutPolicy?: Deliberation['timeoutPolicy'];
}

export interface AddParticipantInput {
  deliberationId: string;
  role: Participant['role'];
  label?: string;
  adapterConfig?: Record<string, unknown>;
}

export interface ChallengeInput {
  deliberationId: string;
  targetRef: string;
  authorRunId: string;
  question: string;
  requestedEvidence?: string;
}

export interface ResponseInput {
  challengeId: string;
  authorRunId: string;
  text: string;
  concession?: boolean;
  evidenceRefs?: string[];
}

export interface HumanDecisionInput {
  deliberationId: string;
  action: Decision['humanAction'];
  rationale: string;
  selectedRefs?: string[];
  conditions?: string[];
  dissent?: string[];
  ownerId: string;
}

export interface VisibleObjects {
  authoritySources: Array<{ ref: string; binding: SourceBinding; content?: string }>;
  artifacts: ResolvedArtifactVersion[];
  claims: Array<{ claimId: string; positionId: string; statement: string; type: string; evidenceRefs: string[] }>;
  evidence: Evidence[];
  candidates?: ReviewerCandidate[];
}

/**
 * Protocol Engine (PRD sections 6, 8, 11; ADR-002/003/004).
 *
 * Owns the deterministic state machine, transition guards, round limits,
 * Commit-Reveal, isolation workspaces, evidence ledger, anonymous review and
 * the human gate. Agent adapters are injected so the engine is provider-
 * agnostic; state and events are persisted through the Store on every mutation.
 */
export class ProtocolEngine {
  private readonly options: EngineOptions;
  private readonly db: Database;
  private readonly workspaceManager: WorkspaceManager;
  private readonly registry: ArtifactRegistry;
  private readonly now: () => Date;
  private readonly seed: string;
  private readonly autoReveal: boolean;
  private readonly verifierConfig: CommandVerifierConfig;

  constructor(options: EngineOptions) {
    this.options = options;
    this.db = this.loadDatabase(options.store);
    this.workspaceManager = new WorkspaceManager(options.workspaceRoot ?? join(process.cwd(), 'data', 'workspaces'));
    this.registry = new ArtifactRegistry(this.db);
    this.now = options.now ?? (() => new Date());
    this.seed = options.seed ?? 'counterpoint-default-seed';
    this.autoReveal = options.autoReveal ?? true;
    this.verifierConfig = options.verifierConfig ?? {
      allowlist: ['node', 'npm', 'git', 'python', 'rg'],
      timeoutMs: 30_000,
      environmentRef: 'local',
    };
  }

  // -------------------------------------------------------------------------
  // Projects and sources
  // -------------------------------------------------------------------------

  createProject(input: CreateProjectInput): Project {
    const project: Project = {
      id: newId('prj'),
      name: input.name,
      description: input.description,
      sourceBindings: [],
      createdAt: this.now().toISOString(),
    };
    this.db.projects.push(project);
    this.mutate(`project.created ${project.name}`, {
      type: 'project.created',
      actor: 'system',
      objectRef: project.id,
      payload: { projectId: project.id, name: project.name },
    });
    this.persist();
    return project;
  }

  getProject(projectId: string): Project {
    const project = this.db.projects.find((item) => item.id === projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    return project;
  }

  archiveProject(projectId: string): Project {
    const project = this.getProject(projectId);
    project.archivedAt = this.now().toISOString();
    this.mutate(`project.archived ${projectId}`, {
      type: 'project.archived',
      actor: 'human-owner',
      objectRef: projectId,
    });
    this.persist();
    return project;
  }

  addSourceBinding(input: AddSourceInput): SourceBinding {
    const project = this.getProject(input.projectId);
    let content = input.text ?? '';
    if ((input.type === 'file' || input.type === 'directory') && input.path) {
      content = snapshotPath(input.path, input.type);
    }
    if (input.type === 'file' && input.path) {
      content = readFileSync(input.path, 'utf8');
    }
    if (input.type === 'directory' && input.path) {
      content = snapshotDirectory(input.path);
    }
    if (!content.trim() && input.type !== 'git') {
      throw new Error('Source binding must have text or a readable file/directory path');
    }
    const binding: SourceBinding = {
      id: `src_${slugify(input.label)}`,
      type: input.type,
      label: input.label,
      path: input.path,
      text: content || undefined,
      version: 1,
      snapshotHash: sha256(content || input.label),
    };
    project.sourceBindings.push(binding);
    this.registry.publish({
      logicalName: binding.id,
      type: 'text',
      content: content || input.label,
      visibility: 'shared',
      dependencies: [],
    });
    this.mutate(`source.added ${binding.id}`, {
      type: 'source.added',
      actor: 'human-owner',
      objectRef: project.id,
      payload: { sourceId: binding.id, snapshotHash: binding.snapshotHash, version: 1 },
    });
    this.persist();
    return binding;
  }

  // -------------------------------------------------------------------------
  // Deliberation lifecycle
  // -------------------------------------------------------------------------

  createDeliberation(input: CreateDeliberationInput): Deliberation {
    const project = this.getProject(input.projectId);
    const packet: TaskPacket = {
      id: newId('tp'),
      version: 1,
      problem: input.problem,
      goals: input.goals,
      constraints: input.constraints,
      rubric: input.rubric,
      sources: project.sourceBindings.map((binding) => binding.id),
      deliverable: input.deliverable,
    };
    this.db.taskPackets.push(packet);
    const deliberation: Deliberation = {
      id: newId('delib'),
      projectId: project.id,
      protocolVersion: '0.1.0',
      state: 'draft',
      taskPacketId: packet.id,
      ownerId: input.ownerId,
      participants: [],
      runs: [],
      positions: [],
      challenges: [],
      responses: [],
      evidenceRequests: [],
      evidence: [],
      reviews: [],
      decisions: [],
      rounds: { challenge: 0, evidence: 0 },
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      timeoutPolicy: input.timeoutPolicy ?? { defaultMs: 120_000, maxEvidenceRounds: 1 },
    };
    this.db.deliberations.push(deliberation);
    this.addParticipant({ deliberationId: deliberation.id, role: 'human', label: 'Human Owner' });
    this.mutate(`deliberation.created ${deliberation.id}`, {
      type: 'deliberation.created',
      actor: input.ownerId,
      objectRef: deliberation.id,
      payload: { projectId: project.id, packetId: packet.id },
    });
    this.persist();
    return deliberation;
  }

  addParticipant(input: AddParticipantInput): Participant {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (!['draft', 'frozen'].includes(deliberation.state)) {
      throw new Error(`Participants can only be added in draft or frozen, not ${deliberation.state}`);
    }
    const participant: Participant = {
      id: newId(`part_${input.role}`),
      deliberationId: deliberation.id,
      role: input.role,
      label: input.label,
      adapterConfig: input.adapterConfig,
    };
    deliberation.participants.push(participant);
    this.mutate(`participant.added ${participant.id}`, {
      type: 'participant.added',
      actor: deliberation.ownerId,
      objectRef: deliberation.id,
      payload: { participantId: participant.id, role: participant.role, label: participant.label },
    });
    this.persist();
    return participant;
  }

  getTaskPacket(deliberationId: string): TaskPacket {
    const deliberation = this.requireDeliberation(deliberationId);
    const packet = this.db.taskPackets.find((item) => item.id === deliberation.taskPacketId);
    if (!packet) throw new Error(`Task Packet missing for ${deliberationId}`);
    return packet;
  }

  freezeTaskPacket(deliberationId: string): TaskPacket {
    const deliberation = this.requireDeliberation(deliberationId);
    if (deliberation.state !== 'draft') {
      throw new Error(`Task Packet can only be frozen in draft state, not ${deliberation.state}`);
    }
    const packet = this.getTaskPacket(deliberationId);
    const project = this.getProject(deliberation.projectId);
    const missing: string[] = [];
    if (!packet.problem.trim()) missing.push('problem');
    if (!packet.goals.length) missing.push('goals');
    if (!packet.constraints.length) missing.push('constraints');
    if (!packet.rubric.items.length) missing.push('rubric');
    if (!packet.sources.length) missing.push('sources');
    if (!deliberation.ownerId) missing.push('owner');
    if (missing.length) {
      throw new Error(`Task Packet incomplete, missing: ${missing.join(', ')}`);
    }
    packet.hash = hashJson({
      id: packet.id,
      version: packet.version,
      problem: packet.problem,
      goals: packet.goals,
      constraints: packet.constraints,
      rubric: packet.rubric,
      sources: packet.sources.map((sourceId) => {
        const binding = project.sourceBindings.find((item) => item.id === sourceId);
        return formatVersionRef(sourceId, binding?.version ?? 1);
      }),
      deliverable: packet.deliverable ?? null,
    });
    packet.frozenAt = this.now().toISOString();
    const violations = guardTransition('draft', 'frozen', {
      deliberation,
      taskPacket: packet,
    });
    if (violations.length) throw new Error(`Cannot freeze: ${violations.join('; ')}`);
    this.transition(deliberation, 'frozen', `Task Packet v${packet.version} frozen (hash ${packet.hash.slice(0, 12)})`, {
      type: 'task_packet.frozen',
      actor: deliberation.ownerId,
      objectRef: deliberation.id,
      payload: { packetId: packet.id, version: packet.version, hash: packet.hash, sources: packet.sources },
    });
    this.persist();
    return packet;
  }

  async startBlindRun(deliberationId: string): Promise<Deliberation> {
    const deliberation = this.requireDeliberation(deliberationId);
    if (deliberation.state !== 'frozen') {
      throw new Error(`Blind run can only start from frozen state, not ${deliberation.state}`);
    }
    const packet = this.getTaskPacket(deliberationId);
    const project = this.getProject(deliberation.projectId);
    const workers = deliberation.participants.filter((participant) => participant.role === 'worker');
    if (workers.length < 2) throw new Error('At least 2 worker participants are required');

    const runs: AgentRun[] = [];
    for (const worker of workers) {
      const runId = newId('run');
      const workspacePath = this.workspaceManager.createRunWorkspace(deliberation.id, runId);
      runs.push({
        id: runId,
        participantId: worker.id,
        phase: 'blind_run',
        status: 'pending',
        workspacePath,
        startedAt: this.now().toISOString(),
      });
    }
    deliberation.runs.push(...runs);
    this.guardTransition('frozen', 'blind_run', deliberation);
    this.transition(deliberation, 'blind_run', `Blind run started with ${runs.length} isolated workers`, {
      type: 'blind_run.started',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: { runIds: runs.map((run) => run.id), workspacePaths: runs.map((run) => run.workspacePath) },
    });
    this.persist();

    const authoritySources = packet.sources
      .map((sourceId) => project.sourceBindings.find((binding) => binding.id === sourceId))
      .filter((binding): binding is SourceBinding => Boolean(binding))
      .map((binding) => ({
        ref: formatVersionRef(binding.id, binding.version),
        binding,
        content: binding.text,
      }));
    const authorityArtifactRefs = packet.sources.map((sourceId) => formatVersionRef(sourceId, 1));

    for (const run of runs) {
      this.workspaceManager.writeSources(
        run.workspacePath!,
        authoritySources.map((source) => ({ id: source.binding.id, label: source.binding.label, content: source.content ?? '' })),
      );
      const view = buildContextView({
        deliberation,
        viewerRunId: run.id,
        role: 'worker',
        phase: deliberation.state,
        authoritySources: authoritySources.map((source) => source.ref),
        authorityArtifactRefs,
        candidateArtifactRefs: [],
        seed: this.seed,
      });
      run.contextViewId = view.id;
      this.db.contextViews.push(view);
      run.status = 'running';
      this.emitRunUpdate(deliberation, run);
    }
    this.persist();

    const results = await Promise.allSettled(
      runs.map(async (run) => {
        const worker = deliberation.participants.find((participant) => participant.id === run.participantId)!;
        const adapter = this.options.resolveAdapter(worker);
        if (!adapter) throw new Error(`No adapter resolved for participant ${worker.id} (${worker.label ?? worker.role})`);
        return this.runAgent(adapter as AgentAdapter, run, worker, authoritySources, deliberation.timeoutPolicy.defaultMs);
      }),
    );

    for (let i = 0; i < runs.length; i++) {
      const run = runs[i];
      if (run.status === 'cancelled') {
        // Cancelled while the adapter was running: the late result is ignored
        // and the cancellation record is preserved.
        continue;
      }
      const result = results[i];
      if (result.status === 'fulfilled') {
        this.commitRunResult(deliberation, run, result.value);
      } else {
        this.failRun(deliberation, run, result.reason);
      }
      this.persist();
      this.emitRunUpdate(deliberation, run);
    }
    this.persist();
    this.maybeTransitionToCommitted(deliberation);
    return deliberation;
  }

  reveal(deliberationId: string): Deliberation {
    const deliberation = this.requireDeliberation(deliberationId);
    this.guardTransition('committed', 'revealed', deliberation);
    this.assertLegal('committed', 'revealed');
    const positions = committedPositions(deliberation);
    deliberation.candidateOrder = positions.map((position) => position.id);
    this.transition(deliberation, 'revealed', `Simultaneous reveal of ${positions.length} candidate(s)`, {
      type: 'candidates.revealed',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: {
        candidateOrder: deliberation.candidateOrder,
        commitmentHashes: positions.map((position) => position.commitmentHash),
      },
    });
    deliberation.rounds.challenge = 1;
    this.transition(deliberation, 'challenging', 'Challenge round 1 opened', {
      type: 'challenging.started',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: { round: deliberation.rounds.challenge },
    });
    this.persist();
    return deliberation;
  }

  createChallenge(input: ChallengeInput): Challenge {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (!['revealed', 'challenging'].includes(deliberation.state)) {
      throw new Error(`Challenges require revealed/challenging state, not ${deliberation.state}`);
    }
    this.assertTargetRef(deliberation, input.targetRef);
    const author = deliberation.runs.find((run) => run.id === input.authorRunId);
    if (!author || author.status !== 'committed') {
      throw new Error(`Challenge author must be a committed run: ${input.authorRunId}`);
    }
    const authored = deliberation.challenges.filter((item) => item.authorRunId === input.authorRunId).length;
    if (authored >= 5) throw new Error(`Challenge limit reached for ${input.authorRunId}`);
    const challenge: Challenge = {
      id: newId('chl'),
      deliberationId: deliberation.id,
      targetRef: input.targetRef,
      authorRunId: input.authorRunId,
      question: input.question,
      requestedEvidence: input.requestedEvidence,
      status: 'open',
      createdAt: this.now().toISOString(),
    };
    deliberation.challenges.push(challenge);
    this.mutate(`challenge.created ${challenge.id}`, {
      type: 'challenge.created',
      actor: input.authorRunId,
      objectRef: deliberation.id,
      payload: { challengeId: challenge.id, targetRef: challenge.targetRef, question: challenge.question },
    });
    this.persist();
    return challenge;
  }

  respondToChallenge(input: ResponseInput): Response {
    const deliberationId = this.findDeliberationForChallenge(input.challengeId);
    if (!deliberationId) throw new Error(`Challenge not found: ${input.challengeId}`);
    const deliberation = this.requireDeliberation(deliberationId);
    const challenge = deliberation.challenges.find((item) => item.id === input.challengeId);
    if (!challenge) throw new Error(`Challenge not found: ${input.challengeId}`);
    const targetRun = this.resolveChallengeTargetRun(deliberation, challenge);
    if (targetRun !== input.authorRunId) {
      throw new Error(`Only the challenged candidate run may respond (expected ${targetRun}, got ${input.authorRunId})`);
    }
    for (const ref of input.evidenceRefs ?? []) {
      if (!deliberation.evidence.some((item) => item.id === ref)) {
        throw new Error(`Response references unknown evidence: ${ref}`);
      }
    }
    const response: Response = {
      id: newId('rsp'),
      challengeId: challenge.id,
      authorRunId: input.authorRunId,
      text: input.text,
      concession: input.concession ?? false,
      evidenceRefs: input.evidenceRefs ?? [],
      createdAt: this.now().toISOString(),
    };
    deliberation.responses.push(response);
    challenge.status = 'answered';
    this.mutate(`challenge.answered ${challenge.id}`, {
      type: 'challenge.answered',
      actor: input.authorRunId,
      objectRef: deliberation.id,
      payload: { challengeId: challenge.id, responseId: response.id, concession: response.concession },
    });
    this.persist();
    this.maybeAdvanceFromChallenging(deliberation);
    return response;
  }

  createEvidenceRequest(input: {
    deliberationId: string;
    challengeId?: string;
    assignee: EvidenceRequest['assignee'];
    question: string;
  }): EvidenceRequest {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (!['challenging', 'verifying', 'reviewing'].includes(deliberation.state)) {
      throw new Error(`Evidence requests require challenging/verifying/reviewing state, not ${deliberation.state}`);
    }
    if (input.challengeId) {
      const challenge = deliberation.challenges.find((item) => item.id === input.challengeId);
      if (!challenge) throw new Error(`Challenge not found: ${input.challengeId}`);
      if (challenge.status === 'open') challenge.status = 'evidence_requested';
    }
    const request: EvidenceRequest = {
      id: newId('req'),
      deliberationId: deliberation.id,
      challengeId: input.challengeId,
      assignee: input.assignee,
      question: input.question,
      status: 'pending',
      createdAt: this.now().toISOString(),
    };
    deliberation.evidenceRequests.push(request);
    this.mutate(`evidence_request.created ${request.id}`, {
      type: 'evidence_request.created',
      actor: input.assignee === 'human' ? 'human-owner' : 'protocol-engine',
      objectRef: deliberation.id,
      payload: { requestId: request.id, challengeId: request.challengeId ?? null, assignee: request.assignee, question: request.question },
    });
    this.persist();
    return request;
  }

  fulfillEvidenceRequest(requestId: string, evidenceId: string): EvidenceRequest {
    const deliberation = this.findDeliberationWithRequest(requestId);
    if (!deliberation) throw new Error(`Evidence request not found: ${requestId}`);
    const request = deliberation.evidenceRequests.find((item) => item.id === requestId);
    if (!request) throw new Error(`Evidence request not found: ${requestId}`);
    const evidence = deliberation.evidence.find((item) => item.id === evidenceId);
    if (!evidence) throw new Error(`Evidence not found: ${evidenceId}`);
    request.status = 'fulfilled';
    this.mutate(`evidence_request.fulfilled ${requestId}`, {
      type: 'evidence_request.fulfilled',
      actor: evidence.kind === 'manual' ? 'human-owner' : 'verifier',
      objectRef: deliberation.id,
      payload: { requestId, evidenceId, evidenceStatus: evidence.status },
    });
    this.persist();
    this.maybeAdvanceFromChallenging(deliberation);
    return request;
  }

  finalizeChallenges(deliberationId: string): Deliberation {
    const deliberation = this.requireDeliberation(deliberationId);
    if (deliberation.state !== 'challenging') return deliberation;
    this.maybeAdvanceFromChallenging(deliberation);
    return deliberation;
  }

  // -------------------------------------------------------------------------
  // Verification
  // -------------------------------------------------------------------------

  async runVerification(input: {
    deliberationId: string;
    command: string;
    args: string[];
    cwd?: string;
    targetRefs: string[];
    expectedExitCode?: number;
    description?: string;
  }): Promise<Evidence> {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (deliberation.state !== 'verifying') {
      throw new Error(`Verification requires verifying state, not ${deliberation.state}`);
    }
    const ledger = new EvidenceLedger(deliberation, this.db, this.verifierConfig);
    const evidence = await ledger.runCommandVerifier({
      command: input.command,
      args: input.args,
      cwd: input.cwd,
      targetRefs: input.targetRefs,
      expectedExitCode: input.expectedExitCode,
      description: input.description,
    });
    this.mutate(`evidence.recorded ${evidence.id}`, {
      type: 'evidence.recorded',
      actor: 'verifier',
      objectRef: deliberation.id,
      payload: { evidenceId: evidence.id, status: evidence.status, targetRefs: evidence.targetRefs },
    });
    this.persist();
    return evidence;
  }

  addEvidence(input: {
    deliberationId: string;
    targetRefs: string[];
    status: Evidence['status'];
    resultSummary: string;
    kind?: Evidence['kind'];
    sourceDescription?: string;
    reproducibility?: Evidence['reproducibility'];
  }): Evidence {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (!['challenging', 'verifying', 'reviewing'].includes(deliberation.state)) {
      throw new Error(`Evidence requires challenging/verifying/reviewing state, not ${deliberation.state}`);
    }
    const ledger = new EvidenceLedger(deliberation, this.db, this.verifierConfig);
    const evidence = ledger.addSubmission({
      targetRefs: input.targetRefs,
      status: input.status,
      resultSummary: input.resultSummary,
      kind: input.kind,
      sourceDescription: input.sourceDescription,
      reproducibility: input.reproducibility,
    });
    this.mutate(`evidence.recorded ${evidence.id}`, {
      type: 'evidence.recorded',
      actor: input.kind === 'manual' ? 'human-owner' : 'verifier',
      objectRef: deliberation.id,
      payload: { evidenceId: evidence.id, status: evidence.status, targetRefs: evidence.targetRefs },
    });
    this.persist();
    return evidence;
  }

  freezeEvidencePack(deliberationId: string): Deliberation {
    const deliberation = this.requireDeliberation(deliberationId);
    this.guardTransition('verifying', 'reviewing', deliberation);
    this.assertLegal('verifying', 'reviewing');
    this.transition(deliberation, 'reviewing', 'Evidence pack frozen for independent review', {
      type: 'evidence_pack.frozen',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: {
        evidenceIds: deliberation.evidence.map((item) => item.id),
        statuses: Object.fromEntries(deliberation.evidence.map((item) => [item.id, item.status])),
      },
    });
    this.persist();
    return deliberation;
  }

  // -------------------------------------------------------------------------
  // Review and human gate
  // -------------------------------------------------------------------------

  async runReview(deliberationId: string): Promise<Review> {
    const deliberation = this.requireDeliberation(deliberationId);
    if (deliberation.state !== 'reviewing') {
      throw new Error(`Review requires reviewing state, not ${deliberation.state}`);
    }
    const reviewer = deliberation.participants.find((participant) => participant.role === 'reviewer');
    if (!reviewer) throw new Error('No reviewer participant configured');
    const adapter = this.options.resolveAdapter(reviewer);
    if (!adapter || typeof (adapter as ReviewerAdapter).review !== 'function') {
      throw new Error('Reviewer adapter unavailable; use submitReview manually');
    }

    const runId = newId('run');
    const positions = committedPositions(deliberation);
    const { candidates, order } = buildReviewerCandidates(positions, this.seed);
    deliberation.reviewOrder = order;
    const view = buildContextView({
      deliberation,
      viewerRunId: runId,
      role: 'reviewer',
      phase: 'reviewing',
      authoritySources: this.authoritySourceRefs(deliberation),
      authorityArtifactRefs: this.authorityArtifactRefs(deliberation),
      candidateArtifactRefs: this.candidateArtifactRefs(deliberation),
      seed: this.seed,
    });
    this.db.contextViews.push(view);
    const run: AgentRun = {
      id: runId,
      participantId: reviewer.id,
      phase: 'reviewing',
      contextViewId: view.id,
      status: 'running',
      startedAt: this.now().toISOString(),
    };
    deliberation.runs.push(run);
    this.persist();
    this.emitRunUpdate(deliberation, run);
    const result = await this.runReviewerAdapter(
      adapter as ReviewerAdapter,
      run,
      deliberation,
      candidates,
    );
    const review = this.storeReview(deliberation, run, result);
    this.persist();
    this.emitRunUpdate(deliberation, run);
    return review;
  }

  submitReview(input: {
    deliberationId: string;
    reviewerRunId: string;
    review: ReviewerRunResult;
  }): Review {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (deliberation.state !== 'reviewing') {
      throw new Error(`Review requires reviewing state, not ${deliberation.state}`);
    }
    const run = deliberation.runs.find((item) => item.id === input.reviewerRunId);
    if (!run) throw new Error(`Reviewer run not found: ${input.reviewerRunId}`);
    const review = this.storeReview(deliberation, run, input.review);
    this.persist();
    return review;
  }

  humanDecision(input: HumanDecisionInput): Decision {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (!['reviewing', 'escalated'].includes(deliberation.state)) {
      throw new Error(`Human decision requires reviewing/escalated state, not ${deliberation.state}`);
    }

    if (!['approve', 'override', 'merge', 'no_decision'].includes(input.action)) {
      throw new Error(`Invalid human action: ${input.action}`);
    }
    const review = deliberation.reviews[deliberation.reviews.length - 1];
    if (input.action !== 'no_decision' && !review) {
      throw new Error('Reviewer verdict required before human decision');
    }
    let selectedRefs = input.selectedRefs ?? [];
    if (input.action === 'approve' && review && !selectedRefs.length) {
      selectedRefs = this.refsForRecommendation(deliberation, review.recommendation);
    }
    if (input.action === 'approve' && !selectedRefs.length) {
      throw new Error('Approval requires a resolvable recommendation or explicit refs');
    }
    const decision: Decision = {
      id: newId('dec'),
      deliberationId: deliberation.id,
      selectedRefs,
      rationale: input.rationale,
      conditions: input.conditions ?? [],
      dissent: input.dissent ?? (review ? review.unresolvedRisks : []),
      humanAction: input.action,
      decidedAt: this.now().toISOString(),
      ownerId: input.ownerId,
    };
    deliberation.decisions.push(decision);
    this.transition(deliberation, 'decided', `Human decision: ${input.action}`, {
      type: 'decision.recorded',
      actor: input.ownerId,
      objectRef: deliberation.id,
      payload: {
        decisionId: decision.id,
        humanAction: input.action,
        selectedRefs,
        rationale: input.rationale,
      },
    });
    this.persist();
    return decision;
  }

  escalateToHuman(input: { deliberationId: string; rationale: string; ownerId: string }): Deliberation {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (deliberation.state !== 'reviewing') {
      throw new Error(`Escalation requires reviewing state, not ${deliberation.state}`);
    }
    this.guardTransition('reviewing', 'escalated', deliberation);
    this.assertLegal('reviewing', 'escalated');
    this.transition(deliberation, 'escalated', 'Escalated to Human Owner', {
      type: 'human.escalated',
      actor: input.ownerId,
      objectRef: deliberation.id,
      payload: { rationale: input.rationale },
    });
    this.persist();
    return deliberation;
  }

  requestMoreEvidence(input: { deliberationId: string; rationale: string; ownerId: string }): EvidenceRequest {
    const deliberation = this.requireDeliberation(input.deliberationId);
    if (deliberation.state !== 'reviewing') throw new Error('Evidence requests only from reviewing');
    this.guardTransition('reviewing', 'verifying', deliberation, {
      evidenceRounds: deliberation.rounds.evidence,
      maxEvidenceRounds: deliberation.timeoutPolicy.maxEvidenceRounds,
    });
    this.assertLegal('reviewing', 'verifying');
    const request = this.createEvidenceRequest({
      deliberationId: deliberation.id,
      assignee: 'human',
      question: input.rationale,
    });
    deliberation.rounds.evidence += 1;
    this.transition(deliberation, 'verifying', `Evidence round ${deliberation.rounds.evidence} opened by Human Owner`, {
      type: 'human.requested_evidence',
      actor: input.ownerId,
      objectRef: deliberation.id,
      payload: { requestId: request.id, round: deliberation.rounds.evidence },
    });
    this.persist();
    return request;
  }

  // -------------------------------------------------------------------------
  // Runs: cancel / retry / status
  // -------------------------------------------------------------------------

  cancelRun(deliberationId: string, runId: string): AgentRun {
    const deliberation = this.requireDeliberation(deliberationId);
    const run = deliberation.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    if (!['pending', 'running'].includes(run.status)) {
      throw new Error(`Cannot cancel run in status ${run.status}`);
    }
    run.status = 'cancelled';
    run.finishedAt = this.now().toISOString();
    this.mutate(`run.cancelled ${runId}`, {
      type: 'run.cancelled',
      actor: deliberation.ownerId,
      objectRef: deliberation.id,
      payload: { runId },
    });
    this.persist();
    this.emitRunUpdate(deliberation, run);
    return run;
  }

  async retryRun(deliberationId: string, runId: string): Promise<AgentRun> {
    const deliberation = this.requireDeliberation(deliberationId);
    if (!['blind_run', 'committed'].includes(deliberation.state)) {
      throw new Error(`Retry only allowed in blind_run/committed state, not ${deliberation.state}`);
    }
    const oldRun = deliberation.runs.find((item) => item.id === runId);
    if (!oldRun) throw new Error(`Run not found: ${runId}`);
    if (!['failed', 'timed_out', 'cancelled'].includes(oldRun.status)) {
      throw new Error(`Run ${runId} is not retryable (status ${oldRun.status})`);
    }
    const worker = deliberation.participants.find((participant) => participant.id === oldRun.participantId);
    if (!worker) throw new Error(`Participant not found for run ${runId}`);
    const runIdNew = newId('run');
    const workspacePath = this.workspaceManager.createRunWorkspace(deliberation.id, runIdNew);
    const run: AgentRun = {
      id: runIdNew,
      participantId: worker.id,
      phase: 'blind_run',
      status: 'running',
      workspacePath,
      startedAt: this.now().toISOString(),
    };
    deliberation.runs.push(run);
    const packet = this.getTaskPacket(deliberation.id);
    const project = this.getProject(deliberation.projectId);
    const authoritySources = packet.sources
      .map((sourceId) => project.sourceBindings.find((binding) => binding.id === sourceId))
      .filter((binding): binding is SourceBinding => Boolean(binding))
      .map((binding) => ({ ref: formatVersionRef(binding.id, binding.version), binding, content: binding.text }));
    this.workspaceManager.writeSources(
      workspacePath,
      authoritySources.map((source) => ({ id: source.binding.id, label: source.binding.label, content: source.content ?? '' })),
    );
    const view = buildContextView({
      deliberation,
      viewerRunId: run.id,
      role: 'worker',
      phase: 'blind_run',
      authoritySources: authoritySources.map((source) => source.ref),
      authorityArtifactRefs: this.authorityArtifactRefs(deliberation),
      candidateArtifactRefs: [],
      seed: this.seed,
    });
    run.contextViewId = view.id;
    this.db.contextViews.push(view);
    this.mutate(`run.retry ${runId} -> ${runIdNew}`, {
      type: 'run.retry',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: { oldRunId: runId, newRunId: runIdNew, reason: oldRun.error ?? oldRun.status },
    });
    this.persist();
    this.emitRunUpdate(deliberation, run);
    const adapter = this.options.resolveAdapter(worker);
    if (!adapter) throw new Error(`No adapter resolved for participant ${worker.id}`);
    try {
      const result = await this.runAgent(
        adapter as AgentAdapter,
        run,
        worker,
        authoritySources,
        deliberation.timeoutPolicy.defaultMs,
      );
      this.commitRunResult(deliberation, run, result);
    } catch (error) {
      this.failRun(deliberation, run, error);
    }
    this.persist();
    this.emitRunUpdate(deliberation, run);
    this.maybeTransitionToCommitted(deliberation);
    return run;
  }

  // -------------------------------------------------------------------------
  // Visibility, audit and export
  // -------------------------------------------------------------------------

  getContextView(deliberationId: string, runId: string): ContextView {
    const deliberation = this.requireDeliberation(deliberationId);
    const run = deliberation.runs.find((item) => item.id === runId);
    if (!run) throw new Error(`Run not found: ${runId}`);
    const view = this.db.contextViews.find((item) => item.id === run.contextViewId);
    if (!view) throw new Error(`Context view missing for ${runId}`);
    return view;
  }

  getState(deliberationId: string): Deliberation {
    return this.requireDeliberation(deliberationId);
  }

  getVisibleObjects(deliberationId: string, viewerRunId: string, role: 'worker' | 'reviewer' | 'verifier' | 'human' = 'worker'): VisibleObjects {
    const deliberation = this.requireDeliberation(deliberationId);
    const view = this.getContextView(deliberationId, viewerRunId);
    const project = this.getProject(deliberation.projectId);
    const authoritySources = view.visible.authoritySources
      .map((ref) => {
        const parsed = parseVersionRef(ref);
        if (!parsed) return undefined;
        const binding = project.sourceBindings.find((item) => item.id === parsed.name);
        return binding ? { ref, binding, content: binding.text } : undefined;
      })
      .filter((item): item is { ref: string; binding: SourceBinding; content: string | undefined } => Boolean(item));
    const artifacts = view.visible.artifacts
      .map((ref) => this.registry.getVersion(ref))
      .filter((item): item is ResolvedArtifactVersion => Boolean(item));
    const claims: VisibleObjects['claims'] = [];
    for (const position of deliberation.positions) {
      for (const claim of position.claims) {
        if (view.visible.claims.includes(claim.id)) {
          claims.push({
            claimId: claim.id,
            positionId: position.id,
            statement: claim.statement,
            type: claim.type,
            evidenceRefs: claim.evidenceRefs,
          });
        }
      }
    }
    const evidence = deliberation.evidence.filter((item) => view.visible.evidence.includes(item.id));
    let candidates: ReviewerCandidate[] | undefined;
    if (role === 'reviewer' && deliberation.state === 'reviewing') {
      const { candidates: built } = buildReviewerCandidates(committedPositions(deliberation), this.seed);
      candidates = built;
    }
    return { authoritySources, artifacts, claims, evidence, candidates };
  }

  auditBlindLeaks(deliberationId: string): string[] {
    const deliberation = this.requireDeliberation(deliberationId);
    const leaks: string[] = [];
    for (const run of deliberation.runs) {
      if (run.phase !== 'blind_run') continue;
      const view = this.db.contextViews.find((item) => item.id === run.contextViewId);
      if (!view) continue;
      const otherRunIds = deliberation.runs
        .map((item) => item.id)
        .filter(
          (id) =>
            id !== run.id &&
            deliberation.runs.find((r) => r.id === id)?.phase === 'blind_run' &&
            !['failed', 'timed_out', 'cancelled'].includes(
              deliberation.runs.find((r) => r.id === id)?.status ?? '',
            ),
        );
      leaks.push(...findBlindLeaks(view, otherRunIds));
    }
    return [...new Set(leaks)];
  }

  getTimeline(deliberationId: string): Event[] {
    const deliberation = this.requireDeliberation(deliberationId);
    return this.db.events.filter((event) => event.objectRef === deliberation.id);
  }

  verifyEventChain(): boolean {
    let previousHash: string | undefined;
    for (const event of this.db.events) {
      if (event.previousHash !== previousHash) return false;
      previousHash = hashJson(event);
    }
    return true;
  }

  exportDecisionPack(deliberationId: string): DecisionPack {
    const deliberation = this.requireDeliberation(deliberationId);
    return exportDecisionPack({
      db: this.db,
      deliberationId,
      seed: this.seed,
    });
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  private loadDatabase(store: Store): Database {
    try {
      return store.load();
    } catch (error) {
      if (store instanceof JsonFileStore && !existsSync((store as unknown as { filePath: string }).filePath)) {
        return emptyDatabase();
      }
      throw error;
    }
  }

  private persist(): void {
    this.options.store.save(this.db);
  }

  private mutate(message: string, event: Parameters<typeof appendEvent>[1]): void {
    const appended = appendEvent(this.db, event);
    this.options.onEvent?.(appended);
    void message;
  }

  private transition(deliberation: Deliberation, to: Deliberation['state'], message: string, event: Parameters<typeof appendEvent>[1]): void {
    this.assertLegal(deliberation.state, to);
    deliberation.state = to;
    deliberation.updatedAt = this.now().toISOString();
    const appended = appendEvent(this.db, event);
    this.options.onEvent?.(appended);
    void message;
  }

  private emitRunUpdate(deliberation: Deliberation, run: AgentRun): void {
    this.options.onRunUpdate?.({
      deliberationId: deliberation.id,
      runId: run.id,
      status: run.status,
      phase: run.phase,
      error: run.error,
    });
  }

  private assertLegal(from: Deliberation['state'], to: Deliberation['state']): void {
    assertLegalTransition(from, to);
  }

  private guardTransition(from: Deliberation['state'], to: Deliberation['state'], deliberation: Deliberation, extra?: Record<string, number | boolean>): void {
    const violations = guardTransition(from, to, {
      deliberation,
      taskPacket: this.getTaskPacketOrUndefined(deliberation),
      committedWorkers: deliberation.runs.filter((run) => run.status === 'committed').length,
      activeWorkers: this.activeWorkerCount(deliberation),
      hasReview: deliberation.reviews.length > 0,
      hasDecision: deliberation.decisions.length > 0,
      ...extra,
    });
    if (violations.length) throw new Error(`Guard rejected ${from} -> ${to}: ${violations.join('; ')}`);
  }

  private getTaskPacketOrUndefined(deliberation: Deliberation): TaskPacket | undefined {
    return this.db.taskPackets.find((item) => item.id === deliberation.taskPacketId);
  }

  private activeWorkerCount(deliberation: Deliberation): number {
    return deliberation.runs.filter((run) =>
      deliberation.participants.find((participant) => participant.id === run.participantId)?.role === 'worker' &&
      !['failed', 'timed_out', 'cancelled'].includes(run.status),
    ).length;
  }

  private runAgent(
    adapter: AgentAdapter,
    run: AgentRun,
    participant: Participant,
    authoritySources: Array<{ ref: string; binding: SourceBinding; content?: string }>,
    timeoutMs: number,
  ): Promise<AgentRunResult> {
    const deliberation = deliberationForRun(this, run);
    const packet = this.getTaskPacket(deliberation.id);
    const view = this.db.contextViews.find((item) => item.id === run.contextViewId);
    if (!view) throw new Error(`Context view missing for run ${run.id}`);
    const input = {
      runId: run.id,
      participantId: participant.id,
      phase: run.phase,
      taskPacket: packet,
      contextView: view,
      authoritySources,
      visibleArtifacts: this.resolveVisibleArtifacts(view),
      workspacePath: run.workspacePath!,
      fingerprintHint: participant.fingerprint,
    };
    let timer: ReturnType<typeof setTimeout> | undefined;
    const withTimeout = new Promise<AgentRunResult>((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`Run timed out after ${timeoutMs}ms`)), timeoutMs);
      adapter.run(input).then(resolve, reject);
    });
    return withTimeout.finally(() => clearTimeout(timer));
  }

  private commitRunResult(deliberation: Deliberation, run: AgentRun, result: AgentRunResult): void {
    const artifactRefs: string[] = [];
    for (const artifact of result.artifacts) {
      const published = this.registry.publish({
        logicalName: artifact.logicalName,
        type: artifact.type,
        content: artifact.content,
        ownerRunId: run.id,
        visibility: artifact.visibility ?? 'shared',
        dependencies: [],
      });
      artifactRefs.push(published.ref);
    }
    const claims = result.position.claims.map((claim, index) => ({
      ...claim,
      id: claim.id ?? `claim_${run.id}_${index + 1}`,
    }));
    const position: Position = {
      id: newId('pos'),
      runId: run.id,
      summary: result.position.summary,
      claims,
      unknowns: result.position.unknowns,
      artifactRefs: result.position.artifactRefs.length ? result.position.artifactRefs : artifactRefs,
      decisionConditions: result.position.decisionConditions,
      confidence: result.position.confidence,
      commitmentHash: hashJson({
        summary: result.position.summary,
        claims,
        unknowns: result.position.unknowns,
        artifactRefs: result.position.artifactRefs.length ? result.position.artifactRefs : artifactRefs,
        decisionConditions: result.position.decisionConditions,
        confidence: result.position.confidence,
      }),
      committedAt: this.now().toISOString(),
      status: 'committed',
    };
    deliberation.positions.push(position);
    run.positionId = position.id;
    run.status = 'committed';
    run.finishedAt = this.now().toISOString();
    run.fingerprint = result.fingerprint as unknown as Record<string, unknown>;
    run.cost = result.cost;
    const logRef = `log_${sha256(result.logs ?? '').slice(0, 16)}`;
    this.db.logs[logRef] = result.logs ?? '';
    run.logsRef = logRef;
    this.mutate(`run.committed ${run.id}`, {
      type: 'run.committed',
      actor: run.id,
      objectRef: deliberation.id,
      payload: {
        runId: run.id,
        positionId: position.id,
        commitmentHash: position.commitmentHash,
        artifactRefs: position.artifactRefs,
        cost: run.cost,
      },
    });
  }

  private failRun(deliberation: Deliberation, run: AgentRun, error: unknown): void {
    const message = error instanceof Error ? error.message : String(error);
    run.status = message.includes('timed out') ? 'timed_out' : 'failed';
    run.error = message;
    run.finishedAt = this.now().toISOString();
    this.mutate(`run.${run.status} ${run.id}`, {
      type: run.status === 'timed_out' ? 'run.timed_out' : 'run.failed',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: { runId: run.id, error: message },
    });
  }

  private maybeTransitionToCommitted(deliberation: Deliberation): void {
    if (deliberation.state !== 'blind_run') return;
    try {
      this.guardTransition('blind_run', 'committed', deliberation);
    } catch {
      return;
    }
    this.transition(deliberation, 'committed', 'All active Workers committed', {
      type: 'blind_run.completed',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: {
        committedRuns: deliberation.runs.filter((run) => run.status === 'committed').map((run) => run.id),
      },
    });
    this.persist();
    if (this.autoReveal) this.reveal(deliberation.id);
  }

  private maybeAdvanceFromChallenging(deliberation: Deliberation): void {
    if (deliberation.state !== 'challenging') return;
    const open = deliberation.challenges.some((challenge) => challenge.status === 'open');
    const pending = deliberation.evidenceRequests.some((request) => request.status === 'pending');
    if (open || pending) return;
    this.transition(deliberation, 'verifying', 'Challenge round resolved', {
      type: 'verifying.started',
      actor: 'protocol-engine',
      objectRef: deliberation.id,
      payload: { round: deliberation.rounds.challenge },
    });
    this.persist();
  }

  private async runReviewerAdapter(
    adapter: ReviewerAdapter,
    run: AgentRun,
    deliberation: Deliberation,
    candidates: ReviewerCandidate[],
  ): Promise<ReviewerRunResult> {
    const packet = this.getTaskPacket(deliberation.id);
    const result = await adapter.review({
      runId: run.id,
      rubric: packet.rubric,
      candidates,
      evidence: redactEvidenceForReviewer(deliberation.evidence),
      unresolvedConflicts: deliberation.challenges
        .filter((challenge) => challenge.status === 'evidence_requested' || !deliberation.responses.some((response) => response.challengeId === challenge.id))
        .map((challenge) => challenge.question),
    });
    return result;
  }

  private storeReview(deliberation: Deliberation, run: AgentRun, result: ReviewerRunResult): Review {
    const packet = this.getTaskPacket(deliberation.id);
    for (const item of packet.rubric.items) {
      const score = result.rubricScores[item.id];
      if (score === undefined || score < 0 || score > packet.rubric.maxScore) {
        throw new Error(`Review missing or invalid score for rubric item ${item.id} (0..${packet.rubric.maxScore})`);
      }
    }
    const review: Review = {
      id: newId('rev'),
      deliberationId: deliberation.id,
      reviewerRunId: run.id,
      rubricScores: result.rubricScores,
      recommendation: result.recommendation,
      rationale: result.rationale,
      unresolvedRisks: result.unresolvedRisks,
      evidenceSufficiency: result.evidenceSufficiency,
      createdAt: this.now().toISOString(),
    };
    deliberation.reviews.push(review);
    run.status = 'committed';
    run.finishedAt = this.now().toISOString();
    const logRef = `log_${sha256(result.logs ?? '').slice(0, 16)}`;
    this.db.logs[logRef] = result.logs ?? '';
    run.logsRef = logRef;
    this.mutate(`review.submitted ${review.id}`, {
      type: 'review.submitted',
      actor: run.id,
      objectRef: deliberation.id,
      payload: {
        reviewId: review.id,
        recommendation: review.recommendation,
        evidenceSufficiency: review.evidenceSufficiency,
        unresolvedRisks: review.unresolvedRisks,
      },
    });
    return review;
  }

  private refsForRecommendation(deliberation: Deliberation, recommendation: Review['recommendation']): string[] {
    if (!deliberation.reviewOrder?.length) {
      throw new Error('Review order not recorded; cannot map recommendation to candidate');
    }
    if (recommendation === 'candidate_a' || recommendation === 'candidate_b') {
      const positionId = deliberation.reviewOrder[recommendation === 'candidate_a' ? 0 : 1];
      const position = deliberation.positions.find((item) => item.id === positionId);
      if (!position) throw new Error(`Position not found: ${positionId}`);
      return [`position:${position.id}`, ...position.artifactRefs];
    }
    if (recommendation === 'merge') {
      return deliberation.reviewOrder.flatMap((positionId) => {
        const position = deliberation.positions.find((item) => item.id === positionId);
        return position ? [`position:${position.id}`, ...position.artifactRefs] : [];
      });
    }
    return [];
  }

  private resolveVisibleArtifacts(view: ContextView): Array<{ ref: string; logicalName: string; type: string; content: string; version: number; contentHash: string; dependencies: string[] }> {
    return view.visible.artifacts
      .map((ref) => this.registry.getVersion(ref))
      .filter((item): item is ResolvedArtifactVersion => Boolean(item))
      .map((item) => ({
        ref: item.ref,
        logicalName: this.db.artifacts.find((artifact) => artifact.id === item.version.artifactId)?.logicalName ?? item.version.artifactId,
        type: item.version.encoding === 'utf8' ? 'text' : 'binary',
        content: item.content,
        version: item.version.version,
        contentHash: item.version.contentHash,
        dependencies: item.version.dependencies,
      }));
  }

  private authoritySourceRefs(deliberation: Deliberation): string[] {
    const packet = this.getTaskPacket(deliberation.id);
    const project = this.getProject(deliberation.projectId);
    return packet.sources.map((sourceId) => {
      const binding = project.sourceBindings.find((item) => item.id === sourceId);
      return formatVersionRef(sourceId, binding?.version ?? 1);
    });
  }

  private authorityArtifactRefs(deliberation: Deliberation): string[] {
    return this.authoritySourceRefs(deliberation);
  }

  private candidateArtifactRefs(deliberation: Deliberation): string[] {
    return deliberation.positions.flatMap((position) => position.artifactRefs);
  }

  private resolveChallengeTargetRun(deliberation: Deliberation, challenge: Challenge): string {
    if (challenge.targetRef.startsWith('claim:')) {
      const claimId = challenge.targetRef.slice('claim:'.length);
      const position = deliberation.positions.find((item) => item.claims.some((claim) => claim.id === claimId));
      return position?.runId ?? '';
    }
    if (challenge.targetRef.startsWith('artifact:')) {
      const ref = challenge.targetRef.slice('artifact:'.length);
      const resolved = this.registry.getVersion(ref);
      return resolved?.version.sourceRunId ?? '';
    }
    if (challenge.targetRef.startsWith('evidence:')) {
      const evidenceId = challenge.targetRef.slice('evidence:'.length);
      const evidence = deliberation.evidence.find((item) => item.id === evidenceId);
      if (!evidence) return '';
      const claimRef = evidence.targetRefs.find((ref) => ref.startsWith('claim:'));
      if (claimRef) return this.resolveChallengeTargetRun(deliberation, { ...challenge, targetRef: claimRef });
      const artifactRef = evidence.targetRefs.find((ref) => ref.startsWith('artifact:'));
      if (artifactRef) return this.resolveChallengeTargetRun(deliberation, { ...challenge, targetRef: artifactRef });
      return '';
    }
    return '';
  }

  private assertTargetRef(deliberation: Deliberation, ref: string): void {
    if (ref.startsWith('claim:')) {
      const claimId = ref.slice('claim:'.length);
      if (!deliberation.positions.some((position) => position.claims.some((claim) => claim.id === claimId))) {
        throw new Error(`Unknown claim target: ${ref}`);
      }
      return;
    }
    if (ref.startsWith('artifact:')) {
      if (!this.registry.getVersion(ref.slice('artifact:'.length))) {
        throw new Error(`Unknown artifact target: ${ref}`);
      }
      return;
    }
    if (ref.startsWith('evidence:')) {
      if (!deliberation.evidence.some((item) => item.id === ref.slice('evidence:'.length))) {
        throw new Error(`Unknown evidence target: ${ref}`);
      }
      return;
    }
    throw new Error(`Target ref must start with claim:, artifact: or evidence: (got ${ref})`);
  }

  private requireDeliberation(deliberationId: string): Deliberation {
    const deliberation = this.db.deliberations.find((item) => item.id === deliberationId);
    if (!deliberation) throw new Error(`Deliberation not found: ${deliberationId}`);
    return deliberation;
  }

  private findDeliberationForChallenge(challengeId: string): string {
    const deliberation = this.db.deliberations.find((item) => item.challenges.some((challenge) => challenge.id === challengeId));
    return deliberation?.id ?? '';
  }

  private findDeliberationWithRequest(requestId: string): Deliberation | undefined {
    return this.db.deliberations.find((item) => item.evidenceRequests.some((request) => request.id === requestId));
  }

  get deliberationDatabase(): Database {
    return this.db;
  }
}

function committedPositions(deliberation: Deliberation): Position[] {
  return deliberation.positions.filter((position) => position.status === 'committed');
}

function deliberationForRun(engine: ProtocolEngine, run: AgentRun): Deliberation {
  const found = engine.deliberationDatabase.deliberations.find((d) => d.runs.some((r) => r.id === run.id));
  if (!found) throw new Error(`Deliberation not found for run ${run.id}`);
  return found;
}

function snapshotPath(path: string, type: 'file' | 'directory'): string {
  return type === 'file' ? readFileSync(path, 'utf8') : snapshotDirectory(path);
}

function snapshotDirectory(path: string): string {
  const { readdirSync, statSync } = require('node:fs') as typeof import('node:fs');
  const entries: string[] = [];
  const walk = (current: string, relativePath: string) => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      const stat = statSync(full);
      const rel = relativePath ? `${relativePath}/${entry}` : entry;
      if (stat.isDirectory()) walk(full, rel);
      else entries.push(`${rel}\t${stat.size}`);
    }
  };
  walk(path, '');
  entries.sort();
  return `# directory snapshot: ${path}\n${entries.join('\n')}`;
}

function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return slug || 'source';
}
