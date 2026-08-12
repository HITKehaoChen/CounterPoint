import type { AgentAdapter, AgentRunInput, AgentRunResult } from './agent.ts';
import type { AgentFingerprint, PositionDraft } from '../schemas.ts';

export interface MockClaim {
  id: string;
  statement: string;
  type: 'fact' | 'preference' | 'risk' | 'design' | 'unknown';
  evidenceRefs?: string[];
  confidence?: number;
}

export interface MockAgentScript {
  summary: string;
  claims: MockClaim[];
  unknowns?: string[];
  artifactRefs?: string[];
  decisionConditions?: string[];
  confidence?: number;
  artifacts?: Array<{
    logicalName: string;
    type: 'text' | 'markdown' | 'code' | 'json' | 'binary';
    content: string;
    visibility?: 'private' | 'shared' | 'review';
  }>;
  delayMs?: number;
  failWith?: string;
  model?: string;
  provider?: string;
  promptVersion?: string;
  cost?: number;
}

export type MockScriptProvider = (input: AgentRunInput) => MockAgentScript;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Deterministic Agent Adapter for tests, demos and evaluation baselines
 * (FR-010 / FR-013). Behavior is fully controlled by a script provider, so
 * scenarios can simulate independent judgments, failures and timeouts.
 */
export class MockAgentAdapter implements AgentAdapter {
  readonly name = 'mock-agent';
  private readonly scriptProvider: MockScriptProvider;

  constructor(scriptProvider: MockScriptProvider) {
    this.scriptProvider = scriptProvider;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const script = this.scriptProvider(input);
    if (script.delayMs) await sleep(script.delayMs);
    if (script.failWith) throw new Error(script.failWith);

    const position: PositionDraft = {
      summary: script.summary,
      claims: script.claims.map((claim) => ({
        id: claim.id,
        statement: claim.statement,
        type: claim.type,
        evidenceRefs: claim.evidenceRefs ?? [],
        confidence: claim.confidence,
      })),
      unknowns: script.unknowns ?? [],
      artifactRefs: script.artifactRefs ?? [],
      decisionConditions: script.decisionConditions ?? [],
      confidence: script.confidence ?? 0.5,
    };

    const fingerprint: AgentFingerprint = {
      adapter: this.name,
      model: script.model ?? 'mock-model',
      provider: script.provider ?? 'mock-provider',
      promptVersion: script.promptVersion ?? 'mock-prompt-1',
      toolset: ['read_sources'],
      contextViewHash: input.contextView.hash,
    };

    return {
      position,
      artifacts: script.artifacts ?? [],
      fingerprint,
      logs: `mock run ${input.runId}: ${position.summary}`,
      cost: script.cost ?? 0,
    };
  }
}
