import type { AgentAdapter } from '../adapters/agent.ts';
import type { ReviewerAdapter } from '../adapters/reviewer.ts';
import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { HumanGateAction, HumanGateRequest } from '../autonomy/human-gate.ts';
import { ArtifactRegistry } from '../artifact-registry.ts';
import { newId } from '../ids.ts';
import type { Store } from '../store.ts';
import type { CollaborationPlan } from '../planning/schemas.ts';
import type { PlanPatch } from '../planning/plan-patch.ts';
import type { CapabilityCatalog } from '../planning/capabilities.ts';
import { buildNodeContextView, materializeNodeContext } from './context-view.ts';
import { compilePlan } from './graph-compiler.ts';
import { computeReadyNodes, type ExecutionGraph, type GraphNode } from './execution-graph.ts';
import { BudgetLedger } from './budget-ledger.ts';
import type { NewEvent } from '../events.ts';
import { hashJson } from '../hashing.ts';
import type {
  Database,
  Event,
  NodeRun,
  WorkItem,
} from '../schemas.ts';
import type {
  Operator,
  OperatorContext,
  OperatorRegistry,
  OperatorResult,
  OperatorWriteBatch,
} from '../operators/operator.ts';
import { normalizeOutputRefs } from '../operators/operator.ts';

export interface SchedulerOptions {
  db: Database;
  store: Store;
  envelope: AutonomyEnvelope;
  operators: OperatorRegistry;
  ledger: BudgetLedger;
  catalog: CapabilityCatalog;
  maxParallelism: number;
  resolveAgent: (capability: string) => AgentAdapter | undefined;
  resolveReviewer: (capability: string) => ReviewerAdapter | undefined;
  onEvent?: (event: Event) => void;
  onNodeRunUpdate?: (run: NodeRun) => void;
  seed?: string;
}

export class Scheduler {
  private readonly options: SchedulerOptions;
  private graph: ExecutionGraph | undefined;
  private plan: CollaborationPlan | undefined;
  private workItem: WorkItem | undefined;
  private readonly nodeRuns = new Map<string, NodeRun>();

  constructor(options: SchedulerOptions) {
    this.options = options;
    this.recoverInterruptedRuns();
  }

  attach(graph: ExecutionGraph, plan: CollaborationPlan, workItem: WorkItem): void {
    this.graph = graph;
    this.plan = plan;
    this.workItem = workItem;
    for (const node of graph.nodes) {
      this.ensureNodeRun(node);
    }
  }

  getGraph(): ExecutionGraph {
    if (!this.graph) throw new Error('SCHEDULER_NOT_ATTACHED');
    return this.graph;
  }

  async runUntilIdle(): Promise<{ completed: boolean; waitingHuman: boolean }> {
    let guard = 0;
    while (guard++ < 1000) {
      if (!this.graph) throw new Error('SCHEDULER_NOT_ATTACHED');
      const ready = computeReadyNodes(this.graph).slice(0, this.options.maxParallelism);
      if (ready.length === 0) break;
      await Promise.all(ready.map((node) => this.runNode(node)));
      if (this.hasWaitingHuman()) {
        return { completed: false, waitingHuman: true };
      }
    }
    if (!this.graph) throw new Error('SCHEDULER_NOT_ATTACHED');
    const terminal = this.graph.nodes.every((node) =>
      ['succeeded', 'failed', 'cancelled', 'skipped', 'waiting_human'].includes(node.status),
    );
    return { completed: terminal, waitingHuman: this.hasWaitingHuman() };
  }

  async resumeGate(runId: string, action: HumanGateAction, payload?: Record<string, unknown>): Promise<void> {
    const run = this.nodeRuns.get(runId);
    if (!run) throw new Error(`NodeRun not found: ${runId}`);
    const node = this.graph?.nodes.find((item) => item.id === run.graphNodeId);
    if (!node) throw new Error(`Graph node not found: ${run.graphNodeId}`);
    const operator = this.options.operators.get(node.operator.type);
    if (!operator || !('resume' in operator)) throw new Error(`Operator ${node.operator.type} cannot resume`);
    const gate = this.options.db.humanGateRequests.find(
      (item) => item.nodeId === node.id && item.status === 'pending' && item.workItemId === run.workItemId,
    );
    if (!gate) throw new Error('PENDING_GATE_NOT_FOUND');
    const ctx = this.buildContext(node, run);
    const result = await (operator as Operator & { resume(ctx: OperatorContext, gate: HumanGateRequest, action: HumanGateAction, payload?: Record<string, unknown>): Promise<OperatorResult> }).resume(
      ctx,
      gate,
      action,
      payload,
    );
    this.options.ledger.settle(run.id, result.usage ?? { timeMs: 0 });
    this.finishResult(node, run, result);
  }

