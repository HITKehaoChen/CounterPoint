import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ProtocolEngine } from '../../src/protocol-engine.ts';
import { JsonFileStore } from '../../src/store.ts';
import { ArtifactRegistry } from '../../src/artifact-registry.ts';
import {
  buildHumanView,
  buildWorkItemBoard,
  buildWorkItemView,
  buildWorkspaceKnowledge,
} from '../../src/human-view.ts';
import { decisionPackToMarkdown } from '../../src/decision-pack.ts';
import { createEventBus } from './bus.ts';
import { inviteAgentDraft, resolveApiAdapter } from './adapters.ts';
import { KeyedMutex } from './mutex.ts';
import { JobRegistry } from './jobs.ts';

const MAX_BODY_BYTES = 2 * 1024 * 1024;
const HEARTBEAT_MS = 15_000;

export interface ApiServerOptions {
  storePath?: string;
  workspaceRoot?: string;
  seed?: string;
  autoReveal?: boolean;
  verifierAllowlist?: string[];
  staticRoot?: string;
}

class HttpError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

type RouteHandler = (
  res: ServerResponse,
  params: Record<string, string>,
  query: URLSearchParams,
  body: unknown,
) => Promise<void> | void;

interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: RouteHandler;
}

function route(method: string, path: string, handler: RouteHandler): Route {
  const keys: string[] = [];
  const pattern = new RegExp(
    '^' +
      path.replace(/:([a-zA-Z]+)/g, (_match, key: string) => {
        keys.push(key);
        return '([^/]+)';
      }) +
      '$',
  );
  return { method, pattern, keys, handler };
}

