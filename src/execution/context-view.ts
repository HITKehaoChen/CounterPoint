import { hashJson, parseVersionRef } from '../hashing.ts';
import { newId } from '../ids.ts';
import type { ContextView, Database, WorkItem } from '../schemas.ts';
import type { Visibility } from '../planning/schemas.ts';
import { ArtifactRegistry } from '../artifact-registry.ts';
import type { VisibleArtifact, VisibleAuthoritySource } from '../adapters/agent.ts';
import type { GraphNode } from './execution-graph.ts';

export interface NodeContextViewInput {
  node: GraphNode;
  db: Database;
  workItem: WorkItem;
  /** Full graph; used to compute the dependency-ancestor closure. */
  nodes: GraphNode[];
  /** graph node id -> output refs it published so far (claim:/evidence:/<logicalName>@v<n>). */
  producerIndex: Map<string, string[]>;
  /** graph node id -> its contextPolicy.visibility. Defaults to shared when absent. */
  producerVisibility?: Map<string, Visibility>;
  seed?: string;
}

export interface MaterializedNodeContext {
  authoritySources: VisibleAuthoritySource[];
  visibleArtifacts: VisibleArtifact[];
}

type RefCategory = 'claim' | 'artifact' | 'evidence';

interface SplitRefs {
  claims: Set<string>;
  artifacts: Set<string>;
  evidence: Set<string>;
}

function categoryOfRef(ref: string, db: Database): RefCategory | undefined {
  if (ref.startsWith('claim:')) return 'claim';
  if (ref.startsWith('evidence:')) return 'evidence';
  const parsed = parseVersionRef(ref);
  if (parsed && db.artifacts.some((artifact) => artifact.logicalName === parsed.name)) return 'artifact';
  return undefined;
}

function splitRefs(refs: string[], db: Database): SplitRefs {
  const claims = new Set<string>();
  const artifacts = new Set<string>();
  const evidence = new Set<string>();
  for (const ref of refs) {
    const category = categoryOfRef(ref, db);
    if (category === 'claim') claims.add(ref.slice('claim:'.length));
    else if (category === 'artifact') artifacts.add(ref);
    else if (category === 'evidence') evidence.add(ref.slice('evidence:'.length));
  }
  return { claims, artifacts, evidence };
}

function typeMatches(declared: string, category: RefCategory): boolean {
  return declared === category || declared === `${category}s`;
}

function allowedByPolicy(node: GraphNode, ref: string, category: RefCategory): boolean {
  if (node.contextPolicy.excludeObjectTypes.some((type) => typeMatches(type, category))) return false;
  if (
    node.contextPolicy.includeObjectTypes.length > 0 &&
    !node.contextPolicy.includeObjectTypes.some((type) => typeMatches(type, category))
  ) {
    return false;
  }
  if (node.contextPolicy.readScopes.length > 0) {
    const inScope = node.contextPolicy.readScopes.some(
      (scope) => ref === scope || ref.startsWith(`${scope}:`) || ref.startsWith(scope),
    );
    if (!inScope) return false;
  }
  return true;
}

function ancestorsOf(nodeId: string, nodes: GraphNode[]): Set<string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const ancestors = new Set<string>();
  const visit = (id: string): void => {
    const node = byId.get(id);
    for (const dependency of node?.dependsOn ?? []) {
      if (ancestors.has(dependency)) continue;
      ancestors.add(dependency);
      visit(dependency);
    }
  };
  visit(nodeId);
  return ancestors;
}

export function buildNodeContextView(input: NodeContextViewInput): ContextView {
  const { node, workItem, producerIndex, nodes, db } = input;
  const producerVisibility = input.producerVisibility ?? new Map<string, Visibility>();
  const ancestors = ancestorsOf(node.id, nodes);
  const visibleArtifacts = new Set<string>();
  const visibleClaims = new Set<string>();
  const visibleEvidence = new Set<string>();
  const hiddenObjectTypes = new Set<string>(node.contextPolicy.excludeObjectTypes);

  for (const ref of node.inputRefs) {
    const category = categoryOfRef(ref, db);
    if (!category || !allowedByPolicy(node, ref, category)) continue;
    if (category === 'claim') visibleClaims.add(ref.slice('claim:'.length));
    else if (category === 'artifact') visibleArtifacts.add(ref);
    else visibleEvidence.add(ref.slice('evidence:'.length));
  }

  for (const [producerId, refs] of producerIndex) {
    if (producerId === node.id) continue;
    const explicitlyReferenced = refs.some((ref) => node.inputRefs.includes(ref));
    if (!ancestors.has(producerId) && !explicitlyReferenced) continue;
    const producerNode = nodes.find((item) => item.id === producerId);
    const revealedToThisNode = producerNode?.contextPolicy.revealAfter === node.id;
    const visibility = producerVisibility.get(producerId) ?? 'shared';
    const outputs = splitRefs(refs, db);
    if (visibility === 'shared' || revealedToThisNode) {
      for (const artifact of outputs.artifacts) if (allowedByPolicy(node, artifact, 'artifact')) visibleArtifacts.add(artifact);
      for (const claim of outputs.claims) if (allowedByPolicy(node, `claim:${claim}`, 'claim')) visibleClaims.add(claim);
      for (const evidenceId of outputs.evidence) if (allowedByPolicy(node, `evidence:${evidenceId}`, 'evidence')) visibleEvidence.add(evidenceId);
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

export function materializeNodeContext(input: {
  view: ContextView;
  db: Database;
  workItem: WorkItem;
}): MaterializedNodeContext {
  const project = input.db.projects.find((item) => item.id === input.workItem.workspaceId);
  const authoritySources: VisibleAuthoritySource[] = [];
  for (const ref of input.view.visible.authoritySources) {
    const parsed = parseVersionRef(ref);
    const binding = project?.sourceBindings.find((item) => item.id === parsed?.name);
    if (binding) authoritySources.push({ ref, binding, content: binding.text });
  }
  const registry = new ArtifactRegistry(input.db);
  const visibleArtifacts: VisibleArtifact[] = [];
  for (const ref of input.view.visible.artifacts) {
    const resolved = registry.getVersion(ref);
    if (!resolved) continue;
    const artifact = input.db.artifacts.find((item) => item.id === resolved.version.artifactId);
    visibleArtifacts.push({
      ref: resolved.ref,
      logicalName: artifact?.logicalName ?? resolved.version.artifactId,
      type: artifact?.type ?? 'text',
      content: resolved.content,
      version: resolved.version.version,
      contentHash: resolved.version.contentHash,
      dependencies: resolved.version.dependencies,
    });
  }
  return { authoritySources, visibleArtifacts };
}
