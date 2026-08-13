import type { AgentAdapter } from '../adapters/agent.ts';
import type { ReviewerAdapter } from '../adapters/reviewer.ts';
import type { PublishArtifactInput } from '../artifact-registry.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { HumanGateRequest } from '../autonomy/human-gate.ts';
import type { BudgetLedger, BudgetUsage } from '../execution/budget-ledger.ts';
import type { GraphNode } from '../execution/execution-graph.ts';
import type { NewEvent } from '../events.ts';
import type { OperatorSpec } from '../planning/schemas.ts';
import type { Claim, ContextView, Database, Evidence, NodeRun, WorkItem } from '../schemas.ts';
import type { MaterializedNodeContext } from '../execution/context-view.ts';
import { AgentTaskOperator } from './agent-task.ts';
import { ToolTaskOperator } from './tool-task.ts';
import { VerificationOperator } from './verification.ts';
import { IndependentReviewOperator } from './independent-review.ts';
import { CounterpointDeliberationOperator } from './counterpoint-deliberation.ts';
import { HumanGateOperator } from './human-gate.ts';
import type { ProtocolEngine } from '../protocol-engine.ts';

class UnavailableOperator implements Operator {
  readonly type = 'counterpoint_deliberation' as const;
  async run(): Promise<OperatorResult> {
    throw new Error('OPERATOR_UNAVAILABLE');
  }
}

export interface OperatorWriteBatch {
  artifacts?: PublishArtifactInput[];
  claims?: Claim[];
  evidence?: Evidence[];
}

export interface OperatorContext {
  graphNode: GraphNode;
  nodeRun: NodeRun;
  workItem: WorkItem;
  contextView: ContextView;
  workspacePath: string;
  envelope: AutonomyEnvelope;
  resolveAgent(capability: string): AgentAdapter | undefined;
  resolveReviewer(capability: string): ReviewerAdapter | undefined;
  /** Scheduler-provided, serialized write path. Returns published artifact refs. */
  commit(batch: OperatorWriteBatch): string[];
  ledger: BudgetLedger;
  emit(event: NewEvent): void;
  requestHumanGate(input: HumanGateRequest): HumanGateRequest;
  readDb(): Readonly<Database>;
  materialize(): MaterializedNodeContext;
}

export interface OperatorResult {
  status: 'succeeded' | 'failed' | 'waiting_human';
  artifactRefs: string[];
  evidenceRefs: string[];
  claimRefs: string[];
  opinionRefs: string[];
  outputs: Record<string, unknown>;
  usage?: BudgetUsage;
  error?: string;
}

export interface Operator {
  readonly type: OperatorSpec['type'];
  run(ctx: OperatorContext): Promise<OperatorResult>;
}

export type OperatorRegistry = Map<OperatorSpec['type'], Operator>;

export function createOperatorRegistry(deps: { engine?: ProtocolEngine } = {}): OperatorRegistry {
  return new Map<OperatorSpec['type'], Operator>([
    ['agent_task', new AgentTaskOperator()],
    ['tool_task', new ToolTaskOperator()],
    ['verification', new VerificationOperator()],
    ['independent_review', new IndependentReviewOperator()],
    [
      'counterpoint_deliberation',
      deps.engine ? new CounterpointDeliberationOperator(deps.engine) : new UnavailableOperator(),
    ],
    ['human_gate', new HumanGateOperator()],
  ]);
}
