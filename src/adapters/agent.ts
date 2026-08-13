import type {
  AgentFingerprint,
  ContextView,
  PositionDraft,
  SourceBinding,
  TaskPacket,
} from '../schemas.ts';

export interface VisibleAuthoritySource {
  ref: string;
  binding: SourceBinding;
  content?: string;
}

export interface VisibleArtifact {
  ref: string;
  logicalName: string;
  type: string;
  content: string;
  version: number;
  contentHash: string;
  dependencies: string[];
}

export interface AgentRunInput {
  runId: string;
  participantId: string;
  phase: string;
  isolationMode?: 'blind' | 'shared' | 'private' | 'sealed';
  taskPacket: TaskPacket;
  contextView: ContextView;
  authoritySources: VisibleAuthoritySource[];
  visibleArtifacts: VisibleArtifact[];
  workspacePath: string;
  fingerprintHint?: Partial<AgentFingerprint>;
}

export interface AgentRunResult {
  position: PositionDraft;
  artifacts: Array<{
    logicalName: string;
    type: 'text' | 'markdown' | 'code' | 'json' | 'binary';
    content: string;
    visibility?: 'private' | 'shared' | 'review';
  }>;
  fingerprint: AgentFingerprint;
  logs?: string;
  cost?: number;
}

export interface AgentAdapter {
  readonly name: string;
  run(input: AgentRunInput): Promise<AgentRunResult>;
}
