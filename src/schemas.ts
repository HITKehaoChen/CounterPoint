import { z } from 'zod';

// ---------------------------------------------------------------------------
// Counterpoint Protocol Schemas (PRD v0.1, section 12)
// Deterministic data contracts shared by the Protocol Engine, Context Policy,
// Artifact Registry, adapters and export tooling.
// ---------------------------------------------------------------------------

export const RubricItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  weight: z.number().min(0).max(1).default(1),
});
export type RubricItem = z.infer<typeof RubricItemSchema>;

export const RubricSchema = z.object({
  items: z.array(RubricItemSchema).min(1),
  maxScore: z.number().int().positive().default(5),
});
export type Rubric = z.infer<typeof RubricSchema>;

export const SourceBindingSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['file', 'directory', 'git', 'text']),
  label: z.string().min(1),
  path: z.string().optional(),
  text: z.string().optional(),
  version: z.number().int().positive(),
  snapshotHash: z.string().optional(),
});
export type SourceBinding = z.infer<typeof SourceBindingSchema>;

export const TaskPacketSchema = z.object({
  id: z.string().min(1),
  version: z.number().int().positive(),
  hash: z.string().optional(),
  problem: z.string().min(1),
  goals: z.array(z.string()).min(1),
  constraints: z.array(z.string()).min(1),
  rubric: RubricSchema,
  sources: z.array(z.string()).min(1),
  deliverable: z.string().optional(),
  frozenAt: z.string().optional(),
});
export type TaskPacket = z.infer<typeof TaskPacketSchema>;

export const ParticipantRoleSchema = z.enum(['worker', 'reviewer', 'verifier', 'human']);
export type ParticipantRole = z.infer<typeof ParticipantRoleSchema>;

export const ParticipantSchema = z.object({
  id: z.string().min(1),
  deliberationId: z.string().min(1),
  role: ParticipantRoleSchema,
  label: z.string().optional(),
  adapterConfig: z.record(z.unknown()).optional(),
  fingerprint: z.record(z.unknown()).optional(),
});
export type Participant = z.infer<typeof ParticipantSchema>;

export const RunStatusSchema = z.enum([
  'pending',
  'running',
  'committed',
  'failed',
  'timed_out',
  'cancelled',
]);
export type RunStatus = z.infer<typeof RunStatusSchema>;

export const AgentRunSchema = z.object({
  id: z.string().min(1),
  participantId: z.string().min(1),
  phase: z.string().min(1),
  contextViewId: z.string().optional(),
  positionId: z.string().optional(),
  fingerprint: z.record(z.unknown()).optional(),
  status: RunStatusSchema,
  workspacePath: z.string().optional(),
  startedAt: z.string().optional(),
  finishedAt: z.string().optional(),
  cost: z.number().min(0).optional(),
  error: z.string().optional(),
  logsRef: z.string().optional(),
});
export type AgentRun = z.infer<typeof AgentRunSchema>;

export const ContextViewSchema = z.object({
  id: z.string().min(1),
  runId: z.string().min(1),
  phase: z.string().min(1),
  visible: z.object({
    authoritySources: z.array(z.string()),
    artifacts: z.array(z.string()),
    claims: z.array(z.string()),
    evidence: z.array(z.string()),
  }),
  hidden: z.object({
    agentRuns: z.array(z.string()),
    objectTypes: z.array(z.string()),
  }),
  tools: z.object({
    allow: z.array(z.string()),
    deny: z.array(z.string()),
  }),
  hash: z.string().min(1),
});
export type ContextView = z.infer<typeof ContextViewSchema>;

export const ArtifactTypeSchema = z.enum(['text', 'markdown', 'code', 'json', 'binary']);
export type ArtifactType = z.infer<typeof ArtifactTypeSchema>;

export const ArtifactSchema = z.object({
  id: z.string().min(1),
  logicalName: z.string().min(1),
  type: ArtifactTypeSchema,
  ownerRunId: z.string().optional(),
  visibility: z.enum(['private', 'shared', 'review']),
});
export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactVersionSchema = z.object({
  id: z.string().min(1),
  artifactId: z.string().min(1),
  version: z.number().int().positive(),
  contentHash: z.string().min(1),
  contentRef: z.string().min(1),
  sourceRunId: z.string().optional(),
  dependencies: z.array(z.string()).default([]),
  createdAt: z.string(),
  byteLength: z.number().int().nonnegative(),
  encoding: z.enum(['utf8', 'base64']),
});
export type ArtifactVersion = z.infer<typeof ArtifactVersionSchema>;

