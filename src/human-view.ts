import type {
  Artifact,
  ArtifactVersion,
  Challenge,
  Claim,
  Database,
  Decision,
  Deliberation,
  Evidence,
  EvidenceRequest,
  KnowledgeRef,
  Participant,
  Response,
  Review,
  TaskPacket,
  WorkItem,
  WorkItemClaim,
  WorkItemEntry,
  WorkItemKind,
} from './schemas.ts';
import { formatVersionRef } from './hashing.ts';
import { buildReviewerCandidates } from './context-policy.ts';

const BLIND_STATES: Deliberation['state'][] = ['draft', 'frozen', 'blind_run', 'committed'];

export interface HumanRun {
  id: string;
  participantId: string;
  phase: string;
  status: 'pending' | 'running' | 'committed' | 'failed' | 'timed_out' | 'cancelled';
  contextViewId?: string;
  positionId?: string;
  startedAt?: string;
  finishedAt?: string;
  cost?: number;
  error?: string;
  fingerprint?: Record<string, unknown>;
  logsRef?: string;
  workspacePath?: string;
}

export interface HumanClaim {
  id: string;
  statement: string;
  type: Claim['type'];
  evidenceRefs: string[];
  confidence?: number;
}

export interface HumanPosition {
  id: string;
  label: string;
  summary: string;
  claims: HumanClaim[];
  unknowns: string[];
  decisionConditions: string[];
  confidence: number;
  commitmentHash: string;
  artifactRefs: string[];
}

export interface HumanArtifact {
  ref: string;
  logicalName: string;
  type: Artifact['type'];
  version: number;
  contentHash: string;
  visibility: Artifact['visibility'];
  dependencies: string[];
  byteLength: number;
  encoding: ArtifactVersion['encoding'];
  content?: string;
}

export interface HumanAuthor {
  role: Participant['role'];
  candidateLabel?: string;
}

export interface HumanChallenge {
  id: string;
  targetRef: string;
  question: string;
  requestedEvidence?: string;
  status: Challenge['status'];
  createdAt: string;
  author: HumanAuthor;
}

export interface HumanResponse {
  challengeId: string;
  text: string;
  concession: boolean;
  evidenceRefs: string[];
  createdAt: string;
  author: HumanAuthor;
}

export interface HumanView {
  deliberation: {
    id: string;
    projectId: string;
    protocolVersion: string;
    state: Deliberation['state'];
    taskPacketId?: string;
    workItemId?: string;
    ownerId: string;
    rounds: Deliberation['rounds'];
    createdAt: string;
    updatedAt: string;
    timeoutPolicy: Deliberation['timeoutPolicy'];
    candidateOrder: string[];
    reviewOrder?: string[];
  };
  taskPacket: TaskPacket;
  participants: Array<{ id: string; role: Participant['role']; label?: string }>;
  runs: HumanRun[];
  positions: HumanPosition[];
  claims: HumanClaim[];
  artifacts: HumanArtifact[];
  evidence: Evidence[];
  challenges: HumanChallenge[];
  responses: HumanResponse[];
  evidenceRequests: EvidenceRequest[];
  reviews: Review[];
  decisions: Decision[];
  unresolvedConflicts: string[];
  candidateOrder: string[];
  state: Deliberation['state'];
  reviewOrder?: string[];
}

export interface HumanWorkItemEntry {
  id: string;
  kind: WorkItemEntry['kind'];
  statement?: string;
  status?: string;
  evidenceRefs?: string[];
  text?: string;
  assignee?: string;
  answer?: string;
  author: string;
  createdAt: string;
}

export interface HumanWorkItemRound {
  deliberationId: string;
  state: string;
  createdAt: string;
  decidedAt?: string;
  recommendation?: string;
}

export interface HumanWorkItemView {
  id: string;
  workspaceId: string;
  kind: WorkItemKind;
  title: string;
  description?: string;
  ownerId: string;
  status: WorkItem['status'];
  templateFields: Record<string, unknown>;
  currentConclusionRefs: string[];
  knowledgeRefs: WorkItem['knowledgeRefs'];
  relations: WorkItem['relations'];
  entries: HumanWorkItemEntry[];
  rounds: HumanWorkItemRound[];
  version: number;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
}

export interface HumanWorkItemSummary {
  id: string;
  title: string;
  kind: WorkItemKind;
  status: WorkItem['status'];
  updatedAt: string;
  roundCount: number;
}

export interface HumanWorkItemBoard {
  groups: Record<WorkItemKind, HumanWorkItemSummary[]>;
}

export interface WorkspaceKnowledge {
  promotedClaims: Array<{
    workItemId: string;
    workItemTitle: string;
    claimId: string;
    statement: string;
  }>;
  knowledgeRefs: Array<{
    workItemId: string;
    workItemTitle: string;
    ref: KnowledgeRef;
  }>;
}

