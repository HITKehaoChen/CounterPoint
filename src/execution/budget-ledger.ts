import type { AutonomyEnvelope } from '../autonomy/autonomy-envelope.ts';
import type { NodeBudget } from '../planning/schemas.ts';

export interface BudgetUsage {
  timeMs: number;
  tokens?: number;
  costUsd?: number;
}

export interface LedgerSnapshot {
  reservations: Record<string, { reservedTimeMs: number; maxTimeMs: number }>;
  attemptCounts: Record<string, number>;
  totalSettledTimeMs: number;
  totalSettledCostUsd: number;
  totalSettledTokens: number;
}

/**
 * Reserve → settle → release budget ledger (spec §6, M1 plan R1).
 * A node reserves its whole time budget before starting so parallel nodes
 * cannot oversell the envelope; settle records actual usage and returns the
 * remainder; the snapshot is serializable and restored on restart.
 */
export class BudgetLedger {
  private readonly envelope: AutonomyEnvelope;
  private readonly reservations = new Map<string, { reservedTimeMs: number; maxTimeMs: number }>();
  private readonly attemptCounts = new Map<string, number>();
  private totalSettledTimeMs = 0;
  private totalSettledCostUsd = 0;
  private totalSettledTokens = 0;

  constructor(envelope: AutonomyEnvelope, snapshot?: LedgerSnapshot) {
    this.envelope = envelope;
    if (snapshot) {
      for (const [runId, reservation] of Object.entries(snapshot.reservations)) {
        this.reservations.set(runId, { ...reservation });
      }
      for (const [runId, count] of Object.entries(snapshot.attemptCounts ?? {})) {
        this.attemptCounts.set(runId, count);
      }
      this.totalSettledTimeMs = snapshot.totalSettledTimeMs;
      this.totalSettledCostUsd = snapshot.totalSettledCostUsd;
      this.totalSettledTokens = snapshot.totalSettledTokens;
    }
  }

  private totalReservedTimeMs(): number {
    let sum = 0;
    for (const reservation of this.reservations.values()) sum += reservation.reservedTimeMs;
    return sum;
  }

  canReserve(nodeBudget: NodeBudget): boolean {
    if (this.totalReservedTimeMs() + this.totalSettledTimeMs + nodeBudget.maxTimeMs >= this.envelope.timeBudgetMs) {
      return false;
    }
    if (this.envelope.tokenBudget !== undefined && this.totalSettledTokens >= this.envelope.tokenBudget) {
      return false;
    }
    if (this.envelope.costBudget !== undefined && this.totalSettledCostUsd >= this.envelope.costBudget) {
      return false;
    }
    return true;
  }

  reserve(runId: string, nodeBudget: NodeBudget): void {
    if (this.reservations.has(runId)) throw new Error(`DUPLICATE_RESERVATION for ${runId}`);
    if (!this.canReserve(nodeBudget)) throw new Error('BUDGET_EXCEEDED');
    this.reservations.set(runId, { reservedTimeMs: nodeBudget.maxTimeMs, maxTimeMs: nodeBudget.maxTimeMs });
    this.attemptCounts.set(runId, (this.attemptCounts.get(runId) ?? 0) + 1);
  }

  settle(runId: string, usage: BudgetUsage): void {
    const reservation = this.reservations.get(runId);
    if (!reservation) throw new Error(`NO_RESERVATION for ${runId}`);
    if (usage.timeMs > reservation.maxTimeMs) {
      throw new Error(`NODE_BUDGET_EXCEEDED: ${usage.timeMs}ms > ${reservation.maxTimeMs}ms`);
    }
    const nextTime = this.totalSettledTimeMs + usage.timeMs;
    const nextCost = this.totalSettledCostUsd + (usage.costUsd ?? 0);
    const nextTokens = this.totalSettledTokens + (usage.tokens ?? 0);
    if (this.envelope.costBudget !== undefined && nextCost > this.envelope.costBudget) throw new Error('BUDGET_EXCEEDED');
    if (this.envelope.tokenBudget !== undefined && nextTokens > this.envelope.tokenBudget) throw new Error('BUDGET_EXCEEDED');
    this.totalSettledTimeMs = nextTime;
    this.totalSettledCostUsd = nextCost;
    this.totalSettledTokens = nextTokens;
    this.reservations.delete(runId);
  }

  release(runId: string): void {
    this.reservations.delete(runId);
  }

  canRetry(runId: string, maxRetries: number): boolean {
    return (this.attemptCounts.get(runId) ?? 0) <= maxRetries && !this.envelopeExhausted();
  }

  envelopeExhausted(): boolean {
    return (
      this.totalReservedTimeMs() + this.totalSettledTimeMs >= this.envelope.timeBudgetMs ||
      (this.envelope.tokenBudget !== undefined && this.totalSettledTokens >= this.envelope.tokenBudget) ||
      (this.envelope.costBudget !== undefined && this.totalSettledCostUsd >= this.envelope.costBudget)
    );
  }

  snapshot(): LedgerSnapshot {
    const reservations: LedgerSnapshot['reservations'] = {};
    for (const [runId, reservation] of this.reservations) reservations[runId] = { ...reservation };
    return {
      reservations,
      attemptCounts: Object.fromEntries(this.attemptCounts),
      totalSettledTimeMs: this.totalSettledTimeMs,
      totalSettledCostUsd: this.totalSettledCostUsd,
      totalSettledTokens: this.totalSettledTokens,
    };
  }
}
