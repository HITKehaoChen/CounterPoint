import type { Deliberation, DeliberationState, TaskPacket } from './schemas.ts';

export const LEGAL_TRANSITIONS: Record<DeliberationState, DeliberationState[]> = {
  draft: ['frozen'],
  frozen: ['blind_run'],
  blind_run: ['committed'],
  committed: ['revealed'],
  revealed: ['challenging'],
  challenging: ['verifying'],
  verifying: ['reviewing'],
  reviewing: ['decided', 'escalated', 'verifying'],
  escalated: ['decided'],
  decided: [],
};

export interface TransitionContext {
  deliberation: Deliberation;
  taskPacket?: TaskPacket;
  /** Number of worker runs that already committed a Position. */
  committedWorkers?: number;
  /** Number of active (non-excluded) worker runs. */
  activeWorkers?: number;
  /** Evidence rounds already consumed. */
  evidenceRounds?: number;
  maxEvidenceRounds?: number;
  hasReview?: boolean;
  hasDecision?: boolean;
}

export function assertLegalTransition(
  from: DeliberationState,
  to: DeliberationState,
): void {
  if (!LEGAL_TRANSITIONS[from].includes(to)) {
    throw new Error(`Illegal transition ${from} -> ${to}`);
  }
}

/**
 * Deterministic transition guards (PRD 6.3 / ADR-002). Returns the list of
 * unmet preconditions; an empty list means the transition is allowed.
 */
export function guardTransition(
  from: DeliberationState,
  to: DeliberationState,
  context: TransitionContext,
): string[] {
  const violations: string[] = [];
  const { deliberation, taskPacket } = context;

  if (from === 'draft' && to === 'frozen') {
    if (!taskPacket) violations.push('Task Packet missing');
    if (taskPacket && !taskPacket.hash) violations.push('Task Packet is not frozen (no hash)');
    const workers = deliberation.participants.filter((participant) => participant.role === 'worker');
    if (workers.length < 2) violations.push('At least 2 Worker participants required');
    if (!deliberation.participants.some((participant) => participant.role === 'human')) {
      violations.push('Human Owner participant required');
    }
  }

  if (from === 'frozen' && to === 'blind_run') {
    if (!taskPacket?.hash) violations.push('Task Packet not frozen');
    if (!deliberation.runs.length) violations.push('Worker runs must be created before launch');
  }

  if (from === 'blind_run' && to === 'committed') {
    const committed = context.committedWorkers ?? 0;
    const active = context.activeWorkers ?? deliberation.runs.length;
    if (committed < 1) violations.push('At least one Worker must have committed');
    if (committed < active) {
      violations.push(
        `Not all active Workers committed (${committed}/${active}); timeouts must be resolved first`,
      );
    }
  }

  if (from === 'committed' && to === 'revealed') {
    if (deliberation.positions.length < 1) violations.push('No committed Positions to reveal');
  }

  if (from === 'revealed' && to === 'challenging') {
    if (!deliberation.candidateOrder?.length) violations.push('Candidate order not established');
  }

  if (from === 'challenging' && to === 'verifying') {
    const openChallenges = deliberation.challenges.filter(
      (challenge) => challenge.status === 'open',
    );
    const pendingRequests = deliberation.evidenceRequests.filter(
      (request) => request.status === 'pending',
    );
    if (openChallenges.length > 0) violations.push(`Open challenges remain: ${openChallenges.length}`);
    if (pendingRequests.length > 0) violations.push(`Pending evidence requests remain: ${pendingRequests.length}`);
  }

  if (from === 'verifying' && to === 'reviewing') {
    const pendingRequests = deliberation.evidenceRequests.filter(
      (request) => request.status === 'pending',
    );
    if (pendingRequests.length > 0) violations.push('Evidence requests are still pending');
  }

  if (from === 'reviewing' && to === 'decided') {
    if (!context.hasReview) violations.push('Reviewer verdict is required before human decision');
    if (!context.hasDecision) violations.push('Human decision is required');
  }

  if (from === 'reviewing' && to === 'escalated') {
    if (!context.hasReview) violations.push('Cannot escalate before review');
  }

  if (from === 'reviewing' && to === 'verifying') {
    const maxRounds = context.maxEvidenceRounds ?? 1;
    const used = context.evidenceRounds ?? 0;
    if (used >= maxRounds) violations.push('Evidence round limit reached');
  }

  if (from === 'escalated' && to === 'decided') {
    if (!context.hasDecision) violations.push('Human decision is required');
  }

  return violations;
}
