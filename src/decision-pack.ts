import type {
  Challenge,
  Database,
  Decision,
  Deliberation,
  Event,
  Evidence,
  Position,
  Response,
  Review,
  TaskPacket,
} from './schemas.ts';
import { formatVersionRef, parseVersionRef } from './hashing.ts';
import { buildReviewerCandidates } from './context-policy.ts';

export interface DecisionPackCandidate {
  label: string;
  positionId: string;
  runId: string;
  summary: string;
  claims: Array<{ id: string; statement: string; type: string; evidenceRefs: string[]; confidence?: number }>;
  unknowns: string[];
  decisionConditions: string[];
  confidence: number;
  artifactRefs: string[];
  commitmentHash: string;
}

export interface DecisionPack {
  formatVersion: '0.1.0';
  deliberationId: string;
  protocolVersion: string;
  state: Deliberation['state'];
  createdAt: string;
  decidedAt?: string;
  taskPacket: TaskPacket;
  candidates: DecisionPackCandidate[];
  divergence: {
    sharedStatements: string[];
    uniqueClaims: Array<{ positionId: string; statement: string }>;
    unresolvedConflicts: string[];
  };
  challenges: Array<{
    id: string;
    targetRef: string;
    authorRunId: string;
    question: string;
    status: string;
    response?: Response;
  }>;
  evidence: Evidence[];
  reviews: Review[];
  decision?: Decision;
  timeline: Event[];
  traceability: {
    resolvedRefs: string[];
    unresolvedRefs: string[];
  };
}

export interface ExportDecisionPackInput {
  db: Database;
  deliberationId: string;
  seed?: string;
}

export function exportDecisionPack(input: ExportDecisionPackInput): DecisionPack {
  const { db } = input;
  const deliberation = db.deliberations.find((item) => item.id === input.deliberationId);
  if (!deliberation) throw new Error(`Deliberation not found: ${input.deliberationId}`);
  const packet = db.taskPackets.find((item) => item.id === deliberation.taskPacketId);
  if (!packet) throw new Error(`Task Packet missing for ${input.deliberationId}`);
  const positions = deliberation.positions.filter((position) => position.status === 'committed');
  const { candidates: reviewerCandidates } = buildReviewerCandidates(positions, input.seed);
  const candidatePack = positions.map((position) => {
    const label = reviewerCandidates.find((candidate) => candidate.originalPositionId === position.id)?.candidateId ?? '?';
    return {
      label,
      positionId: position.id,
      runId: position.runId,
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
      artifactRefs: position.artifactRefs,
      commitmentHash: position.commitmentHash,
    };
  });
  const statementCounts = new Map<string, number>();
  const uniqueClaims: Array<{ positionId: string; statement: string }> = [];
  for (const position of positions) {
    for (const claim of position.claims) {
      const key = normalize(claim.statement);
      statementCounts.set(key, (statementCounts.get(key) ?? 0) + 1);
    }
  }
  for (const position of positions) {
    for (const claim of position.claims) {
      if ((statementCounts.get(normalize(claim.statement)) ?? 0) === 1) {
        uniqueClaims.push({ positionId: position.id, statement: claim.statement });
      }
    }
  }
  const sharedStatements = [...statementCounts.entries()]
    .filter(([, count]) => count >= 2)
    .map(([statement]) => statement);

  const challenges: DecisionPack['challenges'] = deliberation.challenges.map((challenge) => ({
    id: challenge.id,
    targetRef: challenge.targetRef,
    authorRunId: challenge.authorRunId,
    question: challenge.question,
    status: challenge.status,
    response: deliberation.responses.find((response) => response.challengeId === challenge.id),
  }));

  const unresolvedConflicts = deliberation.challenges
    .filter((challenge) => challenge.status === 'evidence_requested' || challenge.status === 'open')
    .map((challenge) => challenge.question)
    .concat(
      deliberation.reviews.flatMap((review) => review.unresolvedRisks),
      deliberation.decisions.flatMap((decision) => decision.dissent),
    );

  const refs = collectRefs({ packet, positions, evidence: deliberation.evidence, decisions: deliberation.decisions });
  const { resolved, unresolved } = resolveRefs(db, deliberation, refs);

  return {
    formatVersion: '0.1.0',
    deliberationId: deliberation.id,
    protocolVersion: deliberation.protocolVersion,
    state: deliberation.state,
    createdAt: deliberation.createdAt,
    decidedAt: deliberation.decisions[deliberation.decisions.length - 1]?.decidedAt,
    taskPacket: packet,
    candidates: candidatePack,
    divergence: {
      sharedStatements,
      uniqueClaims,
      unresolvedConflicts: [...new Set(unresolvedConflicts)],
    },
    challenges,
    evidence: deliberation.evidence,
    reviews: deliberation.reviews,
    decision: deliberation.decisions[deliberation.decisions.length - 1],
    timeline: db.events.filter((event) => event.objectRef === deliberation.id),
    traceability: {
      resolvedRefs: [...resolved].sort(),
      unresolvedRefs: [...unresolved].sort(),
    },
  };
}