/**
 * Human-side projection of a Deliberation (PRD 10.2).
 *
 * This is the ONLY shape the Web Console may render. During blind phases
 * (`blind_run`/`committed`) candidate summaries, claims, artifact contents
 * and run logs are removed; after Reveal, candidates are labelled
 * "候选 X/候选 Y" without author or model identity, and unresolved conflicts
 * are always listed explicitly.
 */
export function buildHumanView(
  db: Database,
  deliberationId: string,
  seed = 'counterpoint-default-seed',
): HumanView {
  const deliberation = db.deliberations.find((item) => item.id === deliberationId);
  if (!deliberation) throw new Error(`Deliberation not found: ${deliberationId}`);
  const packet = db.taskPackets.find((item) => item.id === deliberation.taskPacketId);
  if (!packet) throw new Error(`Task Packet missing for ${deliberationId}`);

  const revealed = !BLIND_STATES.includes(deliberation.state);
  const committed = deliberation.positions.filter((position) => position.status === 'committed');
  const order =
    deliberation.reviewOrder ??
    deliberation.candidateOrder ??
    buildReviewerCandidates(committed, seed).order;
  const labelForPosition = new Map<string, string>();
  order.forEach((positionId, index) => labelForPosition.set(positionId, candidateLabel(index)));

  const runLabel = (runId: string): string | undefined => {
    const position = committed.find((item) => item.runId === runId);
    return position ? labelForPosition.get(position.id) : undefined;
  };
  const authorFor = (runId: string): HumanAuthor => {
    const run = deliberation.runs.find((item) => item.id === runId);
    const participant = deliberation.participants.find((item) => item.id === run?.participantId);
    return {
      role: participant?.role ?? 'human',
      candidateLabel: runLabel(runId),
    };
  };

  const positions: HumanPosition[] = revealed
    ? committed.map((position) => ({
        id: position.id,
        label: labelForPosition.get(position.id) ?? candidateLabel(committed.indexOf(position)),
        summary: position.summary,
        claims: position.claims.map((claim) => ({
          id: claim.id,
          statement: claim.statement,
          type: claim.type,
          evidenceRefs: claim.evidenceRefs,
          confidence: claim.confidence,
        })),
        unknowns: position.unknowns,
        decisionConditions: position.decisionConditions,
        confidence: position.confidence,
        commitmentHash: position.commitmentHash,
        artifactRefs: position.artifactRefs,
      }))
    : [];

  const claims: HumanClaim[] = revealed
    ? committed.flatMap((position) =>
        position.claims.map((claim) => ({
          id: claim.id,
          statement: claim.statement,
          type: claim.type,
          evidenceRefs: claim.evidenceRefs,
          confidence: claim.confidence,
        })),
      )
    : [];

  const artifacts: HumanArtifact[] = db.artifacts.flatMap((artifact) =>
    db.artifactVersions
      .filter((version) => version.artifactId === artifact.id)
      .sort((a, b) => a.version - b.version)
      .map((version) => ({
        ref: formatVersionRef(artifact.logicalName, version.version),
        logicalName: artifact.logicalName,
        type: artifact.type,
        version: version.version,
        contentHash: version.contentHash,
        visibility: artifact.visibility,
        dependencies: version.dependencies,
        byteLength: version.byteLength,
        encoding: version.encoding,
        content: revealed ? db.artifactContents[version.contentRef] : undefined,
      })),
  );

  const challenges = deliberation.challenges.map((challenge) => ({
    id: challenge.id,
    targetRef: challenge.targetRef,
    question: challenge.question,
    requestedEvidence: challenge.requestedEvidence,
    status: challenge.status,
    createdAt: challenge.createdAt,
    author: authorFor(challenge.authorRunId),
  }));

  const responses = deliberation.responses.map((response) => ({
    challengeId: response.challengeId,
    text: response.text,
    concession: response.concession,
    evidenceRefs: response.evidenceRefs,
    createdAt: response.createdAt,
    author: authorFor(response.authorRunId),
  }));

  const unresolvedConflicts = [
    ...deliberation.challenges
      .filter(
        (challenge) =>
          challenge.status === 'evidence_requested' ||
          challenge.status === 'open' ||
          !deliberation.responses.some((response) => response.challengeId === challenge.id),
      )
      .map((challenge) => challenge.question),
    ...deliberation.reviews.flatMap((review) => review.unresolvedRisks),
    ...deliberation.decisions.flatMap((decision) => decision.dissent),
  ];

  return {
    state: deliberation.state,
    deliberation: {
      id: deliberation.id,
      projectId: deliberation.projectId,
      protocolVersion: deliberation.protocolVersion,
      state: deliberation.state,
      taskPacketId: deliberation.taskPacketId,
      workItemId: deliberation.workItemId,
      ownerId: deliberation.ownerId,
      rounds: deliberation.rounds,
      createdAt: deliberation.createdAt,
      updatedAt: deliberation.updatedAt,
      timeoutPolicy: deliberation.timeoutPolicy,
      candidateOrder: order,
      reviewOrder: deliberation.reviewOrder,
    },
    taskPacket: packet,
    participants: deliberation.participants.map((participant) => ({
      id: participant.id,
      role: participant.role,
      label: participant.label,
    })),
    runs: deliberation.runs.map((run) => ({
      id: run.id,
      participantId: run.participantId,
      phase: run.phase,
      status: run.status,
      contextViewId: run.contextViewId,
      positionId: run.positionId,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      cost: run.cost,
      error: run.error,
      fingerprint: revealed ? run.fingerprint : undefined,
      logsRef: revealed ? run.logsRef : undefined,
      workspacePath: run.workspacePath,
    })),
    positions,
    claims,
    artifacts,
    evidence: deliberation.evidence,
    challenges,
    responses,
    evidenceRequests: deliberation.evidenceRequests,
    reviews: deliberation.reviews,
    decisions: deliberation.decisions,
    unresolvedConflicts: [...new Set(unresolvedConflicts)],
    candidateOrder: order,
    reviewOrder: deliberation.reviewOrder,
  };
}