  applyPlanUpdate(input: {
    previousPlan: CollaborationPlan;
    updatedPlan: CollaborationPlan;
    patch: PlanPatch;
  }): void {
    if (!this.plan || !this.graph || !this.workItem) throw new Error('SCHEDULER_NOT_ATTACHED');
    if (this.plan.version !== input.previousPlan.version) {
      throw new Error(`VERSION_CONFLICT: current ${this.plan.version} != previous ${input.previousPlan.version}`);
    }
    const runningIds = this.graph.nodes
      .filter((node) => node.status === 'running' || node.status === 'succeeded')
      .map((node) => node.planNodeId);
    const cancelledIds = input.previousPlan.nodes
      .map((node) => node.id)
      .filter((id) => !input.updatedPlan.nodes.some((node) => node.id === id));
    const immutableTouched = cancelledIds.filter((id) => runningIds.includes(id));
    if (immutableTouched.length) throw new Error(`PATCH_TARGET_IMMUTABLE: ${immutableTouched.join(', ')}`);

    const previousByPlanId = new Map(this.graph.nodes.map((node) => [node.planNodeId, node]));
    const newGraph = compilePlan({ plan: input.updatedPlan, catalog: this.options.catalog });
    for (const newNode of newGraph.nodes) {
      const previous = previousByPlanId.get(newNode.planNodeId);
      if (!previous) continue;
      if (['running', 'succeeded', 'failed', 'waiting_human'].includes(previous.status)) {
        newNode.status = previous.status;
      } else if (newNode.dependsOn.length === 0) {
        newNode.status = 'ready';
      }
    }
    for (const planNodeId of cancelledIds) {
      const run = [...this.nodeRuns.values()].find((item) => item.graphNodeId === `gn_${planNodeId}`);
      if (run) {
        run.status = 'cancelled';
        run.cancelReason = 'patch';
        run.outputs = { ...run.outputs, cancelled_by_patch: input.patch.id };
      }
    }
    this.plan = input.updatedPlan;
    this.graph = newGraph;
    for (const node of newGraph.nodes) this.ensureNodeRun(node);
    this.persist();
    this.emit({ type: 'plan_patch.applied', actor: input.patch.proposedByRunId, objectRef: input.updatedPlan.id, payload: { patchId: input.patch.id, version: input.updatedPlan.version } });
  }

  private recoverInterruptedRuns(): void {
    for (const run of this.options.db.nodeRuns.filter((item) => item.status === 'running')) {
      if (run.effectClass === 'non_idempotent') {
        run.status = 'waiting_human';
        run.error = 'interrupted; recovered after restart (non_idempotent)';
        const gate: HumanGateRequest = {
          id: newId('hg'),
          workItemId: run.workItemId,
          planId: run.planId,
          nodeId: run.graphNodeId,
          kind: 'high_risk',
          summary: 'non_idempotent run interrupted; manual decision required',
          requested: { runId: run.id },
          status: 'pending',
          availableActions: ['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop'],
          createdAt: new Date().toISOString(),
        };
        this.options.db.humanGateRequests.push(gate);
      } else {
        run.status = 'failed';
        run.error = 'interrupted; recovered after restart';
      }
    }
    this.persist();
  }

  private ensureNodeRun(node: GraphNode): NodeRun {
    const existing = this.options.db.nodeRuns.find((item) => item.graphNodeId === node.id);
    if (existing) {
      this.nodeRuns.set(existing.id, existing);
      return existing;
    }
    const run: NodeRun = {
      id: newId('nr'),
      workItemId: this.workItem?.id ?? '',
      planId: this.plan?.id ?? '',
      planVersion: this.plan?.version ?? 1,
      graphNodeId: node.id,
      role: node.role,
      operatorType: node.operator.type,
      status: 'pending',
      attempt: 0,
      attempts: [],
      artifactRefs: [],
      evidenceRefs: [],
      claimRefs: [],
      opinionRefs: [],
      outputs: {},
      effectClass: node.effectClass,
    };
    this.options.db.nodeRuns.push(run);
    this.nodeRuns.set(run.id, run);
    return run;
  }