export function decisionPackToMarkdown(pack: DecisionPack): string {
  const lines: string[] = [];
  lines.push(`# Decision Pack — ${pack.taskPacket.problem}`);
  lines.push('');
  lines.push(`- Deliberation: \`${pack.deliberationId}\``);
  lines.push(`- Protocol: ${pack.protocolVersion} (format ${pack.formatVersion})`);
  lines.push(`- State: ${pack.state}`);
  lines.push(`- Created: ${pack.createdAt}`);
  if (pack.decidedAt) lines.push(`- Decided: ${pack.decidedAt}`);
  lines.push('');
  lines.push('## Task Packet');
  lines.push('');
  lines.push(pack.taskPacket.problem);
  lines.push('');
  lines.push('### Goals');
  pack.taskPacket.goals.forEach((goal) => lines.push(`- ${goal}`));
  lines.push('');
  lines.push('### Constraints');
  pack.taskPacket.constraints.forEach((constraint) => lines.push(`- ${constraint}`));
  lines.push('');
  lines.push('### Rubric');
  pack.taskPacket.rubric.items.forEach((item) => {
    lines.push(`- ${item.name}${item.description ? ` — ${item.description}` : ''} (weight ${item.weight})`);
  });
  lines.push('');
  lines.push('## Candidates');
  lines.push('');
  for (const candidate of pack.candidates) {
    lines.push(`### Candidate ${candidate.label}`);
    lines.push('');
    lines.push(candidate.summary);
    lines.push('');
    lines.push(`- Confidence: ${candidate.confidence}`);
    lines.push(`- Commitment: \`${candidate.commitmentHash.slice(0, 16)}…\``);
    lines.push(`- Artifacts: ${candidate.artifactRefs.join(', ') || '(none)'}`);
    if (candidate.unknowns.length) {
      lines.push('- Unknowns:');
      candidate.unknowns.forEach((unknown) => lines.push(`  - ${unknown}`));
    }
    if (candidate.decisionConditions.length) {
      lines.push('- Decision conditions:');
      candidate.decisionConditions.forEach((condition) => lines.push(`  - ${condition}`));
    }
    lines.push('');
    lines.push('#### Claims');
    for (const claim of candidate.claims) {
      lines.push(`- [${claim.type}] ${claim.statement}`);
      if (claim.evidenceRefs.length) lines.push(`  - Evidence: ${claim.evidenceRefs.join(', ')}`);
    }
    lines.push('');
  }
  lines.push('## Divergence Matrix');
  lines.push('');
  if (pack.divergence.sharedStatements.length) {
    lines.push('### Shared conclusions');
    pack.divergence.sharedStatements.forEach((statement) => lines.push(`- ${statement}`));
  } else {
    lines.push('_No shared conclusions._');
  }
  lines.push('');
  if (pack.divergence.uniqueClaims.length) {
    lines.push('### Unique claims');
    pack.divergence.uniqueClaims.forEach((item) => lines.push(`- ${item.statement} (${item.positionId})`));
  }
  lines.push('');
  if (pack.divergence.unresolvedConflicts.length) {
    lines.push('### Unresolved conflicts');
    pack.divergence.unresolvedConflicts.forEach((conflict) => lines.push(`- ${conflict}`));
    lines.push('');
    lines.push('> ⚠ Unresolved conflicts are NOT hidden from the final decision.');
  } else {
    lines.push('_No unresolved conflicts._');
  }
  lines.push('');
  lines.push('## Challenges & Responses');
  lines.push('');
  if (!pack.challenges.length) lines.push('_No challenges recorded._');
  for (const challenge of pack.challenges) {
    lines.push(`- **${challenge.question}** (target ${challenge.targetRef}, status ${challenge.status})`);
    if (challenge.response) {
      lines.push(`  - Response: ${challenge.response.text}${challenge.response.concession ? ' (concession)' : ''}`);
      if (challenge.response.evidenceRefs.length) {
        lines.push(`    - Evidence: ${challenge.response.evidenceRefs.join(', ')}`);
      }
    }
  }
  lines.push('');
  lines.push('## Evidence');
  lines.push('');
  if (!pack.evidence.length) lines.push('_No evidence recorded._');
  for (const evidence of pack.evidence) {
    lines.push(`- **${evidence.status.toUpperCase()}** (${evidence.kind}) ${evidence.result.summary ?? ''}`);
    lines.push(`  - Targets: ${evidence.targetRefs.join(', ')}`);
    lines.push(`  - Reproducibility: ${evidence.reproducibility ?? 'unknown'}`);
    if (evidence.source.command) lines.push(`  - Command: ${evidence.source.command} ${(evidence.source.args ?? []).join(' ')}`);
  }
  lines.push('');
  lines.push('## Review');
  lines.push('');
  if (!pack.reviews.length) {
    lines.push('_No review recorded._');
  } else {
    const review = pack.reviews[pack.reviews.length - 1];
    lines.push(`- Recommendation: **${review.recommendation}**`);
    lines.push(`- Evidence sufficiency: ${review.evidenceSufficiency}`);
    for (const [itemId, score] of Object.entries(review.rubricScores)) {
      lines.push(`- Rubric ${itemId}: ${score}`);
    }
    lines.push('');
    lines.push(review.rationale);
    if (review.unresolvedRisks.length) {
      lines.push('');
      lines.push('### Unresolved risks');
      review.unresolvedRisks.forEach((risk) => lines.push(`- ${risk}`));
    }
  }
  lines.push('');
  lines.push('## Decision');
  lines.push('');
  if (!pack.decision) {
    lines.push('_No human decision recorded._');
  } else {
    lines.push(`- Action: **${pack.decision.humanAction}**`);
    lines.push(`- Selected refs: ${pack.decision.selectedRefs.join(', ') || '(none)'}`);
    lines.push('');
    lines.push(pack.decision.rationale);
    if (pack.decision.conditions.length) {
      lines.push('');
      lines.push('### Conditions');
      pack.decision.conditions.forEach((condition) => lines.push(`- ${condition}`));
    }
    if (pack.decision.dissent.length) {
      lines.push('');
      lines.push('### Dissent / retained risks');
      pack.decision.dissent.forEach((item) => lines.push(`- ${item}`));
    }
  }
  lines.push('');
  lines.push('## Traceability');
  lines.push('');
  lines.push(`- Resolved refs: ${pack.traceability.resolvedRefs.length}`);
  lines.push(`- Unresolved refs: ${pack.traceability.unresolvedRefs.length}`);
  if (pack.traceability.unresolvedRefs.length) {
    lines.push('');
    lines.push('**UNRESOLVED REFS** (must not be empty for a traceable Decision Pack):');
    pack.traceability.unresolvedRefs.forEach((ref) => lines.push(`- ${ref}`));
  }
  lines.push('');
  lines.push('## Timeline');
  lines.push('');
  for (const event of pack.timeline) {
    lines.push(`- \`${event.timestamp}\` ${event.type} (${event.actor})`);
  }
  lines.push('');
  return lines.join('\n');
}