/**
 * Human-side projection of a WorkItem (PRD §8/§10). Collaboration entries
 * and round history are shown without protocol-internal candidate content.
 */
export function buildWorkItemView(db: Database, workItemId: string): HumanWorkItemView {
  const workItem = db.workItems.find((item) => item.id === workItemId);
  if (!workItem) throw new Error(`WorkItem not found: ${workItemId}`);
  const rounds: HumanWorkItemRound[] = db.deliberations
    .filter((deliberation) => deliberation.workItemId === workItem.id)
    .map((deliberation) => ({
      deliberationId: deliberation.id,
      state: deliberation.state,
      createdAt: deliberation.createdAt,
      decidedAt: deliberation.decisions[deliberation.decisions.length - 1]?.decidedAt,
      recommendation:
        deliberation.reviews[deliberation.reviews.length - 1]?.recommendation,
    }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const entries: HumanWorkItemEntry[] = workItem.entries.map((entry) =>
    entry.kind === 'claim'
      ? {
          id: entry.id,
          kind: 'claim',
          statement: entry.statement,
          status: entry.status,
          evidenceRefs: entry.evidenceRefs,
          author: entry.author,
          createdAt: entry.createdAt,
        }
      : entry.kind === 'question'
        ? {
            id: entry.id,
            kind: 'question',
            text: entry.text,
            assignee: entry.assignee,
            answer: entry.answer,
            author: entry.author,
            createdAt: entry.createdAt,
          }
        : {
            id: entry.id,
            kind: 'update',
            text: entry.text,
            author: entry.author,
            createdAt: entry.createdAt,
          },
  );
  return {
    ...workItem,
    entries,
    rounds,
  };
}

/** Board projection: work items grouped by kind, newest first. */
export function buildWorkItemBoard(db: Database, workspaceId: string): HumanWorkItemBoard {
  const groups: Record<WorkItemKind, HumanWorkItemSummary[]> = {
    problem: [],
    requirement: [],
    bug: [],
    hypothesis: [],
    decision: [],
  };
  const summaries: HumanWorkItemSummary[] = db.workItems
    .filter((workItem) => workItem.workspaceId === workspaceId)
    .map((workItem) => ({
      id: workItem.id,
      title: workItem.title,
      kind: workItem.kind,
      status: workItem.status,
      updatedAt: workItem.updatedAt,
      roundCount: db.deliberations.filter(
        (deliberation) => deliberation.workItemId === workItem.id,
      ).length,
    }));
  for (const summary of summaries) groups[summary.kind].push(summary);
  for (const list of Object.values(groups)) {
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }
  return { groups };
}

/** Workspace-level knowledge: only Promoted claims and scoped knowledge refs. */
export function buildWorkspaceKnowledge(
  db: Database,
  workspaceId: string,
): WorkspaceKnowledge {
  const items = db.workItems.filter((workItem) => workItem.workspaceId === workspaceId);
  const promotedClaims = items.flatMap((workItem) =>
    workItem.entries
      .filter(
        (entry): entry is WorkItemClaim =>
          entry.kind === 'claim' && entry.status === 'promoted',
      )
      .map((entry) => ({
        workItemId: workItem.id,
        workItemTitle: workItem.title,
        claimId: entry.id,
        statement: entry.statement,
      })),
  );
  const knowledgeRefs = items.flatMap((workItem) =>
    workItem.knowledgeRefs.map((ref) => ({
      workItemId: workItem.id,
      workItemTitle: workItem.title,
      ref,
    })),
  );
  return { promotedClaims, knowledgeRefs };
}

function candidateLabel(index: number): string {
  if (index === 0) return '候选 X';
  if (index === 1) return '候选 Y';
  return `候选 ${index + 1}`;
}