  private async runNode(node: GraphNode): Promise<void> {
    const run = this.ensureNodeRun(node);
    const budget = node.allocatedBudget;
    let attempt = run.attempt;
    for (;;) {
      try {
        this.options.ledger.reserve(run.id, budget);
      } catch (error) {
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        this.persist();
        return;
      }
      attempt += 1;
      run.attempt = attempt;
      run.status = 'running';
      run.error = undefined;
      run.startedAt = new Date().toISOString();
      const started = Date.now();
      const operator = this.options.operators.get(node.operator.type);
      if (!operator) {
        run.status = 'failed';
        run.error = `OPERATOR_MISSING: ${node.operator.type}`;
        this.options.ledger.release(run.id);
        this.persist();
        return;
      }
      const ctx = this.buildContext(node, run);
      let result: OperatorResult;
      try {
        result = await operator.run(ctx);
      } catch (error) {
        result = { status: 'failed', artifactRefs: [], evidenceRefs: [], claimRefs: [], opinionRefs: [], outputs: {}, usage: { timeMs: Date.now() - started }, error: error instanceof Error ? error.message : String(error) };
      }
      run.attempts.push({
        attempt,
        startedAt: run.startedAt,
        finishedAt: new Date().toISOString(),
        costUsd: result.usage?.costUsd ?? 0,
        error: result.error,
      });
      run.finishedAt = new Date().toISOString();
      if (result.status === 'waiting_human') {
        run.status = 'waiting_human';
        this.finishResult(node, run, result, { settle: false });
        return;
      }
      try {
        this.options.ledger.settle(run.id, result.usage ?? { timeMs: Date.now() - started });
      } catch (error) {
        this.options.ledger.release(run.id);
        run.status = 'failed';
        run.error = error instanceof Error ? error.message : String(error);
        this.persist();
        return;
      }
      if (result.status === 'succeeded') {
        this.finishResult(node, run, result, { settle: false });
        return;
      }
      run.error = result.error;
      this.persist();
      this.emit({ type: 'run.failed', actor: run.id, objectRef: run.planId, payload: { runId: run.id, error: run.error, attempt } });
      if (this.options.ledger.canRetry(run.id, node.failurePolicy.maxRetries)) continue;
      this.applyFailurePolicy(node, run, result);
      return;
    }
  }

  private finishResult(
    node: GraphNode,
    run: NodeRun,
    result: OperatorResult,
    opts: { settle: boolean } = { settle: true },
  ): void {
    run.artifactRefs = [...result.artifactRefs];
    run.evidenceRefs = [...result.evidenceRefs];
    run.claimRefs = [...result.claimRefs];
    run.opinionRefs = [...result.opinionRefs];
    run.outputs = { ...result.outputs };
    run.error = result.error;
    if (result.status === 'succeeded') {
      run.status = 'succeeded';
      node.status = 'succeeded';
    } else if (result.status === 'failed') {
      run.status = 'failed';
      node.status = 'failed';
    } else if (result.status === 'waiting_human') {
      run.status = 'waiting_human';
      node.status = 'waiting_human';
    }
    if (opts.settle) this.options.ledger.settle(run.id, result.usage ?? { timeMs: 0 });
    this.persist();
    this.emit({ type: 'run.finished', actor: run.id, objectRef: run.planId, payload: { runId: run.id, status: run.status, artifactRefs: run.artifactRefs, claimRefs: run.claimRefs, evidenceRefs: run.evidenceRefs } });
  }

  private applyFailurePolicy(node: GraphNode, run: NodeRun, result: OperatorResult): void {
    if (node.failurePolicy.onFailure === 'escalate') {
      run.status = 'waiting_human';
      node.status = 'waiting_human';
      run.error = result.error;
      this.options.db.humanGateRequests.push({
        id: newId('hg'),
        workItemId: run.workItemId,
        planId: run.planId,
        nodeId: node.id,
        kind: 'high_risk',
        summary: `node failed after retries: ${result.error ?? 'unknown'}`,
        requested: { runId: run.id },
        status: 'pending',
        availableActions: ['approve_once', 'approve_work_item', 'modify_envelope', 'reject_and_stop'],
        createdAt: new Date().toISOString(),
      });
    } else if (node.failurePolicy.onFailure === 'cancel_pending_children') {
      run.status = 'failed';
      node.status = 'failed';
      const cancelled = new Set([node.id]);
      let changed = true;
      while (changed) {
        changed = false;
        for (const other of this.graph?.nodes ?? []) {
          if (other.dependsOn.some((dep) => cancelled.has(dep)) && !cancelled.has(other.id)) {
            if (['pending', 'ready'].includes(other.status)) {
              other.status = 'cancelled';
              const otherRun = this.nodeRunsFor(other.id);
              if (otherRun) {
                otherRun.status = 'cancelled';
                otherRun.cancelReason = 'failure_policy';
              }
            }
            cancelled.add(other.id);
            changed = true;
          }
        }
      }
    } else {
      run.status = 'failed';
      node.status = 'failed';
    }
    this.persist();
  }