function collectRefs(input: {
  packet: TaskPacket;
  positions: Position[];
  evidence: Evidence[];
  decisions: Decision[];
}): string[] {
  const refs: string[] = [];
  for (const source of input.packet.sources) refs.push(formatVersionRef(source, 1));
  for (const position of input.positions) {
    refs.push(`position:${position.id}`);
    for (const artifactRef of position.artifactRefs) refs.push(artifactRef);
    for (const claim of position.claims) {
      refs.push(`claim:${claim.id}`);
      for (const evidenceRef of claim.evidenceRefs) refs.push(evidenceRef);
    }
  }
  for (const evidence of input.evidence) {
    refs.push(`evidence:${evidence.id}`);
    for (const targetRef of evidence.targetRefs) refs.push(targetRef);
  }
  for (const decision of input.decisions) {
    for (const ref of decision.selectedRefs) refs.push(ref);
  }
  return [...new Set(refs)];
}

function resolveRefs(
  db: Database,
  deliberation: Deliberation,
  refs: string[],
): { resolved: Set<string>; unresolved: Set<string> } {
  const resolved = new Set<string>();
  const unresolved = new Set<string>();
  for (const ref of refs) {
    if (ref.startsWith('position:')) {
      const positionId = ref.slice('position:'.length);
      if (deliberation.positions.some((position) => position.id === positionId)) resolved.add(ref);
      else unresolved.add(ref);
      continue;
    }
    if (ref.startsWith('claim:')) {
      const claimId = ref.slice('claim:'.length);
      if (deliberation.positions.some((position) => position.claims.some((claim) => claim.id === claimId))) resolved.add(ref);
      else unresolved.add(ref);
      continue;
    }
    if (ref.startsWith('evidence:')) {
      const evidenceId = ref.slice('evidence:'.length);
      if (deliberation.evidence.some((evidence) => evidence.id === evidenceId)) resolved.add(ref);
      else unresolved.add(ref);
      continue;
    }
    const parsed = parseVersionRef(ref);
    if (parsed) {
      const artifact = db.artifacts.find((item) => item.logicalName === parsed.name);
      const version = artifact
        ? db.artifactVersions.find((item) => item.artifactId === artifact.id && item.version === parsed.version)
        : undefined;
      if (version) resolved.add(ref);
      else unresolved.add(ref);
      continue;
    }
    unresolved.add(ref);
  }
  return { resolved, unresolved };
}

function normalize(statement: string): string {
  return statement.trim().toLowerCase().replace(/\s+/g, ' ');
}
