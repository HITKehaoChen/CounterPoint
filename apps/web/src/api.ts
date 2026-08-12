import type { DecisionPack } from '../../../src/decision-pack.ts';
import type {
  HumanArtifact,
  HumanWorkItemBoard,
  HumanWorkItemView,
  HumanView,
  WorkspaceKnowledge,
} from '../../../src/human-view.ts';
import type {
  Challenge,
  ContextView,
  Deliberation,
  Evidence,
  EvidenceRequest,
  Event,
  Participant,
  Project,
  Response as ProtocolResponse,
  Rubric,
  SourceBinding,
  WorkItemEntry,
  WorkItemKind,
  WorkItemStatus,
} from '../../../src/schemas.ts';
import type { DiffResult } from '../../../src/artifact-registry.ts';

export interface DeliberationSummary {
  id: string;
  projectId: string;
  state: string;
  createdAt: string;
  updatedAt: string;
  problem?: string;
  positionCount: number;
}

interface ErrorBody {
  error?: { code?: number; message?: string };
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, init);
  const text = await response.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) {
    const message = (body as ErrorBody | null)?.error?.message;
    throw new Error(message ?? `请求失败：HTTP ${response.status}`);
  }
  return body as T;
}

function post<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export const api = {
  listProjects: () => request<{ projects: Project[] }>('/api/projects'),
  getProject: (projectId: string) => request<{ project: Project }>(`/api/projects/${projectId}`),
  createProject: (input: { name: string; description?: string }) =>
    post<{ project: Project }>('/api/projects', input),
  archiveProject: (projectId: string) =>
    post<{ project: Project }>(`/api/projects/${projectId}/archive`, {}),
  addSource: (
    projectId: string,
    input: { type: 'text' | 'file' | 'directory' | 'git'; label: string; text?: string; path?: string },
  ) => post<{ binding: SourceBinding }>(`/api/projects/${projectId}/sources`, input),
  listWorkItems: (workspaceId: string) =>
    request<{ board: HumanWorkItemBoard }>(`/api/workspaces/${workspaceId}/work-items`),
  workspaceKnowledge: (workspaceId: string) =>
    request<{ knowledge: WorkspaceKnowledge }>(`/api/workspaces/${workspaceId}/knowledge`),
  createWorkItem: (
    workspaceId: string,
    input: {
      kind: WorkItemKind;
      title: string;
      description?: string;
      templateFields?: Record<string, unknown>;
    },
  ) => post<{ workItem: HumanWorkItemView }>(`/api/workspaces/${workspaceId}/work-items`, input),
  getWorkItem: (workItemId: string) =>
    request<{ workItem: HumanWorkItemView }>(`/api/work-items/${workItemId}`),
  patchWorkItem: (
    workItemId: string,
    patch: {
      description?: string;
      status?: WorkItemStatus;
      templateFields?: Record<string, unknown>;
      relations?: Array<{ relation: string; targetRef: string }>;
    },
  ) =>
    request<{ workItem: HumanWorkItemView }>(`/api/work-items/${workItemId}`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    }),
  addWorkItemEntry: (workItemId: string, input: Record<string, unknown>) =>
    post<{ entry: WorkItemEntry; workItem: HumanWorkItemView }>(
      `/api/work-items/${workItemId}/entries`,
      input,
    ),
  transitionWorkItemEntry: (workItemId: string, entryId: string, status: string) =>
    post<{ entry: WorkItemEntry }>(
      `/api/work-items/${workItemId}/entries/${entryId}/status`,
      { status },
    ),
  promoteWorkItemEntry: (workItemId: string, entryId: string) =>
    post<{ entry: WorkItemEntry }>(
      `/api/work-items/${workItemId}/entries/${entryId}/promote`,
      {},
    ),
  addWorkItemKnowledgeRef: (workItemId: string, ref: Record<string, unknown>) =>
    post<{ workItem: HumanWorkItemView }>(
      `/api/work-items/${workItemId}/knowledge-refs`,
      ref,
    ),
  inviteAgent: (workItemId: string, prompt?: string) =>
    post<{ jobId: string; status: number }>(`/api/work-items/${workItemId}/invite-agent`, {
      prompt,
    }),
  createRound: (
    workspaceId: string,
    input: {
      ownerId: string;
      problem: string;
      goals: string[];
      constraints: string[];
      rubric: Rubric;
      workItemId: string;
    },
  ) =>
    post<{ deliberation: Deliberation }>(
      `/api/workspaces/${workspaceId}/deliberations`,
      input,
    ),
  listDeliberations: (projectId?: string) => {
    const query = projectId ? `?projectId=${encodeURIComponent(projectId)}` : '';
    return request<{ deliberations: DeliberationSummary[] }>(`/api/deliberations${query}`);
  },
  getDeliberation: (id: string) => request<HumanView>(`/api/deliberations/${id}`),
  createDeliberation: (
    projectId: string,
    input: {
      ownerId: string;
      problem: string;
      goals: string[];
      constraints: string[];
      rubric: Rubric;
      deliverable?: string;
    },
  ) =>
    post<{ deliberation: Deliberation }>(`/api/projects/${projectId}/deliberations`, input),
  addParticipant: (
    deliberationId: string,
    input: { role: 'worker' | 'reviewer' | 'verifier' | 'human'; label?: string; adapterConfig?: Record<string, unknown> },
  ) => post<{ participant: Participant }>(`/api/deliberations/${deliberationId}/participants`, input),
  freeze: (deliberationId: string) =>
    post<{ view: HumanView }>(`/api/deliberations/${deliberationId}/freeze`, {}),
  start: (deliberationId: string) =>
    post<{ jobId: string; status: number }>(`/api/deliberations/${deliberationId}/start`, {}),
  reveal: (deliberationId: string) =>
    post<{ view: HumanView }>(`/api/deliberations/${deliberationId}/reveal`, {}),
  cancelRun: (deliberationId: string, runId: string) =>
    post<{ view: HumanView }>(`/api/deliberations/${deliberationId}/cancel`, { runId }),
  createChallenge: (
    deliberationId: string,
    input: { targetRef: string; authorRunId: string; question: string; requestedEvidence?: string },
  ) => post<{ challenge: Challenge }>(`/api/deliberations/${deliberationId}/challenges`, input),
  respondChallenge: (
    challengeId: string,
    input: { authorRunId: string; text: string; concession?: boolean; evidenceRefs?: string[] },
  ) => post<{ response: ProtocolResponse }>(`/api/challenges/${challengeId}/respond`, input),
  verify: (
    deliberationId: string,
    input: { command: string; args: string[]; targetRefs: string[]; description?: string },
  ) => post<{ jobId: string; status: number }>(`/api/deliberations/${deliberationId}/verify`, input),
  addEvidence: (
    deliberationId: string,
    input: {
      targetRefs: string[];
      status: string;
      resultSummary: string;
      sourceDescription?: string;
    },
  ) => post<{ evidence: Evidence }>(`/api/deliberations/${deliberationId}/evidence`, input),
  freezeEvidence: (deliberationId: string) =>
    post<{ view: HumanView }>(`/api/deliberations/${deliberationId}/freeze-evidence`, {}),
  finalizeChallenges: (deliberationId: string) =>
    post<{ view: HumanView }>(`/api/deliberations/${deliberationId}/finalize-challenges`, {}),
  runReview: (deliberationId: string) =>
    post<{ jobId: string; status: number }>(`/api/deliberations/${deliberationId}/review`, {}),
  escalate: (deliberationId: string, rationale: string) =>
    post<{ view: HumanView }>(`/api/deliberations/${deliberationId}/escalate`, { rationale }),
  requestMoreEvidence: (deliberationId: string, rationale: string) =>
    post<{ request: EvidenceRequest; view: HumanView }>(
      `/api/deliberations/${deliberationId}/evidence-request`,
      { rationale },
    ),
  humanDecision: (
    deliberationId: string,
    input: { action: string; rationale: string; conditions?: string[]; ownerId?: string },
  ) => post<{ decision: { id: string; humanAction: string } }>(
    `/api/deliberations/${deliberationId}/decision`,
    input,
  ),
  timeline: (deliberationId: string) =>
    request<{ events: Event[] }>(`/api/deliberations/${deliberationId}/timeline`),
  contextViews: (deliberationId: string, runId?: string) => {
    const query = runId ? `?runId=${encodeURIComponent(runId)}` : '';
    return request<{ contextViews: ContextView[] }>(
      `/api/deliberations/${deliberationId}/context-views${query}`,
    );
  },
  artifacts: (deliberationId: string) =>
    request<{ artifacts: HumanArtifact[] }>(`/api/deliberations/${deliberationId}/artifacts`),
  artifactDiff: (ref: string, against: string) =>
    request<{ diff: DiffResult }>(
      `/api/artifacts/${encodeURIComponent(ref)}/diff?against=${encodeURIComponent(against)}`,
    ),
  decisionPack: (deliberationId: string) =>
    request<{ pack: DecisionPack }>(`/api/deliberations/${deliberationId}/decision-pack`),
};