  private nodeRunsFor(graphNodeId: string): NodeRun | undefined {
    return [...this.nodeRuns.values()].find((item) => item.graphNodeId === graphNodeId);
  }

  private hasWaitingHuman(): boolean {
    return (this.graph?.nodes ?? []).some((node) => node.status === 'waiting_human');
  }

  private producerIndex(): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const run of this.options.db.nodeRuns) {
      if (run.status !== 'succeeded') continue;
      index.set(run.graphNodeId, normalizeOutputRefs(run));
    }
    return index;
  }

  private producerVisibility(): Map<string, 'shared' | 'private' | 'blind' | 'sealed'> {
    const map = new Map<string, 'shared' | 'private' | 'blind' | 'sealed'>();
    for (const node of this.graph?.nodes ?? []) map.set(node.id, node.contextPolicy.visibility);
    return map;
  }

  private buildContext(node: GraphNode, run: NodeRun): OperatorContext {
    if (!this.workItem) throw new Error('SCHEDULER_NOT_ATTACHED');
    const view = buildNodeContextView({
      node,
      db: this.options.db,
      workItem: this.workItem,
      nodes: this.graph?.nodes ?? [],
      producerIndex: this.producerIndex(),
      producerVisibility: this.producerVisibility(),
      seed: this.options.seed,
    });
    return {
      graphNode: node,
      nodeRun: run,
      workItem: this.workItem,
      contextView: view,
      workspacePath: '', // Node operators get workspaces in Task 12 integration
      envelope: this.options.envelope,
      resolveAgent: this.options.resolveAgent,
      resolveReviewer: this.options.resolveReviewer,
      commit: (batch) => this.commit(run, batch),
      ledger: this.options.ledger,
      emit: (event) => this.emit(event),
      requestHumanGate: (input) => {
        this.options.db.humanGateRequests.push(input);
        this.persist();
        this.emit({ type: 'human_gate.requested', actor: run.id, objectRef: run.planId, payload: { gateId: input.id } });
        return input;
      },
      readDb: () => this.options.db,
      materialize: () => materializeNodeContext({ view, db: this.options.db, workItem: this.workItem! }),
    };
  }

  private commit(run: NodeRun, batch: OperatorWriteBatch): string[] {
    const registry = new ArtifactRegistry(this.options.db);
    const refs = (batch.artifacts ?? []).map((artifact) =>
      registry.publish({ ...artifact, ownerRunId: artifact.ownerRunId ?? run.id }).ref,
    );
    for (const claim of batch.claims ?? []) {
      this.options.db.claims.push({ ...claim, workItemId: claim.workItemId ?? run.workItemId, nodeRunId: claim.nodeRunId ?? run.id });
    }
    for (const evidence of batch.evidence ?? []) {
      this.options.db.evidence.push({
        ...evidence,
        workItemId: evidence.workItemId ?? run.workItemId,
        planId: evidence.planId ?? run.planId,
        nodeRunId: evidence.nodeRunId ?? run.id,
      });
    }
    this.persist();
    return refs;
  }

  private emit(event: NewEvent): void {
    const last = this.options.db.events[this.options.db.events.length - 1];
    const full: Event = {
      id: newId('evt'),
      type: event.type,
      actor: event.actor,
      objectRef: event.objectRef,
      payload: event.payload ?? {},
      timestamp: new Date().toISOString(),
      previousHash: last ? hashJson(last) : undefined,
    };
    this.options.db.events.push(full);
    this.options.onEvent?.(full);
  }

  private persist(): void {
    this.options.store.save(this.options.db);
    const latest = [...this.nodeRuns.values()].at(-1);
    if (latest) this.options.onNodeRunUpdate?.(latest);
  }
}
