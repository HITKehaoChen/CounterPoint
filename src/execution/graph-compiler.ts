import { newId } from '../ids.ts';
import type { CollaborationPlan } from '../planning/schemas.ts';
import type { CapabilityCatalog } from '../planning/capabilities.ts';
import type { AdapterBinding, ExecutionGraph, GraphNode } from './execution-graph.ts';

export interface CompilePlanInput {
  plan: CollaborationPlan;
  catalog: CapabilityCatalog;
}

export function compilePlan(input: CompilePlanInput): ExecutionGraph {
  const nodes: GraphNode[] = input.plan.nodes.map((node) => {
    const primary = node.capabilityRequirements[0];
    if (!primary || !input.catalog.byCapability.has(primary)) {
      throw new Error(`No capability "${primary ?? ''}" for node ${node.id}`);
    }
    const descriptor = input.catalog.byCapability.get(primary)!;
    const adapterBinding: AdapterBinding = {
      adapterId: descriptor.adapterId ?? `${descriptor.adapterKind}-${primary}`,
      kind: descriptor.adapterKind,
      capabilities: node.capabilityRequirements,
    };
    const isSource = node.dependsOn.length === 0;
    return {
      id: `gn_${node.id}`,
      planNodeId: node.id,
      role: node.role,
      objective: node.objective,
      dependsOn: node.dependsOn.map((dependency) => `gn_${dependency}`),
      inputRefs: [...node.inputRefs],
      contextPolicy: node.contextPolicy,
      operator: node.operator,
      capabilityRequirements: [...node.capabilityRequirements],
      completionCriteria: node.completionCriteria,
      failurePolicy: node.failurePolicy,
      allocatedBudget: node.allocatedBudget,
      adapterBinding,
      effectClass:
        node.operator.type === 'tool_task' || node.operator.type === 'verification'
          ? node.operator.effectClass ?? 'read_only'
          : 'read_only',
      status: isSource ? 'ready' : 'pending',
    };
  });
  return {
    id: newId('graph'),
    planId: input.plan.id,
    planVersion: input.plan.version,
    nodes,
    status: 'pending',
  };
}