export function createApiServer(options: ApiServerOptions = {}) {
  const cwd = process.cwd();
  const storePath = options.storePath ?? join(cwd, 'data', 'store.json');
  const workspaceRoot = options.workspaceRoot ?? join(cwd, 'data', 'workspaces');
  const staticRoot = options.staticRoot ?? join(cwd, 'apps', 'web', 'dist');
  const seed = options.seed ?? 'counterpoint-web-seed';
  const bus = createEventBus();
  const mutex = new KeyedMutex();
  const jobs = new JobRegistry();

  const engine = new ProtocolEngine({
    store: new JsonFileStore(storePath),
    workspaceRoot,
    seed,
    autoReveal: options.autoReveal ?? true,
    verifierConfig: {
      allowlist: options.verifierAllowlist ?? ['node', 'npm', 'git', 'python', 'rg'],
      timeoutMs: 30_000,
      environmentRef: 'local',
    },
    onEvent: (event) => bus.publish({ type: 'event', event }),
    onRunUpdate: (update) => bus.publish({ type: 'run.update', update }),
    resolveAdapter: resolveApiAdapter,
  });

  const db = () => engine.deliberationDatabase;
  const viewOf = (deliberationId: string) => buildHumanView(db(), deliberationId, seed);

  // -------------------------------------------------------------------------
  // Handlers
  // -------------------------------------------------------------------------

  const health: RouteHandler = (res) => sendJson(res, 200, { ok: true });

  const listProjects: RouteHandler = (res) => {
    sendJson(res, 200, { projects: db().projects });
  };

  const createProject: RouteHandler = (res, _params, _query, body) => {
    const input = body as { name?: unknown; description?: unknown };
    if (typeof input?.name !== 'string' || !input.name.trim()) {
      throw new HttpError(400, 'name is required');
    }
    const project = engine.createProject({
      name: input.name,
      description: typeof input.description === 'string' ? input.description : undefined,
    });
    sendJson(res, 201, { project });
  };

  const getProject: RouteHandler = (res, params) => {
    sendJson(res, 200, { project: engine.getProject(params.id) });
  };

  const archiveProject: RouteHandler = (res, params) => {
    sendJson(res, 200, { project: engine.archiveProject(params.id) });
  };

  const addSource: RouteHandler = (res, params, _query, body) => {
    const input = body as {
      type?: unknown;
      label?: unknown;
      text?: unknown;
      path?: unknown;
    };
    if (!['text', 'file', 'directory', 'git'].includes(String(input?.type))) {
      throw new HttpError(400, 'type must be text, file, directory or git');
    }
    if (typeof input?.label !== 'string' || !input.label.trim()) {
      throw new HttpError(400, 'label is required');
    }
    const binding = engine.addSourceBinding({
      projectId: params.id,
      type: input.type as 'text' | 'file' | 'directory' | 'git',
      label: input.label,
      text: typeof input.text === 'string' ? input.text : undefined,
      path: typeof input.path === 'string' ? input.path : undefined,
    });
    sendJson(res, 201, { binding });
  };

  const createDeliberation: RouteHandler = (res, params, _query, body) => {
    const input = body as {
      ownerId?: unknown;
      problem?: unknown;
      goals?: unknown;
      constraints?: unknown;
      rubric?: unknown;
      deliverable?: unknown;
    };
    if (typeof input?.problem !== 'string' || !input.problem.trim()) {
      throw new HttpError(400, 'problem is required');
    }
    if (!isNonEmptyStringArray(input.goals)) throw new HttpError(400, 'goals is required');
    if (!isNonEmptyStringArray(input.constraints)) throw new HttpError(400, 'constraints is required');
    if (!isRubric(input.rubric)) throw new HttpError(400, 'rubric with at least one item is required');
    const workItemIdValue = (input as { workItemId?: unknown }).workItemId;
    const deliberation = engine.createDeliberation({
      projectId: params.id,
      ownerId: typeof input.ownerId === 'string' ? input.ownerId : 'human-owner',
      problem: input.problem,
      goals: input.goals as string[],
      constraints: input.constraints as string[],
      rubric: input.rubric as { items: Array<{ id: string; name: string; weight: number }>; maxScore: number },
      deliverable: typeof input.deliverable === 'string' ? input.deliverable : undefined,
      workItemId: typeof workItemIdValue === 'string' ? workItemIdValue : undefined,
    });
    sendJson(res, 201, { deliberation });
  };

  const listWorkItems: RouteHandler = (res, params) => {
    sendJson(res, 200, { board: buildWorkItemBoard(db(), params.id) });
  };

  const workspaceKnowledge: RouteHandler = (res, params) => {
    sendJson(res, 200, { knowledge: buildWorkspaceKnowledge(db(), params.id) });
  };

  const createWorkItem: RouteHandler = (res, params, _query, body) => {
    const input = body as { kind?: unknown; title?: unknown; description?: unknown; templateFields?: unknown };
    if (!['problem', 'requirement', 'bug', 'hypothesis', 'decision'].includes(String(input?.kind))) {
      throw new HttpError(400, 'kind must be problem/requirement/bug/hypothesis/decision');
    }
    if (typeof input?.title !== 'string' || !input.title.trim()) {
      throw new HttpError(400, 'title is required');
    }
    const workItem = engine.createWorkItem({
      workspaceId: params.id,
      kind: input.kind as 'problem' | 'requirement' | 'bug' | 'hypothesis' | 'decision',
      title: input.title,
      description: typeof input.description === 'string' ? input.description : undefined,
      templateFields:
        input.templateFields && typeof input.templateFields === 'object'
          ? (input.templateFields as Record<string, unknown>)
          : undefined,
    });
    sendJson(res, 201, { workItem });
  };

  const getWorkItem: RouteHandler = (res, params) => {
    sendJson(res, 200, { workItem: buildWorkItemView(db(), params.id) });
  };

  const patchWorkItem: RouteHandler = (res, params, _query, body) => {
    const input = body as Record<string, unknown>;
    const patch: {
      description?: string;
      status?: string;
      templateFields?: Record<string, unknown>;
      currentConclusionRefs?: string[];
      relations?: unknown;
    } = {};
    if (input.description !== undefined) {
      if (typeof input.description !== 'string') throw new HttpError(400, 'description must be a string');
      patch.description = input.description;
    }
    if (input.status !== undefined) {
      if (!['open', 'investigating', 'resolved', 'rejected', 'needs_evidence'].includes(String(input.status))) {
        throw new HttpError(400, 'invalid work item status');
      }
      patch.status = String(input.status);
    }
    if (input.templateFields !== undefined) {
      patch.templateFields = input.templateFields as Record<string, unknown>;
    }
    if (input.currentConclusionRefs !== undefined) {
      if (!Array.isArray(input.currentConclusionRefs)) throw new HttpError(400, 'currentConclusionRefs must be an array');
      patch.currentConclusionRefs = input.currentConclusionRefs.map(String);
    }
    if (input.relations !== undefined) {
      patch.relations = input.relations;
    }
    const workItem = engine.updateWorkItem(params.id, patch as Parameters<typeof engine.updateWorkItem>[1]);
    sendJson(res, 200, { workItem: buildWorkItemView(db(), params.id) });
  };

  const addWorkItemEntry: RouteHandler = (res, params, _query, body) => {
    const input = body as { kind?: unknown; statement?: unknown; text?: unknown; assignee?: unknown; author?: unknown; evidenceRefs?: unknown };
    if (!['claim', 'question', 'update'].includes(String(input?.kind))) {
      throw new HttpError(400, 'entry kind must be claim/question/update');
    }
    if (typeof input?.author !== 'string' || !input.author.trim()) {
      throw new HttpError(400, 'author is required');
    }
    const entry =
      input.kind === 'claim'
        ? engine.addWorkItemEntry(params.id, {
            kind: 'claim',
            statement: String(input.statement ?? ''),
            evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(String) : undefined,
            author: input.author,
          })
        : input.kind === 'question'
          ? engine.addWorkItemEntry(params.id, {
              kind: 'question',
              text: String(input.text ?? ''),
              assignee: input.assignee === 'human' ? 'human' : 'agent',
              author: input.author,
            })
          : engine.addWorkItemEntry(params.id, {
              kind: 'update',
              text: String(input.text ?? ''),
              author: input.author,
            });
    sendJson(res, 201, { entry, workItem: buildWorkItemView(db(), params.id) });
  };

  const transitionWorkItemEntry: RouteHandler = (res, params, _query, body) => {
    const input = body as { status?: unknown };
    if (typeof input?.status !== 'string') throw new HttpError(400, 'status is required');
    const entry = engine.transitionWorkItemClaim(params.id, params.entryId, input.status as never);
    sendJson(res, 200, { entry });
  };

  const promoteWorkItemEntry: RouteHandler = (res, params) => {
    const entry = engine.promoteWorkItemClaim(params.id, params.entryId);
    sendJson(res, 200, { entry });
  };

  const addWorkItemKnowledgeRef: RouteHandler = (res, params, _query, body) => {
    const input = body as Record<string, unknown>;
    const workItem = engine.addWorkItemKnowledgeRef(params.id, input as Parameters<typeof engine.addWorkItemKnowledgeRef>[1]);
    sendJson(res, 200, { workItem: buildWorkItemView(db(), params.id) });
  };

  const inviteAgent: RouteHandler = (res, params) => {
    const workItem = engine.getWorkItem(params.id);
    const entries = inviteAgentDraft(workItem);
    const job = jobs.start('inviteAgent', params.id, () => {
      for (const entry of entries) {
        engine.addWorkItemEntry(workItem.id, entry);
      }
    });
    sendJson(res, 202, { jobId: job.id, status: 202 });
  };

  const addParticipant: RouteHandler = (res, params, _query, body) => {
    const input = body as { role?: unknown; label?: unknown; adapterConfig?: unknown };
    if (!['worker', 'reviewer', 'verifier', 'human'].includes(String(input?.role))) {
      throw new HttpError(400, 'role must be worker, reviewer, verifier or human');
    }
    const participant = engine.addParticipant({
      deliberationId: params.id,
      role: input.role as 'worker' | 'reviewer' | 'verifier' | 'human',
      label: typeof input.label === 'string' ? input.label : undefined,
      adapterConfig:
        input.adapterConfig && typeof input.adapterConfig === 'object'
          ? (input.adapterConfig as Record<string, unknown>)
          : undefined,
    });
    sendJson(res, 201, { participant });
  };

  const getDeliberation: RouteHandler = (res, params) => {
    sendJson(res, 200, viewOf(params.id));
  };

  const listDeliberations: RouteHandler = (res, _params, query) => {
    const projectId = query.get('projectId');
    const deliberations = db()
      .deliberations.filter((deliberation) => !projectId || deliberation.projectId === projectId)
      .map((deliberation) => ({
        id: deliberation.id,
        projectId: deliberation.projectId,
        state: deliberation.state,
        createdAt: deliberation.createdAt,
        updatedAt: deliberation.updatedAt,
        problem: db().taskPackets.find((packet) => packet.id === deliberation.taskPacketId)?.problem,
        positionCount: deliberation.positions.length,
      }));
    sendJson(res, 200, { deliberations });
  };

  const freeze: RouteHandler = (res, params) => {
    engine.freezeTaskPacket(params.id);
    sendJson(res, 200, { view: viewOf(params.id) });
  };

  const startBlindRun: RouteHandler = (res, params) => {
    const deliberation = engine.getState(params.id);
    if (deliberation.state !== 'frozen') {
      throw new HttpError(409, `Blind run can only start from frozen state, not ${deliberation.state}`);
    }
    if (deliberation.participants.filter((participant) => participant.role === 'worker').length < 2) {
      throw new HttpError(409, 'At least 2 worker participants are required');
    }
    const job = jobs.start('startBlindRun', params.id, () => engine.startBlindRun(params.id));
    sendJson(res, 202, { jobId: job.id, status: 202 });
  };

  const reveal: RouteHandler = (res, params) => {
    engine.reveal(params.id);
    sendJson(res, 200, { view: viewOf(params.id) });
  };

  const cancelRun: RouteHandler = (res, params, _query, body) => {
    const input = body as { runId?: unknown };
    if (typeof input?.runId !== 'string' || !input.runId) {
      throw new HttpError(400, 'runId is required');
    }
    engine.cancelRun(params.id, input.runId);
    sendJson(res, 200, { view: viewOf(params.id) });
  };

  const createChallenge: RouteHandler = (res, params, _query, body) => {
    const input = body as { targetRef?: unknown; authorRunId?: unknown; question?: unknown; requestedEvidence?: unknown };
    if (typeof input?.targetRef !== 'string') throw new HttpError(400, 'targetRef is required');
    if (typeof input?.authorRunId !== 'string') throw new HttpError(400, 'authorRunId is required');
    if (typeof input?.question !== 'string' || !input.question.trim()) {
      throw new HttpError(400, 'question is required');
    }
    const challenge = engine.createChallenge({
      deliberationId: params.id,
      targetRef: input.targetRef,
      authorRunId: input.authorRunId,
      question: input.question,
      requestedEvidence: typeof input.requestedEvidence === 'string' ? input.requestedEvidence : undefined,
    });
    sendJson(res, 201, { challenge });
  };

  const respondToChallenge: RouteHandler = (res, params, _query, body) => {
    const input = body as { authorRunId?: unknown; text?: unknown; concession?: unknown; evidenceRefs?: unknown };
    if (typeof input?.authorRunId !== 'string') throw new HttpError(400, 'authorRunId is required');
    if (typeof input?.text !== 'string' || !input.text.trim()) throw new HttpError(400, 'text is required');
    const deliberationId = db().deliberations.find((deliberation) =>
      deliberation.challenges.some((challenge) => challenge.id === params.id),
    )?.id;
    if (!deliberationId) throw new HttpError(404, `Challenge not found: ${params.id}`);
    const response = engine.respondToChallenge({
      challengeId: params.id,
      authorRunId: input.authorRunId,
      text: input.text,
      concession: input.concession === true,
      evidenceRefs: Array.isArray(input.evidenceRefs) ? input.evidenceRefs.map(String) : undefined,
    });
    sendJson(res, 200, { response, view: viewOf(deliberationId) });
  };

  const runVerification: RouteHandler = (res, params, _query, body) => {
    const input = body as { command?: unknown; args?: unknown; cwd?: unknown; targetRefs?: unknown; expectedExitCode?: unknown; description?: unknown };
    const deliberation = engine.getState(params.id);
    if (deliberation.state !== 'verifying') {
      throw new HttpError(409, `Verification requires verifying state, not ${deliberation.state}`);
    }
    if (typeof input?.command !== 'string' || !input.command) throw new HttpError(400, 'command is required');
    if (!Array.isArray(input.args)) throw new HttpError(400, 'args must be an array');
    if (!isNonEmptyStringArray(input.targetRefs)) throw new HttpError(400, 'targetRefs is required');
    const args = input.args.map(String);
    const job = jobs.start('runVerification', params.id, () =>
      engine.runVerification({
        deliberationId: params.id,
        command: input.command as string,
        args,
        cwd: typeof input.cwd === 'string' ? input.cwd : undefined,
        targetRefs: input.targetRefs as string[],
        expectedExitCode: typeof input.expectedExitCode === 'number' ? input.expectedExitCode : undefined,
        description: typeof input.description === 'string' ? input.description : undefined,
      }),
    );
    sendJson(res, 202, { jobId: job.id, status: 202 });
  };

  const addEvidence: RouteHandler = (res, params, _query, body) => {
    const input = body as { targetRefs?: unknown; status?: unknown; resultSummary?: unknown; kind?: unknown; sourceDescription?: unknown; reproducibility?: unknown };
    if (!isNonEmptyStringArray(input.targetRefs)) throw new HttpError(400, 'targetRefs is required');
    if (!['pending', 'verified', 'failed', 'inconclusive', 'superseded'].includes(String(input?.status))) {
      throw new HttpError(400, 'status must be pending/verified/failed/inconclusive/superseded');
    }
    if (typeof input?.resultSummary !== 'string' || !input.resultSummary.trim()) {
      throw new HttpError(400, 'resultSummary is required');
    }
    const evidence = engine.addEvidence({
      deliberationId: params.id,
      targetRefs: input.targetRefs as string[],
      status: input.status as 'pending' | 'verified' | 'failed' | 'inconclusive' | 'superseded',
      resultSummary: input.resultSummary,
      kind: input.kind as 'command_result' | 'manual' | 'authoritative_source' | undefined,
      sourceDescription: typeof input.sourceDescription === 'string' ? input.sourceDescription : undefined,
      reproducibility: input.reproducibility as 'reproducible' | 'observed_once' | 'unknown' | undefined,
    });
    sendJson(res, 201, { evidence, view: viewOf(params.id) });
  };

  const freezeEvidence: RouteHandler = (res, params) => {
    engine.freezeEvidencePack(params.id);
    sendJson(res, 200, { view: viewOf(params.id) });
  };

  const finalizeChallenges: RouteHandler = (res, params) => {
    engine.finalizeChallenges(params.id);
    sendJson(res, 200, { view: viewOf(params.id) });
  };

  const runReview: RouteHandler = (res, params) => {
    const deliberation = engine.getState(params.id);
    if (deliberation.state !== 'reviewing') {
      throw new HttpError(409, `Review requires reviewing state, not ${deliberation.state}`);
    }
    const job = jobs.start('runReview', params.id, () => engine.runReview(params.id));
    sendJson(res, 202, { jobId: job.id, status: 202 });
  };

  const submitReview: RouteHandler = (res, params, _query, body) => {
    const input = body as { reviewerRunId?: unknown; review?: unknown };
    if (typeof input?.reviewerRunId !== 'string') throw new HttpError(400, 'reviewerRunId is required');
    if (!input.review || typeof input.review !== 'object') throw new HttpError(400, 'review is required');
    const review = engine.submitReview({
      deliberationId: params.id,
      reviewerRunId: input.reviewerRunId,
      review: input.review as Parameters<typeof engine.submitReview>[0]['review'],
    });
    sendJson(res, 201, { review });
  };

  const humanDecision: RouteHandler = (res, params, _query, body) => {
    const input = body as {
      action?: unknown;
      rationale?: unknown;
      selectedRefs?: unknown;
      conditions?: unknown;
      dissent?: unknown;
      ownerId?: unknown;
    };
    if (!['approve', 'override', 'merge', 'no_decision'].includes(String(input?.action))) {
      throw new HttpError(400, 'action must be approve/override/merge/no_decision');
    }
    if (typeof input?.rationale !== 'string' || !input.rationale.trim()) {
      throw new HttpError(400, 'rationale is required');
    }
    const decision = engine.humanDecision({
      deliberationId: params.id,
      action: input.action as 'approve' | 'override' | 'merge' | 'no_decision',
      rationale: input.rationale,
      selectedRefs: Array.isArray(input.selectedRefs) ? input.selectedRefs.map(String) : undefined,
      conditions: Array.isArray(input.conditions) ? input.conditions.map(String) : undefined,
      dissent: Array.isArray(input.dissent) ? input.dissent.map(String) : undefined,
      ownerId: typeof input.ownerId === 'string' ? input.ownerId : 'human-owner',
    });
    sendJson(res, 200, { decision });
  };

  const escalate: RouteHandler = (res, params, _query, body) => {
    const input = body as { rationale?: unknown; ownerId?: unknown };
    if (typeof input?.rationale !== 'string' || !input.rationale.trim()) {
      throw new HttpError(400, 'rationale is required');
    }
    engine.escalateToHuman({
      deliberationId: params.id,
      rationale: input.rationale,
      ownerId: typeof input.ownerId === 'string' ? input.ownerId : 'human-owner',
    });
    sendJson(res, 200, { view: viewOf(params.id) });
  };

  const requestMoreEvidence: RouteHandler = (res, params, _query, body) => {
    const input = body as { rationale?: unknown; ownerId?: unknown };
    if (typeof input?.rationale !== 'string' || !input.rationale.trim()) {
      throw new HttpError(400, 'rationale is required');
    }
    const request = engine.requestMoreEvidence({
      deliberationId: params.id,
      rationale: input.rationale,
      ownerId: typeof input.ownerId === 'string' ? input.ownerId : 'human-owner',
    });
    sendJson(res, 200, { request, view: viewOf(params.id) });
  };

  const timeline: RouteHandler = (res, params) => {
    sendJson(res, 200, { events: engine.getTimeline(params.id) });
  };

  const contextViews: RouteHandler = (res, params, query) => {
    const runId = query.get('runId');
    if (runId) {
      sendJson(res, 200, { contextViews: [engine.getContextView(params.id, runId)] });
      return;
    }
    const deliberation = engine.getState(params.id);
    const views = db().contextViews.filter((view) =>
      deliberation.runs.some((run) => run.contextViewId === view.id),
    );
    sendJson(res, 200, { contextViews: views });
  };

  const artifacts: RouteHandler = (res, params) => {
    sendJson(res, 200, { artifacts: viewOf(params.id).artifacts });
  };

  const artifactDiff: RouteHandler = (res, params, query) => {
    const against = query.get('against');
    if (!against) throw new HttpError(400, 'against query parameter is required');
    assertDiffAllowed(engine, params.ref);
    const registry = new ArtifactRegistry(db());
    sendJson(res, 200, { diff: registry.diff(params.ref, against) });
  };

  const decisionPack: RouteHandler = (res, params) => {
    sendJson(res, 200, { pack: engine.exportDecisionPack(params.id) });
  };

  const decisionPackMarkdown: RouteHandler = (res, params) => {
    const markdown = decisionPackToMarkdown(engine.exportDecisionPack(params.id));
    res.writeHead(200, { 'content-type': 'text/markdown; charset=utf-8' });
    res.end(markdown);
  };

  const stream: RouteHandler = (res, _params, query) => handleStream(res, query);

  function handleStream(res: ServerResponse, query: URLSearchParams): void {
    const deliberationId = query.get('deliberationId');
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
    });
    res.write('retry: 3000\n\n');
    const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
    const unsubscribe = bus.subscribe((message) => {
      if (deliberationId) {
        if (message.type === 'event' && message.event.objectRef !== deliberationId) return;
        if (message.type === 'run.update' && message.update.deliberationId !== deliberationId) return;
      }
      res.write(`event: ${message.type}\ndata: ${JSON.stringify(message)}\n\n`);
    });
    res.on('close', () => {
      clearInterval(heartbeat);
      unsubscribe();
      res.end();
    });
  }

  // -------------------------------------------------------------------------
  // Routes
  // -------------------------------------------------------------------------

  const routes: Route[] = [
    route('GET', '/api/health', health),
    route('GET', '/api/projects', listProjects),
    route('POST', '/api/projects', createProject),
    route('GET', '/api/projects/:id', getProject),
    route('POST', '/api/projects/:id/archive', archiveProject),
    route('POST', '/api/projects/:id/sources', addSource),
    route('POST', '/api/projects/:id/deliberations', createDeliberation),
    route('POST', '/api/workspaces/:id/deliberations', createDeliberation),
    route('GET', '/api/workspaces/:id/work-items', listWorkItems),
    route('GET', '/api/workspaces/:id/knowledge', workspaceKnowledge),
    route('POST', '/api/workspaces/:id/work-items', createWorkItem),
    route('GET', '/api/work-items/:id', getWorkItem),
    route('PATCH', '/api/work-items/:id', patchWorkItem),
    route('POST', '/api/work-items/:id/entries', addWorkItemEntry),
    route('POST', '/api/work-items/:id/entries/:entryId/status', transitionWorkItemEntry),
    route('POST', '/api/work-items/:id/entries/:entryId/promote', promoteWorkItemEntry),
    route('POST', '/api/work-items/:id/knowledge-refs', addWorkItemKnowledgeRef),
    route('POST', '/api/work-items/:id/invite-agent', inviteAgent),
    route('GET', '/api/deliberations', listDeliberations),
    route('GET', '/api/deliberations/:id', getDeliberation),
    route('POST', '/api/deliberations/:id/participants', addParticipant),
    route('POST', '/api/deliberations/:id/freeze', freeze),
    route('POST', '/api/deliberations/:id/start', startBlindRun),
    route('POST', '/api/deliberations/:id/reveal', reveal),
    route('POST', '/api/deliberations/:id/cancel', cancelRun),
    route('POST', '/api/deliberations/:id/challenges', createChallenge),
    route('POST', '/api/challenges/:id/respond', respondToChallenge),
    route('POST', '/api/deliberations/:id/verify', runVerification),
    route('POST', '/api/deliberations/:id/evidence', addEvidence),
    route('POST', '/api/deliberations/:id/freeze-evidence', freezeEvidence),
    route('POST', '/api/deliberations/:id/finalize-challenges', finalizeChallenges),
    route('POST', '/api/deliberations/:id/review', runReview),
    route('POST', '/api/deliberations/:id/review/submit', submitReview),
    route('POST', '/api/deliberations/:id/decision', humanDecision),
    route('POST', '/api/deliberations/:id/escalate', escalate),
    route('POST', '/api/deliberations/:id/evidence-request', requestMoreEvidence),
    route('GET', '/api/deliberations/:id/timeline', timeline),
    route('GET', '/api/deliberations/:id/context-views', contextViews),
    route('GET', '/api/deliberations/:id/artifacts', artifacts),
    route('GET', '/api/artifacts/:ref/diff', artifactDiff),
    route('GET', '/api/deliberations/:id/decision-pack', decisionPack),
    route('GET', '/api/deliberations/:id/decision-pack.md', decisionPackMarkdown),
    route('GET', '/api/stream', stream),
  ];

  // -------------------------------------------------------------------------
  // HTTP plumbing
  // -------------------------------------------------------------------------

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const pathname = decodeURIComponent(url.pathname);
    try {
      for (const candidate of routes) {
        if (candidate.method !== req.method) continue;
        const match = candidate.pattern.exec(pathname);
        if (!match) continue;
        const params: Record<string, string> = {};
        candidate.keys.forEach((key, index) => {
          params[key] = match[index + 1] ?? '';
        });
        const body = isBodyMethod(req.method) ? await readJsonBody(req) : undefined;
        await mutex.run(candidate.handler === stream ? 'stream' : 'global', () =>
          candidate.handler(res, params, url.searchParams, body),
        );
        return;
      }
      if (req.method === 'GET' && (await serveStatic(res, pathname, staticRoot))) return;
      sendJson(res, 404, {
        error: { code: 404, message: `Not found: ${req.method} ${pathname}` },
      });
    } catch (error) {
      if (res.headersSent) {
        res.end();
      } else {
        sendError(res, error);
      }
    }
  });

  return { server, engine, bus, jobs };
}

function isBodyMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(400, 'Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (!chunks.length) {
        resolve(undefined);
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
      } catch {
        reject(new HttpError(400, 'Invalid JSON body'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: unknown): void {
  const status = error instanceof HttpError ? error.status : errorStatus(error);
  const message = error instanceof Error ? error.message : String(error);
  sendJson(res, status, { error: { code: status, message } });
}

function errorStatus(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/missing:/i.test(message)) return 400;
  if (/not found/i.test(message)) return 404;
  if (/can only|requires|required|only allowed|\bonly\b|cannot|must|Guard rejected|Invalid/i.test(message)) {
    return 409;
  }
  return 500;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === 'string');
}

function isRubric(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const rubric = value as { items?: unknown; maxScore?: unknown };
  return (
    Array.isArray(rubric.items) &&
    rubric.items.length > 0 &&
    rubric.items.every(
      (item) =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as { id?: unknown }).id === 'string' &&
        typeof (item as { name?: unknown }).name === 'string',
    )
  );
}

function assertDiffAllowed(engine: ProtocolEngine, ref: string): void {
  const registry = new ArtifactRegistry(engine.deliberationDatabase);
  const resolved = registry.getVersion(ref);
  if (!resolved) throw new HttpError(404, `Artifact not found: ${ref}`);
  const sourceRunId = resolved.version.sourceRunId;
  if (!sourceRunId) return;
  const deliberation = engine.deliberationDatabase.deliberations.find((item) =>
    item.runs.some((run) => run.id === sourceRunId),
  );
  if (deliberation && ['draft', 'frozen', 'blind_run', 'committed'].includes(deliberation.state)) {
    throw new HttpError(409, 'Candidate artifact diff is not available before reveal');
  }
}

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

async function serveStatic(
  res: ServerResponse,
  pathname: string,
  staticRoot: string,
): Promise<boolean> {
  if (!existsSync(join(staticRoot, 'index.html'))) return false;
  let filePath = normalize(join(staticRoot, pathname));
  if (!filePath.startsWith(staticRoot)) {
    sendJson(res, 403, { error: { code: 403, message: 'Forbidden path' } });
    return true;
  }
  if (!existsSync(filePath) || statSync(filePath).isDirectory()) {
    filePath = join(staticRoot, 'index.html');
  }
  const ext = extname(filePath);
  res.writeHead(200, {
    'content-type': MIME_TYPES[ext] ?? 'application/octet-stream',
  });
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on('error', reject);
    stream.on('end', () => resolve());
    stream.pipe(res);
  });
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.PORT ?? 8787);
  const app = createApiServer();
  app.server.listen(port, () => {
    console.log(`Counterpoint API listening on http://localhost:${port}`);
  });
}
