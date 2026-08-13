import { hashJson } from '../hashing.ts';
import { newId } from '../ids.ts';
import type { ContextView, Database, WorkItem } from '../schemas.ts';
import type { Visibility } from '../planning/schemas.ts';
import type { GraphNode } from './execution-graph.ts';

export interface NodeContextViewInput {
  node: GraphNode;
  db: Database;
  workItem: WorkItem;
  /** graph node id -> output refs it published so far (claim:/artifact:/evidence:). */
  producerIndex: Map<string, string[]>;
  /** graph node id -> its contextPolicy.visibility. Defaults to shared when absent. */
  producerVisibility?: Map<string, Visibility>;
  seed?: string;
}

function splitRefs(refs: string[]): { claims: Set<string>; artifacts: Set<string>; evidence: Set<string> } {
  const claims = new Set<string>();
  const artifacts = new Set<string>();
  const evidence = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith('claim:')) claims.add(ref.slice('claim:'.length));
    else if (ref.startsWith('artifact:')) artifacts.add(ref);
    else if (ref.startsWith('evidence:')) evidence.add(ref.slice('evidence:'.length));
  }
  return { claims, artifacts, evidence };
}

export function buildNodeContextView(input: NodeContextViewInput): ContextView {
  const { node, workItem, producerIndex } = input;
  const producerVisibility = input.producerVisibility ?? new Map<string, Visibility>();
  const visibleArtifacts = new Set<string>();
  const visibleClaims = new Set<string>();
  const visibleEvidence = new Set<string>();
  const hiddenObjectTypes = new Set<string>(node.contextPolicy.excludeObjectTypes);

  const ownInputs = splitRefs(node.inputRefs);
  for (const artifact of ownInputs.artifacts) visibleArtifacts.add(artifact);
  for (const claim of ownInputs.claims) visibleClaims.add(claim);
  for (const evidenceId of ownInputs.evidence) visibleEvidence.add(evidenceId);

  for (const [producerId, refs] of producerIndex) {
    if (producerId === node.id) continue;
    const visibility = producerVisibility.get(producerId) ?? 'shared';
    const outputs = splitRefs(refs);
    if (visibility === 'shared') {
      for (const artifact of outputs.artifacts) visibleArtifacts.add(artifact);
      for (const claim of outputs.claims) visibleClaims.add(claim);
      for (const evidenceId of outputs.evidence) visibleEvidence.add(evidenceId);
    } else {
      hiddenObjectTypes.add(`${visibility}_artifacts`);
      hiddenObjectTypes.add(`${visibility}_claims`);
      hiddenObjectTypes.add(`${visibility}_evidence`);
    }
  }

  const tools =
    node.operator.type === 'agent_task' || node.operator.type === 'independent_review'
      ? { allow: ['read_sources', 'write_scratch'], deny: [] }
      : node.operator.type === 'tool_task' || node.operator.type === 'verification'
        ? { allow: ['read_sources', 'run_command'], deny: [] }
        : { allow: [], deny: [] };

  const view: ContextView = {
    id: newId('ctx'),
    runId: node.id,
    phase: 'node',
    visible: {
      authoritySources: [...workItem.sourceRefs],
      artifacts: [...visibleArtifacts],
      claims: [...visibleClaims],
      evidence: [...visibleEvidence],
    },
    hidden: {
      agentRuns: [...producerIndex.keys()].filter((id) => id !== node.id),
      objectTypes: [...hiddenObjectTypes],
    },
    tools,
    hash: '',
  };
  view.hash = hashJson({
    runId: view.runId,
    phase: view.phase,
    visible: view.visible,
    hidden: view.hidden,
    tools: view.tools,
    seed: input.seed ?? null,
  });
  return view;
}
