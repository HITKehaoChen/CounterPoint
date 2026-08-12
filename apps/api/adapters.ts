import { MockAgentAdapter, type MockAgentScript } from '../../src/adapters/mock-agent.ts';
import { MockReviewerAdapter } from '../../src/adapters/mock-reviewer.ts';
import { LocalProcessAgentAdapter } from '../../src/adapters/local-process-agent.ts';
import type { AgentAdapter } from '../../src/adapters/agent.ts';
import type { ReviewerAdapter } from '../../src/adapters/reviewer.ts';
import type { Participant, WorkItem } from '../../src/schemas.ts';

export function webWorkerScript(side: 'a' | 'b'): MockAgentScript {
  if (side === 'a') {
    return {
      summary: 'Use synchronous calls: simpler rollback and testability.',
      claims: [
        {
          id: 'web-a-1',
          statement: 'Synchronous calls preserve transactional rollback.',
          type: 'fact',
          confidence: 0.8,
        },
        {
          id: 'web-a-2',
          statement: 'Eventual consistency adds hidden failure modes.',
          type: 'risk',
          confidence: 0.7,
        },
      ],
      unknowns: ['Peak load is not measured'],
      decisionConditions: ['If P99 latency budget is below 50ms, revisit'],
      confidence: 0.7,
      artifacts: [
        {
          logicalName: 'design-a',
          type: 'markdown',
          content: '# Design A: synchronous\nUse RPC with retries.',
        },
      ],
      model: 'mock-web-a',
      provider: 'mock-provider',
      cost: 1,
    };
  }
  return {
    summary: 'Use an event bus: decouples failure domains and scales.',
    claims: [
      {
        id: 'web-b-1',
        statement: 'Events decouple the ledger from downstream outages.',
        type: 'fact',
        confidence: 0.75,
      },
      {
        id: 'web-b-2',
        statement: 'Synchronous calls couple availability to the weakest link.',
        type: 'risk',
        confidence: 0.65,
      },
    ],
    unknowns: ['Exactly-once delivery semantics'],
    decisionConditions: ['If strong end-to-end consistency is a hard constraint, reassess'],
    confidence: 0.72,
    artifacts: [
      {
        logicalName: 'design-b',
        type: 'markdown',
        content: '# Design B: event-driven\nUse an outbox pattern.',
      },
    ],
    model: 'mock-web-b',
    provider: 'mock-provider',
    cost: 1,
  };
}

/**
 * Resolves Agent/Reviewer adapters from `participant.adapterConfig`
 * (FR-010/012, ADR-006). Defaults to deterministic mock adapters; workers can
 * opt into `{ kind: 'local-process', command, args }`.
 */
export function resolveApiAdapter(
  participant: Participant,
): AgentAdapter | ReviewerAdapter | undefined {
  const config = (participant.adapterConfig ?? {}) as Record<string, unknown>;
  if (participant.role === 'worker') {
    if (config.kind === 'local-process') {
      return new LocalProcessAgentAdapter({
        command: typeof config.command === 'string' ? config.command : 'node',
        args: Array.isArray(config.args) ? config.args.map(String) : [],
        timeoutMs: typeof config.timeoutMs === 'number' ? config.timeoutMs : 60_000,
      });
    }
    return new MockAgentAdapter(() => webWorkerScript(config.side === 'b' ? 'b' : 'a'));
  }
  if (participant.role === 'reviewer') {
    return new MockReviewerAdapter({
      recommendation: 'candidate_a',
      evidenceSufficiency: 'partial',
      unresolvedRisks: ['Load testing evidence is not yet available'],
    });
  }
  return undefined;
}

/**
 * Deterministic "invite an agent" draft (Phase 2): one progress update plus
 * three tentative claims derived from the work item context. All entries are
 * tentative until humans or evidence promote them.
 */
export function inviteAgentDraft(
  workItem: Pick<WorkItem, 'title' | 'description' | 'templateFields'>,
): Array<
  | { kind: 'update'; text: string; author: string }
  | { kind: 'claim'; statement: string; author: string }
> {
  const title = workItem.title;
  return [
    {
      kind: 'update',
      text: `Agent 已分析「${title}」：先列出最可能的候选解释，等待证据确认。`,
      author: 'agent-facilitator',
    },
    {
      kind: 'claim',
      statement: `「${title}」最可能的原因是外部依赖不可用或调用超时未配置。`,
      author: 'agent-facilitator',
    },
    {
      kind: 'claim',
      statement: `需要先复现并收集调用链日志，才能确认具体故障点。`,
      author: 'agent-facilitator',
    },
    {
      kind: 'claim',
      statement: `修复方向应先保证调用有明确超时与重试上限，并保留可观测性。`,
      author: 'agent-facilitator',
    },
  ];
}
