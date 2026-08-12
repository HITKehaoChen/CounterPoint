import type { AgentAdapter, AgentRunInput, AgentRunResult } from './agent.ts';
import { AcpClient } from './acp-client.ts';
import { parseAgentResultText } from './output.ts';
import { renderAgentPrompt } from './prompt.ts';
import type { AgentFingerprint } from '../schemas.ts';

export interface AcpAgentConfig {
  /** ACP-capable CLI, e.g. "claude" (with --acp) or another ACP server binary. */
  command: string;
  args?: string[];
  timeoutMs?: number;
  cwd?: string;
  promptVersion?: string;
  model?: string;
  provider?: string;
  env?: Record<string, string>;
}

/**
 * ACP Adapter: wraps any Agent Client Protocol v1-capable coding agent
 * (e.g. Claude Code with `--acp`, or a future Codex ACP server) as a
 * Counterpoint Worker/Reviewer adapter.
 *
 * Lifecycle per run: initialize -> session/new (isolated workspace as cwd) ->
 * session/prompt with the Counterpoint task contract -> parse the returned
 * JSON document into a Position + Artifacts.
 */
export class AcpAgentAdapter implements AgentAdapter {
  readonly name = 'acp-agent';
  private readonly config: AcpAgentConfig;

  constructor(config: AcpAgentConfig) {
    this.config = config;
  }

  async run(input: AgentRunInput): Promise<AgentRunResult> {
    const client = new AcpClient({
      command: this.config.command,
      args: this.config.args,
      cwd: this.config.cwd ?? input.workspacePath,
      timeoutMs: this.config.timeoutMs ?? 120_000,
      env: this.config.env,
    });
    try {
      const init = await client.initialize();
      const sessionId = await client.newSession({
        cwd: input.workspacePath,
        additionalWorkspaceRoots: [input.workspacePath],
      });
      const promptText = renderAgentPrompt(input);
      const result = await client.prompt({
        sessionId,
        text: promptText,
        timeoutMs: this.config.timeoutMs ?? 120_000,
      });
      if (result.stopReason === 'cancelled') {
        throw new Error('ACP prompt cancelled');
      }
      let parsed;
      try {
        parsed = parseAgentResultText(result.text);
      } catch (error) {
        throw new Error(
          `ACP agent (${init.agentInfo.name ?? this.config.command}) did not return a valid submission (stopReason=${result.stopReason}): ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const fingerprint: AgentFingerprint = {
        adapter: this.name,
        model: this.config.model ?? init.agentInfo.title ?? init.agentInfo.name,
        provider: this.config.provider ?? 'acp',
        promptVersion: this.config.promptVersion ?? 'counterpoint-prompt-1',
        toolset: ['acp_fs', 'acp_terminal'],
        contextViewHash: input.contextView.hash,
      };
      return {
        position: parsed.position,
        artifacts: parsed.artifacts,
        fingerprint,
        logs: [
          `acp agent=${init.agentInfo.name ?? 'unknown'} version=${init.agentInfo.version ?? 'unknown'}`,
          `protocolVersion=${init.protocolVersion} updates=${result.updateCount} stopReason=${result.stopReason}`,
        ].join('\n'),
        cost: result.cost,
      };
    } finally {
      client.close();
    }
  }
}