export const ClaimTypeSchema = z.enum(['fact', 'preference', 'risk', 'design', 'unknown']);
export type ClaimType = z.infer<typeof ClaimTypeSchema>;

export const ClaimSchema = z.object({
  id: z.string().min(1),
  positionId: z.string().optional(),
  statement: z.string().min(1),
  type: ClaimTypeSchema,
  evidenceRefs: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const PositionDraftSchema = z.object({
  summary: z.string().min(1),
  claims: z.array(ClaimSchema).min(1),
  unknowns: z.array(z.string()).default([]),
  artifactRefs: z.array(z.string()).default([]),
  decisionConditions: z.array(z.string()).default([]),
  confidence: z.number().min(0).max(1),
});
export type PositionDraft = z.infer<typeof PositionDraftSchema>;

export const PositionSchema = PositionDraftSchema.extend({
  id: z.string().min(1),
  runId: z.string().min(1),
  commitmentHash: z.string().min(1),
  committedAt: z.string(),
  status: z.enum(['draft', 'committed', 'superseded']),
});
export type Position = z.infer<typeof PositionSchema>;

export const ChallengeSchema = z.object({
  id: z.string().min(1),
  deliberationId: z.string().min(1),
  targetRef: z.string().min(1),
  authorRunId: z.string().min(1),
  question: z.string().min(1),
  requestedEvidence: z.string().optional(),
  status: z.enum(['open', 'answered', 'evidence_requested', 'unanswerable', 'closed']),
  createdAt: z.string(),
});
export type Challenge = z.infer<typeof ChallengeSchema>;

export const ResponseSchema = z.object({
  id: z.string().min(1),
  challengeId: z.string().min(1),
  authorRunId: z.string().min(1),
  text: z.string().min(1),
  concession: z.boolean().default(false),
  evidenceRefs: z.array(z.string()).default([]),
  createdAt: z.string(),
});
export type Response = z.infer<typeof ResponseSchema>;

export const EvidenceRequestSchema = z.object({
  id: z.string().min(1),
  deliberationId: z.string().min(1),
  challengeId: z.string().optional(),
  assignee: z.enum(['agent', 'verifier', 'human']),
  question: z.string().min(1),
  status: z.enum(['pending', 'fulfilled', 'rejected']),
  createdAt: z.string(),
});
export type EvidenceRequest = z.infer<typeof EvidenceRequestSchema>;

export const EvidenceStatusSchema = z.enum([
  'pending',
  'verified',
  'failed',
  'inconclusive',
  'superseded',
]);
export type EvidenceStatus = z.infer<typeof EvidenceStatusSchema>;

export const EvidenceSchema = z.object({
  id: z.string().min(1),
  deliberationId: z.string().min(1),
  kind: z.enum(['command_result', 'manual', 'authoritative_source']),
  source: z.object({
    command: z.string().optional(),
    args: z.array(z.string()).optional(),
    environmentRef: z.string().optional(),
    description: z.string().optional(),
  }),
  targetRefs: z.array(z.string()).min(1),
  result: z.object({
    exitCode: z.number().optional(),
    stdoutHash: z.string().optional(),
    stderrLogRef: z.string().optional(),
    summary: z.string().optional(),
  }),
  status: EvidenceStatusSchema,
  reproducibility: z.enum(['reproducible', 'observed_once', 'unknown']).optional(),
  hash: z.string().min(1),
  createdAt: z.string(),
  supersededBy: z.string().optional(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ReviewRecommendationSchema = z.enum([
  'candidate_a',
  'candidate_b',
  'merge',
  'insufficient_evidence',
  'no_decision',
]);
export type ReviewRecommendation = z.infer<typeof ReviewRecommendationSchema>;

export const ReviewSchema = z.object({
  id: z.string().min(1),
  deliberationId: z.string().min(1),
  reviewerRunId: z.string().min(1),
  rubricScores: z.record(z.number().min(0)),
  recommendation: ReviewRecommendationSchema,
  rationale: z.string().min(1),
  unresolvedRisks: z.array(z.string()).default([]),
  evidenceSufficiency: z.enum(['sufficient', 'partial', 'insufficient']),
  createdAt: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

export const HumanActionSchema = z.enum([
  'approve',
  'override',
  'merge',
  'request_evidence',
  'no_decision',
]);
export type HumanAction = z.infer<typeof HumanActionSchema>;

export const DecisionSchema = z.object({
  id: z.string().min(1),
  deliberationId: z.string().min(1),
  selectedRefs: z.array(z.string()).default([]),
  rationale: z.string().min(1),
  conditions: z.array(z.string()).default([]),
  dissent: z.array(z.string()).default([]),
  humanAction: HumanActionSchema,
  decidedAt: z.string(),
  ownerId: z.string().min(1),
});
export type Decision = z.infer<typeof DecisionSchema>;

export const DeliberationStateSchema = z.enum([
  'draft',
  'frozen',
  'blind_run',
  'committed',
  'revealed',
  'challenging',
  'verifying',
  'reviewing',
  'escalated',
  'decided',
]);
export type DeliberationState = z.infer<typeof DeliberationStateSchema>;

export const DeliberationSchema = z.object({
  id: z.string().min(1),
  projectId: z.string().min(1),
  protocolVersion: z.string().default('0.1.0'),
  state: DeliberationStateSchema,
  taskPacketId: z.string().optional(),
  ownerId: z.string().min(1),
  participants: z.array(ParticipantSchema).default([]),
  runs: z.array(AgentRunSchema).default([]),
  positions: z.array(PositionSchema).default([]),
  challenges: z.array(ChallengeSchema).default([]),
  responses: z.array(ResponseSchema).default([]),
  evidenceRequests: z.array(EvidenceRequestSchema).default([]),
  evidence: z.array(EvidenceSchema).default([]),
  reviews: z.array(ReviewSchema).default([]),
  decisions: z.array(DecisionSchema).default([]),
  candidateOrder: z.array(z.string()).optional(),
  reviewOrder: z.array(z.string()).optional(),
  rounds: z
    .object({
      challenge: z.number().int().nonnegative().default(0),
      evidence: z.number().int().nonnegative().default(0),
    })
    .default({ challenge: 0, evidence: 0 }),
  createdAt: z.string(),
  updatedAt: z.string(),
  timeoutPolicy: z
    .object({
      defaultMs: z.number().int().positive().default(120000),
      maxEvidenceRounds: z.number().int().nonnegative().default(1),
    })
    .default({ defaultMs: 120000, maxEvidenceRounds: 1 }),
});
export type Deliberation = z.infer<typeof DeliberationSchema>;

export const ProjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  sourceBindings: z.array(SourceBindingSchema).default([]),
  createdAt: z.string(),
  archivedAt: z.string().optional(),
});
export type Project = z.infer<typeof ProjectSchema>;

export const EventSchema = z.object({
  id: z.string().min(1),
  type: z.string().min(1),
  actor: z.string().min(1),
  objectRef: z.string().optional(),
  payload: z.unknown(),
  timestamp: z.string(),
  previousHash: z.string().optional(),
});
export type Event = z.infer<typeof EventSchema>;

export const DatabaseSchema = z.object({
  schemaVersion: z.string().default('0.1.0'),
  projects: z.array(ProjectSchema).default([]),
  deliberations: z.array(DeliberationSchema).default([]),
  taskPackets: z.array(TaskPacketSchema).default([]),
  contextViews: z.array(ContextViewSchema).default([]),
  events: z.array(EventSchema).default([]),
  artifacts: z.array(ArtifactSchema).default([]),
  artifactVersions: z.array(ArtifactVersionSchema).default([]),
  artifactContents: z.record(z.string()).default({}),
  logs: z.record(z.string()).default({}),
});
export type Database = z.infer<typeof DatabaseSchema>;

export const AgentFingerprintSchema = z.object({
  adapter: z.string().min(1),
  model: z.string().optional(),
  provider: z.string().optional(),
  promptVersion: z.string().optional(),
  toolset: z.array(z.string()).default([]),
  contextViewHash: z.string().optional(),
});
export type AgentFingerprint = z.infer<typeof AgentFingerprintSchema>;

export function emptyDatabase(): Database {
  return {
    schemaVersion: '0.1.0',
    projects: [],
    deliberations: [],
    taskPackets: [],
    contextViews: [],
    events: [],
    artifacts: [],
    artifactVersions: [],
    artifactContents: {},
    logs: {},
  };
}
