import type { CollaborationNode } from '../planning/schemas.ts';
import type { EffectClass } from '../schemas.ts';

export type GraphNodeStatus = 'pending' | 'ready' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';

export interface AdapterBinding {
  adapterId: string;
  kind: string;
  capabilities: string[];
}

export interface GraphNode {
  id: string;
  planNodeId: string;
  role: string;
  objective: string;
  dependsOn: string[];
  inputRefs: string[];
  contextPolicy: CollaborationNode['contextPolicy'];
  operator: CollaborationNode['operator'];
  capabilityRequirements: string[];
  completionCriteria: CollaborationNode['completionCriteria'];
  failurePolicy: CollaborationNode['failurePolicy'];
  allocatedBudget: CollaborationNode['allocatedBudget'];
  adapterBinding?: AdapterBinding;
  effectClass: EffectClass;
  status: GraphNodeStatus;
}

export interface ExecutionGraph {
  id: string;
  planId: string;
  planVersion: number;
  nodes: GraphNode[];
  status: 'pending' | 'active' | 'completed' | 'failed';
}

export function computeReadyNodes(graph: ExecutionGraph): GraphNode[] {
  const byId = new Map(graph.nodes.map((node) => [node.id, node]));
  const satisfied = (node: GraphNode): boolean =>
    node.dependsOn.every((dependency) => {
      const depNode = byId.get(dependency);
      return depNode && (depNode.status === 'succeeded' || depNode.status === 'skipped');
    });
  return graph.nodes.filter(
    (node) => (node.status === 'pending' || node.status === 'ready') && satisfied(node),
  );
}
